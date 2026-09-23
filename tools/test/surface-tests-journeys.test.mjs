import test from 'node:test'
import assert from 'node:assert/strict'
import { BROWSER_PATHS, browserPaths, browserCases, pendingJourney, runJourney, validateJourneys } from '../lib/surface-tests/journeys.mjs'
import { resultStatus, markdown } from '../lib/surface-tests/results.mjs'
import { pathCatalog, pathsMarkdown } from '../lib/surface-tests/path-catalog.mjs'
import { parseOptions } from '../lib/surface-tests/options.mjs'
import { buildPlan } from '../lib/surface-tests/plan.mjs'

const verified = () => ({ verified: true, observed: 'Observed through the inert test boundary' })
const tiny = { id: 'recovery', title: 'Recovery', steps: [
  { id: 'open', action: 'Open', expected: 'Visible' },
  { id: 'recover', action: 'Recover', expected: 'Restored' },
  { id: 'return', action: 'Return', expected: 'Home' },
] }
const actionsFor = p => Object.fromEntries(p.steps.map(s => [s.id, async () => verified()]))
async function passed(p) { const record = pendingJourney(p); await runJourney(record, actionsFor(p)); return record }

test('path plan includes observable actions with stable distinct IDs and no execution claims', () => {
  assert.equal(parseOptions(['paths']).command, 'paths')
  const paths = pathCatalog()
  assert.ok(paths.length >= 7)
  assert.equal(new Set(paths.map(p => p.id)).size, paths.length)
  for (const p of paths) {
    assert.equal(p.status, 'NOT_RUN')
    assert.ok(p.scope && p.prerequisites.length && p.steps.length)
    assert.equal(new Set(p.steps.map(s => s.id)).size, p.steps.length)
    for (const s of p.steps) assert.ok(s.action && s.expected)
  }
  const text = pathsMarkdown(pathCatalog(['mobile']))
  assert.match(text, /No action or browser has been started/)
  assert.match(text, /No matching agents/)
  assert.match(text, /same agent/)
})

test('actual plan binds the complete expected step sequence and viewport matrix', () => {
  const o = parseOptions(['list', '--surface', 'browser,mobile', '--profile', 'full'])
  const plan = buildPlan(o, '/inert')
  assert.equal(plan[0].caseLabels.length, 4)
  assert.equal(plan[1].caseLabels.length, 8)
  assert.deepEqual(plan[1].journeys, browserPaths('mobile'))
  assert.deepEqual(browserCases('mobile', 'smoke').map(c => c.label), ['chromium-390x844', 'chromium-320x568'])
  assert.throws(() => browserCases('phone', 'smoke'))
  assert.throws(() => browserCases('mobile', 'invalid'))
})

test('checkpoints precede each ordered action; positive proof and timing survive', async () => {
  const p = pendingJourney(tiny), saved = [], called = []
  let time = 20
  const actions = Object.fromEntries(tiny.steps.map(s => [s.id, async () => {
    const latest = saved.at(-1)
    assert.equal(latest.steps.find(r => r.id === s.id).status, 'RUNNING')
    called.push(s.id); time += 5; return verified()
  }]))
  await runJourney(p, actions, { now: () => time, save: () => saved.push(structuredClone(p)) })
  assert.deepEqual(called, ['open', 'recover', 'return'])
  assert.equal(validateJourneys([tiny], [p]), null)
  assert.deepEqual(p.steps.map(s => s.elapsedMs), [5, 5, 5])
  await assert.rejects(runJourney(p, actions), /cannot be replayed/)
})

test('an action failure records the exact failing step and never executes successors', async () => {
  const p = pendingJourney(tiny), called = [], saves = []
  await assert.rejects(runJourney(p, {
    open: async () => { called.push('open'); return verified() },
    recover: async () => { called.push('recover'); throw Error('Recovery control obscured') },
    return: async () => { called.push('return'); return verified() },
  }, { save: () => saves.push(structuredClone(p)), onFailure: async () => ({ screenshot: '/retained/failure.png' }) }), /obscured/)
  assert.deepEqual(called, ['open', 'recover'])
  assert.deepEqual(p.steps.map(s => s.status), ['PASS', 'FAIL', 'NOT_RUN'])
  assert.equal(p.steps[1].failureCapture.screenshot, '/retained/failure.png')
  assert.equal(saves.at(-1).status, 'FAIL')
  assert.equal(saves.at(-1).steps[1].error, 'Recovery control obscured')
})

test('missing or empty action observations and missing callbacks cannot become passes', async () => {
  for (const bad of [undefined, {}, { verified: false, observed: 'No' }, { verified: true, observed: '' }]) {
    const p = pendingJourney(tiny)
    await assert.rejects(runJourney(p, { ...actionsFor(tiny), open: async () => bad }), /no explicit verified observation/)
    assert.equal(p.status, 'FAIL')
    assert.equal(p.steps[1].status, 'NOT_RUN')
  }
  const p = pendingJourney(tiny)
  await assert.rejects(runJourney(p, { open: verified }), /Missing user action/)
  assert.equal(p.status, 'NOT_RUN')
})

test('capture failure preserves the actual step failure and checkpoint', async () => {
  const p = pendingJourney(tiny)
  await assert.rejects(runJourney(p, { ...actionsFor(tiny), open: async () => { throw Error('Route failed') } },
    { onFailure: async () => { throw Error('Screenshot unavailable') } }), /Route failed/)
  assert.equal(p.steps[0].error, 'Route failed')
  assert.equal(p.steps[0].captureError, 'Screenshot unavailable')
  assert.equal(p.status, 'FAIL')
})

test('evidence rejects omitted, duplicated, reordered, unfinished and fabricated steps', async () => {
  const valid = await passed(tiny)
  const variants = [
    [],
    [{ ...valid, steps: valid.steps.slice(1) }],
    [{ ...valid, steps: [valid.steps[0], valid.steps[0], valid.steps[2]] }],
    [{ ...valid, steps: [...valid.steps].reverse() }],
    [{ ...valid, steps: valid.steps.map(s => ({ ...s, status: 'RUNNING' })) }],
    [{ ...valid, steps: valid.steps.map(s => ({ ...s, observation: undefined })) }],
    [{ ...valid, steps: valid.steps.map(s => ({ ...s, expected: 'Weakened claim' })) }],
    [{ ...valid, steps: valid.steps.map(s => ({ ...s, elapsedMs: -1 })) }],
  ]
  for (const value of variants) assert.ok(validateJourneys([tiny], value))
  assert.equal(validateJourneys([tiny], [valid]), null)
})

test('driver success requires every requested viewport, path, step and confirmed closure', async () => {
  const expected = browserPaths('mobile')
  const journeys = await Promise.all(expected.map(passed))
  const job = { id: 'mobile', kind: 'driver', journeys: expected, caseLabels: ['chromium-390x844', 'chromium-320x568'] }
  const cases = job.caseLabels.map(label => ({ label, ok: true, status: 'PASS', cleanupConfirmed: true, journeys: structuredClone(journeys) }))
  const evidence = { ok: true, tests: 1, failed: 0, checks: [{ ok: true }], cases, requestedCases: 2, cleanupConfirmed: true }
  const processResult = { status: 0, cleanupConfirmed: true }
  assert.equal(resultStatus(job, processResult, evidence).status, 'PASS')
  for (const invalid of [
    { ...evidence, cases: undefined }, { ...evidence, cases: cases.slice(1) },
    { ...evidence, cases: [cases[0], cases[0]] }, { ...evidence, requestedCases: 1 },
    { ...evidence, cases: cases.map(c => ({ ...c, cleanupConfirmed: false })) },
    { ...evidence, cases: cases.map(c => ({ ...c, journeys: c.journeys.slice(1) })) },
  ]) assert.equal(resultStatus(job, processResult, invalid).status, 'FAIL')
})

test('nonzero driver exits retain failed step evidence in human-readable reports', async () => {
  const failed = pendingJourney(tiny)
  await assert.rejects(runJourney(failed, { ...actionsFor(tiny), recover: async () => { throw Error('Obscured button') } }))
  const job = { id: 'mobile', kind: 'driver', journeys: [tiny], caseLabels: ['case-a'] }
  const evidence = { ok: false, cleanupConfirmed: true, cases: [{ label: 'case-a', cleanupConfirmed: true, journeys: [failed] }] }
  const verdict = resultStatus(job, { status: 1, cleanupConfirmed: true }, evidence)
  assert.equal(verdict.evidence, evidence)
  const text = markdown({ status: 'FAIL', platform: 'linux', profile: 'smoke', elapsedMs: 3,
    results: [{ ...verdict, id: 'mobile' }], plan: [job], limitations: [] })
  assert.match(text, /2\. recover \| Recover \| Restored \| FAIL \| Obscured button/)
  assert.match(text, /3\. return \| Return \| Home \| NOT_RUN/)
})

test('blocked runs still print every unexecuted user action', () => {
  const job = { id: 'mobile', journeys: [tiny], caseLabels: ['case-a'] }
  const text = markdown({ status: 'BLOCKED', platform: 'linux', profile: 'smoke', elapsedMs: 0,
    results: [{ id: 'mobile', status: 'BLOCKED', reason: 'No qualified artifact' }], plan: [job], limitations: [] })
  assert.match(text, /1\. open \| Open \| Visible \| NOT_RUN \| No qualified artifact/)
  assert.match(text, /Context closed: unconfirmed/)
})

test('uncertain browser cleanup stops later surfaces even after clean process exit', () => {
  const job = { id: 'mobile', kind: 'driver', journeys: browserPaths('mobile') }
  for (const evidence of [undefined, {}, { cleanupConfirmed: false }]) {
    const result = resultStatus(job, { status: 0, cleanupConfirmed: true }, evidence)
    assert.equal(result.status, 'FAIL')
    assert.equal(result.stop, true)
  }
})
