#!/usr/bin/env node
/* THE STRANGER'S FIRST HOUR, DRIVEN AS A SECOND PERSON ON THIS COMPUTER.
 *
 * WHO IS RUNNING THIS. Not the owner. A person who has just installed the
 * product, has no account, has never seen the walkthrough, and whose only
 * instrument is the mouse. Everything below is done by clicking what is on the
 * glass. Nothing is asserted from source, nothing is reached by assigning
 * location.hash, and no state is prepared behind the window's back except the
 * one thing an installer would have done anyway.
 *
 * WHAT IT ANSWERS, IN ORDER.
 *   1. A virgin profile opens on the first-run question rather than on a screen
 *      that assumes a setup nobody has done.
 *   2. The permission-level screen offers its three choices and preselects the
 *      cautious one, so somebody who decides nothing still proceeds safely.
 *   3. The walkthrough reaches an account step, an account can be MADE there,
 *      and the person ends the walkthrough signed in as themselves.
 *   4. Every top-level route reachable by the arrows renders without a raw
 *      exception, an empty stage, or a page-level error.
 *   5. A representative preference changed from a user-facing control survives
 *      TWO ordinary close/relaunch cycles and is VISUALLY restored -- read off
 *      the painted document, not off the settings file. The acceptance matrix
 *      this lane reuses names "a settings file alone" as insufficient.
 *   6. The agent surface can be reached by drilling in, and whatever its
 *      steering controls actually offer is RECORDED rather than assumed.
 *
 * THE PASSWORD IS GENERATED AND NEVER LEAVES MEMORY. It is random bytes, typed
 * into the field over the debugger, and never printed, never written to a log,
 * never returned. A local account has no reset by design, so the account this
 * run creates is deliberately disposable: it lives in a scratch profile that is
 * deleted at the end, and nothing outside this process ever needs to sign in to
 * it again.
 *
 * NOTHING HERE TOUCHES THE REAL INSTALLATION. Every launch gets an explicit
 * --user-data-dir under the OS temp dir and the rig fails the run if the app
 * wrote its preferences anywhere else.
 *
 * WHAT IS DELIBERATELY NOT DONE. No purchase is confirmed, no card is
 * attached, and no external account is created anywhere. The account made here
 * is an account inside this product and nowhere else.
 *
 *   node tools/test-account-journey-qa.mjs [--visible] [--release <dir>]
 */

import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

import {
  VISIBLE, accountState, assertIsolated, closeWindow, createLedger, delay, describeTimeline,
  generatedPassword, openWindow, prefsFileFor, releaseDirectory, route, scratchDirectory,
  screenText, stage, walkRing, writeEvidence,
} from './test-account-harness.mjs'

/* Unmistakable on every surface it can appear on. The walkthrough's account
   step has no "shown as" field -- it passes an empty display name, so the
   username IS the label a stranger's records will carry -- which is why the
   username itself has to say what this account is. */
const TEST_USERNAME = 'test-account-not-a-real-user'

/* The three sentences the permission screen is specified to ask with. Quoted so
   a build that silently loses the question fails here rather than being read as
   a pass because "setup rendered". */
const TIER_LABELS = Object.freeze([
  'I’m new to this',
  'I’ve used AI coding tools before',
  'I run agents with permissions bypassed',
])

/* A raw exception, an error page, or a stack trace on a customer's screen. */
const RAW_ERROR_MARKERS = Object.freeze([
  'Uncaught', 'TypeError:', 'ReferenceError:', 'SyntaxError:', 'is not a function',
  'undefined is not', 'at Object.<anonymous>', 'ENOENT', 'Cannot read properties',
])

async function pageHealth(window) {
  return window.evaluate(`(() => {
    const stage = document.getElementById('stage')
    const text = document.body.innerText || ''
    return {
      route: document.body.dataset.route || null,
      stageChildren: stage ? stage.childElementCount : -1,
      textLength: text.trim().length,
      title: document.title || '',
      hasDialogRole: Boolean(document.querySelector('[role="alert"]')),
    }
  })()`)
}

function rawErrorsIn(text) {
  return RAW_ERROR_MARKERS.filter(marker => text.includes(marker))
}

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('test-account-journey-qa')
  const profile = path.join(scratch, 'stranger')
  let window = null
  const started = Date.now()

  console.log(`release  : ${releaseDirectory()}`)
  console.log(`scratch  : ${scratch}`)
  console.log(`mode     : ${VISIBLE ? 'VISIBLE (control run)' : 'headless'}`)

  try {
    const { executable } = await stage(scratch)

    /* ---------- 1. A VIRGIN PROFILE OPENS ON THE FIRST-RUN QUESTION ---------- */
    window = await openWindow(executable, profile)
    ledger.check('the packaged application opens a window on a profile that has never run it',
      window.timeline.windowAt !== null, describeTimeline(window.timeline))
    assertIsolated(profile)
    ledger.check('and it is reading a sterile data directory rather than this machine\'s own installation',
      existsSync(prefsFileFor(profile)), prefsFileFor(profile))

    const firstRoute = await route(window)
    ledger.check('a first run stops on the setup question instead of assuming a setup nobody did',
      firstRoute === 'setup', `route=${firstRoute}`)

    const tierText = await screenText(window)
    const missingTiers = TIER_LABELS.filter(label => !tierText.includes(label))
    ledger.check('the permission-level screen offers all three choices in the person\'s own words',
      missingTiers.length === 0, missingTiers.join(' | ') || 'all three present')
    ledger.check('and one of them is preselected, so deciding nothing still proceeds',
      (await window.evaluate('Boolean(document.querySelector(\'[data-setup-tier][aria-pressed="true"]\'))')) === true)
    ledger.check('the screen carries no raw exception text',
      rawErrorsIn(tierText).length === 0, rawErrorsIn(tierText).join(', '))
    writeEvidence(scratch, 'step-1-tier-screen.txt', tierText)

    /* ---------- 2. WALK THE WALKTHROUGH BY CLICKING ---------- */
    const pickedTier = await window.clickVisible('[data-setup-tier="standard"]')
    ledger.check('a tier can be chosen with the mouse', pickedTier === 'clicked', pickedTier)
    const continued = await window.clickVisible('[data-setup-continue]')
    ledger.check('Continue is live once a level is chosen', continued === 'clicked', continued)
    await delay(1400)

    const workspaceText = await screenText(window)
    ledger.check('the next question is the working folder, and it suggests one rather than demanding a file dialog',
      workspaceText.includes('Which folder should your assistant work in?')
      && !workspaceText.includes('No folder chosen yet.'),
      workspaceText.split('\n').slice(0, 2).join(' / '))
    writeEvidence(scratch, 'step-2-workspace.txt', workspaceText)

    const toAccount = await window.clickVisible('[data-setup-next="account"]')
    ledger.check('the walkthrough moves on to the account question', toAccount === 'clicked', toAccount)
    await delay(1200)

    /* ---------- 3. MAKE AN ACCOUNT, AS THE STRANGER ---------- */
    const accountText = await screenText(window)
    ledger.check('the account step asks who is using this copy',
      accountText.includes('Who is using this copy?'), accountText.split('\n')[0])
    ledger.check('and it says, before anything is typed, that this is a local account with no reset',
      accountText.includes('no password reset') || accountText.includes('cannot be recovered')
      || accountText.includes('account on this computer'),
      'scope notice')
    writeEvidence(scratch, 'step-3-account-question.txt', accountText)

    /* A computer with no accounts opens on the create form. If it opened on
       sign-in, a stranger's first act would be to fail a sign-in to an account
       that does not exist, so this is checked rather than clicked past. */
    const createFormOffered = await window.evaluate(
      'Boolean(document.querySelector(\'[data-setup-account-submit="create"]\'))')
    ledger.check('a computer with no accounts offers the CREATE form first, not a sign-in that must fail',
      createFormOffered === true)

    const password = generatedPassword()
    const typedName = await window.typeInto('[data-setup-account-field="username"]', TEST_USERNAME)
    const typedPassword = await window.typeInto('[data-setup-account-field="password"]', password)
    ledger.check('both account fields accept typing', typedName === 'typed' && typedPassword === 'typed',
      `${typedName}/${typedPassword}`)

    const submitted = await window.clickVisible('[data-setup-account-submit="create"]')
    ledger.check('the create button is clickable', submitted === 'clicked', submitted)
    /* scrypt at N=2^17 costs about a second, and this path derives twice --
       once to create and once to sign in. Waited for generously; a harness that
       gives up early reports a deliberately expensive hash as a hang. */
    await delay(9000)

    const afterCreate = await accountState(window)
    const signedIn = afterCreate?.current?.signedIn === true
    ledger.check('the stranger ends the account step SIGNED IN as themselves',
      signedIn, `signedIn=${signedIn} username=${afterCreate?.current?.account?.username || 'none'}`)
    ledger.check('and the account the shell reports is the one that was typed, not a default',
      afterCreate?.current?.account?.username === TEST_USERNAME,
      String(afterCreate?.current?.account?.username))
    ledger.check('the shell hands the page no session token, only the window of validity',
      afterCreate?.current?.session !== undefined
        ? Object.keys(afterCreate.current.session || {}).every(key => key === 'issuedAtMs' || key === 'expiresAtMs')
        : true,
      Object.keys(afterCreate?.current?.session || {}).join(','))
    /* The whole reply is kept, because it is the one object that would carry a
       credential if the boundary ever leaked one. It has no password field --
       that is the point of writing it down. */
    writeEvidence(scratch, 'step-3-account-reply.json', afterCreate)

    /* ---------- 4. FINISH, AND REACH THE PRODUCT ---------- */
    for (let step = 0; step < 6; step += 1) {
      const here = await route(window)
      if (here !== 'setup') break
      const next = await window.evaluate(`(() => {
        const button = [...document.querySelectorAll('[data-setup-next],[data-setup-continue]')]
          .filter(node => !node.disabled).pop()
        return button ? (button.dataset.setupNext || 'continue') : null
      })()`)
      if (!next) break
      const selector = next === 'continue' ? '[data-setup-continue]' : `[data-setup-next="${next}"]`
      const clicked = await window.clickVisible(selector)
      if (clicked !== 'clicked') break
      await delay(1600)
    }
    const landed = await route(window)
    ledger.check('finishing the walkthrough lands on the product rather than looping in setup',
      landed !== 'setup', `route=${landed}`)
    writeEvidence(scratch, 'step-4-after-setup.txt', await screenText(window))

    /* ---------- 5. EVERY TOP-LEVEL ROUTE, BY THE ARROWS ---------- */
    const ring = await walkRing(window, 10)
    const stops = ring.visited.map(stop => stop.route)
    ledger.check('the forward arrow keeps working all the way round the ring',
      ring.clicked === 'clicked', `${stops.length} stops: ${stops.join(' -> ')}`)
    ledger.check('the ring returns to where it started, so it is a ring and not a dead end',
      stops.includes('home'), stops.join(' -> '))

    const broken = []
    for (const stop of ring.visited) {
      const errors = rawErrorsIn(stop.text)
      if (errors.length > 0) broken.push(`${stop.route}: ${errors.join(', ')}`)
      if (stop.text.trim().length < 20) broken.push(`${stop.route}: blank (${stop.text.trim().length} chars)`)
    }
    ledger.check('no stop on the ring shows a raw exception or an empty screen',
      broken.length === 0, broken.join(' | '))
    writeEvidence(scratch, 'step-5-ring.json', ring.visited.map(stop => ({ route: stop.route, chars: stop.text.length })))

    const uniqueStops = [...new Set(stops)]
    ledger.note(`routes visited by clicking: ${uniqueStops.join(', ')}`)

    /* ---------- 6. THE AGENT SURFACE, BY DRILLING IN ---------- */
    /* Reached the way a person reaches it: round the ring to the machines page,
       then into a machine, then into an agent. Recorded rather than asserted
       where the product's own answer is "unavailable" -- a control that says
       why it cannot act is a different thing from a control that is broken, and
       a QA lane that cannot tell them apart is worth nothing. */
    let atComputers = false
    for (let step = 0; step < 10; step += 1) {
      if ((await route(window)) === 'computers') { atComputers = true; break }
      if ((await window.clickVisible('#nav-next')) !== 'clicked') break
      await delay(400)
    }
    ledger.check('the machines page is reachable by walking the ring', atComputers, `route=${await route(window)}`)

    /* Into an agent page, by pressing the door the CURRENT product offers.
       Since 5cc2f09 ("a fleet tree you build, instead of one the app
       invented") a virgin profile's tree is EMPTY by design -- there is no
       `.static-tree-node` to click, which is what this step used to do -- and
       since 18ef5e7 ("The only door to the page that starts an agent opened
       after you had started one") the `.graph-open-btn` in the named-controls
       strip is aimed at the first DECLARED seat and visible with no selection,
       exactly so a fresh install has a way in. So the door is pressed first;
       the node-then-open path is kept for a profile that has running agents.
       The projection resolves asynchronously, so the door is waited for
       rather than sampled once. */
    let door = 'none'
    let viaOpen = 'absent'
    /* clickVisible already waits up to 8s for the selector, so four attempts
       is ~half a minute of patience for a slow projection, not 4 samples. */
    for (let tick = 0; tick < 4 && viaOpen !== 'clicked'; tick += 1) {
      viaOpen = await window.clickVisible('.graph-open-btn')
      if (viaOpen !== 'clicked') await delay(400)
    }
    if (viaOpen === 'clicked') door = '.graph-open-btn (declared capacity, 18ef5e7)'
    else {
      const clickedNode = await window.clickVisible('.static-tree-node')
      if (clickedNode === 'clicked') {
        await delay(900)
        const opened = await window.clickVisible('[data-a="open"]')
        ledger.note(`the node panel's open action: ${opened}`)
        if (opened === 'clicked') door = '.static-tree-node then [data-a="open"]'
      }
    }
    await delay(1200)
    const agentRoute = await route(window)
    ledger.check('an agent page is reachable by drilling into the fleet graph, without typing an address',
      agentRoute === 'agent', `door=${door} route=${agentRoute}`)

    const agentText = await screenText(window)
    ledger.check('the agent page renders rather than showing a raw exception or an empty stage',
      agentText.trim().length > 60 && rawErrorsIn(agentText).length === 0,
      `${agentText.trim().length} chars ${rawErrorsIn(agentText).join(', ')}`)

    /* WHAT THE STEERING CONTROLS ACTUALLY OFFER, RECORDED RATHER THAN ASSUMED.
       A control that is disabled and says why is a different thing from a
       control that is broken, and a lane that cannot tell them apart is worth
       nothing. This surface belongs to another lane; this run reports what a
       second person sees on it and changes none of it. */
    const agentControls = await window.evaluate(`(() => {
      const controls = [...document.querySelectorAll('[data-control]')]
      return controls.map(node => ({
        control: node.dataset.control,
        disabled: node.disabled === true,
        label: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        reason: (node.getAttribute('aria-label') || '').slice(0, 120),
      }))
    })()`)
    const offered = Array.isArray(agentControls) ? agentControls.map(c => c.control) : []
    ledger.check('all three steering controls are present on the agent page',
      ['pause', 'respawn', 'terminate'].every(id => offered.includes(id)), offered.join(', ') || 'none found')
    const unexplained = (Array.isArray(agentControls) ? agentControls : [])
      .filter(control => control.disabled && !control.reason)
    ledger.check('every steering control that is disabled says WHY it is disabled, in words',
      unexplained.length === 0, unexplained.map(c => c.control).join(', '))
    ledger.note(`steering controls as a second person sees them: ${JSON.stringify(agentControls)}`)
    writeEvidence(scratch, 'step-6-agent-controls.json', { route: agentRoute, controls: agentControls })

    /* ---------- 7. A PREFERENCE, AND TWO ORDINARY RELAUNCHES ---------- */
    /* Theme is the representative preference: it is changed from a control a
       person can actually find (the settings drawer), it is written to
       userData, and it is VISIBLE -- the painted document carries it -- so
       restoration can be read off the glass rather than off the file. */
    const openedDrawer = await window.clickVisible('#open-settings')
    ledger.check('the settings drawer opens from the toolbar', openedDrawer === 'clicked', openedDrawer)
    await delay(600)
    const chose = await window.clickVisible('#theme-seg button[data-theme="black"]')
    ledger.check('a theme can be chosen from the drawer', chose === 'clicked', chose)
    await delay(900)
    const paintedAfterChange = await window.evaluate('document.documentElement.dataset.theme')
    ledger.check('the choice paints immediately', paintedAfterChange === 'black', `theme=${paintedAfterChange}`)
    await window.clickVisible('#close-settings')
    await delay(400)

    const cycles = []
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const closing = await closeWindow(window)
      window = null
      cycles.push({ cycle, phase: 'close', timeline: describeTimeline(closing) })
      ledger.check(`close cycle ${cycle} ends the process, and the timeline says how`,
        closing.exitedAt !== null, describeTimeline(closing))

      window = await openWindow(executable, profile)
      const relaunch = window.timeline
      cycles.push({ cycle, phase: 'relaunch', timeline: describeTimeline(relaunch) })
      ledger.check(`relaunch ${cycle} produces a real window, not an exit-0 with nothing on screen`,
        relaunch.windowAt !== null, describeTimeline(relaunch))

      /* WAITED FOR, NOT SAMPLED ONCE. The theme is account-scoped
         (public/durable-storage.js), and the store hydrates the signed-in
         account ASYNCHRONOUSLY at launch -- reapplyAfterAccountChange() paints
         the account's theme a beat after first paint, by design. A person sees
         the settled window; a single sample taken in the first few hundred
         milliseconds measures the race, not the preference. Bounded at 8s so a
         theme that never arrives still fails, with the settled value in the
         detail. */
      let painted = null
      for (let tick = 0; tick < 20; tick += 1) {
        painted = await window.evaluate('document.documentElement.dataset.theme')
        if (painted === 'black') break
        await delay(400)
      }
      const background = await window.evaluate('getComputedStyle(document.body).backgroundColor')
      ledger.check(`the preference is VISUALLY restored after relaunch ${cycle}`,
        painted === 'black', `theme=${painted} background=${background}`)

      const stillIn = await accountState(window)
      ledger.check(`the stranger is still signed in after relaunch ${cycle}`,
        stillIn?.current?.signedIn === true,
        `signedIn=${stillIn?.current?.signedIn} as=${stillIn?.current?.account?.username || 'nobody'}`)

      const health = await pageHealth(window)
      ledger.check(`relaunch ${cycle} lands on a painted screen rather than an empty stage`,
        health.stageChildren > 0 && health.textLength > 40, JSON.stringify(health))
    }
    writeEvidence(scratch, 'step-7-relaunch-cycles.json', cycles)

    const prefsBody = existsSync(prefsFileFor(profile))
    ledger.check('and the preference is on disk in userData as well as on the glass',
      prefsBody, prefsFileFor(profile))
  } finally {
    /* Cleanup may never decide the verdict. */
    try { await closeWindow(window) } catch { /* already gone */ }
    if (!process.env.TEST_ACCOUNT_QA_KEEP) {
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows may still hold a DLL */ }
    } else {
      console.log(`kept evidence in ${scratch}`)
    }
  }

  console.log(`\nrun duration ${((Date.now() - started) / 1000).toFixed(1)}s`)
  ledger.finish('stranger journey')
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error))
  process.exitCode = 1
})
