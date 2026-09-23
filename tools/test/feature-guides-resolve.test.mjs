/* EVERY STEP OF EVERY PAGE GUIDE POINTS AT A CONTROL THAT IS ACTUALLY THERE.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. src/first-use-guidance.js resolves a step by
 * running each of its `selectors` against the mounted page and taking the first
 * VISIBLE match. When no selector matches, the step does not error and does not
 * disappear: it quietly shows its `unavailable` sentence instead. So a guide
 * whose selectors have gone stale -- because the control was renamed, moved, or
 * rebuilt -- still walks a new person through the page telling them, step after
 * step, that the thing it is describing is "not visible right now". That is a
 * bad first five minutes: the one surface built to reassure a stranger is the
 * surface confidently describing controls that are on the screen in front of
 * them under a different name.
 *
 * Nothing else catches it. The copy is prose, so no gate reads it; the
 * selectors are strings, so no compiler resolves them; and the fallback means
 * the page never throws. It is invisible until a person is confused by it.
 *
 * WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT. It mounts each
 * page with the fixtures that page's own view test uses and asserts that every
 * step has at least one selector matching at least one element. That is the
 * half a node DOM can answer honestly.
 *
 * It does NOT assert VISIBILITY. first-use-guidance.js filters matches with
 * getClientRects(), which a node DOM has no layout to answer, so a visibility
 * assertion here would test the stand-in rather than the product. The rendered
 * half -- which matched control is on the glass at each size -- belongs to the
 * Electron harness and is named in the report as owed.
 *
 * THE THREE TEXT SIZES ARE REAL BUT NARROW HERE, and that is stated rather than
 * implied. Text size is a `zoom` on <body> plus a `--zoom` custom property
 * (src/text-size.js); it changes no markup. Sweeping all three catches a view
 * that BRANCHES on the stored size and would otherwise be measured at one size
 * only. It is not a substitute for looking at the rendered page.
 *
 * Run: node --test tools/test/feature-guides-resolve.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)

/* THE PAGE FIXTURE, TAKEN FROM tools/test/disposal-teardown.test.mjs, which is
   the view test that already mounts settingsView() in a node DOM. The bare
   stand-in is not enough for these pages and says so loudly rather than
   quietly: metrics dies in buildTiles on document.createElementNS and settings
   dies in readValue on document.getElementById. Mounting them with less than
   this would have reported "no selector matched" for a page that never rendered
   -- a fixture gap wearing the costume of a stale guide. */
function installSurfaceDom() {
  const dom = installDomStandIn(globalThis)
  // Metrics updates the first option's account label. Supply the native
  // select.options read boundary in this fixture, including parsed selects.
  const elementPrototype = Object.getPrototypeOf(document.createElement('select'))
  const originalOptions = Object.getOwnPropertyDescriptor(elementPrototype, 'options')
  Object.defineProperty(elementPrototype, 'options', {
    configurable: true,
    get() { return this.tagName === 'SELECT' ? this.querySelectorAll('option') : undefined },
  })
  const restore = dom.restore.bind(dom)
  dom.restore = () => {
    if (originalOptions) Object.defineProperty(elementPrototype, 'options', originalOptions)
    else delete elementPrototype.options
    restore()
  }
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
  globalThis.window.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', getPropertyValue: () => '' })
  globalThis.getComputedStyle = globalThis.window.getComputedStyle
  globalThis.document.querySelector = selector => globalThis.document.documentElement.querySelector(selector) || globalThis.document.body.querySelector(selector)
  globalThis.document.querySelectorAll = selector => [...globalThis.document.documentElement.querySelectorAll(selector), ...globalThis.document.body.querySelectorAll(selector)]
  globalThis.document.getElementById = id => globalThis.document.querySelector('#' + id)
  globalThis.document.createElementNS = (_namespace, tag) => globalThis.document.createElement(tag)
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  return dom
}

const dom = installSurfaceDom()

const { FEATURE_GUIDES } = await import('../../src/feature-guides.js')
const { TEXT_SIZES, applyTextSize } = await import('../../src/text-size.js')

const { homeView } = await import('../../src/views/home.js')
const { computersView } = await import('../../src/views/computers.js')
const { agentView } = await import('../../src/views/agent.js')
const { researchView } = await import('../../src/views/research.js')
const { metricsView } = await import('../../src/views/metrics.js')
const { commsView } = await import('../../src/views/comms.js')
const { ledgerView } = await import('../../src/views/ledger.js')
const { settingsView } = await import('../../src/views/settings.js')
const { toolsView } = await import('../../src/views/tools.js')
const { accountView } = await import('../../src/views/account.js')

test.after(() => { dom.restore(); delete globalThis.navigator; delete globalThis.getComputedStyle })

/* The same arguments src/main.js makeView() hands each stop, so what is mounted
   here is what a person opens. `navigate` is a no-op: resolving a selector must
   never move anybody. */
const MOUNT = Object.freeze({
  home: () => homeView(),
  computers: () => computersView({ initialComputer: null, navigate() {} }),
  // The product's declared example seat goes through the same agent renderer
  // as a live projection, without reading an owner's sessions or starting one.
  agent: () => agentView({ compId: 'guide-fixture', agentId: 'codex', example: true, navigate() {} }),
  research: () => researchView(),
  metrics: () => metricsView(),
  comms: () => commsView(),
  ledger: () => ledgerView(),
  settings: () => settingsView({ query: null, navigate() {} }),
  tools: () => toolsView(),
  account: () => accountView({ navigate() {} }),
})

/** Mount one page, run `fn` against its root, and always tear it down. */
async function onPage(name, fn) {
  const view = MOUNT[name]()
  const root = view.el
  document.body.appendChild(root)
  try {
    // The agent projection is asynchronous even for the local example data.
    // Drain that real render before judging its controls, not its loading shell.
    if (name === 'agent') await new Promise(resolve => setImmediate(resolve))
    assert.ok(!root.querySelector('.is-loading'), `${name} did not finish its fixture render`)
    return fn(root)
  } finally {
    try { view.destroy?.() } catch { /* teardown is not what this file measures */ }
    root.remove()
  }
}

/* Counted with real tag names rather than "*", which the DOM stand-in does not
   implement: a universal query returns nothing there, which would report every
   page as empty and hide every stale selector behind a false excuse. */
const BODY_TAGS = Object.freeze(['div', 'section', 'button', 'input', 'a', 'h1', 'h2', 'p', 'span', 'ul', 'li'])

/** Every selector of one step, with how many elements each matched. */
function resolveStep(root, step) {
  return step.selectors.map(selector => {
    let matched = 0
    try { matched = root.querySelectorAll(selector).length } catch { matched = -1 }
    return { selector, matched }
  })
}

/* One test per page, so a stale page names itself in its own TAP line instead
   of hiding inside a single combined failure. */
for (const [name, guide] of Object.entries(FEATURE_GUIDES)) {
  test(`every step of the ${name} guide points at a control that exists`, async () => {
    assert.ok(MOUNT[name], `no mount fixture for the ${name} guide`)
    assert.ok(guide.steps.length > 0, `the ${name} guide has no steps`)

    const broken = []
    const bare = []
    for (const size of TEXT_SIZES) {
      applyTextSize(size)
      await onPage(name, root => {
        if (name === 'agent') assert.ok(!root.querySelector('.projection-unavailable'),
          `${name} fixture could not mount: ${root.textContent}`)
        /* A PAGE THAT RENDERED NOTHING IS NOT A STALE GUIDE, and the two must
           never be reported as one thing. agentView() with no computer and no
           assistant chosen returns an empty shell, so every selector misses for
           a reason that says nothing about the guide's copy. Calling that
           "stale" would send somebody to rewrite correct selectors. */
        if (BODY_TAGS.every(tag => root.querySelectorAll(tag).length === 0)) {
          bare.push(size)
          return
        }
        guide.steps.forEach((step, index) => {
          const tried = resolveStep(root, step)
          if (tried.some(one => one.matched > 0)) return
          broken.push(`step ${index + 1} "${step.title}" at text size ${size}: `
            + tried.map(one => `${one.selector} matched ${one.matched < 0 ? 'nothing (invalid selector)' : '0'}`).join('; '))
        })
      })
    }
    applyTextSize(1)

    assert.deepEqual(bare, [], `${name} rendered no fixture markup at text size(s) ${bare.join(', ')}`)

    assert.deepEqual(broken, [],
      `${broken.length} step reading(s) of the ${name} guide describe a control this page does not have, `
      + `so a new person is shown the "not visible right now" sentence instead:\n  ${broken.join('\n  ')}`)
  })
}

test('every guide names a page the router can actually mount', () => {
  /* A guide for a page nothing opens is copy nobody will read, and it would
     make the per-page assertions above silently vacuous. */
  const unmountable = Object.keys(FEATURE_GUIDES).filter(name => !MOUNT[name])
  assert.deepEqual(unmountable, [], `guides with no page to open: ${unmountable.join(', ')}`)
})

test('the Metrics layout guide names the visible button', async () => {
  await onPage('metrics', root => {
    const step = FEATURE_GUIDES.metrics.steps.find(value => value.selectors.includes('#m-edit'))
    const button = root.querySelector('#m-edit')
    assert.ok(step && button)
    assert.equal(button.textContent.trim(), 'Edit layout')
    assert.ok(step.text.includes(button.textContent.trim()), 'the guide must use the button label a person sees')
  })
})

test('no step is written without a selector or without copy a person can read', () => {
  const thin = []
  for (const [name, guide] of Object.entries(FEATURE_GUIDES)) {
    guide.steps.forEach((step, index) => {
      const where = `${name} step ${index + 1}`
      if (!Array.isArray(step.selectors) || step.selectors.length === 0) thin.push(`${where}: no selectors`)
      if (!step.title || step.title.trim().length < 3) thin.push(`${where}: no title`)
      /* A deliberately low bound: this catches an empty or placeholder step and
         leaves the judgement about GOOD copy to a person. */
      if (!step.text || step.text.trim().length < 40) thin.push(`${where}: text too short to explain anything`)
    })
  }
  assert.deepEqual(thin, [], `steps that cannot help anybody:\n  ${thin.join('\n  ')}`)
})
