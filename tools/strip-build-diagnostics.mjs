/* Remove electron-builder's diagnostic sidecar from the release directory.
 *
 * builder-debug.yml is written by electron-builder alongside the installer. It
 * is NOT part of the installer and never reaches a user who runs the .exe --
 * but it records the BUILD MACHINE's absolute paths (NSIS include directories,
 * %TEMP% paths, the electron-builder cache), which on this machine means the
 * owner's home directory. Anyone who shipped or published the whole release
 * folder would hand those over.
 *
 * Note carefully what this is NOT: it is not a way to make the owner-data
 * guard pass. The guard's patterns were deliberately left untouched. The
 * product was already clean -- 0 matches across the app.asar and the installer
 * .exe -- and only the output FOLDER was dirty, because of this one build
 * byproduct. Deleting a file that should not be distributed is the honest fix;
 * loosening the guard to stop it reporting would have been the
 * fix-that-satisfies-its-own-test trap, and the guard is the only thing
 * standing between us and shipping his home directory again.
 */
import { realpathSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIAGNOSTIC_FILES = ['builder-debug.yml']
/* Written into release/ (never into win-unpacked, so it is not sealed and never
   ships) to record that this tool has stripped this directory. It is what lets a
   re-run tell "already stripped" from "the build produced nothing", which are the
   same observation and opposite verdicts. */
const STRIP_RECORD = '.build-diagnostics-stripped.json'

/* THE SECOND ROUTE, AND THIS ONE REACHES THE USER.
 *
 * The header above records that the product was clean and only the output
 * FOLDER was dirty. That stopped being true on 2026-08-27, and the difference
 * matters: this litter ships INSIDE the installer.
 *
 * Chromium writes debug.log next to the running binary. For `npm start` and for
 * every test that spawns the app, that binary is node_modules/electron/dist --
 * which is exactly the directory `build.electronDist` names, and which
 * electron-builder copies wholesale into release/win-unpacked. So a log written
 * by a dev run yesterday is packed into today's .exe.
 *
 * Measured on the 1.0.33 cut: release/win-unpacked/debug.log carried the
 * owner's home directory 31 times, with a CreationTime LATER than its
 * LastWriteTime -- the signature of a copy, which is what identified the source.
 * check-no-owner-data refused, correctly, and that refusal is what this exists
 * to stop being necessary.
 *
 * ABSENCE IS THE GOOD CASE HERE, which is why this list is removed on a
 * different footing from DIAGNOSTIC_FILES above. That one refuses when its file
 * is missing, because builder-debug.yml is always written and its absence means
 * the build did not do what we think. Nothing guarantees a dev run happened
 * before a build, so requiring debug.log to exist would turn a clean machine
 * into a failure. Removed-if-present is the honest disposition; it is not a
 * softening, because check-no-owner-data still refuses anything this misses.
 */
const RUNTIME_LOG_LITTER = ['debug.log']

/* Runs from electron-builder's afterPack hook -- after the app directory is
 * staged, before it is packed into the installer. That ordering is the whole
 * point: strip it here and both the .exe and every check downstream see a clean
 * directory. Stripping it at the release-folder step, where this file's original
 * job runs, would be after the installer already contained it. */
async function stripPackedLitter(appDirectory) {
  const directory = path.resolve(appDirectory)
  const removed = []

  let directoryStat
  try {
    directoryStat = await stat(directory)
  } catch {
    throw new Error(`[strip-build-diagnostics] Refusing to pass: packed app directory does not exist: ${directory}`)
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`[strip-build-diagnostics] Refusing to pass: packed app path is not a directory: ${directory}`)
  }

  for (const name of RUNTIME_LOG_LITTER) {
    const target = path.join(directory, name)
    try {
      await stat(target)
    } catch {
      continue
    }
    await rm(target)
    removed.push(name)
  }
  return { directory, removed }
}

async function stripBuildDiagnostics(releaseDirectory) {
  const directory = path.resolve(releaseDirectory)
  const removed = []

  let directoryStat
  try {
    directoryStat = await stat(directory)
  } catch {
    throw new Error(`[strip-build-diagnostics] Refusing to pass: release directory does not exist: ${directory}`)
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`[strip-build-diagnostics] Refusing to pass: release path is not a directory: ${directory}`)
  }

  /* A CUT RE-RUNS THIS CHAIN AFTER EVERY FIX, AND THIS STEP USED TO DIE ON THE
   * SECOND PASS. Measured in the D1 chain run: the first call removed
   * builder-debug.yml, the second threw "Refusing to pass without expected
   * diagnostic" because the file it strips was already gone.
   *
   * THE HARD PART IS KEEPING THE TEETH. Fail-closed is right here -- a build that
   * produced NO diagnostic is the silent-skip defect this codebase keeps
   * re-finding -- so "absent" must keep meaning REFUSE for a tree that was never
   * stripped. Absence alone therefore cannot be the signal, because it is true in
   * both the safe case and the dangerous one.
   *
   * So the tool records that it stripped, and only a directory carrying that
   * record may pass with nothing to do. First run and second run are then told
   * apart by evidence rather than by assuming the friendlier case. The record
   * lives in release/ beside the artefact, never inside win-unpacked, so it is
   * not sealed and never ships. */
  let priorRecord = null
  try {
    priorRecord = JSON.parse(await readFile(path.join(directory, STRIP_RECORD), 'utf8'))
  } catch { /* no record: this directory has not been stripped by this tool */ }

  const missing = []
  for (const name of DIAGNOSTIC_FILES) {
    const target = path.join(directory, name)
    try {
      await stat(target)
    } catch {
      missing.push(target)
      continue
    }
    await rm(target)
    removed.push(name)
  }

  if (missing.length > 0 && !priorRecord) {
    throw new Error(`[strip-build-diagnostics] Refusing to pass without expected diagnostic: ${missing[0]}`)
  }

  if (removed.length > 0) {
    await writeFile(
      path.join(directory, STRIP_RECORD),
      `${JSON.stringify({ schemaVersion: 1, strippedAt: new Date().toISOString(), removed }, null, 2)}\n`,
    )
  }
  return { directory, removed, alreadyStripped: removed.length === 0 && Boolean(priorRecord) }
}

const invokedDirectly = process.argv[1]
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))

/* `|| process.argv[2]` USED TO BE HERE. DO NOT PUT IT BACK.
 *
 * It made this module self-execute inside ANY process that happened to have a
 * second argument, whether or not this file was the entry point. That was
 * harmless while nothing imported it, and it broke the 1.0.33 build the moment
 * the afterPack hook did: inside electron-builder, process.argv[2] is `--win`,
 * so importing this module ran stripBuildDiagnostics('--win') and refused
 * because no such directory exists. The build died at packaging, blaming a
 * missing release directory that was never meant to be looked for.
 *
 * A module that runs its CLI on import cannot be a library, and this one has to
 * be both -- the litter list belongs in exactly one place, and the hook has to
 * read it from here. Entry-point detection is the whole test; a stray argument
 * is not evidence of anything.
 */
if (invokedDirectly) {
  const target = process.argv[2] || 'release'
  const { directory, removed } = await stripBuildDiagnostics(target)
  console.log(
    removed.length > 0
      ? `[strip-build-diagnostics] ${directory} -> removed ${removed.join(', ')}`
      : `[strip-build-diagnostics] ${directory} -> nothing to strip (already stripped by an earlier run)`,
  )
}

export { stripBuildDiagnostics, stripPackedLitter, DIAGNOSTIC_FILES, RUNTIME_LOG_LITTER }
