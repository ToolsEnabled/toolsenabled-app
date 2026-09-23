/* THE CHOICES A PERSON MADE MUST STILL BE THEIRS AFTER THEY SIGN IN.
 *
 * WHAT WAS MEASURED, and it is the owner's own installation rather than a
 * hypothetical: `renderer-prefs.json` holds `mc.theme` and six `mc.set.*` rows,
 * the single account on that computer arrived through the HOSTED door, and that
 * account's partition holds ONE key with `adopted` null. Both facts come from
 * the same rule: `adoptDeviceSettings` is called at two of the creation sites
 * and not at the hosted one, so on that installation the settings already on
 * the computer were owned by nobody -- and `public/durable-storage.js`
 * `getItem` answers `null`, not the device value, for an account-scoped name
 * the overlay has never heard of. From where the person sits every one of those
 * choices is gone the moment they are signed in. "still doesnt seem to actually
 * persist" is what that looks like.
 *
 * THESE ARE BEHAVIOUR TESTS, DELIBERATELY. They call the real store with real
 * values and ask what comes back; not one of them names the function that
 * carries the settings across, so a better implementation passes them and
 * reinstating the defect cannot. The one thing they DO drive end to end is the
 * real `public/durable-storage.js` against the real `shell/renderer-prefs.cjs`
 * and the real `shell/product-account.cjs`, because the defect lives in the
 * seam between those three and no one of them is wrong on its own.
 *
 * THE NO-LEAK PROPERTY IS TESTED IN THE SAME FILE ON PURPOSE. A fix for this
 * that let a SECOND person inherit the first person's settings would be a worse
 * bug than the one it fixed, so the two live together where nobody can satisfy
 * one and quietly drop the other.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import accountModule from '../../shell/product-account.cjs'
import prefsModule from '../../shell/renderer-prefs.cjs'

const { createAccountStore } = accountModule
const { createRendererPrefs } = prefsModule

/* fileURLToPath, not pathname.slice(1): dropping the leading slash is a
   Windows-only idiom, and on Linux it makes this path RELATIVE, so this file
   could not even load outside a cwd of '/'. The product targets both. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DURABLE_STORAGE = fs.readFileSync(path.join(REPO, 'public', 'durable-storage.js'), 'utf8')

/* Stands in for safeStorage's contract only. It genuinely transforms the bytes
   so that nothing here passes because a fake was a passthrough. */
const keystore = () => ({
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: buffer => {
    const stored = buffer.toString('utf8')
    if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
    return Buffer.from(stored.slice(4), 'base64').toString('utf8')
  },
})

/**
 * One installation: a state directory that outlives every launch, and an
 * account store that is REBUILT for each launch.
 *
 * The rebuild is the point. A launch is a process, and the thing being tested
 * is what a LATER process sees; reusing one store object across launches would
 * carry in-memory state -- a restored session, anything a launch has already
 * decided -- across a boundary the product does not have.
 */
function installation(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-survive-sign-in-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let verified = null
  const open = () => createAccountStore({
    directory,
    safeStorage: keystore(),
    hostedAccount: { verifiedAccount: () => verified },
  })
  const box = {
    directory,
    account: open(),
    relaunch: () => { box.account = open(); return box.account },
    signInHosted: (id, email) => { verified = { id, email }; return box.account.signInWithHostedAccount() },
  }
  return box
}

const tick = () => new Promise(resolve => setImmediate(resolve))

/**
 * One launch of the renderer's settings store, built the way the product builds
 * it: the durable prefs file underneath, the account bridge beside it, and the
 * REAL public/durable-storage.js on top. Returns what the page gets when it
 * says `localStorage`.
 */
async function launch(box) {
  const { directory } = box
  const account = box.relaunch()
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  const snapshot = prefs.snapshot()
  const window = {
    localStorage: { length: 0, key: () => null, getItem: () => null },
    document: { documentElement: { dataset: {} } },
    dispatchEvent: () => {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
    mcPrefs: {
      available: true,
      values: snapshot.values,
      drainRequired: false,
      damaged: snapshot.damaged,
      file: prefs.file,
      preservedAt: snapshot.preservedAt,
      write: (key, value) => prefs.set(key, value),
      remove: key => prefs.remove(key),
      clear: () => prefs.clear(),
      drain: () => ({ ok: true, migrated: 0 }),
    },
    mcAccount: {
      current: async () => account.current(),
      data: async () => account.accountDataForRenderer(),
      getSetting: async key => account.getSetting(key),
      putSetting: async (key, value) => account.putSetting({ key, value }),
    },
  }
  const previous = globalThis.window
  globalThis.window = window
  try {
    const storage = new Function('window', `${DURABLE_STORAGE}\n;return window.localStorage`)(window)
    /* The account is asked asynchronously, exactly as it is in the product. A
       page that read before that settled would be testing the wrong moment. */
    for (let turn = 0; turn < 12; turn += 1) await tick()
    return { storage, window, prefs }
  } finally {
    globalThis.window = previous
  }
}

test('a choice made before there was an account is still the person\'s choice after they sign in', async (t) => {
  const box = installation(t)

  /* Signed out: somebody uses the product and chooses things. */
  const before = await launch(box)
  before.storage.setItem('mc.theme', 'black')
  before.storage.setItem('mc.set.tree_style', 'boxes')
  assert.equal(before.storage.getItem('mc.set.tree_style'), 'boxes', 'the choice did not even hold while signed out')

  /* They sign in through the door the owner's own installation used. */
  const signedIn = box.signInHosted('171a949d-hosted-subject', 'someone@example.invalid')
  assert.equal(signedIn.ok, true, signedIn.reason || 'the hosted sign-in refused')

  /* A fresh launch, now signed in. Nothing about what they chose has changed. */
  const after = await launch(box)
  assert.equal(after.storage.getItem('mc.set.tree_style'), 'boxes',
    'a setting chosen on this computer read as absent once its owner signed in')
  assert.equal(after.storage.getItem('mc.theme'), 'black',
    'the appearance chosen on this computer read as absent once its owner signed in')
  assert.equal(after.window.document.documentElement.dataset.theme, 'black',
    'the app repainted itself in a theme the person never chose')
})

test('the second account on this computer inherits nothing from the first', async (t) => {
  const box = installation(t)

  const before = await launch(box)
  before.storage.setItem('mc.set.tree_style', 'boxes')

  assert.equal(box.signInHosted('first-subject', 'first@example.invalid').ok, true)
  const first = await launch(box)
  assert.equal(first.storage.getItem('mc.set.tree_style'), 'boxes', 'the first account lost its own settings')

  box.account.signOut()
  assert.equal(box.signInHosted('second-subject', 'second@example.invalid').ok, true)
  const second = await launch(box)
  assert.equal(second.storage.getItem('mc.set.tree_style'), null,
    'a second person on this computer was shown the first person\'s settings')
})

test('what the account already holds wins over the copy left on the computer', async (t) => {
  const box = installation(t)

  const before = await launch(box)
  before.storage.setItem('mc.set.tree_style', 'boxes')

  assert.equal(box.signInHosted('subject-3', 'three@example.invalid').ok, true)
  const signedIn = await launch(box)
  signedIn.storage.setItem('mc.set.tree_style', 'rings')
  assert.equal(signedIn.storage.getItem('mc.set.tree_style'), 'rings')

  const relaunched = await launch(box)
  assert.equal(relaunched.storage.getItem('mc.set.tree_style'), 'rings',
    'the newer choice was overwritten by the older copy on the computer')
})

test('a setting returned to its default does not come back from the dead on the next sign-in', async (t) => {
  const box = installation(t)

  const before = await launch(box)
  before.storage.setItem('mc.set.tree_style', 'boxes')

  assert.equal(box.signInHosted('subject-4', 'four@example.invalid').ok, true)
  const signedIn = await launch(box)
  assert.equal(signedIn.storage.getItem('mc.set.tree_style'), 'boxes')
  signedIn.storage.removeItem('mc.set.tree_style')
  assert.equal(signedIn.storage.getItem('mc.set.tree_style'), null)

  box.account.signOut()
  assert.equal(box.signInHosted('subject-4', 'four@example.invalid').ok, true)
  const relaunched = await launch(box)
  assert.equal(relaunched.storage.getItem('mc.set.tree_style'), null,
    'a setting the person deliberately cleared was resurrected from the stale copy on the computer')
})

test('an installation that is ALREADY signed in repairs itself on its next launch', async (t) => {
  const box = installation(t)

  /* The owner's own on-disk state, reproduced: choices in the device record,
     one account, and an account partition that never adopted anything. That is
     what a build whose sign-in door skipped the adoption leaves behind, and the
     person is already signed in -- so nothing they do goes back through a
     sign-in to be repaired there. */
  const before = await launch(box)
  before.storage.setItem('mc.set.tree_style', 'boxes')
  before.storage.setItem('mc.theme', 'black')
  assert.equal(box.signInHosted('already-signed-in', 'already@example.invalid').ok, true)

  const partition = path.join(box.directory, 'accounts', `${box.account.current().account.id}.json`)
  const record = JSON.parse(fs.readFileSync(partition, 'utf8'))
  fs.writeFileSync(partition, JSON.stringify({ ...record, settings: {}, adopted: null }, null, 2))

  /* A relaunch. The session is restored from disk; nobody signs in. */
  const relaunched = await launch(box)
  assert.equal(relaunched.storage.getItem('mc.set.tree_style'), 'boxes',
    'an installation already signed in had to wait for an expiry to get its settings back')
  assert.equal(relaunched.storage.getItem('mc.theme'), 'black')
})

test('a payment method on the account survives the settings being carried across', async (t) => {
  const box = installation(t)

  const before = await launch(box)
  before.storage.setItem('mc.set.tree_style', 'boxes')

  assert.equal(box.signInHosted('subject-5', 'five@example.invalid').ok, true)
  const attached = box.account.attachPaymentMethod({ vaultKey: 'payment_card_default' })
  assert.equal(attached.ok, true, attached.reason || 'the fixture card could not be attached')

  box.account.signOut()
  assert.equal(box.signInHosted('subject-5', 'five@example.invalid').ok, true)
  const data = box.account.accountDataForRenderer()
  assert.equal(data.ok, true)
  assert.ok(data.paymentMethod, 'carrying the settings across detached the person\'s card')
})
