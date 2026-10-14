// TWO COMMENTS THAT DESCRIBE OTHER FILES BY COUNT, AND DRIFTED.
//
// src/agent-availability-copy.js and src/refusal-copy.js each carry a header
// that states a FACT about code elsewhere -- a code that is still live, a
// table with a stated number of entries -- rather than just showing the
// entry and trusting the reader to count. That is more honest than silence
// right up until the fact it states stops being true, at which point it is
// actively misleading: a person reading "the session limit is still reached"
// has no reason to doubt it, because the sentence does not look like a claim
// that could go stale.
//
// MEASURED 2026-09-03. shell/agent-command-surface.cjs removed the
// session-limit ceiling on 2026-09-02 (commit "There is no ceiling on how
// many agents may be running at once"; tools/test/started-sessions-are-
// released.test.mjs pins MC_AGENT_SESSION_LIMIT gone from that file). But
// src/agent-availability-copy.js, written 2026-08-17, still said in the
// present tense that "the session limit is still reached" -- describing a
// path that had not existed for a day. Separately, src/refusal-copy.js's
// note about src/views/agent.js's local START_REFUSAL_TEXT table said
// "three-entry" and "the two BRIDGE_ / MC_AGENT_SESSION_LIMIT phrasings"
// while the table it describes actually holds FOUR entries -- two distinct
// BRIDGE_ codes (BRIDGE_ALL_SEATS_BUSY, BRIDGE_CLAUDE_UNAVAILABLE), not one.
//
// Both are fixed by this change. This suite is what keeps them fixed: it
// reads the real source on both sides of each claim and fails the moment
// they disagree again, rather than trusting the next person to notice a
// sentence that reads just as confidently whether it is true or not.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')

const NUMBER_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
})

/* Brace-matched, the same technique tools/test/started-sessions-are-released
   .test.mjs uses to find a destroy() body: this table's own text can contain
   `{` or `}` inside a sentence, so a regex that stops at the first `}` would
   under-count. */
function objectLiteralBody(source, declarationNeedle) {
  const at = source.indexOf(declarationNeedle)
  assert.ok(at >= 0,
    `"${declarationNeedle}" was not found in the source -- it moved, was renamed, or was removed. `
    + 'Update this test to find whatever replaced it before trusting its count.')
  const open = source.indexOf('{', at)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`"${declarationNeedle}": braces never balance`)
}

function topLevelKeyCount(body) {
  return (body.match(/^\s{4}[A-Z][A-Z0-9_]*:/gm) || []).length
}

test('refusal-copy.js states the true size of the START_REFUSAL_TEXT table it describes', () => {
  const agentSource = read('src/views/agent.js')
  const body = objectLiteralBody(agentSource, 'const START_REFUSAL_TEXT = Object.freeze({')
  const trueCount = topLevelKeyCount(body)
  assert.ok(trueCount > 0, 'found the START_REFUSAL_TEXT object but counted zero entries in it -- the key pattern this test uses no longer matches, fix the test')

  const refusalCopySource = read('src/refusal-copy.js')
  const match = refusalCopySource.match(/a small one: the file keeps its own (\w+)-entry\s*\n\s*table beside the shared one/)
  assert.ok(match,
    'src/refusal-copy.js no longer has the SEVENTH-source note describing views/agent.js\'s '
    + 'START_REFUSAL_TEXT table by size (looked for "keeps its own <word>-entry table"). '
    + 'If the note was reworded rather than deleted, point this test at the new wording.')

  const statedWord = match[1].toLowerCase()
  const stated = NUMBER_WORDS[statedWord]
  assert.ok(stated !== undefined,
    `src/refusal-copy.js names an entry count ("${statedWord}") this test does not have a number for. Extend NUMBER_WORDS above.`)

  assert.equal(stated, trueCount,
    `src/refusal-copy.js says views/agent.js keeps a ${statedWord}-entry START_REFUSAL_TEXT table, but it actually `
    + `has ${trueCount}. The comment describes the code by count instead of showing it, which means it goes stale `
    + 'silently the next time an entry is added or removed -- update the comment\'s count to match the code (or, '
    + 'if the comment is now the accurate one, this test has drifted instead and should be fixed to match it).')
})

test('agent-availability-copy.js does not claim the removed session-limit ceiling is still reached', () => {
  const availability = read('src/agent-availability-copy.js')
  assert.doesNotMatch(availability, /these clears by pressing Start again: the session limit is still reached/,
    'src/agent-availability-copy.js still tells a maintainer that the session-limit ceiling fires on the '
    + 'mc-agent:start path. shell/agent-command-surface.cjs removed that ceiling 2026-09-02 ("There is no '
    + 'ceiling on how many agents may be running at once"), and tools/test/started-sessions-are-released.test.mjs '
    + 'pins MC_AGENT_SESSION_LIMIT gone from that file -- so this sentence is describing a path that cannot fire '
    + 'from a local start any more. Fix the comment (or, if the ceiling genuinely came back on purpose, update '
    + 'this test alongside started-sessions-are-released.test.mjs, not instead of it).')
})

/* A REFUSAL MUST NAME THE CHEAPEST REMEDY THAT WORKS, NOT THE MOST EXPENSIVE
 * ONE THAT ALSO WOULD.
 *
 * MEASURED 2026-09-19 on the owner's own tree. A close-failed circle
 * (node-24-d7961725) was cleared by "Remove this agent" alone: ok true, the
 * application still running, every other agent untouched. The sentence the
 * product showed for that state instead read "Close ToolsEnabled to end every
 * session, then open it again" -- so a person with ONE wedged agent was told
 * to end every other agent on the computer, losing every running turn, to
 * clear it. The control that works was already on that circle's own menu and
 * already enabled for it.
 *
 * These two check the PROPERTY rather than the wording: the sentence must not
 * send the reader to close the application, and it must name a remedy. Either
 * sentence may be rewritten freely; it may not go back to costing the whole
 * tree. */
/* "without closing ToolsEnabled" is the REASSURANCE, not the instruction, so a
   bare /closing ToolsEnabled/ would fail against the very sentence that fixes
   this -- it did, on the first run. What is refused is being TOLD to close the
   application, so a mention preceded by "without" is explicitly allowed. */
const sendsReaderToCloseTheApp = /(?<!without )clos(e|ing) ToolsEnabled|close the app|quit ToolsEnabled|restart ToolsEnabled/i

test('the close-failed refusal names a remedy that keeps the rest of the tree running', () => {
  const { UNAVAILABLE_TEXT } = require('../../src/agent-availability-copy.js')
  const sentence = UNAVAILABLE_TEXT.AGENT_SESSION_CLEANUP_FAILED
  assert.equal(typeof sentence, 'string')

  assert.doesNotMatch(sentence, sendsReaderToCloseTheApp,
    'the close-failed sentence tells the reader to close ToolsEnabled. Measured 2026-09-19: one agent.remove '
    + 'cleared a circle in exactly this state with the app running and every other agent untouched, so this '
    + 'sentence is asking a person to end every running turn on the computer to fix one circle.')

  assert.match(sentence, /Remove this agent/,
    'the close-failed sentence does not name the control that clears this state. "Remove this agent" is already '
    + 'on the circle\'s own menu and already enabled for it; a refusal that names no remedy leaves the reader to '
    + 'guess, which is how the close-the-whole-app answer got used.')

  assert.match(sentence, /other agent|keeps? running|still running/i,
    'the sentence names Remove but does not say the rest of the tree survives it. That is the fact that makes '
    + 'Remove the cheap remedy rather than a scarier-sounding one.')
})

test('the resume close-failed sentence still has a way out when Stop does not clear it', () => {
  const { RESUME_PANEL } = require('../../src/fleet-tree-copy.js')
  const sentence = RESUME_PANEL.closeFailed
  assert.equal(typeof sentence, 'string')

  /* Stop first is still the right order and is not being removed. What this
     refuses is a sentence whose ONLY instruction is Stop: measured the same
     day, Stop answered a bare internal error on five consecutive calls on
     node-35-4f5a2c39, and answered MC_TREE_COMMAND_SESSION_ENDED on one call
     and the internal error on the next -- so a reader who only has Stop has
     nothing left when Stop will not take. */
  assert.match(sentence, /Stop/, 'Stop is still worth trying first and should still be named')
  assert.match(sentence, /Remove this agent/,
    'the resume close-failed sentence offers only Stop. Stop has been measured answering a bare internal error '
    + 'on five consecutive calls on a wedged circle, so a reader following this sentence has no way out; name '
    + 'the control that does clear it.')
  assert.doesNotMatch(sentence, sendsReaderToCloseTheApp,
    'the resume close-failed sentence sends the reader to close the application')
})
