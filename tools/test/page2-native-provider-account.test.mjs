import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { NAME, guardOwnedPath, readCredential, assertAccountReadback, assertSessionAccounts,
  prepareProviderAccount, finalizeProviderAccount } = require('../lib/page2-native-provider-account.cjs')
const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const syntheticId = 'synthetic-qa-account-id'
const syntheticAuth = () => JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { account_id: syntheticId, access_token: 'synthetic-not-a-real-credential' } })

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-account-fixture-'))
  const accountHome = process.platform === 'win32' ? os.userInfo().homedir : root
  const sourceHome = path.join(root, '.codex-fixture')
  const qaRoot = path.join(root, 'evidence', 'page2-fixture')
  const userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  fs.mkdirSync(sourceHome)
  fs.mkdirSync(qaRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceHome, 'auth.json'), syntheticAuth(), { mode: 0o600 })
  const argument = { options: { realProvider: true, codexProfileHome: sourceHome, codexAccountIdSha256: digest(syntheticId) },
    accountHome, qaRoot, userData, runtime, environment: { LOCALAPPDATA: path.join(qaRoot, 'profile', 'localappdata') } }
  const guard = { accountHome, platform: process.platform, uid: process.getuid?.() }
  let prepared = null
  t.after(() => {
    if (prepared?.receipt?.staged?.profileHome) fs.rmSync(prepared.receipt.staged.profileHome, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, sourceHome, qaRoot, userData, argument, guard,
    prepare() { prepared = prepareProviderAccount(argument); return prepared },
    finalize(receipt, extra = {}) { return finalizeProviderAccount(receipt, { qaRoot, accountHome, processesClosed: true, ...extra }) } }
}

function accountAnswer(receipt) {
  return { ok: true, damaged: false, accounts: [{ name: NAME, provider: 'codex', directory: receipt.staged.profileHome, signedIn: 'yes' }],
    active: { name: NAME, provider: 'codex', byProvider: { codex: NAME }, chosenByProvider: { codex: NAME } },
    policy: { ok: true, policy: { byProvider: { codex: { selectionMode: 'manual' } } } } }
}
const started = (sessionId = 'session-one', agentId = 'agent-one', offset = 0) => [
  { sequence: offset + 1, action: 'agent_session_start', sessionId, details: { agentId }, eventHash: digest('start-' + sessionId) },
  { sequence: offset + 2, action: 'agent_session_outcome', sessionId, details: { agentId },
    outcome: { resolves: offset + 1, result: 'started' }, eventHash: digest('outcome-' + sessionId) },
]
const sessionAnswer = () => ({ ok: true, sessions: [{ sessionId: 'session-one', agentId: 'agent-one', account: NAME, provider: 'codex' }] })

test('actual product registry selects a private byte-identical copy without touching the source or ambient default', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.sourceHome, 'auth.json'))
  const ambient = path.join(f.root, 'ambient-default')
  fs.mkdirSync(ambient)
  fs.writeFileSync(path.join(ambient, 'auth.json'), 'synthetic unrelated ambient credential')
  f.argument.environment.CODEX_HOME = ambient
  const prepared = f.prepare(), receipt = prepared.receipt
  assert.equal(receipt.custodyStage, 'prepared')
  assert.equal(receipt.accountIdSha256, digest(syntheticId))
  assert.equal(receipt.source.sha256, receipt.staged.sha256)
  assert.equal(receipt.staged.separateFile, true)
  assert.notDeepEqual([receipt.source.identity.dev, receipt.source.identity.ino], [receipt.staged.identity.dev, receipt.staged.identity.ino])
  assert.ok(!path.relative(f.qaRoot, receipt.staged.profileHome).startsWith('profile' + path.sep))
  assert.deepEqual(fs.readFileSync(receipt.source.file), before)
  assert.equal(fs.readFileSync(path.join(ambient, 'auth.json'), 'utf8'), 'synthetic unrelated ambient credential')
  assert.equal(receipt.prepared.chosenName, NAME)
  assert.equal(receipt.prepared.selectionMode, 'manual')
  const registry = JSON.parse(fs.readFileSync(receipt.registry.file, 'utf8'))
  assert.equal(registry.accounts.length, 1)
  assert.equal(registry.accounts[0].profileDir, receipt.staged.profileHome)
  assert.equal(JSON.stringify(receipt).includes('synthetic-not-a-real-credential'), false)
  const custody = JSON.parse(fs.readFileSync(path.join(f.qaRoot, 'provider-account-custody.json')))
  assert.equal(custody.custodyStage, 'prepared')
  assert.deepEqual(custody.staged, receipt.staged)
  assert.equal(fs.readFileSync(path.join(f.qaRoot, 'provider-account-custody.json'), 'utf8').includes('synthetic-not-a-real-credential'), false)
  const proof = f.finalize(receipt)
  assert.deepEqual(proof.errors, [])
  assert.equal(proof.sourceUnchanged, true)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.equal(proof.generatedCredentialsRemoved, true)
})

test('mismatched expected account refuses before creating a credential copy or registry', t => {
  const f = fixture(t)
  f.argument.options.codexAccountIdSha256 = digest('different-account')
  assert.throws(() => f.prepare(), /not the expected account/)
  assert.equal(fs.existsSync(path.join(f.userData, 'capability/config/accounts.json')), false)
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'provider-account-custody.json')), false)
})

test('explicit selection requires real-provider mode and a full expected account fingerprint', t => {
  const f = fixture(t)
  f.argument.options.realProvider = false
  assert.throws(() => f.prepare(), /requires --real-provider/)
  f.argument.options.realProvider = true
  delete f.argument.options.codexAccountIdSha256
  assert.throws(() => f.prepare(), /expected Codex account-ID/)
  assert.equal(prepareProviderAccount({ options: {} }), null)
})

for (const [label, content] of [
  ['malformed JSON', '{credential:'],
  ['a key-only account', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-key' })],
  ['mixed key billing', JSON.stringify({ ...JSON.parse(syntheticAuth()), OPENAI_API_KEY: 'synthetic-key' })],
  ['missing account ID', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic' } })],
  ['whitespace account ID', JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: ' ', access_token: 'synthetic' } })],
  ['missing access credential', JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: syntheticId } })],
  ['oversized credential', ' '.repeat(1024 * 1024 + 1)],
]) test(`source identity refuses ${label} without exposing credential text`, t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.sourceHome, 'auth.json'), content)
  assert.throws(() => f.prepare(), error => {
    assert.equal(String(error).includes('synthetic-key'), false)
    assert.equal(String(error).includes('synthetic-not-a-real-credential'), false)
    return true
  })
  assert.equal(fs.existsSync(path.join(f.qaRoot, 'provider-account-custody.json')), false)
})

test('the same source inode may have existing product hardlinks but staging never shares it', t => {
  const f = fixture(t)
  fs.linkSync(path.join(f.sourceHome, 'auth.json'), path.join(f.sourceHome, 'existing-product-link.json'))
  const receipt = f.prepare().receipt
  assert.equal(fs.statSync(receipt.source.file).nlink, 2)
  assert.equal(fs.statSync(receipt.staged.file).nlink, 1)
  assert.deepEqual(f.finalize(receipt).errors, [])
})

test('existing QA registries are refused without changing their bytes', t => {
  const f = fixture(t), file = path.join(f.userData, 'capability/config/accounts.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const before = '{"accounts":[{"name":"already owned"}]}'
  fs.writeFileSync(file, before)
  assert.throws(() => f.prepare(), /fresh QA account stores/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('Linux profile guard rejects foreign ownership and dot aliases before credential reads', () => {
  const stat = { uid: 1234, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false }
  assert.throws(() => guardOwnedPath('/home/current/.codex', { accountHome: '/home/current', platform: 'linux', uid: 5555,
    fsImpl: { lstatSync() { return stat } } }), /belong to the invoking account/)
  let calls = 0
  for (const value of ['/home/other/.codex', '/home/current/../other/.codex', '/home/current/.codex/']) {
    assert.throws(() => guardOwnedPath(value, { accountHome: '/home/current', platform: 'linux', uid: 1234,
      fsImpl: { lstatSync() { calls++; throw Error('not allowed') } } }))
  }
  assert.equal(calls, 0)
})

test('Windows foreign and alias sources refuse before any profile probe', () => {
  let calls = 0
  for (const value of ['C:\\Users\\Another\\.codex', '/home/j/.codex-joel', '\\\\?\\C:\\Users\\Current\\.codex', 'C:\\Users\\Current\\short~1\\.codex']) {
    assert.throws(() => guardOwnedPath(value, { accountHome: 'C:\\Users\\Current', platform: 'win32',
      fsImpl: { lstatSync() { calls++; throw Error('must not inspect') } } }))
  }
  assert.equal(calls, 0)
})

test('a selected source cannot redirect its directory or credential through a link', t => {
  const f = fixture(t)
  const alias = path.join(f.root, 'source-alias')
  fs.symlinkSync(f.sourceHome, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readCredential(alias, f.guard), /link|junction/)
  const file = path.join(f.sourceHome, 'auth.json'), real = path.join(f.sourceHome, 'saved-credential.json')
  fs.renameSync(file, real)
  if (process.platform === 'win32') {
    // A directory junction at the credential leaf needs no Windows symlink privilege.
    fs.symlinkSync(f.sourceHome, file, 'junction')
  } else fs.symlinkSync(real, file)
  assert.throws(() => readCredential(f.sourceHome, f.guard), /link|reparse|regular/)
})

test('actual account readback must retain the sole name, private home, provider and manual pin', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  assert.equal(assertAccountReadback(accountAnswer(receipt), receipt).name, NAME)
  for (const mutate of [
    value => { value.ok = false },
    value => { value.damaged = true },
    value => { value.accounts = [] },
    value => { value.accounts.push(structuredClone(value.accounts[0])) },
    value => { value.accounts[0].name = 'wrong' },
    value => { value.accounts[0].provider = 'claude' },
    value => { value.accounts[0].directory = f.sourceHome },
    value => { value.accounts[0].signedIn = 'unknown' },
    value => { value.active.name = 'wrong' },
    value => { value.active.provider = 'claude' },
    value => { value.active.byProvider.codex = 'wrong' },
    value => { value.active.chosenByProvider = {} },
    value => { value.policy.ok = false },
    value => { value.policy.policy.byProvider.codex.selectionMode = 'priority' },
  ]) {
    const value = accountAnswer(receipt); mutate(value)
    assert.throws(() => assertAccountReadback(value, receipt))
  }
})

test('successful still-open session identity binds to the exact start/outcome and saved node', () => {
  const evidence = { records: started(), savedNodes: [{ id: 'agent-one', sessionId: 'session-one' }] }
  const bound = assertSessionAccounts(sessionAnswer(), evidence)
  assert.equal(bound.required.length, 1)
  assert.equal(bound.required[0].savedNodeMatched, true)
  assert.equal(bound.required[0].outcomeSequence, 2)
  assert.equal(bound.required[0].startHash, evidence.records[0].eventHash)
  for (const mutate of [
    answer => { answer.ok = false },
    answer => { answer.sessions = [] },
    answer => { answer.sessions.push(structuredClone(answer.sessions[0])) },
    answer => { answer.sessions[0].sessionId = 'wrong-session' },
    answer => { answer.sessions[0].agentId = 'wrong-agent' },
    answer => { answer.sessions[0].account = 'wrong-account' },
    answer => { answer.sessions[0].provider = 'claude' },
  ]) {
    const answer = sessionAnswer(); mutate(answer)
    assert.throws(() => assertSessionAccounts(answer, evidence))
  }
})

test('closed, refused and earlier app-generation starts do not invent current live account rows', () => {
  const records = started()
  const closed = [...records, { sequence: 3, action: 'agent_session_end', sessionId: 'session-one', details: { agentId: 'agent-one' }, end: { resolves: 1 } }]
  assert.deepEqual(assertSessionAccounts({ ok: true, sessions: [] }, { records: closed }).required, [])
  const refused = structuredClone(records); refused[1].outcome.result = 'refused'
  assert.deepEqual(assertSessionAccounts({ ok: true, sessions: [] }, { records: refused }).required, [])
  assert.deepEqual(assertSessionAccounts({ ok: true, sessions: [] }, { records, afterSequence: 2 }).required, [])
  const wrongEnd = structuredClone(closed); wrongEnd[2].end.resolves = 2
  assert.throws(() => assertSessionAccounts({ ok: true, sessions: [] }, { records: wrongEnd }), /own actual account receipt/)
  const wrongAgent = structuredClone(closed); wrongAgent[2].details.agentId = 'different-agent'
  assert.throws(() => assertSessionAccounts({ ok: true, sessions: [] }, { records: wrongAgent }), /own actual account receipt/)
  assert.throws(() => assertSessionAccounts({ ok: true, sessions: [] }, { records: [...closed, { ...closed[2], sequence: 4 }] }), /ambiguous signed endings/)
  const second = [...records, ...started('session-two', 'agent-two', 2)]
  assert.throws(() => assertSessionAccounts(sessionAnswer(), { records: second }), /own actual account receipt/)
})

test('native verification refuses an absent successful-session row through its actual read-only consumer', async t => {
  const f = fixture(t), prepared = f.prepare()
  prepared.beginOpen()
  const records = started().map(row => ({ ...row, at: '2026-09-08T00:00:00.000Z' }))
  fs.writeFileSync(path.join(f.userData, 'agent-spawn-records.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n')
  const entries = records.toReversed().map(row => ({ sequence: row.sequence, at: row.at, action: row.action, sessionId: row.sessionId,
    principal: null, outcome: row.outcome ?? null, usage: null, end: null }))
  const page = { async evaluate(fn) {
    if (fn.toString().includes('mcProviders.accounts')) return accountAnswer(prepared.receipt)
    return { savedNodes: [{ id: 'agent-one', sessionId: 'session-one' }], accounts: { ok: true, sessions: [] },
      history: { ok: true, verified: true, total: records.length, entries } }
  } }
  await assert.rejects(prepared.verify(page, 'after:root-start'), /own actual account receipt/)
  assert.equal(prepared.receipt.checks.length, 0)
})

test('post-guardian cleanup removes both refreshed staged auth and generated hardlinks while preserving the original', t => {
  const f = fixture(t), prepared = f.prepare(), receipt = prepared.receipt
  const generated = path.join(receipt.servicesRoot, 'agent-home', '@agents', 'agent-one', 'codex', 'standard', 'selected')
  fs.mkdirSync(generated, { recursive: true })
  const target = path.join(generated, 'auth.json')
  fs.linkSync(receipt.staged.file, target)
  // A provider refresh can atomically replace its staged source without changing accounts.
  const refreshed = JSON.stringify({ ...JSON.parse(syntheticAuth()), last_refresh: '2026-09-08T00:00:00Z' })
  fs.writeFileSync(receipt.staged.file + '.tmp', refreshed)
  fs.renameSync(receipt.staged.file + '.tmp', receipt.staged.file)
  assert.equal(prepared.finish().credentials.length, 1)
  const proof = f.finalize(receipt)
  assert.deepEqual(proof.errors, [])
  assert.equal(proof.sourceUnchanged, true)
  assert.equal(proof.stagedAuthSha256, digest(refreshed))
  assert.equal(proof.removedGeneratedAuthFiles.length, 1)
  assert.equal(proof.removedGeneratedAuthFiles[0].file, target)
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.existsSync(receipt.staged.profileHome), false)
  assert.equal(fs.readFileSync(receipt.source.file, 'utf8'), syntheticAuth())
})

test('cleanup refuses before proven custody closure and retains all credential names', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  assert.throws(() => f.finalize(receipt, { processesClosed: false }), /independently proven process closure/)
  assert.equal(fs.existsSync(receipt.staged.file), true)
})

test('the durable allocation receipt exists before the first credential write and survives a preparation refusal', t => {
  const f = fixture(t), write = fs.writeFileSync
  let allocated = null
  fs.writeFileSync = function (target, ...args) {
    if (typeof target === 'string' && path.basename(target) === 'auth.json' && target !== path.join(f.sourceHome, 'auth.json')) {
      allocated = JSON.parse(fs.readFileSync(path.join(f.qaRoot, 'provider-account-custody.json'), 'utf8'))
      assert.equal(allocated.custodyStage, 'allocated')
      assert.equal(allocated.staged.file, target)
      assert.equal(allocated.source.accountIdSha256, digest(syntheticId))
      assert.equal(fs.existsSync(target), false)
      throw Error('synthetic preparation refusal')
    }
    return write.call(fs, target, ...args)
  }
  try { assert.throws(() => f.prepare(), /synthetic preparation refusal/) } finally { fs.writeFileSync = write }
  assert.ok(allocated)
  assert.equal(fs.existsSync(allocated.staged.profileHome), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.qaRoot, 'provider-account-custody.json'))).custodyStage, 'removed-before-launch')
  assert.equal(fs.readFileSync(path.join(f.sourceHome, 'auth.json'), 'utf8'), syntheticAuth())
})

test('an interrupted allocation with no staged auth still cleans its exact temporary directory without account proof', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  fs.unlinkSync(receipt.staged.file)
  receipt.custodyStage = 'allocated'
  delete receipt.staged.separateFile
  const proof = f.finalize(receipt)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.equal(proof.generatedCredentialsRemoved, true)
  assert.equal(proof.sourceUnchanged, true)
  assert.equal(proof.stagedAccountIdSha256, null)
  assert.ok(proof.errors.length > 0, 'Incomplete preparation cannot earn an account identity pass')
})

test('cleanup rejects a substituted temp inode, foreign run or expanded removal scope', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  for (const mutate of [
    value => { value.qaRoot = path.dirname(f.qaRoot) },
    value => { value.servicesRoot = f.sourceHome },
    value => { value.staged.profileHome = f.sourceHome },
    value => { value.staged.directoryIdentity.ino = (BigInt(value.staged.directoryIdentity.ino) + 1n).toString() },
  ]) {
    const value = structuredClone(receipt); mutate(value)
    assert.throws(() => f.finalize(value))
    assert.equal(fs.existsSync(receipt.staged.file), true)
    assert.equal(fs.existsSync(receipt.source.file), true)
  }
})

test('source drift remains a failed proof even though owned cleanup still completes', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  const changed = JSON.stringify({ ...JSON.parse(syntheticAuth()), last_refresh: 'source-changed' })
  fs.writeFileSync(receipt.source.file, changed)
  const proof = f.finalize(receipt)
  assert.equal(proof.sourceUnchanged, false)
  assert.match(proof.errors.join('\n'), /original provider credential changed/)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.equal(fs.readFileSync(receipt.source.file, 'utf8'), changed)
})

test('wrong generated account stays a failure while its owned credential name is removed', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  const generated = path.join(receipt.servicesRoot, 'agent-home', 'wrong-account')
  fs.mkdirSync(generated, { recursive: true })
  const wrong = JSON.parse(syntheticAuth()); wrong.tokens.account_id = 'unexpected-synthetic-account'
  fs.writeFileSync(path.join(generated, 'auth.json'), JSON.stringify(wrong))
  const proof = f.finalize(receipt)
  assert.match(proof.errors.join('\n'), /different account/)
  assert.equal(proof.generatedCredentialsRemoved, true)
})

test('malformed generated credentials refuse identity proof without retaining their owned names or temporary source', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  for (const [index, text] of ['', '{broken', ' '.repeat(1024 * 1024 + 1)].entries()) {
    const generated = path.join(receipt.servicesRoot, 'agent-home', 'bad-' + index)
    fs.mkdirSync(generated, { recursive: true })
    fs.writeFileSync(path.join(generated, 'auth.json'), text)
  }
  const proof = f.finalize(receipt)
  assert.ok(proof.errors.length >= 3)
  assert.equal(proof.removedGeneratedAuthFiles.length, 3)
  assert.equal(proof.generatedCredentialsRemoved, true)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.equal(proof.sourceUnchanged, true)
})

test('same-account generated credentials still fail if they share the protected original inode', t => {
  const f = fixture(t), prepared = f.prepare(), receipt = prepared.receipt
  const generated = path.join(receipt.servicesRoot, 'agent-home', 'wrong-source')
  fs.mkdirSync(generated, { recursive: true })
  fs.linkSync(receipt.source.file, path.join(generated, 'auth.json'))
  assert.throws(() => prepared.finish(), /share the original account inode/)
  const proof = f.finalize(receipt)
  assert.match(proof.errors.join('\n'), /shares the original account inode/)
  assert.equal(proof.generatedCredentialsRemoved, true)
  assert.equal(fs.readFileSync(receipt.source.file, 'utf8'), syntheticAuth())
})

test('actual Codex bootstrap link names are ignored without traversing them or hiding generated auth', t => {
  const f = fixture(t), prepared = f.prepare(), receipt = prepared.receipt
  const home = path.join(receipt.servicesRoot, 'agent-home', '@agents', 'agent-one', 'codex', 'standard', 'selected')
  const bootstrap = path.join(home, 'tmp', 'arg0', 'codex-arg0AY841u')
  fs.mkdirSync(bootstrap, { recursive: true })
  const generated = path.join(home, 'auth.json')
  fs.linkSync(receipt.staged.file, generated)
  const outside = path.join(f.root, 'unrelated-canary')
  fs.mkdirSync(outside)
  const foreignAuth = path.join(outside, 'auth.json'), marker = path.join(outside, 'do-not-change')
  fs.writeFileSync(foreignAuth, 'synthetic foreign authentication must never be scanned')
  fs.writeFileSync(marker, 'synthetic foreign target canary')
  const names = ['codex-execve-wrapper', 'codex-linux-sandbox', 'applypatch', 'apply_patch']
  for (const [index, name] of names.entries()) {
    const sourceTarget = index % 2 === 0
    const target = process.platform === 'win32'
      ? (sourceTarget ? f.sourceHome : outside)
      : (sourceTarget ? receipt.source.file : foreignAuth)
    fs.symlinkSync(target, path.join(bootstrap, name), process.platform === 'win32' ? 'junction' : 'file')
  }
  // A directory link must also remain opaque, even if its target has auth.json.
  const directoryLink = path.join(bootstrap, 'unrelated-directory')
  fs.symlinkSync(outside, directoryLink, process.platform === 'win32' ? 'junction' : 'dir')
  const observed = prepared.finish()
  assert.deepEqual(observed.credentials.map(row => row.file), [generated])
  const proof = f.finalize(receipt)
  assert.deepEqual(proof.errors, [])
  assert.equal(proof.generatedCredentialsRemoved, true)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.deepEqual(proof.removedGeneratedAuthFiles.map(row => row.file), [generated])
  assert.equal(fs.existsSync(generated), false)
  for (const name of [...names, 'unrelated-directory']) assert.equal(fs.lstatSync(path.join(bootstrap, name)).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(receipt.source.file, 'utf8'), syntheticAuth())
  assert.equal(fs.readFileSync(foreignAuth, 'utf8'), 'synthetic foreign authentication must never be scanned')
  assert.equal(fs.readFileSync(marker, 'utf8'), 'synthetic foreign target canary')
})

for (const destination of ['original', 'unrelated', 'absent']) {
  test(`a generated auth link to an ${destination} target refuses identity but cleanup removes only its owned leaf`, t => {
    const f = fixture(t), prepared = f.prepare(), receipt = prepared.receipt
    const goodHome = path.join(receipt.servicesRoot, 'agent-home', 'ordinary-session')
    const badHome = path.join(receipt.servicesRoot, 'agent-home', 'linked-session')
    fs.mkdirSync(goodHome, { recursive: true })
    fs.mkdirSync(badHome, { recursive: true })
    const good = path.join(goodHome, 'auth.json'), linked = path.join(badHome, 'auth.json')
    fs.linkSync(receipt.staged.file, good)
    const outside = path.join(f.root, 'unrelated-canary')
    fs.mkdirSync(outside)
    const foreignAuth = path.join(outside, 'auth.json')
    fs.writeFileSync(foreignAuth, 'synthetic foreign credential canary')
    const target = process.platform === 'win32'
      ? (destination === 'original' ? f.sourceHome : destination === 'unrelated' ? outside : path.join(f.root, 'absent-directory'))
      : (destination === 'original' ? receipt.source.file : destination === 'unrelated' ? foreignAuth : path.join(f.root, 'absent-auth'))
    fs.symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'file')
    const linkIdentity = fs.lstatSync(linked, { bigint: true })
    assert.throws(() => prepared.finish(), /auth|link/i)
    const proof = f.finalize(receipt)
    assert.ok(proof.errors.length > 0, 'A linked credential cannot earn account identity credit')
    assert.equal(proof.generatedCredentialsRemoved, true)
    assert.equal(proof.stagedProfileRemoved, true)
    assert.equal(proof.sourceUnchanged, true)
    assert.deepEqual(proof.removedGeneratedAuthFiles.map(row => row.file).sort(), [good, linked].sort())
    const removed = proof.removedGeneratedAuthFiles.find(row => row.file === linked)
    assert.match(removed.identityError, /auth.*link|link.*auth/i)
    assert.equal(removed.symbolicLink, true)
    assert.equal(removed.sha256, null)
    assert.equal(removed.accountIdSha256, null)
    assert.equal(removed.identity.dev, String(linkIdentity.dev))
    assert.equal(removed.identity.ino, String(linkIdentity.ino))
    assert.throws(() => fs.lstatSync(linked), { code: 'ENOENT' })
    assert.equal(fs.existsSync(good), false)
    assert.equal(fs.readFileSync(receipt.source.file, 'utf8'), syntheticAuth())
    assert.equal(fs.readFileSync(foreignAuth, 'utf8'), 'synthetic foreign credential canary')
    if (destination === 'absent') assert.equal(fs.existsSync(target), false)
  })
}

test('cleanup retains a substituted auth link instead of unlinking a different leaf inode', t => {
  const f = fixture(t), receipt = f.prepare().receipt
  const generated = path.join(receipt.servicesRoot, 'agent-home', 'linked-session')
  fs.mkdirSync(generated, { recursive: true })
  const linked = path.join(generated, 'auth.json'), oldLink = path.join(f.root, 'retained-old-link')
  const outside = path.join(f.root, 'unrelated-canary')
  fs.mkdirSync(outside)
  const foreignAuth = path.join(outside, 'auth.json')
  fs.writeFileSync(foreignAuth, 'synthetic unrelated target canary')
  const linkType = process.platform === 'win32' ? 'junction' : 'file'
  fs.symlinkSync(process.platform === 'win32' ? f.sourceHome : receipt.source.file, linked, linkType)
  const lstat = fs.lstatSync
  let probes = 0, proof
  fs.lstatSync = function (file, ...args) {
    if (file === linked && ++probes === 2) {
      fs.renameSync(linked, oldLink)
      fs.symlinkSync(process.platform === 'win32' ? outside : foreignAuth, linked, linkType)
    }
    return lstat.call(fs, file, ...args)
  }
  try { proof = f.finalize(receipt) } finally { fs.lstatSync = lstat }
  assert.ok(probes >= 2, 'The remover must inspect the exact leaf again after scanning it')
  assert.match(proof.errors.join('\n'), /could not be removed/)
  assert.equal(proof.generatedCredentialsRemoved, false)
  assert.equal(proof.stagedProfileRemoved, true)
  assert.deepEqual(proof.removedGeneratedAuthFiles, [])
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true)
  assert.equal(fs.lstatSync(oldLink).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(receipt.source.file, 'utf8'), syntheticAuth())
  assert.equal(fs.readFileSync(foreignAuth, 'utf8'), 'synthetic unrelated target canary')
})

test('the visible setup may mirror a global policy while the exact account list and Codex manual choice stay fixed', t => {
  const f = fixture(t), prepared = f.prepare(), receipt = prepared.receipt
  const { createAccountRegistryStore } = require('../../shell/account-registry.cjs')
  const store = createAccountRegistryStore({ file: receipt.registry.file, stateFile: receipt.registry.stateFile,
    servicesRoot: receipt.servicesRoot, homedir: () => f.argument.accountHome })
  store.setPolicy({ selectionMode: 'priority' })
  assert.equal(assertAccountReadback(store.list(), receipt, store.activeAccount()).selectionMode, 'manual')
  assert.notEqual(prepared.finish().registrySha256, receipt.registry.sha256)
  const changed = JSON.parse(fs.readFileSync(receipt.registry.file))
  changed.accounts[0].profileDir = f.sourceHome
  fs.writeFileSync(receipt.registry.file, JSON.stringify(changed))
  assert.throws(() => prepared.finish(), /account list changed/)
})
