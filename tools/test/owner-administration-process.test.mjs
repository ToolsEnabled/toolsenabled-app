import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { identity } from './owner-administration-fixture.mjs'
import claimModule from '../../shell/device-claim.cjs'
import lifetime from '../../shell/claim-lifetime-process.cjs'
import owned from '../../shell/owned-claim-process.cjs'
import contract from '../../shell/owner-administration-contract.cjs'
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-admin-process-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const keys = identity(root)
  const launches = []
  const claim = claimModule.createDeviceClaim({ spawn() {}, exists: () => true, resolvePayloadRoot: () => root, stateRoot: root,
    spawnOwned(options) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      let complete
      const completion = new Promise(resolve => { complete = resolve })
      const launch = { options, child, cancelled: false, finish(answer, receipt = {}) {
        child.stdout.emit('data', Buffer.from(JSON.stringify(answer) + '\n'))
        complete({ quiescent: true, started: true, exitedNormally: true, exitCode: 0, ...receipt })
      } }
      launches.push(launch)
      return { child, completion, cancel() { launch.cancelled = true; return completion } }
    } })
  return { root, ...keys, claim, launches, input: { context: keys.context } }
}
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }
test('administrative CLI uses private input and only terminal exact durable receipt can refresh cache', async t => {
  const f = fixture(t)
  const pending = f.claim.administer('finalize', { ...f.input, reply: { signature: 'fixture-private-inbox' } })
  assert.equal(f.launches.length, 1)
  const launch = f.launches[0]
  assert.equal(path.basename(launch.options.args[0]), 'online-fra-admin-cli.js')
  assert.equal(launch.options.args.length, 1)
  assert.doesNotMatch(JSON.stringify(launch.options.args), /fixture-private-inbox/)
  assert.equal(JSON.parse(launch.options.input).reply.signature, 'fixture-private-inbox')
  assert.equal(f.claim.enrolled(), false)
  assert.equal(f.claim.completeAdministration(f.receipt(true)), false)
  launch.finish({ ok: true, stage: 'finalized', receipt: f.receipt(true), deviceToken: 'must not escape' })
  const answer = await pending
  assert.equal(answer.ok, true)
  assert.equal(answer.childQuiescent, true)
  assert.doesNotMatch(JSON.stringify(answer), /must not escape/)
  assert.equal(f.claim.completeAdministration({ ...answer.receipt }), false, 'receipt object must be the current exact owned result')
  assert.equal(f.claim.completeAdministration(answer.receipt), true)
  assert.equal(f.claim.enrolled(), true)
  assert.equal(f.claim.completeAdministration(answer.receipt), false, 'a consumed completion cannot be replayed')
})
test('output success with unknown owner closure stays blocked and excludes later children', async t => {
  const f = fixture(t)
  const pending = f.claim.administer('finalize', f.input)
  f.launches[0].finish({ ok: true, stage: 'finalized', receipt: f.receipt(true) }, { quiescent: false })
  const answer = await pending
  assert.equal(answer.ok, false)
  assert.equal(answer.childQuiescent, false)
  assert.equal(f.claim.enrolled(), false)
  assert.equal((await f.claim.administer('resume', f.input)).ok, false)
  assert.equal(f.launches.length, 1)
})
test('late administrative child cannot publish enrollment after synchronous disconnect invalidation', async t => {
  const f = fixture(t)
  const pending = f.claim.administer('finalize', f.input)
  const invalidation = f.claim.invalidateForDisconnect()
  assert.equal(f.launches[0].cancelled, true)
  f.launches[0].finish({ ok: true, stage: 'finalized', receipt: f.receipt(true) })
  assert.equal((await invalidation).quiescent, true)
  assert.equal((await pending).ok, false)
  assert.equal(f.claim.enrolled(), false)
  assert.equal(f.claim.completeAdministration(f.receipt(true)), false)
})
test('pair signing reads current metadata through a separate owned child and derives the browser digest internally', async t => {
  const f = fixture(t)
  const pending = f.claim.administer('pair-request', { ...f.input, webDriveEnabled: true, consentStillEnabled: () => true, capabilityDigest: 'renderer-controlled-refused' })
  assert.equal(JSON.parse(f.launches[0].options.input).action, 'resume')
  f.launches[0].finish({ ok: true, stage: 'stored', signedRequest: f.signedRequest('collect'), receipt: f.receipt(false) })
  await flush()
  assert.equal(f.launches.length, 2)
  const request = JSON.parse(f.launches[1].options.input)
  assert.equal(request.action, 'pair-request')
  assert.equal(request.capabilityDigest, contract.pairDigest('fixture-pair'))
  assert.equal(request.webDriveEnabled, true)
  f.launches[1].finish({ ok: true, stage: 'pair-request', signedRequest: f.signedRequest('pair', { capabilityDigest: request.capabilityDigest }), receipt: f.receipt(true) })
  assert.equal((await pending).ok, true)
})
test('disconnect between pair metadata and signing admits no second child', async t => {
  const f = fixture(t)
  const pending = f.claim.administer('pair-request', { ...f.input, webDriveEnabled: true, consentStillEnabled: () => true })
  const invalidation = f.claim.invalidateForDisconnect()
  f.launches[0].finish({ ok: true, stage: 'stored', signedRequest: f.signedRequest('collect'), receipt: f.receipt(false) })
  await invalidation
  assert.equal((await pending).ok, false)
  assert.equal(f.launches.length, 1)
})
test('Linux actual owned lifetime delivers bounded private input and writes only metadata terminal receipts', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-admin-private-native-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'target.cjs')
  fs.writeFileSync(file, "const fs=require('node:fs'),crypto=require('node:crypto');const value=fs.readFileSync(0);process.stdout.write(JSON.stringify({bytes:value.length,hash:crypto.createHash('sha256').update(value).digest('hex')})+'\\n')")
  const input = JSON.stringify({ marker: 'DISPOSABLE_PRIVATE_INPUT', data: 'ü'.repeat(30000) })
  let descriptor
  const processOwner = lifetime.spawnClaimLifetime({ spawn, command: process.execPath, args: [file], payloadRoot: root,
    stateRoot: root, environment: {}, input,
    onOwnershipStart: value => { descriptor = value; return true }, onOwnershipComplete: () => {} })
  let stdout = ''
  processOwner.child.stdout.on('data', value => { stdout += value })
  const timer = setTimeout(() => processOwner.cancel(), 10000)
  t.after(() => clearTimeout(timer))
  const result = await processOwner.completion
  assert.deepEqual(result, { quiescent: true, started: true, exitedNormally: true, exitCode: 0 })
  const answer = JSON.parse(stdout)
  assert.equal(answer.bytes, Buffer.byteLength(input))
  assert.equal(answer.hash, crypto.createHash('sha256').update(input).digest('hex'))
  const saved = fs.readFileSync(path.join(root, 'state', 'claim-lifetimes', descriptor.id + '.json'), 'utf8')
  assert.doesNotMatch(saved, /DISPOSABLE_PRIVATE_INPUT|input|data|privateKey/)
})
test('oversized input and unsupported private-input platforms refuse before spawning', () => {
  let spawns = 0
  const options = { spawn() { spawns++ }, command: process.execPath, args: [], payloadRoot: '/fixture', stateRoot: '/fixture', environment: {} }
  assert.throws(() => lifetime.spawnClaimLifetime({ ...options, input: 'a'.repeat(65537) }))
  assert.throws(() => owned.spawnOwnedClaim({ ...options, input: '{}', platform: 'win32' }))
  assert.equal(spawns, 0)
})
test('consent withdrawn between metadata and pair signing admits no signing child', async t => {
  const f = fixture(t)
  let consent = true
  const pending = f.claim.administer('pair-request', { ...f.input, webDriveEnabled: true, consentStillEnabled: () => consent })
  consent = false
  f.launches[0].finish({ ok: true, stage: 'stored', signedRequest: f.signedRequest('collect'), receipt: f.receipt(false) })
  assert.equal((await pending).ok, false)
  assert.equal(f.launches.length, 1)
})
