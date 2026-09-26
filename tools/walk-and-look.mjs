#!/usr/bin/env node
/* DRIVE THE PACKAGED PRODUCT AND LOOK AT IT, HARD.
 *
 * NOT A GATE. A gate asserts what somebody already thought to assert, and on
 * 2026-08-17 every gate in this tree was green while three of them were
 * reporting a working product as broken and one had never been run at all. This
 * walks a real packaged build like a person would and writes down what it SEES,
 * so a reader can find what nobody wrote a check for.
 *
 * WHAT IT LOOKS FOR, chosen because a unit test structurally cannot see any of
 * it:
 *   - controls that do nothing        press it; if not one byte of the DOM, the
 *                                     address, or the title moved, say so
 *   - errors the page swallowed       window.onerror, unhandledrejection and
 *                                     console.error collected from inside the
 *                                     renderer, per route
 *   - text a customer should never    undefined / NaN / [object Object] /
 *     read                            ENOENT / raw stack frames on the glass
 *   - things off the edge             horizontal overflow, controls whose box
 *                                     falls outside the window
 *   - things on top of each other     visible controls whose rectangles overlap
 *   - targets too small to hit        under 24px on either side
 *   - screens with nothing on them    character count per route
 *   - and it does all of the above at TWO WINDOW SIZES and in BOTH THEMES,
 *     because a laptop at 1280x800 in light mode is not the machine this was
 *     built on and that is where clipping and unreadable copy live
 *
 * It asserts almost nothing on purpose: its exit code is 0 unless it could not
 * run. The output is evidence. A person or a model reads it and judges.
 *
 *   node tools/walk-and-look.mjs --release <win-unpacked> --out <dir>
 *   node tools/walk-and-look.mjs --quick        one size, one theme
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  closeWindow, delay, openWindow, releaseDirectory, scratchDirectory, stage,
} from './test-account-harness.mjs'

const argAt = name => {
  const at = process.argv.indexOf(name)
  return at === -1 ? null : process.argv[at + 1]
}
const OUT = path.resolve(argAt('--out') || path.join(process.env.TEMP || '.', 'walk-and-look'))
const QUICK = process.argv.includes('--quick')

/* Every stop a person can reach by address, ring or link.
 *
 * `#/guide` is kept BESIDE the Settings row it now resolves to, rather than
 * replaced by it. The page it used to open is a section of Settings, and the
 * old address is still in older refusal sentences and in whatever a reader
 * wrote down -- so a walk that stopped visiting it would stop noticing the day
 * the alias broke and dropped a person back on home. */
const ROUTES = [
  '#/', '#/computers', '#/metrics', '#/research', '#/comms', '#/ledger',
  '#/approvals', '#/settings', '#/settings?setting=this_computer_programs', '#/guide',
  '#/account', '#/subscribe', '#/checkout',
]

/* 1280x800 is the laptop this product is not developed on. */
const SIZES = QUICK ? [[1512, 945]] : [[1512, 945], [1280, 800]]
const THEMES = QUICK ? ['dark'] : ['dark', 'light']

/* Collected from INSIDE the renderer: a thrown error that the page caught and a
   console.error nobody reads are both invisible to every harness here. */
const INSTALL_COLLECTOR = `(() => {
  if (window.__walk) return 'already'
  window.__walk = { errors: [] }
  const push = (kind, text) => { if (window.__walk.errors.length < 60) window.__walk.errors.push(kind + ': ' + String(text).slice(0, 300)) }
  window.addEventListener('error', e => push('error', e.message || e.error))
  window.addEventListener('unhandledrejection', e => push('unhandled', e.reason && (e.reason.message || e.reason)))
  const realError = console.error.bind(console)
  console.error = (...args) => { push('console.error', args.map(a => (a && a.message) || a).join(' ')); realError(...args) }
  const realWarn = console.warn.bind(console)
  console.warn = (...args) => { push('console.warn', args.map(a => (a && a.message) || a).join(' ')); realWarn(...args) }
  return 'installed'
})()`

const DRAIN = `(() => { const e = (window.__walk && window.__walk.errors) || []; if (window.__walk) window.__walk.errors = []; return e })()`

const LOOK = `(() => {
  const vis = node => {
    if (!node) return false
    const b = node.getBoundingClientRect(); const s = getComputedStyle(node)
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  }
  const stage = document.querySelector('.stage') || document.body
  const text = stage.innerText.replace(/\\s+/g, ' ').trim()
  const controls = [...document.querySelectorAll('button, a[href], input, select, [role="button"]')].filter(vis)
  const box = n => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const label = n => (n.textContent || n.getAttribute('aria-label') || n.name || n.type || n.tagName).replace(/\\s+/g, ' ').trim().slice(0, 44)

  /* Off the edge of the window a person actually has. */
  const offscreen = controls.filter(n => { const r = n.getBoundingClientRect()
    return r.right > innerWidth + 2 || r.bottom > innerHeight + 2 || r.left < -2 || r.top < -2 })
    .map(n => ({ label: label(n), ...box(n) }))

  /* Too small to hit reliably. 24px is the smallest anyone recommends. */
  const tiny = controls.filter(n => { const r = n.getBoundingClientRect(); return r.width < 24 || r.height < 24 })
    .map(n => ({ label: label(n), ...box(n) }))

  /* Two visible controls sharing pixels: one of them cannot be pressed. */
  const overlaps = []
  for (let i = 0; i < controls.length && overlaps.length < 12; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue
      const a = controls[i].getBoundingClientRect(); const b = controls[j].getBoundingClientRect()
      const ov = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      if (ov > 64) { overlaps.push({ a: label(controls[i]), b: label(controls[j]), px: Math.round(ov) }); break }
    }
  }

  return {
    hash: location.hash, route: document.body.dataset.route || '', title: document.title,
    chars: text.length, text: text.slice(0, 1500),
    controls: controls.length,
    disabled: controls.filter(n => n.disabled === true).length,
    controlLabels: controls.slice(0, 40).map(label),
    overflowX: document.documentElement.scrollWidth > innerWidth + 2,
    scrollWidth: document.documentElement.scrollWidth, innerWidth,
    offscreen, tiny, overlaps,
    /* Text no customer should ever be shown. */
    junk: (text.match(/undefined|NaN|\\[object [A-Z]|ENOENT|Error:|TypeError|at [A-Za-z]+ \\(/g) || []).slice(0, 8),
    refusals: (text.match(/could not|cannot|unavailable|not available|nothing here|does not include|no .{0,18}(data|host|record)/gi) || []).length,
    emptyPanels: document.querySelectorAll('.projection-unavailable, [data-projection-state="unavailable"]').length,
  }
})()`

/* Press a control and report whether ANYTHING changed. A control that moves
   nothing is either dead or purely decorative, and the two look identical from
   the outside -- which is the point of writing it down rather than asserting. */
const PRESS = index => `(async () => {
  const vis = node => { const b = node.getBoundingClientRect(); const s = getComputedStyle(node)
    return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const controls = [...document.querySelectorAll('button, [role="button"]')].filter(vis)
  const node = controls[${index}]
  if (!node) return null
  const name = (node.textContent || node.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 44)
  if (/sign out|delete|remove|reset|uninstall|archive|decline|terminate|stop/i.test(name)) return { name, skipped: 'destructive-looking, not pressed' }
  const before = { html: document.body.innerHTML.length, hash: location.hash, title: document.title, text: (document.querySelector('.stage') || document.body).innerText.length }
  node.click()
  await new Promise(r => setTimeout(r, 550))
  const after = { html: document.body.innerHTML.length, hash: location.hash, title: document.title, text: (document.querySelector('.stage') || document.body).innerText.length }
  const moved = before.html !== after.html || before.hash !== after.hash || before.title !== after.title || before.text !== after.text
  return { name, moved, htmlDelta: after.html - before.html, hashChanged: before.hash !== after.hash }
})()`

async function main() {
  const release = releaseDirectory()
  const scratch = scratchDirectory('walk-and-look')
  mkdirSync(OUT, { recursive: true })
  const staged = await stage(scratch, release)
  const window = await openWindow(staged.executable, scratch)
  const findings = []
  const report = []
  try {
    await window.evaluate(INSTALL_COLLECTOR)
    /* Skip setup the way a person in a hurry does. */
    await window.evaluate(`location.hash = '#/setup'`)
    await delay(1500)
    const skippedSetup = await window.evaluate(`(() => { const s = [...document.querySelectorAll('button, a')].find(n => /skip/i.test(n.textContent)); if (!s) return false; s.click(); return true })()`)
    if (!skippedSetup) throw new Error('setup could not be skipped: no skip control was found')
    await delay(1500)
    const routeAfterSetup = await window.evaluate('location.hash')
    if (routeAfterSetup === '#/setup') throw new Error('setup could not be skipped: the skip control left the walkthrough open')

    for (const [w, h] of SIZES) {
      await window.session.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
      for (const theme of THEMES) {
        await window.evaluate(`(() => { try { localStorage.setItem('mc.theme', ${JSON.stringify(theme)}) } catch {} ; document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true })()`)
        await delay(400)
        for (const hash of ROUTES) {
          await window.evaluate(`location.hash = ${JSON.stringify(hash)}`)
          await delay(1900)
          await window.evaluate(INSTALL_COLLECTOR)
          const look = await window.evaluate(LOOK)
          const errors = await window.evaluate(DRAIN)
          /* A query is part of an address now (`?setting=<row>`), and `?` and
             `=` are not filename characters on every platform this runs on. */
          const tag = `${hash.replace(/[#/]/g, '').replace(/[?=&]/g, '-') || 'home'}-${w}x${h}-${theme}`
          const shot = await window.session.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(path.join(OUT, `${tag}.png`), Buffer.from(shot.result.data, 'base64'))

          /* Press every control on the largest/darkest pass only -- pressing the
             same buttons four times tells you nothing new and takes four times
             as long. */
          const presses = []
          if (w === SIZES[0][0] && theme === THEMES[0]) {
            for (let i = 0; i < Math.min(look.controls, 14); i += 1) {
              const pressed = await window.evaluate(PRESS(i))
              if (pressed) presses.push(pressed)
              const hashNow = await window.evaluate('location.hash')
              if (hashNow !== hash) { await window.evaluate(`location.hash = ${JSON.stringify(hash)}`); await delay(900) }
            }
          }
          const pressErrors = await window.evaluate(DRAIN)

          const row = { tag, ...look, errors, presses, pressErrors }
          report.push(row)

          const dead = presses.filter(p => p && p.moved === false).map(p => p.name)
          if (errors.length) findings.push(`${tag}: ${errors.length} renderer error(s) -- ${errors[0]}`)
          if (pressErrors.length) findings.push(`${tag}: pressing controls raised ${pressErrors.length} error(s) -- ${pressErrors[0]}`)
          if (look.junk.length) findings.push(`${tag}: raw junk on screen -- ${look.junk.join(', ')}`)
          if (look.overflowX) findings.push(`${tag}: page scrolls sideways (${look.scrollWidth} > ${look.innerWidth})`)
          if (look.offscreen.length) findings.push(`${tag}: ${look.offscreen.length} control(s) outside the window -- ${look.offscreen.slice(0, 3).map(o => o.label).join(' | ')}`)
          if (look.overlaps.length) findings.push(`${tag}: ${look.overlaps.length} overlapping control pair(s) -- ${look.overlaps.slice(0, 2).map(o => `${o.a} x ${o.b}`).join(' | ')}`)
          if (look.tiny.length) findings.push(`${tag}: ${look.tiny.length} control(s) under 24px -- ${look.tiny.slice(0, 3).map(o => o.label).join(' | ')}`)
          if (look.chars < 120) findings.push(`${tag}: almost nothing on screen (${look.chars} chars)`)
          if (dead.length) findings.push(`${tag}: ${dead.length} control(s) moved nothing when pressed -- ${dead.slice(0, 4).join(' | ')}`)

          console.log(`${tag.padEnd(34)} chars=${String(look.chars).padStart(5)} ctl=${String(look.controls).padStart(3)} off=${look.offscreen.length} ovl=${look.overlaps.length} tiny=${look.tiny.length} err=${errors.length}${look.junk.length ? ' JUNK:' + look.junk.join(',') : ''}${dead.length ? ' DEAD:' + dead.length : ''}`)
        }
      }
    }
  } finally {
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1))
    writeFileSync(path.join(OUT, 'FINDINGS.txt'), findings.length ? findings.join('\n') + '\n' : 'nothing suspicious was seen\n')
    try { await closeWindow(window) } catch { /* already gone */ }
  }
  console.log(`\n===== ${findings.length} THING(S) WORTH LOOKING AT =====`)
  for (const line of findings) console.log(`  ${line}`)
  console.log(`\nscreens, text and report.json in ${OUT}`)
}

main().catch(error => { console.error(error?.stack || String(error)); process.exitCode = 1 })
