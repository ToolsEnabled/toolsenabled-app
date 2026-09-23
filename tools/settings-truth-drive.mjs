#!/usr/bin/env node
/* THE SETTINGS PAGE AFTER SEVENTY-FOUR ROWS WERE REMOVED, DRIVEN.
 *
 * 74 of the page's 96 rows wrote a `mc.set.<id>` key that nothing read. They are
 * gone, and six section headings went with them. That is the largest visible
 * change of the night and it is not a thing tests can accept: a person SEES it,
 * and the failure mode is not "a control is missing" but "the page now looks
 * broken rather than deliberate".
 *
 * SO THIS ASKS THREE QUESTIONS OF THE PACKAGED BUILD, WITH A REAL MOUSE.
 *
 *   1  IS ANYTHING LEFT THAT DOES NOTHING? Every control the page draws is
 *      enumerated from the DOM -- not from the source -- and checked against the
 *      set of rows that genuinely act. A row on the glass that is not in that
 *      set is the defect this whole change exists to remove, and finding one
 *      here means the source-level guard missed a rendering path.
 *
 *   2  DOES WHAT REMAINS STILL WORK? Removing 74 lies is only worth anything if
 *      the 22 survivors are true. Each one is pressed and its effect looked for
 *      in the document -- the theme attribute, the zoom, the --glow property,
 *      the reduce-motion class, the stored key -- rather than in whether the
 *      control moved. A switch that moves is what a dead row also did.
 *
 *   3  DOES IT LOOK DELIBERATE? Screenshots at 1024, 1440 and 1920, plus a count
 *      of rows under every heading. A section thin enough to read as broken is
 *      reported by name, and an EMPTY heading is a failure: a person opening a
 *      group cannot tell an empty section from one that did not load.
 *
 * It never presses the uninstall row's "Remove everything", and it never runs an
 * installer. The build is staged by copying release/win-unpacked and overlaying
 * this tree's dist/ and shell/, which is what every packaged driver here does.
 *
 *   node tools/settings-truth-drive.mjs [--visible]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  VISIBLE, closeDrawer, closeWindow, createLedger, delay, openWindow,
  scratchDirectory, seedMachineRecord, stage, writeEvidence,
} from './test-account-harness.mjs'

/* THE ROWS THAT GENUINELY ACT, and the evidence each one leaves. Written as a
   question about the DOCUMENT, never about the control: "the switch moved" is
   exactly what all 74 dead rows also did, so a check that accepts it accepts
   them back. */
const ALIVE = Object.freeze({
  theme: 'the document theme attribute',
  ui_font: 'the --font-ui custom property',
  text_size: 'the body zoom',
  glow: 'the --glow custom property',
  reduce_motion: 'the reduce-motion class on the body',
  scenario_tick_rate: 'the sim pace, stored and re-applied at launch',
  ledger_archive: 'a button that previews an archive rather than a stored value',
  uninstall_data: 'read by shell/uninstall-retention.cjs at uninstall',
})
const ALIVE_PREFIXES = ['live_', 'write_']

const isAlive = id => Object.prototype.hasOwnProperty.call(ALIVE, id)
  || ALIVE_PREFIXES.some(prefix => id.startsWith(prefix))
  /* The five rows the installed application enforces. They are not `mc.set.`
     rows at all -- the shell writes them beside the program -- so they are named
     by their dotted ids. */
  || id.includes('.')

const WIDTHS = [1024, 1440, 1920]

/* SCREENSHOTS ARE BEST-EFFORT, AND THE TIMEOUT IS THE WHOLE REASON THIS WORKS.
 *
 * Under MC_SMOKE_HEADLESS a window that is not compositing answers
 * Page.captureScreenshot with silence rather than an error --
 * Page.setWebLifecycleState('active') is what usually wakes it, and usually is
 * not always: measured on this build, a run with the test suite competing for
 * the CPU produced one shot and then hung indefinitely on the next.
 *
 * A CDP call with no deadline turns that into a dead process with no output,
 * which is the worst possible failure mode here -- it reads as the PRODUCT
 * hanging. So the shot is raced against a timer and a miss is reported as a
 * miss. The structural findings do not depend on it; a lost frame must not cost
 * the run, and it must never be silent. */
async function shoot(window, scratch, name, timeoutMs = 20_000) {
  /* RETRIED, BECAUSE A LOST FRAME IS USUALLY A COMPOSITOR THAT HAS NOT WOKEN
     YET. Measured across three widths: the shot succeeded at 1440 and was lost
     at 1024 and 1920, and the difference is whether the surface had produced a
     frame since the metrics override changed. Nudging the scroll position
     dirties the surface, which is what actually makes the next frame arrive. */
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older build */ }
    if (attempt > 1) {
      await window.evaluate(`(() => { window.scrollBy(0, ${attempt % 2 ? 1 : -1}); return true })()`)
    }
    await delay(attempt === 1 ? 400 : 1200)
    let packet = null
    try {
      packet = await Promise.race([
        window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
        new Promise(resolve => setTimeout(() => resolve({ __timedOut: true }), timeoutMs)),
      ])
    } catch (error) {
      console.log(`  --    shot ${name}: captureScreenshot threw ${error?.message || error}`)
      return null
    }
    if (packet?.result?.data) {
      const file = path.join(scratch, `${name}.png`)
      writeFileSync(file, Buffer.from(packet.result.data, 'base64'))
      return file
    }
    console.log(`  --    shot ${name}: no frame on attempt ${attempt}${packet?.__timedOut ? ` (timed out at ${timeoutMs}ms)` : ''}`)
  }
  /* Said out loud, never swallowed. A run that quietly produced no image would
     let a reader assume a screenshot was looked at when none exists. */
  console.log(`  --    shot ${name}: NO FRAME CAPTURED after 3 attempts -- do not claim this width was seen`)
  return null
}

/* THE REAL WINDOW IS RESIZED, NOT AN EMULATED VIEWPORT, and the difference is
 * the difference between evidence and an impression.
 *
 * Emulation.setDeviceMetricsOverride changes what the DOM measures and does NOT
 * change the native window surface. Page.captureScreenshot with
 * `fromSurface: true` photographs that surface -- so an "at 1920" image taken
 * after a metrics override shows whatever size the window actually is, and can
 * disagree with the numbers read in the same breath. `fromSurface: false` is
 * worse: under MC_SMOKE_HEADLESS it never returns at all, a dead path rather
 * than a slow one.
 *
 * Browser.setWindowBounds moves the real edges, so the picture and the
 * measurement are of the same thing. It is also what a person does: they drag a
 * window edge, they do not emulate a device. */
async function resize(window, width, height = 900) {
  /* PREFERRED: move the real edges. MEASURED on this build, headless Electron:
     Browser.getWindowForTarget answers with no windowId, so this route is not
     available here and the emulation fallback is what actually runs. The
     attempt stays because a visible run (--visible) may well support it, and
     because the log has to say WHICH route was used -- the two are not equally
     trustworthy and a reader must not have to guess. */
  let real = false
  try {
    const packet = await window.session.send('Browser.getWindowForTarget', {})
    const windowId = packet?.result?.windowId
    if (windowId !== undefined) {
      await window.session.send('Browser.setWindowBounds', {
        windowId, bounds: { width, height, windowState: 'normal' },
      })
      real = true
    }
  } catch { /* not supported on this target */ }

  if (!real) {
    await window.session.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    })
  }
  await delay(1100)
  const seen = await window.evaluate('({ w: window.innerWidth, h: window.innerHeight })')
  const how = real ? 'real window bounds' : 'EMULATED viewport'
  console.log(`  --    resize ${width}x${height} via ${how}; the page reports ${seen?.w}x${seen?.h}`)
  /* THE CAVEAT THAT MUST TRAVEL WITH THE PICTURE. Page.captureScreenshot
     photographs the native surface. Under an emulated viewport that surface was
     never resized, so the IMAGE can disagree with the numbers measured beside
     it -- measured here at 1920, where the DOM reported no horizontal overflow
     while the image showed the segmented controls clipped at the right edge.
     The structural readings below are trustworthy either way; the picture, on
     the emulated path, is only an indication. */
  return { real, innerWidth: seen?.w ?? null }
}

/* Every group opened, because the page ships them collapsed and a run that
   measured the collapsed page would report six headings and no controls -- which
   is a real defect this product already had, and not the one being measured. */
async function openEveryGroup(window) {
  return window.evaluate(`(() => {
    const heads = [...document.querySelectorAll('button[data-group-toggle]')]
    for (const head of heads) if (head.getAttribute('aria-expanded') !== 'true') head.click()
    return heads.length
  })()`)
}

/* EVERY ROW, NOT ONLY THE ONES CARRYING data-setting-id. Measured: keying on
   that attribute reported Home screen, Setup and System as EMPTY HEADINGS,
   because those three sections are drawn by their own modules and mark their
   rows with data-chatbox-row, data-setup-profile-row, or nothing at all. A
   detector that called three populated sections empty would have manufactured
   the exact defect this run exists to look for. The class settings-row is what
   every section genuinely shares.

   NOTE FOR ANYONE EDITING THE PAGE SCRIPT BELOW: it is a template literal, so a
   backtick inside it -- including inside a comment -- ends the string and the
   module fails to parse. Prose about this code belongs out here. */
async function readPage(window) {
  return window.evaluate(`(() => {
    const sections = [...document.querySelectorAll('.settings-section')].map(node => ({
      title: node.querySelector('.settings-section-title')?.textContent?.trim() || '(untitled)',
      rows: [...node.querySelectorAll('.settings-row')].map(row => ({
        id: row.dataset.settingId || row.dataset.chatboxRow || row.dataset.setupProfileRow || '(module row)',
        /* WHICH ROWS THIS RUN IS ENTITLED TO JUDGE. Only a row carrying
           data-setting-id came out of the SETTINGS catalogue and stores under
           mc.set.<id>; that is the population the dead-row question is about.
           The chat box and Setup sections keep their own stores and mark rows
           with their own attributes, and judging those by this rule reported
           twelve working controls as dead. */
        declared: Boolean(row.dataset.settingId),
        name: row.querySelector('.settings-name')?.textContent?.trim() || '',
        control: row.querySelector('.settings-seg') ? 'seg'
          : row.querySelector('.settings-toggle') ? 'toggle'
          : row.querySelector('input[type=range]') ? 'range'
          : row.querySelector('.settings-stepper') ? 'stepper'
          : row.querySelector('button[data-setting-action]') ? 'action'
          : 'none',
      })),
    }))
    return {
      footer: document.querySelector('.settings-footer')?.textContent?.trim()
        || [...document.querySelectorAll('*')].map(n => n.textContent)
             .find(t => t && /settings · .* shown/.test(t))?.trim() || '(no footer)',
      groups: [...document.querySelectorAll('button[data-group-toggle]')].map(b => ({
        id: b.dataset.groupToggle,
        label: b.textContent.trim().slice(0, 60),
      })),
      sections,
      totalRows: document.querySelectorAll('.settings-row').length,
      declaredRows: document.querySelectorAll('[data-setting-id]').length,
      /* IS ANYTHING CUT OFF? ASKED OF THE LAYOUT, NOT OF A PHOTOGRAPH.
         The 1920 screenshot showed the segmented controls clipped mid-word
         ("Every agent" -> "Every") while the DOM reported no horizontal
         overflow, and the two could not both be true. A picture taken through
         an emulated viewport cannot settle that; element rectangles can, and
         they are what the emulation genuinely changes. Every control is
         measured against the viewport, so a control running past the right edge
         is reported as a number rather than as an impression. */
      clipped: [...document.querySelectorAll('.settings-row .settings-control, .settings-row .seg, .settings-row .settings-seg, .settings-row .settings-stepper, .settings-row .settings-range')]
        .map(node => {
          const box = node.getBoundingClientRect()
          const row = node.closest('.settings-row')
          return {
            row: row?.dataset?.settingId || row?.dataset?.chatboxRow || row?.dataset?.setupProfileRow || '(row)',
            right: Math.round(box.right),
            left: Math.round(box.left),
          }
        })
        .filter(item => item.right > document.documentElement.clientWidth + 1 || item.left < -1),
      viewport: document.documentElement.clientWidth,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  })()`)
}

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('settings-truth')
  mkdirSync(scratch, { recursive: true })
  const profile = path.join(scratch, 'profile')
  mkdirSync(profile, { recursive: true })

  const { executable, appRoot } = await stage(scratch)
  if (!existsSync(executable)) throw new Error(`no executable at ${executable}`)
  seedMachineRecord(profile, appRoot, 'standard')

  /* NO `--headless=new` HERE, and that is a measured correction rather than a
     tidy-up. environmentFor() in the harness already sets MC_SMOKE_HEADLESS=1
     for a non-`--visible` run, which is how every driver in this repo goes
     headless. Passing Chromium's own flag as well produced a process tree with
     a renderer and a gpu-process and no debuggable page target: the run hung in
     openWindow for nine minutes with no output and would have read as a
     product timeout rather than a harness mistake. */
  const window = await openWindow(executable, profile)
  try {
    await window.evaluate(`location.hash = '#/settings'`)
    await delay(1600)
    await closeDrawer(window)

    const opened = await openEveryGroup(window)
    ledger.note(`opened ${opened} settings groups`)
    await delay(900)

    const findings = { widths: {}, deadOnGlass: [], emptyHeadings: [], thinSections: [] }

    for (const width of WIDTHS) {
      await resize(window, width)
      const page = await readPage(window)
      const shot = await shoot(window, scratch, `settings-${width}`)
      findings.widths[width] = {
        footer: page.footer, totalRows: page.totalRows, viewport: page.viewport,
        horizontalOverflow: page.horizontalOverflow, clipped: page.clipped, shot,
      }
      ledger.note(`${width}px: viewport ${page.viewport}, ${page.totalRows} rows, footer "${page.footer}", `
        + `horizontal overflow ${page.horizontalOverflow ? 'YES -- DEFECT' : 'no'}, shot ${shot ? path.basename(shot) : 'FAILED'}`)
      ledger.note(page.clipped.length
        ? `${width}px CONTROLS PAST THE EDGE -- DEFECT: ${page.clipped.map(c => `${c.row} right=${c.right}`).join(', ')}`
        : `${width}px: every control sits inside the viewport (nothing cut off)`)

      if (width === WIDTHS[0]) {
        for (const section of page.sections) {
          if (section.rows.length === 0) findings.emptyHeadings.push(section.title)
          else if (section.rows.length === 1) findings.thinSections.push(`${section.title} (1 row)`)
          for (const row of section.rows) {
            /* Only catalogue rows are judged. Guarding on "has no id" was not
               enough: the chat box and Setup rows DO carry ids, under their own
               attributes, and this reported twelve of them -- `agents`, `tier`,
               `autonomy`, `approvals` and the rest -- as dead controls still on
               the glass. They are not dead and they are not this lane's; they
               keep their own stores. `declared` is the honest test. */
            if (!row.declared) continue
            if (!isAlive(row.id)) findings.deadOnGlass.push(`${section.title} / ${row.id} (${row.control})`)
          }
        }
        findings.sections = page.sections.map(s => `${s.title}: ${s.rows.length}`)
        findings.groups = page.groups.map(g => g.id)
        writeEvidence(scratch, 'page-at-1024.json', page)
      }
    }

    ledger.note(`sections: ${findings.sections.join(' | ')}`)
    ledger.note(`groups: ${findings.groups.join(', ')}`)
    ledger.note(findings.deadOnGlass.length
      ? `DEAD CONTROLS STILL ON THE GLASS: ${findings.deadOnGlass.join(', ')}`
      : 'no control on the page writes a value nothing reads')
    ledger.note(findings.emptyHeadings.length
      ? `EMPTY HEADINGS: ${findings.emptyHeadings.join(', ')}`
      : 'every heading on the page has at least one row under it')
    ledger.note(findings.thinSections.length
      ? `single-row sections (judge whether these read as deliberate): ${findings.thinSections.join(', ')}`
      : 'no single-row sections')

    /* ---- do the survivors still work? ---- */
    await resize(window, 1440)
    const effects = []
    const press = async (selector, probe, label) => {
      const clicked = await window.clickVisible(selector)
      await delay(500)
      const after = await window.evaluate(probe)
      effects.push(`${label}: click=${clicked} -> ${JSON.stringify(after)}`)
      return after
    }

    await press('[data-setting-id="theme"] button[data-setting-value="black"]',
      `document.documentElement.dataset.theme`, 'theme -> black')
    await press('[data-setting-id="theme"] button[data-setting-value="white"]',
      `document.documentElement.dataset.theme`, 'theme -> white')
    await press('[data-setting-id="text_size"] button[data-setting-value="1.12"]',
      `document.body.style.zoom`, 'text_size -> large')
    await press('[data-setting-id="text_size"] button[data-setting-value="1"]',
      `document.body.style.zoom || '(cleared)'`, 'text_size -> default')
    await press('[data-setting-id="reduce_motion"] .settings-toggle',
      `document.body.classList.contains('reduce-motion')`, 'reduce_motion')
    await press('[data-setting-id="reduce_motion"] .settings-toggle',
      `document.body.classList.contains('reduce-motion')`, 'reduce_motion back')
    await press('[data-setting-id="ui_font"] button[data-setting-value="mono"]',
      `document.documentElement.style.getPropertyValue('--font-ui').slice(0, 40)`, 'ui_font -> mono')

    /* The two ranges are dragged by keyboard rather than clicked: a click on a
       track lands wherever the pointer is, which is not a value this can predict
       and therefore not a claim it can make. */
    const nudge = async (id, probe, label) => {
      const before = await window.evaluate(probe)
      await window.clickVisible(`[data-setting-id="${id}"] input[type=range]`)
      for (let i = 0; i < 6; i += 1) {
        await window.session.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 37, key: 'ArrowLeft' })
        await window.session.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 37, key: 'ArrowLeft' })
        await delay(90)
      }
      await delay(400)
      const after = await window.evaluate(probe)
      effects.push(`${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)} ${String(before) === String(after) ? 'NO CHANGE -- DEFECT' : 'changed'}`)
    }
    await nudge('glow', `document.documentElement.style.getPropertyValue('--glow')`, 'glow')
    await nudge('scenario_tick_rate', `localStorage.getItem('mc.set.scenario_tick_rate')`, 'scenario_tick_rate')

    const archive = await window.evaluate(`(() => {
      const b = document.querySelector('[data-setting-id="ledger_archive"] button[data-setting-action]')
      return b ? { label: b.textContent.trim(), disabled: b.disabled } : null
    })()`)
    effects.push(`ledger_archive button: ${JSON.stringify(archive)}`)

    for (const line of effects) ledger.note(line)
    findings.effects = effects
    await shoot(window, scratch, 'settings-after-presses')

    writeEvidence(scratch, 'findings.json', findings)
    ledger.note(`evidence in ${scratch}`)
    console.log(`\nEVIDENCE: ${scratch}`)
  } finally {
    await closeWindow(window)
  }
  ledger.finish?.()
}

main().catch(error => {
  console.error(error?.stack || String(error))
  process.exit(1)
})
