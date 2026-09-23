import assert from 'node:assert/strict'
import test from 'node:test'

import { wireSingleInstance } from '../../shell/single-instance.cjs'

test('lock lost quits without registering readiness or starting', () => {
  let quitCalls = 0
  let readyRegistrations = 0
  let startCalls = 0

  const gotLock = wireSingleInstance({
    requestLock: () => false,
    quit: () => { quitCalls += 1 },
    whenReady: () => {
      readyRegistrations += 1
      return Promise.resolve()
    },
    onSecondInstance: () => assert.fail('second-instance handler must not be registered'),
    getWindow: () => null,
    start: () => { startCalls += 1 },
    onStartFailure: (error) => assert.fail(error),
  })

  assert.equal(gotLock, false)
  assert.equal(quitCalls, 1)
  assert.equal(readyRegistrations, 0)
  assert.equal(startCalls, 0)
})

test('lock won starts once when ready resolves', async () => {
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  let quitCalls = 0
  let startCalls = 0

  const gotLock = wireSingleInstance({
    requestLock: () => true,
    quit: () => { quitCalls += 1 },
    whenReady: () => ready,
    onSecondInstance: () => {},
    getWindow: () => null,
    start: () => { startCalls += 1 },
    onStartFailure: (error) => assert.fail(error),
  })

  assert.equal(gotLock, true)
  assert.equal(quitCalls, 0)
  assert.equal(startCalls, 0)
  resolveReady()
  await ready
  await Promise.resolve()
  assert.equal(startCalls, 1)
})

test('requests the lock before registering readiness', () => {
  const order = []

  wireSingleInstance({
    requestLock: () => { order.push('request-lock'); return true },
    quit: () => {},
    whenReady: () => { order.push('when-ready'); return new Promise(() => {}) },
    onSecondInstance: () => { order.push('second-instance') },
    getWindow: () => null,
    start: () => {},
    onStartFailure: (error) => assert.fail(error),
  })

  assert.equal(order[0], 'request-lock')
  assert.ok(order.indexOf('request-lock') < order.indexOf('when-ready'))
})

test('second instance restores a minimized window, focuses it, and does not restart', () => {
  const calls = []
  let secondInstanceHandler
  let startCalls = 0
  const win = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => { calls.push('restore') },
    focus: () => { calls.push('focus') },
  }

  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    onSecondInstance: (handler) => { secondInstanceHandler = handler },
    getWindow: () => win,
    start: () => { startCalls += 1 },
    onStartFailure: (error) => assert.fail(error),
  })

  assert.equal(typeof secondInstanceHandler, 'function')
  secondInstanceHandler()
  assert.deepEqual(calls, ['restore', 'focus'])
  assert.equal(startCalls, 0)
})

test('second instance ignores a window that was destroyed while the app is closing', () => {
  let secondInstanceHandler
  const win = {
    isDestroyed: () => true,
    isMinimized: () => assert.fail('destroyed window must not be inspected'),
    restore: () => assert.fail('destroyed window must not be restored'),
    focus: () => assert.fail('destroyed window must not be focused'),
  }

  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    onSecondInstance: (handler) => { secondInstanceHandler = handler },
    getWindow: () => win,
    start: () => {},
    onStartFailure: (error) => assert.fail(error),
  })

  assert.doesNotThrow(() => secondInstanceHandler())
})

test('second-instance data reaches its handler before any focus work', () => {
  const order = []
  let secondInstanceHandler
  const data = { treeNodeCommandRequestId: 'tnc-00000000-0000-4000-8000-000000000000' }
  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    onSecondInstance: (handler) => { secondInstanceHandler = handler },
    handleSecondInstance: (_event, _argv, _cwd, additionalData) => {
      order.push(['command', additionalData])
      return null
    },
    getWindow: () => ({
      isDestroyed: () => false,
      isMinimized: () => false,
      focus: () => { order.push(['focus']) },
    }),
    start: () => {},
    onStartFailure: (error) => assert.fail(error),
  })

  secondInstanceHandler({}, [], 'C:\\work', data)
  assert.deepEqual(order, [['command', data], ['focus']])
})

test('a handled opaque command suppresses focus and works before a window exists', () => {
  let secondInstanceHandler
  let handled = null
  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    onSecondInstance: (handler) => { secondInstanceHandler = handler },
    handleSecondInstance: (_event, _argv, _cwd, additionalData) => {
      handled = additionalData
      return { focus: false }
    },
    getWindow: () => assert.fail('focus-suppressed command must not inspect a window'),
    start: () => {},
    onStartFailure: (error) => assert.fail(error),
  })

  const data = { treeNodeCommandRequestId: 'tnc-00000000-0000-4000-8000-000000000000' }
  assert.doesNotThrow(() => secondInstanceHandler({}, [], 'C:\\work', data))
  assert.equal(handled, data)
})

/* THE ALREADY-RUNNING INSTANCE MUST OUTLIVE A SECOND LAUNCH IT COULD NOT
 * INTERPRET. `start`/`whenReady` have `onStartFailure` as their safety net;
 * `handleSecondInstance` had none. In production this handler is wired
 * straight to `app.on('second-instance', handler)` (shell/main.cjs) -- a
 * plain EventEmitter listener with no caller-side try/catch waiting for it --
 * so a synchronous throw here does not fail the second launch, it becomes an
 * uncaught exception in the FIRST, already-running instance: the one process
 * a command handoff must never be able to reach. shell/main.cjs's own
 * handleSecondInstance is carefully guarded today (its argv-parsing has its
 * own try/catch, and the broker call after it cannot throw), but
 * wireSingleInstance is the general wiring, reused by whatever a later change
 * puts inside that guard, and had nothing of its own protecting it -- unlike
 * every other caller-supplied hook here. */
test('a handleSecondInstance that throws is reported, not left to crash the running instance', () => {
  let secondInstanceHandler
  const failure = new Error('boom from handleSecondInstance')
  let reported = null
  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    onSecondInstance: (handler) => { secondInstanceHandler = handler },
    handleSecondInstance: () => { throw failure },
    onSecondInstanceFailure: (error) => { reported = error },
    getWindow: () => assert.fail('a throw must not fall through to focus/restore'),
    start: () => {},
    onStartFailure: (error) => assert.fail(error),
  })

  assert.doesNotThrow(() => secondInstanceHandler({}, [], 'C:\\work', {}))
  assert.equal(reported, failure)
})

test('a handleSecondInstance that throws with no onSecondInstanceFailure supplied still does not crash', () => {
  let secondInstanceHandler
  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => new Promise(() => {}),
    onSecondInstance: (handler) => { secondInstanceHandler = handler },
    handleSecondInstance: () => { throw new Error('boom, nobody is listening for it') },
    getWindow: () => assert.fail('a throw must not fall through to focus/restore'),
    start: () => {},
    onStartFailure: (error) => assert.fail(error),
  })

  assert.doesNotThrow(() => secondInstanceHandler({}, [], 'C:\\work', {}), 'must fall back to its own reporting, never propagate')
})

test('a rejected readiness promise is reported', async () => {
  const failure = new Error('readiness failed')
  let reported = null

  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => Promise.reject(failure),
    onSecondInstance: () => {},
    getWindow: () => null,
    start: () => assert.fail('start must not run'),
    onStartFailure: (error) => { reported = error },
  })

  await Promise.resolve()
  await Promise.resolve()
  assert.equal(reported, failure)
})

test('a rejected start promise is reported', async () => {
  const failure = new Error('createWindow failed')
  let reported = null

  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => Promise.resolve(),
    onSecondInstance: () => {},
    getWindow: () => null,
    start: () => Promise.reject(failure),
    onStartFailure: (error) => { reported = error },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reported, failure)
})

test('a synchronous start throw is reported', async () => {
  const failure = new Error('createWindow threw synchronously')
  let reported = null

  wireSingleInstance({
    requestLock: () => true,
    quit: () => {},
    whenReady: () => Promise.resolve(),
    onSecondInstance: () => {},
    getWindow: () => null,
    start: () => { throw failure },
    onStartFailure: (error) => { reported = error },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reported, failure)
})
