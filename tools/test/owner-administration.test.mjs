import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { identity } from './owner-administration-fixture.mjs'
import boundary from '../../shell/owner-administration.cjs'
import contract from '../../shell/owner-administration-contract.cjs'
const linuxFilesystem = { skip: process.platform !== 'linux' && 'Native Linux dirfd, UID and private-mode filesystem boundary' }
function fixture(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'te-admin-boundary-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))
  const stateRoot = path.join(userData, 'capability')
  const directory = path.join(userData, boundary.DIRECTORY)
  fs.mkdirSync(directory, { mode: 0o700 })
  const keys = identity(stateRoot)
  const configFile = path.join(directory, boundary.CONFIG_FILE)
  const replyFile = path.join(directory, boundary.REPLY_FILE)
  const config = { version: 1, ...keys.context }
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  write(configFile, config)
  const calls = []
  let consent = false
  const controller = boundary.createOwnerAdministration({ userData, stateRoot,
    lifecycle: { async administer(action, input) { calls.push({ action, input }); return { ok: true } } }, webDriveEnabled: () => consent })
  return { ...keys, directory, configFile, replyFile, config, calls, controller, write, consent: value => { consent = value } }
}
test('trusted native actions read fixed private context and a matching signed-reply inbox', linuxFilesystem, async t => {
  const f = fixture(t)
  assert.equal((await f.controller.run('prepare')).ok, true)
  assert.deepEqual(f.calls[0], { action: 'prepare', input: { context: f.context } })
  f.write(f.replyFile, { version: 1, action: 'import', operationId: f.context.operationId, reply: { signed: 'opaque fixture' } })
  assert.equal((await f.controller.run('import')).ok, true)
  assert.equal(f.calls[1].input.reply.signed, 'opaque fixture')
  assert.equal((await f.controller.run('finalize')).ok, false)
  assert.equal(f.calls.length, 2)
})
test('renderer cannot supply context paths credentials or arbitrary action before filesystem access', async t => {
  let reads = 0, calls = 0
  t.mock.method(fs, 'lstatSync', () => { reads++; throw Error('No filesystem access expected') })
  const userData = os.userInfo().homedir
  const controller = boundary.createOwnerAdministration({ userData, stateRoot: path.join(userData, 'fixture'),
    platform: 'linux', lifecycle: { administer() { calls++ } }, webDriveEnabled: () => false })
  for (const action of [null, {}, { action: 'prepare', context: { credential: 'untrusted' } }, '../prepare', 'disconnect', true]) {
    assert.equal((await controller.run(action)).ok, false)
  }
  assert.equal(reads, 0)
  assert.equal(calls, 0)
})
test('native pairing reads current consent instead of accepting it from the renderer', linuxFilesystem, async t => {
  const f = fixture(t)
  assert.equal((await f.controller.run('pair-request')).ok, false)
  assert.equal(f.calls.length, 0)
  f.consent(true)
  assert.equal((await f.controller.run('pair-request')).ok, true)
  assert.equal(f.calls[0].input.webDriveEnabled, true)
})
test('missing malformed wrong-profile unknown-field and unsafe-permission configs refuse without calls', linuxFilesystem, async t => {
  const f = fixture(t)
  for (const value of [{ ...f.config, profile: 'd'.repeat(64) }, { ...f.config, extra: true }, { ...f.config, issuerPublicKey: 'bad' }, null]) {
    f.write(f.configFile, value)
    assert.equal((await f.controller.run('prepare')).ok, false)
  }
  f.write(f.configFile, f.config)
  fs.chmodSync(f.configFile, 0o644)
  assert.equal((await f.controller.run('prepare')).ok, false)
  fs.chmodSync(f.configFile, 0o600)
  fs.chmodSync(f.directory, 0o755)
  assert.equal((await f.controller.run('prepare')).ok, false)
  fs.chmodSync(f.directory, 0o700)
  fs.unlinkSync(f.configFile)
  assert.equal((await f.controller.run('prepare')).ok, false)
  assert.equal(f.calls.length, 0)
})
test('symlink hardlink directory and oversized inbox refuse without reading their contents into replies', linuxFilesystem, async t => {
  const f = fixture(t)
  const original = path.join(f.directory, 'original')
  fs.renameSync(f.configFile, original)
  fs.symlinkSync(original, f.configFile)
  assert.equal((await f.controller.run('prepare')).ok, false)
  fs.unlinkSync(f.configFile)
  fs.linkSync(original, f.configFile)
  assert.equal((await f.controller.run('prepare')).ok, false)
  fs.unlinkSync(f.configFile); fs.renameSync(original, f.configFile)
  fs.mkdirSync(f.replyFile)
  assert.equal((await f.controller.run('import')).ok, false)
  fs.rmdirSync(f.replyFile)
  fs.writeFileSync(f.replyFile, 'PRIVATE'.repeat(10000), { mode: 0o600 })
  const answer = await f.controller.run('import')
  assert.equal(answer.ok, false)
  assert.doesNotMatch(JSON.stringify(answer), /PRIVATE/)
  assert.equal(f.calls.length, 0)
})
test('signed public requests and durable receipts require exact binding and named fields', () => {
  const f = identity('/fixture')
  const source = { ok: true, stage: 'stored', signedRequest: f.signedRequest('collect'), receipt: f.receipt(false), privateKey: 'must not escape' }
  const result = contract.answer(source, f.context, 'import')
  assert.doesNotMatch(JSON.stringify(result), /must not escape/)
  for (const change of [{ accountId: 'wrong' }, { publicKey: identity('/fixture').context.publicKey }, { operationId: 'd'.repeat(48) },
    { durable: false }, { readBackVerified: false }, { credentialStored: false }, { serverCollected: true }, { extra: 'secret' }]) {
    assert.throws(() => contract.answer({ ...source, receipt: { ...source.receipt, ...change } }, f.context, 'import'))
  }
  assert.throws(() => contract.answer({ ...source, signedRequest: f.signedRequest('collect', { extra: 'secret' }) }, f.context, 'import'))
  assert.throws(() => contract.answer({ ...source, signedRequest: { ...source.signedRequest, signature: 'a'.repeat(86) } }, f.context, 'import'))
  assert.throws(() => contract.answer({ ok: true, stage: 'finalized', receipt: f.receipt(true) }, f.context, 'resume'), 'resume must require a fresh collection attestation')
})
test('native identity discovery permits only a null public-key pin', linuxFilesystem, async t => {
  const f = fixture(t)
  assert.equal((await f.controller.run('identity')).ok, false)
  f.write(f.configFile, { ...f.config, publicKey: null })
  assert.equal((await f.controller.run('identity')).ok, true)
  assert.equal(f.calls[0].input.context.publicKey, null)
  assert.equal((await f.controller.run('prepare')).ok, false)
})
test('portable identity answers return only the current public key and discard private fields', () => {
  const f = identity('/fixture')
  const answer = contract.answer({ ok: true, stage: 'identity', publicKey: f.context.publicKey, privateKey: 'discard' }, f.context, 'identity')
  assert.deepEqual(Object.keys(answer), ['ok', 'stage', 'publicKey'])
  assert.equal(answer.publicKey, f.context.publicKey)
  assert.doesNotMatch(JSON.stringify(answer), /discard|privateKey/)
})

test('unsupported platforms refuse every administrative action before files consent or lifecycle access', async t => {
  let reads = 0, calls = 0
  for (const name of ['lstatSync', 'openSync', 'readSync']) {
    t.mock.method(fs, name, () => { reads++; throw Error('Unsupported platforms cannot read private inputs') })
  }
  const userData = os.userInfo().homedir
  const dependencies = { userData, stateRoot: path.join(userData, 'fixture'),
    lifecycle: { administer() { calls++ } }, webDriveEnabled() { calls++; return true },
    available() { calls++; return true } }
  const controllers = ['win32', 'darwin', 'freebsd'].map(platform => boundary.createOwnerAdministration({ ...dependencies, platform }))
  if (process.platform !== 'linux') controllers.push(boundary.createOwnerAdministration(dependencies))
  for (const controller of controllers) for (const action of contract.ACTIONS) {
    assert.deepEqual(await controller.run(action), { ok: false, code: 'DEVICE_ADMIN_CONFIGURATION_REFUSED',
      reason: 'Administrative enrollment requires a valid protected local operation configuration.' })
  }
  assert.equal(reads, 0)
  assert.equal(calls, 0)
})
