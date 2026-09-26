import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { test } from 'node:test'
import ownedModule from '../../shell/owned-claim-process.cjs'

const { spawnOwnedClaim } = ownedModule
const root = path.resolve('owned-claim-fixture')
const inputs = { command: process.execPath, args: ['claim-entry.js', 'status'],
  payloadRoot: root, stateRoot: path.join(root, 'state'), environment: { ELECTRON_RUN_AS_NODE: '1' } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function linuxFixture() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  const writes = []
  child.stdin.write = value => { writes.push(value) }
  const channel = new EventEmitter()
  child.stdio = [child.stdin, child.stdout, child.stderr, channel]
  let launch
  const owned = spawnOwnedClaim({ ...inputs, platform: 'linux', readHelper: () => 'STATIC PYTHON SOURCE',
    spawn(command, args, options) { launch = { command, args, options }; return child } })
  child.emit('spawn')
  return { child, channel, writes, owned, launch,
    frame(value) { channel.emit('data', Buffer.from(JSON.stringify(value) + '\n')) } }
}

test('Linux starts only after the dedicated ownership channel is ready', async () => {
  const f = linuxFixture()
  assert.deepEqual(f.writes, [])
  assert.equal(f.launch.command, '/usr/bin/python3')
  assert.deepEqual(f.launch.args.slice(0, 4), ['-I', '-u', '-c', 'STATIC PYTHON SOURCE'])
  assert.deepEqual(f.launch.options.env, inputs.environment)
  f.frame({ type: 'ready' })
  assert.deepEqual(f.writes, ['START\n'])
  f.frame({ type: 'started' })
  f.frame({ type: 'complete', quiescent: true, started: true, cancelled: false, exitCode: 0 })
  let settled = false
  f.owned.completion.then(() => { settled = true })
  f.child.emit('exit', 0, null)
  await Promise.resolve()
  assert.equal(settled, false, 'the owner must also close its pipes')
  f.child.emit('close', 0, null)
  assert.equal((await f.owned.completion).quiescent, true)
})

test('an early cancellation cannot authorize the Linux claim CLI', async () => {
  const f = linuxFixture()
  const cancelled = f.owned.cancel()
  f.frame({ type: 'ready' })
  assert.equal(f.writes.includes('START\n'), false)
  f.frame({ type: 'complete', quiescent: true, started: false, cancelled: true, exitCode: null })
  f.child.emit('close', 0, null)
  assert.deepEqual(await cancelled, { quiescent: true, started: false, exitedNormally: false, exitCode: null })
})

test('Linux missing, duplicate, and malformed owner receipts are all unknown', async () => {
  for (const mode of ['missing', 'duplicate', 'malformed', 'signal', 'nonzero-close']) {
    const f = linuxFixture()
    f.frame({ type: 'ready' })
    f.frame({ type: 'started' })
    if (mode !== 'missing') {
      f.frame({ type: 'complete', quiescent: true, started: true, cancelled: false, exitCode: 0 })
      if (mode === 'duplicate') f.frame({ type: 'complete', quiescent: true, started: true, cancelled: false, exitCode: 0 })
      if (mode === 'malformed') f.channel.emit('data', Buffer.from('unexpected secret-shaped text\n'))
    }
    f.child.emit('close', mode === 'nonzero-close' ? 1 : 0, mode === 'signal' ? 'SIGKILL' : null)
    assert.equal((await f.owned.completion).quiescent, false, mode)
  }
})

test('Linux unsupported native ownership is a proved pre-spawn refusal', async () => {
  const f = linuxFixture()
  f.frame({ type: 'complete', quiescent: true, started: false, cancelled: false, exitCode: null })
  f.child.emit('close', 0, null)
  const result = await f.owned.completion
  assert.equal(result.started, false)
  assert.equal(result.quiescent, true)
  assert.equal(f.writes.length, 0)
})

test('oversized Linux receipt output cannot become a quiescent answer', async () => {
  const f = linuxFixture()
  f.channel.emit('data', Buffer.alloc(4097, 65))
  f.child.emit('close', 0, null)
  assert.equal((await f.owned.completion).quiescent, false)
  assert(f.writes.includes('CANCEL\n'))
})

test('Windows requires the actual empty Job outcome and wrapper close', async () => {
  const child = new EventEmitter()
  const outcome = deferred()
  const close = deferred()
  child.jobOutcome = outcome.promise
  child.jobClosed = close.promise
  let invocation
  const owned = spawnOwnedClaim({ ...inputs, platform: 'win32', spawn() {},
    loadJobControl(file) {
      assert.equal(file, path.join(root, 'src', 'lib', 'windows-job-control.js'))
      return { spawnInJob(command, args, options, dependencies) {
        invocation = { command, args, options, dependencies }; return child
      } }
    } })
  assert.equal(invocation.options.terminateDescendantsOnRootExit, true)
  assert.equal(invocation.dependencies.recordDirectory, path.join(inputs.stateRoot, 'state', 'claim-jobs'))
  assert.deepEqual(invocation.dependencies.safeLaunchEnvironment({ SECRET: 'refused' }), inputs.environment)
  let settled = false
  owned.completion.then(() => { settled = true })
  child.emit('exit', 0, null)
  outcome.resolve({ type: 'exit', exitCode: 0, activeProcesses: 0 })
  await Promise.resolve()
  assert.equal(settled, false)
  close.resolve({ code: 0, signal: null, failure: null })
  assert.deepEqual(await owned.completion, { quiescent: true, started: true, exitedNormally: true, exitCode: 0 })
})

test('Windows a closed wrapper with a nonempty Job receipt remains unknown', async () => {
  const child = new EventEmitter()
  child.jobOutcome = Promise.resolve({ type: 'exit', exitCode: 0, activeProcesses: 1 })
  child.jobClosed = Promise.resolve({ code: 0, signal: null, failure: null })
  const owned = spawnOwnedClaim({ ...inputs, platform: 'win32', spawn() {},
    loadJobControl: () => ({ spawnInJob: () => child }) })
  assert.equal((await owned.completion).quiescent, false)
})

test('unsupported platforms refuse before any child is created', () => {
  let spawns = 0
  assert.throws(() => spawnOwnedClaim({ ...inputs, platform: 'unsupported', spawn() { spawns += 1 } }))
  assert.equal(spawns, 0)
})
