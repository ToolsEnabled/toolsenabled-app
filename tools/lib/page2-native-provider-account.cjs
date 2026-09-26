'use strict'

// Explicit QA preparation through the product's existing named-account store.
// Credential bytes stay in memory and a private temporary profile, never in a
// receipt. The provider may refresh that copy; it never receives the source home.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { guardWindowsPath } = require('./page2-native-paths.cjs')
const { servicesRootForSelectedIdentity } = require('./sterile-launch.cjs')
const NAME = 'QA selected Codex'
const LIMIT = 1024 * 1024
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const MAX_FILE_ID = (1n << 64n) - 1n
function assertFileKey(value) {
  for (const key of ['dev', 'ino']) {
    assert.ok(typeof value?.[key] === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value[key])
      && BigInt(value[key]) <= MAX_FILE_ID, 'File identity requires exact canonical decimal strings')
  }
  return value
}
function fileKey(stat) {
  for (const key of ['dev', 'ino']) assert.ok(typeof stat[key] === 'bigint' && stat[key] >= 0n
    && stat[key] <= MAX_FILE_ID, 'File identity must come directly from exact BigInt stat values')
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}
function statNumber(value) {
  assert.ok(typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER),
    'File metadata must be exactly representable before conversion to a number')
  return Number(value)
}
function credentialIdentity(stat) {
  return { ...fileKey(stat), uid: statNumber(stat.uid), mode: statNumber(stat.mode) }
}
const sameFile = (left, right) => Boolean(left && right && assertFileKey(left) && assertFileKey(right)
  && left.dev === right.dev && left.ino === right.ino)
const inside = (root, value, api = path) => {
  const relative = api.relative(root, value)
  return relative && !api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + api.sep)
}

function guardOwnedPath(value, { accountHome, platform = process.platform, uid = process.getuid?.(),
  expectedType = 'directory', allowMissing = false, allowHardlink = false, fsImpl = fs } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix
  assert.ok(typeof value === 'string' && api.isAbsolute(value) && !value.includes('\0'), 'An explicit absolute provider profile path is required')
  assert.ok(typeof accountHome === 'string' && api.isAbsolute(accountHome), 'The operating-system account home is required')
  // Refuse foreign Windows paths before even inspecting an ancestor. The
  // maintained guard also rejects aliases, device paths and junctions.
  if (platform === 'win32') {
    // The product can already have hard-linked an auth.json into a confined
    // home. Guard the containing path before inspecting that exact leaf; this
    // read-only exception neither follows links nor relaxes the shared guard.
    let selected
    if (allowHardlink) {
      assert.ok(expectedType === 'file' && api.basename(value) === 'auth.json', 'Only an existing authentication leaf may have product-owned hard links')
      const directory = guardWindowsPath(api.dirname(value), { accountHome, platform,
        expectedType: 'directory', requireProfile: true, fsImpl })
      selected = api.join(directory, 'auth.json')
      const stat = fsImpl.lstatSync(selected)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'The selected credential must be a regular file without a reparse point')
    } else selected = guardWindowsPath(value, { accountHome, platform, expectedType, allowMissing, requireProfile: true, fsImpl })
    assert.ok(inside(accountHome, selected, api), 'The provider path must be below the owning profile')
    return selected
  }
  assert.equal(api.resolve(value), value, 'The provider path cannot contain dot segments or aliases')
  assert.ok(inside(accountHome, value, api), 'The provider path must be below the owning account home')
  assert.ok(Number.isInteger(uid) && uid > 0, 'Native provider preparation requires the owning non-root UID')
  const parts = api.relative(accountHome, value).split(api.sep)
  let current = accountHome
  const targets = [accountHome, ...parts.map(part => (current = api.join(current, part)))]
  for (const [index, target] of targets.entries()) {
    let stat
    try { stat = fsImpl.lstatSync(target) } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return value
      throw new Error('The owned provider path could not be inspected')
    }
    assert.equal(stat.isSymbolicLink(), false, 'Provider paths cannot follow a link')
    assert.equal(stat.uid, uid, 'Provider paths must belong to the invoking account')
    assert.ok(index < targets.length - 1 || expectedType === 'directory' ? stat.isDirectory() : stat.isFile(), 'A provider path has the wrong type')
    if (stat.isFile() && !allowHardlink) assert.equal(stat.nlink, 1, 'A QA metadata or staged credential file cannot be hard-linked')
  }
  assert.equal(fsImpl.realpathSync(value), value, 'The provider path must be canonical')
  return value
}

function readCredential(profileHome, options, { allowHardlink = false } = {}) {
  const api = options.platform === 'win32' ? path.win32 : path
  guardOwnedPath(profileHome, options)
  const file = guardOwnedPath(api.join(profileHome, 'auth.json'), { ...options, expectedType: 'file', allowHardlink })
  const before = fs.lstatSync(file, { bigint: true })
  assert.ok(before.size > 0n && before.size <= BigInt(LIMIT), 'The selected credential must be a bounded nonempty regular file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let bytes, opened
  try {
    opened = fs.fstatSync(fd, { bigint: true })
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size,
      'The selected credential changed before its owned read')
    bytes = Buffer.alloc(statNumber(before.size))
    let read = 0
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read)
      assert.ok(count > 0, 'The selected credential changed during its owned read')
      read += count
    }
    const after = fs.fstatSync(fd, { bigint: true })
    assert.ok(after.size === opened.size && after.mtimeNs === opened.mtimeNs && after.ctimeNs === opened.ctimeNs,
      'The selected credential changed during its owned read')
  } finally { fs.closeSync(fd) }
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('The selected credential is not a readable authentication record') }
  assert.equal(parsed?.auth_mode, 'chatgpt', 'Explicit native account selection requires an existing ChatGPT sign-in')
  assert.ok(!parsed.OPENAI_API_KEY, 'Explicit native account selection cannot select metered API-key billing')
  const id = parsed?.tokens?.account_id
  assert.ok(typeof id === 'string' && id.length > 0 && id.length <= 512 && id.trim() === id,
    'The selected sign-in has no unambiguous account identity')
  assert.ok(typeof parsed.tokens.access_token === 'string' && parsed.tokens.access_token.length > 0,
    'The selected sign-in has no access credential')
  return { bytes, stat: opened, receipt: { file, sha256: hash(bytes), bytes: bytes.length, accountIdSha256: hash(id),
    identity: credentialIdentity(opened) } }
}

function assertAccountReadback(answer, expected, active = answer?.active) {
  assert.equal(answer?.ok, true, 'The actual account registry must answer successfully')
  assert.equal(answer.damaged, false, 'A damaged account registry cannot authorize native starts')
  assert.equal(answer.accounts?.length, 1, 'Only the explicitly selected QA provider account may be listed')
  const row = answer.accounts[0]
  assert.equal(row.name, NAME, 'The account registry must retain the exact QA selection')
  assert.equal(row.provider, 'codex', 'The selected QA account must be Codex')
  assert.equal(row.directory, expected.staged.profileHome, 'The provider must use the private QA credential copy')
  assert.equal(row.signedIn, 'yes', 'The real account store must find the staged sign-in')
  assert.equal(active?.name, NAME, 'The active account must be the selected QA account')
  assert.equal(active.provider, 'codex', 'The active program must be Codex')
  assert.equal(active.byProvider?.codex, NAME, 'The active Codex account must be the selected QA account')
  assert.equal(active.chosenByProvider?.codex, NAME, 'The explicit Codex account choice must be retained')
  assert.equal(answer.policy?.ok, true, 'The actual account selection policy must be readable')
  assert.equal(answer.policy.policy?.byProvider?.codex?.selectionMode, 'manual', 'The owned QA account must use the supported manual selection policy')
  return { name: row.name, provider: row.provider, directory: row.directory, signedIn: row.signedIn,
    activeName: active.name, chosenName: active.chosenByProvider.codex, selectionMode: 'manual' }
}

function assertSessionAccounts(answer, { records = [], afterSequence = 0, savedNodes = [] } = {}) {
  assert.equal(answer?.ok, true, 'The actual session-account surface must answer successfully')
  assert.ok(Array.isArray(answer.sessions), 'The actual session-account surface must return its sessions')
  const seen = new Set()
  const sessions = answer.sessions.map(row => {
    assert.ok(typeof row.sessionId === 'string' && row.sessionId && !seen.has(row.sessionId), 'Each account receipt must name one distinct real session')
    seen.add(row.sessionId)
    assert.ok(typeof row.agentId === 'string' && row.agentId, 'Each account receipt must name its declared agent')
    assert.equal(row.account, NAME, 'Every provider session must retain the explicitly selected QA account')
    assert.equal(row.provider, 'codex', 'Every tested provider session must use the selected Codex provider')
    return { sessionId: row.sessionId, agentId: row.agentId, account: row.account, provider: row.provider }
  })
  const required = []
  for (const start of records.filter(row => row.action === 'agent_session_start' && row.sequence > afterSequence)) {
    const outcomes = records.filter(row => row.action === 'agent_session_outcome' && row.outcome?.resolves === start.sequence)
    assert.ok(outcomes.length <= 1, 'A start cannot have ambiguous account-binding outcomes')
    const outcome = outcomes[0]
    if (outcome?.outcome?.result !== 'started') continue
    assert.ok(outcome.sequence > start.sequence && outcome.sessionId === start.sessionId
      && outcome.details?.agentId === start.details?.agentId, 'The successful outcome must retain its original agent and session')
    // main.cjs retains the original start receipt in session.started. An END
    // resolves that intent sequence, exactly as the real recorder requires.
    const endings = records.filter(row => row.action === 'agent_session_end' && row.sessionId === start.sessionId
      && row.end?.resolves === start.sequence && row.details?.agentId === start.details?.agentId
      && row.sequence > outcome.sequence)
    assert.ok(endings.length <= 1, 'A session cannot have ambiguous signed endings')
    if (endings.length === 1) continue
    const row = sessions.find(row => row.sessionId === start.sessionId)
    assert.ok(row, 'Every still-open successful start needs its own actual account receipt')
    assert.equal(row.agentId, start.details?.agentId, 'The account receipt must name the actual started agent')
    const saved = savedNodes.filter(node => node.id === row.agentId && node.sessionId === row.sessionId)
    assert.ok(saved.length <= 1, 'A saved session identity cannot belong to duplicate fleet nodes')
    required.push({ sessionId: row.sessionId, agentId: row.agentId, startSequence: start.sequence,
      outcomeSequence: outcome.sequence, startHash: start.eventHash, outcomeHash: outcome.eventHash,
      savedNodeMatched: saved.length === 1 })
  }
  return { sessions, required }
}

function generatedCredentials(servicesRoot, guard, { forCleanup = false } = {}) {
  const root = path.join(servicesRoot, 'agent-home')
  guardOwnedPath(root, { ...guard, allowMissing: true })
  if (!fs.existsSync(root)) return []
  const found = [], queue = [root]
  let entries = 0
  while (queue.length) {
    const directory = queue.pop()
    guardOwnedPath(directory, guard)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 100000, 'The owned generated credential inventory exceeded its bound')
      const target = path.join(directory, entry.name)
      const stat = fs.lstatSync(target, { bigint: true })
      if (stat.isSymbolicLink()) {
        // Codex creates ordinary bootstrap links in tmp/arg0. This inventory
        // concerns only auth.json: never traverse or read unrelated links.
        if (entry.name !== 'auth.json') continue
        const identityError = 'Generated auth.json cannot be a symbolic link'
        assert.ok(forCleanup, identityError)
        // Retain the link's own metadata, not its target or credential bytes.
        // The post-guardian remover rechecks the owned parent and this inode.
        found.push({ file: target, bytes: statNumber(stat.size), sha256: null, accountIdSha256: null, symbolicLink: true,
          identity: credentialIdentity(stat), identityError })
        continue
      }
      if (stat.isDirectory()) queue.push(target)
      else if (entry.name === 'auth.json') {
        try {
          const credential = readCredential(directory, guard, { allowHardlink: true })
          credential.bytes.fill(0)
          found.push(credential.receipt)
        } catch (error) {
          if (!forCleanup) throw error
          // Bad credential contents refuse identity credit but cannot keep an
          // otherwise proven owned regular-file name from being removed after
          // process closure. No invalid bytes enter the returned receipt.
          guardOwnedPath(target, { ...guard, expectedType: 'file', allowHardlink: true })
          found.push({ file: target, bytes: statNumber(stat.size), sha256: null, accountIdSha256: null,
            identity: credentialIdentity(stat), identityError: error.message })
        }
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file))
}

// Called by the outer maintained runner only after its process guardian has
// independently proved every owned process closed. application.close() alone
// does not establish that custody boundary, so the native driver never calls
// this. Paths remain bounded to the exact fresh run and recorded temp inode.
function finalizeProviderAccount(receipt, { qaRoot, accountHome, processesClosed = false,
  platform = process.platform, uid = process.getuid?.() } = {}) {
  assert.equal(processesClosed, true, 'Credential removal requires independently proven process closure')
  assert.equal(receipt?.schemaVersion, 1)
  assert.equal(receipt.provider, 'codex')
  assert.equal(receipt.name, NAME)
  assert.equal(receipt.qaRoot, qaRoot, 'Credential cleanup must name this exact native run')
  assertFileKey(receipt.source?.identity)
  assertFileKey(receipt.staged?.directoryIdentity)
  if (receipt.staged?.identity) assertFileKey(receipt.staged.identity)
  const guard = { accountHome, platform, uid }
  guardOwnedPath(qaRoot, guard)
  const expectedServices = path.join(qaRoot, 'profile', 'localappdata', 'ToolsEnabled-Page2-QA')
  assert.equal(receipt.servicesRoot, expectedServices, 'Only this run’s generated account homes may be cleaned')
  const parent = platform === 'win32' ? path.join(accountHome, 'AppData', 'Local', 'Temp') : path.join(accountHome, '.cache')
  const stagedHome = receipt.staged?.profileHome
  assert.equal(path.dirname(stagedHome), parent, 'Credential cleanup cannot leave the owning temporary directory')
  assert.match(path.basename(stagedHome), /^toolsenabled-native-account-[A-Za-z0-9]{6}$/, 'Only a fresh QA credential directory may be removed')
  guardOwnedPath(stagedHome, guard)
  const stat = fs.lstatSync(stagedHome, { bigint: true })
  assert.ok(sameFile(fileKey(stat), receipt.staged.directoryIdentity),
    'The temporary credential directory changed identity before cleanup')
  const problems = []
  let sourceSha256 = null, sourceIdentity = null, stagedAuthSha256 = null, stagedAccountIdSha256 = null
  try {
    const source = readCredential(receipt.profileHome, guard, { allowHardlink: true })
    source.bytes.fill(0)
    sourceSha256 = source.receipt.sha256
    sourceIdentity = source.receipt.identity
    if (source.receipt.file !== receipt.source.file || sourceSha256 !== receipt.source.sha256
        || !sameFile(sourceIdentity, receipt.source.identity)
        || source.receipt.accountIdSha256 !== receipt.expectedAccountIdSha256) problems.push('The original provider credential changed during the QA run')
  } catch (error) { problems.push(error.message) }
  try {
    const staged = readCredential(stagedHome, guard, { allowHardlink: true })
    staged.bytes.fill(0)
    stagedAuthSha256 = staged.receipt.sha256
    stagedAccountIdSha256 = staged.receipt.accountIdSha256
    if (stagedAccountIdSha256 !== receipt.expectedAccountIdSha256) problems.push('The staged provider credential changed account identity')
    if (sameFile(staged.receipt.identity, sourceIdentity) || sameFile(staged.receipt.identity, receipt.source.identity)) {
      problems.push('The staged provider credential shares the original account inode')
    }
  } catch (error) { problems.push(error.message) }
  let credentials = []
  try { credentials = generatedCredentials(expectedServices, guard, { forCleanup: true }) }
  catch (error) { problems.push(error.message) }
  const removedGeneratedAuthFiles = []
  for (const credential of credentials) {
    if (credential.identityError) problems.push(credential.identityError)
    if (credential.accountIdSha256 !== receipt.expectedAccountIdSha256) problems.push('A generated credential used a different account')
    if (sameFile(credential.identity, sourceIdentity) || sameFile(credential.identity, receipt.source.identity)) {
      problems.push('A generated credential shares the original account inode')
    }
    try {
      assert.ok(inside(path.join(expectedServices, 'agent-home'), credential.file)
        && path.basename(credential.file) === 'auth.json', 'Only an owned generated auth.json leaf may be removed')
      guardOwnedPath(path.dirname(credential.file), guard)
      const current = fs.lstatSync(credential.file, { bigint: true })
      assert.ok(sameFile(fileKey(current), credential.identity), 'The generated credential changed before removal')
      assert.equal(current.isSymbolicLink(), credential.symbolicLink === true, 'The generated credential changed type before removal')
      if (platform !== 'win32') assert.equal(current.uid, BigInt(guard.uid), 'Generated credential names must belong to the invoking account')
      if (!credential.symbolicLink) assert.equal(current.isFile(), true, 'Only a regular generated credential or its rejected link may be removed')
      fs.unlinkSync(credential.file)
      removedGeneratedAuthFiles.push(credential)
    }
    catch { problems.push('An owned generated credential name could not be removed') }
  }
  try {
    guardOwnedPath(stagedHome, guard)
    const current = fs.lstatSync(stagedHome, { bigint: true })
    assert.ok(current.dev === stat.dev && current.ino === stat.ino, 'The staged directory changed before removal')
    fs.rmSync(stagedHome, { recursive: true, force: false })
  } catch { problems.push('The owned temporary credential profile could not be removed') }
  let generatedCredentialsRemoved = false
  try { generatedCredentialsRemoved = generatedCredentials(expectedServices, guard, { forCleanup: true }).length === 0 }
  catch (error) { problems.push(error.message) }
  return { schemaVersion: 1, provider: 'codex', qaRoot, stagedProfileHome: stagedHome,
    processesClosed: true, sourceSha256, sourceIdentity,
    sourceUnchanged: sourceSha256 === receipt.source.sha256 && sameFile(sourceIdentity, receipt.source.identity),
    stagedAuthSha256, stagedAccountIdSha256,
    stagedProfileRemoved: !fs.existsSync(stagedHome), removedGeneratedAuthFiles,
    generatedCredentialsRemoved, errors: problems }
}

function prepareProviderAccount({ options, accountHome, qaRoot, userData, runtime, environment,
  platform = process.platform, uid = process.getuid?.() }) {
  const supplied = options.codexProfileHome !== undefined || options.codexAccountIdSha256 !== undefined
  if (!supplied) return null
  assert.ok(options.realProvider, 'An explicit Codex profile requires --real-provider')
  assert.match(options.codexAccountIdSha256 || '', /^[a-f0-9]{64}$/, 'An explicit expected Codex account-ID SHA-256 is required')
  const guard = { accountHome, platform, uid }
  const requestedProfileHome = options.codexProfileHome
  const profileHome = guardOwnedPath(requestedProfileHome, guard)
  // A source may already have product-owned hard links from another live
  // confined session. This read follows no link and never writes that inode.
  const source = readCredential(profileHome, guard, { allowHardlink: true })
  assert.equal(source.receipt.accountIdSha256, options.codexAccountIdSha256,
    'The explicitly selected provider profile is not the expected account')
  for (const directory of [qaRoot, userData]) {
    guardOwnedPath(directory, { ...guard, allowMissing: true })
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    guardOwnedPath(directory, guard)
  }
  const servicesRoot = servicesRootForSelectedIdentity({ env: environment, selectedUserData: userData, platform })
  assert.ok(inside(qaRoot, servicesRoot), 'The selected account state must stay inside this QA run')
  const registryModule = require(path.join(runtime, 'shell/account-registry.cjs'))
  const file = registryModule.accountsRegistryFile({ stateRoot: path.join(userData, 'capability') })
  const stateFile = registryModule.accountRotationStateFile({ servicesRoot })
  for (const target of [file, stateFile]) {
    assert.ok(inside(qaRoot, target), 'The selected account registry must stay inside this QA run')
    guardOwnedPath(target, { ...guard, allowMissing: true, expectedType: 'file' })
    assert.equal(fs.existsSync(target), false, 'Explicit provider preparation requires fresh QA account stores')
  }
  const temporaryParent = platform === 'win32' ? path.join(accountHome, 'AppData', 'Local', 'Temp') : path.join(accountHome, '.cache')
  guardOwnedPath(temporaryParent, { ...guard, allowMissing: true })
  fs.mkdirSync(temporaryParent, { recursive: true, mode: 0o700 })
  guardOwnedPath(temporaryParent, guard)
  assert.ok(!inside(qaRoot, temporaryParent) && temporaryParent !== qaRoot, 'Credentials must be staged outside the evidence directory')
  const stagedHome = fs.mkdtempSync(path.join(temporaryParent, 'toolsenabled-native-account-'))
  fs.chmodSync(stagedHome, 0o700)
  const directoryStat = fs.lstatSync(stagedHome, { bigint: true })
  const receipt = { schemaVersion: 1, provider: 'codex', name: NAME, qaRoot, servicesRoot, requestedProfileHome, profileHome,
    expectedAccountIdSha256: options.codexAccountIdSha256, accountIdSha256: source.receipt.accountIdSha256,
    source: source.receipt, staged: { profileHome: stagedHome, file: path.join(stagedHome, 'auth.json'),
      directoryIdentity: fileKey(directoryStat) },
    custodyStage: 'allocated', registry: null, prepared: null, opens: [], checks: [], finalCheck: null,
    cleanup: { required: true, completed: false, scope: 'after-guardian-process-closure' } }
  const custodyFile = path.join(qaRoot, 'provider-account-custody.json')
  function retainCustody() {
    // The initial durable receipt precedes the first credential write. If the
    // outer guardian interrupts preparation, it can still find the exact temp
    // inode for cleanup; this receipt never counts as a native result.
    const temporary = custodyFile + '.tmp'
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, custodyFile)
    if (platform === 'linux') {
      const directory = fs.openSync(qaRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    }
  }
  let store
  try {
    guardOwnedPath(stagedHome, guard)
    assert.equal(fs.existsSync(custodyFile), false, 'The native provider custody receipt must be fresh')
    retainCustody()
    const authFile = path.join(stagedHome, 'auth.json')
    fs.writeFileSync(authFile, source.bytes, { flag: 'wx', mode: 0o600 })
    const staged = readCredential(stagedHome, guard)
    assert.ok(staged.stat.dev !== source.stat.dev || staged.stat.ino !== source.stat.ino,
      'The staged credential must not share the original account inode')
    assert.equal(staged.receipt.sha256, source.receipt.sha256, 'The staged credential must retain the verified source bytes')
    receipt.staged = { profileHome: stagedHome, ...staged.receipt, separateFile: true,
      directoryIdentity: fileKey(directoryStat) }
    staged.bytes.fill(0)
    store = registryModule.createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => accountHome })
    assert.equal(store.add({ name: NAME, provider: 'codex', directory: stagedHome }).ok, true)
    assert.equal(store.setPolicy({ provider: 'codex', selectionMode: 'manual' }).ok, true)
    assert.equal(store.switchTo({ name: NAME, provider: 'codex' }).ok, true)
    receipt.prepared = assertAccountReadback(store.list(), receipt, store.activeAccount())
    const registryBytes = fs.readFileSync(file)
    receipt.registry = { file, sha256: hash(registryBytes), accountsSha256: hash(JSON.stringify(JSON.parse(registryBytes).accounts)),
      stateFile, stateSha256: hash(fs.readFileSync(stateFile)) }
    receipt.custodyStage = 'prepared'
    retainCustody()
  } catch (error) {
    if (options.retainProviderCredentials === true) {
      // The caller may authorize scratch cleanup while excluding credentials.
      // Preserve this owned copy on failure as well as after a normal run.
      receipt.custodyStage = 'preserved-before-launch'
    } else {
      fs.rmSync(stagedHome, { recursive: true, force: true })
      receipt.custodyStage = 'removed-before-launch'
    }
    if (fs.existsSync(custodyFile)) retainCustody()
    throw error
  } finally { source.bytes.fill(0) }

  function sourceUnchanged() {
    const now = readCredential(profileHome, guard, { allowHardlink: true })
    now.bytes.fill(0)
    assert.equal(now.receipt.sha256, receipt.source.sha256, 'The original provider credential changed during the QA run')
    assert.ok(sameFile(now.receipt.identity, receipt.source.identity), 'The original provider credential changed inode during the QA run')
    return now.receipt
  }
  const ledgerFile = path.join(userData, 'agent-spawn-records.jsonl')
  function ledgerBytes() {
    guardOwnedPath(ledgerFile, { ...guard, expectedType: 'file', allowMissing: true })
    if (!fs.existsSync(ledgerFile)) return Buffer.alloc(0)
    assert.ok(fs.statSync(ledgerFile).size <= 64 * 1024 * 1024, 'The owned provider start ledger exceeds its bounded size')
    return fs.readFileSync(ledgerFile)
  }
  function checkFiles() {
    const source = sourceUnchanged()
    const sourceSha256 = source.sha256
    guardOwnedPath(file, { ...guard, expectedType: 'file' })
    guardOwnedPath(stateFile, { ...guard, expectedType: 'file' })
    const registryBytes = fs.readFileSync(file)
    // Setup may mirror its visible failover answer into the global policy.
    // The account list and Codex-specific manual pin must remain exact; the
    // real readback below owns that policy assertion on every native check.
    assert.equal(hash(JSON.stringify(JSON.parse(registryBytes).accounts)), receipt.registry.accountsSha256,
      'The explicitly selected QA account list changed during the run')
    const staged = readCredential(stagedHome, guard, { allowHardlink: true })
    staged.bytes.fill(0)
    assert.equal(staged.receipt.accountIdSha256, receipt.accountIdSha256, 'The QA provider changed the selected account identity')
    assert.ok(!sameFile(staged.receipt.identity, source.identity) && !sameFile(staged.receipt.identity, receipt.source.identity),
      'The QA credential cannot share the original account inode')
    const credentials = generatedCredentials(servicesRoot, guard)
    for (const credential of credentials) {
      assert.equal(credential.accountIdSha256, receipt.accountIdSha256, 'A generated session credential belongs to a different provider account')
      assert.ok(!sameFile(credential.identity, source.identity) && !sameFile(credential.identity, receipt.source.identity),
        'A generated session credential cannot share the original account inode')
    }
    return { sourceSha256, sourceIdentity: source.identity, stagedAuthSha256: staged.receipt.sha256,
      stagedIdentity: staged.receipt.identity, registrySha256: hash(registryBytes), credentials }
  }
  return {
    receipt,
    beginOpen() {
      const bytes = ledgerBytes()
      const records = bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
      const opening = { index: receipt.opens.length + 1, at: new Date().toISOString(),
        afterSequence: records.length ? records.at(-1).sequence : 0, ledgerSha256: hash(bytes) }
      receipt.opens.push(opening)
      return opening
    },
    async verify(page, phase) {
      const files = checkFiles()
      const answer = await page.evaluate(() => window.mcProviders.accounts())
      const readback = assertAccountReadback(answer, receipt)
      const ledgerBefore = ledgerBytes()
      const snapshot = await page.evaluate(async needsHistory => {
        const savedNodes = []
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index)
          if (!key?.startsWith('mc.fleet.trees.v1:')) continue
          for (const node of JSON.parse(localStorage.getItem(key))?.nodes || []) {
            savedNodes.push({ id: node.id, sessionId: node.sessionId ?? null })
          }
        }
        return { savedNodes, accounts: await window.mcAgent.sessionAccounts(),
          history: needsHistory ? await window.mcAgent.history({ limit: 200 }) : null }
      }, ledgerBefore.length > 0)
      const ledgerAfter = ledgerBytes()
      assert.ok(ledgerBefore.equals(ledgerAfter), 'The owned session ledger must remain stable around the account identity read')
      let records = [], ledgerSha256 = hash(ledgerBefore), verifiedHistoryTotal = 0
      if (ledgerBefore.length) {
        const verified = require('./page2-native-functions-scenarios.cjs').assertVerifiedSessionSnapshot({
          history: snapshot.history, ledgerBefore, ledgerAfter })
        ;({ records, ledgerSha256, verifiedHistoryTotal } = verified)
      }
      const afterSequence = receipt.opens.at(-1)?.afterSequence
      assert.ok(Number.isSafeInteger(afterSequence), 'The account observation must belong to an actual QA app opening')
      const bound = assertSessionAccounts(snapshot.accounts, { records, afterSequence, savedNodes: snapshot.savedNodes })
      if (!ledgerBefore.length) assert.equal(bound.sessions.length, 0, 'An empty start ledger cannot authorize an existing session')
      const observation = { phase, at: new Date().toISOString(), opening: receipt.opens.at(-1).index,
        ...files, readback, ...bound, ledgerSha256, verifiedHistoryTotal }
      receipt.checks.push(observation)
      return observation
    },
    finish() { receipt.finalCheck = { at: new Date().toISOString(), ...checkFiles() }; return receipt.finalCheck },
  }
}

module.exports = { NAME, guardOwnedPath, readCredential, assertAccountReadback, assertSessionAccounts, prepareProviderAccount, finalizeProviderAccount }
