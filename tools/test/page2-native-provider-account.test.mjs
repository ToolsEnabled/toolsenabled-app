import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { NAME, guardOwnedPath, assertAccountReadback, assertSessionAccounts, prepareProviderAccount } = require('../lib/page2-native-provider-account.cjs')
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

function accountAnswer(receipt) {
  return { ok: true, damaged: false, accounts: [{ name: NAME, provider: 'codex', directory: receipt.profileHome, signedIn: 'yes' }],
    active: { name: NAME, provider: 'codex', byProvider: { codex: NAME }, chosenByProvider: { codex: NAME } },
    policy: { ok: true, policy: { byProvider: { codex: { selectionMode: 'manual' } } } } }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-selection-fixture-'))
  const accountHome = process.platform === 'win32' ? os.userInfo().homedir : root
  const sourceHome = path.join(root, 'provider-home')
  const qaRoot = path.join(root, 'evidence', 'page2-fixture')
  const userData = path.join(qaRoot, 'ToolsEnabled-Page2-QA')
  fs.mkdirSync(sourceHome)
  fs.mkdirSync(qaRoot, { recursive: true })
  const operations = []
  const originals = new Map()
  for (const name of ['openSync', 'readFileSync', 'writeFileSync', 'copyFileSync', 'linkSync', 'symlinkSync', 'unlinkSync', 'rmSync', 'readdirSync']) {
    const original = fs[name]; originals.set(name, original)
    fs[name] = function(...args) {
      for (const value of args.slice(0, name.endsWith('linkSync') || name === 'copyFileSync' ? 2 : 1)) {
        if (typeof value !== 'string') continue
        operations.push({ name, path: value })
        const relative = path.relative(sourceHome, value)
        assert.ok(relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative)),
          'QA must not perform file operations on the selected provider home')
      }
      return original.apply(this, args)
    }
  }
  t.after(() => {
    for (const [name, original] of originals) fs[name] = original
    fs.rmSync(root, { recursive: true, force: true })
  })
  let chosen, file, stateFile
  const registryModule = {
    accountsRegistryFile: ({ stateRoot }) => path.join(stateRoot, 'accounts.json'),
    accountRotationStateFile: ({ servicesRoot }) => path.join(servicesRoot, 'multi-account-state.json'),
    createAccountRegistryStore(input) {
      ;({ file, stateFile } = input)
      return {
        add(row) {
          chosen = row
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, JSON.stringify({ accounts: [row] }))
          return { ok: true }
        },
        setPolicy() { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, '{}'); return { ok: true } },
        switchTo() { return { ok: true } },
        list() { return accountAnswer({ profileHome: chosen.directory }) },
        activeAccount() { return accountAnswer({ profileHome: chosen.directory }).active },
      }
    },
  }
  const argument = { options: { realProvider: true, codexProfileHome: sourceHome }, accountHome, qaRoot, userData,
    runtime: root, registryModule, environment: { LOCALAPPDATA: path.join(qaRoot, 'profile', 'localappdata') } }
  return { root, sourceHome, qaRoot, userData, argument, operations,
    prepare: () => prepareProviderAccount(argument),
    guard: { accountHome, platform: process.platform, uid: process.getuid?.() } }
}

const started = (sessionId = 'session-one', agentId = 'agent-one', offset = 0) => [
  { sequence: offset + 1, action: 'agent_session_start', sessionId, details: { agentId }, eventHash: digest('start-' + sessionId) },
  { sequence: offset + 2, action: 'agent_session_outcome', sessionId, details: { agentId },
    outcome: { resolves: offset + 1, result: 'started' }, eventHash: digest('outcome-' + sessionId) },
]
const sessionAnswer = () => ({ ok: true, sessions: [{ sessionId: 'session-one', agentId: 'agent-one', account: NAME, provider: 'codex' }] })


test('native selection passes the original provider home in place without any file operation on it', t => {
  const f = fixture(t), prepared = f.prepare()
  assert.equal(f.argument.environment.CODEX_HOME, f.sourceHome)
  assert.equal(prepared.receipt.profileHome, f.sourceHome)
  assert.equal(prepared.receipt.credentialCustody, 'provider-cli-only')
  assert.equal(prepared.receipt.prepared.directory, f.sourceHome)
  const registry = JSON.parse(fs.readFileSync(prepared.receipt.registry.file, 'utf8'))
  assert.equal(registry.accounts[0].directory, f.sourceHome)
  prepared.beginOpen()
  assert.equal(prepared.finish().profileHome, f.sourceHome)
  assert.equal(fs.existsSync(f.sourceHome), true)
  assert.equal(prepared.receipt.staged, undefined)
  assert.equal(prepared.receipt.source, undefined)
})

test('native selection requires real-provider mode and a fresh QA registry', t => {
  const f = fixture(t)
  f.argument.options.realProvider = false
  assert.throws(() => f.prepare(), /requires --real-provider/)
  f.argument.options.realProvider = true
  const prepared = f.prepare()
  const file = prepared.receipt.registry.file
  const bytes = fs.readFileSync(file)
  assert.throws(() => f.prepare(), /fresh QA account stores/)
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('native final checks reject a changed QA account selection', t => {
  const f = fixture(t), prepared = f.prepare()
  fs.writeFileSync(prepared.receipt.registry.file, JSON.stringify({ accounts: [] }))
  assert.throws(() => prepared.finish(), /account list changed/)
})

test('native profile guard rejects paths outside the owning account before metadata probes', () => {
  const asked = []
  const fsImpl = new Proxy({}, { get: (_, name) => (...args) => { asked.push([name, ...args]); throw new Error('unexpected metadata probe') } })
  assert.throws(() => guardOwnedPath('/foreign/provider', { accountHome: '/owning', platform: 'linux', uid: 1000, fsImpl }), /owning account/)
  assert.throws(() => guardOwnedPath('\x43:\\Users\\Other\\provider', { accountHome: '\x43:\\Users\\Owner', platform: 'win32', fsImpl }))
  assert.deepEqual(asked, [])
})

test('account readback retains original directory, provider, sole selection and manual pin', () => {
  const expected = { profileHome: '/selected/provider' }
  assert.equal(assertAccountReadback(accountAnswer(expected), expected).directory, expected.profileHome)
  for (const mutate of [
    row => { row.accounts[0].directory = '/staged/provider' },
    row => { row.accounts[0].provider = 'claude' },
    row => { row.accounts.push({ ...row.accounts[0] }) },
    row => { row.active.chosenByProvider.codex = 'different' },
  ]) {
    const answer = accountAnswer(expected); mutate(answer)
    assert.throws(() => assertAccountReadback(answer, expected))
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
