import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests({ warn: () => {} })
const rotation = require(path.join(engineRoot, 'src/lib/multi-account/rotation.js'))
const { STATUS } = require(path.join(engineRoot, 'src/lib/multi-account/health.js'))
const { readState, activeFor } = require(path.join(engineRoot, 'src/lib/multi-account/switcher.js'))
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function extract(name, async = false) {
  const at = main.indexOf((async ? 'async ' : '') + 'function ' + name + '(')
  const end = main.indexOf('\n}', at)
  assert.ok(at >= 0 && end > at, 'production function is available')
  return main.slice(at, end + 2)
}
function shellResolver(rotationModule = rotation, paths = {}) {
  return new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts',
    'ACCOUNT_HOME_DIR', 'PROVIDER_ISOLATION_REQUESTED', 'ACCOUNT_REGISTRY_FILE',
    extract('resolveSessionAccount', true) + '; return resolveSessionAccount;')(
      () => rotationModule, () => ({ selectionMode: 'manual' }),
      () => paths.servicesRoot || 'synthetic-services', paths.homeDir || 'synthetic-home', false, 'synthetic-registry')
}
function parser() {
  return new Function('agentIpcError', 'MAX_SESSION_ID_LENGTH', 'MAX_SURFACE_LENGTH', 'MAX_CWD_LENGTH',
    'MAX_ACCOUNT_NAME_LENGTH', 'AGENT_EFFORT_VALUES',
    [extract('agentPayload'), extract('boundedAgentString'), extract('parseAgentStart')].join('\n') + '; return parseAgentStart;')(
      (code, message) => { throw Object.assign(new Error(message), { code }) },
      128, 64, 4096, 120, ['low', 'medium', 'high'])
}
function machine() {
  // The resolver uses its real registry/selection/state readers against in-memory files.
  // No credential, provider, host write, or fixture deletion is involved.
  const root = path.join(ownedFixtureTempRoot(), 'synthetic-account-resolver')
  const servicesRoot = path.join(root, 'services'), homeDir = path.join(root, 'homes')
  const statePath = path.join(servicesRoot, 'multi-account-state.json')
  const accounts = ['primary', 'chosen'].map((name, index) => ({
    name, provider: 'codex', profileDir: '.codex-' + name, priority: index + 1,
  }))
  const files = new Map()
  const fsImpl = {
    readFileSync(file) {
      if (path.basename(file) === 'accounts.json') return JSON.stringify({ accounts })
      if (!files.has(String(file))) throw Object.assign(new Error('synthetic absent file'), { code: 'ENOENT' })
      return files.get(String(file))
    },
    mkdirSync() {},
    writeFileSync(file, value) { files.set(String(file), String(value)) },
  }
  const probe = async account => ({ account: account.name, status: STATUS.HEALTHY,
    canServe: true, usedPercent: 4, planType: 'pro', reason: 'synthetic healthy observation' })
  const base = { provider: 'codex', servicesRoot, homeDir, statePath, fsImpl, probe, selectionMode: 'manual' }
  return { base, files, fsImpl, statePath, probe }
}
test('explicit account selection leaves the recorded computer choice and history unchanged', async () => {
  const m = machine()
  assert.equal((await rotation.resolveAccountForSession({ ...m.base, preferred: 'primary' })).account?.name, 'primary')
  const before = m.files.get(m.statePath)
  const selected = await rotation.resolveAccountForSession({ ...m.base, preferred: 'chosen', persistSelection: false })
  assert.equal(selected.account?.name, 'chosen')
  assert.equal(m.files.get(m.statePath), before, 'a slot choice must not rewrite the computer choice/history')
})
test('ordinary selection still records its account with the default options', async () => {
  const m = machine()
  await rotation.resolveAccountForSession({ ...m.base, preferred: 'chosen' })
  assert.equal(activeFor(readState(m.statePath, { fsImpl: m.fsImpl }), 'codex'), 'chosen')
})
test('a deferred slot selection cannot redirect or overwrite a concurrent ordinary start', async () => {
  const m = machine()
  await rotation.resolveAccountForSession({ ...m.base, preferred: 'primary' })
  let entered, release
  const observed = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const slot = rotation.resolveAccountForSession({ ...m.base, preferred: 'chosen', persistSelection: false,
    probe: async account => { entered(); await held; return m.probe(account) } })
  await observed
  const ordinary = await rotation.resolveAccountForSession(m.base)
  assert.equal(ordinary.account?.name, 'primary')
  const recorded = m.files.get(m.statePath)
  release()
  assert.equal((await slot).account?.name, 'chosen')
  assert.equal(m.files.get(m.statePath), recorded, 'late slot completion must not publish a global selection')
})
test('native resolver forwards per-request selection without changing the ordinary request', async () => {
  const requests = []
  const resolve = shellResolver({ ...rotation, ACCOUNT_REQUEST_SELECTION_VERSION: 1,
    resolveAccountForSession: async value => { requests.push(value); return { rotated: true } } })
  await resolve({ provider: 'codex', preferred: 'chosen', exact: true, persistSelection: false })
  assert.equal(requests[0].preferred, 'chosen')
  assert.equal(requests[0].persistSelection, false)
  await resolve({ provider: 'codex' })
  assert.notEqual(requests[1].persistSelection, false)
  assert.equal(requests[1].preferred, undefined)
})
test('native resolver refuses an older engine before its selection can write global state', async () => {
  let calls = 0
  const resolve = shellResolver({ resolveAccountForSession: async () => { calls++; return { rotated: true } } })
  await assert.rejects(resolve({ provider: 'codex', preferred: 'chosen', exact: true, persistSelection: false }),
    { code: 'AGENT_ACCOUNT_SELECTION_UNAVAILABLE' })
  assert.equal(calls, 0)
})
const identity = { requestKeys: { treeAnchors: ['root', 'slot'], threadId: 'slot' },
  treeIdentity: { selfName: 'Builder', managerName: 'Controller' } }
test('native start parser accepts an exact tree account and refuses conflicting or unbound choices', () => {
  const parse = parser()
  let result
  assert.doesNotThrow(() => { result = parse({ sessionId: 'choice', ...identity, treeAccount: 'chosen' }) })
  assert.equal(result.treeAccount, 'chosen')
  for (const patch of [
    { treeIdentity: undefined }, { requestKeys: undefined }, { treeAccount: '' },
    { resumeThreadId: 'old-thread' }, { resumeAccount: 'primary' },
    { accountRetry: { excludeAccounts: [], recheckAttempt: 0 } }, { delegationToken: 'inherited' },
    { accountRecovery: { recoveryId: 'old-recovery' } }, { researchSetup: true },
  ]) assert.throws(() => parse({ sessionId: 'bad', ...identity, treeAccount: 'chosen', ...patch }))
})
async function recordingHost(t, resolver) {
  const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  const engine = require(enginePath)
  let starts = 0
  t.mock.method(engine, 'startCodexSession', async () => {
    starts++
    return { threadId: 'synthetic-thread-' + starts, close() {}, adapter: { interrupt() {}, sendTurn: async () => ({}) } }
  })
  const { createAgentHost } = require('../../shell/agent-host.cjs')
  const host = createAgentHost({ enginePath, defaultCwd: ownedFixtureTempRoot(),
    freeMemory: () => 64 * 1024 * 1024 * 1024,
    confinementPlanner: ({ account } = {}) => ({ account: account?.name || null, ok: true,
      tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    ...(resolver ? { accountResolver: resolver } : {}),
  })
  t.after(() => host.closeAll())
  return { host, starts: () => starts }
}
test('actual host sends the exact slot selector and returns only its selected account', async t => {
  const requests = []
  const h = await recordingHost(t, async request => {
    requests.push(request)
    return { rotated: true, account: { name: request.preferred || 'primary', provider: 'codex' } }
  })
  const result = await h.host.startSession({ sessionId: 'slot-choice', ...identity, treeAccount: 'chosen' })
  assert.equal(result.account, 'chosen')
  assert.equal(requests[0].preferred, 'chosen')
  assert.equal(requests[0].exact, true)
  assert.equal(requests[0].persistSelection, false)
  assert.equal(h.starts(), 1)
})
for (const [label, answer] of [
  ['different account', { rotated: true, account: { name: 'primary', provider: 'codex' } }],
  ['default account', { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' }],
  ['blocked exact account', { rotated: true, blocked: true, account: { name: 'chosen', provider: 'codex' } }],
  ['other provider', { rotated: true, account: { name: 'chosen', provider: 'claude' } }],
  ['unknown provider', { rotated: true, account: { name: 'chosen' } }],
  ['unavailable resolver', null],
]) test('actual host refuses ' + label + ' without spawning a replacement', async t => {
  const h = await recordingHost(t, answer === null ? null : async () => answer)
  await assert.rejects(async () => h.host.startSession({ sessionId: 'refused', ...identity, treeAccount: 'chosen' }))
  assert.equal(h.starts(), 0)
})
test('actual host keeps a held slot selection independent from another session start', async t => {
  const requests = []
  let entered, release
  const observed = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const h = await recordingHost(t, async request => {
    requests.push(request)
    if (request.preferred) { entered(); await held }
    return { rotated: true, account: { name: request.preferred || 'primary', provider: 'codex' } }
  })
  const slot = h.host.startSession({ sessionId: 'held-slot', ...identity, treeAccount: 'chosen' })
  // Do not hang the baseline if it drops the new selector before the resolver.
  await Promise.race([observed, slot])
  const ordinary = await h.host.startSession({ sessionId: 'ordinary' })
  release()
  assert.equal(ordinary.account, 'primary')
  assert.equal((await slot).account, 'chosen')
  assert.equal(requests.find(request => !request.preferred)?.persistSelection, undefined)
  assert.equal(h.starts(), 2)
})
test('actual host refuses a slot selector without a saved tree identity', async t => {
  const h = await recordingHost(t, async () => ({ rotated: true, account: { name: 'chosen', provider: 'codex' } }))
  await assert.rejects(async () => h.host.startSession({ sessionId: 'unbound', treeAccount: 'chosen' }))
  assert.equal(h.starts(), 0)
})

test('actual host and native resolver use the selected account without changing ordinary starts', async t => {
  const m = machine()
  await rotation.resolveAccountForSession({ ...m.base, preferred: 'primary' })
  const before = m.files.get(m.statePath)
  const resolve = shellResolver({ ...rotation,
    resolveAccountForSession: args => rotation.resolveAccountForSession({ ...m.base, ...args }),
  }, m.base)
  const h = await recordingHost(t, resolve)
  const slot = await h.host.startSession({ sessionId: 'bound-choice', ...identity, treeAccount: 'chosen' })
  assert.equal(slot.account, 'chosen')
  assert.equal(m.files.get(m.statePath), before)
  const ordinary = await h.host.startSession({ sessionId: 'bound-ordinary' })
  assert.equal(ordinary.account, 'primary')
  assert.equal(h.starts(), 2)
})

for (const [label, requested, status] of [
  ['unlisted', 'absent', STATUS.HEALTHY],
  ['signed-out', 'chosen', STATUS.SIGNED_OUT],
  ['exhausted', 'chosen', STATUS.EXHAUSTED],
]) test('actual resolver and host refuse a ' + label + ' slot choice without substitution', async t => {
  const m = machine()
  await rotation.resolveAccountForSession({ ...m.base, preferred: 'primary' })
  const before = readState(m.statePath, { fsImpl: m.fsImpl })
  const resolve = shellResolver({ ...rotation,
    resolveAccountForSession: args => rotation.resolveAccountForSession({ ...m.base, ...args,
      probe: async account => account.name === 'chosen'
        ? { account: account.name, status, canServe: status === STATUS.HEALTHY,
          usedPercent: status === STATUS.EXHAUSTED ? 100 : 4, reason: 'synthetic ' + label }
        : m.probe(account),
    }),
  }, m.base)
  const h = await recordingHost(t, resolve)
  await assert.rejects(async () => h.host.startSession({ sessionId: 'bad-choice', ...identity, treeAccount: requested }))
  assert.equal(h.starts(), 0)
  const after = readState(m.statePath, { fsImpl: m.fsImpl })
  assert.deepEqual(after.activeByProvider, before.activeByProvider)
  assert.deepEqual(after.manualPinByProvider, before.manualPinByProvider)
})

test('saved slot account resumes its own thread without a global preference write', async t => {
  const m = machine()
  await rotation.resolveAccountForSession({ ...m.base, preferred: 'primary' })
  const before = m.files.get(m.statePath)
  const requests = []
  const resolve = shellResolver({ ...rotation,
    resolveAccountForSession: args => { requests.push(args); return rotation.resolveAccountForSession({ ...m.base, ...args }) },
  }, m.base)
  const h = await recordingHost(t, resolve)
  const request = parser()({ sessionId: 'resume-choice', ...identity,
    treeAccount: 'chosen', resumeThreadId: 'saved-thread', resumeAccount: 'chosen', resumeThreadProvider: 'codex' })
  const resumed = await h.host.startSession(request)
  assert.equal(resumed.account, 'chosen')
  assert.equal(resumed.threadId, 'saved-thread')
  assert.equal(requests[0].persistSelection, false)
  assert.equal(m.files.get(m.statePath), before)
  assert.equal(h.starts(), 0, 'the native resume must not start a fresh thread')
})
test('a saved slot account cannot redirect a thread that belongs to another account', async t => {
  const h = await recordingHost(t, async () => { assert.fail('mismatched thread must refuse before account lookup') })
  const request = { sessionId: 'wrong-thread-home', ...identity,
    treeAccount: 'chosen', resumeThreadId: 'saved-thread', resumeAccount: 'primary' }
  assert.throws(() => parser()(request), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  await assert.rejects(async () => h.host.startSession(request), { code: 'AGENT_HOST_INVALID_ARGUMENT' })
  assert.equal(h.starts(), 0)
})
