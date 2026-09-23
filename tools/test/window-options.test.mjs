import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { headlessWindowOptions } = require('../../shell/window-options.cjs')

/* The point of this suite is the DEFAULT case. MC_SMOKE_HEADLESS is a testing
 * affordance living in shipping code, so the thing that must be guarded is not
 * that the affordance works -- it is that it stays off unless asked for. Each
 * default assertion is a deepEqual against {}, so ANY key that starts being
 * added by default (show, or anything else) turns this red before it reaches a
 * user. */

test('DEFAULT: an unset environment adds nothing to the window options', () => {
  assert.deepEqual(headlessWindowOptions({}), {})
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
})
