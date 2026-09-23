import assert from 'node:assert/strict'
import test from 'node:test'

import { attachOwnedChild, createSession } from '../test-account-harness.mjs'

function manualClock() {
  let current = 0
  let nextId = 1
  const timers = new Map()
  const flush = async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }
  return {
    now: () => current,
    setTimer(callback, milliseconds) {
      const id = nextId++
      timers.set(id, { at: current + milliseconds, callback })
      return id
    },
    clearTimer(id) { timers.delete(id) },
    pause(milliseconds) {
      return new Promise(resolve => {
        const id = nextId++
        timers.set(id, { at: current + milliseconds, callback: resolve })
      })
    },
    async advance(milliseconds) {
      const target = current + milliseconds
      for (;;) {
        await flush()
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
        if (!due) break
        const [id, timer] = due
        timers.delete(id)
        current = timer.at
        timer.callback()
      }
      current = target
      await flush()
    },
    async flush() { await flush() },
    activeTimers: () => timers.size,
  }
}

class FakeSocket {
  constructor() {
    this.readyState = 0
    this.closed = false
    this.sent = []
    this.listeners = new Map()
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || []
    listeners.push({ listener, once: options.once === true })
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    this.listeners.set(type, listeners.filter(entry => entry.listener !== listener))
  }

  emit(type, event = {}) {
    const listeners = [...(this.listeners.get(type) || [])]
    for (const entry of listeners) {
      if (entry.once) this.removeEventListener(type, entry.listener)
      entry.listener(event)
    }
  }

  send(payload) { this.sent.push(payload) }

  close() {
    this.closed = true
    this.readyState = 3
  }
}

function sessionHarness({ fetchImpl, socketFactory } = {}) {
  const clock = manualClock()
  let socket = null
  class Socket extends FakeSocket {
    constructor(url) {
      super()
      socket = this
      socketFactory?.(this, url)
    }
  }
  const session = createSession(9229, { exitCode: null }, {}, {
    fetchImpl,
    WebSocketImpl: Socket,
    now: clock.now,
    pause: clock.pause,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, session, socket: () => socket }
}

async function openFakeSession(harness) {
  const opening = harness.session.open({ budgetMs: 100, pollMs: 10, attemptMs: 50 })
  await harness.clock.flush()
  harness.socket().readyState = 1
  harness.socket().emit('open')
  await opening
  assert.equal(harness.clock.activeTimers(), 0, 'the successful handshake left its deadline armed')
}

test('a failed debugger attach reaps the live child tree before its parent and preserves the exact error', async () => {
  const primary = new Error('primary debugger failure')
  const order = []
  const child = { pid: 4321, exitCode: null }
  const session = {
    open: async () => { order.push('open'); throw primary },
    close: () => { order.push('session-close') },
  }

  await assert.rejects(attachOwnedChild({
    session,
    child,
    reapChild: pid => { assert.equal(pid, child.pid); order.push('tree-reap') },
    killParent: () => { order.push('parent-kill') },
    pause: async () => { order.push('pause'); throw new Error('cleanup pause failed') },
  }), error => error === primary)
  assert.deepEqual(order, ['open', 'session-close', 'tree-reap', 'parent-kill', 'pause'])
})

test('a stalled debugger discovery fetch is bounded, aborted, and leaves no timer', async () => {
  let signal = null
  const harness = sessionHarness({
    fetchImpl: (_url, options) => {
      signal = options.signal
      return new Promise(() => {})
    },
  })
  const opening = harness.session.open({ budgetMs: 20, pollMs: 5, attemptMs: 20 })
  await harness.clock.flush()
  await harness.clock.advance(20)
  await assert.rejects(opening, /no debuggable page appeared within 20ms/)
  assert.equal(signal?.aborted, true)
  assert.equal(harness.clock.activeTimers(), 0)
})

test('a stalled debugger WebSocket handshake closes at its deadline and leaves no timer', async () => {
  const harness = sessionHarness({
    fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://qa', url: 'qa' }] }),
  })
  const opening = harness.session.open({ budgetMs: 25, pollMs: 5, attemptMs: 25 })
  await harness.clock.flush()
  assert.ok(harness.socket(), 'the HTTP discovery did not reach the WebSocket handshake')
  await harness.clock.advance(25)
  await assert.rejects(opening, /no debuggable page appeared within 25ms/)
  assert.equal(harness.socket().closed, true)
  assert.equal(harness.clock.activeTimers(), 0)
})

test('pending CDP calls time out once, ignore late replies, and clear their timer', async () => {
  const harness = sessionHarness({
    fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://qa', url: 'qa' }] }),
  })
  await openFakeSession(harness)
  let settlements = 0
  const call = harness.session.send('Runtime.evaluate', { expression: '1' }, 15)
    .then(value => { settlements += 1; return value }, error => { settlements += 1; throw error })
  assert.equal(harness.clock.activeTimers(), 1)
  await harness.clock.advance(15)
  await assert.rejects(call, /Runtime\.evaluate was not answered within 15ms/)
  assert.equal(harness.clock.activeTimers(), 0)
  harness.socket().emit('message', { data: JSON.stringify({ id: 1, result: { result: { value: 1 } } }) })
  await harness.clock.flush()
  assert.equal(settlements, 1)
  assert.equal(harness.clock.activeTimers(), 0)
})

test('a debugger socket close rejects every pending call once and clears its timer', async () => {
  const harness = sessionHarness({
    fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://qa', url: 'qa' }] }),
  })
  await openFakeSession(harness)
  let settlements = 0
  const call = harness.session.send('Input.dispatchMouseEvent', {}, 30)
    .then(value => { settlements += 1; return value }, error => { settlements += 1; throw error })
  assert.equal(harness.clock.activeTimers(), 1)
  harness.socket().emit('close')
  await assert.rejects(call, /debugger socket closed before this reply arrived/)
  assert.equal(harness.clock.activeTimers(), 0)
  harness.socket().emit('message', { data: JSON.stringify({ id: 1, result: {} }) })
  await harness.clock.advance(30)
  assert.equal(settlements, 1)
  assert.equal(harness.clock.activeTimers(), 0)
})

test('an answered CDP call clears its deadline timer', async () => {
  const harness = sessionHarness({
    fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://qa', url: 'qa' }] }),
  })
  await openFakeSession(harness)
  const call = harness.session.send('Runtime.evaluate', {}, 30)
  assert.equal(harness.clock.activeTimers(), 1)
  harness.socket().emit('message', { data: JSON.stringify({ id: 1, result: { result: { value: true } } }) })
  assert.deepEqual(await call, { id: 1, result: { result: { value: true } } })
  assert.equal(harness.clock.activeTimers(), 0)
})

test('an immediate CDP reply cannot arrive before its pending handler is registered', async () => {
  const expected = { id: 1, result: { result: { value: 'immediate' } } }
  const harness = sessionHarness({
    fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://qa', url: 'qa' }] }),
    socketFactory(socket) {
      socket.send = payload => {
        socket.sent.push(payload)
        const { id } = JSON.parse(payload)
        socket.emit('message', { data: JSON.stringify({ ...expected, id }) })
      }
    },
  })
  await openFakeSession(harness)

  let outcome = null
  void harness.session.send('Runtime.evaluate', {}, 30).then(
    value => { outcome = { value } },
    error => { outcome = { error } },
  )
  await harness.clock.flush()

  assert.deepEqual(outcome, { value: expected })
  assert.equal(harness.clock.activeTimers(), 0,
    'the reply raced ahead of registration and left the command deadline armed')
})
