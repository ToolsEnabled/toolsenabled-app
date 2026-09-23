#!/usr/bin/env node

/* THE DOCUMENT DESIGNED TO LEAVE THE MACHINE WAS THE ONE NOTHING SCANNED.
 *
 * check-no-owner-data.mjs guards the packaged bytes: it walks release/win-unpacked
 * and fails the build on anything that identifies the builder. That is the right
 * gate on the right payload, and it is wired into `npm run dist`.
 *
 * It never saw DECLARATION.md. The declaration is not inside the package -- it is
 * written beside it, into the transfer directory, by the release packager after the
 * build has already passed every gate. So the one file whose entire purpose is to
 * travel with the artifact and be read by whoever verifies it was the one file with
 * no privacy check at all, and it carried the builder's home directory in ten
 * different places for every candidate this packager has cut.
 *
 * REUSE, NOT REIMPLEMENTATION -- AND REUSE BY EXECUTION, NOT BY COPY.
 *
 * The obvious way to write this guard is to import a pattern list. There isn't one
 * to import: check-no-owner-data.mjs runs main() at module load, so importing it
 * scans a directory as a side effect. The tempting alternative -- restate its
 * patterns here -- creates a second list that drifts, and a privacy rule that is
 * true in one file and stale in another is worse than one strict rule, because the
 * stale copy still reports "clean".
 *
 * So this guard RUNS the real scanner. It writes the candidate text into a scratch
 * directory and points check-no-owner-data.mjs at it, which means it inherits all
 * eleven of that guard's patterns -- the built-in product ones AND the per-builder
 * identity profile -- and inherits every future change to them on the day it lands,
 * with no possibility of divergence. It also inherits that guard's refusal to pass
 * when the identity profile is missing, empty, or somebody else's.
 *
 * WHICH IS WHY EXIT CODE 2 IS A FAILURE HERE, NOT A SKIP. check-no-owner-data.mjs
 * exits 1 for "matches found" and 2 for "I could not do the check" -- a missing
 * profile, an unreadable one, an unnamed build account. Treating 2 as anything
 * other than a hard failure would rebuild, one level up, the exact
 * absence-as-emptiness defect that guard's own header spends thirty lines closing:
 * a check that reports success because it was given nothing to find. There is no
 * override flag in this file on purpose. A declaration that cannot be proved clean
 * is not written.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// Resolved relative to THIS file, not to cwd, so the guard and the scanner it
// delegates to are always the same pair from the same checkout. The test suite
// copies both into a fixture tree and this is what makes that work.
export const PAYLOAD_SCANNER = path.join(HERE, 'check-no-owner-data.mjs')

export const OWNER_DATA_FOUND = 'owner-data-found'
export const SCANNER_ERROR = 'scanner-error'
export const SCANNER_UNUSABLE = 'scanner-unusable'

// The scanner reports per-FILE, so the scratch copy keeps a recognisable name:
// an operator reading the failure needs to know which document tripped it.
function scratchFileName(label) {
  const base = path.basename(String(label || 'declaration'))
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_')
  return safe.length > 0 ? safe : 'declaration'
}

/**
 * Scan a string for owner data using the real payload scanner.
 * Returns { ok, reason, exitCode, output } -- never throws for a dirty result,
 * so a caller can decide between reporting and refusing.
 */
export function scanTextForOwnerData(label, text) {
  if (typeof text !== 'string') {
    return { ok: false, reason: SCANNER_UNUSABLE, exitCode: null, output: `nothing to scan: ${label} is not text` }
  }
  if (!existsSync(PAYLOAD_SCANNER)) {
    return {
      ok: false,
      reason: SCANNER_UNUSABLE,
      exitCode: null,
      output: `the payload scanner is missing at ${PAYLOAD_SCANNER}; this guard has no patterns of its own by design`,
    }
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'mc-declaration-privacy-'))
  try {
    writeFileSync(path.join(scratch, scratchFileName(label)), text, 'utf8')
    // JSON, including JSON embedded in another document, repeats backslashes.
    // Scan both original bytes and a separately labelled decoded-separator
    // view with the SAME scanner/patterns. This never changes public output or
    // reads a path found in the text; offsets name the view they refer to.
    const decodedSeparators = text.replace(/\\{2,}/g, '\\')
    if (decodedSeparators !== text) {
      writeFileSync(path.join(scratch, 'decoded-backslashes-' + scratchFileName(label)), decodedSeparators, 'utf8')
    }
    const result = spawnSync(process.execPath, [PAYLOAD_SCANNER, scratch], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

    if (result.error) {
      return { ok: false, reason: SCANNER_UNUSABLE, exitCode: null, output: `${output}\n${result.error.message}` }
    }
    if (result.status === 0) return { ok: true, reason: null, exitCode: 0, output }
    if (result.status === 1) return { ok: false, reason: OWNER_DATA_FOUND, exitCode: 1, output }
    if (result.status === 2) return { ok: false, reason: SCANNER_ERROR, exitCode: 2, output }
    return { ok: false, reason: SCANNER_UNUSABLE, exitCode: result.status, output }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Refuse to let `text` be written anywhere if it carries owner data.
 *
 * The thrown message is deliberately SHORT and carries no matched text. The
 * scanner prints matching offsets and 120-byte excerpts, which is exactly what
 * an operator needs and exactly what must not end up quoted into a file, a
 * commit message, or a report; so the detail goes to this process's stderr (a
 * local console) and the exception carries only counts and a reason.
 */
export function assertNoOwnerData(label, text, { log = console.error } = {}) {
  const result = scanTextForOwnerData(label, text)
  if (result.ok) return result

  if (result.output.trim()) log(`[check-declaration-privacy] scanner output for ${label}:\n${result.output.trim()}`)

  if (result.reason === OWNER_DATA_FOUND) {
    throw new Error(
      `${label} contains owner-identifying data and was NOT written. This document is designed to travel with ` +
        `the release artifact, so it must not carry the builder's name, account, machine paths or LAN addresses. ` +
        `The matches and their offsets were printed above by tools/check-no-owner-data.mjs (console only -- do not ` +
        `paste them into a file). Fix the renderer or the facts it was given; there is no override.`,
    )
  }
  if (result.reason === SCANNER_ERROR) {
    throw new Error(
      `${label} could not be checked for owner data (tools/check-no-owner-data.mjs exited 2 -- a setup problem, ` +
        `usually a missing or foreign private/owner-data-patterns.owner.json). Unchecked is not clean, so nothing ` +
        `was written. See the scanner's own message above.`,
    )
  }
  throw new Error(
    `${label} could not be checked for owner data: the scanner was unusable (exit ${result.exitCode}). ` +
      `Nothing was written.`,
  )
}

function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('usage: node tools/check-declaration-privacy.mjs <file> [<file> ...]')
    console.error('  scans generated release-provenance documents (DECLARATION.md, declaration-facts.json)')
    console.error('  for owner data, using tools/check-no-owner-data.mjs\'s own pattern set.')
    process.exitCode = 2
    return
  }

  let failures = 0
  let setupFailures = 0

  for (const file of files) {
    // A file that is not there is not a pass. The whole class of defect this
    // guard exists for is "the check reported success without looking".
    if (!existsSync(file)) {
      console.error(`[check-declaration-privacy] nothing to check: ${file} does not exist`)
      setupFailures += 1
      continue
    }
    const result = scanTextForOwnerData(path.basename(file), readFileSync(file, 'utf8'))
    if (result.ok) {
      console.log(`[check-declaration-privacy] clean: ${file}`)
      continue
    }
    if (result.output.trim()) console.error(result.output.trim())
    console.error(`[check-declaration-privacy] FAIL (${result.reason}): ${file}`)
    if (result.reason === OWNER_DATA_FOUND) failures += 1
    else setupFailures += 1
  }

  if (setupFailures > 0) process.exitCode = 2
  else if (failures > 0) process.exitCode = 1
}

// Compare filesystem identities, not the spelling of the command line. Release
// lanes can reach this file through junctions, symlinks, or differently-cased
// paths; treating those spellings as an import silently skips main() and turns
// every input into a green check that looked at nothing.
const invokedDirectly =
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))

if (invokedDirectly) main()
