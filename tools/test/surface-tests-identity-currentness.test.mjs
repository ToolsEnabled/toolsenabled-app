import test from 'node:test'
import assert from 'node:assert/strict'
import { assertBuildInfo } from '../lib/surface-tests/identity.mjs'

const app = 'a'.repeat(40)
const engine = 'b'.repeat(40)
const unbound = { schemaVersion: 2, dirty: false, overridden: false, app: { dirty: false }, payload: { dirty: false, resolved: true } }
const valid = {
  schemaVersion: 2, dirty: false, overridden: false, ref: app,
  app: { ref: app, dirty: false },
  payload: { ref: engine, dirty: false, resolved: true }, checkedAt: 'now',
}

test('rejects missing or malformed expected refs instead of accepting an unbound build', () => {
  for (const expected of [ undefined, null, {}, { app: undefined, engine }, { app, engine: undefined },
    { app: 'missing', engine }, { app, engine: 'g'.repeat(40) },
    { app: app.toUpperCase(), engine } ]) {
    assert.throws(() => assertBuildInfo(valid, expected), /exact app and engine commits/)
  }
  for (const expected of [undefined, null, {}]) {
    assert.throws(() => assertBuildInfo(unbound, expected), /exact app and engine commits/)
  }
})

test('accepts a clean build bound to exact app and engine commits', () => {
  assert.deepEqual(assertBuildInfo(valid, { app, engine }), { app, engine, checkedAt: 'now' })
})
