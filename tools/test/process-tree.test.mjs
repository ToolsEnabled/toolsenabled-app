import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { descendantPids, processSnapshot, reapPids } from '../process-tree.cjs'

/* Why this suite exists, in one line: `taskkill /T` is not a tree kill when
   the middle process is already dead, and a check that does not FORCE that
   condition cannot tell the difference. */

const isWindows = process.platform === 'win32'
const alive = (pid) => !isWindows ? (() => { try { process.kill(pid, 0); return true } catch { return false } })() : spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`,
], { encoding: 'utf8' }).stdout.trim() === '1'

const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function fixtures(t) {
  const directory = mkdtempSync(join(tmpdir(), 'process-tree-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'grandchild.cjs'), 'setInterval(() => {}, 1000)\n')
  // detached, so it genuinely survives its parent -- like a crashpad handler
  writeFileSync(join(directory, 'middle.cjs'), `
    const { spawn } = require('node:child_process')
    const path = require('node:path')
    const child = spawn(process.execPath, [path.join(__dirname, 'grandchild.cjs')], {
      detached: true, stdio: 'ignore',
    })
    child.unref()
    console.log('GRANDCHILD=' + child.pid)
    setTimeout(() => process.exit(0), 1200)
  `)
  return directory
}

/* Start the middle, capture the detached grandchild's pid, and wait for the
   middle to exit on its own -- the shape an Electron app leaves behind. */
async function orphanedGrandchild(directory) {
  const middle = spawn(process.execPath, [join(directory, 'middle.cjs')], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let grandchildPid = null
  middle.stdout.on('data', (chunk) => {
    const match = String(chunk).match(/GRANDCHILD=(\d+)/)
    if (match) grandchildPid = Number(match[1])
  })
  await new Promise(resolve => middle.once('exit', resolve))
  await settle(800)
  return { middlePid: middle.pid, grandchildPid }
}

test('taskkill /T does NOT reach an orphaned grandchild', { skip: !isWindows }, async (t) => {
  const directory = fixtures(t)
  const { middlePid, grandchildPid } = await orphanedGrandchild(directory)
  t.after(() => { try { execFileSync('taskkill', ['/PID', String(grandchildPid), '/F'], { stdio: 'ignore' }) } catch {} })

  // PRECONDITION. Without this the test can pass because the grandchild died
  // with its parent, which measures nothing at all. This assertion is the
  // entire difference between a real check and a false green.
  assert.equal(alive(middlePid), false, 'the middle must be dead for this to be the case under test')
  assert.equal(alive(grandchildPid), true, 'the grandchild must have survived, or nothing is being measured')

  let taskkillFailed = false
  try {
    execFileSync('taskkill', ['/PID', String(middlePid), '/T', '/F'], { stdio: 'ignore' })
  } catch { taskkillFailed = true }

  await settle(900)
  assert.equal(taskkillFailed, true, 'taskkill against an already-dead pid is expected to fail outright')
  assert.equal(alive(grandchildPid), true, '/T must be shown NOT to reach the orphan -- this is why reaping happens in the parent')
})

test('descendantPids finds a live descendant, and reapPids kills it', { skip: !['win32', 'linux', 'darwin'].includes(process.platform) }, async (t) => {
  const directory = fixtures(t)
  const child = spawn(process.execPath, [join(directory, 'grandchild.cjs')], { stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  await settle(600)

  const found = descendantPids(process.pid)
  assert.ok(found.includes(child.pid), 'the walk must find a direct child of this process')

  assert.equal(reapPids([child.pid]), 1)
  await settle(700)
  assert.equal(alive(child.pid), false, 'the reaped process must actually be gone')
})

test('the walk is bounded and safe on nonsense input', () => {
  // A snapshot claiming a process is its own parent must not hang the walk.
  const cyclic = () => [
    { ProcessId: 4242, ParentProcessId: 1 },
    { ProcessId: 4243, ParentProcessId: 4242 },
    { ProcessId: 4242, ParentProcessId: 4243 },
  ]
  assert.deepEqual(descendantPids(1, { snapshot: cyclic }).sort(), [4242, 4243])
  assert.deepEqual(descendantPids(0), [])
  assert.deepEqual(descendantPids(-1), [])
  assert.deepEqual(descendantPids(1, { snapshot: () => [] }), [])
  assert.deepEqual(descendantPids(1, { snapshot: () => [null, { ProcessId: 'x', ParentProcessId: 'y' }] }), [])
})

test('snapshot failures are not reported as an empty process tree or latched', () => {
  let calls = 0
  const busyThenAvailable = () => {
    calls += 1
    if (calls === 1) throw Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' })
    return '[]'
  }

  assert.throws(
    () => processSnapshot({ run: busyThenAvailable, platform: 'win32' }),
    error => error.code === 'PROCESS_SNAPSHOT_UNAVAILABLE' &&
      error.message.includes('does not claim that the process tree is empty') &&
      error.cause?.code === 'EMFILE',
  )
  // CONTROL: a real empty snapshot keeps its old [] answer, and the second
  // invocation proves the transient failure was neither cached nor latched.
  assert.deepEqual(processSnapshot({ run: busyThenAvailable, platform: 'win32' }), [])
  assert.equal(calls, 2)

  assert.throws(
    () => processSnapshot({ run: () => { throw 'temporarily unavailable' } }),
    { code: 'PROCESS_SNAPSHOT_UNAVAILABLE' },
  )
  assert.throws(
    () => processSnapshot({ run: () => 'not json' }),
    { code: 'PROCESS_SNAPSHOT_UNAVAILABLE' },
  )
})
