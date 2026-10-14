/* THE UPDATE CHECK, HELD STILL WITHOUT ELECTRON OR A SOCKET.
 *
 * shell/update-check.cjs takes every dependency as an argument, so this suite
 * hands it a fake dialog, a fake manifest fetcher, a fake downloader, a fake
 * runAfterQuit and an in-memory prefs store, and reads back what it decided. The
 * wire layer is tested separately against a fake `https` whose responses
 * are event emitters, so the pins -- https only, one host, no redirect, ten
 * seconds, 64 KB -- are asserted rather than trusted.
 *
 * Run: node --test tools/test/update-check.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import updateCheck from '../../shell/update-check.cjs'
import peIdentity from '../../shell/installer-pe-identity.cjs'

const {
  CHECK_BUTTONS,
  CHECK_DETAIL,
  CHECK_INTERVAL_MS,
  CHECKED_TITLE,
  COULD_NOT_CHECK_MESSAGE,
  COULD_NOT_TELL_CODE,
  COULD_NOT_TELL_SENTENCE,
  DOWNLOAD_SUBDIRECTORY,
  ELEVATED_ANNOUNCED_KEY,
  ELEVATED_DETAIL,
  ELEVATED_TITLE,
  LAST_CHECKED_KEY,
  MANIFEST_URL,
  MISMATCH_SENTENCE,
  POLICY_KEY,
  REMEMBER_LABEL,
  UNSIGNED_SENTENCE,
  UPDATE_BUTTONS,
  UPDATE_DETAIL,
  INSTALLER_ARGUMENTS,
  createInstallerAfterQuit,
  createInstallerDownloader,
  createManifestFetcher,
  createUpdateCheck,
  decidePolicy,
  dueForCheck,
  elevatedMessage,
  installerUrl,
  isNewer,
  manifestIsSane,
  pinnedUrl,
} = updateCheck

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0)
const CURRENT = '1.0.27'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

const INSTALLER_BYTES = Buffer.from('this stands in for a 100 MB installer', 'utf8')

/* What the signing step's read-back reported for the 1.0.50 installer. */
const SIGNED_BY_US = Object.freeze({
  status: 'Valid', signer: 'ToolsEnabled, Inc.', issuer: 'Microsoft ID Verified CS AOC CA 03', timestamped: true,
})

function goodManifest(overrides = {}) {
  const version = overrides.version ?? '1.0.28'
  return {
    filename: 'ToolsEnabled-Setup-1.0.28.exe',
    version,
    bytes: INSTALLER_BYTES.length,
    sha256: sha256(INSTALLER_BYTES),
    productName: 'ToolsEnabled',
    fileVersion: version,
    productVersion: version,
    buildRef: 'abc',
    immutableLocation: '\x43:\\lanes\\releases\\1.0.28',
    ...overrides,
  }
}

/* An in-memory renderer-prefs: the two verbs the module uses, the same
   shapes the real store answers with. */
function memoryPrefs(initial = {}, { damaged = null, throwOnRead = false } = {}) {
  const values = { ...initial }
  const writes = []
  return {
    values,
    writes,
    snapshot() {
      if (throwOnRead) throw new Error('EBUSY')
      return { ok: true, values: { ...values }, drainedOrigins: [], damaged, preservedAt: null }
    },
    set(key, value) {
      writes.push([key, value])
      values[key] = value
      return { ok: true }
    },
  }
}

function tempDirectory() {
  const directory = path.join(os.tmpdir(), `update-check-${randomUUID()}`)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

/* A real PowerShell, where one is installed (it is on the Linux build host),
   for the U3 and U7 rows that run the actual scripts. */
const PWSH = (() => {
  for (const candidate of ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh']) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
})()

/* The rig: every dependency scripted, every call recorded. `answers` is the
   list of dialog answers in the order dialogs appear. */
function rig({
  prefs = memoryPrefs(),
  answers = [],
  manifest = goodManifest(),
  fetched = null,
  installerBytes = INSTALLER_BYTES,
  installerIdentity = null,
  installerSignature = SIGNED_BY_US,
  downloadResult = null,
  running = 0,
  currentVersion = CURRENT,
  directory = tempDirectory(),
  platform = 'win32',
  setupActive = () => false,
  elevated,
  schedule,
} = {}) {
  const dialogs = []
  const logs = []
  const spawned = []
  const signatureReads = []
  let quits = 0
  let fetches = 0
  let downloads = 0
  const controller = createUpdateCheck({
    platform,
    setupActive,
    fetchManifest: async (url) => {
      fetches += 1
      assert.equal(url, MANIFEST_URL)
      return fetched || { ok: true, manifest }
    },
    download: async ({ url, destination, maxBytes }) => {
      downloads += 1
      if (downloadResult) return downloadResult
      assert.equal(url, installerUrl(manifest.filename))
      assert.equal(maxBytes, manifest.bytes)
      fs.writeFileSync(destination, installerBytes)
      return { ok: true, bytes: installerBytes.length }
    },
    inspectInstaller: async () => installerIdentity || {
      productName: manifest.productName,
      fileVersion: manifest.fileVersion,
      productVersion: manifest.productVersion,
    },
    inspectSignature: async (file) => {
      signatureReads.push({ file, present: fs.existsSync(file) })
      if (installerSignature instanceof Error) throw installerSignature
      return installerSignature
    },
    fs,
    prefs,
    currentVersion,
    showMessageBox: async (options) => {
      dialogs.push(options)
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      return answer || { response: 1, checkboxChecked: false }
    },
    /* What the shell's runAfterQuit does, recorded: arm the file, then quit.
       Nothing is started here; createInstallerAfterQuit below is what starts
       it, on the app's quit event (U1). */
    runAfterQuit: (file) => {
      spawned.push({ file, present: fs.existsSync(file) })
      quits += 1
    },
    runningAgentCount: () => (typeof running === 'function' ? running() : running),
    closeWarning: (count) => ({ message: `Closing this window ends ${count} agents that are still running.`, detail: 'Their work stops where it is.' }),
    downloadDirectory: directory,
    ...(elevated ? { elevated } : {}),
    now: () => NOW,
    log: (line) => logs.push(line),
    setTimeout: schedule || ((fn) => { fn(); return 0 }),
    launchDelayMs: 0,
  })
  return {
    controller,
    prefs,
    dialogs,
    logs,
    spawned,
    signatureReads,
    directory,
    get quits() { return quits },
    get fetches() { return fetches },
    get downloads() { return downloads },
    installerPath: path.join(directory, DOWNLOAD_SUBDIRECTORY, manifest.filename),
  }
}

/* ---------- the decisions ---------- */

test('decidePolicy: one checkbox, two remembered answers, and unticked remembers nothing', () => {
  assert.deepEqual(decidePolicy({ response: 0, checkboxChecked: true }), { policy: 'always', check: true })
  assert.deepEqual(decidePolicy({ response: 1, checkboxChecked: true }), { policy: 'never', check: false })
  assert.deepEqual(decidePolicy({ response: 0, checkboxChecked: false }), { policy: 'ask', check: true })
  assert.deepEqual(decidePolicy({ response: 1, checkboxChecked: false }), { policy: 'ask', check: false })
  /* A dialog that answered nothing useful is "not now, remember nothing". */
  assert.deepEqual(decidePolicy(undefined), { policy: 'ask', check: false })
  assert.deepEqual(decidePolicy({ response: 'yes', checkboxChecked: true }), { policy: 'never', check: false })
})

test('isNewer: newer only, three numbers only', () => {
  assert.equal(isNewer('1.0.28', '1.0.27'), true)
  assert.equal(isNewer('1.1.0', '1.0.27'), true)
  assert.equal(isNewer('2.0.0', '1.9.9'), true)
  assert.equal(isNewer('1.0.27', '1.0.27'), false)
  assert.equal(isNewer('1.0.26', '1.0.27'), false)
  assert.equal(isNewer('1.0.10', '1.0.9'), true, 'numeric, not lexical')
  assert.equal(isNewer('1.0.28-beta', '1.0.27'), false)
  assert.equal(isNewer('latest', '1.0.27'), false)
  assert.equal(isNewer('1.0.28', 'dev'), false)
  assert.equal(isNewer(undefined, '1.0.27'), false)
})

test('manifestIsSane requires hashes plus an internally consistent PE identity', () => {
  assert.equal(manifestIsSane(goodManifest()), true)
  assert.equal(
    manifestIsSane(goodManifest({ filename: 'ToolsEnabled Setup 1.0.28.exe' })),
    true,
    'the cutter emits electron-builder\'s spaced installer filename',
  )
  assert.equal(manifestIsSane(goodManifest({ immutableLocation: undefined, buildRef: undefined })), true)
  assert.equal(manifestIsSane(null), false)
  assert.equal(manifestIsSane([]), false)
  assert.equal(manifestIsSane(goodManifest({ version: '1.0' })), false)
  assert.equal(manifestIsSane(goodManifest({ filename: '../ToolsEnabled.exe' })), false)
  assert.equal(manifestIsSane(goodManifest({ filename: 'sub/ToolsEnabled.exe' })), false)
  assert.equal(manifestIsSane(goodManifest({ filename: 'ToolsEnabled.msi' })), false)
  assert.equal(manifestIsSane(goodManifest({ bytes: 0 })), false)
  assert.equal(manifestIsSane(goodManifest({ bytes: '102553067' })), false)
  assert.equal(manifestIsSane(goodManifest({ bytes: 1.5 })), false)
  assert.equal(manifestIsSane(goodManifest({ sha256: 'abc' })), false)
  assert.equal(manifestIsSane(goodManifest({ sha256: undefined })), false)
  assert.equal(manifestIsSane(goodManifest({ productName: '' })), false)
  assert.equal(manifestIsSane(goodManifest({ fileVersion: undefined })), false)
  assert.equal(manifestIsSane(goodManifest({ productVersion: '1.0.32' })), false)
  assert.equal(manifestIsSane(goodManifest({ fileVersion: '1.0.28.0', productVersion: '1.0.28.0' })), true)
})

test('dueForCheck: absent, unreadable and future stamps are due; a fresh one is not', () => {
  assert.equal(dueForCheck(null, NOW), true)
  assert.equal(dueForCheck('', NOW), true)
  assert.equal(dueForCheck('yesterday', NOW), true)
  assert.equal(dueForCheck(new Date(NOW - 1000).toISOString(), NOW), false)
  assert.equal(dueForCheck(new Date(NOW - CHECK_INTERVAL_MS + 1).toISOString(), NOW), false)
  assert.equal(dueForCheck(new Date(NOW - CHECK_INTERVAL_MS).toISOString(), NOW), true)
  assert.equal(dueForCheck(new Date(NOW + 60_000).toISOString(), NOW), true, 'a stamp from the future is not a record of a check')
})

test('the pins: https only, one host, no credentials, and the installer address is built from the declaration', () => {
  assert.equal(pinnedUrl('https://toolsenabled.ai/download/download.json').ok, true)
  assert.deepEqual(pinnedUrl('http://toolsenabled.ai/download/download.json'), { ok: false, reason: 'not https' })
  assert.deepEqual(pinnedUrl('https://toolsenabled.com/download/download.json'), { ok: false, reason: 'wrong host' })
  assert.deepEqual(pinnedUrl('https://www.toolsenabled.ai/download/download.json'), { ok: false, reason: 'wrong host' })
  assert.deepEqual(pinnedUrl('https://toolsenabled.ai.evil.example/x'), { ok: false, reason: 'wrong host' })
  assert.deepEqual(pinnedUrl('https://user:person-ab42c258@example.com/x'), { ok: false, reason: 'credentials in address' })
  assert.deepEqual(pinnedUrl('not a url'), { ok: false, reason: 'not an address' })
  assert.equal(installerUrl('ToolsEnabled-Setup-1.0.28.exe'), 'https://toolsenabled.ai/download/ToolsEnabled-Setup-1.0.28.exe')
  assert.equal(installerUrl('ToolsEnabled Setup 1.0.28.exe'), 'https://toolsenabled.ai/download/ToolsEnabled%20Setup%201.0.28.exe')
  assert.equal(MANIFEST_URL, 'https://toolsenabled.ai/download/download.json')
})

/* ---------- the factory refuses to be built half-way ---------- */

test('the factory rejects every missing required dependency', () => {
  const full = {
    fetchManifest: async () => ({ ok: false, reason: 'x' }),
    download: async () => ({ ok: false, reason: 'x' }),
    inspectInstaller: async () => ({ productName: 'x', fileVersion: '1.0.0', productVersion: '1.0.0' }),
    fs,
    prefs: memoryPrefs(),
    currentVersion: CURRENT,
    showMessageBox: async () => ({ response: 1 }),
    runAfterQuit: () => {},
    runningAgentCount: () => 0,
    closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: '\x43:\\somewhere',
  }
  assert.doesNotThrow(() => createUpdateCheck(full))
  for (const name of Object.keys(full)) {
    const without = { ...full }
    delete without[name]
    assert.throws(
      () => createUpdateCheck(without),
      { name: 'TypeError' },
      `missing ${name} must prevent construction`,
    )
  }
})

/* ---------- the launch question ---------- */

test('Linux and macOS never fetch or offer the Windows installer', async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const policy of ['ask', 'always', 'never']) {
      const r = rig({ platform, prefs: memoryPrefs({ [POLICY_KEY]: policy }) })
      assert.equal((await r.controller.runAtLaunch()).reason, 'platform unsupported')
      assert.equal((await r.controller.check()).reason, 'platform unsupported')
      r.controller.scheduleAtLaunch()
      assert.equal(r.dialogs.length, 0)
      assert.equal(r.fetches, 0)
      assert.equal(r.downloads, 0)
      assert.equal(r.spawned.length, 0)
    }
  }
})

test('the update question waits for setup to finish and is scheduled only once', async () => {
  let inSetup = true
  const queued = []
  const r = rig({ setupActive: () => inSetup, schedule: fn => { queued.push(fn) } })
  r.controller.scheduleAtLaunch()
  r.controller.scheduleAtLaunch()
  assert.equal(queued.length, 1)
  queued[0]()
  assert.equal(r.dialogs.length, 0)
  assert.equal(r.fetches, 0)
  inSetup = false
  r.controller.scheduleAtLaunch()
  assert.equal(queued.length, 2)
  queued[1]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.dialogs.length, 1)
  r.controller.scheduleAtLaunch()
  assert.equal(queued.length, 2)
  assert.equal(r.fetches, 0, 'dismissing the delayed question grants no network permission')
})

test('ask: the first dialog is about checking, with two buttons and the one checkbox', async () => {
  const r = rig({ answers: [{ response: 1, checkboxChecked: false }] })
  const result = await r.controller.runAtLaunch()
  assert.equal(r.dialogs.length, 1)
  const dialog = r.dialogs[0]
  assert.deepEqual(dialog.buttons, [...CHECK_BUTTONS])
  assert.equal(dialog.checkboxLabel, REMEMBER_LABEL)
  assert.equal(dialog.noLink, true)
  assert.match(dialog.message, /Check for updates\?/)
  assert.equal(result.action, 'declined-check')
  assert.equal(r.fetches, 0, 'Not now makes no request')
  assert.deepEqual(r.prefs.writes, [], 'an unticked box writes nothing')
})

test('ask: Check now with the box unticked checks once and remembers nothing', async () => {
  const r = rig({ answers: [{ response: 0, checkboxChecked: false }, { response: 1 }] })
  const result = await r.controller.runAtLaunch()
  assert.equal(r.fetches, 1)
  assert.equal(result.action, 'declined-update')
  assert.equal(result.policy, 'ask')
  assert.equal(r.prefs.values[POLICY_KEY], undefined)
  assert.equal(typeof r.prefs.values[LAST_CHECKED_KEY], 'string')
})

test('ask: ticked + Check now becomes always; ticked + Not now becomes never', async () => {
  const always = rig({ answers: [{ response: 0, checkboxChecked: true }, { response: 1 }] })
  await always.controller.runAtLaunch()
  assert.equal(always.prefs.values[POLICY_KEY], 'always')
  assert.equal(always.fetches, 1)

  const never = rig({ answers: [{ response: 1, checkboxChecked: true }] })
  const result = await never.controller.runAtLaunch()
  assert.equal(never.prefs.values[POLICY_KEY], 'never')
  assert.equal(never.fetches, 0)
  assert.equal(result.action, 'declined-check')
})

test('never: no dialog, no network call, one log line', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'never' }) })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'not-checked')
  assert.equal(r.dialogs.length, 0)
  assert.equal(r.fetches, 0)
  assert.equal(r.downloads, 0)
  assert.equal(r.logs.length, 1)
  assert.deepEqual(r.prefs.writes, [])
})

test('always: the check runs silently, and only the install question appears', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 1 }] })
  const result = await r.controller.runAtLaunch()
  assert.equal(r.fetches, 1)
  assert.equal(r.dialogs.length, 1)
  assert.deepEqual(r.dialogs[0].buttons, [...UPDATE_BUTTONS])
  assert.equal(r.dialogs[0].checkboxLabel, undefined, 'the install question has no checkbox')
  assert.match(r.dialogs[0].message, /ToolsEnabled 1\.0\.28 is available \(you have 1\.0\.27\)\. Download and install it now\?/)
  /* The dialog says what the app checks, and no longer hands the person a
     check this flow gives them no way to make (release-ops F4). */
  assert.equal(r.dialogs[0].detail, UPDATE_DETAIL)
  assert.match(r.dialogs[0].detail, /checks that the installer is signed by ToolsEnabled, Inc\./)
  assert.doesNotMatch(r.dialogs[0].detail, /Check that the publisher/,
    'no screen in this flow shows a publisher, so the person cannot be the one who checks it')
  assert.equal(result.action, 'declined-update')
})

test('always: could-not-tell is not cached, says it is not absence, while a completed comparison is cached', async () => {
  const fresh = memoryPrefs({ [POLICY_KEY]: 'always', [LAST_CHECKED_KEY]: new Date(NOW - 60_000).toISOString() })
  const notDue = rig({ prefs: fresh })
  const result = await notDue.controller.runAtLaunch()
  assert.equal(result.action, 'not-due')
  assert.equal(notDue.fetches, 0)
  assert.equal(notDue.dialogs.length, 0)

  const staleStamp = new Date(NOW - CHECK_INTERVAL_MS - 1).toISOString()
  const stale = memoryPrefs({ [POLICY_KEY]: 'always', [LAST_CHECKED_KEY]: staleStamp })
  const busy = rig({ prefs: stale, fetched: { ok: false, reason: 'network', errorCode: 'EBUSY' } })
  const failed = await busy.controller.runAtLaunch()
  assert.equal(failed.code, COULD_NOT_TELL_CODE)
  assert.equal(failed.errorCode, 'EBUSY')
  assert.equal(failed.sentence, COULD_NOT_TELL_SENTENCE)
  assert.match(failed.sentence, /does not claim that an update is absent/)
  await busy.controller.runAtLaunch()
  assert.equal(busy.fetches, 2, 'EBUSY remains due instead of being latched as not-due')
  assert.equal(stale.values[LAST_CHECKED_KEY], staleStamp)

  const completedPrefs = memoryPrefs({ [POLICY_KEY]: 'always', [LAST_CHECKED_KEY]: staleStamp })
  const completed = rig({ prefs: completedPrefs, manifest: goodManifest({ version: CURRENT }) })
  assert.equal((await completed.controller.runAtLaunch()).action, 'up-to-date')
  assert.equal(completedPrefs.values[LAST_CHECKED_KEY], new Date(NOW).toISOString())
  assert.equal((await completed.controller.runAtLaunch()).action, 'not-due')
  assert.equal(completed.fetches, 1, 'the successful comparison still pays for the 24-hour cache')
})

test('damaged or unreadable prefs: fail closed, nothing runs', async () => {
  const damaged = rig({ prefs: memoryPrefs({}, { damaged: 'the settings file contains malformed JSON' }) })
  const first = await damaged.controller.runAtLaunch()
  assert.equal(first.action, 'not-checked')
  assert.equal(damaged.dialogs.length, 0)
  assert.equal(damaged.fetches, 0)
  assert.equal(damaged.logs.length, 1)

  const throwing = rig({ prefs: memoryPrefs({}, { throwOnRead: true }) })
  const second = await throwing.controller.runAtLaunch()
  assert.equal(second.action, 'not-checked')
  assert.equal(throwing.dialogs.length, 0)
  assert.equal(throwing.fetches, 0)
})

test('an unknown stored policy reads as ask', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'sometimes' }), answers: [{ response: 1 }] })
  await r.controller.runAtLaunch()
  assert.equal(r.dialogs.length, 1)
  assert.deepEqual(r.dialogs[0].buttons, [...CHECK_BUTTONS])
})

/* ---------- a check that could not be made is silent ---------- */

for (const reason of ['bad json', 'not https', 'wrong host', 'redirect', 'timeout', 'oversize', 'network', 'status 404']) {
  test(`check failed (${reason}): no prompt, one log line, nothing downloaded`, async () => {
    const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), fetched: { ok: false, reason } })
    const result = await r.controller.runAtLaunch()
    assert.equal(result.action, 'check-failed')
    assert.equal(result.reason, reason)
    assert.equal(r.dialogs.length, 0)
    assert.equal(r.downloads, 0)
    assert.equal(r.logs.length, 1)
    assert.match(r.logs[0], new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
}

test('a fetcher that throws is a failed check, not a crash', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }) })
  const thrower = createUpdateCheck({
    platform: 'win32',
    fetchManifest: async () => { throw new Error('boom') },
    download: async () => ({ ok: false }),
    inspectInstaller: async () => { throw new Error('must not inspect') },
    fs,
    prefs: r.prefs,
    currentVersion: CURRENT,
    showMessageBox: async () => { throw new Error('must not be asked') },
    runAfterQuit: () => { throw new Error('must not install') },
    runningAgentCount: () => 0,
    closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: r.directory,
    now: () => NOW,
    log: (line) => r.logs.push(line),
  })
  const result = await thrower.runAtLaunch()
  assert.equal(result.action, 'check-failed')
})

test('an unusable manifest and a same-or-older version both end silently', async () => {
  const unusable = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), manifest: goodManifest({ version: 'latest' }) })
  assert.equal((await unusable.controller.runAtLaunch()).action, 'check-failed')
  assert.equal(unusable.dialogs.length, 0)

  const same = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), manifest: goodManifest({ version: CURRENT }) })
  const result = await same.controller.runAtLaunch()
  assert.equal(result.action, 'up-to-date')
  assert.equal(result.seen, CURRENT)
  assert.equal(same.dialogs.length, 0)
  assert.equal(same.logs.length, 1)
  assert.match(same.logs[0], /version seen 1\.0\.27/)

  const older = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), manifest: goodManifest({ version: '1.0.26' }) })
  assert.equal((await older.controller.runAtLaunch()).action, 'up-to-date')
  assert.equal(older.dialogs.length, 0)
})

/* ---------- installing ---------- */

test('Update now with no agents: download, hash, then hand the verified file to runAfterQuit', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }] })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'installing')
  assert.equal(r.downloads, 1)
  assert.deepEqual(r.spawned, [{ file: r.installerPath, present: true }], 'the verified installer is armed once, still on disk')
  assert.equal(r.quits, 1)
  assert.deepEqual(r.signatureReads, [{ file: r.installerPath, present: true }],
    'the downloaded installer itself is the file whose signature is read, before it runs')
  assert.ok(fs.existsSync(r.installerPath), 'the matched file is left for the installer to run')
  assert.ok(r.installerPath.startsWith(path.join(r.directory, DOWNLOAD_SUBDIRECTORY)), 'under userData, not temp')
})

test('a hash-matched download whose PE still says 1.0.32 is deleted and never launched', async () => {
  const r = rig({
    prefs: memoryPrefs({ [POLICY_KEY]: 'always' }),
    answers: [{ response: 0 }, { response: 0 }],
    installerIdentity: {
      productName: 'ToolsEnabled',
      fileVersion: '1.0.32',
      productVersion: '1.0.32',
    },
  })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'mismatch')
  assert.equal(result.reason, 'installer PE identity differs from manifest')
  assert.equal(r.spawned.length, 0)
  assert.equal(r.quits, 0)
  assert.equal(fs.existsSync(r.installerPath), false, 'the stale-but-hash-matched PE is deleted')
  assert.equal(r.dialogs[1].message, MISMATCH_SENTENCE)
})

test('a sha256 mismatch removes the file, says the sentence, and spawns nothing', async () => {
  const r = rig({
    prefs: memoryPrefs({ [POLICY_KEY]: 'always' }),
    answers: [{ response: 0 }, { response: 0 }],
    installerBytes: Buffer.from('not the bytes the site described'),
    manifest: goodManifest({ bytes: 'not the bytes the site described'.length }),
  })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'mismatch')
  assert.equal(r.spawned.length, 0)
  assert.equal(r.quits, 0)
  assert.equal(fs.existsSync(r.installerPath), false, 'the refused file is deleted')
  assert.equal(r.dialogs.length, 2)
  assert.equal(r.dialogs[1].message, MISMATCH_SENTENCE)
})

test('a byte-count mismatch is refused even when the hash matches', async () => {
  const r = rig({
    prefs: memoryPrefs({ [POLICY_KEY]: 'always' }),
    answers: [{ response: 0 }, { response: 0 }],
    manifest: goodManifest({ bytes: INSTALLER_BYTES.length + 1 }),
  })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'mismatch')
  assert.equal(r.spawned.length, 0)
  assert.equal(fs.existsSync(r.installerPath), false)
  assert.equal(r.dialogs[1].message, MISMATCH_SENTENCE)
})

test('a download that did not finish is said, and nothing runs', async () => {
  const r = rig({
    prefs: memoryPrefs({ [POLICY_KEY]: 'always' }),
    answers: [{ response: 0 }, { response: 0 }],
    downloadResult: { ok: false, reason: 'timeout' },
  })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'download-failed')
  assert.equal(result.reason, 'timeout')
  assert.equal(r.spawned.length, 0)
  assert.equal(r.quits, 0)
  assert.equal(r.dialogs.length, 2)
  assert.match(r.dialogs[1].message, /did not finish/)
})

test('a shell that cannot arm the installer says so, and the app is not asked to quit', async () => {
  const prefs = memoryPrefs({ [POLICY_KEY]: 'always' })
  const directory = tempDirectory()
  const dialogs = []
  const controller = createUpdateCheck({
    platform: 'win32',
    fetchManifest: async () => ({ ok: true, manifest: goodManifest() }),
    download: async ({ destination }) => {
      fs.writeFileSync(destination, INSTALLER_BYTES)
      return { ok: true, bytes: INSTALLER_BYTES.length }
    },
    inspectInstaller: async () => ({
      productName: 'ToolsEnabled',
      fileVersion: '1.0.28',
      productVersion: '1.0.28',
    }),
    /* A signed installer, so arming it is what fails here. */
    inspectSignature: async () => SIGNED_BY_US,
    fs,
    prefs,
    currentVersion: CURRENT,
    showMessageBox: async (options) => {
      dialogs.push(options)
      return { response: 0 }
    },
    runAfterQuit: () => { throw new Error('no quit listener') },
    runningAgentCount: () => 0,
    closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: directory,
    now: () => NOW,
  })

  const result = await controller.runAtLaunch()
  assert.equal(result.action, 'install-failed')
  assert.equal(result.reason, 'could not start the installer')
  assert.equal(dialogs.length, 2)
  assert.equal(dialogs[1].title, 'Update not installed')
})

/* ---------- U1: the installer starts after the app has quit ---------- */

function fakeApp() {
  const app = new EventEmitter()
  return {
    app,
    onQuit: (listener) => app.once('quit', listener),
    offQuit: (listener) => app.removeListener('quit', listener),
  }
}

test('U1: an armed installer is not started until the app emits quit, then starts once with --updated', () => {
  const { app, onQuit, offQuit } = fakeApp()
  const started = []
  const logs = []
  const after = createInstallerAfterQuit({
    onQuit, offQuit, log: (line) => logs.push(line),
    spawn: (file, args, options) => { started.push({ file, args, options }); return { on() {}, unref() { started.at(-1).unref = true } } },
  })
  after.arm('\x43:\\u\\updates\\ToolsEnabled-Setup-1.0.51.exe')
  assert.equal(after.armedFile, '\x43:\\u\\updates\\ToolsEnabled-Setup-1.0.51.exe')
  app.emit('before-quit', { preventDefault() {} })
  app.emit('will-quit', { preventDefault() {} })
  assert.deepEqual(started, [], 'nothing runs while the quit can still be refused')
  app.emit('quit')
  assert.deepEqual(started, [{
    file: '\x43:\\u\\updates\\ToolsEnabled-Setup-1.0.51.exe',
    args: ['--updated'],
    options: { detached: true, stdio: 'ignore', windowsHide: true },
    unref: true,
  }])
  assert.deepEqual(INSTALLER_ARGUMENTS, ['--updated'])
  assert.equal(after.armedFile, null)
  app.emit('quit')
  assert.equal(started.length, 1, 'one quit, one installer')
  assert.equal(app.listenerCount('quit'), 0)
})

test('U1: a refused quit cancels the installer, so a later unrelated quit starts nothing', () => {
  const { app, onQuit, offQuit } = fakeApp()
  const started = []
  const after = createInstallerAfterQuit({ onQuit, offQuit, spawn: (file) => { started.push(file); return {} } })
  after.arm('\x43:\\u\\updates\\a.exe')
  assert.equal(after.cancel(), true)
  assert.equal(after.cancel(), false, 'a second cancel is a no-op')
  assert.equal(app.listenerCount('quit'), 0, 'the quit listener is removed, not just ignored')
  app.emit('quit')
  assert.deepEqual(started, [])
})

test('U1: arming twice keeps only the newest file', () => {
  const { app, onQuit, offQuit } = fakeApp()
  const started = []
  const after = createInstallerAfterQuit({ onQuit, offQuit, spawn: (file) => { started.push(file); return {} } })
  after.arm('\x43:\\u\\updates\\old.exe')
  after.arm('\x43:\\u\\updates\\new.exe')
  assert.equal(app.listenerCount('quit'), 1)
  app.emit('quit')
  assert.deepEqual(started, ['\x43:\\u\\updates\\new.exe'])
})

test('U1: an installer that cannot start after the quit is logged, never thrown into the quit', () => {
  const { app, onQuit, offQuit } = fakeApp()
  const logs = []
  const throwing = createInstallerAfterQuit({ onQuit, offQuit, log: (line) => logs.push(line), spawn: () => { throw new Error('ENOENT') } })
  throwing.arm('\x43:\\u\\updates\\gone.exe')
  assert.doesNotThrow(() => app.emit('quit'))
  assert.match(logs.at(-1), /could not be started/)

  const second = fakeApp()
  const child = new EventEmitter()
  child.unref = () => {}
  const emitting = createInstallerAfterQuit({ onQuit: second.onQuit, offQuit: second.offQuit, log: (line) => logs.push(line), spawn: () => child })
  emitting.arm('\x43:\\u\\updates\\x.exe')
  second.app.emit('quit')
  assert.doesNotThrow(() => child.emit('error', new Error('EACCES')), 'a late spawn error has a listener')
  assert.match(logs.at(-1), /could not be started/)
  assert.throws(() => createInstallerAfterQuit({ onQuit: () => {}, offQuit: () => {} }), { name: 'TypeError' })
  assert.throws(() => emitting.arm(''), { name: 'TypeError' })
})

test('U1: shell/main.cjs arms the installer before asking to quit, and every refused quit cancels it', () => {
  const source = fs.readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  assert.match(source, /createInstallerAfterQuit\(\{\s*onQuit: listener => app\.once\('quit', listener\),\s*offQuit: listener => app\.removeListener\('quit', listener\),\s*spawn: spawnChildProcess,/)
  const wiring = source.match(/runAfterQuit: \(file\) => \{([\s\S]*?)\n    \},/)?.[1]
  assert.ok(wiring, 'the update check is handed runAfterQuit')
  assert.ok(wiring.indexOf('installerAfterQuit.arm(file)') >= 0)
  assert.ok(wiring.indexOf('installerAfterQuit.arm(file)') < wiring.indexOf('app.quit()'), 'armed before the quit is asked for')
  assert.ok(!/createUpdateCheck\(\{[\s\S]*?\n  \}\)/.exec(source)[0].includes('spawn:'), 'the update check no longer spawns anything itself')
  const veto = source.slice(source.indexOf("window.webContents.on('will-prevent-unload'"), source.indexOf("window.webContents.on('will-prevent-unload'") + 600)
  assert.match(veto, /installerAfterQuit\.cancel\(\)/, 'a renderer veto cancels it')
  const notice = source.slice(source.indexOf('function reportUnsavedTranscriptClose('), source.indexOf('const appQuitGate = createAppQuitGate('))
  assert.match(notice, /if \(answer\.response !== 0\) \{[\s\S]*?installerAfterQuit\.cancel\(\)/, 'Keep ToolsEnabled open cancels it')
  const later = source.slice(source.indexOf('function quitAfterSaving()'), source.indexOf('function closeWindowAfterSaving('))
  assert.match(later, /openWindowCount\(\) > windowsAtRefusal\) \{ installerAfterQuit\.cancel\(\); return \}/, 'a window opened since the refusal cancels it')
})

test('agents running: the close warning comes first, and Keep working stops everything', async () => {
  const kept = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 1 }], running: 2 })
  const result = await kept.controller.runAtLaunch()
  assert.equal(result.action, 'kept-working')
  assert.equal(kept.dialogs.length, 2)
  assert.deepEqual(kept.dialogs[1].buttons, ['Close them and update', 'Keep working'])
  assert.equal(kept.dialogs[1].message, 'Closing this window ends 2 agents that are still running.')
  assert.equal(kept.dialogs[1].defaultId, 1, 'the safe button is the default')
  assert.equal(kept.downloads, 0)
  assert.equal(kept.spawned.length, 0)
  assert.equal(kept.quits, 0)

  const closed = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 0 }], running: 1 })
  const installed = await closed.controller.runAtLaunch()
  assert.equal(installed.action, 'installing')
  assert.equal(closed.spawned.length, 1)
  assert.equal(closed.quits, 1)
})

/* ---------- U2: agents started during the download ---------- */

/* The count is read once before the download and once after it; `counts`
   answers those reads in order and then repeats its last value. */
function countsInOrder(...counts) {
  let index = 0
  return () => counts[Math.min(index++, counts.length - 1)]
}

test('U2: an agent started during the download is asked about before the app quits; Keep working keeps the file', async () => {
  const directory = tempDirectory()
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 1 }], running: countsInOrder(0, 1), directory })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'kept-working')
  assert.equal(result.running, 1)
  assert.equal(r.dialogs.length, 2)
  assert.deepEqual(r.dialogs[1].buttons, ['Close them and update', 'Keep working'])
  assert.equal(r.dialogs[1].message, 'Closing this window ends 1 agents that are still running.')
  assert.equal(r.dialogs[1].defaultId, 1, 'the safe button is the default')
  assert.deepEqual(r.spawned, [], 'nothing is armed and the app is not quit')
  assert.equal(r.quits, 0)
  assert.ok(fs.existsSync(r.installerPath), 'the verified installer is kept for later')

  /* Later, with nothing running: the kept file is checked again and used, not downloaded again. */
  const again = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }], running: 0, directory })
  assert.equal((await again.controller.runAtLaunch()).action, 'installing')
  assert.equal(again.downloads, 0, 'the kept, still-matching installer is reused')
  assert.deepEqual(again.signatureReads, [{ file: again.installerPath, present: true }], 'its signature is read again before it is used')
  assert.deepEqual(again.spawned, [{ file: again.installerPath, present: true }])
})

test('U2: Close them and update after the download arms the installer', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 0 }], running: countsInOrder(0, 2) })
  assert.equal((await r.controller.runAtLaunch()).action, 'installing')
  assert.equal(r.dialogs[1].message, 'Closing this window ends 2 agents that are still running.')
  assert.equal(r.quits, 1)
})

test('U2: agents already approved are not asked about twice; more than approved are', async () => {
  const same = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 0 }], running: countsInOrder(2, 2) })
  assert.equal((await same.controller.runAtLaunch()).action, 'installing')
  assert.equal(same.dialogs.length, 2, 'one install question, one agent question, no repeat')

  const fewer = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 0 }], running: countsInOrder(2, 1) })
  assert.equal((await fewer.controller.runAtLaunch()).action, 'installing')
  assert.equal(fewer.dialogs.length, 2)

  const more = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }, { response: 0 }, { response: 1 }], running: countsInOrder(1, 3) })
  const result = await more.controller.runAtLaunch()
  assert.equal(result.action, 'kept-working')
  assert.equal(more.dialogs.length, 3)
  assert.equal(more.dialogs[2].message, 'Closing this window ends 3 agents that are still running.')
  assert.equal(more.quits, 0)
})

test('U2: a kept file that no longer matches the manifest is removed and downloaded again', async () => {
  const directory = tempDirectory()
  fs.mkdirSync(path.join(directory, DOWNLOAD_SUBDIRECTORY), { recursive: true })
  const stale = path.join(directory, DOWNLOAD_SUBDIRECTORY, goodManifest().filename)
  fs.writeFileSync(stale, 'a different, partial or older file')
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }], directory })
  assert.equal((await r.controller.runAtLaunch()).action, 'installing')
  assert.equal(r.downloads, 1)
  assert.deepEqual(fs.readFileSync(stale), INSTALLER_BYTES)
})

/* ---------- U6: run as administrator ---------- */

test('U6: running as administrator, a newer version is named and nothing is downloaded, started or quit', async () => {
  for (const policy of ['always', 'ask']) {
    const answers = policy === 'ask' ? [{ response: 0 }, { response: 0 }] : [{ response: 0 }]
    const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: policy }), answers, elevated: () => true })
    const result = await r.controller.runAtLaunch()
    assert.equal(result.action, 'not-installed-elevated', policy)
    assert.equal(r.downloads, 0, policy)
    assert.deepEqual(r.spawned, [], `${policy}: no installer armed`)
    assert.equal(r.quits, 0, `${policy}: the app is not quit for an installer that would refuse`)
    const said = r.dialogs.at(-1)
    assert.equal(said.title, ELEVATED_TITLE)
    assert.equal(said.message, elevatedMessage('1.0.28', CURRENT))
    assert.match(said.message, /administrator/)
    assert.equal(said.detail, ELEVATED_DETAIL)
    assert.deepEqual(said.buttons, ['OK'], `${policy}: it is not offered as something to accept`)
    assert.ok(!r.dialogs.some(dialog => dialog.title === 'Update ToolsEnabled?'), `${policy}: no install question that would only be refused`)
    assert.equal(r.prefs.values[LAST_CHECKED_KEY], undefined, `${policy}: the next ordinary launch must check again`)
    assert.equal(r.prefs.values[ELEVATED_ANNOUNCED_KEY], '1.0.28', `${policy}: the version named is remembered`)
  }
})

/* 1.0.50 review of fixes, 3.11. The box above is OK-only and the 24-hour stamp
   is not written (U6), so under policy 'always' a person who runs elevated on
   purpose met it at EVERY launch while a newer version existed, with no way to
   dismiss it. The version named is now remembered, and an automatic check
   names each version once. The stamp is still not written, so the next
   ordinary launch offers the update; a pressed Check now is answered every
   time; a newer version than the one named is named once more. */
test('U6: running as administrator under policy always, each new version is named once, not at every launch', async () => {
  const prefs = memoryPrefs({ [POLICY_KEY]: 'always' })
  const first = rig({ prefs, elevated: () => true })
  const named = await first.controller.runAtLaunch()
  assert.equal(named.action, 'not-installed-elevated')
  assert.equal(named.announced, true)
  assert.equal(first.dialogs.length, 1)
  assert.equal(prefs.values[ELEVATED_ANNOUNCED_KEY], '1.0.28')
  assert.equal(prefs.values[LAST_CHECKED_KEY], undefined, 'the next ordinary launch must still check')

  const second = rig({ prefs, elevated: () => true })
  const again = await second.controller.runAtLaunch()
  assert.equal(again.action, 'not-installed-elevated', 'still not installed while elevated')
  assert.equal(again.announced, false)
  assert.equal(second.fetches, 1, 'the check itself still runs, since no stamp was written')
  assert.equal(second.dialogs.length, 0, 'the same version was named a second time')
  assert.equal(second.downloads, 0)
  assert.equal(prefs.values[LAST_CHECKED_KEY], undefined)

  const newer = rig({ prefs, elevated: () => true, manifest: goodManifest({ version: '1.0.29' }) })
  assert.equal((await newer.controller.runAtLaunch()).action, 'not-installed-elevated')
  assert.equal(newer.dialogs.length, 1, 'a newer version than the one named is named once more')
  assert.equal(newer.dialogs[0].message, elevatedMessage('1.0.29', CURRENT))
  assert.equal(prefs.values[ELEVATED_ANNOUNCED_KEY], '1.0.29')

  // An ordinary launch afterwards offers the update as before, whatever was named.
  const ordinary = rig({ prefs, elevated: () => false, answers: [{ response: 0 }] })
  assert.equal((await ordinary.controller.runAtLaunch()).action, 'installing')
})

test('U6: Check now pressed while running as administrator names the version every time, one already named included', async () => {
  const prefs = memoryPrefs({ [POLICY_KEY]: 'ask', [ELEVATED_ANNOUNCED_KEY]: '1.0.28' })
  const r = rig({ prefs, answers: [{ response: 0 }, { response: 0 }], elevated: () => true })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'not-installed-elevated')
  assert.equal(result.announced, true)
  assert.equal(r.dialogs.at(-1).title, ELEVATED_TITLE)
  assert.equal(r.dialogs.at(-1).message, elevatedMessage('1.0.28', CURRENT))
  assert.equal(prefs.values[LAST_CHECKED_KEY], undefined)
})

test('U6: running as administrator changes nothing when there is no update, and an unreadable answer is not elevated', async () => {
  const same = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), manifest: goodManifest({ version: CURRENT }), elevated: () => true })
  assert.equal((await same.controller.runAtLaunch()).action, 'up-to-date')
  assert.equal(typeof same.prefs.values[LAST_CHECKED_KEY], 'string', 'a completed comparison is still cached')

  const unknown = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }], elevated: () => { throw new Error('no token') } })
  assert.equal((await unknown.controller.runAtLaunch()).action, 'installing')

  const ordinary = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }], elevated: () => false })
  assert.equal((await ordinary.controller.runAtLaunch()).action, 'installing')
})

test('U6: shell/main.cjs hands the update check the measured elevation', () => {
  const source = fs.readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  const call = /createUpdateCheck\(\{[\s\S]*?\n  \}\)/.exec(source)[0]
  assert.match(call, /elevated: \(\) => runtimeIntegrityCheck\.elevated === true,/)
})

test('Not now on the install question downloads nothing', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 1 }] })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'declined-update')
  assert.equal(r.downloads, 0)
  assert.equal(r.spawned.length, 0)
})

test('a dialog that cannot be shown is "not now": nothing remembered, nothing run', async () => {
  const r = rig({ answers: [new Error('no window')] })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'declined-check')
  assert.deepEqual(r.prefs.writes, [])
  assert.equal(r.fetches, 0)
})

test('scheduleAtLaunch hands the scheduler the delay and runs the launch path', async () => {
  let scheduled = null
  const prefs = memoryPrefs({ [POLICY_KEY]: 'never' })
  const logs = []
  const controller = createUpdateCheck({
    platform: 'win32',
    fetchManifest: async () => ({ ok: false }),
    download: async () => ({ ok: false }),
    inspectInstaller: async () => { throw new Error('must not inspect') },
    fs,
    prefs,
    currentVersion: CURRENT,
    showMessageBox: async () => ({ response: 1 }),
    runAfterQuit: () => {},
    runningAgentCount: () => 0,
    closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: tempDirectory(),
    log: (line) => logs.push(line),
    setTimeout: (fn, ms) => { scheduled = { fn, ms }; return 'handle' },
  })
  assert.equal(controller.scheduleAtLaunch(), 'handle')
  assert.equal(scheduled.ms, 1500)
  scheduled.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(logs.length, 1)
})

/* ---------- the wire, against a fake https ---------- */

function fakeHttps(script) {
  const calls = []
  return {
    calls,
    request(href, options, onResponse) {
      calls.push({ href, options })
      const request = new EventEmitter()
      request.setTimeout = (ms, handler) => { request.timeoutMs = ms; request.onTimeout = handler }
      request.destroy = (error) => { request.destroyed = true; if (error) request.emit('error', error) }
      request.end = () => { setImmediate(() => script({ request, onResponse })) }
      return request
    },
  }
}

function fakeResponse(statusCode, chunks = []) {
  const response = new EventEmitter()
  response.statusCode = statusCode
  response.resume = () => {}
  response.pipe = (target) => {
    response.on('data', (chunk) => target.write(chunk))
    response.on('end', () => target.end())
    return target
  }
  response.play = () => {
    setImmediate(() => {
      for (const chunk of chunks) response.emit('data', Buffer.from(chunk))
      response.emit('end')
    })
  }
  return response
}

test('the manifest fetcher parses a 200 and nothing else', async () => {
  const https = fakeHttps(({ onResponse }) => {
    const response = fakeResponse(200, [JSON.stringify(goodManifest())])
    onResponse(response)
    response.play()
  })
  const fetchManifest = createManifestFetcher({ https })
  const got = await fetchManifest()
  assert.equal(got.ok, true)
  assert.equal(got.manifest.version, '1.0.28')
  assert.equal(https.calls[0].href, MANIFEST_URL)
  assert.equal(https.calls[0].options.method, 'GET')
})

test('the manifest fetcher refuses a redirect, a non-200, bad JSON, oversize and a timeout', async () => {
  const redirect = createManifestFetcher({ https: fakeHttps(({ onResponse }) => onResponse(fakeResponse(302))) })
  assert.deepEqual(await redirect(), { ok: false, reason: 'redirect' })

  const missing = createManifestFetcher({ https: fakeHttps(({ onResponse }) => onResponse(fakeResponse(404))) })
  assert.deepEqual(await missing(), { ok: false, reason: 'status 404' })

  const badJson = createManifestFetcher({ https: fakeHttps(({ onResponse }) => { const r = fakeResponse(200, ['{not json']); onResponse(r); r.play() }) })
  assert.deepEqual(await badJson(), { ok: false, reason: 'bad json' })

  const oversize = createManifestFetcher({ https: fakeHttps(({ onResponse }) => { const r = fakeResponse(200, ['x'.repeat(70 * 1024)]); onResponse(r); r.play() }), maxBytes: 64 * 1024 })
  assert.deepEqual(await oversize(), { ok: false, reason: 'oversize' })

  const timeout = createManifestFetcher({ https: fakeHttps(({ request }) => request.onTimeout()), timeoutMs: 10 })
  assert.deepEqual(await timeout(), { ok: false, reason: 'timeout' })

  const network = createManifestFetcher({ https: fakeHttps(({ request }) => request.emit('error', new Error('ECONNRESET'))) })
  assert.deepEqual(await network(), { ok: false, reason: 'network' })
})

test('the manifest fetcher never puts a non-https or off-host address on the wire', async () => {
  const https = fakeHttps(() => { throw new Error('must not be reached') })
  const fetchManifest = createManifestFetcher({ https })
  assert.deepEqual(await fetchManifest('http://toolsenabled.ai/download/download.json'), { ok: false, reason: 'not https' })
  assert.deepEqual(await fetchManifest('https://toolsenabled.com/download/download.json'), { ok: false, reason: 'wrong host' })
  assert.equal(https.calls.length, 0)
})

test('the installer downloader streams to disk, stops past the declared size, and follows no redirect', async () => {
  const directory = tempDirectory()
  const destination = path.join(directory, 'ToolsEnabled-Setup-1.0.28.exe')
  const ok = createInstallerDownloader({
    https: fakeHttps(({ onResponse }) => { const r = fakeResponse(200, ['abc', 'def']); onResponse(r); r.play() }),
    fs,
  })
  const got = await ok({ url: installerUrl('ToolsEnabled-Setup-1.0.28.exe'), destination, maxBytes: 6 })
  assert.deepEqual(got, { ok: true, bytes: 6 })
  assert.equal(fs.readFileSync(destination, 'utf8'), 'abcdef')

  const tooBig = createInstallerDownloader({
    https: fakeHttps(({ onResponse }) => { const r = fakeResponse(200, ['abc', 'def', 'g']); onResponse(r); r.play() }),
    fs,
  })
  const big = await tooBig({ url: installerUrl('ToolsEnabled-Setup-1.0.28.exe'), destination: path.join(directory, 'big.exe'), maxBytes: 6 })
  assert.deepEqual(big, { ok: false, reason: 'oversize' })

  const redirected = createInstallerDownloader({ https: fakeHttps(({ onResponse }) => onResponse(fakeResponse(301))), fs })
  assert.deepEqual(await redirected({ url: installerUrl('x.exe'), destination: path.join(directory, 'r.exe'), maxBytes: 6 }), { ok: false, reason: 'redirect' })
  assert.equal(fs.existsSync(path.join(directory, 'r.exe')), false, 'a refused response writes no file')
})

/* ---------- the shell really uses it ---------- */

test('shell/main.cjs schedules the check after the window is up, and both sites read one agent count', () => {
  const source = fs.readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
  assert.ok(source.includes("require('./update-check.cjs')"), 'main.cjs requires the module')
  assert.ok(source.includes("require('./installer-pe-identity.cjs')"), 'main.cjs requires the shared PE identity reader')
  assert.ok(source.includes('updateCheck.scheduleAtLaunch()'), 'main.cjs schedules the launch check')
  const afterLayer = source.indexOf('await capabilityLayerStart')
  assert.ok(afterLayer > 0 && source.indexOf('createUpdateCheck({') > afterLayer, 'scheduled after the capability layer has settled, never before the window')
  const countBody = source.match(/function runningAgentCount\(\) \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(countBody, 'the shared session count implementation remains present')
  const count = new Function('agentSessions', countBody)
  assert.equal(count(new Map()), 0)
  assert.equal(count(new Map([['one', {}], ['two', {}]])), 2)
  assert.match(source, /createUpdateCheck\(\{[\s\S]*?runningAgentCount,/, 'the updater receives the shared count')
  assert.ok(source.includes('function runningAgentCount()'))
  assert.equal(source.match(/runningAgentCount\(\)/g).length >= 2, true, 'the close warning and the updater share it')
  assert.ok(source.includes('closeWarning: closeEndsAgentsWarning'), 'the updater says the close warning\'s own sentence')
  assert.ok(source.includes('inspectInstaller: readExeVersionInfo'), 'the updater must inspect the downloaded PE before spawning it')
  /* The comment beside the close warning names the sync form to say why it is
     not used; the call form is what must never appear. */
  assert.ok(!source.includes('showMessageBoxSync('), 'never the sync form: it cannot report the checkbox')
  assert.ok(!source.includes('ready-to-show'), 'no new window-ready handler')
})

/* The gate that decides whether the downloaded bytes are the release the prompt
   named must not be run by an interpreter somebody else can choose. */
test('the PE identity gate runs Windows PowerShell by absolute path, never through PATH', async () => {
  const { WINDOWS_POWERSHELL, createExeVersionInfoReader } = peIdentity

  /* The address itself: an object-manager path, which PATH cannot answer and
     which no environment variable a user can set takes part in. */
  assert.equal(
    WINDOWS_POWERSHELL,
    String.raw`\\.\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
  )
  assert.notEqual(WINDOWS_POWERSHELL, 'powershell.exe', 'a bare name is a PATH lookup')

  /* What the reader actually launches. This runs on the downloaded installer
     moments before update-check spawns it and quits the app, and
     shell/bridge-env-path.cjs records that HKCU\Environment -- and therefore
     PATH -- is writable by the user with no elevation and no consent. */
  const launched = []
  const stub = (stdout) => (file, args, options, done) => {
    launched.push({ file, args, options })
    /* promisify without the custom symbol resolves the one callback value */
    done(null, { stdout, stderr: '' })
  }
  const pe = JSON.stringify({ ProductName: 'ToolsEnabled', FileVersion: '1.0.39.0', ProductVersion: '1.0.39.0' })
  const read = createExeVersionInfoReader({ execFile: stub(pe) })
  const identity = await read(String.raw`${"\x43:\\Users\\somebody\\AppData\\Roaming\\ToolsEnabled\\updates\\ToolsEnabled Setup 1.0.39.exe"}`)

  assert.equal(identity.productName, 'ToolsEnabled')
  assert.equal(launched.length, 1)
  assert.equal(launched[0].file, WINDOWS_POWERSHELL, 'the identity gate must not be a PATH lookup')
  assert.equal(launched[0].options.windowsHide, true)

  /* The seam stays injectable, so the assertion above cannot be satisfied by
     inlining the constant at the call site and quietly losing this grip. */
  const chosen = []
  const stubbed = createExeVersionInfoReader({
    powershell: String.raw`${"\x43:\\fixture\\pwsh.exe"}`,
    execFile: (file, args, options, done) => { chosen.push(file); stub(pe)(file, args, options, done) },
  })
  await stubbed('x.exe')
  assert.deepEqual(chosen, [String.raw`${"\x43:\\fixture\\pwsh.exe"}`])
})

/* U7: PowerShell treats U+2018..U+201B as single quotes too. A path spliced
   into a single-quoted literal with only ' doubled broke on D’Angelo. */
const TYPOGRAPHIC_PATHS = [
  '\x44:\\fixture\\D\u2019Angelo\\AppData\\Roaming\\ToolsEnabled\\updates\\ToolsEnabled-Setup-1.0.51.exe',
  "\x44:\\fixture\\O'Brien \u2018x\u201A\u201B\\updates\\ToolsEnabled-Setup-1.0.51.exe",
  '\x44:\\fixture\\$(whoami) `n ; "q"\\updates\\ToolsEnabled-Setup-1.0.51.exe',
]

test('U7: the VersionInfo reader passes the path in the environment, never inside the command', async () => {
  const { VERSION_INFO_FILE_VARIABLE, VERSION_INFO_SCRIPT, createExeVersionInfoReader } = peIdentity
  const pe = JSON.stringify({ ProductName: 'ToolsEnabled', FileVersion: '1.0.51.0', ProductVersion: '1.0.51.0' })
  for (const file of TYPOGRAPHIC_PATHS) {
    const launched = []
    const read = createExeVersionInfoReader({
      env: { PATH: 'fixture' },
      execFile: (exe, args, options, done) => { launched.push({ exe, args, options }); done(null, { stdout: pe, stderr: '' }) },
    })
    assert.equal((await read(file)).productName, 'ToolsEnabled')
    assert.deepEqual(launched[0].args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_INFO_SCRIPT])
    assert.ok(!launched[0].args.some(arg => arg.includes('fixture')), 'the path must never be spliced into the command')
    assert.equal(launched[0].options.env[VERSION_INFO_FILE_VARIABLE], file)
    assert.equal(launched[0].options.env.PATH, 'fixture', 'the rest of the environment is passed through unchanged')
  }
  assert.match(VERSION_INFO_SCRIPT, new RegExp(`-LiteralPath \\$env:${VERSION_INFO_FILE_VARIABLE}\\)`))
})

test('U7: the command the VersionInfo reader runs parses in a real PowerShell for every path (real pwsh)', { skip: PWSH ? false : 'pwsh is not installed here' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const { createExeVersionInfoReader } = peIdentity
  const directory = tempDirectory()
  for (const file of TYPOGRAPHIC_PATHS) {
    let command = null
    const read = createExeVersionInfoReader({
      env: {},
      execFile: (exe, args, options, done) => { command = args.at(-1); done(null, { stdout: JSON.stringify({ ProductName: 'x', FileVersion: '1.0.0', ProductVersion: '1.0.0' }), stderr: '' }) },
    })
    await read(file)
    const commandFile = path.join(directory, 'command.txt')
    fs.writeFileSync(commandFile, command, 'utf8')
    const errors = execFileSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput((Get-Content -Raw -Encoding utf8 -LiteralPath '${commandFile}'),[ref]$t,[ref]$e); $e.Count`],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } }).trim()
    assert.equal(errors, '0', `the VersionInfo command does not parse for ${JSON.stringify(file)}`)
  }
})

test('package.json no longer describes an updater the product does not have', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.build.publish, undefined, 'the publish block made electron-builder emit an inert app-update.yml')
  assert.equal(pkg.dependencies?.['electron-updater'], undefined)
  assert.equal(pkg.devDependencies?.['electron-updater'], undefined)
})

test('the new files are classified open in the payload boundary', () => {
  const boundary = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'payload-boundary.json'), 'utf8'))
  const open = boundary.source.open.paths
  for (const file of ['shell/installer-pe-identity.cjs', 'shell/update-check.cjs', 'src/update-settings.js', 'tools/test/update-check.test.mjs', 'tools/test/update-settings.test.mjs']) {
    assert.ok(open.includes(file), `${file} is classified`)
  }
})

/* ---------- the signature (1.0.50 release review, release-ops F4) ---------- */

test('a hash- and PE-matched installer that ToolsEnabled, Inc. did not sign is deleted and never launched', async () => {
  for (const [label, signature] of [
    ['not signed', { status: 'NotSigned', signer: null, issuer: null, timestamped: false }],
    ['signed by somebody else', { ...SIGNED_BY_US, signer: 'Somebody Else, LLC' }],
    ['not trusted', { ...SIGNED_BY_US, status: 'NotTrusted' }],
    ['altered after signing', { ...SIGNED_BY_US, status: 'HashMismatch' }],
    ['no timestamp', { ...SIGNED_BY_US, timestamped: false }],
    ['unreadable answer', null],
    ['reader failed', new Error('powershell could not start')],
  ]) {
    const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }], installerSignature: signature })
    const result = await r.controller.runAtLaunch()
    assert.equal(result.action, 'mismatch', label)
    assert.equal(r.spawned.length, 0, `${label}: an installer whose signature was not confirmed was launched`)
    assert.equal(r.quits, 0, label)
    assert.equal(fs.existsSync(r.installerPath), false, `${label}: the refused installer was left on disk`)
    assert.equal(r.dialogs.at(-1).message, UNSIGNED_SENTENCE, label)
    assert.match(r.dialogs.at(-1).detail, /toolsenabled\.ai\/download/, `${label}: the person is not told where to get it instead`)
  }
})

test('the signature reader runs Windows PowerShell by absolute path, with the file outside the command', async () => {
  const {
    SIGNATURE_FILE_VARIABLE, SIGNATURE_SCRIPT, WINDOWS_POWERSHELL, createInstallerSignatureReader, compareInstallerSignature,
  } = peIdentity
  const launched = []
  const file = String.raw`${"\x44:\\fixture\\updates\\ToolsEnabled-Setup-1.0.51.exe"}`
  const read = createInstallerSignatureReader({
    env: { PATH: 'fixture' },
    execFile: (exe, args, options, done) => {
      launched.push({ exe, args, options })
      /* What the CLM-safe script prints (U3): subject and issuer as Windows
         formats them, CN first, a value with a comma in quotes. */
      done(null, { stdout: `WARNING: noise\r\n${JSON.stringify({
        status: 'Valid',
        subject: 'CN="ToolsEnabled, Inc.", O="ToolsEnabled, Inc.", L=Wilmington, S=Delaware, C=US',
        issuer: 'CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US',
        timestamped: true,
      })}\r\n`, stderr: '' })
    },
  })
  const measured = await read(file)
  assert.deepEqual(measured, SIGNED_BY_US)
  assert.deepEqual(compareInstallerSignature(measured), { ok: true, signer: 'ToolsEnabled, Inc.' })
  assert.equal(launched.length, 1)
  assert.equal(launched[0].exe, WINDOWS_POWERSHELL, 'the signature gate must not be a PATH lookup')
  assert.ok(launched[0].args.includes(SIGNATURE_SCRIPT))
  assert.ok(!launched[0].args.some(arg => arg.includes(file)), 'the path must never be spliced into the command')
  assert.equal(launched[0].options.env[SIGNATURE_FILE_VARIABLE], file)
  assert.equal(launched[0].options.env.PATH, 'fixture', 'the rest of the environment is passed through unchanged')
  assert.equal(launched[0].options.windowsHide, true)
  await assert.rejects(read(''), /non-empty/)
})

test('the install-time signature check is the read-back the signing step measured', () => {
  /* tools/code-signing/windows-signing.cjs runs VERIFY_SCRIPT on every file it
     signs; for the 1.0.50 installer it answered Valid, ToolsEnabled, Inc.,
     timestamped. The updater cannot load tools/ (it is not shipped), so it
     carries its own copy, and this holds the copy to the measured original. */
  const require = createRequire(import.meta.url)
  const { VERIFY_SCRIPT } = require('../code-signing/windows-signing.cjs')
  assert.equal(
    peIdentity.SIGNATURE_SCRIPT.replaceAll(peIdentity.SIGNATURE_FILE_VARIABLE, 'TOOLSENABLED_SIGNATURE_READBACK_FILE'),
    VERIFY_SCRIPT,
  )
  assert.equal(peIdentity.EXPECTED_PUBLISHER, 'ToolsEnabled, Inc.')
})

test('U3: the signature script and the VersionInfo script use nothing Constrained Language Mode refuses', () => {
  const { SIGNATURE_SCRIPT, VERSION_INFO_SCRIPT } = peIdentity
  /* 1.0.50 review of fixes, 3.10: the VersionInfo script is run by the same
     update under the same policy, so it is held to the same list. */
  for (const [name, script] of [['signature', SIGNATURE_SCRIPT], ['VersionInfo', VERSION_INFO_SCRIPT]]) {
    for (const refused of ['::', '.GetNameInfo(', '[pscustomobject]', '.ToString(', '[IO.Path]', '[System.', '[Console]']) {
      assert.ok(!script.includes(refused), `the ${name} script still uses ${refused}, which CLM refuses`)
    }
  }
  assert.match(SIGNATURE_SCRIPT, /\$env:PSModulePath="\$PSHOME\\Modules"/, 'the module path is still reset to Windows PowerShell\'s own')
  assert.match(SIGNATURE_SCRIPT, /subject=\$\(if\(\$c\)\{\$c\.Subject\}else\{\$null\}\)/)
})

test('U3: the signer is the CN of the subject, quoted or not, in either order, and nothing else', () => {
  const { commonNameFromDistinguishedName: cn } = peIdentity
  assert.equal(cn('CN="ToolsEnabled, Inc.", O="ToolsEnabled, Inc.", L=Wilmington, S=Delaware, C=US'), 'ToolsEnabled, Inc.')
  assert.equal(cn('C=US, S=Delaware, L=Wilmington, O="ToolsEnabled, Inc.", CN="ToolsEnabled, Inc."'), 'ToolsEnabled, Inc.')
  assert.equal(cn('CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US'), 'Microsoft ID Verified CS AOC CA 03')
  assert.equal(cn('CN="Say ""hi"", Inc.", C=US'), 'Say "hi", Inc.')
  assert.equal(cn('OID.2.5.4.3=Thing, C=US'), 'Thing')
  assert.equal(cn('CN=x + OU=y, C=US'), 'x')
  /* An O or OU that merely says the name is not a CN. */
  assert.equal(cn('O="CN=ToolsEnabled, Inc.", C=US'), null)
  assert.equal(cn('OU=ToolsEnabled, C=US'), null)
  /* Ambiguous or unreadable is null, which compareInstallerSignature refuses. */
  for (const unreadable of ['CN=a, CN=b', 'CN="unterminated', 'CN="a"b, C=US', 'no equals sign', 'CN=', '', null, undefined, 42]) {
    assert.equal(cn(unreadable), null, JSON.stringify(unreadable))
  }
  assert.equal(peIdentity.compareInstallerSignature({ status: 'Valid', signer: cn('CN="ToolsEnabled, Inc. ", C=US'), timestamped: true }).ok, false,
    'a near-miss name is still a different publisher')
})

test('U3: a reader answer without a readable subject CN is refused, not trusted', async () => {
  const { createInstallerSignatureReader, compareInstallerSignature } = peIdentity
  for (const answer of [
    { status: 'Valid', signer: 'ToolsEnabled, Inc.', timestamped: true },
    { status: 'Valid', subject: 'O="ToolsEnabled, Inc.", C=US', timestamped: true },
    { status: 'Valid', subject: 'CN="ToolsEnabled, Inc.", CN=Other', timestamped: true },
  ]) {
    const read = createInstallerSignatureReader({ env: {}, execFile: (exe, args, options, done) => done(null, { stdout: JSON.stringify(answer), stderr: '' }) })
    const measured = await read('\x43:\\fixture\\a.exe')
    assert.equal(measured.signer, null, JSON.stringify(answer))
    assert.equal(compareInstallerSignature(measured).ok, false)
  }
})

/* The script itself, run by a real PowerShell under ConstrainedLanguage. Only
   where pwsh is installed (it is on the Linux build host); Get-AuthenticodeSignature
   is a Windows cmdlet, so a stand-in returns a real X509Certificate2 made in
   FullLanguage, and the script under test then runs in ConstrainedLanguage. */
test('U3: the signature script answers under ConstrainedLanguage (real pwsh)', { skip: PWSH ? false : 'pwsh is not installed here' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const { SIGNATURE_SCRIPT, SIGNATURE_FILE_VARIABLE, createInstallerSignatureReader, compareInstallerSignature } = peIdentity
  const directory = tempDirectory()
  const scriptFile = path.join(directory, 'script.txt')
  fs.writeFileSync(scriptFile, SIGNATURE_SCRIPT)
  const harness = path.join(directory, 'harness.ps1')
  fs.writeFileSync(harness, [
    'param([string]$ScriptFile)',
    '$script = Get-Content -Raw -LiteralPath $ScriptFile',
    '$rsa = [System.Security.Cryptography.RSA]::Create(2048)',
    '$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(\'CN="ToolsEnabled, Inc.", O="ToolsEnabled, Inc.", C=US\', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)',
    '$global:cert = $request.CreateSelfSigned([DateTimeOffset]::Now.AddDays(-1), [DateTimeOffset]::Now.AddDays(1))',
    'function global:Get-AuthenticodeSignature { param([string]$LiteralPath)',
    '  [pscustomobject]@{ Status = [System.Management.Automation.SignatureStatus]::Valid; SignerCertificate = $global:cert; TimeStamperCertificate = $global:cert; Path = $LiteralPath } }',
    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'",
    'Invoke-Expression $script',
  ].join('\n'))
  const stdout = execFileSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', harness, '-ScriptFile', scriptFile], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, [SIGNATURE_FILE_VARIABLE]: path.join(directory, 'ToolsEnabled-Setup-1.0.51.exe'), NO_COLOR: '1' },
  })
  const read = createInstallerSignatureReader({ env: {}, execFile: (exe, args, options, done) => done(null, { stdout, stderr: '' }) })
  const measured = await read('fixture.exe')
  assert.deepEqual({ status: measured.status, signer: measured.signer, timestamped: measured.timestamped },
    { status: 'Valid', signer: 'ToolsEnabled, Inc.', timestamped: true }, stdout)
  assert.deepEqual(compareInstallerSignature(measured), { ok: true, signer: 'ToolsEnabled, Inc.' })
})

/* 1.0.50 review of fixes, 3.10. The VersionInfo script under the same policy.
   It used to begin with `[Console]::OutputEncoding = ...`, which CLM refuses
   ("Cannot set property. Property setting is supported only on core types in
   this language mode."); the statement came before $ErrorActionPreference =
   'Stop', so the script went on and printed its JSON with an error on stderr
   that nothing read. The reader must not depend on that: the script has to run
   under ConstrainedLanguage with nothing on stderr. Get-Item's VersionInfo is
   read on Linux too (every field null), which is enough to run the script. */
test('U7: the VersionInfo script runs clean under ConstrainedLanguage (real pwsh)', { skip: PWSH ? false : 'pwsh is not installed here' }, async () => {
  const { spawnSync } = await import('node:child_process')
  const { VERSION_INFO_SCRIPT, VERSION_INFO_FILE_VARIABLE } = peIdentity
  const directory = tempDirectory()
  const scriptFile = path.join(directory, 'script.txt')
  fs.writeFileSync(scriptFile, VERSION_INFO_SCRIPT)
  const target = path.join(directory, 'ToolsEnabled-Setup-1.0.51.exe')
  fs.writeFileSync(target, 'not a PE; only its VersionInfo fields are read, and they are null here')
  const harness = path.join(directory, 'harness.ps1')
  fs.writeFileSync(harness, [
    'param([string]$ScriptFile)',
    '$script = Get-Content -Raw -LiteralPath $ScriptFile',
    "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'",
    'Invoke-Expression $script',
  ].join('\n'))
  const run = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', harness, '-ScriptFile', scriptFile], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, [VERSION_INFO_FILE_VARIABLE]: target, NO_COLOR: '1' },
  })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr.trim(), '', 'the VersionInfo script wrote an error under ConstrainedLanguage')
  const parsed = JSON.parse(run.stdout.trim())
  assert.deepEqual(Object.keys(parsed).sort(),
    ['CompanyName', 'FileDescription', 'FileVersion', 'LegalCopyright', 'OriginalFilename', 'ProductName', 'ProductVersion'])
})

test('a shell that passes no signature reader still gets the real one, never a skipped check', () => {
  const source = fs.readFileSync(path.join(ROOT, 'shell', 'update-check.cjs'), 'utf8')
  assert.match(source, /inspectSignature = readInstallerSignature,/)
  assert.match(source, /requireFunction\(inspectSignature, 'inspectSignature'\)/)
  assert.throws(() => createUpdateCheck({
    fetchManifest: async () => ({ ok: false }), download: async () => ({ ok: false }),
    inspectInstaller: async () => null, inspectSignature: null, fs, prefs: memoryPrefs(),
    currentVersion: CURRENT, showMessageBox: async () => ({ response: 1 }), runAfterQuit: () => {},
    runningAgentCount: () => 0, closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: tempDirectory(),
  }), { name: 'TypeError' }, 'an explicit non-function signature reader must refuse construction')
})

/* ---------- a pressed Check now is answered (release-ops F9) ---------- */

test('the launch question says the remembered check runs at launch, at most once a day, not every launch', () => {
  assert.match(CHECK_DETAIL, /at launch, at most once a day/)
  assert.doesNotMatch(CHECK_DETAIL, /every launch/, 'dueForCheck() allows one check per 24 hours')
  assert.ok(CHECK_INTERVAL_MS === 24 * 60 * 60 * 1000, 'the sentence and the throttle must agree')
})

test('ask: a pressed Check now that finds no newer version says so', async () => {
  for (const version of [CURRENT, '1.0.26']) {
    const r = rig({ answers: [{ response: 0, checkboxChecked: false }], manifest: goodManifest({ version }) })
    const result = await r.controller.runAtLaunch()
    assert.equal(result.action, 'up-to-date')
    assert.equal(r.dialogs.length, 2, 'the person pressed Check now and was shown nothing')
    assert.equal(r.dialogs[1].title, CHECKED_TITLE)
    assert.equal(r.dialogs[1].message, `You have the newest version (${CURRENT}).`)
    assert.deepEqual(r.dialogs[1].buttons, ['OK'])
  }
})

test('ask: a pressed Check now that could not tell says so, without claiming there is no update', async () => {
  for (const fetched of [{ ok: false, reason: 'network' }, { ok: false, reason: 'status 404' }]) {
    const r = rig({ answers: [{ response: 0, checkboxChecked: true }], fetched })
    const result = await r.controller.runAtLaunch()
    assert.equal(result.action, 'check-failed')
    assert.equal(result.policy, 'always', 'the remembered answer is still kept')
    assert.equal(r.dialogs.length, 2)
    assert.equal(r.dialogs[1].message, COULD_NOT_CHECK_MESSAGE)
    assert.match(r.dialogs[1].detail, /does not mean there is no update/)
    assert.match(r.dialogs[1].detail, /toolsenabled\.ai\/download/)
    assert.equal(r.downloads, 0)
  }
})

test('the check nobody pressed stays silent when it finds nothing or cannot tell', async () => {
  const quiet = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), manifest: goodManifest({ version: CURRENT }) })
  assert.equal((await quiet.controller.runAtLaunch()).action, 'up-to-date')
  const offline = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), fetched: { ok: false, reason: 'network' } })
  assert.equal((await offline.controller.runAtLaunch()).action, 'check-failed')
  assert.equal(quiet.dialogs.length + offline.dialogs.length, 0)
})

/* ---------- installers left by earlier updates (release-ops F10) ---------- */

test('at launch, installers for the running version or older are removed, and nothing else is', async () => {
  const directory = tempDirectory()
  const updates = path.join(directory, DOWNLOAD_SUBDIRECTORY)
  fs.mkdirSync(updates, { recursive: true })
  const finished = ['ToolsEnabled-Setup-1.0.26.exe', 'ToolsEnabled Setup 1.0.27.exe', 'ToolsEnabled-Setup-0.9.99.exe']
  const kept = ['ToolsEnabled-Setup-1.0.28.exe', 'notes.txt', 'Other-Setup-1.0.1.exe', 'ToolsEnabled-Setup-1.0.26.exe.partial']
  for (const name of [...finished, ...kept]) fs.writeFileSync(path.join(updates, name), 'x')
  fs.mkdirSync(path.join(updates, 'ToolsEnabled-Setup-1.0.1.exe'))

  const queued = []
  const r = rig({ directory, prefs: memoryPrefs({ [POLICY_KEY]: 'never' }), schedule: fn => { queued.push(fn) } })
  r.controller.scheduleAtLaunch()
  assert.equal(queued.length, 1)
  queued[0]()
  for (let turn = 0; turn < 20 && fs.readdirSync(updates).some(name => finished.includes(name)); turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(fs.readdirSync(updates).sort(), [...kept, 'ToolsEnabled-Setup-1.0.1.exe'].sort(),
    'only finished installers of our own name may be removed; a newer download, a directory and other files stay')
  assert.ok(r.logs.some(line => /removed 3 installers left by earlier updates/.test(line)), JSON.stringify(r.logs))
  assert.equal(r.dialogs.length, 0, 'removing old installers never asks anybody anything')
  assert.deepEqual(await r.controller.removeFinishedInstallers(), { removed: 0 }, 'it runs once per launch')
})

test('removing old installers tolerates a missing folder and a file still in use, and never runs off Windows', async () => {
  const absent = rig({ directory: tempDirectory() })
  assert.deepEqual(await absent.controller.removeFinishedInstallers(), { removed: 0 })

  const busyDirectory = tempDirectory()
  fs.mkdirSync(path.join(busyDirectory, DOWNLOAD_SUBDIRECTORY))
  fs.writeFileSync(path.join(busyDirectory, DOWNLOAD_SUBDIRECTORY, 'ToolsEnabled-Setup-1.0.27.exe'), 'x')
  const busyFs = { ...fs, promises: { ...fs.promises, unlink: async () => { const error = new Error('EBUSY'); error.code = 'EBUSY'; throw error } } }
  const busy = createUpdateCheck({
    platform: 'win32', fetchManifest: async () => ({ ok: false }), download: async () => ({ ok: false }),
    inspectInstaller: async () => null, fs: busyFs, prefs: memoryPrefs(), currentVersion: CURRENT,
    showMessageBox: async () => ({ response: 1 }), runAfterQuit: () => {},
    runningAgentCount: () => 0, closeWarning: () => ({ message: '', detail: '' }), downloadDirectory: busyDirectory,
  })
  assert.deepEqual(await busy.removeFinishedInstallers(), { removed: 0 })
  assert.ok(fs.existsSync(path.join(busyDirectory, DOWNLOAD_SUBDIRECTORY, 'ToolsEnabled-Setup-1.0.27.exe')))

  const linuxDirectory = tempDirectory()
  fs.mkdirSync(path.join(linuxDirectory, DOWNLOAD_SUBDIRECTORY))
  fs.writeFileSync(path.join(linuxDirectory, DOWNLOAD_SUBDIRECTORY, 'ToolsEnabled-Setup-1.0.26.exe'), 'x')
  const linux = rig({ platform: 'linux', directory: linuxDirectory })
  assert.deepEqual(await linux.controller.removeFinishedInstallers(), { removed: 0 })
  assert.ok(fs.existsSync(path.join(linuxDirectory, DOWNLOAD_SUBDIRECTORY, 'ToolsEnabled-Setup-1.0.26.exe')))
})
