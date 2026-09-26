import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const { acquireSandboxPreparation } = createRequire(import.meta.url)('../../shell/sandbox-setup-lease.cjs')
const linuxTest = (name, body) => test(name, { skip: process.platform !== 'linux' ? 'Linux ownership, modes and crash recovery require Linux' : false }, body)
const bootId = '11111111-1111-4111-8111-111111111111'
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lease-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stateRoot = path.join(dir, 'profile'), runtimeRoot = path.join(dir, 'runtime'), other = path.join(dir, 'other')
  for (const root of [stateRoot, runtimeRoot, other]) fs.mkdirSync(root, { mode: 0o700 })
  const options = { stateRoot, runtimeRoot, bootId, platform: 'linux', uid: process.getuid?.() }
  return { dir, stateRoot, runtimeRoot, other, options, acquire: extra => acquireSandboxPreparation({ ...options, ...extra }) }
}
linuxTest('durable profile and per-user slot exclude another app instance and another profile', t => {
  const f = fixture(t), lease = f.acquire()
  assert.throws(() => f.acquire(), { code: 'SANDBOX_SETUP_RECOVERY_REQUIRED' })
  assert.throws(() => f.acquire({ stateRoot: f.other }), { code: 'SANDBOX_SETUP_RECOVERY_REQUIRED' })
  assert.equal(fs.existsSync(path.join(f.other, '.sandbox-image-preparation')), false)
  assert.equal(lease.finish().status, 'released')
  f.acquire({ stateRoot: f.other }).finish()
})
linuxTest('known prebuild failure releases; unknown build survives app restart without PID-based unlock', t => {
  const f = fixture(t)
  f.acquire().finish({ completed: false })
  const build = f.acquire(); build.markBuildStarted()
  assert.equal(build.finish({ completed: false }).recoveryRequired, true)
  assert.throws(() => f.acquire(), { code: 'SANDBOX_SETUP_RECOVERY_REQUIRED' })
  assert.throws(() => build.finish({ completed: true }))
})
linuxTest('successful verification releases both slots; changed kernel boot safely recovers interrupted build', t => {
  const f = fixture(t), first = f.acquire(); first.markBuildStarted(); first.finish({ completed: true })
  const interrupted = f.acquire(); interrupted.markBuildStarted(); interrupted.finish()
  f.acquire({ bootId: '22222222-2222-4222-8222-222222222222' }).finish()
})
linuxTest('symlink journal or root never follows another directory', t => {
  const f = fixture(t), target = path.join(f.stateRoot, '.sandbox-image-preparation')
  fs.symlinkSync(f.other, target)
  assert.throws(() => f.acquire())
  assert.deepEqual(fs.readdirSync(f.other), [])
})
linuxTest('modified journal token refuses release instead of deleting another attempt', t => {
  const f = fixture(t), lease = f.acquire()
  const file = path.join(f.stateRoot, '.sandbox-image-preparation/record.json')
  const record = JSON.parse(fs.readFileSync(file)); record.token = '33333333-3333-4333-8333-333333333333'
  fs.writeFileSync(file, JSON.stringify(record))
  assert.throws(() => lease.finish(), { code: 'SANDBOX_SETUP_COORDINATION_UNAVAILABLE' })
  assert.ok(fs.existsSync(file))
})
test('unsupported Windows coordination refuses before any lock mutation', t => {
  const f = fixture(t)
  assert.throws(() => f.acquire({ platform: 'win32' }), { code: 'SANDBOX_SETUP_COORDINATION_UNSUPPORTED' })
  assert.deepEqual(fs.readdirSync(f.stateRoot), [])
})
for (const action of ['crash', 'build-crash']) linuxTest(`real child ${action}: next process refuses same boot; simulated next kernel boot recovers`, t => {
  const f = fixture(t)
  const run = (mode, boot = bootId) => spawnSync(process.execPath,
    [fileURLToPath(new URL('./fixtures/sandbox-setup-lease-child.cjs', import.meta.url)), f.stateRoot, f.runtimeRoot, boot, mode],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const killed = run(action)
  assert.equal(killed.signal, 'SIGKILL'); assert.equal(killed.error, undefined)
  const blocked = run('complete')
  assert.equal(blocked.status, 2); assert.equal(blocked.stdout, 'SANDBOX_SETUP_RECOVERY_REQUIRED')
  const recovered = run('complete', '22222222-2222-4222-8222-222222222222')
  assert.equal(recovered.status, 0, recovered.stderr); assert.equal(recovered.stdout, 'released')
})
linuxTest('real child preflight release allows a second process without reboot', t => {
  const f = fixture(t)
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL('./fixtures/sandbox-setup-lease-child.cjs', import.meta.url)), f.stateRoot, f.runtimeRoot, bootId, 'preflight'],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'released')
  }
})
linuxTest('incomplete/malformed journal refuses distinctly even after simulated reboot', t => {
  for (const contents of [null, '{broken', JSON.stringify({ version: 1, token: 'bad', bootId })]) {
    const f = fixture(t), dir = path.join(f.stateRoot, '.sandbox-image-preparation')
    fs.mkdirSync(dir, { mode: 0o700 })
    if (contents !== null) fs.writeFileSync(path.join(dir, 'record.json'), contents, { mode: 0o600 })
    assert.throws(() => f.acquire({ bootId: '22222222-2222-4222-8222-222222222222' }), { code: 'SANDBOX_SETUP_JOURNAL_UNREADABLE' })
    assert.ok(fs.existsSync(dir))
  }
})
linuxTest('retained descriptors cannot authorize build after named state root replacement', t => {
  const f = fixture(t), lease = f.acquire(), moved = path.join(f.dir, 'moved-profile')
  fs.renameSync(f.stateRoot, moved); fs.mkdirSync(f.stateRoot, { mode: 0o700 })
  assert.throws(() => lease.markBuildStarted(), { code: 'SANDBOX_SETUP_COORDINATION_UNAVAILABLE' })
  assert.deepEqual(fs.readdirSync(f.stateRoot), [])
  lease.finish() // exact retained inode cleanup, never the new named root
  assert.deepEqual(fs.readdirSync(f.stateRoot), [])
})
linuxTest('created journal directories and files have exact private ownership/modes', t => {
  const f = fixture(t), lease = f.acquire()
  for (const dir of [path.join(f.stateRoot, '.sandbox-image-preparation'), path.join(f.runtimeRoot, 'toolsenabled-sandbox-image-preparation')]) {
    const st = fs.statSync(dir), file = fs.statSync(path.join(dir, 'record.json'))
    assert.equal(st.uid, process.getuid()); assert.equal(st.mode & 0o777, 0o700)
    assert.equal(file.uid, process.getuid()); assert.equal(file.mode & 0o777, 0o600)
  }
  lease.finish()
})
linuxTest('unsafe mode substituted immediately after mkdir refuses before record write', t => {
  const f = fixture(t)
  const source = fs.readFileSync(new URL('../../shell/sandbox-setup-lease.cjs', import.meta.url), 'utf8')
  const altered = new Proxy(fs, { get(target, key) {
    if (key === 'mkdirSync') return (dir, options) => {
      const result = fs.mkdirSync(dir, options)
      if (dir.endsWith('/.sandbox-image-preparation')) fs.chmodSync(dir, 0o777)
      return result
    }
    return target[key]
  } })
  const realRequire = createRequire(import.meta.url)
  const module = { exports: {} }
  vm.runInNewContext(source, { module, process, require: name => name === 'node:fs' ? altered : realRequire(name) })
  assert.throws(() => module.exports.acquireSandboxPreparation(f.options), { code: 'SANDBOX_SETUP_COORDINATION_UNAVAILABLE' })
  assert.equal(fs.existsSync(path.join(f.stateRoot, '.sandbox-image-preparation/record.json')), false)
})
