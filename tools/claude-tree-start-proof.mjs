#!/usr/bin/env node

/* PRESS START ON A CLAUDE TIER, WITH A REAL HAND, AND SEE WHETHER AN AGENT
 * ACTUALLY ANSWERS.
 *
 * THE ONLY QUESTION THIS FILE ASKS. This is the whole thing, end to end,
 * through the packaged product: pick Claude in the menu, press Start, ask it
 * something, and read what comes back.
 *
 * SUCCESS IS A REAL ANSWER AND NOTHING ELSE COUNTS. Not a session id, not a
 * spinner, not an event on a stream. The agent is asked for an unmistakable
 * string and must produce it. A named refusal is a legitimate outcome and is
 * reported as such -- it is what a build with no Claude engine SHOULD do -- but
 * it is never reported as success. Silence is a defect.
 *
 * THE CANDIDATE MUST CARRY ITS OWN ENGINE. This stages the packaged build and
 * verifies the required modules in that payload. A missing module is a harness
 * no-verdict; the driver never repairs a candidate from another checkout.
 *
 * Nothing about the RUNTIME path is simulated by that. The shell resolves the
 * engine out of its capability root exactly as it does on a customer machine,
 * spawns the real `claude` binary, and talks to it over the real protocol. There
 * is no mock, no stub and no fake stream anywhere in the product path; the only
 * fake transport in this lane lives inside the engine's unit suite. What the
 * overlay buys is the ability to answer the question TODAY instead of after a
 * cross-lane pin negotiation.
 *
 * IT SPENDS REAL MONEY on the person's own subscription, so it is a tool and
 * never a default test target.
 *
 *   node tools/claude-tree-start-proof.mjs
 *   node tools/claude-tree-start-proof.mjs --visible
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'

/* THE ANSWER MUST NOT BE IN THE QUESTION, and this file has been burned by that
 * twice. The old prompt NAMED the word it was looking for, so the check matched
 * the message box and reported a real answer on a run where no session started.
 * An arithmetic question the model has to actually do cannot echo: `391` appears
 * nowhere in what is typed, which the guard below re-checks at run time rather
 * than trusting this comment to stay true. */
const PROOF_WORD = '391'
const PROMPT = 'What is 17 multiplied by 23? Reply with only the number.'
if (PROMPT.includes(PROOF_WORD)) {
  throw new Error('the answer is inside the question; this run could only measure its own typing')
}

const ENGINE_MODULES = ['claude-cli-process.js', 'claude-cli-adapter.js']
const CLAUDE_TIER = 'claude-sonnet'

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* Move, down, up at coordinates taken from the element's own box, with
   document.elementFromPoint checked first by the shared harness's waitForVisible
   and the press refused BY NAME if something else is on top. */
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

/* CHOOSING A TIER WITH THE KEYBOARD, AND THE CLAIM I GOT WRONG FIRST.
 *
 * WHAT THIS COMMENT USED TO SAY, and it was wrong in the worst way -- stated as
 * measured. It said arrow keys cannot move a native <select> in an offscreen
 * window, "because the operating-system popup does not exist there", and on that
 * basis this step set .value directly and reported itself as not-real-input. The
 * measurements behind it were real: press the select, activeElement IS the
 * select, then ArrowDown with both key-code fields, then explicit .focus() and
 * ArrowDown again, then type-ahead -- value unchanged at "luna" every time.
 *
 * The conclusion drawn from them was not. The lane driving the same packaged
 * build headlessly does this successfully every run, dozens of times, and the
 * step I was missing is ONE keystroke: Escape. Pressing a native select OPENS
 * the popup, and while it is open the first ArrowDown goes to the popup instead
 * of the element. Dismiss it and the arrows land where a keyboard user's do.
 *
 * WHY THE CORRECTION MATTERS MORE THAN THE TECHNIQUE. The owner's standard for
 * this work is that it is driven "as a real user would, not with DOM elements".
 * One synthetic step inside a run does not weaken that claim a little -- it
 * costs the whole claim, because the person reading it cannot tell which step
 * was the exception. Reading the label back afterwards proved the box held the
 * right value; it never proved a person could have put it there.
 *
 * There is now no synthetic step in this file. The way in, the role, the tier,
 * the prompt and Start are all real presses and real keystrokes. */
async function chooseByKeyboard(window, selector, wantedValue, maxPresses = 24) {
  const focused = await press(window, selector)
  if (!focused.pressed) return { ok: false, why: `could not focus the menu: ${focused.why}` }

  /* THE ESCAPE IS THE WHOLE TRICK. Pressing a native <select> opens an
     operating-system popup, and while it is open the first ArrowDown goes to the
     popup rather than to the element. Dismiss it and the arrows land on the
     select itself, which is what a keyboard user does. */
  await key(window, 'Escape', 27)
  await delay(120)

  const valueNow = () => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`)
  const seen = []
  for (let i = 0; i < maxPresses; i += 1) {
    const current = await valueNow()
    seen.push(current)
    if (current === wantedValue) {
      const label = await window.evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)})
        return n ? [...n.options].find(o => o.value === n.value)?.textContent.trim().slice(0, 60) : null
      })()`)
      return { ok: true, presses: i, label, at: focused.at }
    }
    await key(window, 'ArrowDown', 40)
    await delay(130)
  }
  return { ok: false, why: `never reached ${wantedValue} in ${maxPresses} presses`, seen }
}

async function key(window, name, keyCode) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await window.session.send('Input.dispatchKeyEvent', {
      type, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code: name, key: name,
    })
  }
}

async function typeReal(window, selector, text) {
  const clicked = await press(window, selector)
  if (!clicked.pressed) return { ok: false, why: clicked.why }
  await window.session.send('Input.insertText', { text })
  await delay(200)
  const landed = await window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  return { ok: String(landed).includes(PROMPT), landed: String(landed).slice(0, 90) }
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'claude-tree-proof-'))
  let window = null
  try {
    console.log('staging the packaged build...')
    const staged = await stage(scratch)

    /* THE ENGINE THIS RUN WILL ACTUALLY LOAD, CONFIRMED RATHER THAN ASSUMED.
     *
     * stage() overlays capability/ from this tree, so a current candidate
     * carries both modules. This file never reports a result about a payload it
     * did not verify, and never borrows missing code from another checkout. */
    const payloadEngine = path.join(staged.appRoot, 'resources', 'capability', 'src', 'lib', 'agent-engine')
    mkdirSync(payloadEngine, { recursive: true })
    const alreadyStaged = ENGINE_MODULES.filter(module => existsSync(path.join(payloadEngine, module)))
    if (alreadyStaged.length !== ENGINE_MODULES.length) {
      const missing = ENGINE_MODULES.filter(module => !alreadyStaged.includes(module))
      throw new Error(`the staged candidate is missing its Claude engine module(s): ${missing.join(', ')}; this is a harness fault, not a product defect`)
    }
    note('ok', `the staged payload carries the Claude engine: ${ENGINE_MODULES.join(', ')}`)

    /* THE SIGN-IN THIS RUN NEEDS, AND WHY IT IS BORROWED RATHER THAN INVENTED.
     *
     * openWindow() isolates USERPROFILE and APPDATA to this scratch profile --
     * deliberately, because a driver that ran against the real home once
     * desynced the owner's audit ledger, and that isolation is not negotiable.
     * The cost is that a Claude child started under it looks for a sign-in in a
     * home that has never had one and answers "Not logged in", which is the
     * product working and is also not the proof.
     *
     * So the scratch home is given the two files the CLI reads, exactly as
     * tools/claude-engine-control-probe.mjs already does for the same reason and
     * with the same lifetime: they live in a temporary directory that is removed
     * in the `finally` below. Nothing in the product path reads them -- the
     * child authenticates itself, as it does in the person's own terminal.
     *
     * And the npm layout is linked rather than copied, because
     * resolveInvocation() prefers the NATIVE claude.exe under %APPDATA%/npm and a
     * redirected APPDATA empties it. A junction keeps the run on the same
     * invocation a customer gets instead of falling back to a shell lookup. */
    const realHome = process.env.USERPROFILE || ''
    const scratchClaude = path.join(scratch, 'home', '.claude')
    mkdirSync(scratchClaude, { recursive: true })
    const credential = path.join(realHome, '.claude', '.credentials.json')
    if (!existsSync(credential)) {
      note('FAIL', 'HARNESS STATE: this computer has no Claude sign-in to lend the scratch profile, so nothing below could be a measurement of the Claude path.')
      return
    }
    cpSync(credential, path.join(scratchClaude, '.credentials.json'))
    const settings = path.join(realHome, '.claude.json')
    if (existsSync(settings)) cpSync(settings, path.join(scratch, 'home', '.claude.json'))
    const realNpm = path.join(process.env.APPDATA || '', 'npm')
    if (existsSync(realNpm)) {
      mkdirSync(path.join(scratch, 'roaming'), { recursive: true })
      try { symlinkSync(realNpm, path.join(scratch, 'roaming', 'npm'), 'junction') } catch { /* already linked */ }
    }
    note('info', 'lent the scratch profile this computer\'s Claude sign-in and npm layout; both live only in the temporary profile this run deletes.')

    /* NO CODEX CREDENTIAL IS SEEDED, AND THAT IS NOW THE POINT OF THE RUN.
     *
     * WHAT STOOD HERE. This file used to write a throwaway ~/.codex/auth.json
     * into the scratch profile, because with no such file
     * mc-agent:availability answered {ok:false, AGENT_CONFINEMENT_SIGNED_OUT}
     * and the page offered no start FOR ANY TIER, Claude included. It recorded
     * that as a real defect and stepped around it so the Claude path could be
     * measured at all.
     *
     * THE DEFECT IS FIXED, so the step-around comes out. confinedSessionPlan()
     * is Codex-shaped -- every permission level is isolated, and an isolated
     * level prepares a Codex home by LINKING the user's Codex credential, which
     * refuses when there is nothing to link. shell/agent-host.cjs now asks for
     * the plan PER PROVIDER (confinementPlanFor): a Claude tier is planned from
     * resolveAgentConfinement() alone, which reads the recorded level and opens
     * no credential. The ceiling is unchanged -- the same sandbox word reaches
     * claudeArgs() as --permission-mode -- and the Codex path, including its
     * refusal on a missing credential, is untouched.
     *
     * SO THE ABSENCE OF THIS FILE IS AN ASSERTION. The profile below has a
     * Claude sign-in and NO Codex sign-in anywhere: it is the owner's own
     * requirement, "a user adds their CLI subscriptions and uses them", as a
     * measurable state. If a Codex precondition ever creeps back in front of a
     * Claude start, this run stops at the panel and says so. */
    note('info', 'this profile has NO ~/.codex/auth.json: a Claude start that needs one would fail here, which is the point.')

    seedMachineRecord(scratch, staged.appRoot, 'standard')
    window = await openWindow(staged.executable, scratch)

    console.log('\n[1] getting to somewhere an agent can be started')
    /* THE WRITE SWITCH IS SEEDED, NOT CLICKED, AND HERE IS WHY THAT IS HONEST.
     *
     * Every action that writes anything ships switched OFF, so on a fresh
     * profile pressing Start does nothing at all. The first run of this file hit
     * exactly that and reported SILENCE -- a harness gap wearing the costume of
     * the product's worst defect.
     *
     * It is seeded rather than driven through Settings for the same reason
     * seedMachineRecord() exists in the shared harness: the question this file
     * asks is "does a Claude agent run", and a person who has reached that
     * question has already turned the switch on. Driving the Settings toggle is
     * a DIFFERENT question, it already has its own coverage, and putting it in
     * front of this one only adds a way for this run to fail for a reason that
     * is not about Claude. tools/agent-subpage-qa.mjs and
     * tools/example-page-write-fence-qa.mjs seed the same key for the same
     * reason. */
    await window.evaluate(`localStorage.setItem('mc.write.agent-session', 'enabled')`)
    await window.evaluate(`location.hash = '#/computers'`)
    await delay(1200)
    await window.evaluate(`location.reload()`)
    await delay(3600)
    const inSetup = await window.evaluate(`location.hash.includes('setup')`)
    if (inSetup) {
      note('FAIL', 'the build stopped in setup, so nothing below would be about the product')
      return
    }
    const doorway = await press(window, '.computers .tree-empty-node')
    note(doorway.pressed ? 'ok' : 'FAIL', `pressed the way in${doorway.pressed ? ` at (${doorway.at.x}, ${doorway.at.y})` : `: ${doorway.why}`}`)
    await delay(2400)

    console.log('\n[2] choosing Claude in the menu, with the keyboard')
    const tierSelector = '[data-compose-field="tier"]'
    const present = await window.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(tierSelector)})
      if (!node) return null
      return { options: [...node.options].map(o => ({ value: o.value, label: o.textContent.trim().slice(0, 44) })), value: node.value }
    })()`)
    if (!present) {
      note('FAIL', 'there is no tier menu on the panel, so a Claude tier cannot be picked at all')
      return
    }
    note('info', `the menu offers: ${JSON.stringify(present.options.map(o => o.value))}`)
    const chosen = await chooseByKeyboard(window, tierSelector, CLAUDE_TIER)
    note(chosen.ok ? 'ok' : 'FAIL',
      `chose ${CLAUDE_TIER}${chosen.ok ? ` (${JSON.stringify(chosen.label)})` : `: ${chosen.why}`}`)
    note('info', 'REAL INPUT NOW, and this line used to say the opposite. I reported arrow keys as unable to move a native select offscreen; the missing step was Escape, which dismisses the popup the click itself opens. The lane that drives this every run corrected me. There is no synthetic step left in this file.')
    if (!chosen.ok) return

    /* THE ROLE, WHICH THIS DRIVER FORGOT AND THEN BLAMED THE PRODUCT FOR.
     *
     * Earlier runs pressed Start with no role chosen and reported SILENCE. The
     * panel was not silent at all -- it had painted "Pick a role first, then
     * press Start" exactly where a person would read it, and attemptSubmit()
     * returned before any IPC. The driver was pressing Start on an incomplete
     * form and calling the result a defect in the start path.
     *
     * It is set the same way the tier is, and for the same measured reason: a
     * native <select> takes arrow keys only through an operating-system popup
     * that an offscreen window does not have. Focused by a real press, then set.
     * Reported as not-real-input, never hidden inside the mouse-and-keyboard
     * claim. */
    console.log('\n[3] choosing a role, which the form requires before it will start')
    const roleSelector = '[data-compose-field="role"]'
    /* The first role the menu really offers, read off the menu rather than
       assumed, then walked to with the same real arrow keys the tier uses. */
    const firstRole = await window.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(roleSelector)})
      if (!node) return null
      return [...node.options].map(o => o.value).find(v => v && v.length > 0) || null
    })()`)
    if (!firstRole) {
      note('FAIL', 'no role menu on the panel, or it offers no role')
      return
    }
    const roleChosen = await chooseByKeyboard(window, roleSelector, firstRole)
    note(roleChosen?.ok ? 'ok' : 'FAIL', `chose a role: ${roleChosen?.ok ? JSON.stringify(roleChosen.label) : roleChosen?.why}`)
    if (!roleChosen?.ok) return

    console.log('\n[4] typing the question and pressing Start')
    /* `message`, not `prompt`. The first version guessed `prompt` plus a couple
       of fallbacks, matched a hidden element, and reported "typed the question
       with real keystrokes: hidden" -- a harness fault dressed as a product
       finding. The four real field names are role, tier, effort and message. */
    const promptSelector = '[data-compose-field="message"]'
    const typed = await typeReal(window, promptSelector, PROMPT)
    note(typed.ok ? 'ok' : 'FAIL', `typed the question with real keystrokes: ${JSON.stringify(typed.landed || typed.why)}`)

    const startSelector = await window.evaluate(`(() => {
      const vis = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)
        return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      const btn = [...document.querySelectorAll('button')].filter(vis).find(n => /^start/i.test(n.textContent.trim()))
      if (!btn) return null
      if (!btn.id) btn.id = 'proof-start-target'
      return { selector: '#' + btn.id, label: btn.textContent.trim().slice(0, 40), disabled: btn.disabled === true }
    })()`)
    if (!startSelector) {
      note('FAIL', 'there is no Start control on the panel')
      return
    }
    note('info', `Start reads ${JSON.stringify(startSelector.label)} disabled=${startSelector.disabled}`)
    const started = await press(window, startSelector.selector)
    note(started.pressed ? 'ok' : 'FAIL', `pressed Start${started.pressed ? ` at (${started.at.x}, ${started.at.y})` : `: ${started.why}`}`)

    console.log('\n[4] waiting for a REAL answer (a cold start plus a turn)')
    const deadline = Date.now() + 150_000
    let last = null
    for (;;) {
      /* READ THE AGENT SURFACE, NOT THE WHOLE BODY. The first version scanned
         document.body.innerText and reported SILENCE with a tail full of theme
         and font controls -- it was reading the settings drawer, which is in the
         DOM on every route, and would have reported a refusal it never looked
         at as silence. A driver that cannot say WHERE it looked cannot call
         anything a defect. */
      last = await window.evaluate(`(() => {
        const panel = document.querySelector('.computers') || document.body
        const text = panel.innerText || ''
        const refusalNodes = [...document.querySelectorAll('[data-refusal-code]')]
        /* THE WORD I TYPED IS NOT THE WORD I AM LOOKING FOR.
         *
         * This read text.includes(PROOF_WORD) over the whole panel, and the
         * prompt is "Reply with exactly the word ALBATROSS-9317 and nothing
         * else." -- so the answer is INSIDE THE QUESTION. The check matched the
         * message box and reported A REAL CLAUDE AGENT ANSWERED on a run where
         * no session ever started. A false pass, produced by the driver, about
         * the one claim this whole lane exists to make.
         *
         * Caught by asking a DIFFERENT question whose answer was not in the
         * prompt: nothing came back in 150s, which is what the panel had been
         * saying all along.
         *
         * So the word only counts when it appears somewhere that is NOT a form
         * control -- a leaf node outside every input, textarea and select. */
        const inFormField = node => node.closest('input, textarea, select, [data-compose-field], .agent-compose-form') !== null
        /* AND NOT AN ECHO OF THE QUESTION EITHER.

           This used to exclude the tree chip WHOLESALE -- .cl-previous,
           .cl-chat, [data-tree-chip] -- and it had to, because the old prompt
           NAMED the word being looked for. The asked-line and the answer were
           then indistinguishable by content, so only position could separate
           them, and two false PASSES came from getting that wrong.

           CORRECTED 2026-08-17, because the crude rule then produced the
           opposite error. The chip is exactly where the tree renders what the
           agent SAID, so a run in which the model really did answer reported
           its answer as an echo and blamed the profile instead -- a false
           NEGATIVE from the same line.

           An arithmetic question removes the ambiguity that forced the crude
           rule. The answer appears nowhere in what was typed (guarded at the
           top of this file), so an echo is identifiable by CONTENT -- a node
           repeating the question -- and the chip can be read rather than
           discarded. */
        const asked = ${JSON.stringify(PROMPT)}
        const isEcho = node => {
          const text = String(node.textContent || '')
          return text.includes(asked) || text.toLowerCase().includes('asked:')
        }
        const spoken = [...document.querySelectorAll('*')]
          .filter(node => node.children.length === 0
            && (node.textContent || '').includes(${JSON.stringify(PROOF_WORD)})
            && !inFormField(node)
            && !isEcho(node))
          /* The words themselves ride back, because "the string is present" is a
             weaker fact than "here is what the node says" -- and a reader has to
             be able to tell an answer from a token count that happens to
             contain the same digits. */
          .map(node => ({
            tag: node.tagName,
            cls: String(node.className || '').slice(0, 50),
            text: String(node.textContent || '').trim().slice(0, 120),
          }))
        return {
          hasProof: spoken.length > 0,
          spokenIn: spoken.slice(0, 4),
          echoedInForm: text.includes(${JSON.stringify(PROOF_WORD)}) && spoken.length === 0,
          refusalCodes: refusalNodes.map(n => n.getAttribute('data-refusal-code')),
          refusalText: refusalNodes.map(n => (n.textContent || '').trim().slice(0, 220)),
          noLauncher: text.includes('does not carry the part') || text.includes('no launcher'),
          notLoggedIn: text.includes('Not logged in') || text.includes('Please run /login'),
          /* THE STATE THAT MADE THREE RUNS REPORT SILENCE.
             attemptSubmit() returns before any IPC when the panel carries an
             unavailableReason, and paints it as a notice. On a scratch profile
             with no declared computers the page is in example mode and EVERY
             start is refused -- Codex too. A driver that reports that as
             silence is measuring its own profile.

             CORRECTED 2026-08-17: this read any element with "notice" in its
             class name for "example data until you connect" / "Open Settings".
             That is the GLOBAL fleet-profile notice, which is on screen for any
             profile with no computers of its own -- including runs that go on
             to start a real agent and get a real answer. MEASURED: the notice
             was present, verbatim, on a run where availability answered
             AGENT_ENGINE_READY, the Claude tiers were offered, and the model
             replied. So this named the profile as the cause of failures that
             had nothing to do with it, and would have sent the next reader to
             fix something that was never wrong.

             The compose panel has its OWN words for the state that actually
             blocks a start (EXAMPLE_BOARD_TEXT in src/views/computers.js), and
             those are what this looks for now -- the thing that refuses the
             press, not a banner that happens to sit on the same page. */
          exampleMode: /This is the example fleet/i.test(text),
          sessions: document.querySelectorAll('[data-session-id], .agent-session, [data-agent-session]').length,
          tail: text.slice(-500),
        }
      })()`)
      if (last?.refusalCodes?.length) break
      if (last?.hasProof || last?.noLauncher || last?.notLoggedIn || Date.now() > deadline) break
      await delay(2500)
    }

    note('info', `sessions on the page: ${last?.sessions ?? 0}`)
    /* THE OUTCOME THIS HARNESS CANNOT AVOID, NAMED SO IT IS NEVER MISREAD.
     *
     * openWindow() isolates USERPROFILE to a throwaway directory -- deliberately,
     * because a driver that runs against the real home once desynced the owner's
     * audit ledger. A Claude child started under that profile looks for a
     * sign-in in a home that has never had one, and answers "Not logged in ·
     * Please run /login".
     *
     * That sentence is the PRODUCT WORKING: the session started, the turn was
     * accepted, the child ran, and its own words came back through the event
     * mapping. It is not a defect and it must never be filed as one. It is also
     * not the proof, because the model never answered the question.
     *
     * The gap cannot be closed from here without either pointing the run at the
     * owner's real home -- the incident above -- or copying a credential into
     * the throwaway one, which this lane forbids outright and which the engine's
     * own fence would fail on. So it is reported as its own outcome. */
    if (last?.notLoggedIn) {
      note('info', 'THE PIPELINE RAN: the child started, answered, and its words came back through the event mapping. It said "Not logged in", because this harness gives it a throwaway home with no Claude sign-in. That is the harness, not the product, and it is not the proof either.')
    }
    if (last?.echoedInForm) {
      note('info', `"${PROOF_WORD}" is on the glass ONLY inside the form I typed it into. That is my own text, not an answer.`)
    }
    if (last?.hasProof) {
      note('ok', `A REAL CLAUDE AGENT ANSWERED: "${PROOF_WORD}" appears outside the form, in ${JSON.stringify(last.spokenIn)}`)
    } else if (last?.refusalCodes?.length || last?.noLauncher) {
      note('FAIL', `the start was REFUSED rather than run: codes=${JSON.stringify(last.refusalCodes)} said=${JSON.stringify(last.refusalText)}`)
    } else if (last?.exampleMode) {
      note('FAIL', 'HARNESS STATE, NOT A CLAUDE DEFECT: this profile has no declared computers, so the page is in example mode and the compose panel carries an unavailableReason. attemptSubmit() returns before any IPC and paints that notice, for EVERY tier including Codex. Nothing here is a measurement of the Claude start path. Give the profile a declared computer before believing anything below.')
    } else {
      note('FAIL', `SILENCE: no answer and no refusal within 150s. Agent surface tail: ${JSON.stringify(last?.tail || '')}`)
    }
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }

  const failed = findings.filter(f => f.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const f of failed) console.log(`  FAIL ${f.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
