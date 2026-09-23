import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* THE WORKING ROW'S step(), FED FROM REAL SESSION STATE AND HEARD LIVE.
 *
 * Two separate defects, both closed here:
 *   1. treeChatConfigFor's status object never carried a step() at all, so
 *      buildChat's working row (src/components.js syncComposer, which reads
 *      `status.step()` while `status.busy()` is true) always rendered no text
 *      and stayed hidden — a five-minute turn showed nothing running.
 *   2. Once step() existed, the value it reads (nodeActivity, a map already
 *      fed by every tool-call/tool-result event on the wire) is mutated many
 *      times a SECOND while a turn runs, and nothing told the composer's
 *      status.subscribe() listener about any of those mutations — only
 *      turn-start and turn-end went through refreshTree() (which is where
 *      notifyNodeStatusListeners() lives). So a mounted chat's working row
 *      would still have gone stale for the length of a whole turn even with
 *      step() wired, because subscribe() was never re-fired mid-turn.
 *
 * Source-pinned against src/views/computers.js, the idiom this suite already
 * uses for this file's internal wiring (see tools/test/session-reply-
 * paths.test.mjs, tools/test/example-reparent-refusal.test.mjs) — a DOM
 * module the size of a small program, whose closures are not separately
 * exported for direct unit testing. */

const VIEW = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '')

test("treeChatConfigFor's status carries a real step(), reading nodeActivity rather than inventing text", () => {
  const cfg = VIEW.slice(VIEW.indexOf('function treeChatConfigFor'), VIEW.indexOf('function chatActionRowsFor'))
  const cfgCode = strip(cfg)
  assert.match(cfgCode, /step: \(\) => nodeActivity\.get\(node\.id\) \|\| ''/,
    "status.step() no longer reads nodeActivity by node id — the working row would show a fabricated or stale string")
})

test('the activity branch tells the composer on every line, not only at turn start and end', () => {
  const setIdx = VIEW.indexOf('nodeActivity.set(nodeId, line)')
  assert.ok(setIdx !== -1, 'nodeActivity.set(nodeId, line) is gone from the session-event listener')
  const boundIdx = VIEW.indexOf('scheduleChipRefresh(nodeId)', setIdx)
  assert.ok(boundIdx !== -1, 'scheduleChipRefresh(nodeId) no longer follows the activity branch — the window this test scans has moved')
  const windowCode = strip(VIEW.slice(setIdx, boundIdx))
  assert.match(windowCode, /notifyNodeStatusListeners\(\)/,
    "the activity branch no longer calls notifyNodeStatusListeners() — a chat's working row goes stale for the length of a turn again")
})
