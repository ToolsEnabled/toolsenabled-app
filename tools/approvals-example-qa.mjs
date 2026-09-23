#!/usr/bin/env node

/* THE APPROVALS SCREEN'S TWO FACES, DRIVEN ON THE PACKAGED WINDOW.
 *
 * The finding this closes (the paid lane's walk of the vendored simulation
 * build, commit 36010d5, reassigned here by legal's launch delivery): every
 * landing view labels its own example data and the approvals view labelled
 * nothing. This driver opens the staged packaged build twice on a sterile
 * profile and reads the glass in both states:
 *
 *   LIVE (the default): the screen reads the live queue exactly as before, and
 *   NO example marking of any kind is on it -- a marking that leaks onto real
 *   data would be the same defect pointed the other way.
 *
 *   DEMONSTRATION: with the example switch on -- the one mc.example key,
 *   which src/data-source.js resolves every screen's source from, written
 *   into the app origin's storage before the app boots on it -- the screen
 *   wears the demonstration face: badge in home's words, source line in
 *   research's shape, example cards whose every control is disabled, and NOT
 *   the "service unavailable"
 *   state the walk found.
 *
 * NAVIGATION IS BY CLICKING (the ring arrow, via walkRing), never by assigning
 * location.hash. The switch write goes through the page's own storage and a
 * real reload, so the app boots on the same stored choice the Settings row's
 * setExampleMode leaves behind -- stated here rather than dressed up as
 * something else.
 *
 * RUN IT:
 *   node tools/approvals-example-qa.mjs
 *   node tools/approvals-example-qa.mjs --release <dir> --shots <dir> --keep
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  argument,
  assertIsolated,
  closeWindow,
  createLedger,
  delay,
  describeTimeline,
  openWindow,
  scratchDirectory,
  seedMachineRecord,
  stage,
  writeEvidence,
} from './test-account-harness.mjs'

const KEEP = process.argv.includes('--keep')
const SHOTS = argument('--shots', null)
const ledger = createLedger()

const READ_APPROVALS = `(() => {
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const shown = node => {
    if (!node) return false
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const badge = document.querySelector('[data-approvals-badge]')
  const source = document.querySelector('[data-approvals-source]')
  const cards = [...document.querySelectorAll('.approvals-card')]
  return {
    hash: location.hash,
    route: document.body.dataset.route,
    face: document.querySelector('.ledger-prompt-queue')?.dataset.face || null,
    badgeShown: shown(badge),
    badgeText: text(badge),
    sourceShown: shown(source),
    sourceText: text(source),
    pageText: text(document.querySelector('.ledger-prompt-queue')),
    queueNote: text(document.querySelector('[data-visible-count]')),
    unavailableText: text(document.querySelector('.projection-unavailable')),
    cards: cards.map(card => ({
      example: card.dataset.example === 'true',
      status: text(card.querySelector('.owner-popup-status')),
      buttons: [...card.querySelectorAll('button')].map(button => ({ text: text(button).slice(0, 40), disabled: button.disabled })),
      body: text(card).slice(0, 400),
    })),
  }
})()`

async function shot(window, name) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  const deadline = new Promise(resolve => setTimeout(() => resolve(null), 25_000))
  const capture = (async () => {
    try { await window.session.send('Page.enable', {}) } catch { /* on */ }
    try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older */ }
    await window.session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await delay(700)
    const packet = await window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
    try { await window.session.send('Emulation.clearDeviceMetricsOverride', {}) } catch { /* nothing */ }
    return packet?.result?.data || null
  })()
  let data = await Promise.race([capture, deadline])
  if (!data) {
    /* ONE RETRY, the same rule tools/panel-readability-qa.mjs states: a hidden
       window's first frame is timing-dependent, and a second miss is a missing
       image, never a missing measurement -- the DOM read is the measurement. */
    await delay(1500)
    data = await Promise.race([
      (async () => {
        try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older */ }
        await delay(900)
        const packet = await window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
        return packet?.result?.data || null
      })(),
      new Promise(resolve => setTimeout(() => resolve(null), 25_000)),
    ])
  }
  if (!data) { ledger.note(`shot ${name}: no frame arrived after a retry`); return }
  const file = path.join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  ledger.note(`shot ${file}`)
}

const READ_APPROVALS_LOCATION = `(() => {
  const page = document.querySelector('.ledger-prompt-queue')
  const inertAncestor = page?.closest('[inert]') || null
  return {
    hash: location.hash,
    route: document.body.dataset.route || '',
    face: page?.dataset.face || null,
    pageActive: Boolean(page?.isConnected && !inertAncestor && page.getAttribute('aria-hidden') !== 'true'),
    inert: Boolean(inertAncestor),
  }
})()`

const approvalsReady = state => state?.route === 'ledger'
  && state.pageActive === true
  && state.inert === false

// Walk to Ledger, wait for its render, then select Purchases. Stop walking as
// soon as the hash arrives so a delayed render cannot skip the destination.
export async function gotoApprovals(window, {
  pause = delay,
  maxSteps = 12,
  syncAttempts = 40,
  pollMs = 250,
} = {}) {
  const seen = []
  let state = await window.evaluate(READ_APPROVALS_LOCATION)
  for (let step = 0; step <= maxSteps; step += 1) {
    seen.push({ hash: state?.hash || '', route: state?.route || '', face: state?.face || null })
    if (/^#\/ledger(?:\?|$)/.test(state?.hash || '') || state?.hash === '#/approvals') {
      let selectedPurchases = false
      for (let attempt = 0; attempt < syncAttempts; attempt += 1) {
        if (approvalsReady(state)) return { status: 'clicked', state, seen }
        if (state?.route === 'ledger' && !selectedPurchases) {
          const clicked = await window.clickVisible('[data-mode="p"]')
          if (clicked !== 'clicked') return { status: `purchases:${clicked}`, state, seen }
          selectedPurchases = true
        }
        await pause(pollMs)
        state = await window.evaluate(READ_APPROVALS_LOCATION)
      }
      return { status: 'not-ready', state, seen }
    }
    if (step === maxSteps) break
    const clicked = await window.clickVisible('#nav-next')
    if (clicked !== 'clicked') return { status: `arrow:${clicked}`, state, seen }
    await pause(pollMs)
    state = await window.evaluate(READ_APPROVALS_LOCATION)
  }
  return { status: 'never-reached', state, seen }
}

const reachedDetail = reached => JSON.stringify({
  status: reached?.status,
  hash: reached?.state?.hash,
  route: reached?.state?.route,
  face: reached?.state?.face,
  pageActive: reached?.state?.pageActive,
  inert: reached?.state?.inert,
})

async function main() {
  const scratch = scratchDirectory('approvals-example-qa')
  console.log(`scratch: ${scratch}`)
  try {
    const { executable, appRoot } = await stage(scratch)
    console.log(`staged:  ${executable}`)
    const profile = path.join(scratch, 'profile')
    for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
    seedMachineRecord(profile, appRoot, 'guided')

    /* ---- state 1: live (the default) ---- */
    console.log('\n[live] the default face, on a fresh profile')
    let window = await openWindow(executable, profile)
    try {
      await delay(2500)
      assertIsolated(profile)
      const reached = await gotoApprovals(window)
      ledger.check('L1 the approvals screen can be reached by clicking the ring', reached.status === 'clicked', reachedDetail(reached))
      await delay(2500)
      const live = await window.evaluate(READ_APPROVALS)
      ledger.check('L2 the live face is stamped', live.face === 'this-computer', `face=${live.face}`)
      ledger.check('L3 no example badge is on the live screen', live.badgeShown === false, live.badgeText)
      ledger.check('L4 no example source line is on the live screen', live.sourceShown === false, live.sourceText)
      ledger.check('L5 no example card is on the live screen', live.cards.every(card => !card.example), `${live.cards.length} card(s)`)
      ledger.check('L6 the live screen reports its live state honestly (queue, empty, or unreachable -- never "example")',
        !/example/i.test(`${live.queueNote} ${live.unavailableText}`), `${live.queueNote} | ${live.unavailableText}`.slice(0, 160))
      writeEvidence(scratch, 'live-read.json', live)
      await shot(window, 'approvals-live')
    } finally {
      ledger.note(`live window: ${describeTimeline(await closeWindow(window))}`)
    }

    /* ---- state 2: demonstration ---- */
    console.log('\n[demonstration] the example switch on -- one key, every screen')
    window = await openWindow(executable, profile)
    try {
      await delay(2500)
      /* Written into the app origin's own storage, then a real reload so the
         app boots on it -- the same one stored key the Settings row's
         setExampleMode leaves behind (src/data-source.js). */
      await window.evaluate(`(() => {
        localStorage.setItem('mc.example', 'on')
        return true
      })()`)
      await window.evaluate('location.reload(); true')
      await delay(4000)
      const reached = await gotoApprovals(window)
      ledger.check('D1 the approvals screen can be reached by clicking', reached.status === 'clicked', reachedDetail(reached))
      await delay(1500)
      const demo = await window.evaluate(READ_APPROVALS)
      ledger.check('D2 the demonstration face is stamped', demo.face === 'demonstration', `face=${demo.face}`)
      ledger.check('D3 the badge is visible, in home’s exact words', demo.badgeShown === true && demo.badgeText === 'Example, not your data', `${demo.badgeShown} "${demo.badgeText}"`)
      ledger.check('D4 the source line is visible and names the way back to your own data', demo.sourceShown === true && /example data — switch off the example fleet in settings/.test(demo.sourceText), demo.sourceText)
      ledger.check('D5 the queue note says it is an example queue', /example/i.test(demo.queueNote), demo.queueNote)
      ledger.check('D6 example cards are on the glass', demo.cards.length >= 2 && demo.cards.every(card => card.example), `${demo.cards.length} card(s)`)
      ledger.check('D7 every control on every example card is disabled', demo.cards.length > 0 && demo.cards.every(card => card.buttons.length > 0 && card.buttons.every(button => button.disabled)),
        demo.cards.map(card => card.buttons.filter(button => !button.disabled).map(button => button.text).join('/')).join(' | ') || 'all disabled')
      ledger.check('D8 each card says in words that it is an example', demo.cards.length > 0 && demo.cards.every(card => /example request/i.test(card.status) || /example/i.test(card.body)),
        demo.cards.map(card => card.status).join(' | ').slice(0, 200))
      ledger.check('D9 the "service unavailable" state the walk found is gone', !/service unavailable/i.test(demo.pageText), demo.pageText.slice(0, 160))
      writeEvidence(scratch, 'demonstration-read.json', demo)
      await shot(window, 'approvals-demonstration')
    } finally {
      ledger.note(`demonstration window: ${describeTimeline(await closeWindow(window))}`)
    }
  } catch (error) {
    ledger.check('the run completed', false, error?.stack || String(error))
  } finally {
    const failed = ledger.finish('approvals-example-qa')
    if (!KEEP && failed === 0) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* keep the evidence */ }
    } else {
      console.log(`evidence kept at ${scratch}`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main()
}
