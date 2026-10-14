'use strict'

/* IS THE PURCHASE LIST ACTUALLY READABLE, ON REAL GLASS, WITH A REAL DEADLINE ON IT?
 *
 * WHY A TEST SUITE WAS NOT ENOUGH. tools/test/purchase-cart-view.test.mjs calls
 * the drawing code and reads the strings it returns. That proves the words are
 * correct and proves nothing about whether they are ON THE SCREEN. A rule in a
 * stylesheet can give an element no height, push it out of the viewport, or
 * paint it in the background colour, and every assertion over returned text
 * stays green while a person sees nothing. The deadline is the single fact the
 * owner's money depends on, so "the function returned the sentence" is not the
 * bar. The bar is a measured box, on a screen, with a cart in it.
 *
 * WHAT THIS FILE USED TO BE, AND THE TWO THINGS THAT MADE IT NOT A GATE.
 *
 * 1. IT MEASURED LIVE CART STATE AND NOTHING ELSE. Finding the owner's queue
 *    empty, it exited 2 with "re-run it when something is waiting" -- so whether
 *    the suite measured anything depended on whether he happened to be deciding
 *    a purchase that hour. On an ordinary day the one check standing between his
 *    money and an unreadable deadline measured NOTHING, and exit 2 is FAIL to
 *    the suite (tools/packaged-qa-suite.mjs verdictFor: any non-zero code).
 *
 * 2. IT NEEDED A BROWSER THAT IS NOT ON THIS MACHINE. It required Playwright out
 *    of the engine checkout's node_modules. Measured 2026-08-18: that checkout
 *    has no node_modules at all, so this driver could not run here in any state
 *    of the queue -- a permanent red that said nothing about the product. It now
 *    draws in the Electron this repository already depends on, which is the same
 *    renderer the product ships in and the same instrument
 *    tools/write-outcome-restate-qa.cjs uses for the same class of question.
 *
 * SO THERE ARE NOW TWO CARTS, WITH TWO DIFFERENT JOBS.
 *
 *   THE FIXTURE always runs. It is built here in the shape the engine's own
 *   producers emit, and it goes through the product's own
 *   normalizeOwnerPromptSnapshot before anything is drawn -- so this file cannot
 *   assert against a shape the product would reject. It carries a deadline, two
 *   lines whose descriptions have provenance stamps on the front, and a title
 *   and message with no record number in them: exactly the material every rule
 *   below is about. It is served on loopback and drawn in a scratch userData
 *   directory. No profile, no store and no product data on this machine is read
 *   or written for it.
 *
 *   THE OWNER'S REAL CART runs when there is one, and is SKIPPED WITH ITS REASON
 *   when there is not. An empty queue is a fact about his week, not a defect in
 *   this window.
 *
 * A run that measured NEITHER is the one state that still refuses, because a
 * gate that passes without measuring anything is worse than no gate.
 *
 * WHAT IT NEVER DOES. It presses nothing. It decides nothing. It approves,
 * denies, acknowledges and enqueues nothing, and it never reaches the audited
 * connection at all. There is no code path in this file that can spend, and the
 * renderer it loads has none either. The server binds 127.0.0.1 and the window
 * visits only that address.
 *
 * Run:  electron tools/purchase-cart-readable-qa.cjs
 * Exit: 0 measured and clean · 1 a real finding · 2 nothing could be measured.
 */

// Refuse --release before Electron can open any legacy source fixture.
require('./lib/qa-candidate-scope.cjs').refuseUnsupportedCandidate({
  repoRoot: require('node:path').resolve(__dirname, '..'), driver: 'purchase-cart-readable',
  reason: 'this cart fixture imports unbundled source modules that are absent from the candidate archive; a selected-renderer cart scenario is still required',
})

const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(REPO_ROOT, 'artifacts', 'purchase-cart-readable')

/* A record number of ours, of the shape the engine stamps onto a description.
   None of these may appear in anything a person reads. */
const OUR_RECORD_NUMBER = /\bR\d{3,4}(?:\.\d{1,3})?\b/
const STAMP = /From your words|AGENT-PROPOSED/

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purchase-cart-qa-'))
app.setPath('userData', USER_DATA)

function refuse(message) {
  process.stderr.write(`${message}\n`)
  app.exit(2)
}

/* ---------------------------------------------------------------- carts --- */

/* THE FIXTURE. Deliberately not a copy of anything on this machine. The deadline
   is computed from the clock so the "Expires" sentence has a real future date to
   render rather than a frozen one that would eventually read as expired. The
   descriptions carry the provenance stamps the engine puts on the front of a
   line, because taking those apart is this window's job and the rule below is
   that no piece of one survives onto a line a person reads. */
/* THE THEME THE SNAPSHOT BOUNDARY REQUIRES. normalizeOwnerPromptSnapshot is a
   strict boundary -- exact keys, no extras, every metric in range -- which is
   exactly why the fixture goes through it: a harness that hand-rolled a prompt
   and skipped the boundary could assert against a shape the product would
   refuse to draw. The token names are placeholders on purpose; what is under
   test here is the LAYOUT of the deadline, and applyOwnerPopupTheme maps these
   onto custom properties whatever they are called. */
const FIXTURE_THEME = {
  schemaVersion: 1,
  defaultTheme: 'black',
  fonts: { ui: 'Fixture UI', mono: 'Fixture Mono', nativeUiFamilies: ['Fixture UI'], nativeMonoFamilies: ['Fixture Mono'] },
  metrics: { radiusSmall: 2, radiusMedium: 3, radiusLarge: 3, space1: 4, space2: 8, space3: 12, space4: 16, space5: 24 },
  common: { accent: 'color-accent', accentFloor: 'color-accent-floor', focus: 'color-focus', onAccent: 'color-on-accent' },
  roles: { coordinator: 'color-coordinator', helper: 'color-helper', shadow: 'color-shadow', manager: 'color-manager' },
  themes: {
    white: fixturePalette('white'),
    tan: fixturePalette('tan'),
    black: fixturePalette('black'),
  },
}
function fixturePalette(suffix) {
  return {
    bg: `color-bg-${suffix}`, bg2: `color-bg2-${suffix}`, surface: `color-surface-${suffix}`,
    sheet: `color-sheet-${suffix}`, ink: `color-ink-${suffix}`, ink2: `color-ink2-${suffix}`,
    ink25: `color-ink25-${suffix}`, ink3: `color-ink3-${suffix}`, line: `color-line-${suffix}`,
    line2: `color-line2-${suffix}`, good: `color-good-${suffix}`, serious: `color-serious-${suffix}`,
  }
}

const FIXTURE_PROMPTS = [
  {
    id: 'fixture-cart-1',
    kind: 'purchase_batch',
    title: 'Two things the product needs',
    message: 'Approve or deny each line.',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    state: 'pending',
    defaultDecision: 'deny',
    currency: 'USD',
    totalCents: 3_607,
    items: [
      {
        id: 'fixture-line-domain',
        description: '[From your words: R1234] example-product.com - first-year registration',
        amountCents: 1_108,
        currency: 'USD',
        merchant: 'A domain registrar',
        purpose: 'The address the product is reached at.',
      },
      {
        id: 'fixture-line-cert',
        /* THE REAL AGENT STAMP, character for character. The first draft of this
           fixture wrote a bare "AGENT-PROPOSED ..." prefix, and the run reported
           "a raw stamp is on a LINE" -- a finding about a string the engine has
           never emitted, which would have been this harness's own mistake filed
           as a product defect. src/purchase-cart-view.js:61 holds the only
           accepted form and it is quoted here. */
        description: '[AGENT-PROPOSED - not traceable to your words] code signing certificate - one year',
        amountCents: 2_499,
        currency: 'USD',
        merchant: 'A certificate authority',
        purpose: 'So the installer does not warn every customer that it is unknown.',
      },
    ],
  },
]

/* The owner's own queue, read through the ENGINE's own reader in exactly the
   shape GET /v1/owner-prompts serves. Its absence is reported, never guessed
   at: a checkout that is not on this machine and a queue that is empty are two
   different sentences and a reader that merged them would hide one of them. */
function ownerQueue() {
  const setting = path.join(REPO_ROOT, 'private', 'capability-source.owner.json')
  if (!fs.existsSync(setting)) {
    return { prompts: null, snapshot: null, why: 'private/capability-source.owner.json does not exist, so no engine checkout is named on this machine' }
  }
  let root = null
  try {
    const configured = JSON.parse(fs.readFileSync(setting, 'utf8'))?.path
    root = typeof configured === 'string' && fs.existsSync(configured) ? configured : null
  } catch (error) {
    return {
      prompts: null,
      snapshot: null,
      why: null,
      error: `private/capability-source.owner.json could not be read: ${error.message}`,
    }
  }
  if (root === null) {
    return { prompts: null, snapshot: null, why: 'private/capability-source.owner.json does not name an engine checkout that exists on this machine' }
  }
  try {
    const snapshot = createRequire(__filename)(path.join(root, 'src', 'lib', 'mission-bridge', 'owner-prompts.js')).snapshot()
    if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.prompts)) {
      return { prompts: null, snapshot: null, why: 'the engine did not return a queue in the shape the screens read' }
    }
    if (snapshot.prompts.length === 0) {
      return { prompts: null, snapshot: null, why: "the owner's queue is empty right now, so there was no real cart to look at beside the fixture" }
    }
    return { prompts: snapshot.prompts, snapshot, why: null }
  } catch (error) {
    return {
      prompts: null,
      snapshot: null,
      why: null,
      error: `the engine's queue reader could not be loaded from ${root}: ${error.message}`,
    }
  }
}

const live = ownerQueue()

/* ----------------------------------------------------------------- page --- */

const PAGE = `<!doctype html>
<html data-theme="black"><head><meta charset="utf-8">
<link rel="stylesheet" href="/src/styles.css">
<link rel="stylesheet" href="/src/ledger.css">
<link rel="stylesheet" href="/src/owner-popup.css">
<link rel="stylesheet" href="/src/settings.css">
<style>body{margin:0;padding:24px;background:var(--bg,#111)}</style>
</head><body>
<main class="view-pad"><div class="ledger-shell ledger-prompt-queue">
  <section class="ledger-register approvals-list owner-popup-root" id="queue"></section>
  <div class="settings-shell"><section class="settings-section" id="accountRow"></section></div>
</div></main>
<script>window.__pageErrors = []
window.addEventListener('error', event => window.__pageErrors.push(String(event.message)))
window.addEventListener('unhandledrejection', event => window.__pageErrors.push(String(event.reason && event.reason.message || event.reason)))</script>
<script type="module">
import { renderOwnerPrompt, normalizeOwnerPromptSnapshot, applyOwnerPopupTheme } from '/src/owner-popup.js'
import { cartSummary } from '/src/purchase-cart-view.js'
import { cartMarkup } from '/src/account-markup.js'
try {
  const raw = await (await fetch('/queue.json' + location.search)).json()
  const snapshot = normalizeOwnerPromptSnapshot(raw)
  const list = document.getElementById('queue')
  applyOwnerPopupTheme(list, snapshot.theme, 'black')
  for (const prompt of snapshot.prompts) {
    const wrap = document.createElement('div')
    wrap.className = 'approvals-card'
    wrap.dataset.promptKind = prompt.kind
    wrap.append(renderOwnerPrompt(document, prompt, { dismiss() {}, submit() {} }, { surface: 'screen' }).dialog)
    list.append(wrap)
  }
  document.getElementById('accountRow').innerHTML = cartMarkup({ cart: cartSummary(snapshot.prompts, Date.now()) })
} catch (error) {
  window.__pageErrors.push(String(error && error.message || error))
}
document.body.dataset.ready = 'true'
</script></body></html>`

const TYPES = new Map([['.js', 'text/javascript'], ['.mjs', 'text/javascript'], ['.css', 'text/css'], ['.json', 'application/json']])

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(PAGE)
    return
  }
  if (url.pathname === '/queue.json') {
    /* WHICH cart is drawn is decided per request, so both readings go through
       the identical page, the identical modules and the identical stylesheets.
       A second page would be a second renderer. */
    const wantsLive = url.searchParams.get('which') === 'live'
    /* The LIVE reading is served as the engine handed it over, whole -- the
       theme it chose included. The FIXTURE borrows the live snapshot's envelope
       when there is one and falls back to its own, so the strict boundary sees
       the same shape either way. */
    const body = wantsLive && live.snapshot
      ? live.snapshot
      : {
        ok: true,
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        theme: live.snapshot ? live.snapshot.theme : FIXTURE_THEME,
        prompts: FIXTURE_PROMPTS,
      }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
    return
  }
  /* Served straight out of the working tree, so what is measured is the source
     on disk rather than a copy taken at some earlier moment. Confined to the
     repository root: a request that resolves outside it is refused. */
  const wanted = path.resolve(REPO_ROOT, `.${url.pathname}`)
  if (!wanted.startsWith(REPO_ROOT) || !fs.existsSync(wanted)) {
    response.writeHead(404).end('not here')
    return
  }
  response.writeHead(200, { 'content-type': TYPES.get(path.extname(wanted)) || 'application/octet-stream' })
  response.end(fs.readFileSync(wanted))
})

/* ------------------------------------------------------------ measuring --- */

/* Read in the page, in one pass, so every number below comes from one layout. */
const READ = `(() => {
  const cards = [...document.querySelectorAll('.approvals-card')].map(node => {
    const deadline = node.querySelector('.owner-popup-deadline')
    if (!deadline) return { drawn: false }
    const box = deadline.getBoundingClientRect()
    const style = getComputedStyle(deadline)
    const when = deadline.querySelector('.owner-popup-deadline-when')
    const consequence = deadline.querySelector('.owner-popup-deadline-consequence')
    return {
      drawn: true,
      title: node.querySelector('h2') ? node.querySelector('h2').textContent : '',
      when: when ? when.textContent : '',
      consequence: consequence ? consequence.textContent : '',
      width: Math.round(box.width),
      height: Math.round(box.height),
      left: Math.round(box.left),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      colour: getComputedStyle(when || deadline).color,
      background: style.backgroundColor,
      /* SPLIT BY WHICH FIELD IT CAME FROM, not by where it lands on the card --
         a distinction this measurement got wrong the first time, and the owner's
         own cart is what caught it. Both classes sit inside a line item.
         \`description\` arrives with a provenance stamp on the front and this
         window is what takes that stamp apart, so the item NAME and the badge
         beside it are this repository's to keep clean. \`merchant\` and
         \`purpose\` are whole sentences the engine's producers wrote and this
         window prints unedited. */
      drawnText: [
        ...node.querySelectorAll('.owner-popup-item-name'),
        ...node.querySelectorAll('.owner-popup-item-origin'),
      ].map(part => part.textContent || '').join(' '),
      writtenText: [
        node.querySelector('h2'),
        node.querySelector('.owner-popup-heading-message'),
        ...node.querySelectorAll('.owner-popup-item-meta:not(.owner-popup-item-origin)'),
      ].map(part => (part ? part.textContent : '') || '').join(' '),
    }
  })
  const rowNode = document.querySelector('[data-account-cart]')
  const rowBox = rowNode ? rowNode.getBoundingClientRect() : null
  return {
    cards,
    viewportWidth: window.innerWidth,
    row: rowNode ? {
      drawn: true,
      state: rowNode.dataset.cartState,
      text: rowNode.textContent || '',
      link: rowNode.querySelector('a') ? rowNode.querySelector('a').getAttribute('href') : '',
      width: Math.round(rowBox.width),
      height: Math.round(rowBox.height),
    } : { drawn: false },
    pageErrors: window.__pageErrors || [],
  }
})()`

/* Kept apart on purpose. `drawn` is this repository's to fix; `written` is the
   engine's, and both are printed. See the header. */
const findings = []
const routed = []
const pageErrors = []
let measured = 0

async function measureCart(win, label, prompts, which) {
  await win.loadURL(`${ORIGIN}/?which=${which}`)
  await win.webContents.executeJavaScript(
    'new Promise(r => { const t = setInterval(() => { if (document.body.dataset.ready === "true") { clearInterval(t); r(true) } }, 25) })')
  const seenAll = await win.webContents.executeJavaScript(READ)
  pageErrors.push(...seenAll.pageErrors.map(message => `${label}: the page itself threw while drawing: ${message}`))

  /* EVERY CARD, MEASURED. Not a sample: the lists and the questions are all on
     the same clock, and the ones that run out first are questions. */
  if (seenAll.cards.length !== prompts.length) {
    findings.push(`${label}: only ${seenAll.cards.length} of ${prompts.length} waiting requests were drawn at all`)
  }
  for (const seen of seenAll.cards) {
    measured += 1
    if (!seen.drawn) { findings.push(`${label}: a waiting request was drawn with no deadline on it at all`); continue }
    if (seen.width < 40 || seen.height < 10) findings.push(`${label}: the deadline on "${seen.title}" has no readable box: ${seen.width} by ${seen.height}`)
    if (seen.display === 'none' || seen.visibility === 'hidden' || seen.opacity === '0') {
      findings.push(`${label}: the deadline on "${seen.title}" is in the page and hidden from the person reading it`)
    }
    if (seen.left < 0 || seen.left > seenAll.viewportWidth) findings.push(`${label}: the deadline on "${seen.title}" is outside the window at x=${seen.left}`)
    if (seen.colour === seen.background) findings.push(`${label}: the deadline on "${seen.title}" is painted in its own background colour`)
    if (!/Expires|no longer waiting/.test(seen.when)) findings.push(`${label}: the deadline on "${seen.title}" says nothing about when: "${seen.when}"`)
    if (!/denied|marked as read/.test(seen.consequence)) findings.push(`${label}: the card "${seen.title}" does not say what doing nothing does`)
    if (OUR_RECORD_NUMBER.test(seen.drawnText)) {
      findings.push(`${label}: a record number of ours is on a LINE of "${seen.title}", which this window draws`)
    }
    if (STAMP.test(seen.drawnText)) {
      findings.push(`${label}: a raw stamp is on a LINE of "${seen.title}", which this window draws`)
    }
    if (OUR_RECORD_NUMBER.test(seen.writtenText) || STAMP.test(seen.writtenText)) {
      const found = seen.writtenText.match(OUR_RECORD_NUMBER)?.[0] || seen.writtenText.match(STAMP)?.[0]
      routed.push(`${label}: "${seen.title.slice(0, 70)}" — its own title or message contains ${found}`)
    }
  }

  /* THE ROW ON THE ACCOUNT SCREEN, measured the same way. */
  const row = seenAll.row
  if (!row.drawn) findings.push(`${label}: the signed-in account screen drew no purchase list row`)
  else {
    if (row.state !== 'waiting') findings.push(`${label}: the account row is in the "${row.state}" state while ${prompts.length} requests are waiting`)
    if (row.width < 100 || row.height < 20) findings.push(`${label}: the account row has no readable box: ${row.width} by ${row.height}`)
    if (row.link !== '#/ledger?tab=p') findings.push(`${label}: the account row does not lead to the full list`)
    if (OUR_RECORD_NUMBER.test(row.text)) findings.push(`${label}: one of our record numbers is on the account row`)
    if (!/Expires|no longer waiting/.test(row.text)) findings.push(`${label}: the account row does not say when anything runs out`)
  }

  /* A screenshot, so the verdict can be looked at rather than trusted -- and it
     MAY NEVER DECIDE THE VERDICT. A window started with `show: false` is not
     compositing, and capturePage against one raises UnknownVizError on this
     build; a harness that let that abort the run would report exit 2 ("nothing
     was measured") over a run that had just measured everything. Measured
     2026-08-18, which is how this comment came to exist. */
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const shot = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT_DIR, `purchase-list-${which}.png`), shot.toPNG())
  } catch (error) {
    process.stdout.write(`  ..   no screenshot for the ${which} cart (${error?.message || error}); the measurements above still stand
`)
  }
}

let ORIGIN = null

app.whenReady().then(async () => {
  /* A named queue that cannot be read is not an empty queue. Continuing with
     only the fixture would turn a broken live-cart check into a clean pass. */
  if (live.error) {
    refuse(`harness error: ${live.error}`)
    return
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  ORIGIN = `http://127.0.0.1:${server.address().port}`

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  try {
    await measureCart(win, 'fixture cart', FIXTURE_PROMPTS, 'fixture')
    const fixtureCards = measured
    if (fixtureCards === 0) {
      findings.push('the fixture cart drew no cards at all, so nothing was measured and this run has no verdict in it')
    }
    if (live.prompts) await measureCart(win, "the owner's own cart", live.prompts, 'live')

    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'measured.json'), `${JSON.stringify({
      at: new Date().toISOString(),
      origin: ORIGIN,
      fixtureCards,
      liveWaiting: live.prompts ? live.prompts.length : 0,
      liveSkipReason: live.why,
      cardsMeasured: measured,
      findings,
      routed,
      pageErrors,
    }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`harness error: ${error?.stack || error}\n`)
    try { win.destroy() } catch { /* already gone */ }
    server.close()
    app.exit(2)
    return
  }
  try { win.destroy() } catch { /* already gone */ }
  server.close()

  findings.push(...pageErrors)

  process.stdout.write(`Purchase list, measured in a real renderer: ${measured} card(s) drawn.\n`)
  process.stdout.write('  the fixture cart: measured, always\n')
  process.stdout.write(live.prompts
    ? `  the owner's own cart: measured, ${live.prompts.length} waiting request(s)\n`
    : `  the owner's own cart: SKIPPED — ${live.why}\n`)
  process.stdout.write(`Screenshots and measurements: ${OUT_DIR}\n`)

  /* A run that drew nothing is not a pass and never was. It is the one state
     left that refuses, and it now means the instrument has broken rather than
     "nobody bought anything this week". */
  if (measured === 0) {
    process.stdout.write('\nNOTHING WAS MEASURED: not even the fixture cart drew a card. This run has no verdict in it.\n')
    app.exit(2)
    return
  }

  if (findings.length > 0) {
    process.stdout.write(`\n${findings.length} finding(s) in what this window draws:\n${findings.map(entry => `  - ${entry}`).join('\n')}\n`)
  }
  if (routed.length > 0) {
    process.stdout.write(`\n${routed.length} finding(s) in the words the engine wrote — routed, not edited here:\n`
      + `${routed.map(entry => `  - ${entry}`).join('\n')}\n`
      + '\nThese titles and messages are written by the engine\'s cart producers and printed here unedited.\n'
      + 'Rewriting them in this window would edit the owner\'s own quoted words on his money screen.\n')
  }
  if (findings.length > 0 || routed.length > 0) { app.exit(1); return }
  process.stdout.write('Every request drawn'
    + (live.prompts ? ' — fixture and the owner\'s own' : ' — the fixture, the owner\'s own queue being empty')
    + ' — draws its deadline, says what doing nothing does, and carries no record number of ours.\n')
  app.exit(0)
}).catch(error => {
  refuse(`harness error: ${error?.stack || error}`)
})
