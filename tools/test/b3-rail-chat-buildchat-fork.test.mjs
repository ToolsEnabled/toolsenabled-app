import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* THE HAND-ROLLED FORK IS GONE, AND STAYS GONE.
 *
 * mountRailChat used to draw its own `<div class="chat chat-readonly">` for a
 * node with no channel: its own header, its own empty log, its own disabled-
 * composer sentence, kept in step with buildChat's real markup by hand. This
 * suite pins the file so a second fork cannot creep back in unnoticed, and
 * pins the replacement's shape: a buildChat() call carrying composerReason,
 * seed: 0 (never the three canned demonstration bubbles over an empty
 * transcript), and the copy module the reason string now lives in — the same
 * idiom tools/test/example-reparent-refusal.test.mjs and
 * tools/test/session-reply-paths.test.mjs already use for src/views/
 * computers.js, a DOM module too large to mount whole in this test process.
 *
 * MUTATION PROOF (recorded by hand, this file has no self-mutating harness):
 *   1. Ran unmutated: green (see the report for the quoted run).
 *   2. Reinstated the literal `<div class="chat chat-readonly">` markup in
 *      src/views/computers.js in place of the buildChat() call.
 *   3. Ran this file alone: 'the fork's own class name never appears again'
 *      went red, quoting the reinstated markup.
 *   4. Restored the file from git; sha256sum before the mutation and after
 *      the restore matched.
 *   5. Ran again: green. */

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const COPY = readFileSync(new URL('../../src/rail-readonly-chat-copy.js', import.meta.url), 'utf8')
/* Block comments stripped before the "is it really gone" scan below, so the
   documentation comment ABOVE the fix (which quotes the old markup on
   purpose, as evidence of what was removed) cannot itself satisfy the check
   it is describing — the exact trap tools/check-plain-language.mjs's own
   header warns about ("a naive scan finds the defect inside the note
   explaining that the defect was removed"). JS block comments do not nest,
   so a non-greedy strip is exact here. */
const VIEW_CODE_ONLY = VIEW.replace(/\/\*[\s\S]*?\*\//g, '')

test("the fork's own class name never appears again, as CODE rather than as a comment quoting history", () => {
  assert.ok(!VIEW_CODE_ONLY.includes('chat-readonly'),
    'a hand-rolled "chat-readonly" frame is back in src/views/computers.js — buildChat is no longer the only chat surface this file draws')
})

test('mountRailChat mounts the read-only channel through buildChat, with composerReason and no fabricated seed', () => {
  const mount = VIEW.slice(VIEW.indexOf('function mountRailChat'), VIEW.indexOf('function treeEngineFace'))
  assert.ok(mount.length > 0, 'mountRailChat is gone from src/views/computers.js')
  /* Two buildChat() calls live in this function: the sampleConversation
     branch (unchanged) and the composerReason branch this deliverable added.
     Scope to the second so a regression in the first cannot hide a missing
     second call, and vice versa. */
  const readOnlyBranch = mount.slice(mount.indexOf('} else {'))
  assert.match(readOnlyBranch, /mounted = buildChat\(\{/,
    'the read-only branch no longer calls buildChat — a fork may have come back under another shape')
  const call = readOnlyBranch.slice(0, readOnlyBranch.indexOf('host.appendChild(mounted)'))
  assert.match(call, /composerReason: plan\.composerReason \|\| plan\.contextHiddenReason \|\| RAIL_CHAT_COPY\.noChannel,/,
    'the composerReason wiring changed — the box could fall back to an invented sentence, or silently accept sends')
  assert.match(call, /seed: 0/,
    'seed: 0 is missing — an empty transcript here would fall through to buildChat\'s three canned demonstration bubbles')
  /* Comments stripped: this branch's own documentation names onSend and
     sampleConversation in prose (explaining the invariant it honours), which
     must not itself satisfy the "does not also pass them as code" check. */
  const callCodeOnly = call.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/onSend|sampleConversation:\s*true/.test(callCodeOnly),
    'the read-only branch now also passes onSend or sampleConversation as code — a channel with no reason could send, or fabricate a reply')
})

test('the read-only fallback sentence lives in a copy module, not inline', () => {
  assert.match(VIEW, /import \{ RAIL_CHAT_COPY \} from '\.\.\/rail-readonly-chat-copy\.js'/,
    'src/views/computers.js no longer imports RAIL_CHAT_COPY — the fallback reason may be inlined again')
  assert.match(COPY, /noChannel:\s*'No channel to this agent\.'/,
    'the copy module\'s sentence changed — src/views/computers.js and this pin must change together')
})
