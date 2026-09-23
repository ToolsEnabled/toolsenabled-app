#!/usr/bin/env node
/* ARE THE CHARTS BACK, AND IS EVERY MARK ON THEM SOMETHING THIS COMPUTER
 * ACTUALLY RECORDED?
 *
 * THE FINDING THIS ANSWERS, in the owner's words: "In metrics what happened to
 * all the charts and the pretty page we had worked so hard to make? Im glad its
 * connected now but you need to change the appearance back - although simulation
 * routing still seems to have the old version so im just confused whats
 * happening."
 *
 * Three separate claims are therefore measured here, and a green on one of them
 * is not a green on the others:
 *
 *   1. the measured face draws charts at all -- ECharts instruments, in the
 *      hosts the demonstration uses, on the page that reads this computer;
 *   2. every series on them traces back to the record. Read back from the
 *      engine's own option and compared, number for number, against what
 *      mcAgent.usage() and mcAgent.history() answer in the same window;
 *   3. a panel with nothing behind it is still a SENTENCE and not an empty
 *      pretty chart, and the Range control genuinely re-projects.
 *
 * And the fourth thing he asked for: that a person can tell the two faces apart
 * at a glance. Both are opened, through the product's own switch, pressed.
 *
 * WHAT IT DRIVES. A STAGED packaged build -- the same executable, the same
 * resources/capability, this tree's dist/ and shell/ overlaid by stage() in
 * tools/test-account-harness.mjs, on a scratch --user-data-dir this run deletes.
 * It NEVER touches the installed copy under %LOCALAPPDATA%\\Programs. Every
 * press below is a real CDP mouse or keyboard event at real coordinates with the
 * element under the point confirmed first: no el.click(), no dispatchEvent.
 *
 *   node tools/metrics-charts-live-drive.mjs [--visible] [--keep]
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  assertIsolated,
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
  writeEvidence,
} from './test-account-harness.mjs'

const TIER = 'luna'
/* The answer must not appear anywhere in the question, or an echo of the prompt
   would read as a reply and this run could not tell a real turn from none. */
const PROMPT = 'What is 12 multiplied by 13? Reply with only the number.'
const PROOF = '156'
if (PROMPT.includes(PROOF)) throw new Error('the answer is inside the question; this run could not tell an echo from a reply')

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* ------------------------------------------------------------------ input -- */

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') return { pressed: false, why: spot?.state || 'unknown' }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  }
  await delay(420)
  return { pressed: true, at: spot }
}

async function key(window, name, keyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode })
  }
  await delay(90)
}

/* A native <select> in an offscreen window takes arrow keys only after the popup
   its own click opened is dismissed with Escape. Measured by a sibling driver. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const opened = await press(window, selector)
  if (!opened.pressed) return { ok: false, why: `could not focus the menu: ${opened.why}` }
  await key(window, 'Escape', 27)
  for (let step = 0; step < maxPresses; step += 1) {
    const now = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
    if (now === wanted) return { ok: true }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `walked the menu ${maxPresses} times without reaching ${wanted}` }
}

async function typeReal(window, selector, text) {
  const pressed = await press(window, selector)
  if (!pressed.pressed) return { ok: false, why: pressed.why }
  await window.session.send('Input.insertText', { text })
  await delay(150)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
  return { ok: landed === text, landed }
}

/* PUT A TRAY-FIRST INSTRUMENT ON THE PAGE, the way the layout editor offers.
 *
 * The tray chip re-adds its component on Enter (src/metrics-layout.js), which is
 * the keyboard half of the drag it also supports. The ACTIVATION here is a real
 * CDP key event; only the focus that precedes it is scripted, because a click on
 * the chip starts a drag carry rather than activating it, and a drag is a
 * different question from the one this run is asking. */
async function placeFromTray(window, id) {
  const opened = await press(window, '#m-edit')
  if (!opened.pressed) return { ok: false, why: `the Edit layout button: ${opened.why}` }
  await delay(700)
  const focused = await window.evaluate(`(() => {
    const chip = document.querySelector('[data-chip=${JSON.stringify(id)}]')
    if (!chip) return false
    chip.focus()
    return document.activeElement === chip
  })()`)
  if (!focused) return { ok: false, why: 'no tray chip for it, or it would not take focus' }
  await key(window, 'Enter', 13)
  await delay(900)
  const closed = await press(window, '#m-edit')
  await delay(900)
  const onPage = await window.evaluate(`document.querySelector('.m-stash > [data-mc=${JSON.stringify(id)}]') === null`)
  if (!closed.pressed) return { ok: false, why: 'the layout editor would not close again' }
  return onPage ? { ok: true } : { ok: false, why: 'it is still in the tray after the key press' }
}

/* NAVIGATION IS BY CLICKING THE RING ARROW. A sibling harness reached its page
   by assigning location.hash and passed on a build where nothing routed there. */
async function walkTo(window, stop, limit = 12) {
  for (let step = 0; step < limit; step += 1) {
    const here = await window.evaluate(`(location.hash || '').replace('#/', '').split('/')[0] || 'home'`)
    if (here === stop) return { ok: true }
    const clicked = await press(window, '#nav-next', 6000)
    if (!clicked.pressed) return { ok: false, why: `the ring arrow: ${clicked.why}` }
    await delay(700)
  }
  return { ok: false, why: `never reached ${stop}` }
}

/* A HIDDEN WINDOW DOES NOT PAINT, AND A SCREENSHOT OF IT WAITS FOR EVER.
 *
 * MC_SMOKE_HEADLESS=1 makes the packaged shell open its window with
 * `show: false` (shell/window-options.cjs), which is what keeps a driver off
 * the owner's desktop. A window that is never shown produces no compositor
 * frames, so the ordinary Page.captureScreenshot -- which waits for one -- never
 * answers. Two things together make a hidden window yield an image, and both are
 * needed: the page is life-cycled back to `active`, and the capture is taken
 * from the RENDERER (`fromSurface: false`) rather than from the surface that is
 * not being composited. The race is kept anyway, so a build that still will not
 * paint costs this run nine seconds and a stated note rather than the run.
 */
async function shoot(window, directory, name) {
  try { await window.session.send('Emulation.setWebLifecycleState', { state: 'active' }) } catch { /* older build */ }
  try {
    await window.session.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    })
  } catch { /* older build */ }
  await delay(400)
  let data = null
  /* ONE COMBINATION IS KEPT AND THE OTHERS ARE NOT, because they were measured
     rather than guessed. `captureBeyondViewport` would have given the whole page
     in one image and on a hidden window it never answers -- nine seconds burnt
     per shot, eleven shots a run. The plain surface capture does not answer
     either. The renderer capture does, so the page is covered by scrolling to
     each band and shooting it, which is also how a person sees it. */
  for (const params of [{ format: 'png', fromSurface: false }, { format: 'png' }]) {
    const reply = await Promise.race([
      window.session.send('Page.captureScreenshot', params),
      delay(9000).then(() => null),
    ])
    data = reply?.result?.data
    if (data) break
  }
  if (!data) { note('info', `no frame came back for ${name}`); return null }
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  note('info', `screenshot ${name}.png (${Math.round(data.length * 0.75 / 1024)} kB)`)
  return file
}

/* --------------------------------------------------------------- reading -- */

/* WHAT THE MEASURED FACE IS SHOWING, read off the page and off the engine.
 *
 * `charts` comes from the measured engine's own probe hook, so the numbers below
 * are the numbers ECharts is drawing, not a second copy of the input. `record`
 * is what the two ledgers answer at the same instant, asked through the same
 * mcAgent channel the page uses. A claim is only made where those two agree. */
async function readFace(window) {
  return window.evaluate(`(async () => {
    const pad = document.querySelector('.view-pad')
    const root = document.querySelector('.metrics')
    if (!root) return { present: false }
    const charts = window.__mcLiveCharts || null
    const keys = ['hero', 'strip', 'sankey', 'fail', 'heat', 'verdict', 'burn']
    const series = {}
    for (const key of keys) series[key] = charts?.seriesOf ? charts.seriesOf(key) : null
    const svg = {}
    for (const [key, selector] of Object.entries({
      hero: '#hero-chart', strip: '#strip-chart', sankey: '#sankey-chart',
      fail: '#fail-chart', heat: '#heat-chart', verdict: '#verdict-live-chart',
      burn: '#burn-chart',
    })) {
      const host = document.querySelector(selector)
      svg[key] = {
        present: Boolean(host),
        hasSvg: Boolean(host?.querySelector('svg')),
        marks: host ? host.querySelectorAll('svg path, svg rect, svg polyline').length : 0,
        note: host?.querySelector('.m-panel-note')?.textContent?.trim()?.slice(0, 140) || null,
      }
    }
    /* THE DEMONSTRATION'S OWN ENGINE, asked the same way. Stage two of the mount
       is now shared by both faces, so a run that only proves the measured face
       draws could hide a demonstration that stopped drawing entirely. */
    const simCharts = window.__mcCharts
      ? Object.fromEntries(Object.entries(window.__mcCharts).map(([key, instance]) => {
          try {
            const option = instance.getOption()
            return [key, { series: (option.series || []).length, points: (option.series?.[0]?.data || []).length }]
          } catch { return [key, null] }
        }))
      : null
    let history = null
    let usage = null
    try { history = await window.mcAgent?.history?.({ limit: 200 }) } catch (error) { history = { error: String(error) } }
    try { usage = await window.mcAgent?.usage?.({ limit: 200 }) } catch (error) { usage = { error: String(error) } }
    return {
      present: true,
      face: root.dataset.face || null,
      liveMode: root.dataset.liveMode || null,
      chip: document.querySelector('#mf-face')?.textContent?.trim() || null,
      note: document.querySelector('#mf-note')?.textContent?.trim() || '',
      subs: Object.fromEntries(['#sankey-sub', '#tokens-sub', '#heat-sub', '#verdict-sub', '#fail-sub', '#burn-sub', '#table-sub', '#heartbeat-sub', '#gates-sub']
        .map(id => [id, document.querySelector(id)?.textContent?.trim() || null])),
      pills: {
        range: [...document.querySelectorAll('[data-group="range"] .pill')].map(p => \`\${p.dataset.v}\${p.classList.contains('on') ? '*' : ''}\`),
        machine: [...document.querySelectorAll('[data-group="machine"] .pill')].map(p => \`\${p.dataset.v}:\${p.textContent.trim()}\${p.classList.contains('on') ? '*' : ''}\`),
      },
      panelStates: Object.fromEntries([...root.querySelectorAll('[data-mc]')]
        .map(node => [node.dataset.mc, node.getAttribute('data-panel-state')])),
      panelNotes: [...root.querySelectorAll('.m-panel-note')].map(node => node.textContent.trim().slice(0, 130)),
      /* A legend told to hide, measured by whether a person can SEE it rather
         than by whether the attribute was set: the shared display rule for that
         class outranks the hidden attribute's own rule, so three severity chips
         stayed on screen over a panel that draws no percentages at all -- true
         of the attribute, false of the screen.
         NO BACKTICKS IN HERE. This comment lives inside a template literal that
         is evaluated in the page, and a backtick closes it -- which is exactly
         how the first version of this note turned the whole driver into a
         syntax error. */
      hiddenLegendsStillVisible: [...root.querySelectorAll('.chart-legend[hidden]')]
        .filter(node => node.getBoundingClientRect().height > 0)
        .map(node => node.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)),
      legend: [...root.querySelectorAll('.token-legend .ck')]
        .map(node => \`\${node.querySelector('.ck-name')?.textContent?.trim()}=\${node.querySelector('.ck-value')?.textContent?.trim()}\`),
      outcomeLegend: [...root.querySelectorAll('.m-outcome-legend li')]
        .map(node => \`\${node.querySelector('span')?.textContent?.trim()}=\${node.querySelector('b')?.textContent?.trim()}\`),
      runRows: [...root.querySelectorAll('#agent-table tbody tr')].map(row =>
        [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())),
      series,
      simCharts,
      svg,
      record: {
        runs: Array.isArray(history?.entries) ? history.entries.length : null,
        usageTurns: Array.isArray(usage?.entries) ? usage.entries.length : null,
        usageRows: Array.isArray(usage?.entries)
          ? usage.entries.map(entry => ({
              at: entry.at,
              tier: entry.usage?.tier || null,
              basis: entry.usage?.basis || null,
              total: entry.usage?.totalTokens ?? null,
              input: entry.usage?.inputTokens ?? null,
              output: entry.usage?.outputTokens ?? null,
            }))
          : null,
        runRows: Array.isArray(history?.entries)
          ? history.entries.map(entry => ({ at: entry.at, action: entry.action, outcome: entry.outcome }))
          : null,
      },
      pageWiderThanWindow: pad ? pad.scrollWidth > pad.clientWidth + 2 : null,
      oldRefusalOnScreen: (root.innerText || '').includes('No local agent fleet host detected'),
    }
  })()`)
}

const drawn = (face, key) => Boolean(face?.series?.[key]?.length) && face.svg[key]?.hasSvg && face.svg[key]?.marks > 0

/* Every number a series is drawing, flattened -- a line's plain values, a
   heatmap's third column, a stacked bar's single figure. */
function seriesNumbers(series) {
  const out = []
  for (const one of series || []) {
    for (const point of one.data || []) {
      if (typeof point === 'number') out.push(point)
      else if (Array.isArray(point)) out.push(point[point.length - 1])
      else if (point && typeof point === 'object' && typeof point.value === 'number') out.push(point.value)
    }
  }
  return out
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

/* ------------------------------------------------------------------ run -- */

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'metrics-charts-'))
  const shots = path.join(scratch, 'shots')
  let window = null
  try {
    console.log('staging the packaged build (never the installed copy)...')
    const staged = await stage(scratch)

    /* The Codex sign-in is LENT to the scratch profile, as the sibling drivers
       lend it: openWindow redirects CODEX_HOME into this temporary directory, so
       a child started under it would otherwise look for a sign-in in a home that
       has never had one. The copy lives only in the directory this run deletes. */
    const realCodex = path.join(process.env.USERPROFILE || '', '.codex', 'auth.json')
    if (!existsSync(realCodex)) {
      note('FAIL', 'HARNESS STATE: this computer has no Codex sign-in to lend, so no real turn could be caused and nothing below would be a measurement.')
      return
    }
    const scratchCodex = path.join(scratch, 'home', '.codex')
    mkdirSync(scratchCodex, { recursive: true })
    cpSync(realCodex, path.join(scratchCodex, 'auth.json'))
    const realNpm = path.join(process.env.APPDATA || '', 'npm')
    if (existsSync(realNpm)) {
      mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
      try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* already linked */ }
    }

    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)
    const prefs = assertIsolated(scratch)
    note('ok', `this run wrote to its own profile, measured: ${prefs}`)

    /* ------------------------------------------------------- [1] nothing yet */
    console.log('\n[1] the measured metrics page on a profile where nothing has run')
    const reached = await walkTo(window, 'metrics')
    note(reached.ok ? 'ok' : 'FAIL', `walked the ring to #/metrics by pressing the arrow${reached.ok ? '' : `: ${reached.why}`}`)
    if (!reached.ok) return
    await delay(2400)
    const before = await readFace(window)
    if (!before.present) { note('FAIL', 'there is no metrics surface on the metrics route'); return }
    await shoot(window, shots, '1-measured-empty')

    note(before.face === 'this-computer' ? 'ok' : 'FAIL',
      `the page names itself: chip=${JSON.stringify(before.chip)} face=${JSON.stringify(before.face)}`)
    const emptyCharts = ['hero', 'strip', 'sankey', 'fail', 'heat', 'verdict', 'burn'].filter(key => drawn(before, key))
    note(emptyCharts.length === 0 ? 'ok' : 'FAIL',
      emptyCharts.length === 0
        ? 'with nothing recorded, not one chart is drawn -- every panel is a sentence'
        : `these drew a chart over an empty record: ${JSON.stringify(emptyCharts)}`)
    note(before.panelNotes.length > 0 ? 'ok' : 'FAIL',
      `${before.panelNotes.length} panels explain themselves in words, e.g. ${JSON.stringify(before.panelNotes[0] || '')}`)
    note(before.oldRefusalOnScreen ? 'FAIL' : 'ok',
      before.oldRefusalOnScreen ? 'the fleet-host refusal is on the page' : 'the fleet-host refusal is nowhere on the page')
    note(before.pills.machine.length === 1 ? 'ok' : 'FAIL',
      `the computer control offers ${JSON.stringify(before.pills.machine)}`)

    /* --------------------------------------------------------- [2] real work */
    console.log('\n[2] causing a REAL Codex turn, so there is something to draw')
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    const toComputers = await walkTo(window, 'computers')
    note(toComputers.ok ? 'ok' : 'FAIL', `walked to #/computers${toComputers.ok ? '' : `: ${toComputers.why}`}`)
    if (!toComputers.ok) return
    await window.evaluate('location.reload()')
    await delay(3600)

    const doorway = await press(window, '.computers .tree-empty-node')
    note(doorway.pressed ? 'ok' : 'FAIL', `pressed the way in${doorway.pressed ? '' : `: ${doorway.why}`}`)
    if (!doorway.pressed) return
    await delay(2400)

    const tier = await chooseByKeyboard(window, '[data-compose-field="tier"]', TIER)
    note(tier.ok ? 'ok' : 'FAIL', `chose ${TIER} with real arrow keys${tier.ok ? '' : `: ${tier.why}`}`)
    if (!tier.ok) return
    const firstRole = await window.evaluate(`(() => {
      const node = document.querySelector('[data-compose-field="role"]')
      if (!node) return null
      return [...node.options].map(o => o.value).find(v => v && v.length > 0) || null
    })()`)
    if (!firstRole) { note('FAIL', 'the panel offers no role, and the form will not start without one'); return }
    const role = await chooseByKeyboard(window, '[data-compose-field="role"]', firstRole)
    note(role.ok ? 'ok' : 'FAIL', `chose a role${role.ok ? '' : `: ${role.why}`}`)
    if (!role.ok) return
    const typed = await typeReal(window, '[data-compose-field="message"]', PROMPT)
    note(typed.ok ? 'ok' : 'FAIL', `typed the question with real keystrokes: ${JSON.stringify(typed.landed || typed.why)}`)
    if (!typed.ok) return

    const startTarget = await window.evaluate(`(() => {
      const visible = node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node)
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
      const button = [...document.querySelectorAll('button')].filter(visible).find(node => /^start/i.test(node.textContent.trim()))
      if (!button) return null
      if (!button.id) button.id = 'metrics-charts-drive-start'
      return { selector: '#' + button.id, label: button.textContent.trim().slice(0, 40) }
    })()`)
    if (!startTarget) { note('FAIL', 'there is no Start control on the panel'); return }
    const started = await press(window, startTarget.selector)
    note(started.pressed ? 'ok' : 'FAIL', `pressed ${JSON.stringify(startTarget.label)}${started.pressed ? '' : `: ${started.why}`}`)
    if (!started.pressed) return

    console.log('\n[3] waiting for a real answer, which is what writes the usage record')
    const deadline = Date.now() + 200_000
    let heard = null
    for (;;) {
      heard = await window.evaluate(`(() => {
        const inField = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
        const isEcho = node => String(node.textContent || '').includes(${JSON.stringify(PROMPT)})
        const spoken = [...document.querySelectorAll('*')]
          .filter(node => node.children.length === 0
            && (node.textContent || '').includes(${JSON.stringify(PROOF)})
            && !inField(node) && !isEcho(node))
          .map(node => String(node.textContent || '').trim().slice(0, 90))
        const text = (document.querySelector('.computers') || document.body).innerText || ''
        return {
          hasProof: spoken.length > 0, spokenIn: spoken.slice(0, 2),
          refusals: [...document.querySelectorAll('[data-refusal-code]')].map(n => n.getAttribute('data-refusal-code')),
          notLoggedIn: /Not logged in|Please run \\/login/.test(text),
          tail: text.slice(-260),
        }
      })()`)
      if (heard?.hasProof || heard?.refusals?.length || heard?.notLoggedIn || Date.now() > deadline) break
      await delay(2500)
    }
    if (heard?.hasProof) note('ok', `a real Codex agent answered: ${JSON.stringify(heard.spokenIn)}`)
    else if (heard?.refusals?.length) note('FAIL', `the start was refused: ${JSON.stringify(heard.refusals)}`)
    else if (heard?.notLoggedIn) note('FAIL', 'the lent Codex sign-in was not accepted by the child')
    else note('FAIL', `no answer inside the budget · ${JSON.stringify(heard?.tail)}`)
    /* The turn record is written when the turn completes; give the fan-out a
       moment to reach the ledger before the page is asked what it can see. */
    await delay(4000)

    /* ------------------------------------------------- [4] the charts return */
    console.log('\n[4] the same page, after work this file caused')
    const back = await walkTo(window, 'metrics')
    note(back.ok ? 'ok' : 'FAIL', `walked back to #/metrics${back.ok ? '' : `: ${back.why}`}`)
    if (!back.ok) return
    await delay(3000)
    const after = await readFace(window)
    await shoot(window, shots, '2-measured-24h')
    /* AND EVERY BAND OF IT, one shot each, scrolled the way a person scrolls.
       This is not decoration and it is not for the log: the first version of
       this change passed every assertion below while drawing the routing panel
       as a full-height grey slab, and the only thing that caught it was looking
       at the picture. A run that measures a page it never looked at can only
       report the things it thought to assert. */
    for (const band of ['sankey', 'tokenflow', 'heatmap', 'verdicts', 'lanes', 'pools', 'agents', 'heartbeat', 'burn', 'gates']) {
      const found = await window.evaluate(`(() => {
        const node = document.querySelector('[data-mc=${JSON.stringify(band)}]')
        if (!node) return false
        node.scrollIntoView({ block: 'start' })
        return true
      })()`)
      if (!found) { note('info', `no ${band} band on the page`); continue }
      await delay(650)
      await shoot(window, shots, `band-${band}`)
    }
    await window.evaluate('window.scrollTo(0, 0)')
    await delay(500)

    const chartKeys = ['hero', 'strip', 'sankey', 'fail', 'heat', 'verdict', 'burn']
    const drawnNow = chartKeys.filter(key => drawn(after, key))
    note(drawnNow.length >= 4 ? 'ok' : 'FAIL',
      `charts drawn on the measured page: ${JSON.stringify(drawnNow)} (${drawnNow.length} of ${chartKeys.length})`)
    for (const key of chartKeys) {
      const state = after.svg[key]
      note('info', `${key}: svg=${state.hasSvg} marks=${state.marks}${state.note ? ` note=${JSON.stringify(state.note)}` : ''}`)
    }

    /* ---- the trace: every token on the chart is a token in the record ---- */
    const recorded = (after.record.usageRows || [])
      .filter(row => row.basis !== 'session-total' && typeof row.total === 'number')
    const recordedTokens = sum(recorded.map(row => row.total))
    const heroTokens = sum(seriesNumbers(after.series.hero))
    note(recordedTokens > 0 ? 'ok' : 'FAIL',
      `the usage ledger holds ${after.record.usageTurns} turn(s), ${recordedTokens} tokens outside cumulative rows`)
    note(heroTokens === recordedTokens ? 'ok' : 'FAIL',
      heroTokens === recordedTokens
        ? `the token bands draw exactly the recorded tokens: ${heroTokens} = ${recordedTokens}`
        : `the token bands draw ${heroTokens} against ${recordedTokens} in the record`)
    /* POOL BURN IS A TRAY-FIRST INSTRUMENT. The standard layout leaves it in the
       off-screen tray, and the measured face deliberately builds no chart for a
       panel nobody has placed -- so "no burn chart" here is the rule working,
       not the panel failing. Both halves are measured: cold in the tray, drawn
       the moment a person puts it on the page. */
    note(after.series.burn === null ? 'ok' : 'info',
      after.series.burn === null
        ? 'pool burn is in the tray and draws nothing there, so no hidden chart is running'
        : 'pool burn is already on the page')
    const placed = await placeFromTray(window, 'burn')
    note(placed.ok ? 'ok' : 'FAIL', `put Pool burn on the page from the tray${placed.ok ? '' : `: ${placed.why}`}`)
    const withBurn = placed.ok ? await readFace(window) : after
    await shoot(window, shots, 'band-burn-placed')
    const burnTokens = sum(seriesNumbers(withBurn.series.burn))
    note(burnTokens === recordedTokens ? 'ok' : 'FAIL',
      `once placed, the burn trace draws ${burnTokens} against ${recordedTokens} recorded`)
    const stripTurns = sum(seriesNumbers(after.series.strip))
    note(stripTurns === recorded.length ? 'ok' : 'FAIL',
      `the turn strip draws ${stripTurns} turn(s) against ${recorded.length} recorded in this window`)
    const heatRuns = sum(seriesNumbers(after.series.heat))
    /* The run ledger writes two lines per run (one before the child is spawned,
       one for its outcome), so the page's own count is what this is compared
       against rather than the raw line count. */
    note(heatRuns >= 1 ? 'ok' : 'FAIL', `the activity heatmap draws ${heatRuns} run(s) in its cells`)
    const sankeyLinks = after.series.sankey?.[0]?.data?.length ?? 0
    note('info', `token routing nodes drawn: ${sankeyLinks}; sub-heading ${JSON.stringify(after.subs['#sankey-sub'])}`)
    note('info', `token legend chips: ${JSON.stringify(after.legend)}`)
    note('info', `outcome legend: ${JSON.stringify(after.outcomeLegend)}`)

    note(after.hiddenLegendsStillVisible.length === 0 ? 'ok' : 'FAIL',
      after.hiddenLegendsStillVisible.length === 0
        ? 'no legend that was told to hide is still on the screen'
        : `these legends were hidden and are still visible: ${JSON.stringify(after.hiddenLegendsStillVisible)}`)

    /* ---- panels with no measured source say so, and are not charts ---- */
    note(after.panelStates.heartbeat === 'not-measured' ? 'ok' : 'FAIL',
      `machine heartbeat is stated as unmeasured: ${JSON.stringify(after.subs['#heartbeat-sub'])}`)
    note(after.panelStates.gates === 'not-measured' ? 'ok' : 'FAIL',
      `gates and checkpoints are stated as unmeasured: ${JSON.stringify(after.subs['#gates-sub'])}`)

    /* -------------------------------------------- [5] the Range control works */
    console.log('\n[5] pressing 7d, with a real click on the pill')
    const before7d = JSON.stringify(after.series.hero)
    const pressed7d = await press(window, '[data-group="range"] .pill[data-v="7d"]')
    note(pressed7d.pressed ? 'ok' : 'FAIL', `pressed the 7d pill${pressed7d.pressed ? '' : `: ${pressed7d.why}`}`)
    await delay(1600)
    const week = await readFace(window)
    await shoot(window, shots, '3-measured-7d')
    const buckets24 = after.series.hero?.[0]?.data?.length ?? 0
    const buckets7d = week.series.hero?.[0]?.data?.length ?? 0
    note(buckets7d !== buckets24 && buckets7d > 0 ? 'ok' : 'FAIL',
      `the token band re-projected: ${buckets24} bucket(s) at 24h, ${buckets7d} at 7d`)
    note(JSON.stringify(week.series.hero) !== before7d ? 'ok' : 'FAIL',
      'the drawn series changed when the range changed')
    note(week.subs['#tokens-sub'] !== after.subs['#tokens-sub'] ? 'ok' : 'FAIL',
      `the sub-heading follows the control: ${JSON.stringify(after.subs['#tokens-sub'])} -> ${JSON.stringify(week.subs['#tokens-sub'])}`)
    note(week.note !== after.note ? 'ok' : 'FAIL',
      `the line under the filter row names the window: ${JSON.stringify(week.note.slice(0, 90))}`)

    /* ------------------------------------------- [6] the other face, and back */
    console.log('\n[6] switching to the demonstration through the product’s own control')
    const gear = await press(window, '#nav-settings, .nav-gear, [data-drawer-open]', 4000)
    if (!gear.pressed) {
      const opened = await window.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(node => /settings|gear/i.test(node.getAttribute('aria-label') || ''))
        if (!button) return null
        if (!button.id) button.id = 'metrics-charts-drive-gear'
        return '#' + button.id
      })()`)
      if (opened) {
        const second = await press(window, opened)
        note(second.pressed ? 'ok' : 'FAIL', `opened the quick settings drawer${second.pressed ? '' : `: ${second.why}`}`)
      } else {
        note('FAIL', 'no quick-settings control could be found to press')
      }
    } else {
      note('ok', 'opened the quick settings drawer with a real press')
    }
    await delay(900)
    /* THE CHECKBOX ITSELF IS NOT WHAT A PERSON PRESSES. It is the accessible
       control behind a drawn switch, at zero opacity, so a harness that aims at
       the input is aiming at something nobody can see -- and the shared visible
       check rightly refuses it. The `<i>` beside it IS the switch, and a press
       on it reaches the input the way the label does for a person. */
    const flipped = await press(window, 'input[data-quick-live="metrics"] + i', 6000)
    note(flipped.pressed ? 'ok' : 'FAIL', `pressed the live-data switch${flipped.pressed ? '' : `: ${flipped.why}`}`)
    const flippedTo = await window.evaluate(`document.querySelector('input[data-quick-live=\"metrics\"]')?.checked ?? null`)
    note(flippedTo === false ? 'ok' : 'FAIL', `the switch is now ${JSON.stringify(flippedTo)}, so the page should be the demonstration`)
    /* The drawer sits over the page it changed; close it the way it opened. */
    await key(window, 'Escape', 27)
    await delay(2600)
    const demo = await readFace(window)
    await shoot(window, shots, '4-demonstration')
    note(demo.face === 'demonstration' ? 'ok' : 'FAIL',
      `the other face names itself: chip=${JSON.stringify(demo.chip)} face=${JSON.stringify(demo.face)}`)
    const saysLive = /\blive\b/i.test(demo.note)
    note(saysLive ? 'FAIL' : 'ok',
      saysLive
        ? `the demonstration still calls itself live: ${JSON.stringify(demo.note)}`
        : `the demonstration says what it is: ${JSON.stringify(demo.note.slice(0, 90))}`)
    note(demo.chip !== week.chip ? 'ok' : 'FAIL',
      `the two faces are labelled differently: ${JSON.stringify(week.chip)} vs ${JSON.stringify(demo.chip)}`)
    note(demo.pills.machine.length > 1 ? 'ok' : 'FAIL',
      `the demonstration keeps its ${demo.pills.machine.length} machine pills: ${JSON.stringify(demo.pills.machine)}`)
    /* THE HOIST MUST NOT HAVE COST THE DEMONSTRATION ITS OWN CHARTS. Its engine
       is built in the same shared frame the measured one is now built in, so
       this is the regression that change could cause. */
    const simDrawn = demo.simCharts
      ? Object.entries(demo.simCharts).filter(([, state]) => (state?.points || 0) > 0).map(([key]) => key)
      : []
    note(simDrawn.length >= 5 ? 'ok' : 'FAIL',
      `the demonstration's own instruments still draw: ${JSON.stringify(simDrawn)}`)
    note('info', `demonstration engine detail: ${JSON.stringify(demo.simCharts)}`)

    note(week.pageWiderThanWindow === false ? 'ok' : 'FAIL',
      `the measured page does not scroll sideways: ${week.pageWiderThanWindow}`)

    writeEvidence(scratch, 'metrics-charts.json', JSON.stringify({ before, after, week, demo, heard }, null, 2))
    console.log(`\nevidence: ${path.join(scratch, 'metrics-charts.json')}`)
    console.log(`screenshots: ${shots}`)
  } finally {
    if (window) {
      await Promise.race([closeWindow(window), delay(12_000)])
      reap(window.timeline?.pid)
    }
    const failed = findings.some(finding => finding.level === 'FAIL')
    console.log(`\n${failed ? 'RED' : 'GREEN'} · ${findings.filter(f => f.level === 'FAIL').length} failing of ${findings.length} notes`)
    if (!failed && !process.argv.includes('--keep')) rmSync(scratch, { recursive: true, force: true })
    else console.log(`kept the profile at ${scratch}`)
    process.exitCode = failed ? 1 : 0
  }
}

await main()
