'use strict'

const assert = require('node:assert/strict')

const factories = new Set(['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByAltText', 'getByTitle', 'filter', 'first', 'last', 'nth', 'frameLocator'])
const actions = new Set(['click', 'dblclick', 'press', 'fill', 'type', 'insertText', 'check', 'uncheck', 'setChecked', 'selectOption', 'dragTo', 'focus', 'down', 'up', 'move', 'wheel'])

// CDP can otherwise dispatch input behind a native operating-system modal. Read the
// real main-window state before every input, including locator chains and
// keyboard/mouse calls. This wrapper changes no application or dialog API.
function guardNativeInput(page, beforeInput) {
  const cache = new WeakMap()
  function wrap(target) {
    if (cache.has(target)) return cache.get(target)
    const proxy = new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object)
        if (property === 'keyboard' || property === 'mouse') return wrap(value)
        if (typeof value !== 'function') return value
        if (factories.has(property)) return (...args) => wrap(value.apply(object, args))
        if (actions.has(property)) return async (...args) => { await beforeInput(); return value.apply(object, args) }
        return value.bind(object)
      },
    })
    cache.set(target, proxy)
    return proxy
  }
  return wrap(page)
}

function assertNativeSelection(receipt) {
  const { requested, before, after, resetsAfterSelection, events } = receipt
  assert.equal(after, resetsAfterSelection ? '' : requested, 'Native select must retain its requested value or documented placeholder')
  const unchanged = !resetsAfterSelection && before === requested && events.length === 0
  if (unchanged) return
  assert.deepEqual(events.map(({ type, value, trusted }) => ({ type, value, trusted })), [
    { type: 'input', value: requested, trusted: true },
    { type: 'change', value: requested, trusted: true },
  ], 'Native select must commit the requested visible choice once, without intermediate selections')
}

// Playwright's Electron inspector can collect the promise wrapping a synchronous
// main-process read. Retry only that exact transport error, before input. A
// disabled/destroyed window, other error, focus operation or input gets no retry.
async function readNativeWindowState(read, recordRetry) {
  const limit = 3
  for (let attempt = 1; ; attempt++) {
    try { return await read() }
    catch (error) {
      if (attempt >= limit || !/^(?:electronApplication\.evaluate: )?Resulting promise was garbage collected\.$/.test(error?.message || '')) throw error
      recordRetry({ kind: 'native-read-retry', operation: 'window-readiness', attempt, limit, reason: error.message })
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

module.exports = { guardNativeInput, assertNativeSelection, readNativeWindowState }
