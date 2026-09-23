/* THE PHONE CANVAS, PINNED AT SOURCE.
 *
 * The owner's hard constraint, verbatim: "we cannot let mobile development
 * change the main app or the normal site". That is the first requirement, so it
 * is the first thing this file tests, and it is tested as a MECHANISM rather
 * than as a promise:
 *
 *   1. every rule in src/phone-canvas.css begins with the mode's attribute, so
 *      no width and no window can reach one of them;
 *   2. no other stylesheet in the product contains that attribute, so the phone
 *      dress cannot be smeared anywhere else;
 *   3. only src/phone-canvas.js ever WRITES the attribute; and
 *   4. the function that decides to write it returns false for every desktop
 *      in a 3,000-point matrix, and is enumerated rather than argued.
 *
 * This repository has no DOM in its node tests, so nothing here measures a
 * rendered box. What it can do — and does — is drive the boot path with a fake
 * window and prove that a desktop comes out of it with nothing written at all.
 * The findings that need a real phone are named in the pass report and are
 * deliberately NOT asserted: a gate that claims coverage it does not have is
 * worse than no gate.
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PHONE_CANVAS_ATTR,
  PHONE_CANVAS_CHOICES,
  PHONE_CANVAS_COULD_NOT_TELL,
  PHONE_CANVAS_DEFAULT_CHOICE,
  PHONE_CANVAS_SETTING,
  PHONE_RELOCATED,
  PHONE_SHAPE_ATTR,
  PHONE_SHAPE_LANDSCAPE,
  PHONE_SHAPE_PORTRAIT,
  mountPhoneCanvas,
  phoneShape,
  phoneCanvasDecision,
  readPhoneCanvasChoice,
  readPhoneCanvasEnvironment,
  startPhoneCanvas,
} from '../../src/phone-canvas.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = path.join(REPO, 'src')
const read = (...parts) => readFileSync(path.join(SRC, ...parts), 'utf8')
const MODE = `[${PHONE_CANVAS_ATTR}="on"]`

/* Prose in this codebase quotes the very declarations it explains, so a gate
   that read comments as rules would fail on its own explanation. Same parser
   shape as tools/test/mobile-size-floor.test.mjs, copied rather than shared for
   the reason that file gives: a suite that imports its own subject's helpers
   can be made to pass by editing the helper. */
const stripCssComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '')

/** Flatten a sheet to { atRule, selector, body }, one entry per declaration block. */
function cssRules(text) {
  const cleaned = stripCssComments(text)
  const rules = []
  const stack = []
  let index = 0
  let head = ''
  while (index < cleaned.length) {
    const character = cleaned[index]
    if (character === '{') {
      const selector = head.trim()
      head = ''
      if (selector.startsWith('@')) {
        stack.push(selector)
        index += 1
        continue
      }
      const close = cleaned.indexOf('}', index)
      const end = close === -1 ? cleaned.length : close
      rules.push({ atRule: stack.join(' '), selector, body: cleaned.slice(index + 1, end) })
      index = end + 1
      continue
    }
    if (character === '}') {
      stack.pop()
      head = ''
      index += 1
      continue
    }
    head += character
    index += 1
  }
  return rules
}

/** Every `property: value` in a block, in order. */
function declarations(body) {
  return body
    .split(';')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const colon = entry.indexOf(':')
      if (colon === -1) return null
      return { property: entry.slice(0, colon).trim().toLowerCase(), value: entry.slice(colon + 1).trim() }
    })
    .filter(Boolean)
}

function walkFiles(directory, suffix, found = []) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) {
      walkFiles(full, suffix, found)
      continue
    }
    if (full.endsWith(suffix)) found.push(full)
  }
  return found
}

/* ==================================================================
   THE DESKTOP IS UNCHANGED. Four gates, and they are the point of the file.
   ================================================================== */

/* GATE 1 — THE ONE THAT MUST NEVER GO GREEN BY ACCIDENT.
   A single selector in this sheet that forgets the attribute is a rule that
   applies to every desktop window in the world. Mutation-checked: dropping the
   attribute from one selector turns this red. */
test('every rule in the phone sheet is behind the mode attribute', () => {
  const rules = cssRules(read('phone-canvas.css'))
  assert.ok(rules.length > 20, 'the phone sheet must actually contain rules')
  const loose = rules
    .flatMap(rule => rule.selector.split(','))
    .map(part => part.trim())
    .filter(part => part && !part.includes(MODE))
  assert.deepEqual(loose, [], 'a selector without the mode attribute applies to every desktop')
})

/* GATE 2 — the mode is a mode, not a media query smeared through the sheets.
   A width cannot switch it on and nothing else may declare it. */
test('the phone sheet has no at-rules, and no other sheet knows the mode', () => {
  for (const rule of cssRules(read('phone-canvas.css'))) {
    assert.equal(rule.atRule, '', `${rule.selector} sits inside ${rule.atRule}; the mode is not a width`)
  }
  const sheets = walkFiles(SRC, '.css')
  const others = sheets
    .filter(file => stripCssComments(readFileSync(file, 'utf8')).includes(PHONE_CANVAS_ATTR))
    .map(file => path.relative(REPO, file).replace(/\\/g, '/'))
  assert.deepEqual(others, ['src/phone-canvas.css'], 'the phone dress belongs in exactly one sheet')
})

/* GATE 3 — one writer. If any other module could set the attribute, gates 1
   and 4 would both be arguing about the wrong switch. */
test('only the mode module writes the mode attribute', () => {
  const writers = walkFiles(SRC, '.js')
    .filter(file => /(setAttribute\s*\(\s*PHONE_CANVAS_ATTR|dataset\s*\.\s*phoneCanvas|setAttribute\s*\(\s*['"]data-phone-canvas)/.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(REPO, file).replace(/\\/g, '/'))
  assert.deepEqual(writers, ['src/phone-canvas.js'], 'the mode must have exactly one writer')
})

/* The default selects phone browsers and preserves desktop/installed views. */
test('auto selects only mobile browser geometry across the device matrix', () => {
  const offences = []
  for (let width = 240; width <= 3840; width += 4) {
    for (const height of [320, 390, 430, 520, 521, 768, 1080]) {
      for (const installed of [false, true]) {
        for (const canHover of [true, false]) {
          for (const coarsePointer of [false, true]) {
            const on = phoneCanvasDecision({
              choice: PHONE_CANVAS_DEFAULT_CHOICE, ledgerRoute: false, installed, coarsePointer, canHover, width, height,
            })
            const expected = !installed && coarsePointer && !canHover && (width <= height ? width <= 820 : height <= 520)
            if (on !== expected) offences.push(`${width}x${height} installed=${installed} hover=${canHover} coarse=${coarsePointer}`)
          }
        }
      }
    }
  }
  assert.deepEqual(offences.slice(0, 5), [], 'automatic mobile selection disagreed with the device matrix')
})

test('the downloaded application is never put into the phone canvas, on any width', () => {
  for (let width = 240; width <= 1200; width += 1) {
    assert.equal(
      phoneCanvasDecision({ choice: 'auto', installed: true, coarsePointer: true, canHover: false, width, height: 844 }),
      false,
      `the installed app was switched at ${width}px`,
    )
  }
})

test('a mobile browser defaults to phone canvas without an entry query in both orientations', () => {
  for (const [width, height] of [[320, 844], [360, 800], [390, 844], [430, 932], [768, 1024], [844, 390], [932, 430], [1024, 480]]) {
    assert.equal(phoneCanvasDecision({ choice: 'auto', ledgerRoute: false, installed: false, coarsePointer: true, canHover: false, width, height }), true, `${width}x${height}`)
  }
})

test('an explicit canvas off keeps the graph on mobile', () => {
  assert.equal(phoneCanvasDecision({ choice: 'off', coarsePointer: true, canHover: false, width: 390, height: 844 }), false)
})

/* The floor is a cause-level rule, not a list of controls found by one census.
   Keep the selector vocabulary aligned with the browser driver, plus the ARIA
   tab/switch controls used by the renderer. The value is assembled only from
   the existing spacing scale and divided by the same body zoom that paints it;
   no second phone-size token or raw length exists. */
test('row mode withholds controls that only change the hidden graph, not fleet overview', () => {
  const rules = cssRules(read('phone-canvas.css'))
  for (const name of ['tree-display-controls', 'tree-active-zoom', 'tree-workspace-controls', 'tree-window-add', 'tree-window-header']) {
    const selector = `${MODE} .computers.phone-ledger-mode .${name}`
    const rule = rules.find(rule => rule.selector.split(',').some(part => part.trim() === selector))
    assert.ok(rule, `${name} must be scoped to phone rows, not Graph or desktop`)
    assert.match(rule.body, /display:\s*none/)
    assert.doesNotMatch(rule.selector, /\.graph-open-btn|\.phone-sheet-open/)
  }
})

test('the complete control vocabulary shares one phone-only touch floor', () => {
  const floorValue = 'calc((var(--s5) + var(--s4) + var(--s1)) / var(--zoom, 1)) !important'
  const rules = cssRules(read('phone-canvas.css'))
  const floorRules = rules.filter(rule => {
    const declared = declarations(rule.body)
    return declared.some(({ property, value }) => (
      (property === 'min-width' || property === 'min-height') && value === floorValue
    ))
  })
  assert.equal(floorRules.length, 1, 'the phone stylesheet must declare one shared touch-floor rule')
  assert.equal(floorRules[0].atRule, '', 'the floor uses the existing phone-mode path, not a second media path')

  const selectors = floorRules[0].selector.split(',').map(selector => selector.trim()).sort()
  assert.deepEqual(selectors, [
    `${MODE} [role="button"]:not([hidden])`,
    `${MODE} [role="switch"]:not([hidden])`,
    `${MODE} [role="tab"]:not([hidden])`,
    `${MODE} a[href]:not([hidden])`,
    `${MODE} button:not([hidden])`,
    `${MODE} input:not([type="hidden"]):not([hidden])`,
    `${MODE} select:not([hidden])`,
    `${MODE} summary:not([hidden])`,
    `${MODE} textarea:not([hidden])`,
  ].sort(), 'every measured control kind must enter through the one floor rule')

  const floorDeclarations = declarations(floorRules[0].body)
    .filter(({ property }) => property === 'min-width' || property === 'min-height')
  assert.deepEqual(floorDeclarations, [
    { property: 'min-width', value: floorValue },
    { property: 'min-height', value: floorValue },
  ], 'the same existing-scale floor must protect both target dimensions')

  // The profile notice is already a flex item in the fitted phone body.
  // Its own route rules must retain control of display:none.
  const anchorRule = rules.find(rule => rule.selector === `${MODE} a[href]:not([hidden]):not(.fleet-profile-notice)`)
  assert.ok(anchorRule, 'phone links need a sizeable box for their shared minimums to apply')
  assert.deepEqual(declarations(anchorRule.body), [
    { property: 'display', value: 'inline-flex' },
    { property: 'align-items', value: 'center' },
  ], 'link plumbing must not introduce another size declaration')
})

/* THE SETTING THE OWNER NAMED — "an optional 2nd view style" — exists, is the
   first thing the decision reads, and is not written by anything that ships. */
test('the mode is a setting a switch could flip, and nothing flips it yet', () => {
  assert.deepEqual(PHONE_CANVAS_CHOICES, ['auto', 'on', 'off'])
  assert.equal(PHONE_CANVAS_DEFAULT_CHOICE, 'auto')
  assert.equal(phoneCanvasDecision({ choice: 'off', installed: false, coarsePointer: true, canHover: false, width: 390 }), false)
  assert.equal(phoneCanvasDecision({ choice: 'on', installed: true, coarsePointer: false, canHover: true, width: 1920 }), true)
  const writers = walkFiles(SRC, '.js')
    .filter(file => new RegExp(`setItem\\s*\\(\\s*['"\`]${PHONE_CANVAS_SETTING.replace('.', '\\.')}`).test(readFileSync(file, 'utf8')))
  assert.deepEqual(writers, [], 'nothing in the product may store this choice until the owner asks for the control')
})

test('a failed device query is could-not-tell, never absence and never latched', () => {
  const assertion = (sourceCode, sentence) => error => {
    assert.equal(error.code, PHONE_CANVAS_COULD_NOT_TELL)
    assert.equal(error.cause?.code, sourceCode)
    assert.match(error.message, /does not claim that it is absent or false/)
    assert.match(error.message, sentence)
    return true
  }

  let storageReads = 0
  const storage = {
    localStorage: {
      getItem() {
        storageReads += 1
        if (storageReads === 1) throw Object.assign(new Error('busy'), { code: 'EIO' })
        return null
      },
    },
  }
  assert.throws(() => readPhoneCanvasChoice(storage), assertion('EIO', /stored choice/))
  assert.equal(readPhoneCanvasChoice(storage), PHONE_CANVAS_DEFAULT_CHOICE,
    'a failed read must be retried; null alone is the legitimate absent answer')
  assert.equal(storageReads, 2, 'could-not-tell must not be cached or latched')

  let mediaReads = 0
  const media = {
    localStorage: { getItem: () => null },
    matchMedia() {
      mediaReads += 1
      if (mediaReads === 1) throw { code: 'EBUSY' }
      return { matches: false }
    },
  }
  assert.throws(() => readPhoneCanvasEnvironment(media), assertion('EBUSY', /whether \(pointer: coarse\) matches/))
  assert.equal(readPhoneCanvasEnvironment(media).coarsePointer, false,
    'a successful false query remains distinct from the failed query')
  assert.equal(mediaReads, 3, 'the failed query is retried, then both successful queries run')
})

/* THE BOOT PATH ITSELF, driven rather than argued. A desktop must come out of
   startPhoneCanvas with nothing written: no attribute, no custom property, and
   not even a listener attached. */
function fakeWindow({ coarsePointer = false, canHover = true, width = 1440, height = 900, installed = false, choice = null, search = '', zoom = '' } = {}) {
  const attributes = new Map()
  const properties = new Map()
  const listeners = []
  const documentElement = {
    getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => { attributes.set(name, value) },
    removeAttribute: name => { attributes.delete(name) },
    style: {
      setProperty: (name, value) => { properties.set(name, value) },
      removeProperty: name => { properties.delete(name) },
    },
  }
  const win = {
    document: { documentElement, body: { style: { zoom } } },
    localStorage: { getItem: () => choice },
    matchMedia: query => ({
      matches: query === '(pointer: coarse)' ? coarsePointer : query === '(hover: hover)' ? canHover : false,
    }),
    location: { search },
    innerWidth: width,
    innerHeight: height,
    addEventListener: name => { listeners.push(name) },
  }
  if (installed) win.mcPrefs = {}
  return { win, attributes, properties, listeners }
}

test('explicit desktop entry keeps the graph on a phone while ordinary and ledger entry use rows', () => {
  for (const [search, desktopRoute, expected] of [
    ['?desktop=1', true, false],
    ['?other=1&desktop=1', true, false],
    ['?desktop=10', false, true],
    ['', false, true],
    ['?ledger=1', false, true],
    ['?desktop=1&ledger=1', true, true],
  ]) {
    const phone = fakeWindow({ coarsePointer: true, canHover: false, width: 390, height: 844, search })
    const environment = readPhoneCanvasEnvironment(phone.win)
    assert.equal(environment.desktopRoute, desktopRoute, search)
    assert.equal(phoneCanvasDecision(environment), expected, search)
    assert.equal(startPhoneCanvas({ win: phone.win }), expected, search)
    assert.equal(phone.attributes.get(PHONE_CANVAS_ATTR), expected ? 'on' : undefined, search)
  }
})

test('booting on a desktop writes nothing at all', () => {
  for (const width of [1024, 1280, 1440, 1920, 2560]) {
    const desktop = fakeWindow({ width })
    assert.equal(startPhoneCanvas({ win: desktop.win }), false, `${width}px was switched`)
    assert.deepEqual([...desktop.attributes.keys()], [], `${width}px had an attribute written`)
    assert.deepEqual([...desktop.properties.keys()], [], `${width}px had a custom property written`)
    assert.deepEqual(desktop.listeners, [], `${width}px had a listener attached`)
  }
  /* A desktop window dragged narrower than a phone is still a desktop. */
  const narrow = fakeWindow({ width: 380 })
  assert.equal(startPhoneCanvas({ win: narrow.win }), false)
  assert.deepEqual([...narrow.attributes.keys()], [])
  /* And a touchscreen laptop, whose screen is coarse but whose primary pointer
     hovers. */
  const laptop = fakeWindow({ coarsePointer: true, canHover: true, width: 1366 })
  assert.equal(startPhoneCanvas({ win: laptop.win }), false)
  assert.deepEqual([...laptop.attributes.keys()], [])
  assert.deepEqual(laptop.listeners, [])
})

test('a phone without a ledger link boots into the default canvas', () => {
  for (const [width, height] of [[390, 844], [844, 390]]) {
    const phone = fakeWindow({ coarsePointer: true, canHover: false, width, height })
    assert.equal(startPhoneCanvas({ win: phone.win }), true)
    assert.equal(phone.attributes.get(PHONE_CANVAS_ATTR), 'on')
    assert.ok(phone.properties.has('--phone-canvas-h'))
  }
})

/* THE ONE DOOR LEFT: a phone that DID follow /app/?ledger=1 still boots into
   the mode and still gets its box measured — M2's own mechanism, unchanged,
   now doing the whole job the pointer heuristic used to share with it. */
test('a phone that followed the ledger link boots writing the one attribute and measures the visible box', () => {
  for (const [width, height] of [[390, 844], [844, 390]]) {
    const phone = fakeWindow({ coarsePointer: true, canHover: false, width, height, search: '?ledger=1' })
    assert.equal(startPhoneCanvas({ win: phone.win }), true, `${width}x${height} was not switched after following /app/?ledger=1`)
    assert.equal(phone.attributes.get(PHONE_CANVAS_ATTR), 'on')
    assert.equal(phone.properties.get('--phone-canvas-h'), `${height}px`)
    assert.equal(phone.properties.get('--phone-canvas-body-h'), `${height}px`)
    assert.equal(phone.properties.get('--phone-canvas-w'), `${width}px`)
  }
})

test('a dock-reduced stage cannot shrink the visual viewport body, and keyboard pan resets', () => {
  const phone = fakeWindow({ width: 390, height: 844, search: '?ledger=1', zoom: '1.12' })
  const callbacks = new Map()
  phone.win.visualViewport = { width: 390, height: 423, offsetTop: 180,
    addEventListener: (name, callback) => callbacks.set(name, callback) }
  phone.win.document.documentElement.style.getPropertyValue = name => phone.properties.get(name) || ''
  phone.win.document.getElementById = () => ({ getBoundingClientRect: () => ({ width: 390, height: 300, top: 180, left: 0 }) })
  assert.equal(startPhoneCanvas({ win: phone.win }), true)
  assert.equal(phone.properties.get('--phone-canvas-h'), '423px')
  assert.equal(phone.properties.get('--phone-canvas-body-h'), `${423 / 1.12}px`)
  assert.equal(phone.properties.get('--phone-canvas-body-top'), `${180 / 1.12}px`)
  // Reading the slot must restore the caller's properties, including offset.
  const before = new Map(phone.properties)
  readPhoneCanvasEnvironment(phone.win)
  assert.deepEqual(phone.properties, before)
  phone.win.visualViewport.height = 844
  phone.win.visualViewport.offsetTop = 0
  callbacks.get('resize')()
  assert.equal(phone.properties.get('--phone-canvas-body-h'), `${844 / 1.12}px`)
  assert.equal(phone.properties.get('--phone-canvas-body-top'), '0px')
  phone.win.location.search = ''
  callbacks.get('scroll')()
  assert.equal(phone.attributes.has(PHONE_CANVAS_ATTR), false)
  assert.equal(phone.properties.has('--phone-canvas-body-top'), false)
  assert.equal(phone.properties.has('--phone-canvas-body-h'), false)
})

test('the phone body height compensates for every offered Text size', () => {
  for (const zoom of [0.9, 1, 1.12]) {
    const phone = fakeWindow({ width: 844, height: 390, search: '?ledger=1', zoom: String(zoom) })
    assert.equal(startPhoneCanvas({ win: phone.win }), true)
    assert.equal(phone.properties.get('--phone-canvas-h'), '390px',
      'the shared measurement stays in physical pixels for window-bounding consumers')
    assert.equal(phone.properties.get('--phone-canvas-body-h'), `${390 / zoom}px`,
      `the body CSS height must compensate for Text size ${zoom}`)
  }
})

/* AND A FINE-POINTER DESKTOP THAT FOLLOWS THE SAME LINK gets it too — the
   load-bearing case the routing law's ledger door depends on: the mobile
   page's own /app/?ledger=1 link has to work from any browser that opens it,
   not only ones that also happen to look like a phone. Pinned at the pure-
   function level already (phone-canvas-ledger-override.test.mjs); pinned here
   through the actual boot path once more, the same doubling gate 4 gets. */
test('a fine-pointer desktop that followed the ledger link boots writing the one attribute too', () => {
  const desktop = fakeWindow({ coarsePointer: false, canHover: true, width: 1440, height: 900, search: '?ledger=1' })
  assert.equal(startPhoneCanvas({ win: desktop.win }), true, 'a fine-pointer desktop following /app/?ledger=1 was not switched')
  assert.equal(desktop.attributes.get(PHONE_CANVAS_ATTR), 'on')
})

/* ==================================================================
   THE LOCK. What the owner asked for, in the declarations that deliver it.
   ================================================================== */

const phoneRule = (selector) => cssRules(read('phone-canvas.css')).find(rule => rule.selector.trim() === selector)

test('the page cannot scroll, bounce, or be pinched', () => {
  const root = phoneRule(`html${MODE}`)
  const body = phoneRule(`html${MODE} body`)
  assert.ok(root && body, 'the mode must dress both the root and the body')
  for (const [name, rule] of [['root', root], ['body', body]]) {
    const seen = new Map(declarations(rule.body).map(entry => [entry.property, entry.value]))
    assert.equal(seen.get('overflow'), 'hidden', `the ${name} must not scroll`)
    assert.equal(seen.get('overscroll-behavior'), 'none', `the ${name} must not rubber-band`)
    /* pan-y and none both exclude pinch-zoom and both exclude double-tap zoom;
       `auto` and anything containing pinch-zoom do not. */
    const touch = seen.get('touch-action')
    assert.ok(touch && !/auto|pinch-zoom|manipulation/.test(touch), `the ${name} touch-action ${touch} still permits a pinch`)
  }
  /* The page is sized to the VISUAL viewport, never to 100vh, which on iOS is
     the taller box the collapsed URL bar sits over. */
  assert.match(body.body, /height:\s*var\(--phone-canvas-body-h,\s*100%\)/,
    'the body must use the post-measurement, zoom-adjusted height, with a percentage fallback that cannot perturb the first read')
  const inViewportUnits = cssRules(read('phone-canvas.css'))
    .flatMap(rule => declarations(rule.body).map(entry => ({ rule, entry })))
    .filter(({ entry }) => /\b\d*\.?\d+(vh|svh|lvh|dvh)\b/.test(entry.value))
    .map(({ rule, entry }) => `${rule.selector} { ${entry.property}: ${entry.value} }`)
  assert.deepEqual(inViewportUnits, [], 'no declaration in the phone sheet may size itself in viewport-height units')
})

test('the centered navigation stays on desktop and out of the phone canvas', () => {
  const desktop = cssRules(read('styles.css'))
    .find(rule => rule.selector.trim() === '.tb-nav')
  assert.ok(desktop, 'the desktop navigation rule must still exist')
  assert.equal(
    new Map(declarations(desktop.body).map(entry => [entry.property, entry.value])).get('display'),
    'flex',
    'desktop must keep the centered navigation',
  )

  const phoneNav = phoneRule(`${MODE} .tb-nav`)
  assert.ok(phoneNav, 'phone mode must explicitly omit the centered navigation')
  assert.equal(
    new Map(declarations(phoneNav.body).map(entry => [entry.property, entry.value])).get('display'),
    'none',
    'phone mode must not draw the desktop navigation',
  )

  const phoneTopbar = phoneRule(`${MODE} .topbar`)
  assert.ok(phoneTopbar, 'phone mode must keep a layout for its retained edge controls')
  const phoneTopbarDeclarations = new Map(
    declarations(phoneTopbar.body).map(entry => [entry.property, entry.value]),
  )
  assert.equal(phoneTopbarDeclarations.get('display'), 'grid')
  assert.equal(phoneTopbarDeclarations.get('grid-template-columns'), 'minmax(0, 1fr) auto minmax(0, 1fr)')
})

/* THE DECLARATIVE ROUTE DOES NOT WORK ON iOS AND MUST NOT BE ATTEMPTED.
   Safari has ignored user-scalable and maximum-scale since iOS 10, and WebKit
   closed the request to restore them RESOLVED INVALID. Writing them anyway
   would change the meta tag every page in the product shares — including the
   desktop app's — for no effect at all. */
test('the shared viewport meta is untouched', () => {
  const html = readFileSync(path.join(REPO, 'index.html'), 'utf8')
  const meta = /<meta name="viewport" content="([^"]*)"/.exec(html)
  assert.ok(meta, 'index.html must still declare a viewport')
  assert.equal(meta[1], 'width=device-width, initial-scale=1.0')
})

test('Safari own pinch events are cancelled, and cancellably', () => {
  const source = read('phone-canvas.js')
  for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.ok(source.includes(`'${name}'`), `${name} must be bound`)
  }
  /* A passive listener cannot preventDefault, and browsers default the touch
     family to passive. Without this the belt is decoration. */
  const passiveFalse = source.match(/\{\s*passive:\s*false\s*\}/g) || []
  assert.ok(passiveFalse.length >= 2, 'the gesture and touchmove locks must both be cancellable')
  assert.match(source, /touches\s*&&\s*event\.touches\.length\s*>\s*1/, 'a two-finger touchmove is a pinch and must be cancelled')
})

test('the tree canvas claims its own gestures in this mode', () => {
  const rule = phoneRule(`${MODE} .computers .graph-canvas-slot`)
  assert.ok(rule, 'the zoom host must be given a touch-action in this mode')
  assert.match(rule.body, /touch-action:\s*none/, 'the drag that pans the tree must not be read as a scroll')
})

test('the accounts panel is capped by the visual space below its phone trigger', () => {
  const phone = phoneRule(`${MODE} .acct-menu`)
  assert.ok(phone, 'the accounts disclosure must get a phone-only height budget')
  const available = new Map(declarations(phone.body).map(entry => [entry.property, entry.value]))
    .get('--acct-menu-available-height')
  assert.ok(available, 'the phone dress must provide the optional ceiling consumed by account-switcher.css')
  assert.match(available, /var\(--phone-canvas-h,\s*390px\)/,
    'the ceiling must use the measured visual app box, with the shortest registered phone side as its fallback')
  assert.match(available, /var\(--zoom,\s*1\)/,
    'the body text-size zoom must not paint the menu beyond the visual height it was given')

  const base = cssRules(read('account-switcher.css')).find(rule => /(?:^|[\s,])(?:dialog)?\.acct-menu(?:$|[\s,{])/.test(rule.selector.trim()))
  assert.ok(base, 'the accounts menu must retain its ordinary desktop rule')
  const maxHeight = new Map(declarations(base.body).map(entry => [entry.property, entry.value])).get('max-height')
  assert.match(maxHeight, /var\(--acct-menu-available-height,\s*960px\)/,
    'the shared menu must accept the phone ceiling while falling back to its unchanged desktop cap')
})

/* ==================================================================
   NOTHING IS LOST. The owner: "the functionality must remain isomorphic".
   ================================================================== */

/* The same rule tools/test/mobile-size-floor.test.mjs applies to widths, applied
   here to the mode: a control that vanishes is a path one device has and
   another does not. In this mode the answer is never a hide — it is a MOVE —
   so anything that does disappear has to be named in PHONE_RELOCATED with the
   door it left through. */
const CONTROL_WORD = /(seg|btn|button|toggle|control|action|chevron|switch|rail|tool)/i
test('the mode hides no control without a door', () => {
  const relocated = new Set(PHONE_RELOCATED.map(entry => entry.what))
  const offences = []
  for (const rule of cssRules(read('phone-canvas.css'))) {
    if (!/(?:^|;|\s)display\s*:\s*none/.test(rule.body)) continue
    for (const part of rule.selector.split(',')) {
      const compound = part.trim().split(/[\s>+~]/).filter(Boolean).pop() || ''
      if (compound.includes('::')) continue                 // a pseudo-element is decoration
      if (compound.includes('[hidden]')) continue           // state, not width and not the mode
      const bare = `.${compound.split('.').filter(Boolean).pop() || ''}`
      if (!CONTROL_WORD.test(compound)) continue
      if (relocated.has(bare)) continue
      offences.push(part.trim())
    }
  }
  assert.deepEqual(offences, [], 'a control the mode hides must be named in PHONE_RELOCATED with its door')
})

/* THE ISOMORPHISM ITSELF, at the only level source can see it: the phone shows
   the SAME ELEMENTS. Not a copy, not a re-render, not a summary — the rail node
   this page already built is appended into the sheet, so there is no second
   place for a number to be computed differently. */
test('the sheet moves the real rail rather than drawing a second one', () => {
  const source = read('phone-canvas.js')
  assert.match(source, /sheetBody\.append\(rail\)/, 'the sheet must hold the page own rail element')
  assert.match(source, /toolSlot\.append\(toolSet\)/, 'the sheet must hold the page own tool buttons')
  assert.ok(!/cloneNode/.test(source), 'a clone would be a second copy of the same facts')
  assert.ok(!/innerHTML/.test(source), 'the phone must not re-author any markup that already exists')
  for (const entry of PHONE_RELOCATED) {
    assert.ok(entry.what && entry.desktop && entry.phone && entry.how, 'every relocation states both ends and the mechanism')
  }
})

test('the two lines this mode adds to the computers page are unreachable on a desktop', () => {
  const source = readFileSync(path.join(SRC, 'views', 'computers.js'), 'utf8')
  const calls = source.match(/phoneCanvas[?.]*[.]\w+/g) || []
  assert.ok(calls.length > 0, 'the computers page must use the mode it mounts')
  for (const call of calls) {
    assert.ok(call.startsWith('phoneCanvas?.'), `${call} must be optional — mountPhoneCanvas returns null on a desktop`)
  }
  /* THE BINDING AND THE COUNT, NEVER THE EXPRESSION BETWEEN THEM. This read
     `const phoneCanvas = mountPhoneCanvas\(` until the call acquired a guard --
     the chat-only page declines to mount at all -- and the assertion went false
     against a file that was still correct. Relaxing it to a bare
     /mountPhoneCanvas/ would be worse than deleting it: that passes against a
     version that calls the mount and throws the handle away, which is exactly
     the defect every `phoneCanvas?.` assertion above depends on not happening.
     So pin the two properties that matter and nothing else: the mount happens
     ONCE in this file, and its value lands on the name `phoneCanvas`. Whatever
     guard sits in the middle is this page's business. */
  assert.equal((source.match(/mountPhoneCanvas\s*\(/g) || []).length, 1, 'exactly one mount in this file')
  assert.match(source, /const phoneCanvas = [^\n]*\bmountPhoneCanvas\s*\(/, 'the mode is mounted once, by name')
  assert.match(read('phone-canvas.js'), /if \(!root \|\| !phoneCanvasOn\(doc\)\) return null/, 'the mount must refuse off-mode')
})

test('the mode is started once, from the one place that boots the app', () => {
  const starters = walkFiles(SRC, '.js')
    .filter(file => /startPhoneCanvas\(/.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(REPO, file).replace(/\\/g, '/'))
  assert.deepEqual(starters.sort(), ['src/main.js', 'src/phone-canvas.js'])
  const main = read('main.js')
  /* The property is the COUNT -- one call, at boot -- not the column it starts
     in. The call now sits inside the try/catch asserted below, so it is
     indented; `^\s*` keeps the count assertion exactly as strong as it was. */
  assert.equal((main.match(/^\s*startPhoneCanvas\(\)$/gm) || []).length, 1, 'exactly one call, at boot')
  assert.match(main, /import '\.\/phone-canvas\.css'/, 'the sheet must be loaded with the rest of them')
})

/* AND THAT ONE CALL MAY NEVER TAKE THE BOOT DOWN WITH IT.
 *
 * startPhoneCanvas() is a bare call at module top level, so anything it throws
 * aborts the whole module and the product renders nothing at all. It CAN
 * throw, by design: readPhoneCanvasChoice() and readPhoneCanvasEnvironment()
 * both raise PHONE_CANVAS_COULD_NOT_TELL when localStorage or matchMedia
 * refuses -- the behaviour the "a failed device query is could-not-tell"
 * test above pins deliberately -- and it is reachable in private mode and in
 * locked-down embedded browsers. Measured 2026-09-02: nothing anywhere in
 * src/ caught it, while the text-size read twelve lines above main.js's call
 * had had its try/catch since it was written, for the same storage on the
 * same page load.
 *
 * Losing the phone dress is a small, correct degradation -- could-not-tell
 * lands on the desktop graph, which is where the routing law sends a visitor
 * who asked for nothing. Losing the application is not. */
test('a refused device query cannot stop the application from booting', () => {
  const main = read('main.js')
  assert.match(main, /try\s*\{\s*startPhoneCanvas\(\)\s*\}\s*catch/,
    'the one boot call must be wrapped in try/catch -- an uncaught '
    + 'PHONE_CANVAS_COULD_NOT_TELL from a private-mode or embedded browser '
    + 'aborts main.js and renders nothing at all')
  /* READ THE CATCH BODY, NOT THE FILE. Asserting the constant appears anywhere
     in main.js is vacuous -- the import line names it, so the assertion passed
     against a catch block emptied to `/* ignore *​/`. Simulated 2026-09-02
     while writing this test, which is the only reason it is written this way. */
  const guard = /try\s*\{\s*startPhoneCanvas\(\)\s*\}\s*catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(main)
  assert.ok(guard, 'the boot call must be wrapped in a try/catch this test can read')
  assert.match(guard[1], /PHONE_CANVAS_COULD_NOT_TELL/,
    'the catch body must distinguish a refused query from a real defect rather '
    + 'than swallowing every error silently')
})

/* THE LISTENERS BELONG TO THE MODE, NOT TO THE POINTER.
 *
 * `followable` decides whether a rotation re-measures the canvas. It used to
 * read "(coarsePointer && !canHover) || choice !== 'auto'", justified in prose
 * as "the only environments in which a later resize could change the answer".
 * That reason died with the routing law: phoneCanvasDecision reads no width,
 * so a resize can no longer change the answer for ANYBODY. What the listeners
 * actually do is MAINTAIN a canvas that is already on -- apply() re-runs
 * measureBox() and phoneShape().
 *
 * So the test is the one the old rule missed: the ledger route is now the only
 * door the shipped product has, and a device that comes through it must be
 * maintained whatever pointer it reports. Without ledgerRoute in the rule, a
 * stylus tablet or a desktop following the mobile page's link got the canvas
 * once and never re-measured it, leaving --phone-canvas-h at the pre-rotation
 * height. */
test('a device that came through the ledger door is re-measured on rotation', () => {
  const hovering = fakeWindow({ coarsePointer: false, canHover: true, width: 1440, height: 900, search: '?ledger=1' })
  assert.equal(startPhoneCanvas({ win: hovering.win }), true, 'the ledger door did not open')
  assert.ok(hovering.listeners.includes('resize'),
    'a hover-reporting device that followed /app/?ledger=1 got the canvas but no '
    + 'resize listener -- its box is frozen at the height it booted with')
  assert.ok(hovering.listeners.includes('orientationchange'),
    'the same device gets no orientationchange listener either')
})

test('a window that asked for nothing still gets no listeners at all', () => {
  const quiet = fakeWindow({ coarsePointer: false, canHover: true, width: 1440, height: 900 })
  assert.equal(startPhoneCanvas({ win: quiet.win }), false)
  assert.deepEqual(quiet.listeners, [],
    'widening followability must not start attaching listeners to plain desktops')
})

/* ==================================================================
   THE THEME. The owner: "it must strictly agree with the theme."
   ================================================================== */

/* NO NEW COLOUR. Every colour in the phone sheet resolves through the token
   layer, so a theme flip carries it and nobody has to remember it exists. */
const COLOUR_PROPERTY = /(^|-)color$|^background$|^background-color$|^border$|^border-[a-z-]*color$|^box-shadow$|^outline$|^fill$|^stroke$/
test('the phone sheet introduces no colour of its own', () => {
  const offences = []
  for (const rule of cssRules(read('phone-canvas.css'))) {
    for (const entry of declarations(rule.body)) {
      if (!COLOUR_PROPERTY.test(entry.property)) continue
      if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(entry.value)) {
        offences.push(`${rule.selector} { ${entry.property}: ${entry.value} }`)
      }
    }
  }
  assert.deepEqual(offences, [], 'a literal colour here is a colour the themes do not know about')
})

/* NO NEW RADIUS. The product radii are 3px, 3px and 2px and that sharpness is
   deliberate, so a radius here is a token or it is nothing. */
test('the phone sheet introduces no radius of its own', () => {
  const offences = []
  for (const rule of cssRules(read('phone-canvas.css'))) {
    for (const entry of declarations(rule.body)) {
      if (entry.property !== 'border-radius') continue
      const remainder = entry.value.replace(/var\(--r-(sm|md|lg)\)/g, '').replace(/\b0\b/g, '').trim()
      if (remainder) offences.push(`${rule.selector} { border-radius: ${entry.value} }`)
    }
  }
  assert.deepEqual(offences, [], 'every radius must be var(--r-sm), var(--r-md), var(--r-lg) or 0')
})

/* NO NEW FONT. */
test('the phone sheet introduces no font of its own', () => {
  const offences = []
  for (const rule of cssRules(read('phone-canvas.css'))) {
    for (const entry of declarations(rule.body)) {
      if (entry.property !== 'font' && entry.property !== 'font-family') continue
      if (!/var\(--font-(ui|mono)\)/.test(entry.value)) offences.push(`${rule.selector} { ${entry.property}: ${entry.value} }`)
    }
  }
  assert.deepEqual(offences, [], 'every font must come from var(--font-ui) or var(--font-mono)')
})

/* SPACING COMES OFF THE SCALE. Padding, margin and gap are the steps --s1..--s5
   or a calc over them; a bare pixel padding here would be a new spacing value
   in a product that has five. */
test('the phone sheet spaces itself on the product scale', () => {
  const offences = []
  for (const rule of cssRules(read('phone-canvas.css'))) {
    for (const entry of declarations(rule.body)) {
      if (!/^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/.test(entry.property)) continue
      const remainder = entry.value
        .replace(/var\(--s[1-5]\)/g, '')
        .replace(/calc\([^)]*\)/g, '')
        .replace(/\b0\b/g, '')
        .trim()
      if (remainder) offences.push(`${rule.selector} { ${entry.property}: ${entry.value} }`)
    }
  }
  assert.deepEqual(offences, [], 'spacing must be var(--s1)..var(--s5), a calc over them, or 0')
})

/* Every class this module creates has a dress, and every class the sheet
   dresses is one the module or the page actually builds. Drift in either
   direction is a control nobody can see or a rule nobody can reach. */
test('the sheet and the module agree about what exists', () => {
  const module = read('phone-canvas.js')
  const sheet = read('phone-canvas.css')
  const built = new Set((module.match(/make\('[a-z]+', '([a-z-]+)'\)/g) || [])
    .map(entry => /'([a-z-]+)'\)$/.exec(entry)[1]))
  assert.ok(built.size >= 6, 'the module must build the sheet it is styling')
  for (const className of built) {
    assert.ok(sheet.includes(`.${className}`), `.${className} is built and never dressed`)
  }
})

/* ==================================================================
   THE SHEET A PERSON PRESSES INTO, AND THE SHAPE THE PHONE IS HELD IN.
   ==================================================================

   WHAT WENT WRONG, AND WHY NOTHING SAW IT. A geometry gate walked every route
   of this product on an emulated phone, in two engines, and passed 100 out of
   100 while the surface behind one press was unusable: press an agent, the
   sheet comes up on Chat, and there is nothing to type into and nothing to
   read. Measured on the served build 2026-08-28 at 390x664:

     .chat-input   [22, 664, 346, 44]  -- the whole box below the glass
     .chat-log     8px tall holding 75px of content
     .chat-nosend  the sentence explaining the empty chat, half of it hidden
     and NOT ONE of the composer's thirteen ancestors could scroll.

   tools/phone-sheet-geometry-qa.mjs is the eye that opens the sheet and
   measures those rectangles in a browser. These are the mechanisms underneath
   it, pinned where a unit suite can reach them: a sheet that can scroll, a
   composer that stays at the foot of the view, and a bar that stops assuming
   the phone is upright. */

test('the sheet column can scroll, and a finger is allowed to move it', () => {
  const rule = phoneRule(`${MODE} .phone-sheet-body .rail-page`)
  assert.ok(rule, 'the rail column inside the sheet must be dressed by this mode')
  const seen = new Map(declarations(rule.body).map(entry => [entry.property, entry.value]))
  assert.equal(seen.get('overflow-y'), 'auto',
    'the column is position:absolute inset:0 inside a rail that clips; without a scroller here, anything it cannot fit is unreachable')
  assert.equal(seen.get('touch-action'), 'pan-y',
    'the mode locks the page by touch-action, so the one box that is meant to move has to say so')
  assert.equal(seen.get('overscroll-behavior'), 'contain',
    'a scroller inside a pinned page must not hand its overscroll to the page')
})

test('the message box stays at the foot of the sheet', () => {
  const rule = phoneRule(`${MODE} .phone-sheet-body .chat-input`)
  assert.ok(rule, 'the composer must be dressed by this mode')
  const seen = new Map(declarations(rule.body).map(entry => [entry.property, entry.value]))
  assert.equal(seen.get('position'), 'sticky', 'scrolling to find the message box is not the phone answer; it rides at the bottom of the view')
  assert.equal(seen.get('bottom'), '0', 'sticky without an offset sticks to nothing')
  assert.ok(seen.get('background'), 'the transcript passes behind the composer, so it needs a fill of its own')
})

test('the conversation keeps a floor, and gives it up for the sentence that replaces it', () => {
  const log = phoneRule(`${MODE} .phone-sheet-body .chat-log`)
  assert.ok(log, 'the transcript must have a floor in this mode; without one it collapsed to 8px of padding')
  assert.match(log.body, /min-height:\s*calc\(var\(--s5\) \+ var\(--s5\)\)/, 'the floor is two steps of the existing scale, never a new number')
  const refused = phoneRule(`${MODE} .phone-sheet-body .chat-cannot-send .chat-log`)
  assert.ok(refused, 'an agent that cannot be written to has a sentence to show instead of a transcript')
  assert.match(refused.body, /min-height:\s*0/, 'in that one state the floor gives way, so the refusal is read rather than half-hidden behind the composer')
})

/* THE SHAPE. src/phone-canvas.css may not contain a media query -- gate 2 --
   so a phone held sideways is told apart by an attribute the same one function
   writes, and these are both ends of that. */
test('which way the phone is held is arithmetic, and it is one function', () => {
  assert.equal(phoneShape({ width: 390, height: 844 }), PHONE_SHAPE_PORTRAIT, 'taller than it is wide is portrait')
  assert.equal(phoneShape({ width: 844, height: 390 }), PHONE_SHAPE_LANDSCAPE, 'wider than it is tall is landscape')
  assert.equal(phoneShape({ width: 500, height: 500 }), PHONE_SHAPE_PORTRAIT, 'a square canvas has the portrait problem and none of the landscape one')
  for (const nonsense of [{}, { width: 0, height: 0 }, { width: NaN, height: 100 }, { width: -1, height: -1 }]) {
    assert.equal(phoneShape(nonsense), PHONE_SHAPE_PORTRAIT,
      'a device that cannot be measured gets the dress that already shipped, never an untested one')
  }
  const writes = new RegExp(String.raw`setAttribute\s*\(\s*(?:PHONE_SHAPE_ATTR|['"]` + PHONE_SHAPE_ATTR + `)`)
  const writers = walkFiles(SRC, '.js')
    .filter(file => writes.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(REPO, file).replace(/\\/g, '/'))
  assert.deepEqual(writers, ['src/phone-canvas.js'], 'the shape must have exactly one writer, the same one the mode has')
})

test('a phone held sideways gets the tree back, and only a phone can reach the rule', () => {
  const sheet = cssRules(read('phone-canvas.css'))
  const landscape = sheet.filter(rule => rule.selector.includes(`[${PHONE_SHAPE_ATTR}="${PHONE_SHAPE_LANDSCAPE}"]`))
  assert.ok(landscape.length > 0, 'there must be a sideways dress at all; there was none, and a sideways phone lost every agent')
  for (const rule of landscape) {
    for (const part of rule.selector.split(',')) {
      assert.ok(part.includes(MODE),
        `${part.trim()} must carry the mode as well as the shape, or a desktop could reach it by turning a window`)
    }
  }
  /* The bar's three stacked full-width rows are a 390px decision. At 750 they
     took 151 of the tree pane's 152 pixels and the canvas resolved to zero. */
  const unstacked = landscape.filter(rule => /flex:\s*0 1 auto/.test(rule.body))
  assert.ok(unstacked.some(rule => rule.selector.includes('.graph-bar-lead')), 'the name gives up its own row when there is width for it')
  assert.ok(unstacked.some(rule => rule.selector.includes('.graph-tools')), 'the controls give up their own row when there is width for them')
  const treeStrip = landscape.find(rule => rule.selector.trim() === `${MODE}[${PHONE_SHAPE_ATTR}="${PHONE_SHAPE_LANDSCAPE}"] .computers .graph-bar-trees`)
  assert.match(treeStrip?.body || '', /flex:\s*1 1 0/,
    'the scrolling selector takes the remaining width rather than wrapping at its full content width')

  const slot = phoneRule(`${MODE} .computers .graph-canvas-slot`)
  assert.ok(slot, 'the canvas must be dressed by this mode')
  assert.match(slot.body, /min-height:\s*calc\(/, 'the canvas keeps a floor the bar cannot eat, or the next control added to the bar takes the tree away again')

  /* AND THE SHEET GIVES UP ITS DISMISS STRIP SIDEWAYS. The 44px band above the
     card is a press target for closing the sheet; sideways it is 44 of the
     ~250 pixels a whole conversation has, and the close button in the sheet's
     own head carries the same floor. Measured: with the strip, the message box
     sat at y=393 on a 390px screen; without it, 341. */
  const card = sheet.find(rule => rule.selector.trim()
    === `${MODE}[${PHONE_SHAPE_ATTR}="${PHONE_SHAPE_LANDSCAPE}"] .phone-sheet-card`)
  assert.ok(card, 'the sideways sheet must have a height rule of its own')
  assert.match(card.body, /height:\s*100%/, 'sideways the sheet takes the whole box it is in')
  const portraitCard = phoneRule(`${MODE} .phone-sheet-card`)
  assert.match(portraitCard.body, /height:\s*calc\(100% - var\(--s5\) - var\(--s4\) - var\(--s1\)\)/,
    'upright the strip stays, and it is stated as one touch target rather than as a percentage')

  /* A full-height sheet no longer needs the pull handle to explain where its
     exterior edge is; in the short dimension that decoration and the portrait
     head padding clipped the composer's touch target. */
  const compactGrab = sheet.find(rule => rule.selector.trim()
    === `${MODE}[${PHONE_SHAPE_ATTR}="${PHONE_SHAPE_LANDSCAPE}"] .phone-sheet-grab`)
  assert.ok(compactGrab, 'the decorative handle must have a sideways rule')
  assert.match(compactGrab.body, /display:\s*none/, 'sideways, the full-height sheet spends no room on a redundant handle')
  const compactHead = sheet.find(rule => rule.selector.trim()
    === `${MODE}[${PHONE_SHAPE_ATTR}="${PHONE_SHAPE_LANDSCAPE}"] .phone-sheet-head`)
  assert.ok(compactHead, 'the sheet head must have a sideways rule')
  assert.match(compactHead.body, /padding-block:\s*0/,
    'the close button supplies the head height sideways, leaving the 44px composer inside the rail clip')
})

/* ==================================================================
   THE SHEET, MOUNTED. Everything above drives startPhoneCanvas with a fake
   window because the file's own preface says why: no DOM in these node
   tests, findings that need one are named in the pass report and NOT
   asserted here. mountPhoneCanvas is different from phoneCanvasDecision: it
   is not pure arithmetic, it BUILDS the sheet, and setSubject / the is-up
   transition / the grab bar only exist on the nodes it builds. So this
   section drives it with the smallest DOM double that answers exactly what
   mountPhoneCanvas calls -- the same house move tools/test/chat-surface-
   behaviors.test.mjs makes for buildChat. Copied rather than imported, for
   the reason this file's own CSS-parser preamble already gives: a suite
   that imports its own subject's test double can be made to pass by
   editing the double.
   ================================================================== */

class FakeClassList {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(name) { return this.values().includes(name) }
  add(...names) { this.node.className = [...new Set([...this.values(), ...names])].join(' ') }
  remove(...names) { this.node.className = this.values().filter(name => !names.includes(name)).join(' ') }
}
class FakeStyle {
  constructor() { this.props = {} }
  setProperty(name, value) { this.props[name] = value }
  removeProperty(name) { delete this.props[name] }
}
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.ownerDocument = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.className = ''
    this.hidden = false
    this.textContent = ''
    this.style = new FakeStyle()
    this.dataset = {}
    this.classList = new FakeClassList(this)
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node) } }
  prepend(node) { node.parentNode = this; this.children.unshift(node) }
  remove() {
    if (!this.parentNode) return
    const at = this.parentNode.children.indexOf(this)
    if (at >= 0) this.parentNode.children.splice(at, 1)
    this.parentNode = null
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list) }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || []
    const at = list.indexOf(fn)
    if (at >= 0) list.splice(at, 1)
  }
  dispatch(type, init = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...init }
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event)
    return event
  }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false }
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : false }
  querySelectorAll(selector) {
    const found = []
    const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child) } }
    walk(this)
    return found
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this }
}

/** A document that answers exactly what mountPhoneCanvas asks of it: an
    element factory, a root already carrying the mode attribute (so
    phoneCanvasOn reads true, the mount's own guard), and a keydown bus for
    the Escape handler. */
function fakeMountDoc() {
  const documentElement = new FakeNode('html')
  documentElement.setAttribute(PHONE_CANVAS_ATTR, 'on')
  const doc = {
    documentElement,
    activeElement: null,
    listeners: new Map(),
    createElement(tag) { const node = new FakeNode(tag); node.ownerDocument = doc; return node },
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list) },
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
  }
  return doc
}

/** A window whose requestAnimationFrame runs its callback synchronously (so
    the rise is observable the instant open() returns) and whose setTimeout /
    clearTimeout are driven BY HAND (so the fall's two states -- mid-fall,
    still on the page, and settled, hidden again -- can both be observed
    instead of only the end state a real timer would eventually reach). */
function fakeMountWin() {
  let nextId = 1
  const pending = new Map()
  return {
    lastTimeoutMs: null,
    requestAnimationFrame(run) { run(); return nextId++ },
    setTimeout(run, ms) { const id = nextId++; this.lastTimeoutMs = ms; pending.set(id, run); return id },
    clearTimeout(id) { pending.delete(id) },
    firePendingTimers() { for (const [id, run] of [...pending]) { pending.delete(id); run() } },
  }
}

/** The slice of the computers page mountPhoneCanvas actually reaches into:
    a rail (mandatory -- mountPhoneCanvas refuses without one), the graph's
    tool-chip set and zoom-cluster host, and the two panes that go inert
    behind the open sheet. */
function fakeComputersRoot(doc) {
  const root = doc.createElement('div')
  root.className = 'computers'
  const rail = doc.createElement('aside')
  rail.className = 'rail'
  const toolSet = doc.createElement('div')
  toolSet.className = 'graph-tool-set'
  const tools = doc.createElement('div')
  tools.className = 'graph-tools'
  const body = doc.createElement('div')
  body.className = 'comp-body'
  const tabs = doc.createElement('div')
  tabs.className = 'tabs'
  root.append(rail, toolSet, tools, body, tabs)
  return { root, rail, toolSet, tools, body, tabs }
}

/** Mount for real, over the fake DOM above, and hand back both halves: the
    root a test can query for the nodes mountPhoneCanvas built, and the
    sheet -- the API src/views/computers.js and src/phone-ledger.js actually
    call (setSubject, open, close, isOpen). */
function mountFakeSheet(options = {}) {
  const doc = fakeMountDoc()
  doc.defaultView = fakeMountWin()
  const { root } = fakeComputersRoot(doc)
  const sheet = mountPhoneCanvas({ root, doc, ...options })
  assert.ok(sheet, 'mountPhoneCanvas must mount over a rail-bearing root once the mode attribute is on')
  return { doc, win: doc.defaultView, root, sheet }
}

test('entering Chat reveals the complete composer in its rail without changing focus or other pages', () => {
  const { doc, root, sheet } = mountFakeSheet()
  const active = doc.createElement('div')
  active.className = 'ctl-page'
  const dock = doc.createElement('div')
  dock.className = 'chat-composer-dock'
  active.append(dock)
  root.querySelector('.rail').append(active)
  active.clientTop = 1
  active.clientHeight = 300
  active.offsetHeight = 302
  active.scrollTop = 20
  // A translated, magnified sheet: scrolling uses CSS pixels, while its
  // observed bounds include the current zoom and rising-sheet transform.
  active.getBoundingClientRect = () => ({ top: 800, height: 604 })
  dock.getBoundingClientRect = () => ({ bottom: 1502, height: 320 })
  sheet.onRailPage('controls')
  assert.equal(active.scrollTop, 70, 'only the clipped 50 CSS pixels are revealed')
  assert.equal(doc.activeElement, root.querySelector('.phone-sheet-close'), 'opening keeps dialog focus and does not summon the keyboard')
  assert.equal(dock.parentNode, active, 'the shared composer is never detached or rebuilt')

  dock.getBoundingClientRect = () => ({ bottom: 1390, height: 320 })
  sheet.onRailPage('controls')
  assert.equal(active.scrollTop, 70, 'an already visible composer preserves the reading position')
  dock.getBoundingClientRect = () => ({ bottom: 1600, height: 320 })
  sheet.onRailPage('compose')
  sheet.onRailPage('stats')
  assert.equal(active.scrollTop, 70, 'opening a different rail page never scrolls Chat')
})

test('the phone dialog identifies example data inside the modal and clears it when the source becomes real', () => {
  let sample = true
  const { root, sheet } = mountFakeSheet({ isExample: () => sample })
  const card = root.querySelector('.phone-sheet-card')
  const badge = root.querySelector('.phone-sheet-example')
  sheet.setSubject({ name: 'Coordinator', lineage: 'Coordinator', statusWord: 'finished' })
  sheet.open()
  assert.equal(badge.hidden, false)
  assert.equal(badge.textContent, 'Example, not your data')
  assert.ok(card.contains(badge), 'the disclosure must be inside the modal, not behind its inert boundary')
  assert.match(card.getAttribute('aria-label'), /Coordinator.*Example, not your data/)
  sample = false
  sheet.syncSource()
  assert.equal(badge.hidden, true)
  assert.equal(root.querySelector('.phone-sheet-line').hidden, false)
  assert.equal(card.getAttribute('aria-label'), 'Coordinator — Details')
  sample = true
  sheet.setSubject(null)
  assert.equal(badge.hidden, false, 'the fleet overview in the same sheet must retain its example disclosure')
  assert.equal(card.getAttribute('aria-label'), 'Details — Example, not your data')
  sheet.destroy()
})

test('the phone sheet keeps keyboard focus inside and releases navigation when closed', () => {
  const doc = fakeMountDoc()
  doc.defaultView = fakeMountWin()
  const topbar = doc.createElement('nav')
  const skipLink = doc.createElement('a')
  doc.querySelector = selector => selector === '.topbar' ? topbar : selector === '.skip-link' ? skipLink : null
  const { root } = fakeComputersRoot(doc)
  const sheet = mountPhoneCanvas({ root, doc })
  const card = root.querySelector('.phone-sheet-card')
  const first = root.querySelector('.phone-sheet-close')
  const last = doc.createElement('button')
  card.append(last)
  card.querySelectorAll = () => [first, last]
  sheet.open()
  assert.equal(topbar.getAttribute('inert'), '')
  assert.equal(skipLink.getAttribute('inert'), '')
  const keydown = doc.listeners.get('keydown')[0]
  let prevented = 0
  last.focus()
  keydown({ key: 'Tab', preventDefault() { prevented++ } })
  assert.equal(doc.activeElement, first)
  keydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented++ } })
  assert.equal(doc.activeElement, last)
  assert.equal(prevented, 2)
  keydown({ key: 'Escape', preventDefault() {} })
  assert.equal(sheet.isOpen(), false)
  assert.equal(topbar.getAttribute('inert'), null)
  assert.equal(skipLink.getAttribute('inert'), null)
})

for (const [label, flags] of [
  ['active composition', { isComposing: true }],
  ['composition boundary', { isComposing: false, keyCode: 229 }],
]) test(`the phone sheet leaves ${label} keys to the input method`, t => {
  const { doc, root, sheet } = mountFakeSheet()
  t.after(() => sheet.destroy())
  const card = root.querySelector('.phone-sheet-card')
  const first = root.querySelector('.phone-sheet-close')
  const input = doc.createElement('input')
  card.append(input)
  card.querySelectorAll = () => [first, input]
  sheet.open()
  input.value = '変換中'
  input.focus()
  const onKeydown = doc.listeners.get('keydown')[0]
  let prevented = 0
  for (const key of ['Tab', 'Escape']) {
    onKeydown({ key, ...flags, preventDefault() { prevented++ } })
    assert.equal(sheet.isOpen(), true)
    assert.equal(doc.activeElement === input, true, 'composition must keep focus on its input')
    assert.equal(input.value, '変換中')
  }
  assert.equal(prevented, 0)
  onKeydown({ key: 'Tab', preventDefault() { prevented++ } })
  assert.equal(doc.activeElement, first, 'ordinary Tab still wraps inside the sheet')
  onKeydown({ key: 'Escape', preventDefault() { prevented++ } })
  assert.equal(sheet.isOpen(), false, 'ordinary Escape still closes the sheet')
})

test('setSubject fills the subject head -- rolebar, name, lineage, runtime, state -- and clearing it empties the head again', () => {
  const { root, sheet } = mountFakeSheet()
  const card = root.querySelector('.phone-sheet-card')
  const subject = root.querySelector('.phone-sheet-subject')
  const title = root.querySelector('.phone-sheet-title')
  const bar = root.querySelector('.phone-sheet-rolebar')
  const name = root.querySelector('.phone-sheet-name')
  const lineage = root.querySelector('.phone-sheet-line')
  const run = root.querySelector('.phone-sheet-run')
  const state = root.querySelector('.phone-sheet-state')
  assert.equal(subject.hidden, true, 'nothing has been pressed yet, so the subject head starts hidden')
  assert.equal(title.hidden, false, 'the container names itself until an agent does')

  let unbindCalls = 0
  let boundNode = null
  sheet.setSubject({
    name: 'Coordinator 7',
    lineage: 'DEFAULT 2 / COORDINATOR',
    roleHex: '#ff8800',
    runtimeText: '0:12:04',
    live: true,
    statusWord: 'running',
    mark: 'run',
    bindRun(node) { boundNode = node; return () => { unbindCalls += 1 } },
  })

  assert.equal(subject.hidden, false, 'a pressed row un-hides the subject head')
  assert.equal(title.hidden, true, 'the container word steps aside for the agent it now names')
  assert.equal(bar.style.background, '#ff8800', "the rolebar carries the pressed row's own role colour")
  assert.equal(name.textContent, 'Coordinator 7')
  assert.equal(lineage.textContent, 'DEFAULT 2 / COORDINATOR')
  assert.equal(run.textContent, '0:12:04')
  assert.equal(run.dataset.live, 'true', 'a live agent marks its own runtime node live')
  assert.equal(state.textContent, 'running')
  assert.equal(state.dataset.mark, 'run', 'the mark is read off the record, never off the status word')
  assert.equal(card.getAttribute('aria-label'), 'Coordinator 7 — Details',
    'the dialog names the agent it is about, not just the container')
  assert.equal(boundNode, run, 'the runtime clock is bound to the run node itself, never a copy of it')

  sheet.setSubject(null)
  assert.equal(unbindCalls, 1, 'the previous clock binding is released when the subject is cleared')
  assert.equal(subject.hidden, true, 'clearing the subject hides the head again')
  assert.equal(title.hidden, false, 'the container word returns once no agent is named')
  assert.equal(card.getAttribute('aria-label'), 'Details', 'the dialog label reverts to the plain container name')
})

test('refreshSubject keeps the head on the agent it is about, and repaints only a change', () => {
  const { root, sheet } = mountFakeSheet()
  const run = root.querySelector('.phone-sheet-run')
  const state = root.querySelector('.phone-sheet-state')
  let binds = 0, unbinds = 0
  const row = (fields) => ({ id: 'node-7', name: 'Builder 2', lineage: 'CONTROLLER / MANAGER', runtimeText: '0:00:33',
    live: true, statusWord: 'running', mark: 'run', bindRun: () => { binds += 1; return () => { unbinds += 1 } }, ...fields })
  sheet.setSubject(row())
  assert.equal(binds, 1)
  sheet.refreshSubject(row())
  assert.equal(binds, 1, 'an unchanged row must not rebind the clock')
  sheet.refreshSubject(row({ id: 'node-8', statusWord: 'finished', mark: 'done', live: false, bindRun: null }))
  assert.equal(state.textContent, 'running', 'another agent’s row must not take over the head')
  sheet.refreshSubject(row({ statusWord: 'the last turn failed', mark: 'fail', live: false, runtimeText: '0:00:34', bindRun: null }))
  assert.equal(state.textContent, 'the last turn failed', 'the head did not follow its own agent’s change')
  assert.equal(state.dataset.mark, 'fail')
  assert.equal(run.dataset.live, 'false')
  assert.equal(run.textContent, '0:00:34')
  assert.equal(unbinds, 1, 'the live clock was not released when the agent stopped running')
  sheet.setSubject(null)
  sheet.refreshSubject(row())
  assert.equal(root.querySelector('.phone-sheet-subject').hidden, true, 'a cleared head must stay cleared')
})

test('the sheet rises with is-up on open, and only drops hidden after the fall timer on close', () => {
  const { root, sheet, win } = mountFakeSheet()
  const sheetEl = root.querySelector('.phone-sheet')
  assert.equal(sheetEl.hidden, true, 'the sheet starts closed')
  assert.equal(sheetEl.classList.contains('is-up'), false, 'and not mid-rise')

  /* RISE */
  sheet.open()
  assert.equal(sheetEl.hidden, false,
    'opening un-hides FIRST, before the class is applied, so the browser has a start position to transition from')
  assert.equal(sheetEl.classList.contains('is-up'), true, 'the rise class lands on the next frame')
  assert.equal(sheet.isOpen(), true)

  /* FALL */
  sheet.close()
  assert.equal(sheetEl.classList.contains('is-up'), false,
    'closing drops the class immediately, so the fall transition has something to play from')
  assert.equal(sheetEl.hidden, false,
    'hidden must NOT land in the same frame as the class drop -- the card is still on the page, still falling')
  assert.equal(win.lastTimeoutMs, 460,
    'the hidden attribute is deferred by the module\'s own SHEET_FALL_MS, matched to the CSS transition duration')
  win.firePendingTimers()
  assert.equal(sheetEl.hidden, true, 'once the fall timer actually fires, hidden lands and the sheet leaves the tab ring')
  assert.equal(sheet.isOpen(), false)
})

test('the grab bar is the first thing in the card, and is marked decorative', () => {
  const { root } = mountFakeSheet()
  const card = root.querySelector('.phone-sheet-card')
  assert.ok(card, 'the card must mount')
  const grab = card.children[0]
  assert.ok(grab, 'the card must have a first child at all')
  assert.equal(grab.className, 'phone-sheet-grab',
    'the grab bar is the first thing in the card, because that is where every sheet on this platform puts it')
  assert.equal(grab.getAttribute('aria-hidden'), 'true',
    'the grab bar carries no fact, so it must be marked decorative rather than announced')
})
