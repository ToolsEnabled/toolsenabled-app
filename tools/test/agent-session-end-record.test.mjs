import path from 'node:path'
import sessionChangePaths from '../../shell/session-change-paths.cjs'
/* THE ENDING OF A RUN, WRITTEN DOWN.
 *
 * THE GAP THIS CLOSES. The run ledger (shell/spawn-record.cjs, written by
 * shell/main.cjs) carried exactly two lines per run: the intent before the
 * spawn, and `started`/`refused` when the start resolved. Nothing was ever
 * written when a session ENDED -- not when the person stopped it, not when the
 * engine's child went away, not when the app closed. So the product could not
 * truthfully say a session had finished or how long it ran, and the home screen
 * says so in as many words.
 *
 * WHAT IS ASSERTED HERE, and in this order:
 *
 *   1. The end is a THIRD RECORD (`agent_session_end`), joined to its start by
 *      `end.resolves` -- the same key the outcome record already uses, so the
 *      existing reader needs no new mechanism.
 *   2. Its `reason` is a closed set (`closed`, `exited`, `app-shutdown`,
 *      `crashed`, `cap-reached`, `parent-stopped`) and the writer refuses anything else.
 *   3. It carries NO duration. The reader subtracts two signed instants; a
 *      duration computed by the shell would be a claim the chain cannot check.
 *   4. A provider's word for how the last turn ended is carried VERBATIM. The
 *      two engines disagree (`completed` vs `success`) and the record must never
 *      normalise; the reader translates.
 *   5. The commitment is a TENTH positional field, and every record written
 *      before this existed still hashes exactly as it did.
 *   6. ABSENCE STAYS READABLE AS ABSENCE. A start with no end record reads as
 *      "this record does not say", never as "still running" and never as
 *      finished; nothing invents an ending it did not observe.
 *   7. The child's own exit is observable shell-side, for BOTH vendored
 *      transports, and the host reports it only when the host did not close the
 *      session itself.
 *   8. shell/main.cjs hooks the two genuine endings and the best-effort orderly
 *      quit, and records nothing on the way down that it did not observe.
 *
 * The first assertion was written before the writer knew the field, and was red
 * for the plain reason that `end` was dropped on the floor: the record was
 * written, the field was not, and history() answered as if no ending had ever
 * been recorded -- which, until then, was true.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { createAgentHost, observeEngineExit } from '../../shell/agent-host.cjs'
/* READ, NOT EDITED: the renderer's reader is another lane's second pass. It is
   imported here only to show what a start with no ending reads as today. */
import { readLocalSessions } from '../../src/local-activity.js'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require = createRequire(import.meta.url)
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEST_SCRATCH_ROOT = testScratchRoot('.toolsenabled-session-end-record-test')
mkdirSync(TEST_SCRATCH_ROOT, { recursive: true })
const EXITING_ENGINE = join(ROOT, 'tools/test/fixtures/exiting-engine/src/lib/agent-engine/codex-process.js')
const MAIN_SOURCE = readFileSync(join(ROOT, 'shell/main.cjs'), 'utf8')

function keystore() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      const stored = buffer.toString('utf8')
      if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    },
  }
}

function workspace(t, prefix = 'session-end-record-') {
  const directory = mkdtempSync(join(TEST_SCRATCH_ROOT, prefix))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function ledgerLines(recorder) {
  return readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function closeSurface({ session, closeSession, recordSessionEnd }) {
  const noop = () => {}
  const deps = Object.fromEntries(Object.entries(REQUIRED_DEPS).map(([name, kind]) => [name,
    kind === 'function' ? noop : kind === 'number' ? 1 : kind === 'string' ? 'test' : {},
  ]))
  deps.agentSessions = new Map([[session.sessionId, session]])
  deps.currentAgentHost = () => ({ closeSession })
  deps.agentIpcError = (code, message) => { throw Object.assign(new Error(message), { code }) }
  // Close now validates its outer payload before parsing the session command.
  // Exercise the current main-process validator instead of the generic no-op.
  const payloadStart = MAIN_SOURCE.indexOf('function agentPayload(')
  const payloadEnd = MAIN_SOURCE.indexOf('\n}\n', payloadStart)
  assert.ok(payloadStart >= 0 && payloadEnd > payloadStart)
  deps.agentPayload = vm.runInNewContext(`(${MAIN_SOURCE.slice(payloadStart, payloadEnd + 2)})`, {
    agentIpcError: deps.agentIpcError,
  })
  deps.parseAgentSessionCommand = value => value
  deps.rendererSafeAgentError = error => error
  deps.recordSessionEnd = recordSessionEnd
  deps.dialog = { showOpenDialog: noop }
  deps.AGENT_EFFORT_VALUES = []
  return { surface: createAgentCommandSurface(deps), sessions: deps.agentSessions }
}

/* One run, as shell/main.cjs writes it today: the intent, then the outcome. */
function startedRun(recorder, sessionId) {
  const start = recorder.record({ action: 'agent_session_start', sessionId, principal: 'unauthenticated', details: { cwd: 'C:\\work' } })
  recorder.record({
    action: 'agent_session_outcome',
    sessionId,
    principal: 'unauthenticated',
    outcome: { result: 'started', resolves: start.sequence, reason: null },
  })
  return start
}

const END_REASONS = ['closed', 'exited', 'app-shutdown', 'crashed', 'cap-reached', 'parent-stopped']

/* ------------------------------------------------------ 1. the third record */

test('a run that ended is written down as a third record, joined to its start by resolves', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = startedRun(recorder, 'chat-one')

  /* THE GAP, MEASURED BEFORE IT IS CLOSED. Today's ledger has a start and an
     outcome and nothing else, and the reader shows the run as started with no
     way to say it ended. */
  const before = readLocalSessions(recorder.history())
  assert.equal(before.runs.length, 1)
  assert.equal(before.runs[0].result, 'started')
  assert.equal(ledgerLines(recorder).filter(line => line.action === 'agent_session_end').length, 0,
    'no ending has ever been recorded for this run')

  const receipt = recorder.record({
    action: 'agent_session_end',
    sessionId: 'chat-one',
    principal: 'unauthenticated',
    details: {},
    end: { resolves: start.sequence, reason: 'closed', turns: 2, lastTurnStatus: 'completed' },
  })
  assert.equal(receipt.durable, true)
  assert.equal(receipt.signed, true)

  const ends = ledgerLines(recorder).filter(line => line.action === 'agent_session_end')
  assert.equal(ends.length, 1, 'the ending is one appended line')
  assert.deepEqual(ends[0].end, { resolves: start.sequence, reason: 'closed', turns: 2, lastTurnStatus: 'completed' })
  assert.equal(typeof ends[0].at, 'string', 'the recorder stamps when')
  assert.ok(Number.isFinite(Date.parse(ends[0].at)))

  /* And it reaches the reader's side of the channel through history(), so the
     screen that joins outcomes by `resolves` can join endings the same way. */
  const reply = recorder.history()
  const shown = reply.entries.find(entry => entry.action === 'agent_session_end')
  assert.ok(shown, 'history() returns the end record')
  assert.deepEqual(shown.end, { resolves: start.sequence, reason: 'closed', turns: 2, lastTurnStatus: 'completed' })
  assert.equal(shown.sessionId, 'chat-one')
  assert.equal(reply.verified, true, 'the chain still verifies with an ending in it')
  assert.deepEqual(reply.outcomes, { starts: 1, started: 1, refused: 0 }, 'an ending is not a fourth run')
})

/* ------------------------------------------------------ 2. the closed set */

test('the reason is a closed set, and the writer refuses anything outside it', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = startedRun(recorder, 'chat-two')

  for (const reason of END_REASONS) {
    recorder.record({
      action: 'agent_session_end',
      sessionId: 'chat-two',
      end: { resolves: start.sequence, reason, turns: 0, lastTurnStatus: null },
    })
  }
  for (const reason of ['finished', 'stopped', 'CLOSED', 'crash', '', null, undefined, 'C:\\Users\\x']) {
    assert.throws(
      () => recorder.record({
        action: 'agent_session_end',
        sessionId: 'chat-two',
        end: { resolves: start.sequence, reason, turns: 0, lastTurnStatus: null },
      }),
      /end/i,
      `a reason of ${JSON.stringify(reason)} must be refused, not written`,
    )
  }
  assert.throws(
    () => recorder.record({ action: 'agent_session_end', sessionId: 'chat-two', end: { resolves: 0, reason: 'closed', turns: 0, lastTurnStatus: null } }),
    /end/i,
    'an end must name the start it resolves',
  )
  assert.throws(
    () => recorder.record({ action: 'agent_session_end', sessionId: 'chat-two', end: { resolves: start.sequence, reason: 'closed', turns: -1, lastTurnStatus: null } }),
    /end/i,
    'a negative turn count is not a count',
  )
  assert.throws(
    () => recorder.record({ action: 'agent_session_end', sessionId: 'chat-two', end: { resolves: start.sequence, reason: 'closed', turns: 1.5, lastTurnStatus: null } }),
    /end/i,
    'a fractional turn count is not a count',
  )
  assert.equal(recorder.verify().ok, true)
})

/* ------------------------------------------------------ 3. no duration */

test('an end record carries no duration, and exactly the fields it promises', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = startedRun(recorder, 'chat-three')
  recorder.record({
    action: 'agent_session_end',
    sessionId: 'chat-three',
    /* A caller that reaches for a duration is silently NOT given one: the writer
       builds the field in a fixed key order from the four things it admits. */
    end: { resolves: start.sequence, reason: 'exited', turns: 1, lastTurnStatus: 'success', durationMs: 1234, endedAt: 'x' },
  })
  const line = ledgerLines(recorder).find(entry => entry.action === 'agent_session_end')
  assert.deepEqual(Object.keys(line.end).sort(), ['lastTurnStatus', 'reason', 'resolves', 'turns'],
    'the written ending contains only the four promised fields')
  assert.doesNotMatch(JSON.stringify(line), /duration|elapsed|endedAt|startedAt/i,
    'nothing on the line is a shell-computed span; the reader subtracts two signed instants')
  const shown = recorder.history().entries.find(entry => entry.action === 'agent_session_end')
  assert.deepEqual(Object.keys(shown.end).sort(), ['lastTurnStatus', 'reason', 'resolves', 'turns'],
    'history returns only the four promised ending fields')
})

/* ------------------------------------------------------ 4. verbatim */

test('the provider\'s word for the last turn is carried verbatim, never normalised, and nulled when it is not a bare word', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = startedRun(recorder, 'chat-four')
  /* MEASURED (src/agent-session-events.js): codex says `completed`, the Claude
     CLI says `success`; the host's own word for a child that died mid-turn is
     `failed`; a CLI result subtype can read `error_max_turns`. Each is written
     as it arrived, including its case. */
  for (const status of ['completed', 'success', 'failed', 'error_max_turns', 'Interrupted']) {
    recorder.record({
      action: 'agent_session_end',
      sessionId: 'chat-four',
      end: { resolves: start.sequence, reason: 'closed', turns: 1, lastTurnStatus: status },
    })
  }
  const written = ledgerLines(recorder).filter(line => line.action === 'agent_session_end').map(line => line.end.lastTurnStatus)
  assert.deepEqual(written, ['completed', 'success', 'failed', 'error_max_turns', 'Interrupted'])

  /* Anything that could be a path or a sentence is refused at the write -- the
     same rule outcome.reason and usage.status keep. */
  for (const status of ['C:\\Users\\x\\.codex', 'exit code 1: nope', 'a b', '.', '']) {
    assert.throws(
      () => recorder.record({
        action: 'agent_session_end',
        sessionId: 'chat-four',
        end: { resolves: start.sequence, reason: 'closed', turns: 1, lastTurnStatus: status },
      }),
      /end/i,
      `a status of ${JSON.stringify(status)} must be refused`,
    )
  }
  /* And null is admitted, because "no turn ever ended" is a true state. */
  recorder.record({
    action: 'agent_session_end',
    sessionId: 'chat-four',
    end: { resolves: start.sequence, reason: 'closed', turns: 0, lastTurnStatus: null },
  })
  assert.equal(recorder.verify().ok, true)
})

/* ------------------------------------------------------ 5. the commitment */

test('an end commits as the tenth positional field, and older records still hash exactly as they did', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  const start = startedRun(recorder, 'chat-five')
  recorder.record({
    action: 'agent_turn_usage',
    sessionId: 'chat-five',
    usage: { turnId: 'turn-1', tier: 'luna', account: null, status: 'completed', basis: 'turn', inputTokens: 10, outputTokens: 5 },
  })
  recorder.record({
    action: 'agent_session_end',
    sessionId: 'chat-five',
    end: { resolves: start.sequence, reason: 'app-shutdown', turns: 1, lastTurnStatus: 'completed' },
  })

  const lines = ledgerLines(recorder)
  const hash = fields => createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex')
  const base = line => [line.sequence, line.at, line.action, line.sessionId, line.principal, line.details, line.previousHash]

  const plain = lines.find(line => line.action === 'agent_session_start')
  assert.equal(hash(base(plain)), plain.eventHash, 'a start still commits to seven fields')
  const outcome = lines.find(line => line.action === 'agent_session_outcome')
  assert.equal(hash([...base(outcome), outcome.outcome]), outcome.eventHash, 'an outcome still commits to eight')
  const usage = lines.find(line => line.action === 'agent_turn_usage')
  assert.equal(hash([...base(usage), null, usage.usage]), usage.eventHash, 'a usage record still commits to nine')
  const end = lines.find(line => line.action === 'agent_session_end')
  assert.equal(hash([...base(end), null, null, end.end]), end.eventHash,
    'an end commits to ten, with the outcome and usage slots stated as absent')

  /* Presence is part of the commitment: stripping the field must fail. */
  assert.notEqual(hash(base(end)), end.eventHash)

  assert.deepEqual(recorder.verify(), { ok: true, count: 4 })
  /* And the incremental path a relaunch takes agrees. */
  const relaunched = createSpawnRecorder({ safeStorage: keystore(), directory })
  assert.equal(relaunched.history().verified, true)
  recorder.record({ action: 'agent_session_start', sessionId: 'chat-six' })
  assert.equal(relaunched.history().verified, true, 'appended records verify on the incremental path')
})

/* ------------------------------------------------------ 6. absence */

test('a start with no end record reads as "does not say" -- never as finished, never as still running', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = startedRun(recorder, 'chat-seven')

  const reply = recorder.history()
  for (const entry of reply.entries) {
    assert.equal(entry.end, null, `${entry.action} carries no end, so it reads null`)
  }
  /* The read side re-validates the bytes: a line whose end is not the admitted
     shape reads as null too, never as an invented ending. */
  const forged = { ...ledgerLines(recorder)[0] }
  const line = recorder.history().entries.find(entry => entry.sequence === start.sequence)
  assert.equal(line.end, null)
  assert.equal(forged.end, undefined)

  /* And nothing here writes an ending on a relaunch. A second recorder over the
     same directory -- what the next launch looks like -- sees the same two lines. */
  const again = createSpawnRecorder({ safeStorage: keystore(), directory: recorder.ledgerPath.replace(/[\\/][^\\/]+$/, '') })
  assert.equal(again.history().total, 2, 'a relaunch invents no ending it did not observe')
})

/* ------------------------------------------------------ 7. the child's exit */

const PLAN = JSON.stringify({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} })

function withPlan(run) {
  const previous = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = PLAN
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previous
  })
}

function withExitAfter(ms, run) {
  const previous = process.env.MC_TEST_EXIT_AFTER_MS
  if (ms === null) delete process.env.MC_TEST_EXIT_AFTER_MS
  else process.env.MC_TEST_EXIT_AFTER_MS = String(ms)
  return Promise.resolve().then(run).finally(() => {
    if (previous === undefined) delete process.env.MC_TEST_EXIT_AFTER_MS
    else process.env.MC_TEST_EXIT_AFTER_MS = previous
  })
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

/* A DEADLINE THAT RACED THE THING IT WAS WAITING FOR, NOT MEASURED AGAINST IT.
 *
 * The first assertion below used to be `await settle(1500)` before reading
 * `exits.length` -- a fixed sleep standing in for "long enough that the
 * fixture's 400ms exit has surely been observed and reported." That budget
 * was never measured against real scheduling delay, only against a quiet
 * machine: MEASURED 2026-09-03 running this suite at --test-concurrency=4
 * (four files' worth of process spawns sharing this machine's cores with the
 * fleet's other agents), this exact assertion failed with `0 !== 1` -- the
 * fixture had not finished exiting and being reported within 1500ms, not
 * because anything was broken, but because the spawn-plus-exit round trip
 * legitimately took longer under real contention than it does alone. The
 * same run passed at --test-concurrency=1 seconds earlier: intermittent by
 * load, the signature of a clock racing work rather than work failing.
 *
 * waitFor polls the actual signal this test cares about -- the exit callback
 * having fired -- instead of guessing how long that takes. A healthy run
 * still finishes as soon as the event arrives; a genuinely broken host still
 * fails, just against ten real seconds of headroom instead of a number that
 * was already proven too tight on this exact machine. */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await settle(25)
  }
  return null
}

test('the host reports a child exit and exposes source metadata only during ended capture', async (t) => {
  const workdir = workspace(t, 'session-end-host-')
  await withPlan(() => withExitAfter(400, async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: EXITING_ENGINE, defaultCwd: workdir })
    t.after(() => host.closeAll().catch(() => {}))
    const exits = []
    const packets = []
    let metadataAtEndEvent = null
    let racingCommand
    host.onEvent(packet => {
      packets.push(packet)
      if (packet.event?.type === 'session_ended') metadataAtEndEvent = host.sessionTranscriptMetadata(packet.sessionId)
    })
    host.onSessionExit(report => {
      exits.push(report)
      racingCommand = host.sendTurn({ sessionId: report.sessionId, text: 'must not reach the dead adapter' })
        .then(() => null, error => error)
    })

    await host.startSession({ sessionId: 'exits-by-itself' })
    const metadataBeforeExit = host.sessionTranscriptMetadata('exits-by-itself')
    assert.ok(metadataBeforeExit?.threadId, 'the started host exposes the provider thread before exit')
    await waitFor(() => exits.length === 1)
    assert.deepEqual(metadataAtEndEvent, metadataBeforeExit,
      'session_ended capture sees the established source before the tombstone is forgotten')
    assert.equal(host.sessionTranscriptMetadata('exits-by-itself'), null,
      'source metadata is not retained after synchronous ended capture')
    assert.equal(exits.length, 1, 'the child ended by itself and the host said so once')
    assert.equal(exits[0].sessionId, 'exits-by-itself')
    assert.equal(exits[0].exit.code, 0, 'the child\'s own exit code rides with the report')
    assert.deepEqual(packets, [{
      sessionId: 'exits-by-itself',
      event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } },
    }], 'the OS-observed exit must produce exactly one bounded terminal event')
    assert.equal(Object.isFrozen(packets[0]), true)
    assert.equal(Object.isFrozen(packets[0].event), true)
    assert.equal(Object.isFrozen(packets[0].event.exit), true)
    assert.equal((await racingCommand).code, 'AGENT_SESSION_ENDED',
      'a command racing terminal cleanup reached the dead adapter')
    await assert.rejects(
      host.sendTurn({ sessionId: 'exits-by-itself', text: 'still dead' }),
      error => error?.code === 'AGENT_SESSION_UNKNOWN',
      'successful cleanup must forget the host tombstone for recovery',
    )
  }))

  await withPlan(() => withExitAfter(null, async () => {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: EXITING_ENGINE, defaultCwd: workdir })
    t.after(() => host.closeAll().catch(() => {}))
    const exits = []
    const packets = []
    host.onEvent(packet => packets.push(packet))
    host.onSessionExit(report => exits.push(report))

    await host.startSession({ sessionId: 'closed-by-host' })
    await host.closeSession({ sessionId: 'closed-by-host' })
    await settle(800)
    assert.equal(exits.length, 0, 'an exit the host caused is the close, not a second ending')
    assert.equal(packets.filter(packet => packet.event?.type === 'session_ended').length, 0,
      'a requested close emitted an unrequested-exit terminal event')
  }))

  /* THE CLOSE THAT FAILED. The host keeps a session whose close threw in its
     map (state `close-failed`) so the close can be retried -- and the child it
     already asked to stop may exit in the meantime. That exit is the close's
     doing. Without the closeRequested guard this reports it as the child's own
     ending, which a planted mutant proved the two cases above cannot catch: in
     both, the session has already LEFT the map by the time the exit lands. */
  const previousCloseThrows = process.env.MC_TEST_CLOSE_THROWS
  process.env.MC_TEST_CLOSE_THROWS = '1'
  try {
    await withPlan(() => withExitAfter(null, async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: EXITING_ENGINE, defaultCwd: workdir })
      t.after(() => host.closeAll().catch(() => {}))
      const exits = []
      host.onSessionExit(report => exits.push(report))

      await host.startSession({ sessionId: 'close-failed' })
      await assert.rejects(host.closeSession({ sessionId: 'close-failed' }), /FIXTURE_CLOSE_FAILED|close failed/i)
      await settle(800)
      assert.equal(exits.length, 0, 'the child died because the host asked it to; a failed close does not turn that into "exited"')
    }))
  } finally {
    if (previousCloseThrows === undefined) delete process.env.MC_TEST_CLOSE_THROWS
    else process.env.MC_TEST_CLOSE_THROWS = previousCloseThrows
  }
})

test('failed automatic cleanup retains only an ended retry tombstone, then an explicit retry forgets it', async (t) => {
  const workdir = workspace(t, 'session-end-cleanup-retry-')
  const previousCloseThrows = process.env.MC_TEST_CLOSE_THROWS
  process.env.MC_TEST_CLOSE_THROWS = '1'
  try {
    await withPlan(() => withExitAfter(250, async () => {
      let accountProbes = 0
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: EXITING_ENGINE, defaultCwd: workdir,
        accountResolver: async () => { accountProbes++; return { rotated: true, account: { name: 'fixture-owner', provider: 'codex' } } } })
      t.after(() => host.closeAll().catch(() => {}))
      const packets = []
      host.onEvent(packet => packets.push(packet))
      const identity = { requestKeys: { threadId: 'owned-node', treeAnchors: ['owned-root', 'owned-node'] }, treeIdentity: { selfName: 'Worker', managerName: 'Controller' } }
      await host.startSession({ sessionId: 'cleanup-retry', ...identity })
      // The fixture's exit timer starts in the child, after Node has booted.
      // Join the observed ending within the same bound as the other exit case.
      await waitFor(() => packets.some(packet => packet.sessionId === 'cleanup-retry'
        && packet.event?.type === 'session_ended'))
      assert.equal(packets.filter(packet => packet.event?.type === 'session_ended').length, 1)
      await assert.rejects(
        host.sendTurn({ sessionId: 'cleanup-retry', text: 'do not send' }),
        error => error?.code === 'AGENT_SESSION_ENDED',
        'failed cleanup made an ended child sendable',
      )

      await assert.rejects(host.startSession({ sessionId: 'blocked-replacement', replacesSessionId: 'cleanup-retry',
        ...identity, accountRetry: { excludeAccounts: [], recheckAttempt: 0 } }), { code: 'AGENT_PREDECESSOR_CLEANUP_FAILED' })
      assert.equal(accountProbes, 1, 'an exited child with unresolved cleanup cannot reach replacement account selection')
      assert.equal(host.sessionAccounts().some(row => row.sessionId === 'blocked-replacement'), false)
      delete process.env.MC_TEST_CLOSE_THROWS
      assert.deepEqual(await host.closeSession({ sessionId: 'cleanup-retry' }), {
        sessionId: 'cleanup-retry',
        closed: true,
      })
      await assert.rejects(
        host.sendTurn({ sessionId: 'cleanup-retry', text: 'forgotten' }),
        error => error?.code === 'AGENT_SESSION_UNKNOWN',
      )
      assert.equal(packets.filter(packet => packet.event?.type === 'session_ended').length, 1,
        'cleanup retry emitted a second terminal event')
    }))
  } finally {
    if (previousCloseThrows === undefined) delete process.env.MC_TEST_CLOSE_THROWS
    else process.env.MC_TEST_CLOSE_THROWS = previousCloseThrows
  }
})

test('the exit is observed through both vendored transports, so neither engine can end unnoticed', async (t) => {
  const codexPath = join(ROOT, 'capability/src/lib/agent-engine/codex-process.js')
  const claudePath = join(ROOT, 'capability/src/lib/agent-engine/claude-cli-process.js')
  if (!existsSync(codexPath) || !existsSync(claudePath)) {
    t.skip('vendored capability transports are not present in this checkout')
    return
  }
  const codex = require(codexPath)
  const claude = require(claudePath)
  const script = 'setTimeout(() => process.exit(3), 150)'

  /* codex: a multi-listener onData that delivers (null, exitInfo) once. */
  const codexTransport = codex.createCodexProcessTransport({
    command: process.execPath, args: ['-e', script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const codexExit = await new Promise((resolveExit) => {
    const attached = observeEngineExit({ adapter: { transport: codexTransport } }, exit => resolveExit(exit))
    assert.equal(attached, 'transport', 'the codex transport shape was recognised')
  })
  assert.equal(codexExit.code, 3)

  /* Claude: the transport hands out its ChildProcess. Its onData is a single
     handler slot, so the observer must NOT go through it -- doing so would
     replace the adapter's own reader and kill the session. */
  const claudeTransport = claude.createClaudeCliTransport({
    command: process.execPath, args: ['-e', script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  /* Stand in for the adapter's own reader. The transport calls its ONE handler
     with (null, exit) when the child ends; if the observer had taken that slot,
     this stand-in would never hear the exit. */
  let adapterHeardExit = false
  claudeTransport.onData((packet, exit) => { if (packet === null && exit) adapterHeardExit = true })
  const claudeExit = await new Promise((resolveExit) => {
    const attached = observeEngineExit({ adapter: { transport: claudeTransport } }, exit => resolveExit(exit))
    assert.equal(attached, 'child', 'the Claude transport shape was recognised')
  })
  assert.equal(claudeExit.code, 3)
  await settle(100)
  assert.equal(adapterHeardExit, true, 'the adapter\'s own handler slot was left alone, so it still heard the exit')

  /* An engine that exposes neither is left alone, and the observer says so. */
  assert.equal(observeEngineExit({ adapter: { sendTurn() {} } }, () => {}), null)
  assert.equal(observeEngineExit(null, () => {}), null)
})

/* ------------------------------------------------------ 8. main.cjs wiring */

test('shell wiring records the two genuine endings and the best-effort quit, and computes no duration', async () => {
  const at = needle => {
    const index = MAIN_SOURCE.indexOf(needle)
    assert.notEqual(index, -1, `shell/main.cjs must contain ${JSON.stringify(needle)}`)
    return index
  }
  const recorder = MAIN_SOURCE.slice(at('function recordSessionEnd('), at('function recordSessionEnd(') + 2600)
  assert.match(recorder, /action: 'agent_session_end'/)
  assert.match(recorder, /resolves: session\.started\.sequence/, 'the end resolves the start receipt this session was started under')
  assert.match(recorder, /turns: session\.turnsCompleted/, 'the turn count is the one main observed, not a guess')
  assert.match(recorder, /lastTurnStatus: session\.lastTurnStatus/, 'the provider\'s last word is carried as it arrived')
  assert.doesNotMatch(recorder, /duration|Date\.now\(\)\s*-|elapsed/i, 'the shell computes no span')

  /* The Electron wrapper remains a static integration assertion: main.cjs is
     not importable under bare Node. The extracted close command itself is
     exercised below, so its implementation can be freely reorganised. */
  assert.match(MAIN_SOURCE.slice(at("ipcMain.handle('mc-agent:close'"), at("ipcMain.handle('mc-agent:close'") + 300), /run\('agent:close'/,
    'the close channel no longer dispatches to the shared surface')
  const session = { sessionId: 'close-behaviour', owner: {}, ownerKind: 'window' }
  const events = []
  const { surface, sessions } = closeSurface({
    session,
    closeSession: async () => { events.push('closed'); return { closed: true } },
    recordSessionEnd: () => {
      events.push('recorded')
      assert.equal(sessions.has(session.sessionId), true,
        'the ending is recorded while the closed session is still available')
    },
  })
  const principal = { kind: 'window', owner: session.owner, mayWrite: true, label: 'test window' }
  assert.deepEqual(await surface.run('agent:close', { sessionId: session.sessionId }, principal), { closed: true })
  assert.deepEqual(events, ['closed', 'recorded'],
    'the ending is recorded only after the host has actually closed the session')
  assert.equal(sessions.has(session.sessionId), false, 'the closed session is removed after its ending is recorded')

  /* THE CHILD WENT AWAY: the host's exit report, wired where the event listener is.
   *
   * THE RANGE IS THE FUNCTION, NOT 2600 CHARACTERS. It used to be a fixed
   * window, which is two faults in one number: a paragraph of comment added
   * anywhere above the exit handler pushed the line it looks for out of range
   * and reported a wiring that had not changed, and a window longer than the
   * function would have accepted a match from whatever followed it. The
   * function's own closing brace at column zero is the boundary, so this is
   * both stabler and strictly tighter than the number it replaces -- it can no
   * longer read anything outside buildAgentHost at all. (Caught 2026-08-27, by a
   * lane that added a second caller here and three lines of reasoning with it.) */
  /* Host construction moved behind asyncSingleFlight so readiness callers can
     share one build. The listeners still belong to the construction function;
     getAgentHost is now deliberately only the small single-flight selector. */
  const hostStart = at('async function buildAgentHost()')
  const hostEnd = MAIN_SOURCE.indexOf('\n}\n', hostStart)
  assert.notEqual(hostEnd, -1, 'buildAgentHost has no closing brace at column zero, so its range cannot be found')
  const host = MAIN_SOURCE.slice(hostStart, hostEnd)
  assert.match(host, /host\.onSessionExit\(/)
  assert.match(host, /recordSessionEnd\(session, [a-zA-Z.]+, 'exited'\)/)
  // Execute the actual event callback: ordinary exit and bounded cleanup now
  // intentionally use different ledger reasons. A literal search for 'exited'
  // missed that distinction and never proved the order of the callbacks.
  const listenerMarker = 'removeAgentEventListener = host.onEvent('
  const listenerAt = host.indexOf(listenerMarker)
  const listenerEnd = host.indexOf('\n  })', listenerAt)
  assert.ok(listenerAt >= 0 && listenerEnd > listenerAt)
  const listenerSource = host.slice(listenerAt + listenerMarker.length, listenerEnd + 4)
  for (const [event, expectedReason] of [
    [{ type: 'session_ended', reason: 'exited' }, 'exited'],
    [{ type: 'session_ended', reason: 'cap-reached' }, 'cap-reached'],
    [{ type: 'session_ended', reason: 'parent-stopped' }, 'parent-stopped'],
    [{ type: 'turn_completed', status: 'completed' }, null],
    [{ type: 'session_ended', reason: 'unrecognized' }, null],
  ]) {
    for (const hasStarted of [false, true]) {
      const sessionId = 'observed-ending'
      const observed = { sessionId, state: 'ready', ...(hasStarted ? { started: { sequence: 1 } } : {}) }
      const sessions = new Map([[sessionId, observed]])
      const ordered = []
      const packet = { sessionId, event }
      const listener = vm.runInNewContext(`(${listenerSource})`, {
        bindSessionChangePaths: sessionChangePaths.bindSessionChangePaths, WORKSPACE_ROOT: process.cwd(), path,
        agentSessions: sessions,
        recordSessionEnd(value, id, reason) {
          assert.equal(value, observed)
          assert.equal(id, sessionId)
          assert.equal(value.state, 'ended')
          assert.equal(sessions.get(id), value, 'record before removing the outer session')
          ordered.push(`record:${reason}`)
        },
        mainLagMonitor: { note(name, callback) { assert.equal(name, 'agent-event:forward'); callback() } },
        getAgentCommandSurface: () => ({ forwardSessionEvent(value) {
          assert.equal(value, packet)
          assert.equal(sessions.get(sessionId), observed, 'the session remains routable during terminal fanout')
          ordered.push('forward')
          return true
        } }),
        transcriptCapture: { packet() {} }, noteAgentTurnUsage() {}, noteAgentTurnCompleted() {},
        ownedByThisWindow: () => false,
      })
      listener(packet)
      assert.deepEqual(ordered, expectedReason && hasStarted ? [`record:${expectedReason}`, 'forward'] : ['forward'])
      assert.equal(observed.state, expectedReason ? 'ended' : 'ready')
      assert.equal(observed.observedEndReason, expectedReason || undefined, 'an early ending must retain its exact cause until the start receipt exists')
      assert.equal(observed.exitedBeforeStarted === true, Boolean(expectedReason && !hasStarted))
      assert.equal(sessions.has(sessionId), !(['cap-reached', 'parent-stopped'].includes(expectedReason) && hasStarted), 'bounded cleanup removes its outer entry only after fanout')
    }
  }
  const exitNotification = host.indexOf('noteAgentSessionEnded(report)')
  const exitRemoval = host.indexOf('agentSessions.delete(report.sessionId)')
  assert.ok(exitNotification !== -1 && exitNotification < exitRemoval,
    'the outer session disappeared before its one terminal notification was routed')

  const hostSource = readFileSync(join(ROOT, 'shell/agent-host.cjs'), 'utf8')
  const terminalizerStart = hostSource.indexOf('function endSessionFromExit(')
  const terminalizerEnd = hostSource.indexOf('\n\n  function assertOpen', terminalizerStart)
  const terminalizer = hostSource.slice(terminalizerStart, terminalizerEnd)
  assert.ok(terminalizer.indexOf('forgetTreeSession(session)') < terminalizer.indexOf('emit(session, event)'),
    'a dead child remained tree-addressable while its terminal event was emitted')

  /* THE APP IS CLOSING: the window's owner going away, and before-quit, both
     best-effort and both BEFORE the map is emptied. */
  const owner = MAIN_SOURCE.slice(at('function bindAgentOwner('), at('function bindAgentOwner(') + 1200)
  assert.ok(owner.indexOf("recordSessionEnd(session, sessionId, 'app-shutdown')") < owner.indexOf('agentSessions.delete(sessionId)'))
  // Execute the actual quit body, not a character window around its event
  // registration. Research now joins that event independently of chat agents.
  const quitStart = at('async function closeAgentSessionsForQuit()')
  const quitEnd = MAIN_SOURCE.indexOf('\n}\n', quitStart)
  assert.ok(quitEnd > quitStart, 'the app quit body must have an exact function boundary')
  const quitEvents = []
  const quitSessions = new Map([['first', { marker: 1 }], ['second', { marker: 2 }]])
  const clear = quitSessions.clear.bind(quitSessions)
  quitSessions.clear = () => { quitEvents.push('clear'); clear() }
  let releaseHost
  const hostClosed = new Promise(resolve => { releaseHost = resolve })
  const quitSandbox = {
    nodeRecovery: { async stop() {} },
    agentSessions: quitSessions,
    recordSessionEnd(value, id, reason) {
      assert.equal(quitSessions.get(id), value, 'the record sees the original session before removal')
      assert.equal(reason, 'app-shutdown')
      quitEvents.push(`record:${id}`)
    },
    agentHost: { closeAll() { quitEvents.push('close'); return hostClosed } },
    usageRecorder: { async flush() { quitEvents.push('usage:flush') } },
    transcriptCapture: { async shutdown() { quitEvents.push('capture:shutdown') } },
    nodeTranscripts: { async shutdown({ deleteNodes }) { quitEvents.push('transcripts:shutdown'); await deleteNodes() } },
    nodePrivacyCleanup: { prepare() { quitEvents.push('privacy:prepare') }, complete() { quitEvents.push('privacy:complete') } },
  }
  vm.runInNewContext(`${MAIN_SOURCE.slice(quitStart, quitEnd + 3)}\nglobalThis.close = closeAgentSessionsForQuit`, quitSandbox)
  let quitFinished = false
  const closing = quitSandbox.close().then(() => { quitFinished = true })
  assert.deepEqual(quitEvents, ['record:first', 'record:second', 'clear', 'close'])
  assert.equal(quitSessions.size, 0)
  await Promise.resolve()
  assert.equal(quitFinished, false, 'the quit join must await the actual host close')
  releaseHost()
  await closing
  assert.equal(quitFinished, true)
  assert.deepEqual(quitEvents, ['record:first', 'record:second', 'clear', 'close',
    'usage:flush', 'capture:shutdown', 'transcripts:shutdown', 'privacy:prepare', 'privacy:complete'])

  /* AND NOTHING WRITES `crashed`: it is in the closed set for a future writer
     with real evidence, and main.cjs has none tonight. */
  assert.doesNotMatch(MAIN_SOURCE, /recordSessionEnd\([^)]*'crashed'\)/)
  /* Turns are counted where every session's events cross, from the engine's
     own completion event. */
  const counting = MAIN_SOURCE.slice(at('function noteAgentTurnCompleted('), at('function noteAgentTurnCompleted(') + 900)
  assert.match(counting, /turn_completed/)
  assert.match(counting, /turnsCompleted/)
  assert.doesNotMatch(counting, /toLowerCase/, 'the status is not normalised on the way in')
})
