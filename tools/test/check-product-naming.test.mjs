import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = path.join(REPO_ROOT, 'tools', 'check-product-naming.mjs')

function runGuard(script, source) {
  return spawnSync(process.execPath, [script, '--source', source], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, TOOLSENABLED_SOURCE: '' }
  })
}

test('check-product-naming refuses a missing input when invoked through a differently named copy', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'check-product-naming-'))
  const copiedGuard = path.join(REPO_ROOT, 'tools', `check-product-naming-copy-${path.basename(directory)}.mjs`)
  t.after(async () => {
    await rm(copiedGuard, { force: true })
    await rm(directory, { recursive: true, force: true })
  })
  await copyFile(GUARD, copiedGuard)

  const result = runGuard(copiedGuard, path.join(directory, 'missing-source'))

  assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stderr, /Product-naming guard error: no src\/lib\/entitlement\.js/)
})

test('check-product-naming still passes after inspecting a healthy source tree', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'check-product-naming-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const library = path.join(directory, 'src', 'lib')
  await mkdir(library, { recursive: true })
  await writeFile(path.join(library, 'entitlement.js'), `
module.exports = {
  PAID_PRODUCT: 'ToolsEnabled Anywhere',
  TIERS: {
    community: { id: 'community', label: 'Community', qualifiedLabel: 'Community', requiresLicense: false },
    operator: {
      id: 'operator',
      label: 'Operator Cloud',
      qualifiedLabel: 'ToolsEnabled Anywhere — Operator Cloud',
      requiresLicense: true
    }
  }
}
`)

  const result = runGuard(GUARD, directory)

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stdout, /Checked 6 published documents and 1 paid plans\. Consistent\./)
})
