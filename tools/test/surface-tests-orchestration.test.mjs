import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { parseOptions } from '../lib/surface-tests/options.mjs'
import { buildPlan, batches, overall } from '../lib/surface-tests/plan.mjs'
import { LIMITATIONS } from '../lib/surface-tests/catalog.mjs'
import { markdown, resultStatus } from '../lib/surface-tests/results.mjs'
import { runMemoryFixtures } from '../lib/surface-tests/memory.mjs'
import { pathCatalog, pathsMarkdown } from '../lib/surface-tests/path-catalog.mjs'

// Execute the actual main body unchanged (apart from its ESM export keyword).
// The VM cannot require real modules, start processes, or write physical files.
const sourceUrl = new URL('../surface-tests.mjs', import.meta.url)
const source = fs.readFileSync(sourceUrl, 'utf8')
const start = source.indexOf('export async function main(')
const end = source.indexOf('\nif (process.argv[1]', start)
assert.ok(start >= 0 && end > start, 'actual main entry must remain discoverable')
const body = source.slice(start, end).replace(/^export /, '') + '\nmain'
const root = path.join(path.parse(process.cwd()).root, 'inert-surface-orchestration')
const paths = { app: path.join(root, 'app'), engine: path.join(root, 'engine'), out: path.join(root, 'proof'), kit: path.join(root, 'kit') }
const identity = { app: 'a'.repeat(40), engine: 'b'.repeat(40) }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const argv = ['run', '--engine', paths.engine, '--out', paths.out, '--surface', 'hosted',
  '--origin', 'https://fixture.invalid', '--expect-app', identity.app, '--expect-engine', identity.engine,
  '--playwright-root', paths.kit, '--fixture-cleanup', 'approved', '--budget-ms', '1000', '--timeout-ms', '1000']

function completeHostedEvidence() {
  const labels = ['chromium', 'webkit'].flatMap(engine =>
    ['390x844', '844x390', '320x568', '568x320'].map(size => engine + '-' + size))
  const results = labels.map(label => ({
    label, ok: true, passed: 1, failed: 0, errors: [], blocked: [],
    checks: [{ ok: true, label: label + ': observed anonymous gate' }],
  }))
  return {
    startedAt: '2026-09-22T10:00:00.000Z', finishedAt: '2026-09-22T10:00:01.000Z',
    ok: true, tests: labels.length, passed: labels.length, failed: 0, errors: [],
    requestedCases: labels, results, checks: results.flatMap(row => row.checks),
  }
}

function harness({ verify, prepare, child, plan = buildPlan, verdict = resultStatus,
  driverEvidence = completeHostedEvidence() } = {}) {
  const state = { time: 0, files: new Map(), launches: [], prepared: [], output: [], identities: 0 }
  const proof = { kind: 'reconciled-tap', counts: { tests: 1, pass: 1, fail: 0 }, unexecuted: 0 }
  const modules = new Map([
    [path.join(paths.engine, 'tests/lib/isolated-child.js'), {
      runIsolatedChild: async (executable, args, options) => {
        state.launches.push({ executable, args, options, at: state.time })
        if (options.env.PHONE_GATE_QA_REPORT) state.files.set(options.env.PHONE_GATE_QA_REPORT,
          JSON.stringify(driverEvidence))
        return child ? child(state) : { status: 0, cleanupConfirmed: true, stdout: 'inert TAP', stderr: '' }
      },
    }],
    [path.join(paths.engine, 'tests/lib/isolated-environment.js'), { configure: () => prepare?.(state) }],
    [path.join(paths.engine, 'tools/lib/test-completion.js'), { validateCompletion: () => proof }],
  ])
  class Clock extends Date { static now() { return state.time } }
  const context = {
    parseOptions, buildPlan: plan, batches, overall, LIMITATIONS, markdown, resultStatus: verdict, runMemoryFixtures, pathCatalog, pathsMarkdown,
    path, appRoot: paths.app, help: 'inert help', json: value => JSON.stringify(value, null, 2) + '\n',
    Date: Clock, ordinaryPath: () => {}, sourceIdentity: () => ({ ref: 'stable-source' }),
    artifactIdentity: () => { throw Error('unexpected artifact lookup') },
    hostedIdentity: async () => { state.identities++; return verify ? verify(state) : identity },
    sterileProfileDirectories: dir => dir,
    prepareSterileProfile: dir => { state.prepared.push(dir); return dir },
    sterileLaunchEnvironment: () => ({}),
    require: name => { assert.ok(modules.has(name), 'unexpected real module access: ' + name); return modules.get(name) },
    process: { argv: [], env: {}, execPath: process.execPath, platform: process.platform, version: process.version,
      stdout: { write: value => state.output.push(value) } },
    fs: {
      mkdirSync: dir => { assert.equal(dir, paths.out) },
      writeFileSync: (file, text) => state.files.set(file, text),
      readFileSync: file => { assert.ok(state.files.has(file), 'missing inert evidence: ' + file); return state.files.get(file) },
    },
  }
  const main = vm.runInNewContext(body, context, { filename: sourceUrl.pathname })
  return { state, run: args => main(args || argv), report: () => JSON.parse(state.files.get(path.join(paths.out, 'report.json'))) }
}

for (const elapsed of [1000, 1500]) {
  test('actual main refuses deferred identity admission at elapsed ' + elapsed, async () => {
    const entered = deferred(), release = deferred()
    const h = harness({ verify: async () => { entered.resolve(); await release.promise; return identity } })
    const pending = h.run()
    await entered.promise
    h.state.time = elapsed
    release.resolve()
    assert.equal(await pending, 2)
    assert.equal(h.state.launches.length, 0)
    assert.equal(h.state.prepared.length, 0)
    assert.equal(h.state.identities, 1)
    assert.equal(h.report().status, 'BLOCKED')
    assert.equal(h.report().results[0].status, 'NOT_RUN')
    assert.equal(h.report().results[0].reason, 'Run time budget exhausted')
  })
}

test('actual main rechecks budget immediately before child launch after profile preparation', async () => {
  const h = harness({ prepare: state => { state.time = 1500 } })
  assert.equal(await h.run(), 2)
  assert.equal(h.state.prepared.length, 1)
  assert.equal(h.state.launches.length, 0)
  assert.equal(h.report().results[0].status, 'NOT_RUN')
})

test('actual main admits timely identity and lets admitted cleanup/evidence finish', async () => {
  const entered = deferred(), release = deferred()
  const h = harness({
    verify: async state => { if (state.identities === 1) { entered.resolve(); await release.promise } return identity },
    child: state => { state.time = 1200; return { status: 0, cleanupConfirmed: true, stdout: '', stderr: '' } },
  })
  const pending = h.run()
  await entered.promise
  h.state.time = 250
  release.resolve()
  assert.equal(await pending, 0)
  assert.equal(h.state.launches.length, 1)
  assert.equal(h.state.launches[0].at, 250)
  assert.equal(h.state.launches[0].options.timeout, 750)
  assert.equal(h.state.identities, 2)
  assert.equal(h.report().status, 'PASS')
  assert.equal(h.report().results[0].cleanupConfirmed, true)
})

test('actual main rejects aggregate-only hosted evidence after a successful child exit', async () => {
  const h = harness({ driverEvidence: { ok: true, tests: 1, failed: 0, checks: [{ ok: true }] } })
  assert.equal(await h.run(), 1)
  assert.equal(h.state.launches.length, 1)
  assert.equal(h.report().status, 'FAIL')
  assert.equal(h.report().results[0].status, 'FAIL')
  assert.match(h.report().results[0].reason, /Hosted summary/)
  assert.equal(h.report().results[0].evidence.requestedCases, undefined)
})

test('actual main stops subsequent batches after unconfirmed admitted cleanup', async () => {
  const h = harness({ child: () => ({ status: 0, cleanupConfirmed: false, stdout: '', stderr: '' }) })
  const args = ['run', '--engine', paths.engine, '--out', paths.out, '--only', 'fra-identity,fra-relay',
    '--budget-ms', '1000', '--timeout-ms', '1000']
  assert.equal(await h.run(args), 1)
  assert.equal(h.state.launches.length, 1)
  assert.deepEqual(h.report().results.map(row => row.status), ['FAIL', 'NOT_RUN'])
  assert.equal(h.report().results[1].reason, 'Previous process cleanup was unconfirmed')
})

test('actual main rechecks stopped state after another admitted job fails during identity await', async () => {
  const entered = deferred(), release = deferred(), failed = deferred()
  const h = harness({
    plan: (o, app) => {
      const hosted = buildPlan(o, app)[0]
      return [{ id: 'inert-sibling', surface: 'source', kind: 'tap', files: ['inert.js'], root: app, args: ['inert.js'] },
        { ...hosted, serial: false }]
    },
    child: () => ({ status: 0, cleanupConfirmed: false, stdout: '', stderr: '' }),
    verify: async () => { entered.resolve(); await release.promise; return identity },
    verdict: (...args) => { const result = resultStatus(...args); if (result.stop) failed.resolve(); return result },
  })
  const pending = h.run([...argv, '--jobs', '2'])
  await entered.promise
  await failed.promise
  release.resolve()
  assert.equal(await pending, 1)
  assert.equal(h.state.launches.length, 1)
  assert.equal(h.state.prepared.length, 1)
  assert.deepEqual(h.report().results.map(row => row.status), ['FAIL', 'NOT_RUN'])
  assert.equal(h.report().results[1].reason, 'Previous process cleanup was unconfirmed')
})

test('actual paths command prints ordered expectations without any launch or filesystem mutation', async () => {
  const h = harness()
  assert.equal(await h.run(['paths', '--surface', 'mobile']), 0)
  assert.equal(h.state.launches.length, 0)
  assert.equal(h.state.prepared.length, 0)
  assert.equal(h.state.files.size, 0)
  assert.equal(h.state.identities, 0)
  assert.match(h.state.output.join(''), /No action or browser has been started/)
  assert.match(h.state.output.join(''), /pg2-agent-return/)
})
test('actual list command includes the expected browser steps and manual path limitations', async () => {
  const h = harness()
  assert.equal(await h.run(['list', '--surface', 'mobile,packaged']), 0)
  const listed = JSON.parse(h.state.output.join(''))
  assert.equal(listed.plan.find(j => j.id === 'mobile').journeys.length, 3)
  assert.ok(listed.userPaths.some(p => p.execution.includes('manual acceptance')))
  assert.equal(h.state.launches.length, 0)
  assert.equal(h.state.files.size, 0)
})
