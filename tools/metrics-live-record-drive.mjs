#!/usr/bin/env node
/* DOES THE METRICS PAGE SHOW A RUN I ACTUALLY CAUSED?
 *
 * THE CLAIM THIS RUN EXISTS TO TEST, and it is deliberately not "does the page
 * render". A page that renders is not a page that is connected. The metrics page
 * shipped rendering perfectly while every tile on it said
 * "unavailable · No local agent fleet host detected on this machine." on every
 * install, for ever, because it read a file written at BUILD time on the
 * builder's machine. The owner hit it himself and asked whether it was his
 * account.
 *
 * So this file measures the only thing that settles it: a fresh profile with
 * nothing in it, the metrics page read BEFORE anything has run, then a REAL
 * Codex agent started from the tree with real mouse and keyboard, allowed to
 * answer, and the metrics page read again. The numbers have to move, and they
 * have to move by exactly the run this file caused.
 *
 * WHAT IT DRIVES. A STAGED packaged build -- the same executable, the same
 * resources/capability, this tree's dist/ and shell/ overlaid by stage() in
 * tools/test-account-harness.mjs. It NEVER touches the installed copy under
 * %LOCALAPPDATA%\\Programs\\toolsenabled: a harness pointed at the owner's live
 * install once desynced his audit ledger, and openWindow() redirects APPDATA,
 * LOCALAPPDATA, USERPROFILE and CODEX_HOME into a scratch profile that this run
 * deletes.
 *
 * WHY CODEX AND NOT CLAUDE. The Claude quota on this machine is at zero until
 * 2026-08-21, and a run that cannot get an answer cannot tell a connected page
 * from a disconnected one. `luna` is the cheapest Codex tier the host offers
 * (shell/agent-host.cjs START_TIERS).
 *
 *   node tools/metrics-live-record-drive.mjs [--visible]
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
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
/* The answer must not appear anywhere in the question. A sibling driver asked
   for a word it had just typed, found it in its own message box, and reported a
   real agent answer on a run where no session ever started. */
const PROMPT = 'What is 17 multiplied by 23? Reply with only the number.'
const PROOF = '391'
if (PROMPT.includes(PROOF)) throw new Error('the answer is inside the question; this run could not tell an echo from a reply')

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* A real press at real coordinates, with the element under the point confirmed
   first. No el.click(), anywhere in this file. */
async function press(window, selector, timeoutMs = 9000) {
  const spot = await window.waitForVisible(selector, timeoutMs)
  if (spot?.state !== 'visible') return { pressed: false, why: spot?.state || 'unknown' }
  const under = await window.evaluate(`(() => {
    const node = document.elementFromPoint(${spot.x}, ${spot.y})
    if (!node) return null
    return { tag: node.tagName, cls: String(node.className || '').slice(0, 60),
      mine: node.closest(${JSON.stringify(selector)}) !== null }
  })()`)
  if (!under?.mine) return { pressed: false, why: `covered-by-${under?.tag}.${under?.cls}` }
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

/* A native <select> in an offscreen window takes arrow keys only after the
   popup its own click opened is dismissed with Escape. Measured; the earlier
   version of this step reported arrow keys as not working and was wrong. */
async function chooseByKeyboard(window, selector, wanted, maxPresses = 24) {
  const opened = await press(window, selector)
  if (!opened.pressed) return { ok: false, why: `could not focus the menu: ${opened.why}` }
  await key(window, 'Escape', 27)
  for (let step = 0; step < maxPresses; step += 1) {
    const now = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`)
    if (now === wanted) {
      const label = await window.evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        return node?.selectedOptions?.[0]?.textContent?.trim()?.slice(0, 44) ?? null
      })()`)
      return { ok: true, label }
    }
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

/* WHAT THE METRICS PAGE IS SAYING, read off the page itself rather than from a
   store. Every field is something a person can see. */
async function readMetrics(window) {
  return window.evaluate(`(() => {
    const root = document.querySelector('.metrics')
    if (!root) return { present: false }
    const tiles = [...root.querySelectorAll('#tiles .stat')].map(node => ({
      label: node.querySelector('.tl')?.textContent?.trim() || '',
      value: node.querySelector('.tvn')?.textContent?.trim() || '',
      unit: node.querySelector('.unit')?.textContent?.trim() || '',
      delta: node.querySelector('.td')?.textContent?.trim() || '',
    }))
    const cells = [...root.querySelectorAll('.m-activity-cell[data-runs]')]
    return {
      present: true,
      state: root.dataset.projectionState || null,
      note: root.querySelector('#mf-note')?.textContent?.trim() || '',
      tiles,
      panelStates: Object.fromEntries([...root.querySelectorAll('[data-mc]')]
        .map(node => [node.dataset.mc, node.getAttribute('data-panel-state')])),
      activity: {
        drawn: root.querySelector('.m-activity') !== null,
        litCells: cells.length,
        runsDrawn: cells.reduce((sum, node) => sum + Number(node.dataset.runs || 0), 0),
        sub: root.querySelector('#heat-sub')?.textContent?.trim() || '',
      },
      outcomes: {
        total: root.querySelector('.m-outcome-total b')?.textContent?.trim() || null,
        legend: [...root.querySelectorAll('.m-outcome-legend li')]
          .map(node => \`\${node.querySelector('span')?.textContent?.trim()}=\${node.querySelector('b')?.textContent?.trim()}\`),
        note: root.querySelector('.m-outcome-note')?.textContent?.trim() || '',
      },
      runRows: [...root.querySelectorAll('#agent-table tbody tr')].map(row =>
        [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())),
      refusals: [...root.querySelectorAll('.m-refusals li')].map(node => node.textContent.trim().slice(0, 120)),
      /* The sentence this whole repair exists to remove, looked for on the
         rendered page rather than in the source. */
      oldRefusalOnScreen: (root.innerText || '').includes('No local agent fleet host detected'),
      unavailableAlone: [...root.querySelectorAll('.metrics .ms, .metrics .unit, .metrics .td')]
        .map(node => node.textContent.trim())
        .filter(text => /^unavailable\\b/i.test(text)),
      panelNotes: [...root.querySelectorAll('.m-panel-note')].map(node => node.textContent.trim().slice(0, 150)),
    }
  })()`)
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'metrics-live-'))
  let window = null
  try {
    console.log('staging the packaged build (never the installed copy)...')
    const staged = await stage(scratch)

    /* The Codex sign-in is LENT to the scratch profile, exactly as
       tools/claude-tree-start-proof.mjs lends the Claude one and for the same
       reason: openWindow() redirects CODEX_HOME into this temporary directory,
       so a child started under it would otherwise look for a sign-in in a home
       that has never had one. Nothing in the product path reads the copy; the
       CLI authenticates itself, as it does in the person's own terminal. The
       file lives only in the directory this run deletes. */
    const realCodex = path.join(process.env.USERPROFILE || '', '.codex', 'auth.json')
    if (!existsSync(realCodex)) {
      note('FAIL', 'HARNESS STATE: this computer has no Codex sign-in to lend, so no real run could be caused and nothing below would be a measurement.')
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
    note('info', 'lent the scratch profile this computer’s Codex sign-in; it lives only in the temporary profile this run deletes.')

    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)

    /* MEASURED, NOT REASONED. Everything above says this run is isolated -- a
       redirected APPDATA, a --user-data-dir on the scratch profile, and a
       capability state root derived from that userData. Belief is not accepted
       here: assertIsolated reads where the app ACTUALLY wrote its preferences
       and throws if that path is inside the real installation. A driver that
       cannot prove which data directory it touched has no business reporting on
       a signed ledger at all. */
    const prefs = assertIsolated(scratch)
    note('ok', `this run wrote to its own profile, measured: ${prefs}`)
    const realState = path.join(process.env.APPDATA || '', 'ToolsEnabled', 'capability', 'state', 'audit.sqlite3')
    note('info', `the real installation's audit ledger is untouched by construction; this run never resolves ${realState}`)

    /* ---------------------------------------------------------------- before */
    console.log('\n[1] the metrics page on a profile where nothing has ever run')
    const reached = await walkTo(window, 'metrics')
    note(reached.ok ? 'ok' : 'FAIL', `walked the ring to #/metrics by pressing the arrow${reached.ok ? '' : `: ${reached.why}`}`)
    if (!reached.ok) return
    await delay(2200)
    const before = await readMetrics(window)
    if (!before.present) { note('FAIL', 'there is no metrics surface on the metrics route'); return }
    note('info', `state=${before.state} note=${JSON.stringify(before.note.slice(0, 160))}`)
    note(before.oldRefusalOnScreen ? 'FAIL' : 'ok',
      before.oldRefusalOnScreen
        ? 'the fleet-host refusal is still on the metrics page'
        : 'the fleet-host refusal is nowhere on the metrics page')
    note(before.unavailableAlone.length === 0 ? 'ok' : 'FAIL',
      before.unavailableAlone.length === 0
        ? 'no tile or sub-heading says "unavailable" on its own'
        : `these still lead with "unavailable": ${JSON.stringify(before.unavailableAlone.slice(0, 6))}`)
    note('info', `tiles before: ${JSON.stringify(before.tiles.map(tile => `${tile.label}=${tile.value}`))}`)
    note('info', `panel sentences before: ${JSON.stringify(before.panelNotes.slice(0, 3))}`)

    /* -------------------------------------------------------------- the run */
    console.log('\n[2] starting a REAL Codex agent from the tree')
    /* Every action that writes anything ships switched off; a person who has
       reached this question has already turned it on. Seeded rather than driven
       through Settings for the reason the sibling drivers give at length: the
       Settings toggle is a different question with its own coverage. */
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    const toComputers = await walkTo(window, 'computers')
    note(toComputers.ok ? 'ok' : 'FAIL', `walked to #/computers${toComputers.ok ? '' : `: ${toComputers.why}`}`)
    if (!toComputers.ok) return
    await window.evaluate('location.reload()')
    await delay(3600)

    const doorway = await press(window, '.computers .tree-empty-node')
    note(doorway.pressed ? 'ok' : 'FAIL', `pressed the way in${doorway.pressed ? ` at (${doorway.at.x}, ${doorway.at.y})` : `: ${doorway.why}`}`)
    if (!doorway.pressed) return
    await delay(2400)

    const tier = await chooseByKeyboard(window, '[data-compose-field="tier"]', TIER)
    note(tier.ok ? 'ok' : 'FAIL', `chose ${TIER} with real arrow keys${tier.ok ? ` (${JSON.stringify(tier.label)})` : `: ${tier.why}`}`)
    if (!tier.ok) return

    const firstRole = await window.evaluate(`(() => {
      const node = document.querySelector('[data-compose-field="role"]')
      if (!node) return null
      return [...node.options].map(o => o.value).find(v => v && v.length > 0) || null
    })()`)
    if (!firstRole) { note('FAIL', 'the panel offers no role, and the form will not start without one'); return }
    const role = await chooseByKeyboard(window, '[data-compose-field="role"]', firstRole)
    note(role.ok ? 'ok' : 'FAIL', `chose a role${role.ok ? ` (${JSON.stringify(role.label)})` : `: ${role.why}`}`)
    if (!role.ok) return

    const typed = await typeReal(window, '[data-compose-field="message"]', PROMPT)
    note(typed.ok ? 'ok' : 'FAIL', `typed the question with real keystrokes: ${JSON.stringify(typed.landed || typed.why)}`)
    if (!typed.ok) return

    const startTarget = await window.evaluate(`(() => {
      const visible = node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node)
        return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
      const button = [...document.querySelectorAll('button')].filter(visible).find(node => /^start/i.test(node.textContent.trim()))
      if (!button) return null
      if (!button.id) button.id = 'metrics-drive-start'
      return { selector: '#' + button.id, label: button.textContent.trim().slice(0, 40), disabled: button.disabled === true }
    })()`)
    if (!startTarget) { note('FAIL', 'there is no Start control on the panel'); return }
    const started = await press(window, startTarget.selector)
    note(started.pressed ? 'ok' : 'FAIL', `pressed ${JSON.stringify(startTarget.label)}${started.pressed ? ` at (${started.at.x}, ${started.at.y})` : `: ${started.why}`}`)
    if (!started.pressed) return

    console.log('\n[3] waiting for a real answer (a cold start plus a turn)')
    const deadline = Date.now() + 180_000
    let heard = null
    for (;;) {
      heard = await window.evaluate(`(() => {
        const panel = document.querySelector('.computers') || document.body
        const text = panel.innerText || ''
        const inField = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
        const isEcho = node => String(node.textContent || '').includes(${JSON.stringify(PROMPT)})
        const spoken = [...document.querySelectorAll('*')]
          .filter(node => node.children.length === 0
            && (node.textContent || '').includes(${JSON.stringify(PROOF)})
            && !inField(node) && !isEcho(node))
          .map(node => ({ cls: String(node.className || '').slice(0, 40), text: String(node.textContent || '').trim().slice(0, 100) }))
        return {
          hasProof: spoken.length > 0,
          spokenIn: spoken.slice(0, 3),
          refusals: [...document.querySelectorAll('[data-refusal-code]')].map(n => n.getAttribute('data-refusal-code')),
          notLoggedIn: /Not logged in|Please run \\/login/.test(text),
          exampleMode: /This is the example fleet/i.test(text),
          tail: text.slice(-320),
        }
      })()`)
      if (heard?.hasProof || heard?.refusals?.length || heard?.notLoggedIn || Date.now() > deadline) break
      await delay(2500)
    }
    if (heard?.hasProof) note('ok', `a real Codex agent answered: ${JSON.stringify(heard.spokenIn)}`)
    else if (heard?.refusals?.length) note('FAIL', `the start was refused: ${JSON.stringify(heard.refusals)} · ${JSON.stringify(heard.tail)}`)
    else if (heard?.notLoggedIn) note('FAIL', 'the lent Codex sign-in was not accepted by the child')
    else note('FAIL', `no answer inside the budget · ${JSON.stringify(heard?.tail)}`)

    /* The run is recorded BEFORE the child is spawned (shell/spawn-record.cjs),
       so the page has something to show even if the answer never arrives. The
       measurement below is therefore taken either way, and says which. */

    /* ----------------------------------------------------------------- after */
    console.log('\n[4] the same metrics page, after a run this file caused')
    const backToMetrics = await walkTo(window, 'metrics')
    note(backToMetrics.ok ? 'ok' : 'FAIL', `walked back to #/metrics${backToMetrics.ok ? '' : `: ${backToMetrics.why}`}`)
    if (!backToMetrics.ok) return
    await delay(2600)
    const after = await readMetrics(window)

    note('info', `state=${after.state} note=${JSON.stringify(after.note.slice(0, 200))}`)
    note('info', `tiles after: ${JSON.stringify(after.tiles.map(tile => `${tile.label}=${tile.value} ${tile.unit}`))}`)
    note('info', `activity: ${JSON.stringify(after.activity)}`)
    note('info', `outcomes: ${JSON.stringify(after.outcomes)}`)
    note('info', `run rows: ${JSON.stringify(after.runRows.slice(0, 4))}`)

    const runsTile = after.tiles.find(tile => /agent runs/i.test(tile.label))
    const movedFrom = before.tiles.find(tile => /agent runs/i.test(tile.label))?.value ?? '—'
    const countedOne = runsTile && Number(runsTile.value) >= 1
    note(countedOne ? 'ok' : 'FAIL',
      countedOne
        ? `the run I caused is counted: "Agent runs" went ${movedFrom} → ${runsTile.value}`
        : `the page did not count the run I caused: "Agent runs" reads ${JSON.stringify(runsTile?.value)}`)

    const drewIt = after.activity.drawn && after.activity.runsDrawn >= 1
    note(drewIt ? 'ok' : 'FAIL',
      drewIt
        ? `the activity grid drew it: ${after.activity.runsDrawn} run(s) in ${after.activity.litCells} lit cell(s) · ${JSON.stringify(after.activity.sub)}`
        : `the activity grid did not draw the run: ${JSON.stringify(after.activity)}`)

    const listedIt = after.runRows.length >= 1
    note(listedIt ? 'ok' : 'FAIL',
      listedIt
        ? `the run list shows it: ${JSON.stringify(after.runRows[0])}`
        : 'the run list is empty after a run that was recorded before the child was spawned')

    note(after.oldRefusalOnScreen ? 'FAIL' : 'ok',
      after.oldRefusalOnScreen ? 'the fleet-host refusal came back' : 'the fleet-host refusal is still nowhere on the page')

    writeEvidence(scratch, 'metrics-before-after.json', JSON.stringify({ before, after, heard }, null, 2))
    console.log(`\nevidence: ${path.join(scratch, 'metrics-before-after.json')}`)
  } finally {
    /* BOUNDED, because closeWindow()'s graceful step evaluates `window.close()`
       over the debugger with awaitPromise, and a page that closes never sends
       the response -- so the send hangs, the try/catch never fires, and node
       exits 13 on an unsettled top-level await AFTER every measurement has
       already printed. Measured on this file's second run. The verdict below is
       about the product; the teardown must not be able to overwrite it. */
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
