import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/* ONE CANDIDATE SLOT, ONE CUT.
 *
 * stagingDir is deterministic -- `path.join(stagingRoot, version)`, and
 * computeNextVersion() compares only against package.json, which does not
 * advance unless --advance-branch was used. So every concurrent cut from the
 * same source line lands in the SAME staging directory.
 *
 * assertStagingFree() looks at that directory once, before anything is built,
 * for FINISHED artifacts (exe/blockmap/DECLARATION.md/declaration-facts.json/
 * download.json). During another cut's minutes-long build the slot holds none
 * of those, so an in-flight cut reads as a free slot: the second run proceeds,
 * `cp` overwrites the first run's staged installer (fs.promises.cp overwrites
 * by default), and the declaration set is then published last-writer-wins --
 * producing an installer whose declaration-facts.json names a different
 * sha256, with no error anywhere. That is the outcome this module refuses.
 *
 * The primitive is the same one lib/gate-quarantine.mjs already uses, so this
 * introduces no new idiom: fs.mkdirSync() WITHOUT `recursive` is an atomic
 * exclusive create on both Windows and POSIX -- `recursive: true` would make
 * it idempotent and admit the second cut -- plus an owner.json opened 'wx'.
 *
 * ABSENCE IS NEVER CONSENT, and neither is a dead pid. The marker is retained
 * on abrupt death exactly as gate-quarantine retains on `uncertain`: there is
 * no pid-liveness auto-clear and no timer, because a recycled pid cannot
 * distinguish "dead" from "alive". An operator inspects the owning process and
 * clears the marker by hand.
 */

const MARKER = '.cut-in-flight'
const OWNER = 'owner.json'
const SCHEMA_VERSION = 1

/** The identity a caller asserts on, instead of a message spelling. */
export const CUT_SLOT_HELD = 'CUT_SLOT_HELD'

const leases = new WeakSet()

function slotPaths(stagingDir) {
  if (typeof stagingDir !== 'string' || stagingDir.trim() === '') throw new Error('[cut-slot] claimCutSlot requires a stagingDir')
  const staging = path.resolve(stagingDir)
  const marker = path.join(staging, MARKER)
  return { staging, marker, owner: path.join(marker, OWNER) }
}

function assertNotLink(target, what) {
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`[cut-slot] the ${what} was replaced with a link: ${target}`)
}

/* Best effort BY DESIGN: a cut can die between mkdirSync(marker) and the 'wx'
 * write of owner.json, and that death must still refuse. "Could not read the
 * owner" and "there is no owner" are different answers and are reported as
 * different strings -- never merged into a silent blank. */
function readHolder(owner) {
  let raw
  try { raw = fs.readFileSync(owner, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'unrecorded', detail: 'the holding cut died before it recorded itself' }
    return { state: 'unreadable', detail: `${error.code ?? 'read failed'} reading ${owner}` }
  }
  try { return { state: 'recorded', owner: JSON.parse(raw) } }
  catch { return { state: 'unreadable', detail: `${owner} is not readable JSON` } }
}

function describe(value, missing) {
  if (typeof value !== 'string' || value === '') return `(${missing})`
  return value
}

function heldError({ staging, marker }, holder) {
  const recorded = holder.state === 'recorded' ? holder.owner : null
  // Two different absences, never merged: the whole owner record is missing or
  // unreadable, versus the record is fine and one field in it was never set
  // (readinessOutput is null whenever the holder supplied its own receipt with
  // --readiness-evidence instead of writing one). Reporting the second as the
  // first would tell an operator a live cut had died.
  const unknown = holder.state === 'unrecorded'
    ? `unrecorded -- ${holder.detail}`
    : `unreadable -- ${holder.detail ?? 'no reason recorded'}`
  const absent = recorded ? 'not recorded by the holding cut' : unknown
  const lines = [
    '[cut-slot] another release:cut already holds this candidate slot',
    `  staging:   ${describe(recorded?.stagingDir, absent)}`,
    `  build:     ${describe(recorded?.buildDirectory, absent)}`,
    `  readiness: ${describe(recorded?.readinessOutput, absent)}`,
    `  claimed by pid ${describe(recorded?.pid === undefined ? undefined : String(recorded.pid), absent)} at ${describe(recorded?.startedAt, absent)}.`,
    'Two cuts sharing these paths overwrite each other\'s staged installer and the declaration that describes it:',
    'the installer that ships and the declaration-facts.json beside it stop describing the same bytes, with no error.',
    'Nothing was built by this run: it stopped before its build worktree, its installer and its evidence.',
    'Either wait for that cut to finish, or give this run its own --staging, --build-dir and --readiness-output.',
    `If you are certain no cutter is alive, inspect the owning process and then remove ${marker} by hand;`,
    'this refusal never clears itself, and an alternate evidence path does not bypass it.',
  ]
  const error = new Error(lines.join('\n'))
  error.code = CUT_SLOT_HELD
  error.stagingDir = staging
  error.marker = marker
  error.holder = recorded
  return error
}

/**
 * Claim the candidate slot for this process, or refuse by name.
 *
 * Call it in main() immediately after `mkdir(stagingDir)` and BEFORE the
 * `existsSync(worktreePath)` branch, so the claim is taken before any
 * worktree, any build and any evidence write.
 *
 * @returns {{ marker: string, release: () => void }}
 * @throws {Error & { code: 'CUT_SLOT_HELD' }} when another cut holds the slot.
 */
export function claimCutSlot({ stagingDir, buildDirectory, readinessOutput, cutSession = null }) {
  const paths = slotPaths(stagingDir)
  try {
    // No `recursive`: this line IS the exclusion. `recursive: true` makes
    // mkdir idempotent and silently admits the second cut.
    fs.mkdirSync(paths.marker)
  } catch (error) {
    if (error.code === 'EEXIST') throw heldError(paths, readHolder(paths.owner))
    if (error.code === 'ENOENT') throw new Error(`[cut-slot] the staging directory does not exist, so the slot cannot be claimed: ${paths.staging}`)
    if (error.code === 'ENOTDIR') throw new Error(`[cut-slot] the staging path is not a directory: ${paths.staging}`)
    throw error
  }
  const token = randomUUID()
  const record = {
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    stagingDir: paths.staging,
    buildDirectory: typeof buildDirectory === 'string' && buildDirectory !== '' ? path.resolve(buildDirectory) : null,
    // undefined whenever the run reuses a supplied receipt instead of writing
    // one; recorded as null rather than omitted so the refusal can say so.
    readinessOutput: typeof readinessOutput === 'string' && readinessOutput !== '' ? path.resolve(readinessOutput) : null,
    cutSession: typeof cutSession === 'string' && cutSession !== '' ? cutSession : null,
  }
  const fd = fs.openSync(paths.owner, 'wx')
  try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }

  const lease = {
    marker: paths.marker,
    stagingDir: paths.staging,
    release() {
      if (!leases.has(lease)) throw new Error('[cut-slot] this candidate slot lease was already released')
      assertNotLink(paths.marker, 'candidate slot marker')
      assertNotLink(paths.owner, 'candidate slot owner record')
      const current = JSON.parse(fs.readFileSync(paths.owner, 'utf8'))
      if (current.token !== token || current.pid !== process.pid) {
        throw new Error(`[cut-slot] candidate slot ownership changed while this cut held it: ${paths.marker}`)
      }
      fs.unlinkSync(paths.owner)
      fs.rmdirSync(paths.marker)
      leases.delete(lease)
    },
  }
  leases.add(lease)
  return lease
}
