import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runDevelopmentProcess } from '../lib/development-process.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { prepareSterileProfile, sterileProfileDirectories, sterileLaunchEnvironment } = require('../lib/sterile-launch.cjs')

test('native role editor filters visible functions, preserves drafts, and persists into the real engine role store', { timeout: 200000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'toolsenabled-role-functions-ui-'))
  const env = sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(dataRoot)))
  // Real persistence, audited MCP dispatch and full-page native hit testing
  // take longer than the old 25-second budget on a cold Linux profile. Retain
  // native descendant custody so expiration also stops helpers which keep the
  // captured pipes open after Electron receives a termination request.
  const completed = await runDevelopmentProcess({ paths: { app: root,
    controlEngine: path.join(root, 'capability'), evidence: dataRoot,
    cache: path.join(dataRoot, 'wrapper-cache') } }, realpathSync(require('electron')),
  [path.join(root, 'tools/test/helpers/role-functions-ui-electron.cjs'), dataRoot], {
    cwd: root, env, timeoutMs: 120000, maxOutputBytes: 1024 * 1024,
  })
  assert.equal(completed.cleanupConfirmed, true, `native child cleanup is unproved; evidence: ${completed.output}`)
  assert.equal(completed.failure, null, `native role proof failed; evidence: ${completed.output}`)
  assert.equal(completed.code, 0, `native role proof failed; evidence: ${completed.output}`)
  const stdout = await readFile(completed.output, 'utf8')
  const result = stdout.split('\n').map(line => { try { return JSON.parse(line) } catch { return null } }).find(value => value?.ok === true)
  assert.ok(result, 'the real native renderer must report its checked result')
  assert.deepEqual(result.selected, ['agent.spawn', 'app.context', 'settings.read'])
  assert.deepEqual(result.filter.matching, ['app.context'])
  assert.ok(result.filter.rows > 1)
  assert.equal(result.filter.noMatch, 0)
  assert.equal(result.filter.restored, result.filter.rows)
})
