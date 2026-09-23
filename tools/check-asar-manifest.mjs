#!/usr/bin/env node

/* Assert that the built application actually contains what it declares.
 *
 * WHY THIS EXISTS. On 2026-08-10 a shipped build was diagnosed as missing its
 * own entry point -- "the app has no entry point", "shell/main.cjs IS NOT IN
 * THE ARCHIVE" -- and the diagnosis was wrong. The archive was correct. The
 * reader used to inspect it printed a header count of 51 and then listed only
 * the first 40 entries, and the 11 it never printed were exactly the 11
 * declared missing. A tool that silently truncates its own output produced a
 * false root cause that a second person then acted on.
 *
 * So this gate does three things, and none of them is optional decoration:
 *
 *   1. It checks that every file the build declares is in the archive, and
 *      that the archive's declared `main` resolves to an entry that exists.
 *      That is the cheap check nobody was running.
 *
 *   2. It checks ITSELF. The walk's entry count must equal the header's own
 *      file count before any conclusion is drawn from the listing. A reader
 *      that stops early can no longer report a clean or a dirty result -- it
 *      reports that it cannot be trusted, which is the only honest output of a
 *      measurement that did not finish.
 *
 *   3. It makes the archive STATE WHAT IT IS. See below.
 *
 * WHY (3) EXISTS. On 2026-08-11 the installed application was measured against
 * the source tree and did not contain that night's port-keyed-storage fix: the
 * fix's seven identifiers appeared 0 times in the shipped app.asar while a
 * control string appeared once, proving the scan worked. The fix greps as
 * present in the checkout and is absent from the thing a customer installs --
 * and nothing anywhere could see the gap, because the artifact carried no
 * statement of which commit it came from.
 *
 * require-clean-tree.mjs already writes exactly that statement, and its own
 * header promises the record "ships inside the package -- inspectable by anyone
 * holding only the .exe". MEASURED: dist/build-info.json was absent from all
 * three app.asar files on this machine (the installed 01:31 build, the 02:59
 * release/win-unpacked build, and a 22:07 verification build). The promise was
 * never kept by any artifact, because require-clean-tree only writes the record
 * when it RUNS, and `electron-builder --win nsis` invoked directly produces a
 * complete, fully-formed installer without it.
 *
 * That is this project's recurring defect in the release layer: an absence read
 * as consent. An archive with no provenance passed every gate here, in
 * check-no-owner-data, in check-license-notices, in check-payload-boundary and
 * in smoke-packaged, because not one of them asked the question. So a build
 * that skipped the provenance gate was indistinguishable from one that passed
 * it, which is the precise failure require-clean-tree's header says it exists
 * to prevent. Missing provenance is now a REFUSAL, not a silence.
 *
 * The asar format is documented and node reads it directly: 4 bytes, 4 bytes
 * pickle size, 4 bytes string size, 4 bytes JSON length, the JSON header, then
 * the file bytes at 4-byte alignment. No extraction tool is required, and the
 * absence of one is not a reason to leave a packaged artifact unverified.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* The archive entry require-clean-tree.mjs writes and build.files ships. Named
   once, here, because this string is the whole contract between the two files. */
export const PROVENANCE_ENTRY = 'dist/build-info.json'

/* The SAME variable that authorises building from a dirty tree authorises
   shipping the result. Deliberately not a second switch: a gate whose escape
   hatch is different from the one that created the condition is a gate people
   learn to route around. Spelled out rather than imported from
   require-clean-tree.mjs, which runs work at module scope -- the same reason
   check-payload-current.mjs duplicates resolveSource() instead of importing it. */
const DIRTY_OVERRIDE_VARIABLE = 'MC_ALLOW_DIRTY_BUILD'

function readArchive(archivePath) {
  const fd = openSync(archivePath, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const jsonLength = head.readUInt32LE(12)
    const jsonBuffer = Buffer.alloc(jsonLength)
    readSync(fd, jsonBuffer, 0, jsonLength, 16)
    const header = JSON.parse(jsonBuffer.toString('utf8'))
    const baseOffset = 16 + Math.ceil(jsonLength / 4) * 4

    const entries = []
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const full = prefix ? `${prefix}/${name}` : name
        if (child.files) walk(child, full)
        else entries.push({ path: full, size: child.size, offset: Number(child.offset) })
      }
    }
    walk(header, '')

    const countHeaderFiles = (node) => Object.values(node.files || {})
      .reduce((total, child) => total + (child.files ? countHeaderFiles(child) : 1), 0)

    return { entries, headerCount: countHeaderFiles(header), baseOffset, fd: null, archivePath, jsonLength }
  } finally {
    closeSync(fd)
  }
}

function readEntry(archivePath, entry, baseOffset) {
  const fd = openSync(archivePath, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    if (entry.size > 0) readSync(fd, buffer, 0, entry.size, baseOffset + entry.offset)
    return buffer
  } finally {
    closeSync(fd)
  }
}

function filesUnder(directory, prefix) {
  const out = []
  const walk = (current, relative) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, item.name)
      const rel = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) walk(next, rel)
      else out.push(`${prefix}/${rel}`)
    }
  }
  if (existsSync(directory)) walk(directory, '')
  return out
}

/* WHAT THIS ARCHIVE SAYS IT IS, decided from the record alone.
 *
 * Split out from main() and exported so the decision can be exercised against
 * hand-built records without packaging a 100MB installer to reach it. Returns
 * { problems, notes } rather than printing, so a caller cannot mistake a
 * console line for a verdict.
 *
 * `record` is null when the archive has no provenance entry at all, which is
 * the case this function exists for. Every other shape it can be handed --
 * unparseable, missing ref, wrong schema -- is also unknown provenance and gets
 * the same refusal, because "the record is there but says nothing" and "there
 * is no record" are the same fact about the artifact.
 */
export function judgeProvenance(record, { headRef = null, dirtyOverridden = false } = {}) {
  const problems = []
  const notes = []

  if (record === null) {
    problems.push(
      `the archive contains no ${PROVENANCE_ENTRY}, so it cannot state which commit it was built from. `
        + 'require-clean-tree.mjs writes that record and the `dist` chain runs it before electron-builder, '
        + 'so an archive without it was packaged off the ship path -- `electron-builder` invoked directly. '
        + 'Nothing downstream can tell such a build apart from a gated one, which is how a shipped installer '
        + 'came to be missing a fix that was present in the checkout. Build with `npm run dist`.',
    )
    return { problems, notes }
  }

  if (typeof record !== 'object' || Array.isArray(record)) {
    problems.push(`${PROVENANCE_ENTRY} is not a provenance record (got ${Array.isArray(record) ? 'an array' : typeof record}); this archive's provenance is unreadable, which is not the same as clean`)
    return { problems, notes }
  }

  const ref = typeof record.ref === 'string' ? record.ref.trim() : ''
  if (!ref) {
    problems.push(`${PROVENANCE_ENTRY} names no commit (\`ref\` is ${JSON.stringify(record.ref)}), so the record is present but says nothing about where these bytes came from`)
  }

  /* An UNKNOWN dirty flag is not a clean one. require-clean-tree writes
     dirty:false only after measuring BOTH repositories; a record that omits the
     field was written by something else, and the honest reading of "the field
     that says whether this is reproducible is absent" is not "it is". */
  if (record.dirty !== false && record.dirty !== true) {
    problems.push(`${PROVENANCE_ENTRY} does not state whether the trees were clean (\`dirty\` is ${JSON.stringify(record.dirty)}); an unstated provenance claim is not a clean one`)
  } else if (record.dirty === true) {
    const files = Array.isArray(record.dirtyFiles) ? record.dirtyFiles : []
    const detail = files.length ? `\n      ${files.join('\n      ')}` : ''
    if (dirtyOverridden) {
      notes.push(`SHIPPING A DIRTY BUILD: ${DIRTY_OVERRIDE_VARIABLE}=1, and ${files.length} uncommitted path(s) are inside this artifact. It cannot be reproduced from git history.${detail}`)
    } else {
      problems.push(
        `${PROVENANCE_ENTRY} records dirty:true -- these bytes cannot be reproduced from git history, and ${files.length} uncommitted path(s) are inside the artifact.${detail}\n`
          + `    If that is deliberate, set ${DIRTY_OVERRIDE_VARIABLE}=1, the same variable that authorised building it. That does not hide the fact: the record ships inside the package.`,
      )
    }
  }

  if (ref) {
    notes.push(`built from ${ref.slice(0, 12)}${record.dirty === true ? ' (DIRTY)' : ''}${record.checkedAt ? ` at ${record.checkedAt}` : ''}`)
    /* REPORTED, NOT REFUSED, and the reason is written down so nobody
       "tightens" it later without knowing the cost. Around ten lanes share this
       checkout, so HEAD moves during the three minutes electron-builder takes;
       failing here would red a correct build because an unrelated lane
       committed mid-package. The file already states the principle: an
       over-strict gate that rejects correct builds gets deleted, and then
       nothing is checked. Naming both commits ends the silence, which is the
       defect -- the shipped artifact being stale was invisible, not disputed. */
    if (headRef && headRef !== ref) {
      notes.push(`THIS IS NOT THE CURRENT CHECKOUT: the archive was built from ${ref.slice(0, 12)}, the checkout is at ${headRef.slice(0, 12)}. Anything committed in between is NOT in this artifact.`)
    }
  }

  return { problems, notes }
}

function headRefOf(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true })
  return result.status === 0 ? result.stdout.trim() : null
}

/* What the build declares it ships. Only the unambiguous half of the
 * electron-builder `files` grammar is enforced: a `dir/**` pattern means every
 * file under dir/ on disk, and a bare path means that exact file. Negations
 * and anything cleverer are skipped rather than guessed at -- an over-strict
 * gate that rejects correct builds gets deleted, and then nothing is checked. */
function declaredFiles(buildFiles, sourceRoot) {
  const expected = new Set()
  const skipped = []
  const missingInputs = []
  for (const pattern of buildFiles || []) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) { skipped.push(pattern); continue }
    const globSuffix = /^([^*?]+)\/\*\*$/.exec(pattern)
    if (globSuffix) {
      const directory = path.join(sourceRoot, globSuffix[1])
      if (!existsSync(directory)) {
        missingInputs.push(globSuffix[1])
        continue
      }
      for (const file of filesUnder(directory, globSuffix[1])) expected.add(file)
      continue
    }
    if (!/[*?]/.test(pattern)) {
      if (existsSync(path.join(sourceRoot, pattern))) expected.add(pattern)
      continue
    }
    skipped.push(pattern)
  }
  return { expected: [...expected].sort(), skipped, missingInputs }
}

function main() {
  const target = process.argv[2] || path.join(REPO_ROOT, 'release', 'win-unpacked')
  const unpacked = path.resolve(target)
  const archivePath = path.join(unpacked, 'resources', 'app.asar')
  const problems = []

  if (!existsSync(archivePath)) {
    console.error(`check-asar-manifest: no archive at ${archivePath}`)
    process.exitCode = 1
    return
  }

  const archive = readArchive(archivePath)

  // Self-check first. Nothing below may be believed until this passes.
  if (archive.entries.length !== archive.headerCount) {
    console.error(
      `check-asar-manifest: REFUSING TO REPORT. The walk produced ${archive.entries.length} entries but the ` +
        `header declares ${archive.headerCount}. This reader did not finish, so neither a pass nor a fail ` +
        'from it would mean anything. Fix the walk before trusting any result.',
    )
    process.exitCode = 2
    return
  }
  console.log(`check-asar-manifest: read ${archive.entries.length} entries (header agrees) from ${archivePath}`)

  const present = new Set(archive.entries.map((entry) => entry.path))

  // 1. The declared main must exist inside the archive.
  const packageEntry = archive.entries.find((entry) => entry.path === 'package.json')
  if (!packageEntry) problems.push('the archive contains no package.json, so it declares no entry point')
  else {
    const packaged = JSON.parse(readEntry(archivePath, packageEntry, archive.baseOffset).toString('utf8'))
    const main = packaged.main || 'index.js'
    if (!present.has(main)) problems.push(`the archive declares "main": "${main}" but contains no such entry -- Electron would exit silently with code 0`)
    else console.log(`check-asar-manifest: declared main ${main} is present`)
  }

  // 2. The archive must state what it is. An archive that cannot is refused.
  const provenanceEntry = archive.entries.find((entry) => entry.path === PROVENANCE_ENTRY)
  let record = null
  if (provenanceEntry) {
    try {
      record = JSON.parse(readEntry(archivePath, provenanceEntry, archive.baseOffset).toString('utf8'))
    } catch (error) {
      record = `unparseable: ${error.message}`
    }
  }
  if (typeof record === 'string') {
    problems.push(`${PROVENANCE_ENTRY} is present but not valid JSON (${record}), so this archive's provenance is unreadable -- which is not the same as clean`)
  } else {
    const provenance = judgeProvenance(record, {
      headRef: headRefOf(REPO_ROOT),
      dirtyOverridden: process.env[DIRTY_OVERRIDE_VARIABLE] === '1',
    })
    problems.push(...provenance.problems)
    for (const note of provenance.notes) console.log(`check-asar-manifest: provenance -- ${note}`)
  }

  // 3. Everything the build config declares must be in the archive.
  const buildConfig = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).build || {}
  const { expected, skipped, missingInputs } = declaredFiles(buildConfig.files, REPO_ROOT)
  if (missingInputs.length) {
    problems.push(`build.files declares source directories that do not exist, so their contents could not be checked:\n    ${missingInputs.join('\n    ')}`)
  }
  /* A BUILD THAT DECLARES NOTHING MUST NOT REPORT "all 0 declared files are
     present". Same defect class as the missing provenance record, one function
     lower: `.build || {}` turns an absent build config into an empty one, an
     empty one expands to an empty expectation set, and every file check below
     then passes vacuously over an archive nobody compared against anything.
     The gate would print a green line while measuring zero things. */
  if (!expected.length) {
    problems.push(
      'package.json declares no shippable files this gate can enforce (build.files is absent, empty, or entirely patterns this gate skips), '
        + 'so the file check below would have compared the archive against nothing and printed a pass. Refusing instead.',
    )
  }
  const missing = expected.filter((file) => !present.has(file))
  if (missing.length) {
    problems.push(`${missing.length} declared file(s) are absent from the archive:\n    ${missing.join('\n    ')}`)
  } else {
    console.log(`check-asar-manifest: all ${expected.length} declared files are present`)
  }
  if (skipped.length) console.log(`check-asar-manifest: patterns not enforced (negations/complex globs): ${skipped.join(', ')}`)

  // 3b. The Google sign-in carrier ships with an empty or a PRODUCT client id,
  //     never the vault project's. The 840383906222 client proved the flow
  //     against Google's real servers, but it is registered in the owner's
  //     personal project and docs/GOOGLE-SIGN-IN-SETUP.md forbids shipping it.
  //     An empty clientId is the honest pre-registration state and passes with
  //     a printed note; a populated one must be Google-shaped and not the
  //     forbidden client.
  const googleEntry = archive.entries.find((entry) => entry.path === 'config/google-signin.json')
  if (googleEntry) {
    let googleConfig = null
    try {
      googleConfig = JSON.parse(readEntry(archivePath, googleEntry, archive.baseOffset).toString('utf8'))
    } catch (error) {
      problems.push(`config/google-signin.json ships but is not valid JSON (${error.message}) -- every install would report the config as unreadable instead of not-configured`)
    }
    if (googleConfig) {
      const clientId = typeof googleConfig.clientId === 'string' ? googleConfig.clientId.trim() : ''
      if (!clientId) {
        console.log('check-asar-manifest: google sign-in carrier ships with an empty clientId -- sign-in reports not-configured until the product client is registered (docs/GOOGLE-SIGN-IN-SETUP.md)')
      } else if (clientId.startsWith('840383906222-')) {
        problems.push('config/google-signin.json ships the VAULT project\'s OAuth client (840383906222-*). That client is registered in the owner\'s personal project and must never ship; register the product\'s own Desktop client instead.')
      } else if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
        problems.push(`config/google-signin.json ships a clientId that is not in the form Google issues (${clientId.slice(0, 40)}...) -- every install would refuse it as invalid`)
      } else {
        console.log('check-asar-manifest: google sign-in ships a product client id')
      }
    }
  }

  // 4. The capability layer is an extraResource, so it is NOT in the archive --
  //    it sits beside it. A build that ships the viewer alone is the exact
  //    defect this whole lane exists to close, so its absence is a failure
  //    here rather than something discovered on a customer's machine.
  const capabilityRoot = path.join(unpacked, 'resources', 'capability')
  const payloadFile = path.join(capabilityRoot, 'PAYLOAD.json')
  if (!existsSync(payloadFile)) {
    problems.push(`no capability payload at ${payloadFile} -- this build ships the viewer with nothing behind it`)
  } else {
    const payload = JSON.parse(readFileSync(payloadFile, 'utf8'))
    const entry = path.join(capabilityRoot, payload.bridgeEntrypoint || '')
    if (!payload.bridgeEntrypoint || !existsSync(entry)) {
      problems.push(`the capability payload names bridge entrypoint "${payload.bridgeEntrypoint}", which is not present`)
    } else {
      const size = statSync(entry).size
      console.log(`check-asar-manifest: capability payload present -- ${payload.fileCount} files, bridge entrypoint ${payload.bridgeEntrypoint} (${size} bytes)`)
    }

    // hostModules is the same kind of claim as bridgeEntrypoint -- a relative
    // path the payload asserts is really staged under capabilityRoot -- and
    // gets the same check. Without this, PAYLOAD.json could list a module
    // (e.g. the setup screen's machine-record.js/workspace.js) that never
    // actually got staged, and nothing before a customer's own require()
    // would have noticed.
    const hostModules = Array.isArray(payload.hostModules) ? payload.hostModules : []
    const missingHostModules = hostModules.filter((relative) => !existsSync(path.join(capabilityRoot, relative)))
    if (missingHostModules.length) {
      problems.push(`the capability payload declares hostModules not present on disk:\n    ${missingHostModules.join('\n    ')}`)
    } else if (hostModules.length) {
      console.log(`check-asar-manifest: all ${hostModules.length} declared hostModules are present`)
    }

    if (payload.ownerHostModule !== 'src/owner-host.js'
        || !hostModules.includes(payload.ownerHostModule)
        || !existsSync(path.join(capabilityRoot, payload.ownerHostModule))) {
      problems.push('the capability payload does not carry its declared app-owned agent-session authority')
    }

    if (payload.ownerDataClean !== true) {
      problems.push('the capability payload is marked ownerDataClean:false; it carries builder-identifying data and must not ship')
    }
  }

  if (problems.length) {
    console.error('\ncheck-asar-manifest FAILED:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('check-asar-manifest: OK')
}

/* Guarded so a test can import judgeProvenance without this file walking an
   archive and setting an exit code as a side effect of the import -- the same
   hazard check-payload-current.mjs and require-clean-tree.mjs both call out
   about pack-capability-layer.mjs. Direct invocation is unchanged. */
const invokedDirectly = process.argv[1]
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))

if (invokedDirectly) main()
