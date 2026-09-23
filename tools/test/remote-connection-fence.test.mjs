import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import fenceModule from '../../shell/remote-connection-fence.cjs'
const { FILE_NAME, MAX_RECORD_BYTES, createRemoteConnectionFence } = fenceModule

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-connection-fence-'))
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false)
    fs.rmSync(directory, { recursive: true, force: true })
    assert.equal(fs.existsSync(directory), false)
  })
  return { directory, file: path.join(directory, FILE_NAME), load: overrides => createRemoteConnectionFence({ directory, ...overrides }) }
}
function deferredError(code) { return Object.assign(new Error('private detail must not escape'), { code }) }
function owner() {
  const { publicKey } = generateKeyPairSync('ed25519')
  return { version: 1, id: randomUUID(), publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}
function receipt(owner) {
  return { version: 1, kind: 'claim-lifetime-terminal', id: owner.id, quiescent: true,
    started: true, exitedNormally: true, exitCode: 0 }
}
function activeRecord() {
  return JSON.stringify({ version: 2, state: 'active', pendingOwner: null,
    disconnectPending: false, mutationOutcome: null })
}

test('disconnect is immediate, survives restart, and a late prior claim cannot reopen it', t => {
  const { load, file } = fixture(t)
  const fence = load()
  assert.equal(fence.allowsRemote(), true)
  const oldClaim = fence.ticket()
  const disconnect = fence.block()
  assert.equal(fence.allowsRemote(), false)
  assert.equal(fence.isCurrent(oldClaim), false)
  assert.equal(fence.completeFreshClaim(oldClaim, { consentCleared: true }), false)
  assert.equal(fence.recordDisconnect(disconnect), true)
  assert.equal(load().allowsRemote(), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2, state: 'blocked',
    pendingOwner: null, disconnectPending: true, mutationOutcome: null })
})

test('only a current explicit fresh claim with cleared consent can reopen access', t => {
  const { load } = fixture(t)
  const fence = load()
  const ticket = fence.block()
  fence.recordDisconnect(ticket)
  assert.equal(fence.completeCleanup(ticket), true)
  for (const consentCleared of [undefined, false, 'true', 1]) {
    assert.equal(fence.completeFreshClaim(ticket, { consentCleared }), false)
    assert.equal(fence.allowsRemote(), false)
  }
  assert.equal(fence.completeFreshClaim(ticket, { consentCleared: true }), true)
  assert.equal(fence.allowsRemote(), true)
  assert.equal(load().allowsRemote(), true)
  const next = fence.block()
  assert.equal(fence.recordDisconnect(next), true)
  assert.equal(fence.completeFreshClaim(ticket, { consentCleared: true }), false)
  assert.equal(load().allowsRemote(), false)
})

test('observed active replacement after fresh consent stays active with unknown restart sync', t => {
  const { directory, load, file } = fixture(t)
  let flushes = 0
  const initial = load()
  const ticket = initial.block()
  initial.recordDisconnect(ticket)
  initial.completeCleanup(ticket)
  const fence = load({ platform: 'linux', fs: { ...fs,
    openSync: (target, ...args) => target === directory ? fs.openSync(file, 'r') : fs.openSync(target, ...args),
    fsyncSync: fd => { if (++flushes === 2) throw deferredError('EIO'); fs.fsyncSync(fd) },
  } })
  assert.equal(fence.completeFreshClaim(fence.ticket(), { consentCleared: true }), true)
  assert.equal(flushes, 2)
  assert.equal(fence.allowsRemote(), true)
  assert.equal(fence.snapshot().restartSafety, 'unknown')
  assert.equal(load().allowsRemote(), true)
})


test('failed intent writes keep current authority closed and report restart safety unknown', t => {
  const { directory, load, file } = fixture(t)
  const fence = load({ fs: { ...fs, openSync: () => { throw deferredError('EACCES') } } })
  const ticket = fence.block()
  assert.equal(fence.recordDisconnect(ticket), false)
  assert.equal(fence.allowsRemote(), false)
  assert.equal(fence.snapshot().restartSafety, 'unknown')
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(fs.readdirSync(directory), [])
  assert.equal(JSON.stringify(fence.snapshot()).includes('private'), false)
})

test('damaged, oversized, and directory records refuse remote access and preserve customer data', t => {
  const { load, file } = fixture(t)
  for (const text of ['{', 'x'.repeat(MAX_RECORD_BYTES + 1), '{"version":1,"state":"active","consent":"on"}', '{"version":2,"state":"active"}']) {
    fs.writeFileSync(file, text)
    const fence = load()
    assert.equal(fence.allowsRemote(), false)
    assert.equal(fence.snapshot().damaged, true)
    const ticket = fence.block()
    assert.equal(fence.recordDisconnect(ticket), false)
    assert.equal(fence.completeFreshClaim(ticket, { consentCleared: true }), false)
    assert.equal(fs.readFileSync(file, 'utf8'), text)
  }
  fs.unlinkSync(file)
  fs.mkdirSync(file)
  assert.equal(load().allowsRemote(), false)
})

test('record disappearing after inspection and redirected opened file are not legacy absence', t => {
  const { load, file } = fixture(t)
  fs.writeFileSync(file, activeRecord())
  const disappearing = load({ fs: { ...fs, openSync: () => { throw deferredError('ENOENT') } } })
  assert.equal(disappearing.allowsRemote(), false)
  const redirected = load({ fs: { ...fs, fstatSync: fd => ({ ...fs.fstatSync(fd), isFile: () => true, ino: -1 }) } })
  assert.equal(redirected.allowsRemote(), false)
})

test('flush failure never reports saved intent or reuses a stale temporary record', t => {
  const { directory, load, file } = fixture(t)
  const fence = load({ fs: { ...fs, fsyncSync: () => { throw deferredError('EIO') } } })
  const ticket = fence.block()
  assert.equal(fence.recordDisconnect(ticket), false)
  assert.equal(fence.snapshot().restartSafety, 'unknown')
  assert.equal(fence.allowsRemote(), false)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('injected POSIX directory sync failure after actual replacement remains uncertain', t => {
  const { load, file, directory } = fixture(t)
  let flushes = 0
  const fence = load({ platform: 'linux', fs: { ...fs,
    // Windows cannot open a directory descriptor this way; inject that one
    // platform operation while retaining actual file replacement and cleanup.
    openSync: (target, ...args) => target === directory ? fs.openSync(file, 'r') : fs.openSync(target, ...args),
    fsyncSync: fd => {
    if (++flushes === 2) throw deferredError('EIO')
    fs.fsyncSync(fd)
  } } })
  const ticket = fence.block()
  assert.equal(fence.recordDisconnect(ticket), false)
  assert.equal(flushes, 2)
  assert.equal(fence.snapshot().restartSafety, 'unknown')
  assert.equal(fence.allowsRemote(), false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'blocked')
  assert.equal(load().allowsRemote(), false)
})

test('every active invocation is recorded before admission and a restart retains its exact unresolved owner', t => {
  const { load, file } = fixture(t)
  const first = load()
  const original = owner()
  assert.equal(first.admitOwnership(original), true)
  assert.equal(first.allowsRemote(), true, 'an ordinary current-instance status read does not revoke the connection')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pendingOwner, original)
  const restarted = load()
  assert.equal(restarted.allowsRemote(), false)
  assert.equal(restarted.snapshot().disconnectPending, true)
  assert.deepEqual(restarted.snapshot().pendingOwner, original)
  assert.equal(restarted.admitOwnership(owner()), false, 'a new status helper cannot overwrite the old owner')
  assert.equal(restarted.completeCleanup(restarted.ticket()), false)
  assert.equal(restarted.completeFreshClaim(restarted.ticket(), { consentCleared: true }), false)
  assert.equal(restarted.completeOwnership(original, { ...receipt(original), quiescent: false }), false)
  assert.equal(restarted.completeOwnership({ ...original, publicKey: owner().publicKey }, receipt(original)), false)
  assert.equal(restarted.completeOwnership(original, receipt(original)), true)
  assert.equal(restarted.snapshot().pendingOwner, null)
  assert.equal(restarted.allowsRemote(), false, 'a terminal child receipt is not new remote consent')
  assert.equal(load().allowsRemote(), false)
})

test('completed same-instance ownership leaves a normal connection restartable, without persisting a private key', t => {
  const { load, file } = fixture(t)
  const fence = load()
  const current = owner()
  assert.equal(fence.admitOwnership(current), true)
  assert.equal(fence.completeOwnership(current, receipt(current)), true)
  assert.equal(load().allowsRemote(), true)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.pendingOwner, null)
  assert.equal(Object.hasOwn(saved, 'privateKey'), false)
})

test('failed ownership persistence never admits START or silently discards the unresolved identity', t => {
  const { load } = fixture(t)
  const fence = load({ fs: { ...fs, fsyncSync: () => { throw deferredError('EIO') } } })
  const current = owner()
  assert.equal(fence.admitOwnership(current), false)
  assert.equal(fence.allowsRemote(), false)
  assert.deepEqual(fence.snapshot().pendingOwner, current)
  assert.equal(fence.admitOwnership(owner()), false)
  assert.equal(fence.completeOwnership(current, receipt(current)), false)
  assert.deepEqual(fence.snapshot().pendingOwner, current)
})

test('disconnect mutation uncertainty survives cleanup observations and restart', t => {
  const { load } = fixture(t)
  const fence = load()
  const ticket = fence.block()
  assert.equal(fence.recordDisconnect(ticket), true)
  assert.equal(fence.recordOutcome(ticket, 'UNCERTAIN'), true)
  assert.equal(fence.completeCleanup(ticket), true)
  const restarted = load()
  assert.equal(restarted.snapshot().mutationOutcome, 'UNCERTAIN')
  assert.equal(restarted.snapshot().disconnectPending, false)
  assert.equal(restarted.allowsRemote(), false)
})

test('post-lock refresh sees the old primary\'s newly persisted owner instead of overwriting a stale snapshot', t => {
  const { load } = fixture(t)
  const oldPrimary = load()
  const waitingLaunch = load()
  assert.equal(waitingLaunch.snapshot().pendingOwner, null)
  const original = owner()
  assert.equal(oldPrimary.admitOwnership(original), true)
  assert.equal(oldPrimary.refreshForPrimary(), false, 'an already used primary cannot discard its live owner')
  assert.equal(waitingLaunch.refreshForPrimary(), true)
  assert.equal(waitingLaunch.allowsRemote(), false)
  assert.deepEqual(waitingLaunch.snapshot().pendingOwner, original)
  assert.equal(waitingLaunch.admitOwnership(owner()), false)
  assert.deepEqual(load().snapshot().pendingOwner, original)
})
