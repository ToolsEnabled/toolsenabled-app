import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runQaDriverProcess, mayRetryQaDriver } from '../lib/qa-driver-process.mjs'
import { runDriver } from '../packaged-qa-suite.mjs'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const options = { cwd: repo, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 1000, cleanupMs: 1000 }

function fakeOwner({ settleOnCancel = true, receipt = { quiescent: true, started: true, exitedNormally: false, exitCode: null } } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let destroyCount = 0
  const streams = [child.stdout, child.stderr, new EventEmitter(), new EventEmitter()]
  for (const stream of streams) stream.destroy = () => { destroyCount += 1 }
  child.stdio = streams
  child.unref = () => { child.unreferenced = true }
  let complete
  const completion = new Promise(resolve => { complete = resolve })
  let cancelled = 0
  const owner = { child, completion, cancel() { cancelled += 1; if (settleOnCancel) complete(receipt); return completion } }
  return { owner, complete, get cancelled() { return cancelled }, get destroyed() { return destroyCount } }
}

test('Linux QA delegates only the selected driver and environment to the native descendant owner', async () => {
  const f = fakeOwner()
  let invocation
  const result = runQaDriverProcess(process.execPath, ['/qa/driver.cjs', '--release', '/candidate'], {
    ...options, platform: 'linux', spawnOwner(args) { invocation = args; return f.owner },
  })
  f.owner.child.stdout.emit('data', Buffer.from('1/1 checks passed\n'))
  f.complete({ quiescent: true, started: true, exitedNormally: true, exitCode: 0 })
  const actual = await result
  assert.deepEqual(invocation.args, ['/qa/driver.cjs', '--release', '/candidate'])
  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.environment, options.env)
  assert.equal(invocation.payloadRoot, repo)
  assert.equal(invocation.stateRoot, repo)
  assert.equal(actual.code, 0)
  assert.equal(actual.cleanupConfirmed, true)
  assert.equal(actual.cleanupScope, 'linux-subreaper-pidfd-empty')
  assert.equal(f.cancelled, 0)
  assert.equal(f.destroyed, 0)
})

test('a timed-out driver waits for the owner receipt rather than root close', async () => {
  const f = fakeOwner({ settleOnCancel: false })
  const result = runQaDriverProcess(process.execPath, [], { ...options, platform: 'linux', timeoutMs: 15,
    spawnOwner: () => f.owner })
  let finished = false
  result.then(() => { finished = true })
  f.owner.child.emit('close', 0, null)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.cancelled, 1)
  assert.equal(finished, false)
  f.complete({ quiescent: true, started: true, exitedNormally: false, exitCode: -9 })
  const actual = await result
  assert.equal(actual.timedOut, true)
  assert.equal(actual.code, null)
  assert.equal(actual.cleanupConfirmed, true)
  assert.equal(mayRetryQaDriver({ ...actual, verdict: 'TIMEOUT' }), true)
})

test('missing owner completion answers bounded unknown and never authorizes retry', async () => {
  const f = fakeOwner({ settleOnCancel: false })
  const result = await runQaDriverProcess(process.execPath, [], { ...options, platform: 'linux', timeoutMs: 10,
    cleanupMs: 15, spawnOwner: () => f.owner })
  assert.equal(result.timedOut, true)
  assert.equal(result.cleanupUnconfirmed, true)
  assert.equal(result.cleanupConfirmed, false)
  assert.equal(f.cancelled, 1)
  assert.equal(f.destroyed, 4)
  assert.equal(f.owner.child.unreferenced, true)
  assert.equal(mayRetryQaDriver({ ...result, verdict: 'TIMEOUT' }), false)
  f.complete({ quiescent: true, started: true, exitedNormally: false, exitCode: -9 })
})

test('output bounds cancel the owner without accepting a preceding green summary', async () => {
  const f = fakeOwner()
  const result = runQaDriverProcess(process.execPath, [], { ...options, platform: 'linux', maxOutputBytes: 64,
    spawnOwner: () => f.owner })
  f.owner.child.stdout.emit('data', Buffer.from('1/1 checks passed\n'))
  f.owner.child.stdout.emit('data', Buffer.alloc(65, 65))
  const actual = await result
  assert.equal(actual.timedOut, false)
  assert.match(actual.failureReason, /output exceeded 64 bytes/)
  assert.equal(actual.code, null)
  assert.equal(actual.cleanupConfirmed, true)
  assert.equal(f.cancelled, 1)
})

test('unsupported native ownership refuses before launch without claiming a driver pass', async () => {
  const f = fakeOwner()
  const result = runQaDriverProcess(process.execPath, [], { ...options, platform: 'linux', spawnOwner: () => f.owner })
  f.complete({ quiescent: true, started: false, exitedNormally: false, exitCode: null })
  const actual = await result
  assert.match(actual.failureReason, /unavailable before driver launch/)
  assert.equal(actual.cleanupConfirmed, true)
  assert.equal(actual.code, null)
})

for (const receipt of [null, { quiescent: false, started: true, exitedNormally: true, exitCode: 0 }]) {
  test(`invalid owner completion stays unknown (${receipt ? 'nonempty' : 'missing'})`, async () => {
    const f = fakeOwner()
    const result = runQaDriverProcess(process.execPath, [], { ...options, platform: 'linux', spawnOwner: () => f.owner })
    f.complete(receipt)
    const actual = await result
    assert.equal(actual.cleanupUnconfirmed, true)
    assert.equal(actual.code, null)
  })
}

test('owner creation failure is not silently classified as a clean tree', async () => {
  const actual = await runQaDriverProcess(process.execPath, [], { ...options, platform: 'linux',
    spawnOwner() { throw Object.assign(new Error('private diagnostic'), { code: 'OWNER_ERROR' }) } })
  assert.equal(actual.cleanupUnconfirmed, true)
  assert.match(actual.failureReason, /OWNER_ERROR/)
  assert.doesNotMatch(actual.failureReason, /private diagnostic/)
})

test('Windows root-only cancellation remains explicitly unconfirmed and cannot retry', async () => {
  const actual = await runQaDriverProcess(process.execPath, [], { ...options, platform: 'win32',
    async runRoot(_command, _args, received) {
      assert.equal(received.timeoutMs, 1000)
      return { code: null, output: '1/1 checks passed\n', failureReason: 'process timed out after 1000 ms; descendant cleanup UNCONFIRMED',
        cleanupScope: 'root-handle-only; descendants unconfirmed', terminationConfirmed: false }
    } })
  assert.equal(actual.timedOut, true)
  assert.equal(actual.cleanupUnconfirmed, true)
  assert.equal(mayRetryQaDriver({ ...actual, verdict: 'TIMEOUT' }), false)
})

test('only a timeout with affirmative cleanup evidence may retry', () => {
  for (const result of [{ verdict: 'PASS', cleanupConfirmed: true }, { verdict: 'TIMEOUT' },
    { verdict: 'TIMEOUT', cleanupConfirmed: false }, { verdict: 'TIMEOUT', cleanupConfirmed: true, cleanupUnconfirmed: true }]) {
    assert.equal(mayRetryQaDriver(result), false)
  }
  assert.equal(mayRetryQaDriver({ verdict: 'TIMEOUT', cleanupConfirmed: true, cleanupUnconfirmed: false }), true)
})

test('packaged runner propagates failure/cleanup metadata and cannot pass a dishonest green log', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-runner-lifetime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entry = { key: 'fixture', file: '/fixture/driver.mjs', needs: [], runner: 'node', timeoutMs: 1500, source: '' }
  const actual = await runDriver(entry, options.env, { logDirectory: root,
    async runProcess(command, argv, received) {
      assert.equal(command, process.execPath)
      assert.deepEqual(argv, ['/fixture/driver.mjs'])
      assert.equal(received.timeoutMs, 1500)
      assert.equal(received.cwd, repo)
      return { code: 0, output: '1/1 checks passed\n', timedOut: false, failureReason: 'incomplete cleanup',
        cleanupConfirmed: false, cleanupUnconfirmed: true, cleanupScope: 'linux-owner-unconfirmed' }
    } })
  assert.equal(actual.verdict, 'FAIL')
  assert.equal(actual.cleanupUnconfirmed, true)
  assert.equal(actual.exitCode, null)
  assert.match(readFileSync(actual.logPath, 'utf8'), /incomplete cleanup/)
})

test('no stale PID reaping remains and the lifetime regression is a required source suite', () => {
  const source = readFileSync(path.join(repo, 'tools/packaged-qa-suite.mjs'), 'utf8')
  assert.doesNotMatch(source, /taskkill|reap\(child\.pid\)|process\.kill\(/)
  assert.match(source, /if \(result\.cleanupUnconfirmed\) \{[\s\S]*?break/)
  const rows = SOURCE_MANIFESTS.app.inventory.filter(row => row.file === 'tools/test/qa-driver-process.test.mjs')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, null)
})

test('the one qualified retry cannot overwrite the first timeout log', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'qa-retry-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entry = { key: 'fixture', file: '/fixture/driver.mjs', needs: [], runner: 'node', timeoutMs: 1500, source: '' }
  const first = await runDriver(entry, options.env, { logDirectory: root, async runProcess() {
    return { code: null, output: 'initial observation\n', timedOut: true, failureReason: 'time limit',
      cleanupConfirmed: true, cleanupUnconfirmed: false, cleanupScope: 'linux-subreaper-pidfd-empty' }
  } })
  const second = await runDriver(entry, options.env, { logDirectory: root, attempt: 2, async runProcess() {
    return { code: 0, output: 'retry observation\n1/1 checks passed\n', timedOut: false, failureReason: null,
      cleanupConfirmed: true, cleanupUnconfirmed: false, cleanupScope: 'linux-subreaper-pidfd-empty' }
  } })
  assert.notEqual(first.logPath, second.logPath)
  assert.equal(first.attempt, 1)
  assert.equal(second.attempt, 2)
  assert.match(readFileSync(first.logPath, 'utf8'), /initial observation/)
  assert.doesNotMatch(readFileSync(first.logPath, 'utf8'), /retry observation/)
  assert.match(readFileSync(second.logPath, 'utf8'), /retry observation/)
})

test(`real ${process.platform} driver completion preserves output and actual exit`, async () => {
  const actual = await runQaDriverProcess(process.execPath, ['-e', 'process.stdout.write("1/1 checks passed\\n");process.exitCode=7'],
    { ...options, timeoutMs: 5000 })
  assert.equal(actual.code, 7)
  assert.equal(actual.output, '1/1 checks passed\n')
  assert.equal(actual.cleanupUnconfirmed, false)
  if (process.platform === 'linux') assert.equal(actual.cleanupConfirmed, true)
})

test(`real ${process.platform} hanging driver is bounded and cannot keep its prior PASS summary`, async () => {
  const actual = await runQaDriverProcess(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});process.stdout.write("1/1 checks passed\\n");setInterval(()=>{},1000)'],
  { ...options, timeoutMs: 1000, cleanupMs: 3000 })
  assert.equal(actual.timedOut, true)
  assert.equal(actual.code, null)
  if (process.platform === 'linux') assert.equal(actual.cleanupConfirmed, true)
  else assert.equal(actual.cleanupUnconfirmed, true)
})

if (process.platform === 'linux') {
  test('real Linux detached grandchild is reaped before natural driver completion is accepted', async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'qa-native-descendant-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const fixture = path.join(root, 'fixture.cjs')
    writeFileSync(fixture, `const {spawn}=require('node:child_process');
if(process.argv[2]==='descendant'){
  process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000);
}else{
  const child=spawn(process.execPath,[__filename,'descendant'],{detached:true,stdio:['ignore','inherit','inherit','ipc']});
  child.once('message',()=>{process.stdout.write('detached descendant ready\\n1/1 checks passed\\n');process.exit(0)});
}
`)
    const actual = await runQaDriverProcess(process.execPath, [fixture], { ...options, timeoutMs: 5000, cleanupMs: 3000 })
    assert.equal(actual.code, 0)
    assert.equal(actual.cleanupConfirmed, true)
    assert.equal(actual.cleanupScope, 'linux-subreaper-pidfd-empty')
    assert.match(actual.output, /detached descendant ready/)
  })
}
