/* PROMPT B. What the hotload staleness indicator claims, and what it refuses
 * to claim. Every assertion here is about a socket event that happened; if any
 * of these could be satisfied by elapsed time, the instrument would be the
 * thing this indicator exists to prevent.
 *
 * These cannot see a CSS cascade -- the DOM stand-in has none -- so visibility
 * here means the attribute and the inline display this module sets together.
 * The rendered truth is driven in a browser by tools/hotload-status-qa.mjs,
 * which is what caught an inline `display: flex !important` outranking the UA
 * rule behind `hidden` and putting the banner on healthy pages. */
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

let installed
const { startHotloadStatus, HOTLOAD_COPY } = await import('../../src/dev-hotload-status.js')

function hotStub() {
  const handlers = new Map()
  return {
    on(event, handler) { handlers.set(event, [...(handlers.get(event) || []), handler]) },
    fire(event) { for (const handler of handlers.get(event) || []) handler({}) },
    listening: event => (handlers.get(event) || []).length,
  }
}
const mount = (hot, options = {}) => startHotloadStatus(hot, { doc: document, reload: () => {}, ...options })
const words = view => `${view.el.querySelector('[data-dev-hotload-title]').textContent} ${view.el.querySelector('[data-dev-hotload-body]').textContent}`
const shown = view => view.el.hidden === false && view.el.style.display === 'flex'
const gone = view => view.el.hidden === true && view.el.style.display === 'none'

beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => installed.restore())

test('a healthy page shows nothing at all', () => {
  const hot = hotStub()
  const view = mount(hot)
  assert.equal(gone(view), true, 'nothing is on the glass before anything has gone wrong')
  hot.fire('vite:ws:connect')
  assert.equal(gone(view), true)
  assert.equal(view.state(), 'up')
  view.stop()
})

test('a dropped channel puts it on the glass, in words that say not to trust the page', () => {
  const hot = hotStub()
  const view = mount(hot)
  hot.fire('vite:ws:connect')
  hot.fire('vite:ws:disconnect')
  assert.equal(shown(view), true, 'it is visible, not a console line')
  assert.equal(view.state(), 'down')
  assert.equal(view.el.getAttribute('role'), 'alert')
  assert.equal(view.el.getAttribute('data-dev-hotload-status'), 'down')
  assert.equal(words(view), `${HOTLOAD_COPY.title} ${HOTLOAD_COPY.body}`)
  assert.match(words(view), /stale/i, 'it says the state first')
  assert.match(words(view), /reload/i, 'and then what to do about it')
  view.stop()
})

/* A client that never reached the server closes uncleanly and fires the same
   disconnect, then fires it again on every failed retry. So a page that never
   connected is a page reporting disconnect, and repeated reports must not
   flicker the banner off between them. */
test('a channel that never opened reports the same way, and repeats do not unsettle it', () => {
  const hot = hotStub()
  const view = mount(hot)
  for (let attempt = 0; attempt < 4; attempt += 1) hot.fire('vite:ws:disconnect')
  assert.equal(shown(view), true)
  assert.equal(view.state(), 'down')
  view.stop()
})

test('reconnecting clears it without anyone pressing anything', () => {
  const hot = hotStub()
  const view = mount(hot)
  hot.fire('vite:ws:disconnect')
  assert.equal(shown(view), true)
  hot.fire('vite:ws:connect')
  assert.equal(gone(view), true, 'the page stops accusing itself the moment the channel is back')
  assert.equal(view.state(), 'up')
  view.stop()
})

/* It makes no claim about history, because it can be started after a connect it
   never saw. One sentence that is true either way beats two, one of them a guess. */
test('it says only that the page is not connected, never how it got that way', () => {
  assert.deepEqual(Object.keys(HOTLOAD_COPY), ['title', 'body'])
  assert.equal(/dropped|never|since/i.test(HOTLOAD_COPY.body), false, `no claim about history: ${HOTLOAD_COPY.body}`)
  assert.match(HOTLOAD_COPY.body, /not connected/i)
})

test('the indicator offers the reload itself rather than only describing one', () => {
  const hot = hotStub()
  let reloaded = 0
  const view = mount(hot, { reload: () => { reloaded += 1 } })
  hot.fire('vite:ws:disconnect')
  view.el.querySelector('[data-dev-hotload-reload]').click()
  assert.equal(reloaded, 1)
  view.stop()
})

test('it watches the real channel and nothing else, and leaves no element behind', () => {
  const hot = hotStub()
  const view = mount(hot)
  assert.equal(hot.listening('vite:ws:connect'), 1)
  assert.equal(hot.listening('vite:ws:disconnect'), 1)
  assert.equal(view.el.isConnected, true, 'it is in the document, not detached')
  view.stop()
  assert.equal(view.el.isConnected, false)
})

test('a stopped indicator cannot be brought back by a late event', () => {
  const hot = hotStub()
  const view = mount(hot)
  view.stop()
  hot.fire('vite:ws:disconnect')
  assert.equal(view.el.isConnected, false)
  assert.equal(view.el.hidden, true)
})

test('without a hot channel to watch there is no indicator', () => {
  assert.equal(startHotloadStatus(null, { doc: document }), null)
  assert.equal(startHotloadStatus({}, { doc: document }), null)
  assert.equal(document.body.querySelectorAll('#dev-hotload-status').length, 0, 'nothing was mounted either')
})
