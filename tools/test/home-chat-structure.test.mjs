/* PAGE 1'S CHAT, DRIVEN RATHER THAN READ.
 *
 * The owner, 2026-09-03: "the pg1 full chat needs a full rework". These are the
 * structural halves of that -- the parts that are wrong whatever the panel ends
 * up looking like -- and every one of them is an observation of the DOM the
 * view actually builds, driven through the same sources the shipped screen
 * reads. None of them inspects home.js.
 *
 * WHY THIS SUITE HAS A HARNESS AND tools/test/home.test.mjs DOES NOT DO.
 * That one mounts the view against a null bridge and a sample fleet, which is
 * the LOCAL/NO_HOST shape; the conversation half of the box only exists in
 * FLEET mode (src/local-activity.js `contextAvailable = mode ===
 * HOME_MODES.FLEET`). So the harness supplies a configured profile, a health
 * sweep, and a coordinator projection, and gets the transcript on the glass.
 *
 * THE HARNESS ITSELF now lives in ./helpers/home-view-harness.mjs, because a
 * second suite needed the same mounted view (tools/test/home-turn-surfaces.
 * test.mjs) and copying three hundred lines of DOM stand-in is how two
 * fixtures come to disagree about what the screen is being shown.
 *
 *   node tools/test/home-chat-structure.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { fixture, documentRef, mount, restoreGlobals, settle, textOf, turnsOf, composerOf } from './helpers/home-view-harness.mjs'

test('the conversation half really is on the glass in this fixture', async () => {
  /* Not an assertion about the chat -- an assertion that the tests below are
     looking at something. Every one of them is vacuous if this is empty, and a
     suite that passes because it found nothing is the defect this repository
     already gates against elsewhere (tools/check-suites-discovered.mjs). */
  const { view } = await mount()
  try {
    assert.equal(turnsOf(view).length, 3, `the fixture thread must reach the pane; pane held: "${view.el.querySelector('.log-turns').textContent}"`)
    /* And it is the SHARED surface (owner: "the chat in the chat view needs to
       be the same as every chat surface in the app"), not a painter of its own. */
    assert.ok(view.el.querySelector('.log-turns').querySelector('.chat'), 'the thread is mounted on the shared buildChat surface')
    assert.equal(view.el.querySelector('.log-turns').querySelectorAll('.turn').length, 0, 'no row of the old .turn painter remains')
  } finally { view.destroy() }
})

test('a person typing asterisks gets asterisks, not bold', async () => {
  /* src/chat-markdown.js states the rule its own header exists for: "The
     person's own lines and the product's action lines go through the plain
     renderer instead: somebody typing an asterisk means an asterisk." The pane
     was choosing the renderer by comparing the speaker id against 'you' and
     'action', which are the RUN ROWS' vocabulary; the thread speaks the ids of
     FLEET.speakers, so neither literal ever matched and every line on this
     screen -- the person's own included -- went through markdown. */
  const { view } = await mount()
  try {
    const mine = turnsOf(view).find(turn => turn.classList.contains('me'))
    assert.ok(mine, 'the person\'s own line must be drawn as the person\'s own line')
    assert.match(textOf(mine), /\*\*stars\*\*/,
      `a person's asterisks must survive to the glass; drawn: "${textOf(mine)}"`)
    assert.match(textOf(mine), /_underscores_/,
      `and so must their underscores; drawn: "${textOf(mine)}"`)
    assert.equal(mine.querySelectorAll('strong').length, 0, 'nothing the person typed was turned into markup')
    assert.equal(mine.querySelectorAll('em').length, 0, 'nothing the person typed was turned into markup')
  } finally { view.destroy() }
})

test("a product action line beginning with a hyphen is not turned into a list", async () => {
  const { view } = await mount()
  try {
    const action = turnsOf(view).find(turn => turn.classList.contains('note'))
    assert.ok(action, 'the action line must be drawn as an action line')
    assert.match(textOf(action), /^- read the record$/,
      `an action line is one clause the product wrote, drawn as written; drawn: "${textOf(action)}"`)
    assert.equal(action.querySelectorAll('li').length, 0, 'and not re-read as a bullet list')
  } finally { view.destroy() }
})

test('an agent still gets its markdown drawn', async () => {
  /* The other half of the same rule, and the reason the fix is a choice rather
     than a switch to plain everywhere. */
  const { view } = await mount()
  try {
    const agent = turnsOf(view).find(turn => turn.classList.contains('them'))
    assert.ok(agent, 'the coordinator line must be drawn')
    assert.equal(agent.querySelectorAll('.md-h').length, 1, 'its heading is a heading')
    assert.equal(agent.querySelectorAll('strong').length, 1, 'its emphasis is emphasis')
    assert.doesNotMatch(textOf(agent), /##/, 'and the markers themselves are gone')
  } finally { view.destroy() }
})

test('a reply the person sends is echoed as the person, not as the agent they sent it to', async () => {
  /* It used to be added under `result.receipt.actor || composerTarget` --
     composerTarget being the agent the message is ADDRESSED to, the same value
     the placeholder renders as "Message ...". So a person's own message came
     back wearing the coordinator's name, in the agent's dress, through the
     markdown renderer, and counted as that agent speaking. */
  fixture.sent.length = 0
  const { view } = await mount()
  try {
    const { input, send } = composerOf(view)
    assert.equal(input.disabled, false, 'the composer must be live in this fixture or nothing below is exercised')
    input.value = 'ship it with **stars**'
    send.dispatch('click')
    await settle()

    assert.equal(fixture.sent.length, 1, 'the message must actually have been posted')
    const drawn = turnsOf(view)
    const echoed = drawn.at(-1)
    assert.match(echoed.textContent, /ship it with/, `the sent message must be echoed; last turn: "${echoed.textContent}"`)
    assert.ok(echoed.classList.contains('me'),
      `the person's own message is the person's; drawn as: "${echoed.className}"`)
    assert.match(textOf(echoed), /\*\*stars\*\*/,
      `and it is their text, not markdown; drawn: "${textOf(echoed)}"`)
    assert.doesNotMatch(echoed.textContent, /mission-bridge-service/,
      'the identity the bridge audited the action under is not a speaker on this screen')
  } finally { view.destroy() }
})

test('an arriving turn scrolls the pane to the newest line', async () => {
  const { view, log } = await mount()
  try {
    const before = log.scrollTop
    const { input, send } = composerOf(view)
    input.value = 'one more'
    send.dispatch('click')
    await settle()
    assert.ok(log.scrollTop > before, `the pane must move for the line that just arrived (was ${before}, now ${log.scrollTop})`)
    assert.equal(log.scrollTop, log.scrollHeight - log.clientHeight,
      `and it must land on the newest line, not near it (${log.scrollTop} of ${log.scrollHeight - log.clientHeight})`)
  } finally { view.destroy() }
})

test('a reader who has scrolled up is left where they are', async () => {
  /* The other half of the contract, and the reason this is not simply "always
     scroll to the bottom". */
  const { view, log } = await mount()
  try {
    log.scrollTo(0)
    const { input, send } = composerOf(view)
    input.value = 'arriving while they read'
    send.dispatch('click')
    await settle()
    assert.equal(log.scrollTop, 0, `a reader looking at an older line must not be dragged away from it (moved to ${log.scrollTop})`)
    assert.equal(turnsOf(view).length, 4, 'and the line still arrives')
  } finally { view.destroy() }
})

test('a turn already on the glass is not rebuilt when a newer one arrives', async () => {
  /* A rebuilt node cannot hold a selection a person is dragging across it, and
     rebuilding the whole thread costs the whole thread's render for one
     arriving line. Marked rather than compared by identity because what a
     person loses is the STATE on the node, which is what the mark stands in
     for. */
  const { view } = await mount()
  try {
    const first = turnsOf(view)[0]
    first.dataset.readerMark = 'held'
    const { input, send } = composerOf(view)
    input.value = 'next'
    send.dispatch('click')
    await settle()
    assert.equal(turnsOf(view).length, 4, 'the new line arrives')
    assert.equal(turnsOf(view)[0].dataset.readerMark, 'held',
      'the line the reader was on kept everything it was carrying')
  } finally { view.destroy() }
})

test('words growing inside a run row still carry the pane with them', async () => {
  /* THE PIN'S OBSERVER WATCHES WHAT ACTUALLY GROWS. .session-log's own children
     are four slots appended once at construction and never touched again, so a
     childList observer on the log alone could not fire once in the life of the
     view -- and the paths that grow the log without going through a repaint
     (an agent's words landing in an open run row) simply never scrolled.
     Driven here by growing the same slot the renderers grow. */
  const { view, log } = await mount()
  try {
    log.scrollTop = log.scrollHeight
    const at = log.scrollTop
    const runs = view.el.querySelector('.log-runs')
    const grown = documentRef.createElement('div')
    grown.className = 'home-run'
    for (let index = 0; index < 12; index += 1) grown.appendChild(documentRef.createElement('span'))
    runs.appendChild(grown)
    assert.ok(log.scrollTop > at, `the pane must follow content that grew below it (was ${at}, now ${log.scrollTop})`)
    assert.equal(log.scrollTop, log.scrollHeight - log.clientHeight, 'all the way to the newest line')
  } finally { view.destroy() }
})

test.after(restoreGlobals)
