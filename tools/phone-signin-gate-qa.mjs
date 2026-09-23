#!/usr/bin/env node

// Exercise the real signed-out ledger gate under its website wrapper. Supply
// APP_ORIGIN and TESTKIT_PLAYWRIGHT_ROOT explicitly; this driver never creates
// an account or substitutes account responses. It blocks writes and external
// requests, measures geometry before actions can scroll, and uses native mouse
// and touch coordinates so graph pointer capture cannot conceal broken links.
// Native Tab and Enter also prove a visible, reachable keyboard action.
// PHONE_GATE_QA_REPORT optionally names a JSON report; screenshots live beside it.
// PHONE_GATE_QA_CASE may name one engine-WIDTHxHEIGHT case for a recorded retry.
// Exit 0: all checks passed, 1: failure, 2: required browser/origin unavailable.

import candidateScope from './lib/qa-candidate-scope.cjs'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// --release is an explicit unavailable scenario, never a source fallback.
candidateScope.refuseUnsupportedCandidate({ repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), driver: 'phone-signin-gate', reason: 'this flow requires the deployed website wrapper, /signin/ form and real anonymous /v1/account API; a desktop archive is not that hosted website and no account response may be fabricated' })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const reportPath = process.env.PHONE_GATE_QA_REPORT || ''
const cells = [[390, 844], [844, 390], [320, 568], [568, 320]]
let expectedCases = 8
const report = {
  startedAt: new Date().toISOString(), fixtureResponses: 0, accountOverrides: false,
  checks: [], results: [], errors: [],
  limitations: [
    'Anonymous gate only; this does not establish authenticated FRA or account enrollment.',
    'Browser viewport emulation does not establish physical phone or keyboard behavior.',
    'Only same-origin GET/HEAD requests are permitted; mutations, WebSockets and external requests are blocked and reported.',
  ],
}
const check = (ok, label, detail) => report.checks.push({ ok: Boolean(ok), label, ...(detail === undefined ? {} : { detail }) })
function save() {
  if (!reportPath) return
  mkdirSync(path.dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
}
function measure(html) {
  const visible = el => {
    const box = el?.getBoundingClientRect()
    const style = el && getComputedStyle(el)
    return Boolean(box && box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden')
  }
  const rect = el => {
    if (!el) return null
    const box = el.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
  }
  const actions = [...document.querySelectorAll('.phone-ledger-door-signin')].filter(visible)
  const action = actions.length === 1 ? actions[0] : null
  const ledger = action?.closest('.phone-ledger')
  const box = rect(action)
  const actionStyle = action && getComputedStyle(action)
  const clip = { x: 0, y: 0, right: innerWidth, bottom: innerHeight }
  for (let parent = action?.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), parentBox = parent.getBoundingClientRect()
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
      clip.x = Math.max(clip.x, parentBox.x); clip.right = Math.min(clip.right, parentBox.right)
    }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
      clip.y = Math.max(clip.y, parentBox.y); clip.bottom = Math.min(clip.bottom, parentBox.bottom)
    }
  }
  const hit = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
  return {
    path: location.pathname + location.search + location.hash,
    mode: html.dataset.phoneCanvas, shape: html.dataset.phoneShape,
    roots: document.querySelectorAll('#stage .computers').length,
    actions: actions.length, href: action?.getAttribute('href'), action: box, clip,
    actionFocused: action === document.activeElement, tabIndex: action?.tabIndex,
    focusVisible: Boolean(action?.matches(':focus-visible')),
    focusTransitionActive: Boolean(action?.getAnimations().some(animation => animation.playState === 'running')),
    focusOutline: actionStyle && { style: actionStyle.outlineStyle, width: parseFloat(actionStyle.outlineWidth), offset: parseFloat(actionStyle.outlineOffset), color: actionStyle.outlineColor },
    actionFullyVisible: Boolean(box && box.x >= clip.x - 1 && box.y >= clip.y - 1 && box.right <= clip.right + 1 && box.bottom <= clip.bottom + 1),
    actionReceivesPointer: Boolean(action && (hit === action || action.contains(hit))),
    agentRows: [...document.querySelectorAll('.phone-ledger-row')].filter(visible).length,
    visibleExampleBadges: [...document.querySelectorAll('[data-example-badge]')].filter(visible).map(el => el.textContent.trim()),
    ledger: rect(ledger), ledgerScrollTop: ledger?.scrollTop,
    ledgerClientHeight: ledger?.clientHeight, ledgerScrollHeight: ledger?.scrollHeight,
    ledgerOverflowY: ledger && getComputedStyle(ledger).overflowY,
    pageWidth: html.scrollWidth, viewportWidth: innerWidth,
  }
}
async function ready(page) {
  await page.locator('html').evaluate(async () => { await document.fonts.ready })
  let state
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    state = await page.locator('html').evaluate(measure)
    if (state.roots === 1 && state.actions === 1 && state.mode === 'on') return state
    await delay(150)
  }
  throw new Error('A single anonymous mobile sign-in gate did not settle')
}
async function screenshot(page, label) {
  if (!reportPath) return null
  const file = path.join(path.dirname(reportPath), label + '.png')
  await page.screenshot({ path: file, fullPage: false })
  return { path: file, sha256: sha(readFileSync(file)) }
}

async function runCase(browser, origin, appPath, engine, cell) {
  const label = `${engine}-${cell.width}x${cell.height}`
  const start = report.checks.length
  const row = { label, engine, viewport: cell, errors: [], blocked: [], responses: [], observations: [], screenshots: [] }
  const context = await browser.newContext({ viewport: cell, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
      row.blocked.push({ method: request.method(), origin: url.origin, path: url.pathname })
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  if (typeof context.routeWebSocket !== 'function') throw new Error('WebSocket request guard unavailable')
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url())
    row.blocked.push({ method: 'WEBSOCKET', origin: url.origin, path: url.pathname })
    socket.close()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => row.errors.push(error.message))
  page.on('response', response => row.responses.push({ path: new URL(response.url()).pathname, status: response.status() }))
  try {
    check((await context.cookies()).length === 0, `${label}: fresh context has no cookies`)
    for (const pointer of ['mouse', 'touch', 'keyboard']) {
      const response = await page.goto(origin + appPath + '?ledger=1#/computers', { waitUntil: 'domcontentloaded' })
      check(response?.status() === 200, `${label} ${pointer}: actual app document loaded`)
      const state = await ready(page)
      row.observations.push({ pointer, ...state })
      check(state.mode === 'on' && state.shape === (cell.width > cell.height ? 'landscape' : 'portrait'), `${label} ${pointer}: explicit dropdown route and orientation retained`)
      check(state.agentRows === 0 && state.href === '/signin/', `${label} ${pointer}: signed-out gate shows no authenticated rows`)
      check(state.pageWidth <= state.viewportWidth + 1, `${label} ${pointer}: no horizontal page overflow`)
      check(state.action.height >= 43.5 && state.action.width >= 43.5 && state.actionFullyVisible,
        `${label} ${pointer}: complete 44px sign-in target is visible before scrolling`, { action: state.action, clip: state.clip })
      check(state.actionReceivesPointer, `${label} ${pointer}: sign-in target receives a pointer at its center`)
      check(/auto|scroll/.test(state.ledgerOverflowY), `${label} ${pointer}: ledger retains vertical scrolling for overflow`)
      if (pointer === 'mouse') {
        const capture = await screenshot(page, label + '-anonymous')
        if (capture) row.screenshots.push(capture)
      }
      const x = state.action.x + state.action.width / 2, y = state.action.y + state.action.height / 2
      if (!state.actionFullyVisible || !state.actionReceivesPointer) throw new Error('Sign-in action is clipped or blocked; refusing an action outside its visible target')
      if (pointer === 'keyboard') {
        let focused
        for (let tabs = 1; tabs <= 40; tabs += 1) {
          await page.keyboard.press('Tab')
          focused = await page.locator('html').evaluate(measure)
          if (focused.actionFocused) { row.keyboardTabs = tabs; break }
        }
        // The shared control style animates all properties. Measure the
        // painted ring after that transition, not its initial zero-width frame.
        for (const deadline = Date.now() + 2000; focused.actionFocused && Date.now() < deadline;) {
          if (!focused.focusTransitionActive && focused.focusOutline?.width >= 2) break
          await delay(40)
          focused = await page.locator('html').evaluate(measure)
        }
        row.observations.push({ pointer: 'keyboard-focused', ...focused })
        check(focused.actionFocused && focused.tabIndex === 0, `${label}: native Tab reaches the primary sign-in action`)
        const ring = focused.focusOutline
        const ringVisible = focused.focusVisible && ring?.style !== 'none' && ring?.width >= 2 && ring?.color !== 'rgba(0, 0, 0, 0)'
        check(ringVisible, `${label}: keyboard focus paints a visible outline`, ring)
        const extent = ring ? Math.max(0, ring.width + ring.offset) : 0
        check(ringVisible && focused.action.x - extent >= focused.clip.x - 1
          && focused.action.y - extent >= focused.clip.y - 1
          && focused.action.right + extent <= focused.clip.right + 1
          && focused.action.bottom + extent <= focused.clip.bottom + 1,
        `${label}: the complete keyboard focus indicator fits inside the visible pane`)
        const capture = await screenshot(page, label + '-keyboard-focus')
        if (capture) row.screenshots.push(capture)
        if (!focused.actionFocused) throw new Error('Native Tab did not reach the primary sign-in action')
      }
      await Promise.all([
        page.waitForURL(url => url.origin === origin && url.pathname === '/signin/'),
        pointer === 'keyboard' ? page.keyboard.press('Enter') : pointer === 'mouse' ? page.mouse.click(x, y) : page.touchscreen.tap(x, y),
      ])
      check(new URL(page.url()).pathname === '/signin/', `${label} ${pointer}: native activation navigates to sign in`)
      await page.locator('form').first().waitFor({ state: 'visible' })
    }
    check(!(await context.cookies()).some(cookie => cookie.name === '__Host-te_session'), `${label}: no authenticated session was created`)
  } catch (error) {
    check(false, `${label}: anonymous gate flow completed`, error.message)
    report.errors.push({ label, error: error.message })
  } finally {
    check(row.errors.length === 0, `${label}: no page JavaScript exceptions`, row.errors)
    check(row.blocked.length === 0, `${label}: no write or external request attempted`, row.blocked)
    const failures = row.responses.filter(response => response.status >= 400 && !(response.status === 401 && response.path.startsWith('/v1/')))
    check(failures.length === 0, `${label}: no unexpected HTTP errors`, failures)
    check(row.responses.some(response => response.path === '/v1/account' && response.status === 401), `${label}: real account API confirms anonymous state`)
    row.checks = report.checks.slice(start)
    row.passed = row.checks.filter(item => item.ok).length
    row.failed = row.checks.length - row.passed
    row.ok = row.failed === 0
    await context.close()
    report.results.push(row)
    save()
    process.stdout.write(JSON.stringify({ label, passed: row.passed, failed: row.failed }) + '\n')
  }
}

try {
  const input = process.env.APP_ORIGIN || ''
  const origin = new URL(input)
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must be an explicit HTTP(S) origin')
  const appPath = process.env.APP_PATH || '/app/'
  if (!/^\/(?:[a-z0-9_-]+\/)*$/i.test(appPath)) throw new Error('APP_PATH must be an absolute directory path')
  const kit = process.env.TESTKIT_PLAYWRIGHT_ROOT || ''
  if (!path.isAbsolute(kit)) throw new Error('TESTKIT_PLAYWRIGHT_ROOT must name the explicit installed test kit')
  const engines = createRequire(path.join(kit, 'package.json'))('playwright')
  report.origin = origin.origin; report.appPath = appPath
  const selected = process.env.PHONE_GATE_QA_CASE || ''
  const allCases = ['chromium', 'webkit'].flatMap(engine => cells.map(([width, height]) => `${engine}-${width}x${height}`))
  if (selected && !allCases.includes(selected)) throw new Error('PHONE_GATE_QA_CASE must name a case in the fixed regression matrix')
  report.requestedCases = selected ? [selected] : allCases
  expectedCases = report.requestedCases.length
  if (reportPath) mkdirSync(path.dirname(reportPath), { recursive: true })
  for (const engine of ['chromium', 'webkit']) {
    if (selected && !selected.startsWith(engine + '-')) continue
    const browser = await engines[engine].launch({ headless: true })
    try {
      for (const [width, height] of cells) {
        if (selected && selected !== `${engine}-${width}x${height}`) continue
        await runCase(browser, origin.origin, appPath, engine, { width, height })
      }
    } finally { await browser.close() }
  }
} catch (error) {
  report.errors.push({ error: error.message })
  process.exitCode = report.results.length ? 1 : 2
} finally {
  report.finishedAt = new Date().toISOString()
  report.tests = report.checks.length
  report.passed = report.checks.filter(item => item.ok).length
  report.failed = report.tests - report.passed
  report.ok = report.results.length === expectedCases && report.failed === 0 && report.errors.length === 0
  save()
  process.stdout.write(JSON.stringify({ ok: report.ok, cases: report.results.length, tests: report.tests, passed: report.passed, failed: report.failed, reportPath }) + '\n')
  if (!report.ok && !process.exitCode) process.exitCode = 1
}
