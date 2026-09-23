// EVERY PATH THE SHIPPED MANIFEST REFERENCES MUST RESOLVE INSIDE THE PAYLOAD.
//
// Nothing checked this before, and the measured result: the payload shipped
// the engine's package.json byte-identical -- 119 scripts naming 603 test
// files and 17 tools/ paths that do not exist in the payload (no tests/
// directory ships at all). Every npm script in the shipped product failed on
// contact, and the file published ~620 internal engine file names to every
// install. The existing gates each looked elsewhere: check-no-owner-data scans
// for owner identity (there was none -- file NAMES are not owner data),
// check-payload-boundary classifies which files ship (package.json is open),
// and check-payload-current compares bytes against the source (they matched,
// because shipping the wrong file faithfully is still shipping it).
//
// The fix stages a curated capability-defaults/package.json over the engine's
// via neutralDefaults; this test is the guard that keeps it curated. It reads
// the STAGED payload, so it validates whatever the packer actually produced,
// not what any config promises.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const here = fileURLToPath(import.meta.url)
const REPO = dirname(dirname(dirname(here)))
const PAYLOAD = join(REPO, 'capability')
const MANIFEST = join(PAYLOAD, 'package.json')

// Path-like tokens inside script commands: the payload's own top-level trees.
const REF_PATTERN = /(?:src|tools|tests|config|research|schemas|sidecars|bin)\/[A-Za-z0-9._/-]+/g

function stagedPayloadMissing() {
  return !existsSync(MANIFEST)
}

const SKIP = 'capability/ is not staged in this checkout; run `npm run pack:capability` first. On a machine with the pinned source this test RUNS.'

test('every script in the shipped package.json references only files that ship', (t) => {
  if (stagedPayloadMissing()) return t.skip(SKIP)
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const missing = []
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    for (const ref of command.match(REF_PATTERN) ?? []) {
      if (!existsSync(join(PAYLOAD, ref))) missing.push(`${name}: ${ref}`)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `shipped scripts reference files absent from the payload -- a customer running them gets MODULE_NOT_FOUND:\n  ${missing.join('\n  ')}`,
  )
})

test('every bin target in the shipped package.json ships', (t) => {
  if (stagedPayloadMissing()) return t.skip(SKIP)
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const missing = Object.entries(manifest.bin ?? {})
    .filter(([, target]) => !existsSync(join(PAYLOAD, target)))
    .map(([name, target]) => `${name}: ${target}`)
  assert.deepEqual(missing, [], `shipped bin entries point at absent files:\n  ${missing.join('\n  ')}`)
})

test('the shipped package.json does not enumerate the engine test suite', (t) => {
  if (stagedPayloadMissing()) return t.skip(SKIP)
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const testRefs = Object.values(manifest.scripts ?? {})
    .filter(command => command.includes('tests/'))
  // No tests/ directory ships, so ANY tests/ reference is a dead one -- and
  // hundreds of them are how ~620 internal engine file names reached every
  // install. Zero is the only honest number.
  assert.equal(
    testRefs.length,
    0,
    `the shipped manifest names ${testRefs.length} script(s) with tests/ paths; the payload ships no tests/ directory, so each is a dead reference leaking an internal file name (first: ${testRefs[0]})`,
  )
})

test('the payload manifest stays the curated neutral default, not the engine file', (t) => {
  if (stagedPayloadMissing()) return t.skip(SKIP)
  const defaultsFile = join(REPO, 'capability-defaults', 'package.json')
  assert.ok(existsSync(defaultsFile), 'capability-defaults/package.json is missing; the curated manifest has no source')
  assert.deepEqual(
    JSON.parse(readFileSync(MANIFEST, 'utf8')),
    JSON.parse(readFileSync(defaultsFile, 'utf8')),
    'capability/package.json differs from capability-defaults/package.json -- the packer staged something other than the curated default (is package.json still in neutralDefaults?)',
  )
})

test('every ACCEPTED dependency actually reaches the shipped manifest', () => {
  /* THE DEFECT THIS CLOSES, AND IT SURVIVED FOUR DAYS IN SILENCE.
   *
   * `werift` was reviewed and written into config/dependency-acceptance.json on
   * 2026-08-20 -- kind crypto, license MIT -- and never added to this manifest.
   * The payload ships no node_modules, so the manifest is the only thing that
   * could install it. The engine's consumer requires it LAZILY:
   *
   *     try { return require('werift') } catch { return null }
   *
   * so the direct-Ethernet WebRTC transport reported itself unavailable and the
   * relay road carried on. That is the documented fallback behaving exactly as
   * designed, which is precisely why nobody noticed a whole transport had never
   * run in any build.
   *
   * REVIEWED, ACCEPTED, NEVER WIRED -- with nothing anywhere reporting a fault.
   * The acceptance ledger records a DECISION; only this file makes it real, and
   * until now nothing compared them.
   *
   * Direction matters: this asserts accepted -> manifest. The reverse is
   * already covered by the capture gate the ledger exists to serve, and a
   * baselineDependencies entry is a dependency that predates that gate rather
   * than one that skipped it.
   */
  const ledgerFile = join(REPO, 'capability-defaults', 'config', 'dependency-acceptance.json')
  if (!existsSync(ledgerFile)) return
  const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  const manifest = JSON.parse(readFileSync(join(REPO, 'capability-defaults', 'package.json'), 'utf8'))
  const declared = new Set(Object.keys(manifest.dependencies || {}))

  const accepted = Array.isArray(ledger.records) ? ledger.records : []
  const missing = accepted.map(record => record?.name).filter(name => name && !declared.has(name))
  assert.deepEqual(
    missing,
    [],
    `accepted into the dependency ledger but absent from the shipped manifest: ${missing.join(', ')}. `
    + 'The payload ships no node_modules, so a dependency this manifest does not name is never installed -- '
    + 'and a lazy require of it fails silently, which is how one of these hid for four days.',
  )
})
