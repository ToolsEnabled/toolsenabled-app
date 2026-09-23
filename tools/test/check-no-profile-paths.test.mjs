// Run: node --test tools/test/check-no-profile-paths.test.mjs

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { scanRepository } from '../check-no-profile-paths.mjs'

let repoRoot

before(async () => {
  repoRoot = await mkdtemp(path.join(os.tmpdir(), 'check-no-profile-paths-'))
  const init = spawnSync('git', ['init', '-q', repoRoot])
  assert.equal(init.status, 0, init.stderr?.toString())
  spawnSync('git', ['-C', repoRoot, 'config', 'user.email', 'fixture@example.invalid'])
  spawnSync('git', ['-C', repoRoot, 'config', 'user.name', 'fixture'])
})

after(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function track(relativePath, content) {
  const full = path.join(repoRoot, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
  const add = spawnSync('git', ['-C', repoRoot, 'add', relativePath])
  assert.equal(add.status, 0, add.stderr?.toString())
}

test('a repository with no absolute profile paths scans clean', async () => {
  await track('tools/ordinary-driver.mjs', 'export const nothing = 1\n')
  const { scanned, offenders } = scanRepository(repoRoot)
  assert.ok(scanned >= 1)
  assert.deepEqual(offenders, [])
})

test('a new file outside the allowlist carrying a Windows profile path is caught and named', async () => {
  await track('tools/planted-offender.mjs', "const p = 'C:\\\\Users\\\\SomeoneElse\\\\x'\n")
  const { offenders } = scanRepository(repoRoot)
  const found = offenders.find(o => o.file === 'tools/planted-offender.mjs')
  assert.ok(found, 'expected the planted Windows-path file to be reported')
  assert.match(found.match, /SomeoneElse/)
})

test('a new file carrying a Linux or macOS profile path is caught the same way', async () => {
  await track('tools/planted-linux-offender.mjs', "const p = '/home/someone-real'\n")
  const { offenders } = scanRepository(repoRoot)
  const found = offenders.find(o => o.file === 'tools/planted-linux-offender.mjs')
  assert.ok(found, 'expected the planted Linux-path file to be reported')
  assert.match(found.match, /someone-real/)
})

test('removing the planted offender clears the gate', async () => {
  await track('tools/planted-offender.mjs', 'export const nothing = 1\n')
  await track('tools/planted-linux-offender.mjs', 'export const nothing = 1\n')
  const { offenders } = scanRepository(repoRoot)
  assert.deepEqual(offenders, [])
})

test('the redacted-profile marker is never flagged, in any file', async () => {
  await track('captures-example/pre-fix/capture.log', "cssOverride C:\\Users\\redacted-profile\\Desktop\\work\\file.css\n")
  const { offenders } = scanRepository(repoRoot)
  assert.deepEqual(offenders, [])
})

test('a file on the explicit allowlist is exempt even though it names a real-shaped account', async () => {
  // Uses the exact relative path of a real allowlist entry (a fence-literal
  // driver script), independent of which temp directory holds this fixture --
  // the allowlist is keyed by tracked path, not by absolute location.
  await track('tools/check-no-owner-data.mjs', "const fence = 'C:\\\\Users\\\\ToolsEnabled-Dev'\n")
  const { offenders } = scanRepository(repoRoot)
  assert.deepEqual(offenders, [])
})

test('scanning a repository with zero tracked files reports nothing, not success', async () => {
  const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'check-no-profile-paths-empty-'))
  try {
    spawnSync('git', ['init', '-q', emptyRoot])
    const { scanned, offenders } = scanRepository(emptyRoot)
    assert.equal(scanned, 0)
    assert.deepEqual(offenders, [])
  } finally {
    await rm(emptyRoot, { recursive: true, force: true })
  }
})

test('a lowercase Windows drive and users segment is caught the same as the exact-case form', async () => {
  // CF27 review finding 1: the four detection regexes originally carried no
  // `i` flag, so a leak whose drive/segment prefix happened to be
  // lower- or mixed-case was silently invisible even though the tool's own
  // stated purpose is catching exactly this shape of leak.
  await track('tools/planted-lowercase-drive-offender.mjs', "const p = 'c:\\\\users\\\\someoneelse\\\\x'\n")
  const { offenders } = scanRepository(repoRoot)
  const found = offenders.find(o => o.file === 'tools/planted-lowercase-drive-offender.mjs')
  assert.ok(found, 'expected the planted lowercase-drive Windows-path file to be reported')
  assert.match(found.match, /someoneelse/i)
  await track('tools/planted-lowercase-drive-offender.mjs', 'export const nothing = 1\n')
})

test('a capitalized /Home/<account> segment is caught the same as lowercase /home/', async () => {
  await track('tools/planted-capital-home-offender.mjs', "const p = '/Home/someone-real'\n")
  const { offenders } = scanRepository(repoRoot)
  const found = offenders.find(o => o.file === 'tools/planted-capital-home-offender.mjs')
  assert.ok(found, 'expected the planted /Home/ path file to be reported')
  assert.match(found.match, /someone-real/)
  await track('tools/planted-capital-home-offender.mjs', 'export const nothing = 1\n')
})

test('a lowercase macOS /users/<account> segment is caught the same as /Users/', async () => {
  await track('tools/planted-lowercase-users-offender.mjs', "const p = '/users/someone-real'\n")
  const { offenders } = scanRepository(repoRoot)
  const found = offenders.find(o => o.file === 'tools/planted-lowercase-users-offender.mjs')
  assert.ok(found, 'expected the planted lowercase /users/ path file to be reported')
  assert.match(found.match, /someone-real/)
  await track('tools/planted-lowercase-users-offender.mjs', 'export const nothing = 1\n')
})

test('an untracked file (written but never git add-ed) is still caught', async () => {
  const full = path.join(repoRoot, 'tools', 'never-staged-offender.mjs')
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, "const p = 'C:\\\\Users\\\\SomeoneElse\\\\x'\n")
  const { offenders } = scanRepository(repoRoot)
  const found = offenders.find(o => o.file === 'tools/never-staged-offender.mjs')
  assert.ok(found, 'expected an untracked planted file to be reported too, before it is ever git add-ed')
  await rm(full)
})

test('the CLI exits nonzero and names the offending file when run end to end, then clears on rm', async () => {
  const full = path.join(repoRoot, 'tools', 'planted-cli-offender.mjs')
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, "const p = 'C:\\\\Users\\\\SomeoneElse\\\\x'\n")
  const gate = fileURLToPath(new URL('../check-no-profile-paths.mjs', import.meta.url))
  // T339: the CLI defaults to its own repository, so the throwaway fixture
  // is named explicitly; cwd alone no longer redirects the scan.
  const result = spawnSync(process.execPath, [gate, repoRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /tools\/planted-cli-offender\.mjs/)
  await rm(full)
  const cleaned = spawnSync(process.execPath, [gate, repoRoot], { encoding: 'utf8' })
  assert.equal(cleaned.status, 0)
})


test('an unreadable tracked file cannot be counted as a clean scan', async () => {
  const relative = 'captures-example/unreadable.txt'
  await track(relative, 'fixture')
  const target = path.join(repoRoot, relative)
  await rm(target)
  try {
    assert.throws(() => scanRepository(repoRoot), /PROFILE_PATH_SCAN_UNREADABLE: could not scan captures-example\/unreadable.txt/)
  } finally {
    await writeFile(target, 'fixture')
  }
})
