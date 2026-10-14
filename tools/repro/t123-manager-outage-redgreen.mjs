#!/usr/bin/env node
/* LANE A ITEM 4 (ledger T123 / T410) -- RED at the base pair, GREEN at the fix.
 *
 * THE DEFECT, MEASURED 2026-09-15. A manager's session failed every turn from
 * 21:47Z. Five circles reporting to it each finished one item, sent the report
 * to a circle that could no longer read it, and then sat idle for over three
 * hours under a working policy whose entire point is that they do not.
 *
 * THE FIX IS IN TWO REPOSITORIES AND EITHER HALF ALONE IS INERT.
 * shell/agent-host.cjs OBSERVES which circle on the person's tree has stopped;
 * the engine's ledger-continuation-controller.js DECIDES what the next turn
 * says and who above the gap is told. This script checks BOTH halves and the
 * seam between them, so a run that is green here cannot be green on one half.
 *
 * WHAT IS REAL HERE: the app's real shell/agent-host.cjs, driven with real
 * sessions whose provider child is really killed; and the engine's real
 * createLedgerContinuation with its real continuation store and real task
 * selection. The provider is the app's own confined-engine fixture, because
 * this proves scheduling rather than a model, and the manager reading handed to
 * the engine half is injected, because "is that circle still running" is a fact
 * about the host's session map and the engine has no session map.
 *
 * WHY THIS EXISTS BESIDE lane-M-hardest-20260919/t123-manager-outage-proof.mjs:
 * that script runs the two real halves against each other end to end and takes
 * minutes of real scheduler time per run, which is the right shape for an
 * acceptance run and the wrong shape for a mutation check. This one isolates
 * the same behaviour in seconds so a gate can be broken and restored.
 *
 * USAGE (no path, port, machine or account name is baked in):
 *   node <this file> --app <app worktree> --engine <engine worktree>
 *                    [--fixture <exiting provider fixture>]
 *   node <this file> --app <a> --engine <e> --mutate <name>   # break a gate: RED
 *   node <this file> --list-mutations
 * --fixture defaults to the app worktree's own copy. Give it explicitly when
 * running against a base commit that predates the fixture, so that ONLY
 * agent-host.cjs and the continuation controller differ between the two runs.
 * --mutate edits one worktree file, asserts the edit matched EXACTLY ONCE, and
 * restores it; see the note above MUTATIONS. A run without it writes nothing.
 * Exits 0 when every check passes, 1 otherwise.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

function argument(name, { required = true } = {}) {
  const at = process.argv.indexOf(`--${name}`)
  const value = at >= 0 ? process.argv[at + 1] : undefined
  if (required && (typeof value !== 'string' || value === '')) {
    console.error(`Missing --${name} <path>. See the usage note at the top of this file.`)
    process.exit(2)
  }
  return value ? path.resolve(value) : undefined
}

const APP = argument('app')
const ENGINE_ROOT = argument('engine')
const FIXTURE = argument('fixture', { required: false })
  || path.join(APP, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/exiting-codex-process.js')

/* ------------------------------------------------------------------ *
 * THE MUTATION CHECK, AND ITS OWN PROOF THAT IT APPLIED.
 *
 * A GATE THAT WAS NEVER BROKEN IS NOT A GATE THAT CANNOT BE BROKEN. Lane C
 * measured the failure this exists to stop: a mutation whose search string
 * matched nothing ran to completion and reported "still green", so a run that
 * proved only that the edit had silently not happened read as a run that
 * proved the gate held. So every mutation below counts its own matches and
 * REFUSES at anything but exactly one -- zero means the edit never landed, and
 * more than one means it is not the line this check claims to be breaking.
 *
 * WHY IT EDITS THE WORKTREE FILE AND HOW THAT IS MADE SAFE. This script loads
 * the real shell/agent-host.cjs and the real continuation controller out of the
 * trees it is pointed at, and both pull in siblings by relative require, so
 * there is no single file to copy aside and load instead. Instead:
 *   - a mutation run REFUSES on a file that differs from HEAD, so it can never
 *     be applied on top of somebody's uncommitted work;
 *   - the original bytes go to a sibling backup before the edit, and a run that
 *     finds a backup already there refuses rather than overwriting it, because
 *     an existing backup means an earlier run died mid-mutation;
 *   - the restore runs in a finally AND on exit, and it verifies the restored
 *     bytes equal the backup before it deletes it.
 * A run without --mutate writes nothing at all.
 * ------------------------------------------------------------------ */
const MUTATIONS = Object.freeze([
  Object.freeze({
    name: 'tombstone',
    what: 'the app stops writing down the ending it watched, so a dead manager becomes a circle nobody ever saw',
    file: () => path.join(APP, 'shell/agent-host.cjs'),
    find: "    noteTreeNodeEnded(session, 'exited')\n",
    replace: '',
  }),
  Object.freeze({
    name: 'release',
    what: 'the scheduler never marks the held report delivered, so every later turn asks for it again',
    file: () => path.join(ENGINE_ROOT, 'src/lib/ledger-continuation-controller.js'),
    find: "        if (managerTelling === 'release') state.managerHeldEpisodeId = null;\n",
    replace: '',
  }),
])

if (process.argv.includes('--list-mutations')) {
  for (const mutation of MUTATIONS) console.log(`${mutation.name}\n  ${mutation.what}`)
  process.exit(0)
}

const MUTATE = (() => {
  const at = process.argv.indexOf('--mutate')
  if (at < 0) return null
  const name = process.argv[at + 1]
  const found = MUTATIONS.find(mutation => mutation.name === name)
  if (!found) {
    console.error(`Unknown mutation ${JSON.stringify(name)}. Try --list-mutations.`)
    process.exit(2)
  }
  return found
})()

let restoreMutation = () => {}
if (MUTATE) {
  const file = MUTATE.file()
  const backup = `${file}.redgreen-backup`
  if (existsSync(backup)) {
    console.error(`A backup is already beside ${file}. An earlier mutation run died without restoring;`
      + ' put the original back by hand before running another.')
    process.exit(2)
  }
  const repo = file.startsWith(ENGINE_ROOT) ? ENGINE_ROOT : APP
  const relative = path.relative(repo, file).split(path.sep).join('/')
  const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--', relative], { encoding: 'utf8' })
  if (dirty.status !== 0) {
    console.error(`Could not ask git about ${relative}: ${(dirty.stderr || '').trim() || 'git did not run'}`)
    process.exit(2)
  }
  if (dirty.stdout.trim() !== '') {
    console.error(`${relative} differs from HEAD. A mutation run refuses to edit a file somebody is working in.`)
    process.exit(2)
  }
  const original = readFileSync(file, 'utf8')
  /* EXACTLY ONE, OR THIS PROVES NOTHING. */
  const occurrences = original.split(MUTATE.find).length - 1
  if (occurrences !== 1) {
    console.error(`Mutation ${JSON.stringify(MUTATE.name)} matched ${occurrences} time(s) in ${relative};`
      + ' it must match exactly once. Zero means the edit never landed and the run would report a green'
      + ' gate that was never broken.')
    process.exit(2)
  }
  writeFileSync(backup, original)
  writeFileSync(file, original.replace(MUTATE.find, MUTATE.replace))
  restoreMutation = () => {
    if (!existsSync(backup)) return
    const kept = readFileSync(backup, 'utf8')
    writeFileSync(file, kept)
    if (readFileSync(file, 'utf8') !== kept) {
      console.error(`RESTORE FAILED for ${relative}: put it back from ${backup} by hand.`)
      return
    }
    rmSync(backup, { force: true })
  }
  process.on('exit', restoreMutation)
  console.log(`# MUTATED ${MUTATE.name}: ${relative}, ${occurrences} match replaced`)
  console.log(`#   ${MUTATE.what}`)
}

/* A PRIVATE STATE ROOT, ALWAYS. The engine half opens a real continuation
   store; neither half may ever resolve the owner's live root. Set before
   anything that reads it is loaded. */
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'laneA-item4-'))
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state')
mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true })

const require_ = createRequire(import.meta.url)
const host_ = require_(path.join(APP, 'shell/agent-host.cjs'))
const engineFixture = require_(FIXTURE)
const controller = require_(path.join(ENGINE_ROOT, 'src/lib/ledger-continuation-controller.js'))
const { createContinuationState } = require_(path.join(ENGINE_ROOT, 'src/lib/agent-continuation-state.js'))

const checks = []
const skipped = []
/* A SKIP NAMES ITSELF AND ITS REASON. A run that stops measuring because an
   earlier answer made the rest meaningless must say how many checks it did not
   take: a shorter PASS list read as a total is the silent skip this codebase
   keeps re-finding. */
function skip(count, why) {
  skipped.push({ count, why })
  console.log(`SKIP  ${count} further check(s) not taken: ${why}`)
}
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`)
}

const CONTROLLER = 'node-controller'
const MANAGER = 'node-manager'
const WORKER = 'node-worker'
const ANCHORS = [CONTROLLER, MANAGER, WORKER]
const FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let value
    try { value = predicate() } catch { value = null }
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return null
}

function plan(workdir) {
  return {
    ok: true, tier: 'standard', isolated: true,
    threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly', 'toolsenabled'],
  }
}

/* A stand-in for the installed payload's controller that records the options
   the host handed it and the session objects the host passed back, so the
   callbacks below are invoked with the host's OWN live values rather than a
   shape this script invented. */
function recordingContinuation() {
  const seen = { options: null, sessions: new Map() }
  const noop = () => null
  const stub = new Proxy({}, {
    get(_target, property) {
      if (property === 'started') return session => { seen.sessions.set(session.sessionId, session) }
      if (property === 'instructions') return () => null
      if (property === 'enabled') return () => false
      if (property === 'then') return undefined
      return noop
    },
  })
  return { seen, loader: () => ({ createLedgerContinuation(options) { seen.options = options; return stub } }) }
}

async function treeSession(host, engine, { sessionId, selfName, managerName, anchors }) {
  await host.startSession({
    sessionId,
    requestKeys: { treeAnchors: anchors, threadId: anchors.at(-1) },
    treeIdentity: { selfName, managerName },
  })
  await host.sendTurn({ sessionId, text: `Tree address: you are "${selfName}".\n\nBegin.`, origin: 'brief' })
  engine.calls.at(-1).onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: `${sessionId}-t1`, status: 'completed' })
}

/* ------------------------------------------------------------------ *
 * HALF ONE: THE APP OBSERVES THE ENDING IT WATCHED.
 * ------------------------------------------------------------------ */
async function appHalf() {
  const workdir = mkdtempSync(path.join(SCRATCH, 'host-'))
  engineFixture.reset()
  const { seen, loader } = recordingContinuation()
  const host = host_.createAgentHost({
    freeMemory: FREE_MEMORY,
    enginePath: FIXTURE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  try {
    const wired = typeof seen.options?.readManagerState === 'function'
      && typeof seen.options?.onManagerUnavailable === 'function'
    check('the host offers the continuation controller a manager reading and an escalation route', wired,
      'the host gave the scheduler no way to learn that a manager stopped and nowhere to send the escalation')
    if (!wired) return skip(10, 'this build of the host reports on no manager, so there is no reading or escalation to measure')

    await treeSession(host, engineFixture, { sessionId: 'controller', selfName: 'Controller', managerName: null, anchors: [CONTROLLER] })
    await treeSession(host, engineFixture, { sessionId: 'manager', selfName: 'Manager 6', managerName: 'Controller', anchors: [CONTROLLER, MANAGER] })
    await treeSession(host, engineFixture, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
    const worker = seen.sessions.get('worker')
    if (!worker) { check('the host handed the scheduler its worker session', false, 'nothing below can be measured'); return skip(9, 'the host handed the scheduler no worker session') }

    check('a manager that is still answering is not an outage', seen.options.readManagerState(worker) === null,
      'a running manager was read as gone, which would have a worker abandon a manager that was about to answer')

    /* THE MEASURED EVENT: the manager's provider goes away and nobody asked it
       to. Index 1 is the manager -- the fixture indexes by start order. */
    if (engineFixture.exitAt(1) !== true) { check('the fixture produced a manager child to kill', false, 'nothing below is testing the measured state'); return skip(8, 'no manager child was produced, so the measured event cannot be staged') }
    /* AFTER CLEANUP, NOT DURING IT. cleanupEndedSession() removes the entry
       from the host's map asynchronously; a reading taken in that window is
       standing on a row that is about to disappear, and the state that matters
       is the one the worker's next five-second tick actually sees. */
    const gone = await waitFor(() => host.sessionActivity('manager') === null)
    check('the dead manager session has left the host, as it had on 2026-09-15', gone,
      'the entry never left, so nothing below is testing the measured state')
    if (!gone) return skip(7, 'the dead manager entry never left the host, so no reading taken after cleanup means anything')

    const fact = seen.options.readManagerState(worker)
    check('a worker whose manager\'s provider died can tell that its manager is gone', Boolean(fact),
      'the manager died and the worker read it as a circle this computer never saw, which makes no claim at all')
    check('the reading names the manager node and why', fact?.managerNodeId === MANAGER && fact?.reason === 'session-unavailable',
      `read ${fact?.managerNodeId ?? 'nothing'} / ${fact?.reason ?? 'no reason'}`)
    check('and it names the nearest live circle above the gap', fact?.ancestor?.sessionId === 'controller',
      `the escalation would go to ${fact?.ancestor?.sessionId ?? 'nobody'} instead of the Controller that was still running`)
    check('one continuing outage keeps one episode id', Boolean(fact) && seen.options.readManagerState(worker)?.episodeId === fact.episodeId,
      'the same outage read as a new episode, which tells the circle above the gap again on every poll')
    if (!fact) return skip(4, 'there is no outage fact to escalate')

    const accepted = seen.options.onManagerUnavailable(worker, fact, ['T-fixture-1'])
    check('the escalation is accepted and addressed to that live circle', accepted?.accepted === true && accepted.ancestorSessionId === 'controller',
      `the host answered ${JSON.stringify(accepted)}`)
    const notices = (typeof host.managerCoordinationNotices === 'function' ? host.managerCoordinationNotices() : [])
      .filter(notice => notice.fromSessionId === 'worker')
    check('the escalation is retained before it returns, exactly once', notices.length === 1,
      `${notices.length} notices were retained for one accepted escalation`)
    check('and it says the worker is still carrying its own work', notices[0]?.text.includes('T-fixture-1'),
      'the circle above the gap was told a worker was stuck but not that it is still working, which is the whole claim')
    check('nothing was spawned on the strength of the outage', engineFixture.calls.length === 3,
      `the host started ${engineFixture.calls.length} provider sessions; 3 is the Controller, Manager and Worker this script asked for`)
  } finally {
    await host.closeAll().catch(() => {})
    engineFixture.reset()
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

/* ------------------------------------------------------------------ *
 * HALF TWO: THE ENGINE DECIDES WHAT THE NEXT TURN SAYS.
 * ------------------------------------------------------------------ */
function engineHalf() {
  const TASK = 'T-outage-1'
  function scheduler({ reading }) {
    let time = 100_000, runner
    const keys = { threadId: WORKER, treeAnchors: ANCHORS }
    const session = { sessionId: 'worker', threadId: 'native-thread', treeRequestIdentity: keys }
    const sent = [], escalations = []
    runner = controller.createLedgerContinuation({
      now: () => time,
      stateFactory: () => createContinuationState({ file: ':memory:', now: () => time, leaseMs: 1000, baseDelayMs: 1000, maxDelayMs: 4000, maxRetries: 1 }),
      readSettings: () => ({ values: { [controller.SETTING_ID]: true }, provenance: { [controller.SETTING_ID]: { source: 'user' } } }),
      readTasks: () => [{ kind: 'T', id: TASK, scope: 'thread', scopeKey: WORKER, status: 'open', words: 'Finish the authorized work' }],
      selectTasks: records => records,
      isLive: () => true, canSend: () => true,
      send: async (worker, text) => { sent.push(text); runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }) },
      onPause: () => {},
      readManagerState: worker => reading(worker),
      onManagerUnavailable: (worker, fact, taskIds) => { escalations.push({ fact, taskIds }); return { accepted: true } },
    })
    runner.remember(session, { sessionId: session.sessionId, resumeThreadId: session.threadId, resumeThreadProvider: 'local', requestKeys: keys })
    runner.started(session, 'person')
    runner.completed(session, { status: 'completed' })
    return {
      runner, sent, escalations,
      poll: async () => { time += controller.INTERVAL_MS; runner.tick(); await new Promise(resolve => setImmediate(resolve)) },
      /* The person says something and the session answers. Real, and it resets
         the scheduler's unchanged-turn budget the way a real message does --
         without it the fourth poll on one unchanged task is a pause, and
         "nothing was sent" would read as "the release was not repeated". */
      person: () => { runner.started(session, 'person'); runner.completed(session, { status: 'completed' }) },
    }
  }
  const fact = Object.freeze({
    managerNodeId: MANAGER, managerSessionId: 'manager-session', managerName: 'Manager 6',
    reason: 'session-unavailable', episodeId: `${MANAGER}#manager-session#session-unavailable#0`,
    ancestor: { nodeId: CONTROLLER, sessionId: 'controller', name: 'Controller' },
  })
  /* THE SENTENCES ARE READ FROM THE MODULE, NOT QUOTED HERE. A pinned phrase
     fails against a better wording and the quickest way back to green is to
     put the old wording back. A base commit exports neither, which is itself
     the RED answer to "does this build decide anything at all". */
  const HOLD = controller.MANAGER_OUTAGE_HOLD
  const RELEASE = controller.MANAGER_OUTAGE_RELEASE
  const decides = typeof HOLD === 'string' && HOLD !== '' && typeof RELEASE === 'string' && RELEASE !== ''
  check('the scheduler has something to say about an unreachable manager', decides,
    'this build of the continuation controller has no outage sentence at all, so no turn can carry one')
  if (!decides) { skip(8, 'this build of the continuation controller carries no outage sentence, so no turn can be measured for one'); return Promise.resolve() }

  return (async () => {
    let down = true
    const f = scheduler({ reading: () => (down ? fact : null) })
    try {
      await f.poll()
      check('a session whose manager is gone is still given its next turn', f.sent.length === 1,
        'the session got no turn at all: this is the three-hour idle T123 measured, unchanged')
      check('that turn names the session\'s own filed ledger task', f.sent[0]?.includes(TASK),
        'the turn did not name the work the session is meant to continue')
      check('and it tells the session to hold the report its manager cannot read', f.sent[0]?.includes(HOLD),
        'the turn never said the manager was gone, so a refused send still reads as the end of the work')
      check('the circle above the gap is told once, with the work still being carried',
        f.escalations.length === 1 && f.escalations[0].taskIds.includes(TASK),
        `${f.escalations.length} escalations, carrying ${JSON.stringify(f.escalations[0]?.taskIds)}`)

      await f.poll()
      check('a continuing outage is still one escalation a poll later', f.escalations.length === 1,
        `${f.escalations.length} escalations; the circle above the gap is being told once per poll`)

      down = false
      await f.poll()
      const release = f.sent.at(-1)
      check('when the manager is reachable again the held report is released', release?.includes(RELEASE),
        'the manager came back and nothing told the session, so the report it was told to hold is held forever')
      check('and the release is not the outage sentence over again', release?.includes(HOLD) !== true,
        'a session told at once to hold and to send has been told nothing')

      const before = f.sent.length
      f.person()
      await f.poll()
      check('the release is said once, not on every later turn', f.sent.length > before && !f.sent.at(-1)?.includes(RELEASE),
        f.sent.length > before
          ? 'every later turn repeats the delivery instruction, so one queued report is sent over and over'
          : 'no later turn was dispatched at all, so this check could prove nothing either way')
    } finally {
      f.runner.close()
    }
  })()
}

/* A build whose host says nothing about any manager must behave exactly as it
   did: the seam is optional on the engine side, and a payload cut before it
   existed must not start changing turns. */
async function optionalSeam() {
  let text = null
  let time = 100_000, runner
  const keys = { threadId: WORKER, treeAnchors: ANCHORS }
  const session = { sessionId: 'worker', threadId: 'native-thread', treeRequestIdentity: keys }
  runner = controller.createLedgerContinuation({
    now: () => time,
    stateFactory: () => createContinuationState({ file: ':memory:', now: () => time, leaseMs: 1000, baseDelayMs: 1000, maxDelayMs: 4000, maxRetries: 1 }),
    readSettings: () => ({ values: { [controller.SETTING_ID]: true }, provenance: { [controller.SETTING_ID]: { source: 'user' } } }),
    readTasks: () => [{ kind: 'T', id: 'T-plain', scope: 'thread', scopeKey: WORKER, status: 'open', words: 'Finish the authorized work' }],
    selectTasks: records => records,
    isLive: () => true, canSend: () => true,
    send: async (worker, value) => { text = value; runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }) },
    onPause: () => {},
  })
  try {
    runner.remember(session, { sessionId: session.sessionId, resumeThreadId: session.threadId, resumeThreadProvider: 'local', requestKeys: keys })
    runner.started(session, 'person')
    runner.completed(session, { status: 'completed' })
    time += controller.INTERVAL_MS
    runner.tick()
    await new Promise(resolve => setImmediate(resolve))
    const clean = typeof text === 'string' && text.includes('T-plain')
      && !(controller.MANAGER_OUTAGE_HOLD && text.includes(controller.MANAGER_OUTAGE_HOLD))
      && !(controller.MANAGER_OUTAGE_RELEASE && text.includes(controller.MANAGER_OUTAGE_RELEASE))
    check('a host that reports on no manager changes no turn at all', clean,
      'a build with no manager reading started claiming an outage, which is a claim nobody evidenced')
  } finally {
    runner.close()
  }
}


/* ------------------------------------------------------------------ *
 * TWO INSTANCES, AND THE SECOND ONE IS THE ONE THAT MATTERS.
 *
 * A LANE RULE, EARNED THE HARD WAY. The gate that proved Lane A's seat fix
 * only ever built ONE store, so it was structurally blind to a whole class of
 * defect: the fix was strictly better on the first computer and worse in kind
 * on every other one, because the evidence it gated on lived at MODULE scope
 * and the second instance inherited the first instance's answer. Any fix that
 * touches module-level state now owes a check that builds at least two and
 * reads the second.
 *
 * WHAT THIS PROVES FOR T123. Every mutable thing this change introduces lives
 * inside a closure -- the host's watched-ending tombstones and its episode
 * ledger inside createAgentHost, the held/escalated episode ids on the
 * scheduler's per-session state. Nothing was hoisted to module scope. That is
 * a claim about where a `const` sits, and a claim like that is worth exactly
 * nothing the day somebody hoists one "just for the cache", so it is asserted
 * BY BEHAVIOUR instead: two hosts and two schedulers are built in ONE process
 * with DELIBERATELY IDENTICAL node keys, so any map that turned out to be
 * shared would collide loudly, and the second instance is the one read.
 * ------------------------------------------------------------------ */
async function twoInstances() {
  /* --- two hosts, same tree node keys, only the first one's manager dies --- */
  const dirA = mkdtempSync(path.join(SCRATCH, 'hostA-'))
  const dirB = mkdtempSync(path.join(SCRATCH, 'hostB-'))
  engineFixture.reset()
  const seenA = recordingContinuation()
  const seenB = recordingContinuation()
  const build = (workdir, loader) => host_.createAgentHost({
    freeMemory: FREE_MEMORY,
    enginePath: FIXTURE,
    defaultCwd: workdir,
    confinementPlanner: () => plan(workdir),
    ledgerContinuationLoader: loader,
  })
  const hostA = build(dirA, seenA.loader)
  const hostB = build(dirB, seenB.loader)
  try {
    if (typeof seenA.seen.options?.readManagerState !== 'function') {
      check('two hosts keep their watched endings apart', false,
        'this build of the host reports on no manager, so there is nothing to keep apart')
      return skip(1, 'the host offers no manager reading')
    }
    for (const [host, engineSeen] of [[hostA, seenA], [hostB, seenB]]) {
      await treeSession(host, engineFixture, { sessionId: 'controller', selfName: 'Controller', managerName: null, anchors: [CONTROLLER] })
      await treeSession(host, engineFixture, { sessionId: 'manager', selfName: 'Manager 6', managerName: 'Controller', anchors: [CONTROLLER, MANAGER] })
      await treeSession(host, engineFixture, { sessionId: 'worker', selfName: 'Worker 64', managerName: 'Manager 6', anchors: ANCHORS })
      void engineSeen
    }
    const workerA = seenA.seen.sessions.get('worker')
    const workerB = seenB.seen.sessions.get('worker')
    if (!workerA || !workerB) {
      check('both hosts handed their scheduler a worker session', false, 'nothing below can be measured')
      return skip(1, 'a host handed the scheduler no worker session')
    }

    /* Start order across the shared fixture: A is 0,1,2 and B is 3,4,5, so
       index 1 is the FIRST host's manager and only that one dies. */
    if (engineFixture.exitAt(1) !== true) {
      check('the fixture produced the first host\'s manager to kill', false, 'nothing below is testing the measured state')
      return skip(1, 'no manager child was produced')
    }
    const gone = await waitFor(() => hostA.sessionActivity('manager') === null)
    if (!gone) {
      check('the first host\'s dead manager left that host', false, 'the entry never left, so nothing below means anything')
      return skip(1, 'the dead manager entry never left the first host')
    }

    const factA = seenA.seen.options.readManagerState(workerA)
    const factB = seenB.seen.options.readManagerState(workerB)
    check('the first host reports the outage it watched', Boolean(factA),
      'the manager died on the first host and its report could not tell')
    check('and the SECOND host, whose manager is alive under the same node key, reports nothing',
      factB === null,
      `the second host answered ${JSON.stringify(factB)} for a manager that never stopped: one host's watched ending reached another host's tree`)

    const noticesB = (typeof hostB.managerCoordinationNotices === 'function' ? hostB.managerCoordinationNotices() : [])
    check('and the second host is holding no escalation', noticesB.length === 0,
      `${noticesB.length} notices were retained on a host whose manager never stopped`)
  } finally {
    await hostA.closeAll().catch(() => {})
    await hostB.closeAll().catch(() => {})
    engineFixture.reset()
    rmSync(dirA, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dirB, { recursive: true, force: true, maxRetries: 5 })
  }
}

/* The same question of the scheduler: two controllers in one process, one told
   its manager is gone and one told nothing, and the SECOND one's turn read. */
async function twoSchedulers() {
  const HOLD = controller.MANAGER_OUTAGE_HOLD
  if (typeof HOLD !== 'string' || HOLD === '') {
    check('two schedulers keep their outage episodes apart', false,
      'this build of the continuation controller carries no outage sentence')
    return skip(1, 'the controller carries no outage sentence')
  }
  const TASK = 'T-two-instances'
  const fact = Object.freeze({
    managerNodeId: MANAGER, managerSessionId: 'manager-session', managerName: 'Manager 6',
    reason: 'session-unavailable', episodeId: `${MANAGER}#manager-session#session-unavailable#0`,
    ancestor: { nodeId: CONTROLLER, sessionId: 'controller', name: 'Controller' },
  })
  function scheduler(reading) {
    let time = 100_000, runner
    const keys = { threadId: WORKER, treeAnchors: ANCHORS }
    const session = { sessionId: 'worker', threadId: 'native-thread', treeRequestIdentity: keys }
    const sent = [], escalations = []
    runner = controller.createLedgerContinuation({
      now: () => time,
      stateFactory: () => createContinuationState({ file: ':memory:', now: () => time, leaseMs: 1000, baseDelayMs: 1000, maxDelayMs: 4000, maxRetries: 1 }),
      readSettings: () => ({ values: { [controller.SETTING_ID]: true }, provenance: { [controller.SETTING_ID]: { source: 'user' } } }),
      readTasks: () => [{ kind: 'T', id: TASK, scope: 'thread', scopeKey: WORKER, status: 'open', words: 'Finish the authorized work' }],
      selectTasks: records => records,
      isLive: () => true, canSend: () => true,
      send: async (worker, text) => { sent.push(text); runner.started(worker, 'continuation'); runner.completed(worker, { status: 'completed' }) },
      onPause: () => {},
      readManagerState: () => reading(),
      onManagerUnavailable: (worker, seen) => { escalations.push(seen); return { accepted: true } },
    })
    runner.remember(session, { sessionId: session.sessionId, resumeThreadId: session.threadId, resumeThreadProvider: 'local', requestKeys: keys })
    runner.started(session, 'person')
    runner.completed(session, { status: 'completed' })
    return {
      runner, sent, escalations,
      poll: async () => { time += controller.INTERVAL_MS; runner.tick(); await new Promise(resolve => setImmediate(resolve)) },
    }
  }
  /* DELIBERATELY IDENTICAL session id, node key and episode id: two schedulers
     that shared any of their bookkeeping would collide on all three. */
  const down = scheduler(() => fact)
  const healthy = scheduler(() => null)
  try {
    await down.poll()
    await healthy.poll()
    check('the scheduler told of an outage says so', down.sent[0]?.includes(HOLD),
      'the outage sentence never reached the session whose manager is gone')
    check('and the SECOND scheduler, told nothing, changes no turn', healthy.sent[0] && !healthy.sent[0].includes(HOLD),
      'a scheduler that was told nothing claimed an outage: one instance\'s episode reached another')
    check('and it escalated nothing', healthy.escalations.length === 0,
      `${healthy.escalations.length} escalations from a scheduler that was told nothing`)
  } finally {
    down.runner.close()
    healthy.runner.close()
  }
}

async function main() {
  console.log(`# app     ${APP}`)
  console.log(`# engine  ${ENGINE_ROOT}`)
  console.log(`# fixture ${FIXTURE}`)
  console.log('')
  await appHalf()
  await engineHalf()
  await optionalSeam()
  await twoInstances()
  await twoSchedulers()
}

main().then(() => {
  const failed = checks.filter(row => !row.ok)
  console.log(`\n# checks ${checks.length}\n# pass ${checks.length - failed.length}\n# fail ${failed.length}
# not taken ${skipped.reduce((total, row) => total + row.count, 0)}`)
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5 })
  process.exit(failed.length === 0 ? 0 : 1)
}).catch(error => {
  console.error(`\nThe script itself could not run to the end: ${error?.stack || error}`)
  console.log(`# checks ${checks.length}\n# pass ${checks.filter(row => row.ok).length}\n# fail ${checks.filter(row => !row.ok).length}\n# aborted`)
  rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5 })
  process.exit(1)
})
