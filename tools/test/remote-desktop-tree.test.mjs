import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parseFleetTrees, EMPTY_FLEET_TREES, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import { treeNodeClock } from '../../src/tree-session-liveness.js'

const require = createRequire(import.meta.url)
const { createRemoteDesktopSessions } = require('../../shell/remote-desktop-sessions.cjs')
const { readDesktopTreeSnapshot, LIMITS } = require('../../shell/desktop-tree-snapshot.cjs')
const { createRendererPrefs, RECORD_FILE } = require('../../shell/renderer-prefs.cjs')
const key = 'mc.fleet.trees.v1:this-computer'
const stamp = '2026-09-13T16:00:00.000Z'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function forest() {
  const node = (id, treeId, parentId, status = 'draft', sessionId = null) => ({
    id, treeId, parentId, status, sessionId, role: 'worker', nameBase: 'Worker', nameOrdinal: 1,
    message: 'Exact brief\nwith context', reply: '', statusNote: '', tier: 'local', effort: 'medium',
    runMs: 0, runStartedAt: null, createdByAgent: false, promptedByPerson: true, createdAt: stamp, updatedAt: stamp,
  })
  return {
    version: 1, computerId: 'this-computer',
    trees: ['tree-a', 'tree-b'].map(id => ({ id, name: id, createdAt: stamp, updatedAt: stamp, profileId: 'private-profile' })),
    nodes: [
      { ...node('root-a', 'tree-a', null, 'running', 'native-a'), runMs: 170, runStartedAt: stamp, lastTurnId: 'turn-a' },
      { ...node('child-a', 'tree-a', 'root-a'), nameOrdinal: 2 },
      { ...node('root-b', 'tree-b', null, 'finished', 'old-b'), reply: 'Saved completed answer' },
    ],
  }
}
function fixture({ saved = forest(), ...overrides } = {}) {
  const owner = {}, state = { generation: 1, owner, mayWrite: true, pairId: 'pair-a', deviceId: 'device-a' }
  const principal = () => ({ kind: 'relay', owner: state.owner, mayWrite: state.mayWrite })
  const native = { ownerKind: 'window', owner: {}, pairingOwner: owner, state: 'ready', agentId: 'worker',
    treeNodeId: 'root-a', desktopName: 'Worker', turnsCompleted: 1, lastTurnStatus: 'success' }
  const sessions = new Map([['native-a', native]])
  const calls = { prefs: 0, sends: 0, transcript: 0, emitted: 0 }
  const prefs = { ok: true, damaged: false, values: { [key]: JSON.stringify(saved), 'private-token': 'secret-token' } }
  const deps = {
    sessions, currentPrincipal: principal, connectionTicket: () => state.generation,
    connectionContinues: ticket => ticket === state.generation,
    deviceStatus: async () => ({ connected: true, deviceId: state.deviceId, pairId: state.pairId }),
    rendererPrefsSnapshot: () => { calls.prefs++; return prefs },
    host: () => ({ sessionActivity: () => ({ busy: false }), sessionTranscriptMetadata: () => ({ provider: 'local' }),
      sendTurn: () => { calls.sends++; throw new Error('tree export cannot send') } }),
    bindingFor: () => null, readTranscript: () => { calls.transcript++ },
    emitRemote: () => { calls.emitted++ }, emitWindow: () => { calls.emitted++ }, ...overrides,
  }
  return { controller: createRemoteDesktopSessions(deps), state, deps, prefs, calls, sessions, native, principal }
}

test('desktop tree export preserves actual multi-tree identity, drafts, hierarchy, completed context and saved clocks', async () => {
  const saved = forest(), f = fixture({ saved })
  saved.nodes[0].pendingEditorFork = { path: '/private/editor', receipt: 'private-receipt' }
  saved.nodes[0].credential = 'secret-token'
  f.prefs.values[key] = JSON.stringify(saved)
  const before = JSON.stringify(f.prefs)
  const answer = await f.controller.tree(f.principal())
  assert.equal(answer.ok, true)
  assert.equal(answer.desktopTree.computerId, 'this-computer')
  assert.deepEqual(answer.desktopTree.trees.map(tree => tree.id), ['tree-a', 'tree-b'])
  assert.deepEqual(answer.desktopTree.nodes.map(node => [node.id, node.treeId, node.parentId, node.status]), [
    ['root-a', 'tree-a', null, 'running'], ['child-a', 'tree-a', 'root-a', 'draft'], ['root-b', 'tree-b', null, 'finished'],
  ])
  assert.equal(answer.desktopTree.nodes[0].runStartedAt, stamp)
  assert.equal(answer.desktopTree.nodes[0].runMs, 170)
  assert.equal(answer.desktopTree.nodes[0].lastTurnId, 'turn-a')
  assert.equal(answer.desktopTree.nodes[0].message, saved.nodes[0].message)
  assert.equal(answer.desktopTree.nodes[2].reply, 'Saved completed answer')
  assert.equal(answer.sessions[0].sessionId, 'native-a')
  assert.equal(answer.sessions[0].busy, false, 'a saved running node can have an idle native conversation')
  assert.equal(answer.sessionsTruncated, false)
  assert.doesNotMatch(JSON.stringify(answer), /private-|secret-token|pendingEditorFork|credential|profileId/)
  assert.equal(JSON.stringify(f.prefs), before, 'read leaves all persisted state byte-identical')
  assert.deepEqual(f.calls, { prefs: 1, sends: 0, transcript: 0, emitted: 0 })
  assert.equal(f.native.ownerKind, 'window')
})

test('only the genuinely absent native key is empty, never another computer or a damaged record', async () => {
  const f = fixture()
  delete f.prefs.values[key]
  f.prefs.values['mc.fleet.trees.v1:browser-computer'] = JSON.stringify(forest())
  assert.deepEqual((await f.controller.tree(f.principal())).desktopTree, { version: 1, computerId: 'this-computer', trees: [], nodes: [] })
  f.prefs.damaged = true
  await assert.rejects(f.controller.tree(f.principal()), { code: 'MC_AGENT_DESKTOP_TREE_DAMAGED' })
  f.prefs.damaged = false
  for (const invalid of ['{', 'null', '', '[]', JSON.stringify({ ...forest(), computerId: 'other-computer' })]) {
    f.prefs.values[key] = invalid
    await assert.rejects(f.controller.tree(f.principal()), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
  }
})

for (const [name, damage] of [
  ['missing parent', record => { record.nodes[1].parentId = 'not-present' }],
  ['parent cycle', record => { record.nodes[0].parentId = 'child-a' }],
  ['cross-tree parent', record => { record.nodes[1].parentId = 'root-b' }],
  ['duplicate node id', record => { record.nodes[1].id = 'root-a' }],
  ['tree/node id collision', record => { record.nodes[0].id = 'tree-a' }],
  ['duplicate root', record => { record.nodes[1].parentId = null }],
  ['duplicate session', record => { record.nodes[2].sessionId = 'native-a' }],
  ['duplicate name ordinal', record => { record.nodes[1].nameOrdinal = 1 }],
  ['missing tree', record => { record.nodes[1].treeId = 'not-present' }],
  ['running without native id', record => { record.nodes[0].sessionId = null }],
  ['draft with native id', record => { record.nodes[1].sessionId = 'unexpected-native' }],
  ['unknown saved status', record => { record.nodes[1].status = 'invented-state' }],
]) test(`desktop export refuses ${name} as the maintained tree parser does`, async () => {
  const saved = forest(); damage(saved)
  assert.equal(parseFleetTrees(saved, { computerId: 'this-computer' }), EMPTY_FLEET_TREES)
  const f = fixture({ saved })
  await assert.rejects(f.controller.tree(f.principal()), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
  assert.equal(f.calls.sends + f.calls.transcript + f.calls.emitted, 0)
})

test('legacy naming migration agrees with desktop parser, and empty trees retain membership', async () => {
  const saved = forest()
  delete saved.nodes[0].nameOrdinal; delete saved.nodes[1].nameOrdinal
  saved.trees.push({ id: 'empty-tree', name: null, createdAt: stamp, updatedAt: stamp, kind: 'experiment' })
  const f = fixture({ saved }), answer = await f.controller.tree(f.principal())
  const parsed = parseFleetTrees(saved)
  assert.deepEqual(answer.desktopTree.nodes.map(n => n.nameOrdinal), parsed.nodes.map(n => n.nameOrdinal))
  assert.equal(answer.desktopTree.trees.length, 3)
  assert.equal(answer.desktopTree.trees[2].id, 'empty-tree')
  assert.equal(answer.desktopTree.trees[2].kind, 'experiment')
})

test('export envelope and chain bounds stay aligned with the maintained native tree format', () => {
  assert.deepEqual(LIMITS, FLEET_TREE_LIMITS)
  const saved = forest()
  saved.nodes = [saved.nodes[0]]
  for (let i = 1; i < LIMITS.maxChainSteps; i++) saved.nodes.push({ ...forest().nodes[1], id: `chain-${i}`,
    parentId: saved.nodes.at(-1).id, nameOrdinal: i + 1 })
  const read = value => readDesktopTreeSnapshot({ ok: true, damaged: false, values: { [key]: JSON.stringify(value) } })
  assert.notEqual(parseFleetTrees(saved), EMPTY_FLEET_TREES)
  assert.equal(read(saved).nodes.length, LIMITS.maxChainSteps)
  saved.nodes.push({ ...saved.nodes.at(-1), id: 'chain-too-deep', parentId: saved.nodes.at(-1).id, nameOrdinal: LIMITS.maxChainSteps + 1 })
  assert.equal(parseFleetTrees(saved), EMPTY_FLEET_TREES)
  assert.throws(() => read(saved), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
})

test('real native preferences survive reopen and export without replacing or rewriting the saved forest', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'te-native-tree-prefs-'))
  try {
    const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
    const saved = forest(), text = JSON.stringify(saved)
    assert.equal(prefs.set(key, text).ok, true)
    assert.equal(prefs.set('mc.private', 'not-for-the-tree').ok, true)
    const before = readFileSync(path.join(directory, RECORD_FILE))
    const reopened = createRendererPrefs({ directory, fs, path, randomUUID })
    const f = fixture({ rendererPrefsSnapshot: () => reopened.snapshot() })
    const answer = await f.controller.tree(f.principal())
    assert.deepEqual(answer.desktopTree.nodes, saved.nodes)
    assert.doesNotMatch(JSON.stringify(answer), /not-for-the-tree/)
    assert.deepEqual(readFileSync(path.join(directory, RECORD_FILE)), before)
    assert.equal(reopened.snapshot().values[key], text)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an oversized invalid brief still refuses the complete tree', async () => {
  const saved = forest(); saved.nodes[0].message = 'x'.repeat(LIMITS.maxMessageChars + 1)
  const f = fixture({ saved })
  await assert.rejects(f.controller.tree(f.principal()), { code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
})

for (const [name, fields] of [
  ['oversized saved display strings', { reply: 'r'.repeat(4001), tier: 't'.repeat(65), effort: 'e'.repeat(65) }],
  ['non-string legacy display values', { reply: 123, tier: false, effort: {} }],
  ['padded limit-sized brief and status note', { message: ' ' + 'm'.repeat(12000) + '\n', statusNote: '\n' + 'n'.repeat(240) + ' ' }],
  ['invalid old clock start', { runStartedAt: 'unknown' }],
  ['negative unmeasured old clock', { runMs: -1, runStartedAt: null }],
  ['fractional old clock', { runMs: 1.9, runStartedAt: null }],
  ['legacy blank last-turn id', { lastTurnId: ' ' }],
]) test(`legacy display normalization matches the native reader for ${name}`, async () => {
  const saved = forest(); Object.assign(saved.nodes[0], fields)
  const parsed = parseFleetTrees(saved)
  assert.notEqual(parsed, EMPTY_FLEET_TREES)
  const f = fixture({ saved }), answer = (await f.controller.tree(f.principal())).desktopTree
  for (const field of Object.keys(fields)) assert.deepEqual(answer.nodes[0][field], parsed.nodes[0][field], field)
  assert.equal(answer.nodes[0].status, 'running', 'normalizing legacy display fields is not a restart')
})

test('legacy open-clock normalization preserves its interval and the native elapsed reading at last write', async () => {
  const saved = forest(); saved.nodes[0].runMs = -1
  saved.nodes[0].updatedAt = '2026-09-13T16:00:12.000Z'
  const parsed = parseFleetTrees(saved), f = fixture({ saved })
  const answer = (await f.controller.tree(f.principal())).desktopTree.nodes[0]
  assert.equal(answer.runStartedAt, stamp)
  assert.equal(answer.runMs, 0)
  assert.equal(answer.status, 'running')
  assert.equal(treeNodeClock(answer, new Set()).runMs, treeNodeClock(parsed.nodes[0], new Set()).runMs)
})

test('snapshot keeps a tree larger than the session-response budget whole and marks only runtime row truncation', async () => {
  const saved = forest()
  for (let i = 0; i < 20; i++) saved.nodes.push({ ...saved.nodes[1], id: `child-extra-${i}`, nameOrdinal: i + 3,
    message: '界'.repeat(FLEET_TREE_LIMITS.maxMessageChars), reply: 'α'.repeat(FLEET_TREE_LIMITS.maxReplyChars) })
  const f = fixture({ saved })
  for (let i = 0; i < 205; i++) f.sessions.set(`native-extra-${i}`, { ...f.native, treeNodeId: null })
  const result = await f.controller.tree(f.principal())
  assert.equal(result.desktopTree.nodes.length, saved.nodes.length)
  assert.deepEqual(result.desktopTree.nodes.map(node => node.message), saved.nodes.map(node => node.message))
  assert.equal(result.sessions.length, 200)
  assert.equal(result.sessionsTruncated, true)
})

test('read-only paired caller may read the tree without acquiring native session ownership or watches', async () => {
  const f = fixture(); f.state.mayWrite = false
  f.native.pairingOwner = {}
  const answer = await f.controller.tree(f.principal())
  assert.equal(answer.mayWrite, false)
  assert.equal(answer.sessions[0].openable, false)
  assert.equal(answer.sessions[0].refusal, 'MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION')
  assert.equal(f.controller.forward({ sessionId: 'native-a', event: {} }), false)
  assert.equal(f.calls.emitted + f.calls.sends + f.calls.transcript, 0)
})

for (const [name, principal] of [
  ['window', f => ({ ...f.principal(), kind: 'window' })],
  ['different pairing owner', f => ({ ...f.principal(), owner: {} })],
]) test(`${name} is refused before reading native preferences`, async () => {
  const f = fixture()
  await assert.rejects(f.controller.tree(principal(f)), { code: name === 'window' ? 'MC_AGENT_PRINCIPAL_INVALID' : 'MC_AGENT_CONNECTION_CLOSED' })
  assert.equal(f.calls.prefs, 0)
})

for (const change of ['generation', 'owner', 'pair', 'device', 'close']) test(`a ${change} change during snapshot read discards the complete response`, async () => {
  const entered = deferred(), pendingRead = deferred()
  const f = fixture({ rendererPrefsSnapshot: async () => { entered.resolve(); return pendingRead.promise } })
  const pending = f.controller.tree(f.principal())
  await entered.promise
  if (change === 'generation') f.state.generation++
  if (change === 'owner') f.state.owner = {}
  if (change === 'pair') f.state.pairId = 'pair-new'
  if (change === 'device') f.state.deviceId = 'device-new'
  if (change === 'close') f.controller.close()
  pendingRead.resolve(f.prefs)
  await assert.rejects(pending, { code: 'MC_AGENT_CONNECTION_CLOSED' })
})

test('a final claim change cannot leak a captured tree or stale write-access indicator', async () => {
  let checks = 0
  const f = fixture({ deviceStatus: async () => {
    if (++checks === 2) f.state.pairId = 'revoked'
    return { connected: true, deviceId: f.state.deviceId, pairId: f.state.pairId }
  } })
  await assert.rejects(f.controller.tree(f.principal()), { code: 'MC_AGENT_CONNECTION_CLOSED' })
  assert.equal(checks, 2)
  const readOnly = fixture({ deviceStatus: async () => {
    readOnly.state.mayWrite = false
    return { connected: true, deviceId: readOnly.state.deviceId, pairId: readOnly.state.pairId }
  } })
  assert.equal((await readOnly.controller.tree(readOnly.principal())).mayWrite, false)
})

test('unavailable preferences refuse explicitly without inventing a fresh desktop', async () => {
  for (const rendererPrefsSnapshot of [undefined, () => null, () => ({ ok: false }), () => { throw new Error('private path') }]) {
    const f = fixture({ rendererPrefsSnapshot })
    await assert.rejects(f.controller.tree(f.principal()), { code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' })
  }
})

test('a tree read lease checks only paired access and never reads tree data or changes native work', async () => {
  const f = fixture(), lease = await f.controller.treeReadLease(f.principal())
  assert.equal(typeof lease, 'function')
  assert.deepEqual(Object.keys(lease), [], 'the private closure exposes no captured principal or saved context')
  await lease(f.principal())
  await lease(f.principal())
  assert.deepEqual(f.calls, { prefs: 0, sends: 0, transcript: 0, emitted: 0 })
  assert.equal(f.controller.forward({ sessionId: 'native-a', event: {} }), false)
  assert.equal(f.native.ownerKind, 'window')
  f.state.mayWrite = false
  const readOnly = await f.controller.treeReadLease(f.principal())
  await readOnly(f.principal())
})

for (const change of ['passed-owner', 'passed-kind', 'passed-grant', 'actual-owner', 'generation', 'pair', 'device', 'close', 'grant-off', 'grant-on']) {
  test(`a tree read lease refuses ${change} and cannot be revived after refusal`, async () => {
    const f = fixture()
    if (change === 'grant-on') f.state.mayWrite = false
    const original = { ...f.state }, lease = await f.controller.treeReadLease(f.principal())
    let current = f.principal()
    if (change === 'passed-owner') current = { ...current, owner: {} }
    if (change === 'passed-kind') current = { ...current, kind: 'window' }
    if (change === 'passed-grant') current = { ...current, mayWrite: false }
    if (change === 'actual-owner') f.state.owner = {}
    if (change === 'generation') f.state.generation++
    if (change === 'pair') f.state.pairId = 'pair-new'
    if (change === 'device') f.state.deviceId = 'device-new'
    if (change === 'close') f.controller.close()
    if (change === 'grant-off') f.state.mayWrite = false
    if (change === 'grant-on') f.state.mayWrite = true
    await assert.rejects(lease(current), { code: 'MC_AGENT_CONNECTION_CLOSED' })
    Object.assign(f.state, original)
    await assert.rejects(lease(f.principal()), { code: 'MC_AGENT_CONNECTION_CLOSED' })
    assert.equal(f.calls.prefs + f.calls.sends + f.calls.transcript + f.calls.emitted, 0)
  })
}

test('a grant change while creating a lease refuses it instead of adopting the new grant', async () => {
  const entered = deferred(), claim = deferred()
  const f = fixture({ deviceStatus: async () => { entered.resolve(); return claim.promise } })
  const pending = f.controller.treeReadLease(f.principal())
  await entered.promise
  f.state.mayWrite = false
  claim.resolve({ connected: true, deviceId: f.state.deviceId, pairId: f.state.pairId })
  await assert.rejects(pending, { code: 'MC_AGENT_CONNECTION_CLOSED' })
})

test('a grant change during an awaited lease check is refused after device admission settles', async () => {
  const f = fixture(), lease = await f.controller.treeReadLease(f.principal())
  const entered = deferred(), claim = deferred()
  f.deps.deviceStatus = async () => { entered.resolve(); return claim.promise }
  const pending = lease(f.principal())
  await entered.promise
  f.state.mayWrite = false
  claim.resolve({ connected: true, deviceId: f.state.deviceId, pairId: f.state.pairId })
  await assert.rejects(pending, { code: 'MC_AGENT_CONNECTION_CLOSED' })
})

test('the desktop snapshot controller loads and runs in a shell-only packaged layout', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'te-desktop-tree-package-'))
  try {
    mkdirSync(path.join(directory, 'shell'))
    for (const name of ['remote-desktop-sessions.cjs', 'desktop-tree-snapshot.cjs', 'native-desktop-stop.cjs']) {
      copyFileSync(new URL(`../../shell/${name}`, import.meta.url), path.join(directory, 'shell', name))
    }
    const run = spawnSync(process.execPath, ['-e', `
      const {readDesktopTreeSnapshot} = require('./shell/desktop-tree-snapshot.cjs');
      require('./shell/remote-desktop-sessions.cjs');
      const value = readDesktopTreeSnapshot({ok:true,damaged:false,values:{}});
      if(value.computerId !== 'this-computer' || value.nodes.length) process.exit(2);
    `], { cwd: directory, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const build = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).build
    assert.ok(build.files.includes('shell/**'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('real paired desktop controller and native broker share exact Stop receipt after native session removal', async () => {
  const { createNativePersonStop } = require('../../shell/native-person-stop.cjs')
  let f, packet; const closed = []
  const broker = createNativePersonStop({
    checkContext: (...args) => f.controller.checkStopContext(...args),
    closeSession: async (id, expected, principal) => {
      assert.equal(expected, f.native); assert.equal(principal.kind, 'window'); assert.equal(principal.owner, f.native.owner)
      closed.push(id); f.sessions.delete(id); return { ok: true, closed: true, sessionId: id }
    },
    send: (owner, value) => { assert.equal(owner, f.native.owner); packet = value },
  })
  f = fixture({ nativeStopHandler: broker })
  assert.equal((await f.controller.list(f.principal())).desktopStopVersion, undefined)
  broker.setReady(f.native.owner, true)
  const listed = await f.controller.list(f.principal())
  assert.equal(listed.desktopStopVersion, 1)
  const target = listed.sessions[0].stopTarget
  assert.deepEqual(Object.keys(target), ['version', 'treeId', 'nodeId', 'sessionId', 'revision'])
  const request = { requestId: '00000000-0000-4000-8000-000000000001', target }
  assert.equal((await f.controller.stop(request, f.principal())).state, 'pending')
  const key = { requestId: packet.requestId, token: packet.token }
  await broker.close(key, f.native.owner, { kind: 'window', owner: f.native.owner })
  const saved = JSON.parse(f.prefs.values['mc.fleet.trees.v1:this-computer'])
  saved.nodes[0].status = 'finished'; saved.nodes[0].statusNote = 'Stopped by you.'
  f.prefs.values['mc.fleet.trees.v1:this-computer'] = JSON.stringify(saved)
  broker.complete({ ...key, savedState: 'recorded' }, f.native.owner)
  const receipt = await f.controller.stopStatus({ requestId: request.requestId }, f.principal())
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.closed, true)
  assert.deepEqual(await f.controller.stop(request, f.principal()), receipt)
  assert.deepEqual(closed, ['native-a'])
  f.state.owner = {}
  await assert.rejects(f.controller.stopStatus({ requestId: request.requestId }, f.principal()), { code: 'MC_AGENT_DESKTOP_STOP_RECEIPT_UNAVAILABLE' })
})

test('native Stop capability and admission obey ordinary pairing write consent; absent handler is explicit', async () => {
  const plain = fixture()
  await assert.rejects(plain.controller.stop({}, plain.principal()), { code: 'MC_AGENT_DESKTOP_STOP_UNAVAILABLE' })
  const delivered = []
  const f = fixture({ nativeStopHandler: { ready: () => true, dispatch: request => { delivered.push(request); return { completion: Promise.resolve({ outcome: 'not-sent' }) } } } })
  const target = (await f.controller.list(f.principal())).sessions[0].stopTarget
  f.state.mayWrite = false
  assert.equal((await f.controller.list(f.principal())).desktopStopVersion, undefined)
  await assert.rejects(f.controller.stop({ requestId: '00000000-0000-4000-8000-000000000002', target }, f.principal()), { code: 'MC_AGENT_PRINCIPAL_READ_ONLY' })
  assert.equal(delivered.length, 0)
})
