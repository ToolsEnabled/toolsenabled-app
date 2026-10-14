#!/usr/bin/env node

/* Drive a real Claude turn and prove a product memory tool round trip through
 * product state. Use --claude-config-dir PATH for the existing sign-in home in
 * place, or ANTHROPIC_API_KEY from the environment. This spends provider budget.
 * The drive cannot certify isolation from the caller's own provider settings. */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
  userDataFor,
} from './test-account-harness.mjs'
import { chooseProviderThenModel } from './lib/compose-model-choice.mjs'

const CLAUDE_TIER = 'claude-sonnet'

/* The memory proof is COMPUTED by the session (31*47), so the value can never
   be an echo of what was typed. Guarded below, same device as the sibling
   proof driver, because this file's lineage includes a false pass built
   exactly that way. */
const MEMORY_PROOF = '1457'

const PROMPT_B = 'Use your toolsenabled MCP tools to compute 31 multiplied by 47, call memory_set to store the result as a string under key drive-proof in namespace scratch, then call memory_get to read it back. Reply with VALUE=<value read back>.'
for (const [name, prompt] of [['B', PROMPT_B]]) {
  if (prompt.includes(MEMORY_PROOF)) throw new Error(`the memory proof is inside prompt ${name}; the round trip could then be an echo`)
}

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* ---- real-input helpers, the same shapes every packaged driver here uses ---- */

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
  await delay(400)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
}

/* Escape first: pressing a native <select> opens the OS popup and the first
   ArrowDown lands there instead of on the element. Measured and corrected in
   tools/claude-tree-start-proof.mjs; the lesson is reused, not relearned. */
async function chooseByKeyboard(window, selector, wantedValue, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }
  await key(window, 'Escape', 27)
  await delay(120)
  /* FROM THE TOP (1.0.48). A provider change leaves the Model menu on that
     provider's default, which can sit BELOW the wanted row, and ArrowDown
     only moves down. Home puts the walk on the first row; a menu already on
     the wanted row is left alone, so no key moves it away and back. */
  if ((await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)) !== wantedValue) await key(window, 'Home', 36)
  for (let i = 0; i < maxPresses; i += 1) {
    const current = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
    if (current === wantedValue) return { ok: true, presses: i }
    await key(window, 'ArrowDown', 40)
    await delay(130)
  }
  return { ok: false, why: `never reached ${wantedValue} in ${maxPresses} presses` }
}

async function typeReal(window, selector, text) {
  const clicked = await press(window, selector)
  if (!clicked.pressed) return { ok: false, why: clicked.why }
  await window.session.send('Input.insertText', { text })
  await delay(200)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  return { ok: String(landed).includes(text.slice(0, 40)), landed: String(landed).slice(0, 90) }
}

/* ---- one driven phase: fresh profile, canary planted, one agent, one turn ---- */

async function drivePhase(label, staged, prompt, watchFor) {
  const profile = mkdtempSync(path.join(tmpdir(), `claude-iso-${label}-`))
  let window = null
  try {
    seedMachineRecord(profile, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, profile, { provider: 'claude' })

    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(3600)
    if (await window.evaluate(`location.hash.includes('setup')`)) {
      note('FAIL', `[${label}] the build stopped in setup; nothing below is about the product`)
      return null
    }
    const doorway = await press(window, '.computers .tree-empty-node')
    if (!doorway.pressed) { note('FAIL', `[${label}] no way into the compose panel: ${doorway.why}`); return null }

    /* Provider, then model (1.0.48): the Model menu lists one provider's rows. */
    const tierChosen = await chooseProviderThenModel((selector, value) => chooseByKeyboard(window, selector, value), CLAUDE_TIER)
    if (!tierChosen.ok) { note('FAIL', `[${label}] could not choose ${CLAUDE_TIER}: ${tierChosen.why}`); return null }
    const firstRole = await window.evaluate(`(() => {
      const node = document.querySelector('[data-compose-field="role"]')
      return node ? [...node.options].map(o => o.value).find(v => v && v.length > 0) || null : null
    })()`)
    if (!firstRole) { note('FAIL', `[${label}] the role menu offers nothing`); return null }
    const roleChosen = await chooseByKeyboard(window, '[data-compose-field="role"]', firstRole)
    if (!roleChosen.ok) { note('FAIL', `[${label}] could not choose a role: ${roleChosen.why}`); return null }

    const typed = await typeReal(window, '[data-compose-field="message"]', prompt)
    if (!typed.ok) { note('FAIL', `[${label}] the question never landed in the box: ${typed.why || typed.landed}`); return null }
    const startSelector = await window.evaluate(`(() => {
      const vis = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
        return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      const btn = [...document.querySelectorAll('button')].filter(vis).find(n => /^start/i.test(n.textContent.trim()))
      if (!btn) return null
      if (!btn.id) btn.id = 'proof-start-target'
      return '#' + btn.id
    })()`)
    if (!startSelector) { note('FAIL', `[${label}] no Start control on the panel`); return null }
    const started = await press(window, startSelector)
    note(started.pressed ? 'ok' : 'FAIL', `[${label}] pressed Start${started.pressed ? '' : `: ${started.why}`}`)
    if (!started.pressed) return null

    /* Read the agent surface, outside every form control, for the strings this
       phase watches. An answer inside the compose form is my own typing.
       300s, not 180: the fixed payload boots THREE MCP servers before the
       first tool call, and the packaged toolsenabled server is the app binary
       running as Node -- a measured cold start, not a hang. */
    const deadline = Date.now() + 300_000
    let last = null
    for (;;) {
      last = await window.evaluate(`(() => {
        const inForm = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
        const asked = ${JSON.stringify(prompt.slice(0, 60))}
        const leaves = [...document.querySelectorAll('*')].filter(n => n.children.length === 0 && !inForm(n)
          && !String(n.textContent || '').includes(asked))
        /* THE WINDOW FOLLOWS THE NEEDLE, and that is a harness fix, not a
           preference. A leaf matched on its FULL text and was then recorded as
           its first 160 characters, so an answer that reached the watched token
           later than that -- any answer with a sentence in front of it -- was
           counted as a hit here and then failed the value check downstream,
           which reads hit.text. A real memory round trip was reported as none. */
        const spokenWith = needle => leaves
          .filter(n => String(n.textContent || '').includes(needle))
          .map(n => {
            const full = String(n.textContent || '').trim()
            const at = full.indexOf(needle)
            return {
              cls: String(n.className || '').slice(0, 40),
              text: full.slice(Math.max(0, at - 40), at + 200)
            }
          })
        const panelText = (document.querySelector('.computers') || document.body).innerText || ''
        return {
          watched: Object.fromEntries(${JSON.stringify(watchFor)}.map(w => [w, spokenWith(w)])),
          refusalCodes: [...document.querySelectorAll('[data-refusal-code]')].map(n => n.getAttribute('data-refusal-code')),
          notLoggedIn: panelText.includes('Not logged in') || panelText.includes('Please run /login'),
          exampleMode: /This is the example fleet/i.test(panelText),
          tail: panelText.slice(-400),
        }
      })()`)
      const answered = last && Object.values(last.watched).some(hits => hits.length > 0)
      if (answered || last?.refusalCodes?.length || last?.notLoggedIn || Date.now() > deadline) break
      await delay(2500)
    }
    return { profile, last }
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    /* The profile is NOT removed here: phase B's filesystem assertions read it.
       main() removes both at the end. */
  }
}

/* ---- the run ---- */

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'claude-iso-stage-'))
  const profiles = []
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)

    console.log('\n[real turn] product memory tool round trip with the caller-selected provider home')
    const fixed = await drivePhase('b', staged, PROMPT_B, ['VALUE='])
    if (!fixed) return
    profiles.push(fixed.profile)
    const value = fixed.last?.watched?.['VALUE='] || []

    /* The value must be the RIGHT one -- computed in-session, so it cannot be
       an echo of this prompt (guarded at the top of the file). */
    const rightValue = value.filter(hit => hit.text.includes(`VALUE=${MEMORY_PROOF}`))
    if (rightValue.length > 0) {
      note('ok', `[b] A PRODUCT TOOL RAN: memory set/get round-tripped a value computed in-session -- ${JSON.stringify(rightValue[0])}`)
    } else {
      note('FAIL', `[b] no memory round trip on the glass. saw VALUE hits=${JSON.stringify(value.slice(0, 2))} refusals=${JSON.stringify(fixed.last?.refusalCodes)} tail=${JSON.stringify(fixed.last?.tail)}`)
    }
    /* Where the memory PERSISTED: the product's OWN state root, which is
       userData/capability -- shell/main.cjs sets TOOLSENABLED_STATE_ROOT to
       exactly that before the first capability require, and the driver runs the
       app with --user-data-dir=<profile>/userdata. This used to walk
       <profile>/local (LOCALAPPDATA), which holds the machine record and the
       agent homes but NOT the state the product writes memory into -- so the
       check could only ever report "did not persist", whatever the tool did.
       The agent-home exclusion below is kept as a guard rather than a
       necessity: those homes live under local/, outside the tree now walked,
       and the confined transcript inside one of them repeats the prompt --
       an earlier draft of this file counted exactly that echo as proof. */
    const stateHits = []
    const agentHomes = path.join(fixed.profile, 'local', 'ToolsEnabled', 'agent-home')
    const walk = dir => {
      if (dir === agentHomes) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) walk(full)
          else if (statSync(full).size < 32 * 1024 * 1024
            && readFileSync(full, 'latin1').includes('drive-proof')) stateHits.push(full)
        } catch { /* unreadable is not evidence */ }
      }
    }
    try { walk(path.join(userDataFor(fixed.profile), 'capability', 'state')) } catch { /* no state tree */ }
    note(stateHits.length > 0 ? 'ok' : 'FAIL',
      stateHits.length > 0
        ? `[b] the memory write persisted in the profile's own product state: ${stateHits.map(h => path.relative(fixed.profile, h)).join(', ')}`
        : '[b] no product state OUTSIDE the agent homes carries the memory key; the tool call did not persist where the product reads')
  } finally {
    const failedRun = findings.some(f => f.level === 'FAIL')
    for (const profile of profiles) {
      /* A failing run KEEPS its profiles: the confined transcript inside is
         the post-mortem. A green run cleans up after itself. */
      if (failedRun) { note('info', `kept for post-mortem: ${profile}`); continue }
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }) } catch { /* outlives the run */ }
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* outlives the run */ }
  }

  const failed = findings.filter(f => f.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const f of failed) console.log(`  FAIL ${f.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the harness itself failed: ${error?.stack || error}`)
  process.exitCode = 2
})
