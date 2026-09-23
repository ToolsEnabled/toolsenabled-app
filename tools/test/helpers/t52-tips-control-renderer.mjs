/* T52(4) fixture: the REAL first-use guidance, mounted in a real window, and
   the "Turn off new-page tips" control measured as the browser resolves it.

   WHY A REAL WINDOW. The question is literally "how big is the box, and can a
   person press it", and jsdom has no layout: getBoundingClientRect() there
   returns zeros for everything, which is the very value under investigation. A
   source pin would prove a rule is written and could not prove what the browser
   does with it.

   MEASUREMENT ONLY -- this builds no product behaviour. It mounts
   mountFirstUseGuidance() exactly as src/main.js does (entry host `.tb-left`,
   then `visit(route, element)` per route) and reports, per route and per step:
   whether the Guide entry is offered, whether the layer is open, whether the
   guide considers itself blocked, the control's own `hidden`, its resolved
   display, and its rectangle -- plus the first ancestor that is display:none,
   so a zero box says WHY it is zero instead of only that it is. */
import '../../../src/glow.css'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/app-navigation.css'
import '../../../src/sidebar-pages.css'
import '../../../src/readability.css'
import '../../../src/first-use-guidance.css'
import '../../../src/ledger.css'
import '../../../src/settings.css'
import '../../../src/metrics.css'
import '@fontsource-variable/ibm-plex-sans/index.css'
import '@fontsource-variable/jetbrains-mono/index.css'

import { mountFirstUseGuidance } from '../../../src/first-use-guidance.js'
import { FEATURE_GUIDES } from '../../../src/feature-guides.js'

const settle = async () => {
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/* A storage the fixture controls, so "already seen" is a state the test CHOOSES
   rather than an accident of the order pages were visited in. The real one is
   window.localStorage; createGuidePreferences takes whatever is handed to it. */
function freshStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    get length() { return map.size },
    key: index => [...map.keys()][index] ?? null,
  }
}

/* Each route's own outermost page element, the same shells the landed T52 width
   fixture uses. The guide reads `root` for its step targets, so the element has
   to be the page's real one or every step reports "not visible right now". */
const PAGE_HTML = Object.freeze({
  home: '<div class="home"><div style="height:400px"><p>content</p></div></div>',
  computers: '<div class="computers"><div style="height:400px"><p>content</p></div></div>',
  ledger: '<div class="ledger-shell"><div style="height:400px"><p>content</p></div></div>',
  settings: '<div class="settings-shell"><div style="height:400px"><p>content</p></div></div>',
  metrics: '<div class="metrics"><div style="height:400px"><p>content</p></div></div>',
  research: '<div class="research"><div style="height:400px"><p>content</p></div></div>',
  comms: '<div class="comms"><div style="height:400px"><p>content</p></div></div>',
})

let guidance = null
let pageHost = null

function boxOf(node) {
  if (!node) return null
  const rect = node.getBoundingClientRect()
  const round = value => Math.round(value * 100) / 100
  return { width: round(rect.width), height: round(rect.height), left: round(rect.left), top: round(rect.top) }
}

/* The first ancestor (the node itself included) that the browser is not laying
   out, and why. A zero-size rectangle has exactly one interesting question
   attached to it and this answers it. */
function collapsedBecause(node) {
  for (let el = node; el && el !== document.documentElement; el = el.parentElement) {
    const style = getComputedStyle(el)
    if (style.display === 'none') {
      return { selector: el.className || el.tagName.toLowerCase(), reason: 'display:none', hiddenAttribute: el.hasAttribute('hidden') }
    }
    if (style.visibility === 'hidden') {
      return { selector: el.className || el.tagName.toLowerCase(), reason: 'visibility:hidden', hiddenAttribute: el.hasAttribute('hidden') }
    }
  }
  return null
}

function readState(route, step) {
  const launch = document.querySelector('.first-use-launch')
  const layer = document.querySelector('.first-use-layer')
  const card = document.querySelector('.first-use-card')
  const quiet = document.querySelector('.first-use-quiet')
  return {
    route,
    step,
    launchOffered: Boolean(launch) && !launch.hidden,
    layerOpen: Boolean(layer) && !layer.hidden,
    guideExists: Object.hasOwn(FEATURE_GUIDES, route),
    quietPresent: Boolean(quiet),
    quietHiddenAttribute: quiet ? quiet.hasAttribute('hidden') : null,
    quietDisplay: quiet ? getComputedStyle(quiet).display : null,
    quietText: quiet ? quiet.textContent : null,
    quietBox: boxOf(quiet),
    quietCollapsedBecause: quiet ? collapsedBecause(quiet) : null,
    cardBox: boxOf(card),
  }
}

window.t52Tips = {
  /* One mount, one storage, one route -- a clean slate per measurement, so a
     route measured after another cannot inherit its "already seen" state. */
  async open(route, { advance = 0, blockWith = null } = {}) {
    guidance?.destroy()
    document.querySelector('.first-use-block')?.remove()
    document.body.className = ''
    document.body.setAttribute('data-navigation', 'side')
    document.body.setAttribute('data-route', route)
    document.body.innerHTML = '<header class="topbar"><div class="tb-left"></div></header><main class="page-host"></main>'
    pageHost = document.querySelector('.page-host')
    pageHost.innerHTML = PAGE_HTML[route] || '<div><p>content</p></div>'
    if (blockWith === 'modal') {
      const dialog = document.createElement('div')
      dialog.className = 'first-use-block'
      dialog.setAttribute('aria-modal', 'true')
      dialog.style.cssText = 'position:fixed;inset:20px;background:#fff'
      document.body.append(dialog)
    }
    if (blockWith === 'first-run') document.body.classList.add('first-run')
    guidance = mountFirstUseGuidance({ entryHost: document.querySelector('.tb-left'), storage: freshStorage() })
    guidance.visit(route, pageHost.firstElementChild)
    await settle()
    /* The intro card auto-opens on a route the person has not seen. If it did
       not (a guide-less route, or a blocked page), press the Guide entry the
       way a person would, so "offered but unreachable" is distinguishable from
       "never offered". */
    const layer = document.querySelector('.first-use-layer')
    if (layer?.hidden) {
      const launch = document.querySelector('.first-use-launch')
      if (launch && !launch.hidden) { launch.click(); await settle() }
    }
    for (let i = 0; i < advance; i++) {
      document.querySelector('.first-use-next')?.click()
      await settle()
    }
    return readState(route, advance === 0 ? -1 : advance - 1)
  },

  /* Press the control itself, and report what the person is then told. A
     control that measures 44px high and does nothing is still unreachable. */
  async press() {
    const quiet = document.querySelector('.first-use-quiet')
    if (!quiet) return { pressed: false, reason: 'no control in the DOM' }
    const box = boxOf(quiet)
    /* What the browser says is at the control's own centre. A control covered
       by something else is not pressable however large its box is. */
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const before = quiet.textContent
    quiet.click()
    await settle()
    return {
      pressed: true,
      box,
      hitIsControl: hit === quiet || quiet.contains(hit),
      hitTag: hit ? (hit.className || hit.tagName.toLowerCase()) : null,
      labelBefore: before,
      labelAfter: quiet.textContent,
      feedback: document.querySelector('#first-use-preference-feedback')?.textContent ?? null,
    }
  },

  routes() { return Object.keys(FEATURE_GUIDES) },
}
