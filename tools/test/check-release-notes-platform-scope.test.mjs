import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkReleaseNotes, installProblems, recordPlatform, installRecords } from '../check-release-notes.mjs'

/* THE DEFECT THIS FILE GUARDS.
 *
 * 1.0.44 is a Linux-only cut (standing request R1212). The release note at the cut
 * tip still carried a "### Windows installer" install record whose SHA-256 said
 * `pending`. Every existing check passed it, because `pending` is the correct state
 * for a record a cutter has not filled yet -- and no check asked whether a Windows
 * cutter was ever going to run. It was not. The note would have gone to publication
 * promising a package nobody was building.
 *
 * The caller that knows which platforms a release ships is the cutter, so the guard
 * takes them as `--platform`. With no `--platform` the behaviour is unchanged, which
 * is what keeps a two-platform release and every existing caller working. */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const GUARD = path.join(REPO_ROOT, 'tools', 'check-release-notes.mjs')
const VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version

const LINUX_RECORD = `### Linux package

| Item | Value |
| --- | --- |
| Package | toolsenabled_${VERSION}_amd64.deb |
| Platform | Linux |
| Bytes | 118000000 |
| SHA-256 | pending |
| Signed | no |`

const WINDOWS_RECORD = `### Windows installer

| Item | Value |
| --- | --- |
| Package | ToolsEnabled-Setup-${VERSION}.exe |
| Platform | Windows |
| Bytes | 96000000 |
| SHA-256 | pending |
| Signed | no |`

function notes({ records }) {
  return `# ToolsEnabled \`${VERSION}\`

*Released \`2026-09-11\`*

## Highlights

- The Research page writes a report a reviewer who was not in the room can read.

## Added

- Qualification receipts in the exported command-line runner.

## Changed

- Archived evidence is verified against what ran, not against today's extractor.

## Fixed

- A report renders for a project this build cannot rebuild, and says so.

## Known issues

- There is no Windows package in this version.

## Install

${records.join('\n\n')}

## Publisher and copyright

Published by ToolsEnabled, Inc. (in formation)

Copyright © 2026 Joshua Pinckard

ToolsEnabled was founded and created by Joshua Pinckard. The original platform was developed by directing autonomous AI-agent fleets through the system's own evolving coordination architecture.

Contributors and maintainers are never founders.
`
}

function problemsFor(text, platforms) {
  return checkReleaseNotes({ text, expectedVersion: VERSION, platforms }).problems
}

function installSection(text) {
  const marker = '## Install\n'
  const start = text.indexOf(marker) + marker.length
  const end = text.indexOf('\n## ', start)
  return text.slice(start, end)
}

test('a Linux-only release is refused a Windows install record', () => {
  const text = notes({ records: [WINDOWS_RECORD, LINUX_RECORD] })
  const found = problemsFor(text, ['linux'])
  const offending = found.filter(problem => /install record for windows/i.test(problem))
  assert.equal(offending.length, 1, `expected one windows-scope problem, got ${JSON.stringify(found)}`)
  assert.match(offending[0], /this release ships linux/i)
  assert.match(offending[0], /remove the record, or say in Known issues/i)
})

test('a Linux-only release accepts a note that carries only the Linux record', () => {
  const text = notes({ records: [LINUX_RECORD] })
  const found = problemsFor(text, ['linux'])
  assert.equal(found.filter(problem => /install record for/i.test(problem)).length, 0, JSON.stringify(found))
  assert.equal(found.filter(problem => /has no install record/i.test(problem)).length, 0, JSON.stringify(found))
})

test('a platform this release ships must have a record', () => {
  const text = notes({ records: [LINUX_RECORD] })
  const found = problemsFor(text, ['linux', 'windows'])
  const missing = found.filter(problem => /ships windows, but the note has no install record/i.test(problem))
  assert.equal(missing.length, 1, JSON.stringify(found))
})

test('without --platform the guard says nothing about scope, so existing callers are unchanged', () => {
  const text = notes({ records: [WINDOWS_RECORD, LINUX_RECORD] })
  const withScope = problemsFor(text, ['linux'])
  const withoutScope = problemsFor(text, [])
  assert.equal(withoutScope.filter(problem => /install record for/i.test(problem)).length, 0)
  assert.ok(withScope.length > withoutScope.length, 'declaring a scope must be able to add a problem')
  assert.deepEqual(withoutScope, [
    'install digest pending: Install record "Windows installer", Install record "Linux package". ' +
    'The platform cutter fills this from its own receipt in the packet copy of the note. ' +
    'Never write a digest by hand.'
  ])
})

test('the platform comes from the Platform row, and the heading is only a fallback', () => {
  assert.equal(recordPlatform({ name: 'Linux package', body: '| Platform | Linux |' }), 'linux')
  assert.equal(recordPlatform({ name: 'Windows installer', body: '| Platform | Linux |' }), 'linux')
  assert.equal(recordPlatform({ name: 'Windows installer', body: '| Bytes | 1 |' }), 'windows')
  assert.equal(recordPlatform({ name: null, body: '| SHA-256 | pending |' }), null)
  assert.equal(recordPlatform({ name: 'Package', body: '| Platform | Plan 9 |' }), null)
})

test('a record whose platform cannot be read is left alone, not accused', () => {
  const unnamed = [
    '| Item | Value |',
    '| --- | --- |',
    `| Package | toolsenabled_${VERSION}_amd64.deb |`,
    '| SHA-256 | pending |',
    '| Signed | no |'
  ].join('\n')
  const records = installRecords(unnamed)
  assert.equal(records.length, 1)
  assert.equal(recordPlatform(records[0]), null)
  const found = installProblems(unnamed, ['linux'])
  /* "is an install record for", not "install record for": the uncovered-platform message
   * below also contains "install record for it", and a looser pattern matched it. */
  assert.equal(found.filter(problem => /is an install record for/i.test(problem)).length, 0, JSON.stringify(found))
  assert.equal(found.filter(problem => /ships linux, but the note has no install record/i.test(problem)).length, 1)
})

test('the command-line guard takes --platform and reports the scope it read', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rc-notes-scope-'))
  try {
    const file = path.join(directory, 'NOTES.md')
    await writeFile(file, notes({ records: [WINDOWS_RECORD, LINUX_RECORD] }), 'utf8')
    const result = spawnSync(process.execPath, [GUARD, '--notes', file, '--platform', 'linux'], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /Platforms this release ships: linux/)
    assert.match(result.stderr, /install record for windows/i)

    const linuxOnly = path.join(directory, 'NOTES-LINUX.md')
    await writeFile(linuxOnly, notes({ records: [LINUX_RECORD] }), 'utf8')
    const scoped = spawnSync(process.execPath, [GUARD, '--notes', linuxOnly, '--platform', 'linux'], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(scoped.status, 1, scoped.stdout + scoped.stderr)
    assert.doesNotMatch(scoped.stderr, /install record for/i)
    assert.match(scoped.stderr, /install digest pending/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// The public Beta requires both native cuts; neither borrows the other's proof.
const SHIPPING_PLATFORMS = ['linux', 'windows']

test('the shipped note carries an install record for every platform this release cuts, and no other', () => {
  const text = readFileSync(path.join(REPO_ROOT, 'docs', `RELEASE-NOTES-${VERSION}.md`), 'utf8')
  const section = installSection(text)
  const found = installProblems(section, SHIPPING_PLATFORMS)
  assert.deepEqual(
    found.filter(problem => /install record for|has no install record/i.test(problem)),
    [],
    `docs/RELEASE-NOTES-${VERSION}.md does not match a ${SHIPPING_PLATFORMS.join(' and ')} release: ${JSON.stringify(found)}`
  )
})

// A release plan declares both future artifacts; a platform packet qualifies
// only the artifact that actually exists in that cut. Neither is publication.
test('a two-platform source plan accepts pending measurements without qualifying a packet', () => {
  const text = notes({ records: [LINUX_RECORD, WINDOWS_RECORD] })
  assert.deepEqual(checkReleaseNotes({ text, expectedVersion: VERSION, platforms: ['linux', 'windows'], sourcePlan: true }).problems, [])
  assert.ok(checkReleaseNotes({ text, expectedVersion: VERSION, platforms: ['linux', 'windows'] }).problems.some(p => /digest pending/.test(p)))
})

test('a measured Linux packet can precede its declared Windows cut', () => {
  const text = notes({ records: [LINUX_RECORD.replace('| SHA-256 | pending |', '| SHA-256 | ' + 'a'.repeat(64) + ' |')] })
  assert.deepEqual(checkReleaseNotes({ text, expectedVersion: VERSION, platforms: ['linux', 'windows'], packetPlatform: 'linux' }).problems, [])
  assert.ok(checkReleaseNotes({ text, expectedVersion: VERSION, platforms: ['linux', 'windows'] }).problems.some(p => /has no install record/.test(p)))
})

test('a packet cannot carry another platform or certify pending measurements', () => {
  const text = notes({ records: [LINUX_RECORD, WINDOWS_RECORD] })
  const problems = checkReleaseNotes({ text, expectedVersion: VERSION, platforms: ['linux', 'windows'], packetPlatform: 'linux' }).problems
  assert.ok(problems.some(p => /digest pending/.test(p)))
  assert.ok(problems.some(p => /packet.*windows|windows.*packet/.test(p)))
})
