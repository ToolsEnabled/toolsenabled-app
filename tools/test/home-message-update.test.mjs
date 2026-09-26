/* A CONVERSATION THAT GROWS, on the shared surface.
 *
 * This suite used to extract the home feed's own painter (turnNode,
 * updateTurnBody, paintTurns) out of home.js by source text and drive it. That
 * painter is gone: the thread mounts buildChat (src/components.js) and is fed
 * by src/home-coordinator-chat.js, which diffs each polled snapshot into the
 * surface. The behaviours pinned here are the same ones, observed on the
 * mounted view: a line that grows keeps its row; a new id is a new row and
 * the earlier rows are untouched; the growing line is the responding state.
 *
 * The harness stubs setTimeout, so the thread poll is captured and fired by
 * hand after the fixture's thread is changed -- the same path the shipped
 * screen takes every THREAD_POLL_MS.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers'
import { fixture, message, mount, restoreGlobals, settle, turnsOf, textOf } from './helpers/home-view-harness.mjs'

/* Capture the view's LONG timers (the thread poll and the other recurring
   reads) so a test can fire the poll by hand; the surface's own short timers
   -- it paces a live stream's words on them -- run for real, so what a person
   would see is what is asserted. */
/* node:timers, not the global: the harness has already replaced the global
   with a stub by the time this module's body runs. */
const realSetTimeout = nodeSetTimeout, realClearTimeout = nodeClearTimeout
const timers = []
globalThis.setTimeout = (fn, ms) => (ms >= 1000 ? (timers.push(fn), -timers.length) : realSetTimeout(fn, ms))
globalThis.clearTimeout = (handle) => { if (handle && !(typeof handle === 'number' && handle < 0)) realClearTimeout(handle) }
const later = ms => new Promise(resolve => realSetTimeout(resolve, ms))
const firePolls = async () => { const due = timers.splice(0); for (const fn of due) fn(); await settle(); await later(120); await settle() }

const original = fixture.thread.slice()
test.afterEach(() => { fixture.thread = original.slice() })
test.after(restoreGlobals)

test('a changed message with the same ID updates in place and keeps its row', async () => {
  const { view } = await mount()
  try {
    const rows = turnsOf(view)
    assert.equal(rows.length, 3)
    const last = rows[2]
    last.dataset.readerMark = 'held'
    const grown = { ...fixture.thread[2], text: fixture.thread[2].text + '\n\n**Finished** with new details.' }
    fixture.thread = [fixture.thread[0], fixture.thread[1], grown]
    await firePolls()
    const after = turnsOf(view)
    assert.equal(after.length, 3, 'a longer line is not a new line')
    assert.equal(after[2], last, 'the row a reader was on is the row that grew')
    assert.equal(after[2].dataset.readerMark, 'held')
    assert.match(textOf(after[2]), /Finished/)
    assert.ok(after[2].querySelectorAll('strong').some(node => node.textContent === 'Finished'), 'and the markdown of the new words is drawn')
    /* The surface paces a live stream's words on its own frames; what is
       fixed is that a growing line is a WORKING state (thinking until words
       show, responding once they do), never idle. */
    assert.ok(['thinking', 'responding'].includes(view.el.querySelector('.log-turns').querySelector('.chat').getAttribute('data-chat-activity')),
      'a line still growing between polls is a working state on the surface')
  } finally { view.destroy() }
})

test('new records preserve earlier message nodes, but a new ID is a distinct message', async () => {
  const { view } = await mount()
  try {
    const first = turnsOf(view)[0]
    fixture.thread = [...fixture.thread, message('m4', 'codex', 'Second response.')]
    await firePolls()
    const rows = turnsOf(view)
    assert.equal(rows.length, 4)
    assert.equal(rows[0], first, 'the first row is untouched')
    assert.match(textOf(rows[3]), /Second response/)
    const fourth = rows[3]
    fixture.thread = [...fixture.thread.slice(0, 3), message('m5', 'codex', 'Second response.')]
    await firePolls()
    /* The same words under a NEW id is a different message. The feed refuses
       to repaint over painted history, so the view remounts the surface, and
       what a person sees is a different row, not the old one relabelled. */
    const again = turnsOf(view)
    assert.equal(again.length, 4)
    assert.notEqual(again[3], fourth)
  } finally { view.destroy() }
})

test('a growing response keeps its body element and settles once a poll leaves it unchanged', async () => {
  const { view } = await mount()
  try {
    fixture.thread = [...fixture.thread, message('m4', 'codex', 'Looking')]
    await firePolls()
    const row = turnsOf(view)[3]
    const body = row.querySelector('.chat-msg-text')
    const chat = view.el.querySelector('.log-turns').querySelector('.chat')
    assert.ok(['thinking', 'responding'].includes(chat.getAttribute('data-chat-activity')), 'an arriving answer is a working state')
    fixture.thread = [...fixture.thread.slice(0, 3), message('m4', 'codex', 'Looking at step two now.')]
    await firePolls()
    assert.equal(turnsOf(view)[3], row)
    assert.equal(row.querySelector('.chat-msg-text'), body, 'the body that grew is the body that was there')
    await firePolls()
    assert.match(body.textContent, /step two/)
    assert.equal(chat.getAttribute('data-chat-activity'), 'idle', 'unchanged across a poll: the answer has settled')
  } finally { view.destroy() }
})

/* THE SHARED SURFACE'S OWN SCROLL CONTRACT, on a conversation that grows by
   poll -- the case the old painter's pin used to cover: a reader partway up
   is left where they are and offered the way down; a reader at the bottom
   follows. The scroll port is the surface's .chat-log, not the panel's. */
function chatLogOf(view) {
  const log = view.el.querySelector('.log-turns').querySelector('.chat-log')
  log.contentUnit = 20
  log.clientHeight = 60
  return log
}

test('a reader partway up a growing conversation is left there and offered the way down', async () => {
  const { view } = await mount()
  try {
    const log = chatLogOf(view)
    log.scrollTo(0)
    fixture.thread = [...fixture.thread, message('m4', 'codex', 'One more line.')]
    await firePolls()
    assert.equal(turnsOf(view).length, 4, 'the line still arrives')
    assert.equal(log.scrollTop, 0, `a reader looking at an older line must not be dragged away from it (moved to ${log.scrollTop})`)
    const pill = view.el.querySelector('.log-turns').querySelector('.chat-new-below')
    assert.ok(pill && pill.hidden === false, 'the way down is offered')
  } finally { view.destroy() }
})

test('a reader at the bottom follows a growing conversation to the newest line', async () => {
  const { view } = await mount()
  try {
    const log = chatLogOf(view)
    log.scrollTo(log.scrollHeight)
    const before = log.scrollTop
    fixture.thread = [...fixture.thread, message('m4', 'codex', 'One more line.')]
    await firePolls()
    assert.ok(log.scrollTop > before, `the pane must move for the line that arrived (was ${before}, now ${log.scrollTop})`)
    assert.equal(log.scrollTop, log.scrollHeight - log.clientHeight, 'and land on the newest line')
  } finally { view.destroy() }
})
