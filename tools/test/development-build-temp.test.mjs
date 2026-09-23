import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { developmentSessionEnvironment, sessionPaths } from '../lib/development-session.mjs'
import sterile from '../lib/sterile-launch.cjs'

function session(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-build-temp-'))
  t.after(() => t.diagnostic('RETAINED_DEV_BUILD_TEMP ' + root))
  return { id: '11111111-1111-4111-8111-111111111111', paths: sessionPaths(root),
    sources: { app: { origin: path.join(root, 'origin-app') },
      engine: { origin: path.join(root, 'origin-engine'), ref: 'fixture-ref' } } }
}

test('native build scratch stays in its own synthetic profile for actual child temp allocation', t => {
  const selected = session(t)
  const env = developmentSessionEnvironment(selected, { phase: 'build', base: { ...process.env,
    TMPDIR: selected.paths.root, TEMP: selected.paths.root, TMP: selected.paths.root } })
  const expected = sterile.sterileProfileDirectories(selected.paths.buildProfile).temp
  assert.equal(env.TEMP, expected)
  assert.equal(env.TMP, expected)
  if (process.platform === 'linux') assert.equal(env.TMPDIR, expected)
  const result = spawnSync(process.execPath, ['-e', "console.log(require('node:os').tmpdir())"],
    { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.equal(path.resolve(result.stdout.trim()), expected, 'installer temp must not escape into shared account temp')
})

test('separate DEV and CUT builds cannot share scratch and runtime socket preparation remains separate', t => {
  const one = { ...session(t), kind: 'dev' }, two = { ...session(t), kind: 'cut' }
  const first = developmentSessionEnvironment(one, { phase: 'build' })
  const second = developmentSessionEnvironment(two, { phase: 'build' })
  assert.notEqual(first.TEMP, second.TEMP)
  const runtime = developmentSessionEnvironment(one)
  assert.equal(runtime.TEMP, sterile.sterileProfileDirectories(one.paths.runtimeProfile).temp)
  assert.notEqual(runtime.TEMP, first.TEMP)
  assert.equal(runtime.TOOLSENABLED_PROVIDER_ISOLATION_ROOT, one.paths.runtimeProfile)
  assert.equal(first.TOOLSENABLED_PROVIDER_ISOLATION_ROOT, undefined)
})
