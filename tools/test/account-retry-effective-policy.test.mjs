import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import { readAccountList } from '../../src/account-switcher-state.js'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const functions = ['accountRetryChipState', 'applyAccountRetryChip', 'keepTryingOnLimitIsOn', 'refreshAccountRetryGlobalPolicy']
  .map(name => declaredFunctionSource(source, name)).join('\n')
const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
test.after(() => dom.restore())
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(t) {
  const cells = new Map()
  const storage = { read: key => cells.has(key) ? structuredClone(cells.get(key)) : null,
    write: (key, value) => { cells.set(key, structuredClone(value)); return true } }
  let serial = 0
  const treeStore = createFleetTreeStore({ computerId: 'fixture', storage, makeId: kind => `${kind}-${++serial}` })
  const node = treeStore.addNode({ role: 'worker', message: 'Preserve the conversation.', tier: 'luna' }).node
  treeStore.attachSession(node.id, 'old-session')
  treeStore.setNodeStatus(node.id, 'turn-failed')
  const transcriptStore = { ...createTranscriptStore({ computerId: 'fixture', storage }) }
  transcriptStore.save(node.id, { provider: 'codex', account: 'original', threadId: 'thread-original',
    lines: [{ who: 'agent', text: 'The first step is complete.', at: 1 }] })
  transcriptStore.readLatest = async id => ({ ...transcriptStore.get(id), recoveryDirectory: '/fixture/history' })
  const handoffStore = createRecoveryHandoffStore({ computerId: 'fixture', storage })
  const calls = { close: [], start: [], send: [], notices: [] }
  const bridge = {
    onEvent: () => () => {},
    ledger: async () => ({ ok: true, records: [], chain: { checked: true, ok: true } }),
    close: async args => { calls.close.push(args); return { sessionId: args.sessionId, closed: true } },
    start: async args => { calls.start.push(args); return { ok: true, sessionId: 'successor' } },
    sendAutomatic: async args => { calls.send.push(args); return { ok: true, result: { ok: true }, deliveryDisposition: 'accepted' } },
  }
  const sessionNodeIds = new Map([['old-session', node.id]])
  let coordinator
  const makeCoordinator = () => {
    const next = createAccountRecoveryCoordinator({ bridge, sessionNodeIds,
      canStart: () => true, canContinue: () => true, keepTryingOnLimit: async () => true,
      tiers: [{ id: 'luna', provider: 'codex' }],
      orgBridge: { read: async () => ({ ok: true, org: { revision: 1, agents: [{ id: node.id, role: 'worker', enabled: true }] }, roles: [{ id: 'worker', revision: 1 }] }) } })
    next.register('fixture', { treeStore, transcriptStore, handoffStore })
    next.subscribe(notice => calls.notices.push(notice))
    return next
  }
  coordinator = makeCoordinator()
  const context = vm.createContext({ treeStore, recoveryCoordinator: () => coordinator,
    currentDataSource: () => 'local', isWriteEnabled: () => true, START_CONTROL_FLAG: 'start',
    ACCOUNT_RETRY_DRAFT_REASON: 'Start this agent first.', notifyNodeStatusListeners() {},
    window: {}, accountRetryGlobalPolicy: { state: 'pending', autoRecoverOnLimit: null }, accountRetryGlobalPolicyRead: null,
    loadAccounts: async () => ({ available: true, policy: { autoRecoverOnLimit: true } }),
    accountsBridge: () => ({ accounts: async () => ({ ok: true, accounts: [] }) }), readAccountList,
    continueNodeOnAnotherAccount: async () => assert.fail('Off must not request a continuation'),
  })
  vm.runInContext(functions, context)
  const packet = { sessionId: 'old-session', event: { type: 'account_recovery_needed',
    recoveryId: 'ticket', handoff: 'Continue the preserved work.' } }
  const chats = []
  const chat = () => {
    const root = buildChat({ title: 'Worker', seed: 0, onSend() {}, chips: {
      accountRetry: () => context.accountRetryChipState(node.id),
      onAccountRetryChange: value => context.applyAccountRetryChip(node.id, value),
    } })
    chats.push(root)
    return root
  }
  t.after(() => { coordinator.destroy(); for (const root of chats) root.dispose?.() })
  return { node, treeStore, transcriptStore, handoffStore, calls, context, packet, chat,
    coordinator: () => coordinator,
    rebind(sessionId) { sessionNodeIds.clear(); sessionNodeIds.set(sessionId, node.id); treeStore.attachSession(node.id, sessionId); treeStore.setNodeStatus(node.id, 'turn-failed') },
    async reopen({ wait = true } = {}) { coordinator.destroy(); coordinator = makeCoordinator(); if (wait) await tick() },
  }
}

test('the fresh chat identifies the Accounts default instead of claiming automatic recovery is off', async t => {
  const f = fixture(t)
  await tick()
  assert.equal(await f.context.keepTryingOnLimitIsOn(f.node.id), true, 'the actual Accounts read establishes default-on')
  f.context.accountRetryChipState(f.node.id)
  await tick()
  const select = f.chat().querySelector('[data-chat-chip="account-retry"]')
  const selected = [...select.querySelectorAll('option')].find(option => option.value === select.value)
  assert.match(selected.textContent, /Follows Accounts menu|Accounts.*default|default.*Accounts/i)
  assert.doesNotMatch(selected.textContent, /off/i)
})

test('choosing Off prevents automatic account recovery with the global default on, including after reopen', async t => {
  const f = fixture(t)
  await tick()
  assert.equal(await f.context.applyAccountRetryChip(f.node.id, 'off'), true)
  await tick()
  await f.coordinator().recover(f.packet)
  assert.equal(f.calls.close.length, 0, 'Off preserves the original session')
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.calls.send.length, 0)
  await f.reopen()
  await f.coordinator().recover({ ...f.packet, event: { ...f.packet.event, recoveryId: 'after-reopen' } })
  assert.equal(f.calls.close.length, 0, 'saved Off survives coordinator recreation')
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.context.accountRetryChipState(f.node.id).value, 'off')
})

test('the actual resume consent read respects the selected per-agent Off with Accounts default on', async t => {
  const f = fixture(t)
  await tick()
  assert.equal(await f.context.applyAccountRetryChip(f.node.id, 'off'), true)
  assert.equal(await f.context.keepTryingOnLimitIsOn(f.node.id), false)
  await f.reopen()
  assert.equal(await f.context.keepTryingOnLimitIsOn(f.node.id), false)
})


test('an automatic event waits for the saved Off choice when coordinator hydration is still pending', async t => {
  const f = fixture(t)
  await tick()
  await f.context.applyAccountRetryChip(f.node.id, 'off')
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  f.handoffStore.readRecord = async id => { await gate; return f.handoffStore.get(id) }
  await f.reopen({ wait: false })
  const recovering = f.coordinator().recover(f.packet)
  await tick()
  assert.equal(f.calls.close.length, 0, 'no close while the saved choice is unread')
  release()
  await recovering
  assert.equal(f.calls.close.length, 0, 'the retained Off choice rejects the event')
  assert.equal(f.calls.start.length, 0)
})

test('an unreadable saved retry choice refuses the automatic event visibly and preserves the session', async t => {
  const f = fixture(t)
  await tick()
  f.handoffStore.readRecord = async () => { throw new Error('Fixture saved choice could not be read') }
  await f.coordinator().recover(f.packet)
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.ok(f.calls.notices.some(notice => /saved.*choice.*read/i.test(notice.error || '')))
})

test('a default automatic event still reaches the host once when the same ticket arrives concurrently', async t => {
  const f = fixture(t)
  await tick()
  await Promise.all([f.coordinator().recover(f.packet), f.coordinator().recover(f.packet)])
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.start.length, 1)
})

test('a deliberate manual continuation remains available after choosing Off', async t => {
  const f = fixture(t)
  await tick()
  await f.context.applyAccountRetryChip(f.node.id, 'off')
  await f.coordinator().continueOnAnotherAccount({ computerId: 'fixture', nodeId: f.node.id })
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.start.length, 1)
})


test('a session rebound while the saved choice is being read cannot close or start either session', async t => {
  const f = fixture(t)
  await tick()
  let release
  const gate = new Promise(resolve => { release = resolve })
  t.after(() => release())
  f.handoffStore.readRecord = async id => { await gate; return f.handoffStore.get(id) }
  const recovering = f.coordinator().recover(f.packet)
  await tick()
  f.treeStore.attachSession(f.node.id, 'different-session')
  release()
  await recovering
  assert.equal(f.calls.close.length, 0)
  assert.equal(f.calls.start.length, 0)
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, 'different-session')
})

test('an Off record bound to another session does not suppress the current conversation default recovery', async t => {
  const f = fixture(t)
  await tick()
  f.handoffStore.save(f.node.id, { handoff: 'Other saved conversation.', sessionId: 'other-session',
    retryPolicy: { v: 1, nodeId: f.node.id, sessionId: 'other-session', enabled: false } })
  await f.coordinator().recover(f.packet)
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.start.length, 1)
})


for (const enabled of [false, true]) test(`a cached ${enabled ? 'enabled' : 'Off'} policy for an earlier session cannot govern a rebound automatic event`, async t => {
  const f = fixture(t)
  await tick()
  if (enabled) {
    f.treeStore.setNodeStatus(f.node.id, 'finished')
    assert.equal(await f.coordinator().keepTryingAccounts({ computerId: 'fixture', nodeId: f.node.id,
      startOptions: { tier: 'luna', roleBinding: { agentId: f.node.id, id: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 } } }), true)
  } else {
    assert.equal(await f.context.applyAccountRetryChip(f.node.id, 'off'), true)
  }
  assert.equal(f.coordinator().retryPolicy(f.node.id).sessionId, 'old-session')
  f.rebind('rebound-session')
  const packet = { sessionId: 'rebound-session', event: { ...f.packet.event, recoveryId: 'rebound-ticket' } }
  await f.coordinator().recover(packet)
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.close[0].sessionId, 'rebound-session')
  assert.equal(f.calls.start.length, 1)
  assert.deepEqual(f.calls.start[0].accountRecovery, { recoveryId: 'rebound-ticket' })
  assert.equal(f.calls.start[0].accountRetry, undefined, 'an old session policy must not select a persistent retry')
})
