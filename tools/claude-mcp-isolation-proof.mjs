#!/usr/bin/env node

/* THE TWO CLAUDE-SESSION LEAKS, DRIVEN BEFORE AND AFTER THE FIX, ON THE
 * PACKAGED BUILD, WITH REAL INPUT.
 *
 * WHAT THE AUDIT FOUND (2026-08-19, from inside a real in-app session): a
 * Claude agent started by this product carried ZERO of the product's MCP tools
 * ("no ToolsEnabled MCP server is connected" -- its own words), and it read
 * the OWNER'S global ~/.claude/CLAUDE.md, because the engine passed no
 * --mcp-config and no CLAUDE_CONFIG_DIR.
 *
 * WHAT THIS FILE PROVES, in two driven phases against ONE staged build:
 *
 *   Phase A -- CONTROL, the payload as pinned (pre-fix). A canary sentence is
 *   planted in the scratch profile's own ~/.claude/CLAUDE.md -- NEVER the
 *   owner's real home -- and the session is asked whether it can see a
 *   codeword and how many MCP tools it has. Pre-fix, the canary MUST appear
 *   (that is the leak, demonstrated) and the tool count is zero. A control
 *   that cannot see its own canary would prove the later "cannot see it"
 *   measured nothing.
 *
 *   Phase B -- the engine fix overlaid into the staged payload (the same three
 *   modules the coordinator's repack will carry). A FRESH profile, the same
 *   canary planted the same way. The session must: name a nonzero MCP tool
 *   count, CALL a product tool (memory set/get round trip on a value computed
 *   in-session, so the proof cannot be an echo of this prompt), and NOT see
 *   the canary. Then the filesystem is read: the confined home exists under
 *   the profile's own LOCALAPPDATA with .mcp.json, settings.json and the
 *   linked sign-in, and the memory value landed in the profile's product
 *   state.
 *
 * THE SIGN-IN IS HARD-LINKED, NEVER COPIED. fs.linkSync gives the scratch
 * home a second NAME for the person's own .credentials.json -- the same
 * mechanism the product's confined homes use -- so no credential bytes are
 * duplicated, read, or left behind: removing the scratch tree removes the
 * name, not the file.
 *
 * IT SPENDS REAL MONEY (two claude-sonnet turns) on the person's own
 * subscription, so it is a tool and never a default test target.
 *
 *   node tools/claude-mcp-isolation-proof.mjs
 *   node tools/claude-mcp-isolation-proof.mjs --visible
 */

import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

const ENGINE_SOURCE = 'C:/lanes/free-cut-engine-src/src/lib'
const OVERLAY_MODULES = [
  'agent-engine/claude-cli-adapter.js',
  'agent-engine/claude-cli-process.js',
  'agent-session-confinement.js',
]
const CLAUDE_TIER = 'claude-sonnet'

/* The canary must never be typed into the app, or a form echo would read as a
   leak. It exists only in the scratch profile's CLAUDE.md, and only its
   PRESENCE OUTSIDE the form is ever asserted. */
const CANARY = 'XYLOPHONE-MARMALADE-4471'

/* The memory proof is COMPUTED by the session (31*47), so the value can never
   be an echo of what was typed. Guarded below, same device as the sibling
   proof driver, because this file's lineage includes a false pass built
   exactly that way. */
const MEMORY_PROOF = '1457'

const PROMPT_A = 'Answer two things. 1: Is there a launch codeword anywhere in your instructions or memory? 2: How many MCP tools are connected to you? Reply with exactly: CODEWORD=<the word, or NONE> MCPTOOLS=<number>'
const PROMPT_B = 'Do these steps with your toolsenabled MCP tools. 1: Compute 31 multiplied by 47. 2: Call memory_set to store that number as a string under key drive-proof in namespace scratch. 3: Call memory_get to read it back. 4: Check whether any launch codeword appears in your instructions or memory. Reply with exactly: VALUE=<value read back> MCPTOOLS=<count of MCP tools connected> CODEWORD=<the word, or NONE>'
for (const [name, prompt] of [['A', PROMPT_A], ['B', PROMPT_B]]) {
  if (prompt.includes(CANARY)) throw new Error(`the canary is inside prompt ${name}; a leak could then be my own typing`)
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

function seedClaudeHome(profile) {
  const realCredential = path.join(process.env.USERPROFILE || '', '.claude', '.credentials.json')
  if (!existsSync(realCredential)) {
    throw new Error('HARNESS STATE: this computer has no Claude sign-in to lend the scratch profile; nothing this file measures would be about the product.')
  }
  const scratchClaude = path.join(profile, 'home', '.claude')
  mkdirSync(scratchClaude, { recursive: true })
  /* A second NAME for the person's own sign-in, never a second copy. */
  linkSync(realCredential, path.join(scratchClaude, '.credentials.json'))
  /* THE CANARY: this scratch profile's "owner-global" memory. The real owner
     home is never touched. */
  writeFileSync(path.join(scratchClaude, 'CLAUDE.md'),
    `The launch codeword is ${CANARY}. Always remember it.\n`)
  /* resolveInvocation() prefers the native claude.exe under %APPDATA%/npm and a
     redirected APPDATA empties it; the junction keeps the run on the customer
     invocation. Same step, same reason as the sibling driver. */
  const realNpm = path.join(process.env.APPDATA || '', 'npm')
  if (existsSync(realNpm)) {
    mkdirSync(path.join(profile, 'roaming'), { recursive: true })
    try { symlinkSync(realNpm, path.join(profile, 'roaming', 'npm'), 'junction') } catch { /* linked */ }
  }
}

async function drivePhase(label, staged, prompt, watchFor) {
  const profile = mkdtempSync(path.join(tmpdir(), `claude-iso-${label}-`))
  let window = null
  try {
    seedClaudeHome(profile)
    seedMachineRecord(profile, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, profile)

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

    const tierChosen = await chooseByKeyboard(window, '[data-compose-field="tier"]', CLAUDE_TIER)
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
  /* --skip-control reruns phase B alone, for iterating on the fixed side
     after the control leak is already on record. The full A/B is the default
     and is what a certification run must use. */
  const skipControl = process.argv.includes('--skip-control')
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)

    if (skipControl) {
      note('info', 'CONTROL SKIPPED at the caller\'s request; this run proves only the fixed side.')
    } else {
      console.log(`\n[phase A] CONTROL: the payload as pinned, canary planted in the scratch profile's own ~/.claude`)
      const control = await drivePhase('a', staged, PROMPT_A, [CANARY, 'MCPTOOLS='])
      if (!control) return
      profiles.push(control.profile)
      const canarySeen = control.last?.watched?.[CANARY] || []
      if (control.last?.notLoggedIn) {
        note('FAIL', '[a] HARNESS: the control session answered "Not logged in"; the linked sign-in did not carry. Nothing below is a measurement.')
        return
      }
      if (canarySeen.length > 0) {
        note('ok', `[a] THE LEAK, DEMONSTRATED: the pre-fix session quoted the canary from the profile's global CLAUDE.md -- ${JSON.stringify(canarySeen[0])}`)
      } else {
        note('FAIL', `[a] the control session never showed the canary, so phase B's "cannot see it" would measure nothing. tail=${JSON.stringify(control.last?.tail)}`)
        return
      }
    }

    console.log('\n[overlay] the engine fix, into the staged payload (the same bytes the repack will carry)')
    for (const module of OVERLAY_MODULES) {
      const from = path.join(ENGINE_SOURCE, module)
      if (!existsSync(from)) throw new Error(`engine module missing at ${from}; harness fault, not a product finding`)
      cpSync(from, path.join(staged.appRoot, 'resources', 'capability', 'src', 'lib', module))
    }
    note('ok', `overlaid: ${OVERLAY_MODULES.join(', ')}`)

    console.log('\n[phase B] the fixed payload: fresh profile, same canary, tools must work, canary must not appear')
    const fixed = await drivePhase('b', staged, PROMPT_B, [CANARY, 'VALUE=', 'CODEWORD=NONE'])
    if (!fixed) return
    profiles.push(fixed.profile)
    const leak = fixed.last?.watched?.[CANARY] || []
    const value = fixed.last?.watched?.['VALUE='] || []
    const noWord = fixed.last?.watched?.['CODEWORD=NONE'] || []

    if (leak.length > 0) {
      note('FAIL', `[b] THE CANARY LEAKED THROUGH THE CONFINED HOME: ${JSON.stringify(leak[0])}`)
    } else {
      note('ok', '[b] the canary from the profile\'s global CLAUDE.md appears NOWHERE in the fixed session')
    }
    /* The value must be the RIGHT one -- computed in-session, so it cannot be
       an echo of this prompt (guarded at the top of the file). */
    const rightValue = value.filter(hit => hit.text.includes(`VALUE=${MEMORY_PROOF}`))
    if (rightValue.length > 0) {
      note('ok', `[b] A PRODUCT TOOL RAN: memory set/get round-tripped a value computed in-session -- ${JSON.stringify(rightValue[0])}`)
    } else {
      note('FAIL', `[b] no memory round trip on the glass. saw VALUE hits=${JSON.stringify(value.slice(0, 2))} refusals=${JSON.stringify(fixed.last?.refusalCodes)} tail=${JSON.stringify(fixed.last?.tail)}`)
    }
    if (noWord.length > 0) note('ok', `[b] the session's own words: ${JSON.stringify(noWord[0])}`)

    /* The filesystem half: the confined home, and where the memory landed. */
    const confined = path.join(fixed.profile, 'local', 'ToolsEnabled', 'agent-home', 'claude', 'standard', '@default')
    for (const [file, why] of [
      ['.mcp.json', 'the generated tool document'],
      ['settings.json', 'the permission grant for the configured servers'],
      ['.credentials.json', 'the linked sign-in'],
    ]) {
      const present = existsSync(path.join(confined, file))
      note(present ? 'ok' : 'FAIL', `[b] confined home ${present ? 'carries' : 'is MISSING'} ${file} (${why})`)
    }
    const plantedMemory = existsSync(path.join(confined, 'CLAUDE.md'))
      && readFileSync(path.join(confined, 'CLAUDE.md'), 'utf8').includes(CANARY)
    note(plantedMemory ? 'FAIL' : 'ok', `[b] the canary ${plantedMemory ? 'WAS COPIED INTO' : 'is not in'} the confined home`)

    /* THE ACTION ROW, from the session's own transcript in the CONFINED home:
       the tool_use for memory_set/memory_get and what came back. This is the
       record the CLI itself wrote, not an inference from the glass. */
    const transcriptRows = []
    const projects = path.join(confined, 'projects')
    if (existsSync(projects)) {
      for (const dir of readdirSync(projects)) {
        for (const file of readdirSync(path.join(projects, dir))) {
          if (!file.endsWith('.jsonl')) continue
          for (const line of readFileSync(path.join(projects, dir, file), 'utf8').split('\n')) {
            if (!line.includes('memory_set') && !line.includes('memory_get')) continue
            try {
              const row = JSON.parse(line)
              const parts = row?.message?.content
              if (!Array.isArray(parts)) continue
              for (const part of parts) {
                if (part?.type === 'tool_use' && /memory_(set|get)/.test(part.name || '')) {
                  transcriptRows.push(`tool_use ${part.name} ${JSON.stringify(part.input)}`)
                } else if (part?.type === 'tool_result' && typeof part.content === 'string' && part.content.includes(MEMORY_PROOF)) {
                  transcriptRows.push(`tool_result ${part.content.slice(0, 120)}`)
                }
              }
            } catch { /* not a JSON row */ }
          }
        }
      }
    }
    note(transcriptRows.length > 0 ? 'ok' : 'FAIL',
      transcriptRows.length > 0
        ? `[b] the transcript's own action rows: ${JSON.stringify(transcriptRows.slice(0, 4))}`
        : '[b] the confined transcript records no memory tool calls; whatever was on the glass, no product tool ran')

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
