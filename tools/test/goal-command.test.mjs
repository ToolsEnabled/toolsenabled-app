/* `/goal` SETS A GOAL ON THE RUNNING AGENT, and -- when an R id is typed --
 * also records one build-queue item.
 *
 * WHAT THESE TESTS USED TO ASSERT, AND WHY IT WAS THE DEFECT. This file began
 * "`/goal` is the product's record-only door into the strict build queue" and
 * its copy test was named "help, usage, confirmation, and refusals all say
 * record-only". It required an R id before anything could happen at all:
 * '/goal write this down' was listed under `invalid` and asserted to parse to
 * `goalUsageSentence()`, whose words were "Nothing was recorded and no agent
 * was started."
 *
 * Ledger T61, owner A23, overruled that: "Goal must function like the CLI
 * /goal: a goal set in the app makes the agent work autonomously until the
 * goal is achieved. It is NOT record-only." Those assertions were pinning the
 * behaviour the owner reported as broken ("theres still issues with goal"),
 * so they are changed here rather than worked around.
 *
 * WHAT DID NOT CHANGE, and is still asserted below: the R id is never
 * invented, guessed, lowercased or extracted from the objective; the queue
 * write keeps its fail-closed CAS ordering and its exact payload; and both
 * composers still consume `/goal` before any outbox or model send. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { PALETTE_PANEL } from '../../src/fleet-tree-copy.js'

import {
  GOAL_BRIEF_MAX_BYTES,
  GOAL_OBJECTIVE_MAX_BYTES,
  GOAL_REQUEST_ID_RE,
  GOAL_TITLE_MAX_CODE_POINTS,
  goalConfirmationSentence,
  goalNoSessionSentence,
  goalPendingSentence,
  goalRefusalSentence,
  goalTitleFromObjective,
  goalTooLongSentence,
  goalUsageSentence,
  parseSlashCommand,
  slashHelpSentence,
} from '../../src/slash-commands.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')

function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n')
}

test('goal parsing accepts a case-insensitive command but preserves an explicit canonical R authority and exact objective', () => {
  assert.deepEqual(
    parseSlashCommand('  /GoAl R1234 Preserve  both spaces\nand this second line.  '),
    {
      kind: 'goal',
      operation: 'set',
      directiveId: 'R1234',
      objective: 'Preserve  both spaces\nand this second line.',
    },
  )
  assert.deepEqual(
    parseSlashCommand('/GOAL R52.3 versioned request objective'),
    { kind: 'goal', operation: 'set', directiveId: 'R52.3', objective: 'versioned request objective' },
    'an explicit canonical request version remains the authority instead of being reduced to its root',
  )
  assert.equal(GOAL_REQUEST_ID_RE.test('R1'), true)
  assert.equal(GOAL_REQUEST_ID_RE.test('R9999'), true)
})

test('goal parsing never invents, infers, repairs, or lowercases an R authority', () => {
  /* AN R ID IS NO LONGER REQUIRED, SO THESE ARE GOALS RATHER THAN REFUSALS.
     What must still hold is the part that was always about authority: the
     words are kept verbatim as the objective and NO directiveId is invented
     from them. Each of these used to assert `goalUsageSentence()` -- "Nothing
     was recorded and no agent was started" -- which is the defect. */
  const noAuthority = [
    '/goal write this down',
    '/goal r1234 lowercase authority',
    '/goal Q123 queue phase is not authority',
    '/goal R0123 leading zero is not canonical',
    '/goal R10000 too many root digits',
    '/goal R1234.0 zero version',
    '/goal R1234.01 padded version',
  ]
  for (const input of noAuthority) {
    const parsed = parseSlashCommand(input)
    assert.equal(parsed.kind, 'goal')
    assert.equal(parsed.operation, 'set', `${input} must set a goal rather than refuse`)
    assert.equal(parsed.directiveId, null, `${input} must not invent a queue authority`)
    assert.equal(parsed.objective, input.slice('/goal '.length),
      `${input} must keep the person's words exactly as the objective`)
  }

  /* `/goal R1234` with no objective after it is a goal whose objective is the
     R id itself -- the person typed words and the words are kept -- and it
     still opens no queue item, because a queue item needs a brief. */
  const idOnly = parseSlashCommand('/goal R1234')
  assert.equal(idOnly.operation, 'set')
  assert.equal(idOnly.directiveId, null, 'a bare R id is an objective, not authority for an empty brief')
  assert.equal(idOnly.objective, 'R1234')

  // The canonical form itself is unchanged.
  assert.equal(GOAL_REQUEST_ID_RE.test('r1234'), false)
  assert.equal(GOAL_REQUEST_ID_RE.test('R0123'), false)
  assert.equal(GOAL_REQUEST_ID_RE.test('R10000'), false)
  assert.equal(GOAL_REQUEST_ID_RE.test('R1234.0'), false)
})

test('goal shows and clears without setting anything', () => {
  assert.deepEqual(parseSlashCommand('/goal'), { kind: 'goal', operation: 'show' })
  assert.deepEqual(parseSlashCommand('/goal   '), { kind: 'goal', operation: 'show' })
  assert.deepEqual(parseSlashCommand('/goal clear'), { kind: 'goal', operation: 'clear' })
  assert.deepEqual(parseSlashCommand('/GOAL CLEAR'), { kind: 'goal', operation: 'clear' })
  /* "clear" only means clear when it is the WHOLE instruction. A person whose
     goal is to clear something said so in a sentence, and throwing their goal
     away instead would be the worst possible reading of it. */
  const sentence = parseSlashCommand('/goal clear the build queue')
  assert.equal(sentence.operation, 'set')
  assert.equal(sentence.objective, 'clear the build queue')
})

test('goal parsing admits the exact UTF-8 objective boundary and refuses one byte beyond it before any write', () => {
  const asciiBoundary = 'a'.repeat(GOAL_OBJECTIVE_MAX_BYTES)
  const asciiAccepted = parseSlashCommand(`/goal R1234 ${asciiBoundary}`)
  assert.equal(asciiAccepted.kind, 'goal')
  assert.equal(asciiAccepted.directiveId, 'R1234')
  assert.equal(asciiAccepted.objective, asciiBoundary, 'an admitted ASCII brief must remain exact')
  assert.deepEqual(
    parseSlashCommand(`/goal R1234 ${asciiBoundary}a`),
    { kind: 'goal', sentence: goalTooLongSentence() },
  )

  const multibyteBoundary = '\u{1F680}'.repeat(GOAL_OBJECTIVE_MAX_BYTES / 4)
  assert.equal(Buffer.byteLength(multibyteBoundary, 'utf8'), GOAL_OBJECTIVE_MAX_BYTES)
  const multibyteAccepted = parseSlashCommand(`/goal R52.3 ${multibyteBoundary}`)
  assert.equal(multibyteAccepted.directiveId, 'R52.3')
  assert.equal(multibyteAccepted.objective, multibyteBoundary, 'an admitted multibyte brief must remain exact')
  assert.deepEqual(
    parseSlashCommand(`/goal R52.3 ${multibyteBoundary}\u{1F680}`),
    { kind: 'goal', sentence: goalTooLongSentence() },
  )

  const refusal = goalTooLongSentence()
  assert.match(refusal, /no goal was set/i)
  assert.match(refusal, /shorten it/i)
  assert.doesNotMatch(refusal, /BRIDGE_|QUEUE_/)
  /* ONE BOUND ON ONE TYPED STRING. `/goal R1234 <objective>` opens a queue
     item AND sets a goal from the same words, so a goal bound tighter than the
     brief bound would refuse one half of a `/goal` the other half accepted,
     with nothing on screen saying why. This asserts they agree by VALUE rather
     than asserting the number, so changing the number in one place and not the
     other is what goes red. */
  assert.equal(GOAL_OBJECTIVE_MAX_BYTES, GOAL_BRIEF_MAX_BYTES,
    'the goal and the queue brief bound the same typed string, so they are one number')
})

test('goal remains distinct from the local /queue session outbox command', () => {
  assert.deepEqual(parseSlashCommand('/queue send this after the turn'), {
    kind: 'action', action: 'queue', rest: 'send this after the turn',
  })
  assert.deepEqual(parseSlashCommand('/goal R1234 record this for the build queue'), {
    kind: 'goal', operation: 'set', directiveId: 'R1234', objective: 'record this for the build queue',
  })
})

test('goal title derivation is single-line, Unicode-safe, and bounded below the engine title limit', () => {
  assert.equal(
    goalTitleFromObjective('  First line\n\nsecond\tline  '),
    'First line second line',
  )
  const longObjective = `Start ${'\u{1F680}'.repeat(300)} finish`
  const title = goalTitleFromObjective(longObjective)
  assert.equal(Array.from(title).length, GOAL_TITLE_MAX_CODE_POINTS)
  assert.equal(title.endsWith('\u2026'), true)
  assert.equal(title.includes('\n'), false)
  assert.ok(Buffer.byteLength(title, 'utf8') < 2 * 1024, 'the derived title must stay inside the bridge\'s 2 KiB bound')
  assert.equal(longObjective.endsWith('finish'), true, 'deriving a title must not mutate the exact objective used as the brief')
})

test('help, usage, confirmation and refusals describe a goal that WORKS, and never expose bridge internals', () => {
  /* THE ASSERTIONS THIS REPLACES ARE THE DEFECT, VERBATIM. This test was
     named "...all say record-only" and required:
       assert.match(help, /without starting an agent/i)
       assert.match(usage, /nothing was recorded/i)
       assert.match(usage, /no agent was started/i)
       assert.match(confirmation, /no agent was started/i)
       assert.match(pending, /no agent is being started/i)
       assert.match(sentence, /no agent was started/i)  // every refusal
     An agent IS now started, so every one of those would be a false promise
     to the person reading it. What is asserted instead is that the copy tells
     them what will actually happen and how to end it. */
  const help = slashHelpSentence()
  assert.match(help, /\/goal <objective>/)
  assert.match(help, /on its own/i, 'the help must say the agent keeps working by itself')
  assert.match(help, /\/goal clear/, 'and how to stop it')
  assert.doesNotMatch(help, /without starting an agent/i,
    'the help must not still promise that /goal starts nothing')

  const usage = goalUsageSentence()
  assert.match(usage, /no goal was set/i, 'a refused command says what did not happen')
  assert.match(usage, /on its own/i)
  assert.doesNotMatch(usage, /no agent was started/i,
    'the usage sentence must not claim nothing was started when a valid goal starts one')

  /* The queue half keeps its own confirmation, and it is now about the QUEUE
     ONLY: what the agent is doing is reported separately by the goal. */
  const confirmation = goalConfirmationSentence('Q81', 'R1234')
  assert.match(confirmation, /Q81/)
  assert.match(confirmation, /R1234/)
  assert.match(confirmation, /build queue/i)
  assert.doesNotMatch(confirmation, /no agent was started/i)

  const pending = goalPendingSentence()
  assert.match(pending, /goal/i)
  assert.doesNotMatch(pending, /no agent is being started/i)

  assert.match(goalNoSessionSentence(), /not running/i,
    'a goal typed at an agent that is not running must say so plainly')
  assert.match(goalNoSessionSentence(), /start it first/i, 'and name the one thing the person can do')

  for (const reason of ['disabled', 'unavailable', 'unconfirmed', 'noSession', 'goalUnconfirmed', 'unknown-reason']) {
    const sentence = goalRefusalSentence(reason)
    assert.ok(sentence.length > 30, `${reason} must be a sentence a person can act on`)
    assert.doesNotMatch(sentence, /BRIDGE_|QUEUE_|[a-f0-9]{64}|[A-Z]:\\/i,
      `${reason} reflected an internal code, hash, or path`)
    assert.doesNotMatch(sentence, /no agent was started/i,
      `${reason} must not deny an agent start that may have happened`)
  }
  /* The three queue refusals still name the queue, so a person can tell which
     of the two writes they are being told about. */
  for (const reason of ['disabled', 'unavailable', 'unconfirmed']) {
    assert.match(goalRefusalSentence(reason), /build[- ]queue/i,
      `${reason} must identify the build queue rather than the goal or the session outbox`)
  }
  assert.match(goalRefusalSentence('unconfirmed'), /could not confirm whether/i,
    'an uncertain post-write result must not falsely claim that nothing was recorded')
  assert.doesNotMatch(goalRefusalSentence('unconfirmed'), /nothing was recorded/i)
})

test('both composer seams intercept kind:goal before any model send or local outbox write (mutation: route bypass)', () => {
  const source = read('src/views/computers.js')

  const busyStart = source.indexOf('add: text => {')
  const busyEnd = source.indexOf('cancel: id =>', busyStart)
  const busy = source.slice(busyStart, busyEnd)
  assert.ok(busyStart !== -1 && busyEnd !== -1)
  assert.ok(busy.indexOf("slash.kind === 'goal'") !== -1
    && busy.indexOf("slash.kind === 'goal'") < busy.indexOf('queueForSession'),
  'the busy composer can queue /goal as a model message')
  /* THE ROUTE MOVED FROM recordGoalFor TO runGoalFor, which is the fix: the
     first only wrote a queue row, the second sets the goal on the running
     session and records the queue row when an R id was typed. */
  assert.match(busy, /runGoalFor\(node, slash\)/)
  assert.match(busy, /setOrgStatus\(goalPendingSentence\(\), 'busy', \{ sticky: true \}\)/,
    'the fresh status read and goal write can leave a busy composer with no loading feedback')

  const cardStart = source.indexOf('function treeCardSend')
  const cardEnd = source.indexOf('function removeOptimisticUserEntry', cardStart)
  const card = source.slice(cardStart, cardEnd === -1 ? cardStart + 7000 : cardEnd)
  assert.ok(cardStart !== -1)
  assert.ok(card.indexOf("slash.kind === 'goal'") !== -1
    && card.indexOf("slash.kind === 'goal'") < card.indexOf('outboxEnqueue')
    && card.indexOf("slash.kind === 'goal'") < card.indexOf('bridge.send'),
  'treeCardSend can send /goal to an outbox or model before acting on it')
  assert.match(card, /runGoalFor\(node, slash\)/)
  assert.match(card, /fail\(goalPendingSentence\(\)\)/,
    'the card can wait on the goal write with no visible feedback')
})

test('the one goal controller serves both composers and the palette entry', () => {
  /* ACCEPTANCE POINT 1 OF T61: the same behaviour on the full conversation
     composer, the right-rail composer and the palette "Goal" entry. The
     palette composes `/goal ` into whichever composer the person is at, so
     all three reach the same parse and the same controller -- which is what
     stops the three surfaces from drifting apart. */
  const source = read('src/views/computers.js')
  assert.equal((source.match(/async function runGoalFor\(/g) || []).length, 1,
    'there must be exactly one goal controller, not one per surface')
  assert.equal((source.match(/void runGoalFor\(node, slash\)/g) || []).length, 2,
    'both composer seams must call it')
  assert.match(source, /run: ctx => ctx\.compose\('\/goal ', PALETTE_PANEL\.goalHint\)/,
    'the palette entry must compose /goal into the composer rather than build its own path')

  /* The palette hint is what a person reads before they use it, so it must
     describe the behaviour they will get. */
  assert.match(PALETTE_PANEL.goalHint, /on its own/i)
  assert.doesNotMatch(PALETTE_PANEL.goalHint, /^Record an objective in the build queue\./,
    'the palette hint must not still describe /goal as a queue record')
})

test('goal recording uses a fresh first-root CAS snapshot and the exact open-only payload (mutation: authority or dispatch widening)', () => {
  const source = read('src/views/computers.js')
  const start = source.indexOf('async function recordGoalFor')
  const end = source.indexOf('function treeCardSend', start)
  assert.ok(start !== -1 && end !== -1, 'the goal recorder is not in the computer view')
  const recorder = codeOnly(source.slice(start, end))

  const flagAt = recorder.indexOf("isWriteEnabled('queue')")
  const statusAt = recorder.indexOf('await bridgeStatus()')
  const postAt = recorder.indexOf("postBridgeAction('queue'")
  assert.ok(flagAt !== -1 && statusAt > flagAt && postAt > statusAt,
    'permission, fresh status, and queue write are not ordered fail-closed')
  assert.doesNotMatch(recorder, /prepareBridgeOnce\(/, 'a cached status can feed the queue CAS write')
  assert.match(recorder, /Array\.isArray\(status\.roots\)\s*\?\s*status\.roots\[0\]/,
    'the recorder does not deterministically choose the current first root')
  assert.match(recorder, /Object\.hasOwn\(queues, rootId\)/)
  assert.match(recorder, /queue\?\.ok === true/)
  assert.match(recorder, /GOAL_HASH_RE\.test/)

  assert.match(recorder, /operation:\s*'open'/)
  assert.match(recorder, /title:\s*goalTitleFromObjective\(slash\.objective\)/)
  assert.match(recorder, /authority:\s*`\$\{slash\.directiveId\} \(directiveId: \$\{slash\.directiveId\}\)`/)
  assert.match(recorder, /brief:\s*slash\.objective/,
    'the exact parsed objective is not the queue brief')
  assert.doesNotMatch(recorder, /brief:\s*slash\.objective\.(slice|substring)|brief:\s*goalTitleFromObjective/,
    'the queue brief is truncated or replaced by its display title')
  assert.doesNotMatch(recorder, /postBridgeAction\('dispatch'|runPaletteAction\('dispatch'|bridge\.send|outboxEnqueue/,
    'the record-only goal path acquired a dispatch, model-send, or session-outbox side effect')
  assert.match(recorder, /verifiedGoalQueueReceipt\(result, expectedHash, rootId\)/,
    'the view can confirm a goal without checking the queue-open receipt')
})

import vm from 'node:vm'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { validAuditReceiptPair } from '../../src/mission-bridge.js'
const basicGoalAudit = (action, target) => ({ ok: true, disposition: 'not-required', required: false, recorded: false,
  durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action, target })
function goalReceiptFixture() {
  const hash = 'a'.repeat(64)
  const posted = []
  const context = vm.createContext({ GOAL_HASH_RE: /^[a-f0-9]{64}$/, GOAL_PHASE_RE: /^Q[1-9]\d{0,2}$/,
    validAuditReceiptPair, isWriteEnabled: () => true,
    bridgeStatus: async () => ({ ok: true, roots: ['main'], queues: { main: { ok: true, hash } } }),
    goalTitleFromObjective, goalConfirmationSentence, goalRefusalSentence,
    postBridgeAction: async (action, body) => { posted.push({ action, body }); return context.reply },
  })
  const source = read('src/views/computers.js')
  for (const name of ['validGoalAuditReceipt', 'verifiedGoalQueueReceipt', 'recordGoalFor']) {
    if (source.includes(`function ${name}(`)) vm.runInContext(declaredFunctionSource(source, name), context)
  }
  const reply = { ok: true, receipt: { action: 'queue-open', phaseId: 'Q81', queuePath: '/fixture/BUILD-QUEUE.md',
    previousHash: hash, nextHash: 'b'.repeat(64),
    intentAudit: basicGoalAudit('build.queue.open.intent', 'main'), audit: basicGoalAudit('build.queue.open', 'Q81') } }
  return { context, posted, hash, reply }
}
test('Basic queue Goal confirms only its current root, CAS hash and exact new phase without replay', async () => {
  const f = goalReceiptFixture()
  f.context.reply = f.reply
  const result = await f.context.recordGoalFor({ objective: 'Exact work', directiveId: 'R1234' })
  assert.equal(result.ok, true)
  assert.match(result.sentence, /Q81/)
  assert.equal(f.posted.length, 1)
  assert.equal(f.posted[0].body.rootId, 'main')
  assert.equal(f.posted[0].body.expectedHash, f.hash)
  assert.equal(f.posted[0].body.brief, 'Exact work')
  for (const change of [row => { row.receipt.intentAudit.target = 'other-root' }, row => { row.receipt.audit.target = 'Q82' },
    row => { row.receipt.previousHash = 'c'.repeat(64) }, row => { row.receipt.nextHash = 'bad' },
    row => { row.receipt.phaseId = 'invalid' }, row => { row.receipt.queuePath = '' },
    row => { row.receipt.audit = { ok: true } }, row => { row.ok = false }]) {
    const reply = structuredClone(f.reply); change(reply)
    f.context.reply = reply
    const count = f.posted.length
    assert.equal((await f.context.recordGoalFor({ objective: 'Exact work', directiveId: 'R1234' })).ok, false)
    assert.equal(f.posted.length, count + 1, 'uncertain delivery is not replayed')
  }
})

import { refusalCode } from '../../src/agent-availability-copy.js'

/* THE SAME ENDED-SESSION MISMATCH, ON THE TYPED DOOR.
 *
 * runGoalFor is the ONE controller both composers and the palette reach (the
 * test above pins that), so a code it does not recognise is wrong on all
 * three surfaces at once. shell/agent-command-surface.cjs refuses a retained
 * but ended session with ENDED_SESSION_REFUSAL -- 'MC_AGENT_SESSION_ENDED' --
 * and this branch compared against the relay's 'AGENT_SESSION_ENDED', so a
 * person who typed /goal at an agent that had stopped was told the screen
 * "could not confirm" it, which reads as a fault in the app and invites a
 * retry, instead of the one fact they can act on: it is not running.
 *
 * The set is read out of the view so this file cannot certify a box that has
 * drifted from the product's own terminal codes. */
const TERMINAL_CODES = new Function(`return ${
  /const TERMINAL_AGENT_SESSION_CODES = (new Set\(\[[^\]]*\]\))/.exec(read('src/views/computers.js'))[1]}`)()

function goalControllerFixture(thrown) {
  const calls = []
  const context = vm.createContext({
    treeStore: { getNode: id => (id === 'node-1' ? { id: 'node-1', sessionId: 'session-1' } : null) },
    window: { mcAgent: { goal: async request => { calls.push(request); throw thrown } } },
    START_NEEDS_APP_TEXT: () => 'an app window is needed to reach the goal.',
    goalRefusalSentence, refusalCode, TERMINAL_AGENT_SESSION_CODES: TERMINAL_CODES,
    recordGoalFor: async () => ({ ok: true, sentence: 'Recorded.' }),
  })
  vm.runInContext(declaredFunctionSource(read('src/views/computers.js'), 'runGoalFor'), context)
  return { context, calls }
}
const ipcError = code => new Error(`Error invoking remote method 'mc-agent:goal': Error: ${code}`)

test('a typed /goal on an ended session says it is not running, and a transient refusal still says unconfirmed', async () => {
  assert.ok(TERMINAL_CODES.has('MC_AGENT_SESSION_ENDED') && TERMINAL_CODES.has('MC_AGENT_UNKNOWN_SESSION'),
    'the view must treat both of the surface\'s dead-session refusals as terminal')

  for (const code of ['MC_AGENT_SESSION_ENDED', 'MC_AGENT_UNKNOWN_SESSION']) {
    const f = goalControllerFixture(ipcError(code))
    const result = await f.context.runGoalFor({ id: 'node-1' }, { operation: 'show' })
    assert.equal(result.ok, false)
    assert.equal(result.sentence, goalRefusalSentence('noSession'), `${code} must name the agent as not running`)
    // Fields, not deepEqual: the request is built inside the vm realm.
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].sessionId, 'session-1')
    assert.equal(f.calls[0].operation, 'get')
  }

  /* NOT WIDENED. Anything that is not terminal keeps its honest "could not
     confirm", because for those the next attempt really can answer. */
  const transient = goalControllerFixture(ipcError('AGENT_SESSION_NOT_READY'))
  const pending = await transient.context.runGoalFor({ id: 'node-1' }, { operation: 'show' })
  assert.equal(pending.ok, false)
  assert.equal(pending.sentence, goalRefusalSentence('goalUnconfirmed'))
})
