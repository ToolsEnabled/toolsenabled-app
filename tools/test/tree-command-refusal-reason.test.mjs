/* THE REASON HAS TO SURVIVE THE LAST TWO HOPS.
 *
 * src/main.js now carries a bounded `reason` beside a refusal code (see
 * tools/test/tree-node-command-drain.test.mjs). Two things stood between that
 * string and the assistant that asked:
 *
 *   1. shell/main.cjs resolveLocalTreeCommand built the rejection sentence
 *      from two code tables and nothing else, so the reason arrived and was
 *      dropped at the hop where it would have been read.
 *
 *   2. shell/tree-node-command.cjs normalizeRendererResult pinned the result
 *      to exactly six keys. The SAME completion IPC serves a spooled request,
 *      so a result carrying `reason` would have failed publication four times
 *      and come back MC_TREE_COMMAND_RESULT_WRITE_FAILED for a correct answer.
 *      The key is admitted and dropped; the stored schema is unchanged.
 *
 * And one more hole on the way in: dispatchTreeSpawn ignored queueRequest's
 * `false` (a disposed broker, an id it already knew), so a request the broker
 * refused waited on the full delivery timer with nothing to answer it.
 *
 *   node tools/test/tree-command-refusal-reason.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { treeCommandRefusalSentence, MAX_REASON_CHARS, TREE_COMMAND_REFUSAL_SENTENCES } = require('../../shell/tree-command-refusal-sentences.cjs')
const { normalizeRendererResult } = require('../../shell/tree-node-command.cjs')

const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

test('a refusal with a reason names the errand, the code, and then the reason', () => {
  const line = treeCommandRefusalSentence('create-and-start-node', 'MC_TREE_COMMAND_START_FAILED', 'No launcher for that tier on this computer.')
  assert.equal(line, 'The application could not add that assistant to the tree (MC_TREE_COMMAND_START_FAILED). No launcher for that tier on this computer.')
})

test('a code with a named sentence keeps it; the reason does not restate the rule', () => {
  const named = treeCommandRefusalSentence('remove-node', 'MC_TREE_COMMAND_REMOVE_PERSON_SPOKE', 'ignored')
  assert.equal(named, treeCommandRefusalSentence('remove-node', 'MC_TREE_COMMAND_REMOVE_PERSON_SPOKE'))
  assert.doesNotMatch(named, /ignored/)
})

/* THE IDENTITY GATE'S FIX, PROVEN THROUGH THE FUNCTION THAT ACTUALLY SPEAKS
 * TO THE CALLER, NOT JUST PINNED AS SOURCE TEXT.
 *
 * freshStartExistingNodeUnguarded's identity gate (src/views/computers.js)
 * computes a specific sentence for MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE --
 * a role removed from the library, an org revision conflict, an unavailable
 * seat store are all the same code with different causes -- and, as of the
 * commit this test accompanies, returns it as `reason`. Whether an assistant
 * actually reads that specific sentence or only the generic one depends
 * entirely on ONE fact about this table: that MC_TREE_COMMAND_ROLE_BINDING_
 * UNAVAILABLE has no entry in TREE_COMMAND_REFUSAL_SENTENCES above. If a
 * later author "helpfully" gave this code a fixed sentence here -- exactly
 * the pattern the six codes above it already follow -- the `named` branch
 * would win, the specific reason would never be appended, and the fix that
 * added `reason: identityReason` would still return it, unread by anyone,
 * with no test anywhere going red. tools/test/start-draft-node-anonymous-
 * reason.test.mjs pins that computers.js RETURNS the field; this is the one
 * place that pins the field is actually SPOKEN, through the real function
 * shell/main.cjs calls. */
test('the identity gate\'s refusal has no fixed sentence, so its computed reason is what an assistant actually reads', () => {
  const line = treeCommandRefusalSentence(
    'fresh-start-existing-node',
    'MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE',
    'The Role library could not be read, so this agent could not be given a declared identity. Reload this page, then try again.',
  )
  assert.equal(
    line,
    'The application could not restart that circle (MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE). '
    + 'The Role library could not be read, so this agent could not be given a declared identity. Reload this page, then try again.',
  )
  assert.ok(
    !Object.prototype.hasOwnProperty.call(TREE_COMMAND_REFUSAL_SENTENCES, 'MC_TREE_COMMAND_ROLE_BINDING_UNAVAILABLE'),
    'a future named entry for this code would silently swallow the identity gate\'s specific reason',
  )
})

test('an empty, blank, or non-string reason leaves the generic line exactly as it was', () => {
  const plain = treeCommandRefusalSentence('stop-node', 'MC_TREE_COMMAND_STOP_FAILED')
  for (const reason of [null, undefined, '', '   ', 42, { message: 'x' }, ['x']]) {
    assert.equal(treeCommandRefusalSentence('stop-node', 'MC_TREE_COMMAND_STOP_FAILED', reason), plain, String(reason))
  }
  assert.equal(plain, 'The application could not stop that circle (MC_TREE_COMMAND_STOP_FAILED).')
})

/* resume-node named its errand at the same time as the gate that let it reach
 * this file at all (src/main.js cleanTreeNodeCommand). Before that entry
 * existed, a resume refusal with no named sentence for its code fell back to
 * TREE_COMMAND_ERRANDS's own default, "carry out that request on the tree" --
 * a real, if vaguer, sentence, never a crash -- so this is a wording
 * improvement pinned as behaviour, not a missing-key regression test. */
/* A VIEW TORN DOWN MID-WAIT IS A RACE, NOT A REFUSAL -- AND MUST NOT READ AS
 * AN INTERNAL ERROR.
 *
 * MEASURED: agent.remove refused MC_TREE_COMMAND_VIEW_DESTROYED, then the
 * identical command succeeded three times in the next 33 seconds; agent.spawn
 * refused it and succeeded under a minute later on a plain retry. Before this code had an entry in
 * TREE_COMMAND_REFUSAL_SENTENCES, treeCommandRefusalSentence fell through to
 * the generic line -- indistinguishable from any other unnamed code, and
 * upstream readers rendered it as an internal error. This does not add retry
 * logic (a policy call for Controller); it only says, in the assistant's own
 * words, that nothing was done and the command may simply be sent again. */
test('a view torn down mid-wait gets a named sentence, not the generic fallback an internal error would produce', () => {
  const line = treeCommandRefusalSentence('remove-node', 'MC_TREE_COMMAND_VIEW_DESTROYED')
  assert.notEqual(line, 'The application could not remove that circle (MC_TREE_COMMAND_VIEW_DESTROYED).',
    'bad value: the generic fallback line is what an internal error also produces -- this code needs its own words')
  assert.match(line, /rebuilt itself while the command was still waiting/)
  assert.match(line, /not a refusal/i)
  assert.match(line, /again/)
})

test('a resume refusal without a named sentence names the errand as resuming, not the generic fallback', () => {
  const line = treeCommandRefusalSentence('resume-node', 'MC_TREE_COMMAND_RESUME_REFUSED')
  assert.equal(line, 'The application could not resume that circle (MC_TREE_COMMAND_RESUME_REFUSED).')
  assert.doesNotMatch(line, /carry out that request on the tree/)
})

test('a runaway reason is cut at the bound and a NUL is stripped, before it becomes an Error message', () => {
  const line = treeCommandRefusalSentence('fresh-start-existing-node', 'MC_TREE_COMMAND_CLOSE_FAILED', `a\0b${'x'.repeat(10_000)}`)
  const prefix = 'The application could not restart that circle (MC_TREE_COMMAND_CLOSE_FAILED). '
  assert.ok(line.startsWith(`${prefix}ab`))
  assert.equal(line.length, prefix.length + MAX_REASON_CHARS)
  assert.doesNotMatch(line, /\0/)
})

/* Integrated 2026-09-04 with the hand-off lane: the stored result schema now
   admits `reason` as its one optional key, so the gate KEEPS a bounded refusal
   reason instead of dropping it -- a spooled caller reads why it was refused.
   It still refuses any other extra key and still requires every required one. */
test('the spool result gate admits and keeps a bounded renderer reason, and still refuses any other extra key', () => {
  const request = { requestId: 'tnc-11111111-1111-4111-8111-111111111111', nodeId: 'node-1' }
  const refused = normalizeRendererResult({
    requestId: request.requestId, ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: 'node-1', sessionId: null, threadId: null,
    reason: 'The store said no.',
  }, request)
  assert.deepEqual(refused, { ok: false, code: 'MC_TREE_COMMAND_START_FAILED', sessionId: null, threadId: null, reason: 'The store said no.' })
  const succeeded = normalizeRendererResult({
    requestId: request.requestId, ok: true, code: null, nodeId: 'node-1', sessionId: 'session-1', threadId: null,
  }, request)
  assert.equal(succeeded.reason, null, 'a success carries no reason')
  assert.throws(() => normalizeRendererResult({
    requestId: request.requestId, ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: 'node-1', sessionId: null, threadId: null,
    displayName: 'smuggled',
  }, request), /unsupported field/i)
  assert.throws(() => normalizeRendererResult({
    requestId: request.requestId, ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: 'node-1', sessionId: null,
    reason: 'a reason cannot stand in for a required key',
  }, request), /missing a required field/i)
})

test('main.cjs hands the renderer reason to the sentence, and answers a queue that said no at once', () => {
  const main = withoutComments(readFileSync(path.join(repo, 'shell', 'main.cjs'), 'utf8'))
  const start = main.indexOf('function resolveLocalTreeCommand(')
  const resolve = main.slice(start, main.indexOf('function dispatchTreeSpawn(', start))
  assert.match(resolve, /treeCommandRefusalSentence\(envelope\?\.request\?\.action, code, result\?\.reason\)/)

  const dispatch = main.slice(main.indexOf('function dispatchTreeSpawn('), main.indexOf('let treeNodeCommandDispatchEnabled'))
  assert.match(dispatch, /queued = queueTreeNodeCommand\(requestId\)/)
  assert.match(dispatch, /if \(!queued\) \{\s*\n\s*settle\(reject, treeSpawnError\(\s*\n?\s*'MC_TREE_COMMAND_REQUEST_REFUSED'/)
})

/* THE SAME GAP AS resume-node's, ONE RELEASE LATER, FOR THE FIVE MANAGED-SLOT
 * VERBS.
 *
 * The slot redesign gave an assistant five ways to reconfigure a circle below
 * it -- agent.set_model, .set_effort, .set_account, .set_provider, .set_role --
 * and every one of them travels the SAME broker errand as a stop or a restart
 * (capability/src/lib/agent-tree-spawn.js TREE_ACTIONS). Their refusals are
 * ordinary and frequent: a slot outside the caller's managed scope, a model
 * this copy cannot start, a role assignment cancelled before it landed. Each
 * one reached shell/main.cjs resolveLocalTreeCommand and was worded by
 * TREE_COMMAND_ERRANDS, which had no entry for any of them -- so a manager
 * that asked for a model change read "The application could not carry out that
 * request on the tree", the table's own default for a verb it does not know.
 *
 * Pinned against TREE_ACTIONS rather than a retyped list of five, because the
 * defect is not these five strings being absent: it is a verb reaching this
 * file that nobody taught it to name. A tenth verb added to that table without
 * an errand here fails this test instead of shipping the vague line again. */
test('every tree verb an assistant can ask for names its own errand, not the table default', () => {
  const { TREE_ACTIONS } = require('../../capability/src/lib/agent-tree-spawn.js')
  const actions = Object.values(TREE_ACTIONS)
  assert.ok(actions.length >= 9, 'the payload must expose the lifecycle and managed-slot verbs, or this measures nothing')
  for (const action of actions) {
    const line = treeCommandRefusalSentence(action, 'MC_TREE_COMMAND_ACTION_REFUSED')
    assert.doesNotMatch(line, /carry out that request on the tree/,
      `bad value: ${action} falls back to the default errand, so its refusal does not say what was asked`)
  }
})

test('a managed-slot refusal names the configuration change that was asked for', () => {
  assert.equal(treeCommandRefusalSentence('set-node-model', 'TREE_CONFIGURATION_CHOICE_REFUSED', 'This copy cannot start that model.'),
    'The application could not change the model on that circle (TREE_CONFIGURATION_CHOICE_REFUSED). This copy cannot start that model.')
  assert.equal(treeCommandRefusalSentence('set-node-effort', 'TREE_CONFIGURATION_CHOICE_REFUSED'),
    'The application could not change how hard that circle thinks (TREE_CONFIGURATION_CHOICE_REFUSED).')
  assert.equal(treeCommandRefusalSentence('set-node-role', 'TREE_CONFIGURATION_REFUSED'),
    'The application could not change the role on that circle (TREE_CONFIGURATION_REFUSED).')
})
