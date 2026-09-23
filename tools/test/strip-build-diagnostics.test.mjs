import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = path.join(repoRoot, 'tools', 'strip-build-diagnostics.mjs')

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'strip-build-diagnostics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function run(scriptPath, args = [], cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  })
}

test('strip-build-diagnostics refuses a missing release directory instead of passing blind', async t => {
  const root = await fixture(t)
  const missing = path.join(root, 'release')
  const result = run(script, [missing])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Refusing to pass: release directory does not exist:/)
})

test('strip-build-diagnostics refuses when the expected diagnostic is absent', async t => {
  const root = await fixture(t)
  const release = path.join(root, 'release')
  await mkdir(release)

  const result = run(script, [release])

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Refusing to pass without expected diagnostic:/)
})

/* IDEMPOTENCY. A cut re-runs the chain after every fix, and this step refused on
 * the second pass -- "Refusing to pass without expected diagnostic" -- because the
 * file it strips was already gone. Measured in the D1 chain run: the first call
 * removed builder-debug.yml, the second died, and Lane A hits this on its second
 * pass.
 *
 * THE TEETH MUST SURVIVE THE FIX, which is the whole difficulty. Fail-closed is
 * right: a build that produced NO diagnostic is exactly the silent-skip defect
 * this codebase keeps re-finding, and "absent" must keep meaning "refuse" for a
 * tree that was never stripped. So absence alone cannot be the signal -- the tool
 * records that it stripped, and only a tree carrying that record may pass with
 * nothing to do. First run and second run are then distinguishable by evidence
 * rather than by guessing. */
test('strip-build-diagnostics is idempotent: the second run has nothing to strip and passes', async t => {
  const root = await fixture(t)
  const release = path.join(root, 'release')
  await mkdir(release)
  await writeFile(path.join(release, 'builder-debug.yml'), 'debug: true\n')

  const first = run(script, [release])
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`)
  assert.match(first.stdout, /removed builder-debug\.yml/, 'the first run must say what it removed')
  assert.equal(existsSync(path.join(release, 'builder-debug.yml')), false)

  const second = run(script, [release])
  assert.equal(second.status, 0, `second run refused:\n${second.stdout}${second.stderr}`)
  assert.match(second.stdout, /nothing to strip/, 'the second run must say there was nothing to strip')
})

/* THE TEETH, ASSERTED SEPARATELY so the idempotency fix cannot quietly remove
   them. A release directory that never had the diagnostic and carries no record
   of being stripped is a build that did not produce what it should have, and it
   must still refuse. This is the case a "just no-op when absent" fix would break,
   and it is why the record exists. */
test('a tree that was never stripped still refuses when the diagnostic is absent', async t => {
  const root = await fixture(t)
  const release = path.join(root, 'release')
  await mkdir(release)

  const result = run(script, [release])

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /Refusing to pass without expected diagnostic:/)
})

test('strip-build-diagnostics runs through a differently spelled copied main-module path', async t => {
  const root = await fixture(t)
  const copiedScript = path.join(root, 'strip-build-diagnostics-copy.mjs')
  await copyFile(script, copiedScript)
  const invokedCopy = process.platform === 'win32'
    ? path.join(root, `${path.basename(copiedScript, '.mjs').toUpperCase()}.mjs`)
    : copiedScript
  const nodeArgs = process.platform === 'win32'
    ? ['--import', `data:text/javascript,${encodeURIComponent(`process.argv[1] = ${JSON.stringify(invokedCopy)}`)}`, copiedScript]
    : [copiedScript]

  const result = spawnSync(process.execPath, nodeArgs, { cwd: root, encoding: 'utf8' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Refusing to pass: release directory does not exist:/)
})

test('strip-build-diagnostics removes the expected diagnostic on a healthy run', async t => {
  const root = await fixture(t)
  const release = path.join(root, 'release')
  const diagnostic = path.join(release, 'builder-debug.yml')
  await mkdir(release)
  await writeFile(diagnostic, 'debug: true\n')

  const result = run(script, [release])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /removed builder-debug\.yml/)
  assert.equal(existsSync(diagnostic), false)
})
