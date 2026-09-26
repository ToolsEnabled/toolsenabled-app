import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'
import { createRequire } from 'node:module'
import { riskConsent } from '../../src/unrestricted-consent.js'
const require = createRequire(import.meta.url)
const { auditedTierChoice } = require('../../shell/tier-consent.cjs')

const root = process.env.PERMISSION_SOURCE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const main = readFileSync(resolve(root, 'shell/main.cjs'), 'utf8')
const preload = readFileSync(resolve(root, 'shell/fleet-profile-preload.cjs'), 'utf8')
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit))
    else if (value && typeof value === 'object') walk(value, visit)
  }
}
function host() {
  let bootstrap, registration
  walk(parseAst(main), node => {
    if (node.type === 'FunctionDeclaration' && node.id.name === 'setupBootstrapReply') bootstrap = node
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.name === 'ipcMain' && node.callee.property.name === 'handle'
        && node.arguments[0]?.value === 'mc-setup:tier-state') registration = node
  })
  assert.ok(bootstrap && registration, 'the host must expose a fresh permission read')
  const reads = [], handlers = new Map()
  let answer = { ok: true, available: true, configured: true, tier: 'standard', tiers: ['guided', 'standard', 'unrestricted'] }
  let failure = null
  const context = vm.createContext({
    trustedFleetProfileSender: event => event.trusted === true,
    readTierState() { reads.push(true); if (failure) throw failure; return answer },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  })
  vm.runInContext(main.slice(bootstrap.start, bootstrap.end) + '\n' + main.slice(registration.start, registration.end), context)
  return { reads, set(value) { answer = value }, fail(value) { failure = value },
    read: event => handlers.get('mc-setup:tier-state')(event) }
}
test('fresh handler rereads actual state on each request; sender refusal never reads', async () => {
  const h = host()
  assert.equal((await h.read({ trusted: true })).tier, 'standard')
  h.set({ ok: true, available: true, configured: true, tier: 'guided', tiers: ['guided', 'standard', 'unrestricted'] })
  assert.equal((await h.read({ trusted: true })).tier, 'guided')
  assert.equal(h.reads.length, 2)
  const refused = await h.read({ trusted: false })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'MC_SETUP_SENDER_REFUSED')
  assert.equal(h.reads.length, 2)
})
test('unreadable, absent and thrown state remain named refusals rather than default permissions', async () => {
  const h = host()
  h.set({ ok: true, available: true, unreadable: true, configured: false, tier: null, code: 'SETUP_MACHINE_RECORD_UNREADABLE' })
  assert.equal((await h.read({ trusted: true })).unreadable, true)
  h.set(null)
  assert.equal((await h.read({ trusted: true })).code, 'MC_SETUP_STATE_ABSENT')
  h.fail(new Error('fixture read failure'))
  const failed = await h.read({ trusted: true })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'MC_SETUP_STATE_FAILED')
})
test('actual preload tierState crosses IPC each time without rereading its frozen bootstrap', async () => {
  let expose
  walk(parseAst(preload), node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.name === 'contextBridge' && node.callee.property.name === 'exposeInMainWorld'
        && node.arguments[0]?.value === 'mcSetup') expose = node
  })
  assert.ok(expose)
  const calls = []
  let setupBridge, tier = 'standard'
  const context = vm.createContext({
    Object, process: { platform: 'linux' }, setup: Object.freeze({ tier: 'guided' }),
    contextBridge: { exposeInMainWorld(_name, bridge) { setupBridge = bridge } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { tier } } },
  })
  vm.runInContext(preload.slice(expose.start, expose.end), context)
  assert.equal(typeof setupBridge.tierState, 'function')
  assert.equal((await setupBridge.tierState()).tier, 'standard')
  tier = 'unrestricted'
  assert.equal((await setupBridge.tierState()).tier, 'unrestricted')
  assert.deepEqual(calls, [['mc-setup:tier-state'], ['mc-setup:tier-state']])
  assert.equal(setupBridge.bootstrap.tier, 'guided')
})

test('actual choose-tier handler preserves host state, consent, audit ordering and setter binding', async () => {
  let registration
  walk(parseAst(main), node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.name === 'ipcMain' && node.callee.property.name === 'handle'
        && node.arguments[0]?.value === 'mc-setup:choose-tier') registration = node
  })
  assert.ok(registration)
  let handler, tier = 'standard'
  const calls = []
  const context = vm.createContext({
    ipcMain: { handle: (_name, fn) => { handler = fn } },
    withFleetProfileSender: (event, fn) => event.trusted ? fn() : { ok: false, code: 'MC_SETUP_SENDER_REFUSED' },
    readTierState: () => ({ configured: true, tier, tiers: ['guided', 'standard', 'unrestricted'] }),
    auditedTierChoice,
    captureAuditPolicy: () => ({ ok: true, decision: { required: true } }),
    accountPrincipal: () => 'fixture-principal',
    WORKSPACE_ROOT: 'fixture-dispatch',
    CAPABILITY_STATE_ROOT: 'fixture-capability-state',
    recordTier(requested, options) { calls.push({ kind: 'write', requested, root: options.dispatchRoot }); tier = requested; return { ok: true, tier } },
    async recordCanonical(action, target, details) { calls.push({ kind: 'audit', action, target, details }); return { ok: true, sequence: calls.length } },
  })
  vm.runInContext(main.slice(registration.start, registration.end), context)
  assert.equal((await handler({ trusted: false }, 'unrestricted', riskConsent({ confirmed: true }))).code, 'MC_SETUP_SENDER_REFUSED')
  assert.equal((await handler({ trusted: true }, 'unrestricted', null)).code, 'SETUP_UNRESTRICTED_UNCONFIRMED')
  assert.equal(calls.length, 0)
  const result = await handler({ trusted: true }, 'unrestricted', riskConsent({ confirmed: true }))
  assert.equal(result.ok, true)
  assert.equal(tier, 'unrestricted')
  assert.deepEqual(calls.map(call => call.kind), ['audit', 'write', 'audit'])
  assert.equal(calls[0].action, 'setup.tier.choose.intent')
  assert.equal(calls[0].details.from, 'standard')
  assert.equal(calls[0].details.riskConfirmed, true)
  assert.equal(calls[1].root, 'fixture-dispatch')
  assert.equal(calls[2].action, 'setup.tier.choose')
})
