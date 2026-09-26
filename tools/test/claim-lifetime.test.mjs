import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import receipts from '../../shell/claim-lifetime-receipts.cjs'
import processModule from '../../shell/claim-lifetime-process.cjs'

const complete = { quiescent: true, started: true, exitedNormally: true, exitCode: 0 }
function state(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-lifetime-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function signed(root, identity, result = complete) {
  const envelope = receipts.signTerminal(identity.descriptor, result, identity.privateKey)
  receipts.writeTerminal(root, identity.descriptor, envelope)
  return envelope
}

test('a signed terminal receipt can be verified with only the persisted public descriptor', t => {
  const root = state(t)
  const identity = receipts.createIdentity()
  assert.equal(Buffer.from(identity.descriptor.publicKey, 'base64').length, 44)
  const envelope = signed(root, identity)
  assert.equal(Buffer.from(envelope.signature, 'base64').length, 64)
  const expected = JSON.parse(JSON.stringify(identity.descriptor))
  assert.deepEqual(receipts.reconcileOwnership(root, expected), { quiescent: true, receipt: envelope.payload })
  const stored = fs.readFileSync(path.join(root, 'state', 'claim-lifetimes', expected.id + '.json'), 'utf8')
  assert.doesNotMatch(stored, /privateKey|command|environment|stdout|pollToken/)
})

test('missing, changed, wrong-key and wrong-invocation receipts all remain unknown', t => {
  const root = state(t)
  const identity = receipts.createIdentity()
  assert.deepEqual(receipts.reconcileOwnership(root, identity.descriptor), { quiescent: false })
  const envelope = signed(root, identity)
  const other = receipts.createIdentity()
  assert.deepEqual(receipts.reconcileOwnership(root, { ...identity.descriptor, publicKey: other.descriptor.publicKey }), { quiescent: false })
  assert.deepEqual(receipts.reconcileOwnership(root, other.descriptor), { quiescent: false })
  const file = path.join(root, 'state', 'claim-lifetimes', identity.descriptor.id + '.json')
  for (const invalid of [
    { ...envelope, payload: { ...envelope.payload, exitCode: 1 } },
    { ...envelope, payload: { ...envelope.payload, extra: true } },
    { ...envelope, publicKey: identity.descriptor.publicKey },
    { ...envelope, signature: 'A'.repeat(88) },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid))
    assert.deepEqual(receipts.reconcileOwnership(root, identity.descriptor), { quiescent: false })
  }
})

test('receipt IDs cannot choose a path and terminal files cannot be replaced', t => {
  const root = state(t)
  const identity = receipts.createIdentity()
  const envelope = signed(root, identity)
  assert.throws(() => receipts.writeTerminal(root, identity.descriptor, envelope))
  assert.deepEqual(receipts.reconcileOwnership(root, { ...identity.descriptor, id: '../outside' }), { quiescent: false })
  assert.deepEqual(receipts.reconcileOwnership(root, { ...identity.descriptor, path: '/outside' }), { quiescent: false })
  const directory = path.join(root, 'state', 'claim-lifetimes')
  assert.equal(fs.readdirSync(directory).length, 1)
})

test('an unknown or inconsistent cleanup result cannot be signed as terminal', () => {
  const identity = receipts.createIdentity()
  assert.throws(() => receipts.signTerminal(identity.descriptor, { ...complete, quiescent: false }, identity.privateKey))
  assert.throws(() => receipts.signTerminal(identity.descriptor, { ...complete, started: false }, identity.privateKey))
})

function proxy(t, hook) {
  const root = state(t)
  const child = new EventEmitter()
  child.connected = true
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const messages = []
  child.send = value => { messages.push(value) }
  let invocation
  const owner = processModule.spawnClaimLifetime({ spawn(command, args, options) {
    invocation = { command, args, options }; return child
  }, command: process.execPath, args: ['claim.js', 'poll', '--token', 'ephemeral-secret-token'],
  payloadRoot: root, stateRoot: root, environment: { ELECTRON_RUN_AS_NODE: '1' }, onOwnershipStart: hook })
  return { root, child, messages, owner, invocation }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('proxy START waits for durable admission; private key and claim arguments use only IPC', async t => {
  let admit
  const f = proxy(t, () => new Promise(resolve => { admit = resolve }))
  f.child.emit('message', { type: 'READY' })
  const init = f.messages.find(value => value.type === 'INIT')
  assert(init.privateKey)
  assert.equal(init.launch.args.at(-1), 'ephemeral-secret-token')
  assert.doesNotMatch(JSON.stringify(f.invocation), /ephemeral-secret-token|privateKey/)
  f.child.emit('message', { type: 'INITIALIZED' })
  await flush()
  assert.equal(f.messages.some(value => value.type === 'START'), false)
  admit(true)
  await flush()
  assert.equal(f.messages.filter(value => value.type === 'START').length, 1)
  f.child.emit('close', 1, null)
  assert.equal((await f.owner.completion).quiescent, false, 'an admitted missing receipt is unknown')
})

test('failed admission and cancellation during persistence never send START', async t => {
  for (const mode of ['refused', 'cancelled']) {
    let admit
    const f = proxy(t, () => new Promise(resolve => { admit = resolve }))
    f.child.emit('message', { type: 'READY' })
    f.child.emit('message', { type: 'INITIALIZED' })
    await flush()
    if (mode === 'cancelled') f.owner.cancel()
    admit(mode === 'cancelled')
    await flush()
    assert.equal(f.messages.some(value => value.type === 'START'), false)
    assert.equal(f.messages.some(value => value.type === 'CANCEL'), true)
    f.child.emit('close', 1, null)
    assert.equal((await f.owner.completion).quiescent, false)
  }
})

test('mere TERMINAL IPC or proxy close cannot substitute for its signed receipt', async t => {
  const f = proxy(t, () => true)
  f.child.emit('message', { type: 'READY' })
  f.child.emit('message', { type: 'INITIALIZED' })
  await flush()
  f.child.emit('message', { type: 'TERMINAL' })
  f.child.emit('close', 0, null)
  assert.equal((await f.owner.completion).quiescent, false)
})
