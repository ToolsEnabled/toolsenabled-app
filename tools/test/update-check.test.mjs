/* THE UPDATE CHECK, HELD STILL WITHOUT ELECTRON OR A SOCKET.
 *
 * shell/update-check.cjs takes every dependency as an argument, so this suite
 * hands it a fake dialog, a fake manifest fetcher, a fake downloader, a fake
 * spawn and an in-memory prefs store, and reads back what it decided. The
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
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import updateCheck from '../../shell/update-check.cjs'
import peIdentity from '../../shell/installer-pe-identity.cjs'

const {
  CHECK_BUTTONS,
  CHECK_INTERVAL_MS,
  COULD_NOT_TELL_CODE,
  COULD_NOT_TELL_SENTENCE,
  DOWNLOAD_SUBDIRECTORY,
  LAST_CHECKED_KEY,
  MANIFEST_URL,
  MISMATCH_SENTENCE,
  POLICY_KEY,
  REMEMBER_LABEL,
  UPDATE_BUTTONS,
  createInstallerDownloader,
  createManifestFetcher,
  createUpdateCheck,
  decidePolicy,
  dueForCheck,
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
    immutableLocation: 'C:\\lanes\\releases\\1.0.28',
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

/* The rig: every dependency scripted, every call recorded. `answers` is the
   list of dialog answers in the order dialogs appear. */
function rig({
  prefs = memoryPrefs(),
  answers = [],
  manifest = goodManifest(),
  fetched = null,
  installerBytes = INSTALLER_BYTES,
  installerIdentity = null,
  downloadResult = null,
  running = 0,
  currentVersion = CURRENT,
  directory = tempDirectory(),
  platform = 'win32',
  setupActive = () => false,
  schedule,
} = {}) {
  const dialogs = []
  const logs = []
  const spawned = []
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
    fs,
    prefs,
    currentVersion,
    showMessageBox: async (options) => {
      dialogs.push(options)
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      return answer || { response: 1, checkboxChecked: false }
    },
    spawn: (file, args, options) => {
      spawned.push({ file, args, options })
      return { unref() {} }
    },
    quit: () => { quits += 1 },
    runningAgentCount: () => running,
    closeWarning: (count) => ({ message: `Closing this window ends ${count} agents that are still running.`, detail: 'Their work stops where it is.' }),
    downloadDirectory: directory,
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
  assert.deepEqual(pinnedUrl('https://user:pw@toolsenabled.ai/x'), { ok: false, reason: 'credentials in address' })
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
    spawn: () => ({ unref() {} }),
    quit: () => {},
    runningAgentCount: () => 0,
    closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: 'C:\\somewhere',
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
  assert.match(r.dialogs[0].detail, /Windows will warn you/)
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
    spawn: () => { throw new Error('must not spawn') },
    quit: () => { throw new Error('must not quit') },
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

test('Update now with no agents: download, hash, spawn detached, quit', async () => {
  const r = rig({ prefs: memoryPrefs({ [POLICY_KEY]: 'always' }), answers: [{ response: 0 }] })
  const result = await r.controller.runAtLaunch()
  assert.equal(result.action, 'installing')
  assert.equal(r.downloads, 1)
  assert.equal(r.spawned.length, 1)
  assert.equal(r.spawned[0].file, r.installerPath)
  assert.deepEqual(r.spawned[0].args, [])
  assert.deepEqual(r.spawned[0].options, { detached: true, stdio: 'ignore', windowsHide: true })
  assert.equal(r.quits, 1)
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

test('an asynchronous installer launch failure is said and does not quit', async () => {
  const prefs = memoryPrefs({ [POLICY_KEY]: 'always' })
  const directory = tempDirectory()
  const dialogs = []
  let quits = 0
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
    fs,
    prefs,
    currentVersion: CURRENT,
    showMessageBox: async (options) => {
      dialogs.push(options)
      return { response: 0 }
    },
    spawn: () => {
      const child = new EventEmitter()
      child.unref = () => { throw new Error('must not unref a child that did not spawn') }
      setImmediate(() => child.emit('error', new Error('ENOENT')))
      return child
    },
    quit: () => { quits += 1 },
    runningAgentCount: () => 0,
    closeWarning: () => ({ message: '', detail: '' }),
    downloadDirectory: directory,
    now: () => NOW,
  })

  const result = await controller.runAtLaunch()
  assert.equal(result.action, 'install-failed')
  assert.equal(result.reason, 'could not start the installer')
  assert.equal(quits, 0)
  assert.equal(dialogs.length, 2)
  assert.equal(dialogs[1].title, 'Update not installed')
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
    spawn: () => ({ unref() {} }),
    quit: () => {},
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
  const identity = await read(String.raw`C:\Users\somebody\AppData\Roaming\ToolsEnabled\updates\ToolsEnabled Setup 1.0.39.exe`)

  assert.equal(identity.productName, 'ToolsEnabled')
  assert.equal(launched.length, 1)
  assert.equal(launched[0].file, WINDOWS_POWERSHELL, 'the identity gate must not be a PATH lookup')
  assert.equal(launched[0].options.windowsHide, true)

  /* The seam stays injectable, so the assertion above cannot be satisfied by
     inlining the constant at the call site and quietly losing this grip. */
  const chosen = []
  const stubbed = createExeVersionInfoReader({
    powershell: String.raw`C:\fixture\pwsh.exe`,
    execFile: (file, args, options, done) => { chosen.push(file); stub(pe)(file, args, options, done) },
  })
  await stubbed('x.exe')
  assert.deepEqual(chosen, [String.raw`C:\fixture\pwsh.exe`])
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
