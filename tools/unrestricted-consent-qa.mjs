#!/usr/bin/env node

/* THE MOMENT OF CHOOSING FULL ACCESS, DRIVEN ON THE PACKAGED WINDOW.
 *
 * The owner's X4 ruling (2026-08-15) on the unsandboxed configuration -- the
 * `unrestricted` permission level -- in four clauses, each of which this driver
 * proves with a real mouse press on a staged packaged build and a read of what
 * the disk and the signed ledger hold afterwards:
 *
 *   1. DEFAULT OFF.   A fresh install opens on the permission question with the
 *                     narrowest level lit and nothing else.
 *   2. THE MOMENT.    Pressing the widest level -- in Setup and in Settings --
 *                     puts the Terms' words on the glass and asks; Continue is
 *                     held while it asks. Declining leaves the previous level
 *                     in place, on the screen and on the disk, and writes no
 *                     confirmed row. Confirming moves the disk.
 *   3. RECORDED.      After a confirmed choice, the canonical signed ledger in
 *                     the sterile profile holds setup.tier.choose rows naming
 *                     the level, that the risk was shown and confirmed, and the
 *                     words -- and audit.verify() reports the chain valid. Read
 *                     out of process, with the payload's own reader, not off the
 *                     screen.
 *   4. RE-WARNED.     Moving unrestricted -> guided -> unrestricted in Settings
 *                     shows the words again; the earlier confirmation on the
 *                     ledger silences nothing.
 *
 * TWO MORE THINGS IT PROVES, because they are where this could quietly be wrong:
 *
 *   LEGACY READS HONESTLY. A profile seeded at the widest level with no ledger
 *   row (the machine record written directly, as tools/mcsetup.js or an older
 *   build would) shows "no confirmation of the risk is on record" on the
 *   Settings row, never "confirmed".
 *
 *   SETTINGS-FIRST ORDERING. shell/canonical-audit.cjs caches its first load;
 *   the settings channel used to load it with no state root, so a research
 *   toggle as the FIRST ledger-touching act after launch poisoned the cache and
 *   every later record in the process failed. Scenario C flips a research
 *   switch first and THEN chooses full access, and asserts the choice is
 *   recorded. Before the fix this scenario is the reproduction; after it, it is
 *   the regression guard.
 *
 * ISOLATION is the harness's (tools/test-account-harness.mjs): a staged copy of
 * release/win-unpacked with this tree's dist/, shell/ and capability/ in it, a
 * scratch --user-data-dir per scenario, LOCALAPPDATA/USERPROFILE redirected so
 * the machine record lands in scratch, MC_SMOKE_HEADLESS=1, and assertIsolated()
 * on the file the app actually wrote. Every press is Input.dispatchMouseEvent at
 * a measured, visible point -- never el.click().
 *
 * RUN IT:
 *   node tools/unrestricted-consent-qa.mjs
 *   node tools/unrestricted-consent-qa.mjs --release <dir> --shots <dir> --keep
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  REPO_ROOT,
  argument,
  assertIsolated,
  closeWindow,
  createLedger,
  delay,
  describeTimeline,
  gotoSettings,
  openWindow,
  resolveMachineServicesRoot,
  scratchDirectory,
  seedMachineRecord,
  stage,
  userDataFor,
  writeEvidence,
} from './test-account-harness.mjs'

const require_ = createRequire(import.meta.url)
const KEEP = process.argv.includes('--keep')
const SHOTS = argument('--shots', null)

const ledger = createLedger()

/* ---------- reading the disk and the signed ledger, out of process ---------- */

function machineTier(profile, appRoot) {
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  try {
    const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)
    const record = machineRecord.readMachineRecord({ servicesRoot })
    return record ? record.tier : null
  } catch (error) {
    return `unreadable:${error?.code || error?.message}`
  }
}

/* The payload's own reader, in a child process with the state root set BEFORE
   its first require -- the same rule shell/canonical-audit.cjs states, and the
   reason this is a child rather than an in-process require: the module resolves
   its database path at load. */
function readLedger(profile, appRoot) {
  const stateRoot = path.join(userDataFor(profile), 'capability')
  const auditModule = path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'audit.js')
  const script = `
    const audit = require(${JSON.stringify(auditModule)})
    const out = { verify: null, choices: [], intents: [], error: null }
    try {
      out.verify = audit.verify()
    } catch (error) { out.error = 'verify:' + (error && (error.code || error.message)) }
    try {
      for (const tier of ['guided', 'standard', 'unrestricted']) {
        out.choices.push(...audit.findEvents({ action: 'setup.tier.choose', target: 'tier:' + tier, limit: 50 }))
        out.intents.push(...audit.findEvents({ action: 'setup.tier.choose.intent', target: 'tier:' + tier, limit: 50 }))
      }
    } catch (error) { out.error = (out.error ? out.error + '; ' : '') + 'find:' + (error && (error.code || error.message)) }
    out.choices.sort((a, b) => a.sequence - b.sequence)
    process.stdout.write(JSON.stringify(out))
  `
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot, ELECTRON_RUN_AS_NODE: undefined },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (error) {
    return { verify: null, choices: [], intents: [], error: `child:${String(error?.stderr || error?.message).slice(0, 400)}` }
  }
}

const confirmedChoices = read => (read.choices || []).filter(row => row.event?.details?.outcome === 'ok' && row.event?.details?.riskConfirmed === true)

/* ---------- reading the glass ---------- */

const READ_TIER_STEP = `(() => {
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const lit = [...document.querySelectorAll('[data-setup-tier]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.setupTier)
  const block = document.querySelector('[data-unrestricted-risk]')
  const cont = document.querySelector('[data-setup-continue]')
  return {
    route: document.body.dataset.route,
    lit,
    blockShown: Boolean(block) && block.getBoundingClientRect().height > 0,
    blockText: text(block),
    continueDisabled: cont ? cont.disabled : null,
  }
})()`

const READ_SETTINGS_TIER = `(() => {
  const text = node => (node ? node.textContent.replace(/\\s+/g, ' ').trim() : '')
  const row = document.querySelector('[data-setup-profile-row="tier"]')
  const lit = [...document.querySelectorAll('[data-setup-profile-set="tier"]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.setupProfileValue)
  const block = document.querySelector('[data-unrestricted-risk]')
  const status = document.querySelector('[data-setup-profile-status]')
  return {
    route: document.body.dataset.route,
    lit,
    rowText: text(row),
    blockShown: Boolean(block) && block.getBoundingClientRect().height > 0,
    blockText: text(block),
    statusText: text(status),
  }
})()`

const TERMS_PHRASES = [
  'read, change, and delete any file on your computer',
  'run any program on it',
  'without asking you first',
  'knowingly accepting that risk',
  'not limited to any one folder',
  'not automatically reversible',
  'recommended default',
  'confine an agent to a folder you pick',
  'enforced by the operating system rather than by an on-screen promise',
]
const carriesTheWords = text => TERMS_PHRASES.every(phrase => String(text || '').includes(phrase))
const missingPhrases = text => TERMS_PHRASES.filter(phrase => !String(text || '').includes(phrase))

async function shot(window, name) {
  if (!SHOTS) return null
  mkdirSync(SHOTS, { recursive: true })
  const deadline = new Promise(resolve => setTimeout(() => resolve(null), 25_000))
  const capture = (async () => {
    try { await window.session.send('Page.enable', {}) } catch { /* already on */ }
    try { await window.session.send('Page.setWebLifecycleState', { state: 'active' }) } catch { /* older */ }
    await window.session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await delay(700)
    const packet = await window.session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
    try { await window.session.send('Emulation.clearDeviceMetricsOverride', {}) } catch { /* nothing */ }
    return packet?.result?.data || null
  })()
  let data = await Promise.race([capture, deadline])
  if (!data) {
    /* ONE RETRY, the rule tools/panel-readability-qa.mjs states: a hidden
       window's first frame is timing-dependent, and a second miss costs this
       run an image, never a measurement -- the DOM reads are the measurement. */
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
  if (!data) { ledger.note(`shot ${name}: no frame arrived (evidence, not measurement)`); return null }
  const file = path.join(SHOTS, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  ledger.note(`shot ${file}`)
  return file
}

async function pressSettingsTier(window, tier) {
  return window.clickVisible(`[data-setup-profile-set="tier"][data-setup-profile-value="${tier}"]`)
}

/* The settings groups ship collapsed (settings-ia): the category buttons in
   the rail are nested under group heads. Open every closed group the way a
   person does; the open state is remembered on the profile afterwards. */
async function expandSettingsGroups(window) {
  await window.evaluate(`(() => { for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click(); return true })()`)
  await delay(400)
}

async function openSetupSection(window) {
  const reached = await gotoSettings(window)
  if (reached !== 'clicked' && reached !== 'already-there') return `settings:${reached}`
  await expandSettingsGroups(window)
  const category = await window.clickVisible('button[data-category="Setup"]')
  if (category !== 'clicked') return `category:${category}`
  await delay(900)
  const row = await window.waitForVisible('[data-setup-profile-row="tier"]', 8000)
  return row?.state === 'visible' ? 'clicked' : `row:${row?.state}`
}

/* ============================ scenario A: fresh install ============================ */

async function scenarioFresh(executable, appRoot, scratch) {
  console.log('\n[A] fresh install: default, the words in Setup, decline, re-ask, confirm, ledger')
  const profile = path.join(scratch, 'profile-fresh')
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  const window = await openWindow(executable, profile)
  try {
    await delay(2500)
    assertIsolated(profile)
    let step = await window.evaluate(READ_TIER_STEP)
    ledger.check('A1 a fresh install opens on the permission question', step.route === 'setup', `route=${step.route}`)
    ledger.check('A2 DEFAULT OFF: the narrowest level is lit and the widest is not', step.lit.length === 1 && step.lit[0] === 'guided', `lit=${JSON.stringify(step.lit)}`)
    ledger.check('A3 no risk block is on the glass before anything is pressed', step.blockShown === false)
    ledger.check('A4 the machine record does not exist yet (nothing chosen)', machineTier(profile, appRoot) === null, `tier=${machineTier(profile, appRoot)}`)
    await shot(window, 'A-fresh-default')

    /* Press the widest level. */
    let pressed = await window.clickVisible('[data-setup-tier="unrestricted"]')
    ledger.check('A5 the widest level can be pressed', pressed === 'clicked', pressed)
    await delay(600)
    step = await window.evaluate(READ_TIER_STEP)
    ledger.check('A6 THE MOMENT: the risk block is on the glass', step.blockShown === true)
    ledger.check('A7 ...in the Terms’ own words', carriesTheWords(step.blockText), missingPhrases(step.blockText).join(' | ') || 'all phrases present')
    ledger.check('A8 Continue is held while the question is open', step.continueDisabled === true)
    ledger.check('A9 nothing was written on the press', machineTier(profile, appRoot) === null)
    await shot(window, 'A-setup-words-shown')

    /* Decline. */
    pressed = await window.clickVisible('[data-unrestricted-decline]')
    ledger.check('A10 the decline control can be pressed', pressed === 'clicked', pressed)
    await delay(500)
    step = await window.evaluate(READ_TIER_STEP)
    ledger.check('A11 declining closes the block and the narrowest level is lit again', step.blockShown === false && step.lit[0] === 'guided', JSON.stringify(step.lit))
    ledger.check('A12 declining wrote nothing', machineTier(profile, appRoot) === null)
    let read = readLedger(profile, appRoot)
    ledger.check('A13 declining left no confirmed row in the ledger', read.error === null && confirmedChoices(read).length === 0, `confirmed=${confirmedChoices(read).length} err=${read.error}`)
    await shot(window, 'A-setup-declined')

    /* Press again: asked again. */
    pressed = await window.clickVisible('[data-setup-tier="unrestricted"]')
    await delay(600)
    step = await window.evaluate(READ_TIER_STEP)
    ledger.check('A14 pressing again asks again, in the same words', step.blockShown === true && carriesTheWords(step.blockText))

    /* Confirm, then Continue. */
    pressed = await window.clickVisible('[data-unrestricted-confirm]')
    ledger.check('A15 the confirm control can be pressed', pressed === 'clicked', pressed)
    await delay(500)
    step = await window.evaluate(READ_TIER_STEP)
    ledger.check('A16 confirming lights the widest level, closes the block, releases Continue', step.lit[0] === 'unrestricted' && step.blockShown === false && step.continueDisabled === false, JSON.stringify(step))
    ledger.check('A17 confirming alone still wrote nothing (Continue is what records)', machineTier(profile, appRoot) === null)
    await shot(window, 'A-setup-confirmed-before-continue')
    pressed = await window.clickVisible('[data-setup-continue]')
    ledger.check('A18 Continue can be pressed', pressed === 'clicked', pressed)
    await delay(2500)
    const after = await window.evaluate('document.body.dataset.route + ":" + (document.querySelector("[data-setup-progress]") ? document.querySelector("[data-setup-progress]").textContent : "")')
    ledger.check('A19 the walkthrough advanced to the folder question', /Question 2 of 3/.test(String(after)), String(after))
    ledger.check('A20 the machine record now holds the widest level', machineTier(profile, appRoot) === 'unrestricted', `tier=${machineTier(profile, appRoot)}`)
    read = readLedger(profile, appRoot)
    const confirmed = confirmedChoices(read)
    ledger.check('A21 RECORDED: the signed ledger holds a confirmed setup.tier.choose row for the widest level', confirmed.length === 1, `confirmed=${confirmed.length} total=${read.choices.length} err=${read.error}`)
    const rowDetails = confirmed[0]?.event?.details || {}
    ledger.check('A22 the row names the move, the showing and the words', rowDetails.to === 'unrestricted' && rowDetails.from === null && rowDetails.riskShown === true && carriesTheWords(rowDetails.riskText) && /^[0-9a-f]{64}$/.test(String(rowDetails.riskTextSha256)) && rowDetails.via === 'setup', JSON.stringify({ to: rowDetails.to, from: rowDetails.from, via: rowDetails.via, sha: rowDetails.riskTextSha256 }))
    ledger.check('A23 the outcome row points at its intent row', Number.isSafeInteger(rowDetails.intentSequence) && read.intents.some(row => row.sequence === rowDetails.intentSequence), `intentSequence=${rowDetails.intentSequence}`)
    ledger.check('A24 audit.verify() reports the chain valid', read.verify?.valid === true, JSON.stringify(read.verify))
    ledger.check('A25 the principal on the row is stated, not invented', typeof rowDetails.principal === 'string' && rowDetails.principal.length > 0, String(rowDetails.principal))
    writeEvidence(scratch, 'A-ledger-read.json', read)
  } finally {
    const timeline = await closeWindow(window)
    ledger.note(`A window: ${describeTimeline(timeline)}`)
  }
}

/* ============================ scenario B: Settings, down and back up ============================ */

async function scenarioSettings(executable, appRoot, scratch) {
  console.log('\n[B] Settings: the words, decline keeps the level, re-warned after going down and back up')
  const profile = path.join(scratch, 'profile-settings')
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  /* Seeded at the narrowest level so the app opens on home rather than setup;
     the machine record is written the way the walkthrough writes it. */
  seedMachineRecord(profile, appRoot, 'guided')
  const window = await openWindow(executable, profile)
  try {
    await delay(2500)
    assertIsolated(profile)
    const opened = await openSetupSection(window)
    ledger.check('B1 the Setup section of Settings can be reached by clicking', opened === 'clicked', opened)
    let view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B2 the row shows the narrowest level and no block', view.lit[0] === 'guided' && view.blockShown === false, JSON.stringify(view.lit))
    ledger.check('B3 a narrower level carries no sentence about a confirmation', !/confirmed|No confirmation/.test(view.rowText), view.rowText.slice(0, 160))

    /* Press the widest level: words, no write. */
    let pressed = await pressSettingsTier(window, 'unrestricted')
    ledger.check('B4 the widest level can be pressed on the row', pressed === 'clicked', pressed)
    await delay(700)
    view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B5 THE MOMENT, in Settings: the words are on the row', view.blockShown === true && carriesTheWords(view.blockText), missingPhrases(view.blockText).join(' | ') || 'all phrases present')
    ledger.check('B6 the row still shows the level the machine holds', view.lit[0] === 'guided', JSON.stringify(view.lit))
    ledger.check('B7 the disk did not move on the press', machineTier(profile, appRoot) === 'guided', machineTier(profile, appRoot))
    await shot(window, 'B-settings-words-shown')

    /* Decline. */
    pressed = await window.clickVisible('[data-unrestricted-decline]')
    ledger.check('B8 decline can be pressed', pressed === 'clicked', pressed)
    await delay(700)
    view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B9 declining keeps the level on the row and on the disk', view.lit[0] === 'guided' && view.blockShown === false && machineTier(profile, appRoot) === 'guided', `${JSON.stringify(view.lit)} disk=${machineTier(profile, appRoot)}`)
    ledger.check('B10 declining says so', /Full access was not turned on/.test(view.statusText), view.statusText)
    let read = readLedger(profile, appRoot)
    ledger.check('B11 declining left no confirmed row', read.error === null && confirmedChoices(read).length === 0, `confirmed=${confirmedChoices(read).length} err=${read.error}`)
    await shot(window, 'B-settings-declined')

    /* Press again and confirm. */
    pressed = await pressSettingsTier(window, 'unrestricted')
    await delay(700)
    view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B12 pressing again asks again', view.blockShown === true && carriesTheWords(view.blockText))
    pressed = await window.clickVisible('[data-unrestricted-confirm]')
    ledger.check('B13 confirm can be pressed', pressed === 'clicked', pressed)
    await delay(3000)
    view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B14 confirming moves the row and the disk to the widest level', view.lit[0] === 'unrestricted' && machineTier(profile, appRoot) === 'unrestricted', `${JSON.stringify(view.lit)} disk=${machineTier(profile, appRoot)}`)
    ledger.check('B15 the row says the change was recorded in the signed ledger', /recorded in the signed ledger/.test(view.statusText), view.statusText)
    ledger.check('B16 the row now states when full access was confirmed', /Full access was confirmed on/.test(view.rowText), view.rowText.slice(0, 260))
    read = readLedger(profile, appRoot)
    ledger.check('B17 the ledger holds exactly one confirmed row, via settings', confirmedChoices(read).length === 1 && confirmedChoices(read)[0].event.details.via === 'settings' && confirmedChoices(read)[0].event.details.from === 'guided', `confirmed=${confirmedChoices(read).length} err=${read.error}`)
    await shot(window, 'B-settings-confirmed')

    /* Down. */
    pressed = await pressSettingsTier(window, 'guided')
    await delay(2500)
    view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B18 moving down asks nothing and moves the disk', view.blockShown === false && view.lit[0] === 'guided' && machineTier(profile, appRoot) === 'guided', `${JSON.stringify(view.lit)} disk=${machineTier(profile, appRoot)}`)
    read = readLedger(profile, appRoot)
    ledger.check('B19 the move down is itself on the ledger', read.choices.some(row => row.event?.details?.to === 'guided' && row.event?.details?.from === 'unrestricted' && row.event?.details?.outcome === 'ok'), `rows=${read.choices.length}`)

    /* Back up: RE-WARNED. */
    pressed = await pressSettingsTier(window, 'unrestricted')
    await delay(700)
    view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('B20 RE-WARNED: going back up shows the words again despite the confirmation on the ledger', view.blockShown === true && carriesTheWords(view.blockText))
    ledger.check('B21 ...and has not moved the disk', machineTier(profile, appRoot) === 'guided')
    await shot(window, 'B-settings-rewarned')
    pressed = await window.clickVisible('[data-unrestricted-confirm]')
    await delay(3000)
    read = readLedger(profile, appRoot)
    ledger.check('B22 the second confirmation is a second row, not a reuse of the first', confirmedChoices(read).length === 2 && machineTier(profile, appRoot) === 'unrestricted', `confirmed=${confirmedChoices(read).length} disk=${machineTier(profile, appRoot)}`)
    ledger.check('B23 audit.verify() still reports the chain valid', read.verify?.valid === true, JSON.stringify(read.verify))
    writeEvidence(scratch, 'B-ledger-read.json', read)
  } finally {
    const timeline = await closeWindow(window)
    ledger.note(`B window: ${describeTimeline(timeline)}`)
  }
}

/* ============================ scenario C: a settings toggle first ============================ */

async function scenarioSettingsFirst(executable, appRoot, scratch) {
  console.log('\n[C] a research switch is the FIRST ledger-touching act, then full access is chosen')
  const profile = path.join(scratch, 'profile-settings-first')
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  seedMachineRecord(profile, appRoot, 'guided')
  const window = await openWindow(executable, profile)
  try {
    await delay(2500)
    assertIsolated(profile)
    const reached = await gotoSettings(window)
    ledger.check('C1 Settings can be reached', reached === 'clicked' || reached === 'already-there', reached)
    await expandSettingsGroups(window)
    const category = await window.clickVisible('button[data-category="Research & Agents"]')
    ledger.check('C2 the Research section can be opened', category === 'clicked', category)
    await delay(1200)
    const toggle = await window.clickVisible('label.settings-toggle:has(input[data-research-setting="research.pipeline"])', { timeoutMs: 10_000 })
    ledger.check('C3 the research pipeline switch can be pressed', toggle === 'clicked', toggle)
    await delay(3000)
    const said = await window.evaluate('(() => { const n = document.querySelector(\'[data-research-setting-status="research.pipeline"]\'); return n ? n.textContent.trim() : null })()')
    ledger.note(`C research row said: ${said}`)
    ledger.check('C4 the research change was written to the signed record (the first ledger act of this launch)', /written to this computer’s signed record/.test(String(said)) && !/could not be written/.test(String(said)), String(said))

    const opened = await openSetupSection(window)
    ledger.check('C5 the Setup section can be reached afterwards', opened === 'clicked', opened)
    let pressed = await pressSettingsTier(window, 'unrestricted')
    await delay(700)
    pressed = await window.clickVisible('[data-unrestricted-confirm]')
    ledger.check('C6 confirm can be pressed', pressed === 'clicked', pressed)
    await delay(3000)
    const view = await window.evaluate(READ_SETTINGS_TIER)
    const read = readLedger(profile, appRoot)
    ledger.check('C7 after a settings toggle first, the widest level is still recorded and takes', confirmedChoices(read).length === 1 && machineTier(profile, appRoot) === 'unrestricted', `confirmed=${confirmedChoices(read).length} disk=${machineTier(profile, appRoot)} status="${view.statusText}" err=${read.error}`)
    ledger.check('C8 the row says it was recorded', /recorded in the signed ledger/.test(view.statusText), view.statusText)
    writeEvidence(scratch, 'C-ledger-read.json', read)
  } finally {
    const timeline = await closeWindow(window)
    ledger.note(`C window: ${describeTimeline(timeline)}`)
  }
}

/* ============================ scenario D: a legacy install at the widest level ============================ */

async function scenarioLegacy(executable, appRoot, scratch) {
  console.log('\n[D] a legacy install already at the widest level, with no confirmation on any ledger')
  const profile = path.join(scratch, 'profile-legacy')
  for (const leaf of ['userdata', 'local', 'home']) mkdirSync(path.join(profile, leaf), { recursive: true })
  seedMachineRecord(profile, appRoot, 'unrestricted')
  const window = await openWindow(executable, profile)
  try {
    await delay(2500)
    assertIsolated(profile)
    const opened = await openSetupSection(window)
    ledger.check('D1 the Setup section can be reached', opened === 'clicked', opened)
    await delay(1500)
    const view = await window.evaluate(READ_SETTINGS_TIER)
    ledger.check('D2 the row shows the widest level', view.lit[0] === 'unrestricted', JSON.stringify(view.lit))
    ledger.check('D3 ABSENCE READS HONESTLY: no confirmation is on record, and the row says so', /No confirmation of the risk is on record/.test(view.rowText), view.rowText.slice(0, 300))
    ledger.check('D4 ...and never says "confirmed on"', !/was confirmed on/.test(view.rowText))
    await shot(window, 'D-legacy-no-confirmation-on-record')
    /* And an unconfirmed re-record of the level it already holds is not an
       enable: walking setup again does not strand the owner behind his own
       gate. The walkthrough RESUMES PAST a recorded level (resumeStep: a
       configured machine opens on the folder question), so the level question
       is reached by its own Back button -- and at the level the machine
       already holds, Continue proceeds without asking, because re-recording
       is not enabling. */
    const back = await window.clickVisible('[data-setup-profile-action="walkthrough"]')
    ledger.check('D5 "Walk through setup again" can be pressed', back === 'clicked', back)
    await delay(1500)
    const resumed = await window.evaluate('document.querySelector("[data-setup-progress]") ? document.querySelector("[data-setup-progress]").textContent : document.body.dataset.route')
    ledger.check('D6 the walkthrough resumes past the recorded level, not on it', /Question 2 of 3/.test(String(resumed)), String(resumed))
    const toTier = await window.clickVisible('[data-setup-back="tier"]')
    ledger.check('D6b Back reaches the permission question', toTier === 'clicked', toTier)
    await delay(900)
    const step = await window.evaluate(READ_TIER_STEP)
    ledger.check('D6c the recorded (widest) level is lit and nothing asks: showing a held level is not enabling it', step.route === 'setup' && step.lit[0] === 'unrestricted' && step.blockShown === false && step.continueDisabled === false, JSON.stringify(step))
    const cont = await window.clickVisible('[data-setup-continue]')
    await delay(2500)
    const after = await window.evaluate('document.querySelector("[data-setup-progress]") ? document.querySelector("[data-setup-progress]").textContent : document.body.dataset.route')
    ledger.check('D7 Continue at the level already held is not refused (re-recording is not enabling)', cont === 'clicked' && /Question 2 of 3/.test(String(after)), `${cont} ${after}`)
    const read = readLedger(profile, appRoot)
    ledger.check('D8 that re-record is on the ledger as unconfirmed, and still no confirmed row exists', confirmedChoices(read).length === 0 && read.choices.some(row => row.event?.details?.to === 'unrestricted' && row.event?.details?.riskConfirmed === false), `rows=${read.choices.length} confirmed=${confirmedChoices(read).length} err=${read.error}`)
    writeEvidence(scratch, 'D-ledger-read.json', read)
  } finally {
    const timeline = await closeWindow(window)
    ledger.note(`D window: ${describeTimeline(timeline)}`)
  }
}

/* ============================ main ============================ */

async function main() {
  const scratch = scratchDirectory('unrestricted-consent-qa')
  console.log(`scratch: ${scratch}`)
  const only = argument('--only', null)
  try {
    const { executable, appRoot } = await stage(scratch)
    console.log(`staged:  ${executable}`)
    if (!only || only === 'A') await scenarioFresh(executable, appRoot, scratch)
    if (!only || only === 'B') await scenarioSettings(executable, appRoot, scratch)
    if (!only || only === 'C') await scenarioSettingsFirst(executable, appRoot, scratch)
    if (!only || only === 'D') await scenarioLegacy(executable, appRoot, scratch)
  } catch (error) {
    ledger.check('the run completed', false, error?.stack || String(error))
  } finally {
    const failed = ledger.finish('unrestricted-consent-qa')
    if (!KEEP && failed === 0) {
      try { rmSync(scratch, { recursive: true, force: true }) } catch { /* a locked file keeps the evidence */ }
    } else {
      console.log(`evidence kept at ${scratch}`)
    }
  }
}

main()
