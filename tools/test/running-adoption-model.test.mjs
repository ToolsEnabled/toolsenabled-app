import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentHost } from '../../shell/agent-host.cjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { adoptStandaloneIntoTree } from '../../src/tree-standalone-adoption.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const require = createRequire(import.meta.url)
const ENGINE = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(ENGINE)
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

async function mounted(t, initial, { unselected = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'running-adoption-model-'))
  const { document, restore } = installDomStandIn()
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const root = document.createElement('div'); document.body.appendChild(root)
  const launches = [], sends = [], receipts = [], listeners = new Set()
  const adapter = { sendTurn: async request => { sends.push(request); return { turnId: 'turn-' + sends.length } },
    interrupt: async () => {}, answerApproval() {} }
  t.mock.method(engine, 'startCodexSession', async request => {
    launches.push(request); return { adapter, threadId: 'running-thread', close() {} }
  })
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: directory,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  host.onEvent(packet => { for (const fn of listeners) fn(packet) })
  const bridge = { availability: async () => ({ ok: true }),
    ownerContext: async () => ({ version: 1, ownerId: 'fixture-owner', currentEpoch: 'fixture-epoch', kind: 'local' }),
    onOwnerContextChanged: () => () => {},
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    start: request => host.startSession(unselected ? { sessionId: request.sessionId } : request),
    send: request => host.sendTurn(request), close: request => host.closeSession(request),
    interrupt: request => host.interrupt(request),
    adoptTreeAddress: request => { const result = host.adoptTreeAddress(request); receipts.push(result); return result },
  }
  const panel = mountStandaloneAgent(root, { id: 'standalone-model-seat', live: true, bridge, start: initial,
    transcript: { bind: async () => ({ ok: true }), release: async () => ({ ok: true, released: true }) } })
  let saved = null
  const store = createFleetTreeStore({ computerId: 'running-model', storage: {
    read: () => saved, write: (_key, value) => { saved = structuredClone(value); return true },
  } })
  t.after(async () => {
    panel.dispose(); await host.closeAll(); restore()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    rmSync(directory, { recursive: true, force: true })
  })
  await settle()
  const input = root.querySelector('.chat-input textarea')
  input.value = 'Work on the existing conversation.'; input.dispatch('input')
  root.querySelector('.chat-send').click(); await settle()
  assert.equal(sends.length, 1, root.textContent)
  return { panel, store, receipts, launches, sends, saved: () => saved, async adopt() {
    return adoptStandaloneIntoTree({ store, session: panel, bridge,
      identityFor: node => ({ selfName: 'Worker', treeKey: node.id,
        requestKeys: { treeAnchors: [node.id], threadId: node.id } }),
      bindSession: node => ({ getStartOptions: () => ({ tier: store.getNode(node.id).tier }), onSessionChange() {} }),
    })
  } }
}

for (const [name, initial, pending] of [
  ['exact A survives a pending catalog choice', { tier: 'astra', model: ' vendor/exact:A ', effort: 'high' }, { tier: 'luna', effort: 'low' }],
  ['exact A survives pending exact B', { tier: 'astra', model: 'vendor/exact:A', effort: 'high' }, { tier: 'astra', model: 'vendor/exact:B', effort: 'low' }],
  ['a running Codex model replaces a pending Claude model', { tier: 'astra', model: 'vendor/codex:A', effort: 'high' }, { tier: 'claude-sonnet', model: 'vendor/claude:B', effort: 'low' }],
]) test(name + ' through mounted standalone and the actual host receipt', async t => {
  const f = await mounted(t, initial)
  assert.equal(f.panel.chooseStart(pending).ok, true)
  assert.deepEqual(f.panel.chosenStart(), pending)
  const result = await f.adopt()
  assert.equal(result.ok, true, result.sentence)
  assert.equal(f.receipts[0].model, initial.model, 'the host receipt lost the live exact ID')
  const node = f.store.getNode(result.nodeId)
  assert.equal(node.model, initial.model)
  assert.equal(node.tier, initial.tier)
  assert.equal(node.effort, initial.effort)
  const reopened = createFleetTreeStore({ computerId: 'running-model', storage: { read: () => f.saved(), write: () => true } })
  assert.equal(reopened.getNode(node.id).model, initial.model, 'the circle survives a store reopen with the actual model')
  assert.equal(f.sends.length, 1, 'placement sends no extra provider turn')
})

test('an explicitly unselected running model clears a pending exact model on adoption', async t => {
  const f = await mounted(t, { tier: 'astra' }, { unselected: true })
  assert.equal(f.panel.chooseStart({ tier: 'claude-sonnet', model: 'pending/exact:model' }).ok, true)
  const result = await f.adopt()
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(f.receipts[0], 'model'), true, 'nullable model must be present in the host receipt')
  assert.equal(f.receipts[0].model, null)
  const node = f.store.getNode(result.nodeId)
  assert.equal(node.model == null, true, 'a nullable live model must clear the pending exact ID')
  assert.equal(node.tier, '', 'the actual no-tier native default replaces the pending Claude route')
  assert.equal(f.sends.length, 1)
})
