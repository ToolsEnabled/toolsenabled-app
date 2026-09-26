import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { headlessWindowOptions, startupWindowOptions, revealInactiveWindow } = require('../../shell/window-options.cjs')

/* The point of this suite is the DEFAULT case. MC_SMOKE_HEADLESS is a testing
 * affordance living in shipping code, so the thing that must be guarded is not
 * that the affordance works -- it is that it stays off unless asked for. Each
 * default assertion is a deepEqual against {}, so ANY key that starts being
 * added by default (show, or anything else) turns this red before it reaches a
 * user. */

test('DEFAULT: an unset environment adds nothing to the window options', () => {
  assert.deepEqual(headlessWindowOptions({}), {})
  assert.deepEqual(startupWindowOptions({ env: {} }), {})
  for (const startInactive of [false, null, 1, 'true']) assert.deepEqual(startupWindowOptions({ env: {}, startInactive }), {})
  assert.deepEqual(startupWindowOptions({ env: {}, startInactive: true }), { show: false })
})

test('DEFAULT: process.env with no MC_SMOKE_HEADLESS adds nothing', () => {
  const env = { ...process.env }
  delete env.MC_SMOKE_HEADLESS
  assert.deepEqual(headlessWindowOptions(env), {})
})

test('DEFAULT: null adds nothing, while undefined reads the process environment', () => {
  const previous = process.env.MC_SMOKE_HEADLESS
  process.env.MC_SMOKE_HEADLESS = '1'
  try {
    assert.deepEqual(headlessWindowOptions(undefined), { show: false })
  } finally {
    if (previous === undefined) delete process.env.MC_SMOKE_HEADLESS
    else process.env.MC_SMOKE_HEADLESS = previous
  }
  assert.deepEqual(headlessWindowOptions(null), {})
})

test('only the exact string "1" enables headless', () => {
  assert.deepEqual(headlessWindowOptions({ MC_SMOKE_HEADLESS: '1' }), { show: false })
  for (const startInactive of [false, true]) {
    const env = { MC_SMOKE_HEADLESS: '1' }
    assert.deepEqual(startupWindowOptions({ env, startInactive }), { show: false })
    revealInactiveWindow({ isDestroyed: () => false, showInactive() { assert.fail('a smoke window must stay hidden') } }, { env, startInactive })
  }
})

test('near-miss values fail closed to the visible default', () => {
  for (const value of ['0', '', 'true', 'TRUE', 'yes', ' 1', '1 ', '01', 'false']) {
    assert.deepEqual(
      headlessWindowOptions({ MC_SMOKE_HEADLESS: value }),
      {},
      `MC_SMOKE_HEADLESS=${JSON.stringify(value)} must not hide the window`,
    )
  }
})

test('the returned object is a fresh one each call, never shared state', () => {
  const a = headlessWindowOptions({ MC_SMOKE_HEADLESS: '1' })
  a.show = true
  assert.deepEqual(headlessWindowOptions({ MC_SMOKE_HEADLESS: '1' }), { show: false })
  const inactive = startupWindowOptions({ env: {}, startInactive: true })
  inactive.show = true
  assert.deepEqual(startupWindowOptions({ env: {}, startInactive: true }), { show: false })
  const calls = [], handlers = new Map()
  const window = { isDestroyed: () => false, once: (name, fn) => handlers.set(name, fn),
    showInactive: () => calls.push('inactive'), maximize: () => calls.push('maximize'),
    show() { assert.fail('maintenance must not show normally') }, focus() { assert.fail('maintenance must not focus') } }
  revealInactiveWindow(window, { env: {}, startInactive: true, maximized: true })
  assert.deepEqual(calls, ['inactive'], 'saved maximization cannot steal focus at startup')
  handlers.get('focus')()
  assert.deepEqual(calls, ['inactive', 'maximize'], 'the owner can restore normal maximized use by focusing')
  revealInactiveWindow({ ...window, isDestroyed: () => true }, { env: {}, startInactive: true })
  revealInactiveWindow(window, { env: {} })
  assert.deepEqual(calls, ['inactive', 'maximize'], 'closed and normal windows are untouched by maintenance reveal')
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const create = main.slice(main.indexOf('async function createWindow()'), main.indexOf('ipcMain.on(\'mc-theme\''))
  assert.match(create, /const startInactive = app\.commandLine\.hasSwitch\('start-inactive'\)/)
  assert.match(create, /\.\.\.startupWindowOptions\(\{ startInactive \}\)/)
  assert.ok(create.indexOf('revealInactiveWindow(window,') > create.indexOf('await window.loadURL('), 'inactive reveal follows the real load')
  assert.match(create, /state\.maximized && !startInactive && headlessWindowOptions\(\)\.show !== false/)
  assert.match(create, /if \(startInactive && !window\.isFocused\(\)\) window\.once\('focus', scheduleUpdates\)/, 'maintenance also defers modal update prompts')
})
