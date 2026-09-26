'use strict'

// Native QA custody and read-only observations. Product writes happen only
// through the mounted wizard/Settings controls in the companion scenarios.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { sterileProfileDirectories, prepareSterileProfile, sterileLaunchEnvironment } = require('./sterile-launch.cjs')

const CASE_IDS = Object.freeze(['first-use-wizard-standard', 'first-use-wizard-cold-reopen',
  'first-use-settings-discard', 'first-use-settings-save', 'first-use-settings-cold-reopen'])
const GUIDED_CASE_IDS = Object.freeze(['guided-draft-cancel-and-cold-resume', 'guided-recommended-finish-and-exit'])
const FLAG_IDS = Object.freeze(['dispatch', 'decision', 'queue', 'thread-reply', 'report-read', 'agent-session', 'cloud-launch'])
const KEYS = Object.freeze(['mc.setup.profile', 'mc.example', ...FLAG_IDS.map(id => 'mc.write.' + id)])
const HOME_KEYS = Object.freeze(['HOME', 'USERPROFILE', 'CODEX_HOME', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'])
const CREDENTIAL_ENV = /^(?:MC_|TOOLSENABLED_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|AWS_|AZURE_|NODE_OPTIONS$|NODE_PATH$)/i
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}

function validateFirstUseOptions(options, platform = process.platform) {
  if (options.sterileFirstUse === undefined) return false
  assert.equal(options.sterileFirstUse, true, 'Sterile first-use must be explicitly true')
  assert.equal(platform, 'linux', 'Sterile first-use is currently a Linux-only native cohort')
  assert.equal(options.realProvider, false, 'Sterile first-use cannot request a real provider')
  assert.equal(options.codexProfileHome, undefined, 'Sterile first-use cannot select a provider home')
  assert.equal(options.codexAccountIdSha256, undefined, 'Sterile first-use cannot select a provider identity')
  const family = options.level === 'standard' ? CASE_IDS : options.level === 'guided' ? GUIDED_CASE_IDS : null
  assert.ok(family, 'Sterile first-use requires its explicit Standard or Guided family')
  assert.ok(Array.isArray(options.cases) && options.cases.length && new Set(options.cases).size === options.cases.length
    && options.cases.every(id => family.includes(id)), 'Sterile first-use needs an explicit unmixed first-use case selection')
  return true
}

function ownedPath(root, file, { missing = false, directory = false } = {}) {
  assert.ok(path.isAbsolute(root) && path.resolve(root) === root && path.isAbsolute(file) && path.resolve(file) === file
    && (file === root || inside(root, file)), 'First-use evidence must remain in its exact owned root')
  let current = root
  for (const component of ['', ...path.relative(root, file).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component)
    let stat
    try { stat = fs.lstatSync(current, { bigint: true }) }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error }
    assert.equal(stat.isSymbolicLink(), false, 'First-use custody cannot follow a linked ancestor')
    if (process.getuid) assert.equal(stat.uid, BigInt(process.getuid()), 'First-use evidence must belong to the current owner')
    if (current !== file || directory) assert.ok(stat.isDirectory(), 'First-use ancestor must be a directory')
    else {
      assert.ok(stat.isFile() && stat.nlink === 1n && stat.size <= 64n * 1024n * 1024n,
        'First-use data must be a bounded private regular file')
    }
  }
  return file
}

function readOwnedJSON(root, file) {
  ownedPath(root, file)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let bytes, before
  try {
    before = fs.fstatSync(fd, { bigint: true })
    assert.ok(before.isFile() && before.nlink === 1n && before.size <= 64n * 1024n * 1024n)
    bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true })
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      assert.equal(after[field], before[field]); assert.equal(named[field], before[field])
    }
  } finally { fs.closeSync(fd) }
  return { file, sha256: hash(bytes), bytes: bytes.length, value: JSON.parse(bytes.toString('utf8')) }
}

function absent(root, file) {
  assert.equal(ownedPath(root, file, { missing: true }), null, 'The sterile fixture must retain actual absence: ' + path.relative(root, file))
  return { path: file, absent: true }
}

function scanCredentialNames(root) {
  ownedPath(root, root, { directory: true })
  const pending = [root], opaqueLinks = []
  let entries = 0
  while (pending.length) {
    const directory = pending.pop()
    ownedPath(root, directory, { directory: true })
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 100000, 'First-use credential-name scan exceeds its bound')
      const file = path.join(directory, entry.name)
      assert.ok(!['auth.json', '.credentials.json', 'credentials.json'].includes(entry.name.toLowerCase()), 'A provider credential name appeared in the sterile fixture')
      // Chromium's own singleton/bootstrap links are opaque. Never follow a
      // target; an auth.json link is refused above just like a regular leaf.
      if (entry.isSymbolicLink()) opaqueLinks.push(path.relative(root, file))
      else if (entry.isDirectory()) pending.push(file)
      else assert.ok(entry.isFile(), 'Unsupported entry in the first-use profile')
    }
  }
  return { entries, credentialNames: 0, opaqueLinks: opaqueLinks.sort(), followedLinks: 0 }
}

function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(')').at(-1).trim().split(/\s+/)
  assert.match(stat[19], /^(?:0|[1-9]\d*)$/)
  return { pid, startTicks: stat[19] }
}

function postBootstrapHomes(homes) {
  // main.cjs applies fencedAccountEnvironment before capability setup. The
  // owning launch's provider selector is deliberately removed, even on Linux.
  // Its generated directory remains an empty, separately inspected input.
  return { ...homes, CODEX_HOME: null }
}

// Retain a launch before any mounted-window or runtime check can reject it.
// The identity reader is an explicit source-test seam; native preparation
// always uses the real /proc reader and the actual retained ChildProcess.
function createFirstUseLifecycle({ receipt, inspect, identity = processIdentity }) {
  let active = null
  const attempted = child => {
    assert.equal(active, null, 'Every prior Electron attempt must close before another launch')
    assert.ok(child && Number.isSafeInteger(child.pid) && child.pid > 0, 'Retain the actual Electron child handle')
    const attempt = { attempt: receipt.attempts.length + 1, pid: child.pid, startTicks: null,
      retainedChild: true, identityCaptured: false }
    receipt.cleanupComplete = false; receipt.complete = false
    active = { child, attempt }
    receipt.attempts.push(attempt)
    // An early process/read failure leaves an attempted identity, never an
    // invented opening. Its retained handle must still be closed by the caller.
    const observed = identity(child.pid)
    assert.equal(observed.pid, child.pid)
    assert.match(observed.startTicks, /^[1-9]\d*$/)
    attempt.startTicks = observed.startTicks; attempt.identityCaptured = true
    return attempt
  }
  const validateOpening = runtime => {
    assert.ok(active && active.attempt.identityCaptured, 'Runtime validation requires its captured launch attempt')
    const attempt = active.attempt
    assert.equal(runtime.pid, attempt.pid, 'Runtime must belong to the retained Electron child')
    assert.deepEqual(identity(runtime.pid), { pid: attempt.pid, startTicks: attempt.startTicks }, 'Electron identity changed during opening')
    assert.equal(runtime.userData, path.join(receipt.qaRoot, 'ToolsEnabled-Page2-QA'))
    assert.deepEqual(runtime.homes, receipt.postBootstrapHomes, 'Actual Electron homes must match the ordinary post-bootstrap environment')
    assert.deepEqual(runtime.absentHomeKeys, ['CODEX_HOME'], 'The ordinary bootstrap must remove the inherited provider home')
    assert.equal(runtime.homedir, receipt.homes.HOME)
    assert.deepEqual(runtime.credentialEnvironmentKeys, [], 'Actual Electron cannot inherit provider credentials or Node injection')
    const opening = { attempt: attempt.attempt, pid: attempt.pid, startTicks: attempt.startTicks,
      userData: runtime.userData, homes: runtime.homes, absentHomeKeys: runtime.absentHomeKeys,
      homedir: runtime.homedir, credentialEnvironmentKeys: runtime.credentialEnvironmentKeys }
    return opening
  }
  return {
    async observeOpening(child, ready, event) {
      try {
        event({ kind: 'first-use-attempt', ...attempted(child) })
        const runtime = await ready()
        const opening = validateOpening(runtime)
        const custody = inspect(runtime.userData)
        receipt.openings.push(opening)
        event({ kind: 'first-use-open', ...opening, custody })
        return opening
      } catch (error) {
        if (active) {
          const rejection = { ...active.attempt, message: String(error.message || error) }
          receipt.rejections.push(rejection)
          event({ kind: 'first-use-rejected', ...rejection })
        }
        throw error
      }
    },
    closed(child) {
      assert.ok(active, 'Closing needs its own retained Electron attempt')
      assert.equal(child, active.child, 'Cold reopen must retain the exact Electron ChildProcess object')
      const attempt = active.attempt
      assert.equal(child.pid, attempt.pid)
      assert.ok(Number.isInteger(child.exitCode) || (typeof child.signalCode === 'string' && child.signalCode.length > 0),
        'The old Electron child must report actual exit before reopen')
      let oldIdentityGone = false
      if (attempt.identityCaptured) {
        try { oldIdentityGone = identity(attempt.pid).startTicks !== attempt.startTicks }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; oldIdentityGone = true }
        assert.equal(oldIdentityGone, true, 'The old Electron process identity must be gone before reopening')
      }
      const closure = { ...attempt, openingValidated: receipt.openings.some(row => row.attempt === attempt.attempt),
        exitCode: child.exitCode, signal: child.signalCode, exited: true, oldIdentityGone }
      receipt.closures.push(closure); active = null
      return closure
    },
    finish(userData) {
      receipt.complete = false
      receipt.cleanupComplete = active === null && receipt.attempts.length === receipt.closures.length
        && receipt.closures.every(row => row.exited && row.oldIdentityGone)
      receipt.final = inspect(userData)
      receipt.complete = receipt.cleanupComplete && receipt.attempts.length > 0 && receipt.rejections.length === 0
        && receipt.attempts.length === receipt.openings.length
      return receipt
    },
  }
}

function prepareFirstUseProfile(qaRoot, base = process.env) {
  assert.equal(process.platform, 'linux')
  assert.notEqual(process.getuid(), 0, 'The native fixture must run as its ordinary non-root owner')
  ownedPath(qaRoot, qaRoot, { directory: true })
  const root = path.join(qaRoot, 'profile')
  assert.equal(fs.existsSync(root), false, 'Sterile first-use requires a fresh profile root')
  const profile = prepareSterileProfile(sterileProfileDirectories(root))
  const scrubbed = Object.fromEntries(Object.entries(base).filter(([key]) => !CREDENTIAL_ENV.test(key)))
  const environment = sterileLaunchEnvironment(profile, scrubbed, { systemPathOnly: true, cwd: qaRoot })
  const homes = Object.fromEntries(HOME_KEYS.map(key => [key, environment[key]]))
  for (const [key, file] of Object.entries(homes)) {
    assert.ok(typeof file === 'string' && inside(root, file), 'Every first-use home must be generated: ' + key)
    assert.notEqual(file, os.userInfo().homedir, 'The first-use app cannot receive the owning account home')
    fs.mkdirSync(file, { recursive: true, mode: 0o700 })
    ownedPath(root, file, { directory: true })
  }
  assert.deepEqual(fs.readdirSync(profile.codexHome), [], 'The generated CODEX_HOME must begin empty')
  const receipt = { schemaVersion: 2, kind: 'sterile-first-use', platform: 'linux', qaRoot, root, homes,
    postBootstrapHomes: postBootstrapHomes(homes),
    providerMode: false, credentialSource: null, initialCodexHomeEmpty: true,
    initialPreferences: absent(qaRoot, path.join(qaRoot, 'ToolsEnabled-Page2-QA', 'renderer-prefs.json')),
    attempts: [], openings: [], rejections: [], closures: [], cleanupComplete: false, complete: false }
  const inspect = userData => {
    assert.equal(userData, path.join(qaRoot, 'ToolsEnabled-Page2-QA'), 'Inspect only the exact generated application profile')
    const roots = [root]
    if (fs.existsSync(userData)) roots.push(userData)
    assert.deepEqual(fs.readdirSync(profile.codexHome), [], 'The provider-free CODEX_HOME must remain empty')
    const credentials = roots.map(directory => ({ root: directory, ...scanCredentialNames(directory) }))
    const registry = absent(qaRoot, path.join(userData, 'capability', 'config', 'accounts.json'))
    const ledger = path.join(userData, 'agent-spawn-records.jsonl')
    let starts = 0, ledgerEvidence = { path: ledger, absent: true }
    if (ownedPath(qaRoot, ledger, { missing: true })) {
      const bytes = fs.readFileSync(ledger)
      const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
      starts = rows.filter(row => row.action === 'agent_session_start').length
      ledgerEvidence = { path: ledger, sha256: hash(bytes), bytes: bytes.length, absent: false }
    }
    assert.equal(starts, 0, 'A sterile first-use gesture must not request any provider session')
    return { registry, credentials, starts, ledger: ledgerEvidence, codexHomeEmpty: true }
  }
  return { environment, receipt, inspect, ...createFirstUseLifecycle({ receipt, inspect }) }
}

async function readFirstUseState(context) {
  await context.page.waitForFunction(() => window.mcDurableStorage?.accountReady === true)
  const state = await context.page.evaluate(async keys => {
    const settings = await window.mcSettings.read()
    const accounts = await window.mcProviders.accounts()
    const notice = window.mcPrefsNotice.read()
    return { source: { available: window.mcPrefs.available, file: window.mcPrefs.file,
      accountReady: window.mcDurableStorage.accountReady, signedIn: (await window.mcAccount.current()).signedIn,
      notice: { damaged: notice.damaged, preservedAt: notice.preservedAt, refused: notice.refused } },
      raw: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])),
      host: Object.fromEntries(keys.map(key => [key, window.mcPrefs.read(key)])),
      settings: { ok: settings.ok, available: settings.available, valuesPath: settings.valuesPath,
        approval: settings.rows?.find(row => row.id === 'agent.blocked_question'), rejected: settings.rejected },
      editor: await window.mcSetup.editorSessionState({ discover: false }),
      workspace: await window.mcSetup.workspaceState(),
      accounts: { ok: accounts.ok, damaged: accounts.damaged === true, count: accounts.accounts?.length, policy: accounts.policy },
      tier: window.mcSetup.bootstrap?.tier }
  }, KEYS)
  assert.equal(state.source.available, true); assert.equal(state.source.accountReady, true); assert.equal(state.source.signedIn, false)
  assert.deepEqual(state.source.notice, { damaged: null, preservedAt: null, refused: null })
  assert.equal(state.source.file, path.join(context.paths.userData, 'renderer-prefs.json'))
  const prefs = readOwnedJSON(context.paths.qaRoot, state.source.file)
  assert.equal(prefs.value.storageVersion, 1)
  for (const key of KEYS) {
    assert.equal(prefs.value.values[key] ?? null, state.raw[key], 'Disk and renderer must agree: ' + key)
    assert.deepEqual(state.host[key], { ok: true, value: state.raw[key] }, 'IPC and renderer must agree: ' + key)
  }
  assert.equal(state.settings.ok, true); assert.equal(state.settings.available, true)
  assert.deepEqual(state.settings.rejected, []); assert.equal(state.settings.approval?.present, true)
  // The shell sets TOOLSENABLED_STATE_ROOT=userData/capability. With the
  // sterile launcher's generated LOCALAPPDATA and no settings-path override,
  // the engine's resolveSettingsValuesPath selects this product-specific
  // service leaf, outside userData but still inside the exact owned QA root.
  const settingsPath = path.join(context.paths.qaRoot, 'profile', 'localappdata', path.basename(context.paths.userData), 'settings.json')
  assert.equal(state.settings.valuesPath, settingsPath, 'Settings must report its canonical generated product leaf')
  const settings = readOwnedJSON(context.paths.qaRoot, settingsPath)
  assert.equal(settings.value.values['agent.blocked_question'], state.settings.approval.value)
  const consent = readOwnedJSON(context.paths.qaRoot, path.join(context.paths.userData, 'capability/state/config/ide-session-consent.json'))
  assert.equal(state.editor.ok, true); assert.equal(consent.value.importPolicy, state.editor.importPolicy)
  assert.equal(state.accounts.ok, true); assert.equal(state.accounts.damaged, false); assert.equal(state.accounts.count, 0)
  const protectedValues = Object.fromEntries(Object.entries(prefs.value.values).filter(([key]) => !KEYS.includes(key)).sort(([a], [b]) => a.localeCompare(b)))
  state.disk = { prefs: { file: prefs.file, bytes: prefs.bytes, sha256: prefs.sha256 }, settings, consent,
    protectedSha256: hash(JSON.stringify(protectedValues)) }
  state.profile = JSON.parse(state.raw['mc.setup.profile'])
  state.custody = context.firstUse.inspect(context.paths.userData)
  return state
}

function assertSavedState(state, { autonomy, screens, workspace }) {
  assert.equal(state.profile.status, 'complete'); assert.equal(state.profile.step, 'review')
  assert.equal(state.profile.answers.autonomy, autonomy); assert.equal(state.profile.answers.screens, screens)
  assert.deepEqual(state.profile.answers.workspaceRoots, [workspace])
  assert.equal(state.workspace.ok, true); assert.equal(state.workspace.available, true)
  assert.equal(state.workspace.configured, true); assert.equal(state.workspace.chosen, true); assert.equal(state.workspace.recorded, true)
  assert.equal(state.workspace.tier, 'standard'); assert.deepEqual(state.workspace.roots, [workspace])
  const enabled = autonomy === 'observe' ? [] : ['dispatch', 'report-read', 'agent-session', 'cloud-launch']
  for (const id of FLAG_IDS) assert.equal(state.raw['mc.write.' + id], enabled.includes(id) ? 'enabled' : 'disabled', id)
  assert.equal(state.raw['mc.example'], screens === 'demonstration' ? 'on' : null)
  assert.equal(state.settings.approval.value, autonomy === 'observe' ? 'Stop and wait for me' : 'Switch to other work')
  assert.equal(state.settings.approval.provenance.source, 'user')
  assert.equal(state.editor.importPolicy, autonomy === 'observe' ? 'none' : 'ask')
  assert.equal(state.custody.registry.absent, true); assert.equal(state.custody.starts, 0)
  return state
}

function retainedState(state) {
  return { raw: state.raw, settings: state.disk.settings.sha256, consent: state.disk.consent.sha256,
    protectedSha256: state.disk.protectedSha256, registryAbsent: state.custody.registry.absent }
}

module.exports = { CASE_IDS, GUIDED_CASE_IDS, FLAG_IDS, KEYS, HOME_KEYS, CREDENTIAL_ENV, validateFirstUseOptions, ownedPath, readOwnedJSON,
  scanCredentialNames, processIdentity, postBootstrapHomes, createFirstUseLifecycle, prepareFirstUseProfile,
  readFirstUseState, assertSavedState, retainedState }
