import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import mainLag from '../../shell/main-lag.cjs'

function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'main-lag-reset-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'main-lag.log')
  let clock = 1000
  const scheduled = []
  const monitor = mainLag.createMainLagMonitor({
    file, intervalMs: 10, thresholdMs: 20,
    now: () => clock, monotonic: () => clock,
    setTimer: callback => {
      const timer = { callback, cancelled: false, unref() {} }
      scheduled.push(timer)
      return timer
    },
    clearTimer: timer => { timer.cancelled = true },
    ...extra,
  })
  return { directory, file, monitor, scheduled,
    lateTick: timer => { clock += 1000; timer.callback() } }
}

test('ordinary stop and start still resume diagnostic recording', t => {
  const f = fixture(t)
  assert.equal(f.monitor.start(), true)
  f.lateTick(f.scheduled[0])
  const first = fs.readFileSync(f.file, 'utf8')
  assert.equal(f.monitor.stop(), true)
  assert.equal(f.scheduled[0].cancelled, true)
  assert.equal(f.monitor.start(), true)
  f.lateTick(f.scheduled[1])
  assert.ok(fs.readFileSync(f.file, 'utf8').length > first.length)
})

test('erase seal prevents a retained timer and settled IPC from recreating the log', async t => {
  const f = fixture(t)
  let listener, settle
  const pending = new Promise(resolve => { settle = resolve })
  const ipc = { handle: (_channel, callback) => { listener = callback } }
  f.monitor.instrument(ipc)
  ipc.handle('mc-reset:erase', () => pending)
  f.monitor.start()
  const timer = f.scheduled[0]
  const returned = listener()
  assert.equal(returned, pending, 'instrumentation must preserve the original reply')
  f.lateTick(timer)
  const bytes = fs.readFileSync(f.file)
  const end = f.monitor.span('outstanding work')

  assert.deepEqual(f.monitor.sealForErase(), { ok: true, sealed: true })
  assert.deepEqual(fs.readFileSync(f.file), bytes, 'sealing itself does not remove or change data')
  assert.equal(timer.cancelled, true)
  fs.rmSync(f.directory, { recursive: true })
  settle({ ok: true })
  assert.deepEqual(await returned, { ok: true })
  end()
  f.monitor.recordDuration('late event', 1000)
  assert.equal(f.monitor.note('late handler', () => 'original result'), 'original result')
  f.lateTick(timer)
  assert.equal(f.monitor.start(), false)
  assert.deepEqual(f.monitor.sealForErase(), { ok: true, sealed: true })
  assert.equal(f.monitor.stats().running, false)
  assert.equal(fs.existsSync(f.directory), false, 'neither log nor deleted profile may return')
})

test('a monitor sealed before it starts never arms a timer or touches files', t => {
  let accesses = 0
  const noFiles = new Proxy({}, { get() { accesses += 1; throw new Error('unexpected file access') } })
  const f = fixture(t, { fs: noFiles })
  assert.deepEqual(f.monitor.sealForErase(), { ok: true, sealed: true })
  assert.equal(f.monitor.start(), false)
  assert.equal(f.scheduled.length, 0)
  assert.equal(accesses, 0)
})

test('a failed timer cancellation still seals retained callbacks before reporting failure', t => {
  const f = fixture(t, { clearTimer() { throw new Error('fixture cancellation failed') } })
  f.monitor.start()
  const timer = f.scheduled[0]
  f.lateTick(timer)
  assert.throws(() => f.monitor.sealForErase(), /fixture cancellation failed/)
  fs.rmSync(f.directory, { recursive: true })
  f.lateTick(timer)
  assert.equal(f.monitor.start(), false)
  assert.equal(fs.existsSync(f.directory), false)
})
