import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('check-declaration-privacy.mjs runs and can fail through a differently named copy path', t => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'check-declaration-privacy-test-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))

  const alias = path.join(fixture, 'renamed-declaration-privacy-gate.mjs')
  const clean = path.join(fixture, 'DECLARATION.md')
  const dirty = path.join(fixture, 'DIRTY-DECLARATION.md')

  copyFileSync(path.join(REPO_ROOT, 'tools', 'check-declaration-privacy.mjs'), alias)
  const invokedAlias = process.platform === 'win32' ? path.toNamespacedPath(alias) : alias
  writeFileSync(
    path.join(fixture, 'check-no-owner-data.mjs'),
    `import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
const directory = process.argv[2]
const dirty = readdirSync(directory).some(file => readFileSync(path.join(directory, file), 'utf8').includes('OWNER_MARKER'))
if (dirty) {
  console.error('fixture scanner: owner data found')
  process.exitCode = 1
} else {
  console.log('fixture scanner: clean')
}
`,
  )
  writeFileSync(clean, 'release declaration with public facts only\n')
  writeFileSync(dirty, 'OWNER_MARKER\n')

  const missing = spawnSync(process.execPath, [invokedAlias, path.join(fixture, 'MISSING.md')], { encoding: 'utf8' })
  assert.equal(missing.status, 2, `${missing.stdout}${missing.stderr}`)
  assert.match(missing.stderr, /nothing to check: .*MISSING\.md does not exist/)

  const rejected = spawnSync(process.execPath, [invokedAlias, dirty], { encoding: 'utf8' })
  assert.doesNotMatch(rejected.stdout, /clean:/, 'a dirty declaration must never be reported as clean')
  assert.equal(rejected.status, 1, `${rejected.stdout}${rejected.stderr}`)
  assert.match(rejected.stderr, /FAIL \(owner-data-found\):/)

  const output = execFileSync(process.execPath, [invokedAlias, clean], { encoding: 'utf8' })
  assert.match(output, /\[check-declaration-privacy\] clean:/)
})
