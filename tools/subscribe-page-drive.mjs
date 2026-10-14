#!/usr/bin/env node

/* DRIVE THE SUBSCRIPTION PAGE THE WAY A VISITOR WOULD, AND MEASURE WHAT
 * HAPPENED. Source-grep is not proof; this is.
 *
 * It runs the whole stack on loopback -- the built site, the signup service, and
 * a test-mode provider double -- and opens the page in a PLAIN Chromium context:
 * no preload, no node integration, no shell bridge. That is what a person on the
 * website gets, and it is the context every other harness in this repo does not
 * use, which is how "functionally ready" came to be true of the app and false of
 * the website (R1260 t5a).
 *
 * WHAT IT ASSERTS, AND WHY EACH ONE IS HERE
 *   A. no horizontal overflow at 1024/1280/1440/1600/1920, on all three themes
 *   B. every control HIT-TESTS: the element at the centre of its own box is
 *      itself. A non-zero bounding box is not a clickable target -- an overlay,
 *      a transform or a negative margin makes a control that measures fine and
 *      cannot be pressed.
 *   C. every inclusion CLAIM on screen appears in the catalog. This is the
 *      behavioural half of "the page cannot promise what the model does not
 *      grant"; the static half is tools/check-subscription-claims.mjs.
 *   D. a keyboard-only signup completes: real Tab/Space/Enter key events, with
 *      document.activeElement read after each one. No mouse is used at all.
 *   E. the end-to-end test-mode signup reaches a cs_test_ checkout link.
 *   F. the states: catalog gone (fails closed, controls disabled), already
 *      subscribed, declined, offline, double-submit, and the back button.
 *
 * CONFIGURATION COMES FROM THE ENVIRONMENT, NOT ARGV. Measured by R1260 t5a: a
 * bare URL passed as an Electron argv makes the binary exit -1 before main runs,
 * with no stdout and no stderr -- which reads to a caller as a fast clean pass.
 *
 *   SUB_DRIVE_DIST    built site to serve      default: <repo>/dist
 *   SUB_DRIVE_OUT     screenshots and report   default: artifacts/subscribe-drive
 *   MC_SMOKE_HEADLESS =1 renders OFFSCREEN: no window, no stolen focus.
 *
 * THIS IS THE ONLY BEHAVIOURAL CHECK OF THE PURCHASE SURFACE, AND UNTIL
 * 2026-08-23 NOTHING RAN IT BEFORE A PUBLICATION. It was held out of
 * tools/packaged-qa-suite.mjs -- what `npm run release:cut` runs before a cut --
 * because it created its window with `show: true`, and rule 4 of that suite is
 * no window, no console, no stolen focus. The reason was right and the cost was
 * the money path going unchecked at every cut.
 *
 * Under MC_SMOKE_HEADLESS=1 the window is created OFFSCREEN instead: it paints,
 * it takes real mouse and key input, and it appears nowhere. Hiding it is NOT
 * enough on its own -- preview-browser-drive's header records a hidden window
 * that produced green assertions beside lying screenshots -- so every capture
 * here now carries a freshness probe from tools/lib/capture-evidence.mjs and a
 * capture that is blank or from the wrong moment FAILS the run by name.
 *
 * Measured 2026-08-23 on Electron 43.3.0 before this was relied on: offscreen,
 * Tab moves document.activeElement through the form, typed characters land in
 * the focused field, Space activates a button, real mouse input and
 * elementFromPoint both work, setContentSize reflows the page, and the DevTools
 * protocol attaches (which the offline scenario needs). One thing does NOT hold
 * offscreen: document.hasFocus() stays false. That assertion is replaced below
 * by the behavioural fact it was standing in for.
 *
 * Exit 0 only if every assertion passed AND a non-trivial number of them ran; a
 * run that measured nothing exits 1, because a harness that passes because it
 * found nothing is the defect it exists to catch.
 */

import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProviderDouble } from './test-mode-provider-double.mjs'
import rendererSubject from './lib/qa-renderer-dist.cjs'
import { captureTruthfully, domAgreementScript, pixelAt, withViewport } from './lib/capture-evidence.mjs'

/* THE ENDPOINT THE APPLICATION ACTUALLY MOUNTS, not a hand-rolled copy of it.
 *
 * This drive used to build its own service and hand createHttpHandler straight
 * to its site server. Everything it asserted about the page was true and it
 * proved nothing about the product, because the shipped shell mounted no such
 * handler at all: /v1/signup fell through to the SPA fallback and the page was
 * told it was offline. A harness that stands up its own working version of the
 * missing piece cannot see that the piece is missing.
 *
 * So it now goes through shell/subscribe-endpoint.cjs -- the same module
 * serveDist() calls, with the same synchronous take-it-or-leave-it convention,
 * the same per-request construction and the same shipped model file. */
const requireShell = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { selectRendererDist, rendererRequestPath } = rendererSubject
// --release selects packed renderer and service code. Provider responses and
// signup storage remain explicit test fixtures, so this is instrumented QA.
const RENDERER = selectRendererDist({ argv: process.argv, repoRoot: REPO_ROOT })
function selectedSubscribeDirectory() {
  if (RENDERER.release && process.env.SUB_DRIVE_DIST) throw new Error('SUB_DRIVE_DIST cannot override an explicit release')
  return RENDERER.release ? RENDERER.dist : path.resolve(REPO_ROOT, process.env.SUB_DRIVE_DIST || 'dist')
}
const DIST = selectedSubscribeDirectory()
const SUBJECT_ROOT = RENDERER.release ? path.dirname(DIST) : REPO_ROOT
const { createSubscribeEndpoint } = requireShell(path.join(SUBJECT_ROOT, 'shell', 'subscribe-endpoint.cjs'))
const { SignupStore, createCheckoutProvider } = requireShell(path.join(SUBJECT_ROOT, 'shell', 'subscribe-service.cjs'))
const OUT = path.join(REPO_ROOT, process.env.SUB_DRIVE_OUT || 'artifacts/subscribe-drive')
const WIDTHS = [1024, 1280, 1440, 1600, 1920]
const THEMES = ['white', 'tan', 'black']

/* The exact string '1' -- the value shell/window-options.cjs reads and the value
   tools/packaged-qa-suite.mjs sets. Anything else, absence included, leaves the
   window visible, which is what an operator running this by hand wants. */
const HEADLESS = process.env.MC_SMOKE_HEADLESS === '1'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
}

const results = []
const failures = []
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail })
  if (!condition) failures.push(`${name}${detail ? ` -- ${detail}` : ''}`)
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// The site + service, on one loopback origin so the page's fetches are same-origin
// ---------------------------------------------------------------------------

async function startSite({ endpoint, catalogGone }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    /* Same call shape and same order as serveDist(): the endpoint is offered
       the pathname, takes the request or declines it, and everything it
       declines falls through to the file server exactly as it does in the app.
       A `/v1/` prefix test here instead would be this harness deciding the
       routing question the product actually has to answer. */
    if (endpoint.serve(url.pathname, request, response)) return
    if (catalogGone() && url.pathname === '/data/subscription-catalog.json') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('gone')
      return
    }
    const file = rendererRequestPath(DIST, request.url)
    if (!file) { response.writeHead(403).end(); return }
    if (!existsSync(file) || !statSync(file).isFile()) {
      const index = path.join(DIST, 'index.html')
      response.writeHead(200, { 'content-type': MIME['.html'] })
      createReadStream(index).pipe(response)
      return
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).pipe(response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

// ---------------------------------------------------------------------------
// In-page measurement, injected as a string (plain context: no bridge exists)
// ---------------------------------------------------------------------------

/* THE LIVE VIEW, NOT "THE FIRST ONE IN THE DOM".
 *
 * This router keeps the OUTGOING view mounted for 420ms so it can transition
 * out, marking it `inert` on the way. It also re-renders once when the
 * checkout-surface probe lands, so a page that has just loaded genuinely has
 * two subscribe views in the document for a fraction of a second. Measured
 * naively that reads as four plan cards and a twelve-item free list; acted on
 * naively, a click lands on the retiring copy whose handlers have already been
 * torn down, and the scenario silently does nothing. Everything below addresses
 * the live one. */
const LIVE = `(() => {
  const views = [...document.querySelectorAll('#stage > .view')]
    .filter(view => !view.inert && !view.hasAttribute('inert') && !view.classList.contains('exit'))
  return views[views.length - 1] || document
})()`

const MEASURE = `(() => {
  const doc = ${LIVE}
  const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth
  const controls = [...doc.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
  const visible = controls.filter(node => {
    /* A control inside a subtree the page has marked inert or aria-hidden is
       not offered to anybody -- the closed settings drawer is exactly that, and
       counting its four off-screen controls would make this check fail on the
       app chrome instead of on the page under test. This is a definition of
       "offered", not a carve-out: remove either attribute and they come back. */
    if (node.closest('[inert], [aria-hidden="true"]')) return false
    const rect = node.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(node)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.01
  })
  const hit = visible.map(node => {
    /* SCROLLED INTO VIEW FIRST. Clamping an out-of-view control's centre to the
       viewport edge tests whatever happens to be at that edge, which reports a
       perfectly good button below the fold as unclickable. A person scrolls to
       a control before pressing it; so does this. */
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
    const at = inView ? document.elementFromPoint(x, y) : null
    return {
      tag: node.tagName.toLowerCase(),
      label: (node.getAttribute('aria-label') || node.textContent || node.id || '').trim().slice(0, 60),
      disabled: node.disabled === true,
      inView,
      hit: inView && !!at && (at === node || node.contains(at) || at.contains(node)),
    }
  })
  return {
    overflow,
    bodyText: document.body.innerText.length,
    route: location.hash,
    controls: hit,
    planCards: [...doc.querySelectorAll('.sub-plan')].map(card => ({
      plan: card.dataset.plan,
      chosen: card.classList.contains('is-chosen'),
      saving: (() => { const node = card.querySelector('.sub-plan-saving'); return node && !node.hidden ? node.textContent.trim() : null })(),
      noPrice: !!card.querySelector('.sub-plan-noprice'),
      radioDisabled: (card.querySelector('.sub-plan-radio') || {}).disabled ?? null,
      /* The card IS the control -- a label wrapping a visually-hidden radio --
         so it is hit-tested like one. A card with a perfect bounding box that
         something else sits on top of is a plan nobody can choose. */
      hit: (() => {
        card.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        const rect = card.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false
        const at = document.elementFromPoint(x, y)
        return !!at && (at === card || card.contains(at))
      })(),
      price: (card.querySelector('.sub-plan-figure') || {}).textContent || null,
      inclusions: [...card.querySelectorAll('.sub-inc-name')].map(node => node.textContent.trim()),
      why: [...card.querySelectorAll('.sub-inc-why')].map(node => node.textContent.trim()),
      alternatives: [...card.querySelectorAll('.sub-plan-alt-line')].map(node => node.textContent.trim()),
    })),
    freeList: [...doc.querySelectorAll('.sub-free-list li')].map(node => node.textContent.trim()),
    status: (() => {
      const box = doc.querySelector('#sub-status')
      if (!box || box.hidden) return null
      return { className: box.className, text: box.innerText.trim(), link: (box.querySelector('a') || {}).href || null }
    })(),
    refusal: (() => {
      const box = doc.querySelector('.sub-refusal')
      return box ? box.innerText.trim() : null
    })(),
    submitDisabled: (() => { const b = doc.querySelector('.sub-submit'); return b ? b.disabled : null })(),
    submitPresent: !!doc.querySelector('.sub-submit'),
    form: {
      email: (doc.querySelector('#sub-email') || {}).value ?? null,
      plan: (doc.querySelector('input[name="plan"]:checked') || {}).value ?? null,
      seatsVisible: (() => { const f = doc.querySelector('#sub-seats-field'); return f ? getComputedStyle(f).display !== 'none' : null })(),
      errors: [...doc.querySelectorAll('.sub-field-error')].filter(node => !node.hidden).map(node => node.textContent.trim()),
    },
  }
})()`

/* Every offered way to the subscription page on whatever screen is live, with
   the same hit-test MEASURE applies to a control: at the centre of its own box,
   is the element that is actually there this element? Both spellings of the
   route are collected because src/main.js routes `#/pricing` to the same
   surface, so a screen that used that spelling would otherwise read as a screen
   with no door at all. */
const DOORS = `(() => {
  const doc = ${LIVE}
  return [...doc.querySelectorAll('a[href="#/subscribe"], a[href="#/pricing"]')].map(node => {
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const inView = rect.width >= 1 && rect.height >= 1 && x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight
    const at = inView ? document.elementFromPoint(x, y) : null
    return {
      href: node.getAttribute('href'),
      label: (node.textContent || '').trim().slice(0, 60),
      hit: inView && !!at && (at === node || node.contains(at) || at.contains(node)),
    }
  })
})()`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* A SCREENSHOT THAT DID NOT HAPPEN IS A RECORD MISSING; A SCREENSHOT THAT
   HAPPENED AND LIES IS A DEFECT. The two are treated differently on purpose.

   Measured: capturePage() immediately after setContentSize threw UnknownVizError
   once and took the whole drive down at check 24 of 67, which turned a
   page-quality harness into a flaky one for a reason unrelated to the page. So a
   capture that will not happen is still a reported MISS, never an exception and
   never a failure of the page.

   But a frame that arrives BLANK, or that is a picture of an earlier instant, is
   not a hiccup -- it is the failure mode that made this driver unrunnable
   unattended in the first place, and it is a failed assertion. Every capture
   carries a per-shot freshness probe and is compared against a point the page
   itself nominated; the untrustworthy ones are written under an UNTRUSTED name
   so nobody browsing artifacts/ mistakes one for evidence. */
const shootMisses = []
const shootVerdicts = []
let shootNonce = 1
async function shoot(view, name) {
  /* Back to the top first: the hit-test pass scrolls every control into view,
     so a screenshot taken after it records the page mid-scroll with its
     masthead off screen -- a visual record that shows neither what a visitor
     sees on arrival nor anything the checks measured. */
  await view.webContents.executeJavaScript(
    `(() => { const pad = document.querySelector('.view-pad'); if (pad) pad.scrollTop = 0; window.scrollTo(0, 0) })()`)
  await sleep(140)
  let point = { x: null, y: null, rgb: null }
  try { point = await view.webContents.executeJavaScript(domAgreementScript()) } catch { /* asserted below */ }
  shootNonce += 10
  let shot = null
  try {
    shot = await captureTruthfully(view.webContents, { nonce: shootNonce, attempts: 3, settleMs: 140 })
  } catch (error) {
    shootMisses.push(`${name}: ${error?.message || error}`)
    return
  }
  if (!shot.image) {
    shootMisses.push(`${name}: ${shot.verdict?.why || 'no frame'}`)
    return
  }
  writeFileSync(path.join(OUT, shot.verdict.truthful ? name : name.replace(/\.png$/, '.UNTRUSTED.png')),
    shot.image.toPNG())
  const frame = withViewport(shot.frame, point)
  const captured = point.x === null ? null : pixelAt(frame, point.x, point.y)
  const agrees = Boolean(captured && point.rgb
    && captured.every((value, index) => Math.abs(value - point.rgb[index]) <= 8))
  shootVerdicts.push({ name, verdict: shot.verdict.verdict, why: shot.verdict.why, agrees, point, captured })
  check(`the screenshot ${name} is a true picture of the page it names`,
    shot.verdict.truthful === true && agrees,
    shot.verdict.truthful
      ? `frame is fresh, but the DOM says ${JSON.stringify(point.rgb)} at (${point.x},${point.y}) `
        + `and the capture shows ${JSON.stringify(captured)}`
      : shot.verdict.why)
}

async function settle(view, predicate, { tries = 60, wait = 100 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const state = await view.webContents.executeJavaScript(MEASURE)
    if (predicate(state)) return state
    await sleep(wait)
  }
  return view.webContents.executeJavaScript(MEASURE)
}

/* Named keys get keyDown/keyUp only. Sending a `char` event for Tab inserts a
   literal tab into whatever has focus instead of moving focus, which silently
   turns a keyboard-navigation proof into a typing test. */
async function key(view, keyCode, { shift = false } = {}) {
  const modifiers = shift ? ['shift'] : []
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(28)
}

async function typeText(view, text) {
  for (const character of text) {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: character })
    view.webContents.sendInputEvent({ type: 'char', keyCode: character })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: character })
    await sleep(12)
  }
}

async function activeElement(view) {
  return view.webContents.executeJavaScript(`(() => {
    const a = document.activeElement
    if (!a) return null
    return { tag: a.tagName.toLowerCase(), id: a.id || null, name: a.name || null, value: a.value ?? null,
             label: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 48), type: a.type || null }
  })()`)
}

// ---------------------------------------------------------------------------

async function run() {
  mkdirSync(OUT, { recursive: true })
  const started = Date.now()
  console.log(`renderer subject: ${JSON.stringify(RENDERER.provenance)}`)
  console.log('scope: selected renderer and subscription service in host Electron with a test provider; no installed billing proof')

  const double = createProviderDouble()
  const providerOrigin = await double.listen(0)
  const provider = createCheckoutProvider({
    mode: 'test', secretKey: 'sk_test_drivenbyharness0001', apiBase: providerOrigin,
  })
  const storeFile = path.join(OUT, 'drive-signups.json')
  if (existsSync(storeFile)) writeFileSync(storeFile, JSON.stringify({ schemaVersion: 1, accounts: {}, attempts: {}, signups: {} }, null, 2))
  const store = new SignupStore(storeFile)
  /* A REAL price map on disk, not an object handed to the constructor. The
     endpoint reads this file itself on every request, which is the thing an
     installed copy does and the thing that was never exercised: a deployment
     with no price map must refuse in JSON rather than answer with a web page. */
  const pricesFile = path.join(OUT, 'drive-prices.json')
  writeFileSync(pricesFile, `${JSON.stringify({
    mode: 'test',
    prices: {
      'operator:monthly': 'price_test_operator_monthly',
      'operator:annual': 'price_test_operator_annual',
      'team:monthly': 'price_test_team_monthly',
    },
  }, null, 2)}\n`, 'utf8')
  let siteOrigin = 'http://127.0.0.1:0'
  const endpoint = createSubscribeEndpoint({
    storeFile,
    pricesFile,
    provider,
    siteOrigin: () => siteOrigin,
  })
  let catalogGone = false
  const site = await startSite({ endpoint, catalogGone: () => catalogGone })
  siteOrigin = site.origin
  console.log(`site ${site.origin} · provider double ${providerOrigin}`)

  /* ---- H. THERE IS A SERVICE AT ALL --------------------------------------
   *
   * The measured defect, asserted before anything else because every other
   * check on this page presupposes it. serveDist() handled two special routes
   * and then answered EVERYTHING ELSE with index.html and a 200: the signup
   * POST received a web page, response.json() threw, and the flow classified an
   * unparseable reply as `offline`. So the page told a customer with a working
   * connection that their device was offline, on the screen that takes money.
   *
   * The request body is deliberately malformed. A well-formed one would prove
   * the same point only when a provider is configured; a broken one has exactly
   * one correct answer -- a JSON refusal -- on every machine, configured or
   * not, which is what makes this check hold in the shipped product too. */
  {
    const reply = await fetch(`${site.origin}/v1/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    const type = reply.headers.get('content-type') || ''
    const body = await reply.text()
    check('H POST /v1/signup is answered by a service, not by the app shell',
      type.includes('application/json') && !/<!doctype html|<html/i.test(body), `${reply.status} · ${type}`)
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* the check below reports it */ }
    check('H an unreadable request is refused in a state the page knows',
      parsed?.ok === false && parsed?.state === 'refused', body.slice(0, 100))
    /* An installed copy keeps its ledger and its price map under the person's
       own user directory, and the service's refusals name the file they could
       not read. That sentence is right for an operator and wrong for a stranger:
       the path carries their account name. */
    check('H a refusal from the endpoint names no file on this computer',
      !/[A-Za-z]:[\\/]/.test(body), body.slice(0, 100))
  }

  /* SHOWN for an operator; OFFSCREEN for a cut. Not `show: false` -- a hidden
     window is what produced the lying screenshots recorded in
     preview-browser-drive's header. An offscreen window has its own frame sink
     and paints on demand, and every capture below proves it did. */
  const view = new BrowserWindow({
    width: 1440, height: 960, show: !HEADLESS, frame: !HEADLESS,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, preload: undefined,
      ...(HEADLESS ? { offscreen: true, backgroundThrottling: false } : {}),
    },
  })
  if (HEADLESS) view.webContents.setFrameRate(30)
  /* A page error on a payment surface is a silent dead end for the visitor, so
     the harness records them rather than letting them vanish into a console
     nobody reads. Any error-level message fails the run at the end. */
  const pageErrors = []
  view.webContents.on('console-message', (_event, level, message, line, source) => {
    if (level >= 2) pageErrors.push(`${message} (${source}:${line})`)
  })
  view.webContents.on('render-process-gone', (_event, details) => pageErrors.push(`renderer gone: ${details.reason}`))

  /* Attached LAZILY, and only for the offline scenario. Attaching the DevTools
     protocol to a BrowserWindow that has never loaded a document leaves
     Network.enable waiting on a renderer that does not exist yet -- measured
     here as a hang with no output at all, which is exactly the failure mode a
     harness must not have. */
  let debuggerAttached = false
  const withNetwork = async (params) => {
    if (!debuggerAttached) {
      view.webContents.debugger.attach('1.3')
      await view.webContents.debugger.sendCommand('Network.enable')
      debuggerAttached = true
    }
    await view.webContents.debugger.sendCommand('Network.emulateNetworkConditions', params)
  }
  const catalog = JSON.parse(readFileSync(path.join(DIST, 'data', 'subscription-catalog.json'), 'utf8'))

  /* A NONCE IN THE PATH, BECAUSE loadURL TO THE SAME URL IS NOT A RELOAD.
     Measured here: navigating to `origin/#/subscribe` while already on it is a
     same-document navigation, so the previous document's JavaScript state
     survives. Three scenarios silently ran against a page that was still in the
     `checkout` state from the scenario before -- their submits returned early
     and the harness read the leftover status as the new result. Every `go` now
     lands on a genuinely new document. */
  let visit = 0
  const go = async (hash) => {
    visit += 1
    await view.loadURL(`${site.origin}/?visit=${visit}${hash}`)
    await sleep(400)
  }

  /* ---- I. A PERSON CAN GET HERE WITHOUT TYPING THE ADDRESS ---------------
   *
   * The second measured defect, and the one every check below quietly assumed
   * away. `#/subscribe` was routed and linked from NOWHERE: the router knew the
   * address, the page rendered perfectly, and no screen in the product offered
   * a way to it. A subscription page a customer can only reach by typing a URL
   * into an application that has no address bar is a page with no customers.
   *
   * Pressed rather than counted. An anchor with the right href proves markup;
   * what has to be true is that a person can SEE it, put a pointer on it, and
   * arrive at the plans. So each door is hit-tested at the centre of its own
   * box -- an overlay or a transform makes a link that greps fine and cannot be
   * clicked -- and the home one is then actually clicked and the destination
   * read back from the page that results. */
  for (const [where, hash] of [['home', '#/'], ['the account screen', '#/account']]) {
    await go(hash)
    let doors = []
    for (let i = 0; i < 30 && doors.length === 0; i += 1) {
      doors = await view.webContents.executeJavaScript(DOORS)
      if (doors.length === 0) await sleep(100)
    }
    check(`I ${where} offers a way to the subscription page`, doors.length > 0,
      `${doors.length} link(s): ${doors.map(door => door.label).join(' | ') || 'none'}`)
    check(`I the way in from ${where} is a real click target`,
      doors.length > 0 && doors.every(door => door.hit),
      doors.filter(door => !door.hit).map(door => door.label).join(' | '))
    check(`I the way in from ${where} says where it goes`,
      doors.every(door => door.label.length >= 8), doors.map(door => JSON.stringify(door.label)).join(' | '))
  }
  {
    await go('#/')
    for (let i = 0; i < 30; i += 1) {
      const found = await view.webContents.executeJavaScript(DOORS)
      if (found.length > 0) break
      await sleep(100)
    }
    await view.webContents.executeJavaScript(`(${LIVE}).querySelector('a[href="#/subscribe"]').click()`)
    const landed = await settle(view, s => s.planCards.length > 0, { tries: 40 })
    check('I pressing it from home lands on the plans, not back on home',
      landed.route.startsWith('#/subscribe') && landed.planCards.length > 0,
      `${landed.route} with ${landed.planCards.length} plan cards`)
  }

  // ---- A. widths and themes -------------------------------------------------
  for (const theme of THEMES) {
    await go(`#/subscribe`)
    await view.webContents.executeJavaScript(`try { localStorage.setItem('mc.theme', ${JSON.stringify(theme)}) } catch (e) {}`)
    await go(`#/subscribe`)
    for (const width of WIDTHS) {
      view.setContentSize(width, 960)
      await sleep(240)
      const state = await settle(view, s => s.planCards.length > 0)
      check(`A width ${width} theme ${theme}: no horizontal overflow`, state.overflow <= 0, `scrollWidth-clientWidth=${state.overflow}`)
      check(`A width ${width} theme ${theme}: plan cards rendered`, state.planCards.length >= 2, `${state.planCards.length} cards`)
      if (width === 1440 || width === 1024) {
        await shoot(view, `subscribe-${theme}-${width}.png`)
      }
    }
  }
  view.setContentSize(1440, 960)
  await sleep(200)

  // ---- B. hit-testing -------------------------------------------------------
  await go('#/subscribe')
  let state = await settle(view, s => s.planCards.length > 0)
  const missed = state.controls.filter(control => !control.hit)
  check('B every visible control hit-tests to itself', missed.length === 0, missed.map(c => `${c.tag}:${c.label}`).join(' | '))
  /* Named rather than counted. A bare threshold is a number somebody tunes down
     the first time it fails; naming the controls means the check can only be
     satisfied by the page actually offering them. Scoped to the live view, so
     the app's own topbar chrome is not what makes it pass. */
  const wanted = ['input#sub-email', 'button:Continue to payment', 'button:Monthly', 'button:Annual', 'a:Back to the first page']
  const present = wanted.filter(want => {
    const [tag, label] = want.split(':')
    return state.controls.some(control => `${control.tag}${control.tag === 'input' ? '#sub-email' : ''}` === tag
      && (!label || control.label.includes(label)) && control.hit)
  })
  check('B the page offers, and hit-tests, every control the signup needs',
    present.length === wanted.length, `${present.length}/${wanted.length}: missing ${wanted.filter(w => !present.includes(w)).join(', ')}`)
  check('B every plan card is a real click target', state.planCards.every(card => card.hit),
    state.planCards.filter(card => !card.hit).map(card => card.plan).join(', '))

  // ---- C. no claim on screen that the catalog does not back -----------------
  const known = new Set(Object.values(catalog.capabilities).map(capability => capability.label))
  const knownWhy = new Set(Object.values(catalog.capabilities).map(capability => capability.rationale))
  const claimed = state.planCards.flatMap(card => card.inclusions)
  const claimedWhy = state.planCards.flatMap(card => card.why)
  check('C at least one inclusion is actually rendered', claimed.length > 0, `${claimed.length} inclusion lines`)
  check('C every inclusion NAME on screen is one the catalog declares',
    claimed.every(line => known.has(line)), claimed.filter(line => !known.has(line)).join(' | '))
  check('C every inclusion REASON on screen is one the catalog declares',
    claimedWhy.every(line => knownWhy.has(line)), claimedWhy.filter(line => !knownWhy.has(line)).join(' | '))
  check('C the free-forever list on screen equals the model\'s NEVER_GATED list',
    JSON.stringify(state.freeList) === JSON.stringify(catalog.neverGated),
    `${state.freeList.length} on screen vs ${catalog.neverGated.length} in the model`)
  check('C every plan card names a free alternative to what it sells',
    state.planCards.every(card => card.inclusions.length === 0 || card.alternatives.length > 0))
  check('C no plan is pre-selected on arrival', state.planCards.every(card => !card.chosen))
  const forbidden = ['limited time', 'only today', 'hurry', 'most popular', 'was $', 'act now', 'spots left']
  const pageText = await view.webContents.executeJavaScript(`(${LIVE}).innerText.toLowerCase()`)
  const found = forbidden.filter(phrase => pageText.includes(phrase))
  check('C no urgency or scarcity language on the page', found.length === 0, found.join(', '))

  // ---- C2. the annual toggle, and the only arithmetic claim on the page ----
  {
    await go('#/subscribe')
    await settle(view, s => s.planCards.length > 0)
    await view.webContents.executeJavaScript(`(() => {
      const live = ${LIVE}
      live.querySelector('.sub-seg-btn[data-period="annual"]').click()
    })()`)
    await sleep(260)
    const annual = await view.webContents.executeJavaScript(MEASURE)
    for (const plan of catalog.plans.filter(candidate => candidate.requiresLicense)) {
      const card = annual.planCards.find(candidate => candidate.plan === plan.id)
      if (!card) continue
      if (Number.isFinite(plan.annualUsd) && plan.annualUsd > 0) {
        const expected = plan.monthlyUsd * 12 - plan.annualUsd
        const shows = expected > 0
        check(`C2 ${plan.label} annual price is the model's annual price`, card.price?.includes(String(plan.annualUsd)),
          `card shows ${card.price}, model says ${plan.annualUsd}`)
        check(`C2 ${plan.label} states the saving only when there is one, and states it correctly`,
          shows ? (card.saving || '').includes(String(expected)) : card.saving === null,
          `saving line: ${JSON.stringify(card.saving)}, arithmetic says ${expected}`)
      } else {
        /* A plan the model does not price annually must say so and must not be
           selectable on that period -- the alternative is a visitor choosing a
           plan whose price nobody set and being refused after they commit. */
        check(`C2 ${plan.label} is shown as not offered annually`, card.noPrice === true && card.saving === null,
          `noPrice=${card.noPrice} saving=${JSON.stringify(card.saving)}`)
        check(`C2 ${plan.label} cannot be selected on a period it has no price for`, card.radioDisabled === true,
          `radio disabled=${card.radioDisabled}`)
      }
    }
    await shoot(view, 'subscribe-annual.png')
  }

  // ---- D. keyboard-only signup ---------------------------------------------
  await go('#/subscribe')
  await settle(view, s => s.planCards.length > 0)
  /* THE WINDOW HAS TO ACTUALLY HOLD FOCUS OR THE TAB PRESSES GO NOWHERE, and a
     Tab that goes nowhere leaves document.activeElement on <body> -- which is
     indistinguishable from a page with no keyboard-reachable controls. Measured
     on one run out of several: fourteen Tab presses, fourteen readings of
     "body", and a page that is in fact perfectly navigable. So focus is
     asserted rather than assumed, and re-asserted before the traversal is
     called a failure. */
  /* OFFSCREEN, document.hasFocus() STAYS FALSE AND THE TAB PRESSES STILL LAND.
     Measured 2026-08-23 on Electron 43.3.0: with the window offscreen and
     webContents.focus() called, document.hasFocus() read false, and Tab still
     moved document.activeElement BODY -> input -> input -> button, typed
     characters landed in the focused field, and Space activated the button. So
     hasFocus() is not the fact this check needs; it was a proxy for it, and
     unattended it is a proxy that reads false while the thing it stands for is
     true. `view.show()` is also the one line in this harness that would steal
     the owner's focus, which is what held the whole driver out of the cut.

     The fact itself is asserted instead, from the traversal's OWN first Tab:
     activeElement must LEAVE the body. It is not asserted with a separate probe
     press, because Chromium remembers the sequential-focus starting point --
     measured: press Tab (lands on the first control), blur, press Tab again,
     and focus goes to the SECOND control, so a probe press would silently skip
     whatever it landed on and the traversal below would report it unreachable. */
  const takeFocus = async () => {
    if (!HEADLESS) { view.show(); view.moveTop(); view.focus() }
    view.webContents.focus()
    await sleep(220)
    return view.webContents.executeJavaScript('document.hasFocus()')
  }
  let hasFocus = await takeFocus()
  if (!hasFocus && !HEADLESS) hasFocus = await takeFocus()
  await sleep(120)

  const seen = []
  let leftTheBody = null
  let reachedRadio = null
  let reachedEmail = null
  let reachedSubmit = null
  for (let i = 0; i < 40; i += 1) {
    await key(view, 'Tab')
    const active = await activeElement(view)
    if (leftTheBody === null) {
      leftTheBody = Boolean(active && active.tag && active.tag.toLowerCase() !== 'body')
      check('D Tab presses actually move the focus, so the traversal below can be believed',
        leftTheBody === true,
        `first Tab landed on ${active ? active.tag : 'nothing'} · document.hasFocus()=${hasFocus}`
        + `${HEADLESS ? ' (offscreen: hasFocus is false by design and is not the claim)' : ''}`)
    }
    if (!active) continue
    seen.push(`${active.tag}${active.id ? `#${active.id}` : ''}${active.name ? `[${active.name}]` : ''}`)
    if (!reachedRadio && active.type === 'radio' && active.name === 'plan') {
      reachedRadio = active
      await key(view, ' ')                  // Space selects a radio
    }
    if (!reachedEmail && active.id === 'sub-email') {
      reachedEmail = active
      await typeText(view, 'keyboard.buyer@example.com')
    }
    if (reachedEmail && !reachedSubmit && active.tag === 'button' && /Continue to payment/i.test(active.label)) {
      reachedSubmit = active
      break
    }
  }
  check('D Tab reaches a plan radio without a mouse', !!reachedRadio, seen.slice(0, 14).join(' > '))
  check('D Tab reaches the email field without a mouse', !!reachedEmail)
  check('D Tab reaches the submit button without a mouse', !!reachedSubmit)

  if (reachedSubmit) {
    const before = await view.webContents.executeJavaScript(MEASURE)
    console.log(`     [D] before Enter: plan=${before.form.plan} email=${JSON.stringify(before.form.email)} `
      + `seatsVisible=${before.form.seatsVisible} errors=${JSON.stringify(before.form.errors)} submitDisabled=${before.submitDisabled}`)
    check('D the keyboard-selected plan actually registered', before.form.plan !== null, `plan=${before.form.plan}`)
    check('D the typed address actually landed in the field', (before.form.email || '').includes('@'), `email=${JSON.stringify(before.form.email)}`)
    /* The invariant, not a fixed expectation: the Seats field is on screen if
       and only if the plan the visitor chose actually has a seat minimum. An
       earlier version of this check assumed the keyboard would land on the
       cheapest plan and asserted "hidden" outright -- so when Tab selected the
       seat-based plan instead, correct behaviour read as a failure. Asserting
       the relationship is the only version that cannot be fooled either way. */
    const chosen = catalog.plans.find(plan => plan.id === before.form.plan)
    const expectsSeats = !!(chosen && chosen.seatMinimum)
    check('D the seats field is shown exactly when the chosen plan is seat-based',
      before.form.seatsVisible === expectsSeats,
      `plan=${before.form.plan} seatMinimum=${chosen?.seatMinimum ?? 'none'} visible=${before.form.seatsVisible}`)
    /* Both are real keyboard activations of a submit button and either is a
       legitimate proof; which one landed is reported rather than hidden,
       because "Enter did nothing" on a payment form is itself worth knowing. */
    const settled = s => s.status && /is-checkout|is-refused|is-declined|is-offline/.test(s.status.className)
    await key(view, 'Return')
    state = await settle(view, settled, { tries: 20 })
    let activationKey = 'Return'
    if (!settled(state)) {
      await key(view, ' ')
      state = await settle(view, settled, { tries: 60 })
      activationKey = 'Space'
    }
    check('D keyboard-only submit reaches checkout', !!state.status && /is-checkout/.test(state.status.className),
      `${state.status ? state.status.className : 'no status shown'} (activated with ${activationKey})`)
    check('E the checkout link is a TEST-MODE session', !!state.status?.link && /cs_test_/.test(state.status.link), state.status?.link || 'none')
    check('E the page says nothing has been charged yet', !!state.status && /not been charged/i.test(state.status.text))
    check('E the page marks the run as test mode', !!state.status && /test mode/i.test(state.status.text))
    await shoot(view, 'subscribe-checkout-state.png')

    /* The hand-off is a real page, not a dead href. Fetched from NODE, not from
       the page: the provider is a different origin and a browser fetch would be
       blocked by CORS, which would read as a broken link rather than a
       cross-origin rule. A browser never fetches this URL -- it navigates to it. */
    if (state.status?.link) {
      const hosted = await fetch(state.status.link).then(async response => ({ status: response.status, body: await response.text() }))
      check('E the checkout link actually serves a checkout page',
        hosted.status === 200 && hosted.body.includes('hosted-checkout'), `${hosted.status}, ${hosted.body.length} bytes`)
    }
  }

  // ---- F. the states --------------------------------------------------------

  // already subscribed
  {
    const ledger = store.read()
    ledger.accounts['known.subscriber@example.com'] = { email: 'known.subscriber@example.com', status: 'active', paidUntilMs: 4102444800000 }
    store.write(ledger)
    await go('#/subscribe')
    await settle(view, s => s.planCards.length > 0)
    state = await view.webContents.executeJavaScript(`(async () => {
      const live = ${LIVE}
      live.querySelector('.sub-plan-radio').click()
      const email = live.querySelector('#sub-email')
      email.value = 'known.subscriber@example.com'
      email.dispatchEvent(new Event('change', { bubbles: true }))
      live.querySelector('.sub-form').requestSubmit()
      return true
    })()`)
    state = await settle(view, s => s.status && !/is-working/.test(s.status.className), { tries: 80 })
    check('F already subscribed is named, and is not sold a second subscription',
      !!state.status && /is-known/.test(state.status.className) && /already has a subscription/i.test(state.status.text),
      state.status ? state.status.text.slice(0, 90) : 'no status')
    check('F the submit control is off for a known subscriber', state.submitDisabled === true)
  }

  // declined
  {
    await go('#/subscribe')
    await settle(view, s => s.planCards.length > 0)
    await view.webContents.executeJavaScript(`(() => {
      const live = ${LIVE}
      live.querySelector('.sub-plan-radio').click()
      const email = live.querySelector('#sub-email')
      email.value = 'card_declined@example.com'
      email.dispatchEvent(new Event('change', { bubbles: true }))
      live.querySelector('.sub-form').requestSubmit()
    })()`)
    state = await settle(view, s => s.status && !/is-working/.test(s.status.className), { tries: 80 })
    check('F a declined card is reported as a decline, with nothing charged',
      !!state.status && /is-declined/.test(state.status.className) && /nothing was charged/i.test(state.status.text),
      state.status ? state.status.text.slice(0, 90) : 'no status')
    check('F a declined card can be retried', state.submitDisabled === false)
  }

  // double submit
  {
    await go('#/subscribe')
    await settle(view, s => s.planCards.length > 0)
    const before = Object.keys(store.read().signups).length
    await view.webContents.executeJavaScript(`(() => {
      const live = ${LIVE}
      live.querySelector('.sub-plan-radio').click()
      const email = live.querySelector('#sub-email')
      email.value = 'double.press@example.com'
      email.dispatchEvent(new Event('change', { bubbles: true }))
      const form = live.querySelector('.sub-form')
      form.requestSubmit(); form.requestSubmit(); form.requestSubmit()
    })()`)
    state = await settle(view, s => s.status && /is-checkout/.test(s.status.className), { tries: 80 })
    const after = Object.keys(store.read().signups).length
    check('F three presses produce exactly ONE signup', after - before === 1, `${after - before} signups created`)
  }

  // offline
  {
    await go('#/subscribe')
    await settle(view, s => s.planCards.length > 0)
    /* GENUINELY OFFLINE, NOT A PATCHED navigator.onLine.
       Two reasons. First, `executeJavaScript` runs in the ISOLATED world under
       contextIsolation, so a prototype patch there never reaches the page's own
       JavaScript at all -- the first version of this scenario "applied" the
       patch, verified it in the isolated world, and the page carried on online.
       Second, even a working patch only lies to one getter; the DevTools
       protocol takes the network away, which is what being offline actually is. */
    await withNetwork({ offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    const offlineApplied = await view.webContents.executeJavaScript('navigator.onLine')
    check('F the offline condition was actually applied before the attempt', offlineApplied === false, `navigator.onLine=${offlineApplied}`)
    await view.webContents.executeJavaScript(`(() => {
      const live = ${LIVE}
      live.querySelector('.sub-plan-radio').click()
      const email = live.querySelector('#sub-email')
      email.value = 'offline.person@example.com'
      email.dispatchEvent(new Event('change', { bubbles: true }))
      live.querySelector('.sub-form').requestSubmit()
    })()`)
    state = await settle(view, s => s.status && !/is-working/.test(s.status.className), { tries: 60 })
    check('F an offline device is told so, and nothing is sent',
      !!state.status && /is-offline/.test(state.status.className), state.status ? state.status.className : 'no status')
    check('F offline created no signup', !Object.values(store.read().signups).some(record => record.accountKey === 'offline.person@example.com'))
    await withNetwork({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }

  // back button: return to #/subscribe?signup=<id> and let the page ask the service
  {
    await go('#/subscribe')
    await settle(view, s => s.planCards.length > 0)
    await view.webContents.executeJavaScript(`(() => {
      const live = ${LIVE}
      live.querySelector('.sub-plan-radio').click()
      const email = live.querySelector('#sub-email')
      email.value = 'returning.person@example.com'
      email.dispatchEvent(new Event('change', { bubbles: true }))
      live.querySelector('.sub-form').requestSubmit()
    })()`)
    await settle(view, s => s.status && /is-checkout/.test(s.status.className), { tries: 80 })
    const record = Object.values(store.read().signups).find(entry => entry.accountKey === 'returning.person@example.com')
    check('F a signup exists to return to', !!record, record ? record.signupId : 'the checkout attempt produced no signup')
    if (!record) throw new Error('cannot drive the return path without a signup')
    await go(`#/subscribe?signup=${record.signupId}&result=complete`)
    state = await settle(view, s => s.status && /is-checkout|is-refused/.test(s.status.className), { tries: 80 })
    check('F returning with ?signup= re-reads the service rather than believing the URL',
      !!state.status && /is-checkout/.test(state.status.className) && /cs_test_/.test(state.status.link || ''),
      state.status ? state.status.className : 'no status')
    check('F returning with result=complete does NOT claim the person is subscribed',
      !!state.status && !/you are subscribed|subscription is active/i.test(state.status.text))

    // and a made-up signup id in the URL is refused, not honoured
    await go('#/subscribe?signup=sub_madeupbyavisitor&result=complete')
    state = await settle(view, s => s.status && !/is-working/.test(s.status.className), { tries: 60 })
    check('F a hand-typed signup id in the URL is refused',
      !!state.status && /is-refused/.test(state.status.className), state.status ? state.status.className : 'no status')
  }

  // catalog gone: fail closed
  {
    catalogGone = true
    await go('#/subscribe')
    state = await settle(view, s => s.refusal !== null || s.planCards.length > 0, { tries: 60 })
    check('F a missing catalog fails CLOSED: no plans are shown', state.planCards.length === 0, `${state.planCards.length} cards`)
    check('F a missing catalog removes the signup control entirely', state.submitPresent === false)
    check('F a missing catalog says why, and says nothing was charged',
      !!state.refusal && /404|could not|not be read/i.test(state.refusal) && /nothing was charged/i.test(state.refusal),
      (state.refusal || 'no refusal shown').slice(0, 120))
    await shoot(view, 'subscribe-catalog-failed-closed.png')
    catalogGone = false
  }

  // ---- summary --------------------------------------------------------------
  /* The localhost port sweep this bundle performs on every page is a KNOWN,
     separately-reported finding (R1260 t5a W3) and is not this page's doing;
     counting its CORS noise as a subscribe-page defect would make this harness
     permanently red for a reason it cannot fix. Everything else counts. */
  /* Two exclusions, both pre-existing findings this lane does not own and
     cannot fix inside its fence, both already on the board from R1260 t5a:
     W3 (every visitor's browser sweeps its own loopback ports) and W5 (the
     bundle ships no Content-Security-Policy). Naming them here rather than
     widening the filter, so the exclusion is auditable. */
  const ownErrors = pageErrors.filter(message =>
    !/127\.0\.0\.1:46\d\d|\/v1\/runtime|Access-Control-Allow-Origin|Electron Security Warning|Content.?Security.?Policy/i.test(message))
  check('G the page raised no errors of its own while being driven', ownErrors.length === 0, ownErrors.slice(0, 3).join(' | '))

  const duration = ((Date.now() - started) / 1000).toFixed(1)
  if (shootMisses.length) console.log(`note: ${shootMisses.length} screenshot(s) could not be captured: ${shootMisses.join(' | ')}`)
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({
    results, failures, screenshotMisses: shootMisses, renderer: RENDERER.provenance,
    /* Every capture's verdict, kept whether it passed or not: a reader of this
       report can see which pictures the run was willing to stand behind. */
    screenshotVerdicts: shootVerdicts,
    headless: HEADLESS, durationSeconds: Number(duration),
  }, null, 2))
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed in ${duration}s`)

  view.destroy()
  await new Promise(resolve => site.server.close(resolve))
  await double.close()

  if (results.length < 30) {
    console.error(`VACUOUS: only ${results.length} checks ran; a drive that measured almost nothing is not a pass.`)
    return 1
  }
  if (failures.length) {
    console.error(`\n${failures.length} FAILED:`)
    for (const failure of failures) console.error(`  - ${failure}`)
    return 1
  }
  return 0
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (error) {
    console.error(`drive error: ${error?.stack || error?.reason || error}`)
    code = 1
  }
  try { RENDERER.assertUnchanged() }
  catch (error) { console.error(`RENDERER INTEGRITY FAILED: ${error.message}`); code = 1 }
  app.exit(code)
})
