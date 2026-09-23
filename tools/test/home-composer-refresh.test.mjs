/* THE LAST UNTESTED CANDIDATE FOR "redraws erase my typing" (Controller 3,
 * 2026-09-07): does the feed panel's own composer keep its VALUE, and stay
 * the SAME ELEMENT, across a home-view refresh -- a data-source event,
 * describeHome re-answering, a fleet change -- with the takeover both
 * closed and open?
 *
 * THE REFRESH DRIVEN HERE IS THE PRODUCT'S OWN: CHATBOX_FEED_EVENT
 * (src/chatbox-feed.js), the window event src/views/home.js's own
 * onChatboxSettings handler listens for -- "The two settings are changed on
 * another screen, and this one is left mounted behind it, so the box has to
 * re-read them when they move rather than only at mount" -- which calls
 * readChatboxSettings() then apply(), the same apply() every poll in this
 * file (health, sessions, usage, approvals, agent packets) already goes
 * through. Dispatching it is a faithful stand-in for any of those triggers,
 * all of which converge on the same apply() -> renderPanel() ->
 * ensureComposer() path.
 *
 * tools/test/helpers/home-view-harness.mjs's own window stub does not wire
 * addEventListener/dispatchEvent at all (both are no-ops) -- window events
 * are simply never delivered there. Patched locally, in this file alone,
 * with a real pub-sub BEFORE mount() calls homeView() (which registers its
 * listener synchronously, before any await), so the patch is captured. Not
 * a change to the shared harness.
 *
 * Run: node --test tools/test/home-composer-refresh.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mount, settle, restoreGlobals } from './helpers/home-view-harness.mjs'
import { CHATBOX_FEED_EVENT } from '../../src/chatbox-feed.js'

const listeners = new Map()
window.addEventListener = (type, listener) => {
  if (!listeners.has(type)) listeners.set(type, new Set())
  listeners.get(type).add(listener)
}
window.removeEventListener = (type, listener) => { listeners.get(type)?.delete(listener) }
window.dispatchEvent = (event) => {
  const type = typeof event === 'string' ? event : event?.type
  for (const listener of listeners.get(type) || []) listener(event)
  return true
}
const fireChatboxFeedChanged = () => { window.dispatchEvent({ type: CHATBOX_FEED_EVENT }); }

test.after(() => restoreGlobals())

/* THE SHARED SURFACE'S BOX. The thread mounts buildChat into .log-turns, so
   the composer is its `.chat-input input`; the feed's own `.session-input`
   row no longer exists. */
function composerInput(view) {
  return view.el.querySelector('.log-turns')?.querySelector('.chat-input input') || null
}
/* A silent remount that never removes the OLD element would still pass an
   identity check against querySelector's FIRST match (the old node stays
   findable first in document order) -- this catches that case directly by
   requiring the count to stay exactly one. */
function composerCount(view) {
  return view.el.querySelector('.log-turns')?.querySelectorAll('.chat-input').length ?? 0
}

test('the composer keeps its value and its identity across a chatbox-settings refresh, takeover closed', async () => {
  const { view } = await mount()
  try {
    const before = composerInput(view)
    assert.ok(before, 'no composer input mounted for this fixture')
    before.value = 'typing before the refresh fires'

    fireChatboxFeedChanged()
    await settle()

    const after = composerInput(view)
    assert.ok(after, 'the composer input did not survive the refresh at all')
    assert.equal(after, before, 'the refresh silently remounted the composer -- a fresh element, not the same one')
    assert.ok(after.value === 'typing before the refresh fires',
      `the typed value did not survive the refresh: got ${JSON.stringify(after.value)}`)
    assert.equal(composerCount(view), 1, `the refresh left ${composerCount(view)} composers mounted, not one`)
  } finally { view.destroy() }
})

test('the composer keeps its value and its identity across a chatbox-settings refresh, takeover open', async () => {
  const { view } = await mount()
  try {
    const expand = view.el.querySelector('[data-chat-expand]')
    assert.ok(expand, 'no expand control on this screen')
    expand.dispatch('click')
    await settle()
    assert.equal(view.el.getAttribute('data-chat-open'), 'true', 'the takeover did not open')

    const before = composerInput(view)
    assert.ok(before, 'no composer input reachable while the takeover is open')
    before.value = 'typing while the takeover is open'

    fireChatboxFeedChanged()
    await settle()

    const after = composerInput(view)
    assert.ok(after, 'the composer input did not survive the refresh while the takeover was open')
    assert.equal(after, before, 'the refresh silently remounted the composer while the takeover was open')
    assert.ok(after.value === 'typing while the takeover is open',
      `the typed value did not survive the refresh while the takeover was open: got ${JSON.stringify(after.value)}`)
    /* NOT composerCount(view) here: paintSubject's host.appendChild(feed)
       moves feed into the takeover stage, and this harness's FakeElement.
       append() does not detach a node from its PREVIOUS parent's children
       array first (the same gap the L6 report already names) -- so a walk
       from view.el reaches the ONE real composer twice, through two stale
       parent paths, and a count assertion here would read 2 on genuinely
       correct code. The identity check above is the reliable proof for this
       scenario; composerCount is reliable for the closed-takeover and
       burst tests below, which never move `feed`. */
  } finally { view.destroy() }
})

test('the composer survives several refreshes in a row, not just one', async () => {
  const { view } = await mount()
  try {
    const input = composerInput(view)
    input.value = 'held across a burst of refreshes'
    for (let index = 0; index < 5; index += 1) {
      fireChatboxFeedChanged()
      await settle()
      assert.ok(composerInput(view) === input, `refresh ${index} silently remounted the composer`)
      assert.ok(composerInput(view).value === 'held across a burst of refreshes',
        `refresh ${index} lost the typed value: got ${JSON.stringify(composerInput(view).value)}`)
      assert.equal(composerCount(view), 1, `refresh ${index} left ${composerCount(view)} composers mounted, not one`)
    }
  } finally { view.destroy() }
})
