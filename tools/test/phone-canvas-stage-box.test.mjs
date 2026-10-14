import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { readPhoneCanvasEnvironment, startPhoneCanvas } from '../../src/phone-canvas.js'

const CANVAS_SOURCE = readFileSync(new URL('../../src/phone-canvas.js', import.meta.url), 'utf8')

/* THE HEIGHT-CONTRACT FIX (owner-approved, following the raw A/B measurement
 * fleet-A took on release #2): innerHeight / visualViewport.height /
 * documentElement.clientHeight all read the whole browser window, which is
 * the SAME number standalone and site-mounted. #stage's own box is not --
 * app-fit.css (the site) gives it `calc(100% - var(--site-hero-h))`, and the
 * measured gap was exactly 52px (664 window, 612 actual slot; 56px in
 * hero-band-phone-geometry.test.mjs is the CSS design CEILING for that band,
 * not the measured height -- do not conflate the two, that mistake is
 * recorded in this fix's own report).
 *
 * A stage element to fake with: only the two calls phone-canvas.js's
 * `stageBox` actually makes (`getElementById`, then `getBoundingClientRect`
 * on what it returns). */
function fakeWin({ stage = null, innerWidth = 1440, innerHeight = 900, viewport = null, search = '' } = {}) {
  return {
    document: {
      getElementById: (id) => (id === 'stage' ? stage : null),
    },
    location: { search },
    matchMedia: () => ({ matches: false }),
    innerWidth,
    innerHeight,
    visualViewport: viewport,
  }
}
const rectStage = (width, height) => ({ getBoundingClientRect: () => ({ width, height }) })

test('readPhoneCanvasEnvironment reads #stage\'s own box when it is present and sized', () => {
  const win = fakeWin({ stage: rectStage(390, 612), innerWidth: 390, innerHeight: 664 })
  const env = readPhoneCanvasEnvironment(win)
  assert.equal(env.height, 612, 'the stage box is present and sized -- the window\'s 664 must not win')
  assert.equal(env.width, 390)
})

test('readPhoneCanvasEnvironment falls back to the window when #stage is absent (no document, no element, or zero-sized)', () => {
  assert.equal(readPhoneCanvasEnvironment(fakeWin({ stage: null, innerWidth: 390, innerHeight: 664 })).height, 664,
    '#stage missing entirely must fall back to the window')
  assert.equal(readPhoneCanvasEnvironment(fakeWin({ stage: rectStage(0, 0), innerWidth: 390, innerHeight: 664 })).height, 664,
    'a zero-sized #stage (not yet laid out) must fall back to the window rather than reporting a false zero')
  assert.equal(readPhoneCanvasEnvironment({ location: { search: '' }, matchMedia: () => ({ matches: false }) }).height, 0,
    'no document at all on the fake win must still answer (0), not throw -- the ultimate fallback')
})

test('the window fallback prefers visualViewport over innerHeight/innerWidth, exactly as it did before this fix', () => {
  const win = fakeWin({ stage: null, innerWidth: 999, innerHeight: 999, viewport: { width: 390, height: 664 } })
  const env = readPhoneCanvasEnvironment(win)
  assert.equal(env.height, 664, 'visualViewport must still be preferred over innerHeight in the fallback path')
  assert.equal(env.width, 390)
})

test('REFUTATION: reading the window unconditionally (the pre-fix behaviour) would reproduce the exact 664-in-612 defect', () => {
  const oldEnvironmentHeight = (win) => Number(win?.visualViewport?.height ?? win?.innerHeight ?? 0)
  const siteMountedUnderHero = fakeWin({ stage: rectStage(390, 612), innerWidth: 390, innerHeight: 664 })
  assert.equal(oldEnvironmentHeight(siteMountedUnderHero), 664, 'the old, window-only read reproduces the measured defect exactly')
  assert.equal(readPhoneCanvasEnvironment(siteMountedUnderHero).height, 612, 'the real function must read the actual slot instead')
})

/* SOURCE-LEVEL PIN, so a change that keeps these tests green by coincidence
 * (e.g. a #stage lookup that never actually reaches getBoundingClientRect)
 * cannot pass silently -- the same discipline
 * phone-canvas-ledger-override.test.mjs already applies to ledgerRoute. */
test('the height/width fields are sourced from #stage\'s own box, as source', () => {
  const fn = CANVAS_SOURCE.slice(CANVAS_SOURCE.indexOf('function stageBox'), CANVAS_SOURCE.indexOf('export function readPhoneCanvasEnvironment'))
  assert.match(fn, /getElementById\('stage'\)/, 'stageBox no longer looks up the app\'s own #stage element by id')
  assert.match(fn, /getBoundingClientRect\(\)/, 'stageBox no longer measures #stage\'s real rendered box')
  assert.match(fn, /source: 'stage'/, 'stageBox lost its own source label -- a caller could no longer tell which path answered')
  const reader = CANVAS_SOURCE.slice(CANVAS_SOURCE.indexOf('export function readPhoneCanvasEnvironment'), CANVAS_SOURCE.indexOf('export function readPhoneCanvasEnvironment') + 900)
  assert.match(reader, /const box = stageBox\(win\)/, 'readPhoneCanvasEnvironment no longer routes its box through stageBox')
  assert.doesNotMatch(reader, /win\?\.visualViewport\?\.height \?\? win\?\.innerHeight/,
    'readPhoneCanvasEnvironment still reads the window directly for height instead of going through stageBox')
  const measure = CANVAS_SOURCE.slice(CANVAS_SOURCE.indexOf('function measureBox'), CANVAS_SOURCE.indexOf('function measureBox') + 700)
  assert.match(measure, /const box = stageBox\(win\)/, 'measureBox no longer routes its box through stageBox')
})

function responsiveWindow() {
  const properties = new Map()
  const attributes = new Map()
  const listeners = new Map()
  const viewportListeners = new Map()
  const win = fakeWin({ innerWidth: 390, innerHeight: 844, search: '?ledger=1' })
  win.document.documentElement = {
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    style: {
      getPropertyValue: name => properties.get(name) || '',
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: name => properties.delete(name),
    },
  }
  win.document.getElementById = id => id === 'stage' ? {
    getBoundingClientRect: () => ({
      width: win.innerWidth,
      height: Number.parseFloat(properties.get('--phone-canvas-h')) || win.innerHeight,
      top: 0,
      left: 0,
    }),
  } : null
  win.addEventListener = (name, callback) => listeners.set(name, callback)
  win.visualViewport = {
    width: 390, height: 844, offsetTop: 0, offsetLeft: 0,
    addEventListener: (name, callback) => viewportListeners.set(name, callback),
  }
  return { win, properties, attributes, listeners, viewportListeners }
}

test('an explicit mobile entry follows rotation in both directions, including a fine-pointer browser', () => {
  const { win, properties, attributes, listeners } = responsiveWindow()
  assert.equal(startPhoneCanvas({ win }), true)
  assert.equal(properties.get('--phone-canvas-h'), '844px')
  assert.equal(typeof listeners.get('resize'), 'function', '?ledger=1 must track resize even without a coarse pointer')
  for (const [width, height, event, shape] of [[844, 390, 'resize', 'landscape'], [390, 844, 'orientationchange', 'portrait']]) {
    win.innerWidth = win.visualViewport.width = width
    win.innerHeight = win.visualViewport.height = height
    listeners.get(event)()
    assert.equal(properties.get('--phone-canvas-h'), `${height}px`, 'the previous fixed height must not become the next measurement')
    assert.equal(properties.get('--phone-canvas-w'), `${width}px`)
    assert.equal(attributes.get('data-phone-shape'), shape)
  }
})

test('the visual viewport can shrink for a keyboard and grow again without a layout resize', () => {
  const { win, properties, viewportListeners } = responsiveWindow()
  startPhoneCanvas({ win })
  win.visualViewport.height = 320
  viewportListeners.get('resize')()
  assert.equal(win.innerHeight, 844, 'the layout window did not resize')
  assert.equal(properties.get('--phone-canvas-h'), '320px', 'the keyboard leaves only the visible band')
  win.visualViewport.height = 844
  viewportListeners.get('resize')()
  assert.equal(properties.get('--phone-canvas-h'), '844px', 'closing the keyboard restores the full available height')
})

test('a constrained stage keeps its own ceiling while the active window changes', () => {
  const { win, properties, listeners } = responsiveWindow()
  win.document.getElementById = () => ({ getBoundingClientRect: () => ({
    width: win.innerWidth, height: Math.min(500, Number.parseFloat(properties.get('--phone-canvas-h')) || win.innerHeight),
  }) })
  startPhoneCanvas({ win })
  assert.equal(readPhoneCanvasEnvironment(win).height, 500,
    'the content slot must retain its actual ceiling')
  assert.equal(properties.get('--phone-canvas-h'), '844px',
    'the fixed phone body still fills the visual viewport around the constrained slot')
  win.innerHeight = win.visualViewport.height = 390
  listeners.get('resize')()
  assert.equal(readPhoneCanvasEnvironment(win).height, 390)
  assert.equal(properties.get('--phone-canvas-h'), '390px')
  win.innerHeight = win.visualViewport.height = 844
  listeners.get('resize')()
  assert.equal(readPhoneCanvasEnvironment(win).height, 500)
  assert.equal(properties.get('--phone-canvas-h'), '844px')
})

test('Text size changes remeasure the body without a window resize', () => {
  const { win, properties } = responsiveWindow()
  let onTextStyleChange
  win.document.body = { style: { zoom: '1' } }
  win.MutationObserver = class {
    constructor(callback) { onTextStyleChange = callback }
    observe() {}
    disconnect() {}
  }
  startPhoneCanvas({ win })
  win.document.body.style.zoom = '1.12'
  onTextStyleChange()
  assert.equal(properties.get('--phone-canvas-h'), '844px')
  assert.equal(Number.parseFloat(properties.get('--phone-canvas-body-h')), 844 / 1.12)
  win.document.body.style.zoom = '0.9'
  onTextStyleChange()
  assert.equal(properties.get('--phone-canvas-h'), '844px')
  assert.equal(Number.parseFloat(properties.get('--phone-canvas-body-h')), 844 / 0.9)
})

test('a failed live layout restores both previously accepted heights', () => {
  const { win, properties } = responsiveWindow()
  startPhoneCanvas({ win })
  const before = new Map(properties)
  win.visualViewport.height = 390
  win.document.getElementById = () => ({ getBoundingClientRect() { throw Error('layout unavailable') } })
  assert.throws(() => readPhoneCanvasEnvironment(win), /layout unavailable/)
  assert.deepEqual(properties, before)
})
