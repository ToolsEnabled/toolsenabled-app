// THE UNINSTALL CHOICE WHEN SOMEBODY IS SIGNED IN.
//
// tools/test/uninstall-retention.test.mjs covers the policy file itself and is
// entirely about ABSENCE resolving to a question. This file covers the half that
// decides WHICH ABSENCE, and it exists because that half shipped broken.
//
// `mc.set.uninstall_data` is account-scoped by public/durable-storage.js: while
// somebody is signed in, the key that reaches the shell is
// `acct:<32 hex>:mc.set.uninstall_data` and the bare name is never written. The
// mirror matched the bare name, so for every customer with an account it never
// ran. Measured 2026-08-19 against these same real stores, both directions were
// live and both are asserted below:
//
//   - "Remove everything" chosen while signed in wrote NO policy file, so a
//     silent uninstall kept the vault the person asked to have destroyed;
//   - "Remove everything" chosen signed OUT and then WITHDRAWN -- sign in,
//     switch to "Keep my data" -- left the armed token on disk, and
//     build/installer.nsh RMDir /r's %APPDATA%\ToolsEnabled on it.
//
// THE STORES HERE ARE THE REAL ONES. shell/renderer-prefs.cjs and
// shell/product-account.cjs are constructed over a scratch directory and driven
// through real sign-ins and real writes; the assertions read the token off the
// disk. What is MODELLED rather than executed is shell/main.cjs, which cannot be
// imported without Electron: `settingsPageChoice` below performs exactly the two
// writes public/durable-storage.js performs for one click and calls the mirror
// where main.cjs's two handlers call it. The source assertions at the bottom are
// what hold main.cjs to that, and they are written to catch REMOVAL of a call
// site -- which is the defect that was here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const retention = require(join(REPO, 'shell', 'uninstall-retention.cjs'))
const { createRendererPrefs } = require(join(REPO, 'shell', 'renderer-prefs.cjs'))
const { createAccountStore } = require(join(REPO, 'shell', 'product-account.cjs'))

const {
  CHOICE_KEEP,
  CHOICE_REMOVE,
  POLICY_FILE,
  RETENTION_PREF_KEY,
  accountScopedRetentionKey,
  isRetentionPrefKey,
  effectiveRetentionValue,
  mirrorRetentionChoice,
} = retention

const NO_FILE = '(no policy file)'

/* A password is required to make an account and none of these is a credential
   for anything: the store is built over a directory this test created and
   deletes. It is never printed. */
const TEST_PASSWORD = 'this-is-not-a-real-password'

/* AWAITED, AND THE REASON IS A DEFECT THIS HELPER ALREADY HAD.
   Written first as a plain `try { return run(...) } finally { rmSync(root) }`,
   which is correct for a synchronous body and silently wrong for every async
   one: `run` returns a promise, the `finally` fires immediately, and the scratch
   directory is deleted WHILE the test is still writing to it. The assertions
   still passed -- the stores recreate what they need -- so the only visible
   symptom was 81 leaked directories under %TEMP%, and the isolation each test
   believed it had was accidental. Awaiting is what makes the cleanup mean
   what it says. Every caller awaits in turn. */
async function withStores(run) {
  const root = mkdtempSync(join(tmpdir(), 'te-retention-account-'))
  const userDataDir = join(root, 'ToolsEnabled')
  fs.mkdirSync(userDataDir, { recursive: true })
  /* `createAccountStore`, not `sharedAccountStore`: the shared one binds to the
     first directory it is given for the life of the process, so a second test
     would be refused. */
  const stores = {
    userDataDir,
    prefs: createRendererPrefs({ directory: userDataDir, fs, path, randomUUID }),
    account: createAccountStore({ safeStorage: undefined, directory: userDataDir }),
  }
  try {
    return await run(stores)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function mirror({ userDataDir, prefs, account }) {
  return mirrorRetentionChoice({ userDataDir, prefs, account })
}

function token({ userDataDir }) {
  const file = join(userDataDir, POLICY_FILE)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : NO_FILE
}

/* Creating an account does NOT sign anybody in -- shell/product-account.cjs
   mints a session only in `signIn` -- so both steps are performed here, exactly
   as the account screen performs them. */
async function signInAsNewPerson(stores, username) {
  const created = await stores.account.createAccount({
    username,
    displayName: `${username} (test)`,
    password: TEST_PASSWORD,
  })
  assert.equal(created.ok, true, 'precondition: the test account was created')
  const signedIn = await stores.account.signIn({ username, password: TEST_PASSWORD })
  assert.equal(signedIn.ok, true, 'precondition: the test account is signed in')
  const state = stores.account.current()
  assert.equal(state.signedIn, true, 'precondition: the store agrees somebody is signed in')
  return state.account.id
}

/* ONE CLICK ON THE SETTINGS PAGE, ROUTED AS THE PRODUCT ROUTES IT.
 *
 * public/durable-storage.js:264-290 -- signed in, an `mc.set.*` write goes to
 * the per-account slot in the device record AND to the account partition; signed
 * out it goes to the bare device key. The settings page REMOVES the key for its
 * default, so choosing "Ask me then" is a removal, not a write of "ask".
 *
 * shell/main.cjs mirrors on `mc-prefs:write`/`mc-prefs:remove` (the key it sees
 * is whichever name was used) and on `mc-account:setting-put` (which always sees
 * the bare name). Both are performed here, in that order, because both are
 * performed there for a single click. */
function settingsPageChoice(stores, choice, signedInId = null) {
  const removing = choice === 'ask'
  if (signedInId !== null) {
    const slot = accountScopedRetentionKey(signedInId)
    if (removing) stores.prefs.remove(slot)
    else stores.prefs.set(slot, choice)
    if (isRetentionPrefKey(slot)) mirror(stores)

    stores.account.putSetting({ key: RETENTION_PREF_KEY, value: removing ? null : choice })
    if (isRetentionPrefKey(RETENTION_PREF_KEY)) mirror(stores)
    return
  }
  if (removing) stores.prefs.remove(RETENTION_PREF_KEY)
  else stores.prefs.set(RETENTION_PREF_KEY, choice)
  if (isRetentionPrefKey(RETENTION_PREF_KEY)) mirror(stores)
}

// ---------------------------------------------------------------------------
// THE TWO FAILURES THAT SHIPPED.
// ---------------------------------------------------------------------------

test('a "remove everything" the person WITHDREW after signing in does not stay armed', async () => {
  await withStores(async (stores) => {
    settingsPageChoice(stores, CHOICE_REMOVE, null)
    assert.equal(token(stores), CHOICE_REMOVE, 'precondition: the signed-out decision was recorded')

    const id = await signInAsNewPerson(stores, 'withdrawn-decision')
    /* Signing in changes which stored answer the settings page shows even
       though no setting was written, so the shell mirrors on the sign-in. */
    mirror(stores)

    settingsPageChoice(stores, CHOICE_KEEP, id)

    assert.equal(
      token(stores),
      CHOICE_KEEP,
      'the person switched to "Keep my data" and the uninstaller must read that. Leaving the '
        + 'earlier "remove everything" here is build/installer.nsh RMDir /r-ing %APPDATA%\\ToolsEnabled '
        + 'on a decision they had already reversed',
    )
  })
})

test('a "remove everything" chosen WHILE SIGNED IN reaches the uninstaller at all', async () => {
  await withStores(async (stores) => {
    const id = await signInAsNewPerson(stores, 'signed-in-remove')
    mirror(stores)

    settingsPageChoice(stores, CHOICE_REMOVE, id)

    assert.equal(
      token(stores),
      CHOICE_REMOVE,
      'the person asked for their credentials and their ledger to be destroyed at uninstall. No '
        + 'policy file means a silent uninstall keeps them, which is the request being ignored',
    )
  })
})

/* THE acct: KEY ON ITS OWN HAS TO BE ENOUGH, and mutation testing is why this
   test exists. Restoring the bare-literal key match -- the shipped defect --
   left the two tests above GREEN, because a settings click also sends the bare
   name through `mc-account:setting-put`, which now mirrors too. The redundancy
   is real and wanted, but it means neither of those tests actually binds the
   `acct:<id>:` match.

   And the partition write is the half that can silently not happen:
   public/durable-storage.js calls it best-effort and swallows a rejection on
   purpose ("the bridge went away; the device mirror already holds it"). So this
   is the click where only the synchronous slot write lands. */
test('the account-scoped key alone carries the decision when the partition write is lost', async () => {
  await withStores(async (stores) => {
    const id = await signInAsNewPerson(stores, 'partition-write-lost')
    mirror(stores)

    stores.prefs.set(accountScopedRetentionKey(id), CHOICE_REMOVE)
    // and nothing else: no putSetting, exactly as a rejected invoke leaves it.
    assert.equal(isRetentionPrefKey(accountScopedRetentionKey(id)), true, 'precondition: the key is recognised')
    mirror(stores)

    assert.equal(
      token(stores),
      CHOICE_REMOVE,
      'the only write that landed was the namespaced one, and the person still asked for their '
        + 'data to be removed',
    )

    stores.prefs.remove(accountScopedRetentionKey(id))
    mirror(stores)
    assert.equal(token(stores), NO_FILE, 'and withdrawing it through that same key clears the token')
  })
})

// ---------------------------------------------------------------------------
// WHICH COPY WINS. The rule is: the value the settings page is showing.
// ---------------------------------------------------------------------------

test('signed out, the device record still decides, exactly as it always did', async () => {
  await withStores((stores) => {
    settingsPageChoice(stores, CHOICE_REMOVE, null)
    assert.equal(token(stores), CHOICE_REMOVE)

    settingsPageChoice(stores, CHOICE_KEEP, null)
    assert.equal(token(stores), CHOICE_KEEP)

    settingsPageChoice(stores, 'ask', null)
    assert.equal(token(stores), NO_FILE, 'the default is an absence, not a token')
  })
})

test('signing out puts the device answer back, because that is what the page shows again', async () => {
  await withStores(async (stores) => {
    settingsPageChoice(stores, CHOICE_REMOVE, null)
    const id = await signInAsNewPerson(stores, 'signs-out-again')
    mirror(stores)
    settingsPageChoice(stores, CHOICE_KEEP, id)
    assert.equal(token(stores), CHOICE_KEEP, 'precondition: the account chose to keep')

    stores.account.signOut()
    mirror(stores)

    assert.equal(
      token(stores),
      CHOICE_REMOVE,
      'signed out, the settings page shows the device answer again, and the uninstaller must '
        + 'read the same thing the person can see',
    )
  })
})

test("a decision this account never made does not inherit the computer's", async () => {
  await withStores(async (stores) => {
    /* Created while the device record is empty, so nothing is adopted into the
       partition, and then a decision is made on this computer signed out. */
    await signInAsNewPerson(stores, 'never-chose')
    stores.account.signOut()
    settingsPageChoice(stores, CHOICE_REMOVE, null)
    assert.equal(token(stores), CHOICE_REMOVE, 'precondition: the computer carries a decision')

    const back = await stores.account.signIn({ username: 'never-chose', password: TEST_PASSWORD })
    assert.equal(back.ok, true)
    mirror(stores)

    assert.equal(
      token(stores),
      NO_FILE,
      'this account has not chosen, and its settings page says "Ask me then". Acting on the '
        + "device's older answer would delete their data on a decision they never saw",
    )
    assert.equal(effectiveRetentionValue(stores).source, 'account-absent')
    assert.equal(
      stores.prefs.snapshot().values[RETENTION_PREF_KEY],
      CHOICE_REMOVE,
      'and the device answer is still on disk, untouched -- it applies again when they sign out',
    )
  })
})

test('the account partition answers when the device slot has never been written', async () => {
  await withStores(async (stores) => {
    const id = await signInAsNewPerson(stores, 'partition-only')
    /* The authoritative per-account store, without the synchronous device
       mirror -- which is the state a first sign-in on another computer, or a
       partition adopted at account creation, actually leaves behind. */
    assert.equal(stores.account.putSetting({ key: RETENTION_PREF_KEY, value: CHOICE_REMOVE }).ok, true)
    assert.equal(
      Object.prototype.hasOwnProperty.call(stores.prefs.snapshot().values, accountScopedRetentionKey(id)),
      false,
      'precondition: nothing is in the device slot',
    )

    mirror(stores)

    assert.equal(token(stores), CHOICE_REMOVE)
    assert.equal(effectiveRetentionValue(stores).source, 'account-partition')
  })
})

test('the device slot wins over a partition that disagrees, as durable-storage resolves it', async () => {
  await withStores(async (stores) => {
    const id = await signInAsNewPerson(stores, 'slot-wins')
    assert.equal(stores.account.putSetting({ key: RETENTION_PREF_KEY, value: CHOICE_REMOVE }).ok, true)
    stores.prefs.set(accountScopedRetentionKey(id), CHOICE_KEEP)

    mirror(stores)

    assert.equal(
      token(stores),
      CHOICE_KEEP,
      'public/durable-storage.js builds the overlay from the partition and then lets the device '
        + 'slot override it, so the slot is what the settings page shows -- and the destructive '
        + 'copy losing that tie is the safe direction as well as the correct one',
    )
    assert.equal(effectiveRetentionValue(stores).source, 'account-device-slot')
  })
})

// ---------------------------------------------------------------------------
// IGNORANCE. Not knowing must never write the token that deletes.
// ---------------------------------------------------------------------------

const BROKEN_ACCOUNT_STORES = Object.freeze([
  ['an account store that throws', { current() { throw new Error('the accounts file is unreadable') } }],
  ['an account store that answers nothing', { current() { return null } }],
  ['an account store that answers a shape nobody expected', { current() { return { signedIn: 'yes' } } }],
  ['a signed-in answer with no account on it', { current() { return { signedIn: true } } }],
  ['a signed-in answer with an id that is not an id', { current() { return { signedIn: true, account: { id: 'not-hex' } } } }],
  ['no account store at all', null],
])

for (const [label, account] of BROKEN_ACCOUNT_STORES) {
  test(`${label} clears the token rather than acting on the device's`, async () => {
    await withStores((stores) => {
      settingsPageChoice(stores, CHOICE_REMOVE, null)
      assert.equal(token(stores), CHOICE_REMOVE, 'precondition: the computer carries a destructive decision')

      const result = mirrorRetentionChoice({ userDataDir: stores.userDataDir, prefs: stores.prefs, account })

      assert.equal(result.ok, true)
      /* The label got MORE specific and the safety property below is unchanged.
         'unknown' became 'device-unreadable' or 'identity-unreadable', which names
         WHICH read failed instead of collapsing both into one word. The assertion
         that matters -- that ignorance disarms a recorded "remove everything" -- is
         asserted below and was restored in the module after a landed diff returned
         early and left the token armed. */
      assert.match(String(result.source), /unreadable|unknown/)
      assert.equal(
        token(stores),
        NO_FILE,
        'we cannot tell whose answer applies. Keeping the data and asking is recoverable; '
          + 'deleting a vault on a guess is not, so ignorance never leaves "remove everything" armed',
      )
    })
  })
}

test('settings that cannot be read clear the token too', async () => {
  await withStores((stores) => {
    settingsPageChoice(stores, CHOICE_REMOVE, null)
    assert.equal(token(stores), CHOICE_REMOVE)

    const result = mirrorRetentionChoice({
      userDataDir: stores.userDataDir,
      prefs: { snapshot() { throw new Error('the settings file is locked') } },
      account: stores.account,
    })

    assert.equal(result.ok, true)
    /* Same widening as above: the source names WHICH read failed now. The
       clearing assertion that follows is the one carrying the safety property. */
    assert.match(String(result.source), /unreadable|unknown/)
    assert.equal(token(stores), NO_FILE)
  })
})

test('a mirror failure is reported, never thrown at the caller that was saving a setting', async () => {
  await withStores((stores) => {
    const result = mirrorRetentionChoice({
      userDataDir: stores.userDataDir,
      prefs: { snapshot() { return { values: {} } } },
      account: { current() { return { signedIn: false } } },
      fs: {
        unlinkSync() { const error = new Error('EBUSY'); error.code = 'EBUSY'; throw error },
        mkdirSync() {},
        writeFileSync() {},
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /could not be cleared/)
    assert.match(result.reason, /may still act on it/)
  })
})

// ---------------------------------------------------------------------------
// THE KEY MATCH. The whole defect was one `!==`.
// ---------------------------------------------------------------------------

test('both names for this setting are recognised, and nothing else is', () => {
  const id = 'a'.repeat(32)
  assert.equal(isRetentionPrefKey(RETENTION_PREF_KEY), true)
  assert.equal(isRetentionPrefKey(accountScopedRetentionKey(id)), true)
  assert.equal(isRetentionPrefKey(`acct:${'0123456789abcdef'.repeat(2)}:${RETENTION_PREF_KEY}`), true)

  for (const other of [
    'mc.set.theme',
    `acct:${id}:mc.set.theme`,
    'mc.set.uninstall_datas',
    'uninstall_data',
    `acct:${'a'.repeat(31)}:${RETENTION_PREF_KEY}`,
    `acct:${'A'.repeat(32)}:${RETENTION_PREF_KEY}`,
    `acct::${RETENTION_PREF_KEY}`,
    `acct:${id}:acct:${id}:${RETENTION_PREF_KEY}`,
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isRetentionPrefKey(other), false, `${JSON.stringify(other)} is not this setting`)
  }
})

// ---------------------------------------------------------------------------
// THE WIRING. Weaker than the above -- it reads source -- and aimed at removal.
// ---------------------------------------------------------------------------

const MAIN = readFileSync(join(REPO, 'shell', 'main.cjs'), 'utf8')

test('the shell no longer compares the settings key against the bare name', () => {
  assert.equal(
    /key\s*!==\s*RETENTION_PREF_KEY/.test(MAIN),
    false,
    'that comparison is the defect: while signed in the key on the wire is the acct: form, so '
      + 'the mirror never ran for anybody with an account',
  )
  assert.match(MAIN, /isRetentionPrefKey\(key\)/)
})

test('every account channel that mutates runs the mirror after it', async () => {
  const mutating = [
    'mc-account:create',
    'mc-account:sign-in',
    'mc-account:sign-out',
    'mc-account:sign-out-everywhere',
    'mc-account:change-password',
    'mc-account:setting-put',
    'mc-account:google-sign-in',
  ]
  for (const channel of mutating) {
    const handler = new RegExp(`ipcMain\\.handle\\('${channel}'[^\\n]*\\n?[^\\n]*withAccountMutation`)
    assert.match(
      MAIN,
      handler,
      `${channel} changes which stored answer the settings page is showing, so the policy file `
        + 'the uninstaller reads has to be recomputed after it',
    )
  }
  const start = MAIN.indexOf('async function withAccountMutation(')
  const end = MAIN.indexOf('\n/*', start)
  assert.ok(start >= 0 && end > start)
  const makeWrapper = new Function('withFleetProfileSender', 'accountResetStarted',
    'accountResetRefusal', 'getImageOwnerContext', 'accountMutations', 'mirrorUninstallRetention',
    `${MAIN.slice(start, end)}; return withAccountMutation`)
  for (const rejects of [false, true]) {
    const events = [], pending = new Set(), failure = new Error('test mutation refusal')
    const wrapper = makeWrapper((_event, action) => action(), false, () => assert.fail('unexpected reset'),
      () => ({ beginMutation() { events.push('invalidate'); return () => events.push('finalize') } }),
      pending, () => events.push('mirror'))
    const result = wrapper({}, async () => {
      events.push('action')
      await Promise.resolve()
      events.push('settled')
      if (rejects) throw failure
      return 'saved'
    })
    assert.equal(pending.size, 1)
    if (rejects) await assert.rejects(result, error => error === failure)
    else assert.equal(await result, 'saved')
    assert.deepEqual(events, ['invalidate', 'action', 'settled', 'finalize', 'mirror'])
    assert.equal(pending.size, 0)
  }
})

test('the mirror is reconciled at launch, not only on a click', () => {
  const start = MAIN.indexOf('async function createWindow()')
  assert.notEqual(start, -1)
  const body = MAIN.slice(start, start + 4000)
  assert.match(
    body,
    /\n\s*mirrorUninstallRetention\(\)/,
    'a session can expire between runs, which moves the person from their account answer back to '
      + "the device's with nothing on this run to notice it",
  )
})

test('the mirror asks the account store, and treats a missing one as unknown rather than signed out', () => {
  assert.match(MAIN, /function mirrorUninstallRetention\(\)[\s\S]*?getAccountStore\(\)[\s\S]*?catch\s*\{\s*account = null/)
  assert.match(MAIN, /mirrorRetentionChoice\(\{[\s\S]*?prefs: rendererPrefs,[\s\S]*?account,/)
})

test('the mirror does not write back into a folder the person just emptied', () => {
  const start = MAIN.indexOf('function mirrorUninstallRetention()')
  const end = MAIN.indexOf('\nfunction mirrorUninstallRetentionIfRelevant', start)
  assert.ok(start >= 0 && end > start)
  const execute = new Function('localDataErased', 'accountResetStarted', 'getAccountStore',
    `${MAIN.slice(start, end)}; return mirrorUninstallRetention()`)
  for (const [erased, accountReset] of [[true, false], [false, true], [true, true]]) {
    const result = execute(erased, accountReset, () => assert.fail('a sealed mirror must not even reopen account data'))
    assert.equal(result.ok, true)
    assert.equal(typeof result.skipped, 'string')
  }
})
