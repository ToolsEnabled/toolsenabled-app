/* T17. AN AGENT DIES ON AN ACCOUNT USAGE LIMIT AND NOTHING IS RECORDED,
 * HELD, RETRIED OR SAID.
 *
 * THE MEASURED SILENCE. The owner's agent failed twice on an account usage
 * limit with persistent continuation on. The durable row stayed
 * `status "running"` / `reason "running"`, `retries 0`, through both failures
 * and moved only when the person intervened nine minutes later.
 *
 * WHAT THIS SUITE FOUND, which source reading had not. Three candidates were
 * on the table -- the agent-host turnId guard, `state.stopped`, and
 * `persist()`'s silent short-circuit. The instrument says it is none of them.
 * The continuation controller IS told, promptly, with `status: 'failed'`.
 * What it is NOT told is that the failure was a LIMIT:
 *
 *   the emitted turn_completed carries NO code -- the provider sent none --
 *   AND NO TEXT, because the person-facing sentence was dropped on its way out.
 *
 * WHY THE SENTENCE IS DROPPED. shell/agent-host.cjs's turnFailureSentence()
 * refuses any sentence containing a slash, so that a path or a stack frame can
 * never reach the person. The observed sentence is
 *
 *   "You've hit your session limit · resets 1:30am (America/Los_Angeles)"
 *
 * and `America/Los_Angeles` is an IANA timezone, not a path. The whole sentence
 * is discarded, and every downstream classifier -- the renderer's
 * retryFailureKind(), the engine's classifyFailure() -- is then reading an
 * empty code and an empty text. They cannot classify what they were not given.
 *
 * THE INVARIANT THIS SUITE PINS. A limit failure must be identifiable
 * downstream WHETHER OR NOT its person-facing sentence survives the leak
 * filter. That is deliberately not a pin on the filter's current rule: if the
 * filter is later narrowed so the sentence does survive, this suite must still
 * pass, and if the sentence is still withheld from the person, the machine-
 * readable reason must carry the meaning instead. Only one of the two has to
 * be true, and one of them always must be.
 *
 * NO REAL LIMIT IS INDUCED. No provider is contacted and no credential is
 * involved; the sentence is a literal in the fixture engine.
 *
 *   node tools/test/t17-limit-continuation-notification.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { createAgentHost, turnFailureSentence } from '../../shell/agent-host.cjs'
import { limitReason } from '../../shell/account-session-recovery.cjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIMITING_ENGINE = join(ROOT, 'tools/test/fixtures/limiting-engine/src/lib/agent-engine/codex-process.js')
const PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} })

/* This suite is not about the memory admission rule; see the same note in
   agent-close-is-not-a-failed-turn.test.mjs. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

/* The sentence exactly as the person saw it, timezone and all. */
const OWNER_SENTENCE = "You've hit your session limit · resets 1:30am (America/Los_Angeles)"

const settle = ms => new Promise(done => setTimeout(done, ms))

function workspace(t) {
  const directory = mkdtempSync(join(ownedFixtureTempRoot(), 'toolsenabled-t17-limit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function withPlan(run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = PLAN
  try { return await run() } finally {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  }
}

/* THE INSTRUMENT. `ledgerContinuationLoader` is already an injectable option of
 * createAgentHost, so nothing in the product changes to watch this. The
 * recorder answers the turnId-guard candidate on its own: if the host emits a
 * turn_completed but `completed` never lands here, the guard skipped it.
 *
 * session.activeTurnId is captured AT THE MOMENT OF THE CALL, because that is
 * the value the guard compared and it is overwritten moments later. */
function recordingContinuation() {
  const calls = []
  const note = (name, session, payload) => {
    calls.push({ name, sessionId: session?.sessionId ?? null, activeTurnId: session?.activeTurnId ?? null, ...payload })
  }
  const api = {
    enabled: () => true,
    direction: () => ({ actionable: false, taskIds: [], reason: 'test' }),
    instructions: () => null,
    pendingRecoveries: () => [],
    recover: async () => ({ ok: true }),
    attached: () => ({ ok: true }),
    attachmentSession: () => null,
    stopSaved: key => { calls.push({ name: 'stopSaved', key }); return null },
    remember: (session, descriptor) => note('remember', session, { descriptor: descriptor ? Object.keys(descriptor) : null }),
    update: (session, patch) => note('update', session, { patch: patch ? Object.keys(patch) : null }),
    started: (session, origin) => note('started', session, { origin }),
    refused: session => note('refused', session, {}),
    exited: (session, error) => note('exited', session, { code: error?.code ?? null }),
    completed: (session, event) => note('completed', session, {
      status: event?.status ?? null,
      eventTurnId: event?.turnId ?? null,
      eventCode: event?.code ?? event?.error?.code ?? '',
      eventText: event?.text ?? event?.error?.message ?? '',
      eventReason: event?.failureReason ?? null,
    }),
    stop: session => note('stop', session, {}),
    forget: session => note('forget', session, {}),
    tick: () => {},
    close: () => {},
  }
  return { calls, loader: () => ({ createLedgerContinuation: () => api }), named: name => calls.filter(call => call.name === name) }
}

async function driveLimitTurn(t) {
  const recorder = recordingContinuation()
  const host = createAgentHost({
    freeMemory: TEST_FREE_MEMORY,
    enginePath: LIMITING_ENGINE,
    defaultCwd: workspace(t),
    ledgerContinuationLoader: recorder.loader,
  })
  t.after(() => host.closeAll().catch(() => {}))
  const packets = []
  host.onEvent(packet => packets.push(packet))
  const sessionId = 't17-limit'
  await host.startSession({ sessionId })
  await host.sendTurn({ sessionId, text: 'please work until the limit' })
  await settle(400)
  return { recorder, host, packets, sessionId }
}

const completions = packets => packets.filter(packet => packet.event?.type === 'turn_completed')

/* ------------------------------------------------------------------ *
 * GUARD ON THE FIXTURE. A diagnostic that quietly stopped reproducing the
 * failure would report "no defect" for the wrong reason.
 * ------------------------------------------------------------------ */
test('the fixture reproduces the observed failure: a turn that failed with NO provider code', async (t) => {
  await withPlan(async () => {
    const { packets } = await driveLimitTurn(t)
    const done = completions(packets)
    assert.equal(done.length, 1, `exactly one turn_completed expected, saw ${done.length}: ${JSON.stringify(done.map(p => p.event))}`)
    const event = done[0].event
    assert.equal(event.status, 'failed', `the turn must be reported failed: ${JSON.stringify(event)}`)
    const code = String(event.code || event.error?.code || '')
    assert.equal(code, '', `the failure must carry NO code -- that is the defect's precondition, and a code here would make this suite prove the wrong thing (saw ${JSON.stringify(code)})`)
  })
})

/* ------------------------------------------------------------------ *
 * THE ROOT CAUSE, ISOLATED. This calls the rule with values rather than
 * pinning its spelling: the question asked is only "does the owner's real
 * sentence reach the person", and the timezone-free control shows the slash is
 * what decides it. If the filter is later narrowed, the first assertion here
 * flips to a pass and this test is then documenting a fixed defect -- see the
 * companion assertion in the invariant test below, which is the one that must
 * hold either way.
 * ------------------------------------------------------------------ */
test('the leak filter is what removes the limit sentence, and an IANA timezone is why', () => {
  const withZone = turnFailureSentence(OWNER_SENTENCE)
  const withoutZone = turnFailureSentence("You've hit your session limit · resets 1:30am")
  const documented = turnFailureSentence("You're out of usage credits · resets Aug 25, 12am")

  console.log('T17 turnFailureSentence(owner sentence)   = ' + JSON.stringify(withZone))
  console.log('T17 turnFailureSentence(no timezone)      = ' + JSON.stringify(withoutZone))
  console.log('T17 turnFailureSentence(documented claude)= ' + JSON.stringify(documented))

  /* The control: the same sentence without the timezone is allowed through, so
     nothing else about the wording is the reason. */
  assert.equal(withoutZone, "You've hit your session limit · resets 1:30am",
    'the sentence without a timezone must survive, or the timezone is not what is being measured')
  assert.ok(documented, 'the sentence the CLI adapter documents must survive, or this filter is broken for every limit')

  /* A real path and a real stack frame must STILL be refused. This is the part
     of the rule that must never loosen, whatever happens to the timezone. */
  assert.equal(turnFailureSentence('Cannot find module ./src/lib/thing.js'), null, 'a relative path must still be refused')
  assert.equal(turnFailureSentence('at handleResult (node_modules/x/y.js:1:1)'), null, 'a stack frame must still be refused')
  assert.equal(turnFailureSentence('TypeError: x is not a function'), null, 'internal runtime prose must still be refused')
})

/* ------------------------------------------------------------------ *
 * THE INVARIANT. This is the regression gate.
 * ------------------------------------------------------------------ */
test('a limit failure is identifiable downstream even when its sentence is withheld from the person', async (t) => {
  await withPlan(async () => {
    const { recorder, packets } = await driveLimitTurn(t)
    const done = completions(packets)
    assert.equal(done.length, 1, 'the host must have observed the failed turn at all')
    const event = done[0].event

    const told = recorder.named('completed')
    const diagnosis = { event, controllerCompletedCalls: told }

    assert.equal(told.length, 1,
      'the failed turn must reach continuation.completed(); 0 here would mean the agent-host turnId guard skipped it. '
      + JSON.stringify(diagnosis, null, 2))

    /* The meaning must arrive by ONE of two routes: the person-facing sentence
       survived the filter, or a machine-readable reason was attached. Neither
       is required on its own; at least one is. */
    const sentenceCarriesIt = /hit your session limit|usage limit|out of usage/i.test(String(event.text || ''))
    const reasonCarriesIt = event.failureReason === 'account-limit'

    assert.ok(sentenceCarriesIt || reasonCarriesIt,
      'A LIMIT FAILURE MUST BE IDENTIFIABLE DOWNSTREAM. The emitted turn_completed carries no provider '
      + 'code, and its person-facing sentence was dropped by turnFailureSentence() because the reset time '
      + 'contains an IANA timezone. With neither a code, a sentence, nor a computed reason, the renderer\'s '
      + 'retryFailureKind() and the engine\'s classifyFailure() have nothing to classify, so no failure is '
      + 'recorded, no hold is taken and no retry is scheduled -- the measured silence. '
      + JSON.stringify(diagnosis, null, 2))

    /* And the controller must receive the same meaning, not just the host. */
    const controllerSeesIt = /hit your session limit|usage limit|out of usage/i.test(String(told[0].eventText || ''))
      || told[0].eventReason === 'account-limit'
    assert.ok(controllerSeesIt,
      'the continuation controller must receive the limit meaning too, since it is the surface that decides '
      + 'whether to hold or continue: ' + JSON.stringify(diagnosis, null, 2))
  })
})

/* ------------------------------------------------------------------ *
 * THE CLASSIFIER AGREEMENT. The shell already owns a rule that reads both the
 * code and the words. Whatever route carries the meaning, the shell's verdict
 * on the raw sentence is the one the rest of the product should be consuming.
 * ------------------------------------------------------------------ */
test('the shell classifier recognises the owner sentence from the raw text alone', () => {
  const verdict = limitReason({ type: 'turn_completed', status: 'failed', text: OWNER_SENTENCE })
  assert.equal(verdict, 'account-limit',
    'limitReason() reads the words and must call this an account limit; if this fails, the fix cannot be '
    + '"consume the shell\'s computed reason" and the whole design needs revisiting')

  /* It must not call an ordinary failure a limit. */
  assert.equal(limitReason({ type: 'turn_completed', status: 'failed', text: 'The program stopped answering this turn.' }), null,
    'an ordinary failure must not be classified as a limit, or every crash would be auto-retried as one')
})

/* ------------------------------------------------------------------ *
 * CANDIDATE ELIMINATION, recorded so the next reader does not re-derive it.
 * ------------------------------------------------------------------ */
test('the turnId-guard candidate is eliminated: the host refuses a second concurrent turn, and the single turn reaches the controller with activeTurnId already clear', async (t) => {
  await withPlan(async () => {
    const recorder = recordingContinuation()
    const host = createAgentHost({
      freeMemory: TEST_FREE_MEMORY,
      enginePath: LIMITING_ENGINE,
      defaultCwd: workspace(t),
      ledgerContinuationLoader: recorder.loader,
    })
    t.after(() => host.closeAll().catch(() => {}))
    const sessionId = 't17-limit-race'
    await host.startSession({ sessionId })

    /* Hold one turn open, then try to start another. The guard can only skip
       when activeTurnId is non-null AND different, which needs two turns in
       flight at once. */
    void host.sendTurn({ sessionId, text: 'hold this turn open' }).catch(() => {})
    await settle(200)
    const second = await host.sendTurn({ sessionId, text: 'now hit the limit' }).then(
      value => ({ accepted: true, value }),
      error => ({ accepted: false, message: String(error?.message || '') }))

    assert.equal(second.accepted, false,
      'the host must refuse a second concurrent turn; if it ever accepts one, the turnId-guard candidate '
      + 'is live again and this elimination no longer holds: ' + JSON.stringify(second))
    assert.match(second.message, /already has an active turn/i,
      `the refusal must be the active-turn refusal, not some other error: ${JSON.stringify(second)}`)
  })
})

test('diagnostic: the call sequence the controller actually received', async (t) => {
  await withPlan(async () => {
    const { recorder } = await driveLimitTurn(t)
    console.log('T17 controller call sequence: ' + JSON.stringify(recorder.calls.map(call => call.name)))
    console.log('T17 controller calls: ' + JSON.stringify(recorder.calls, null, 2))
    assert.ok(recorder.named('started').length >= 1, 'the session must have been registered with the controller at all')
  })
})
