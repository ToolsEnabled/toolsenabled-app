/* Electron main for the W16e card line-budget render check.
 *
 * Renders tools/w16e-card-lines-fixture.html -- the real `.chip-preview`
 * class chain (src/tree-graph.js `_renderChipPreview`), styled by a
 * `tree-graph.css` loaded unmodified -- in an OFFSCREEN window, through the
 * same captureTruthfully() freshness/blank-frame check
 * tools/clamp-render-main.cjs uses, for the same reason: a plain `show:
 * false` window does not repaint, which would silently crop a stale frame.
 *
 * CARD_LINES_CSS lets the caller point the fixture's stylesheet at a
 * specific tree-graph.css WITHOUT editing this worktree's real source or
 * touching git (no checkout, no stash, no reset): the check script writes
 * `git show <rev>:src/tree-graph.css` to a scratch file for the RED
 * (pre-fix) run and passes this worktree's own src/tree-graph.css for the
 * GREEN (post-fix) run. Config by environment, not argv -- Electron's own
 * switch parser does not reliably pass a full argv set through to this
 * script (same note as clamp-render-main.cjs / ring-capture-main.cjs).
 *
 * Usage: electron tools/w16e-card-lines-main.cjs
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const OUT = process.env.CARD_LINES_OUT || path.join(process.cwd(), 'captures-w16e')
const FIXTURE = path.join(__dirname, 'w16e-card-lines-fixture.html')
const CSS_OVERRIDE = process.env.CARD_LINES_CSS || null
const SCRATCH_FIXTURE = path.join(__dirname, '.w16e-card-lines-fixture.scratch.html')

function trace(m) {
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.appendFileSync(path.join(OUT, 'capture.log'), `${new Date().toISOString()} ${m}\n`)
  } catch { /* nothing left to do */ }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { captureTruthfully } = await import(pathToFileURL(path.join(__dirname, 'lib', 'capture-evidence.mjs')).href)
  trace(`main: electron ${process.versions.electron}, chrome ${process.versions.chrome}, cssOverride ${CSS_OVERRIDE || '(none, using worktree src/tree-graph.css)'}`)

  let fixtureUrl
  if (CSS_OVERRIDE) {
    const html = fs.readFileSync(FIXTURE, 'utf8')
    const cssUrl = pathToFileURL(CSS_OVERRIDE).href
    const rewritten = html.replace('href="../src/tree-graph.css"', `href="${cssUrl}"`)
    if (rewritten === html) throw new Error('CARD_LINES_CSS set but the fixture\'s tree-graph.css <link> was not found to rewrite')
    fs.writeFileSync(SCRATCH_FIXTURE, rewritten)
    fixtureUrl = pathToFileURL(SCRATCH_FIXTURE).href
  } else {
    fixtureUrl = pathToFileURL(FIXTURE).href
  }

  const win = new BrowserWindow({
    width: 900,
    height: 900,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  })
  win.webContents.setFrameRate(30)

  await win.loadURL(fixtureUrl)
  trace(`fixture loaded: ${fixtureUrl}`)

  const rects = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('[data-clamp-test]')].map(el => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        name: el.getAttribute('data-clamp-test'),
        x: r.x, y: r.y, width: r.width, height: r.height,
        lineHeight: parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.3),
        computedLineClamp: cs.webkitLineClamp,
        textLength: el.textContent.length,
        clampedClientHeight: el.clientHeight,
        unclampedHeight: (() => {
          const clone = el.cloneNode(true)
          clone.style.setProperty('-webkit-line-clamp', 'unset')
          clone.style.setProperty('display', 'block')
          clone.style.setProperty('position', 'fixed')
          clone.style.setProperty('visibility', 'hidden')
          clone.style.setProperty('width', getComputedStyle(el).width)
          document.body.appendChild(clone)
          const h = clone.getBoundingClientRect().height
          clone.remove()
          return h
        })(),
      }
    })
  `)
  trace(`found ${rects.length} test boxes: ${rects.map(r => r.name).join(', ')}`)
  if (rects.length === 0) throw new Error('no [data-clamp-test] elements found in the fixture -- nothing was measured')

  const { verdict } = await captureTruthfully(win.webContents, { nonce: 1 })
  trace(`capture verdict: ${verdict.verdict} truthful=${verdict.truthful} -- ${verdict.why}`)
  if (!verdict.truthful) {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ error: verdict, rects }, null, 2))
    throw new Error(`capture was not truthful (${verdict.verdict}): ${verdict.why}`)
  }

  const results = rects.map(r => ({
    name: r.name,
    lineHeight: r.lineHeight,
    computedLineClamp: r.computedLineClamp,
    textLength: r.textLength,
    clampedClientHeight: r.clampedClientHeight,
    unclampedHeight: r.unclampedHeight,
    overflowing: r.unclampedHeight > r.clampedClientHeight + 0.5,
    linesShown: Math.round(r.clampedClientHeight / r.lineHeight),
  }))

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    verdict: { verdict: verdict.verdict, truthful: verdict.truthful, why: verdict.why },
    cssOverride: CSS_OVERRIDE,
    boxes: results,
  }, null, 2))

  trace(`wrote results.json with ${results.length} boxes`)
  if (CSS_OVERRIDE) { try { fs.unlinkSync(SCRATCH_FIXTURE) } catch { /* best effort */ } }
  win.destroy()
  app.quit()
}

function fail(err) {
  const msg = `capture failed: ${(err && err.stack) || err}\n`
  try {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'capture-error.log'), msg)
  } catch { /* nothing left to do */ }
  try { fs.unlinkSync(SCRATCH_FIXTURE) } catch { /* best effort */ }
  process.exitCode = 1
  app.quit()
}

process.on('uncaughtException', fail)

trace('script evaluated')
app.whenReady().then(() => { trace('app ready'); main().catch(fail) })
