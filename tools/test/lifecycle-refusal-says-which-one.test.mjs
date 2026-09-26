/* A REFUSED STOP OR RESUME MUST NOT SEND THE READER ROUND THE SAME LOOP FOR EVER.
 *
 * MEASURED by reading the shipped 1.0.46 sources named below, not by guessing.
 *
 * WHAT A PERSON READ. src/native-person-stop.js closed its bridge call with a
 * bare `catch` -- `catch { return { closed: false, savedState: 'pending' } }` --
 * which is the whole of what the application knows about a refused Stop thrown
 * away one line after it arrives. src/views/computers.js then printed one
 * sentence for every cause alike:
 *
 *     'The agent was not confirmed stopped. It may still be running; press
 *      Stop again.'
 *
 * That is sound advice for a close that timed out. It is a dead end for the
 * codes this suite names, every one of which refuses the second press exactly
 * as it refused the first:
 *
 *   MC_AGENT_UNKNOWN_SESSION   shell/agent-command-surface.cjs ownedAgentSession
 *   MC_AGENT_SESSION_ENDED     the same function, session.ended === true
 *   AGENT_SESSION_UNKNOWN      shell/agent-host.cjs closeSession
 *   AGENT_TREE_RECOVERY_UNAVAILABLE
 *                              shell/agent-host.cjs retireTreeQueue, whose own
 *                              words are "The engine cannot retain queued agent
 *                              messages. Update it before closing this session."
 *
 * WHY THE WORDS COULD NOT SIMPLY BE FORWARDED. shell/main.cjs
 * rendererSafeAgentError rebuilds every agent rejection as `new Error(code)`
 * with `safe.code = code` -- no path, no stack, no internal prose crosses to a
 * window, deliberately. The code is the entire message, so the renderer is the
 * only place the sentence can be written, and dropping the code in the catch
 * was dropping the last thing anybody could write it from.
 *
 * WHAT IS PINNED HERE, IN BOTH DIRECTIONS.
 *   1. the code survives the close rejection (and the resolved-unconfirmed
 *      answer, which agent:close also uses to refuse a consumed recovery
 *      ticket);
 *   2. each named code gets its own sentence, which shows no identifier and
 *      does not tell the person to press Stop again;
 *   3. everything else keeps the sentence it has always had -- an unknown code
 *      must not become a blank or a shrug;
 *   4. the codes in the table are really raised by the shell, read out of the
 *      shell sources at run time, so a stale entry is a failure here rather
 *      than a sentence nothing can reach;
 *   5. both Stop doors -- the person's palette and an assistant's agent.stop --
 *      compose through the same function, because a person and the assistant
 *      they asked must not be told different things about one refusal.
 *
 * AND THE SAME DISEASE ONE VERB OVER. runTreeNodeCommand's resume-node gate
 * refused three different states -- a circle mid-turn, a circle whose
 * replacement is already starting, and a circle whose last session never
 * finished closing -- with MC_TREE_COMMAND_RESUME_REFUSED and no `reason`, so
 * shell/tree-command-refusal-sentences.cjs (which has no fixed sentence for
 * that code) handed the asking assistant "The application could not resume
 * that circle (MC_TREE_COMMAND_RESUME_REFUSED)." and nothing else. That is the
 * owner's own sore spot -- agent control of other agents -- answered with a
 * grep term. Each state now carries its own sentence, and the last case below
 * pins that the shell table still has no entry for the code, because one would
 * win over all three and none of them would ever be read.
 *
 * Run alone with:
 *   node --test tools/test/lifecycle-refusal-says-which-one.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closeRefusalCode, stopNativePersonSession } from '../../src/native-person-stop.js'
import { PALETTE_PANEL, stopRefusalSentence } from '../../src/fleet-tree-copy.js'

const ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const read = name => readFileSync(join(ROOT, name), 'utf8')

/* The codes whose refusal a second press cannot cure, each with the file that
   raises it. Both halves are checked: the sentence, and that the raise is real. */
const TERMINAL_CLOSE_CODES = Object.freeze({
  MC_AGENT_UNKNOWN_SESSION: 'shell/agent-command-surface.cjs',
  MC_AGENT_SESSION_ENDED: 'shell/agent-command-surface.cjs',
  AGENT_SESSION_UNKNOWN: 'shell/agent-host.cjs',
  AGENT_TREE_RECOVERY_UNAVAILABLE: 'shell/agent-host.cjs',
})

/* An identifier as this product writes them. A sentence a person reads may not
   contain one -- the rule src/refusal-copy.js states and this table obeys. */
const BARE_IDENTIFIER = /\b[A-Z][A-Z0-9_]{5,}\b/

const stripBlockComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '')

function fixture() {
  const events = []
  const node = { id: 'node-a', sessionId: 'session-a' }
  const deps = {
    current: () => true,
    close: async () => ({ ok: true, closed: true, sessionId: 'session-a' }),
    forgetCleanup: id => events.push(['forget', id]),
    clearOutbox: () => 0,
    settle: id => events.push(['settle', id]),
    retire: id => events.push(['retire', id]),
    resetMetrics: () => {},
    ownsNode: () => true,
    saveStopped: () => ({ ok: true, snapshot: { persistenceFailed: false } }),
    recorded: () => true,
  }
  return { node, deps, events }
}

/* ---- 1. the code survives the refusal ---- */

test('a close rejected the way the IPC boundary rejects carries its code out of the catch', async () => {
  for (const code of Object.keys(TERMINAL_CLOSE_CODES)) {
    const f = fixture()
    /* Exactly the shape shell/main.cjs rendererSafeAgentError produces:
       `new Error(code)` with the same string on `.code`. */
    f.deps.close = async () => { const error = new Error(code); error.code = code; throw error }
    const result = await stopNativePersonSession(f.node, f.deps)
    assert.equal(result.closed, false, `${code}: a refused close must still report closed:false`)
    assert.equal(result.savedState, 'pending', `${code}: a refused close must still be admission-uncertain`)
    assert.equal(result.code, code, `${code}: the refusal's own identifier was dropped in the catch`)
    assert.deepEqual(f.events, [], `${code}: a refused close must perform no cleanup`)
  }
})

test('a close that resolves unconfirmed with a code carries that code too', async () => {
  const f = fixture()
  f.deps.close = async () => ({ ok: false, closed: false, code: 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE' })
  const result = await stopNativePersonSession(f.node, f.deps)
  assert.equal(result.closed, false)
  assert.equal(result.code, 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE')
})

test('a rejection that names nothing code-shaped carries null, never a scrap of prose', async () => {
  const f = fixture()
  f.deps.close = async () => { throw new Error('Cannot read properties of undefined (reading \'sessionId\')') }
  const result = await stopNativePersonSession(f.node, f.deps)
  assert.equal(result.code, null, 'a JavaScript fault must not be mistaken for a refusal identifier')
  assert.equal(stopRefusalSentence(result.code), PALETTE_PANEL.stopFailed,
    'with no code the copy must fall back to the sentence it has always printed')
})

test('closeRefusalCode reads a code from either field and refuses anything else', () => {
  assert.equal(closeRefusalCode({ code: 'AGENT_SESSION_UNKNOWN' }), 'AGENT_SESSION_UNKNOWN')
  assert.equal(closeRefusalCode(new Error('AGENT_SESSION_UNKNOWN')), 'AGENT_SESSION_UNKNOWN')
  assert.equal(closeRefusalCode({ code: 'provider AGENT_SESSION_UNKNOWN' }), null)
  assert.equal(closeRefusalCode({ message: 'the session could not be closed' }), null)
  assert.equal(closeRefusalCode(null), null)
  assert.equal(closeRefusalCode(undefined), null)
  assert.equal(closeRefusalCode('AGENT_SESSION_UNKNOWN'), null)
})

/* ---- 2. each named code gets a sentence that is not the loop ---- */

test('a refusal a second press cannot cure never tells the person to press Stop again', () => {
  for (const code of Object.keys(TERMINAL_CLOSE_CODES)) {
    const said = stopRefusalSentence(code)
    assert.notEqual(said, PALETTE_PANEL.stopFailed, `${code} still reads as the catch-all`)
    assert.doesNotMatch(said, /press Stop again\.(?!\s|$)|; press Stop again/,
      `${code} still ends by telling the person to do the thing that just refused`)
    assert.match(said, /[Pp]ressing Stop again refuses the same way/,
      `${code} does not say that a second press changes nothing, which is the whole point`)
    assert.doesNotMatch(said, BARE_IDENTIFIER, `${code} puts an identifier in a sentence a person reads: ${said}`)
    assert.ok(said.length > 60 && /[.!?]$/.test(said), `${code} reads oddly: ${said}`)
    /* A refused close proves nothing about the child process, so every one of
       these opens on the same honest head the catch-all opens on. */
    assert.ok(said.startsWith('The agent was not confirmed stopped.'),
      `${code} claims more about the agent than a refused close establishes: ${said}`)
  }
})

test('the engine-too-old refusal says what to do about the engine, not about Stop', () => {
  const said = stopRefusalSentence('AGENT_TREE_RECOVERY_UNAVAILABLE')
  assert.match(said, /updated/, 'the one cure the engine itself named is missing')
  assert.match(said, /messages waiting for it/, 'it does not say what refusing the close protected')
})

/* ---- 3. the floor is unchanged ---- */

test('the view reaches the translation through PALETTE_PANEL, which every eval fixture already holds', () => {
  /* Both Stop branches are closure-private and a dozen suites run their SOURCE
     through `new Function(...Object.keys(scope), body)`, so a free identifier
     the fixtures do not declare is a reference error in all of them. */
  assert.equal(typeof PALETTE_PANEL.stopRefusal, 'function')
  for (const code of [...Object.keys(TERMINAL_CLOSE_CODES), null, 'AGENT_NOBODY_HAS_SEEN_THIS_YET']) {
    assert.equal(PALETTE_PANEL.stopRefusal(code), stopRefusalSentence(code),
      `PALETTE_PANEL.stopRefusal and stopRefusalSentence disagree about ${code}`)
  }
})

test('an unknown code, no code, or a non-string keeps the sentence this control has always printed', () => {
  for (const value of [null, undefined, '', '   ', 42, {}, [], 'AGENT_NOBODY_HAS_SEEN_THIS_YET', 'MC_AGENT_TURN_ACTIVE']) {
    assert.equal(stopRefusalSentence(value), PALETTE_PANEL.stopFailed,
      `${JSON.stringify(value)} changed the floor sentence`)
  }
  assert.match(PALETTE_PANEL.stopFailed, /press Stop again/,
    'the floor is the one place "press Stop again" is still the right advice')
})

/* ---- 4. the table names refusals the shell really raises ---- */

test('every code with its own Stop sentence is really raised by the shell', () => {
  for (const [code, file] of Object.entries(TERMINAL_CLOSE_CODES)) {
    assert.match(read(file), new RegExp(`['"\`]${code}['"\`]`),
      `${code} has a Stop sentence but ${file} no longer raises it -- remove the entry rather than keeping copy nothing can reach`)
  }
})

/* ---- 5. both Stop doors compose through the same function ---- */

test('the person\'s Stop control composes its refusal from the close\'s own code', () => {
  const view = stripBlockComments(read('src/views/computers.js'))
  const start = view.indexOf('const result = await closePersonNode(node, request => bridge.close(request))')
  assert.notEqual(start, -1, 'the palette Stop branch no longer closes through closePersonNode')
  const branch = view.slice(start, start + 600)
  assert.match(branch, /PALETTE_PANEL\.stopRefusal\(result\.code\)/,
    'the palette Stop branch prints one sentence for every cause again')
  assert.doesNotMatch(branch.split('\n').slice(0, 3).join('\n'), /PALETTE_PANEL\.stopFailed/,
    'the palette Stop branch reaches past the translation to the catch-all')
})

test('an assistant\'s agent.resume is told WHICH of the three refusals it hit', () => {
  /* The gate is closure-private, so the same source-slice idiom this repository
     already uses for both Stop branches (tools/test/stop-node-race-guard.test.mjs)
     pins it. What is checked is the invariant, not the prose: the branch must
     carry a reason, and the reason must differ per state. */
  const view = stripBlockComments(read('src/views/computers.js'))
  const start = view.indexOf('if (nodeBusy(node) || nodeReplacementFlight.busy(node.id) || nodeCleanupPending(node)) {')
  assert.notEqual(start, -1, 'the resume-node busy gate was renamed or removed')
  const branch = view.slice(start, view.indexOf("if (!isWriteEnabled(START_CONTROL_FLAG))", start))
  assert.match(branch, /reason:/, 'the resume refusal leaves as a bare identifier again')
  const sentences = [...branch.matchAll(/'((?:[^'\\]|\\.){40,})'/g)].map(match => match[1])
  assert.equal(sentences.length, 3, `expected one sentence per state, found ${sentences.length}`)
  assert.equal(new Set(sentences).size, 3, 'two of the three states share a sentence, so they cannot be told apart')
  for (const said of sentences) {
    assert.doesNotMatch(said, BARE_IDENTIFIER, `an identifier reached the assistant as prose: ${said}`)
    assert.ok(/[.!?]$/.test(said.replace(/\\'/g, "'")), `not a whole sentence: ${said}`)
  }
  /* shell/tree-command-refusal-sentences.cjs appends a reason only to its
     GENERIC line, so a fixed sentence for this code there would silently
     swallow all three. Pin that it still has none. */
  const table = read('shell/tree-command-refusal-sentences.cjs')
  const named = table.slice(table.indexOf('const TREE_COMMAND_REFUSAL_SENTENCES'), table.indexOf('const MAX_REASON_CHARS'))
  assert.doesNotMatch(named, /MC_TREE_COMMAND_RESUME_REFUSED/,
    'a fixed sentence for this code would win over the three computed reasons and none of them would ever be read')
})

test('an assistant\'s agent.stop is given the same sentence, not the identifier it used to get', () => {
  const view = stripBlockComments(read('src/views/computers.js'))
  const start = view.indexOf("if (command.action === 'stop-node') {")
  assert.notEqual(start, -1, 'the tree-command stop-node branch was renamed or removed')
  const branch = view.slice(start, view.indexOf("if (command.action === 'remove-node') {", start))
  assert.match(branch, /reason: PALETTE_PANEL\.stopRefusal\(refusalCode\(error\)\)/,
    'the stop-node refusal reason is not composed from the same translation the person gets')
  assert.doesNotMatch(branch, /reason: error\?\.message/,
    'the stop-node refusal hands an assistant a bare identifier as prose again')
})
