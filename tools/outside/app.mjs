/* DRIVING THE APP FROM OUTSIDE: press its buttons, read its screen, collect
 * its errors.
 *
 * Owner, 2026-09-02: "the version on my computer SHOULD allow you an agent to
 * touch buttons from the outside and this should be a setting not a standard.
 * ... make CLEAN modularizations for testing. This is essentially our
 * development and test suite". So this is a library, not a script: one function
 * to find the running app (listPages), one to attach to it (openApp), and a
 * driver whose every action is a named method tested against a fake protocol
 * client in tools/test/outside-driver.test.mjs. The command line in cli.mjs is
 * a thin wrapper over it.
 *
 * A press is a real press: the element is scrolled into view, its box is
 * measured, and Chromium is handed mouse events at its centre, so what fires is
 * what a person's click fires -- focus, hover, pointer and click handlers -- not
 * a synthetic .click(). An element with no size on screen, or whose centre is
 * still outside the visible window after scrolling, is refused rather than
 * "pressed" invisibly (the first live drive sent a click to y=1749 in a shorter
 * window and nothing fired).
 *
 * Errors are collected from the moment ready() runs: thrown exceptions,
 * console.error/assert calls, and error-level log entries (failed requests,
 * refused loads). errors() hands back what has arrived so far.
 *
 * Reaches the app only when the app's `app.outside_control` setting is on, or
 * it was started with a port on its command line. */
import { createCdpClient, webSocketTransport } from './cdp-client.mjs'

export const DEFAULT_PORT = 9223
export const DEFAULT_ADDRESS = '127.0.0.1'

/**
 * The pages the running app offers, from its /json/list endpoint.
 */
export async function listPages({ port = DEFAULT_PORT, address = DEFAULT_ADDRESS, fetchImpl = globalThis.fetch } = {}) {
  let response
  try {
    response = await fetchImpl(`http://${address}:${port}/json/list`)
  } catch (error) {
    throw new Error(`nothing answered at ${address}:${port} (${error.message}); is the app running with outside control on?`)
  }
  if (!response.ok) throw new Error(`the app answered ${response.status} at ${address}:${port}`)
  const targets = await response.json()
  if (!Array.isArray(targets)) throw new Error('the app did not list its pages')
  return targets
    .filter(target => target && target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
    .map(target => Object.freeze({
      id: target.id,
      title: target.title || '',
      url: target.url || '',
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }))
}

/**
 * Attach to the app's page (the first one, or the one `match` picks) and hand
 * back a ready driver.
 */
export async function openApp(options = {}) {
  const pages = await listPages(options)
  const page = typeof options.match === 'function' ? pages.find(options.match) : pages[0]
  if (!page) throw new Error('the app has no page to drive')
  const transport = await webSocketTransport(page.webSocketDebuggerUrl)
  const driver = createDriver(createCdpClient(transport), { page })
  await driver.ready()
  return driver
}

/**
 * The driver over a protocol client. Exported on its own so the tests can hand
 * it a fake client.
 */
export function createDriver(client, { page = null } = {}) {
  const errors = []
  const stopListening = [
    client.on('Runtime.exceptionThrown', params => {
      errors.push(Object.freeze({ kind: 'exception', text: describeException(params), at: params.timestamp ?? null }))
    }),
    client.on('Runtime.consoleAPICalled', params => {
      if (params.type !== 'error' && params.type !== 'assert') return
      const args = Array.isArray(params.args) ? params.args : []
      errors.push(Object.freeze({ kind: 'console', text: args.map(argText).join(' '), at: params.timestamp ?? null }))
    }),
    client.on('Log.entryAdded', params => {
      const entry = params.entry
      if (!entry || entry.level !== 'error') return
      errors.push(Object.freeze({ kind: entry.source || 'log', text: entry.text || '', at: entry.timestamp ?? null, url: entry.url ?? null }))
    }),
  ]

  async function ready() {
    await client.send('Runtime.enable')
    await client.send('Log.enable')
    await client.send('Page.enable')
    await client.send('DOM.enable')
  }

  async function evaluate(expression) {
    const reply = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.exceptionDetails) throw new Error(describeException(reply))
    return reply.result ? reply.result.value : undefined
  }

  async function box(selector, { scroll = false } = {}) {
    const { root } = await client.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) throw new Error(`nothing on screen matches ${selector}`)
    if (scroll) await client.send('DOM.scrollIntoViewIfNeeded', { nodeId })
    const { model } = await client.send('DOM.getBoxModel', { nodeId })
    const quad = model.content
    return Object.freeze({
      nodeId,
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
      width: model.width,
      height: model.height,
    })
  }

  async function viewport() {
    const metrics = await client.send('Page.getLayoutMetrics')
    const view = metrics.cssVisualViewport || metrics.visualViewport || metrics.layoutViewport || {}
    return { width: view.clientWidth ?? Infinity, height: view.clientHeight ?? Infinity }
  }

  async function press(selector) {
    const target = await box(selector, { scroll: true })
    if (!(target.width > 0) || !(target.height > 0)) {
      throw new Error(`${selector} has no size on screen, so it cannot be pressed`)
    }
    const view = await viewport()
    if (target.x < 0 || target.y < 0 || target.x > view.width || target.y > view.height) {
      throw new Error(`${selector} is outside the visible window (its centre is at ${Math.round(target.x)},${Math.round(target.y)} in a ${Math.round(view.width)}x${Math.round(view.height)} window), so it cannot be pressed`)
    }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 })
    }
    return target
  }

  function text(selector) {
    return evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? node.textContent : null })()`)
  }

  function exists(selector) {
    return evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`)
  }

  async function screenshot(file = null) {
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
    if (file) {
      const fs = await import('node:fs')
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
    }
    return data
  }

  return Object.freeze({
    page,
    client,
    ready,
    evaluate,
    box,
    press,
    text,
    exists,
    screenshot,
    errors: () => errors.slice(),
    close() {
      for (const stop of stopListening) stop()
      client.close()
    },
  })
}

function argText(arg) {
  if (!arg || typeof arg !== 'object') return String(arg)
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  return arg.description || arg.type || ''
}

function describeException(params) {
  const details = params && params.exceptionDetails ? params.exceptionDetails : params
  if (!details) return 'exception'
  if (details.exception && details.exception.description) return details.exception.description
  if (details.text) return details.text
  return 'exception'
}
