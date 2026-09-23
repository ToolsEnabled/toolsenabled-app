#!/usr/bin/env node

/* DOES A SILENT UNINSTALL ACTUALLY GO SILENTLY, AND DOES ITS EXIT CODE MEAN
 * ANYTHING?
 *
 * WHY THIS EXISTS. The coordination board recorded, from a dogfood run:
 * "Uninstaller ignores /S: opens a modal 'Are you sure?' dialog and blocks
 * forever while returning exit 0 to the caller." Two claims. Measured against
 * the shipped 1.0.3 uninstaller on 2026-08-11, ONE of them is true.
 *
 *   SILENCE IS HONOURED. Run as the registered QuietUninstallString does
 *   ("Uninstall ToolsEnabled.exe" /currentuser /S), no window ever appeared and
 *   the install directory went from 337 files to removed. app-builder-lib
 *   26.15.3's uninstaller.nsh gates the one-click confirmation behind
 *   ${If} ${Silent}, and _CHECK_APP_RUNNING's "app is running" box carries
 *   /SD IDOK, so it auto-answers under /S. Verified byte-identical to the
 *   pristine npm tarball -- this is stock upstream behaviour, not a local patch.
 *
 *   THE EXIT CODE IS A LIE ABOUT COMPLETION, AND THAT HALF IS REAL. The process
 *   the caller waits on returned 0 after 1072 ms with the uninstall not yet
 *   begun -- all 337 files still present -- because an NSIS uninstaller invoked
 *   without `_?=` copies itself to $TEMP and re-execs detached. The work is then
 *   done by a child (Un_A.exe) whose exit code nobody can observe. So a caller
 *   -- winget, an MDM push, an upgrade script -- is told "uninstalled" while the
 *   uninstall is still running, and would be told exactly the same thing if the
 *   child failed outright.
 *
 * A control that reports success without checking is the house defect in its
 * plainest form, so this proof asserts COMPLETION AGAINST THE DISK and treats
 * the caller-visible exit code as evidence about honesty, never as the verdict.
 *
 * SAFETY. It refuses to run against a real installation. Point it at a COPY:
 *
 *   robocopy "%LOCALAPPDATA%\Programs\toolsenabled" C:\some\copy /MIR
 *   node tools/uninstaller-silent-proof.mjs C:\some\copy
 *
 * Note that a real uninstaller also deletes this product's HKCU registry keys
 * and its shortcuts, wherever it is run from. Snapshot and restore them
 * (reg export / reg import) around this proof, or run it on a machine whose
 * install you are willing to lose.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const UNINSTALLER = 'Uninstall ToolsEnabled.exe'
const REAL_INSTALL_MARKER = `${path.sep}Programs${path.sep}toolsenabled`
const COMPLETION_TIMEOUT_MS = 120_000
const POLL_MS = 500

const rawTarget = process.argv[2]
if (!rawTarget || !String(rawTarget).trim()) {
  console.error('[uninstaller-silent-proof] REFUSED: an explicit target directory argument is required; an omitted argument must never resolve to the current directory.')
  process.exit(2)
}
const target = path.resolve(rawTarget)
let failed = false
function fail(message) {
  console.error(`[uninstaller-silent-proof] FAIL: ${message}`)
  failed = true
}

const countFiles = (directory) => {
  let total = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // The uninstaller can remove a directory between the existence check and
      // this read. Any other read failure is not evidence that no files remain.
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name))
      else total += 1
    }
  }
  walk(directory)
  return total
}

async function main() {
  if (!target || !fs.existsSync(target)) {
    fail(`no directory at ${target || '<none given>'} -- pass a COPY of an installation`)
    return
  }
  if (target.toLowerCase().includes(REAL_INSTALL_MARKER.toLowerCase())) {
    fail(`${target} looks like the real installation. Point this at a copy; it deletes what it is given.`)
    return
  }
  const uninstaller = path.join(target, UNINSTALLER)
  if (!fs.existsSync(uninstaller)) {
    fail(`no ${UNINSTALLER} in ${target}`)
    return
  }

  const before = countFiles(target)
  console.log(`[uninstaller-silent-proof] before: ${before} files`)

  /* Exactly the registered QuietUninstallString shape. */
  const started = Date.now()
  const child = spawn(uninstaller, ['/currentuser', '/S'], { windowsHide: true, stdio: 'ignore', detached: false })
  const callerExit = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(null))
  })
  const callerMs = Date.now() - started
  const filesWhenCallerReturned = countFiles(target)

  console.log(`[uninstaller-silent-proof] the process the caller waits on exited ${callerExit} after ${callerMs}ms`)
  console.log(`[uninstaller-silent-proof]   files still present at that moment: ${filesWhenCallerReturned}`)

  /* THE ACTUAL QUESTION: did the uninstall happen, silently, without anyone
     having to answer a dialog? Measured against the disk, on a bounded wait. */
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS
  let remaining = filesWhenCallerReturned
  while (Date.now() < deadline) {
    remaining = fs.existsSync(target) ? countFiles(target) : 0
    if (remaining === 0) break
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  const completedMs = Date.now() - started

  if (remaining !== 0) {
    fail(
      `${remaining} of ${before} files remain ${COMPLETION_TIMEOUT_MS}ms after a /S uninstall. `
      + 'Nothing answered a dialog, so if this build shows one under /S it is blocking here -- '
      + 'which is the reported "opens a modal and blocks forever".',
    )
    return
  }
  console.log(`[uninstaller-silent-proof] PASS silence: the uninstall completed with no dialog, ${completedMs}ms`)

  /* THE HONESTY OF THE CODE, REPORTED SEPARATELY AND NEVER CONFLATED WITH THE
     ABOVE. If the caller was told "0" while files were still on disk, that zero
     was not a statement about the uninstall. */
  if (callerExit === 0 && filesWhenCallerReturned > 0) {
    fail(
      `the caller was told exit 0 after ${callerMs}ms while ${filesWhenCallerReturned} files were still installed. `
      + 'That code is not a completion signal: NSIS re-execs a temp copy when no _?= is given, and the child that '
      + 'does the work reports to nobody. An automated uninstall cannot tell success from failure. '
      + "electron-builder's own upgrade path avoids this with ExecWait '\"$exe\" /S ... _?=$INSTDIR'.",
    )
    return
  }
  if (callerExit !== 0) {
    fail(`the caller-visible exit code was ${callerExit}, not 0, for an uninstall that did complete`)
    return
  }
  console.log('[uninstaller-silent-proof] PASS exit code: the caller-visible code described a finished uninstall')
}

await main().catch((error) => {
  fail(`could not inspect the target: ${error instanceof Error ? error.message : String(error)}`)
})
process.exit(failed ? 1 : 0)
