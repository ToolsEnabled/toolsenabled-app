'use strict'
/* DOES START STAY ON SCREEN WHEN THE FORM IS TALLER THAN THE RAIL?
 *
 * The unit tests cannot answer this: a fake DOM has no layout, so it can prove
 * the button EXISTS and never that a person can SEE it. That gap is why the
 * owner's complaint survived a commit called "Start is reachable" -- the button
 * was in the scroller, ~100px below the fold, present and invisible.
 *
 * This measures the real stylesheet against the real panel structure inside a
 * rail-sized box, at window heights the owner actually uses. It deliberately
 * does NOT drive the app: the tree's empty slots only exist in live mode, which
 * needs the action bridge on the fenced 127.0.0.1:4610-4619 range. The layout
 * question is answerable without it, and the end-to-end proof belongs to
 * tools/agent-start-flow-qa.mjs against a packaged build.
 *
 * Run: npx electron tools/compose-start-layout-qa.cjs [--release <win-unpacked>]
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readComposeLayoutCss } = require('./lib/compose-layout-css.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
const check = (name, pass, detail) => { results.push({ name, pass: Boolean(pass), detail }) }
let overflowSizeCount = 0

/* The panel's real shape, in the order src/agent-compose-panel.js builds it:
   nav row, then the scrolling form, then the pinned action row and status. The
   form is loaded with the real number of fields so its height is honest. */
const PANEL_HTML = `
<div class="rail">
  <div class="rail-page compose-page is-active">
    <section class="agent-compose" data-agent-compose="open">
      <div class="rail-nav"><button class="ctl-btn" data-compose-action="cancel">Not now</button></div>
      <div class="rail-scroll agent-compose-body" data-compose-body="form">
        <p class="agent-compose-intro">Two answers and it runs.</p>
        <p class="agent-compose-under" data-compose-under="parent">Under Default 2</p>
        <div class="agent-compose-field"><label>What should it be?</label><p class="agent-compose-hint">Pick the role.</p><select class="agent-compose-select"><option>helper</option></select><p class="agent-compose-summary">A helper does one job.</p><p class="agent-compose-problem"></p></div>
        <div class="agent-compose-field"><label>Which assistant?</label><p class="agent-compose-hint">Luna is a good default. Claude cannot start from a tree yet; to use Claude, hand the work over on the agent page instead.</p><select class="agent-compose-select"><option>Luna</option></select></div>
        <div class="agent-compose-field"><label>How hard should it think?</label><p class="agent-compose-hint">Harder thinking is slower and costs more. The tier picks a sensible default; change it here for this agent.</p><select class="agent-compose-select"><option>Default</option></select></div>
        <div class="agent-compose-field"><label>What do you want it to do?</label><p class="agent-compose-hint">Write it the way you would ask a person. One clear job is enough to start.</p><textarea class="agent-compose-text" rows="4"></textarea><!-- height comes from the stylesheet min-height, matching the real panel --><p class="agent-compose-problem"></p></div>
        <p class="agent-compose-notice" hidden></p>
      </div>
      <div class="agent-compose-actions">
        <button class="ctl-btn agent-compose-set" type="button" data-compose-action="set">Set</button>
        <button class="ctl-btn agent-compose-start agent-compose-submit" type="button" data-compose-action="start">Start this agent</button>
      </div>
      <p class="agent-compose-status" data-compose-status="panel" hidden></p>
    </section>
  </div>
</div>`

const SIZES = [
  { label: '1600x900', width: 1600, height: 900 },
  { label: '1440x768', width: 1440, height: 768 },
  { label: '1280x720 (shortest)', width: 1280, height: 720 },
]

app.whenReady().then(async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-layout-qa-'))
  app.setPath('userData', path.join(outputDir, 'profile'))
  app.commandLine.appendSwitch('disable-gpu')
  app.on('window-all-closed', () => {})

  /* An explicit release is immutable evidence: read the stylesheet from that
     candidate's app.asar. With no override the development workflow retains
     its source dist/assets input. */
  const stylesheet = readComposeLayoutCss({ argv: process.argv, repoRoot: ROOT })
  const css = stylesheet.css
  process.stdout.write(`stylesheet: ${stylesheet.mode} ${stylesheet.origin} :: ${stylesheet.entry}\n`)
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>
    <style>html,body{margin:0;height:100%} .rail{position:relative;height:100%;width:380px;overflow:hidden}</style>
    </head><body>${PANEL_HTML}</body></html>`
  const pageFile = path.join(outputDir, 'panel.html')
  fs.writeFileSync(pageFile, page)

  for (const size of SIZES) {
    const window = new BrowserWindow({ width: size.width, height: size.height, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } })
    await window.loadFile(pageFile)
    await new Promise(resolve => setTimeout(resolve, 400))
    const measured = await window.webContents.executeJavaScript(`(() => {
      const rail = document.querySelector('.rail')
      const body = document.querySelector('[data-compose-body]')
      const set = document.querySelector('[data-compose-action="set"]')
      const start = document.querySelector('[data-compose-action="start"]')
      const message = document.querySelector('.agent-compose-text')
      const m = message.getBoundingClientRect()
      const r = rail.getBoundingClientRect()
      const s = start.getBoundingClientRect()
      const hit = document.elementFromPoint(Math.round(s.left + s.width / 2), Math.round(s.top + s.height / 2))
      return {
        railTop: Math.round(r.top), railBottom: Math.round(r.bottom), railHeight: Math.round(r.height),
        submitTop: Math.round(s.top), submitBottom: Math.round(s.bottom), submitHeight: Math.round(s.height),
        actions: [...document.querySelectorAll('.agent-compose-actions [data-compose-action]')].map(node => ({
          action: node.dataset.composeAction,
          classes: node.className,
          type: node.type,
        })),
        insideScroller: body.contains(start),
        formOverflows: body.scrollHeight > body.clientHeight + 1,
        formScrollHeight: body.scrollHeight, formClientHeight: body.clientHeight,
        visibleWithoutScrolling: s.top >= r.top - 1 && s.bottom <= r.bottom + 1 && s.height > 0,
        pressable: Boolean(hit && (hit === start || start.contains(hit))),
        messageTop: Math.round(m.top), messageBottom: Math.round(m.bottom),
        messageVisible: m.top < r.bottom && m.bottom > r.top,
        messageFullyVisible: m.top >= r.top - 1 && m.bottom <= r.bottom + 1,
        hitElement: hit ? (hit.className || hit.tagName) : null,
      }
    })()`)
    /* Not an individual pass/fail: whether the form overflows depends on the
       window, and a size where it fits is not a defect. At least one size must
       overflow, though, or this run never exercises the bug it claims to test. */
    process.stdout.write(`note  [${size.label}] form ${measured.formScrollHeight}px in ${measured.formClientHeight}px `
      + `-- ${measured.formOverflows ? 'OVERFLOWS: this size exercises the defect' : 'fits: this size does not exercise it'}\n`)
    if (measured.formOverflows) overflowSizeCount += 1
    check(`[${size.label}] Start is VISIBLE without scrolling`,
      measured.visibleWithoutScrolling === true,
      `submit ${measured.submitTop}..${measured.submitBottom} within rail ${measured.railTop}..${measured.railBottom}`)
    check(`[${size.label}] Start is PRESSABLE where it is drawn`,
      measured.pressable === true, measured.pressable ? 'the centre point reaches it' : `centre hits ${measured.hitElement}`)
    check(`[${size.label}] the message box is at least partly on screen at first paint`,
      measured.messageVisible === true,
      `message ${measured.messageTop}..${measured.messageBottom}, rail ${measured.railTop}..${measured.railBottom}` +
      (measured.messageFullyVisible ? ' (fully visible)' : ' (needs a scroll to see all of it)'))
    check(`[${size.label}] Start is pinned beside the scroller, not inside it`,
      measured.insideScroller === false, measured.insideScroller ? 'inside: it can fall below the fold again' : 'pinned')
    check(`[${size.label}] Set and Start keep the real panel order, classes and button type`,
      JSON.stringify(measured.actions) === JSON.stringify([
        { action: 'set', classes: 'ctl-btn agent-compose-set', type: 'button' },
        { action: 'start', classes: 'ctl-btn agent-compose-start agent-compose-submit', type: 'button' },
      ]),
      JSON.stringify(measured.actions))
    window.destroy()
  }

  check('at least one size exercises the below-the-fold defect',
    overflowSizeCount > 0,
    overflowSizeCount > 0
      ? `${overflowSizeCount}/${SIZES.length} sizes have a form taller than its scroller`
      : `the form fits at all ${SIZES.length} sizes, so visibility checks did not cover the defect`)

  let failed = 0
  let report = ''
  for (const result of results) {
    if (!result.pass) failed += 1
    report += `${result.pass ? 'ok  ' : 'FAIL'}  ${result.name}  --  ${result.detail}\n`
  }
  report += `\ncompose start layout: ${results.length - failed}/${results.length} checks\n`
  report += failed === 0 ? 'compose start layout: PASS\n' : 'compose start layout: FAIL\n'
  process.stdout.write(report)
  process.exitCode = failed === 0 ? 0 : 1
  app.quit()
}).catch(error => {
  process.stderr.write(`driver error: ${error && error.stack || error}\n`)
  process.exitCode = 2
  app.quit()
})
