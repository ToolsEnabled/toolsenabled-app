import test from 'node:test'
import assert from 'node:assert/strict'
import { pendingJourney, runJourney, validateJourneys } from '../lib/surface-tests/journeys.mjs'
import { markdown, resultStatus } from '../lib/surface-tests/results.mjs'

const saveBoundary = {
  id: 'save-boundary',
  title: 'Save boundary',
  steps: [
    { id: 'open', action: 'Open the surface', expected: 'The surface is observed' },
    { id: 'inspect', action: 'Inspect the surface', expected: 'The inspection is observed' },
    { id: 'final-action', action: 'Complete the final action', expected: 'The final action is observed' },
  ],
}
const cleanupPath = {
  id: 'cleanup-boundary',
  title: 'Cleanup boundary',
  steps: [
    { id: 'open', action: 'Open the surface', expected: 'The surface is observed' },
    { id: 'return', action: 'Return from the surface', expected: 'The return is observed' },
  ],
}
const verified = observed => ({ verified: true, observed })
const driverJob = descriptor => ({ id: 'browser', kind: 'driver', journeys: [descriptor], caseLabels: ['case-a'] })

function positiveEvidence(record) {
  return {
    ok: true,
    tests: 1,
    failed: 0,
    checks: [{ ok: true }],
    cleanupConfirmed: true,
    requestedCases: 1,
    cases: [{
      label: 'case-a',
      ok: true,
      status: 'PASS',
      cleanupConfirmed: true,
      journeys: [record],
    }],
  }
}

const saveRejections = [
  { id: 'initial', failAt: 1, expectedActions: [], expectedStatuses: ['NOT_RUN', 'NOT_RUN', 'NOT_RUN'] },
  { id: 'before-first-action', failAt: 2, expectedActions: [], expectedStatuses: ['RUNNING', 'NOT_RUN', 'NOT_RUN'] },
  { id: 'after-first-action', failAt: 3, expectedActions: ['open'], expectedStatuses: ['PASS', 'NOT_RUN', 'NOT_RUN'] },
  { id: 'after-final-action', failAt: 7, expectedActions: ['open', 'inspect', 'final-action'], expectedStatuses: ['PASS', 'PASS', 'PASS'] },
  { id: 'final-save', failAt: 8, expectedActions: ['open', 'inspect', 'final-action'], expectedStatuses: ['PASS', 'PASS', 'PASS'] },
]

for (const scenario of saveRejections) {
  test('save rejection at ' + scenario.id + ' stops later user actions and invalidates the path', async () => {
    const broken = pendingJourney(saveBoundary)
    const called = []
    const saveError = 'Checkpoint failed at ' + scenario.id
    let saveCalls = 0
    const actions = Object.fromEntries(saveBoundary.steps.map(step => [step.id, async () => {
      called.push(step.id)
      return verified(step.id + ' observed before persistence failed')
    }]))

    await assert.rejects(
      runJourney(broken, actions, {
        save: async () => {
          saveCalls += 1
          if (saveCalls === scenario.failAt) throw Error(saveError)
        },
      }),
      error => error?.message === saveError,
    )

    assert.equal(saveCalls, scenario.failAt)
    assert.deepEqual(called, scenario.expectedActions)
    assert.deepEqual(broken.steps.map(step => step.status), scenario.expectedStatuses)
    assert.equal(broken.status, 'FAIL')
    assert.match(broken.error, /checkpoint|persistence/i)
    assert.ok(broken.error.includes(saveError))
    assert.ok(broken.finishedAt)
    assert.notEqual(validateJourneys([saveBoundary], [broken]), null)

    const restored = pendingJourney(saveBoundary)
    const restoredCalls = []
    await runJourney(restored, Object.fromEntries(saveBoundary.steps.map(step => [step.id, async () => {
      restoredCalls.push(step.id)
      return verified(step.id + ' observed after persistence was restored')
    }])), { save: async () => {} })
    assert.deepEqual(restoredCalls, saveBoundary.steps.map(step => step.id))
    assert.equal(validateJourneys([saveBoundary], [restored]), null)

    if (scenario.id === 'final-save') {
      assert.equal(broken.steps.at(-1).status, 'PASS',
        'the genuinely completed final action retains its own PASS outcome')
      const failedEvidence = {
        ...positiveEvidence(broken),
        ok: false,
        failed: 1,
        checks: [{ ok: false }],
        cases: [{
          ...positiveEvidence(broken).cases[0],
          ok: false,
          status: 'FAIL',
        }],
      }
      const failedVerdict = resultStatus(driverJob(saveBoundary), {
        status: 1,
        cleanupConfirmed: true,
      }, failedEvidence)
      assert.equal(failedVerdict.status, 'FAIL')

      const report = markdown({
        status: 'FAIL',
        platform: 'linux',
        profile: 'smoke',
        elapsedMs: 1,
        results: [{ id: 'browser', ...failedVerdict }],
        plan: [driverJob(saveBoundary)],
        limitations: [],
      })
      assert.match(report, /Status: FAIL\./)
      assert.match(report, /Checkpoint failed at final-save/)
    }
  })
}

test('a final action failure records failure and never becomes a complete path', async () => {
  const record = pendingJourney(cleanupPath)
  const called = []
  await assert.rejects(runJourney(record, {
    open: async () => {
      called.push('open')
      return verified('Surface opened')
    },
    return: async () => {
      called.push('return')
      throw Error('Final return control failed')
    },
  }), /Final return control failed/)

  assert.deepEqual(called, ['open', 'return'])
  assert.equal(record.status, 'FAIL')
  assert.equal(record.steps[1].status, 'FAIL')
  assert.notEqual(validateJourneys([cleanupPath], [record]), null)
})

test('unconfirmed browser cleanup stops the next surface even with complete path evidence', async () => {
  const record = pendingJourney(cleanupPath)
  await runJourney(record, {
    open: async () => verified('Surface opened'),
    return: async () => verified('Surface returned'),
  })

  const job = driverJob(cleanupPath)
  const evidence = positiveEvidence(record)
  const blocked = resultStatus(job, { status: 0, cleanupConfirmed: false }, evidence)
  assert.deepEqual(
    { status: blocked.status, stop: blocked.stop, reason: blocked.reason },
    { status: 'FAIL', stop: true, reason: 'Child/descendant shutdown is unconfirmed' },
  )

  const restored = resultStatus(job, { status: 0, cleanupConfirmed: true }, evidence)
  assert.equal(restored.status, 'PASS')
  assert.equal(restored.stop, undefined)
})
