#!/usr/bin/env node
/* IS THE ACCOUNT BOUNDARY REAL WHERE IT SAYS IT IS?
 *
 * WHAT THE PRODUCT PROMISES, IN ITS OWN WORDS. The sign-in screen tells a person
 * that "Sign out everywhere" will refuse "any saved sign-in taken from this
 * computer earlier", and that changing a password "ends every other sign-in to
 * this account, including any that was copied off this computer". Those two
 * sentences are the entire reason shell/product-account.cjs carries an epoch.
 * A promise like that is either true against a copy of the file or it is
 * marketing, and the only way to tell is to TAKE the copy and put it back.
 *
 * SO THAT IS WHAT THIS DOES. It signs in, copies the sealed session file off to
 * one side, performs the revocation from the real button on the real screen,
 * closes the application, puts the copy back byte for byte, and starts the
 * application again. A build where the epoch works comes up SIGNED OUT. A build
 * where it does not comes up as the person whose session was copied, and every
 * "sign out everywhere" anybody ever pressed was a no-op.
 *
 * AND THE FAIL-CLOSED CLAIM, WHICH IS THE OTHER HALF. The module states that
 * absent, unreadable, corrupt, expired, superseded, or pointing-at-a-deleted-
 * account all resolve to SIGNED OUT, and that this is the specific mutant it is
 * tested against. A source test can only ask that of the module. This asks it of
 * the SHIPPED APPLICATION, by damaging the files on disk between two launches
 * and reading what the window says -- including that the screen a person is left
 * with explains itself rather than offering to create an account over the one
 * they could not read.
 *
 * WHY THE COPY IS TAKEN WITH THE APPLICATION SHUT DOWN. The session record lives
 * in the main process's memory and is only consulted from disk at startup, so a
 * file swapped underneath a running window proves nothing about the next launch.
 * Every phase here is a full close and a full relaunch, with the process
 * timeline recorded, because the acceptance matrix this lane reuses does not
 * accept an exit code as proof that anything launched.
 *
 * NO PASSWORD IS PRINTED. Two are generated for this run, used by typing them
 * into the real form, and never logged, never written to the evidence
 * directory, and never returned.
 *
 *   node tools/account-isolation-session-qa.mjs [--visible] [--release <dir>]
 */

import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  VISIBLE, accountState, assertIsolated, changePasswordOnScreen, closeWindow, createAccountOnScreen,
  createLedger, delay, describeTimeline, generatedPassword, gotoAccount, openWindow, releaseDirectory,
  route, accountsFileFor, scratchDirectory, screenText, seedMachineRecord, sessionFileFor,
  signInOnScreen, signOutOnScreen, stage, writeEvidence,
} from './test-account-harness.mjs'

const PERSON = Object.freeze({
  username: 'test-account',
  displayName: 'Test Account — not a real user',
})

function restoreEvidence(source, destination) {
  if (!existsSync(source)) return false
  copyFileSync(source, destination)
  return true
}

/** Start, do something, stop -- with the timeline kept either way. */
async function session(executable, profile, body) {
  const window = await openWindow(executable, profile)
  try {
    return { result: await body(window), timeline: window.timeline, window }
  } finally {
    await closeWindow(window)
  }
}

async function main() {
  const ledger = createLedger()
  const scratch = scratchDirectory('account-isolation-session-qa')
  const profile = path.join(scratch, 'one-windows-user')
  const started = Date.now()

  console.log(`release  : ${releaseDirectory()}`)
  console.log(`scratch  : ${scratch}`)
  console.log(`mode     : ${VISIBLE ? 'VISIBLE (control run)' : 'headless'}`)

  const firstPassword = generatedPassword()
  const secondPassword = generatedPassword()
  const stolenAfterSignIn = path.join(scratch, 'session-copy-taken-while-signed-in.bin')
  const stolenBeforePasswordChange = path.join(scratch, 'session-copy-taken-before-password-change.bin')
  let completed = false

  try {
    const { executable, appRoot } = await stage(scratch)
    seedMachineRecord(profile, appRoot, 'standard')

    /* ---------- 1. AN ACCOUNT, AND A SESSION THAT SURVIVES A RELAUNCH ------- */
    const made = await session(executable, profile, async window => {
      const created = await createAccountOnScreen(window, PERSON, firstPassword)
      return { created, state: await accountState(window) }
    })
    ledger.check('an account can be created on this computer from the real screen',
      made.result.created === 'submitted', made.result.created)
    ledger.check('and creating it signs the person in',
      made.result.state?.current?.signedIn === true,
      `signedIn=${made.result.state?.current?.signedIn} ${describeTimeline(made.timeline)}`)
    assertIsolated(profile)

    const sessionFile = sessionFileFor(profile)
    ledger.check('the sign-in is persisted as one sealed file in userData, not as a token in a page',
      existsSync(sessionFile), `${sessionFile} ${existsSync(sessionFile) ? `${statSync(sessionFile).size} bytes` : 'absent'}`)

    /* The sealed record must not be readable as plain bytes: the whole reason it
       is put through the OS keystore is that a file somebody copies off the
       machine should be useless to them. Checked by looking for what would be in
       it if it were plain -- the account name and the JSON it is made of. */
    if (existsSync(sessionFile)) {
      const raw = readFileSync(sessionFile)
      const asText = raw.toString('latin1')
      ledger.check('and the sealed file is not readable as plain text',
        !asText.includes(PERSON.username) && !asText.includes('"accountId"') && !asText.includes('sessionId'),
        `${raw.length} bytes, first 4 = ${[...raw.subarray(0, 4)].join(' ')}`)
      copyFileSync(sessionFile, stolenAfterSignIn)
    }

    const relaunched = await session(executable, profile, async window => accountState(window))
    ledger.check('the person is still signed in after an ordinary close and relaunch',
      relaunched.result?.current?.signedIn === true,
      `signedIn=${relaunched.result?.current?.signedIn} ${describeTimeline(relaunched.timeline)}`)

    /* ---------- 2. SIGNING OUT ENDS THE SESSION, AND IT STAYS ENDED --------- */
    const signedOut = await session(executable, profile, async window => {
      const clicked = await signOutOnScreen(window)
      return { clicked, state: await accountState(window) }
    })
    ledger.check('signing out from the account screen works', signedOut.result.clicked === 'clicked',
      signedOut.result.clicked)
    ledger.check('and the shell agrees nobody is signed in, in the same window',
      signedOut.result.state?.current?.signedIn === false,
      `signedIn=${signedOut.result.state?.current?.signedIn}`)
    ledger.check('the sealed session file is gone from disk after signing out',
      !existsSync(sessionFile), existsSync(sessionFile) ? 'it is still there' : 'removed')

    const afterSignOutRelaunch = await session(executable, profile, async window => ({
      state: await accountState(window),
      routeName: await route(window),
    }))
    ledger.check('and the next launch comes up SIGNED OUT rather than restoring the session',
      afterSignOutRelaunch.result.state?.current?.signedIn === false,
      `signedIn=${afterSignOutRelaunch.result.state?.current?.signedIn} `
      + `${describeTimeline(afterSignOutRelaunch.timeline)}`)

    /* ---------- 3. THE COPIED SESSION, PUT BACK AFTER A PLAIN SIGN-OUT -----
     *
     * WHAT THE PRODUCT ACTUALLY CLAIMS HERE, AND WHY THIS IS NOT THE FAILURE IT
     * LOOKS LIKE. A plain sign-out deletes the sealed file; it does NOT advance
     * the account's epoch, so a copy taken beforehand still decrypts and is
     * still on the current epoch. The first version of this check asserted the
     * copy would be refused, went red, and would have been reported as a
     * replay hole. It is not one: the screen distinguishes the two controls in
     * so many words, and offers "Sign out everywhere" for exactly the case
     * where somebody thinks a copy exists.
     *
     * So the honest measurement is BOTH halves at once -- the copy IS accepted,
     * and the screen SAYS the weaker control is the weaker one. A build where
     * the copy is accepted and the screen does not say so would be the defect,
     * and this catches that, which asserting the refusal never could. */
    const restoredAfterPlainSignOut = restoreEvidence(stolenAfterSignIn, sessionFile)
    ledger.check('the signed-in session evidence exists for the plain sign-out replay',
      restoredAfterPlainSignOut, restoredAfterPlainSignOut ? 'restored' : 'the prerequisite copy was never created')
    const replayAfterSignOut = await session(executable, profile, async window => {
      const state = await accountState(window)
      const reached = await gotoAccount(window)
      return { state, reached, text: await screenText(window) }
    })
    const plainReplayAccepted = replayAfterSignOut.result.state?.current?.signedIn === true
    ledger.note('a session file copied before a PLAIN sign-out is '
      + `${plainReplayAccepted ? 'ACCEPTED' : 'refused'} on the next launch `
      + `(as=${replayAfterSignOut.result.state?.current?.account?.username || 'nobody'})`)
    ledger.check('the screen tells the person that plain sign-out does NOT refuse a copied sign-in, and which control does',
      /Sign out everywhere.{0,120}(refuses|copied)/is.test(replayAfterSignOut.result.text || '')
      || /use it if you think a copy of it exists/i.test(replayAfterSignOut.result.text || ''),
      (replayAfterSignOut.result.text || '').split('\n').filter(line => /sign out everywhere/i.test(line)).slice(0, 1).join(' ')
      || `reached=${replayAfterSignOut.result.reached}`)
    writeEvidence(scratch, 'signed-in-screen-sign-out-copy.txt', replayAfterSignOut.result.text || '')

    /* ---------- 4. SIGN OUT EVERYWHERE, AGAINST A COPY --------------------- */
    ledger.check('there is a live session to copy before the strong control is used',
      plainReplayAccepted && existsSync(sessionFile),
      `signedIn=${plainReplayAccepted} file=${existsSync(sessionFile)}`)
    if (existsSync(sessionFile)) copyFileSync(sessionFile, stolenAfterSignIn)

    const everywhere = await session(executable, profile, async window => {
      const clicked = await signOutOnScreen(window, { everywhere: true })
      return { clicked, state: await accountState(window), text: await screenText(window) }
    })
    ledger.check('"Sign out everywhere" is a real control on the real screen',
      everywhere.result.clicked === 'clicked', everywhere.result.clicked)
    ledger.check('and it ends the session in the window it was pressed in',
      everywhere.result.state?.current?.signedIn === false,
      `signedIn=${everywhere.result.state?.current?.signedIn}`)
    writeEvidence(scratch, 'after-sign-out-everywhere.txt', everywhere.result.text || '')

    const restoredAfterEverywhere = restoreEvidence(stolenAfterSignIn, sessionFile)
    ledger.check('the signed-in session evidence exists for the sign-out-everywhere replay',
      restoredAfterEverywhere, restoredAfterEverywhere ? 'restored' : 'the prerequisite copy was never created')
    const replayAfterEverywhere = await session(executable, profile, async window => accountState(window))
    ledger.check('A SESSION FILE COPIED BEFORE "SIGN OUT EVERYWHERE" IS REFUSED, which is what the epoch is for',
      replayAfterEverywhere.result?.current?.signedIn === false,
      `signedIn=${replayAfterEverywhere.result?.current?.signedIn} `
      + `as=${replayAfterEverywhere.result?.current?.account?.username || 'nobody'} `
      + `${describeTimeline(replayAfterEverywhere.timeline)}`)
    ledger.check('and the refused copy is removed from disk rather than left to be retried forever',
      !existsSync(sessionFile), existsSync(sessionFile) ? 'the refused copy is still there' : 'removed')

    /* ---------- 5. CHANGING THE PASSWORD, AGAINST A COPY ------------------- */
    const beforeChange = await session(executable, profile, async window => {
      const signIn = await signInOnScreen(window, PERSON, firstPassword)
      return { signIn, state: await accountState(window) }
    })
    ledger.check('the person signs in once more, so there is a session to copy',
      beforeChange.result.state?.current?.signedIn === true,
      `${beforeChange.result.signIn} signedIn=${beforeChange.result.state?.current?.signedIn}`)
    if (existsSync(sessionFile)) copyFileSync(sessionFile, stolenBeforePasswordChange)

    const changed = await session(executable, profile, async window => {
      const submitted = await changePasswordOnScreen(window, firstPassword, secondPassword)
      return { submitted, state: await accountState(window), text: await screenText(window) }
    })
    ledger.check('the password can be changed from the account screen',
      changed.result.submitted === 'submitted', changed.result.submitted)
    ledger.check('and changing it signs this window out, as the screen says it will',
      changed.result.state?.current?.signedIn === false,
      `signedIn=${changed.result.state?.current?.signedIn}`)
    writeEvidence(scratch, 'after-password-change.txt', changed.result.text || '')

    const restoredBeforePasswordChange = restoreEvidence(stolenBeforePasswordChange, sessionFile)
    ledger.check('the signed-in session evidence exists for the password-change replay',
      restoredBeforePasswordChange, restoredBeforePasswordChange ? 'restored' : 'the prerequisite copy was never created')
    const replayAfterChange = await session(executable, profile, async window => accountState(window))
    ledger.check('A SESSION FILE COPIED BEFORE A PASSWORD CHANGE IS REFUSED',
      replayAfterChange.result?.current?.signedIn === false,
      `signedIn=${replayAfterChange.result?.current?.signedIn} `
      + `as=${replayAfterChange.result?.current?.account?.username || 'nobody'}`)

    const oldPasswordStill = await session(executable, profile, async window => {
      const attempt = await signInOnScreen(window, PERSON, firstPassword)
      return { attempt, state: await accountState(window), text: await screenText(window) }
    })
    ledger.check('and the OLD password no longer signs anybody in',
      oldPasswordStill.result.state?.current?.signedIn === false,
      `signedIn=${oldPasswordStill.result.state?.current?.signedIn}`)
    ledger.check('the refusal is one message that does not say whether the account exists',
      /do not match an account on this computer/i.test(oldPasswordStill.result.text || ''),
      (oldPasswordStill.result.text || '').split('\n').filter(line => /did not work|match/i.test(line)).slice(0, 2).join(' / '))

    const newPasswordWorks = await session(executable, profile, async window => {
      const attempt = await signInOnScreen(window, PERSON, secondPassword)
      return { attempt, state: await accountState(window) }
    })
    ledger.check('while the NEW password does, so the change took effect rather than locking the person out',
      newPasswordWorks.result.state?.current?.signedIn === true,
      `${newPasswordWorks.result.attempt} signedIn=${newPasswordWorks.result.state?.current?.signedIn}`)

    /* ---------- 6. DAMAGED FILES RESOLVE TO SIGNED OUT --------------------- */
    /* The session file first: unreadable bytes where a sealed record should be.
       A build that treated an undecryptable file as anything but signed-out
       would be accepting bytes it could not read as proof of identity. */
    writeFileSync(sessionFile, Buffer.from('this is not a sealed session record at all', 'utf8'))
    const corruptSession = await session(executable, profile, async window => ({
      state: await accountState(window),
      routeName: await route(window),
    }))
    ledger.check('AN UNREADABLE SESSION FILE RESOLVES TO SIGNED OUT',
      corruptSession.result.state?.current?.signedIn === false,
      `signedIn=${corruptSession.result.state?.current?.signedIn} `
      + `${describeTimeline(corruptSession.timeline)}`)

    /* Then the account file, which is the more dangerous one: a build that
       replaced an unreadable account list with an empty one would show
       "create your first account" to somebody who already has one, and their
       first action would overwrite the account they could not read.

       THE FILE IS A PREREQUISITE, NOT AN ASSUMPTION. If account creation failed
       earlier, product-accounts.json legitimately does not exist. Reading it
       unconditionally used to throw ENOENT here, bypassing ledger.finish() and
       hiding the earlier checked failure behind a harness exception. Catch
       only absence; every other read error still is an instrumentation error. */
    const accountsFile = accountsFileFor(profile)
    let intact = null
    try {
      intact = readFileSync(accountsFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    ledger.check('the product account file exists before its corrupt-file behavior is tested',
      intact !== null,
      intact !== null ? `${intact.length} bytes` : 'product-accounts.json was not created; account creation did not establish the prerequisite')

    if (intact !== null) {
      writeEvidence(scratch, 'accounts-file-size-before-damage.txt', `${intact.length} bytes`)
      writeFileSync(accountsFile, '{ "version": 1, "accounts": [ this is not json ] }', 'utf8')

      const corruptAccounts = await session(executable, profile, async window => {
        const reached = await gotoAccount(window)
        return {
          reached,
          state: await accountState(window),
          routeName: await route(window),
          text: await screenText(window),
        }
      })
      ledger.check('A CORRUPT ACCOUNT FILE RESOLVES TO SIGNED OUT, never to a signed-in user',
        corruptAccounts.result.state?.current?.signedIn === false,
        `signedIn=${corruptAccounts.result.state?.current?.signedIn} `
        + `${describeTimeline(corruptAccounts.timeline)}`)
      ledger.check('the application still opens a usable window rather than failing to start',
        corruptAccounts.timeline.windowAt !== null && (corruptAccounts.result.text || '').trim().length > 40,
        `${describeTimeline(corruptAccounts.timeline)} ${(corruptAccounts.result.text || '').trim().length} chars`)
      ledger.check('and the sign-in screen SAYS the account file could not be read',
        /could not be read|not readable|cannot read|no account on this page/i.test(corruptAccounts.result.text || ''),
        (corruptAccounts.result.text || '').split('\n').slice(0, 4).join(' / '))
      ledger.check('rather than offering to create a first account over the one it could not read',
        !/data-account-form="create"/.test(corruptAccounts.result.text || '')
        && !/Create account/i.test(corruptAccounts.result.text || ''),
        (corruptAccounts.result.text || '').includes('Create account') ? 'a create form is on screen' : 'no create form')
      writeEvidence(scratch, 'corrupt-account-file-screen.txt', corruptAccounts.result.text || '')

      /* Put it back and prove the damage was the cause, not a coincidence. A
         guard that only shows a failure state has not shown that the failure was
         about the thing it was pointed at. */
      writeFileSync(accountsFile, intact)
      const repaired = await session(executable, profile, async window => {
        const attempt = await signInOnScreen(window, PERSON, secondPassword)
        return { attempt, state: await accountState(window) }
      })
      ledger.check('restoring the account file makes the account usable again, so the refusal was about the damage',
        repaired.result.state?.current?.signedIn === true,
        `${repaired.result.attempt} signedIn=${repaired.result.state?.current?.signedIn}`)
    }
    completed = true
  } finally {
    const failed = ledger.results.some(result => !result.pass)
    if (!process.env.TEST_ACCOUNT_QA_KEEP && completed && !failed) {
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }) } catch { /* Windows may hold a DLL */ }
    } else {
      console.log(`kept evidence in ${scratch}`)
    }
  }

  console.log(`\nrun duration ${((Date.now() - started) / 1000).toFixed(1)}s`)
  ledger.finish('account boundary')
}

main().catch(error => {
  console.error(error?.stack || error?.message || String(error))
  process.exitCode = 1
})
