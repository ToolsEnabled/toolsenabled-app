import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let registerSavedDataMaintenanceIpc = () => {}
try { ({ registerSavedDataMaintenanceIpc } = require('../../shell/saved-data-maintenance-ipc.cjs')) }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }
const source = fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
const methods = ['nodeStatusRepairPreview', 'nodeStatusRepairConfirm', 'nodeStatusRollbackPreview', 'nodeStatusRollbackConfirm', 'continuationPrunePreview', 'continuationPruneConfirm']
const channels = ['node-status-repair-preview', 'node-status-repair-confirm', 'node-status-rollback-preview', 'node-status-rollback-confirm', 'continuation-prune-preview', 'continuation-prune-confirm']
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(platform = 'linux') {
  const handlers = new Map(), exposed = {}, calls = [], owner = { isDestroyed: () => false }
  let principal = { kind: 'window', mayWrite: true, owner }, trusted = true, available = true
  const adapter = Object.fromEntries(methods.map(method => [method, async (value, received) => {
    assert.equal(received, principal); calls.push([method, value]); return { ok: true, result: method, value }
  }]))
  registerSavedDataMaintenanceIpc({ capturePolicy: () => ({ ok: true, decision: { required: false } }), ipcMain: { handle(channel, handler) { handlers.set(channel, handler) } },
    getAdapter() { if (!available) throw new Error('private adapter path'); return adapter },
    assertTrustedSender() { if (!trusted) throw Object.assign(new Error('untrusted'), { code: 'UNTRUSTED' }) },
    principalFor: () => principal })
  vm.runInNewContext(source, { process: { platform }, window: { addEventListener() {} },
    require(name) { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, value) { exposed[name] = value } },
      ipcRenderer: { on() {}, removeListener() {}, sendSync() { return {} }, send() {},
        invoke: async (channel, value) => handlers.has(channel) ? handlers.get(channel)({ sender: owner }, value)
          : { ok: false, code: 'UNAVAILABLE' } } } } })
  return { handlers, bridge: exposed.mcAgent, calls, adapter, owner, principal(value) { principal = value },
    untrust() { trusted = false }, unavailable() { available = false } }
}

test('the shipped preload reaches all six native maintenance routes on Linux and Windows', async () => {
  for (const platform of ['linux', 'win32']) {
    const f = fixture(platform)
    for (const method of methods) {
      const input = { previewToken: 'synthetic-preview', stage: 'confirm', token: 'synthetic-token' }
      const result = await f.bridge[method]?.(input)
      assert.equal(result?.ok, true, `${platform}: ${method} did not reach its native route`)
      assert.equal(result.result, method)
      assert.deepEqual(plain(f.calls.at(-1)), [method, input])
    }
  }
})

test('maintenance routes reject relay, read-only, absent, and destroyed person contexts before loading work', async () => {
  const f = fixture()
  for (const principal of [null, { kind: 'relay', mayWrite: true, owner: f.owner },
    { kind: 'window', mayWrite: false, owner: f.owner }, { kind: 'window', mayWrite: true },
    { kind: 'window', mayWrite: true, owner: { isDestroyed: () => true } }]) {
    f.principal(principal)
    for (const channel of channels) {
      const result = await f.handlers.get('mc-agent:' + channel)?.({}, { stage: 'confirm' })
      assert.equal(result?.ok, false)
      assert.equal(result.code, 'MC_SAVED_DATA_PERSON_REQUIRED')
    }
  }
  assert.deepEqual(f.calls, [])
})

test('an untrusted native sender cannot enter any maintenance adapter', async () => {
  const f = fixture(); f.untrust()
  for (const channel of channels) await assert.rejects(() => f.handlers.get('mc-agent:' + channel)({}, {}), { code: 'UNTRUSTED' })
  assert.deepEqual(f.calls, [])
})

test('missing native maintenance modules give a visible coded refusal without leaking native paths', async () => {
  const f = fixture(); f.unavailable()
  const result = await f.bridge.nodeStatusRepairPreview?.({})
  assert.equal(result?.code, 'MC_SAVED_DATA_UNAVAILABLE')
  assert.match(result.reason, /could not load.*kept/)
  assert.doesNotMatch(JSON.stringify(result), /private adapter path/)
})

test('unexpected adapter failure stays a coded visible refusal with no internal text', async () => {
  const f = fixture()
  f.adapter.nodeStatusRepairConfirm = async () => { throw new Error('synthetic-private-error-canary') }
  const result = await f.bridge.nodeStatusRepairConfirm?.({ previewToken: 'synthetic-preview' })
  assert.equal(result?.code, 'MC_SAVED_DATA_UNAVAILABLE')
  assert.match(result.reason, /Review.*before retrying/)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-error-canary/)
})
