
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanForUnguardedDeskPhrases, scannedFileCount, SCAN_ROOT, PHYSICAL_INSTRUCTION } from '../lib/desk-phrase-scan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

test('the scan reports an unguarded physical instruction from a source file', (t) => {
  // Mutation proof (2026-08-28): inverting the scanner's
  // `if (!PHYSICAL_INSTRUCTION.test(joined)) continue` guard makes this
  // fixture return zero violations, so this assertion fails with `0 !== 1`.
  const scanRoot = mkdtempSync(path.join(tmpdir(), 'desk-phrase-scan-'))
  t.after(() => rmSync(scanRoot, { recursive: true, force: true }))
  writeFileSync(
    path.join(scanRoot, 'unguarded.js'),
    "export const warning = 'Open a terminal and perform the unguarded desk-only step.'\n",
  )

  const violations = scanForUnguardedDeskPhrases({ scanRoot })
  assert.equal(violations.length, 1)
  assert.equal(path.basename(violations[0].file), 'unguarded.js')
  assert.equal(violations[0].reason, 'no-remote-twin')
  assert.match(violations[0].text, /unguarded desk-only step/)
})

test('every desk-shaped string literal under src/ has a remote reading', () => {
  const violations = scanForUnguardedDeskPhrases()
  assert.deepEqual(
    violations.map(v => `${v.file}:${v.line} ${JSON.stringify(v.text)}`),
    [],
    'these string literals tell a browser reader to do something at a computer they are not at, ' +
    'and carry neither a live readerRemedy() translation nor a matching REMOTE_TWIN shape. ' +
    'Add a twin in src/refusal-copy.js (or, if the string is genuinely unreachable over the relay, ' +
    'an evidence-cited exemption in tools/lib/desk-phrase-scan.mjs) -- see that file\'s header for both paths.',
  )
})

test('the scan is actually walking src/, not silently matching nothing', () => {
  // A glob that matches zero files passes by finding nothing -- the exact
  // failure mode tools/check-suites-discovered.mjs exists to catch for the
  // test runner itself, applied here to this scan's own file walk. 60 is
  // comfortably under today's count and catches SCAN_ROOT pointing at an
  // empty or renamed directory without hardcoding a number that drifts on
  // every new file.
  const count = scannedFileCount()
  assert.ok(count > 60, `expected well over 60 files under ${SCAN_ROOT}, found ${count} -- is the scan root still src/?`)
})

test('this file\'s copy of PHYSICAL_INSTRUCTION has not drifted from reader-remedy-coverage.test.mjs\'s', () => {
  // Two independent copies of the same pattern were a deliberate choice (see
  // tools/lib/desk-phrase-scan.mjs's header) but an unnoticed edit to either
  // would let them silently diverge -- the same one-level-up drift this whole
  // guard exists to catch. Read as TEXT rather than imported as a module: a
  // node:test file registers its `test()` calls as a side effect of being
  // loaded, so importing reader-remedy-coverage.test.mjs here would run its
  // six tests a second time, nested inside this file's run, every time
  // `node --test tools/test/*.test.mjs` matches both.
  const sibling = readFileSync(path.join(HERE, 'reader-remedy-coverage.test.mjs'), 'utf8')
  const match = sibling.match(/PHYSICAL_INSTRUCTION = (\/.*\/i);/)
  assert.ok(match, 'could not find a PHYSICAL_INSTRUCTION regex literal in reader-remedy-coverage.test.mjs -- has it moved or been renamed?')
  // eslint-disable-next-line no-eval -- a regex LITERAL from a file in this
  // repo, not user input; this is how its exact source and flags are read
  // back without hand-parsing regex syntax a second time.
  const siblingPattern = (0, eval)(match[1])
  assert.equal(PHYSICAL_INSTRUCTION.source, siblingPattern.source)
  assert.equal(PHYSICAL_INSTRUCTION.flags, siblingPattern.flags)
})
