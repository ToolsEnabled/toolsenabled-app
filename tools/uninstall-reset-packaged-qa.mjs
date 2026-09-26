#!/usr/bin/env node
/* DOES "DELETE EVERYTHING" ACTUALLY DELETE EVERYTHING?
 *
 * THE ONLY WAY TO KNOW IS TO PUT REAL FILES ON A DISK, PRESS THE BUTTON IN THE
 * REAL WINDOW, AND THEN LOOK AT THE DISK. A source test can prove the module
 * removes what it is handed. It cannot prove that the screen hands it the right
 * directories, that the button is reachable, that Windows lets go of the files,
 * or -- the one that matters -- that the sentence the person is left reading
 * matches what is still on their computer.
 *
 * SO THE CENTRAL ASSERTION OF THIS FILE IS NOT "the data is gone". It is THE
 * SCREEN AND THE DISK AGREE. A run where three files survive and the screen says
 * three files survived is a PASS. A run where everything is deleted and the
 * screen says so is a pass. A run where anything is left and the screen says "It
 * is gone" is the failure this whole lane exists to prevent, and it is checked
 * by measuring both and comparing them.
 *
 * WHAT IT ALSO CHECKS, because a destructive control has to be safe as well as
 * honest:
 *   - the FIRST press only measures. The planted vault is still on the disk
 *     after it, byte for byte.
 *   - Cancel is real. After it, everything is still there.
 *   - the folders a person chose for their own work are NOT touched.
 *   - after the removal the program does not write its state back into the
 *     directory it just emptied.
 *   - a relaunch on the same profile comes up as a fresh install, signed out,
 *     with no account to sign in to.
 *
 * NO PASSWORD IS PRINTED. One is generated for this run, typed into the real
 * form, and never logged or written to the evidence directory.
 *
 *   node tools/uninstall-reset-packaged-qa.mjs [--visible] [--release <dir>]
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  accountState, assertIsolated, closeWindow, createAccountOnScreen, createLedger, delay,
  describeTimeline, generatedPassword, gotoAccount, openWindow, releaseDirectory, route,
  scratchDirectory, screenText, seedMachineRecord, stage, userDataFor, writeEvidence,
} from './test-account-harness.mjs'

const PERSON = Object.freeze({
  username: 'reset-test',
  displayName: 'Reset Test — not a real user',
})

/* The files a person would lose. Planted before the first launch so the removal
   has something recognisable to work on, and so the plan's named list -- "your
   saved credentials", "the signed record of every action taken" -- is exercised
   against files that really exist rather than against an empty profile. */
const PLANTED = Object.freeze([
  ['capability/vault/secrets.json', '{"openai_api_key":"REDACTED-NOT-A-REAL-VALUE"}'],
  ['capability/vault/secrets.json.access.log', 'read 2026-08-11\n'],
  ['capability/logs/actions.jsonl', '{"action":"pretend"}\n'],
  ['capability/config/accounts.json', '[]'],
  ['agent-spawn-records.jsonl', '{"sequence":1}\n'],
  ['purchase-catalog.json', '{"items":[]}'],
])

/* THE SIGNED LEDGER IS NOT PLANTED, AND THAT IS THE POINT OF THIS NOTE.
 *
 * It used to be, as `capability/state/audit.sqlite3` written to the literal
 * string "not-a-real-database..." padded to 4KB. Measured 2026-08-18 on a
 * staged packaged build: making an account was then refused, in the product's
 * own words on the glass -- "That did not work. This action was not recorded in
 * the signed ledger, so it was not carried out." The product opens that ledger
 * before it will perform ANY audited write, could not, and refused, which is
 * exactly right and is the behaviour this project has already paid to learn to
 * trust. So the harness was corrupting the ledger and then asking the product to
 * write to it, and reporting the correct refusal as "an account was created and
 * signed in: FAIL" -- the one failing check this file carried.
 *
 * Planting it AFTER the account is made does not work either, and the second
 * measurement is why this is a list rather than a moved line: the running app
 * holds that file and the vault open, so the removal cannot delete what was
 * written over them and three files survive a sweep that is working correctly.
 *
 * So the ledger is left to the PRODUCT to create, which it does the moment the
 * account is made -- a real one, with real content, at the real path. It still
 * has to be gone afterwards, and MUST_BE_GONE is what says so. That is a
 * stronger assertion than the planted string ever was: it is the file the
 * product itself wrote about this person's actions. */
const MUST_BE_GONE = Object.freeze([
  ...PLANTED.map(([relative]) => relative),
  'capability/state/audit.sqlite3',
])

function plant(profile) {
  const userData = userDataFor(profile)
  for (const [relative, body] of PLANTED) {
    const target = path.join(userData, ...relative.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body, 'utf8')
  }
  return userData
}

/** Every file under a directory, relative and sorted. The disk's own answer. */
function filesUnder(directory) {
  const found = []
  const walk = (current, prefix) => {
    /* A directory that cannot be read is not an empty directory. In particular,
       treating EACCES (or any other traversal failure) as an empty subtree can
       make the deletion checks below report that every file is gone when the
       files are merely inaccessible to the QA process. Let the read failure
       abort the run instead of converting "unknown" into "nothing left". */
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relative)
      else found.push(relative)
    }
  }
  if (!existsSync(directory)) return found
  walk(directory, '')
  return found.sort()
}

async function resetPhase(window) {
  return window.evaluate('(document.querySelector("[data-reset]") || {}).getAttribute ? document.querySelector("[data-reset]").getAttribute("data-reset-phase") : null')
}

async function resetOutcome(window) {
  return window.evaluate('(() => { const node = document.querySelector("[data-reset][data-reset-phase=\'done\']"); return node ? node.getAttribute("data-reset-outcome") : null })()')
}

/** What the screen says was left behind, as file names, read from the DOM. */
async function keptOnScreen(window) {
  return window.evaluate('[...document.querySelectorAll("[data-reset-kept]")].map(node => node.textContent.trim())')
}

/**
 * Close the window WITHOUT asking a dead debugger a question.
 *
 * MEASURED, TWICE, ON THIS DRIVER. The shared harness's closeWindow() begins
 * with `await window.evaluate('window.close()')`, and a CDP call resolves only
 * when the debugger answers -- it never rejects when the socket is already gone.
 * This is the one driver whose subject QUITS THE APPLICATION ITSELF (the result
 * screen's "Close ToolsEnabled" is the last control it offers), so by the time
 * the close helper runs there is nothing left to answer. The awaited promise
 * cannot settle, the socket is not a live handle, Node's event loop empties, and
 * the process EXITS 0 with the last third of the run never executed -- printing
 * a clean list of passing checks and no summary.
 *
 * That is a false green of the worst kind: it looks exactly like success. So the
 * child's exit code is consulted BEFORE anything is asked of it, and the harness
 * helper is only used while the application is genuinely still running.
 */
/**
 * Ask the window something, and give up rather than wait forever.
 *
 * EVERY CDP CALL IN THIS DRIVER GOES THROUGH THIS, and that is not defensive
 * decoration. The harness resolves a debugger call when the debugger answers and
 * never rejects when it does not, so a window that dies mid-question leaves a
 * promise that can never settle -- and a Node process whose last handle was that
 * socket then EXITS 0, silently, with the rest of the run never executed and a
 * clean list of passing checks on the screen.
 *
 * Measured on this driver's first three runs, twice in two different places: the
 * run ended at the close button and reported nothing about it. This is the one
 * driver where that is guaranteed rather than unlucky -- its subject QUITS THE
 * APPLICATION, which is what the last control on the result screen is for.
 */
async function answerOr(label, promise, ms = 30_000) {
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(`__timed_out__:${label}`), ms) })
  try {
    /* AND THE OTHER WAY A WINDOW FAILS TO ANSWER, which did not exist when the
       comment above was written. The harness used to leave a call to a dead
       debugger pending forever; since 2026-08-18 it REJECTS every pending call
       when the socket closes, which is the right behaviour and is what turned a
       silent hang into a loud failure everywhere else. Here the socket closing
       is the SUBJECT: this driver's last control quits the application. So a
       rejection is the same fact as a timeout -- the window did not answer --
       and it is recorded as that rather than thrown, with its own marker so the
       report never calls a dead socket a slow one. */
    return await Promise.race([promise, timeout])
      .catch(error => `__unanswered__:${label}:${error && error.message ? error.message : error}`)
  } finally { clearTimeout(timer) }
}

async function finish(window) {
  if (!window) return null
  if (window.child.exitCode !== null) {
    try { window.session?.close() } catch { /* already gone */ }
    return window.timeline
  }
  /* The application may quit between the exit-code read above and the question
     closeWindow asks -- this driver's whole subject is a control that quits it.
     Since the harness began rejecting calls to a closed socket, that race
     throws out of the `finally` that calls this, which killed the run AFTER
     every check had passed and BEFORE ledger.finish() could write the verdict
     line the suite reads. Measured 2026-08-18: 22 checks ok, no summary,
     exit 1. Teardown may not decide the verdict, so the expected race is
     absorbed here and nowhere wider. */
  try {
    return await closeWindow(window)
  } catch (error) {
    return { ...(window.timeline || {}), closeNote: String(error && error.message ? error.message : error) }
  }
}

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('uninstall-reset-packaged-qa')
  const profile = path.join(scratch, 'one-windows-user')
  const release = releaseDirectory()
  const password = generatedPassword()

  const staged = await stage(scratch, release)
  const servicesRoot = seedMachineRecord(profile, staged.appRoot, 'standard')

  const userData = plant(profile)
  /* The person's own work folder, seeded where the machine record points, so the
     "we do not touch your files" claim is measured rather than believed. */
  const workspace = path.join(profile, 'home', 'ToolsEnabled')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(path.join(workspace, 'my-notes.txt'), 'work the assistant did for me\n', 'utf8')

  let before = null

  let window = await openWindow(staged.executable, profile)
  try {
    assertIsolated(profile)
    ledger.check('the packaged app launched on a sterile profile', true, describeTimeline(window.timeline))

    /* SIGNED OUT FIRST, deliberately. Somebody who has forgotten their password
       cannot sign in -- there is no reset -- and a removal control that only
       exists behind a sign-in would be unreachable for exactly the person most
       likely to want it. */
    const beforeAnyAccount = await gotoAccount(window)
    ledger.check('the removal control is on the screen BEFORE anybody signs in',
      (beforeAnyAccount === 'clicked' || beforeAnyAccount === 'already-there')
        && (await resetPhase(window)) === 'idle',
      `${beforeAnyAccount}; phase=${await resetPhase(window)}`)

    const created = await createAccountOnScreen(window, PERSON, password)
    const state = await accountState(window)
    ledger.check('an account was created and signed in', created === 'submitted' && state?.current?.signedIn === true,
      `${created}; signedIn=${state?.current?.signedIn}`)

    /* The snapshot is taken HERE rather than before the launch, because the
       product's own ledger only exists once an account has been made, and the
       assertion below is about the files that were really on the disk when the
       removal ran. */
    before = { userData: filesUnder(userData), services: filesUnder(servicesRoot), workspace: filesUnder(workspace) }
    ledger.check('the signed ledger the product wrote is on the disk before the removal',
      before.userData.includes('capability/state/audit.sqlite3'),
      before.userData.filter(relative => relative.startsWith('capability/state/')).join(', ') || 'nothing under capability/state/')

    const reached = await gotoAccount(window)
    ledger.check('the sign-in screen is reachable by clicking', reached === 'clicked' || reached === 'already-there', reached)

    // ---- 1. the control is on the screen, and it has not deleted anything ----
    const idlePhase = await resetPhase(window)
    const idleText = await screenText(window)
    ledger.check('the removal control is on the signed-in screen',
      idlePhase === 'idle' && idleText.includes('Remove this program’s data from this computer'),
      `phase=${idlePhase}`)
    ledger.check('it says up front that it cannot be undone and does not uninstall the program',
      idleText.includes('It cannot be undone, and it does not uninstall the program'), 'lead sentence')

    // ---- 2. the FIRST press measures, and destroys nothing ----
    const pressedPlan = await window.clickVisible('[data-reset-plan]')
    await delay(1800)
    const confirmPhase = await resetPhase(window)
    const confirmText = await screenText(window)
    const afterMeasure = filesUnder(userData)
    ledger.check('the first press only measures', pressedPlan === 'clicked' && confirmPhase === 'confirm', `${pressedPlan}; phase=${confirmPhase}`)
    ledger.check('nothing was deleted by measuring',
      PLANTED.every(([relative]) => afterMeasure.includes(relative)),
      `${afterMeasure.length} files still under userData`)

    // ---- 3. what it shows before it asks ----
    for (const [what, needle] of [
      ['it names the credentials at stake', 'your saved credentials'],
      ['it names the signed record', 'the signed record of every action taken'],
      ['it names the permission level', 'the permission level you chose'],
      ['it lists what is NOT deleted', 'What this does NOT delete'],
      ['it says the program itself stays', 'It does not uninstall ToolsEnabled'],
      ['it says your own folders are not touched', 'Nothing in them is opened, moved or deleted here'],
      ['it says what already left this computer cannot be reached', 'deleting here cannot reach any of it'],
      ['it offers the backup it cannot make for you', 'There is no undo and no copy anywhere else'],
    ]) {
      ledger.check(what, confirmText.includes(needle), needle)
    }
    ledger.check('it names both folders it would sweep',
      confirmText.includes(userData) && confirmText.includes(servicesRoot),
      'the measured paths are on the screen')
    ledger.check('it names the folder the person chose for their own work',
      confirmText.includes(workspace), workspace)

    // ---- 4. cancel is real ----
    const cancelled = await window.clickVisible('[data-reset-cancel]')
    await delay(900)
    const afterCancel = filesUnder(userData)
    ledger.check('cancel returns to the offer and deletes nothing',
      cancelled === 'clicked' && (await resetPhase(window)) === 'idle'
        && PLANTED.every(([relative]) => afterCancel.includes(relative)),
      `${cancelled}; ${afterCancel.length} files still under userData`)

    // ---- 5. the act ----
    await window.clickVisible('[data-reset-plan]')
    await delay(1800)
    const confirmed = await window.clickVisible('[data-reset-confirm]')
    /* scrypt is not involved here, but stopping the capability layer and
       sweeping two directory trees is; the screen paints `working` first. */
    await delay(9000)
    for (let attempt = 0; attempt < 20 && (await resetPhase(window)) === 'working'; attempt += 1) await delay(1000)

    const donePhase = await resetPhase(window)
    const outcome = await resetOutcome(window)
    const doneText = await screenText(window)
    const kept = await keptOnScreen(window)
    ledger.check('the removal ran and reported', confirmed === 'clicked' && donePhase === 'done', `${confirmed}; phase=${donePhase}; outcome=${outcome}`)

    // ---- 6. THE CENTRAL ASSERTION: the screen and the disk agree ----
    const after = { userData: filesUnder(userData), services: filesUnder(servicesRoot), workspace: filesUnder(workspace) }
    /* Only what was actually there is required to be gone. A file that never
       existed cannot be evidence of a sweep, and counting it as one would be
       this check passing on an absence it did not cause. */
    const survivingProduct = MUST_BE_GONE
      .filter(relative => before.userData.includes(relative))
      .filter(relative => after.userData.includes(relative))
    ledger.check('every planted file of the person’s data is gone', survivingProduct.length === 0,
      survivingProduct.length === 0 ? 'vault, ledger, action log, linked accounts, run records, purchase list' : `still there: ${survivingProduct.join(', ')}`)
    ledger.check('the installation’s own record is gone', after.services.length === 0, `${after.services.length} files under ${servicesRoot}`)

    if (outcome === 'good') {
      ledger.check('"It is gone" is only said when nothing is left',
        after.userData.length === 0 && after.services.length === 0,
        `userData=${after.userData.length} files, installation=${after.services.length} files`)
    } else {
      ledger.check('what stayed is NAMED on the screen rather than hidden',
        after.userData.length > 0 && kept.length > 0 && doneText.includes('could not be deleted while the program'),
        `screen names ${kept.length} group(s); ${after.userData.length} files remain: ${after.userData.slice(0, 12).join(', ')}`)
      const namedOnScreen = kept.join(' ')
      const unnamed = after.userData.filter(relative => !namedOnScreen.includes(relative.split('/')[0]))
      ledger.check('nothing survives that the screen did not name', unnamed.length === 0,
        unnamed.length === 0 ? 'every survivor is on the screen' : `unnamed survivors: ${unnamed.join(', ')}`)
    }

    // ---- 7. the person's own files ----
    ledger.check('the folder the person chose for their own work is untouched',
      existsSync(path.join(workspace, 'my-notes.txt')) && after.workspace.length === before.workspace.length,
      `${after.workspace.length} files, unchanged`)

    // ---- 8. and the program stops writing into what it emptied ----
    /* The click is raced, because pressing this button is what ends the process
       that would answer it. A timeout HERE is the expected shape of success, so
       the check below reads the child's exit code rather than the click's word. */
    const closed = await answerOr('close-click', window.clickVisible('[data-reset-close]'), 20_000)
    /* WAITED FOR, AND THE WAIT IS MEASURED. A first version gave the quit 13.5
       seconds and went red on a run where the app was still tearing down; the
       same driver had passed on the previous run. A flaky red on a destructive
       control is worse than useless -- it teaches people to re-run until green.
       So the time to exit is recorded rather than assumed, and the window is
       long enough to tell "slow" from "never". */
    const pressedAt = Date.now()
    for (let attempt = 0; attempt < 90 && window.child.exitCode === null; attempt += 1) await delay(500)
    const tookMs = Date.now() - pressedAt
    await delay(1500)
    const afterClose = filesUnder(userData)
    ledger.check('closing from the result screen ends the process',
      window.child.exitCode !== null, `${closed}; exit=${window.child.exitCode} after ${tookMs}ms`)
    ledger.check('closing does not write the shell’s state back into the emptied folder',
      !afterClose.includes('shell-state.json') && !afterClose.includes('renderer-prefs.json'),
      `${afterClose.length} files under userData after the close`)
    writeEvidence(scratch, 'after-close.json', { before, after, afterClose, kept, outcome })
  } finally {
    await finish(window)
  }

  // ---- 9. the next launch is a fresh install ----
  window = await openWindow(staged.executable, profile)
  try {
    ledger.check('the app starts again on the emptied profile', window.timeline.windowAt !== null, describeTimeline(window.timeline))
    const state = await answerOr('account-state', accountState(window))
    const landed = await answerOr('route', route(window))
    const text = String(await answerOr('screen-text', screenText(window)) || '')
    /* A read that timed out comes back as the marker string, and `route` legally
       returns a string of its own -- so the test is the marker, not the type.
       The first version of this line compared types and reported a healthy
       window as unresponsive, which is the same class of mistake as the one the
       marker exists to catch: a check that is about the harness rather than the
       product. */
    const timedOut = [state, landed, text].filter(value => typeof value === 'string'
      && (value.startsWith('__timed_out__') || value.startsWith('__unanswered__')))
    if (timedOut.length > 0) {
      ledger.check('the relaunched window answered its own debugger', false,
        `${timedOut.join(', ')}; exit=${window.child.exitCode} stderr=${(window.timeline.stderr || '').slice(-400)}`)
    }
    ledger.check('the next launch comes up signed out', state?.current?.signedIn !== true, JSON.stringify(state?.current || null))
    ledger.check('the next launch asks the first-run question again',
      landed === 'setup' || text.includes('permission') || text.includes('What may your assistant do'),
      `route=${landed}`)
    ledger.check('no account file came back', !existsSync(path.join(userData, 'product-accounts.json')), 'product-accounts.json')
  } finally {
    await finish(window)
  }

  writeEvidence(scratch, 'ledger.json', ledger.results)
  console.log(`\nevidence: ${scratch}`)
  ledger.finish('uninstall-reset-packaged-qa')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
