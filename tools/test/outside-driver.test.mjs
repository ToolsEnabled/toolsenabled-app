/* The outside driver, against a fake protocol transport.
 *
 * tools/outside is how this product's own development and testing press the
 * app's buttons from outside it. Its wire half (cdp-client.mjs) and its action
 * half (app.mjs) each take their lower layer as an argument, which is
 * what lets every rule be asserted here without a running app: reply
 * correlation, error replies, events and unsubscribes, a close that rejects
 * what is still waiting; a press that measures the element and sends real
 * mouse events to its centre, refuses an element with no size, and refuses a
 * selector nothing matches; an error collector that keeps exceptions, console
 * errors and error-level log entries and drops everything else. */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createCdpClient, webSocketTransport } from '../outside/cdp-client.mjs'
import { createDriver, listPages, DEFAULT_PORT } from '../outside/app.mjs'

/* A transport whose replies are scripted per method. `answer(method, params)`
   returns a result, or throws to produce an error reply. Events are pushed in
   with emit(). Everything sent is kept for assertions. */
function fakeTransport(answer = () => ({})) {
  const sent = []
  let handler = null
  const transport = {
    sent,
    closed: false,
    send(text) {
      const message = JSON.parse(text)
      sent.push(message)
      if (transport.holdReplies) return
      queueMicrotask(() => transport.reply(message))
    },
    reply(message) {
      let body
      try {
        body = { id: message.id, result: answer(message.method, message.params, message) }
      } catch (error) {
        body = { id: message.id, error: { code: error.code ?? -32000, message: error.message } }
      }
      handler(JSON.stringify(body))
    },
    emit(method, params, sessionId) {
      handler(JSON.stringify(sessionId ? { method, params, sessionId } : { method, params }))
    },
    onMessage(fn) { handler = fn },
    close() { transport.closed = true },
    holdReplies: false,
  }
  return transport
}

/* ------------------------------ the client ------------------------------ */

test('replies are matched to their ids, in whatever order they arrive', async () => {
  const transport = fakeTransport((method, params) => ({ echo: method, params }))
  transport.holdReplies = true
  const client = createCdpClient(transport)
  const first = client.send('Runtime.evaluate', { expression: '1' })
  const second = client.send('DOM.getDocument', { depth: 0 })
  assert.equal(client.pendingCount(), 2)
  transport.reply(transport.sent[1])
  transport.reply(transport.sent[0])
  assert.deepEqual(await first, { echo: 'Runtime.evaluate', params: { expression: '1' } })
  assert.deepEqual(await second, { echo: 'DOM.getDocument', params: { depth: 0 } })
  assert.equal(client.pendingCount(), 0)
  assert.deepEqual(transport.sent.map(m => m.id), [1, 2], 'ids count up from one')
  assert.equal('sessionId' in transport.sent[0], false, 'no session unless one is given')
})

test('an error reply rejects with the method and the protocol code; a session id rides along when given', async () => {
  const transport = fakeTransport(method => {
    if (method === 'Input.dispatchMouseEvent') { const e = new Error('Target closed'); e.code = -32001; throw e }
    return {}
  })
  const client = createCdpClient(transport)
  await assert.rejects(client.send('Input.dispatchMouseEvent', {}, 'S1'), error => error.message === 'Input.dispatchMouseEvent: Target closed' && error.code === -32001)
  assert.equal(transport.sent[0].sessionId, 'S1')
})

test('events reach their subscribers and stop after unsubscribe; unknown messages are ignored', async () => {
  const transport = fakeTransport()
  const client = createCdpClient(transport)
  const seen = []
  const stop = client.on('Runtime.consoleAPICalled', params => seen.push(params.type))
  const all = []
  client.onAny(event => all.push(event.method))
  transport.emit('Runtime.consoleAPICalled', { type: 'error' })
  transport.emit('Page.loadEventFired', { timestamp: 1 })
  stop()
  transport.emit('Runtime.consoleAPICalled', { type: 'log' })
  transport.onMessage.call(null, () => {})
  assert.deepEqual(seen, ['error'])
  assert.deepEqual(all, ['Runtime.consoleAPICalled', 'Page.loadEventFired', 'Runtime.consoleAPICalled'])
  /* Garbage and unrelated replies do not throw. */
  const handler = transport.reply
  assert.doesNotThrow(() => { transport.emit('x', undefined) })
  assert.equal(typeof handler, 'function')
})

test('close() rejects everything still waiting and closes the transport', async () => {
  const transport = fakeTransport()
  transport.holdReplies = true
  const client = createCdpClient(transport)
  const waiting = client.send('Page.captureScreenshot')
  client.close()
  await assert.rejects(waiting, /Page\.captureScreenshot: the connection closed before it answered/)
  assert.equal(transport.closed, true)
  assert.equal(client.pendingCount(), 0)
})

test('a transport that cannot send rejects the call instead of leaving it pending', async () => {
  const transport = fakeTransport()
  transport.send = () => { throw new Error('socket gone') }
  const client = createCdpClient(transport)
  await assert.rejects(client.send('Runtime.enable'), /socket gone/)
  assert.equal(client.pendingCount(), 0)
})

test('the real transport needs a WebSocket and says so when there is none', async () => {
  await assert.rejects(webSocketTransport('ws://127.0.0.1:1/x', { WebSocketImpl: null }), /no WebSocket/)
})

test('the real transport resolves on open with the three transport methods, and rejects on a refused connection', async () => {
  class FakeSocket {
    constructor(url) { this.url = url; this.listeners = {}; this.sentText = []; FakeSocket.last = this }
    addEventListener(name, fn) { this.listeners[name] = fn }
    send(text) { this.sentText.push(text) }
    close() { this.closedByCaller = true }
  }
  const opening = webSocketTransport('ws://127.0.0.1:9223/devtools/page/1', { WebSocketImpl: FakeSocket })
  FakeSocket.last.listeners.open()
  const transport = await opening
  const got = []
  transport.onMessage(text => got.push(text))
  FakeSocket.last.listeners.message({ data: '{"id":1}' })
  transport.send('hello')
  transport.close()
  assert.deepEqual(got, ['{"id":1}'])
  assert.deepEqual(FakeSocket.last.sentText, ['hello'])
  assert.equal(FakeSocket.last.closedByCaller, true)

  const refused = webSocketTransport('ws://127.0.0.1:1/x', { WebSocketImpl: FakeSocket })
  FakeSocket.last.listeners.error()
  await assert.rejects(refused, /could not connect to ws:\/\/127\.0\.0\.1:1\/x/)
})

/* ------------------------------ the driver ------------------------------ */

const BOX = { content: [10, 20, 110, 20, 110, 60, 10, 60], width: 100, height: 40 }

function driverWith(answer) {
  const transport = fakeTransport(answer)
  const client = createCdpClient(transport)
  return { transport, client, app: createDriver(client, { page: { title: 'ToolsEnabled' } }) }
}

test('ready() turns on the four domains the driver reads', async () => {
  const { transport, app } = driverWith(() => ({}))
  await app.ready()
  assert.deepEqual(transport.sent.map(m => m.method), ['Runtime.enable', 'Log.enable', 'Page.enable', 'DOM.enable'])
})

test('press() scrolls the element into view, measures it, and sends move, press and release at its centre', async () => {
  const { transport, app } = driverWith(method => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 7 }
    if (method === 'DOM.getBoxModel') return { model: BOX }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1200, clientHeight: 800 } }
    return {}
  })
  const at = await app.press('[data-acct="trigger"]')
  assert.deepEqual(transport.sent.map(m => m.method).slice(0, 5), ['DOM.getDocument', 'DOM.querySelector', 'DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'Page.getLayoutMetrics'], 'scrolled into view before measuring, measured before pressing')
  assert.deepEqual(transport.sent[2].params, { nodeId: 7 })
  assert.deepEqual({ x: at.x, y: at.y, width: at.width, height: at.height, nodeId: at.nodeId }, { x: 60, y: 40, width: 100, height: 40, nodeId: 7 })
  const mouse = transport.sent.filter(m => m.method === 'Input.dispatchMouseEvent').map(m => m.params)
  assert.deepEqual(mouse, [
    { type: 'mouseMoved', x: 60, y: 40, button: 'left', clickCount: 1 },
    { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 },
  ])
  assert.equal(transport.sent.find(m => m.method === 'DOM.querySelector').params.selector, '[data-acct="trigger"]')
})

test('press() refuses a selector nothing matches, and an element with no size on screen', async () => {
  const { app: missing } = driverWith(method => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 0 }
    return {}
  })
  await assert.rejects(missing.press('.nope'), /nothing on screen matches \.nope/)
  const { transport, app: hidden } = driverWith(method => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 3 }
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 0, 0, 0, 0, 0, 0], width: 0, height: 0 } }
    return {}
  })
  await assert.rejects(hidden.press('[hidden]'), /has no size on screen, so it cannot be pressed/)
  assert.equal(transport.sent.some(m => m.method === 'Input.dispatchMouseEvent'), false, 'no mouse event went out')
})

test('press() refuses an element whose centre is still outside the visible window after scrolling', async () => {
  const { transport, app } = driverWith(method => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 9 }
    if (method === 'DOM.getBoxModel') return { model: { content: [800, 1730, 1015, 1730, 1015, 1764, 800, 1764], width: 215, height: 34 } }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1600, clientHeight: 1000 } }
    return {}
  })
  await assert.rejects(app.press('a.home-next'), /is outside the visible window \(its centre is at 908,1747 in a 1600x1000 window\), so it cannot be pressed/)
  assert.equal(transport.sent.some(m => m.method === 'Input.dispatchMouseEvent'), false, 'no mouse event went out')
  assert.ok(transport.sent.some(m => m.method === 'DOM.scrollIntoViewIfNeeded'), 'it did try to scroll first')
})

test('evaluate() returns the value and throws the page\'s own exception text; text() and exists() read the page', async () => {
  const { transport, app } = driverWith((method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    if (params.expression.includes('boom')) return { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: boom is not defined' } } }
    if (params.expression.includes('textContent')) return { result: { type: 'string', value: 'Check allowances' } }
    if (params.expression.includes('!== null')) return { result: { type: 'boolean', value: true } }
    return { result: { type: 'number', value: 3 } }
  })
  assert.equal(await app.evaluate('1 + 2'), 3)
  await assert.rejects(app.evaluate('boom'), /ReferenceError: boom is not defined/)
  assert.equal(await app.text('[data-acct="refresh"]'), 'Check allowances')
  assert.equal(await app.exists('.acct-menu'), true)
  const sent = transport.sent.filter(m => m.method === 'Runtime.evaluate')
  assert.ok(sent.every(m => m.params.returnByValue === true && m.params.awaitPromise === true))
  assert.match(sent[2].params.expression, /querySelector\("\[data-acct=\\"refresh\\"\]"\)/)
})

test('errors() keeps exceptions, console errors and error-level log entries, and nothing else', async () => {
  const { transport, app } = driverWith(() => ({}))
  transport.emit('Runtime.exceptionThrown', { timestamp: 5, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } })
  transport.emit('Runtime.consoleAPICalled', { type: 'error', timestamp: 6, args: [{ type: 'string', value: 'settings' }, { type: 'object', description: 'Error: refused' }] })
  transport.emit('Runtime.consoleAPICalled', { type: 'log', timestamp: 7, args: [{ type: 'string', value: 'fine' }] })
  transport.emit('Runtime.consoleAPICalled', { type: 'assert', timestamp: 8, args: [{ type: 'string', value: 'broke' }] })
  transport.emit('Log.entryAdded', { entry: { level: 'error', source: 'network', text: 'Failed to load resource', timestamp: 9, url: 'http://127.0.0.1:1/x.js' } })
  transport.emit('Log.entryAdded', { entry: { level: 'warning', source: 'other', text: 'meh', timestamp: 10 } })
  assert.deepEqual(app.errors(), [
    { kind: 'exception', text: 'TypeError: x is not a function', at: 5 },
    { kind: 'console', text: 'settings Error: refused', at: 6 },
    { kind: 'console', text: 'broke', at: 8 },
    { kind: 'network', text: 'Failed to load resource', at: 9, url: 'http://127.0.0.1:1/x.js' },
  ])
  app.close()
  transport.emit('Runtime.exceptionThrown', { timestamp: 11, exceptionDetails: { text: 'late' } })
  assert.equal(app.errors().length, 4, 'a closed driver stops listening')
  assert.equal(transport.closed, true)
})

test('screenshot() asks for a PNG and hands back its bytes', async () => {
  const { transport, app } = driverWith(method => method === 'Page.captureScreenshot' ? { data: Buffer.from('png!').toString('base64') } : {})
  const data = await app.screenshot()
  assert.equal(Buffer.from(data, 'base64').toString(), 'png!')
  assert.deepEqual(transport.sent[0].params, { format: 'png' })
})

/* ------------------------------ finding the app ------------------------------ */

test('listPages() keeps only pages with a socket, and says plainly when nothing answers', async () => {
  const pages = await listPages({
    fetchImpl: async url => {
      assert.equal(url, `http://127.0.0.1:${DEFAULT_PORT}/json/list`)
      return { ok: true, json: async () => [
        { id: 'a', type: 'page', title: 'ToolsEnabled', url: 'http://127.0.0.1:4602/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/a' },
        { id: 'b', type: 'iframe', title: 'frame', webSocketDebuggerUrl: 'ws://x' },
        { id: 'c', type: 'page', title: 'no socket' },
      ] }
    },
  })
  assert.deepEqual(pages, [{ id: 'a', title: 'ToolsEnabled', url: 'http://127.0.0.1:4602/', webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/a' }])
  await assert.rejects(listPages({ port: 1, fetchImpl: async () => { throw new Error('ECONNREFUSED') } }), /nothing answered at 127\.0\.0\.1:1 \(ECONNREFUSED\); is the app running with outside control on\?/)
  await assert.rejects(listPages({ fetchImpl: async () => ({ ok: false, status: 500 }) }), /answered 500/)
})
