import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { bindRuntimeSources, freezeStudy, RUNTIME_FILES } from '../../src/benchmark/study.mjs'
import { qualifyRequirements, verifySelectedInputQualification, qualificationPreparationLedger, SELECTED_INPUT_PREPARATION_LIMITS } from '../../src/benchmark/requirements.mjs'
import { runStudy, validateJournal } from '../../src/benchmark/runner.mjs'
import { researchReportFiles } from '../../src/benchmark/report.mjs'
import { genericActivationFixture } from './fixtures/research-benchmark-generic-activation.mjs'

// This exercises the shared state machine with two small direct-API arithmetic
// algorithms. Existing activation tests cover actual pinned module processes.
// No fabricated process receipt or native execution is claimed by this fixture.
async function fixture({ maxDurationMs = 60000, timeoutMs = 30000, maxTotalAttempts = 4, replicates = 1 } = {}) {
  const { spec } = await genericActivationFixture()
  delete spec.requirementPlan.interpreters; spec.inputs = []
  Object.assign(spec.protocol, { maxDurationMs, maxTotalAttempts, replicates })
  spec.requirementPlan.selectedInput.timeoutMs = timeoutMs
  const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async file =>
    [file, await readFile(new URL('../../src/benchmark/' + file, import.meta.url), 'utf8')])))
  const project = await freezeStudy(await bindRuntimeSources(spec, sources))
  const direct = async task => ({ observation: String(task.compiled.semantic.a + task.compiled.semantic.b + task.input.offset),
    activation: { counters: { evaluated: 1 }, transitions: {} } })
  const steps = async task => {
    let sum = 0
    for (const term of [task.compiled.semantic.a, task.compiled.semantic.b, task.input.offset]) {
      for (let count = 0; count < Math.abs(term); count++) sum += Math.sign(term)
    }
    return { observation: String(sum), activation: { counters: { evaluated: 1 }, transitions: {} } }
  }
  const proof = { format: 'research-benchmark-qualification', version: 1, projectSha256: project.sha256,
    runtimeSources: project.spec.runtimeSources,
    requirements: await qualifyRequirements(project.requirements, { interpret: direct, independent: steps }),
    scope: 'Synthetic direct-API arithmetic callbacks only; no process or native execution claimed.' }
  await verifySelectedInputQualification(project, proof)
  return { project, proof }
}

async function failure(promise) {
  let caught
  try { await promise } catch (error) { caught = error }
  assert.ok(caught, 'The operation must refuse')
  return caught
}
const clockAt = state => ({ monotonic: () => state.ms, now: () => Date.UTC(2026, 0, 1) + state.ms })
const isTerminal = event => ['qualification', 'qualification-failed'].includes(event.type)

for (const { label, timeoutMs, latencyMs } of [
  { label: 'exact study deadline', timeoutMs: 10000, latencyMs: 10000 },
  { label: 'exceeded study deadline', timeoutMs: 10000, latencyMs: 15000 },
  { label: 'exact preparation deadline', timeoutMs: 1000, latencyMs: 1000 },
  { label: 'exceeded preparation deadline', timeoutMs: 1000, latencyMs: 1500 },
]) test(`a durable qualification intent at the ${label} cannot admit its qualifier`, async () => {
  const { project, proof } = await fixture({ maxDurationMs: 10000, timeoutMs }), clock = { ms: 0 }, durable = []
  let calls = 0
  const error = await failure(runStudy(project, { ...clockAt(clock),
    append: async event => {
      durable.push(structuredClone(event))
      if (event.type === 'qualification-started') { await Promise.resolve(); clock.ms += latencyMs }
    },
    qualify: async () => { calls++; return proof },
    adapter: () => assert.fail('An expired preparation cannot authorize collection'),
  }))
  assert.equal(calls, 0)
  assert.match(error.message, /frozen time budget/)
  assert.deepEqual(durable.map(event => event.type), ['qualification-started', 'qualification-failed'])
  assert.equal(durable[1].status, 'timeout'); assert.equal(durable[1].preparationSeq, durable[0].seq)
  assert.equal(durable[1].elapsedMs, latencyMs); assert.equal(durable[1].budgetChargeMs, latencyMs)
  assert.deepEqual(error.events, durable); assert.deepEqual(validateJournal(project, durable), [])
  assert.equal(qualificationPreparationLedger(project, durable).open, 0)
  if (latencyMs >= project.spec.protocol.maxDurationMs) {
    const resumed = await runStudy(project, { events: durable, ...clockAt(clock),
      qualify: () => assert.fail('The retained intent latency already consumed this study budget'),
      adapter: () => assert.fail('The exhausted study cannot collect on a later invocation'),
    })
    assert.deepEqual(resumed.events, durable)
  }
})

test('remaining time after a durable qualification intent preserves normal admission and measured charges', async () => {
  const { project, proof } = await fixture({ maxDurationMs: 10000, timeoutMs: 1000 }), clock = { ms: 0 }
  let calls = 0
  const result = await runStudy(project, { ...clockAt(clock),
    append: async event => { if (event.type === 'qualification-started') { await Promise.resolve(); clock.ms += 75 } },
    qualify: async () => { calls++; clock.ms += 20; return proof },
  })
  assert.equal(calls, 1); assert.equal(result.summary.completed, 1)
  const terminal = result.events.find(event => event.type === 'qualification')
  assert.equal(terminal.elapsedMs, 95); assert.equal(terminal.budgetChargeMs, 95)
  assert.deepEqual(validateJournal(project, result.events), [])
})

test('caller cancellation while a qualification intent is awaited keeps its reason after budget exhaustion', async () => {
  const { project } = await fixture({ maxDurationMs: 10000, timeoutMs: 1000 }), clock = { ms: 0 }, controller = new AbortController()
  const error = await failure(runStudy(project, { ...clockAt(clock), signal: controller.signal,
    append: async event => {
      if (event.type === 'qualification-started') {
        await Promise.resolve(); clock.ms += 15000
        controller.abort(new Error('Caller cancelled during the durable qualification intent'))
      }
    },
    qualify: () => assert.fail('A cancelled intent cannot admit its qualifier'),
    adapter: () => assert.fail('A cancelled preparation cannot collect'),
  }))
  assert.equal(error.message, 'Caller cancelled during the durable qualification intent')
  assert.equal(error.events.at(-1).status, 'cancelled')
  assert.equal(error.events.at(-1).elapsedMs, 15000)
  assert.deepEqual(validateJournal(project, error.events), [])
})

test('a durable preparation intent precedes the callback and its complete proof survives reporting', async () => {
  const { project, proof } = await fixture(), durable = [], clock = { ms: 0 }
  const result = await runStudy(project, { ...clockAt(clock), append: async event => durable.push(structuredClone(event)),
    qualify: async (_project, context) => {
      assert.equal(durable.length, 1)
      const intent = durable[0]
      assert.equal(intent.type, 'qualification-started')
      assert.equal(context.preparationSeq, intent.seq)
      assert.equal(intent.timeoutMs, project.requirements.selectedInput.timeoutMs)
      assert.equal(intent.settlementMs, 5000)
      assert.equal(intent.reservedMs, intent.timeoutMs + intent.settlementMs)
      clock.ms += 73
      return proof
    },
  })
  assert.deepEqual(result.events, durable)
  assert.equal(result.summary.completed, 1)
  const receipt = result.events.find(event => event.type === 'qualification')
  assert.equal(receipt.preparationSeq, 1); assert.equal(receipt.elapsedMs, 73); assert.equal(receipt.budgetChargeMs, 73)
  assert.deepEqual(receipt.record, proof)
  assert.deepEqual(validateJournal(project, result.events), [])
  assert.deepEqual(result.summary.selectedInputPreparation, qualificationPreparationLedger(project, result.events))
  const report = await researchReportFiles(project, result.events)
  assert.deepEqual(JSON.parse(report['qualification-receipts/' + receipt.seq + '/record.json']), proof)
})

test('successful preparation-only invocations cannot reset the cumulative study time budget', async () => {
  const { project, proof } = await fixture({ maxDurationMs: 10000, timeoutMs: 10000 }), clock = { ms: 0 }
  let events = [], calls = 0
  for (let invocation = 0; invocation < 2; invocation++) {
    const controller = new AbortController()
    const options = { events, ...clockAt(clock), signal: controller.signal,
      qualify: async () => { calls++; clock.ms += 6000; return proof },
      adapter: () => assert.fail('No trial belongs to a preparation-only invocation'),
      onEvent: event => { if (isTerminal(event)) controller.abort(new Error('Stop after preparation')) },
    }
    try { events = (await runStudy(project, options)).events }
    catch (error) { assert.ok(error.events); events = error.events }
  }
  assert.equal(calls, 2)
  assert.deepEqual(qualificationPreparationLedger(project, events).rows.map(row => row.budgetChargeMs), [6000, 6000])
  assert.equal(events.filter(event => event.type === 'started').length, 0)
  const result = await runStudy(project, { events, ...clockAt(clock),
    qualify: () => assert.fail('The prior preparation charges already exhaust this study'),
    adapter: () => assert.fail('Exhausted preparation cannot authorize a response'),
  })
  assert.deepEqual(result.events, events)
})

test('failed preparation preserves raw diagnostics and cumulative charges through the next invocation', async () => {
  const { project } = await fixture({ maxDurationMs: 10000, timeoutMs: 10000 }), clock = { ms: 0 }
  let events = []
  for (let invocation = 0; invocation < 2; invocation++) {
    const error = await failure(runStudy(project, { events, ...clockAt(clock),
      qualify: async () => { clock.ms += 6000; throw Object.assign(new Error('Synthetic qualifier failure'),
        { partialQualification: { diagnostic: 'RETAINED_PARTIAL_PROOF_' + invocation }, evidence: { stderr: 'retained stderr', exitCode: 7 } }) },
      adapter: () => assert.fail('Failed preparation must never dispatch a response'),
    }))
    assert.ok(error.events); assert.ok(error.summary)
    events = error.events
    assert.equal(error.partialQualification.diagnostic, 'RETAINED_PARTIAL_PROOF_' + invocation)
    assert.deepEqual(error.evidence, { stderr: 'retained stderr', exitCode: 7 })
    assert.equal(events.at(-1).type, 'qualification-failed'); assert.equal(events.at(-1).status, 'failed')
  }
  const ledger = qualificationPreparationLedger(project, events)
  assert.equal(ledger.knownBudgetChargeMs, 12000); assert.equal(ledger.missingCharge, 0)
  assert.equal(ledger.open, 0)
  const stopped = await runStudy(project, { events, ...clockAt(clock), qualify: () => assert.fail('Failed work must consume its budget') })
  assert.deepEqual(stopped.events, events)
})

test('cancellation joins late qualifier settlement before recording its measured charge and diagnostics', async () => {
  const { project } = await fixture(), controller = new AbortController(), clock = { ms: 0 }
  let settled = false
  const error = await failure(runStudy(project, { ...clockAt(clock), signal: controller.signal,
    qualify: (_project, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => {
        clock.ms += 85; settled = true
        reject(Object.assign(new Error('Qualifier settled after cancellation'), { partialQualification: { diagnostic: 'LATE_SETTLED_PROOF' } }))
      }, 25), { once: true })
      controller.abort(new Error('Synthetic cancellation'))
    }),
    append: async event => { if (event.type === 'qualification-failed') assert.equal(settled, true) },
    adapter: () => assert.fail('Cancelled preparation cannot dispatch'),
  }))
  assert.equal(settled, true)
  assert.equal(error.events.at(-1).status, 'cancelled')
  assert.equal(error.events.at(-1).elapsedMs, 85); assert.equal(error.events.at(-1).budgetChargeMs, 85)
  assert.equal(error.partialQualification.diagnostic, 'LATE_SETTLED_PROOF')
  assert.equal(error.settledQualificationError.partialQualification.diagnostic, 'LATE_SETTLED_PROOF')
  assert.match(error.message, /Synthetic cancellation/)
  assert.equal(qualificationPreparationLedger(project, error.events).open, 0)
})

test('timeout includes bounded asynchronous shutdown before its terminal receipt', async () => {
  const { project } = await fixture({ timeoutMs: 100 })
  let settled = false
  const error = await failure(runStudy(project, {
    qualify: (_project, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      setTimeout(() => { settled = true; reject(new Error('Owned timeout shutdown finished')) }, 25)
    }, { once: true })),
    append: async event => { if (event.type === 'qualification-failed') assert.equal(settled, true) },
    adapter: () => assert.fail('Timed-out preparation cannot dispatch'),
  }))
  const terminal = error.events.at(-1)
  assert.equal(terminal.status, 'timeout'); assert.equal(settled, true)
  assert.ok(terminal.elapsedMs >= 100)
  assert.equal(terminal.elapsedMs, terminal.budgetChargeMs)
  assert.equal(qualificationPreparationLedger(project, error.events).rows[0].chargeBasis, 'measured')
})

test('an unjoined qualifier remains an open reserved intent and retains the lock after the bounded settlement window', async () => {
  const { project } = await fixture(), controller = new AbortController()
  const before = performance.now()
  const error = await failure(runStudy(project, { signal: controller.signal,
    qualify: () => { controller.abort(new Error('Cancel an unresponsive callback')); return new Promise(() => {}) },
    adapter: () => assert.fail('Unsettled preparation cannot authorize any response'),
  }))
  assert.ok(performance.now() - before >= SELECTED_INPUT_PREPARATION_LIMITS.settlementMs)
  assert.equal(error.keepLock, true); assert.equal(error.qualificationUnsettled, true)
  assert.equal(error.events.length, 1); assert.equal(error.events[0].type, 'qualification-started')
  const ledger = qualificationPreparationLedger(project, error.events)
  assert.equal(ledger.open, 1); assert.equal(ledger.elapsedMs, null)
  assert.equal(ledger.rows[0].budgetChargeMs, error.events[0].reservedMs)
  assert.equal(ledger.rows[0].settled, false)
})

test('journal failures prevent preparation or leave an orphan whose explicit recovery cannot continue', async () => {
  const { project, proof } = await fixture()
  await assert.rejects(runStudy(project, {
    append: async () => { throw new Error('Intent storage failure') },
    qualify: () => assert.fail('The preparation intent must be durable before the callback'),
  }), /Intent storage failure/)
  const durable = []
  const failed = await failure(runStudy(project, {
    append: async event => {
      if (event.type === 'qualification') throw new Error('Terminal storage failure')
      durable.push(structuredClone(event))
    },
    qualify: async () => proof,
    adapter: () => assert.fail('No dispatch before a durable proof'),
  }))
  assert.match(failed.message, /Terminal storage failure/)
  assert.equal(durable.length, 1); assert.equal(durable[0].type, 'qualification-started')
  await assert.rejects(runStudy(project, { events: durable, qualify: () => assert.fail('An orphan cannot silently restart') }), /preparation|interrupt|recover/i)
  const recovered = await failure(runStudy(project, { events: durable, recover: true,
    qualify: () => assert.fail('Orphan recovery cannot infer interpreter containment'),
    adapter: () => assert.fail('Recovery cannot start a new trial'),
  }))
  assert.equal(recovered.keepLock, true); assert.equal(recovered.qualificationUnsettled, true)
  const terminal = recovered.events.at(-1)
  assert.equal(terminal.type, 'qualification-failed'); assert.equal(terminal.status, 'interrupted')
  assert.equal(terminal.elapsedMs, null); assert.equal(terminal.budgetChargeMs, durable[0].reservedMs)
  assert.equal(terminal.preparationSeq, durable[0].seq)
  assert.deepEqual(validateJournal(project, recovered.events), [])
  await assert.rejects(runStudy(project, { events: recovered.events, recover: true,
    qualify: () => assert.fail('A recovered interrupted qualifier permanently halts this journal'),
  }), /preparation|interrupt|unsettled|new.*(design|project)/i)
})

test('journal proof pairing and retained charges reject forged preparation and collection authority', async () => {
  const { project, proof } = await fixture({ maxDurationMs: 20000, replicates: 2 }), clock = { ms: 0 }
  const { events } = await runStudy(project, { ...clockAt(clock), qualify: async () => proof })
  const receiptIndex = events.findIndex(event => event.type === 'qualification')
  for (const mutate of [
    rows => { rows[receiptIndex].preparationSeq = 999 },
    rows => { rows.splice(0, 1); rows.forEach((row, index) => { row.seq = index + 1 }) },
    rows => { rows[receiptIndex].elapsedMs = project.spec.protocol.maxDurationMs; rows[receiptIndex].budgetChargeMs = project.spec.protocol.maxDurationMs },
    rows => { rows.find(row => row.type === 'finished').elapsedMs = project.spec.protocol.maxDurationMs },
    rows => { const { record: _record, ...terminal } = rows[receiptIndex]; rows[receiptIndex] = { ...terminal, type: 'qualification-failed', status: 'failed', reason: 'Rejected qualifier' } },
    rows => { rows.splice(receiptIndex + 1, 0, structuredClone(rows[receiptIndex])); rows.forEach((row, index) => { row.seq = index + 1 }) },
  ]) {
    const changed = structuredClone(events); mutate(changed)
    await assert.rejects(researchReportFiles(project, changed))
  }
  const finalPreparation = structuredClone(events.slice(0, receiptIndex + 1))
  finalPreparation.at(-1).elapsedMs = project.spec.protocol.maxDurationMs + 1
  finalPreparation.at(-1).budgetChargeMs = project.spec.protocol.maxDurationMs + 1
  assert.deepEqual(validateJournal(project, finalPreparation), [])
  const repeated = [...finalPreparation, { ...structuredClone(finalPreparation[0]), seq: finalPreparation.length + 1 }]
  await assert.rejects(researchReportFiles(project, repeated), /budget|charge|time/i)
  assert.deepEqual((await runStudy(project, { events: finalPreparation, qualify: () => assert.fail('Final preparation already exhausted the budget') })).events, finalPreparation)
})

test('legacy proof bytes remain readable with unavailable timing, but cannot authorize resumed work or guessed charges', async () => {
  const { project, proof } = await fixture()
  const { events } = await runStudy(project, { qualify: async () => proof })
  const legacy = structuredClone(events.filter(event => event.type !== 'qualification-started'))
  for (const [index, event] of legacy.entries()) {
    event.seq = index + 1
    if (event.type === 'qualification') { delete event.preparationSeq; delete event.elapsedMs; delete event.budgetChargeMs }
  }
  assert.deepEqual(validateJournal(project, legacy), [])
  const ledger = qualificationPreparationLedger(project, legacy)
  assert.equal(ledger.missingCharge, 1); assert.equal(ledger.missingElapsed, 1)
  assert.equal(ledger.knownBudgetChargeMs, 0); assert.equal(ledger.budgetChargeMs, null)
  const report = await researchReportFiles(project, legacy)
  assert.deepEqual(JSON.parse(report['qualification-receipts/1/record.json']), proof)
  assert.match(report['report.md'], /legacy|unavailable/i)
  const complete = await runStudy(project, { events: legacy,
    qualify: () => assert.fail('Completed legacy evidence needs no new qualifier'),
    adapter: () => assert.fail('Completed legacy evidence cannot be redrawn'),
  })
  assert.deepEqual(complete.events, legacy)
  await assert.rejects(runStudy(project, { events: legacy.slice(0, 1),
    qualify: () => assert.fail('Unknown legacy charges cannot authorize new preparation'),
    adapter: () => assert.fail('Unknown legacy charges cannot authorize a trial'),
  }), /legacy|unavailable|missing|unknown/i)
  const guessed = structuredClone(legacy); guessed[0].elapsedMs = 0; guessed[0].budgetChargeMs = 0
  await assert.rejects(researchReportFiles(project, guessed), /preparation|legacy|timing|charge|paired/i)
})

test('zero-duration preparation count and oversized successful proof cannot bypass admission limits', async () => {
  const { project, proof } = await fixture({ maxTotalAttempts: 1 }), clock = { ms: 0 }
  let events = []
  for (let invocation = 0; invocation < project.spec.protocol.maxTotalAttempts + 1; invocation++) {
    const controller = new AbortController()
    events = (await runStudy(project, { events, ...clockAt(clock), signal: controller.signal, qualify: async () => proof,
      onEvent: event => { if (event.type === 'qualification') controller.abort(new Error('Preparation only')) },
      adapter: () => assert.fail('No trial is requested'),
    })).events
  }
  await assert.rejects(runStudy(project, { events, ...clockAt(clock), qualify: () => assert.fail('Count limit must precede qualifier work') }), /preparation.*(count|limit)|limit.*preparation/i)
  const oversized = { ...proof, diagnostic: 'x'.repeat(SELECTED_INPUT_PREPARATION_LIMITS.proofBytes) }
  const error = await failure(runStudy(project, { qualify: async () => oversized, adapter: () => assert.fail('An oversized proof cannot authorize collection') }))
  assert.match(error.message, /proof|MiB|byte|size/i)
  assert.equal(error.events.filter(event => event.type === 'qualification').length, 0)
  assert.equal(error.events.filter(event => event.type === 'started').length, 0)
})

test('several individually admissible full proofs cannot exceed cumulative canonical or serialized evidence limits', async () => {
  const { project, proof } = await fixture({ maxTotalAttempts: 8 }), clock = { ms: 0 }
  const { events } = await runStudy(project, { ...clockAt(clock), qualify: async () => proof })
  const start = events.find(event => event.type === 'qualification-started'), success = events.find(event => event.type === 'qualification')
  const repeated = (record, count) => Array.from({ length: count }, (_, index) => [
    { ...start, seq: 2 * index + 1 },
    { ...success, seq: 2 * index + 2, preparationSeq: 2 * index + 1, record },
  ]).flat()

  // Extra retained diagnostics are valid finite JSON, but cannot expand the
  // evidence budget just because each individual successful proof fits.
  const wide = { ...proof, diagnostic: 'x'.repeat(3 * 1024 * 1024) }
  await verifySelectedInputQualification(project, wide)
  const canonicalOverflow = repeated(wide, 6)
  assert.ok(Buffer.byteLength(canonical(canonicalOverflow[1])) < SELECTED_INPUT_PREPARATION_LIMITS.proofBytes)
  assert.ok(Buffer.byteLength(canonical(canonicalOverflow)) > SELECTED_INPUT_PREPARATION_LIMITS.journalBytes)
  assert.throws(() => validateJournal(project, canonicalOverflow), /cumulative.*byte|evidence.*byte/i)
  await assert.rejects(runStudy(project, { events: canonicalOverflow,
    qualify: () => assert.fail('Oversized retained journals cannot dispatch another qualifier'),
  }), /cumulative.*byte|evidence.*byte/i)

  const indented = { ...proof, diagnostic: Array(1000000).fill(0) }
  await verifySelectedInputQualification(project, indented)
  const serializedOverflow = repeated(indented, 3)
  assert.ok(Buffer.byteLength(canonical(serializedOverflow[1])) < SELECTED_INPUT_PREPARATION_LIMITS.proofBytes)
  assert.ok(Buffer.byteLength(canonical(serializedOverflow)) < SELECTED_INPUT_PREPARATION_LIMITS.journalBytes)
  assert.ok(Buffer.byteLength(JSON.stringify({ events: serializedOverflow }, null, 2)) > SELECTED_INPUT_PREPARATION_LIMITS.eventEvidenceBytes)
  assert.throws(() => validateJournal(project, serializedOverflow), /serialized.*byte|event evidence/i)
})
