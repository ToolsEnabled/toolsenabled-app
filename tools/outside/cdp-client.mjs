/* A DEVTOOLS-PROTOCOL CLIENT WITH THE SOCKET LEFT OUT.
 *
 * This is the wire half of driving the app from outside (see app.mjs):
 * message ids, replies, error replies, events, sessions. The transport is
 * injected -- an object with send(text), onMessage(fn) and close() -- so every
 * rule here is tested against a fake transport in
 * tools/test/outside-driver.test.mjs, and the real socket is the one small
 * function at the bottom.
 *
 * Development and test tooling only. Nothing under tools/outside is packed or
 * shipped; the app's side of this is the `app.outside_control` setting, off
 * unless the person turns it on. */

/**
 * Wrap a transport in a client.
 *
 * send(method, params, sessionId) resolves with the reply's result, or rejects
 * with an Error carrying the method name and the protocol's code. on(method,
 * fn) subscribes to an event and returns the unsubscribe. close() rejects
 * everything still waiting, so a caller never hangs on a socket that went away.
 */
export function createCdpClient(transport) {
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  const anyListeners = new Set()

  transport.onMessage(text => {
    let message
    try { message = JSON.parse(text) } catch { return }
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, method } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) {
        const error = new Error(`${method}: ${message.error.message || 'the app refused'}`)
        error.code = message.error.code
        error.data = message.error.data
        reject(error)
      } else {
        resolve(message.result === undefined ? {} : message.result)
      }
      return
    }
    if (typeof message.method === 'string') {
      const params = message.params === undefined ? {} : message.params
      const event = Object.freeze({ method: message.method, params, sessionId: message.sessionId })
      for (const fn of listeners.get(message.method) || []) fn(params, event)
      for (const fn of anyListeners) fn(event)
    }
  })

  return Object.freeze({
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject, method })
        const body = sessionId ? { id, method, params, sessionId } : { id, method, params }
        try {
          transport.send(JSON.stringify(body))
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => { listeners.get(method)?.delete(fn) }
    },
    onAny(fn) {
      anyListeners.add(fn)
      return () => { anyListeners.delete(fn) }
    },
    pendingCount() {
      return pending.size
    },
    close() {
      for (const { reject, method } of pending.values()) {
        reject(new Error(`${method}: the connection closed before it answered`))
      }
      pending.clear()
      transport.close()
    },
  })
}

/**
 * The one real transport: a WebSocket to the app's page. Resolves once open,
 * rejects if the connection is refused (the port is shut, or nothing is
 * listening). Node 22 has WebSocket built in; the constructor is injectable
 * for the test that checks this function's own wiring.
 */
export function webSocketTransport(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
  if (typeof WebSocketImpl !== 'function') {
    return Promise.reject(new Error('this Node has no WebSocket; Node 22 or newer is needed to drive the app'))
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url)
    const handlers = new Set()
    let opened = false
    socket.addEventListener('open', () => {
      opened = true
      resolve(Object.freeze({
        send: text => socket.send(text),
        onMessage: fn => { handlers.add(fn) },
        close: () => socket.close(),
      }))
    })
    socket.addEventListener('message', event => {
      const text = typeof event.data === 'string' ? event.data : String(event.data)
      for (const fn of handlers) fn(text)
    })
    socket.addEventListener('error', () => {
      if (!opened) reject(new Error(`could not connect to ${url}; is the app running with outside control on?`))
    })
    socket.addEventListener('close', () => {
      if (!opened) reject(new Error(`the connection to ${url} closed before it opened`))
    })
  })
}
