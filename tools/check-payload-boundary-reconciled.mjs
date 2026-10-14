#!/usr/bin/env node

// THE PAYLOAD BOUNDARY MUST BE RECONCILED AGAINST THE ENGINE AT LANDING, NOT
// ONLY AT CUT TIME.
//
// WHY THIS EXISTS (T367 follow-up, measured 2026-09-18 at app 54f3e8e5 +
// engine 62d445398). The engine landing added src/lib/multi-account/usability.js
// and it packs into the capability payload, but config/payload-boundary.json
// classified it nowhere. Nothing noticed until `check-payload-boundary.mjs
// capability` ran at STEP 9 of the artifact half -- inside a cut, after a build
// and a pack, minutes in. The gate worked, but it fired at the worst moment: a
// red discovered during a cut is a cut that has to be thrown away. R1228 says
// the cut process itself is then the culprit, so the reconciliation moves to
// where the two land: `npm test` on the assembly, before any cut starts.
//
// THE QUESTION, and why it is asked THIS way. "Does the app's payload-boundary
// manifest classify every file the engine will pack?" The only faithful answer
// is the payload the real pack produces -- the closure PLUS the data files,
// neutral defaults and manifest listings that pack also stages. Re-deriving
// that set here would drift from pack the first time pack's staging changed, so
// this gate does not re-derive it: it runs the REAL pack (tools/
// pack-capability-layer.mjs) to a throwaway directory and runs the REAL payload
// gate (tools/check-payload-boundary.mjs) against it. Zero drift, because both
// are the exact tools the cut uses. The engine source is resolved the way pack
// resolves it (private/capability-source.owner.json / TOOLSENABLED_SOURCE),
// via resolveCapabilitySourceBinding.
//
// REFUSE BY NAME, NEVER SILENTLY PASS. If the engine source cannot be resolved
// (no owner file, dirty checkout, ref mismatch), this exits non-zero naming the
// reason. A landing gate that quietly passes because it could not find the
// thing it checks is the hole this closes, not a convenience.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXACT_GIT_COMMIT, resolveCapabilitySourceBinding } from './lib/capability-source-git.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECONCILE_UNRESOLVED = 'PAYLOAD_BOUNDARY_RECONCILE_ENGINE_UNRESOLVED'
const PACK = path.join(REPO_ROOT, 'tools', 'pack-capability-layer.mjs')
const BOUNDARY = path.join(REPO_ROOT, 'tools', 'check-payload-boundary.mjs')

function refuse(message) {
  console.error(`check-payload-boundary-reconciled: ${message}`)
  process.exit(2)
}

// THE CHILD ENV IS BUILT IN ONE PLACE, AND NAMES THE REF IT PASSES.
//
// MEASURED 2026-09-24 (R4). resolveCapabilitySourceBinding returns the commit as
// `sourceRef` (capability-source-git.mjs:180), not `ref`. This file destructured
// `ref`, so `ref` was `undefined` on every run -- with a private/
// capability-source.owner.json as much as without one. Node drops an env key whose
// value is `undefined` from the child's environment entirely, so
// `TOOLSENABLED_SOURCE_REF: ref` did not merely pass nothing: it DELETED a
// TOOLSENABLED_SOURCE_REF the caller had exported, and pack then refused with
// "the capability source has no exact commit binding". The documented env-var
// route could therefore never satisfy pack through this gate, and the log line
// read "@ undefined".
//
// So the env is built here, and the exact ref is asserted rather than assumed: a
// binding that does not carry a 40-character commit refuses by name instead of
// silently handing pack an environment with the key missing.
export function reconcileChildEnvironment({ parentEnvironment = process.env, source, sourceRef } = {}) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('reconcileChildEnvironment needs the resolved capability source path')
  }
  if (typeof sourceRef !== 'string' || !EXACT_GIT_COMMIT.test(sourceRef)) {
    throw new Error(
      'reconcileChildEnvironment needs the binding\'s exact 40-character commit; '
      + `got ${sourceRef === undefined ? 'undefined' : JSON.stringify(sourceRef)}. `
      + 'Passing an undefined ref would delete a caller-supplied TOOLSENABLED_SOURCE_REF from the child environment.',
    )
  }
  return {
    ...parentEnvironment,
    TOOLSENABLED_SOURCE: source,
    TOOLSENABLED_SOURCE_REF: sourceRef,
    TOOLSENABLED_STATE_ROOT: '',
    TOOLSENABLED_VAULT_PATH: '',
  }
}

function main() {
  // Resolve the engine source exactly as pack does, so the refusal names the
  // real reason before a throwaway pack is even attempted.
  let binding
  try {
    binding = resolveCapabilitySourceBinding({ repoRoot: REPO_ROOT })
  } catch (error) {
    refuse(`${RECONCILE_UNRESOLVED}: the engine payload source could not be resolved (${error.message}). `
      + 'Configure private/capability-source.owner.json or TOOLSENABLED_SOURCE; this gate refuses rather than passing blind.')
  }
  const { source, sourceRef: ref } = binding
  console.log(`check-payload-boundary-reconciled: staging the payload from ${source} @ ${ref} to reconcile against ${'config/payload-boundary.json'}`)

  const out = mkdtempSync(path.join(tmpdir(), 'payload-reconcile-'))
  try {
    const env = reconcileChildEnvironment({ parentEnvironment: process.env, source, sourceRef: ref })
    const packed = spawnSync(process.execPath, [PACK, '--out', out, '--quiet'], { cwd: REPO_ROOT, env, encoding: 'utf8' })
    if (packed.status !== 0) {
      process.stderr.write(packed.stderr || '')
      refuse(`${RECONCILE_UNRESOLVED}: the engine payload could not be staged from ${source} @ ${ref} (pack exit ${packed.status}). `
        + 'A source that cannot be staged cannot be reconciled; fix the source, do not skip the check.')
    }
    // The real payload gate, against the freshly staged tree: any file the
    // manifest classifies nowhere REDs by name, exactly as it would at cut step 9.
    const checked = spawnSync(process.execPath, [BOUNDARY, out], { cwd: REPO_ROOT, env, encoding: 'utf8' })
    process.stdout.write(checked.stdout || '')
    process.stderr.write(checked.stderr || '')
    if (checked.status !== 0) {
      console.error('\ncheck-payload-boundary-reconciled: the engine will pack a file the app\'s payload boundary classifies nowhere. '
        + 'Classify it in config/payload-boundary.json now, at the landing, so a cut cannot start with an unclassified payload file.')
      process.exit(checked.status || 1)
    }
    console.log('check-payload-boundary-reconciled: every file the engine will pack is classified by config/payload-boundary.json.')
  } finally {
    try { rmSync(out, { recursive: true, force: true }) } catch { /* Windows may hold a handle briefly */ }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
