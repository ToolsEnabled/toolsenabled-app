import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const { createAgentHost } = require('../../shell/agent-host.cjs')
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }
async function setup(t, supported = true, { appliesOn = null } = {}) {
  let modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'plan', name: 'Plan', description: 'Plan first' }] }
  let finish, fail, sent = 0, changed = 0
  const adapter = {
    transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
    sendTurn: async () => { sent++; return { turnId: 'turn' } },
    interrupt: async () => {}, answerApproval() {},
    updateThreadSettings: async () => {},
  }
  if (supported) {
    adapter.getSessionModes = () => modes
    adapter.selectMode = async (_, id) => {
      changed++
      await new Promise((resolve, reject) => { finish = resolve; fail = reject })
      modes = { ...modes, currentModeId: id }
      return { ...modes, ...(appliesOn ? { appliesOn } : {}) }
    }
  }
  t.mock.method(engine, 'startCodexSession', async () => ({ threadId: 'thread', adapter, close() {} }))
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: root, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }) })
  await host.startSession({ sessionId: 'mode-session', tier: 'luna' })
  t.after(() => host.closeAll())
  return { host, adapter, read: () => host.readSessionModes({ sessionId: 'mode-session' }),
    select: (modeId = 'plan') => host.setSessionMode({ sessionId: 'mode-session', modeId }),
    send: () => host.sendTurn({ sessionId: 'mode-session', text: 'hello' }),
    finish: () => finish(), fail: () => fail(Object.assign(new Error('refused'), { code: 'PROVIDER_REFUSED' })),
    sent: () => sent, changed: () => changed,
    observe: values => { modes = { ...modes, ...values } },
    acknowledgeTiming: value => { appliesOn = value } }
}
test('mode state remains current until ACK; pending operation excludes send, effort and another selection', async t => {
  const f = await setup(t)
  assert.equal(f.read().currentModeId, 'ask')
  const selected = f.select()
  assert.equal(f.read().pending, true)
  assert.equal(f.read().currentModeId, 'ask')
  await assert.rejects(f.send(), { code: 'AGENT_TURN_ACTIVE' })
  await assert.rejects(f.select('ask'), { code: 'AGENT_TURN_ACTIVE' })
  await assert.rejects(f.host.setSessionEffort({ sessionId: 'mode-session', effort: 'low' }), { code: 'AGENT_TURN_ACTIVE' })
  assert.equal(f.sent(), 0)
  f.finish()
  const receipt = await selected
  assert.equal(receipt.applied, true)
  assert.equal(receipt.currentModeId, 'plan')
  assert.equal(receipt.pending, false)
  assert.equal(f.read().pending, false)
  await f.send()
  assert.equal(f.sent(), 1)
})
test('unsupported and unavailable modes refuse without changing provider state', async t => {
  const f = await setup(t, false)
  assert.deepEqual(f.read().availableModes, [])
  assert.equal(f.read().supported, false)
  await assert.rejects(f.select(), { code: 'AGENT_MODE_UNSUPPORTED' })
})
test('unadvertised choice and busy turn cannot dispatch a mode request', async t => {
  const f = await setup(t)
  await assert.rejects(f.select('invented'), { code: 'AGENT_MODE_UNAVAILABLE' })
  await f.send()
  await assert.rejects(f.select(), { code: 'AGENT_TURN_ACTIVE' })
  assert.equal(f.changed(), 0)
})
test('provider refusal clears pending without reporting applied', async t => {
  const f = await setup(t)
  const rejected = assert.rejects(f.select(), { code: 'PROVIDER_REFUSED' })
  f.fail()
  await rejected
  assert.equal(f.read().pending, false)
  assert.equal(f.read().currentModeId, 'ask')
})
test('Stop invalidates a pending ACK and does not claim the provider rolled back', async t => {
  const f = await setup(t)
  const rejected = assert.rejects(f.select(), { code: 'AGENT_MODE_SELECTION_UNCONFIRMED' })
  const stopped = await f.host.interrupt({ sessionId: 'mode-session' })
  assert.equal(stopped.modeChangeUnconfirmed, true)
  f.finish()
  await rejected
  assert.equal(f.read().currentModeId, 'plan', 'refresh exposes actual provider mode after uncertain Stop')
})
test('close and replacement never accept an old adapter ACK', async t => {
  const f = await setup(t)
  const rejected = assert.rejects(f.select(), { code: 'AGENT_SESSION_NOT_READY' })
  await f.host.closeSession({ sessionId: 'mode-session' })
  await f.host.startSession({ sessionId: 'mode-session', tier: 'luna' })
  f.finish()
  await rejected
})
test('effort operation excludes selection until its acknowledgement settles', async t => {
  const f = await setup(t)
  let finish
  f.adapter.updateThreadSettings = () => new Promise(resolve => { finish = resolve })
  const effort = f.host.setSessionEffort({ sessionId: 'mode-session', effort: 'low' })
  await flush()
  await assert.rejects(f.select(), { code: 'AGENT_TURN_ACTIVE' })
  finish()
  await effort
  const mode = f.select()
  f.finish()
  assert.equal((await mode).applied, true)
})

for (const appliesOn of ['next-turn', 'subsequent-turns']) {
  test('confirmed mode timing survives host reads and menu reopening: ' + appliesOn, async t => {
    const f = await setup(t, true, { appliesOn })
    const events = []
    const off = f.host.onEvent(packet => events.push(packet))
    t.after(off)
    const selected = f.select()
    assert.equal(f.read().appliesOn, undefined, 'pending intent is not confirmation')
    f.finish()
    const receipt = await selected
    assert.equal(receipt.appliesOn, appliesOn)
    assert.equal(receipt.applied, true)
    assert.equal(f.read().appliesOn, appliesOn)
    assert.equal(f.read().currentModeId, 'plan')
    const modeEvent = events.find(packet => packet.event?.type === 'session_mode_changed')
    assert.equal(modeEvent?.event.appliesOn, appliesOn)

    const { createProviderModeMenu } = await import('../../src/provider-mode-menu.js')
    for (let opening = 0; opening < 2; opening++) {
      const said = []
      const menu = createProviderModeMenu({ sessionId: 'mode-session', bridge: {
        modes: request => f.host.readSessionModes(request),
        setMode: request => f.host.setSessionMode(request),
      } })
      try {
        await menu.open({ show() {}, say: value => said.push(value) })
        assert.match(said.at(-1), appliesOn === 'next-turn' ? /next turn/i : /subsequent turns/i)
        assert.doesNotMatch(said.at(-1), /mode applied/i)
        assert.equal(menu.rows().find(row => row.id === 'provider-mode-plan').current, true)
      } finally { menu.dispose() }
    }
    assert.equal(f.sent(), 0, 'displaying acknowledged configuration must not run a turn')
  })
}
test('provider observation invalidates old timing even if the old mode returns later', async t => {
  const f = await setup(t, true, { appliesOn: 'next-turn' })
  const selected = f.select()
  f.finish(); await selected
  assert.equal(f.read().appliesOn, 'next-turn')
  f.observe({ currentModeId: 'ask' })
  assert.equal(f.read().appliesOn, undefined)
  f.observe({ currentModeId: 'plan' })
  assert.equal(f.read().appliesOn, undefined, 'matching an old ID must not resurrect stale confirmation')
})
test('a new immediate acknowledgement replaces the previous deferred timing', async t => {
  const f = await setup(t, true, { appliesOn: 'subsequent-turns' })
  const first = f.select()
  f.finish(); await first
  f.acknowledgeTiming(null)
  const second = f.select()
  f.finish()
  assert.equal((await second).appliesOn, undefined)
  assert.equal(f.read().appliesOn, undefined)
})
test('same-ID replacement session does not inherit the retired session timing', async t => {
  const f = await setup(t, true, { appliesOn: 'next-turn' })
  const selected = f.select()
  f.finish(); await selected
  await f.host.closeSession({ sessionId: 'mode-session' })
  await f.host.startSession({ sessionId: 'mode-session', tier: 'luna' })
  assert.equal(f.read().currentModeId, 'plan', 'fixture returns the same provider mode')
  assert.equal(f.read().appliesOn, undefined, 'new host session must receive its own acknowledgement')
})

test('refused change keeps the prior confirmed mode and timing without a new success event', async t => {
  const f = await setup(t, true, { appliesOn: 'subsequent-turns' })
  const first = f.select()
  f.finish(); await first
  const events = []
  const off = f.host.onEvent(packet => events.push(packet))
  t.after(off)
  const refused = assert.rejects(f.select('ask'), { code: 'PROVIDER_REFUSED' })
  f.fail(); await refused
  assert.equal(f.read().currentModeId, 'plan')
  assert.equal(f.read().appliesOn, 'subsequent-turns')
  assert.equal(f.read().pending, false)
  assert.equal(events.filter(packet => packet.event?.type === 'session_mode_changed').length, 0)
})

test('matching ACK cannot override a different authoritative provider observation', async t => {
  const f = await setup(t)
  const events = []
  const off = f.host.onEvent(packet => events.push(packet))
  t.after(off)
  f.adapter.selectMode = async (_threadId, modeId) => ({ currentModeId: modeId, appliesOn: 'next-turn' })
  await assert.rejects(f.select('plan'), { code: 'AGENT_MODE_SELECTION_UNCONFIRMED' })
  assert.equal(f.read().currentModeId, 'ask')
  assert.equal(f.read().appliesOn, undefined)
  assert.equal(f.read().pending, false)
  assert.equal(events.filter(packet => packet.event?.type === 'session_mode_changed').length, 0)
})
