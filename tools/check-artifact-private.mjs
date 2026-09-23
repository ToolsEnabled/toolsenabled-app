#!/usr/bin/env node

/* Refuse an artefact that carries a secret CONTAINER or this machine's identity.
 *
 * OWNER RULING R1191: "The cut must carefully make sure my private info does not
 * make it out period." R1180 adds that this is a CUT concern only -- the live
 * working tree keeps its own files, and nothing here touches them.
 *
 * WHAT ALREADY EXISTED, SO THAT THIS ADDS ONLY WHAT WAS MISSING.
 * Three guards already run over the built artefact in `npm run dist`:
 *   - check-no-owner-data.mjs   scans CONTENT for the builder's identity and
 *                               home-directory paths (all three encodings).
 *   - check-payload-boundary.mjs classifies every staged path against
 *                               config/payload-boundary.json.
 *   - check-payload-current.mjs hashes every staged file against its source.
 * None of them answers "is a credential CONTAINER present, by name" over the
 * BUILT tree, and none of them looks for the machine SID at all. Those two gaps
 * are what this step closes; it deliberately does not restate what the three
 * above already prove.
 *
 * THE FILENAME RULE IS IMPORTED, NOT RESTATED. pack-capability-layer.mjs already
 * owns assertNoSecretMaterial() and applies it when STAGING. The same rule has to
 * hold over the BUILT tree, because staging is not the only way bytes get there:
 * extraResources are copied by electron-builder, and a payload copied by hand
 * after a local run carries whatever that run wrote. Importing the function
 * rather than copying its lists is the point -- two copies of a security list
 * drift, and the copy that drifts is the one nobody is looking at. A rule added
 * to the packer is enforced here the same day, with no second edit.
 *
 * THE SID IS MATCHED BY SHAPE AND NEVER PRINTED. A Windows machine SID
 * (S-1-5-21-<four sub-authorities>) identifies the computer this was built on and
 * appears in ACL dumps, scheduled-task XML and installer logs. It is reported by
 * FILE and COUNT only: a guard that prints the identifier it is trying to keep
 * out of the artefact has written it into the build log instead, which is a
 * different file with a longer life. The excerpt style the owner-data guard uses
 * is right for a home-directory path and wrong for this.
 */

import { readdir, readFile, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { assertNoSecretMaterial } from './pack-capability-layer.mjs'

/* EVERY REFUSAL NAMES ITS RULE CLASS, so a red build is actionable from the log
 * line alone. Without this the reader gets a path and has to open the file and
 * guess which rule objected -- and the three classes have three different
 * remedies: a container is removed from the build, a run record is excluded by
 * the cut, a machine SID means something is embedding build-host identity and the
 * fix is upstream of packaging entirely. The SID class still reports file and
 * count only; naming the class reveals nothing about the value. */
const RULE_CLASS = {
  container: '[container-shape]',
  runRecord: '[owner-run-record]',
  machineSid: '[machine-sid]',
  toolingRepo: '[tooling-not-shipped]',
  /* Deliberately a SEPARATE class from machineSid, because the chain already
     reasons about "could not look" and "not there" as different answers and a
     reader must be able to tell them apart from the log line alone. machineSid
     means a SID was FOUND in the artefact and the fix is upstream of packaging.
     sidUnreadable means the exact-value check never ran, the artefact is
     UNCHECKED rather than dirty, and the fix is on the build host. */
  sidUnreadable: '[machine-sid-unreadable]',
}

/* THE TOOLING REPO MUST NOT REACH THE INSTALLER, and these nine files are why it
 * matters rather than being a tidiness rule.
 *
 * Lane A3 measured 34 added lines carrying the literal C:\Users\ToolsEnabled-Dev
 * across nine tooling files (27 lines in qualification-automation/, 7 in
 * live/test/). Those literals are CORRECT where they live: ACCOUNT-FENCE.md
 * mandates the fence and the person's R1179 keeps them hardcoded -- one of those
 * files runs under a live scheduled task. They are not a defect to rewrite; they
 * are a reason the tooling repo must never be packaged.
 *
 * True today by construction: package.json's build.files is an allow-list
 * (dist/**, shell/**, config/google-signin.json, with !tools/** and
 * !node_modules/** explicit), and tooling/ is a SEPARATE REPOSITORY that the app
 * build never sees. MEASURED over the real 485-file artefact: zero of the nine,
 * and zero paths with a `qualification-automation` or `tooling` segment.
 *
 * This rule exists so that stops being an accident of configuration. Matched as a
 * path SUFFIX on segment boundaries, because if one ever shipped it would appear
 * under a prefix such as resources/app/. */
const TOOLING_REPO_FILES = [
  'qualification-automation/Invoke-AutomaticPreflight.ps1',
  'qualification-automation/Install-AutomaticPreflight.ps1',
  'qualification-automation/LIVE-DELIVERY-CHECKPOINT.md',
  'qualification-automation/Test-AutomaticPreflight.ps1',
  'qualification-automation/Test-InstallAutomaticPreflight.ps1',
  'qualification-automation/README.md',
  'qualification-automation/PRIVATE-UI-OWNERSHIP-NEXT.md',
  'live/test/resume-circle.test.mjs',
  'live/test/auto-live-ui-ownership.test.mjs',
]

function toolingRepoFiles(relativePaths) {
  const found = []
  for (const relative of relativePaths) {
    const match = TOOLING_REPO_FILES.find((candidate) => relative === candidate || relative.endsWith(`/${candidate}`))
    if (match) found.push(`${relative} -- tooling repo file ${match}`)
  }
  return found
}

/* OWNER RULING R1180: "WHEN CUT my profile stuff needs to be removed BUT LIVE
 * does not need it removed ; the cut should remove it."
 *
 * These are run records from the owner's own debugging sessions -- capture logs,
 * evaluation results, a cardroom evidence dump -- and the development probes that
 * produced them, one of which carries a hardcoded profile path and a fixture path.
 * They are legitimate in the repository and in the running tree, which the ruling
 * says explicitly; what must not happen is that they leave the machine inside a
 * shipped installer.
 *
 * THIS IS A REGRESSION GUARD, NOT A REMOVAL, AND SAYING SO IS THE POINT.
 * `build.files` in package.json is an ALLOW-list -- `dist/**`, `shell/**`,
 * `config/google-signin.json`, with `!tools/**` and `!node_modules/**` explicit --
 * so none of these paths can reach the asar today, and the honest measurement is
 * that the artefact already carries zero of them. A step that claimed to "strip"
 * them would be claiming credit for electron-builder's allow-list. What this adds
 * is the thing the allow-list does not give you: a NAMED REFUSAL if that list is
 * ever widened, or if a future extraResources entry copies a tree wholesale.
 *
 * Matched on the artefact-relative path, anchored, so a legitimate file that
 * merely contains one of these words is not caught. */
const OWNER_RUN_RECORD_PATTERNS = [
  { label: 'owner capture/evaluation run records', regex: /(^|\/)captures-[^/]+\// },
  { label: 'owner evidence dump', regex: /(^|\/)evidence\// },
  { label: 'development probe carrying profile pins', regex: /(^|\/)w16[a-z]-[^/]+$/ },
]

function ownerRunRecords(relativePaths) {
  const found = []
  for (const relative of relativePaths) {
    const rule = OWNER_RUN_RECORD_PATTERNS.find((candidate) => candidate.regex.test(relative))
    if (rule) found.push(`${relative} -- ${rule.label}`)
  }
  return found
}

/* Four sub-authorities is what a machine SID has; the trailing RID is optional so
 * both the machine and an account on it are caught. The well-known short SIDs
 * (S-1-5-18 LocalSystem, S-1-5-32-544 Administrators) identify nobody and are not
 * matched -- they are the same for every Windows machine on earth, and matching
 * them would make this refuse ordinary manifests. */
const MACHINE_SID = /\bS-1-5-21-\d{6,}-\d{6,}-\d{6,}(-\d+)?\b/g

/* NOTHING IS SKIPPED, AND THE FIRST VERSION OF THIS FUNCTION GOT THAT WRONG.
 *
 * It skipped `.git` and `node_modules`, copied from the source-tree scanners where
 * those skips are correct and cheap. Over an ARTEFACT they are precisely backwards:
 * a `.git` directory inside a shipped tree is itself a defect, and `node_modules`
 * under `app.asar.unpacked` is shipped content, not build scaffolding. The skip made
 * both invisible to every rule in this step -- filenames, directories and SID alike.
 *
 * Found by this file's own test: the nested `.git/config` fixture failed while the
 * other five depth fixtures passed, which is the useful shape of failure -- one
 * fixture disagreeing with five is a defect in the walker, not in the rule. Had the
 * depth tests all been written at the root, this would have shipped. */
async function walk(directory, base, out) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((l, r) => l.name.localeCompare(r.name))) {
    const full = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await walk(full, base, out)
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

/* THE BUILDING ACCOUNT'S OWN SID, READ AT RUN TIME AND NEVER COMMITTED.
 *
 * The shape rule above already matches any S-1-5-21 machine SID, so this is a
 * REDUNDANCY rather than the primary control -- and it is worth having anyway,
 * because it is the one value we can be certain identifies THIS builder, and it
 * does not depend on the shape rule being right about the format.
 *
 * It is read, never stored: nothing here writes it to disk, to a fixture or to
 * the report, and the refusal below prints file and count only. A guard that
 * committed the identifier it exists to exclude would be self-defeating.
 *
 * T330. THIS USED TO RESOLVE `whoami` THROUGH PATH, AND THAT MADE THE GATE'S
 * STRENGTH A PROPERTY OF THE OPERATOR'S SHELL.
 *
 * Git for Windows, MSYS and Cygwin all ship a POSIX `whoami` that has no /user
 * switch, and all three put their bin directory ahead of the system directory
 * on PATH. On any such build host -- the common case on Windows -- the call
 * threw, the catch returned null, and the step fell back to the shape rule and
 * still printed "clean". MEASURED on the 1.0.45 Windows cut of app a4d37a5d:
 * `whoami` resolved to Git's copy first and the exact-value check did not run.
 *
 * The old code paired that fallback with a claim that made it look harmless --
 * "the shape rule is a superset for every S-1-5-21 value". It is not. The shape
 * rule requires each sub-authority to be at least six digits (see MACHINE_SID),
 * so a machine whose SID has a shorter sub-authority is matched by neither rule
 * and the artefact ships unexamined under a green line.
 *
 * TWO CHANGES, and neither weakens the shape rule -- it still runs, unchanged,
 * on every platform, and the exact value remains a redundancy layered over it:
 *
 *   1. The binary is resolved by ABSOLUTE PATH inside the system directory, so
 *      nothing on PATH can stand in for it. Telling builders to clean their PATH
 *      would not be a fix: a gate that depends on operator environment is the
 *      defect, not the operator.
 *   2. A Windows host where the value cannot be read is now a REFUSAL, not a
 *      pass. A check that could not run is not a check that passed.
 *
 * NOT APPLICABLE IS NOT THE SAME AS UNREADABLE, and collapsing them would break
 * the Linux cut for no safety gain. `dist:linux` runs this same step over
 * release/linux-unpacked, where there is no Windows account and so no machine
 * SID to read; that is not a degraded Windows check, it is a check that does not
 * apply. Refusing there would refuse every Linux build forever. So the lookup
 * reports three distinct states and only one of them refuses. */
const SID_LOOKUP = { read: 'read', notApplicable: 'not-applicable', unreadable: 'unreadable' }

/* One line per state, so the log says which checks ran before it says what they
   found. The unreadable wording is phrased as the refusal it now is, rather than
   as the reassuring "shape rule ONLY" it used to print immediately before
   declaring the artefact clean. */
const SID_LOOKUP_LINE = {
  [SID_LOOKUP.read]: "shape rule + the building account's own SID (read at run time, not printed)",
  [SID_LOOKUP.notApplicable]: 'shape rule (the exact-value check does not apply off Windows, where there is no machine SID)',
  [SID_LOOKUP.unreadable]: "shape rule ran; the building account's SID could NOT be read, so this artefact is UNCHECKED for it -- refusing below",
}

/* Sysnative before System32: a 32-bit process on 64-bit Windows is redirected to
 * the 32-bit system directory when it names System32, and Sysnative is the only
 * name that reaches the real one. It does not exist for a 64-bit process, where
 * the existsSync filter drops it and System32 is already correct. Derived from
 * the environment rather than written out, so no machine path is hardcoded. */
function systemWhoamiCandidates() {
  const systemRoot = process.env.SystemRoot || process.env.windir
  if (!systemRoot) return []
  return [path.join(systemRoot, 'Sysnative', 'whoami.exe'), path.join(systemRoot, 'System32', 'whoami.exe')]
}

function buildingAccountSid() {
  if (process.platform !== 'win32') {
    return { status: SID_LOOKUP.notApplicable, reason: `there is no Windows machine SID on ${process.platform}` }
  }

  const candidates = systemWhoamiCandidates()
  if (candidates.length === 0) {
    return {
      status: SID_LOOKUP.unreadable,
      reason: 'neither SystemRoot nor windir is set, so the system directory could not be located',
    }
  }

  /* Every attempt is recorded so the refusal can say what was tried and what
     each one did. "It failed" is not actionable; "this path is not present, that
     one ran but returned no SID" is. */
  const attempts = []
  for (const executable of candidates) {
    if (!existsSync(executable)) {
      attempts.push(`${executable}: not present`)
      continue
    }
    try {
      const output = execFileSync(executable, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
      const match = /"(S-1-[0-9-]+)"/.exec(output)
      if (match) return { status: SID_LOOKUP.read, sid: match[1] }
      attempts.push(`${executable}: ran, but its output carried no SID`)
    } catch (error) {
      attempts.push(`${executable}: ${error?.code ?? error?.message ?? 'failed'}`)
    }
  }
  return { status: SID_LOOKUP.unreadable, reason: attempts.join('; ') }
}

/* Both encodings, for the same reason check-no-owner-data scans both: a SID
 * written into a PE VersionInfo block or any UTF-16 resource shares no byte
 * sequence with its ASCII form, so a single-byte scan cannot see it at any
 * offset. latin1 keeps one byte per character so offsets stay honest. */
function sidMatchCount(buffer, exactSid) {
  let count = 0
  for (const text of [buffer.toString('latin1'), buffer.toString('utf16le')]) {
    MACHINE_SID.lastIndex = 0
    while (MACHINE_SID.exec(text) !== null) count += 1
    /* Only counted when the shape rule did not already see it, so one SID in one
       file is reported as one occurrence rather than two. */
    if (exactSid && !MACHINE_SID.test(exactSid)) {
      let from = text.indexOf(exactSid)
      while (from !== -1) { count += 1; from = text.indexOf(exactSid, from + exactSid.length) }
    }
  }
  return count
}

async function main() {
  const root = process.argv[2]
  if (!root) {
    throw new Error('name the artefact directory to check, e.g. check-artifact-private.mjs release/win-unpacked')
  }
  const resolved = path.resolve(root)

  /* Absence is not cleanliness. Same refusal shape as check-no-owner-data and
     require-clean-tree: a gate that cannot reach what it checks must refuse. */
  let rootStat
  try {
    rootStat = await lstat(resolved)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`nothing to check: directory does not exist: ${root}`)
    throw error
  }
  if (rootStat.isSymbolicLink()) throw new Error(`nothing to check: refusing to follow symlink: ${root}`)
  if (!rootStat.isDirectory()) throw new Error(`nothing to check: not a directory: ${root}`)

  const relativePaths = await walk(resolved, resolved, [])
  if (relativePaths.length === 0) throw new Error(`nothing to check: scanned 0 files in ${root}`)

  console.log(`[check-artifact-private] scanning ${relativePaths.length} files under ${resolved}`)

  /* Names first: it is a string test over the list already walked, so a payload
     carrying a key file fails in milliseconds instead of after reading it.
     Re-thrown with the class tag rather than editing the shared message: that
     wording is the packer's and is also shown at staging time, where this tag
     would be wrong. */
  try {
    assertNoSecretMaterial(relativePaths)
  } catch (error) {
    throw new Error(`${RULE_CLASS.container} ${error.message}`)
  }

  const runRecords = ownerRunRecords(relativePaths)
  if (runRecords.length > 0) {
    throw new Error(
      `${RULE_CLASS.runRecord} this artefact carries the owner's own run records, which the cut must not ship (R1180):\n  ` +
        runRecords.join('\n  ') +
        '\nThese stay in the repository and in the running tree; they do not leave the machine.',
    )
  }
  console.log(`[check-artifact-private] owner run records (R1180): 0 of ${relativePaths.length} files match`)

  const toolingFiles = toolingRepoFiles(relativePaths)
  if (toolingFiles.length > 0) {
    throw new Error(
      `${RULE_CLASS.toolingRepo} this artefact carries files from the tooling repository, which is not part of the installer:\n  ` +
        toolingFiles.join('\n  ') +
        '\nThose files legitimately hardcode the fence path (ACCOUNT-FENCE.md, owner rule R1179); they are not rewritten, they are not shipped.',
    )
  }
  console.log(
    `[check-artifact-private] tooling repo: 0 of ${TOOLING_REPO_FILES.length} fence-literal files present, across ${relativePaths.length} walked files`,
  )

  const sidLookup = buildingAccountSid()
  const exactSid = sidLookup.status === SID_LOOKUP.read ? sidLookup.sid : null
  console.log(`[check-artifact-private] machine SID: ${SID_LOOKUP_LINE[sidLookup.status]}`)

  const carriers = []
  let bytesScanned = 0
  for (const relative of relativePaths) {
    const buffer = await readFile(path.join(resolved, relative))
    bytesScanned += buffer.length
    const count = sidMatchCount(buffer, exactSid)
    if (count > 0) carriers.push({ relative, count })
  }

  if (carriers.length > 0) {
    /* File and count only. The value is deliberately absent -- see the header. */
    const detail = carriers.map(({ relative, count }) => `  ${relative} -- ${count} occurrence(s)`).join('\n')
    throw new Error(
      `${RULE_CLASS.machineSid} this artefact carries a machine SID, which identifies the computer it was built on:\n` +
        `${detail}\n` +
        '(the value is withheld from this message on purpose: printing it would move the identifier\n' +
        'into the build log instead of keeping it out of the artefact)',
    )
  }

  /* AFTER the scan, not before it, and that order is deliberate. A SID actually
     present in the artefact is the worse finding and must be the one reported:
     "we found the thing" outranks "we could not look for one of it". Refusing
     early would also cost the reader the shape rule's result, which is the only
     evidence they have left when the exact check is unavailable. */
  if (sidLookup.status === SID_LOOKUP.unreadable) {
    throw new Error(
      `${RULE_CLASS.sidUnreadable} the exact-value machine-SID check could not run, so this artefact is\n` +
        "UNCHECKED for the building account's own SID rather than shown to be clean of it:\n" +
        `  ${sidLookup.reason}\n` +
        `The shape rule did run over all ${relativePaths.length} files and found nothing, and that is\n` +
        'reported for what it is worth -- but it is not a substitute. It only matches an S-1-5-21\n' +
        'value whose sub-authorities are each at least six digits, so a shorter SID passes it unseen.\n' +
        'Could not look is not the same answer as not there, and a green cut over a check that never\n' +
        'ran is the failure this gate exists to prevent (R1228).\n' +
        'TO FIX, on the build host rather than in this file: whoami.exe must be present and runnable\n' +
        'at %SystemRoot%\\System32\\whoami.exe. This step resolves it there by absolute path on\n' +
        'purpose, so a POSIX whoami earlier on PATH (Git for Windows, MSYS, Cygwin) is no longer able\n' +
        'to stand in for it and is no longer the cause.',
    )
  }

  console.log(
    `[check-artifact-private] clean: ${relativePaths.length} files (${bytesScanned} bytes), ` +
      'no credential container by name, no machine SID (single-byte and UTF-16LE).',
  )
}

main().catch((error) => {
  console.error(`[check-artifact-private] REFUSING: ${error.message}`)
  process.exitCode = 1
})
