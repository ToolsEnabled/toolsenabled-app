#!/usr/bin/env node
/* THE APPROVED NODE IS A PIN, NOT WHATEVER PATH HANDS OUT.
 *
 * Measured during the 1.0.45 cut (2026-09-18, T309): two false reds in one
 * session -- a require(esm) cycle in the thinking-transcript suite and an
 * artifact-toolchain qualification refusal -- both came from a shell whose
 * PATH resolved `node` to v22.14.0 while the qualified toolchain is v22.19.0.
 * `npm run test:data` and the cutters took the bare PATH node, so a wrong
 * shell produced a red that looked like a product defect and cost a
 * diagnosis each time.
 *
 * The pin lives in ONE place: package.json "engines.node", as an exact
 * version. This file reads it and refuses, by name, when the running node is
 * not that version. It deliberately does not know where the approved binary
 * is installed -- a path would be a machine fact, and this repository is
 * built on more than one machine. Refusal names expected, actual and the
 * running binary so the fix is a one-line shell change, not an hour.
 *
 * Refusal codes (stderr, exit 1):
 *   NODE_VERSION_PIN_MISSING  package.json has no engines.node
 *   NODE_VERSION_PIN_INVALID  engines.node is a range, not an exact version
 *   NODE_VERSION_MISMATCH     process.versions.node differs from the pin
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXACT_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/

export function readPinnedNodeVersion(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const declared = manifest.engines && manifest.engines.node
  if (typeof declared !== 'string' || declared.trim() === '') {
    throw Object.assign(new Error('NODE_VERSION_PIN_MISSING: package.json declares no engines.node, so there is no approved node to check against.'), { code: 'NODE_VERSION_PIN_MISSING' })
  }
  const match = EXACT_VERSION.exec(declared.trim())
  if (!match) {
    throw Object.assign(new Error(`NODE_VERSION_PIN_INVALID: package.json engines.node is "${declared}"; the pin must be one exact version (for example 22.19.0), not a range, or a wrong node still passes.`), { code: 'NODE_VERSION_PIN_INVALID' })
  }
  return `${match[1]}.${match[2]}.${match[3]}`
}

export function checkNodeVersion({ root = REPO_ROOT, running = process.versions.node, execPath = process.execPath } = {}) {
  const expected = readPinnedNodeVersion(root)
  if (running !== expected) {
    throw Object.assign(
      new Error(`NODE_VERSION_MISMATCH: package.json engines.node pins node v${expected}, but this run is node v${running} at ${execPath}. Run with the approved node (put v${expected} first on PATH, or invoke it by its full path); the result of a run under any other node is not evidence.`),
      { code: 'NODE_VERSION_MISMATCH', expected, running, execPath },
    )
  }
  return { expected, running, execPath }
}

function main() {
  let result
  try {
    result = checkNodeVersion()
  } catch (error) {
    console.error(`check-node-version: ${error.message}`)
    process.exit(1)
  }
  console.log(`check-node-version: node v${result.running} matches the package.json engines.node pin (${result.execPath}).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
