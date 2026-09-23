#!/usr/bin/env node
/* SEAL THE BUILT ARTIFACT, THEN PROVE THE REST OF THE CHAIN DID NOT TOUCH IT.
 *
 * THE DEFECT THIS EXISTS TO CATCH, measured on this repo on 2026-08-11. The
 * artifact at release/win-unpacked was built at 02:59. Its
 * resources/capability/state/ directory -- a live mission-bridge BEARER TOKEN,
 * a bootstrap proof, a runtime record, and audit.sqlite3 -- was written at
 * 04:11. Nothing had gone wrong with the packer. The BUILD CHAIN ITSELF wrote
 * those files, because its last two steps start the packaged application
 * against release/win-unpacked, and at the time the layer wrote its runtime
 * state next to itself.
 *
 * The ordering is what made it invisible. `npm run dist` ran
 * check-payload-boundary against resources/capability, and THEN ran
 * smoke-packaged and check-install-dir-immutable, both of which execute the
 * app. So the chain's own final steps contaminated the artifact that the
 * chain had already certified, after the certificate was issued. Every gate
 * was correct and every gate was green; a planted token makes all three refuse
 * the payload, naming `MUST NOT SHIP AT ALL (excluded): state/...`. They just
 * ran too early to see it.
 *
 * WHY THE EXISTING BYTE-COMPARISON DOES NOT COVER THIS.
 * tools/check-install-dir-immutable.mjs already hashes the install directory
 * and compares before against after -- but it takes its BEFORE hash at its own
 * start, which is after smoke-packaged has already run. Anything smoke left
 * behind is baked into that baseline, the final diff comes back empty, and the
 * check prints "the install directory is byte-unchanged after the session"
 * over a tree that was contaminated a minute earlier. It is a correct check of
 * its own phases and blind to everything before them. This file is the wider
 * span: sealed once when the artifact is finished, verified once when the
 * chain is finished, covering every step in between including ones nobody has
 * written yet.
 *
 * PREVENTING AND DETECTING ARE DIFFERENT AND THIS IS ONLY THE SECOND.
 * src/lib/runtime-state-root.js is the prevention: a payload carrying
 * PAYLOAD.json resolves state/, logs/, vault/, captures/, profiles/ and
 * reports/ to a per-user root instead of to itself, so the writes no longer
 * land in the artifact at all. That fix is why a run passes today. This file
 * asserts it is STILL true, on every build, and fails naming the exact files if
 * it ever stops being -- so the next person to reintroduce the defect is told
 * what happened rather than left to discover it in a shipped installer.
 *
 * WHY A WHOLE-TREE HASH RATHER THAN A LIST OF FORBIDDEN NAMES. A name list
 * only catches the contamination someone already thought of; state/ and
 * *.sqlite3 were not the whole of it even in the measured case (logs/, vault/
 * and captures/ were also live write targets). A seal catches any byte that
 * changes for any reason, which is the actual requirement: a finished artifact
 * must be finished. It costs about a second -- the tree is 356 MB across 325
 * files -- which is not a meaningful price next to shipping a bearer token.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* Still version 1: the seal gained builtSha/recordedHead/treeClean, and a
   version bump would have made every already-recorded v1 seal (and the
   immutability fixtures) unreadable for no gain.

   T392 CORRECTS WHAT THAT ONCE MEANT. It used to mean an older seal without
   provenance "verifies exactly as before", because verify() guarded the
   built-vs-artifact comparison on `parsed.builtSha`. Measured beside the
   published 1.0.45 installer: that seal carried no builtSha and no recordedHead
   and --verify passed over it, so an unbound artifact read as a verified one.
   The number stays; a seal that records no built commit is now refused by
   verify() rather than waved through. */
const SEAL_VERSION = 1

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const STALE_BINARY_CODE = 'ARTIFACT_SEAL_STALE_BINARY'
const BINARY_MISMATCH_CODE = 'ARTIFACT_SEAL_BINARY_MISMATCH'
const NO_PROVENANCE_CODE = 'ARTIFACT_SEAL_NO_BUILT_SHA'
/* T394: the binary carries a commit, and the publisher says which commit it
   meant to publish. Those are two facts and this is the one that compares
   them; without it a sound seal still proves nothing about WHICH tip shipped. */
const REF_MISMATCH_CODE = 'ARTIFACT_SEAL_NOT_THE_EXPECTED_REF'

/* THE COMMIT THE BINARY WAS BUILT FROM, READ OUT OF THE ARTIFACT ITSELF.
 *
 * T385 (R1228): a seal was written 31 minutes and three commits after the
 * binary it attested was built, so it certified a tree the binary did not
 * contain. A seal timestamp cannot catch that; the seal has to bind to the
 * commit the BINARY carries. check-dist-current.mjs records that commit into
 * dist/.dist-source.json (`appHead`) at build time, and dist/ is packed into
 * resources/app.asar, so the artifact states its own provenance. This reads it
 * from the packed asar (or an unpacked resources/app), never from HEAD -- HEAD
 * at seal time is exactly the thing that may have drifted. Returns null when the
 * artifact carries no such marker (an older build), which record() refuses. */
function builtAppHead(artifactDirectory) {
  const marker = 'dist/.dist-source.json'
  const asar = path.join(artifactDirectory, 'resources', 'app.asar')
  if (existsSync(asar)) {
    try {
      const asarModule = require(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
      const bytes = asarModule.extractFile(asar, marker)
      const parsed = JSON.parse(bytes.toString('utf8'))
      return typeof parsed.appHead === 'string' && parsed.appHead ? parsed.appHead : null
    } catch { /* fall through to the unpacked location */ }
  }
  const unpacked = path.join(artifactDirectory, 'resources', 'app', marker)
  if (existsSync(unpacked)) {
    try {
      const parsed = JSON.parse(readFileSync(unpacked, 'utf8'))
      return typeof parsed.appHead === 'string' && parsed.appHead ? parsed.appHead : null
    } catch { /* not readable */ }
  }
  return null
}

function gitLine(args) {
  const result = spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

/* HEAD and whether the tree is clean, at seal time, in the repo this tool lives
   in -- the tree the cut is sealing from. A dirty tree means the binary may not
   correspond to any commit at all.

   MC_SEAL_SOURCE_HEAD / MC_SEAL_SOURCE_CLEAN are a QA injection ONLY: a unit
   test seals a synthetic artifact that is not inside the cut worktree, so it
   states the source head/cleanliness the fake build corresponds to. The
   injection never disables the built-vs-source comparison below -- an injected
   head that disagrees with the artifact's own built sha still refuses -- it only
   supplies the head to compare against when there is no cut worktree to read. A
   real cut sets neither and the state comes from git. */
function sourceStateNow() {
  const injectedHead = (process.env.MC_SEAL_SOURCE_HEAD || '').trim()
  if (injectedHead) {
    return { head: injectedHead, clean: process.env.MC_SEAL_SOURCE_CLEAN === undefined ? true : process.env.MC_SEAL_SOURCE_CLEAN === '1', injected: true }
  }
  const head = gitLine(['rev-parse', 'HEAD'])
  const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
  const clean = status.status === 0 && status.stdout.trim() === ''
  return { head, clean, injected: false }
}

/* THE SEAL LIVES BESIDE THE ARTIFACT, NEVER INSIDE IT. A manifest written into
 * release/win-unpacked would be one more file the artifact did not have when it
 * was built -- this check would then be its own first offender, and worse, the
 * seal would be sealing itself. release/ is gitignored, so the sibling location
 * adds nothing to the repository either. */
export function sealPathFor(artifactDirectory) {
  const resolved = path.resolve(artifactDirectory)
  return path.join(path.dirname(resolved), `.artifact-seal-${path.basename(resolved)}.json`)
}

/* THE SEAL NAMES THE ARTIFACT BY BASENAME, NOT BY ABSOLUTE PATH, AND THAT IS A
 * PRIVACY REQUIREMENT RATHER THAN A STYLE CHOICE.
 *
 * This field used to hold `path.resolve(artifactDirectory)`. Measured on this
 * machine on 2026-08-11, that wrote
 *
 *   "artifact": "C:\\Users\\<account>\\<checkout>\\release\\win-unpacked"
 *
 * into release/.artifact-seal-win-unpacked.json on EVERY build -- the builder's
 * home directory and account name, in the output folder, written by the very
 * tool whose job is to certify that folder. `node tools/check-no-owner-data.mjs`
 * fails on it (built-in rule `C:\Users`, which is never excusable), and it is
 * written by `--record`, which runs AFTER tools/strip-build-diagnostics.mjs has
 * already swept the directory. So the existing sweep could never have caught it
 * and a green build ended with the leak in place.
 *
 * Deleting the seal afterwards would be the wrong fix twice over: --verify needs
 * it later in the same chain, and it regenerates on the next build anyway.
 *
 * WHY THE BASENAME IS STILL SUFFICIENT. The only thing the recorded identity has
 * to do is let --verify refuse a seal recorded against a DIFFERENT artifact
 * (see the check in verify()). sealPathFor puts the seal in the artifact's
 * PARENT directory, so a seal is a sibling of the artifact by construction and
 * the basename resolves unambiguously against the seal's own location. That
 * still distinguishes win-unpacked from other-unpacked, which is the confusion
 * the guard exists to stop; it merely stops recording which machine built it.
 *
 * Resolving relative to the seal's directory also keeps a seal recorded by the
 * OLD code working: path.resolve(dir, "C:\\...") returns the absolute path
 * unchanged, so a stale absolute seal still verifies in the tree that wrote it
 * instead of failing a build for a format change. */
function artifactIdentity(resolvedArtifact) {
  return path.basename(resolvedArtifact)
}

function resolveRecordedArtifact(sealPath, recorded) {
  return path.resolve(path.dirname(sealPath), recorded || '')
}

/* Directories the running product writes into, from the same list that
 * src/lib/runtime-state-root.js redirects. Used ONLY to explain a failure in
 * the language of the defect -- the seal itself compares bytes and needs no
 * such list, so a write to a directory that is not on it still fails. */
const RUNTIME_STATE_DIRECTORIES = new Set(['state', 'logs', 'vault', 'captures', 'profiles', 'reports'])

function looksLikeRuntimeState(relativePath) {
  if (/\.sqlite3(-wal|-shm)?$/i.test(relativePath)) return true
  return relativePath.split('/').some((segment) => RUNTIME_STATE_DIRECTORIES.has(segment))
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

/* Entries are keyed by forward-slash relative path so a seal recorded on one
   path separator verifies on another, and sorted so the file diffs readably. */
async function hashTree(root) {
  const entries = new Map()
  async function walk(directory) {
    const listing = await readdir(directory, { withFileTypes: true })
    for (const entry of listing) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      /* Anything that is not a plain file -- a symlink, a junction, a device --
         is recorded by kind rather than skipped. Skipping it would mean a step
         could replace a file with a symlink to somewhere else and the seal
         would call the artifact unchanged. */
      if (!entry.isFile()) {
        entries.set(relative, { kind: entry.isSymbolicLink() ? 'symlink' : 'other', sha256: null, bytes: null })
        continue
      }
      const info = await stat(full)
      entries.set(relative, { kind: 'file', sha256: await hashFile(full), bytes: info.size })
    }
  }
  await walk(root)
  return new Map([...entries].sort((left, right) => (left[0] < right[0] ? -1 : 1)))
}

function describe(entry) {
  if (!entry) return 'absent'
  if (entry.kind !== 'file') return entry.kind
  return `${entry.sha256.slice(0, 12)} (${entry.bytes} bytes)`
}

export function compare(recorded, observed) {
  const added = []
  const removed = []
  const changed = []
  for (const [relative, entry] of observed) {
    const before = recorded.get(relative)
    if (!before) {
      added.push(relative)
      continue
    }
    if (before.kind !== entry.kind || before.sha256 !== entry.sha256 || before.bytes !== entry.bytes) {
      changed.push(`${relative}  ${describe(before)} -> ${describe(entry)}`)
    }
  }
  for (const relative of recorded.keys()) if (!observed.has(relative)) removed.push(relative)
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

async function record(artifactDirectory, { expectRef = null } = {}) {
  const resolved = path.resolve(artifactDirectory)
  const tree = await hashTree(resolved)
  if (tree.size === 0) {
    console.error(`Artifact seal RECORD COULD NOT RUN: ${resolved} contains no files.`)
    console.error('Nothing was sealed. An empty artifact cannot be certified for release.')
    process.exitCode = 1
    return
  }
  /* T385: bind the seal to the commit the BINARY was built from, and refuse to
     seal a stale binary. The built commit is read from the artifact's own
     dist/.dist-source.json; HEAD and tree cleanliness are read from the source
     now. A seal may only be written when the binary was built from the current
     HEAD and the tree is clean -- otherwise the seal would attest a binary that
     predates commits it does not contain (the exact T385 defect). */
  const builtSha = builtAppHead(resolved)
  const { head, clean } = sourceStateNow()
  if (!builtSha) {
    console.error(`Artifact seal RECORD REFUSED (${NO_PROVENANCE_CODE}): ${resolved} carries no dist/.dist-source.json, `
      + 'so the commit it was built from cannot be read. Rebuild the renderer (check-dist-current --record) before sealing.')
    process.exitCode = 1
    return
  }
  if (head && builtSha !== head) {
    console.error(`Artifact seal RECORD REFUSED (${STALE_BINARY_CODE}): the binary was built from ${builtSha} `
      + `but the source HEAD is now ${head}. The tip moved between build and seal; a seal must never attest a stale `
      + 'binary. Rebuild at the current HEAD, then seal.')
    process.exitCode = 1
    return
  }
  if (!clean) {
    console.error(`Artifact seal RECORD REFUSED (${STALE_BINARY_CODE}): the binary was built from ${builtSha} but the `
      + `source tree at ${head || '(unknown HEAD)'} is dirty, so the binary corresponds to no committed state. `
      + 'Commit or clean the tree, rebuild, then seal.')
    process.exitCode = 1
    return
  }
  if (expectRef && builtSha !== expectRef) {
    console.error(`Artifact seal RECORD REFUSED (${REF_MISMATCH_CODE}): the binary was built from ${builtSha} but the `
      + `cut names ${expectRef} as the tip it is publishing. A seal that binds a different commit to the ref being `
      + 'published is how an artifact ships under a tip it does not carry. Build at that tip, then seal.')
    process.exitCode = 1
    return
  }
  const seal = sealPathFor(resolved)
  await writeFile(
    seal,
    `${JSON.stringify(
      {
        version: SEAL_VERSION,
        artifact: artifactIdentity(resolved),
        recordedAt: new Date().toISOString(),
        /* The commit the binary carries (from the artifact), and the source
           state at record time. builtSha === recordedHead by the refusals above;
           both are kept so a reader sees the seal proved they matched. */
        builtSha,
        recordedHead: head,
        treeClean: clean,
        files: Object.fromEntries(tree),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`seal binds built commit ${builtSha} (source HEAD ${head}, tree clean)`)
  console.log(`sealed ${tree.size} file(s) in ${resolved}`)
  console.log(`seal: ${seal}`)
  console.log(
    'Every step after this point must leave the artifact byte-identical. Run --verify once the\n' +
      'last step that starts the packaged application has finished.',
  )
}

async function verify(artifactDirectory, { expectRef = null } = {}) {
  const resolved = path.resolve(artifactDirectory)
  const seal = sealPathFor(resolved)

  /* FAIL CLOSED WHEN THE SEAL IS MISSING OR UNREADABLE. A verify with nothing
   * to compare against has not checked the artifact, and "could not check" must
   * never render as "checked and fine" -- that is the same defect class as the
   * owner-data guard that reported 0 offenders from a scan it never ran
   * (tools/pack-capability-layer.mjs). The realistic way to get here is someone
   * reordering the chain so --verify runs without its --record, which is
   * exactly the mistake this must shout about rather than absorb. */
  let parsed
  try {
    parsed = JSON.parse(await readFile(seal, 'utf8'))
  } catch (error) {
    console.error(`Artifact seal VERIFY COULD NOT RUN: ${seal} could not be read (${error.message}).`)
    console.error(
      '\nNothing was compared, so this says nothing about the artifact. The seal is written by\n' +
        '`node tools/seal-artifact.mjs --record <artifact>`, which must run immediately after the\n' +
        'last packaging step and before any step that starts the packaged application.',
    )
    process.exitCode = 1
    return
  }

  if (parsed?.version !== SEAL_VERSION || !parsed?.files || typeof parsed.files !== 'object') {
    console.error(`Artifact seal VERIFY COULD NOT RUN: ${seal} is not a version ${SEAL_VERSION} seal.`)
    console.error('Nothing was compared. Delete it and re-record.')
    process.exitCode = 1
    return
  }

  /* A seal recorded against a DIFFERENT artifact directory is also "could not
     run": it would compare this tree against a stranger's manifest and report a
     torrent of meaningless differences, which reads as a broken check and gets
     the check disabled. */
  if (resolveRecordedArtifact(seal, parsed.artifact) !== resolved) {
    /* Both sides are reported by basename. The recorded side may be a stale
       absolute path from before the identity became a basename, and echoing a
       home directory into build output is the same leak this file just stopped
       writing to disk -- a diagnostic is not an exemption. Basenames are what
       actually distinguishes the two artifacts here, so nothing diagnostic is
       lost by printing only them. */
    console.error(
      `Artifact seal VERIFY COULD NOT RUN: ${path.basename(seal)} was recorded against ` +
        `${path.basename(resolveRecordedArtifact(seal, parsed.artifact))}, not ${path.basename(resolved)}.`,
    )
    console.error('Nothing was compared. Re-record the seal against the artifact you mean to verify.')
    process.exitCode = 1
    return
  }

  const recorded = new Map(Object.entries(parsed.files))
  if (recorded.size === 0) {
    console.error(`Artifact seal VERIFY COULD NOT RUN: ${seal} records no files.`)
    console.error('Nothing was compared. Re-record after the artifact has been built.')
    process.exitCode = 1
    return
  }
  /* T392/T394: A SEAL THAT RECORDS NO COMMIT BINDS NOTHING, AND USED TO VERIFY
   * GREEN ANYWAY.
   *
   * MEASURED on the 1.0.45 publish: the seal beside the published installer
   * carried NO builtSha and NO recordedHead -- the older seal format records
   * per-file hashes and nothing about provenance at all -- and --verify passed
   * over it, because the comparison below was written as `parsed.builtSha &&
   * ...`. A seal that only says "these bytes are the bytes I hashed" answers
   * "was this artifact modified after packaging". It does not answer "what was
   * this built from", which is the question a published artifact has to carry
   * an answer to. The version number did not move when provenance was added, so
   * the version check above cannot stand in for this one.
   *
   * Unbound is its own answer: not "the artifact changed" (there is nothing to
   * compare against) and not "verified" (nothing about its origin was proven).
   * Re-record the seal against the binary, which cannot itself be recorded
   * without provenance -- record() has refused that since T385. */
  if (typeof parsed.builtSha !== 'string' || parsed.builtSha.trim() === '') {
    console.error(`Artifact seal VERIFY REFUSED (${NO_PROVENANCE_CODE}): ${path.basename(seal)} records no built `
      + 'commit, so this artifact is UNBOUND rather than verified: nothing here says what it was built from.')
    console.error('The file hashes were not compared, because a green on them would read as a verified artifact.\n'
      + 'Re-record the seal (node tools/seal-artifact.mjs --record <artifact>), which refuses an artifact that\n'
      + 'carries no dist/.dist-source.json, and publish only what a bound seal covers.')
    process.exitCode = 1
    return
  }

  /* T385: the seal names the commit the binary was built from; prove the
     artifact ON DISK NOW still carries that commit, so a reader can trust
     binary == sha. The built commit is printed either way. */
  const observedBuiltSha = builtAppHead(resolved)
  console.log(`artifact built from commit: ${observedBuiltSha || '(no dist/.dist-source.json in the artifact)'}`)
  if (observedBuiltSha !== parsed.builtSha) {
    console.error(`Artifact seal VERIFY FAILED (${BINARY_MISMATCH_CODE}): the seal binds built commit `
      + `${parsed.builtSha} but the artifact now reports ${observedBuiltSha || '(none)'}. The binary is not the one `
      + 'that was sealed. Re-record the seal against the binary you mean to ship.')
    process.exitCode = 1
    return
  }

  if (expectRef && parsed.builtSha !== expectRef) {
    console.error(`Artifact seal VERIFY FAILED (${REF_MISMATCH_CODE}): the seal binds built commit ${parsed.builtSha} `
      + `but this artifact is being published as ${expectRef}. The bytes may be sound; they are not the bytes that `
      + 'tip names. Publish the artifact built from that tip, or name the tip this artifact actually carries.')
    process.exitCode = 1
    return
  }

  const observed = await hashTree(resolved)
  const { added, removed, changed } = compare(recorded, observed)

  if (!added.length && !removed.length && !changed.length) {
    console.log(`artifact seal: ${observed.size} file(s) byte-identical to the seal recorded at ${parsed.recordedAt}`)
    console.log(`the sealed binary was built from ${parsed.builtSha}${expectRef ? ' (the tip being published)' : ''}; no step after packaging modified the artifact.`)
    return
  }

  const contamination = [...added, ...changed.map((line) => line.split('  ')[0])].filter(looksLikeRuntimeState)

  console.error('\nTHE BUILD CHAIN MODIFIED THE ARTIFACT IT HAD ALREADY CERTIFIED.')
  console.error(
    `\nThe artifact was sealed at ${parsed.recordedAt}, after packaging and after the boundary gates\n` +
      'passed. It is no longer what was sealed. Every gate that ran before this point passed against\n' +
      'a tree that no longer exists, so their green means nothing about what would ship.',
  )
  if (added.length) console.error(`\nADDED (${added.length}):\n  ${added.join('\n  ')}`)
  if (changed.length) console.error(`\nCHANGED (${changed.length}):\n  ${changed.join('\n  ')}`)
  if (removed.length) console.error(`\nREMOVED (${removed.length}):\n  ${removed.join('\n  ')}`)

  if (contamination.length) {
    console.error(
      `\n${contamination.length === 1 ? 'One of these is' : `${contamination.length} of these are`} RUNTIME STATE, which means the packaged application wrote its own\n` +
        'state into its installation directory. That is the defect src/lib/runtime-state-root.js exists to\n' +
        'prevent: a payload carrying PAYLOAD.json must resolve state/, logs/, vault/, captures/, profiles/\n' +
        'and reports/ to a per-user root. Check whether a new write path bypassed statePath(), or whether\n' +
        'PAYLOAD.json is missing from the staged payload so the layer no longer knows it is installed.\n' +
        'These files can carry live bearer tokens, the vault, and the audit ledger. Do not ship this build.',
    )
  } else {
    console.error(
      '\nNone of these look like runtime state, so this is some other post-packaging write. Whatever wrote\n' +
        'it, the artifact is not what the gates certified; find the step and make it work on a copy.',
    )
  }
  console.error(
    '\nThe steps that run between the seal and this check are the ones to look at: they start the packaged\n' +
      'application against the artifact directory itself.',
  )
  process.exitCode = 1
}

function usage() {
  console.error('usage: node tools/seal-artifact.mjs --record|--verify <artifact-directory> [--expect-ref <commit>]')
  console.error('       --expect-ref binds the seal to the tip being published; the built commit must equal it.')
  process.exitCode = 1
}

export function parseSealArguments(argv) {
  const rest = []
  let expectRef = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--expect-ref') {
      expectRef = argv[index + 1] ?? null
      index += 1
      continue
    }
    rest.push(argv[index])
  }
  const [mode, directory] = rest
  return { mode, directory, expectRef: expectRef && expectRef.trim() ? expectRef.trim() : null }
}

async function main() {
  const { mode, directory, expectRef } = parseSealArguments(process.argv.slice(2))
  if (!directory || (mode !== '--record' && mode !== '--verify')) return usage()

  const resolved = path.resolve(directory)
  let info
  try {
    info = await stat(resolved)
  } catch {
    throw new Error(`artifact directory does not exist: ${resolved}`)
  }
  if (!info.isDirectory()) throw new Error(`artifact path is not a directory: ${resolved}`)

  if (mode === '--record') return record(resolved, { expectRef })
  return verify(resolved, { expectRef })
}

main().catch((error) => {
  /* No mode of this tool has a benign failure: a record that did not happen
     leaves the next verify with nothing, and a verify that threw compared
     nothing. Both are exit 1. */
  console.error(`artifact seal could not run: ${error.message}`)
  process.exitCode = 1
})
