'use strict'

/* THE ANSWER TO A WRITE, ON REAL GLASS, AFTER THE SCREEN THAT ASKED FOR IT IS GONE.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. The controller half of the B2 sweep --
 * cloud launch, ledger archive, loop stop, team dispatch -- has no DOM and is
 * driven end to end by tools/test/write-outcomes.test.mjs. The half that CANNOT
 * be answered by a `node --test` run is this one: whether the restated sentence
 * actually reaches a person's eyes on the audited write surface, in a real
 * renderer, under the real stylesheet, and whether it survives the three other
 * things that write to that panel a fraction of a second after it mounts (the
 * bridge handshake, the pending state, and configureQueueSnapshots' ready line).
 * Source text cannot see that. Only rendering it can.
 *
 * IT DRIVES SHIPPED CODE. The page below imports src/write-surfaces.js and
 * src/write-outcomes.js from the tree -- the same modules the product loads --
 * links src/styles.css unmodified, and calls the same exported functions the
 * product calls. Nothing here reimplements the surface.
 *
 * IT SPENDS NOTHING AND REACHES NOTHING. No audited bridge is started, so
 * postBridgeAction refuses on its own; no launch, no decision and no queue
 * transition is ever sent. The record under test is seeded with the product's
 * own recordUndeliveredWrite, which is the exact call the fixed code path makes.
 *
 * Run: electron tools/write-outcome-restate-qa.cjs
 */

// Refuse --release before Electron can open any legacy source fixture.
require('./lib/qa-candidate-scope.cjs').refuseUnsupportedCandidate({
  repoRoot: require('node:path').resolve(__dirname, '..'), driver: 'write-outcome-restate',
  reason: 'this restatement fixture imports unbundled source modules that are absent from the candidate archive; a selected-renderer delayed receipt scenario is still required',
})

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const captureEvidence = import('./lib/capture-evidence.mjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const SRC = path.join(REPO_ROOT, 'src')
const toUrl = p => `file:///${p.replace(/\\/g, '/')}`

/* Isolated userData: this machine's own settings, theme and permission level
   must not be mistaken for the product's behaviour. */
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-write-outcome-qa-'))
app.setPath('userData', USER_DATA)

const OUT = process.env.WRITE_OUTCOME_QA_OUT || path.join(USER_DATA, 'shots')
fs.mkdirSync(OUT, { recursive: true })

const PAGE = `<!doctype html>
<html data-theme="white"><head><meta charset="utf-8">
<link rel="stylesheet" href="${toUrl(path.join(SRC, 'styles.css'))}">
<style>body{margin:0;padding:24px;background:var(--bg,#fff)}</style>
</head><body class="ledger">
<div id="root"><div class="ledger-toolbar">ledger toolbar</div></div>
<script type="module">
import { mountLedgerWriteSurface } from '${toUrl(path.join(SRC, 'write-surfaces.js'))}'
import {
  WRITE_OUTCOME_KEYS, recordUndeliveredWrite, resetUndeliveredWrites, undeliveredWriteCount,
} from '${toUrl(path.join(SRC, 'write-outcomes.js'))}'

/* The two write actions this surface carries, turned on the way the settings
   screen turns them on -- the same localStorage keys src/write-flags.js reads.
   Off, the forms do not exist at all and there would be nothing to restate. */
localStorage.setItem('mc.write.decision', 'enabled')
localStorage.setItem('mc.write.queue', 'enabled')

const root = document.getElementById('root')
const reading = () => {
  const line = document.querySelector('[data-decision-form] .write-restated')
  if (!line) return null
  const box = line.getBoundingClientRect()
  const css = getComputedStyle(line)
  return {
    text: line.textContent,
    state: line.dataset.state,
    marked: line.dataset.undeliveredOutcome === 'true',
    role: line.getAttribute('role'),
    visible: box.width > 0 && box.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'
      && Number(css.opacity) > 0,
    color: css.color,
    width: Math.round(box.width),
  }
}

window.qa = {
  async step1_absence() {
    resetUndeliveredWrites()
    const destroy = mountLedgerWriteSurface(root)
    const found = reading()
    destroy()
    document.querySelector('.write-surface')?.remove()
    return { restated: found, storeCount: undeliveredWriteCount() }
  },
  async step2_missOutcomeThenComeBack() {
    resetUndeliveredWrites()
    /* The exact call src/write-surfaces.js now makes when a decision receipt
       lands at a surface that has been torn down. */
    recordUndeliveredWrite(WRITE_OUTCOME_KEYS.BRIDGE_DECISION, {
      tone: 'refused',
      message: 'refused · the audited bridge did not confirm the decision record.',
    })
    const destroy = mountLedgerWriteSurface(root)
    const atMount = reading()
    /* Let prepareSurface finish. With no bridge it lands on unavailableState,
       which disables every control and rewrites the header status -- the exact
       race that would have erased a restatement written into the <output>. */
    await new Promise(resolve => setTimeout(resolve, 4000))
    const afterHandshake = reading()
    const outputText = document.querySelector('[data-decision-form] [data-action-output]')?.textContent ?? null
    destroy()
    return { atMount, afterHandshake, outputText }
  },
  teardown() {
    document.querySelector('.write-surface')?.remove()
    resetUndeliveredWrites()
  },
}
window.qaReady = true
</script></body></html>`

const PAGE_FILE = path.join(USER_DATA, 'page.html')
fs.writeFileSync(PAGE_FILE, PAGE, 'utf8')

const problems = []
const check = (ok, label) => { if (!ok) problems.push(label); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  await win.loadFile(PAGE_FILE)
  await win.webContents.executeJavaScript(
    'new Promise(r => { const t = setInterval(() => { if (window.qaReady) { clearInterval(t); r(true) } }, 25) })')

  const started = Date.now()

  // ---- ABSENCE: a fresh surface with nothing missed shows no restatement ----
  const absence = await win.webContents.executeJavaScript('window.qa.step1_absence()')
  check(absence.restated === null, 'ABSENCE: nothing missed -> no restated line on the surface at all')
  check(absence.storeCount === 0, 'ABSENCE: the store is genuinely empty for that reading')

  // ---- THE JOURNEY: an outcome missed, then the surface is built again ----
  const seen = await win.webContents.executeJavaScript('window.qa.step2_missOutcomeThenComeBack()')
  const at = seen.atMount
  check(Boolean(at), 'the restated line exists on the rebuilt surface')
  check(Boolean(at) && at.text.startsWith('While you were on another screen: '),
    'it is labelled as something that happened while the person was elsewhere')
  check(Boolean(at) && at.text.includes('did not confirm the decision record'),
    'it carries the actual sentence the surface would have shown')
  check(Boolean(at) && at.marked === true, 'it is marked data-undelivered-outcome for a driver to find')
  check(Boolean(at) && at.role === 'status', 'it is announced politely, not shouted as an alert')
  check(Boolean(at) && at.visible === true && at.width > 100,
    `it is actually on the glass (width ${at?.width}px, display/visibility/opacity all live)`)
  check(Boolean(at) && at.state === 'refused', 'it carries the refused tone the stylesheet colours')

  const after = seen.afterHandshake
  check(Boolean(after) && after.text === at?.text,
    'THE RACE: the bridge handshake and the queue snapshot did not erase it')
  check(Boolean(after) && after.visible === true, 'and it is still visible after the handshake settles')

  /* A screenshot is evidence only if the renderer painted this moment. A plain
     capturePage() can return a blank or previous frame for a hidden window and
     used to let this driver pass while filing a picture that proved nothing. */
  const { captureTruthfully } = await captureEvidence
  const capture = await captureTruthfully(win.webContents, {
    nonce: Date.now(), attempts: 3, settleMs: 140,
  })
  check(capture.verdict?.truthful === true, `the screenshot is current, painted evidence (${capture.verdict?.why})`)
  const shotFile = path.join(OUT, 'ledger-write-surface-restated.png')
  if (capture.image) fs.writeFileSync(shotFile, capture.image.toPNG())

  await win.webContents.executeJavaScript('window.qa.teardown()')

  console.log('')
  console.log(`colour of the restated line: ${at?.color}`)
  console.log(`decision form <output> alongside it: ${JSON.stringify(seen.outputText)}`)
  console.log(`screenshot: ${shotFile}`)
  console.log(`elapsed ${Date.now() - started}ms`)
  console.log(problems.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${problems.join(' | ')}`)

  win.destroy()
  app.exit(problems.length === 0 ? 0 : 1)
}).catch(error => {
  console.error('harness error:', error?.stack || error)
  app.exit(2)
})
