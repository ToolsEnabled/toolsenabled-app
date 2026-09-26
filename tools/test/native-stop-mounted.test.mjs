import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const deferred = () => { let resolve; const promise = new Promise(go => { resolve = go }); return { promise, resolve } }
let serial = 0
async function fixture(t) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const nodeId = `native-stop-${++serial}`, sessionId = `native-stop-session-${serial}`, treeId = `native-stop-tree-${serial}`
  const events = new Set(), closes = []
  world.storage.setItem('mc.write.agent-session', 'enabled')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  world.bridge.start = async () => ({ ok: true, sessionId, threadId: 'fixture-thread' })
  world.bridge.send = async () => ({ ok: true, turnId: 'fixture-turn' })
  world.bridge.onEvent = fn => { events.add(fn); return () => events.delete(fn) }
  world.bridge.close = async value => { closes.push(value); return { ok: true, closed: true, sessionId: value.sessionId } }
  seedTreeNode(world.storage, { nodeId, treeId, status: 'finished' })
  const prior = globalThis.mcOrg
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org: { revision: 1, source: 'overlay', agents: [{ id: nodeId, role: 'builder', provider: 'codex', enabled: true }], edges: [] }, roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  const view = await mountView(world)
  let destroyed = false
  const destroy = () => { if (!destroyed) { destroyed = true; view.destroy() } }
  t.after(async () => {
    if (!destroyed) await view.nativeStop.run({ version: 1, nodeId, treeId, sessionId }, async () => ({ closed: true, sessionId }))
    destroy(); if (prior === undefined) delete globalThis.mcOrg; else globalThis.mcOrg = prior; world.restore()
  })
  assert.equal(await view.nativeStop.ready, true)
  const started = await view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId: 'this-computer', nodeId })
  assert.equal(started.ok, true, JSON.stringify(started))
  const target = { version: 1, nodeId, treeId, sessionId, revision: 'a'.repeat(64) }
  const saved = () => JSON.parse(world.storage.getItem('mc.fleet.trees.v1:this-computer')).nodes.find(node => node.id === nodeId)
  return { world, view, target, closes, saved, destroy,
    emit: async event => { for (const fn of events) await fn({ sessionId, event }); await settle(4) } }
}
test('mounted native hosted Stop shares person cleanup and preserves the real partial reply plus explicit native note', async t => {
  const f = await fixture(t)
  await f.emit({ type: 'person_turn', via: 'remote', text: 'owned request', turnId: 'turn-a' })
  await f.emit({ type: 'assistant_text_delta', text: 'First line\nSecond line', turnId: 'turn-a' })
  let redeemed = 0
  const result = await f.view.nativeStop.run(f.target, async () => { redeemed++; return { ok: true, closed: true, sessionId: f.target.sessionId } })
  assert.equal(result.closed, true)
  assert.equal(result.savedState, 'recorded')
  assert.equal(redeemed, 1)
  assert.equal(f.closes.length, 0, 'hosted controller redeems its private native lease, never arbitrary mcAgent.close')
  assert.equal(f.saved().status, 'finished')
  assert.equal(f.saved().statusNote, 'Stopped by you.')
  assert.match(f.saved().reply, /First line\nSecond line/)
})
test('mounted native controller refuses wrong node/tree/session without redeeming a close', async t => {
  const f = await fixture(t)
  for (const target of [{ ...f.target, nodeId: 'other' }, { ...f.target, treeId: 'other' }, { ...f.target, sessionId: 'other' }]) {
    const answer = await f.view.nativeStop.run(target, () => { throw Error('must not close') })
    assert.equal(answer.outcome, 'not-sent')
  }
  assert.notEqual(f.saved().statusNote, 'Stopped by you.')
})
test('mounted native close refusal keeps actual saved target and partial reply available for a later Stop', async t => {
  const f = await fixture(t), before = f.saved()
  const answer = await f.view.nativeStop.run(f.target, async () => ({ closed: false }))
  assert.equal(answer.closed, false)
  assert.deepEqual(f.saved(), before)
})
test('native navigation during an admitted close has no hidden remount or false persisted Stop success', async t => {
  const f = await fixture(t), wait = deferred()
  const pending = f.view.nativeStop.run(f.target, () => wait.promise)
  f.destroy(); wait.resolve({ closed: true, sessionId: f.target.sessionId })
  const answer = await pending
  assert.equal(answer.closed, true)
  assert.equal(answer.savedState, 'unconfirmed')
  assert.notEqual(f.saved().statusNote, 'Stopped by you.')
})

test('a real native replacement during hosted close retains the new session and never writes the old Stop note', async t => {
  const f = await fixture(t), wait = deferred()
  const pending = f.view.nativeStop.run(f.target, () => wait.promise)
  const newerSession = f.target.sessionId + '-replacement'
  f.world.bridge.start = async () => ({ ok: true, sessionId: newerSession, threadId: 'newer-thread' })
  const replaced = await f.view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId: 'this-computer', nodeId: f.target.nodeId })
  assert.equal(replaced.ok, true, JSON.stringify(replaced))
  wait.resolve({ closed: true, sessionId: f.target.sessionId })
  const result = await pending
  assert.equal(result.closed, true)
  assert.equal(result.savedState, 'unconfirmed')
  assert.equal(f.saved().sessionId, newerSession)
  assert.notEqual(f.saved().statusNote, 'Stopped by you.')
  await f.view.nativeStop.run({ ...f.target, sessionId: newerSession }, async () => ({ closed: true, sessionId: newerSession }))
})
