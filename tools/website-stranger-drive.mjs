/*
 * website-stranger-drive.mjs — R1260 T5.1
 *
 * Drives the BUILT website (vite dist, served over HTTP) in a plain Chromium
 * browser context as a first-time stranger would see it: no Electron preload,
 * no shell bridge, no nodeIntegration, and a FRESH profile directory every run
 * so no prior session state leaks in.
 *
 * This is deliberately NOT the packaged-app harness. The packaged harnesses in
 * this repo (smoke-packaged, stranger-onboarding-qa) drive the app WITH its
 * shell. R1090 says the website is a browser clone of that same design, so the
 * question this tool answers is the one no existing harness asks: what does the
 * software do when the shell is ABSENT?
 *
 * Absence-first (R1260 rule 10): every check below is written so that a MISSING
 * element/route/handler is a recorded FAILURE, never an implicit pass. The
 * summary refuses to report success if it measured zero routes.
 *
 * Usage: node tools/website-stranger-drive.mjs <baseUrl> <outDir>
 * Exit:  0 = every route was measured without a FAIL finding;
 *        1 = the drive failed, measurement was vacuous, or a route check failed.
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/* Configuration comes from the ENVIRONMENT, not argv, and that is load-bearing:
 * passing a bare URL as an Electron argv makes the binary exit -1 immediately
 * with no stdout, no stderr and no main-process execution at all (measured:
 * same script + "plainarg" exits 0, + "http://localhost:4699" exits -1).
 * Chromium claims URL-shaped arguments before the app ever starts. A harness
 * that took the URL positionally would look like a silent pass to any caller
 * reading stdout, which is precisely the failure mode this program forbids. */
const BASE = process.env.STRANGER_BASE_URL || 'http://localhost:4699'
const OUT = process.env.STRANGER_OUT_DIR || join(process.cwd(), 'artifacts', 'website-stranger')

const ROUTES = [
  '#/', '#/computers', '#/comms', '#/ledger', '#/metrics',
  '#/research', '#/settings', '#/setup', '#/account',
  '#/approvals', '#/checkout', '#/agent',
]

const findings = []
const routeReports = []

// Electron on Windows is a GUI-subsystem binary: stdout does not attach to the
// parent console, so every line also goes to a log file the caller can read.
// Without this the harness looks silent when it is actually failing loudly.
const LOG = []
function say(line) { LOG.push(line); console.log(line) }
function flushLog() {
  try { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'drive.log'), LOG.join('\n') + '\n') } catch { /* last resort */ }
}
process.on('uncaughtException', (err) => {
  say(`UNCAUGHT: ${err && err.stack || err}`)
  flushLog()
  try { app.exit(1) } catch { process.exit(1) }
})

function note(level, route, what, detail) {
  findings.push({ level, route, what, detail })
}

async function drive() {
  mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({
    width: 1600, height: 1000, show: false,
    webPreferences: {
      // A stranger's browser: no preload, no node, isolated context.
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  for (const route of ROUTES) {
    const url = `${BASE}/${route}`
    const consoleErrors = []
    const failedRequests = []
    const pageErrors = []

    // Electron 43 emits console-message with a single event object
    // ({level:'warning'|'error'|..., message, lineNumber, sourceId}); older
    // Electron used positional args with a NUMERIC level. Handle both, and
    // treat an unrecognised shape as noteworthy rather than silently dropping
    // it -- a console listener that quietly matches nothing is the "guard that
    // cannot fail" defect this program is trying to stamp out.
    const onConsole = (a, b, c, d, e) => {
      let level = null, message = null, sourceId = null, line = null
      if (a && typeof a === 'object' && 'level' in a && 'message' in a) {
        level = a.level; message = a.message; sourceId = a.sourceId; line = a.lineNumber
      } else if (typeof b === 'number' || typeof b === 'string') {
        level = b; message = c; line = d; sourceId = e
      } else {
        consoleErrors.push({ level: 'unknown-shape', message: JSON.stringify([a, b, c, d, e]).slice(0, 300) })
        return
      }
      const sev = String(level).toLowerCase()
      const bad = sev === 'error' || sev === 'warning' || Number(level) >= 2
      if (bad) consoleErrors.push({ level: sev, message: String(message), sourceId, line })
    }
    win.webContents.on('console-message', onConsole)

    const onFailLoad = (_e, code, desc, validatedURL) => {
      failedRequests.push({ code, desc, url: validatedURL })
    }
    win.webContents.on('did-fail-load', onFailLoad)

    let loadError = null
    try {
      await win.loadURL(url)
      // let the hash router mount + async data fetches settle
      await new Promise(r => setTimeout(r, 2500))
    } catch (err) {
      loadError = String(err && err.message || err)
    }

    let probe = null
    try {
      probe = await win.webContents.executeJavaScript(`(() => {
        const t = (el) => (el && el.textContent || '').trim()
        const visible = (el) => {
          if (!el) return false
          const r = el.getBoundingClientRect()
          const s = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
        }
        const body = document.body
        const main = document.querySelector('main') || body
        const text = (main.innerText || '').trim()
        // Controls a stranger could click
        const clickable = Array.from(document.querySelectorAll('button, a[href], [role=button]'))
        const controls = clickable.filter(visible).map(el => ({
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || t(el) || el.getAttribute('title') || '').slice(0, 80),
          href: el.getAttribute('href') || null,
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        }))
        // Anything that looks like a download offer
        const downloadish = controls.filter(c =>
          /download|install|get .*(app|windows)|\\.exe/i.test(c.label + ' ' + (c.href || '')))
        return {
          route: location.hash,
          bodyRoute: body.dataset.route || null,
          title: document.title,
          textLen: text.length,
          textHead: text.slice(0, 700),
          controlCount: controls.length,
          controls: controls.slice(0, 60),
          downloadish,
          emptyLooking: text.length < 40,
          mentionsMissionControl: /mission control/i.test(document.documentElement.innerHTML),
          mentionsSimulated: /simulated|sample data|demo data|example data/i.test(text),
        }
      })()`)
    } catch (err) {
      probe = { probeError: String(err && err.message || err) }
    }

    const shot = join(OUT, `${route.replace(/[#/]/g, '') || 'home'}.png`)
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(shot, img.toPNG())
    } catch { /* screenshot is evidence, not a gate */ }

    win.webContents.off('console-message', onConsole)
    win.webContents.off('did-fail-load', onFailLoad)

    // ---- absence-first assertions -------------------------------------
    if (loadError) note('FAIL', route, 'page did not load', loadError)
    if (probe?.probeError) note('FAIL', route, 'DOM probe threw', probe.probeError)
    if (probe?.emptyLooking) note('FAIL', route, 'route renders essentially nothing', `innerText length ${probe.textLen}`)
    if (probe && probe.bodyRoute && route !== '#/' && !route.startsWith('#/agent')) {
      const asked = route.replace('#/', '')
      if (probe.bodyRoute !== asked) {
        note('INFO', route, 'router redirected', `asked ${asked}, landed ${probe.bodyRoute}`)
      }
    }
    if (probe?.mentionsMissionControl) {
      note('FAIL', route, 'pre-rename product name present in shipped website markup', 'matched /mission control/i')
    }
    for (const e of consoleErrors.slice(0, 25)) {
      const isError = String(e.level).toLowerCase() === 'error' || Number(e.level) >= 3
      note(isError ? 'FAIL' : 'WARN', route, 'console', `${e.message} @ ${e.sourceId}:${e.line}`)
    }
    for (const f of failedRequests.slice(0, 25)) {
      note('FAIL', route, 'request failed', `${f.code} ${f.desc} ${f.url}`)
    }

    routeReports.push({ route, url, loadError, consoleErrors, failedRequests, probe, screenshot: shot })
  }

  win.destroy()

  // Vacuity guard: refuse to report success on zero measurement.
  const measured = routeReports.filter(r => r.probe && !r.probe.probeError).length
  const report = {
    base: BASE,
    at: new Date().toISOString(),
    routesRequested: ROUTES.length,
    routesMeasured: measured,
    vacuous: measured === 0,
    findings,
    routes: routeReports,
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))

  const fails = findings.filter(f => f.level === 'FAIL').length
  say(`ROUTES_REQUESTED=${ROUTES.length}`)
  say(`ROUTES_MEASURED=${measured}`)
  say(`FINDINGS_FAIL=${fails}`)
  say(`FINDINGS_WARN=${findings.filter(f => f.level === 'WARN').length}`)
  say(`VACUOUS=${measured === 0}`)
  say(`REPORT=${join(OUT, 'report.json')}`)
  for (const f of findings) say(`[${f.level}] ${f.route} :: ${f.what} :: ${String(f.detail).slice(0, 240)}`)
  if (measured === 0) {
    say('REFUSING SUCCESS: measured zero routes')
    return 1
  }
  if (fails > 0) {
    say(`REFUSING SUCCESS: ${fails} route check${fails === 1 ? '' : 's'} failed`)
    return 1
  }
  return 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await drive()
  } catch (err) {
    say(`DRIVE_FAILED: ${err && err.stack || err}`)
    code = 1
  }
  flushLog()
  app.exit(code)
})
