import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PREFLIGHT_SOURCE = path.join(REPO_ROOT, 'tools', 'installer-preflight.mjs')
const TOOL_NAMES = [
  'quiescent-check.mjs',
  'check-payload-current.mjs',
  'check-payload-boundary.mjs',
  'check-asar-manifest.mjs',
  'check-renderer-payload.mjs',
  'check-no-owner-data.mjs',
  'check-license-notices.mjs',
  'check-electron-runtime-files.mjs',
  'seal-artifact.mjs',
  'check-product-naming.mjs',
  'installer-identity.mjs',
]

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'installer-preflight-test-'))
  const tools = path.join(root, 'tools')
  const artifact = path.join(root, 'release', 'win-unpacked')
  mkdirSync(path.join(tools, 'test'), { recursive: true })
  mkdirSync(path.join(root, 'capability'), { recursive: true })
  mkdirSync(path.join(artifact, 'resources', 'capability'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules', 'electron', 'dist'), { recursive: true })
  writeFileSync(path.join(artifact, 'resources', 'app.asar'), 'fixture')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ build: { directories: { output: 'release' } } }))
  writeFileSync(path.join(tools, 'installer-preflight.mjs'), readFileSync(PREFLIGHT_SOURCE))

  const stub = `
    import path from 'node:path'
    const ownName = path.basename(process.argv[1])
    if (process.env.PREFLIGHT_REFUSE === ownName) {
      console.error('fixture gate refused: staged payload is deliberately stale')
      process.exitCode = 1
    } else {
      console.log('fixture gate accepted ' + ownName)
    }
  `
  for (const name of TOOL_NAMES) writeFileSync(path.join(tools, name), stub)
  writeFileSync(path.join(tools, 'test', 'installer-fixture.test.mjs'), `
    import test from 'node:test'
    test('fixture installer check', () => {})
  `)
  return { root, artifact }
}

function runGate(setup, { args = ['--artifact', setup.artifact], refuse } = {}) {
  return spawnSync(process.execPath, [path.join(setup.root, 'tools', 'installer-preflight.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PREFLIGHT_REFUSE: refuse || '' },
  })
}

function outputOf(run) {
  return `${run.stdout}\n${run.stderr}`
}

function withFixture(run) {
  const setup = fixture()
  try {
    run(setup)
  } finally {
    rmSync(setup.root, { recursive: true, force: true })
  }
}

test('tools/installer-preflight.mjs lets a complete healthy fixture through', () => withFixture((setup) => {
  const run = runGate(setup)
  const output = outputOf(run)

  assert.match(output, /\[PASS\] Staged payload is current/u)
  assert.match(output, /INSTALLER PREFLIGHT VERDICT: PASS/u)
  assert.equal(run.status, 0, output)
}))

test('tools/installer-preflight.mjs refuses a failed child gate and carries its reason', () => withFixture((setup) => {
  const run = runGate(setup, { refuse: 'check-payload-current.mjs' })
  const output = outputOf(run)

  assert.match(output, /\[FAIL\] Staged payload is current/u)
  assert.match(output, /fixture gate refused: staged payload is deliberately stale/u)
  assert.match(output, /INSTALLER PREFLIGHT VERDICT: FAIL/u)
  assert.equal(run.status, 1, output)
}))

test('tools/installer-preflight.mjs refuses an incomplete artifact and names the missing prerequisite', () => withFixture((setup) => {
  const missingArtifact = path.join(setup.root, 'release', 'not-produced')
  const run = runGate(setup, { args: ['--artifact', missingArtifact] })
  const output = outputOf(run)

  assert.match(output, /\[COULD-NOT-CHECK\] Packaged payload is current/u)
  assert.match(output, /required directory is absent: .*not-produced.*resources.*capability/u)
  assert.match(output, /INSTALLER PREFLIGHT VERDICT: COULD-NOT-CHECK/u)
  assert.equal(run.status, 2, output)
}))

test('tools/installer-preflight.mjs refuses an invalid invocation with its setup reason', () => withFixture((setup) => {
  const run = runGate(setup, { args: ['--not-a-preflight-option'] })
  const output = outputOf(run)

  assert.match(output, /\[COULD-NOT-CHECK\] Preflight setup/u)
  assert.match(output, /unknown argument: --not-a-preflight-option/u)
  assert.match(output, /INSTALLER PREFLIGHT VERDICT: COULD-NOT-CHECK/u)
  assert.equal(run.status, 2, output)
}))
