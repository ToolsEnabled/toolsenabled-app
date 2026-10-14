import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { computeClosure } from '../pack-capability-layer.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = canonicalRootForTests()
const HOOK = 'src/lib/browser-action-cursor.js'
const manifest = JSON.parse(readFileSync(path.join(APP, 'tools/capability-manifest.json'), 'utf8'))
const staged = path.join(APP, 'capability')

test('the gateway initialization hook is reached by the real payload closure', () => {
  const closure = computeClosure(ENGINE, [
    ...manifest.entrypoints,
    ...(manifest.hostModules || []),
    ...(manifest.spawnedPrograms || [])
  ], manifest.dynamicRequires || [])
  assert.ok(closure.files.includes(HOOK), 'the --init-page argument must resolve inside the installed payload')
})

test('the staged hook is present, byte-identical and loadable by the pinned CLI', async () => {
  const gateway = readFileSync(path.join(staged, 'src/playwright-gateway.js'), 'utf8')
  assert.match(gateway, /'--init-page', path\.join\(__dirname, 'lib', 'browser-action-cursor\.js'\)/)
  const target = path.join(staged, HOOK)
  assert.ok(existsSync(target), 'a staged gateway must not point Playwright at a missing init page')
  assert.deepEqual(readFileSync(target), readFileSync(path.join(ENGINE, HOOK)))
  const initialize = createRequire(import.meta.url)(target).default
  assert.equal(typeof initialize, 'function')
  const requests = []
  await initialize({ page: { screencast: { showActions: async options => requests.push(options) } } })
  assert.deepEqual(requests, [{ duration: 900, position: 'top-right', cursor: 'pointer' }])
})
