import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const { createAccessibilityDesktopAdapter } = createRequire(import.meta.url)('../../shell/accessibility-desktop.cjs')
const windowsOnly = { skip: process.platform !== 'win32' }
const response = label => Buffer.from(JSON.stringify({ ok: true, result: [{ title: label, name: 'Stream fixture' }] }))

// Scripted pipe events exercise the actual adapter, not Windows UI Automation.
// Real native window/control coverage remains in accessibility-desktop.test.mjs.
function fixture() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = input => { child.input = JSON.parse(input) }
  let kills = 0, settled = false
  child.kill = () => { kills++; return true }
  const controller = new AbortController()
  const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\ToolsEnabled-Dev', spawnProcess: () => child })
  const pending = adapter.inspect({}, { scope: 'desktop', controller })
  void pending.then(() => { settled = true }, () => { settled = true })
  return { child, controller, pending, kills: () => kills, settled: () => settled,
    write: bytes => child.stdout.emit('data', bytes),
    exit: (code = 0) => child.emit('exit', code, null),
    close: (code = 0) => child.emit('close', code, null) }
}

test('Windows helper preserves UTF-8 across every byte boundary', windowsOnly, async () => {
  const f = fixture()
  const label = 'caf\u00e9 \u754c \ud83d\udc4b'
  for (const byte of response(label)) f.write(Buffer.from([byte]))
  f.exit(); f.close()
  assert.equal((await f.pending).windows[0].label, label)
  assert.equal(f.kills(), 0)
})

test('Windows helper waits for pipe closure and accepts output arriving after root exit', windowsOnly, async () => {
  const f = fixture(), bytes = response('late pipe output')
  f.write(bytes.subarray(0, 12))
  f.exit()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(f.settled(), false, 'root exit is not a drained response')
  f.write(bytes.subarray(12)); f.close()
  assert.equal((await f.pending).windows[0].label, 'late pipe output')
  assert.equal(f.kills(), 0, 'an exited helper must not receive a later stop')
})

test('Windows helper rejects invalid UTF-8 instead of silently changing an observed label', windowsOnly, async () => {
  const f = fixture(), bytes = response('label')
  bytes[bytes.indexOf('label')] = 255
  f.write(bytes); f.exit(); f.close()
  await assert.rejects(f.pending, /no trustworthy result/)
  assert.equal(f.kills(), 0)
})

test('Windows helper rejects nonzero and malformed completion without stopping an exited helper', windowsOnly, async () => {
  for (const [bytes, code] of [[response('not successful'), 7], [Buffer.from('{'), 0], [Buffer.alloc(0), 0]]) {
    const f = fixture()
    f.write(bytes); f.exit(code); f.close(code)
    await assert.rejects(f.pending)
    assert.equal(f.kills(), 0)
  }
})

test('Windows helper enforces its output limit in bytes and does not revive after overflow', windowsOnly, async () => {
  const overhead = response('').length
  const boundary = fixture()
  boundary.write(response('a'.repeat(512 * 1024 - overhead)))
  boundary.exit(); boundary.close()
  assert.equal((await boundary.pending).windows[0].label.length, 512 * 1024 - overhead)
  for (const bytes of [response('a'.repeat(512 * 1024 - overhead + 1)), response('\u754c'.repeat(180000))]) {
    const f = fixture()
    f.write(bytes)
    f.write(response('late successful result')); f.exit(); f.close()
    await assert.rejects(f.pending, /exceeded its bound/)
    assert.equal(f.kills(), 1)
  }
})

test('Windows helper cancellation keeps its first failure and only stops a still-running root', windowsOnly, async () => {
  for (const exited of [false, true]) {
    const f = fixture()
    if (exited) f.exit()
    f.controller.abort()
    f.write(response('too late')); if (!exited) f.exit(); f.close()
    await assert.rejects(f.pending, /stopped.*inspect before retrying/i)
    assert.equal(f.kills(), exited ? 0 : 1)
  }
})

test('Windows helper retains its deadline while exited output pipes remain open', windowsOnly, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  f.write(response('not yet closed')); f.exit()
  t.mock.timers.tick(12000)
  await assert.rejects(f.pending, /timed out.*uncertain.*inspect before retrying/i)
  f.close()
  assert.equal(f.kills(), 0)
})
