// Browser driver: every painted button carries the app's button look, never the browser default.
//
// Owner, 2026-09-10: "check for totaly unstyled buttons like browse saved cnversation and full view".
// Measured on the LIVE build: "Browse saved conversation" (src/node-transcript-history.js, a button
// created in script with no class) painted as Chromium's own grey default. This driver:
//   1. walks the routes a person can reach, opens the home chat full view, and lists every visible
//      button / role=button whose computed border AND background equal the user-agent default
//      (measured on a probe button inside a shadow root, which page stylesheets cannot reach);
//   2. mounts the saved-conversation browser for real, through its own module, with a small fake
//      store, and applies the same check to its three buttons -- the case the routes cannot reach
//      without a saved session.
// Exit 0 with a results.json when no control is default-looking; exit 1 naming each one otherwise.
// Every check records how many visible controls it examined, and their labels, and fails when that number is
// zero; a scoped check screenshots the element it measured, not the viewport, so each image shows what was checked.
// RED against a tree without the base rule in src/styles.css; GREEN with it.
//
// Env: BENCHMARK_TEST_ORIGIN (a Vite origin serving this tree), BENCHMARK_TEST_OUTPUT (directory),
// MC_PLAYWRIGHT_ROOT (playwright package root). Same contract as the other run-*.mjs drivers.
// results.json records this driver's own file and sha256, the platform and the origin, and BOTH request
// tallies BY URL -- outsideRequests (left the machine) and loopbackRequests (another 127.0.0.1 port,
// which has not) -- so a release
// qualification (tools/check-browser-proofs-discovered.mjs --receipts) can attribute the receipt to the
// exact tree it came from. This is the family's one required proof (browser-proofs.json, T35).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4600'
const output = process.env.BENCHMARK_TEST_OUTPUT || path.resolve('tmp', 'buttons-carry-app-style')
const { chromium } = require(path.join(process.env.MC_PLAYWRIGHT_ROOT || 'playwright'))
fs.mkdirSync(output, { recursive: true })

const ROUTES = ['#/', '#/computers', '#/metrics', '#/research', '#/comms', '#/ledger', '#/approvals', '#/settings', '#/tools', '#/account', '#/setup']
const results = {
  driver: { file: 'tools/test/fixtures/run-buttons-carry-app-style.mjs', sha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex') },
  platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(),
  origin, checks: [], errors: [], examined: [], defaultLooking: [],
  // outsideRequests means LEFT THE MACHINE. Loopback on another port has not; see the router below.
  outsideRequests: 0, outsideRequestUrls: [], loopbackRequests: 0, loopbackRequestUrls: [],
}
const check = (name, ok, detail) => { results.checks.push(name); if (!ok) results.errors.push(`${name}${detail ? `: ${detail}` : ''}`) }

const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
/* A DIFFERENT PORT ON 127.0.0.1 IS NOT THE OUTSIDE WORLD.
   This compared every request against the ORIGIN STRING, so anything on
   another loopback port counted as having left the machine. What it counted,
   measured on 2026-09-18 while giving this driver its first-ever run: 31
   requests, every one of them loopback -- 127.0.0.1:4610-4619 /v1/runtime,
   which is src/mission-bridge.js scanWellKnownBridges() looking for a local
   action bridge across its declared range, plus one 127.0.0.1 workspace probe.
   Nothing left the machine.

   tools/check-browser-proofs-discovered.mjs fails a receipt whose
   outsideRequests is non-zero, reporting "N request(s) left the loopback
   origin" -- a sentence that contradicts itself about 127.0.0.1, and a bar this
   app can never clear: configuredBaseUrl() only skips that scan on a public
   origin, under a supervised Electron shell, or when ?bridge= is supplied, and
   a Playwright page on the dev origin is none of those.

   So the two are now counted apart. outsideRequests means what the qualifier
   reads it as -- left the machine -- and loopback traffic is recorded beside
   it. Both are still ABORTED: the proof stays hermetic, and the page is
   measured without a bridge either way.

   AND BOTH ARE RECORDED BY URL, not merely counted. A bare number is what made
   the first run's failure unreadable: neither this driver nor the qualifier
   said which requests, so finding out they were all loopback took a separate
   walk. A count with no names costs the next reader that same hour. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const isLoopback = url => {
  try {
    const host = new URL(url).hostname
    return LOOPBACK_HOSTS.has(host) || /^127\./.test(host)
  } catch { return false }
}
await page.route('**/*', route => {
  const url = route.request().url()
  if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
  if (isLoopback(url)) {
    results.loopbackRequests += 1
    if (!results.loopbackRequestUrls.includes(url.split('?')[0])) results.loopbackRequestUrls.push(url.split('?')[0])
  } else {
    results.outsideRequests += 1
    if (!results.outsideRequestUrls.includes(url.split('?')[0])) results.outsideRequestUrls.push(url.split('?')[0])
  }
  return route.abort()
})

// The comparison every check uses. A control is "default-looking" when its border and background both equal
// those of a bare <button> inside a shadow root, which no page stylesheet reaches. Font is not compared:
// Chromium gives every button its own font unless a rule says otherwise, and scoped rules here set it.
const DEFAULT_LOOKING = `(scopeSelector) => {
  const host = document.createElement('div'); const shadow = host.attachShadow({ mode: 'open' })
  const probe = document.createElement('button'); probe.textContent = 'x'; shadow.append(probe); document.body.append(host)
  const ua = getComputedStyle(probe)
  const same = (a, b) => a.borderTopStyle === b.borderTopStyle && a.borderTopColor === b.borderTopColor && a.borderTopLeftRadius === b.borderTopLeftRadius && a.backgroundColor === b.backgroundColor
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  const root = scopeSelector ? document.querySelector(scopeSelector) : document.body
  const out = [], examined = []
  for (const el of root ? root.querySelectorAll('button, [role="button"]') : []) {
    if (!visible(el)) continue
    examined.push((el.getAttribute('aria-label') || el.textContent || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 60) || '(unlabelled)')
    if (same(getComputedStyle(el), ua)) out.push({ name: (el.getAttribute('aria-label') || el.textContent || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 60), markup: [...el.attributes].map(a => a.value ? a.name + '=' + JSON.stringify(a.value) : a.name).join(' ').slice(0, 120) })
  }
  host.remove(); return { scopeFound: Boolean(root), examined, out }
}`

async function assertNoDefaultLooking(label, scopeSelector = null) {
  const { scopeFound, examined, out: found } = await page.evaluate(`(${DEFAULT_LOOKING})(${JSON.stringify(scopeSelector)})`)
  const file = `${label.replace(/[^a-z0-9]+/gi, '-')}.png`
  results.examined.push({ where: label, scope: scopeSelector, scopeFound, count: examined.length, labels: examined, screenshot: file })
  for (const f of found) results.defaultLooking.push({ where: label, ...f })
  // A check that examined nothing proves nothing, so it fails by name instead of passing.
  check(`${label}: at least one visible control was examined`, examined.length > 0,
    scopeSelector ? `scope ${scopeSelector}${scopeFound ? ' had no visible control' : ' matched nothing'}` : 'the page had no visible control')
  check(`${label}: no button paints as the browser default`, found.length === 0, found.map(f => `[${f.name || f.markup}]`).join(' '))
  if (!scopeSelector) return page.screenshot({ path: path.join(output, file) })
  try { await page.locator(scopeSelector).first().screenshot({ path: path.join(output, file) }) }
  catch (error) { check(`${label}: the scoped element was captured`, false, String(error.message).split('\n')[0]) }
}

for (const route of ROUTES) {
  await page.goto(`${origin}/${route}`, { waitUntil: 'load' })
  await page.waitForTimeout(400)
  await assertNoDefaultLooking(`route ${route}`)
}
await page.goto(`${origin}/#/`, { waitUntil: 'load' })
await page.waitForTimeout(400)
const expand = page.locator('[data-chat-expand]')
check('home offers the Full view control', await expand.count() > 0)
if (await expand.count()) {
  const expandDefault = await page.evaluate(`(${DEFAULT_LOOKING})('.home')`)
  check('the Full view control is styled', !expandDefault.out.some(f => /full view/i.test(f.name)), JSON.stringify(expandDefault.out))
  await expand.first().click()
  await page.waitForTimeout(600)
  await assertNoDefaultLooking('home full view', '.home-takeover')
}

// The saved-conversation browser, mounted for real through its own module with a fake store.
await page.goto(`${origin}/#/`, { waitUntil: 'load' })
await page.waitForTimeout(300)
await page.addScriptTag({ type: 'module', content: `
  import { mountTranscriptHistory } from '/src/node-transcript-history.js'
  const host = document.createElement('div'); host.id = 'driver-transcript-host'; document.body.append(host)
  const store = { readPage: async () => ({ entries: [{ who: 'you', text: 'first' }, { who: 'agent', text: 'second' }], next: null }) }
  mountTranscriptHistory({ host, store, nodeId: 'driver-node' })
  window.__driverTranscriptMounted = true
` })
await page.waitForFunction(() => window.__driverTranscriptMounted === true, null, { timeout: 5000 }).catch(() => {})
const mounted = await page.evaluate(() => Boolean(document.querySelector('#driver-transcript-host .node-transcript-history')))
check('the saved-conversation browser mounts through its module', mounted)
if (mounted) {
  const toggle = page.locator('#driver-transcript-host .node-transcript-history > button').first()
  check('its toggle reads "Browse saved conversation"', (await toggle.textContent())?.trim() === 'Browse saved conversation')
  await assertNoDefaultLooking('saved conversation browser (collapsed)', '#driver-transcript-host')
  // A DOM click, not a pointer click: the driver's host sits under the fixed top bar, which would intercept the pointer.
  await toggle.evaluate(el => el.click())
  await page.waitForTimeout(400)
  await assertNoDefaultLooking('saved conversation browser (open, paging buttons)', '#driver-transcript-host')
}

await browser.close()
results.checks.length && fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
console.log(`checks ${results.checks.length} errors ${results.errors.length} defaultLooking ${results.defaultLooking.length}`
  + ` outsideRequests ${results.outsideRequests}${results.outsideRequestUrls.length ? ` (${results.outsideRequestUrls.join(', ')})` : ''}`
  + ` loopbackRequests ${results.loopbackRequests}${results.loopbackRequestUrls.length ? ` (${results.loopbackRequestUrls.join(', ')})` : ''}`)
for (const e of results.errors) console.log(`not ok - ${e}`)
process.exit(results.errors.length ? 1 : 0)
