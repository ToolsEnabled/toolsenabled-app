'use strict'

// A caller-selected provider home is used in place. Account receipts describe
// QA registry and session identities; only the official CLI handles sign-in.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { guardWindowsPath } = require('./page2-native-paths.cjs')
const { servicesRootForSelectedIdentity } = require('./sterile-launch.cjs')
const NAME = 'QA selected Codex'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const inside = (root, value, api = path) => {
  const relative = api.relative(root, value)
  return relative && !api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + api.sep)
}

function guardOwnedPath(value, { accountHome, platform = process.platform, uid = process.getuid?.(),
  expectedType = 'directory', allowMissing = false, fsImpl = fs } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix
  assert.ok(typeof value === 'string' && api.isAbsolute(value) && !value.includes('\0'), 'An explicit absolute provider profile path is required')
  assert.ok(typeof accountHome === 'string' && api.isAbsolute(accountHome), 'The operating-system account home is required')
  // Refuse foreign Windows paths before even inspecting an ancestor. The
  // maintained guard also rejects aliases, device paths and junctions.
  if (platform === 'win32') {
    const selected = guardWindowsPath(value, { accountHome, platform, expectedType, allowMissing, requireProfile: true, fsImpl })
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
    if (stat.isFile()) assert.equal(stat.nlink, 1, 'A QA metadata file cannot be hard-linked')
  }
  assert.equal(fsImpl.realpathSync(value), value, 'The provider path must be canonical')
  return value
}

function assertAccountReadback(answer, expected, active = answer?.active) {
  assert.equal(answer?.ok, true, 'The actual account registry must answer successfully')
  assert.equal(answer.damaged, false, 'A damaged account registry cannot authorize native starts')
  assert.equal(answer.accounts?.length, 1, 'Only the explicitly selected QA provider account may be listed')
  const row = answer.accounts[0]
  assert.equal(row.name, NAME, 'The account registry must retain the exact QA selection')
  assert.equal(row.provider, 'codex', 'The selected QA account must be Codex')
  assert.equal(row.directory, expected.profileHome, 'The provider must use the caller-selected home in place')
  assert.equal(row.signedIn, 'yes', 'The provider account store must report the selected sign-in')
  assert.equal(active?.name, NAME, 'The active account must be the selected QA account')
  assert.equal(active.provider, 'codex', 'The active program must be Codex')
  assert.equal(active.byProvider?.codex, NAME, 'The active Codex account must be the selected QA account')
  assert.equal(active.chosenByProvider?.codex, NAME, 'The explicit Codex account choice must be retained')


  return { name: row.name, provider: row.provider, directory: row.directory, signedIn: row.signedIn,
    activeName: active.name, chosenName: active.chosenByProvider.codex }
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

function prepareProviderAccount({ options, accountHome, qaRoot, userData, runtime, environment,
  platform = process.platform, uid = process.getuid?.(), registryModule: suppliedRegistry }) {
  if (options.codexProfileHome === undefined) return null
  assert.ok(options.realProvider, 'An explicit Codex profile requires --real-provider')
  const guard = { accountHome, platform, uid }
  const profileHome = guardOwnedPath(options.codexProfileHome, guard)
  environment.CODEX_HOME = profileHome
  for (const directory of [qaRoot, userData]) {
    guardOwnedPath(directory, { ...guard, allowMissing: true })
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    guardOwnedPath(directory, guard)
  }
  const servicesRoot = servicesRootForSelectedIdentity({ env: environment, selectedUserData: userData, platform })
  assert.ok(inside(qaRoot, servicesRoot), 'The selected account state must stay inside this QA run')
  const registryModule = suppliedRegistry || require(path.join(runtime, 'shell/account-registry.cjs'))
  const file = registryModule.accountsRegistryFile({ stateRoot: path.join(userData, 'capability') })
  const stateFile = registryModule.accountRotationStateFile({ servicesRoot })
  for (const target of [file, stateFile]) {
    assert.ok(inside(qaRoot, target), 'The selected account registry must stay inside this QA run')
    guardOwnedPath(target, { ...guard, allowMissing: true, expectedType: 'file' })
    assert.equal(fs.existsSync(target), false, 'Explicit provider preparation requires fresh QA account stores')
  }
  const store = registryModule.createAccountRegistryStore({ file, stateFile, servicesRoot, homedir: () => accountHome })
  assert.equal(store.add({ name: NAME, provider: 'codex', directory: profileHome }).ok, true)
  assert.equal(store.switchTo({ name: NAME, provider: 'codex' }).ok, true)
  const receipt = { schemaVersion: 2, provider: 'codex', name: NAME, qaRoot, servicesRoot, profileHome,
    credentialCustody: 'provider-cli-only', registry: null, opens: [], checks: [], finalCheck: null }
  receipt.prepared = assertAccountReadback(store.list(), receipt, store.activeAccount())
  const registryBytes = fs.readFileSync(file)
  receipt.registry = { file, sha256: hash(registryBytes),
    accountsSha256: hash(JSON.stringify(JSON.parse(registryBytes).accounts)), stateFile }
  const ledgerFile = path.join(userData, 'agent-spawn-records.jsonl')
  function ledgerBytes() {
    guardOwnedPath(ledgerFile, { ...guard, expectedType: 'file', allowMissing: true })
    if (!fs.existsSync(ledgerFile)) return Buffer.alloc(0)
    assert.ok(fs.statSync(ledgerFile).size <= 64 * 1024 * 1024, 'The owned provider start ledger exceeds its bounded size')
    return fs.readFileSync(ledgerFile)
  }
  function checkFiles() {
    guardOwnedPath(file, { ...guard, expectedType: 'file' })
    // 1.0.50 keeps no automatic-switching state, so this file may never be written.
    guardOwnedPath(stateFile, { ...guard, expectedType: 'file', allowMissing: true })
    const registryBytes = fs.readFileSync(file)
    assert.equal(hash(JSON.stringify(JSON.parse(registryBytes).accounts)), receipt.registry.accountsSha256,
      'The explicitly selected QA account list changed during the run')
    return { registrySha256: hash(registryBytes), profileHome, credentialCustody: 'provider-cli-only' }
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

module.exports = { NAME, guardOwnedPath, assertAccountReadback, assertSessionAccounts, prepareProviderAccount }
