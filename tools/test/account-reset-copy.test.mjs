import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resetMarkup } from '../../src/account-markup.js'

import {
  formatBytes,
  outcomeLines,
  planLines,
  readPlan,
  readSweep,
  RESET_SUBJECT_REMOTE,
  rootLabel,
  survivesLines,
} from '../../src/account-reset-copy.js'

test('survivor title names the reader’s computer locally and the driven computer over the relay', () => {
  assert.equal(
    survivesLines()[2].title,
    'Anything that already left this computer',
    'the local reader must retain the byte-identical desk sentence',
  )
  assert.equal(
    survivesLines({ subject: RESET_SUBJECT_REMOTE })[2].title,
    'Anything that already left the computer you are driving',
    'the relay reader must be told that the sentence concerns the driven computer',
  )

  const reset = {
    phase: 'confirm',
    plan: { available: true, roots: [], untouched: [], conflicts: [], totals: { files: 0, bytes: 0 } },
  }
  assert.match(resetMarkup({ reset }), /Anything that already left this computer/, 'the local painter must use the desk sentence')
  assert.match(
    resetMarkup({ reset, subject: RESET_SUBJECT_REMOTE }),
    /Anything that already left the computer you are driving/,
    'the relay painter must use the remote twin',
  )
})

test('measured sizes and shell root kinds stay recognisable to a person', () => {
  assert.deepEqual(
    [0, 512, 1024, 1048576].map(formatBytes),
    ['0 bytes', '512 bytes', '1.0 KB', '1.00 MB'],
    'byte measurements must retain their useful unit and magnitude',
  )
  assert.deepEqual(
    ['user-data', 'installation', 'earlier-name', 'future-kind'].map(rootLabel),
    [
      'What this program saved for you',
      'This installation’s own settings',
      'Data from this program’s earlier name',
      'Saved data',
    ],
    'every root kind emitted by the shell needs a human label and unknown kinds need a safe fallback',
  )
})

test('a real plan reply keeps measured folders, totals, survivors, and conflicts distinct', () => {
  const plan = readPlan({
    ok: true,
    roots: [{
      kind: 'user-data', directory: '/profile', guarded: true, present: true,
      files: 2, bytes: 1536, named: [{ what: 'saved credentials', rel: 'credentials.enc' }],
    }],
    totals: { files: 2, bytes: 1536 },
    untouched: [{ kind: 'workspace', directory: '/work/safe' }],
    conflicts: [{ kind: 'workspace', directory: '/profile/work/at-risk' }],
  })

  assert.equal(plan.available, true, 'a valid shell measurement must remain available for confirmation')
  assert.deepEqual(plan.totals, { files: 2, bytes: 1536 }, 'the confirmation must use the shell measured totals')
  assert.deepEqual(plan.untouched, [{ kind: 'workspace', directory: '/work/safe' }], 'an untouched workspace must remain a survivor')
  assert.deepEqual(plan.conflicts, [{ kind: 'workspace', directory: '/profile/work/at-risk' }], 'an at-risk workspace must not collapse into the survivor list')

  const [line] = planLines(plan)
  assert.equal(line.tone, 'serious', 'a present guarded root must be presented as data that would be deleted')
  assert.match(line.detail, /2 files.*1\.5 KB/i, 'the deletion line must state the measured count and readable size')
  assert.match(line.detail, /saved credentials/i, 'the deletion line must disclose the named sensitive data')
})

test('could-not-read replies never collapse into a definite measurement or deletion answer', () => {
  for (const reply of [null, { ok: false, reason: 'vault was locked' }, { ok: true }]) {
    const plan = readPlan(reply)
    assert.equal(plan.available, false, 'an unreadable plan must refuse confirmation rather than claim a definite answer')
    assert.ok(plan.reason, 'an unreadable plan must explain why no definite answer is available')
  }

  const sweep = readSweep({ ok: false, reason: 'vault was locked' })
  assert.equal(sweep.ran, false, 'a failed erase reply must not claim that the sweep ran')
  assert.equal(sweep.complete, false, 'a failed erase reply must never become a complete deletion')
  const outcome = outcomeLines(sweep)
  assert.equal(outcome.tone, 'bad', 'an erase failure must be presented as a failure')
  assert.match(outcome.title, /could not be confirmed/i, 'an unqualified failure must not claim that the data is intact')
  assert.match(outcome.detail, /vault was locked/i, 'failure copy must preserve the useful reason from the shell')
})

test('an explicit refusal before browser deletion preserves the nothing-deleted outcome', () => {
  const browserStorage = { attempted: false, cleared: false }
  const sweep = readSweep({ ok: false, reason: 'The Session storage root could not be guarded.', browserStorage })
  assert.deepEqual(sweep.browserStorage, browserStorage)
  assert.equal(sweep.ran, false)
  assert.equal(sweep.complete, false)
  const outcome = outcomeLines(sweep)
  assert.equal(outcome.title, 'Nothing was deleted.')
  assert.match(outcome.detail, /could not be guarded/)
  assert.match(resetMarkup({ reset: { phase: 'done', sweep } }), /Nothing was deleted\./)
})

test('an unconfirmed browser clear never renders a claim that nothing was deleted', () => {
  const browserStorage = { attempted: true, cleared: false, reason: 'The browser clear did not finish.' }
  const sweep = readSweep({ ok: false, reason: 'Restart ToolsEnabled before trying again.', browserStorage })
  assert.deepEqual(sweep.browserStorage, browserStorage)
  assert.equal(sweep.ran, false, 'browser deletion must not be represented as a filesystem sweep')
  assert.equal(sweep.complete, false)
  const outcome = outcomeLines(sweep)
  assert.equal(outcome.tone, 'bad')
  assert.match(outcome.title, /could not be confirmed/)
  assert.match(outcome.detail, /browser settings may have been deleted/i)
  assert.match(outcome.detail, /Restart ToolsEnabled/)
  const markup = resetMarkup({ reset: { phase: 'done', sweep } })
  assert.doesNotMatch(markup, /Nothing was deleted|exactly as it was|It is gone/)
  assert.match(markup, /could not be confirmed/)
})

test('a confirmed browser-only clear says what changed without inventing a filesystem sweep', () => {
  const browserStorage = { attempted: true, cleared: true }
  for (const reply of [
    { ok: false, reason: 'Research cleanup changed before the remaining files could be erased.', browserStorage },
    { ok: true, browserStorage },
  ]) {
    const sweep = readSweep(reply)
    assert.deepEqual(sweep.browserStorage, browserStorage)
    assert.equal(sweep.ran, false)
    assert.equal(sweep.complete, false)
    const outcome = outcomeLines(sweep)
    assert.equal(outcome.tone, 'bad')
    assert.match(outcome.title, /Browser settings were cleared/)
    assert.doesNotMatch(outcome.detail, /exactly as it was|Every file.*removed/)
    const markup = resetMarkup({ reset: { phase: 'done', sweep } })
    assert.match(markup, /Browser settings were cleared/)
    assert.doesNotMatch(markup, /Nothing was deleted|It is gone/)
  }
})

test('unknown and malformed reset replies cannot claim that saved data is intact', () => {
  for (const reply of [
    null, undefined, 42, [], {}, { ok: true },
    { ok: 'false', browserStorage: { attempted: false, cleared: false } },
    { ok: true, browserStorage: { attempted: false, cleared: false } },
    { ok: false, browserStorage: { attempted: false, cleared: true } },
    { ok: false, browserStorage: { attempted: 'false', cleared: 'false' } },
    { ok: false, browserStorage: [] },
  ]) {
    const sweep = readSweep(reply)
    assert.equal(sweep.ran, false)
    assert.equal(sweep.complete, false)
    const outcome = outcomeLines(sweep)
    assert.match(outcome.title, /could not be confirmed/)
    assert.doesNotMatch(outcome.title + ' ' + outcome.detail, /Nothing was deleted|exactly as it was|data is intact/)
  }
})

test('measured successful filesystem sweeps retain their browser-clear acknowledgment', () => {
  const browserStorage = { attempted: true, cleared: true }
  for (const complete of [true, false]) {
    const sweep = readSweep({
      ok: true, browserStorage,
      swept: { ok: true, complete, remainingFiles: complete ? 0 : 1, results: [] },
    })
    assert.deepEqual(sweep.browserStorage, browserStorage)
    assert.equal(sweep.ran, true)
    assert.equal(sweep.complete, complete)
    assert.equal(outcomeLines(sweep).tone, complete ? 'good' : 'warn')
  }
})

test('post-sweep copy distinguishes verified deletion from files left behind', () => {
  const partial = readSweep({
    ok: true,
    swept: {
      ok: true, complete: false, remainingFiles: 1, remainingBytes: 20,
      results: [{
        kind: 'installation', directory: '/install', removedRoot: false,
        entries: [{ name: 'open.db', removed: false, reason: 'in use' }],
        remaining: { files: 1 },
      }],
    },
    revoked: { ok: true, revokedSessions: true },
  })
  assert.equal(partial.complete, false, 'remaining files must prevent a verified-complete result')
  assert.deepEqual(partial.roots[0].kept, [{ name: 'open.db', reason: 'in use' }], 'files that remain must stay named with their reason')
  const warning = outcomeLines(partial)
  assert.equal(warning.tone, 'warn', 'a sweep with remaining files must be a warning, not success')
  assert.match(warning.detail, /1 file.*could not be deleted/i, 'partial-result copy must state how much remains')
  assert.match(warning.detail, /clos(e|ing).*ToolsEnabled/i, 'partial-result copy must give the user a way to finish')

  const complete = outcomeLines(readSweep({
    ok: true,
    swept: { ok: true, complete: true, results: [], remainingFiles: 0, remainingBytes: 0 },
    revoked: { ok: true, revokedSessions: true },
  }), { platform: 'win32' })
  assert.equal(complete.tone, 'good', 'only a verified complete sweep may produce success copy')
  assert.match(complete.detail, /every file.*removed.*checked/i, 'success copy must say deletion was verified after the sweep')
  assert.match(complete.detail, /sign-in.*ended/i, 'success copy must disclose that sessions were revoked')
  assert.match(complete.detail, /still installed.*Windows Settings/i, 'success copy must refuse to imply that the program was uninstalled')
})

/* THE DELETE-EVERYTHING SCREEN MUST NOT DESCRIBE THINGS THAT DID NOT HAPPEN.
 *
 * Three sentences on the one control in the product that cannot be undone were
 * composed from the wrong field. None of them is a dead control or a swallowed
 * error -- every mechanism underneath works and reports honestly. The summary
 * layer read `ok` where it needed the outcome. That class is invisible to a
 * unit audit, and it was invisible to this suite too: every fixture here passed
 * `revoked: { ok: true, revokedSessions: true }`, so the disagreeing pair was
 * never generated even once.
 *
 * The rule they break is stated by shell/local-data-reset.cjs about itself:
 * "`ok` here means the sweep ran, NEVER everything is gone." It enforced that
 * for `swept` and this screen dropped it for everything else.
 */

test('a wipe with no session to end does not claim copied sign-ins were refused', () => {
  /* The person who presses this is often somebody wiping a laptop they believe
     is compromised. Telling them every copy taken off that computer is now
     refused, when no epoch was bumped, is exactly why they would stop worrying.
     Identical defect to the "Sign out everywhere" button beside it. */
  const ended = outcomeLines(readSweep({
    ok: true,
    swept: { ok: true, complete: true, results: [], remainingFiles: 0 },
    revoked: { ok: true, revokedSessions: true },
  }))
  const notEnded = outcomeLines(readSweep({
    ok: true,
    swept: { ok: true, complete: true, results: [], remainingFiles: 0 },
    revoked: { ok: true, revokedSessions: false },
  }))

  assert.doesNotMatch(notEnded.detail, /Every sign-in was ended/,
    'the screen claimed every copied sign-in was refused when the revocation ended no session')
  assert.match(notEnded.detail, /No sign-in was active/,
    'the honest outcome must still be stated -- going silent about sessions is its own gap')

  /* THE CONTROL. Without it, deleting the sentence outright would pass above. */
  assert.match(ended.detail, /Every sign-in was ended first/,
    'a real revocation no longer says so, so the check above is passing on silence')
})

test('a folder that was never opened is not reported as files Windows had open', () => {
  /* A root the guard refused, or one that could not be read, comes back with no
     `remaining`, so it adds ZERO to remainingFiles while making `complete`
     false. The old branch then printed "0 files could not be deleted while the
     program is running, because Windows had them open. They are named below":
     a count that is zero, a cause that is wrong, a list that is empty, and a
     remedy naming no folder. */
  const out = outcomeLines(readSweep({
    ok: true,
    swept: {
      ok: true,
      complete: false,
      remainingFiles: 0,
      results: [{ kind: 'user-data', ok: false, reason: 'the folder could not be read', directory: 'C:/Users/x/AppData/Roaming/ToolsEnabled' }],
    },
    revoked: { ok: true, revokedSessions: true },
  }))

  assert.doesNotMatch(out.detail, /^0 file/,
    'the screen opened by counting zero files as though something had been counted')
  assert.doesNotMatch(out.detail, /Windows had them open/,
    'the screen blamed open file handles for a folder nothing had looked inside')
  assert.match(out.detail, /could not be opened/,
    'the real cause must be stated')
  assert.match(out.detail, /C:\/Users\/x\/AppData\/Roaming\/ToolsEnabled/,
    'the folder must be named, or the remedy is unfollowable')
  assert.match(out.detail, /the folder could not be read/,
    'what Windows said must survive to the screen')

  /* THE CONTROL: a genuine open-file remainder must still get the open-file
     sentence, or this fix has simply replaced one wrong branch with another. */
  const openFiles = outcomeLines(readSweep({
    ok: true,
    swept: {
      ok: true,
      complete: false,
      remainingFiles: 2,
      results: [{ kind: 'user-data', ok: true, entries: [], remaining: { files: 2 } }],
    },
    revoked: { ok: true, revokedSessions: true },
  }))
  assert.match(openFiles.detail, /Windows had them open/,
    'a real open-file remainder lost its own sentence')
})

test('the survivor the product promised to explain is named', () => {
  /* shell/main.cjs closes the canonical ledger before the sweep and reports
     whether it closed, specifically so this screen can account for a survivor.
     The reader dropped it, so the file most likely to be left behind was the one
     the product had decided in writing it must be able to explain. */
  const held = outcomeLines(readSweep({
    ok: true,
    swept: {
      ok: true,
      complete: false,
      remainingFiles: 1,
      results: [{ kind: 'user-data', ok: true, entries: [], remaining: { files: 1 } }],
    },
    revoked: { ok: true, revokedSessions: true },
    ledgerClosed: { ok: true, closed: false, reason: 'held open by this window' },
  }))
  assert.match(held.detail, /this program's own record/,
    'the ledger survived the sweep and the screen did not say so')
  assert.match(held.detail, /held open by this window/,
    'the reason the ledger survived was dropped')

  /* THE CONTROL: a ledger that DID close must not be mentioned at all. */
  const closed = outcomeLines(readSweep({
    ok: true,
    swept: {
      ok: true,
      complete: false,
      remainingFiles: 1,
      results: [{ kind: 'user-data', ok: true, entries: [], remaining: { files: 1 } }],
    },
    revoked: { ok: true, revokedSessions: true },
    ledgerClosed: { ok: true, closed: true, reason: null },
  }))
  assert.doesNotMatch(closed.detail, /this program's own record/,
    'a ledger that closed cleanly is being reported as a survivor')
})

test('the sign-out sentence does not name a password an account does not have', async () => {
  /* IT SAID "the same password signs you back in", FLATLY, TO EVERYBODY.
   *
   * It is rendered on the same screen where a Google account is told, correctly,
   * "Google checked that address, so there is no password here to change." So a
   * Google account read both sentences at once, and the one beside the Sign out
   * button named a credential they do not have.
   *
   * Not a lockout -- Google sign-in still works -- but it is the sentence
   * somebody acting on a stolen laptop reads immediately before pressing the
   * button, which is when a wrong instruction is least affordable.
   *
   * account-markup.js already branched on state.signInMethod for the rename row
   * twenty lines away and got it right there. The defect was one flat constant
   * beside a screen full of correctly-branched copy.
   */
  const { signOutLimits, SIGN_OUT_LIMITS } = await import('../../src/account-reset-copy.js')

  const google = signOutLimits('google')
  assert.doesNotMatch(google, /password/i,
    'a Google account is still told a password signs them back in, on the same screen that tells them '
    + 'there is no password here')
  assert.match(google, /Google/,
    'the Google case does not say how they get back in, which is worse than naming the wrong credential')

  /* THE CONTROL: a password account must keep the specific, useful sentence.
     Going method-neutral for everyone would pass the assertions above while
     making the copy vaguer for the people it was already right for. */
  const password = signOutLimits('password')
  assert.match(password, /the same password signs you back in/,
    'a password account lost the specific reassurance it had')

  /* Both must still carry what the sentence is FOR: that signing out deletes
     nothing. That is the half somebody on a stolen laptop is checking. */
  for (const [label, text] of [['google', google], ['password', password]]) {
    assert.match(text, /Neither one deletes anything/,
      `the ${label} sentence lost the promise that signing out deletes nothing`)
  }

  /* The bare constant is kept for callers with no method to hand, and must name
     NEITHER credential -- a default that guesses is wrong for half of them. */
  assert.doesNotMatch(SIGN_OUT_LIMITS, /the same password|with Google/,
    'the method-less default names a specific credential again, so a caller that does not know the method '
    + 'will state one anyway')
})

test('the sign-out row hands the copy the sign-in method it already knows', () => {
  /* THE HALF THE COPY TEST CANNOT SEE, and a mutation proved it: changing
   * account-markup.js to call signOutLimits(null) left every assertion in the
   * test above green. The function branches perfectly while the caller stops
   * telling it which branch to take -- a Google account then gets the neutral
   * wording rather than the Google one, which is not the original defect but is
   * the row giving up a fact it is holding.
   *
   * That is the same shape as the defect this whole file keeps finding: a
   * producer that knows, and a consumer that does not ask. */
  const source = readFileSync(
    new URL('../../src/account-markup.js', import.meta.url), 'utf8')

  assert.match(source, /signOutLimits\(state\.signInMethod\)/,
    'the sign-out row no longer passes the sign-in method, so the copy cannot branch and a Google account '
    + 'gets wording written for somebody who has a password')
  assert.doesNotMatch(source, /esc\(SIGN_OUT_LIMITS\)/,
    'the row is rendering the method-less constant again, which is the flat sentence the branch replaced')
})
