/* THE GUIDE ITSELF HAS TO BE OPERABLE, or it is a help surface that traps the
 * person it was built to help.
 *
 * WHAT IS ASSERTED, and why each one is the failure it prevents:
 *   - the launch carries an accessible name that says WHICH page it explains.
 *     "Guide" alone, repeated on ten pages, is ten identically named controls
 *     in a screen reader's list.
 *   - the close control has a name. It is painted as a multiplication sign, so
 *     without aria-label its accessible name is that glyph.
 *   - Escape closes. A card that covers the page and cannot be dismissed from
 *     the keyboard is a trap for anyone not using a mouse.
 *   - focus RETURNS to the launch. Closing a layer while focus is inside it
 *     leaves focus on a removed node, which drops the person back at the top of
 *     the document with no idea where they were.
 *
 * Run: node --test tools/test/feature-guides-a11y.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const dom = installDomStandIn(globalThis)
const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
}
globalThis.location = { hash: '', search: '', hostname: 'localhost' }
globalThis.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail } }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: '' }, configurable: true, writable: true })
globalThis.window.document = globalThis.document
globalThis.document.defaultView = globalThis.window
globalThis.window.localStorage = globalThis.localStorage
globalThis.window.location = globalThis.location
globalThis.window.innerWidth = 1280
globalThis.window.innerHeight = 900
/* first-use-guidance calls getComputedStyle as a bare global, not through
   window, so both bindings have to exist. */
globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' })
globalThis.window.getComputedStyle = globalThis.getComputedStyle
globalThis.document.querySelector = selector => globalThis.document.documentElement.querySelector(selector) || globalThis.document.body.querySelector(selector)
globalThis.document.querySelectorAll = selector => [...globalThis.document.documentElement.querySelectorAll(selector), ...globalThis.document.body.querySelectorAll(selector)]
globalThis.document.getElementById = id => globalThis.document.body.querySelector('#' + id)
globalThis.document.createElementNS = (_namespace, tag) => globalThis.document.createElement(tag)
/* first-use-guidance decides visibility with getClientRects(), which the DOM
   stand-in has no layout to answer. Giving every element one box makes the
   layer visible so the KEYBOARD behaviour can be measured; it is not a claim
   about the rendered page, which is the harness's job. A hidden element still
   reports no boxes, so the rule keeps its meaning. */
const elementProto = Object.getPrototypeOf(globalThis.document.createElement('div'))
const oneBox = { x: 0, y: 0, left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40 }
elementProto.getClientRects = function getClientRects() { return this.hidden ? [] : [oneBox] }
elementProto.getBoundingClientRect = function getBoundingClientRect() { return oneBox }
globalThis.requestAnimationFrame = callback => { callback(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { mountFirstUseGuidance } = await import('../../src/first-use-guidance.js')
const { FEATURE_GUIDES } = await import('../../src/feature-guides.js')

test.after(() => { dom.restore(); delete globalThis.navigator })

/** A mounted guidance layer over one page, always torn down. */
function onGuidance(fn) {
  const entryHost = document.createElement('div')
  const page = document.createElement('div')
  document.body.append(entryHost, page)
  /* quiet:true so visiting never auto-opens: every test here opens on purpose. */
  const guidance = mountFirstUseGuidance({ entryHost, storage: { getItem: () => '{"version":1,"quiet":true,"seen":{}}', setItem() {} } })
  try { return fn({ guidance, entryHost, page }) } finally {
    guidance.destroy()
    entryHost.remove()
    page.remove()
  }
}

test('the launch says which page it explains, not just "Guide"', () => {
  onGuidance(({ guidance, entryHost, page }) => {
    for (const [name, guide] of Object.entries(FEATURE_GUIDES)) {
      guidance.visit(name, page)
      const launch = entryHost.querySelector('#page-guide')
      assert.ok(launch, `no guide launch was mounted for ${name}`)
      assert.equal(launch.hidden, false, `the ${name} page offers no way into its guide`)
      assert.equal(launch.getAttribute('aria-label'), `Guide to ${guide.name}`,
        `the ${name} launch does not name its page, so ten of these read alike`)
    }
  })
})

test('the launch is not offered on a page that has no guide', () => {
  onGuidance(({ guidance, entryHost, page }) => {
    guidance.visit('no-such-page', page)
    assert.equal(entryHost.querySelector('#page-guide').hidden, true,
      'a control that opens nothing is offered')
  })
})

for (const previous of ['home', 'ledger']) {
  for (const destination of ['vault', 'subscribe', 'pricing']) {
    test(`leaving ${previous} for ${destination} clears the guide and its previous-page name`, () => {
      onGuidance(({ guidance, entryHost, page }) => {
        guidance.visit(previous, page)
        const launch = entryHost.querySelector('#page-guide')
        launch.focus()
        launch.click()
        const layer = document.body.querySelector('.first-use-layer')
        assert.equal(layer.hidden, false, 'the starting guide must actually be open')

        guidance.visit(destination, page)
        assert.equal(launch.hidden, true, `${destination} offers a guide that cannot open`)
        assert.equal(layer.hidden, true, `${destination} retained the previous page guide`)
        assert.equal(launch.getAttribute('aria-expanded'), 'false')
        for (const name of [launch.getAttribute('aria-label') || '', launch.title || '']) {
          assert.ok(!name.includes(FEATURE_GUIDES[previous].name), `${destination} retained the previous page name: ${name}`)
        }
        launch.click()
        assert.equal(layer.hidden, true, 'a stale activation reopened the old guide')

        guidance.visit(previous, page)
        assert.equal(launch.hidden, false, 'returning to a guided page lost its launch')
        assert.equal(launch.getAttribute('aria-label'), `Guide to ${FEATURE_GUIDES[previous].name}`)
        launch.focus()
        launch.click()
        assert.equal(layer.hidden, false, 'the returned guide cannot open')
        assert.ok(layer.contains(document.activeElement), 'manual opening lost guide focus')
        layer.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} })
        assert.equal(layer.hidden, true)
        assert.equal(document.activeElement, launch, 'closing the returned guide lost launch focus')
      })
    })
  }
}

test('the close control has a name a person can hear', () => {
  onGuidance(({ guidance, page }) => {
    guidance.visit('home', page)
    document.body.querySelector('#page-guide').click()
    const close = document.body.querySelector('.first-use-close')
    assert.ok(close, 'the opened guide has no close control')
    const name = (close.getAttribute('aria-label') || '').trim()
    assert.notEqual(name, '', 'the close control is painted as a glyph and carries no name')
    assert.match(name, /close/i, `the close control is named "${name}"`)
  })
})

test('Escape closes the guide, and focus comes back to the control that opened it', () => {
  onGuidance(({ guidance, entryHost, page }) => {
    guidance.visit('home', page)
    const launch = entryHost.querySelector('#page-guide')
    launch.focus()
    launch.click()

    const layer = document.body.querySelector('.first-use-layer')
    assert.equal(layer.hidden, false, 'the guide did not open')
    assert.equal(launch.getAttribute('aria-expanded'), 'true', 'the launch does not report the open card')

    const heading = layer.querySelector('h2')
    heading.focus()
    assert.ok(layer.contains(document.activeElement), 'opening the guide left focus outside the card')

    /* A plain record rather than a constructed Event: the DOM stand-in gives
       Event a getter-only defaultPrevented, and the handler calls
       preventDefault(). The handler reads only .key, and this keeps the
       assertion about Escape rather than about the stand-in. */
    layer.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} })

    assert.equal(layer.hidden, true, 'Escape did not close the guide, so a keyboard has no way out')
    assert.equal(launch.getAttribute('aria-expanded'), 'false', 'the launch still reports an open card')
    assert.equal(document.activeElement, launch,
      'focus was left on a hidden node instead of returning to the control that opened the guide')
  })
})

/* T1479: a tip that opened by itself on a first visit was opened with focus on
   the page body. Closing it (Escape, x or Not now) put focus back on the body,
   so the next Tab started again at Skip to main content and the keyboard user
   had lost their place. It must land on the Guide control, where the tip can be
   opened again. */
test('closing a tip that opened by itself puts focus on Guide, not the page body', () => {
  const entryHost = document.createElement('div')
  const page = document.createElement('div')
  document.body.append(entryHost, page)
  const guidance = mountFirstUseGuidance({ entryHost, storage: { getItem: () => '{"version":1,"quiet":false,"seen":{}}', setItem() {} } })
  try {
    for (const how of ['escape', 'close']) {
      document.activeElement = document.body
      guidance.visit(how === 'escape' ? 'home' : 'metrics', page)
      const layer = document.body.querySelector('.first-use-layer')
      assert.equal(layer.hidden, false, `the ${how} case: the first visit did not open its tip`)
      const inside = layer.querySelector('h2')
      inside.focus()
      if (how === 'escape') layer.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} })
      else layer.querySelector('.first-use-close').click()
      assert.equal(layer.hidden, true)
      const launch = entryHost.querySelector('#page-guide')
      assert.notEqual(document.activeElement, document.body, `closing with ${how} dropped focus to the page body`)
      assert.equal(document.activeElement, launch, `closing with ${how} did not put focus on Guide`)
    }
  } finally {
    guidance.destroy()
    entryHost.remove()
    page.remove()
  }
})
