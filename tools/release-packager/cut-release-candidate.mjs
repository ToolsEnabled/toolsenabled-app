#!/usr/bin/env node
/* THE ONE COMMAND: produce a declarable ToolsEnabled release candidate.
 *
 * This packager makes producing and handing off a new version repeatable. A
 * manual cut otherwise means a full session by hand -- a build
 * from a dirty tree that had to be thrown away, and a near-miss where an
 * unrelated agent's uncommitted work was baked into a release candidate,
 * caught only because someone happened to run `git status` by hand right
 * before writing the declaration up. This script is that hand process,
 * mechanised, so the same mistakes cannot recur silently:
 *
 *   1. NEVER build in the shared day-to-day worktree. It has another lane's
 *      live, claimed, uncommitted work in it. This script
 *      always builds in a throwaway `git worktree add --detach` checkout,
 *      which by construction cannot contain anything not already committed.
 *      require-clean-tree.mjs (already wired into `npm run dist`) is the
 *      real gate; this script does not duplicate it, it just guarantees the
 *      tree that gate inspects is trustworthy in the first place.
 *   2. NEVER let the version number lie. Two different binaries must never
 *      silently share "1.0.1" -- see lib/version-bump.mjs.
 *   3. COPY THE ARTIFACT OUT BEFORE CLEANING UP. A previous run destroyed a
 *      freshly built exe by removing its worktree first. Ordering here is:
 *      build -> copy to durable staging -> re-hash -> exact packaged QA ->
 *      validate PE identity and all declaration metadata -> immutable candidate tag -> ONLY THEN remove
 *      the worktree. Every failure path leaves the worktree in place for
 *      postmortem rather than guessing it's safe to delete.
 *   4. DECLARE ONLY WHAT WAS MEASURED. generate-declaration.mjs takes real
 *      hashes, real VersionInfo off the real exe, and real pipeline output
 *      -- never intent, never package.json's say-so alone.
 *
 * What this script deliberately does NOT do: transfer the candidate to
 * another machine, or advance the checked-out release branch, unless asked
 * with --advance-branch. Both are separate, explicit decisions -- see
 * serve-candidate.mjs / verify-candidate.ps1 for the transfer half.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  commitPaths,
  currentBranch,
  fastForwardBranch,
  isClean,
  listTrackedFiles,
  porcelainStatus,
  tagCommit,
  revParse,
  showFile,
  worktreeAddDetached,
  worktreeRemove,
} from './lib/git.mjs'
import { measureFile, sameBytes } from './lib/hash.mjs'
import { provisionNodeModules, prepareNativeTestDependencies, releaseNodeModulesJunction } from './lib/node-modules-reuse.mjs'
import { assertStagingFree } from './lib/staging-collision.mjs'
import { claimCutSlot } from './lib/cut-slot.mjs'
import { findOtherCandidates } from './lib/scan-artifacts.mjs'
import { assertCandidatePeIdentity, readExeVersionInfo, WINDOWS_POWERSHELL } from './lib/version-info.mjs'
import { computeNextVersion, writePackageVersion } from './lib/version-bump.mjs'
import { portablePath } from './lib/portable-paths.mjs'
import { prepareDeclarationArtifacts, tagDeclaredCandidate } from './lib/declaration-preflight.mjs'
import { assertReadinessHandoffPaths, preserveReadinessReceipt } from './lib/readiness-handoff.mjs'
import { assertReleaseReadiness, assertReadinessAdaptersAvailable, assertReceiptNamesRegisteredAdapters, readReleaseReadiness, readQualificationContext, qualifyReleaseArtifact, WINDOWS_READINESS_TARGET } from '../lib/release-readiness.mjs'
import {
  POST_BUILD_GATES,
  defaultEvidencePath,
  describeArtifact,
  runGates,
  selectGates,
  selectSkippableGates,
  summarizeGateRun,
} from './lib/gate-evidence.mjs'
import { assertGateWorktreeAvailable, withGateWorktree } from './lib/gate-quarantine.mjs'
import { runOwnedProcess } from '../lib/owned-process.mjs'
import { ACCOUNT_IDENTITY_NAMES, NODE_LOADER_NAMES, OWNED_NAMES, assertScratchFence, requiredNames } from '../lib/scratch-fence.mjs'
import { CUT_CONTEXT_VARIABLE, WORKSPACE_SEGMENTS_UNRESOLVED_CODE, WORKSPACE_SEGMENTS_VARIABLE, isUsableWorkspaceSegment, segmentsBelowHome } from '../check-no-owner-data.mjs'
import { createRequire } from 'node:module'
import { cuttingAttribution, cuttingIdentity, cuttingSession } from './generate-declaration.mjs'
import { assertSourceInstallPlan, checkReleaseNotes, packetReleaseNotes } from '../check-release-notes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Derived from the same authority the fence reads, so the cut re-points exactly
// the provider homes the fence will judge.
const PROVIDER_HOME_NAMES = requiredNames().groups.find((group) => group.category === 'provider homes').names
// The authoritative list of capability path overrides, owned by the shell and
// kept in sync with capability/src by its own regression test.
const { CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES } = createRequire(import.meta.url)('../../shell/capability-path-environment.cjs')
const DEFAULT_REPO = path.resolve(HERE, '..', '..') // current app repository
// Derived from the running account's home directory rather than written out.
// The literal that used to be here named the owner in this file's own source,
// which is the leak this lane exists to close one step further upstream: a
// hardcoded home path is owner data in the tool as well as in what it emits.
// Use a stable, customer-neutral Desktop folder derived from the running
// account. It is intentionally not tied to a historical machine, checkout,
// or user-specific workspace layout.
export const DEFAULT_STAGING_ROOT = path.join(os.homedir(), 'Desktop', 'ToolsEnabled-INSTALLER-CANDIDATE')
const DEFAULT_TEST_STAGING_ROOT = path.join(os.tmpdir(), 'release-packager-test-candidates')
const EXACT_COMMIT = /^[0-9a-f]{40}$/

export function assertCutQualification(readinessEvidence, readinessOutput, readinessContext, target = WINDOWS_READINESS_TARGET) {
  if (readinessEvidence !== undefined && (typeof readinessEvidence !== 'string' || !readinessEvidence.trim())) {
    throw new Error('--readiness-evidence must name one receipt when supplied. Without it, the registered qualifier measures the assembled artifact.')
  }
  if (readinessOutput !== undefined && (typeof readinessOutput !== 'string' || !readinessOutput.trim())) {
    throw new Error('--readiness-output must name one private receipt destination when supplied')
  }
  if (readinessContext !== undefined && (typeof readinessContext !== 'string' || !readinessContext.trim())) throw new Error('--readiness-context must name a private context file')
  if (readinessEvidence && readinessContext) throw new Error('a supplied receipt already binds its context; do not also supply --readiness-context')
  // No Git, staging, build, provider or installer side effects just to discover
  // that a required trusted readiness adapter has not been implemented.
  assertReadinessAdaptersAvailable('toolsenabled', target)
  if (!readinessEvidence && !readinessOutput) throw new Error('--readiness-output is required when producing a receipt; choose an existing private evidence directory')
  if (!readinessEvidence && !readinessContext) throw new Error('--readiness-context is required when producing a receipt; explicitly locate the actual source, stage, harness and private evidence inputs')
}

/* THE FOUR LOCATIONS ARE KNOWN BEFORE ANYTHING IS BUILT, SO CHECK THEM NOW.
 * readQualificationContext() already compares the qualification context's
 * sourceRoots.app / stageRoot / harnessRoot / evidenceRoot against the real
 * build inputs -- but it is called after `npm run dist`, and it cannot simply
 * be moved earlier: its fencedEntry() lstats every path component, and neither
 * the build worktree nor its release/win-unpacked exists before the build.
 * Cut 1 (2026-09-16) spent a 20-minute build and would then have refused on
 * three of these four fields, because they were filled in by hand.
 *
 * So the same predicate -- path.relative(actual, wanted) !== '' -- is applied
 * here lexically, with no existence requirement, against values derived from
 * --build-dir, --staging and --readiness-output. The refusal names the field,
 * the value the context file carries and the value this cut derived, because
 * "differs from the actual build input" alone does not tell an operator which
 * of the two to change.
 *
 * PASSING THIS IS NOT QUALIFICATION. readQualificationContext() still runs
 * after the build, still on directories that exist by then, and it remains the
 * authority. This only refuses earlier, for free, the cases it would refuse
 * expensively. */
export async function assertQualificationContextLocations(contextPath, expected, { read = readFile } = {}) {
  const FIELDS = ['sourceRoots', 'stageRoot', 'harnessRoot', 'evidenceRoot']
  if (typeof contextPath !== 'string' || !contextPath.trim()) {
    throw new Error('--readiness-context must name a private context file to compare against the build inputs')
  }
  let context
  try {
    context = JSON.parse(await read(contextPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `the qualification context could not be read as JSON before the build: ${contextPath}\n` +
        `  reason:   ${error instanceof Error ? error.message : String(error)}\n` +
        '  The cut needs its four locations now, not after npm run dist.',
    )
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error(`the qualification context must be a JSON object naming ${FIELDS.join(', ')}: ${contextPath}`)
  }
  const pairs = []
  for (const [key, value] of Object.entries(expected)) {
    if (!FIELDS.includes(key)) throw new Error(`unknown expected qualification location: ${key}`)
    if (key === 'sourceRoots') {
      const roots = context.sourceRoots && typeof context.sourceRoots === 'object' && !Array.isArray(context.sourceRoots)
        ? context.sourceRoots
        : {}
      for (const [name, wanted] of Object.entries(value)) pairs.push([`sourceRoots.${name}`, roots[name], wanted])
    } else {
      pairs.push([key, context[key], value])
    }
  }
  for (const [label, actual, wanted] of pairs) {
    if (typeof wanted !== 'string' || !path.isAbsolute(wanted)) {
      throw new Error(
        `this cut could not derive an absolute ${label}, so the qualification context cannot be checked before the ` +
          `build. Pass an absolute --build-dir, --staging and --readiness-output. Derived: ${JSON.stringify(wanted)}`,
      )
    }
    if (typeof actual !== 'string' || !actual.trim()) {
      throw new Error(
        `qualification context ${label} is missing or is not a path, and this cut refuses before building.\n` +
          `  field:    ${label}\n` +
          `  found:    ${actual === undefined ? '(absent)' : JSON.stringify(actual)}\n` +
          `  expected: ${wanted}\n` +
          `  file:     ${contextPath}`,
      )
    }
    if (path.relative(actual, wanted) !== '') {
      throw new Error(
        `qualification context ${label} differs from the actual build input, and this cut refuses before building.\n` +
          `  field:    ${label}\n` +
          `  found:    ${actual}\n` +
          `  expected: ${wanted}\n` +
          `  file:     ${contextPath}\n` +
          '  Nothing has been built and no worktree was created. Correct the context file, or correct the flag it ' +
          'disagrees with, and re-run.',
      )
    }
  }
  return true
}


/* THE SEAL RECORD IS PRODUCED BY THE CUT, NOT REMEMBERED BY A PERSON.
 *
 * tooling/release-controller/seal-cut-record.mjs measures the installer itself
 * and refuses by name when it cannot. It existed, it passed its own suite, and
 * NOTHING CALLED IT: no npm script named it and no exit path referenced it. So
 * cut 1 was "sealed" by a hand-written markdown file that named no installer,
 * no byte count and no sha256 -- which is exactly what a guard invoked by
 * memory produces the first time memory is busy.
 *
 * The tool lives in the release-controller repository, not in this one, so its
 * location cannot be a relative path from here and must not be a literal: it is
 * named by --seal-record-tool or TOOLSENABLED_SEAL_RECORD_TOOL. What is NOT
 * optional is that a record gets produced. A cut that cannot name the tool
 * refuses before it builds; a cut whose seal step fails throws, so the
 * candidate-ready banner is never printed and no sealed marker exists. */
export const SEAL_RECORD_TOOL_ENV = 'TOOLSENABLED_SEAL_RECORD_TOOL'

export function resolveSealRecordTool(explicit, { environment = process.env, exists = existsSync } = {}) {
  const named = typeof explicit === 'string' && explicit.trim()
    ? { value: explicit, from: '--seal-record-tool' }
    : typeof environment[SEAL_RECORD_TOOL_ENV] === 'string' && environment[SEAL_RECORD_TOOL_ENV].trim()
      ? { value: environment[SEAL_RECORD_TOOL_ENV], from: SEAL_RECORD_TOOL_ENV }
      : null
  if (!named) {
    throw new Error(
      'this cut has no way to write a seal record, and a cut that cannot seal is not a candidate.\n' +
        '  Name seal-cut-record.mjs with --seal-record-tool <path>, or set ' + SEAL_RECORD_TOOL_ENV + '.\n' +
        '  It lives in the release-controller repository, which is checked out separately from this one, so ' +
        'there is no correct default to fall back to.\n' +
        '  Refusing here, before the build, rather than after it.',
    )
  }
  const resolved = path.resolve(named.value)
  if (!exists(resolved)) {
    throw new Error(
      `the seal record tool named by ${named.from} does not exist: ${resolved}\n` +
        '  Refusing here, before the build, rather than after it.',
    )
  }
  return resolved
}

/* Runs the seal tool and then insists a record is actually on disk. Both halves
 * matter: exit 0 with no file, and a file left over from an earlier cut, are
 * both "no seal" and both used to read as success. The tool measures bytes and
 * sha256 from the installer itself -- this deliberately does not pass the
 * cutter's own measurements in, so the two are independent. */
export async function sealCutRecord({
  tool, installerPath, appRef, engineRef, version, manifestPath, recordPath,
  run = runOwnedProcess, log = console.log, exists = existsSync,
}) {
  if (exists(recordPath)) {
    throw new Error(
      `a seal record already exists at ${recordPath}. A cut never overwrites one: it would replace the record of ` +
        'whatever was sealed there before. Move it aside or stage this candidate elsewhere.',
    )
  }
  const argv = [
    tool, '--record',
    '--installer', installerPath,
    '--app-ref', appRef,
    '--engine-ref', engineRef,
    '--version', version,
    '--out', recordPath,
    ...(manifestPath ? ['--manifest', manifestPath] : []),
  ]
  log(`[cut-release-candidate] sealing the cut record: ${path.basename(tool)} --record --out ${recordPath}`)
  const sealed = await run(process.execPath, argv, {
    cwd: path.dirname(tool), env: process.env, timeoutMs: 10 * 60_000, log,
  })
  if (sealed.code !== 0) {
    // The tool prints "REFUSED <CODE>: <detail>" on stderr and names what it
    // rejected. Carry that through instead of an exit number on its own.
    throw new Error(
      `the seal record was REFUSED by ${tool} (exit ${sealed.code}${sealed.failureReason ? `, ${sealed.failureReason}` : ''}), ` +
        'so this cut has no sealed record and is not a candidate. No sealed marker was written.\n' +
        `${(sealed.output ?? '').trim()}`,
    )
  }
  if (!exists(recordPath)) {
    throw new Error(
      `the seal tool reported success but wrote no record at ${recordPath}, so nothing measured this candidate. ` +
        'Refusing to declare a cut sealed on a record that does not exist.',
    )
  }
  return recordPath
}

// Pure attribution preflight stays observable before readiness refusal; no
// source Git probe or staging write is needed to validate these caller fields.
export function assertCutterAttribution() {
  /* Refuse in a second rather than at the commit, four minutes in, with a
     build worktree stranded for postmortem. Measured on the 1.0.22 cut. */
  const cutterIdentity = cuttingIdentity()
  const cutterSession = cuttingSession()
  const cutterAttribution = cuttingAttribution()
  if (!cutterIdentity) {
    throw new Error(
      'the cutter identity is missing or invalid, and this repo\'s commit-msg and DCO gates require an attributable '
      + 'version-bump commit. Set a complete TOOLSENABLED_CUT_MODEL and TOOLSENABLED_CUT_EMAIL pair (or the supported '
      + 'Claude fallback) to whoever is cutting, then run this again.',
    )
  }
  if (!cutterSession) {
    throw new Error(
      'the cutter session is missing or invalid, and this repo\'s commit-msg hook requires a unique session seat '
      + 'discriminator. Set TOOLSENABLED_CUT_SESSION (or CLAUDE_SESSION_ID) to 4-200 characters using only '
      + 'A-Z, a-z, 0-9, _ or -, then run this again.',
    )
  }
  return { cutterIdentity, cutterSession, cutterAttribution }
}

export function parseArgs(argv) {
  const args = { bump: 'patch', advanceBranch: false, keepWorktree: false, test: false, allowSameVersion: false, replaceStaged: false }
  const singleValueOptions = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const valueFor = (noun = 'value', { repeatable = false } = {}) => {
      if (!repeatable && singleValueOptions.has(arg)) throw new Error(`${arg} accepts exactly one ${noun}`)
      const value = argv[i + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
        throw new Error(`${arg} requires one ${noun}`)
      }
      if (!repeatable) singleValueOptions.add(arg)
      i += 1
      return value
    }
    if (arg === '--bump') args.bump = valueFor()
    else if (arg === '--version') args.explicitVersion = valueFor()
    else if (arg === '--allow-same-version') args.allowSameVersion = true
    else if (arg === '--replace-staged') args.replaceStaged = true
    else if (arg === '--source-ref') args.sourceRef = valueFor()
    else if (arg === '--engine-source-ref') args.engineSourceRef = valueFor()
    else if (arg === '--release-platform') (args.releasePlatforms ??= []).push(valueFor('platform name', { repeatable: true }).trim().toLowerCase())
    else if (arg === '--readiness-evidence') args.readinessEvidence = valueFor('path')
    else if (arg === '--readiness-output') args.readinessOutput = valueFor('path')
    else if (arg === '--readiness-context') args.readinessContext = valueFor('path')
    else if (arg === '--repo') args.repo = valueFor('path')
    else if (arg === '--staging') args.staging = valueFor('path')
    else if (arg === '--build-dir') args.buildDir = valueFor('path')
    else if (arg === '--advance-branch') args.advanceBranch = true
    else if (arg === '--keep-worktree') args.keepWorktree = true
    else if (arg === '--seal-control') args.sealControl = valueFor('path')
    else if (arg === '--seal-record-tool') args.sealRecordTool = valueFor('path')
    else if (arg === '--test') args.test = true
    else if (arg === '--other-candidate-root') (args.otherCandidateRoots ??= []).push(valueFor('path', { repeatable: true }))
    else if (arg === '--known-fix') (args.knownFixes ??= []).push(parseKnownFixArg(valueFor('value', { repeatable: true })))
    else if (arg === '--gates-only') args.gatesOnly = valueFor('path')
    else if (arg === '--gate') (args.gates ??= []).push(valueFor('name', { repeatable: true }))
    else if (arg === '--gate-source') args.gateSource = valueFor('path')
    else if (arg === '--evidence-out') args.evidenceOut = valueFor('path')
    else if (arg === '--resume-from') args.resumeFrom = valueFor('path')
    else if (arg === '--skip-verified') (args.skipVerified ??= []).push(valueFor('path', { repeatable: true }))
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unrecognised argument: ${arg}`)
  }
  assertGateFlagCombination(args)
  args.releasePlatforms = [...new Set(args.releasePlatforms ?? ['windows'])]
  if (args.releasePlatforms.some(platform => !['linux', 'windows', 'macos'].includes(platform))) throw new Error('--release-platform must be one of linux, windows, macos')
  if (!args.releasePlatforms.includes('windows')) throw new Error('--release-platform must include windows for the Windows cutter')
  return args
}

/* The three incremental-gate flags have exactly one shape each. Combinations
 * that would let a flag silently do nothing (--gate with no --gates-only,
 * --skip-verified with nothing to resume) refuse at the boundary, because a
 * flag that parses and is ignored is how a person believes a gate was skipped
 * or run when it was not. */
export function assertGateFlagCombination(args) {
  if (args.gatesOnly && (args.readinessEvidence || args.readinessOutput || args.readinessContext)) throw new Error('--gates-only is diagnostic scope; readiness evidence/output/context belongs to a full cut/qualification')
  if (args.gatesOnly && args.resumeFrom) throw new Error('--gates-only and --resume-from are different modes; pass exactly one')
  if (args.gates && !args.gatesOnly) throw new Error('--gate selects gates for --gates-only and does nothing without it')
  if (args.evidenceOut && !args.gatesOnly) throw new Error('--evidence-out names the --gates-only record and does nothing without it')
  if (args.skipVerified && !args.resumeFrom) throw new Error('--skip-verified feeds evidence to --resume-from and does nothing without it')
  if (args.resumeFrom && args.buildDir) throw new Error('--resume-from names the worktree itself; --build-dir does not apply')
  if (args.resumeFrom && args.sealControl) throw new Error('--seal-control drives a fresh sealed cut; a resumed cut cannot replay its phases')
  if (args.gatesOnly && (args.advanceBranch || args.replaceStaged || args.knownFixes || args.sealControl)) {
    throw new Error('--gates-only runs gates and writes evidence only; it never advances a branch, stages, declares or seals')
  }
}

// --known-fix "description::verifiedBy[::evidence]" -- `::` rather than a
// single colon so a Windows path or a URL in the evidence text doesn't get
// mis-split. verifiedBy must be one of generate-declaration.mjs's
// VERIFICATION_LABELS keys (source-only / observed / both) so the caller is
// forced to say which kind of claim this is, not just that a fix exists --
// see that file's comment for why that distinction is the point.
export function parseKnownFixArg(raw) {
  if (!raw) throw new Error('--known-fix requires a value: "description::verifiedBy[::evidence]"')
  const [description, verifiedBy, ...evidenceParts] = raw.split('::')
  if (!description || !verifiedBy) {
    throw new Error(`--known-fix value must be "description::verifiedBy[::evidence]", got: ${JSON.stringify(raw)}`)
  }
  return { description: description.trim(), verifiedBy: verifiedBy.trim(), evidence: evidenceParts.join('::').trim() || undefined }
}

/* Convert the optional caller spelling into one immutable commit before any
 * version read, worktree creation or declaration. A moving branch/tag is not
 * release provenance. HEAD remains convenient, but only its resolved commit is
 * carried past this boundary. */
export function resolveExactAppSourceRef(repo, requestedRef, { resolve = revParse, clean = isClean } = {}) {
  if (requestedRef !== undefined && requestedRef !== null
      && (typeof requestedRef !== 'string' || !EXACT_COMMIT.test(requestedRef))) {
    throw new Error('--source-ref must name one exact 40-character lowercase application commit id')
  }
  if (requestedRef == null && !clean(repo)) {
    throw new Error('the application checkout has uncommitted work; commit the intended source or supply an explicit --source-ref so the cut cannot silently omit working changes')
  }
  const resolved = resolve(repo, requestedRef == null ? 'HEAD^{commit}' : `${requestedRef}^{commit}`)
  if (typeof resolved !== 'string' || !EXACT_COMMIT.test(resolved)) {
    throw new Error('the application source did not resolve to one exact lowercase commit id')
  }
  if (requestedRef != null && resolved !== requestedRef) {
    throw new Error('the declared application source ref does not resolve to itself as a commit')
  }
  return resolved
}

/* THE BUILD WORKTREE'S OWN PRIVATE DECLARATION DECIDES WHAT GETS PACKED.
 *
 * pack-capability-layer.mjs resolves its engine checkout from the worktree's
 * private/capability-source.owner.json and refuses a --source-ref that
 * disagrees with it. The cut passes --engine-source-ref and never looked at
 * that file, so a worktree created earlier quietly packed whatever ITS private
 * file pinned: measured on the b4a assembly worktree 2026-09-17, whose
 * declaration and PAYLOAD.json both read e2d443c5 -- 36 commits behind the
 * engine this cut was told to seal -- with tools/secrets-manager.ps1 absent
 * from the payload although the manifest at the tip declares it. Nothing in
 * the cut disagreed, because nothing in the cut asked. */
export function assertDeclaredEngineSource(declaration, engineSourceRef, { file = 'private/capability-source.owner.json' } = {}) {
  const declared = typeof declaration?.ref === 'string' ? declaration.ref.trim().toLowerCase() : null
  if (!declared) {
    throw new Error(
      `${file} declares no engine ref, so the packer would choose the payload source and this cut would not know what it staged.\n` +
        `  --engine-source-ref: ${engineSourceRef}\n` +
        '  Write the declaration to that exact ref, or pass the engine checkout that already declares it.',
    )
  }
  if (declared !== engineSourceRef) {
    throw new Error(
      `${file} and --engine-source-ref name different engine commits, and the packer follows the FILE, not the flag.\n` +
        `  declared in ${file}: ${declared}\n` +
        `  --engine-source-ref:  ${engineSourceRef}\n` +
        '  Refusing before packing rather than staging a payload this cut did not ask for.',
    )
  }
  return declared
}

/* AFTER PACKING, ASK THE PAYLOAD WHAT IT ACTUALLY IS. The pre-pack check above
 * reads a file the packer also reads; this one reads the packer's OUTPUT, so a
 * packer that ignored both still cannot pass. Helper programs are checked by
 * name because the require() walk cannot see a PowerShell or Python program
 * reached through a spawn argument -- tools/capability-manifest.json's own
 * $comment_helperPrograms says so -- and a declared helper missing from the
 * payload means its whole verb set fails closed on the installed product. */
/* The packer's own construction, read back: every staged file sorted by
 * relative path, each path NUL-separated from its bytes, PAYLOAD.json itself
 * excluded because the packer accumulates the digest before that record
 * exists. Kept beside the assertion that uses it so the two conventions cannot
 * drift apart silently. */
export function measurePackedTree(payloadRoot, { walk = readdirSync, readBytes = readFileSync } = {}) {
  const relatives = []
  const visit = (directory) => {
    for (const entry of walk(path.join(payloadRoot, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(relative)
      else if (relative !== 'PAYLOAD.json') relatives.push(relative)
    }
  }
  visit('')
  relatives.sort()
  const digest = createHash('sha256')
  let byteCount = 0
  for (const relative of relatives) {
    const bytes = readBytes(path.join(payloadRoot, ...relative.split('/')))
    digest.update(relative)
    digest.update('\0')
    digest.update(bytes)
    byteCount += bytes.length
  }
  return { fileCount: relatives.length, byteCount, payloadSha256: digest.digest('hex') }
}

export function assertPackedPayload(payloadRoot, engineSourceRef, manifestPath, { read = readFileSync, exists = existsSync, measureTree = measurePackedTree } = {}) {
  /* THE HELPER LIST IS READ HERE, FROM THE MANIFEST, NEVER HANDED IN. A caller
   * that passes an already-parsed array decides what gets checked, and a short
   * array passes a short check -- the scope error that lets a nine-path change
   * be reviewed as six. Taking the path and reading it means the declared set
   * and the measured set come from the same file every time. */
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) throw new Error('assertPackedPayload needs the path of tools/capability-manifest.json, not a parsed list')
  if (!exists(manifestPath)) throw new Error(`the capability manifest does not exist at ${manifestPath}, so no declared helper list could be read`)
  let manifest
  try { manifest = JSON.parse(read(manifestPath, 'utf8')) } catch (error) {
    throw new Error(`the capability manifest is unreadable at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const payloadManifestPath = path.join(payloadRoot, 'PAYLOAD.json')
  if (!exists(payloadManifestPath)) throw new Error(`the packed payload has no PAYLOAD.json at ${payloadManifestPath}; nothing measured what was staged`)
  let packed
  try { packed = JSON.parse(read(payloadManifestPath, 'utf8')) } catch (error) {
    throw new Error(`the packed payload's PAYLOAD.json is unreadable at ${payloadManifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const packedRef = typeof packed?.sourceRef === 'string' ? packed.sourceRef.trim().toLowerCase() : null
  if (packedRef !== engineSourceRef) {
    throw new Error(
      'the staged payload was built from a different engine commit than this cut declares.\n' +
        `  PAYLOAD.json sourceRef: ${packedRef ?? '(absent)'}\n` +
        `  --engine-source-ref:    ${engineSourceRef}\n` +
        `  payload: ${payloadRoot}`,
    )
  }
  /* RECOMPUTE WHAT THE PACKER RECORDED, over the tree that is actually on disk.
   * pack-capability-layer.mjs already writes fileCount, byteCount and
   * payloadSha256; until now nothing read them back, so a payload that lost a
   * file after it was written -- or gained one nobody declared -- still
   * presented a record that agreed with itself. Recomputed exactly the way the
   * packer builds it (sorted relative paths, each NUL-separated from its bytes,
   * PAYLOAD.json excluded because the digest predates the record), so a
   * disagreement is a real difference and not two conventions. */
  {
    /* FAIL CLOSED. A record missing these fields is not a record that says the
     * tree is fine -- it is a record that cannot be checked, and the packer has
     * always written both. Refuse rather than skip. */
    if (!Number.isInteger(packed?.fileCount) || typeof packed?.payloadSha256 !== 'string') {
      throw new Error(
        'the staged payload records no fileCount/payloadSha256, so nothing can confirm the tree matches its record.\n' +
          `  payload: ${payloadRoot}\n` +
          '  pack-capability-layer.mjs writes both; a payload without them was not produced by it.',
      )
    }
    const measured = measureTree(payloadRoot)
    const disagreements = []
    if (measured.fileCount !== packed.fileCount) {
      disagreements.push(`fileCount: PAYLOAD.json records ${packed.fileCount}, the staged tree has ${measured.fileCount}`)
    }
    if (measured.payloadSha256 !== packed.payloadSha256) {
      disagreements.push(`payloadSha256: PAYLOAD.json records ${packed.payloadSha256}, the staged tree hashes to ${measured.payloadSha256}`)
    }
    if (disagreements.length) {
      throw new Error(
        'the staged payload is not the tree its own record describes:\n  ' + disagreements.join('\n  ') +
          `\n  payload: ${payloadRoot}\n` +
          '  A file added or removed after packing changes both numbers, which is the point of checking them.',
      )
    }
  }

  const declaredHelpers = Array.isArray(manifest?.helperPrograms) ? manifest.helperPrograms : []
  const missing = declaredHelpers.filter((relative) => !exists(path.join(payloadRoot, ...String(relative).split('/'))))
  if (missing.length) {
    throw new Error(
      `tools/capability-manifest.json declares ${declaredHelpers.length} helper program(s) and the staged payload is missing ${missing.length}: ${missing.join(', ')}.\n` +
        '  A declared helper absent from the payload fails closed on the installed product -- every verb that spawns it throws.\n' +
        `  payload: ${payloadRoot}`,
    )
  }
  return { sourceRef: packedRef, helpers: declaredHelpers.length }
}

/* THE PAYLOAD-READING GATES MUST BE POINTED AT THE PAYLOAD THIS CUT PACKED.
 *
 * Four of these five variables fall back to <repo>/capability, which is the
 * packed payload, so they read it by accident. MC_TEST_CAPABILITY_PAYLOAD has
 * no fallback: tools/test/vault-manager-staged.test.mjs calls t.skip() naming
 * itself when it is unset. In a development run that is an honest "could not
 * look". In an ACCEPTANCE run it is a gate that reports nothing while the cut
 * seals green -- which is how a credential-remove that cannot execute on the
 * installed product would ship. So the cut binds all five explicitly and
 * refuses if any is unset, rather than resting on four accidental defaults. */
export const PAYLOAD_GATE_VARIABLES = Object.freeze([
  'MC_TEST_AGENT_API_PAYLOAD',
  'MC_TEST_AUDIT_PAYLOAD',
  'MC_TEST_CAPABILITY_PAYLOAD',
  'MC_TEST_LOCAL_MODELS_PAYLOAD',
  'MC_TEST_SETTINGS_PAYLOAD',
])

export function assertPayloadGatesBound(env, payloadRoot) {
  const unset = PAYLOAD_GATE_VARIABLES.filter((name) => typeof env?.[name] !== 'string' || !env[name].trim())
  if (unset.length) {
    throw new Error(
      `the acceptance ratchet would run with ${unset.length} payload gate(s) unbound: ${unset.join(', ')}.\n` +
        '  A payload gate that cannot find a payload reports a named skip, not a failure, so the cut would seal green over a gate that never looked.\n' +
        '  Refusing before the ratchet.',
    )
  }
  const wrong = PAYLOAD_GATE_VARIABLES.filter((name) => path.relative(env[name], payloadRoot) !== '')
  if (wrong.length) {
    throw new Error(
      `${wrong.join(', ')} do(es) not name this cut's packed payload (${payloadRoot}); a gate reading some other payload proves nothing about this candidate`,
    )
  }
  return payloadRoot
}

export function assertBuildProvenance(record, { buildRef, engineSourceRef }) {
  if (record?.schemaVersion !== 2 || record.dirty !== false || record.overridden !== false
      || record.ref !== buildRef || record.app?.ref !== buildRef || record.app?.dirty !== false
      || record.payload?.resolved !== true || record.payload?.ref !== engineSourceRef || record.payload?.dirty !== false
      || [record.dirtyFiles, record.app?.dirtyFiles, record.payload?.dirtyFiles].some(files => !Array.isArray(files) || files.length !== 0)) {
    throw new Error('build provenance must confirm the exact clean application build and engine source refs without an override')
  }
}

function printHelp() {
  console.log(`usage: node tools/release-packager/cut-release-candidate.mjs [options]

Produces a declarable ToolsEnabled release candidate end to end: version
bump -> isolated clean build -> staged artifact -> re-hashed -> declaration.

  --bump <patch|minor|major>   default: patch
  --version <X.Y.Z>            explicit version instead of --bump
  --release-platform <name>    repeat for every platform in this release (default: windows).
                              This cut measures only its Windows installer packet.
  --allow-same-version         allow the source's current version; verify unchanged committed
                                package/lock inputs and retain buildRef = sourceRef (loud, logged)
  --replace-staged             overwrite a candidate ALREADY staged at this version (loud, logged).
                                Without it, an occupied staging slot refuses before anything is built --
                                package.json's version does not move unless --advance-branch is used, so
                                back-to-back cuts from different tips otherwise compute the same number.
  --source-ref <ref>           exact application commit; defaults to HEAD only for a clean checkout
  --engine-source-ref <ref>    required exact 40-character engine commit staged into the installer
  --readiness-evidence <file>  optional existing trusted receipt for the exact installer and app/engine refs.
                                Otherwise run the registered qualifier after assembly, before tagging.
                                Missing required adapters block qualification before building.
  --readiness-output <file>    required when producing a receipt; optional no-clobber copy of supplied evidence.
                                Existing private parent outside candidate/source/build trees; no links.
                                Keep this raw file private and pass it as publisher --ReleaseReadinessPath.
  --readiness-context <file>   required for fresh qualification; paths-only JSON inside the private evidence directory.
                                Must name this cut's app worktree, exact unpacked stage and executing harness.
  --repo <path>                default: ${DEFAULT_REPO}
  --staging <dir>              default: ${portablePath(DEFAULT_STAGING_ROOT)}\\<version>  (or a scratch dir with --test)
  --build-dir <dir>            override the isolated worktree location
  --advance-branch             fast-forward the source branch to the build commit on success
  --keep-worktree              retain the worktree (qualified inputs are always retained)
  --seal-record-tool <path>    REQUIRED. Path to the release-controller repo's seal-cut-record.mjs. The cut
                                runs it with --record after the declaration and refuses to finish without the
                                record it writes. TOOLSENABLED_SEAL_RECORD_TOOL sets the same thing. There is
                                no default: that tool is checked out separately from this repository.
  --seal-control <file>         internal release-controller protocol; exact precreated JSON control
                                is required and every materialize/seal/consume ACK is bounded and fail-closed
  --test                       mark this as a test run: forces branch advance off, stages to a
                                scratch directory, and prints the declaration as TEST/NOT FOR TRANSFER
                                (still requires readiness; this flag does not bypass qualification)
  --other-candidate-root <dir> extra directory to scan for stray same-name installers (repeatable)
  --known-fix "<description>::<source-only|observed|both>[::evidence]"
                                declare a specific fix in this candidate and how it was verified (repeatable) --
                                renders in the declaration's "Known fixes" section instead of being silently omitted

Incremental gates (so one failing gate does not cost a full sealed cut):
  --gates-only <worktree>      build nothing: run the post-packaging gates against an EXISTING build worktree
                                (one left for postmortem, or --keep-worktree) in dist order, and write a
                                gate-evidence record beside its release/ output. Exit 1 on the first red gate.
  --gate <name>                with --gates-only, run only the named gate(s) (repeatable). Names:
                                ${POST_BUILD_GATES.map((entry) => entry.name).join(', ')}
  --gate-source <repo>         where the gate SCRIPTS come from (default: --repo). Lets a repaired harness
                                be run against an untouched artifact; the record names the harness commit.
  --evidence-out <file>        with --gates-only, where to write the record (default: release/.gate-evidence-<utc>.json)
  --resume-from <worktree>     resume a cut whose npm run dist failed AFTER packaging and sealing: reuse that
                                worktree's verified build ref and sealed artifact, re-verify the seal, re-run
                                every post-packaging gate, then stage, QA, tag and declare exactly as a fresh cut.
                                Refuses a dirty worktree, a missing seal, or invalid committed version inputs.
                                HEAD must be a version-only child of --source-ref, or that exact source with
                                --allow-same-version and verified unchanged package/lock versions.
                                --version must name the version that worktree built.
  --skip-verified <record>     with --resume-from, skip a gate ONLY if this evidence record shows the same gate,
                                by the same script bytes, from a clean harness checkout, exiting 0 against the
                                same seal and installer hashes (repeatable). Mismatches are logged and the gate
                                runs. The two seal verifications and strip-diagnostics can never be skipped.

Cutter attribution (required before a cut):
  Set TOOLSENABLED_CUT_MODEL and TOOLSENABLED_CUT_EMAIL together, plus a unique
  TOOLSENABLED_CUT_SESSION of 4-200 characters using only A-Z, a-z, 0-9, _ or -.
  The e-mail must be valid for the named cutter; this generic path never guesses a provider.
  That validated pair becomes the version-bump commit's author and committer,
  and Git adds the matching Signed-off-by trailer required by the DCO gate.
  TOOLSENABLED_CUT_LANE is optional. Claude's CLAUDE_MODEL_NAME and a valid
  CLAUDE_SESSION_ID remain a provider-specific fallback.
`)
}

const RELEASE_SEAL_SCHEMA = 'toolsenabled.release-seal-control'
const RELEASE_SEAL_PHASES = Object.freeze([
  'worktree-materialized',
  'capability-materialized',
  'package-transition-committed',
  'dependencies-materialized',
  'build-output-materialized',
  'staged-output-materialized',
])
const SHA256_HEX = /^[0-9A-F]{64}$/

function assertExactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value)
  if (actual.length !== expected.length || expected.some((name) => !Object.hasOwn(value, name))) {
    throw new Error(`${label} has an unexpected property set`)
  }
}

function sha256Upper(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase()
}

async function assertRegularNonLink(pathValue, label) {
  const info = await lstat(pathValue)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not one regular non-link file`)
  return info
}

/**
 * Load the optional r7 controller contract. Ordinary invocations do not pass
 * --seal-control and retain their historical behaviour. A requested protocol
 * never falls back: malformed, stale, wrong-build, or incomplete control is a
 * release failure before the isolated worktree is consumed.
 */
export async function loadReleaseSealControl(controlPath, { buildDirectory, sourceRef, cutSession }) {
  if (controlPath == null) return null
  if (typeof controlPath !== 'string' || !path.isAbsolute(controlPath)) {
    throw new Error('--seal-control requires one absolute path')
  }
  await assertRegularNonLink(controlPath, 'release seal control')
  const raw = await readFile(controlPath)
  if (raw.length === 0 || raw.length > 1024 * 1024) throw new Error('release seal control byte length is invalid')
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) throw new Error('release seal control must be BOM-free UTF-8')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  const parsed = JSON.parse(text)
  assertExactObjectKeys(parsed, ['schema', 'schemaVersion', 'cutSession', 'sourceRef', 'buildDirectory', 'timeoutMilliseconds', 'phases'], 'release seal control')
  if (parsed.schema !== RELEASE_SEAL_SCHEMA || parsed.schemaVersion !== 1) throw new Error('release seal control schema differs')
  if (parsed.cutSession !== cutSession || parsed.sourceRef !== sourceRef) throw new Error('release seal control provenance differs')
  if (path.resolve(parsed.buildDirectory) !== path.resolve(buildDirectory)) throw new Error('release seal control build directory differs')
  if (!Number.isSafeInteger(parsed.timeoutMilliseconds) || parsed.timeoutMilliseconds < 1_000 || parsed.timeoutMilliseconds > 600_000) {
    throw new Error('release seal control timeout is outside 1,000..600,000 ms')
  }
  if (!Array.isArray(parsed.phases) || parsed.phases.length !== RELEASE_SEAL_PHASES.length) {
    throw new Error('release seal control phase count differs')
  }
  const phases = []
  const seenPaths = new Set([path.resolve(controlPath).toLowerCase()])
  const seenAckHashes = new Set()
  for (let index = 0; index < RELEASE_SEAL_PHASES.length; index += 1) {
    const phase = parsed.phases[index]
    assertExactObjectKeys(phase, ['name', 'ackPath', 'ackBytes', 'ackSha256'], `release seal phase ${index}`)
    if (phase.name !== RELEASE_SEAL_PHASES[index]) throw new Error(`release seal phase order differs at ${index}`)
    if (typeof phase.ackPath !== 'string' || !path.isAbsolute(phase.ackPath)) throw new Error(`release seal phase ${phase.name} ACK path is not absolute`)
    if (!Number.isSafeInteger(phase.ackBytes) || phase.ackBytes < 32 || phase.ackBytes > 4096) throw new Error(`release seal phase ${phase.name} ACK byte length is invalid`)
    if (typeof phase.ackSha256 !== 'string' || !SHA256_HEX.test(phase.ackSha256)) throw new Error(`release seal phase ${phase.name} ACK hash is invalid`)
    if (seenAckHashes.has(phase.ackSha256)) throw new Error(`release seal phase ${phase.name} ACK capability duplicates another phase`)
    seenAckHashes.add(phase.ackSha256)
    const canonicalAck = path.resolve(phase.ackPath)
    const folded = canonicalAck.toLowerCase()
    if (seenPaths.has(folded)) throw new Error(`release seal phase ${phase.name} ACK path aliases another protocol file`)
    seenPaths.add(folded)
    const info = await assertRegularNonLink(canonicalAck, `release seal phase ${phase.name} ACK`)
    if (info.size !== 0) throw new Error(`release seal phase ${phase.name} ACK is stale before protocol start`)
    phases.push(Object.freeze({ ...phase, ackPath: canonicalAck }))
  }
  return { ...parsed, controlPath: path.resolve(controlPath), phases: Object.freeze(phases), nextPhase: 0 }
}

export async function waitForReleaseSealPhase(control, expectedName, { log = console.log } = {}) {
  if (control == null) return
  const index = control.nextPhase
  if (index >= control.phases.length || RELEASE_SEAL_PHASES[index] !== expectedName) {
    throw new Error(`release seal protocol phase order differs: expected ${RELEASE_SEAL_PHASES[index] ?? '(complete)'}, received ${expectedName}`)
  }
  const phase = control.phases[index]
  const before = await assertRegularNonLink(phase.ackPath, `release seal phase ${phase.name} ACK`)
  if (before.size !== 0) throw new Error(`release seal phase ${phase.name} ACK was populated before READY`)
  log(`[cut-release-candidate] SEAL READY phase=${phase.name} session=${control.cutSession} ackBytes=${phase.ackBytes} ackSha256=${phase.ackSha256}`)
  const deadline = Date.now() + control.timeoutMilliseconds
  while (true) {
    if (Date.now() > deadline) throw new Error(`release seal phase ${phase.name} ACK timed out`)
    await assertRegularNonLink(phase.ackPath, `release seal phase ${phase.name} ACK`)
    const bytes = await readFile(phase.ackPath)
    if (bytes.length > 0) {
      if (bytes.length !== phase.ackBytes || sha256Upper(bytes) !== phase.ackSha256) {
        throw new Error(`release seal phase ${phase.name} ACK is wrong or stale`)
      }
      control.nextPhase += 1
      log(`[cut-release-candidate] SEAL ACK phase=${phase.name} session=${control.cutSession}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function runCapturing(command, args, options) {
  return new Promise((resolve, reject) => {
    /* npm.cmd needs the Windows command shell. Node and Electron-facing tools
       do not, and must receive path arguments as argv rather than shell text:
       a legitimate profile/build path may contain metacharacters. */
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function readInstallerSignature(artifactPath) {
  if (process.platform !== 'win32') throw new Error('Windows installer signature status must be measured on Windows')
  const literal = "'" + artifactPath.replace(/'/g, "''") + "'"
  // An inherited PowerShell 7 module path can make the native Windows host
  // discover Security cmdlets it cannot load. Resolve its stock modules from
  // that host's own PSHOME, just as PE identity pins the native interpreter.
  const script = `$ErrorActionPreference='Stop'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); (Get-AuthenticodeSignature -LiteralPath ${literal}).Status.ToString()`
  const result = await runOwnedProcess(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 60_000 })
  if (result.code !== 0) throw new Error('The staged Windows installer signature could not be measured')
  return result.output.trim()
}

export async function stageWindowsReleaseNotes({ worktreePath, stagingDir, version, releasePlatforms = ['windows'], stagedExePath, stagedMeasured }, { readSignature = readInstallerSignature } = {}) {
  if (!sameBytes(stagedMeasured, await measureFile(stagedExePath))) throw new Error('Staged installer changed before release notes')
  const source = await readFile(path.join(worktreePath, 'docs', `RELEASE-NOTES-${version}.md`), 'utf8')
  assertSourceInstallPlan(source, releasePlatforms)
  const signature = await readSignature(stagedExePath)
  const signed = signature === 'NotSigned' ? 'Unsigned (no Authenticode signature)'
    : signature === 'Valid' ? 'Signed (Authenticode signature verified)' : null
  if (!signed) throw new Error('The staged installer signature was not valid or confirmed unsigned')
  const filename = path.basename(stagedExePath)
  if (filename !== `ToolsEnabled Setup ${version}.exe` || !/^[0-9a-f]{64}$/i.test(stagedMeasured?.sha256)
    || !Number.isSafeInteger(stagedMeasured?.bytes) || stagedMeasured.bytes <= 0) throw new Error('Measured Windows installer identity is required for release notes')
  const filled = source.replace(/^## Install[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m, section =>
    section.split(/(?=^### )/m).map(block => {
      if (!/^\|\s*Platform\s*\|\s*Windows\s*\|/im.test(block)) return block
      const values = { Package: filename, Bytes: String(stagedMeasured.bytes), 'SHA-256': stagedMeasured.sha256.toLowerCase(), Signed: signed }
      for (const [field, value] of Object.entries(values)) {
        const pattern = new RegExp('^\\|\\s*' + field + '\\s*\\|([^|]*)\\|[ \\t]*$', 'gm')
        if ([...block.matchAll(pattern)].length !== 1) throw new Error(`Windows install record needs exactly one ${field} row`)
        block = block.replace(pattern, `| ${field} | ${value} |`)
      }
      return block
    }).join(''))
  const packet = packetReleaseNotes(filled, { platforms: releasePlatforms, packetPlatform: 'windows' })
  const checked = checkReleaseNotes({ text: packet, expectedVersion: version, platforms: releasePlatforms, packetPlatform: 'windows' })
  if (checked.problems.length) throw new Error(`Windows packet release notes failed: ${checked.problems.join('; ')}`)
  if (!sameBytes(stagedMeasured, await measureFile(stagedExePath))) throw new Error('Staged installer changed while preparing release notes')
  const notesPath = path.join(stagingDir, `RELEASE-NOTES-${version}.md`)
  await writeFile(notesPath, packet, { mode: 0o644 })
  return { filename: path.basename(notesPath), platform: 'windows', releasePlatforms: [...releasePlatforms] }
}

function extractPipelineFacts(combinedOutput) {
  const verifyMatch = /Ran (\d+) tests: (\d+) pass, (\d+) fail \(suite exit (\d+)\)\./.exec(combinedOutput)
  const ownerDataMatch = /Scanned (\d+) files \((\d+) bytes\)\. Total matches: (\d+)\./.exec(combinedOutput)
  const smokeMatch = /\[smoke-packaged\] (PASS[^\n\r]*)/.exec(combinedOutput)

  return {
    verifySummary: verifyMatch
      ? `${verifyMatch[1]} tests, ${verifyMatch[2]} pass, ${verifyMatch[3]} fail (suite exit ${verifyMatch[4]}).`
      : null,
    checkNoOwnerData: ownerDataMatch
      ? { filesScanned: Number(ownerDataMatch[1]), bytesScanned: Number(ownerDataMatch[2]), totalMatches: Number(ownerDataMatch[3]) }
      : null,
    smokePackagedLine: smokeMatch ? smokeMatch[1].trim() : null,
  }
}

// Copy ONLY the private/ files that are genuinely untracked -- e.g. the
// per-builder identity profile private/owner-data-patterns.owner.json.
// private/fleet-profile.owner.json and private/research-queue.authored.json
// are, despite living under the same gitignored-looking directory, actually
// committed to this repo with their own reviewed content (confirmed with
// `git ls-files`; .gitignore's blanket `/private/` rule does not retroactively
// untrack a file already committed). A first real test run of this script
// copied the whole directory wholesale, overwrote those two tracked files
// with this machine's live copies, and correctly tripped the dirty-tree
// check it was supposed to sail through -- exactly the bug this function
// exists to prevent from recurring.
/* THE BUILD MUST NOT MEASURE, OR WRITE, THIS MACHINE'S LIVE STATE.
 *
 * `npm run dist` includes `verify:release` -> `tools/test-ratchet.mjs --strict`,
 * and that ratchet refuses ONLY when TOOLSENABLED_STATE_ROOT is unset. Set, it
 * measures -- and writes -- whatever root it names. The documented install
 * (docs/GOOGLE-SIGN-IN-SETUP.md) exports that variable user-wide, so handing the
 * dist child a bare { ...process.env } means a release cut on an installed
 * machine runs the whole suite against the operator's LIVE capability state.
 * The operator's shell is not the place to fix that: a cut that is only safe
 * when someone remembers to unset a variable is not safe.
 *
 * tools/test-strict.mjs already defines the scratch set this repo intends for
 * exactly this problem, and `npm run dist` does not call it. This mirrors that
 * set rather than inventing variables, with one addition named in the comment
 * below.
 */
/* UNIX SOCKETS UNDER TMPDIR HAVE A BYTE BUDGET. sockaddr_un.sun_path is 108
 * bytes including its terminator, so a socket path is at most 107 bytes; the
 * repository's isolated test runner refuses any socket path longer than 100
 * (its SOCKET_PATH_BUDGET) before an assertion runs, and tools/smoke-linux-sealed.mjs
 * reserves 80 bytes for what a suite appends under its temp root (a mkdtemp
 * directory plus a socket name). Measured on the 1.0.44 base-pair rehearsal:
 * TEMP=TMP=TMPDIR under the evidence output directory was 112 bytes, so every
 * suite that builds a socket under TMPDIR (10 engine + 1 app suites) was
 * refused or silently disabled under the cutter's environment -- two of them
 * with security assertions that were nominally covered and never ran. Windows
 * is unaffected (named pipes, short roots). Hence min(107, 100) - 80 = 20
 * bytes for TMPDIR on POSIX. /tmp/te-cut-XXXXXX is 18; an $XDG_RUNTIME_DIR
 * root (/run/user/1000/te-cut-XXXXXX = 28) does not fit and is not used. */
export const POSIX_SOCKET_PATH_BYTES = 107
export const RUNNER_SOCKET_PATH_BUDGET_BYTES = 100
export const SOCKET_SUFFIX_RESERVE_BYTES = 80
export const TMPDIR_BYTE_BUDGET = Math.min(POSIX_SOCKET_PATH_BYTES, RUNNER_SOCKET_PATH_BUDGET_BYTES) - SOCKET_SUFFIX_RESERVE_BYTES
export const SHORT_TEMP_BASE = '/tmp'

/** Pure. null when the temp root fits the socket budget on this platform,
 * otherwise the refusal sentence with the measured and allowed byte counts. */
export function tmpdirBudgetProblem(scratchTemp, platform = process.platform) {
  if (platform === 'win32') return null
  const bytes = Buffer.byteLength(String(scratchTemp), 'utf8')
  if (bytes <= TMPDIR_BYTE_BUDGET) return null
  return `TMPDIR ${scratchTemp} is ${bytes} bytes; the dist chain's temp root may be at most ${TMPDIR_BYTE_BUDGET} bytes on POSIX (sun_path ${POSIX_SOCKET_PATH_BYTES}, runner socket budget ${RUNNER_SOCKET_PATH_BUDGET_BYTES}, ${SOCKET_SUFFIX_RESERVE_BYTES} reserved for a suite's mkdtemp directory and socket name), or every suite that opens a Unix socket under it is refused before its assertions run`
}

/* A temp root that fits the socket budget: mkdtemp directly under /tmp on
 * POSIX. Refuses (and removes what it made) rather than hand back a root that
 * would disable suites. On Windows the caller keeps its existing temp root. */
export async function createShortTempRoot({ platform = process.platform, base = SHORT_TEMP_BASE } = {}) {
  if (platform === 'win32') throw new Error('createShortTempRoot is the POSIX socket-budget temp root; Windows keeps its existing temp root')
  const directory = await mkdtemp(path.join(base, 'te-cut-'))
  const problem = tmpdirBudgetProblem(directory, platform)
  if (problem) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(problem)
  }
  return { directory, bytes: Buffer.byteLength(directory, 'utf8'), budgetBytes: TMPDIR_BYTE_BUDGET }
}

/* WINDOWS TEMP ROOT LENGTH -- a DIFFERENT constraint from the POSIX socket
 * budget above, which is why it is a separate name and not a widened
 * TMPDIR_BYTE_BUDGET. Windows has no sun_path limit and tmpdirBudgetProblem()
 * is right to return null there.
 *
 * What the 1.0.45 cut of 2026-09-16 measured is this: tools/lib/sterile-launch.cjs
 * shortLinuxTmpdir() evaluates the LINUX launch rules on whatever host runs the
 * suite. On Windows there is no /run/user/<uid>, so it falls through to
 * os.tmpdir() and refuses STERILE_LAUNCH_NO_SHORT_TMPDIR unless that is at most
 * SHORT_LINUX_TMPDIR_MAX_BYTES. Under the cutter's own scratch temp it refused,
 * and six suites went red for the cutter's path length rather than for anything
 * in the product: home-screen-qa (5055), smoke-linux-sealed (11524, 11525),
 * sterile-launch-short-tmpdir (11697, 11698) and sterile-launch (11699).
 *
 * Measured, same bytes otherwise, only TEMP/TMP differing:
 *   TEMP = the cut's scratch temp  -> sterile-launch-short-tmpdir 8 tests, 6 pass, 2 FAIL
 *   TEMP = a 57-byte root          -> sterile-launch-short-tmpdir 8 tests, 8 pass, 0 fail
 *
 * The number is sterile-launch.cjs's own threshold, not one invented here; if
 * that file changes its rule this constant is the thing that must follow it. */
export const SHORT_LINUX_TMPDIR_MAX_BYTES = 60

/** Pure. null when a Windows temp root is short enough for the Linux
 * sterile-launch rule, otherwise the refusal sentence with both byte counts. */
export function windowsTempRootProblem(scratchTemp, platform = process.platform) {
  if (platform !== 'win32') return null
  const bytes = Buffer.byteLength(String(scratchTemp), 'utf8')
  if (bytes <= SHORT_LINUX_TMPDIR_MAX_BYTES) return null
  return `the cut's Windows temp root ${scratchTemp} is ${bytes} bytes; it may be at most ${SHORT_LINUX_TMPDIR_MAX_BYTES} bytes, because tools/lib/sterile-launch.cjs evaluates the Linux launch rules on this host too and refuses STERILE_LAUNCH_NO_SHORT_TMPDIR above that, so every sterile-launch suite fails for the cutter's path length instead of for the product`
}

/* A Windows temp root short enough for the rule above: mkdtemp directly under
 * the machine temp root, which is the shortest base already guaranteed to be
 * writable by this account. Verified after creation rather than assumed -- on
 * this machine the result is 57 bytes against a 60-byte limit, so a longer
 * account name genuinely does not fit and must refuse by name rather than
 * silently hand back a root that reds six suites. */
/* THE MACHINE TEMP ROOT, NOT THE ONE THIS CUT IS ALREADY REDIRECTING.
 *
 * os.tmpdir() reads TEMP/TMP/TMPDIR, and buildDistChainEnvironment() sets all
 * three to the cut's own scratchTemp. So everything the dist chain runs --
 * every suite, including tools/test/cut-windows-short-temp-root.test.mjs --
 * sees os.tmpdir() ALREADY INSIDE the cut's scratch. Deriving the base from it
 * there nests a second te-cut- directory inside the first and spends the budget
 * twice: measured on the 1.0.45 cut at 72 bytes against the 60-byte limit
 * (...\Temp\te-cut-<a>\te-cut-<b>), which refused and took the whole
 * strict run down at dist segment 0.
 *
 * USERPROFILE (os.homedir()) is the one thing this cut never rewrites, so
 * resolving from it makes the helper idempotent under its own environment:
 * inside a cut it yields the same root as outside one. Falls back to
 * os.tmpdir() when that per-user temp directory is absent, because a guessed
 * path that does not exist is worse than the ambient one. */
export function machineTempRoot({ platform = process.platform, home = os.homedir(), exists = existsSync } = {}) {
  /* BOTH PLATFORMS, because the nesting this prevents is not Windows-specific:
   * createCutScratch() puts its state directory under this root, and inside a
   * cut the ambient temp is already the cut's own scratch on Linux exactly as
   * it is on Windows. (scratchTemp itself was never affected on POSIX -- that
   * one comes from SHORT_TEMP_BASE, which is a literal, not os.tmpdir().) */
  if (platform !== 'win32') return SHORT_TEMP_BASE
  /* NO FALL BACK TO THE AMBIENT DIRECTORY. The ambient value inside a cut IS
   * the cut's own scratch, so falling back here silently reproduces the very
   * 72-byte nesting this function exists to prevent -- fail-open, and invisible
   * because the result still looks like a temp directory. Refuse by name. */
  if (typeof home !== 'string' || !home.trim()) {
    throw new Error(
      'the cut cannot locate the running account home directory (os.homedir()/USERPROFILE is empty), so it has no anchor for its scratch roots.\n' +
        '  Refusing rather than falling back to the ambient temp directory, which inside a cut is the cut\'s own scratch.',
    )
  }
  /* AND THE ANCHOR MUST BE INSIDE THE RUNNING ACCOUNT. USERPROFILE is an
   * ordinary environment variable, so a cut launched with it redirected would
   * anchor its scratch -- and every piece of state the suites write -- outside
   * this account, which is the boundary ACCOUNT-FENCE.md exists to hold.
   * Checked here rather than through the engine's assertAccountProfilePath:
   * that helper lives in the capability payload (reached as
   * planner.assertAccountProfilePath), and the release packager must work on a
   * checkout that has not packed one yet, so importing it would invert the
   * layering and refuse on a contributor clone. */
  const resolvedHome = path.resolve(home)
  const account = path.resolve(os.userInfo().homedir)
  if (path.relative(account, resolvedHome) !== '') {
    throw new Error(
      'the cut would anchor its scratch outside the account it is running as.\n' +
        `  os.homedir()/USERPROFILE: ${resolvedHome}\n` +
        `  account home:             ${account}\n` +
        '  Refusing before any scratch directory is created.',
    )
  }
  const perUser = path.join(resolvedHome, 'AppData', 'Local', 'Temp')
  if (!exists(perUser)) {
    throw new Error(
      `the per-user temp root does not exist: ${perUser}\n` +
        '  Refusing rather than falling back to the ambient temp directory, which inside a cut is the cut\'s own scratch and would nest a second root inside it.',
    )
  }
  return perUser
}

export async function createShortWindowsTempRoot({ platform = process.platform, base = undefined } = {}) {
  // An explicit base still wins, so the refusal path stays deliberately probeable.
  base = base ?? machineTempRoot({ platform })
  if (platform !== 'win32') throw new Error('createShortWindowsTempRoot is the Windows temp root; POSIX uses createShortTempRoot')
  const directory = await mkdtemp(path.join(base, 'te-cut-'))
  const problem = windowsTempRootProblem(directory, platform)
  if (problem) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(problem)
  }
  return { directory, bytes: Buffer.byteLength(directory, 'utf8'), budgetBytes: SHORT_LINUX_TMPDIR_MAX_BYTES }
}

/* EVERY capability path override, not the two the cut happened to remember.
 *
 * shell/capability-path-environment.cjs already enumerates all 31 process-level
 * overrides whose value selects a filesystem root, and its own regression test
 * cross-checks that list against capability/src so a new persistence seam
 * cannot arrive without joining it. That list is the authority here; a hand
 * written one in this file would go stale the first time a seam is added.
 *
 * WHY THE CUT NEEDS IT. Measured 2026-09-17: the shell of every agent circle on
 * this box arrives carrying TOOLSENABLED_STATE_ROOT and TOOLSENABLED_VAULT_PATH
 * already pointing into the owner's LIVE installation profile. The cut
 * overwrote exactly those two and inherited the other 29 untouched. A suite
 * reading any of them reaches the owner's real state -- the 2026-09-10
 * incident recorded in tools/test-ratchet.mjs is a measurement engine writing
 * four real entries into the LIVE ledger. Scrub first, then set this cut's own,
 * so the set the cut does not manage is empty rather than inherited. */
export function scrubInheritedCapabilityPaths(env, { names = CAPABILITY_PATH_OVERRIDE_ENVIRONMENT_NAMES } = {}) {
  const removed = []
  for (const name of names) if (typeof env[name] === 'string' && env[name]) { removed.push(name); delete env[name] }
  return removed
}

/* Nothing the dist chain runs may resolve to the owner's installation, and
 * nothing may sit outside this cut's scratch. Refuses by name, with the value,
 * because "some variable pointed somewhere" is not actionable. */
export function assertCutEnvironmentIsolated(env, {
  scratchState,
  scratchTemp,
  /* Two categories, and the second cannot be derived. The capability overrides
   * come from the shipped module; APPDATA and LOCALAPPDATA are DECLARED,
   * because capability-path-environment.test.mjs collects only names ending
   * _PATH, _FILE, _DIR, _ROOT or _DB -- right for capability overrides, wrong
   * by construction for OS profile roots. Worker 89 drove this function with
   * APPDATA at the live roaming profile and LOCALAPPDATA at the live local
   * profile and it ACCEPTED both, because neither was in the derived list and
   * neither sits under the installation directory, so the live-path rule could
   * not see them either. They are real sinks: machine-record.js reads and
   * writes under %LOCALAPPDATA%\ToolsEnabled, runtime.js reads both, and eight
   * shell modules read APPDATA or Electron userData, which on Windows is the
   * roaming profile. */
  names = requiredNames().names,
} = {}) {
  const roots = [scratchState, scratchTemp].filter(Boolean).map((root) => path.resolve(root))
  const inside = (value) => roots.some((root) => {
    const relative = path.relative(root, value)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
  /* The account identity names are exempt from CONTAINMENT and not from the
   * live rule, exactly as tools/lib/scratch-fence.mjs holds them -- the product
   * measurably only reads USERPROFILE and HOME, and they legitimately name the
   * account home. Taken from the helper rather than restated, so the two cannot
   * drift into disagreeing about the same rule. */
  const containmentExempt = new Set(ACCOUNT_IDENTITY_NAMES)
  const escaped = []
  for (const name of names) {
    const value = env[name]
    if (typeof value !== 'string' || !value) continue
    const resolved = path.resolve(value)
    if (/[\\/]ToolsEnabled-Live[\\/]/i.test(`${resolved}${path.sep}`)) escaped.push(`${name} resolves inside the owner's live installation: ${resolved}`)
    else if (!containmentExempt.has(name) && !inside(resolved)) escaped.push(`${name} resolves outside this cut's scratch: ${resolved}`)
  }
  if (escaped.length) {
    throw new Error(
      `the dist chain environment would let ${escaped.length} capability path(s) reach state this cut does not own:\n  ` +
        escaped.join('\n  ') +
        "\n  Refusing before the ratchet: a suite that writes the owner's real vault or ledger has already done the damage by the time it reports.",
    )
  }
  return env
}

/* THE OWNER'S WORKSPACE, AS BARE DIRECTORY NAMES, DERIVED BY THE CUT ITSELF.
 *
 * tools/check-no-owner-data.mjs turns these names into spellings and refuses a
 * payload that carries one. Inside the cut every state root has been re-pointed
 * into scratch, so the guard cannot read the workspace from its own environment;
 * the cutter must hand the names across. T334 review finding 2: the first
 * version read only the parent shell's OWNED_NAMES, so a cut started from a
 * shell without them scanned without the workspace and reported clean. Now the
 * names come from what the cutter itself knows, in this order, each source
 * named in the result so a refusal can say what was read:
 *
 *   - the repository the cut is made from (`sourceRepo`): the directories
 *     between the builder's home and the checkout are the workspace;
 *   - the engine checkout the cut binds (`canonicalRoot`), the same way;
 *   - the live state roots the parent shell carries (OWNED_NAMES), when it does.
 *
 * The rules are imported from the guard, not restated, so "a name the cutter
 * produced" and "a name the guard would use" are one definition:
 * segmentsBelowHome stops at the product's own segments, and
 * isUsableWorkspaceSegment drops well-known folders and short names. When the
 * result is empty the cut REFUSES by name (WORKSPACE_SEGMENTS_UNRESOLVED_CODE)
 * rather than building a dist environment whose owner-data scan cannot be
 * shown to cover the owner's folder. Names only, never paths: nothing in the
 * fenced environment may resolve to the installation. */
export function resolveCutWorkspaceSegments(processEnv, {
  sourceRepo = null, canonicalRoot = null, homedir = () => os.homedir(), platform = process.platform,
} = {}) {
  let home
  try { home = homedir() } catch (error) {
    throw new Error(`${WORKSPACE_SEGMENTS_UNRESOLVED_CODE}: os.homedir() failed (${error.message}), so no workspace directory name can be derived for the owner-data scan inside the cut.`)
  }
  if (typeof home !== 'string' || !home.trim()) {
    throw new Error(`${WORKSPACE_SEGMENTS_UNRESOLVED_CODE}: os.homedir() returned nothing, so no workspace directory name can be derived for the owner-data scan inside the cut.`)
  }
  const seen = new Set()
  const names = []
  const contributed = []
  const read = []
  const take = (target, source) => {
    if (typeof target !== 'string' || !target.trim()) return
    read.push(source)
    let added = false
    for (const segment of segmentsBelowHome(target, home, { platform })) {
      if (!isUsableWorkspaceSegment(segment)) continue
      const key = segment.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      names.push(segment)
      added = true
    }
    if (added) contributed.push(source)
  }
  // The checkouts' own directory names ("app", "engine") are the product's, not
  // the owner's; the workspace is what sits ABOVE them, so each is taken from
  // its parent -- the same choice the guard makes for its own repository.
  take(typeof sourceRepo === 'string' && sourceRepo.trim() ? path.dirname(path.resolve(sourceRepo)) : null, 'source repository')
  take(typeof canonicalRoot === 'string' && canonicalRoot.trim() ? path.dirname(path.resolve(canonicalRoot)) : null, 'engine checkout')
  for (const name of OWNED_NAMES) take(processEnv[name], `env:${name}`)
  if (names.length === 0) {
    throw new Error(
      `${WORKSPACE_SEGMENTS_UNRESOLVED_CODE}: no workspace directory name could be derived for the owner-data scan `
      + `inside the cut (read: ${read.length ? read.join(', ') : 'nothing -- no source repository, engine checkout or live state root was given'}; `
      + `home: ${path.basename(path.resolve(home)) ? 'resolved' : 'unresolved'}). Every candidate was outside the home directory, `
      + 'a well-known operating-system folder, or shorter than the pattern floor. Run the cut from the checkout that sits in the '
      + `owner's workspace, or export one of ${OWNED_NAMES.join(', ')} pointing into it. A cut is not made with a scan that cannot say what it protects.`,
    )
  }
  return { names, contributed, read }
}

/* Kept for callers that only want the names; same derivation, same refusal. */
export function liveWorkspaceSegments(processEnv, options = {}) {
  return resolveCutWorkspaceSegments(processEnv, options).names
}

export function buildDistChainEnvironment(processEnv, {
  scratchState, scratchTemp, canonicalRoot, engineSourceRef, payloadRoot, platform = process.platform,
  sourceRepo = null, workspaceSegments = undefined, homedir = undefined,
}) {
  if (!scratchState || !scratchTemp) throw new Error('the dist-chain environment needs the cut\'s own scratch state and temp directories')
  const budgetProblem = tmpdirBudgetProblem(scratchTemp, platform)
  if (budgetProblem) throw new Error(budgetProblem)
  const env = { ...processEnv }

  // FIRST, drop every inherited capability path override, so the ones this
  // function does not explicitly set are absent rather than the owner's.
  scrubInheritedCapabilityPaths(env)

  // Pre-existing guarantees, unchanged.
  delete env.MC_ALLOW_DIRTY_BUILD
  if (engineSourceRef) env.TOOLSENABLED_SOURCE_REF = engineSourceRef

  // T334: tools/check-no-owner-data.mjs derives the owner's workspace spellings
  // from the state roots it can see, and below this line every one of them is
  // scratch. The cut hands the workspace directory NAMES across itself -- from
  // the repository it cuts, the engine it binds and the live roots the shell
  // carries (resolveCutWorkspaceSegments) -- as a JSON array under a name the
  // fence does not own. Names only, never paths, so nothing in the fenced
  // environment resolves to the installation. A caller that already resolved
  // them passes `workspaceSegments`; otherwise they are resolved here, and a
  // cut that can produce none REFUSES by name instead of building an
  // environment whose owner-data scan cannot say what it protects. The
  // cut-context marker tells the guard that the hand-over is mandatory, so a
  // future caller that drops it is refused by the guard rather than passed.
  const resolvedSegments = Array.isArray(workspaceSegments)
    ? workspaceSegments
    : resolveCutWorkspaceSegments(processEnv, { sourceRepo, canonicalRoot, platform, ...(homedir ? { homedir } : {}) }).names
  if (resolvedSegments.length === 0 || resolvedSegments.some((name) => typeof name !== 'string' || !name.trim() || /[\\/]/.test(name))) {
    throw new Error(`${WORKSPACE_SEGMENTS_UNRESOLVED_CODE}: the dist-chain environment was handed no usable workspace directory names (bare names only, at least one).`)
  }
  env[WORKSPACE_SEGMENTS_VARIABLE] = JSON.stringify(resolvedSegments)
  env[CUT_CONTEXT_VARIABLE] = '1'

  // The scratch set, mirroring tools/test-strict.mjs.
  env.TOOLSENABLED_TEST_STRICT = '1'
  env.TOOLSENABLED_STATE_ROOT = scratchState
  env.MC_TEST_STATE_ROOT = scratchState
  env.TEMP = scratchTemp
  env.TMP = scratchTemp
  // TMPDIR is the one addition: test-strict.mjs sets only TEMP/TMP, which is
  // enough on Windows, but Node resolves os.tmpdir() from TMPDIR on POSIX. A
  // POSIX child would otherwise still write outside the scratch directory.
  env.TMPDIR = scratchTemp

  // Every payload-reading gate reads THIS cut's payload, by name, rather than
  // the four accidental <repo>/capability fallbacks and one silent skip.
  if (payloadRoot) for (const name of PAYLOAD_GATE_VARIABLES) env[name] = payloadRoot

  /* A pwsh 7 PSModulePath MUST NOT REACH Windows PowerShell 5.1 CHILDREN.
   *
   * The cut is launched from pwsh 7, which exports a PSModulePath whose
   * PowerShell 7 module directories precede the 5.1 ones. node inherits that
   * value verbatim and hands it to every powershell.exe 5.1 the suites spawn;
   * 5.1 finds the Core build of Microsoft.PowerShell.Security first and refuses
   * to load it. Every cmdlet in that module then fails closed -- Get-Acl, which
   * shell/tree-node-command.cjs runWindowsAclPass needs, ConvertTo-SecureString,
   * which the native account-authority proof needs, and the cmdlets the
   * PowerShell vault backend needs, which is why the audit custody suites
   * reported AUDIT_REKEY_CUSTODY_UNAVAILABLE.
   *
   * Measured on the 1.0.45 cut of 2026-09-17: 22 of its 40 strict reds carried
   * one of those three signatures across four suites. Control, same pwsh
   * parent, same scratch, only this value differing -- inherited: 45 tests, 23
   * pass, 22 FAIL; emptied: 45 tests, 45 pass, 0 fail.
   *
   * The intermediate node process is load-bearing: pwsh launching
   * powershell.exe DIRECTLY is fine, because 5.1 repairs the path itself. The
   * cut always has node in between and never gets that repair.
   *
   * Emptied rather than rewritten, so each PowerShell computes its own correct
   * default -- right for 5.1 and 7 children, and a no-op on Linux. Same remedy
   * the repository already applies at tools/vault-names-live-qa.mjs and the two
   * electron diff helpers, for the reason written at verify-candidate.ps1. */
  if (platform === 'win32') env.PSModulePath = ''

  /* THE NODE LOADER VARIABLES DECIDE WHICH MODULES THE RUN LOADS. A NODE_PATH
   * pointed into the installation makes the dist chain resolve the
   * INSTALLATION'S modules while every path-writing check stays green, and
   * NODE_OPTIONS can do the same through --require preloads. Nothing is written
   * through either, so no write-shaped check sees them. Emptied for the same
   * reason PSModulePath is: each child then computes its own correct default,
   * and there is no scratch path for them to be contained inside. */
  for (const name of NODE_LOADER_NAMES) env[name] = ''
  // The vault path is the other inherited pointer: an agent shell on a machine
  // that runs this product carries TOOLSENABLED_VAULT_PATH into the running
  // installation's profile, and the engine resolves it before the state root.
  // Name the scratch vault, in the layout the running product uses, so the
  // strict ratchet's scratch check and the engine agree on where it is.
  env.TOOLSENABLED_VAULT_PATH = path.join(scratchState, 'vault', 'secrets.json')

  /* BOTH WINDOWS PROFILE DIRECTORIES, not just the local one. The screen
   * control audit sink resolves through app.getPath('userData'), which on
   * Windows is APPDATA -- the ROAMING profile -- so redirecting LOCALAPPDATA
   * alone leaves that write on the owner's real profile. Neither is a
   * TOOLSENABLED_* name, so neither is in the capability-path override list
   * scrubbed above; they have to be named here. */
  if (platform === 'win32') {
    env.APPDATA = path.join(scratchState, 'Roaming')
    env.LOCALAPPDATA = path.join(scratchState, 'LocalAppData')
  }

  /* The process-wide store where approval grants are minted and consumed. A run
   * that leaves this pointed at the installation mints into the owner's live
   * store with the fence otherwise green. */
  env.TOOLSENABLED_STATE_PATH = path.join(scratchState, 'state', 'state.sqlite3')

  /* PROVIDER ACCOUNT HOMES. Measured on this box: CLAUDE_CONFIG_DIR is set in
   * every agent shell to the owner's live account home under
   * ToolsEnabled-Live/services/account-homes/claude/<signed-in account> -- the
   * value names the account. account-registry.cjs, provider-cli-presence.cjs
   * and provider-login.cjs read these. Re-pointed per provider rather than
   * deleted: a suite that finds the variable absent may fall back to the
   * provider CLI's own default location, which is also outside this cut. */
  for (const name of PROVIDER_HOME_NAMES) {
    env[name] = path.join(scratchState, 'provider-homes', name.toLowerCase())
  }
  // Python under the suite (src/benchmark drivers run python3) writes __pycache__
  // beside the source it imports -- git-ignored, so the tree reads clean, but
  // test-ratchet.mjs fingerprints ignored files too and refused to rule on the
  // 1.0.44 candidate ("src digest changed") for exactly those .pyc files.
  // Bytecode belongs with the cut's temp root, not in the source tree.
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTHONPYCACHEPREFIX = path.join(scratchTemp, 'pycache')
  // NATIVE WINDOWS QUALIFICATION NEEDS AN APPROVED SCRATCH ROOT (ledger T146).
  // tools/test/audit-repair-native.test.mjs refuses to run its native custody
  // cases on Windows without an explicit MC_SETTINGS_NATIVE_SCRATCH_ROOT, by
  // name: "Native Windows qualification requires an explicit approved
  // MC_SETTINGS_NATIVE_SCRATCH_ROOT." The 1.0.45 cut of 2026-09-16 hit exactly
  // that sentence 14 times inside verify:release, and the strict ratchet
  // rightly refused. The root is the cut's own temp directory, which
  // createCutScratch() creates link-free under the machine's temp root; the
  // suite still checks canonical spelling and ancestors itself.
  env.MC_SETTINGS_NATIVE_SCRATCH_ROOT = nativeQualificationRoot(scratchTemp)

  // The engine this cut is staging -- never the one this machine happens to
  // have checked out. With nothing to bind it to, the variable is removed so
  // the suite's own guard fires, rather than silently measuring the wrong tree.
  /* T277: tools/test/paste-picture-reaches-the-turn.test.mjs asserted at IMPORT
   * that one of these named the engine checkout. Neither was set, so node:test
   * emitted a FILE-level result spliced into the top-level counter and the
   * ratchet refused a verdict for the whole run -- exit 2, measured nothing,
   * after 14151 tests. The cut already knows the engine it packs from; both
   * names now carry it. */
  if (canonicalRoot) env.MC_T18_ENGINE_ROOT = canonicalRoot
  else delete env.MC_T18_ENGINE_ROOT
  if (canonicalRoot) env.MC_CANONICAL_ROOT = canonicalRoot
  else delete env.MC_CANONICAL_ROOT

  return env
}

/* The scratch directory belongs to the cut, not to the machine. Created the
 * same way tools/test-strict.mjs creates its own, and deliberately OUTSIDE the
 * build worktree: an untracked directory inside it would fail the clean-tree
 * gate the cut runs against itself. */
/* Where the native custody suites may write on Windows: one directory under
 * the cut's temp root, so it lives and dies with the cut. Derived from the temp
 * root rather than stored, so buildDistChainEnvironment() stays a pure function
 * of the scratch set it is handed. */
export function nativeQualificationRoot(scratchTemp) {
  return path.join(scratchTemp, 'native-qualification')
}

export async function createCutScratch(version, { platform = process.platform } = {}) {
  // Same reason as machineTempRoot(): inside a cut os.tmpdir() is already this
  // cut's scratchTemp, so anchoring here too keeps scratch roots from nesting.
  const scratch = await mkdtemp(path.join(machineTempRoot({ platform }), `release-cut-scratch-${version}-`))
  const scratchState = path.join(scratch, 'state')
  // Both platforms get a SHORT temp root, for two different reasons.
  // POSIX: under /tmp so Unix sockets built under TMPDIR fit the socket budget
  // (TMPDIR_BYTE_BUDGET). Windows: under the machine temp root so it fits
  // sterile-launch.cjs's Linux rule (SHORT_LINUX_TMPDIR_MAX_BYTES), which that
  // file evaluates on this host too. Windows used to keep `<scratch>/temp`
  // beside state; the 1.0.45 cut measured that at 83 bytes and six suites went
  // red for the path length rather than for the product.
  const scratchTemp = platform === 'win32'
    ? (await createShortWindowsTempRoot({ platform })).directory
    : (await createShortTempRoot({ platform })).directory
  await mkdir(scratchState, { recursive: true })
  await mkdir(scratchTemp, { recursive: true })
  // The native custody suites lstat every ancestor and realpath the root
  // (tools/test/audit-repair-native.test.mjs temporaryRoot), so it must exist
  // before the dist chain starts, not be created by the first case.
  await mkdir(nativeQualificationRoot(scratchTemp), { recursive: true })
  /* The redirected Windows profile roots must EXIST before the dist chain
   * starts. machine-record.js writes the machine record under
   * %LOCALAPPDATA%ToolsEnabled and Electron resolves userData from APPDATA at
   * launch; a redirect at a directory that is not there is how a process
   * decides to fall back to the real profile. */
  if (platform === 'win32') {
    await mkdir(path.join(scratchState, 'Roaming'), { recursive: true })
    await mkdir(path.join(scratchState, 'LocalAppData'), { recursive: true })
  }
  return { scratch, scratchState, scratchTemp }
}

/* Which engine checkout the cut is measuring, resolved exactly the way
 * tools/pack-capability-layer.mjs resolves it (TOOLSENABLED_SOURCE, then
 * private/capability-source.owner.json), so there is one convention and not
 * two. Returns null when it cannot be established; the caller must not guess. */
export async function resolveCutCanonicalRoot(repo, processEnv = process.env) {
  if (processEnv.TOOLSENABLED_SOURCE) return path.resolve(processEnv.TOOLSENABLED_SOURCE)
  const configPath = path.join(repo, 'private', 'capability-source.owner.json')
  if (!existsSync(configPath)) return null
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'))
    return typeof parsed?.path === 'string' && parsed.path.trim() ? path.resolve(parsed.path) : null
  } catch { return null }
}

/* What goes into the gate record: the isolation decision, by name and value,
 * and nothing else. The full environment is never written to an artifact --
 * it carries the operator's tokens. */
export function describeDistChainEnvironment(env, { scratch }) {
  return {
    scratch,
    stateRoot: env.TOOLSENABLED_STATE_ROOT ?? null,
    testStateRoot: env.MC_TEST_STATE_ROOT ?? null,
    temp: env.TEMP ?? null,
    tmpdir: env.TMPDIR ?? null,
    tempBytes: env.TMPDIR ? Buffer.byteLength(env.TMPDIR, 'utf8') : null,
    tempBudgetBytes: TMPDIR_BYTE_BUDGET,
    canonicalRoot: env.MC_CANONICAL_ROOT ?? null,
    testStrict: env.TOOLSENABLED_TEST_STRICT ?? null,
    inheritedStateRoot: false,
  }
}

export async function copyPrivateInputs(repo, worktreePath, { log = console.log, sourcePrivate = null, mode = null } = {}) {
  // sourcePrivate: an explicit staging directory instead of <repo>/private (the
  // Linux cutter takes --private-inputs). mode: applied to every landed copy
  // when given (0o600 on Linux, where the worktree is world-readable by default).
  sourcePrivate = sourcePrivate ?? path.join(repo, 'private')
  const targetPrivate = path.join(worktreePath, 'private')
  if (!existsSync(sourcePrivate)) return { copied: [], skippedTracked: [] }

  const tracked = new Set(
    listTrackedFiles(worktreePath, 'private').map((relPath) => relPath.split('/').join(path.sep)),
  )

  const entries = await readdir(sourcePrivate, { withFileTypes: true, recursive: true })
  const copied = []
  const skippedTracked = []
  // Owner rules D3/A3: these inputs must be provably the ones the operator
  // staged, and must never reach the artifact. Their DIGESTS are recorded so a
  // reader can bind the cut to them; their CONTENTS are never read into any
  // record -- this is the operator's identity profile.
  const digests = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const entryDir = entry.parentPath ?? entry.path
    const sourceFile = path.join(entryDir, entry.name)
    const relativeFromPrivate = path.relative(sourcePrivate, sourceFile)
    const relativeFromRepo = path.join('private', relativeFromPrivate)

    if (tracked.has(relativeFromRepo)) {
      skippedTracked.push(relativeFromPrivate)
      continue
    }

    const targetFile = path.join(targetPrivate, relativeFromPrivate)
    await mkdir(path.dirname(targetFile), { recursive: true })
    await cp(sourceFile, targetFile)
    if (mode !== null) await chmod(targetFile, mode)
    copied.push(relativeFromPrivate)
    const measured = await measureFile(targetFile)
    digests.push({
      file: relativeFromPrivate.split(path.sep).join('/'),
      bytes: measured.bytes,
      sha256: measured.sha256,
    })
  }

  log(`[private-inputs] copied (untracked, per-builder): ${copied.join(', ') || '(none)'}`)
  if (skippedTracked.length > 0) {
    log(`[private-inputs] left as git-tracked content, NOT overwritten with the local copy: ${skippedTracked.join(', ')}`)
  }
  for (const entry of digests) log(`[private-inputs]   ${entry.file}  ${entry.bytes} bytes  sha256 ${entry.sha256}`)
  return { copied, skippedTracked, digests }
}

/* The three candidate documents, written as a set or not at all.
 *
 * EXPORTED BECAUSE THE WIRING IS THE THING THAT BREAKS. The redaction and the
 * scan both had unit tests while this sequence lived inline in main(), and a
 * planted mutant that serialised the RAW facts into declaration-facts.json
 * survived the whole suite -- reintroducing, in one line, exactly the leak in the
 * shipped 1.0.2 and 1.0.4 files. Nothing could reach it: main() runs a build.
 * Pulling the four steps out makes the order testable, and the order is the
 * property: redact once, scan every document, then write.
 *
 * The facts file is scanned before the declaration is written so that a failure
 * cannot leave part of the matched set sitting in the transfer directory --
 * a lone DECLARATION.md next to an installer reads like a complete, declared
 * candidate.
 */
export async function writeDeclarationArtifacts(stagingDir, measuredFacts, { test = false } = {}) {
  const { declarableFacts, downloadManifest, declarationPath, factsPath, manifestPath,
    factsJson, manifestJson, declarationMarkdown } = prepareDeclarationArtifacts(stagingDir, measuredFacts, { test })
  await assertReleaseReadiness(measuredFacts.readiness, {
    product: 'toolsenabled', artifact: { sha256: measuredFacts.candidate?.sha256, bytes: measuredFacts.candidate?.bytes },
    sourceRefs: { app: measuredFacts.buildRef, engine: measuredFacts.engineSourceRef },
    target: WINDOWS_READINESS_TARGET,
  })
  const temporarySuffix = `.cut-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  const temporaryDeclarationPath = `${declarationPath}${temporarySuffix}`
  const temporaryFactsPath = `${factsPath}${temporarySuffix}`
  const temporaryManifestPath = `${manifestPath}${temporarySuffix}`
  const backupDeclarationPath = `${declarationPath}${temporarySuffix}.bak`
  const backupFactsPath = `${factsPath}${temporarySuffix}.bak`
  const backupManifestPath = `${manifestPath}${temporarySuffix}.bak`

  // Never publish one document while the others are still being generated. In
  // particular, writeDeclaration() used to write DECLARATION.md directly and
  // a later writeFile() failure left that declaration beside the installer
  // with no facts file. The staging scanner quite correctly treats that as an
  // occupied, broken candidate, so a transient disk error permanently turned
  // a cut into something that looked declared but could not be verified.
  let documentsCommitted = false
  let declarationBackedUp = false
  let factsBackedUp = false
  let manifestBackedUp = false
  let declarationPublished = false
  let factsPublished = false
  let manifestPublished = false
  try {
    await writeFile(temporaryDeclarationPath, declarationMarkdown, 'utf8')
    await writeFile(temporaryFactsPath, factsJson, 'utf8')
    await writeFile(temporaryManifestPath, manifestJson, 'utf8')

    // --replace-staged deliberately permits existing documents. Move them out
    // of the way rather than destroying them until the replacement set is
    // complete, so an I/O failure can restore the candidate it interrupted.
    if (existsSync(declarationPath)) {
      await rename(declarationPath, backupDeclarationPath)
      declarationBackedUp = true
    }
    if (existsSync(factsPath)) {
      await rename(factsPath, backupFactsPath)
      factsBackedUp = true
    }
    if (existsSync(manifestPath)) {
      await rename(manifestPath, backupManifestPath)
      manifestBackedUp = true
    }

    // Publish the human-facing declaration last. If that rename fails, roll
    // back the earlier renames so the promised set is still all-or-nothing.
    await rename(temporaryFactsPath, factsPath)
    factsPublished = true
    await rename(temporaryManifestPath, manifestPath)
    manifestPublished = true
    await rename(temporaryDeclarationPath, declarationPath)
    declarationPublished = true
    documentsCommitted = true
  } catch (error) {
    if (declarationPublished) await rm(declarationPath, { force: true })
    if (factsPublished) await rm(factsPath, { force: true })
    if (manifestPublished) await rm(manifestPath, { force: true })
    if (declarationBackedUp) await rename(backupDeclarationPath, declarationPath)
    if (factsBackedUp) await rename(backupFactsPath, factsPath)
    if (manifestBackedUp) await rename(backupManifestPath, manifestPath)
    throw error
  } finally {
    await rm(temporaryDeclarationPath, { force: true })
    await rm(temporaryFactsPath, { force: true })
    await rm(temporaryManifestPath, { force: true })
    // If restoration itself fails, leave backups for recovery. A finally
    // block must never erase the only surviving previous document set.
    if (documentsCommitted) {
      await rm(backupDeclarationPath, { force: true })
      await rm(backupFactsPath, { force: true })
      await rm(backupManifestPath, { force: true })
    }
  }

  return { declarationPath, factsPath, manifestPath, declarableFacts, downloadManifest }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  if (args.gatesOnly) {
    console.log('[scope] Selected gate diagnostics only; a green run is NOT full release qualification.')
    await runGatesOnlyMode(args)
    return
  }

  const repo = path.resolve(args.repo ?? DEFAULT_REPO)
  const resumeFrom = args.resumeFrom ? path.resolve(args.resumeFrom) : null
  // Refuse a quarantined worktree before Git/verifier children or staging
  // writes. Changing the evidence file cannot make an uncertain run safe.
  if (resumeFrom) assertGateWorktreeAvailable(resumeFrom)
  const { cutterIdentity, cutterSession, cutterAttribution } = assertCutterAttribution()
  assertCutQualification(args.readinessEvidence, args.readinessOutput, args.readinessContext, WINDOWS_READINESS_TARGET)
  // A supplied receipt is only fully checked after the build, against the
  // measured installer. Its executor identities need no installer, so refuse a
  // receipt naming an unregistered adapter here rather than after a 30-minute
  // dist run. Passing this is not qualification; readReleaseReadiness below is.
  if (args.readinessEvidence) assertReceiptNamesRegisteredAdapters(args.readinessEvidence, 'toolsenabled', WINDOWS_READINESS_TARGET)
  /* T155: the seal step is the last thing a cut does, so its only input --
   * where the tool is -- is resolved first. Refusing after a 20-minute build
   * because nobody said where seal-cut-record.mjs lives is the same waste T154
   * closes for the qualification context. */
  const sealRecordTool = resolveSealRecordTool(args.sealRecordTool)
  console.log(`[cut-release-candidate] seal record tool: ${sealRecordTool}`)
  const keepWorktree = args.keepWorktree || Boolean(resumeFrom)
  const sourceRef = resolveExactAppSourceRef(repo, args.sourceRef)
  const engineSourceRef = args.engineSourceRef
  const branch = currentBranch(repo)

  console.log(`[cut-release-candidate] repo=${repo} sourceRef=${sourceRef} branch=${branch} test=${args.test}`)

  if (typeof engineSourceRef !== 'string' || !/^[0-9a-f]{40}$/.test(engineSourceRef)) {
    throw new Error('--engine-source-ref must name one exact 40-character lowercase engine commit id')
  }
  console.log(`[cut-release-candidate] engineSourceRef=${engineSourceRef}`)

  // --- version -------------------------------------------------------------
  const packageJsonAtRef = JSON.parse(showFile(repo, sourceRef, 'package.json'))
  const currentVersion = packageJsonAtRef.version
  const version = computeNextVersion({
    currentVersion,
    explicitVersion: args.explicitVersion,
    bump: args.bump,
    allowSameVersion: args.allowSameVersion,
  })
  console.log(`[cut-release-candidate] version: ${currentVersion} -> ${version}${args.allowSameVersion && version === currentVersion ? ' (--allow-same-version)' : ''}`)

  // --- staging ---------------------------------------------------------------
  const stagingRoot = args.staging ?? (args.test ? DEFAULT_TEST_STAGING_ROOT : DEFAULT_STAGING_ROOT)
  const stagingDir = path.join(stagingRoot, version)
  const worktreePath = resumeFrom ?? args.buildDir ?? path.join(path.dirname(repo), `wt-release-build-${version}${args.test ? '-test' : ''}`)
  const readinessExcludedRoots = [stagingRoot, repo, worktreePath]
  const readinessPaths = assertReadinessHandoffPaths({
    inputPath: args.readinessEvidence, outputPath: args.readinessOutput, excludedRoots: readinessExcludedRoots,
  })

  /* T154: compare the supplied qualification context to the locations this cut
   * will actually use BEFORE the build directory exists and before npm run
   * dist. Same four locations readQualificationContext() checks after the
   * build, all of them derived here from --build-dir, --staging and
   * --readiness-output rather than trusted from the file. */
  if (!readinessPaths.inputPath) {
    await assertQualificationContextLocations(args.readinessContext, {
      sourceRoots: { app: worktreePath },
      stageRoot: path.join(worktreePath, 'release', 'win-unpacked'),
      harnessRoot: DEFAULT_REPO,
      evidenceRoot: path.dirname(readinessPaths.outputPath),
    })
  }

  /* BEFORE the directory is created, before a worktree exists, before anything
   * is built: is this version's slot already taken by a candidate cut from a
   * different commit? computeNextVersion() cannot answer that -- it only
   * compares against package.json, and package.json does not advance unless
   * --advance-branch was used, so every cut from a non-advancing branch
   * computes the same "next" number. Refusing here costs a wasted argument;
   * refusing after the build would already have overwritten the installer and
   * the declaration that describes it. */
  assertStagingFree({ stagingDir, version, sourceRef, replaceStaged: args.replaceStaged, log: console.log })

  await mkdir(stagingDir, { recursive: true })

  // ONE CANDIDATE SLOT, ONE CUT. Claimed here -- after the directory exists,
  // and BEFORE the build worktree, the build, the staging copy and the
  // evidence write -- so a second cut refuses by name having built nothing.
  // assertStagingFree() above cannot do this: it looks for FINISHED artifacts,
  // so a cut that is mid-build reads to it as a free slot.
  const cutSlot = claimCutSlot({
    stagingDir,
    buildDirectory: worktreePath,
    readinessOutput: readinessPaths.outputPath,
    cutSession: cutterSession,
  })

  let worktreeRemoved = false
  try {
    // --- isolated build worktree ------------------------------------------------
    if (resumeFrom) {
      if (!existsSync(worktreePath)) throw new Error(`--resume-from names a worktree that does not exist: ${worktreePath}`)
    } else if (existsSync(worktreePath)) {
      throw new Error(`build directory already exists: ${worktreePath}. Remove it, pass --build-dir, or resume it with --resume-from.`)
    }
    const sealControl = await loadReleaseSealControl(args.sealControl, {
      buildDirectory: worktreePath,
      sourceRef,
      cutSession: cutterSession,
    })

    if (!resumeFrom) {
      console.log(`[cut-release-candidate] creating isolated detached worktree at ${worktreePath} from ${sourceRef}`)
      worktreeAddDetached(repo, worktreePath, sourceRef)
    }

    // Never inherit MC_ALLOW_DIRTY_BUILD from this process's environment.
    // require-clean-tree.mjs's own gate (already wired into `npm run dist`,
    // between vite build and electron-builder) is the real defence, but it
    // trusts whatever the child process's environment says -- and Node's
    // spawn() inherits process.env by default. A stray MC_ALLOW_DIRTY_BUILD=1
    // left set in a shell (e.g. from testing require-clean-tree.mjs directly)
    // would otherwise silently make this "clean isolated build" accept a
    // dirty one without this script ever noticing, since require-clean-tree.mjs
    // still exits 0 when overridden. Delete it explicitly rather than trust
    // that it happens not to be set. The same environment drives the re-run
    // gates of a resumed cut, so it is built once, here, for both paths.
    const cutScratch = await createCutScratch(version)
    const cutCanonicalRoot = await resolveCutCanonicalRoot(repo)
    const buildEnv = buildDistChainEnvironment(process.env, {
      scratchState: cutScratch.scratchState,
      scratchTemp: cutScratch.scratchTemp,
      canonicalRoot: cutCanonicalRoot,
      sourceRepo: repo,
      engineSourceRef,
      payloadRoot: path.join(worktreePath, 'capability'),
    })
    const distChainEnvironment = describeDistChainEnvironment(buildEnv, { scratch: cutScratch.scratch })
    console.log(`[cut-release-candidate] dist-chain isolation: state and temp under ${cutScratch.scratch}`)
    console.log(`[cut-release-candidate]   MC_CANONICAL_ROOT: ${cutCanonicalRoot ?? '(unresolved -- removed, so the suite refuses rather than measures this machine)'}`)

    let privateInputs
    let buildRef
    let code
    let buildInfo
    let pipelineFacts
    let resumeRun = null
    const skipAccepted = new Map()

    if (resumeFrom) {
      // --- RESUME: the postmortem worktree of a cut that failed AFTER packaging ---
      //
      // Everything a fresh cut proves before `npm run dist` is re-proven here
      // from what the failed run left behind: the version-only commit on top of
      // the declared source, a clean tree, require-clean-tree.mjs's own record,
      // and -- the part a fresh cut never needs -- the artifact seal, which is
      // the only thing that says the unpacked tree is still what packaging
      // produced. A worktree that cannot pass all of these is not resumed; it
      // is re-cut.
      console.log(`[cut-release-candidate] --resume-from: reusing the postmortem build worktree ${worktreePath}`)
      if (!isClean(worktreePath)) {
        throw new Error(`the resume worktree is not clean (git status --porcelain is non-empty); a resumed cut declares only committed bytes plus the sealed build output. Worktree: ${worktreePath}`)
      }
      buildRef = revParse(worktreePath, 'HEAD')
      const packageJsonInWorktree = JSON.parse(await readFile(path.join(worktreePath, 'package.json'), 'utf8'))
      if (packageJsonInWorktree.version !== version) {
        throw new Error(`the resume worktree built version ${packageJsonInWorktree.version}, but this invocation computed ${version}; pass --version ${packageJsonInWorktree.version} (with --allow-same-version if package.json already says so)`)
      }
      const transition = await withGateWorktree(worktreePath, () => runOwnedProcess(
        process.execPath,
        ['tools/release-packager/verify-version-transition.mjs', '--repo', repo, '--source-ref', sourceRef, '--build-ref', buildRef, '--version', version,
          ...(args.allowSameVersion ? ['--allow-same-version'] : [])],
        { cwd: worktreePath, env: process.env, timeoutMs: 120_000, log: console.log },
      ))
      if (transition.code !== 0) {
        throw new Error(`the version-transition verifier failed (exit ${transition.code}) for the resumed worktree; refusing to resume`)
      }
      console.log(`[cut-release-candidate] resumed build ref ${buildRef}: ${buildRef === sourceRef ? 'explicit unchanged source' : 'exact version-only commit'} on ${sourceRef}, verified.`)
      privateInputs = await copyPrivateInputs(repo, worktreePath, { log: console.log })
      if (!isClean(worktreePath)) throw new Error('copying private inputs dirtied the resume worktree; refusing to proceed')

      const resumedBuildInfoPath = path.join(worktreePath, 'dist', 'build-info.json')
      if (!existsSync(resumedBuildInfoPath)) {
        throw new Error('dist/build-info.json is missing in the resume worktree; the original run never reached require-clean-tree.mjs, so there is no gated build to resume. Re-cut.')
      }
      buildInfo = JSON.parse(await readFile(resumedBuildInfoPath, 'utf8'))
      assertBuildProvenance(buildInfo, { buildRef, engineSourceRef })
      if (buildInfo.dirty !== false || buildInfo.overridden !== false || buildInfo.ref !== buildRef) {
        throw new Error(`require-clean-tree.mjs's record in the resume worktree says dirty=${buildInfo.dirty}, overridden=${buildInfo.overridden}, ref=${buildInfo.ref}; a resume needs a clean record at ${buildRef}`)
      }

      // A seal proves bytes survived, not that the prebuild tests passed. Old
      // ratchets accepted baseline failures; a resumed release needs a current
      // strict verdict from the candidate's own source before it can be cut.
      if (packageJsonInWorktree.scripts?.['verify:release'] !== 'node tools/test-ratchet.mjs --strict') {
        throw new Error('the resume worktree has no strict release test entry point; re-cut from source with verify:release')
      }
      const strictTests = await withGateWorktree(worktreePath, () => runOwnedProcess(process.execPath, ['tools/test-ratchet.mjs', '--strict'], {
        cwd: worktreePath, env: buildEnv, timeoutMs: 30 * 60_000, log: console.log,
      }))
      if (strictTests.code !== 0) throw new Error(`strict release tests failed in the resume worktree (exit ${strictTests.code})`)

      const artifact = await describeArtifact(worktreePath, version)
      console.log(
        `[cut-release-candidate] resume artifact: ${artifact.installer.filename} ${artifact.installer.bytes} bytes SHA-256 ${artifact.installer.sha256}; ` +
          `seal ${artifact.sealFile} recorded ${artifact.sealRecordedAt} (SHA-256 ${artifact.sealSha256})`,
      )
      const gateSourcePath = path.resolve(args.gateSource ?? repo)
      const { accepted } = await selectSkippableGates({ evidencePaths: args.skipVerified ?? [], artifact, gateSourcePath, log: console.log })
      for (const [name, entry] of accepted) skipAccepted.set(name, entry)

      console.log('[cut-release-candidate] re-running every post-packaging gate against the sealed artifact (seal verification first and last) ...')
      resumeRun = await runGates({
        worktreePath,
        gateSourcePath,
        gates: POST_BUILD_GATES.filter((entry) => !entry.runsInCutTail),
        skip: skipAccepted,
        artifact,
        evidencePath: defaultEvidencePath(worktreePath),
        env: buildEnv,
        environment: distChainEnvironment,
        privateInputs: privateInputs?.digests ?? null,
        log: console.log,
      })
      if (!resumeRun.ok) {
        throw new Error(
          `post-packaging gate ${resumeRun.failed} failed in the resumed cut; evidence: ${resumeRun.evidencePath}. ` +
            `Nothing was staged, tagged or declared. Worktree kept: ${worktreePath}`,
        )
      }
      code = null
      pipelineFacts = extractPipelineFacts(resumeRun.combinedOutput)
      pipelineFacts.verifySummary = extractPipelineFacts(strictTests.output).verifySummary
      pipelineFacts.resumed = true
    } else {
    if (!isClean(worktreePath)) {
      throw new Error('freshly created worktree is not clean -- this should be impossible; aborting without touching anything else.')
    }
    console.log('[cut-release-candidate] fresh worktree confirmed clean.')

    privateInputs = await copyPrivateInputs(repo, worktreePath, { log: console.log })
    await waitForReleaseSealPhase(sealControl, 'worktree-materialized')

    // STAGE THE CAPABILITY PAYLOAD BEFORE `npm run dist` RUNS ITS VERIFY GATE.
    //
    // This script always builds in a fresh detached worktree, and capability/ is
    // gitignored -- a checkout never materialises it. The dist chain's verify
    // gate runs first (ship-path.test.mjs pins that ordering on purpose), and
    // verify now contains payload-reading tests that FAIL CLOSED when no payload
    // root exists, printing `run node tools/pack-capability-layer.mjs first` as
    // their own remedy. Found on the 2026-08-11 cut attempt: 34 such tests went
    // red in a clean worktree that the day-to-day tree sailed through on a stale
    // leftover payload, so THE ONE COMMAND could not cut any tip anywhere, by
    // construction. Staging here -- right after the private inputs the packer's
    // source-tree setting lives in -- is that remedy, run by the repo's own tool
    // in the same worktree the build will use. capability/ is gitignored, so the
    // clean checks before and inside the build are not perturbed, and the
    // packer's own fail-closed guards stand: no engine source, or owner data in
    // the staged payload, aborts the cut loudly before anything is built.
    /* The packer follows the worktree's private declaration, not this flag,
     * so the two must agree before anything is staged. */
    const declarationPath = path.join(worktreePath, 'private', 'capability-source.owner.json')
    const declaredEngineRef = assertDeclaredEngineSource(
      existsSync(declarationPath) ? JSON.parse(readFileSync(declarationPath, 'utf8')) : null,
      engineSourceRef,
      { file: declarationPath },
    )
    console.log(`[cut-release-candidate] build worktree declares engine ${declaredEngineRef}; it matches --engine-source-ref`)
    console.log('[cut-release-candidate] staging the capability payload (pack-capability-layer.mjs) before the dist verify gate ...')
    const pack = await runCapturing(
      process.execPath,
      ['tools/pack-capability-layer.mjs', '--source-ref', engineSourceRef],
      { cwd: worktreePath, windowsHide: true },
    )
    if (pack.code !== 0) {
      throw new Error(
        `pack-capability-layer.mjs failed (exit ${pack.code}) in ${worktreePath}, so the payload-reading verify ` +
          `gates would have nothing real to check. Nothing was built. The worktree was left in place for postmortem: ${worktreePath}`,
      )
    }
    const packedPayloadRoot = path.join(worktreePath, 'capability')
    const packedPayload = assertPackedPayload(
      packedPayloadRoot,
      engineSourceRef,
      path.join(worktreePath, 'tools', 'capability-manifest.json'),
    )
    console.log(`[cut-release-candidate] staged payload measured: sourceRef=${packedPayload.sourceRef}, all ${packedPayload.helpers} declared helper program(s) present`)
    assertPayloadGatesBound(buildEnv, packedPayloadRoot)
    assertCutEnvironmentIsolated(buildEnv, { scratchState: cutScratch.scratchState, scratchTemp: cutScratch.scratchTemp })
    assertScratchFence(buildEnv, { scratchRoots: [cutScratch.scratchState, cutScratch.scratchTemp] })
    console.log('[cut-release-candidate] capability path overrides: scrubbed and re-pointed inside the cut scratch')
    console.log(`[cut-release-candidate] payload gates bound: ${PAYLOAD_GATE_VARIABLES.join(', ')} -> ${packedPayloadRoot}`)

    await waitForReleaseSealPhase(sealControl, 'capability-materialized')

    if (version === currentVersion) {
      if (!args.allowSameVersion) throw new Error('unchanged version requires explicit --allow-same-version')
      buildRef = sourceRef
      console.log(`[cut-release-candidate] --allow-same-version: retaining source ${sourceRef}; no package rewrite or version-bump commit.`)
    } else {
      const packageJsonPath = path.join(worktreePath, 'package.json')
      await writePackageVersion(packageJsonPath, version)

      buildRef = commitPaths(
        worktreePath,
        ['package.json', 'package-lock.json'],
        `package files: bump version to ${version} for release candidate\n\n` +
          `Automated by tools/release-packager/cut-release-candidate.mjs. Built from ${sourceRef} in an isolated, ` +
          `detached worktree; the day-to-day worktree (with another lane's uncommitted work in it) was never entered.\n\n` +
          `${cutterAttribution}\n`,
        { identity: cutterIdentity, signoff: true },
      )
      console.log(`[cut-release-candidate] version-bump commit: ${buildRef}`)
    }

    /* Independently read the committed package inputs back through Git. In
       the explicit same-version case, prove the unchanged source's version
       and dependency parity. Otherwise commitPaths() naming
       two paths is not proof that the resulting commit changed only those
       bytes or that its parent is still the source we declared. */
    const transition = await runCapturing(
      process.execPath,
      [
        'tools/release-packager/verify-version-transition.mjs',
        '--repo', repo,
        '--source-ref', sourceRef,
        '--build-ref', buildRef,
        '--version', version,
        ...(args.allowSameVersion ? ['--allow-same-version'] : []),
      ],
      { cwd: worktreePath, env: process.env, windowsHide: true },
    )
    if (transition.code !== 0) {
      throw new Error(
        `the version-transition verifier failed (exit ${transition.code}); nothing was built. `
        + `The worktree was left in place for postmortem: ${worktreePath}`,
      )
    }
    console.log(buildRef === sourceRef
      ? '[cut-release-candidate] explicit unchanged source and committed package/lock parity: verified.'
      : '[cut-release-candidate] exact version-only commit transition: verified.')

    const preBuildClean = isClean(worktreePath)
    console.log(`[cut-release-candidate] git status --porcelain empty before npm run dist: ${preBuildClean}`)
    if (!preBuildClean) throw new Error('worktree is dirty immediately before the build -- refusing to proceed.')
    await waitForReleaseSealPhase(sealControl, 'package-transition-committed')

    await provisionNodeModules(repo, worktreePath, { log: console.log })
    await prepareNativeTestDependencies(worktreePath)
    await waitForReleaseSealPhase(sealControl, 'dependencies-materialized')

    // buildEnv (MC_ALLOW_DIRTY_BUILD stripped, engine ref bound) is built once
    // above the fresh/resume branch; see the comment there.
    console.log('[cut-release-candidate] running `npm run dist` (verify -> build -> require-clean-tree -> electron-builder -> strip-diagnostics -> check-no-owner-data -> smoke) ...')
    const distRun = await runCapturing('npm.cmd', ['run', 'dist'], {
      cwd: worktreePath,
      env: buildEnv,
      windowsHide: true,
      shell: true,
    })
    code = distRun.code
    const combinedOutput = `${distRun.stdout}\n${distRun.stderr}`

    if (code !== 0) {
      throw new Error(
        `npm run dist failed (exit ${code}) in ${worktreePath}. The worktree was left in place for postmortem: ${worktreePath}`,
      )
    }
    console.log('[cut-release-candidate] npm run dist: exit 0.')
    await waitForReleaseSealPhase(sealControl, 'build-output-materialized')

    // Independent cross-check: don't just trust `npm run dist`'s exit code.
    // require-clean-tree.mjs writes dist/build-info.json INSIDE this exact
    // worktree recording what IT measured (dirty/overridden), between vite
    // build and electron-builder. Reading it back is a second, independent
    // confirmation from the pipeline's own gate -- not a duplicate of this
    // script's own pre-build isClean() check above, which only proves the
    // tree was clean before the pipeline started, not that it stayed that
    // way or that the gate wasn't overridden by something in the environment.
    const buildInfoPath = path.join(worktreePath, 'dist', 'build-info.json')
    if (!existsSync(buildInfoPath)) {
      throw new Error(
        `dist/build-info.json is missing after a successful npm run dist -- require-clean-tree.mjs should always ` +
          `write it. Refusing to trust this build's provenance. Worktree kept for inspection: ${worktreePath}`,
      )
    }
    buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'))
    assertBuildProvenance(buildInfo, { buildRef, engineSourceRef })
    if (buildInfo.dirty !== false || buildInfo.overridden !== false) {
      throw new Error(
        `require-clean-tree.mjs's own record says dirty=${buildInfo.dirty}, overridden=${buildInfo.overridden} ` +
          `for this build -- this tool only ever produces declarable candidates from a build that gate independently ` +
          `confirms was clean. Worktree kept for inspection: ${worktreePath}`,
      )
    }
    console.log(`[cut-release-candidate] require-clean-tree.mjs independently confirms dirty:false, overridden:false (ref ${buildInfo.ref}).`)

    /* T392/T394: BIND THE SEALED ARTIFACT TO THE TIP THIS CUT SAYS IT IS
       PUBLISHING. The seal written inside `npm run dist` binds the commit the
       BINARY carries; this compares that commit against buildRef, which is the
       ref the declaration, the tag and the download manifest will all name.
       Without it the two facts are never put side by side, and an artifact can
       be published under a tip it does not carry -- the T394 shape. It costs
       about a second and it is the only step that asks this question. */
    const sealBinding = await runCapturing(
      process.execPath,
      ['tools/seal-artifact.mjs', '--verify', 'release/win-unpacked', '--expect-ref', buildRef],
      { cwd: worktreePath, env: buildEnv },
    )
    if (sealBinding.code !== 0) {
      throw new Error(
        `the sealed artifact is not bound to ${buildRef}, the tip this cut is publishing (exit ${sealBinding.code}). ` +
          `Nothing is declared from an artifact whose own provenance disagrees with its ref. ` +
          `Worktree kept for inspection: ${worktreePath}`,
      )
    }
    console.log(`[cut-release-candidate] the sealed artifact is bound to the published tip ${buildRef}.`)

    pipelineFacts = extractPipelineFacts(combinedOutput)
    } // end of the fresh-build branch; a resumed cut joins here with the same variables proven

    // --- locate + copy the built artifact BEFORE any cleanup ------------------
    const releaseDir = path.join(worktreePath, 'release')
    const exeName = `ToolsEnabled Setup ${version}.exe`
    const builtExePath = path.join(releaseDir, exeName)
    const builtBlockmapPath = `${builtExePath}.blockmap`
    if (!existsSync(builtExePath)) {
      throw new Error(`expected build output not found: ${builtExePath}. Worktree kept for inspection: ${worktreePath}`)
    }

    const builtMeasured = await measureFile(builtExePath)
    console.log(`[cut-release-candidate] built artifact: ${builtMeasured.bytes} bytes, SHA-256 ${builtMeasured.sha256}`)

    const stagedExePath = path.join(stagingDir, exeName)
    await cp(builtExePath, stagedExePath)
    if (existsSync(builtBlockmapPath)) await cp(builtBlockmapPath, `${stagedExePath}.blockmap`)
    await waitForReleaseSealPhase(sealControl, 'staged-output-materialized')

    const stagedMeasured = await measureFile(stagedExePath)
    if (!sameBytes(builtMeasured, stagedMeasured)) {
      throw new Error(
        `staged copy is NOT byte-identical to the built artifact (built ${builtMeasured.bytes}b/${builtMeasured.sha256} vs ` +
          `staged ${stagedMeasured.bytes}b/${stagedMeasured.sha256}). Worktree kept for inspection: ${worktreePath}. ` +
          `Staged copy NOT declared.`,
      )
    }
    console.log('[cut-release-candidate] staged copy re-hashed: byte-identical to the build.')

    // QA THE BUILD THAT PRODUCED THIS EXACT CANDIDATE. release:cut used to run
    // qa:packaged before this isolated worktree existed, against whatever stale
    // release/win-unpacked happened to be in the shared checkout. A green result
    // therefore said nothing about the bytes staged above. Every driver now gets
    // this worktree's own unpacked sibling explicitly, after the build and before
    // any candidate declaration or tag is published.
    const exactUnpacked = path.join(releaseDir, 'win-unpacked')
    const qaEvidence = skipAccepted.get('packaged-qa') ?? null
    if (qaEvidence) {
      // Only a resumed cut can get here, and only with a record that bound this
      // exact seal and installer to an exit-0 QA run by an unchanged, clean
      // harness. The declaration says "accepted from evidence", never "exit 0".
      console.log(
        `[cut-release-candidate] exact-candidate packaged QA: not re-run; accepted from bound evidence recorded ` +
          `${qaEvidence.recordedAt} by harness ${qaEvidence.gateSourceRef} against seal ${qaEvidence.sealSha256}`,
      )
      pipelineFacts.packagedQaExitCode = null
      pipelineFacts.packagedQaEvidence = {
        file: path.basename(qaEvidence.evidencePath),
        recordedAt: qaEvidence.recordedAt,
        gateSourceRef: qaEvidence.gateSourceRef,
        sealSha256: qaEvidence.sealSha256,
      }
    } else {
      console.log(`[cut-release-candidate] running exact-candidate packaged QA against ${exactUnpacked} ...`)
      const qa = await runCapturing(
        process.execPath,
        ['tools/packaged-qa-suite.mjs', '--release', exactUnpacked],
        { cwd: worktreePath, env: buildEnv, windowsHide: true },
      )
      if (qa.code !== 0) {
        throw new Error(
          `exact-candidate packaged QA failed (exit ${qa.code}) against ${exactUnpacked}. ` +
            `Nothing was declared or tagged. Worktree kept for inspection: ${worktreePath}`,
        )
      }
      pipelineFacts.packagedQaExitCode = qa.code
      console.log('[cut-release-candidate] exact-candidate packaged QA: exit 0.')
    }
    if (!isClean(worktreePath)) {
      throw new Error('exact-candidate packaged QA changed tracked source files; refusing to publish a candidate from a dirty worktree.')
    }

    // PE identity is measured from the staged bytes before they receive a tag
    // or declaration. A hash-valid file with the wrong embedded release is not
    // a candidate.
    if (!sameBytes(stagedMeasured, await measureFile(stagedExePath))) {
      throw new Error('staged installer changed during exact-candidate QA; refusing to tag or declare it')
    }
    const versionInfo = await readExeVersionInfo(stagedExePath)
    const packageJsonBuilt = JSON.parse(showFile(repo, buildRef, 'package.json'))
    assertCandidatePeIdentity({
      version,
      productName: packageJsonBuilt.productName,
      measured: versionInfo,
    })
    console.log(
      `[cut-release-candidate] staged PE identity confirmed: ${versionInfo.productName} ` +
        `${versionInfo.fileVersion}/${versionInfo.productVersion}.`,
    )

    // --- what's uncommitted in the day-to-day worktree right now, for the declaration ---
    //
    // `sourceWorktree: repo` used to be here. The file list is the information
    // -- it says what is NOT in the build -- and it is already repo-relative;
    // the checkout's absolute location added nothing except the builder's
    // account name, in a document written to be sent elsewhere.
    const sourceDirtyFiles = porcelainStatus(repo)
    const excludedWip = {
      measuredAt: new Date().toISOString(),
      dirtyFiles: sourceDirtyFiles,
    }

    // --- scan for other same-named installers so B is told what to ignore -------
    const otherCandidateRoots = [
      releaseDirIfStillPresent(repo),
      stagingRoot,
      ...(args.otherCandidateRoots ?? []),
    ].filter(Boolean)
    const otherCandidates = await findOtherCandidates(otherCandidateRoots, stagedExePath)

    // Fresh and resumed cuts qualify the artifact that now exists. Preserve
    // the exact raw receipt privately BEFORE immutable bookkeeping; public
    // declarations receive only its informational identity summary.
    const qualificationContext = readinessPaths.inputPath ? undefined : readQualificationContext(args.readinessContext, 'toolsenabled', {
      sourceRoots: { app: worktreePath }, stageRoot: exactUnpacked, harnessRoot: DEFAULT_REPO,
      evidenceRoot: path.dirname(readinessPaths.outputPath),
    })
    const readiness = readinessPaths.inputPath
        ? await readReleaseReadiness(readinessPaths.inputPath, {
          product: 'toolsenabled', artifact: { sha256: stagedMeasured.sha256, bytes: stagedMeasured.bytes },
          sourceRefs: { app: buildRef, engine: engineSourceRef },
          target: WINDOWS_READINESS_TARGET,
        })
        : await qualifyReleaseArtifact({
          product: 'toolsenabled', artifactPath: stagedExePath,
          sourceRefs: { app: buildRef, engine: engineSourceRef },
          target: WINDOWS_READINESS_TARGET,
          context: qualificationContext,
        })
    const retainQualificationInputs = Boolean(readiness.subject?.context)
    if (args.advanceBranch && !args.test && retainQualificationInputs &&
        path.relative(repo, readiness.subject.context.harnessRoot) === '') {
      throw new Error('branch advancement would change the measured qualification harness; use a separate clean harness checkout')
    }
    const readinessHandoff = preserveReadinessReceipt(readiness, { ...readinessPaths, excludedRoots: readinessExcludedRoots })
    console.log(`[cut-release-candidate] private readiness receipt: ${readinessHandoff.path}`)

    const releaseNotes = await stageWindowsReleaseNotes({
      worktreePath, stagingDir, version, releasePlatforms: args.releasePlatforms, stagedExePath, stagedMeasured,
    })
    console.log(`[cut-release-candidate] measured Windows packet release notes passed: ${releaseNotes.filename}`)

    const facts = {
      readiness,
      test: args.test,
      date: new Date().toISOString().slice(0, 10),
      version,
      previousVersion: currentVersion,
      // No `repo` and no `treeState.worktreePath`. Both were absolute paths on
      // the build machine, both were rendered into the declaration verbatim, and
      // neither told a recipient anything: they name directories on a machine
      // that recipient does not have. What identifies the source is `buildRef`,
      // which is true on every clone. toDeclarableFacts() strips them again
      // below if a future edit puts them back -- but not putting them in the
      // object at all is the fix, and the stripper is the net under it.
      branch,
      sourceRef,
      engineSourceRef,
      buildRef,
      releasePlatforms: args.releasePlatforms,
      releaseNotes,
      branchAdvanced: false,
      branchAdvanceError: null,
      candidate: { filename: exeName, bytes: stagedMeasured.bytes, sha256: stagedMeasured.sha256 },
      publisher: packageJsonBuilt.author,
      treeState: {
        worktreeRemoved: false,
        buildInfoConfirmedClean: buildInfo.dirty === false && buildInfo.overridden === false,
      },
      // Present only for a resumed cut: which post-packaging gates re-ran, which
      // were skipped, and the evidence each skip leaned on. A fresh cut has no
      // such table because `npm run dist` ran them as one unbroken chain.
      gateRun: resumeRun ? summarizeGateRun(resumeRun, { mode: 'resumed' }) : null,
      versionInfo,
      appId: { configured: packageJsonBuilt.build?.appId ?? '(not set)' },
      unsigned: { signExecutable: packageJsonBuilt.build?.win?.signExecutable ?? null },
      pipeline: { ...pipelineFacts, distExitCode: code },
      excludedWip,
      otherCandidates,
      stagingDir,
      privateInputsCopied: privateInputs.copied,
      privateInputsSkippedTracked: privateInputs.skippedTracked,
      privateInputsDigests: privateInputs.digests ?? [],
      knownFixes: args.knownFixes,
    }

    if (sealControl && sealControl.nextPhase !== RELEASE_SEAL_PHASES.length) {
      throw new Error('release seal protocol did not consume every ordered phase')
    }

    // TAG ONLY AFTER BUILD + EXACT QA + STAGED HASH + PE IDENTITY + DECLARATION PREFLIGHT. The immutable
    // tag keeps the detached build ref reachable, whether or not --keep-worktree
    // is used; tagCommit refuses to move an existing name to different bytes.
    const tagResult = await tagDeclaredCandidate(stagingDir, facts,
      () => tagCommit(repo, `build/${version}`, buildRef), { test: args.test })
    console.log(
      `[cut-release-candidate] ${tagResult.created ? 'created' : 'confirmed'} immutable candidate tag build/${version}`,
    )

    // Retain inputs bound to qualification evidence for independent replay.
    // A resumed cut always keeps its worktree: the gate-evidence records live in
    // its release/ directory and are the audit trail the declaration cites.
    if (!keepWorktree && !retainQualificationInputs) {
      /* THE JUNCTION IS RELEASED BEFORE GIT DELETES ANYTHING. The helper and
         its docblock existed; nothing called it, and on 2026-08-14 the cut's
         own `git worktree remove --force` followed the node_modules junction
         into the SHARED source tree and emptied it -- the next build died at
         "vite not found" and npm ci cost the cycle the reuse existed to save.
         rmdirSync on the junction removes only the reparse point; the shared
         node_modules is never entered. */
      releaseNodeModulesJunction(worktreePath)
      worktreeRemove(repo, worktreePath)
      worktreeRemoved = true
      console.log(`[cut-release-candidate] removed build worktree: ${worktreePath}`)
    } else {
      console.log(`[cut-release-candidate] retaining build inputs for independent readiness revalidation: ${worktreePath}`)
    }

    // --- optionally advance the shared branch -----------------------------------
    //
    // A FAILURE HERE MUST NOT COST THE DECLARATION. Advancing the branch is
    // bookkeeping; the declaration is the artifact's human-readable record.
    // On the 1.0.3 cut this step threw AFTER a fully successful, fully verified
    // build, and because it threw, control jumped to the catch and the
    // declaration was never written -- leaving a 101 MB installer on disk with
    // no filename/bytes/sha256/build-ref record beside it. The build was fine.
    // The evidence that it was fine is what got lost. The immutable candidate
    // tag now keeps the ref reachable independently of branch advancement.
    //
    // So: capture the error, finish writing the declaration (which records the
    // failure in branchAdvanceError so nobody reads branchAdvanced:false as a
    // deliberate choice), and only then rethrow.
    let branchAdvanced = false
    let branchAdvanceError = null
    if (args.advanceBranch && !args.test) {
      try {
        fastForwardBranch(repo, branch, buildRef)
        branchAdvanced = true
        console.log(`[cut-release-candidate] fast-forwarded ${branch} -> ${buildRef}`)
      } catch (error) {
        // Raw Git diagnostics remain local; never introduce unvalidated
        // account/path text into public metadata after the tag exists.
        console.error(error instanceof Error ? error.message : String(error))
        branchAdvanceError = 'Fast-forward failed; see the private cut log for diagnostics.'
        console.error(
          `[cut-release-candidate] branch advance FAILED (the build itself is fine and is staged): ${branchAdvanceError}`,
        )
        console.error(
          `[cut-release-candidate] the declaration will still be written. To put ${buildRef} on a branch by hand:\n` +
            `    cd <the worktree that has ${branch} checked out> && git merge --ff-only ${buildRef}\n` +
            `  Immutable tag build/${version} already keeps ${buildRef} reachable; this branch step does not ` +
            `control candidate preservation or publication.`,
        )
      }
    } else if (args.advanceBranch && args.test) {
      console.log('[cut-release-candidate] --test overrides --advance-branch: the shared branch was NOT moved.')
    }

    // THE FACTS OBJECT IS ITSELF A PUBLISHED ARTIFACT: declaration-facts.json is
    // written into the same transfer directory as the installer and the
    // declaration, and the shipped 1.0.2 and 1.0.4 copies each carry the
    // builder's account name 7 times. A renderer-only fix would produce a
    // declaration that reads clean sitting next to a JSON file that is not.
    if (worktreeRemoved && !sameBytes(stagedMeasured, await measureFile(stagedExePath))) {
      throw new Error('staged installer changed after build-worktree removal; refusing to declare it')
    }
    facts.branchAdvanced = branchAdvanced
    facts.branchAdvanceError = branchAdvanceError
    facts.treeState.worktreeRemoved = worktreeRemoved
    const { declarationPath, manifestPath } = await writeDeclarationArtifacts(stagingDir, facts, { test: args.test })

    /* THE CUT SEALS ITSELF. This runs before the candidate-ready banner on
     * purpose: if the seal is refused, this throws, the banner is never
     * printed, and no sealed marker exists for anyone to cite. The tool
     * re-measures the installer's bytes and sha256 from the file rather than
     * being handed this run's numbers, so the record is an independent
     * measurement of the artifact and not a copy of the cutter's claim. */
    const sealRecordPath = await sealCutRecord({
      tool: sealRecordTool,
      installerPath: stagedExePath,
      appRef: buildRef,
      engineRef: engineSourceRef,
      version,
      manifestPath,
      recordPath: path.join(stagingDir, `seal-cut-record-${version}.json`),
    })

    console.log('')
    console.log('='.repeat(72))
    console.log(`[cut-release-candidate] ${args.test ? 'TEST candidate' : 'CANDIDATE'} ready.`)
    console.log(`  file:        ${stagedExePath}`)
    console.log(`  bytes:       ${stagedMeasured.bytes}`)
    console.log(`  sha256:      ${stagedMeasured.sha256}`)
    console.log(`  build ref:   ${buildRef}${branchAdvanced ? ` (now tip of ${branch})` : ` (NOT yet on ${branch})`}`)
    console.log(`  declaration: ${declarationPath}`)
    console.log(`  manifest:    ${manifestPath}`)
    console.log(`  private readiness (--ReleaseReadinessPath): ${readinessHandoff.path}`)
    console.log(`  seal record: ${sealRecordPath}`)
    console.log('='.repeat(72))
    if (args.test) {
      console.log('This was a --test run. Nothing was sent anywhere and the shared branch was not moved.')
    }
    if (branchAdvanceError) {
      throw new Error(
        `candidate is staged and declared, but advancing ${branch} to ${buildRef} failed: ${branchAdvanceError}`,
      )
    }
  } catch (error) {
    if (!worktreeRemoved && existsSync(worktreePath) && !keepWorktree) {
      console.error(`[cut-release-candidate] leaving build worktree in place for postmortem: ${worktreePath}`)
      const leftoverNodeModules = path.join(worktreePath, 'node_modules')
      if (existsSync(leftoverNodeModules)) {
        console.error(
          `[cut-release-candidate] WARNING: ${leftoverNodeModules} may be a junction into the shared source ` +
            `node_modules, not a real copy. Do NOT run a recursive delete (rm -rf / Remove-Item -Recurse) on ` +
            `${worktreePath} without first checking: PowerShell \`(Get-Item '${leftoverNodeModules}').LinkType\` -- ` +
            `if it says "Junction", remove only that node_modules entry itself (e.g. \`(Get-Item '${leftoverNodeModules}').Delete()\` ` +
            `or \`rmdir\` without /s) BEFORE deleting the rest of the directory, or a naive recursive delete can ` +
            `follow the link and destroy the real, shared node_modules other lanes are using.`,
        )
      }
    }
    throw error
  } finally {
    // Released on normal completion and on an ordinary caught failure.
    // Abrupt death RETAINS the marker, exactly as gate-quarantine retains an
    // uncertain gate worktree: a dead pid is not consent and there is no timer,
    // so an operator clears it by hand after inspecting the owning process.
    cutSlot.release()
  }
}

function releaseDirIfStillPresent(repo) {
  const dir = path.join(repo, 'release')
  return existsSync(dir) ? dir : null
}

/* --gates-only: the fast loop. Build nothing, mutate no git state, stage
 * nothing; run the post-packaging gates against an existing build worktree and
 * write the evidence record a later --resume-from can consume. The worktree's
 * own package.json says which installer to bind to, so the record can never
 * name a different version than the tree it ran in. */
async function runGatesOnlyMode(args) {
  const worktreePath = path.resolve(args.gatesOnly)
  assertGateWorktreeAvailable(worktreePath)
  if (!existsSync(worktreePath)) throw new Error(`--gates-only worktree does not exist: ${worktreePath}`)
  const gateSourcePath = path.resolve(args.gateSource ?? args.repo ?? DEFAULT_REPO)
  const version = JSON.parse(await readFile(path.join(worktreePath, 'package.json'), 'utf8')).version
  const gates = selectGates(args.gates)
  const artifact = await describeArtifact(worktreePath, version)
  const evidencePath = args.evidenceOut ? path.resolve(args.evidenceOut) : defaultEvidencePath(worktreePath)
  console.log(`[cut-release-candidate] --gates-only: worktree=${worktreePath} version=${version} gateSource=${gateSourcePath}`)
  console.log(`[cut-release-candidate] artifact: ${artifact.installer.filename} ${artifact.installer.bytes} bytes SHA-256 ${artifact.installer.sha256}; seal SHA-256 ${artifact.sealSha256}`)
  console.log(`[cut-release-candidate] gates: ${gates.map((entry) => entry.name).join(', ')}`)
  const gateScratch = await createCutScratch(version)
  const gateCanonicalRoot = await resolveCutCanonicalRoot(path.resolve(args.repo ?? DEFAULT_REPO))
  /* --gates-only built this a SECOND time and forgot payloadRoot, so every
   * payload-reading gate ran unbound: MC_TEST_CAPABILITY_PAYLOAD has no
   * fallback, vault-manager-staged skipped by name, and the diagnostic printed
   * green over a gate that never looked. The same three assertions the full cut
   * makes apply here. */
  const gatePayloadRoot = path.join(worktreePath, 'capability')
  const env = buildDistChainEnvironment(process.env, {
    scratchState: gateScratch.scratchState,
    scratchTemp: gateScratch.scratchTemp,
    canonicalRoot: gateCanonicalRoot,
    sourceRepo: path.resolve(args.repo ?? DEFAULT_REPO),
    engineSourceRef: args.engineSourceRef,
    payloadRoot: gatePayloadRoot,
  })
  assertPayloadGatesBound(env, gatePayloadRoot)
  assertCutEnvironmentIsolated(env, { scratchState: gateScratch.scratchState, scratchTemp: gateScratch.scratchTemp })
  assertScratchFence(env, { scratchRoots: [gateScratch.scratchState, gateScratch.scratchTemp] })
  /* The gates-only worktree has a capability/ too, so the payload it is about
   * to read gets the same provenance check a full cut gives it. */
  assertPackedPayload(gatePayloadRoot, args.engineSourceRef, path.join(worktreePath, 'tools', 'capability-manifest.json'))
  console.log(`[cut-release-candidate] dist-chain isolation: state and temp under ${gateScratch.scratch}`)
  const result = await runGates({ worktreePath, gateSourcePath, gates, artifact, evidencePath, env, environment: describeDistChainEnvironment(env, { scratch: gateScratch.scratch }), log: console.log })
  console.log('')
  console.log('='.repeat(72))
  for (const entry of result.record.gates) console.log(`  ${entry.status.padEnd(7)} ${entry.name}${entry.exitCode === null ? '' : ` (exit ${entry.exitCode})`}`)
  console.log(`  evidence:  ${result.evidencePath}`)
  console.log(`  harness:   ${result.record.gateSource.ref}${result.record.gateSource.dirty ? ' (DIRTY -- this record can never be used for --skip-verified)' : ''}`)
  console.log('='.repeat(72))
  if (!result.ok) throw new Error(`gate ${result.failed} failed; the record above names it. Gates after it did not run.`)
  console.log(`[cut-release-candidate] all ${result.record.gates.length} selected gate(s) passed.`)
}

const invokedDirectly = process.argv[1]
  && existsSync(process.argv[1])
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[cut-release-candidate] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}
