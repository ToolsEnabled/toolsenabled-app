#!/usr/bin/env node

/* DRIVE THE PROVIDER SIGN-IN SCREEN, AND THEN TRY TO START A CLAUDE AGENT.
 *
 * WHY THIS EXISTS RATHER THAN A UNIT TEST. The owner's standard is "I refuse to
 * believe you that anything works until you click through it", and he is right
 * about this product specifically: this tree has had a green suite while the
 * computers page could not draw, and green while a control that a hand could not
 * reach was reported as working. A suite asserts that a module returns the right
 * value. It cannot see a section that renders off the bottom of the window, a
 * link that routes nowhere, or a Start button whose press produces silence.
 *
 * WHAT IT MEASURES, in two halves:
 *
 *   1. THE SCREEN. Can a person actually GET to the provider list, by clicking
 *      what the product offers -- not by assigning location.hash, which is how a
 *      sibling harness once passed on a build where nothing routed there. Then:
 *      are all three programs on the glass, is each one's reach word there, and
 *      are the commands present and readable.
 *   2. THE CLAIM THE SCREEN MAKES ABOUT CLAUDE. The page tells a person Claude
 *      cannot start from a tree and can be handed work on the agent page. The
 *      first half is a claim about a control, so this presses that control and
 *      writes down what came back. SILENCE IS THE DEFECT: a start is a result, a
 *      named refusal is a result, and a press that produces no session, no words
 *      and no change on the glass is a fault.
 *
 * EVERY PRESS IS A REAL MOUSE EVENT. clickVisible() in the shared harness takes
 * document.elementFromPoint at the element's centre BEFORE dispatching, and
 * refuses with the name of whatever is on top rather than clicking through it.
 * This file adds the mouse MOVE that harness omits, so each press is move, down,
 * up at the same coordinates, which is what a hand produces. Nothing here calls
 * el.click() and nothing assigns a value.
 *
 * IT IS A REPORT, NOT A GATE, and that is deliberate. It prints what it saw and
 * exits non-zero only on the two things that are unambiguously the product being
 * wrong: a provider section that is not reachable, and a press that answers with
 * silence. Everything else is written down for a person to read.
 *
 *   node tools/provider-guide-drive.mjs            headless, isolated profile
 *   node tools/provider-guide-drive.mjs --visible  a window you can watch
 *
 * A run needs `npm run build` first; stage() refuses a stale renderer rather
 * than measuring the wrong bytes and reporting the difference as a defect.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  closeWindow,
  delay,
  openWindow,
  reap,
  route,
  screenText,
  seedMachineRecord,
  stage,
} from './test-account-harness.mjs'
import { GUIDE_HREF } from '../src/first-run-needs.js'

/* THE DOOR, AND WHAT COUNTS AS HAVING GONE THROUGH IT.
 *
 * The provider list used to be a page of its own at `#/guide`, so "the route is
 * guide" was the whole question. It is a section of Settings now, reached at
 * `#/settings?setting=<row>`, and `document.body.dataset.route` says only
 * `settings` for it -- which is also true six screens above the answer. So the
 * address is asked as well, and the row id is read off the same constant every
 * door in the product links to rather than spelled here a second time. */
const GUIDE_ROW = GUIDE_HREF.slice(GUIDE_HREF.indexOf('?') + 1)
const GUIDE_DOOR = `a[href="${GUIDE_HREF}"]`
async function atThisComputer(window) {
  if ((await route(window)) !== 'settings') return false
  const hash = await window.evaluate('location.hash')
  return String(hash || '').includes(GUIDE_ROW)
}


const PROVIDERS = ['codex', 'claude', 'gemini']

/* The reach word each provider's block must be showing. Duplicated from
   src/views/guide.js on purpose: a driver that imported the table would agree
   with the renderer by construction and could never catch the two disagreeing,
   which is the whole reason to drive rather than to unit-test. */
const EXPECTED_REACH = Object.freeze({
  codex: 'Works here now',
  /* Was 'Works on the agent page' until 2026-08-17, when that page was driven
     from the state this row is read in and found to have no door. The word now
     describes the LIMIT, which is the part that is actually known. */
  claude: 'Not from a tree in this copy',
  gemini: 'Nothing here starts it yet',
})

const findings = []
const note = (level, text) => { findings.push({ level, text }); console.log(`  ${level.padEnd(5)} ${text}`) }

/* A press that is move, down, up -- the three a hand produces. The shared
   harness dispatches only down and up; a control that reacts to hover before it
   will accept a press would be reported as dead by that, which is the harness
   being wrong about the product. */
async function press(window, selector) {
  const spot = await window.waitForVisible(selector, 9000)
  if (spot?.state !== 'visible') return { pressed: false, why: spot?.state === 'covered' ? `covered by ${spot.by}` : (spot?.state || 'unknown') }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await window.session.send('Input.dispatchMouseEvent', {
      type, x: spot.x, y: spot.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
    })
    await delay(40)
  }
  await delay(500)
  return { pressed: true, at: { x: Math.round(spot.x), y: Math.round(spot.y) } }
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'provider-guide-'))
  const profile = path.join(scratch, 'profile')
  let window = null
  try {
    console.log('staging the packaged build with this tree\'s renderer...')
    const { executable, appRoot } = await stage(scratch)
    seedMachineRecord(profile, appRoot, 'standard')

    console.log('opening...')
    window = await openWindow(executable, profile)
    console.log(`  window up, route=${await route(window)}`)

    /* ---------------------------------------------------------------
       1. Can a person REACH the provider list by clicking?
       --------------------------------------------------------------- */
    console.log('\n[1] getting to This computer by clicking what the product offers')
    const door = await window.evaluate(`(() => {
      const link = document.querySelector('${GUIDE_DOOR}')
      return link ? { found: true, text: (link.textContent || '').trim().slice(0, 80) } : { found: false }
    })()`)
    if (!door?.found) {
      note('FAIL', 'no door to This computer anywhere on the first screen: the section is unreachable by hand')
    } else {
      note('ok', `a door exists on the first screen: "${door.text}"`)
      const pressed = await press(window, GUIDE_DOOR)
      if (!pressed.pressed) note('FAIL', `the door could not be pressed: ${pressed.why}`)
      else note('ok', `pressed at (${pressed.at.x}, ${pressed.at.y})`)
    }
    await delay(700)
    const landed = await atThisComputer(window)
    note(landed ? 'ok' : 'FAIL', `after the press the address is "${await window.evaluate('location.hash')}"`)

    /* ---------------------------------------------------------------
       2. Are all three programs actually on the glass?
       --------------------------------------------------------------- */
    console.log('\n[2] the three programs, as a person sees them')
    const section = await window.waitForVisible('[data-need="provider-accounts"]', 9000)
    note(section?.state === 'visible' ? 'ok' : 'FAIL', `the sign-ins section is ${section?.state}`)

    for (const id of PROVIDERS) {
      const selector = `.guide-provider[data-provider="${id}"]`
      const seen = await window.waitForVisible(selector, 6000)
      if (seen?.state !== 'visible') {
        note('FAIL', `${id}: block is ${seen?.state}`)
        continue
      }
      const detail = await window.evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        if (!node) return null
        return {
          reach: node.dataset.reach,
          tag: (node.querySelector('.guide-need-tag')?.textContent || '').trim(),
          body: (node.querySelector('.guide-need-body')?.textContent || '').trim(),
          buttons: [...node.querySelectorAll('.guide-signin-btn')].filter(b => !b.hidden).map(b => (b.textContent || '').trim()),
          commands: [...node.querySelectorAll('.guide-command')].map(c => (c.textContent || '').trim()),
        }
      })()`)
      const tagOk = detail?.tag === EXPECTED_REACH[id]
      note(tagOk ? 'ok' : 'FAIL', `${id}: reach="${detail?.reach}" showing "${detail?.tag}"`)
      note(detail?.body?.length > 30 ? 'ok' : 'FAIL', `${id}: says "${(detail?.body || '').slice(0, 90)}..."`)
      /* THIS USED TO REQUIRE COMMANDS ON THE GLASS, and their absence is now the
         thing worth measuring. The page printed an install line and a sign-in
         line under every program, and the first external user copied them into
         one window and was told the program was not recognized. Two buttons do
         it instead, the same pair for all three. */
      const buttons = detail?.buttons || []
      note(buttons.some(text => /^Install /.test(text)) ? 'ok' : 'FAIL',
        `${id}: an Install button is on the glass -> ${JSON.stringify(buttons)}`)
      note(buttons.some(text => /^Sign in to /.test(text)) ? 'ok' : 'FAIL',
        `${id}: a Sign in button is on the glass -> ${JSON.stringify(buttons)}`)
      note((detail?.commands || []).length === 0 ? 'ok' : 'FAIL',
        `${id}: no command line is printed for anybody to copy -> ${JSON.stringify(detail?.commands)}`)
    }

    /* The rule that keeps this honest: nothing here may ever be a credential
       prompt. Checked on the rendered page, not on the source. */
    const asksForSecret = await window.evaluate(`(() => {
      const text = (document.querySelector('[data-need="provider-accounts"]')?.innerText || '').toLowerCase()
      return ['paste your', 'api key here', 'enter your key', 'copy your token'].filter(p => text.includes(p))
    })()`)
    note(Array.isArray(asksForSecret) && asksForSecret.length === 0 ? 'ok' : 'FAIL',
      `the screen asks for no credential (${JSON.stringify(asksForSecret)})`)

    /* Nothing on this page may render a filesystem path. */
    const paths = await window.evaluate(`(() => {
      const text = document.querySelector('[data-need="provider-accounts"]')?.innerText || ''
      return (text.match(/[A-Za-z]:\\\\[^\\s"']+/g) || []).slice(0, 5)
    })()`)
    note(Array.isArray(paths) && paths.length === 0 ? 'ok' : 'FAIL',
      `no filesystem path is rendered (${JSON.stringify(paths)})`)

    /* ---------------------------------------------------------------
       3. Do the two places that talk about Claude agree with each other?

       THE DEFECT THIS CATCHES is the one the guide was written to end. For a
       release the ONLY thing the product said about Claude was the tier menu's
       "cannot start from a tree yet", with nowhere saying where it DOES work --
       so a person read it as "Claude is not supported" and never found the agent
       page. The guide now says both halves. That repair fails the moment the two
       drift, and drift is silent: they are different modules, edited by different
       lanes, and nothing renders them on the same screen.

       So this reads the sentence the REFUSAL would show and the sentence the
       GUIDE shows, out of the running bundle, and checks they still tell the
       same person the same thing. It reads them rather than pressing Start
       because the press is on the research page, behind creating a tree, and
       that path plus its refusal copy is being actively changed by another lane
       in this same worktree this pass. Measuring a control mid-repair and
       reporting the result as the product's behaviour would be worse than not
       measuring it: the number would be stale before it was written down.
       --------------------------------------------------------------- */
    console.log('\n[3] the two places that talk about Claude, checked against each other')
    const guideSays = await window.evaluate(
      `(document.querySelector('.guide-provider[data-provider="claude"] .guide-need-body')?.textContent || '').trim()`,
    ).then(value => (typeof value === 'string' ? value : ''))

    /* THE REFUSAL SENTENCE IS READ HERE, IN THE DRIVER, NOT IN THE PAGE.
       The first version of this imported '/src/agent-availability-copy.js' from
       the renderer and got nothing, because a packaged build serves one bundled
       and minified file and that specifier does not exist at runtime. That was
       the harness being unable to look, which is not the product failing to
       agree -- so it reported `info`, and this replaces it with a real
       comparison rather than leaving a hole labelled honestly. */
    const refusalSays = await import(`file://${path.join(process.cwd(), 'src', 'agent-availability-copy.js')}`)
      .then(module => module.UNAVAILABLE_TEXT?.AGENT_TIER_NO_LAUNCHER || null)
      .catch(() => null)

    note(guideSays.length > 0 ? 'ok' : 'FAIL', `the guide's Claude sentence is on the glass: "${guideSays.slice(0, 110)}..."`)
    /* THIS USED TO REQUIRE THE SENTENCE TO NAME THE AGENT PAGE, as "where Claude
       DOES work". Another lane drove that page on 2026-08-17 from the state this
       copy is read in -- a set-up machine, a tree, a refused start -- and found
       ZERO doors to it: no link, no enabled control, and the agent route is not
       on the ring. So the assertion is inverted. A driver that DEMANDS a
       direction is how a dead end gets held in place by the thing meant to catch
       it, which is worse than having no check at all. */
    note(!/agent page/i.test(guideSays) ? 'ok' : 'FAIL', 'the guide does NOT send a person to a page with no route to it')
    note(/tree/i.test(guideSays) ? 'ok' : 'FAIL', 'the guide says where Claude does not work (from a tree)')
    note(/sign-in/i.test(guideSays) ? 'ok' : 'FAIL', 'the guide says the person\'s own sign-in is not the problem')

    if (refusalSays === null) {
      note('FAIL', 'the refusal sentence could not be read, so the two could not be compared')
    } else {
      note('info', `the refusal would say: "${refusalSays.slice(0, 130)}..."`)
      /* They need not be word for word -- one is a page and one is a control --
         but they must not CONTRADICT, and neither may name a destination that
         has no route from where it is read. */
      const neitherDirects = !/agent page/i.test(refusalSays) && !/agent page/i.test(guideSays)
      note(neitherDirects ? 'ok' : 'FAIL', 'neither the refusal nor the guide points at a page with no door on it')
      const bothNameTheBuild = /does not carry the part/i.test(refusalSays) && /does not carry the part/i.test(guideSays)
      note(bothNameTheBuild ? 'ok' : 'FAIL', 'both put the reason in THIS BUILD rather than on the person or their sign-in')
    }

    const text = await screenText(window)
    note('info', `the guide mentions Claude ${(text.match(/Claude/g) || []).length} time(s) and Gemini ${(text.match(/Gemini/g) || []).length} time(s)`)
    note('info', 'NOT MEASURED HERE: pressing Start on a Claude tier. That control and its refusal copy are being changed by another lane in this worktree this pass; the lane that owns it is driving it.')

    /* ---------------------------------------------------------------
       4. Does the page report what THIS machine actually has?

       THE PROFILE MAKES THIS A REAL TEST RATHER THAN A TAUTOLOGY. The harness
       runs the build against an isolated USERPROFILE, so none of the three
       sign-in files exist -- while PATH is still the real one, so the programs
       themselves ARE resolvable. That is precisely the "installed here, but
       nobody is signed in" state, which is the most useful one to get right and
       the hardest to reach on the machine this is written on, where all three
       are signed in.

       The read crosses a preload bridge into the main process and back, so a
       missing handler, a refused sender or a renderer that never calls it all
       show up here as a line that stayed hidden.
       --------------------------------------------------------------- */
    console.log('\n[4] what the page says about THIS machine')
    /* Waited for rather than sampled: the read is asynchronous and the page is
       painted before it answers. A single sample here would report a hidden line
       as a defect, which is the harness being wrong about the product. */
    const presence = await (async () => {
      const until = Date.now() + 9000
      for (;;) {
        const seen = await window.evaluate(`(() => {
          return [...document.querySelectorAll('.guide-provider')].map(node => {
            const slot = node.querySelector('.guide-presence')
            return {
              id: node.dataset.provider,
              hidden: slot ? slot.hidden : null,
              text: slot ? (slot.textContent || '').trim() : null,
              installed: slot ? slot.dataset.installed || null : null,
              signedIn: slot ? slot.dataset.signedIn || null : null,
            }
          })
        })()`)
        if ((Array.isArray(seen) && seen.some(row => row.hidden === false)) || Date.now() >= until) return seen
        await delay(300)
      }
    })()

    if (!Array.isArray(presence) || presence.every(row => row.hidden !== false)) {
      note('FAIL', 'no provider reported what this machine has: the read never reached the page')
    } else {
      for (const row of presence) {
        note(row.hidden === false ? 'ok' : 'FAIL',
          `${row.id}: installed=${row.installed} signedIn=${row.signedIn} -> "${row.text}"`)
        /* The cruel failure this guards: a confident "you are signed out" for a
           provider whose sign-in this product cannot actually see. */
        if (row.signedIn === 'unknown' && /nobody is signed in/i.test(row.text || '')) {
          note('FAIL', `${row.id}: reported a sign-out it could not have known`)
        }
      }
      /* On this isolated profile the sign-in files are absent by construction,
         so nothing may claim to be signed in. A "signed in" here would mean the
         probe is reading the REAL home instead of the profile it was given,
         which would also be a privacy fault. */
      const claimed = presence.filter(row => /and signed in/i.test(row.text || ''))
      note(claimed.length === 0 ? 'ok' : 'FAIL',
        `no provider claims a sign-in on a profile that has none (${claimed.map(row => row.id).join(', ') || 'none did'})`)
    }

    /* ---------------------------------------------------------------
       5. The page rebuilt from scratch, and why the absent-bridge case is NOT
          driven here.

       WHAT I TRIED FIRST AND WHY IT WAS WRONG. This section used to `delete
       window.mcProviders`, route away, route back, and assert the page stayed
       useful with no status lines. It reported three status lines shown and I
       nearly wrote that down as a product defect. It is not one. MEASURED
       directly afterwards, in this same packaged build:

         typeof window.mcProviders  before delete -> "object"
         typeof window.mcProviders  after  delete -> "object"
         Object.getOwnPropertyDescriptor(window, 'mcProviders')
                                    -> configurable: false, writable: false

       contextBridge.exposeInMainWorld defines a non-configurable, non-writable
       property, so `delete` fails silently in non-strict mode. The bridge was
       never removed, the page was right, and the harness was wrong. The
       absent-bridge state therefore CANNOT be simulated from inside the page,
       and a driver that pretends otherwise is measuring nothing.

       WHERE THAT GUARD IS COVERED INSTEAD. It is structural, not behavioural:
       fillPresence() reaches the bridge through `window.mcProviders?.presence()`
       inside a try/catch and returns on any falsy or malformed answer, and
       presenceSentence() returns null for every value that is not a real
       presence record -- which tools/test/first-run-needs.test.mjs asserts
       against null, undefined, '', 42, 'yes' and []. A hidden slot is the
       default state in the markup, so "no answer" needs no code to go right.

       WHAT IS DRIVEN HERE INSTEAD IS STILL WORTH DRIVING: the view is rebuilt
       from scratch on every navigation (src/main.js `case 'guide'` calls
       guideView() fresh, with no cache), so leaving and returning must produce a
       correctly filled page a second time. A read that only worked on first
       mount would be invisible to section 4.
       --------------------------------------------------------------- */
    console.log('\n[5] leaving the page and coming back rebuilds it correctly')
    await window.evaluate(`(async () => {
      location.hash = '#/'
      await new Promise(resolve => setTimeout(resolve, 700))
      location.hash = '${GUIDE_HREF}'
      await new Promise(resolve => setTimeout(resolve, 1600))
      return true
    })()`)
    const revisit = await window.evaluate(`(() => {
      const blocks = [...document.querySelectorAll('.guide-provider')]
      return {
        blocks: blocks.length,
        buttons: [...document.querySelectorAll('.guide-provider .guide-signin-btn')].filter(b => !b.hidden).length,
        shown: blocks.filter(node => node.querySelector('.guide-presence')?.hidden === false).length,
        errorish: /error|failed|undefined|\\[object/i.test(
          document.querySelector('[data-need="provider-accounts"]')?.innerText || '',
        ),
      }
    })()`)
    note(revisit?.blocks === 3 ? 'ok' : 'FAIL', `all three programs render again after leaving and returning (${revisit?.blocks})`)
    note(revisit?.buttons >= 6 ? 'ok' : 'FAIL', `the two buttons are on the glass again for all three (${revisit?.buttons})`)
    note(revisit?.shown === 3 ? 'ok' : 'FAIL', `and the machine was read again on the second visit (${revisit?.shown} of 3)`)
    note(revisit?.errorish === false ? 'ok' : 'FAIL', 'no error text leaked onto the page')
  } finally {
    if (window) {
      await closeWindow(window).catch(() => {})
      reap(window.timeline?.pid)
    }
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }) } catch { /* the profile outlives the run */ }
  }

  const failed = findings.filter(finding => finding.level === 'FAIL')
  console.log(`\n${findings.length} observation(s), ${failed.length} failing`)
  for (const finding of failed) console.log(`  FAIL ${finding.text}`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch(error => {
  console.error(`the driver itself failed, which is not a product defect: ${error?.stack || error}`)
  process.exitCode = 2
})
