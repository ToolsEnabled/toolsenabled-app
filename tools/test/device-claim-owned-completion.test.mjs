import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { test } from 'node:test'
import claimModule from '../../shell/device-claim.cjs'
import lifetimeReceipts from '../../shell/claim-lifetime-receipts.cjs'

const { createDeviceClaim, CODES } = claimModule

function fixture() {
  const children = []
  const timers = new Map()
  let nextTimer = 0
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => true
    children.push(child)
    return child
  }
  const spawnOwned = ({ args }) => {
    const child = spawn()
    child.args = args
    child.descriptor = lifetimeReceipts.createIdentity().descriptor
    let complete
    const completion = new Promise(resolve => { complete = resolve })
    child.receipt = complete
    child.cancelled = false
    return { child, completion, descriptor: child.descriptor,
      cancel() { child.cancelled = true; return completion } }
  }
  const claim = createDeviceClaim({ spawn, spawnOwned,
    resolvePayloadRoot: () => path.resolve('fixture-capability'), exists: () => true,
    stateRoot: path.resolve('fixture-state'), execPath: process.execPath, env: {},
    statusTimeoutMs: 20, networkTimeoutMs: 40, cleanupTimeoutMs: 10,
    setTimeout(fn, ms) { const key = ++nextTimer; timers.set(key, { fn, ms }); return key },
    clearTimeout(key) { timers.delete(key) },
  })
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { claim, children, tick,
    expire(ms) { for (const [key, timer] of [...timers]) if (timer.ms === ms) { timers.delete(key); timer.fn() } },
    answer(child, value, { quiescent = true, exitCode = 0, exitedNormally = true } = {}) {
      child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'))
      child.emit('exit', exitCode, null)
      child.emit('close', exitCode, null)
      child.receipt({ quiescent, started: true, exitedNormally, exitCode })
    },
  }
}

test('a caller timeout leaves the claim lane occupied until owned descendants are gone', async () => {
  const f = fixture()
  const status = f.claim.status()
  f.expire(20)
  const timeout = await status
  assert.equal(timeout.code, CODES.TIMEOUT)
  const attempt = f.claim.begin({ name: 'Computer' })
  await f.tick()
  assert.equal(f.children.length, 1, 'timeout must not admit a second child')
  const blocked = await attempt
  assert.equal(blocked.code, CODES.BUSY)
  assert.equal(timeout.childQuiescent, false)
  assert.doesNotMatch(timeout.reason, /nothing (?:was )?changed/i)
  f.answer(f.children[0], { connected: true })
  await f.tick()
  const fresh = f.claim.status()
  assert.equal(f.children.length, 2)
  f.answer(f.children[1], { connected: false })
  assert.equal((await fresh).childQuiescent, true)
})

test('CLI exit and EOF cannot release the lane before the owner receipt', async () => {
  const f = fixture()
  const status = f.claim.status()
  const child = f.children[0]
  child.stdout.emit('data', Buffer.from('{"connected":false}\n'))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
  await f.tick()
  const attempt = f.claim.begin({ name: 'Computer' })
  await f.tick()
  assert.equal(f.children.length, 1, 'root exit must not admit a second child')
  assert.equal((await attempt).code, CODES.BUSY)
  child.receipt({ quiescent: true, started: true, exitedNormally: true, exitCode: 0 })
  assert.equal((await status).childQuiescent, true)
})

test('an unknown owner receipt never allows another mutating child', async () => {
  const f = fixture()
  const status = f.claim.status()
  f.answer(f.children[0], { connected: false }, { quiescent: false })
  assert.equal((await status).childQuiescent, false)
  assert.deepEqual(await f.claim.invalidateForDisconnect(), { quiescent: false })
  assert.equal((await f.claim.begin({ name: 'Computer' })).code, CODES.BUSY)
  assert.equal(f.children.length, 1)
})

test('disconnect invalidation is synchronous and refuses a late connected status', async () => {
  const f = fixture()
  const old = f.claim.status()
  const quiescence = f.claim.invalidateForDisconnect()
  assert.equal(f.claim.enrolled(), false)
  assert.equal(f.claim.claimOpen(), false)
  f.answer(f.children[0], { connected: true, deviceId: 'old-device' })
  assert.deepEqual(await quiescence, { quiescent: true })
  assert.equal((await old).code, CODES.INVALIDATED)
  assert.equal(f.claim.enrolled(), false)
  const status = f.claim.status()
  f.answer(f.children[1], { connected: true })
  assert.equal((await status).connected, true)
  assert.equal(f.claim.enrolled(), false, 'informational status cannot rearm enrollment')
})

test('a late open cannot recreate the token discarded by disconnect intent', async () => {
  const f = fixture()
  const open = f.claim.begin({ name: 'Computer' })
  const stopped = f.claim.invalidateForDisconnect()
  f.answer(f.children[0], { code: 'TC-TEST-TEST', pollToken: 'secret-old-token' })
  assert.equal((await open).code, CODES.INVALIDATED)
  assert.deepEqual(await stopped, { quiescent: true })
  assert.equal(f.claim.claimOpen(), false)
  assert.deepEqual(await f.claim.poll(), { ok: true, state: 'none', childQuiescent: true })
})

test('a late collecting poll cannot restore enrollment or expose the discarded token', async () => {
  const f = fixture()
  const open = f.claim.begin({ name: 'Computer' })
  f.answer(f.children[0], { code: 'TC-TEST-TEST', pollToken: 'secret-old-token' })
  await open
  const poll = f.claim.poll()
  const stopped = f.claim.invalidateForDisconnect()
  f.answer(f.children[1], { state: 'connected', deviceId: 'old-device', deviceToken: 'secret-device-token' })
  const result = await poll
  assert.equal(result.code, CODES.INVALIDATED)
  assert.doesNotMatch(JSON.stringify(result), /secret-/)
  assert.deepEqual(await stopped, { quiescent: true })
  assert.equal(f.claim.enrolled(), false)
  assert.equal(f.claim.claimOpen(), false)
})

test('bounded invalidation may answer unknown while the old lane remains held', async () => {
  const f = fixture()
  const old = f.claim.status()
  const stopped = f.claim.invalidateForDisconnect()
  f.expire(10)
  assert.deepEqual(await stopped, { quiescent: false })
  assert.equal((await f.claim.begin({ name: 'Computer' })).childQuiescent, false)
  f.answer(f.children[0], { connected: false })
  assert.equal((await old).code, CODES.INVALIDATED)
  const fresh = f.claim.begin({ name: 'Computer' })
  f.answer(f.children[1], { code: 'TC-FRESH-CODE', pollToken: 'fresh-private-token' })
  assert.equal((await fresh).ok, true)
})

test('legacy clear success is uncertain without a typed durability receipt', async () => {
  const f = fixture()
  const disconnect = f.claim.disconnect()
  await f.tick()
  f.answer(f.children[0], { cleared: true, wasConnected: true })
  const result = await disconnect
  assert.equal(result.ok, false)
  assert.equal(result.mutationOutcome, 'UNCERTAIN')
  assert.equal(result.childQuiescent, true)
})

test('typed clear success requires the mutation owner to close, not just prior invalidation', async () => {
  const f = fixture()
  assert.deepEqual(await f.claim.invalidateForDisconnect(), { quiescent: true })
  const disconnect = f.claim.disconnect()
  await f.tick()
  f.expire(20)
  const result = await disconnect
  assert.equal(result.ok, false)
  assert.equal(result.mutationOutcome, 'UNCERTAIN')
  assert.equal(result.childQuiescent, false)
  f.answer(f.children[0], { cleared: true, wasConnected: true, mutationOutcome: 'REMOVED_SYNCED' })
  await f.tick()
  assert.equal((await f.claim.cancel()).childQuiescent, true)
})

test('clear failure preserves only a known local cause and static actionable guidance', async () => {
  for (const cause of ['SECRET_BACKEND_LOCKED', 'SECRET_BACKEND_UNAVAILABLE',
    'SECRET_BACKEND_KEY_MISSING', 'SECRET_BACKEND_KEY_INVALID', 'hostile-private-path']) {
    const f = fixture()
    const disconnect = f.claim.disconnect()
    await f.tick()
    f.answer(f.children[0], { error: { code: 'DEVICE_CREDENTIAL_CLEAR_FAILED',
      mutationOutcome: 'NOT_ATTEMPTED', localCause: cause, message: 'private-secret-details' } }, { exitCode: 1 })
    const result = await disconnect
    assert.equal(result.ok, false)
    assert.equal(result.localCause, cause.startsWith('SECRET_') ? cause : 'SECRET_HELPER_PROTOCOL_INVALID')
    assert.equal(result.mutationOutcome, cause.startsWith('SECRET_') ? 'NOT_ATTEMPTED' : 'UNCERTAIN')
    assert.doesNotMatch(JSON.stringify(result), /private-|account service refused/i)
  }
})

test('successful disconnect and absence keep the validated closed outcome', async () => {
  for (const [wasConnected, mutationOutcome] of [[true, 'REMOVED_SYNCED'], [false, 'NOT_ATTEMPTED']]) {
    const f = fixture()
    const disconnect = f.claim.disconnect()
    await f.tick()
    f.answer(f.children[0], { cleared: true, wasConnected, mutationOutcome, privateKey: 'never-forwarded' })
    assert.deepEqual(await disconnect, { ok: true, wasConnected, mutationOutcome, childQuiescent: true })
  }
})

test('only this instance\'s exact retained ownership descriptor may join its current status lane', async () => {
  const f = fixture()
  const unrelated = lifetimeReceipts.createIdentity().descriptor
  assert.equal(f.claim.ownsPendingOwnership(unrelated), false)
  const first = f.claim.status()
  const current = f.children[0].descriptor
  assert.equal(f.claim.ownsPendingOwnership({ ...current }), true)
  assert.equal(f.claim.ownsPendingOwnership(unrelated), false)
  assert.equal(f.claim.ownsPendingOwnership({ ...current, publicKey: unrelated.publicKey }), false)
  assert.equal(f.claim.ownsPendingOwnership({ ...current, path: 'untrusted' }), false)
  assert.strictEqual(f.claim.status(), first)
  assert.equal(f.children.length, 1)
  f.expire(20)
  assert.equal((await first).childQuiescent, false)
  assert.equal(f.claim.ownsPendingOwnership(current), true, 'timeout retains this owned lane')
  assert.equal((await f.claim.status()).code, CODES.BUSY)
  assert.equal(f.children.length, 1, 'joining cannot spawn over an unknown owner')
  f.answer(f.children[0], { connected: false })
  await f.tick()
  assert.equal(f.claim.ownsPendingOwnership(current), false, 'real terminal completion releases current ownership')
})

test('status, open and poll preserve bounded local credential causes without remote-service blame', async () => {
  for (const verb of ['status', 'begin', 'poll']) {
    for (const cause of ['SECRET_BACKEND_LOCKED', 'SECRET_BACKEND_UNAVAILABLE',
      'SECRET_BACKEND_KEY_MISSING', 'SECRET_BACKEND_KEY_INVALID', 'SECRET_hostile_private_details']) {
      const f = fixture()
      if (verb === 'poll') {
        const opened = f.claim.begin({ name: 'Computer' })
        f.answer(f.children.at(-1), { code: 'TC-TEST-TEST', pollToken: 'fixture-private-token' })
        await opened
      }
      const request = verb === 'begin' ? f.claim.begin({ name: 'Computer' }) : f.claim[verb]()
      f.answer(f.children.at(-1), { error: { code: cause, message: 'private-child-message' } }, { exitCode: 1 })
      const result = await request
      assert.equal(result.code, CODES.LOCAL_CREDENTIAL_UNAVAILABLE)
      assert.equal(result.localCause, cause.includes('hostile') ? 'SECRET_HELPER_PROTOCOL_INVALID' : cause)
      assert.equal(result.childQuiescent, true)
      assert.doesNotMatch(JSON.stringify(result), /private-|hostile|account service refused|remote access remains stopped/i)
      if (cause.endsWith('KEY_MISSING') || cause.endsWith('KEY_INVALID')) {
        assert.match(result.reason, /keep the existing encrypted data/i)
        assert.match(result.reason, /supported recovery/i)
      }
    }
  }
  assert.doesNotMatch(claimModule.REASONS[CODES.DISCONNECT_FAILED], /remote access remains stopped/i)
})
