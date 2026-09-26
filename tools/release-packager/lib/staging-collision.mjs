/* REFUSE TO OVERWRITE A CANDIDATE THAT IS ALREADY STAGED AT THIS VERSION.
 *
 * version-bump.mjs opens with the rule this file enforces the other half of:
 * "two different binaries must never silently share a version number". It
 * enforces that against ONE number -- package.json's -- and that number does
 * not move. `cut-release-candidate.mjs` writes the bump into a THROWAWAY
 * detached worktree and only fast-forwards a branch with --advance-branch,
 * which is off by default. So the source tree's package.json stays at, say,
 * 1.0.6 forever, and every cut computes the same "next" version 1.0.7.
 *
 * MEASURED, NOT THEORISED (2026-08-12, R1531 w1): a 1.0.7 candidate cut from
 * one source ref was sitting in
 * ToolsEnabled-INSTALLER-CANDIDATE\1.0.7 (installer + DECLARATION.md +
 * declaration-facts.json). The next cut, from a LATER source ref, computed
 * 1.0.7 again -- computeNextVersion() cannot see the staging directory, and
 * main() went straight to `mkdir(stagingDir, {recursive:true})` and later
 * `cp(builtExe, stagedExe)`, which overwrites. Two different binaries, one
 * version number, and the declaration beside the first one replaced by a
 * declaration describing the second. That violates the immutable-candidate
 * contract the tool exists to enforce.
 *
 * ABSENCE IS NEVER CONSENT. An installer sitting in the staging directory
 * with NO declaration-facts.json beside it is not evidence that the slot is
 * free -- it is a candidate whose provenance we cannot read, which is a
 * stronger reason to refuse, not a weaker one. Unreadable, unparseable, and
 * blank-sourceRef facts all refuse for the same reason. The only permitted
 * overwrite is an explicit, logged --replace-staged from the caller.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/* What counts as "a candidate is already here". Deliberately broad: the point
 * is to catch a HALF-written slot too (an installer with no declaration, a
 * declaration whose build failed before the exe landed), because a half-written
 * slot is the one a silent overwrite makes unrecoverable. */
const CANDIDATE_FILE = /(\.exe(?:\.blockmap)?$)|^DECLARATION\.md$|^TEST-DECLARATION\.md$|^declaration-facts\.json$|^(?:TEST-)?download\.json$/i

function isAbsent(error) {
  return error instanceof Error && error.code === 'ENOENT'
}

function inspectionFailed(action, target, cause) {
  const detail = cause instanceof Error
    ? `${cause.code ? `${cause.code}: ` : ''}${cause.message}`
    : `non-Error throw: ${String(cause)}`
  const error = new Error(
    `[staging-collision] could not ${action} ${target} (${detail}); ` +
    'STAGING_INSPECTION_INDETERMINATE is NOT claiming that the staging slot or its declaration is absent.',
    { cause },
  )
  error.code = 'STAGING_INSPECTION_INDETERMINATE'
  return error
}

/** Pure half: decide from a directory listing plus whatever facts were read. */
export function classifyStagedCandidate({ entries, factsRaw, version, sourceRef, replaceStaged = false }) {
  const occupants = (entries ?? []).filter((name) => CANDIDATE_FILE.test(name))
  if (occupants.length === 0) return { free: true, occupants: [], reason: null }

  let stagedSourceRef = null
  let factsProblem = null
  if (factsRaw === null || factsRaw === undefined) {
    factsProblem = 'there is no declaration-facts.json beside it, so what it was built from cannot be read'
  } else {
    try {
      const parsed = JSON.parse(factsRaw)
      /* A present-but-empty field is the codebase's recurring defect: an empty
       * string must never read as "matches whatever you are cutting now". */
      stagedSourceRef = typeof parsed.sourceRef === 'string' && parsed.sourceRef.trim() ? parsed.sourceRef.trim() : null
      if (!stagedSourceRef) factsProblem = 'its declaration-facts.json records no sourceRef, so what it was built from cannot be read'
    } catch (error) {
      factsProblem = `its declaration-facts.json could not be parsed (${error instanceof Error ? error.message : String(error)})`
    }
  }

  const sameSource = Boolean(stagedSourceRef) && Boolean(sourceRef) && stagedSourceRef === sourceRef
  if (replaceStaged) {
    return {
      free: true,
      occupants,
      stagedSourceRef,
      replaced: true,
      reason: `--replace-staged: overwriting the ${version} candidate already staged here (${occupants.join(', ')})` +
        `${stagedSourceRef ? ` built from ${stagedSourceRef}` : ` whose provenance is unreadable -- ${factsProblem}`}.`,
    }
  }

  const provenance = sameSource
    ? `built from THE SAME source ref (${stagedSourceRef})`
    : stagedSourceRef
      ? `built from a DIFFERENT source ref (${stagedSourceRef}) than this cut (${sourceRef})`
      : `of unknown provenance -- ${factsProblem}`

  return {
    free: false,
    occupants,
    stagedSourceRef,
    sameSource,
    reason:
      `a ${version} candidate is already staged here and is ${provenance}. ` +
      `Two different binaries must never silently share a version number, and copying over it would replace ` +
      `both the installer and the declaration that describes it. Nothing was built. Choose one: ` +
      `pass --version <X.Y.Z> to cut a new number, --staging <dir> to stage somewhere else, or ` +
      `--replace-staged if you genuinely mean to discard what is there. ` +
      `Present: ${occupants.join(', ')}.`,
  }
}

/** Disk half: read the slot and throw the refusal, or return the classification. */
export function assertStagingFree({ stagingDir, version, sourceRef, replaceStaged = false, log = console.log }) {
  let entries
  try {
    entries = readdirSync(stagingDir)
  } catch (error) {
    if (isAbsent(error)) entries = []
    else throw inspectionFailed('read staging directory', stagingDir, error)
  }
  const factsPath = path.join(stagingDir, 'declaration-facts.json')
  let factsRaw = null
  if (entries.includes('declaration-facts.json')) {
    try {
      factsRaw = readFileSync(factsPath, 'utf8')
    } catch (error) {
      if (!isAbsent(error)) throw inspectionFailed('read staged declaration facts', factsPath, error)
    }
  }

  const verdict = classifyStagedCandidate({ entries, factsRaw, version, sourceRef, replaceStaged })
  if (!verdict.free) throw new Error(`[staging-collision] ${stagingDir}: ${verdict.reason}`)
  if (verdict.reason) log(`[staging-collision] ${verdict.reason}`)
  return verdict
}
