import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import claimModule from '../../shell/device-claim.cjs'
import lifetimeModule from '../../shell/claim-lifetime-process.cjs'

// Real native owner/proxy/CLI descendants, using the same factory as main.cjs.
// No account traffic or customer vault; only disposable programs and files.
const supported = ['linux', 'win32'].includes(process.platform)
const installedPayload = fileURLToPath(new URL('../../capability/', import.meta.url))
function fixture(t, body, deadlines = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-claim-lifetime-'))
  const state = path.join(root, 'state')
  fs.mkdirSync(state, { mode: 0o700 })
  fs.mkdirSync(path.join(root, 'tools'))
  fs.writeFileSync(path.join(root, 'tools/online-fra-claim-cli.js'), body)
  const owners = [], timers = new Map()
  const claim = claimModule.createDeviceClaim({
    resolvePayloadRoot: () => root, stateRoot: state, spawn,
    onOwnershipStart: () => true,
    spawnOwned(options) {
      const owned = lifetimeModule.spawnClaimLifetime({ ...options,
        payloadRoot: process.platform === 'win32' ? installedPayload : options.payloadRoot })
      let ready
      const readyOutput = new Promise(resolve => { ready = resolve })
      owned.child.stdout.on('data', data => { if (String(data).includes('ready')) ready() })
      owners.push({ ...owned, readyOutput })
      return owned
    },
    ...(deadlines ? {
      setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id },
      clearTimeout(id) { timers.delete(id) },
    } : {}),
  })
  t.after(async () => {
    for (const owner of owners) {
      await owner.cancel()
      assert.equal((await owner.completion).quiescent, true, 'Retain isolated state if native cleanup is unproved')
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { claim, owners, deadline() {
    const timer = [...timers.values()].find(value => value.ms === claimModule.STATUS_TIMEOUT_MS)
    assert(timer); timer.fn()
  } }
}

test('native claim waits for an escaped helper family to be reaped', { skip: !supported, timeout: 45000 }, async t => {
  const { claim, owners } = fixture(t, `
    const { spawn } = require('node:child_process');
    const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, windowsHide: true, stdio: 'ignore' });
    helper.unref();
    console.log(JSON.stringify({connected:true, name:'Café 💻'}));
  `)
  const result = await claim.status()
  assert.equal(result.ok, true)
  assert.equal(result.name, 'Café 💻')
  assert.equal(result.childQuiescent, true)
  assert.deepEqual(await owners[0].completion,
    { quiescent: true, started: true, exitedNormally: true, exitCode: 0 })
})

test('native polling carries the token through the lifetime owner without argv disclosure', {
  skip: supported ? false : 'native claim containment requires Linux or Windows', timeout: 45000,
}, async t => {
  const { claim } = fixture(t, `
    const crypto = require('node:crypto');
    const args = process.argv.slice(2);
    const digest = token => crypto.createHash('sha256').update(token).digest('hex');
    if (args[0] === 'open') {
      const token = crypto.randomBytes(32).toString('base64url');
      console.log(JSON.stringify({code:digest(token), pollToken:token}));
    } else if (args[0] === 'poll') {
      const name = args[args.indexOf('--token-env') + 1];
      const token = process.env[name];
      if (!token || args.some(arg => arg.includes(token))) process.exitCode = 2;
      else console.log(JSON.stringify({state:'connected', deviceId:digest(token)}));
    }
  `)
  const opened = await claim.begin({ name: 'Disposable' })
  assert.equal(opened.ok, true)
  const polled = await claim.poll()
  assert.equal(polled.ok, true, 'the containment owner must preserve the private environment handoff')
  assert.equal(polled.state, 'connected')
  assert.equal(polled.device.deviceId, opened.code, 'the polling child received the token minted by open')
  assert.equal(polled.childQuiescent, true)
})

test('native nonzero exit cannot report a successful account connection', { skip: !supported, timeout: 45000 }, async t => {
  const { claim, owners } = fixture(t, 'console.log(JSON.stringify({connected:true})); process.exitCode=17;')
  assert.equal((await claim.status()).code, claimModule.CODES.UNREADABLE)
  assert.equal(claim.enrolled(), false)
  assert.equal((await owners[0].completion).exitCode, 17)
})

test('native timeout refuses another writer until the process family closes', { skip: !supported, timeout: 45000 }, async t => {
  const { claim, owners, deadline } = fixture(t, `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
      { detached:true, windowsHide:true, stdio:'ignore' }).unref();
    console.log('ready'); setInterval(()=>{},1000);
  `, true)
  const pending = claim.status()
  await owners[0].readyOutput
  deadline()
  const competing = claim.begin({ name: 'Disposable' })
  assert.equal((await pending).code, claimModule.CODES.TIMEOUT)
  assert.equal((await competing).code, claimModule.CODES.BUSY)
  assert.equal((await owners[0].completion).quiescent, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(claim.cancel(), { ok: true, dropped: false, childQuiescent: true })
  assert.equal(owners.length, 1)
})
