#!/usr/bin/env node
// Real packed renderer, isolated browser contexts, one page at a time. No API
// response substitution, sign-in, agent execution, research, or personal data.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { serveCandidateRenderer, fenceGeometryContext } from './lib/qa-candidate-browser.mjs'
import { browserPaths, browserCases, pendingJourney, runJourney, validateJourneys } from './lib/surface-tests/journeys.mjs'
import { browserActions } from './lib/surface-tests/browser-path-actions.mjs'
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('./lib/sterile-launch.cjs')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--release','--out','--matrix','--profile'].includes(args[i]) || options[args[i]] || !args[i + 1]) throw Error('Invalid browser driver arguments')
  options[args[i]] = args[i + 1]
}
if (!path.isAbsolute(options['--release'] || '') || !path.isAbsolute(options['--out'] || '') ||
    !['browser','mobile'].includes(options['--matrix']) || !['smoke','full'].includes(options['--profile'])) throw Error('Explicit release, output, matrix and profile are required')
const out = options['--out'], mobile = options['--matrix'] === 'mobile', full = options['--profile'] === 'full'
if (fs.existsSync(out)) throw Error('Browser output already exists')
const kit = process.env.TESTKIT_PLAYWRIGHT_ROOT
if (!path.isAbsolute(kit || '')) throw Error('An installed absolute TESTKIT_PLAYWRIGHT_ROOT is required')
const engines = createRequire(path.join(kit, 'package.json'))('playwright')
const matrix = browserCases(options['--matrix'], options['--profile'])
const selectedEngines = [...new Set(matrix.map(cell => cell.engine))]
const paths = browserPaths(options['--matrix'])
const report = { startedAt: new Date().toISOString(), cleanupConfirmed: false, checks: [], cases: matrix.map(cell => ({ ...cell, ok: false, status: 'NOT_RUN', pageErrors: [],
    inputMethod: mobile ? 'emulated touch and keyboard' : 'browser mouse and keyboard',
    cleanupConfirmed: false, journeys: paths.map(pendingJourney) })), errors: [], requestedCases: matrix.length,
  scope: 'Packed renderer in desktop/mobile emulation; not native shell, authenticated FRA, physical touch or keyboard certification.' }
const check = (ok, label) => { report.checks.push({ ok: Boolean(ok), label }); if (!ok) throw Error(label) }
const save = () => {
  report.tests = report.checks.length; report.failed = report.checks.filter(c => !c.ok).length
  report.ok = report.cleanupConfirmed === true && report.tests > 0 && report.failed === 0 && report.errors.length === 0 &&
    report.cases.length === report.requestedCases && report.cases.every(c => c.ok === true && c.cleanupConfirmed === true && !validateJourneys(paths, c.journeys))
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
}
async function settle(page, route) {
  await page.waitForFunction(name => document.body.dataset.route === name && document.querySelector('#stage')?.children.length === 1, route)
  await page.evaluate(() => document.fonts.ready)
  // Product route transitions retain an inert outgoing view until animation ends.
  await page.waitForFunction(() => !document.querySelector('#stage > [inert]'))
}
async function press(page, locator, label) {
  locator = locator.and(page.locator('body :not([inert], [inert] *)')).first()
  await locator.waitFor({ state: 'visible' }); await locator.scrollIntoViewIfNeeded()
  const box = await locator.evaluate(e => {
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x:r.x, y:r.y, width:r.width, height:r.height, reachable: (hit === e || e.contains(hit)) &&
      r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 }
  })
  check(box.reachable && (!mobile || (box.width >= 43.5 && box.height >= 43.5)), label + ': visible unobscured usable target')
  if (mobile) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  else await locator.click()
}
async function dismissGuide(page) {
  for (const name of ['Turn off new-page tips', 'Close guide']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.isVisible()) await press(page, button, name)
  }
}
let candidate, cleanupFailed = false
save() // Persist the exact requested paths before any browser launch.
try {
  candidate = await serveCandidateRenderer({ argv: ['--release', options['--release']], environment: {}, repoRoot })
  report.identity = candidate.provenance
  for (const engine of selectedEngines) {
    const profile = path.join(path.dirname(out), options['--matrix'] + '-' + engine + '-browser-profile')
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|DISPLAY|XAUTHORITY|LANG|LC_ALL)$/i.test(key)))
    const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(profile)), base)
    if (process.platform === 'linux') {
      env.XDG_RUNTIME_DIR = path.join(profile, 'runtime'); fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 })
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + path.join(profile, 'absent-session-bus')
      env.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=' + path.join(profile, 'absent-system-bus')
    }
    const browser = await engines[engine].launch({ headless: true, env, ...(engine === 'chromium' ? { chromiumSandbox: true } : {}) })
    try {
      for (const row of report.cases.filter(cell => cell.engine === engine)) {
        const { width, height, label } = row
        row.status = 'RUNNING'; save()
        const context = await browser.newContext({ viewport: { width,height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', serviceWorkers: 'block' })
        try {
          row.blocked = await fenceGeometryContext(context, { origin: candidate.origin, staticPath: candidate.staticPath })
          const page = await context.newPage(); page.setDefaultTimeout(10000)
          page.on('pageerror', error => row.pageErrors.push(error.message.slice(0,500)))
          const actions = browserActions({ page, mobile, origin: candidate.origin, settle, press, dismissGuide,
            check: (ok, text) => check(ok, label + ': ' + text), pageErrors: row.pageErrors })
          for (const journey of row.journeys) await runJourney(journey, actions, { save,
            onFailure: async step => {
              const target = path.join(path.dirname(out), options['--matrix'] + '-' + label + '-' + journey.id + '-' + step.id + '-failure.png')
              await page.screenshot({ path: target })
              return { screenshot: target }
            } })
          row.screenshot = path.join(path.dirname(out), options['--matrix'] + '-' + label + '.png')
          await page.screenshot({path:row.screenshot}); row.ok = true; row.status = 'PASS'
        } catch (error) { row.status = 'FAIL'; row.error = error.message; report.errors.push({label,error:error.message}) }
        finally {
          try { await context.close(); row.cleanupConfirmed = true }
          catch (error) { cleanupFailed = true; row.ok = false; row.status = 'FAIL'; row.cleanupError = error.message; throw error }
          finally { save() }
        } // closure failure aborts before another page opens
      }
    } finally {
      try { await browser.close() } catch (error) { cleanupFailed = true; throw error }
    }
  }
} catch (error) { report.errors.push({error:error.message}) }
finally {
  if (candidate) try { await candidate.close() } catch(error) { cleanupFailed = true; report.errors.push({error:error.message}) }
  report.cleanupConfirmed = !cleanupFailed
  report.finishedAt = new Date().toISOString(); save()
  process.stdout.write(JSON.stringify({ok:report.ok,tests:report.tests,failed:report.failed,out}) + '\n')
  process.exitCode = report.ok ? 0 : 1
}
