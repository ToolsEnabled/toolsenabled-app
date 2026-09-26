// Real browser regression, not installed-app or authenticated-provider proof.
// APP_ORIGIN, APP_PATH, TESTKIT_PLAYWRIGHT_ROOT and MOBILE_WORKSPACE_REPORT
// must explicitly identify the served product, installed browser kit and output.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const origin = new URL(process.env.APP_ORIGIN)
assert.ok(['http:', 'https:'].includes(origin.protocol) && origin.pathname === '/' && !origin.username && !origin.password)
const mount = process.env.APP_PATH || '/'
assert.match(mount, /^\/(?:[a-z0-9_-]+\/)*$/i)
assert.ok(path.isAbsolute(process.env.TESTKIT_PLAYWRIGHT_ROOT || ''))
assert.ok(path.isAbsolute(process.env.MOBILE_WORKSPACE_REPORT || ''))
const engines = createRequire(path.join(process.env.TESTKIT_PLAYWRIGHT_ROOT, 'package.json'))('playwright')
const out = process.env.MOBILE_WORKSPACE_REPORT
mkdirSync(path.dirname(out), { recursive: true })
const report = { origin: origin.origin, mount, startedAt: new Date().toISOString(), cases: [], checks: [],
  scope: 'Real renderer and product example UI in fresh browser contexts; no account or response substitution. Touch/keyboard emulation, not physical phones, installed binaries or live provider execution.' }
const save = () => writeFileSync(out, JSON.stringify(report, null, 2))
const check = (ok, label, details) => { report.checks.push({ ok: Boolean(ok), label, ...(details ? { details } : {}) }); assert.ok(ok, label) }

async function settled(page, route) {
  await page.waitForFunction(name => document.body.dataset.route === name && document.querySelector('#stage')?.children.length === 1, route)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
}

async function tap(page, locator, label) {
  // The real router retains outgoing views inert for its exit animation.
  // Those are not live touch targets, even while still visually present.
  locator = locator.and(page.locator('body :not([inert], [inert] *)'))
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.evaluate(e => {
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, width: r.width, height: r.height, receives: e === hit || e.contains(hit), fits: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 }
  })
  check(box.width >= 43.5 && box.height >= 43.5 && box.fits && box.receives, `${label}: visible 44px touch target`, box)
  await page.touchscreen.tap(box.x, box.y)
}

async function navigate(page, hash, route) {
  await page.goto(origin.origin + mount + '?ledger=1#' + hash)
  await settled(page, route)
}

async function one(browser, engine, viewport) {
  const label = `${engine}-${viewport.width}x${viewport.height}`
  const result = { label, errors: [], blocked: [], screenshots: [] }
  report.cases.push(result)
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin.origin && ['GET', 'HEAD'].includes(request.method())) return route.continue()
    result.blocked.push({ method: request.method(), origin: url.origin, path: url.pathname })
    return route.abort()
  })
  // Vite's development hot-reload socket is not product traffic. No socket
  // is connected, so this also keeps the probe away from provider transports.
  await context.routeWebSocket('**/*', socket => socket.close())
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => result.errors.push(error.message))
  const press = (locator, action) => tap(page, locator, `${label} ${action}`)
  const capture = async name => {
    await page.waitForTimeout(250)
    const file = path.join(path.dirname(out), `${label}-${name}.png`)
    await page.screenshot({ path: file }); result.screenshots.push(file)
  }
  try {
    await navigate(page, '/computers', 'computers')
    await press(page.getByRole('button', { name: 'Turn off new-page tips', exact: true }), 'turn off introductions')
    await press(page.getByRole('button', { name: 'Close guide', exact: true }), 'close introduction')
    check(await page.locator('.phone-ledger-row').count() === 0, `${label}: signed-out gate has no agent rows`)
    await press(page.locator('.phone-ledger-door-mark'), 'sign-in screen Home mark')
    await settled(page, 'home')
    check(new URL(page.url()).hash === '#/', `${label}: sign-in screen mark opens app Home`)
    for (const route of ['computers', 'research', 'settings']) {
      await navigate(page, '/' + route, route)
      await press(page.locator('.phone-home-link'), `${route} Home mark`)
      await settled(page, 'home')
      check(await page.locator('.home-overview-title h1').innerText() === 'Home', `${label}: ${route} mark renders actual Home`)
    }
    await navigate(page, '/computers', 'computers')
    await press(page.getByRole('button', { name: 'Explore the demo', exact: true }), 'choose product example')
    await page.waitForFunction(() => document.querySelectorAll('#stage .computers').length === 1 && document.querySelectorAll('.phone-ledger-row').length > 0)
    const initialRows = await page.locator('.phone-ledger-row').count()
    check(initialRows > 1, `${label}: product example has multiple actual agent rows`)
    check(!await page.locator('.tree-shape-select').isVisible() && !await page.locator('.tree-window-add').isVisible(), `${label}: graph-only controls do not crowd rows`)
    const search = page.getByRole('searchbox', { name: 'Find an agent by name or role' })
    await search.fill('Manager')
    check(await page.locator('.phone-ledger-row').count() < initialRows && (await page.locator('.phone-ledger-list').innerText()).includes('Manager'), `${label}: search filters rows and preserves matching agent`)
    await search.fill('')
    await press(page.getByRole('button', { name: 'Collapse all agent branches', exact: true }), 'collapse branches')
    check(await page.locator('.phone-ledger-row').count() < initialRows, `${label}: collapse hides descendants`)
    await press(page.getByRole('button', { name: 'Expand all agent branches', exact: true }), 'expand branches')
    check(await page.locator('.phone-ledger-row').count() === initialRows, `${label}: expand restores descendants`)
    await press(page.getByRole('button', { name: 'Larger rows', exact: true }), 'larger rows')
    check(await page.locator('.phone-ledger-zoom-level').innerText() === '1.18x', `${label}: row size changes`)
    await press(page.getByRole('button', { name: 'Smaller rows', exact: true }), 'restore row size')
    await capture('rows')
    await press(page.locator('.phone-ledger-press').first(), 'open agent')
    await page.locator('.phone-sheet.is-up .chat').waitFor()
    await page.waitForTimeout(600)
    check(await page.locator('.phone-sheet-card .chat-input').evaluate(e => Boolean(e.closest('.chat-composer-dock'))), `${label}: sheet retains shared composer ownership`)
    const input = await page.locator('.phone-sheet-card .chat-input').evaluate(e => {
      const r = e.getBoundingClientRect(), children = [...e.children].filter(n => n.getClientRects().length).map(n => n.getBoundingClientRect())
      return { height: r.height, width: r.width, childrenFit: children.every(n => n.left >= r.left - 1 && n.right <= r.right + 1), sameRow: children.every(n => Math.abs(n.top - children[0].top) < 8) }
    })
    check(input.childrenFit && input.sameRow, `${label}: composer controls fit together`, input)
    await capture('chat')
    await press(page.locator('.phone-sheet [data-rail-tab="details"]'), 'agent Details tab')
    check(await page.locator('.phone-sheet [data-rail-tab="details"]').getAttribute('class') === 'on', `${label}: Details tab selected`)
    await press(page.locator('.phone-sheet [data-rail-tab="chat"]'), 'return to Chat')
    await press(page.locator('.phone-sheet-close'), 'close agent sheet')
    await page.locator('.phone-sheet').waitFor({ state: 'hidden' })
    check(await page.locator('header.topbar').getAttribute('inert') === null, `${label}: closing sheet releases navigation`)
    await press(page.locator('#open-settings'), 'quick settings')
    await press(page.locator('#ledger-seg [data-ledger="off"]'), 'switch to Graph')
    await page.waitForFunction(() => document.querySelectorAll('#stage .computers').length === 1 && !document.querySelector('.computers.phone-ledger-mode'))
    await page.locator('.tree-shape-select').waitFor({ state: 'visible' })
    await page.locator('.tree-window-add').waitFor({ state: 'visible' })
    check(await page.locator('.tree-shape-select').isVisible() && await page.locator('.tree-window-add').isVisible(), `${label}: Graph restores original graph controls`)
    await press(page.locator('#open-settings'), 'reopen quick settings')
    await press(page.locator('#ledger-seg [data-ledger="on"]'), 'return to Rows')
    await page.waitForFunction(() => document.querySelectorAll('#stage .computers').length === 1 && document.querySelector('.computers.phone-ledger-mode'))
    await press(page.locator('.phone-ledger-add').first(), 'add-agent entry')
    await page.locator('.phone-sheet .compose-page.is-active').waitFor()
    check(await page.locator('.phone-sheet .compose-page textarea').count() > 0, `${label}: add-agent entry opens the shared composer`)
    await capture('add-agent')
    await press(page.locator('.phone-sheet-close'), 'close add-agent sheet without starting work')
    await page.locator('.phone-sheet').waitFor({ state: 'hidden' })
    await navigate(page, '/settings', 'settings')
    await page.getByRole('searchbox', { name: 'Search all settings' }).fill('text size')
    await page.waitForTimeout(300)
    check((await page.locator('.settings-results').innerText()).toLowerCase().includes('text size'), `${label}: Settings searches across categories`)
    await capture('settings-search')
    await navigate(page, '/research', 'research')
    await press(page.getByRole('button', { name: 'Runs', exact: true }), 'Research Runs')
    await capture('research-runs')
    await press(page.getByRole('button', { name: 'Evidence', exact: true }), 'Research Evidence')
    await press(page.getByRole('button', { name: 'Design', exact: true }), 'Research Design')
    check(await page.locator('html').evaluate(e => e.scrollWidth <= innerWidth + 1), `${label}: no horizontal page overflow`)
    check(result.errors.length === 0, `${label}: no renderer exceptions`, result.errors)
    check(result.blocked.length === 0, `${label}: no external request or mutation attempted`, result.blocked)
    result.ok = true
  } catch (error) {
    result.ok = false; result.failure = error.message
    await capture('failure').catch(() => {})
  } finally {
    await context.close(); save()
    console.log(JSON.stringify({ label, ok: result.ok, failure: result.failure }))
  }
}

for (const engine of ['chromium', 'webkit']) {
  const browser = await engines[engine].launch()
  try { for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) await one(browser, engine, viewport) }
  finally { await browser.close() }
}
report.finishedAt = new Date().toISOString()
report.ok = report.cases.length === 6 && report.cases.every(row => row.ok)
save()
console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, passed: report.checks.filter(row => row.ok).length, report: out }))
if (!report.ok) process.exitCode = 1
