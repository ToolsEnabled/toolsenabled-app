import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { assertGateWorktreeAvailable, withGateWorktree } from '../release-packager/lib/gate-quarantine.mjs'

const FIXTURE_TEMP = ownedFixtureTempRoot()
const HELPER_URL = new URL('../release-packager/lib/gate-quarantine.mjs', import.meta.url).href

function fixture(t) {
  const temp = fs.realpathSync(FIXTURE_TEMP)
  assert.equal(temp.toLowerCase(), path.resolve(FIXTURE_TEMP).toLowerCase(), 'fixture temp must not redirect elsewhere')
  const root = fs.mkdtempSync(path.join(temp, 'gate-quarantine-test-'))
  assert.equal(path.dirname(root), temp)
  fs.mkdirSync(path.join(root, 'release'))
  let preserve = false
  t.after(() => {
    if (preserve) return
    assert.equal(path.dirname(root), temp)
    assert.equal(fs.realpathSync(root), root, 'only remove the original disposable directory')
    fs.rmSync(root, { recursive: true })
  })
  return {
    root,
    marker: path.join(root, 'release', '.gate-execution-in-flight'),
    preserve() { preserve = true },
  }
}

async function assertRetryRefused(f) {
  assert.equal(fs.existsSync(f.marker), true, 'uncertainty must remain durable')
  assert.throws(() => assertGateWorktreeAvailable(f.root), /incomplete or unconfirmed previous execution/)
  let invoked = false
  await assert.rejects(withGateWorktree(f.root, () => { invoked = true }), /incomplete or unconfirmed previous execution/)
  assert.equal(invoked, false, 'a refused retry must not start its action')
}

async function assertRetryAllowed(f) {
  assert.equal(fs.existsSync(f.marker), false)
  assert.doesNotThrow(() => assertGateWorktreeAvailable(f.root))
  assert.equal(await withGateWorktree(f.root, () => 'retried'), 'retried')
  assert.equal(fs.existsSync(f.marker), false)
}

test('ordinary completion releases the guard after nested work and permits retry', async t => {
  const f = fixture(t)
  const expected = { code: 0, terminationConfirmed: true }
  const actual = await withGateWorktree(f.root, async lease => {
    assert.equal(fs.existsSync(f.marker), true)
    assert.throws(() => assertGateWorktreeAvailable(f.root), /incomplete or unconfirmed/)
    assert.equal(await withGateWorktree(f.root, () => 'nested', { lease }), 'nested')
    assert.equal(fs.existsSync(f.marker), true, 'nested completion must not release the outer guard')
    return expected
  })
  assert.equal(actual, expected)
  await assertRetryAllowed(f)
})

test('a confirmed failure releases the guard and permits retry', async t => {
  const f = fixture(t)
  const failure = Object.assign(new Error('confirmed fixture failure'), { terminationConfirmed: true })
  await assert.rejects(withGateWorktree(f.root, () => { throw failure }), error => error === failure)
  await assertRetryAllowed(f)
  const result = { code: 1, terminationConfirmed: true }
  assert.equal(await withGateWorktree(f.root, () => result), result)
  await assertRetryAllowed(f)
})

test('markUncertain retains the guard even when the action returns successfully', async t => {
  const f = fixture(t)
  assert.equal(await withGateWorktree(f.root, lease => {
    lease.markUncertain()
    return 'completed action, unconfirmed descendants'
  }), 'completed action, unconfirmed descendants')
  await assertRetryRefused(f)
})

test('an unconfirmed returned result retains the guard and refuses retry', async t => {
  const f = fixture(t)
  const result = { code: null, terminationConfirmed: false }
  assert.equal(await withGateWorktree(f.root, () => result), result)
  await assertRetryRefused(f)
})

test('an unconfirmed thrown failure retains the guard and refuses retry', async t => {
  const f = fixture(t)
  const failure = Object.assign(new Error('unconfirmed fixture failure'), { terminationConfirmed: false })
  await assert.rejects(withGateWorktree(f.root, () => { throw failure }), error => error === failure)
  await assertRetryRefused(f)
})

test('an actual child process exiting inside the guarded action leaves a durable refusal', async t => {
  const f = fixture(t)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['TEMP', 'TMP'].includes(key.toUpperCase())))
  env.TEMP = FIXTURE_TEMP
  env.TMP = FIXTURE_TEMP
  // This child creates no descendants. It exits itself inside the action, so
  // the helper cannot run finally; no PID lookup or external process is used.
  const script = `import { withGateWorktree } from ${JSON.stringify(HELPER_URL)};
await withGateWorktree(${JSON.stringify(f.root)}, () => { process.exit(23) });`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: f.root, env, windowsHide: true, timeout: 10_000,
    encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status === null) f.preserve()
  assert.ifError(result.error)
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 23, result.stderr)
  const owner = JSON.parse(fs.readFileSync(path.join(f.marker, 'owner.json'), 'utf8'))
  assert.equal(owner.pid, result.pid, 'the real exited child owns the retained marker')
  await assertRetryRefused(f)
})

test('forged, foreign-worktree and released leases refuse before invoking an action', async t => {
  const first = fixture(t)
  const second = fixture(t)
  let captured
  let invoked = false
  const action = () => { invoked = true }
  await assert.rejects(withGateWorktree(first.root, action, { lease: { worktree: first.root } }), /lease is invalid/)
  assert.equal(fs.existsSync(first.marker), false)
  await withGateWorktree(first.root, async lease => {
    captured = lease
    await assert.rejects(withGateWorktree(second.root, action, { lease }), /lease is invalid/)
    assert.equal(fs.existsSync(first.marker), true)
    assert.equal(fs.existsSync(second.marker), false)
  })
  await assert.rejects(withGateWorktree(first.root, action, { lease: captured }), /lease is invalid/)
  assert.equal(invoked, false)
  await assertRetryAllowed(first)
  await assertRetryAllowed(second)
})
