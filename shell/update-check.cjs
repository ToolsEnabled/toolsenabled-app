'use strict'

/* THE IN-APP UPDATE CHECK.
 *
 * The owner's words: "when a user launches the software it should ask if you
 * want to check for updates and it should have a box for always check
 * automatically and never check automatically so a user can not see the window
 * again if they want and then it should be in settings though."
 *
 * So the FIRST question is about CHECKING, not installing. Three remembered
 * answers, kept in renderer-prefs under `mc.update.policy`:
 *
 *   ask     (the default)  a dialog at launch: "Check for updates?"
 *   always                 the check runs on its own at launch, at most once a
 *                          day, and only the install question ever appears
 *   never                  nothing runs; the Settings row is the way back
 *
 * ONE CHECKBOX CARRIES BOTH REMEMBERED ANSWERS. "Don't ask me again" ticked
 * with Check now means always; ticked with Not now means never; unticked
 * leaves the policy at ask whichever button was pressed. decidePolicy() is
 * that rule, alone, so a test can hold every combination still.
 *
 * WHERE THE TRUTH COMES FROM. https://toolsenabled.ai/download/download.json,
 * the manifest the release step writes beside the installer it ships. It
 * carries version, filename, bytes, sha256 and measured PE identity, and there
 * is no second place that could drift from it. The installer's address is BUILT from `filename`
 * and never written here: tools/check-download-wire.mjs's rule, driven by a
 * declaration rather than a path.
 *
 * THE FIRST PINNED HTTPS GET IN shell/, AND THE PINS ARE THE POINT. Scheme
 * https:, host exactly toolsenabled.ai, no redirect followed (a 3xx is a
 * failure, because a redirect is somebody else choosing where the bytes come
 * from), ten seconds of silence ends the request, the manifest is capped at 64
 * KB, the installer at the byte count the manifest declared. Every failure is
 * SILENT: no prompt, no retry, one log line. A check that could not be made is
 * not an update, and a dialog about it would teach people to dismiss the one
 * that matters.
 *
 * NOTHING RUNS WHOSE HASH DID NOT MATCH. The installer is streamed to disk
 * under userData and hashed over a read stream -- NOT the whole-file
 * readFile() tools/seal-artifact.mjs uses, because that tree is 356 MB of small
 * files and this is one file of 100 MB that must not be held in memory twice.
 * SHA-256, byte count, ProductName, FileVersion and ProductVersion are all
 * compared; a mismatch deletes the file, says one sentence, and stops. Only a
 * fully matched file is spawned, and only after the
 * close warning's own sentence has been shown if agents are running -- the
 * promise shell/main.cjs made at 37f8030 is that nothing ends an agent without
 * a word, and an installer quitting the app is exactly that.
 *
 * EVERY DEPENDENCY IS INJECTED (the shell/relay-supervisor.cjs shape): the
 * required ones throw by name, the optional ones default. The pure decisions
 * are exported on their own, so tools/test/update-check.test.mjs needs no
 * Electron and no network.
 */

const { createHash } = require('crypto')
const nodePath = require('path')
const {
  comparePeIdentity,
  peIdentityManifestIsSane,
} = require('./installer-pe-identity.cjs')

const MANIFEST_URL = 'https://toolsenabled.ai/download/download.json'
const DOWNLOAD_HOST = 'toolsenabled.ai'
const DOWNLOAD_ORIGIN = `https://${DOWNLOAD_HOST}`
const DOWNLOAD_PAGE = `${DOWNLOAD_HOST}/download`

const POLICY_KEY = 'mc.update.policy'
const LAST_CHECKED_KEY = 'mc.update.last-checked'
const POLICIES = Object.freeze(['ask', 'always', 'never'])
const DEFAULT_POLICY = 'ask'

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const MANIFEST_MAX_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 10_000
/* The window is on screen before this runs; the delay is so the first paint
   is never contested by a native dialog landing on top of it. */
const LAUNCH_DELAY_MS = 1500
/* Where the installer lands: a folder of our own under userData, so a stale
   or refused download is always one known file in one known place. */
const DOWNLOAD_SUBDIRECTORY = 'updates'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const SHA256_HEX = /^[0-9a-f]{64}$/i
/* A bare file name for a Windows installer: letters, digits, spaces, dot, dash
   and underscore, ending in .exe, no separators, no leading/trailing dot or
   space. electron-builder writes "ToolsEnabled Setup 1.0.38.exe"; the website
   may instead use the equally valid hyphenated spelling. */
const INSTALLER_FILENAME = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9_-])?\.exe$/

/* The sentences. Each one is what a person reads; none of them carries an
   identifier, and the one about SmartScreen is in the install prompt because
   that is the moment it is true. */
const CHECK_TITLE = 'Check for updates?'
const CHECK_MESSAGE = 'Check for updates?'
const CHECK_DETAIL = 'ToolsEnabled can ask toolsenabled.ai whether a newer version is out. Nothing is installed without asking you first.\n\nTick the box to keep your answer: Check now means it checks on its own at every launch, and Not now means it never checks. Either can be changed later in Settings, under System.'
const CHECK_BUTTONS = Object.freeze(['Check now', 'Not now'])
const REMEMBER_LABEL = 'Don’t ask me again'

const UPDATE_TITLE = 'Update ToolsEnabled?'
const UPDATE_BUTTONS = Object.freeze(['Update now', 'Not now'])
const UPDATE_DETAIL = 'Windows will warn you about the installer; that is expected. The download is checked against what the site says it should be before anything runs.'

const AGENTS_BUTTONS = Object.freeze(['Close them and update', 'Keep working'])

const MISMATCH_SENTENCE = 'The download did not match what the site says it should be, so it was not installed.'
const MISMATCH_DETAIL = `Nothing on this computer was changed. Try again later, or get the installer yourself from ${DOWNLOAD_PAGE}.`
const DOWNLOAD_FAILED_SENTENCE = 'The download did not finish, so nothing was installed.'
const DOWNLOAD_FAILED_DETAIL = `Nothing on this computer was changed. Try again later, or get the installer yourself from ${DOWNLOAD_PAGE}.`
const NOT_INSTALLED_TITLE = 'Update not installed'
const COULD_NOT_TELL_CODE = 'UPDATE_CHECK_COULD_NOT_TELL'
const COULD_NOT_TELL_SENTENCE = 'The update check could not tell whether an update is available; this does not claim that an update is absent.'

function updateMessage(available, current) {
  return `ToolsEnabled ${available} is available (you have ${current}). Download and install it now?`
}

/* ---------------------------------------------------------------
   The decisions, with nothing attached to them.
   --------------------------------------------------------------- */

/* The remembered policy from a stored string. Anything that is not one of the
   three words -- absent, damaged, a word from a build that does not exist
   yet -- reads as the default, which is the one that asks. */
function readPolicyValue(value) {
  return POLICIES.includes(value) ? value : DEFAULT_POLICY
}

/* THE ONE CHECKBOX, TWO MEANINGS. The answer is what dialog.showMessageBox
   resolves with: { response, checkboxChecked }. Response 0 is the first
   button, Check now. A malformed answer -- a dialog that could not be shown
   resolves with nothing useful -- is "not now, do not remember anything". */
function decidePolicy(answer) {
  const response = answer && Number.isInteger(answer.response) ? answer.response : 1
  const remembered = Boolean(answer && answer.checkboxChecked === true)
  const check = response === 0
  if (!remembered) return { policy: DEFAULT_POLICY, check }
  return { policy: check ? 'always' : 'never', check }
}

function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/* Newer ONLY. Equal is not newer, older is not newer, and a version that is
   not three numbers is never newer -- so a manifest carrying "1.0.28-beta" or
   "latest" cannot produce a prompt. */
function isNewer(candidate, current) {
  const a = parseSemver(candidate)
  const b = parseSemver(current)
  if (!a || !b) return false
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return true
    if (a[index] < b[index]) return false
  }
  return false
}

/* What the manifest has to say before it is believed: a version this module
   can compare, a file name that can only be a file name, a positive byte count,
   a sha256, and the three PE identity fields the downloaded executable must
   carry. Release identity is not inferred from a filename: the 1.0.38 update
   path once served a PE whose embedded version was 1.0.32. */
function manifestIsSane(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  if (!parseSemver(manifest.version)) return false
  if (typeof manifest.filename !== 'string' || !INSTALLER_FILENAME.test(manifest.filename)) return false
  if (manifest.filename.includes('..')) return false
  if (!Number.isInteger(manifest.bytes) || manifest.bytes <= 0) return false
  if (typeof manifest.sha256 !== 'string' || !SHA256_HEX.test(manifest.sha256)) return false
  if (!peIdentityManifestIsSane(manifest)) return false
  return true
}

/* THE 24-HOUR THROTTLE IS OURS. The site sends Cache-Control: no-store, so
   nothing between here and it remembers the last answer; this does. An absent
   or unreadable stamp is due. A stamp in the FUTURE is due as well: it is not a
   record of a check that happened, and a clock that was set back must not buy
   a month of silence. */
function dueForCheck(lastIso, nowMs) {
  if (typeof lastIso !== 'string' || !lastIso) return true
  const last = Date.parse(lastIso)
  if (!Number.isFinite(last)) return true
  const elapsed = nowMs - last
  if (elapsed < 0) return true
  return elapsed >= CHECK_INTERVAL_MS
}

/* The pins, as a function of the address alone, so the same rule guards the
   manifest GET and the installer GET and a test can hold it without a socket. */
function pinnedUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return { ok: false, reason: 'not an address' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not https' }
  if (url.hostname !== DOWNLOAD_HOST) return { ok: false, reason: 'wrong host' }
  if (url.username || url.password) return { ok: false, reason: 'credentials in address' }
  return { ok: true, url }
}

/* Built, never written. The manifest's own file name is the only thing that
   decides what is fetched, and it has already passed manifestIsSane(). */
function installerUrl(filename) {
  return `${DOWNLOAD_ORIGIN}/download/${encodeURIComponent(filename)}`
}

/* ---------------------------------------------------------------
   The wire: one pinned GET, used twice.
   --------------------------------------------------------------- */

/* Resolves { ok: true, response } for a 200, and { ok: false, reason } for
   everything else -- including every 3xx, which Node's https never follows
   and this module never will. `timeoutMs` is socket silence, which is the
   timeout a 100 MB download can honestly have. */
function pinnedGet({ https, url, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const pinned = pinnedUrl(url)
    if (!pinned.ok) { resolve(pinned); return }
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let request
    try {
      request = https.request(pinned.url.href, { method: 'GET' }, (response) => {
        const status = response.statusCode
        if (status >= 300 && status < 400) {
          response.resume()
          request.destroy()
          settle({ ok: false, reason: 'redirect' })
          return
        }
        if (status !== 200) {
          response.resume()
          request.destroy()
          settle({ ok: false, reason: `status ${status}` })
          return
        }
        settle({ ok: true, response, request })
      })
    } catch {
      settle({ ok: false, reason: 'request refused' })
      return
    }
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('timeout'))
      settle({ ok: false, reason: 'timeout' })
    })
    request.on('error', (error) => {
      settle({ ok: false, reason: error && error.message === 'timeout' ? 'timeout' : 'network' })
    })
    request.end()
  })
}

/* The manifest: at most 64 KB of JSON, parsed inside a try. */
function createManifestFetcher({ https, timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MANIFEST_MAX_BYTES } = {}) {
  requireValue(https, 'https')
  return async function fetchManifest(url = MANIFEST_URL) {
    const got = await pinnedGet({ https, url, timeoutMs })
    if (!got.ok) return got
    const { response, request } = got
    return new Promise((resolve) => {
      const chunks = []
      let received = 0
      let done = false
      const finish = (result) => {
        if (done) return
        done = true
        resolve(result)
      }
      response.on('data', (chunk) => {
        received += chunk.length
        if (received > maxBytes) {
          request.destroy()
          finish({ ok: false, reason: 'oversize' })
          return
        }
        chunks.push(chunk)
      })
      response.on('error', () => finish({ ok: false, reason: 'network' }))
      response.on('aborted', () => finish({ ok: false, reason: 'network' }))
      response.on('end', () => {
        if (done) return
        try {
          finish({ ok: true, manifest: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch {
          finish({ ok: false, reason: 'bad json' })
        }
      })
    })
  }
}

/* The installer: streamed to `destination`, never held in memory, stopped the
   moment it exceeds the byte count the manifest declared. */
function createInstallerDownloader({ https, fs, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  requireValue(https, 'https')
  requireValue(fs, 'fs')
  return async function download({ url, destination, maxBytes }) {
    const got = await pinnedGet({ https, url, timeoutMs })
    if (!got.ok) return got
    const { response, request } = got
    return new Promise((resolve) => {
      let received = 0
      let done = false
      let file
      const finish = (result) => {
        if (done) return
        done = true
        resolve(result)
      }
      try {
        file = fs.createWriteStream(destination)
      } catch {
        request.destroy()
        finish({ ok: false, reason: 'cannot write' })
        return
      }
      file.on('error', () => {
        request.destroy()
        finish({ ok: false, reason: 'cannot write' })
      })
      response.on('data', (chunk) => {
        received += chunk.length
        if (received > maxBytes) {
          request.destroy()
          file.destroy()
          finish({ ok: false, reason: 'oversize' })
        }
      })
      response.on('error', () => { file.destroy(); finish({ ok: false, reason: 'network' }) })
      response.on('aborted', () => { file.destroy(); finish({ ok: false, reason: 'network' }) })
      file.on('finish', () => finish({ ok: true, bytes: received }))
      response.pipe(file)
    })
  }
}

/* SHA-256 over a read stream, and the byte count from the same pass. This is
   deliberately not the readFile()-then-hash of tools/seal-artifact.mjs: that
   tool hashes hundreds of small files, this hashes one file of about 100 MB,
   and a whole-file read would hold the installer in memory a second time. */
function hashFile({ fs, file }) {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    let bytes = 0
    let stream
    try {
      stream = fs.createReadStream(file)
    } catch {
      resolve({ ok: false, reason: 'cannot read' })
      return
    }
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk) })
    stream.on('error', () => resolve({ ok: false, reason: 'cannot read' }))
    stream.on('end', () => resolve({ ok: true, sha256: hash.digest('hex'), bytes }))
  })
}

function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`createUpdateCheck requires ${name}`)
  }
  return value
}

function requireValue(value, name) {
  if (value === undefined || value === null) {
    throw new TypeError(`createUpdateCheck requires ${name}`)
  }
  return value
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`createUpdateCheck requires ${name}`)
  }
  return value
}

/**
 * @param {object}   deps
 * @param {Function} deps.fetchManifest      () => { ok, manifest } | { ok:false, reason }
 * @param {Function} deps.download           ({ url, destination, maxBytes }) => { ok, bytes } | { ok:false, reason }
 * @param {Function} deps.inspectInstaller   reads ProductName/FileVersion/ProductVersion from the downloaded PE
 * @param {object}   deps.fs                 createReadStream, promises.mkdir / unlink / stat
 * @param {object}   deps.prefs              renderer-prefs: snapshot(), set(key, value)
 * @param {string}   deps.currentVersion     app.getVersion()
 * @param {Function} deps.showMessageBox     (options) => Promise<{ response, checkboxChecked }>
 * @param {Function} deps.spawn              child_process.spawn, or a stand-in
 * @param {Function} deps.quit               ends the application after the installer is started
 * @param {Function} deps.runningAgentCount  how many agent sessions are live right now
 * @param {Function} deps.closeWarning       (running) => { message, detail } -- the close warning's own words
 * @param {string}   deps.downloadDirectory  app.getPath('userData')
 * @param {Function} [deps.now]
 * @param {Function} [deps.log]              one identifier-free line per check
 * @param {Function} [deps.setTimeout]
 * @param {number}   [deps.launchDelayMs]
 * @param {object}   [deps.path]
 */
function createUpdateCheck({
  fetchManifest,
  download,
  inspectInstaller,
  fs,
  prefs,
  currentVersion,
  showMessageBox,
  spawn,
  quit,
  runningAgentCount,
  closeWarning,
  downloadDirectory,
  now = Date.now,
  log = () => {},
  setTimeout: schedule = setTimeout,
  launchDelayMs = LAUNCH_DELAY_MS,
  path = nodePath,
  platform = process.platform,
  setupActive = () => false,
} = {}) {
  requireFunction(fetchManifest, 'fetchManifest')
  requireFunction(download, 'download')
  requireFunction(inspectInstaller, 'inspectInstaller')
  requireValue(fs, 'fs')
  requireValue(prefs, 'prefs')
  requireString(currentVersion, 'currentVersion')
  requireFunction(showMessageBox, 'showMessageBox')
  requireFunction(spawn, 'spawn')
  requireFunction(quit, 'quit')
  requireFunction(runningAgentCount, 'runningAgentCount')
  requireFunction(closeWarning, 'closeWarning')
  requireString(downloadDirectory, 'downloadDirectory')

  let inFlight = false
  let launchScheduled = false

  /* The prefs file, read the way shell/main.cjs reads the close warning's
     key: inside a try, and failing CLOSED. A store that throws, or one that
     reports itself damaged, is a store whose `never` this module cannot see --
     so nothing runs, rather than a dialog appearing over a choice somebody
     already made. */
  function readPrefs() {
    try {
      const snapshot = prefs.snapshot()
      if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'settings unreadable' }
      if (typeof snapshot.damaged === 'string' && snapshot.damaged) return { ok: false, reason: 'settings damaged' }
      const values = snapshot.values && typeof snapshot.values === 'object' ? snapshot.values : {}
      return {
        ok: true,
        policy: readPolicyValue(values[POLICY_KEY]),
        lastChecked: typeof values[LAST_CHECKED_KEY] === 'string' ? values[LAST_CHECKED_KEY] : null,
      }
    } catch {
      return { ok: false, reason: 'settings unreadable' }
    }
  }

  function writePref(key, value) {
    try {
      const result = prefs.set(key, value)
      return Boolean(result && result.ok)
    } catch {
      return false
    }
  }

  async function ask(options) {
    try {
      const answer = await showMessageBox(options)
      return answer && typeof answer === 'object' ? answer : { response: 1, checkboxChecked: false }
    } catch {
      /* A dialog that cannot be shown is "not now": nothing is remembered and
         nothing runs. */
      return { response: 1, checkboxChecked: false }
    }
  }

  function record(action, extra = {}) {
    const seen = extra.seen ? `version seen ${extra.seen}` : 'no version seen'
    const why = extra.reason ? ` (${extra.reason})` : ''
    log(`${seen}, running ${currentVersion}: ${action}${why}`)
    return { action, current: currentVersion, ...extra }
  }

  async function removeFile(file) {
    try { await fs.promises.unlink(file) } catch { /* a file that is already gone is gone */ }
  }

  /* The check itself: fetch, compare, and -- only for a newer version -- ask.
     Every failure before the comparison is silent. */
  async function check() {
    // The current manifest and identity verifier describe a Windows PE.
    // A Linux/macOS app must never offer that installer as its own update.
    if (platform !== 'win32') return record('not-checked', { reason: 'platform unsupported' })
    if (inFlight) return { action: 'already-checking', current: currentVersion }
    inFlight = true
    try {
      let fetched
      try {
        fetched = await fetchManifest(MANIFEST_URL)
      } catch (error) {
        fetched = {
          ok: false,
          reason: error && error.message === 'timeout' ? 'timeout' : 'network',
          errorCode: error && typeof error.code === 'string' ? error.code : 'UNKNOWN',
        }
      }
      if (!fetched || fetched.ok !== true) {
        return record('check-failed', {
          code: COULD_NOT_TELL_CODE,
          sentence: COULD_NOT_TELL_SENTENCE,
          reason: fetched && fetched.reason ? fetched.reason : 'network',
          ...(fetched && fetched.errorCode ? { errorCode: fetched.errorCode } : {}),
        })
      }
      const manifest = fetched.manifest
      if (!manifestIsSane(manifest)) {
        return record('check-failed', {
          code: COULD_NOT_TELL_CODE,
          sentence: COULD_NOT_TELL_SENTENCE,
          reason: 'manifest unusable',
        })
      }
      /* Cache only a completed comparison. A busy machine, timeout, unreadable
         response, or other could-not-tell result must remain due. */
      writePref(LAST_CHECKED_KEY, new Date(now()).toISOString())
      const seen = manifest.version
      if (!isNewer(seen, currentVersion)) return record('up-to-date', { seen })

      const answer = await ask({
        type: 'info',
        buttons: [...UPDATE_BUTTONS],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: UPDATE_TITLE,
        message: updateMessage(seen, currentVersion),
        detail: UPDATE_DETAIL,
      })
      if (answer.response !== 0) return record('declined-update', { seen })

      /* The promise from 37f8030, kept here too: an installer ends every
         running agent, and nobody is told by silence. The sentence is the
         close warning's own. */
      const running = runningAgentCount()
      if (Number.isInteger(running) && running > 0) {
        const words = closeWarning(running)
        const warned = await ask({
          type: 'warning',
          buttons: [...AGENTS_BUTTONS],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          title: 'Close ToolsEnabled?',
          message: words.message,
          detail: words.detail,
        })
        if (warned.response !== 0) return record('kept-working', { seen, running })
      }

      return install(manifest)
    } finally {
      inFlight = false
    }
  }

  async function install(manifest) {
    const seen = manifest.version
    const directory = path.join(downloadDirectory, DOWNLOAD_SUBDIRECTORY)
    const destination = path.join(directory, manifest.filename)
    try {
      await fs.promises.mkdir(directory, { recursive: true })
    } catch {
      await sayNotInstalled(DOWNLOAD_FAILED_SENTENCE, DOWNLOAD_FAILED_DETAIL)
      return record('download-failed', { seen, reason: 'cannot write' })
    }
    await removeFile(destination)

    let got
    try {
      got = await download({ url: installerUrl(manifest.filename), destination, maxBytes: manifest.bytes })
    } catch {
      got = { ok: false, reason: 'network' }
    }
    if (!got || got.ok !== true) {
      await removeFile(destination)
      await sayNotInstalled(DOWNLOAD_FAILED_SENTENCE, DOWNLOAD_FAILED_DETAIL)
      return record('download-failed', { seen, reason: got && got.reason ? got.reason : 'network' })
    }

    const hashed = await hashFile({ fs, file: destination })
    const matched = hashed.ok
      && hashed.bytes === manifest.bytes
      && hashed.sha256.toLowerCase() === manifest.sha256.toLowerCase()
    if (!matched) {
      await removeFile(destination)
      await sayNotInstalled(MISMATCH_SENTENCE, MISMATCH_DETAIL)
      return record('mismatch', { seen, reason: hashed.ok ? 'hash or size differs' : hashed.reason })
    }

    let measuredIdentity
    try {
      measuredIdentity = await inspectInstaller(destination)
    } catch {
      measuredIdentity = null
    }
    const identity = comparePeIdentity(manifest, measuredIdentity)
    if (!identity.ok) {
      await removeFile(destination)
      await sayNotInstalled(MISMATCH_SENTENCE, MISMATCH_DETAIL)
      return record('mismatch', { seen, reason: identity.reason })
    }

    /* Detached and unreferenced, so the installer outlives this process.
       windowsHide is about CONSOLE windows (a console-subsystem child gets one
       otherwise); the NSIS installer is a GUI program and draws its own window
       either way, so the shell's no-console rule holds here as everywhere. */
    try {
      const child = spawn(destination, [], { detached: true, stdio: 'ignore', windowsHide: true })
      /* child_process.spawn reports launch failures through the child's
         asynchronous `error` event, not just by throwing. Wait for `spawn`
         before treating the installer as started; keeping the error listener
         here also prevents a failed launch from becoming an uncaught event. */
      if (child && typeof child.once === 'function') {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
      }
      if (child && typeof child.unref === 'function') child.unref()
    } catch {
      await sayNotInstalled(DOWNLOAD_FAILED_SENTENCE, DOWNLOAD_FAILED_DETAIL)
      return record('install-failed', { seen, reason: 'could not start the installer' })
    }
    const result = record('installing', { seen, file: destination })
    quit()
    return result
  }

  async function sayNotInstalled(message, detail) {
    await ask({
      type: 'warning',
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: NOT_INSTALLED_TITLE,
      message,
      detail,
    })
  }

  /* What happens at launch, under each policy. Returns the record so a caller
     or a test can see what was decided; the shell only schedules it. */
  async function runAtLaunch() {
    if (platform !== 'win32') return record('not-checked', { reason: 'platform unsupported' })
    const read = readPrefs()
    if (!read.ok) return record('not-checked', { reason: read.reason })
    if (read.policy === 'never') return record('not-checked', { reason: 'policy never', policy: 'never' })
    if (read.policy === 'always') {
      if (!dueForCheck(read.lastChecked, now())) return record('not-due', { policy: 'always' })
      return { policy: 'always', ...(await check()) }
    }
    const answer = await ask({
      type: 'question',
      buttons: [...CHECK_BUTTONS],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: CHECK_TITLE,
      message: CHECK_MESSAGE,
      detail: CHECK_DETAIL,
      checkboxLabel: REMEMBER_LABEL,
      checkboxChecked: false,
    })
    const decided = decidePolicy(answer)
    /* Written only when the answer is one to keep; an unticked box leaves the
       file exactly as it was. A prefs file that cannot be written costs the
       memory, not the check. */
    if (decided.policy !== DEFAULT_POLICY) writePref(POLICY_KEY, decided.policy)
    if (!decided.check) return record('declined-check', { policy: decided.policy })
    return { policy: decided.policy, ...(await check()) }
  }

  function scheduleAtLaunch() {
    if (launchScheduled || platform !== 'win32') return
    launchScheduled = true
    return schedule(() => {
      // A route change after setup retries this once. No polling and no
      // remembered-policy change while the person is choosing their folder.
      if (setupActive()) { launchScheduled = false; return }
      void runAtLaunch()
    }, launchDelayMs)
  }

  return Object.freeze({
    runAtLaunch,
    scheduleAtLaunch,
    check,
    readPolicy: () => readPrefs(),
  })
}

module.exports = {
  AGENTS_BUTTONS,
  CHECK_BUTTONS,
  CHECK_DETAIL,
  CHECK_INTERVAL_MS,
  CHECK_MESSAGE,
  CHECK_TITLE,
  COULD_NOT_TELL_CODE,
  COULD_NOT_TELL_SENTENCE,
  DEFAULT_POLICY,
  DOWNLOAD_FAILED_SENTENCE,
  DOWNLOAD_HOST,
  DOWNLOAD_SUBDIRECTORY,
  LAST_CHECKED_KEY,
  LAUNCH_DELAY_MS,
  MANIFEST_MAX_BYTES,
  MANIFEST_URL,
  MISMATCH_SENTENCE,
  POLICIES,
  POLICY_KEY,
  REMEMBER_LABEL,
  REQUEST_TIMEOUT_MS,
  UPDATE_BUTTONS,
  UPDATE_DETAIL,
  createInstallerDownloader,
  createManifestFetcher,
  createUpdateCheck,
  decidePolicy,
  dueForCheck,
  hashFile,
  installerUrl,
  isNewer,
  manifestIsSane,
  pinnedGet,
  pinnedUrl,
  readPolicyValue,
  updateMessage,
}
