#!/usr/bin/env node

/* THE PAGE-2 RIGHT RAIL, INVENTORIED AS A PERSON MEETS IT.
 *
 * The owner, 2026-08-19: "ther right panel on page 2 is still so complicated i
 * think its in there maybe somewhere" -- the "it" being the folder a tree's
 * agents start in, which this product does have and buries.
 *
 * This driver does not judge. It MEASURES, on the packaged build, with real
 * input: every panel of both rail states, in DOM order, with its title, its
 * height in pixels, its top relative to the rail's own scroll box, and whether
 * a person sees it without scrolling. Three widths, because a rail that reads
 * at 1920 can be a column of stacked scrollbars at 1024.
 *
 * TWO RAIL STATES, BOTH OF THEM REAL.
 *   overview  the stats page, which is what page 2 shows before anything is
 *             selected -- the rail a first-time person meets.
 *   tree node the controls page for a node in your own tree, reached by
 *             starting an agent from the dashed circle and pressing its
 *             circle. This is the rail that carries Setup (the folder).
 *
 * NAVIGATION IS BY CLICKING (#nav-next), never location.hash: a harness that
 * jumps passes on a build where nothing routes there. Presses are real CDP
 * mouse events at real coordinates, and waitForVisible refuses a covered
 * control rather than clicking through it.
 *
 *   node tools/rail-inventory-drive.mjs [--visible] [--keep]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  argument,
  assertIsolated,
  closeDrawer,
  closeWindow,
  delay,
  openWindow,
  reap,
  route,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

const KEEP = process.argv.includes('--keep')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
/* WHERE THE READINGS LAND, AND WHY IT IS NOW A FLAG (2026-08-23). The default
   is unchanged: reports/rail-inventory, next to the rest of this drive's
   evidence, which is where a person running it by hand wants it. What changed
   is that this driver joined tools/packaged-qa-suite.mjs, and release:cut runs
   that suite and then requires `git status --porcelain` to be EMPTY before
   `npm run dist`. reports/rail-inventory is TRACKED -- the readings were
   committed with the report they belong to -- so a gate re-running here would
   modify tracked files and fail the cut on evidence the gate itself had just
   produced. The suite therefore passes `--out` into a scratch directory. Same
   flag, same reason, same spelling as tools/context-window-drive.mjs. */
const OUT = path.resolve(argument('--out', path.join(REPO, 'reports', 'rail-inventory')))

const WIDTHS = [
  { label: '1024', width: 1024, height: 768 },
  { label: '1440', width: 1440, height: 900 },
  { label: '1920', width: 1920, height: 1080 },
]

const lines = []
/* Written through on every line. Node block-buffers stdout into a file, so a
   run that hangs at the end shows NOTHING of what it already measured -- which
   is how the first run of this driver looked like a total failure when it had
   in fact read the whole overview rail. */
const say = text => {
  lines.push(text)
  console.log(text)
  try { mkdirSync(OUT, { recursive: true }); writeFileSync(path.join(OUT, 'inventory.txt'), `${lines.join('\n')}\n`) } catch { /* best effort */ }
}

function readOrThrow(value, what) {
  if (value && typeof value === 'object' && value.__evaluateThrew) {
    throw new Error(`the page expression for ${what} threw: ${value.__evaluateThrew}`)
  }
  if (value === undefined) throw new Error(`the page expression for ${what} answered undefined`)
  return value
}

const freshProfile = scratch => {
  const profile = mkdtempSync(path.join(scratch, 'profile-'))
  for (const leaf of ['userdata', 'local', 'home', 'roaming']) mkdirSync(path.join(profile, leaf), { recursive: true })
  return profile
}

/* ------------------------------------------------------------- pressing -- */

async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') {
    return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(45)
  }
  await delay(520)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function typeInto(window, selector, text) {
  const pressed = await press(window, selector)
  if (!pressed.pressed) return pressed
  await window.session.send('Input.insertText', { text })
  await delay(180)
  return pressed
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
  await delay(420)
}

async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  for (let i = 0; i < maxPresses; i += 1) {
    if ((await valueNow()) === wanted) return { ok: true, presses: i }
    await key(window, 'ArrowDown', 40)
  }
  return { ok: false, why: `never reached ${wanted} in ${maxPresses} presses` }
}

/* ---------------------------------------------------------- screenshots -- */

async function shoot(window, name) {
  /* setWebLifecycleState('active') first: under MC_SMOKE_HEADLESS the window is
     offscreen and captureScreenshot never returns without it. */
  try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older */ }
  await delay(260)
  /* MEASURED, 2026-08-20: under MC_SMOKE_HEADLESS the window is offscreen and
     this call can never answer at all -- the first run of this driver sat on it
     for twenty minutes with a full inventory already read and unprinted. The
     race turns that into a reported gap instead of a dead run. */
  /* TWO WAYS, AND THE FAILURE IS REPORTED RATHER THAN SWALLOWED. A shot that
     silently answers null is how a run reports "no screenshot" about a build
     whose frames were arriving fine; the packet is described when nothing
     usable comes back, so the next run debugs the CALL instead of the app. */
  /* CLIPPED TO THE EMULATED VIEWPORT, because the two are not the same thing.
     Measured 2026-08-20: with Emulation.setDeviceMetricsOverride at 1440x900
     over a window whose real surface is larger, a plain captureScreenshot
     returns the SURFACE -- the page rendered at 1440 CSS px, cropped to the
     left ~1080 of it, so the right-hand rail this driver exists to photograph
     was outside the frame. The overview shots happened to look right and the
     tree-node ones did not, which is exactly the kind of inconsistency that
     gets read as a product defect. The clip is asked of the page. */
  const metrics = await window.session.send('Page.getLayoutMetrics').catch(() => null)
  const view = metrics?.result?.cssLayoutViewport || metrics?.result?.layoutViewport
  const clip = view
    ? { clip: { x: 0, y: 0, width: view.clientWidth, height: view.clientHeight, scale: 1 } }
    : {}
  const attempts = [
    ['clipped', { format: 'png', captureBeyondViewport: true, ...clip }],
    ['plain', { format: 'png' }],
  ]
  const failures = []
  for (const [label, options] of attempts) {
    const packet = await Promise.race([
      window.session.send('Page.captureScreenshot', options).catch(error => ({ __sendFailed: String(error?.message || error) })),
      delay(15_000).then(() => ({ __timedOut: true })),
    ])
    /* `session.send` resolves the RAW CDP packet, so the payload is under
       .result -- reading packet.data reported "shot: null" for three widths of
       screenshots that had in fact come back fine. */
    const data = packet?.result?.data || packet?.data
    if (data) {
      const file = path.join(OUT, `${name}.png`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    }
    failures.push(`${label}: ${JSON.stringify(packet)?.slice(0, 180) || 'nothing'}`)
  }
  return `UNMEASURED (${failures.join(' | ')})`
}

async function setWidth(window, size) {
  await window.session.send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
  })
  await delay(900)
}

/* ------------------------------------------------------------- readings -- */

/* One panel inventory for whichever rail page is active. Panels are read in DOM
   order out of the rail's own scroll box, so "top" is the distance a person
   scrolls to reach it, not a viewport coordinate. */
const INVENTORY = bodySelector => `(() => {
  const outer = document.querySelector(${JSON.stringify(bodySelector)})
  if (!outer) return { missing: ${JSON.stringify(bodySelector)} }
  /* THE SCROLLER IS THE .rail-scroll INSIDE, NOT THE PAGE ELEMENT. Measuring
     the page element reported "1 screens" for a rail carrying 1410px of panels
     in a 439px window -- scrollHeight equalled clientHeight because the page
     element is not the thing that scrolls. */
  const host = outer.classList.contains('rail-scroll') ? outer : (outer.querySelector('.rail-scroll') || outer)
  const box = host.getBoundingClientRect()
  const text = n => (n ? (n.textContent || '').replace(/\\s+/g, ' ').trim() : '')
  const panels = []
  /* A "panel" is a titled group: a .board-box (has its own header) or a bare
     .rail-sec heading with the run of siblings under it. Both are what a person
     reads as one thing. */
  {
    for (const child of host.children) {
      const rect = child.getBoundingClientRect()
      if (rect.height === 0) continue
      const title = child.classList.contains('board-box')
        ? text(child.querySelector('.bh-t'))
        : (child.classList.contains('rail-sec') ? text(child) : '')
      panels.push({
        tag: child.tagName.toLowerCase(),
        cls: child.className,
        title,
        kind: child.classList.contains('board-box') ? 'box' : (child.classList.contains('rail-sec') ? 'heading' : 'loose'),
        caption: text(child.querySelector('.board-cap')) || '',
        top: Math.round(rect.top - box.top + host.scrollTop),
        height: Math.round(rect.height),
        controls: child.querySelectorAll('select, input, textarea, button').length,
        firstWords: text(child).slice(0, 90),
      })
    }
  }
  return {
    scrollHeight: host.scrollHeight,
    clientHeight: host.clientHeight,
    screensOfScroll: host.clientHeight ? Number((host.scrollHeight / host.clientHeight).toFixed(2)) : null,
    railWidth: Math.round(box.width),
    panels,
  }
})()`

/* Is the folder control -- the thing the owner is hunting for -- on screen, and
   how far down is it? elementFromPoint decides "visible", never a rectangle. */
const FOLDER_REACH = `(() => {
  const select = document.querySelector('[data-tree-profile]')
  if (!select) return { present: false }
  const rect = select.getBoundingClientRect()
  const scroller = select.closest('.rail-scroll')
  const box = scroller ? scroller.getBoundingClientRect() : null
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const hit = document.elementFromPoint(cx, cy)
  return {
    present: true,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scrollTopToReach: scroller ? Math.round(rect.top - box.top + scroller.scrollTop) : null,
    scrollHeight: scroller ? scroller.scrollHeight : null,
    clientHeight: scroller ? scroller.clientHeight : null,
    inViewportNow: rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
    hitsItself: Boolean(hit && (hit === select || select.contains(hit))),
    hitTag: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 40) : null,
    label: select.getAttribute('aria-label') || null,
    options: [...select.options].map(o => o.textContent.trim()).slice(0, 8),
  }
})()`

/* ----------------------------------------------------- getting about ----- */

async function gotoComputers(window) {
  /* THE DRAWER IS A MODAL AND IT SITS OVER THE RAIL THIS DRIVER PHOTOGRAPHS.
     Measured: a run landed on the computers route with the settings drawer
     standing open, and every screenshot carried it. The panel measurements were
     unaffected -- the rail stayed 351px wide across every run, open or shut --
     but an evidence shot with an unrelated modal in it is a shot somebody has
     to explain. Its state is asked, never assumed. */
  await closeDrawer(window)
  for (let step = 0; step < 14; step += 1) {
    if ((await route(window)) === 'computers') return 'clicked'
    const next = await window.clickVisible('#nav-next')
    if (next !== 'clicked') return `arrow:${next}`
    await delay(480)
  }
  return `stuck-on-${await route(window)}`
}

async function startAgentFromCanvas(window, brief) {
  const doorway = await press(window, '.computers .tree-empty-node')
  if (!doorway.pressed) return { ok: false, why: `the dashed circle could not be pressed (${doorway.why})` }
  await delay(2200)
  const offered = readOrThrow(await window.evaluate(`(() => {
    const read = (field) => {
      const node = document.querySelector('[data-compose-field="' + field + '"]')
      return node ? [...node.options].map(o => o.value).filter(Boolean) : []
    }
    return { tiers: read('tier'), roles: read('role') }
  })()`), 'the compose menus')
  if (!offered.tiers.length || !offered.roles.length) {
    return { ok: false, why: `the compose panel offered no tier or role (${JSON.stringify(offered)})` }
  }
  /* PART B ON REAL GLASS: does the panel that STARTS A TREE ask for the folder,
     and can a person reach the question? elementFromPoint decides "reachable",
     never a rectangle -- a control the panel has scrolled off its own body is
     as absent as one that was never drawn. */
  const folderField = readOrThrow(await window.evaluate(`(() => {
    const select = document.querySelector('[data-compose-field="profile"]')
    if (!select) return { present: false }
    const rect = select.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const label = document.querySelector('label[for="' + select.id + '"]')
    return {
      present: true,
      label: label ? label.textContent.trim() : null,
      options: [...select.options].map(o => o.textContent.trim()),
      value: select.value,
      inViewportNow: rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
      hitsItself: Boolean(hit && (hit === select || select.contains(hit))),
    }
  })()`), 'the compose folder field')
  say(``)
  say(`    THE FOLDER AT TREE START ([data-compose-field="profile"])`)
  say(`      ${JSON.stringify(folderField)}`)

  const pickedTier = await chooseByKeyboard(window, '[data-compose-field="tier"]', offered.tiers[0])
  if (!pickedTier.ok) return { ok: false, why: `could not choose a tier (${pickedTier.why})` }
  const pickedRole = await chooseByKeyboard(window, '[data-compose-field="role"]', offered.roles[0])
  if (!pickedRole.ok) return { ok: false, why: `could not choose a role (${pickedRole.why})` }
  const typed = await typeInto(window, '[data-compose-field="message"]', brief)
  if (!typed.pressed) return { ok: false, why: `the brief field could not be pressed (${typed.why})` }
  const startTarget = readOrThrow(await window.evaluate(`(() => {
    const visible = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
      return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const btn = [...document.querySelectorAll('button')].filter(visible).find(n => /^start/i.test(n.textContent.trim()))
    if (!btn) return null
    if (!btn.id) btn.id = 'rail-inventory-drive-start'
    return { selector: '#' + btn.id }
  })()`), 'the Start control')
  if (!startTarget) return { ok: false, why: 'there is no Start control on the compose panel' }
  const before = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas before the start',
  )
  const pressedStart = await press(window, startTarget.selector)
  if (!pressedStart.pressed) return { ok: false, why: `Start could not be pressed (${pressedStart.why})` }
  await delay(5200)
  const after = readOrThrow(
    await window.evaluate("(() => [...document.querySelectorAll('.node[data-agent-id]')].map(n => n.dataset.agentId))()"),
    'the canvas after the start',
  )
  const fresh = after.find(id => !before.includes(id)) || null
  if (!fresh) return { ok: false, why: `the start drew no new circle (${after.length} on the canvas)` }
  return { ok: true, nodeId: fresh }
}

/* ------------------------------------------------------------- printing -- */

function printInventory(heading, reading) {
  say(``)
  say(`  ${heading}`)
  if (reading.missing) { say(`    ABSENT: no ${reading.missing} in the page`); return }
  say(`    rail ${reading.railWidth}px wide · scroll ${reading.scrollHeight}px in a ${reading.clientHeight}px box · ${reading.screensOfScroll} screens`)
  say(`    ${'#'.padEnd(3)} ${'top'.padStart(6)} ${'high'.padStart(6)} ${'ctl'.padStart(4)}  panel`)
  reading.panels.forEach((panel, index) => {
    const seen = panel.top < reading.clientHeight ? ' ' : '↓'
    const name = panel.title || `(${panel.kind}) ${panel.firstWords.slice(0, 54)}`
    say(`    ${String(index + 1).padEnd(3)} ${String(panel.top).padStart(6)} ${String(panel.height).padStart(6)} ${String(panel.controls).padStart(4)} ${seen} ${name}`)
    if (panel.caption) say(`        └ "${panel.caption}"`)
  })
}

/* ------------------------------------------------------------------ run -- */

async function main() {
  mkdirSync(OUT, { recursive: true })
  const scratch = mkdtempSync(path.join(process.env.TEMP || '/tmp', 'rail-inventory-'))
  let window = null
  try {
    const staged = await stage(scratch)
    const profile = freshProfile(scratch)
    seedMachineRecord(profile, staged.appRoot)
    window = await openWindow(staged.executable, profile)
    assertIsolated(profile)

    await delay(2400)
    const reached = await gotoComputers(window)
    say(`route: ${await route(window)} (${reached})`)
    if ((await route(window)) !== 'computers') throw new Error(`could not reach page 2 by clicking: ${reached}`)

    /* The write switch a person has on by default in a real install; without it
       the start path refuses and the tree-node rail never exists. */
    await window.evaluate("localStorage.setItem('mc.write.agent-session', 'enabled')")
    await window.evaluate('location.reload()')
    await delay(4200)
    await gotoComputers(window)

    for (const size of WIDTHS) {
      await setWidth(window, size)
      say(``)
      say(`================ ${size.label}x${size.height} ================`)
      const overview = readOrThrow(await window.evaluate(INVENTORY('.stats-page')), 'the overview rail')
      printInventory(`OVERVIEW RAIL (nothing selected) @ ${size.label}`, overview)
      const shot = await shoot(window, `overview-${size.label}`)
      say(`    shot: ${shot}`)
    }

    /* Now the rail that carries the folder. Started at the widest size so the
       compose panel has room, then measured at all three. */
    await setWidth(window, WIDTHS[2])
    const started = await startAgentFromCanvas(window, 'Inventory the rail.')
    say(``)
    say(`start from the dashed circle: ${started.ok ? `node ${started.nodeId}` : `FAILED -- ${started.why}`}`)
    if (!started.ok) throw new Error(`no tree node to inventory: ${started.why}`)

    for (const size of WIDTHS) {
      await setWidth(window, size)
      const opened = await press(window, `.node[data-agent-id="${started.nodeId}"]`)
      if (!opened.pressed) { say(`  could not open the node's rail at ${size.label}: ${opened.why}`); continue }
      await delay(900)
      const tabbed = await press(window, '[data-rail-tab="details"]')
      if (!tabbed.pressed) { say(`  could not press Details at ${size.label}: ${tabbed.why}`); continue }
      await delay(700)
      say(``)
      say(`================ TREE NODE RAIL @ ${size.label}x${size.height} ================`)
      const details = readOrThrow(await window.evaluate(INVENTORY('[data-rail-body="details"]')), 'the details tab')
      printInventory(`TREE NODE RAIL · Details tab @ ${size.label}`, details)
      const folder = readOrThrow(await window.evaluate(FOLDER_REACH), 'the folder control')
      say(``)
      say(`    THE FOLDER CONTROL ("Works in", [data-tree-profile]) @ ${size.label}`)
      say(`      ${JSON.stringify(folder)}`)
      const shot = await shoot(window, `treenode-details-${size.label}`)
      say(`    shot: ${shot}`)
    }

    writeFileSync(path.join(OUT, 'inventory.txt'), `${lines.join('\n')}\n`)
    say(``)
    say(`written: ${path.join(OUT, 'inventory.txt')}`)
  } finally {
    if (window) { await closeWindow(window).catch(() => {}); reap(window.child?.pid) }
    if (!KEEP) rmSync(scratch, { recursive: true, force: true })
    else console.log(`kept: ${scratch}`)
  }
}

main().catch(error => {
  console.error(`\nFAILED: ${error.message}`)
  process.exitCode = 1
})
