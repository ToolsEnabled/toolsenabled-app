/* AN EMPTY userData DIRECTORY IS NOT A STATEMENT THAT THERE IS NOTHING TO KEEP.
 *
 * Electron keys userData on productName. Renaming the product to "ToolsEnabled"
 * pointed every build at %APPDATA%\ToolsEnabled while every existing customer's
 * settings, workspace and spawn records stayed in %APPDATA%\Mission Control.
 * Both directories exist on Machine A right now; the new one was created empty
 * and the old one has never been read since.
 *
 * These run against real directories under a real temp root -- no mocked fs.
 * The behaviour being asserted is what ends up on disk.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const {
  RECORD_FILE,
  LEGACY_SUCCESSOR_NAME,
  LEGACY_USER_DATA_NAMES,
  PRODUCT_STATE_ENTRIES,
  resolveLegacyUserDataNames,
  adoptLegacyUserData,
} = require('../../shell/userdata-adoption.cjs')

function makeAppData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-userdata-'))
  return {
    root,
    legacy: path.join(root, 'Mission Control'),
    current: path.join(root, 'ToolsEnabled'),
  }
}

function seedLegacyInstall(legacy, { theme = 'black' } = {}) {
  fs.mkdirSync(path.join(legacy, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1,
    values: { 'mc.theme': theme },
    drainedOrigins: [],
  }))
  fs.writeFileSync(path.join(legacy, 'shell-state.json'), JSON.stringify({ bounds: { width: 1440 } }))
  fs.writeFileSync(path.join(legacy, 'agent-spawn-records.jsonl'), '{"id":"one"}\n')
  fs.writeFileSync(path.join(legacy, 'agent-spawn-key.enc'), 'not-a-real-key')
  fs.writeFileSync(path.join(legacy, 'workspace', 'notes.md'), '# the persons work\n')
  fs.writeFileSync(path.join(legacy, 'purchase-catalog.json'), JSON.stringify({ items: [] }))
  /* Chromium noise that a fresh launch recreates anyway. */
  fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'Cache', 'data_0'), 'x'.repeat(1024))
}

/* THE DEFAULT IS "THE KEYSTORE CAN OPEN IT", and that is a statement about what
   these tests mean, not a convenience. Every assertion below that expects the
   signing key and its ledger to travel is an assertion about the case where THIS
   install can actually open them; the module now refuses to carry ciphertext it
   cannot prove usable, so the case has to be stated rather than assumed. The
   refusal paths get their own tests further down, and one of them passes no
   validator at all. */
function adopt(paths, { canDecrypt = () => true } = {}) {
  return adoptLegacyUserData({
    userDataPath: paths.current,
    searchRoot: paths.root,
    fs,
    path,
    canDecrypt,
    legacyNames: ['Mission Control'],
  })
}

function stateRoot(root, productName) {
  return path.join(root, productName, 'capability')
}

test('the shipping identity resolves its declared predecessor byte-for-byte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-userdata-identity-'))
  const result = resolveLegacyUserDataNames({
    env: { TOOLSENABLED_STATE_ROOT: stateRoot(root, LEGACY_SUCCESSOR_NAME) },
    path,
  })

  assert.equal(result.status, 'known')
  assert.equal(result.productName, LEGACY_SUCCESSOR_NAME)
  assert.equal(result.reason, 'DECLARED_LEGACY_SUCCESSION')
  assert.deepEqual(result.legacyNames, LEGACY_USER_DATA_NAMES)
})

test('a renamed identity claims no predecessor and reaches no filesystem call', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-userdata-identity-'))
  const productName = `${LEGACY_SUCCESSOR_NAME} Test`
  const result = adoptLegacyUserData({
    userDataPath: path.join(root, productName),
    searchRoot: root,
    env: { TOOLSENABLED_STATE_ROOT: stateRoot(root, productName) },
    fs: new Proxy({}, {
      get(_target, operation) {
        return () => { throw new Error(`renamed identity reached filesystem operation ${String(operation)}`) }
      },
    }),
    path,
  })

  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'NO_DECLARED_LEGACY_SUCCESSION')
  assert.equal(result.identity.status, 'known')
  assert.equal(result.identity.productName, productName)
  assert.deepEqual(result.identity.legacyNames, [])
})

test('an absent state root is a named unknown and reaches no filesystem call', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-userdata-identity-'))
  const result = adoptLegacyUserData({
    userDataPath: path.join(root, LEGACY_SUCCESSOR_NAME),
    searchRoot: root,
    env: {},
    fs: new Proxy({}, {
      get(_target, operation) {
        return () => { throw new Error(`unknown identity reached filesystem operation ${String(operation)}`) }
      },
    }),
    path,
  })

  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'PRODUCT_IDENTITY_UNAVAILABLE')
  assert.equal(result.identity.status, 'unknown')
  assert.equal(result.identity.productName, null)
  assert.deepEqual(result.identity.legacyNames, [])
  assert.match(result.identity.detail, /TOOLSENABLED_STATE_ROOT is not set/)
})

test('the production resolver still adopts for the shipping identity', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)

  const result = adoptLegacyUserData({
    userDataPath: paths.current,
    searchRoot: paths.root,
    env: { TOOLSENABLED_STATE_ROOT: stateRoot(paths.root, LEGACY_SUCCESSOR_NAME) },
    fs,
    path,
    canDecrypt: () => true,
  })

  assert.equal(result.reason, 'ADOPTED')
  assert.equal(result.from, paths.legacy)
  assert.equal(fs.existsSync(path.join(paths.current, 'renderer-prefs.json')), true)
})

test('a renamed install adopts the previous one instead of opening on defaults', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)

  const result = adopt(paths)

  assert.equal(result.adopted, true)
  const prefs = JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8'))
  assert.equal(prefs.values['mc.theme'], 'black', 'the person chose black; a fresh install would paint white')
  assert.equal(
    fs.readFileSync(path.join(paths.current, 'workspace', 'notes.md'), 'utf8'),
    '# the persons work\n',
  )
  assert.equal(fs.existsSync(path.join(paths.current, 'agent-spawn-key.enc')), true)
  assert.equal(
    fs.existsSync(path.join(paths.current, 'agent-spawn-records.jsonl')), true,
    'records without their key would be unreadable; they travel together',
  )
})

test('no file the product keeps in userData is missing from the carry-over list', () => {
  /* THE ONLY GUARD THAT CAN CATCH THE NEXT ONE.
   *
   * Every other test here derives from PRODUCT_STATE_ENTRIES, so a file nobody
   * remembered to add is invisible to all of them -- the list agrees with
   * itself. That is how purchase-catalog.json came to be missing: it was added
   * to userData by another lane while this list already looked complete, and it
   * was found by sweeping the source by hand, not by a test.
   *
   * So this derives the truth from the SOURCE instead: every filename the shell
   * joins onto userData, and the filename constants owned by the modules that
   * are handed userData as a directory. Anything the product stores there and
   * this file does not carry is named here, at build time, instead of at a
   * customer who upgraded and lost it. */
  const shellDirectory = path.join(REPO_ROOT, 'shell')
  const sources = fs.readdirSync(shellDirectory)
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(shellDirectory, name), 'utf8') }))

  const residents = new Set()
  for (const { text } of sources) {
    /* Joined directly onto userData, e.g. path.join(app.getPath('userData'), 'fleet-profile.json') */
    for (const match of text.matchAll(/getPath\(\s*['"]userData['"]\s*\)\s*,\s*['"]([^'"]+)['"]/g)) {
      residents.add(match[1])
    }
  }
  /* Modules handed userData as a `directory` own their own filename, so the
     join above never names them. They are read from their declarations rather
     than copied here, so a rename there surfaces as a failure rather than as a
     stale duplicate. */
  for (const { name, text } of sources) {
    if (name === 'userdata-adoption.cjs') continue
    for (const match of text.matchAll(/^const [A-Z_]*(?:RECORD|KEY|LEDGER)_FILE = ['"]([^'"]+)['"]/gm)) {
      residents.add(match[1])
    }
  }

  assert.ok(sources.length > 0, 'scanned no shell sources -- this guard would pass while checking nothing')
  assert.ok(residents.size > 0, 'found no userData residents at all -- the patterns have drifted from the code')

  const carried = new Set(PRODUCT_STATE_ENTRIES)
  /* Regenerated by Chromium or by the product on launch; carrying them across
     installations is what corrupts a profile. Each is named, not pattern-matched,
     so a new one has to be considered rather than silently swept up. */
  const REGENERATED = new Set(['crash-dumps'])
  const stranded = [...residents].filter((entry) => !carried.has(entry) && !REGENERATED.has(entry))

  assert.deepEqual(
    stranded.sort(),
    [],
    'the product stores these in userData and a renamed install would leave them behind',
  )
})

test('every entry the product claims to own actually gets carried across', () => {
  /* Named against the LIST rather than against a handful of files, because the
     way this defect recurs is a userData file nobody remembered to add. A name
     that is declared but never copied fails here instead of at a customer. */
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)
  for (const entry of PRODUCT_STATE_ENTRIES) {
    const seeded = path.join(paths.legacy, entry)
    if (!fs.existsSync(seeded)) fs.writeFileSync(seeded, 'seeded-by-test')
  }

  adopt(paths)

  const stranded = PRODUCT_STATE_ENTRIES.filter((entry) => !fs.existsSync(path.join(paths.current, entry)))
  assert.deepEqual(stranded, [], 'these are declared product state and were left in the old install')
})

test('Chromium cache is left behind rather than copied between installations', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)

  adopt(paths)

  assert.equal(fs.existsSync(path.join(paths.current, 'Cache')), false)
})

test('an install already in use is never written into', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy, { theme: 'black' })
  fs.mkdirSync(paths.current, { recursive: true })
  fs.writeFileSync(path.join(paths.current, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1, values: { 'mc.theme': 'white' }, drainedOrigins: [],
  }))

  const result = adopt(paths)

  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'TARGET_ALREADY_IN_USE')
  const prefs = JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8'))
  assert.equal(prefs.values['mc.theme'], 'white', 'the current install had real state and it was overwritten')
})

test('adoption happens once — data deleted after it does not come back', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)

  assert.equal(adopt(paths).adopted, true)
  fs.rmSync(path.join(paths.current, 'renderer-prefs.json'))

  const second = adopt(paths)

  assert.equal(second.adopted, false)
  assert.equal(second.reason, 'ALREADY_DECIDED')
  assert.equal(
    fs.existsSync(path.join(paths.current, 'renderer-prefs.json')), false,
    'a deliberate deletion was undone by a second adoption',
  )
})

test('a damaged adoption record still counts as a decision', () => {
  /* THE POINT OF THE WHOLE FILE. The house defect is an absence read as
     consent: unreadable treated as "never happened", missing treated as
     "allowed". A corrupt record here would mean re-running the copy and
     resurrecting whatever the person removed. */
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)
  fs.mkdirSync(paths.current, { recursive: true })
  fs.writeFileSync(path.join(paths.current, RECORD_FILE), '{ this is not json')

  const result = adopt(paths)

  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'ALREADY_DECIDED')
  assert.equal(fs.existsSync(path.join(paths.current, 'renderer-prefs.json')), false)
})

test('with no previous installation it records the decision and adopts nothing', () => {
  const paths = makeAppData()

  const result = adopt(paths)

  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'NO_PRIOR_INSTALL')
  const record = JSON.parse(fs.readFileSync(path.join(paths.current, RECORD_FILE), 'utf8'))
  assert.equal(record.status, 'complete')
  assert.equal(record.adopted, false)
})

test('an empty previous install is not mistaken for one worth adopting', () => {
  const paths = makeAppData()
  /* What a first launch creates and nothing more: Chromium files and an empty
     workspace. There is no person's data here. */
  fs.mkdirSync(path.join(paths.legacy, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(paths.legacy, 'Cache'), { recursive: true })

  const result = adopt(paths)

  assert.equal(result.reason, 'NO_PRIOR_INSTALL')
})

/* ---------------------------------------------------------------------------
 * A NEGATIVE VERDICT IS NOT A DECISION UNLESS IT SAYS WHAT IT SAW.
 *
 * MEASURED on the build machine, 2026-08-11, before any of this existed:
 *   %APPDATA%\ToolsEnabled\.userdata-adoption.json
 *     { status: complete, adopted: false, reason: NO_PRIOR_INSTALL }
 *   %APPDATA%\Mission Control\  shell-state.json, agent-spawn-key.enc,
 *                               agent-spawn-records.jsonl -- all non-empty
 * Run against those exact directories the module answers ADOPTED. The verdict
 * on disk contradicts the code that wrote it, and because a verdict is honoured
 * forever, no later version could ever correct it. These fix that class.
 * ------------------------------------------------------------------------- */

function writeRecord(paths, payload) {
  fs.mkdirSync(paths.current, { recursive: true })
  fs.writeFileSync(path.join(paths.current, RECORD_FILE), JSON.stringify(payload))
}

test('a "nothing to adopt" verdict from a build that recorded no evidence does not strand the prior install', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy, { theme: 'black' })
  /* Exactly the record every build before RECORD_VERSION 2 wrote, and exactly
     the one sitting in %APPDATA%\ToolsEnabled on the build machine. */
  writeRecord(paths, { version: 1, status: 'complete', adopted: false, reason: 'NO_PRIOR_INSTALL', at: '2026-08-11T12:11:04.287Z' })

  const result = adopt(paths)

  assert.equal(result.adopted, true, 'the previous install was right there and was left stranded')
  const prefs = JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8'))
  assert.equal(prefs.values['mc.theme'], 'black')
})

test('a stranded person who has since been using the new install still gets what it does not already have', () => {
  /* The realistic shape of the measured case: the wrong verdict was months ago
     and they have used the product since, so the "already in use" shortcut is
     the very thing keeping them stranded. Their own data still wins file by
     file -- the copy never overwrites. */
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy, { theme: 'black' })
  writeRecord(paths, { version: 1, status: 'complete', adopted: false, reason: 'NO_PRIOR_INSTALL', at: '2026-08-11T12:11:04.287Z' })
  fs.writeFileSync(path.join(paths.current, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1, values: { 'mc.theme': 'white' }, drainedOrigins: [],
  }))

  const result = adopt(paths)

  assert.equal(result.adopted, true)
  const prefs = JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8'))
  assert.equal(prefs.values['mc.theme'], 'white', 'the settings they are using now were overwritten by an older copy')
  assert.equal(
    fs.readFileSync(path.join(paths.current, 'workspace', 'notes.md'), 'utf8'), '# the persons work\n',
    'the work only the old install had was still not carried across',
  )
})

test('an evidenced verdict is honoured while its evidence still holds', () => {
  const paths = makeAppData()
  /* A legacy directory that exists and holds nothing worth keeping -- what a
     first launch of the old build leaves behind. */
  fs.mkdirSync(path.join(paths.legacy, 'workspace'), { recursive: true })

  const first = adopt(paths)
  assert.equal(first.reason, 'NO_PRIOR_INSTALL')
  const record = JSON.parse(fs.readFileSync(path.join(paths.current, RECORD_FILE), 'utf8'))
  assert.deepEqual(
    record.searched, [{ directory: paths.legacy, holdsProductState: false }],
    'the verdict has to name what it examined or the next build cannot tell it from an unchecked one',
  )

  const second = adopt(paths)

  assert.equal(second.reason, 'ALREADY_DECIDED', 'nothing changed on disk, so the question was already answered')
})

test('a legacy directory that gains real data after the verdict is adopted after all', () => {
  const paths = makeAppData()
  fs.mkdirSync(path.join(paths.legacy, 'workspace'), { recursive: true })
  assert.equal(adopt(paths).reason, 'NO_PRIOR_INSTALL')

  /* The person ran the OLD build once more -- restored a backup, finished a
     migration, plugged the drive back in. The world changed after the verdict. */
  seedLegacyInstall(paths.legacy, { theme: 'black' })
  const result = adopt(paths)

  assert.equal(result.adopted, true)
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8')).values['mc.theme'],
    'black',
  )
})

test('an unusable evidence list never counts as evidence', () => {
  /* THE HOUSE DEFECT, ENUMERATED. Each of these is an absence -- no list, an
     empty list, a list of the wrong shape, an entry that states nothing about
     the directory it names -- and not one of them is a finding that the prior
     install was absent. */
  for (const searched of [undefined, [], 'nope', {}, [null], [{ holdsProductState: false }], [{ directory: 'Z:\\gone', holdsProductState: false }], [{ directory: null, holdsProductState: false }]]) {
    const paths = makeAppData()
    seedLegacyInstall(paths.legacy, { theme: 'black' })
    writeRecord(paths, { version: 2, status: 'complete', adopted: false, reason: 'NO_PRIOR_INSTALL', searched, at: '2026-08-11T12:11:04.287Z' })

    const result = adopt(paths)

    assert.equal(result.adopted, true, `searched=${JSON.stringify(searched)} was read as a negative finding`)
  }
})

test('an entry that names the directory but says nothing about it is not a negative finding', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy, { theme: 'black' })
  writeRecord(paths, {
    version: 2, status: 'complete', adopted: false, reason: 'NO_PRIOR_INSTALL',
    /* The field is missing, not false. A missing boolean is not `false`. */
    searched: [{ directory: paths.legacy }],
    at: '2026-08-11T12:11:04.287Z',
  })

  assert.equal(adopt(paths).adopted, true)
})

test('the verdicts that observed something are still permanent', () => {
  /* Reopening is for the one verdict that reports an absence. A record saying
     somebody was already using this install observed a fact, and re-litigating
     it is how a deliberate deletion comes back from the dead. */
  for (const record of [
    { version: 2, status: 'complete', adopted: false, reason: 'TARGET_ALREADY_IN_USE', at: '2026-08-11T00:00:00.000Z' },
    { version: 2, status: 'complete', adopted: true, reason: 'ADOPTED', from: 'somewhere', entries: [], at: '2026-08-11T00:00:00.000Z' },
    /* A verdict of a shape this build does not know is still a decision. */
    { version: 3, status: 'complete', adopted: false, reason: 'SOMETHING_LATER_ADDED', at: '2026-08-11T00:00:00.000Z' },
  ]) {
    const paths = makeAppData()
    seedLegacyInstall(paths.legacy, { theme: 'black' })
    writeRecord(paths, record)

    const result = adopt(paths)

    assert.equal(result.reason, 'ALREADY_DECIDED', `${record.reason} was reopened`)
    assert.equal(fs.existsSync(path.join(paths.current, 'renderer-prefs.json')), false)
  }
})

test('a directory is never adopted into itself', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)

  const result = adoptLegacyUserData({
    userDataPath: paths.legacy,
    searchRoot: paths.root,
    fs,
    path,
    legacyNames: ['Mission Control'],
  })

  assert.equal(result.adopted, false)
  assert.equal(result.reason, 'TARGET_ALREADY_IN_USE')
})

test('distinct POSIX directories whose names differ only by case are adopted', { skip: path.sep === '\\' && 'requires a case-sensitive filesystem; on this one two directories differing only by case cannot both exist, so the case has no subject. Named in RELEASE_SKIP_REGISTER (class: platform).' }, () => {
  const paths = makeAppData()
  paths.legacy = path.join(paths.root, 'toolsenabled')
  seedLegacyInstall(paths.legacy, { theme: 'black' })

  const result = adoptLegacyUserData({
    userDataPath: paths.current,
    searchRoot: paths.root,
    fs,
    path,
    canDecrypt: () => true,
    legacyNames: ['toolsenabled'],
  })

  assert.equal(result.adopted, true, 'a distinct case-sensitive predecessor was mistaken for the target itself')
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8')).values['mc.theme'],
    'black',
  )
})

test('a crash mid-copy resumes from the same install rather than stalling', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy)
  fs.mkdirSync(paths.current, { recursive: true })
  /* Exactly what the module leaves behind when it dies between writing the
     record and finishing the copy. */
  fs.writeFileSync(path.join(paths.current, RECORD_FILE), JSON.stringify({
    version: 1, status: 'in-progress', from: paths.legacy, at: '2026-08-11T00:00:00.000Z',
  }))
  fs.writeFileSync(path.join(paths.current, 'shell-state.json'), '{"bounds":{"width":1440}}')

  const result = adopt(paths)

  assert.equal(result.adopted, true)
  assert.equal(
    fs.existsSync(path.join(paths.current, 'renderer-prefs.json')), true,
    'the half-copied install was abandoned instead of finished',
  )
  const record = JSON.parse(fs.readFileSync(path.join(paths.current, RECORD_FILE), 'utf8'))
  assert.equal(record.status, 'complete')
})

test('an existing file is never replaced by the one being adopted', () => {
  const paths = makeAppData()
  seedLegacyInstall(paths.legacy, { theme: 'black' })
  fs.mkdirSync(paths.current, { recursive: true })
  fs.writeFileSync(path.join(paths.current, RECORD_FILE), JSON.stringify({
    version: 1, status: 'in-progress', from: paths.legacy, at: '2026-08-11T00:00:00.000Z',
  }))
  fs.writeFileSync(path.join(paths.current, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1, values: { 'mc.theme': 'tan' }, drainedOrigins: [],
  }))

  adopt(paths)

  const prefs = JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8'))
  assert.equal(prefs.values['mc.theme'], 'tan')
})

/* ==================================================================
   THE ADOPTED KEY THAT COULD NOT BE OPENED, AND THE START CONTROL IT
   PERMANENTLY DISABLED.

   MEASURED on the build machine, against the owner's two real directories,
   before any of this was written:

     %APPDATA%\Mission Control\agent-spawn-key.enc  -> first bytes "v10"
     %APPDATA%\ToolsEnabled\agent-spawn-key.enc     -> first bytes "v10"

   "v10" is Chromium OSCrypt: AES-256-GCM under a per-PROFILE key kept in
   <userData>\Local State, not under the OS user. The two profiles' keys differ,
   and the cross-decrypt matrix was total -- each blob opened under its own
   profile's key and failed to authenticate under the other's. This module
   carried the ciphertext across the rename and left the key behind, so
   shell/spawn-record.cjs found a key file it could not decrypt, raised
   SPAWN_RECORD_KEY_UNREADABLE, and -- correctly, for a key that belongs to the
   install -- refused to regenerate. Start was disabled on every launch at every
   tier, and the product's only explanation was that a key could not be opened.

   THESE TESTS ASSERT THE CONSEQUENCE, NOT THE COPY LIST. The thing that was
   broken was the Start control, so what is checked here is the REAL recorder's
   own availability() answer against the REAL adopted directory. A test that only
   counted copied files would have gone green throughout the outage.
   ================================================================== */

const { createSpawnRecorder } = require('../../shell/spawn-record.cjs')
const { createUsageRecorder, turnUsageFrom } = require('../../shell/usage-record.cjs')
const {
  KEYSTORE_SEALED_ENTRY,
  ENTRIES_BOUND_TO_SEALED_KEY,
  SEALED_KEY_NOT_ADOPTED,
  SEALED_KEY_VERDICTS,
} = require('../../shell/userdata-adoption.cjs')

/* A keystore that behaves the way the real one was MEASURED to behave: bound to
   a profile, not to the user. Blobs carry the profile that sealed them and
   decryptString THROWS -- it does not return false -- when asked to open one
   from a different profile, which is the actual production failure. */
function profileBoundKeystore(profile) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from('v10:' + profile + ':' + text, 'utf8'),
    decryptString: (buffer) => {
      const raw = Buffer.from(buffer).toString('utf8')
      const prefix = 'v10:' + profile + ':'
      if (!raw.startsWith(prefix)) {
        const error = new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
        error.code = 'ERR_CRYPTO_AUTH'
        throw error
      }
      return raw.slice(prefix.length)
    },
  }
}

/* The legacy install as it really is: a spawn key and a ledger written by the
   OLD profile's keystore, so the new profile genuinely cannot open them. */
function seedLegacyWithRealSignedHistory(legacy, profile = 'mission-control') {
  seedLegacyInstall(legacy)
  /* seedLegacyInstall writes placeholder bytes for both. Clear them so the REAL
     recorder below produces a genuinely sealed key and a genuinely signed,
     hash-chained ledger -- the thing whose portability is under test. */
  fs.rmSync(path.join(legacy, 'agent-spawn-key.enc'), { force: true })
  fs.rmSync(path.join(legacy, 'agent-spawn-records.jsonl'), { force: true })
  fs.rmSync(path.join(legacy, 'agent-turn-usage-records.jsonl'), { force: true })
  const old = profileBoundKeystore(profile)
  const recorder = createSpawnRecorder({ safeStorage: old, directory: legacy })
  recorder.record({ action: 'agent_session_start', sessionId: 'legacy-1', details: {} })
  assert.equal(recorder.verify().ok, true, 'the seeded legacy history must verify under its own key')
  /* THE SECOND CHAIN, SEALED BY THE SAME KEY. What each turn cost is kept in its
     own file beside the run record (shell/usage-record.cjs) and signed with the
     same key, so it is bound to that key in exactly the way the runs are -- and
     the tests below sweep ENTRIES_BOUND_TO_SEALED_KEY rather than a hand-written
     pair, so a legacy install that did not have one would be a fixture claiming
     the product keeps less than it does. */
  const usage = createUsageRecorder({ safeStorage: old, directory: legacy })
  usage.recordTurn({
    sessionId: 'legacy-1',
    turnId: 'legacy-turn-1',
    usage: turnUsageFrom({ last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
  })
  assert.equal(usage.verify().ok, true, 'the seeded legacy usage record must verify under its own key')
}

/* What the product asks before it offers a Start control. */
function startIsOffered(userDataPath, keystore) {
  return createSpawnRecorder({ safeStorage: keystore, directory: userDataPath }).availability()
}

test('a signing key this install cannot open is left behind, and Start still works', () => {
  const paths = makeAppData()
  seedLegacyWithRealSignedHistory(paths.legacy)
  const here = profileBoundKeystore('toolsenabled')

  const result = adopt(paths, { canDecrypt: (bytes) => { here.decryptString(bytes); return true } })

  assert.equal(result.adopted, true, 'everything else must still be carried across')
  assert.equal(
    fs.existsSync(path.join(paths.current, KEYSTORE_SEALED_ENTRY)), false,
    'the undecryptable key was adopted -- this is the defect that disabled Start permanently',
  )
  for (const bound of ENTRIES_BOUND_TO_SEALED_KEY) {
    assert.equal(
      fs.existsSync(path.join(paths.current, bound)), false,
      bound + ' was carried without the key that signs it; a fresh key would sign onto a chain whose own signatures no longer check out',
    )
  }
  /* The settings the person actually chose still travel. A fix that protected
     Start by abandoning the carry-over would pass the two assertions above. */
  const prefs = JSON.parse(fs.readFileSync(path.join(paths.current, 'renderer-prefs.json'), 'utf8'))
  assert.equal(prefs.values['mc.theme'], 'black', 'the rest of the carry-over was thrown away with the key')
  assert.equal(fs.existsSync(path.join(paths.current, 'workspace', 'notes.md')), true)

  /* THE POINT. */
  const offered = startIsOffered(paths.current, here)
  assert.equal(
    offered.ok, true,
    'Start is still disabled after the fix (' + offered.code + ') -- a person upgrading cannot run an agent at all',
  )
  assert.equal(
    fs.existsSync(path.join(paths.current, KEYSTORE_SEALED_ENTRY)), true,
    'availability() should have minted a fresh key in the new profile',
  )
  assert.equal(startIsOffered(paths.current, here).ok, true, 'and it must keep working on the next launch')
})

test('the refusal is written down with the path, so the old history is findable', () => {
  const paths = makeAppData()
  seedLegacyWithRealSignedHistory(paths.legacy)

  const result = adopt(paths, { canDecrypt: () => false })

  const note = (result.notes || []).find((entry) => entry.code === SEALED_KEY_NOT_ADOPTED)
  assert.ok(note, 'a key was silently dropped with nothing recorded about it')
  assert.equal(note.verdict, SEALED_KEY_VERDICTS.REFUSED)
  assert.deepEqual(
    [...note.entries].sort(),
    [KEYSTORE_SEALED_ENTRY, ...ENTRIES_BOUND_TO_SEALED_KEY].sort(),
    'the note must name everything it left behind',
  )
  assert.equal(note.from, paths.legacy, 'a note that does not say WHERE the data is is not a note')

  const record = JSON.parse(fs.readFileSync(path.join(paths.current, RECORD_FILE), 'utf8'))
  const durable = (record.notes || []).find((entry) => entry.code === SEALED_KEY_NOT_ADOPTED)
  assert.ok(durable, 'the note did not survive into the record on disk, which is what support reads')
  assert.equal(durable.from, paths.legacy)

  /* Nothing was destroyed to achieve any of this. */
  assert.equal(fs.existsSync(path.join(paths.legacy, KEYSTORE_SEALED_ENTRY)), true, 'the source key was removed')
  for (const bound of ENTRIES_BOUND_TO_SEALED_KEY) {
    assert.equal(fs.existsSync(path.join(paths.legacy, bound)), true, 'the source ' + bound + ' was removed')
  }
})

test('a keystore that throws is refused, not treated as a pass', () => {
  /* The production shape: safeStorage raises on a blob that does not
     authenticate. A try/catch that swallowed the throw to `true` would restore
     the whole defect. */
  const paths = makeAppData()
  seedLegacyWithRealSignedHistory(paths.legacy)
  const here = profileBoundKeystore('toolsenabled')

  const result = adopt(paths, { canDecrypt: (bytes) => { here.decryptString(bytes); return true } })

  const note = (result.notes || []).find((entry) => entry.code === SEALED_KEY_NOT_ADOPTED)
  assert.ok(note, 'a throwing keystore let the key through')
  assert.equal(note.verdict, SEALED_KEY_VERDICTS.REFUSED)
})

test('ABSENCE: with no decryptability check wired at all, the sealed key is refused', () => {
  /* THE HOUSE DEFECT, TESTED BEFORE THE PRESENT CASE. Nine times in this
     codebase a missing field, an empty string or a falsy default has been read
     as permission. A caller that never passes canDecrypt has stated NOTHING
     about whether this install can open the key, and "nothing" must not mean
     "carry it". Adopting on silence is exactly how the key that disabled Start
     got there. */
  const paths = makeAppData()
  seedLegacyWithRealSignedHistory(paths.legacy)

  const result = adoptLegacyUserData({
    userDataPath: paths.current,
    searchRoot: paths.root,
    fs,
    path,
    legacyNames: ['Mission Control'],
    /* canDecrypt deliberately absent */
  })

  assert.equal(
    fs.existsSync(path.join(paths.current, KEYSTORE_SEALED_ENTRY)), false,
    'silence was read as permission to adopt an unverified key',
  )
  const note = (result.notes || []).find((entry) => entry.code === SEALED_KEY_NOT_ADOPTED)
  assert.ok(note, 'nothing was recorded about the key that was skipped')
  assert.equal(
    note.verdict, SEALED_KEY_VERDICTS.NOT_CHECKABLE,
    'an unwired validator must be distinguishable from a keystore that said no',
  )
  assert.equal(startIsOffered(paths.current, profileBoundKeystore('toolsenabled')).ok, true)
})

test('a validator that answers anything other than true is refused', () => {
  /* `undefined` from a validator that forgot to return, and a truthy string,
     are both silence wearing a costume. */
  for (const answer of [undefined, null, 'yes', 1, {}]) {
    const paths = makeAppData()
    seedLegacyWithRealSignedHistory(paths.legacy)

    adopt(paths, { canDecrypt: () => answer })

    assert.equal(
      fs.existsSync(path.join(paths.current, KEYSTORE_SEALED_ENTRY)), false,
      'a validator answering ' + String(answer) + ' was treated as proof the key opens',
    )
  }
})

test('a ledger whose key is missing from the old install is not adopted on its own', () => {
  /* Records signed by a key that does not exist anywhere. Carrying them would
     mint a fresh key, sign new records onto the same chain, and make the product
     report its own history as broken on the home screen. */
  const paths = makeAppData()
  seedLegacyWithRealSignedHistory(paths.legacy)
  fs.rmSync(path.join(paths.legacy, KEYSTORE_SEALED_ENTRY))

  const result = adopt(paths, { canDecrypt: () => true })

  for (const bound of ENTRIES_BOUND_TO_SEALED_KEY) {
    assert.equal(
      fs.existsSync(path.join(paths.current, bound)), false,
      bound + ' was adopted with no key in existence to check its signatures',
    )
  }
  const note = (result.notes || []).find((entry) => entry.code === SEALED_KEY_NOT_ADOPTED)
  assert.ok(note, 'the orphaned ledger was dropped with nothing recorded')
  assert.equal(note.verdict, SEALED_KEY_VERDICTS.NOT_PRESENT)
  assert.deepEqual(note.entries, [...ENTRIES_BOUND_TO_SEALED_KEY], 'the note named a key that was never there')
})

test('a key this install CAN open is still carried across with its ledger', () => {
  /* The other half. A fix that simply stopped adopting the key would pass every
     refusal test above; this is the one it would fail. Same keystore profile on
     both sides -- the case that arises on any move where the profile key travels
     (a restore, or a platform whose keystore really is user-scoped). */
  const paths = makeAppData()
  seedLegacyWithRealSignedHistory(paths.legacy, 'same-profile')
  const shared = profileBoundKeystore('same-profile')

  const result = adopt(paths, { canDecrypt: (bytes) => { shared.decryptString(bytes); return true } })

  assert.equal(fs.existsSync(path.join(paths.current, KEYSTORE_SEALED_ENTRY)), true, 'a usable key was left behind')
  for (const bound of ENTRIES_BOUND_TO_SEALED_KEY) {
    assert.equal(fs.existsSync(path.join(paths.current, bound)), true, bound + ' was separated from a key that opens it')
  }
  assert.equal((result.notes || []).length, 0, 'a successful adoption must not record a refusal')

  const carried = createSpawnRecorder({ safeStorage: shared, directory: paths.current })
  assert.equal(carried.availability().ok, true)
  assert.equal(carried.verify().ok, true, 'the carried history no longer verifies under its own key')
  assert.equal(carried.history().total, 1, 'the person lost their previous session record')
})
