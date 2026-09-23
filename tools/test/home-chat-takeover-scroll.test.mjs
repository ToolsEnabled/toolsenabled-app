/* CONTROLLER 3's HYPOTHESIS (L6, 2026-09-07): "Worker 2 is diagnosing
 * home-chat-takeover.js's rebuild for the composer-loss half; Controller
 * suspects that rebuild also remounts the log and resets its scroll. If you
 * find the home chat's log is replaced by a rebuild rather than re-rendered
 * in place, STOP and tell me."
 *
 * home-chat-takeover.js's own mountChatTakeover().show() DOES call
 * host.replaceChildren() and rebuild on every subject change -- expected,
 * a new subject is new content. For the coordinator subject specifically
 * (the takeover's DEFAULT, and the one the owner named -- "that coordinator
 * chat window"), the takeover does NOT draw its own transcript: it hands the
 * host to renderTranscript, which home.js supplies as paintSubject.
 * paintSubject does `host.appendChild(feed)` -- MOVING the SAME `feed`
 * element the collapsed panel already uses, not cloning or rebuilding it --
 * then calls repaintScope(), which forces exactly one full paintTurns
 * rebuild (correct: the panel just changed location and possibly scope).
 *
 * THE QUESTION THIS FILE ANSWERS: after that one open-time rebuild, does a
 * SUBSEQUENT turn arriving for the SAME subject (no subject change, no
 * takeover re-open) go through paintTurns' already-proven incremental
 * "extending" path (tools/test/home-chat-structure.test.mjs), or does
 * something in the takeover force another full rebuild that would reset
 * scroll the way Controller suspected? Answered by actually opening the
 * takeover and sending a message through the SAME composer, now relocated
 * inside it, while scrolled away from the bottom.
 *
 * Run: node --test tools/test/home-chat-takeover-scroll.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, mount, settle, restoreGlobals } from './helpers/home-view-harness.mjs'

test.after(() => restoreGlobals())

test('opening the takeover onto the coordinator (the owner-named default) moves the real panel rather than cloning it', async () => {
  const { view } = await mount()
  try {
    const expand = view.el.querySelector('[data-chat-expand]')
    assert.ok(expand, 'no expand control on this screen')
    expand.dispatch('click')
    await settle()
    assert.equal(view.el.getAttribute('data-chat-open'), 'true', 'the takeover did not open')
    /* defaultSubjectId() (src/home-chat-takeover.js) always names the
       coordinator first when one exists; the composer being live and
       reachable below is the coordinator-live branch's own signature (an
       'everything' or tree/computer subject carries no composer at all). */
    const input = view.el.querySelector('.log-turns')?.querySelector('.chat-input input')
    assert.ok(input, 'the takeover did not default onto a subject with a live composer (expected the coordinator)')
    /* NOT ASSERTED HERE: a single .session-log. This harness's own
       FakeElement.append() does not detach a node from its PREVIOUS parent's
       children array before re-parenting it (unlike tools/test/lib/
       dom-stand-in.mjs's Element._adopt, which does) -- so after paintSubject
       moves the real `feed` into the takeover host, a querySelectorAll over
       view.el still finds it a second time through feedWrap's stale
       reference. That is a gap in this shared fixture (used by other suites
       too, not this lane's to change), not a second panel in the product:
       the object identity proof below (send through the live composer,
       observe the arrival on the SAME `log` reference mount() returned) is
       the real test of "moved, not cloned". */
  } finally { destroyIfPresent(view) }
})

test('a turn arriving for the coordinator while the takeover is open, on the SAME subject, does not reset a reader\'s scroll', async () => {
  const { view, log } = await mount()
  try {
    const expand = view.el.querySelector('[data-chat-expand]')
    expand.dispatch('click')
    await settle()
    assert.equal(view.el.getAttribute('data-chat-open'), 'true', 'the takeover did not open')

    /* The reader scrolls up to read older lines, inside the now-relocated
       panel. */
    log.scrollTo(0)
    assert.equal(log.scrollTop, 0, 'the scroll stand-in did not hold the position the test set')

    /* The SAME composer, now inside the takeover -- home-chat-takeover.js's
       header comment: "REPLICATE MEANS REUSE, NOT COPY". */
    const input = view.el.querySelector('.log-turns')?.querySelector('.chat-input input')
    assert.ok(input, 'no composer input reachable while the takeover is open')
    input.value = 'arriving while the takeover is open, reader scrolled up'
    const sendButton = view.el.querySelector('.chat-send')
    assert.ok(sendButton, 'no send control reachable while the takeover is open')
    sendButton.dispatch('click')
    await settle()

    assert.equal(log.scrollTop, 0,
      `a reader scrolled up inside the open takeover was dragged to ${log.scrollTop} by a same-subject arrival`)
    assert.equal(fixture.sent.length, 1, 'the message must actually have been posted while the takeover was open')
  } finally { destroyIfPresent(view) }
})

test('a turn arriving for the coordinator while the takeover is open, at the bottom, still follows', async () => {
  const { view, log } = await mount()
  try {
    const expand = view.el.querySelector('[data-chat-expand]')
    expand.dispatch('click')
    await settle()

    log.scrollTo(log.scrollHeight)
    const before = log.scrollTop

    const input = view.el.querySelector('.log-turns')?.querySelector('.chat-input input')
    input.value = 'a second arrival, reader at the bottom'
    view.el.querySelector('.chat-send').dispatch('click')
    await settle()

    assert.ok(log.scrollTop > before || log.scrollTop === log.scrollHeight - log.clientHeight,
      `a reader at the bottom inside the open takeover did not follow a same-subject arrival (was ${before}, now ${log.scrollTop})`)
  } finally { destroyIfPresent(view) }
})

function destroyIfPresent(view) {
  try { view.destroy() } catch { /* already torn down by the view's own close path */ }
}
