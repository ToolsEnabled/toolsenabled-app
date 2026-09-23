/* THE STRANGER'S RIG: one staged packaged build, sterile profiles, real clicks.
 *
 * WHAT THIS IS FOR. Three drivers in this directory ask the same three questions
 * of the same artifact -- can a second person use this product, can they see the
 * owner's things, and does the account boundary hold. Each of them needs a
 * packaged build staged with this tree's dist/ and shell/ in it, a data
 * directory that is emphatically NOT this machine's real installation, and a
 * debugger attached to the real window. Writing that three times would produce
 * three subtly different rigs and the first disagreement between them would be
 * read as a product defect.
 *
 * IT IS NOT ITSELF A DRIVER. tools/packaged-qa-suite.mjs discovers membership by
 * globbing for `-(qa|drive).(mjs|cjs)` (both families, since 2026-08-23 -- it
 * read `-qa` alone and was blind to twenty-eight `-drive` harnesses); this file
 * deliberately matches neither, so the suite runs the drivers and never tries
 * to run the rig.
 *
 * WHAT IT REFUSES TO DO.
 *
 * - It never touches the real installation. Every launch is given an explicit
 *   --user-data-dir under a scratch directory, and `assertIsolated` afterwards
 *   finds the file the app actually wrote and fails the run if it landed
 *   anywhere else. Overriding APPDATA does NOT move userData (Electron resolves
 *   the Windows known folder), so the switch is the mechanism and the written
 *   file is the proof. A confident finding taken from this machine's own state
 *   would be a finding about the wrong computer.
 *
 * - It never prints a password. `generatedPassword()` returns bytes from
 *   crypto.randomBytes and the only thing that ever happens to the value is
 *   being typed into a field over the debugger. Nothing in this file logs it,
 *   returns it in a result object, or writes it to a log path. A test-account
 *   password in a QA log is a credential in a QA log.
 *
 * - It never claims a launch from an exit code. `openWindow` records a timeline
 *   -- spawn time, pid, the moment a debuggable page answered, exit code and
 *   exit time, and the tail of stdout/stderr -- because the acceptance matrix
 *   this lane reuses (Desktop MACHINE-B-REPLACEMENT-BUILD-ACCEPTANCE-MATRIX.md)
 *   names "exit code 0" and "empty stdout" as evidence that is not sufficient.
 *   A window that never appeared reports `windowAt: null`, not a pass.
 *
 * ELECTRON_RUN_AS_NODE IS DELETED FROM EVERY CHILD ENVIRONMENT. It is set in the
 * environment these drivers are launched from. Inherited, the packaged
 * executable starts as a bare Node process with no `app` object, no window, and
 * an exit code that reads like an ordinary failure.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appExecutable,
  applyPlatformHomes,
  makePrivateDirectory,
  defaultReleaseDirectory,
  packagedLaunchCommand,
  reapProcessTree,
  sameFileIdentity,
} from './lib/packaged-platform.mjs'
import { assertRendererMeasurable, assertStagedRendererConsistent } from './lib/staged-renderer.mjs'
import {
  machineRecordEnvironmentFor,
  machineRecordProductDirectory,
  resolveMachineServicesRoot,
  servicesRootForProfile,
  userDataFor,
} from './lib/qa-services-root.mjs'

/* appExecutable MOVED to tools/lib/packaged-platform.mjs and is re-exported
   here. It answers "which file is the packaged application", which is the first
   of the four questions that layer exists for, and seven other drivers had
   grown their own Windows-only copy of it -- a rule in eight places is eight
   chances to be wrong, and off Windows all seven copies were wrong at once.
   Re-exported rather than moved-and-renamed so the ~60 drivers and the tests
   that already reach it through this module do not have to be edited to get
   the Linux answer. */
export {
  appExecutable,
  machineRecordEnvironmentFor,
  machineRecordProductDirectory,
  resolveMachineServicesRoot,
  servicesRootForProfile,
  userDataFor,
}

const require_ = createRequire(import.meta.url)
const SELF = fileURLToPath(import.meta.url)
export const REPO_ROOT = path.resolve(path.dirname(SELF), '..')
const { isCapabilityPathOverrideEnvironmentName } = require_(path.join(REPO_ROOT, 'shell', 'capability-path-environment.cjs'))
const { filterForeignWindowsProfilePath } = require_(path.join(REPO_ROOT, 'tools', 'lib', 'sterile-launch.cjs'))

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/* TYPE THE VALUE THAT THE CHECK ASKED FOR, NOT A SUFFIX OF WHATEVER AN
 * AUTOFILLER LEFT THERE.
 *
 * Input.insertText is still the mechanism: it fires the same input event a
 * real paste/type operation does. The select-all and Backspace are real CDP key
 * events too; assigning `field.value` would skip the product's input handling.
 * Read-back returns only a boolean, never the value. The inserted text appears
 * in exactly one CDP request: Input.insertText. A page-side input listener
 * hashes event.data, and read-back hashes the field's FINAL value after the
 * pause; only those digests are compared. A generated password is therefore
 * neither copied into a Runtime.evaluate program nor accepted from a stale
 * one-shot boolean after autofill changes the field. */
export async function typeExactText({ clickVisible, session, evaluate, pause = delay }, selector, text) {
  if (typeof selector !== 'string' || !selector || typeof text !== 'string') {
    throw new TypeError('typeExactText requires a selector and string text')
  }
  const clicked = await clickVisible(selector)
  if (clicked !== 'clicked') return clicked

  const selectAll = {
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  }
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll })
  const backspace = {
    key: 'Backspace',
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  }
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...backspace })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...backspace })

  const armed = await evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})
    if (!field) return false
    const proof = '__toolsenabledExactInputProof'
    Object.defineProperty(field, proof, { configurable: true, writable: true, value: null })
    field.addEventListener('input', event => {
      field[proof] = typeof event.data === 'string'
        ? crypto.subtle.digest('SHA-256', new TextEncoder().encode(event.data))
        : Promise.resolve(null)
    }, { once: true })
    return true
  })()`)
  if (!armed) return 'field-disappeared'
  await session.send('Input.insertText', { text })
  await pause(120)

  const readBack = await evaluate(`(async () => {
    const field = document.querySelector(${JSON.stringify(selector)})
    if (!field) return { found: false, matches: false }
    const proof = '__toolsenabledExactInputProof'
    const expected = await field[proof]
    const current = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(field.value))
    const equal = (left, right) => {
      if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer) || left.byteLength !== right.byteLength) return false
      const a = new Uint8Array(left)
      const b = new Uint8Array(right)
      for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
      return true
    }
    const matches = equal(expected, current)
    delete field[proof]
    return { found: true, matches }
  })()`)
  if (!readBack?.found) return 'field-disappeared'
  return readBack.matches ? 'typed' : 'value-mismatch'
}

export function argument(name, fallback = null) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback)
}

/* --release is read here so every driver in this family answers it identically.
   packaged-qa-suite refuses to run with --release if any driver would silently
   measure its own default build instead. */
export function releaseArgumentFor(argv = process.argv) {
  const occurrences = argv
    .map((value, index) => value === '--release' || value.startsWith('--release=') ? index : -1)
    .filter(index => index >= 0)
  if (occurrences.length === 0) return null
  if (occurrences.length !== 1) throw new Error('--release accepts exactly one path')
  const index = occurrences[0]
  const token = argv[index]
  const value = token === '--release' ? argv[index + 1] : token.slice('--release='.length)
  if (typeof value !== 'string' || value.length === 0 || (token === '--release' && value.startsWith('--'))) {
    throw new Error('--release requires one path')
  }
  return value
}

/* THE DEFAULT IS THE ARTIFACT THIS HOST'S BUILD PRODUCES, NOT A LITERAL.
   `release/win-unpacked` was written here on every platform, so a Linux host
   with no --release looked for a directory `electron-builder --linux deb`
   never writes and every driver refused before it measured anything. The name
   now comes from tools/lib/packaged-platform.mjs, which is the one place
   either platform's launcher and unpacked-directory names are spelled. */
export function releaseDirectory(argv = process.argv) {
  return path.resolve(releaseArgumentFor(argv) ?? defaultReleaseDirectory(REPO_ROOT))
}

export const STAGE_SOURCE_OVERLAY = 'source-overlay'
export const STAGE_EXACT_RELEASE = 'exact-release'
export const QA_STAGE_MODE_ENV = 'TOOLSENABLED_QA_STAGE_MODE'

export function stageModeForArguments(argv = process.argv, environment = process.env) {
  /* packaged-qa-suite uses the environment marker when an older driver can
     only consume the checkout's implicit default release and therefore cannot
     safely receive an extra --release positional. The suite still had an
     explicit --release request, so those shared-stage callers must be exact. */
  const release = releaseArgumentFor(argv)
  if (environment?.[QA_STAGE_MODE_ENV] === STAGE_EXACT_RELEASE) return STAGE_EXACT_RELEASE
  return release === null ? STAGE_SOURCE_OVERLAY : STAGE_EXACT_RELEASE
}

export const VISIBLE = process.argv.includes('--visible')

/* ---------------------------------------------------------------- results -- */

export function createLedger() {
  const results = []
  return {
    results,
    check(name, pass, detail = '') {
      results.push({ name, pass: pass === true, detail: String(detail) })
      console.log(`${pass === true ? '  ok  ' : '  FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
      return pass === true
    },
    /* A fact worth preserving that is not itself a pass/fail. Kept out of the
       count so an observation cannot pad the score. */
    note(text) { console.log(`  --    ${text}`) },
    finish(label) {
      const failed = results.filter(result => !result.pass)
      console.log(`\n${results.length - failed.length}/${results.length} checks passed${label ? ` (${label})` : ''}`)
      if (failed.length > 0) {
        console.log('FAILING CHECKS:')
        for (const result of failed) console.log(`  - ${result.name}${result.detail ? `  ${result.detail}` : ''}`)
        process.exitCode = 1
      }
      return failed.length
    },
  }
}

/* ---------------------------------------------------------------- secrets -- */

/* Bytes, not a phrase. Long enough to clear MIN_PASSWORD_LENGTH with room, and
   never derived from anything in this file, so a reader of this source cannot
   reconstruct the account it creates. The value is returned to the caller and
   goes exactly one place: an Input.insertText over the local debugger. */
export function generatedPassword() {
  return crypto.randomBytes(24).toString('base64url')
}

/* --------------------------------------------------------------- staging -- */

function lstatIfPresent(file, lstat = lstatSync) {
  try { return lstat(file) }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function insidePath(candidate, root) {
  const selected = path.resolve(candidate)
  const boundary = path.resolve(root)
  if (process.platform === 'win32') {
    const folded = selected.toLowerCase()
    const foldedBoundary = boundary.toLowerCase()
    return folded === foldedBoundary || folded.startsWith(`${foldedBoundary}${path.sep}`)
  }
  return selected === boundary || selected.startsWith(`${boundary}${path.sep}`)
}

function hashRegularFileWithoutFollowingLinks(file, firstStat = lstatSync(file)) {
  if (!firstStat.isFile()) throw new Error(`exact-release manifest refused a non-regular file at ${file}`)
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)
  let descriptor = null
  try {
    descriptor = openSync(file, flags)
    const opened = fstatSync(descriptor)
    if (!sameFileIdentity(firstStat, opened)) {
      throw new Error(`exact-release source changed while it was being opened: ${file}`)
    }
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, offset)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      offset += count
    }
    const closed = fstatSync(descriptor)
    if (!sameFileIdentity(opened, closed) || offset !== opened.size) {
      throw new Error(`exact-release source changed while it was being read: ${file}`)
    }
    return { bytes: offset, sha256: hash.digest('hex') }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function resolvedLinkTarget(linkFile, target) {
  return path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(path.dirname(linkFile), target)
}

export function exactCopyOptions(mode) {
  return Object.freeze({
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    verbatimSymlinks: true,
  })
}

export function assertStageDestinationAbsent(destination, { lstat = lstatIfPresent } = {}) {
  /* Existence probes follow links and answer false for a broken destination
     link. This seam is intentionally lstat-only: a stale reparse point is
     already a destination and must never be opened, resolved, or followed. */
  if (lstat(destination)) {
    throw new Error(`refusing to stage over an existing destination: ${destination}`)
  }
}

/** A deterministic byte-and-topology manifest which never reads through a link.
 *
 * Every reparse/symbolic entry is represented by its link text. Its target must
 * remain lexically inside this tree; because every link in the tree is checked
 * by the same rule, a chain of internal links cannot escape through a second
 * unchecked link. `forbiddenRoot` catches an absolute link copied verbatim from
 * the candidate which still points back into the candidate instead of scratch.
 */
export function exactTreeManifest(root, { forbiddenRoot = null, rejectLinks = false, filesystem = {} } = {}) {
  const lstat = filesystem.lstatSync || lstatSync
  const readDirectory = filesystem.readdirSync || readdirSync
  const readLink = filesystem.readlinkSync || readlinkSync
  const hashFile = filesystem.hashRegularFile || hashRegularFileWithoutFollowingLinks
  const boundary = path.resolve(root)
  const rootStat = lstat(boundary)
  if (rootStat.isSymbolicLink()) throw new Error(`exact-release root may not itself be a link: ${boundary}`)
  if (!rootStat.isDirectory()) throw new Error(`exact-release root is not a directory: ${boundary}`)
  const output = [{ path: '.', type: 'directory' }]

  const walk = (directory, relative = '') => {
    const entries = readDirectory(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const childRelative = path.join(relative, entry.name)
      const child = path.join(boundary, childRelative)
      const stat = lstat(child)
      const portable = childRelative.split(path.sep).join('/')
      if (stat.isSymbolicLink()) {
        if (rejectLinks) {
          throw new Error(`source-overlay staging refuses a linked entry: ${portable}`)
        }
        const target = readLink(child)
        const resolved = resolvedLinkTarget(child, target)
        if (forbiddenRoot && insidePath(resolved, forbiddenRoot)) {
          throw new Error(`exact-release scratch link points back into its source: ${portable} -> ${target}`)
        }
        if (!insidePath(resolved, boundary)) {
          throw new Error(`exact-release link escapes its tree: ${portable} -> ${target}`)
        }
        output.push({ path: portable, type: 'link', target })
      } else if (stat.isDirectory()) {
        output.push({ path: portable, type: 'directory' })
        walk(child, childRelative)
      } else if (stat.isFile()) {
        output.push({ path: portable, type: 'file', ...hashFile(child, stat) })
      } else {
        throw new Error(`exact-release manifest refused unsupported filesystem entry: ${portable}`)
      }
    }
  }
  walk(boundary)
  return output
}

function assertExactManifestEqual(expected, actual, what) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`exact-release identity check failed: ${what}`)
  }
}

async function overlayCurrentSource(app, scratch) {
  /* THE RENDERER THIS RUN IS ABOUT TO MEASURE MUST BE THE ONE THE SOURCE SAYS.
     Shared with every other dist/-staging harness (tools/lib/staged-renderer.mjs);
     refuses with exit 2 and both timestamps rather than reporting a stale bundle
     as a defect in the product. */
  assertRendererMeasurable({ repoRoot: REPO_ROOT, sourceDist: path.join(REPO_ROOT, 'dist') })
  const asar = require_(path.join(REPO_ROOT, 'node_modules', '@electron', 'asar'))
  const unpacked = path.join(scratch, 'asar-stage')
  asar.extractAll(path.join(app, 'resources', 'app.asar'), unpacked)
  for (const directory of ['dist', 'shell']) {
    const from = path.join(REPO_ROOT, directory)
    if (!existsSync(from)) throw new Error(`${directory}/ is missing; run \`npm run build\` first`)
    rmSync(path.join(unpacked, directory), { recursive: true, force: true })
    cpSync(from, path.join(unpacked, directory), { recursive: true })
  }
  /* ...and the COPY of it must have arrived whole; see the module header for the
     blank-stage, no-exception symptom a torn copy produces. */
  assertStagedRendererConsistent({
    stagedDist: path.join(unpacked, 'dist'),
    sourceDist: path.join(REPO_ROOT, 'dist'),
  })
  cpSync(path.join(REPO_ROOT, 'package.json'), path.join(unpacked, 'package.json'))
  await asar.createPackage(unpacked, path.join(app, 'resources', 'app.asar'))
  /* AND THE CAPABILITY PAYLOAD, WHICH THIS FUNCTION USED TO LEAVE BEHIND.
   *
   * THE GAP, MEASURED ON THE DAY IT MATTERED. dist/ and shell/ were overlaid
   * from this tree and `resources/capability` was whatever the last
   * `npm run dist` happened to leave in release/win-unpacked. On 2026-08-17 that
   * directory was cut at 13:06 and capability/src/lib/agent-engine/ took the
   * Claude engine at 18:55, so every packaged driver in this repo was driving a
   * payload with NO claude-cli-process.js in it. shell/agent-host.cjs gates the
   * Claude tiers on a require() of exactly that file, so every one of those runs
   * would have reported "this copy carries no launcher" -- about a build that
   * ships one. A lane was one report away from certifying a cut against an
   * engine it had never once loaded.
   *
   * IT IS THE SAME PROMISE THE FUNCTION ALREADY MAKES. package.json's
   * electron-builder config maps extraResources capability -> capability, and
   * `npm run dist` runs pack:capability immediately before electron-builder. So
   * these bytes ARE the bytes the installer would carry; copying them here is
   * reproducing the ship path, not stepping around it. The asar is left alone
   * because the payload is a sibling of it, never inside it.
   *
   * NOT CURRENCY-CHECKED HERE, DELIBERATELY. tools/check-payload-current.mjs
   * owns "is capability/ newer than the source it was packed from", it is in the
   * dist chain, and a driver that wants the guarantee runs it. Re-deriving that
   * comparison here would be a second opinion that can disagree with the first. */
  const capability = path.join(REPO_ROOT, 'capability')
  if (existsSync(capability)) {
    const staged = path.join(app, 'resources', 'capability')
    rmSync(staged, { recursive: true, force: true })
    cpSync(capability, staged, { recursive: true })
  }
}

/**
 * Stage either an immutable release candidate or a development source overlay.
 *
 * An explicit `--release` always selects exact-release mode: the candidate is
 * copied byte-for-byte into scratch and no checkout source is introduced. With
 * no explicit release, the long-standing development workflow remains intact:
 * the release shell is copied, then this checkout's dist/, shell/, package.json
 * and capability/ are overlaid into the disposable copy. The source candidate
 * is never a mutation target in either mode.
 *
 * `overlay` is injectable solely so the contract can be regression-tested with
 * tiny byte fixtures; production callers use overlayCurrentSource.
 */
export async function stage(
  scratch,
  release = releaseDirectory(),
  { mode = stageModeForArguments(), overlay = overlayCurrentSource, copy = cpSync } = {},
) {
  if (![STAGE_SOURCE_OVERLAY, STAGE_EXACT_RELEASE].includes(mode)) {
    throw new Error(`unknown test-account staging mode: ${mode}`)
  }
  const app = path.join(scratch, 'app')
  assertStageDestinationAbsent(app)
  /* Inspect the whole release before even probing resources/app.asar: a
     resources junction must be refused without inspecting its target. An
     overlay needs ordinary entries because its later writes replace files
     inside this copy. Exact mode retains its internal-link topology contract. */
  const rejectLinks = mode === STAGE_SOURCE_OVERLAY
  const sourceBefore = exactTreeManifest(release, { rejectLinks })
  const releaseArchive = path.join(release, 'resources', 'app.asar')
  const archiveStat = lstatIfPresent(releaseArchive)
  if (!archiveStat || !archiveStat.isFile()) {
    throw new Error(`no packaged build at ${release}. Run \`npm run dist\` first.`)
  }
  /* Neither mode may dereference a link introduced after the preflight. Check
     the copied topology and bytes before the overlay can read or write it. */
  copy(release, app, exactCopyOptions(mode))
  const scratchCopy = exactTreeManifest(app, { forbiddenRoot: release, rejectLinks })
  assertExactManifestEqual(sourceBefore, scratchCopy, 'the scratch copy differs from the named release')
  if (mode === STAGE_SOURCE_OVERLAY) {
    await overlay(app, scratch)
  } else {
    const sourceAfter = exactTreeManifest(release)
    assertExactManifestEqual(sourceBefore, sourceAfter, 'the named release changed while it was copied')
  }
  return {
    executable: appExecutable(app),
    appRoot: app,
    archive: path.join(app, 'resources', 'app.asar'),
    stageMode: mode,
    sourceRelease: path.resolve(release),
  }
}

/** The LOCALAPPDATA subdirectory name a machine record must live under for a
 * window opened by openWindow() to find it.
 *
 * openWindow() launches with --user-data-dir=userDataFor(profile), which
 * overrides Electron's normal appData+productName resolution outright (see
 * the note above userDataFor(): "Overriding APPDATA does NOT move userData").
 * shell/main.cjs sets TOOLSENABLED_STATE_ROOT to <that userData>/capability,
 * and durable-memory-file.js's resolveProductDirectory() takes the basename
 * of that userData path as the LOCALAPPDATA subdirectory name. A literal here
 * would silently drift from whatever openWindow() actually launches with --
 * measured empirically: with --user-data-dir=<profile>/userdata, the app
 * reads its machine record from <profile>/local/userdata, not
 * <profile>/local/ToolsEnabled. Deriving from userDataFor() itself keeps this
 * pinned to the one thing that actually decides it. */
/** The permission-level record a fresh install would otherwise stop to ask for. */
export function seedMachineRecord(profile, appRoot, tier = 'standard') {
  const productDirectory = machineRecordProductDirectory(profile)
  const identity = machineRecordEnvironmentFor(profile)
  const workspace = path.join(profile, 'home', productDirectory)
  mkdirSync(identity.LOCALAPPDATA, { recursive: true })
  mkdirSync(path.dirname(identity.TOOLSENABLED_STATE_ROOT), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const machineRecord = require_(path.join(appRoot, 'resources', 'capability', 'src', 'lib', 'setup', 'machine-record.js'))
  const servicesRoot = resolveMachineServicesRoot(profile, machineRecord)
  mkdirSync(servicesRoot, { recursive: true })
  const record = machineRecord.buildMachineRecord({
    tier,
    servicesRoot,
    installRoot: path.join(appRoot, 'resources', 'capability'),
    nodePath: process.execPath,
    workspaceRoots: [workspace],
  })
  machineRecord.writeMachineRecord(record, { servicesRoot })
  return servicesRoot
}

/* --------------------------------------------------------------- profiles -- */

export const accountsFileFor = profile => path.join(userDataFor(profile), 'product-accounts.json')
export const sessionFileFor = profile => path.join(userDataFor(profile), 'product-session.enc')
export const prefsFileFor = profile => path.join(userDataFor(profile), 'renderer-prefs.json')

/* IS THIS THE NAME OF SOMETHING THAT COULD PAY FOR A MODEL TURN?
 *
 * Exported so the fence that proves the scrub works asks the SAME question the
 * scrub asks. A second copy of this rule in the test is a second copy that
 * drifts, and it would drift in the direction of passing.
 *
 * IT MATCHES ON THE NAME AND NEVER LOOKS AT A VALUE. A rule that inspected
 * values to decide what is secret would have to read every secret to run.
 *
 * IT IS DELIBERATELY WIDER THAN IT NEEDS TO BE, and the asymmetry is the whole
 * argument: this builds the environment for a TEST child. Over-scrubbing costs a
 * drive that fails loudly and gets fixed in a minute. Under-scrubbing costs the
 * operator's money, silently, and leaves evidence that looks green. So anything
 * name-shaped like a credential goes, and a variable a driver genuinely needs is
 * added back by name here rather than by loosening this.
 *
 * WHAT IT MUST NOT CATCH, checked against a real session's environment: paths
 * and ids that merely live under a vendor prefix -- CLAUDE_CODE_EXECPATH,
 * CLAUDE_CODE_SESSION_ID, CLAUDE_PID, CODEX_HOME, CLAUDE_CONFIG_DIR. Those are
 * how a run is wired, not how it pays. */
export function isProviderCredentialName(name) {
  const upper = String(name || '').toUpperCase()
  if (/^(CODEX_HOME|CLAUDE_CONFIG_DIR)$/.test(upper)) return false
  return /(API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/.test(upper)
    || /_KEY$/.test(upper)
}

/**
 * The environment a drive's child gets.
 *
 * THE PROMISE THIS FUNCTION MAKES is the module header's: a run never touches
 * the real installation. LOCALAPPDATA, APPDATA, USERPROFILE and CODEX_HOME are
 * redirected into scratch for exactly that reason -- so a drive cannot read the
 * machine's own Codex sign-in and report a finding about the wrong computer.
 *
 * IT WAS BREAKING THAT PROMISE FOR ONE PROVIDER, AND THE GAP WAS A VARIABLE
 * RATHER THAN A DIRECTORY. This function began `{ ...process.env }` and deleted
 * two Electron flags, so a drive launched from a session that holds
 * ANTHROPIC_API_KEY handed that key to the packaged app and every child it
 * spawned. Measured 2026-08-20, end to end, names and lengths only:
 *
 *   environmentFor() put into a drive child   ANTHROPIC_API_KEY (108 chars)
 *   a real child spawned with it reported     ANTHROPIC_API_KEY (108 chars)
 *   while CODEX_HOME and USERPROFILE were correctly in scratch
 *
 * TWO COSTS, and the second is the one that outlives the fix. A drive that
 * presses a Claude tier authenticates as the operator and bills them. And any
 * drive that reported a Claude session STARTING may have measured the inherited
 * key rather than the sign-in path a customer's machine would use -- a green
 * about something other than the product, the same shape as measuring a working
 * tree and calling it a commit.
 *
 * CLAUDE_CONFIG_DIR IS REDIRECTED, NOT DELETED, for the same reason CODEX_HOME
 * is set rather than unset: presence checks read a directory, and an operator
 * who has that variable pointing at their real ~/.claude would otherwise hand a
 * drive their Claude sign-in through the door Codex's was already closed at. On
 * a machine that does not set it, this lands on exactly the path the homedir
 * fallback already resolved to, so no drive changes behaviour.
 */
export function environmentFor(profile) {
  /* The profile root is an ANCESTOR of the userData every openWindow() launch
     selects, and the Linux launch refuses an ancestor anyone else could write
     (see makePrivateDirectory). Created here, 0700, rather than by whichever
     mkdir happened to reach it first under the operator's umask. */
  makePrivateDirectory(profile)
  const environment = { ...process.env }
  /* Both deleted deliberately. ELECTRON_RUN_AS_NODE turns the packaged
     executable into a Node process with no app object; the console flag makes a
     child steal a console window on a machine somebody is working on. */
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.ELECTRON_NO_ATTACH_CONSOLE
  /* And every provider credential, the same way and for a harder reason. See
     isProviderCredentialName() above; tools/test/harness-credential-fence.test.mjs
     spawns a real child and fails if one of these arrives. */
  for (const name of Object.keys(environment)) {
    if (isProviderCredentialName(name) || isCapabilityPathOverrideEnvironmentName(name)) {
      delete environment[name]
    }
  }
  /* A build shell may retain another account's npm/bin entry in PATH. The
     packaged account fence correctly refuses it. Remove only those lexical
     foreign-profile entries; keep system, Program Files, product-owned and
     this account's own tool locations. Rejected paths are never probed. */
  for (const name of Object.keys(environment)) {
    if (/^path$/i.test(name)) environment[name] = filterForeignWindowsProfilePath(environment[name])
  }
  delete environment[QA_STAGE_MODE_ENV]
  if (VISIBLE) delete environment.MC_SMOKE_HEADLESS
  else environment.MC_SMOKE_HEADLESS = '1'
  environment.LOCALAPPDATA = path.join(profile, 'local')
  environment.APPDATA = path.join(profile, 'roaming')
  environment.USERPROFILE = path.join(profile, 'home')
  environment.CODEX_HOME = path.join(profile, 'home', '.codex')
  environment.CLAUDE_CONFIG_DIR = path.join(profile, 'home', '.claude')
  /* THE FOUR NAMES ABOVE ARE A COMPLETE FENCE ON WINDOWS AND HALF A FENCE ON
     LINUX. Nothing on Linux reads LOCALAPPDATA/APPDATA/USERPROFILE except this
     product's own resolver; HOME, the passwd entry os.homedir() falls back to
     when HOME is unset, and XDG_CONFIG/DATA/CACHE/STATE_HOME are all still
     pointing at the real account, which is the machine this harness promises
     in its header never to report a finding about. applyPlatformHomes is a
     no-op on Windows and sets those six on Linux, with XDG_DATA_HOME pinned to
     the same directory as LOCALAPPDATA so the machine record this harness
     seeds and the one the application reads cannot be different files. */
  applyPlatformHomes(environment, profile)
  mkdirSync(environment.APPDATA, { recursive: true })
  mkdirSync(environment.CODEX_HOME, { recursive: true })
  /* Created before the spawn for the reason sterile-launch.cjs's
     prepareSterileProfile() already records: a home that does not exist reads
     to the shell as "nothing here", which is the right answer, but Chromium
     wants directories it can write and will not make an XDG root for itself. */
  for (const name of ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    if (typeof environment[name] === 'string' && path.isAbsolute(environment[name])) {
      mkdirSync(environment[name], { recursive: true })
    }
  }
  return environment
}

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------------- CDP -- */

export function createSession(port, child, timeline, {
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  pause = delay,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let socket = null
  let nextId = 1
  const pending = new Map()
  const durationLabel = milliseconds => milliseconds >= 1000 && milliseconds % 1000 === 0
    ? `${milliseconds / 1000}s`
    : `${milliseconds}ms`
  const bounded = (operation, timeoutMs, timeoutMessage, onTimeout = () => {}) => new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimer(timer)
      callback(value)
    }
    timer = setTimer(() => {
      try { onTimeout() } catch { /* the deadline remains authoritative */ }
      finish(reject, new Error(timeoutMessage))
    }, timeoutMs)
    Promise.resolve().then(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    )
  })
  const rejectPending = message => {
    /* handler.reject owns deletion and timer cleanup. Deleting here first
       would make its settle-once guard treat the close as a late duplicate and
       leave the caller pending forever. */
    for (const handler of [...pending.values()]) handler.reject(new Error(message))
  }
  return {
    async open({ budgetMs = 90_000, pollMs = 500, attemptMs = 2_000 } = {}) {
      /* 90s. This machine routinely has other Electron windows up from peer
         lanes, and a harness that gives up early reports a busy machine as a
         broken build. It is a MONOTONIC DEADLINE, not 180 nominal attempts:
         either an HTTP peer or a WebSocket peer can accept a connection and
         then say nothing, so each individual handshake gets only the smaller
         of its attempt budget and the time still left. */
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('the debugger attach budget must be positive')
      if (!Number.isFinite(pollMs) || pollMs <= 0) throw new TypeError('the debugger poll interval must be positive')
      if (!Number.isFinite(attemptMs) || attemptMs <= 0) throw new TypeError('the debugger attempt budget must be positive')
      const deadline = now() + budgetMs
      while (now() < deadline) {
        if (child.exitCode !== null) {
          /* THE EXIT CODE ALONE SENDS A READER NOWHERE. Measured 2026-09-11 on
             Linux: five drivers reported "the app exited with code 1 before the
             debugger answered" and the reason was on the child's own stderr,
             which this timeline had already captured and then thrown away --
             `MC_ACCOUNT_STATE_UNSAFE: ... Choose an owned, private user-data
             directory without symbolic links`, a refusal that names exactly what
             to fix. A harness that withholds the product's own sentence turns a
             one-line fix into an afternoon. The tail is bounded because
             timeline.stderr is itself capped at 8000 characters. */
          const said = [timeline.stderr, timeline.stdout]
            .map(text => String(text || '').trim()).filter(Boolean)
            .map(text => text.split('\n').slice(-6).join(' | '))
            .join(' || ')
          throw new Error(`the app exited with code ${child.exitCode} before the debugger answered`
            + (said ? `; it said: ${said}` : '; it said nothing on stdout or stderr'))
        }
        try {
          const remainingForFetch = Math.max(1, deadline - now())
          const fetchBudget = Math.min(attemptMs, remainingForFetch)
          const controller = new AbortController()
          /* Bound the whole HTTP exchange, including response.json(). An abort
             signal alone is advisory to an injected or buggy fetch, and a peer
             can answer the headers then stall the body forever. The explicit
             rejection is the deadline; abort only releases the real socket. */
          const pages = await bounded(async () => {
            const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal })
            return response.json()
          }, fetchBudget, `the debugger HTTP discovery did not finish within ${durationLabel(fetchBudget)}`, () => controller.abort())
          const page = pages.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl)
          if (page) {
            socket = new WebSocketImpl(page.webSocketDebuggerUrl)
            const remaining = Math.max(1, deadline - now())
            const handshakeBudget = Math.min(attemptMs, remaining)
            let opened
            let failed
            const handshake = new Promise((resolve, reject) => {
              opened = resolve
              failed = reject
              socket.addEventListener('open', opened, { once: true })
              socket.addEventListener('error', failed, { once: true })
            })
            try {
              await bounded(
                () => handshake,
                handshakeBudget,
                `the debugger WebSocket handshake did not finish within ${durationLabel(handshakeBudget)}`,
                () => { try { socket.close() } catch { /* a stalled handshake may not be closable */ } },
              )
            } finally {
              socket.removeEventListener?.('open', opened)
              socket.removeEventListener?.('error', failed)
            }
            socket.addEventListener('message', event => {
              const packet = JSON.parse(event.data)
              const handler = pending.get(packet.id)
              if (handler) handler.resolve(packet)
            })
            /* A REPLY THAT CAN NEVER ARRIVE MUST NOT BE WAITED FOR FOREVER.
               When the window closes (which closeWindow ASKS it to do), the
               debugger socket drops before the reply to the very evaluate that
               asked. Un-settled promises here were how the stranger-journey
               driver ended with no summary and exit 0 while carrying four FAIL
               lines (measured 2026-08-18): the last await never settled, the
               event loop drained, node exited "cleanly", and ledger.finish()
               -- the only writer of the `N/M checks passed` verdict line the
               suite reads -- never ran. A dead socket now REJECTS everything
               still pending: closeWindow's try/catch absorbs the expected
               race, and a socket that dies mid-measurement fails the run
               loudly instead of feeding undefined into a check. */
            socket.addEventListener('close', () => rejectPending('the debugger socket closed before this reply arrived'), { once: true })
            timeline.windowAt = now()
            timeline.pageUrl = page.url || null
            return
          }
        } catch { /* not listening yet */ }
        const remaining = deadline - now()
        if (remaining > 0) await pause(Math.min(pollMs, remaining))
      }
      throw new Error(`no debuggable page appeared within ${durationLabel(budgetMs)}`)
    },
    send(method, params = {}, timeoutMs = 45_000) {
      const id = nextId++
      /* A send on an already-dead socket rejects immediately for the same
         reason the close handler rejects: a promise nobody can settle is how
         this file once turned four FAILs into an exit-0 with no verdict. */
      if (!socket || socket.readyState !== 1 /* OPEN */) {
        return Promise.reject(new Error('the debugger socket is not open'))
      }
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new TypeError('the debugger call timeout must be positive'))
      }
      return new Promise((resolve, reject) => {
        let timer = null
        const finish = (callback, value) => {
          if (!pending.delete(id)) return
          if (timer !== null) clearTimer(timer)
          callback(value)
        }
        pending.set(id, {
          resolve: value => finish(resolve, value),
          reject: error => finish(reject, error),
        })
        timer = setTimer(() => {
          pending.get(id)?.reject(new Error(`${method} was not answered within ${durationLabel(timeoutMs)}`))
        }, timeoutMs)
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          pending.get(id)?.reject(error)
        }
      })
    },
    close() {
      rejectPending('the debugger session closed before this reply arrived')
      try { socket?.close() } catch { /* already gone */ }
    },
  }
}

/* VISIBLE IS MEASURED, because text in the DOM is not text on the screen.
 *
 * AND OFFSCREEN IS NOT VISIBLE EITHER, which cost this rig its first run. The
 * obvious version of this function returns the centre of the bounding box and
 * calls anything with a non-zero box visible. A closed settings drawer parked
 * to the right of the viewport, and a Finish button below the fold of a long
 * review page, both satisfy that -- so the harness dispatched clicks at
 * coordinates outside the window, hit nothing, read "clicked", and reported the
 * product as having a walkthrough that cannot be finished and a preference that
 * does not persist. Two false REDs from one missing comparison.
 *
 * So the element is scrolled into view the way a person scrolls to it, the box
 * is re-measured AFTER the scroll, and the point that will be clicked must be
 * inside the viewport and must be the element itself (or one of its own
 * children) under `elementFromPoint`. A control another layer is covering is
 * not clickable, and saying so is the whole job. */
const VISIBLE_FN = `(selector) => {
  const node = document.querySelector(selector)
  if (!node) return { state: 'absent' }
  const style = getComputedStyle(node)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return { state: 'hidden' }
  try { node.scrollIntoView({ block: 'center', inline: 'center' }) } catch (error) { /* detached */ }
  const box = node.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { state: 'zero-size' }
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
    return { state: 'offscreen', box: { x: box.x, y: box.y, w: box.width, h: box.height }, viewport: { w: innerWidth, h: innerHeight } }
  }
  const hit = document.elementFromPoint(x, y)
  /* WHO ACTUALLY RECEIVES THE PRESS. A dispatched click goes to \`hit\` and
     bubbles UP from it. So it reaches the target only when hit IS the target or
     one of the target's own descendants. An ANCESTOR hit means the target never
     receives the event -- pointer-events:none, a clip, or the target simply not
     painting at that point -- and the old rule (\`hit.contains(node)\`) accepted
     exactly that and printed "clicked" over a press the control never felt: a
     silent false green in every drive this harness ran (found 2026-08-18 by the
     rotation lane). The one honest exception is kept: a <label> whose control
     IS the target forwards activation by spec, so a press on the label is a
     real press on the control. */
  if (!hit) return { state: 'covered', by: 'nothing' }
  const labelFor = hit.closest ? hit.closest('label') : null
  const receives = hit === node || node.contains(hit) || (labelFor && labelFor.control === node)
  if (!receives) {
    const name = hit.tagName + (hit.className ? '.' + String(hit.className).split(' ')[0] : '')
    return { state: 'covered', by: hit.contains(node) ? ('own-ancestor-' + name) : name }
  }
  return { state: 'visible', x, y }
}`

/* ---- TAKING A PICTURE OF THIS BUILD, AND WHY THE OBVIOUS WAY LIES --------
 *
 * Three lanes lost time to Page.captureScreenshot in one night (2026-08-20), so
 * the readings live here, beside the function every driver in this family goes
 * through, rather than in three separate reports. Every driver rolls its own
 * shoot(); this is the part none of them should have to re-derive.
 *
 * 1 · WAKING THE WINDOW IS MANDATORY. setWebLifecycleState active, then a REAL
 *     input event (a 1px mouseMoved), then two frames. A window opened with
 *     show:false is not compositing, captureScreenshot waits for a frame that
 *     will never come, and requestAnimationFrame alone does not wake it.
 *
 * 2 · fromSurface: false NEVER RETURNS under MC_SMOKE_HEADLESS=1. Measured:
 *     12s deadline, three attempts, on five separate captures in one run --
 *     every single one timed out. A dead path, not a slow one. A driver that
 *     reaches for it (a committed one does) silently loses all its evidence.
 *     Use the default.
 *
 * 3 · THE TELL IS NOT THE IMAGE SIZE, and this is the correction that matters
 *     most, because "check the file came out the right size" is the defence a
 *     reader invents and it does not work. Under an Emulation override the PNG
 *     comes out at EXACTLY the requested width -- 1024x900, 1440x900, 1920x900,
 *     measured -- while the painted CONTENT is the layout the window still has.
 *     Nothing about the file betrays it. One lane's "1920" image showed the
 *     segmented controls clipped mid-word ("Every agent" cut to "Every") beside
 *     a DOM read taken in the same breath reporting horizontalOverflow: false:
 *     two accounts of one window that cannot both be true.
 *
 *     THE RULE: a picture taken under Emulation.setDeviceMetricsOverride cannot
 *     be trusted to agree with a DOM read taken in the same breath. The only
 *     cure is to resize the REAL window. This is also why a before/after pair
 *     taken at the window's own size, with no override at all, is trustworthy
 *     -- not as a detail of one run, but as the general rule.
 *
 * 4 · Browser.setWindowBounds RESIZES THE REAL WINDOW, AND IS NOT AVAILABLE
 *     HERE. It needs a windowId from Browser.getWindowForTarget, and headless
 *     Electron does not give one -- measured by two lanes independently, across
 *     three widths and repeated attempts. So on this build, in a headless run,
 *     there is currently NO working way to take a trustworthy width-labelled
 *     picture through the debugger.
 *
 * 5 · THE WAY THAT DOES WORK, and the better question underneath it.
 *
 *     THE PICTURE: shell/main.cjs restores its window from
 *     <userData>/shell-state.json (shell/window-state.cjs; minimum 980x640), so
 *     seeding that file BEFORE launch opens a real native window at that size.
 *     Surface, layout and photograph are then one thing. One window per width.
 *     Worked example: tools/context-window-drive.mjs, driveAtWidth().
 *
 *     THE BETTER QUESTION: "are the controls cut off at 1920" does not need a
 *     photograph at all. It needs element rectangles measured against the
 *     viewport -- and geometry is exactly what an emulated viewport genuinely
 *     does change. So the measurement is trustworthy precisely where the image
 *     is not, it names the offending element and pixel instead of inviting
 *     somebody to squint at a PNG, and the surface/override disagreement cannot
 *     reach it. Reach for the picture when a person has to SEE it; reach for
 *     the rectangles when the question is whether something fits.
 *
 * 6 · WHICHEVER ROUTE, THE INSTRUMENT STATES ITS OWN MODE. Read innerWidth and
 *     innerHeight back off the page, print them beside what was asked for and
 *     beside which route was used (real window or emulation), and refuse to
 *     label a picture with a width the page never reported. A resize that
 *     silently does not take is the same failure family as everything else
 *     here: an instrument reporting a state it never reached. A self-checking
 *     log beats a correct result somebody has to trust.
 * ------------------------------------------------------------------------- */

/**
 * Start the packaged application on a sterile profile and attach to its window.
 *
 * Returns the driving surface AND the timeline. Every caller that asserts "it
 * launched" is expected to quote the timeline rather than the absence of an
 * error.
 */
export async function openWindow(executable, profile, { extraArgs = [] } = {}) {
  const port = await freePort()
  const timeline = {
    spawnedAt: Date.now(), pid: null, windowAt: null, exitCode: null, exitedAt: null,
    stdout: '', stderr: '',
  }
  const environment = environmentFor(profile)
  /* THE APPLICATION IS STILL THE THING THAT RUNS; THE CONFINEMENT IS NOT A
     SUBSTITUTE FOR IT. Measured 2026-09-11 against the 1.0.44 candidate's own
     linux-unpacked tree: launched directly on a stock Ubuntu desktop the
     packaged ELF dies at exit 133 before any window, because
     kernel.apparmor_restrict_unprivileged_userns=1 denies Chromium its
     namespace sandbox and an UNPACKED tree's chrome-sandbox cannot be
     root:4755 (only the installer can make it so). packagedLaunchCommand
     returns the executable unchanged unless the operator has named a loaded
     AppArmor profile, in which case the launch is transitioned into it -- the
     same profile shape the shipped .deb installs for the installed product.
     On Windows it is the identity function. */
  const launch = packagedLaunchCommand(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataFor(profile)}`,
    ...extraArgs,
  ])
  const child = spawn(launch.command, launch.args,
    { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  timeline.confinement = launch.confinement
  timeline.pid = child.pid
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { timeline.stdout = (timeline.stdout + chunk).slice(-8000) })
  child.stderr.on('data', chunk => { timeline.stderr = (timeline.stderr + chunk).slice(-8000) })
  child.on('exit', code => { timeline.exitCode = code; timeline.exitedAt = Date.now() })

  const session = createSession(port, child, timeline)
  /* OWN THE CHILD BEFORE ATTACHING TO IT. session.open() can spend its full
     90-second budget while Electron remains healthy but undebuggable. The old
     shape rejected before returning `child`, so the caller had nothing it
     could reap and Node stayed alive on the child's piped stdio indefinitely.
     Tear down here, where ownership is certain, and preserve the attach error
     as the verdict rather than letting a later isolation assertion mask it. */
  await attachOwnedChild({ session, child })

  const evaluate = async (expression, timeoutMs = 45_000) => {
    const packet = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (packet?.result?.exceptionDetails) {
      return { __evaluateThrew: String(packet.result.exceptionDetails.exception?.description || 'exception') }
    }
    return packet?.result?.result?.value
  }
  /* Measured TWICE with a pause between, because the first call is what does the
     scrolling and a page with CSS `scroll-behavior: smooth` has not arrived yet
     when the first rect is taken. The second measurement is the one that
     decides. */
  const visibility = async selector => {
    const first = await evaluate(`(${VISIBLE_FN})(${JSON.stringify(selector)})`)
    if (first?.state === 'absent' || first?.state === 'hidden') return first
    await delay(260)
    return evaluate(`(${VISIBLE_FN})(${JSON.stringify(selector)})`)
  }
  /* WAITED FOR, NOT SAMPLED ONCE.
   *
   * Measured on this build, headless: the settings drawer takes the `open`
   * class in the same frame as the click and its computed transform is still at
   * the parked translateX(342px) 700ms later, arriving at translateX(0)
   * somewhere before 1500ms -- with a transition duration of 0.12s. A window
   * started with `show: false` is not compositing, so style and transition work
   * is deferred, and a harness that measured once at 450ms would have reported
   * "the settings drawer opens off the right edge of the window", which is a
   * serious-sounding RED about the harness. So the state is polled until the
   * element is genuinely on screen, and the last state seen is what gets
   * returned when it never is. */
  const waitForVisible = async (selector, timeoutMs = 8000) => {
    const until = Date.now() + timeoutMs
    let last = null
    for (;;) {
      last = await visibility(selector)
      if (last?.state === 'visible' || Date.now() >= until) return last
      await delay(250)
    }
  }
  const clickVisible = async (selector, { timeoutMs = 8000 } = {}) => {
    const spot = await waitForVisible(selector, timeoutMs)
    /* A refusal says WHAT refused. "covered" on its own sent a lane looking for
       a routing defect when the answer was the name of the element sitting on
       top of the control. */
    if (spot?.state === 'covered') return `covered-by-${spot.by}`
    if (spot?.state === 'offscreen') return `offscreen-${JSON.stringify(spot.box)}-in-${JSON.stringify(spot.viewport)}`
    if (spot?.state !== 'visible') return spot?.state || 'unknown'
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    }
    await delay(450)
    return 'clicked'
  }
  /* Typing, not assignment. A value assigned to `input.value` fires no events;
     a form that reads its fields on submit would still see it, but a form that
     validated as you type would not, and the difference is exactly the kind of
     thing a harness must not paper over. The field is focused by clicking it. */
  const typeInto = (selector, text) => typeExactText({ clickVisible, session, evaluate }, selector, text)
  await delay(2400)
  await evaluate('document.fonts ? document.fonts.ready.then(() => true) : true')
  return { child, session, timeline, evaluate, visibility, waitForVisible, clickVisible, typeInto, port }
}

/* Keep attach ownership independently driveable. In particular, reap the
   Windows PROCESS TREE while its root still exists: killing the Electron root
   first severs the relationship taskkill /T needs and can strand crashpad or a
   capability child. The parent kill is only the cross-platform/failure
   backstop, after the tree operation has had its chance. */
export async function attachOwnedChild({
  session,
  child,
  reapChild = reap,
  killParent = () => child.kill(),
  pause = delay,
} = {}) {
  try {
    await session.open()
  } catch (error) {
    try { session.close() } catch { /* no socket, or it already closed */ }
    try { reapChild(child.pid) } catch { /* fall through to the parent backstop */ }
    try { if (child.exitCode === null) killParent() } catch { /* it may already be gone */ }
    try { await pause(300) } catch { /* cleanup must not replace the attach error */ }
    throw error
  }
}

/* OFF WINDOWS THIS WAS NOT A REAP THAT FAILED, IT WAS A REAP THAT DID NOTHING.
   `taskkill.exe` is not on a Linux host, spawnSync therefore returned ENOENT,
   and the catch swallowed it -- so every driver's teardown reported success
   while leaving its whole Electron tree running, and the next driver in the
   suite would have started on a machine still carrying the last one's windows,
   ports and capability children. reapProcessTree keeps the Windows call
   exactly as it was and gives Linux a real answer: snapshot /proc while the
   parent links are still intact, kill the descendants, kill the root last. */
export function reap(pid) {
  if (!pid) return
  reapProcessTree(pid)
}

/**
 * Close the window the way a person closes it, and wait for the process to go.
 *
 * `window.close()` from the page runs the app's own close path -- which is what
 * a normal close/relaunch cycle has to exercise -- and the reap is the backstop
 * for a build that ignores it. Which of the two ended it is recorded, because
 * "the app would not close on its own" is a finding, not a detail.
 */
export async function closeWindow(window, { graceful = true, waitMs = 9000 } = {}) {
  if (!window) return null
  const { timeline, child } = window
  if (graceful) {
    try { await window.evaluate('window.close()', Math.min(waitMs, 5_000)) } catch { /* the page may already be gone */ }
  }
  const until = Date.now() + waitMs
  while (child.exitCode === null && Date.now() < until) await delay(250)
  timeline.closedGracefully = child.exitCode !== null
  try { window.session?.close() } catch { /* already gone */ }
  if (child.exitCode === null) {
    reap(child.pid)
    await delay(1200)
  }
  return timeline
}

export function describeTimeline(timeline) {
  if (!timeline) return 'no timeline'
  const window = timeline.windowAt ? `${timeline.windowAt - timeline.spawnedAt}ms` : 'NEVER'
  const exit = timeline.exitedAt ? `${timeline.exitCode} after ${timeline.exitedAt - timeline.spawnedAt}ms` : 'still running'
  return `pid=${timeline.pid} window=${window} exit=${exit} graceful=${timeline.closedGracefully === true}`
}

/**
 * Prove this run is reading a sterile data directory rather than the machine's
 * own installation. The app writes renderer-prefs.json into userData at startup,
 * so the file's location is the answer. Belief is not accepted here: a lane once
 * spent hours on a confident, wrong finding taken from inherited state.
 */
export function assertIsolated(profile) {
  const prefs = prefsFileFor(profile)
  if (!existsSync(prefs)) {
    throw new Error(`the app did not write ${prefs}; refusing to report on a data directory this run cannot locate`)
  }
  const real = path.join(process.env.APPDATA || '', 'ToolsEnabled')
  if (real && path.resolve(prefs).toLowerCase().startsWith(path.resolve(real).toLowerCase())) {
    throw new Error('this run is reading the real installation; refusing to continue')
  }
  return prefs
}

/* ------------------------------------------------------- driving the app -- */

export async function route(window) {
  return window.evaluate('document.body.dataset.route')
}

/** Everything the window is actually showing, as text, for a privacy read. */
export async function screenText(window) {
  const value = await window.evaluate('document.body.innerText || ""')
  return typeof value === 'string' ? value : ''
}

/**
 * Walk the ring forward by clicking the arrow, recording every stop.
 *
 * NAVIGATION IS BY CLICKING. A sibling harness reached its page by assigning
 * location.hash and passed on a build where nothing routed there.
 */
export async function walkRing(window, steps = 10) {
  const visited = []
  for (let step = 0; step < steps; step += 1) {
    const clicked = await window.clickVisible('#nav-next')
    if (clicked !== 'clicked') return { visited, clicked }
    await delay(400)
    visited.push({ route: await route(window), text: await screenText(window) })
  }
  return { visited, clicked: 'clicked' }
}

/* ---------------------------------------------------- getting about ------- *
 *
 * THE ONLY NAVIGATION THIS PRODUCT HAS IS TWO ARROWS, A GEAR, AND THE LINKS ON
 * THE PAGES. These helpers use exactly those. They live here rather than in each
 * driver because two copies of "how to reach the sign-in screen" is two copies
 * that disagree the first time the route changes, and the disagreement would be
 * reported as a product defect.
 *
 * THE DRAWER IS A MODAL AND IT COVERS THE TOOLBAR IT WAS OPENED FROM. It is
 * `role="dialog" aria-modal="true"`, and the shell parks the header and the
 * stage behind it with `inert`. A run that opened it to change a theme and then
 * walked away had every later click land on the drawer's backdrop -- which
 * reported as "the purchase screen is not on the ring" and ten other findings
 * that were about the harness. So its state is asked, never assumed.
 */

export async function drawerIsOpen(window) {
  return (await window.evaluate('Boolean(document.querySelector("#drawer.open"))')) === true
}

export async function openDrawer(window) {
  if (await drawerIsOpen(window)) return 'already-open'
  const clicked = await window.clickVisible('#open-settings')
  await delay(900)
  return clicked
}

export async function closeDrawer(window) {
  if (!(await drawerIsOpen(window))) return 'already-closed'
  const clicked = await window.clickVisible('#close-settings', { timeoutMs: 4000 })
  await delay(800)
  /* The drawer's state, not the click, is the answer: navigating away closes it
     on its own and the close button goes offstage with it. */
  return (await drawerIsOpen(window)) ? `still-open:${clicked}` : 'closed'
}

/** Back to the home screen from wherever this is, by clicking only. */
export async function gotoHome(window) {
  await closeDrawer(window)
  const here = await route(window)
  if (here === 'home') return 'already-there'
  if (here === 'account' || here === 'setup') {
    const back = await window.clickVisible('[data-account-home]', { timeoutMs: 5000 })
    if (back === 'clicked') { await delay(1100); if ((await route(window)) === 'home') return 'clicked' }
  }
  for (let step = 0; step < 12; step += 1) {
    if ((await route(window)) === 'home') return 'clicked'
    const next = await window.clickVisible('#nav-next')
    if (next !== 'clicked') return `arrow:${next}`
    await delay(420)
  }
  return `stuck-on-${await route(window)}`
}

/* Reach the full settings page: toolbar gear, then "all settings".
 *
 * FROM HOME, DELIBERATELY. Measured on this build: on the settings route the
 * floating `a.fleet-profile-notice` is painted over the bottom-right corner
 * where the drawer's own "all settings" link sits, so `elementFromPoint` there
 * returns the notice. home.css hides that notice on the home route, so the same
 * gesture works from home every time. Drivers that care about the overlap
 * measure it on its own rather than inferring it from a navigation failure. */
export async function gotoSettings(window) {
  if ((await route(window)) === 'settings') {
    await closeDrawer(window)
    return 'already-there'
  }
  const home = await gotoHome(window)
  if (home !== 'clicked' && home !== 'already-there') return `home:${home}`
  const opened = await openDrawer(window)
  if (opened !== 'clicked' && opened !== 'already-open') return `gear:${opened}`
  const all = await window.clickVisible('.drawer-all')
  if (all !== 'clicked') return `all-settings:${all}`
  await delay(1800)
  await closeDrawer(window)
  const landed = await route(window)
  return landed === 'settings' ? 'clicked' : `landed-on-${landed}`
}

/** Wait for the settings renderer to replace the previous category's DOM.
 *
 * A category button changes the address first. In a headless packaged window,
 * Chromium can defer the View Transition callback that swaps the page even
 * though the hash already names the new category. Reading the first section
 * after a fixed sleep therefore reported the old category and every following
 * selector measured the wrong page. The DOM sentinel is the outcome a person
 * is waiting for, so wait for it directly and return the last category seen on
 * refusal.
 */
export async function waitForSettingsCategory(window, category, {
  timeoutMs = 20_000,
  pause = delay,
  now = () => Date.now(),
} = {}) {
  const until = now() + timeoutMs
  let shown = null
  for (;;) {
    shown = await window.evaluate(
      `document.querySelector('.settings-sections .settings-section')?.dataset.settingsSection || null`)
    if (shown === category) return 'clicked'
    if (now() >= until) return `showing-${shown}`
    await pause(250)
  }
}

/* Reach ONE settings category, which since 2026-08-26 is a page of its own.
 *
 * The rail is navigation, not a table of contents: each category has its own
 * address (`#/settings?category=<slug>`) and the page draws that one alone. So
 * a driver that wants a control now has to say which category holds it, the
 * same way a person does -- opening every group and scrolling reached
 * everything on the old single-document page and reaches nothing here.
 *
 * The groups in the rail ship collapsed, so they are opened first. That is the
 * same gesture every driver used to make against the group heads in the main
 * column, moved to where the groups now are. */
export async function openSettingsCategory(window, category) {
  const settings = await gotoSettings(window)
  if (settings !== 'clicked' && settings !== 'already-there') return `settings:${settings}`
  await window.evaluate(`(() => {
    for (const head of document.querySelectorAll('.settings-rail [data-rail-group][aria-expanded="false"]')) head.click()
    return true
  })()`)
  await delay(400)
  const pressed = await window.clickVisible(`.settings-rail button[data-category=${JSON.stringify(category)}]`)
  if (pressed !== 'clicked') return `category:${pressed}`
  return waitForSettingsCategory(window, category)
}

/* Reach the sign-in surface: settings, the System category, then "Open sign-in".
 *
 * THE CATEGORY IS PART OF THE ROUTE, not a nicety. That link is the product's
 * one persistent door to #/account and it lives in System; on any other
 * category page it is not in the document at all, so a driver that went to
 * Settings and looked for it would report the door missing. */
export async function gotoAccount(window) {
  if ((await route(window)) === 'account') return 'already-there'
  const settings = await openSettingsCategory(window, 'System')
  if (settings !== 'clicked') return `settings:${settings}`
  const link = await window.clickVisible('a.ctl-btn[href="#/account"]')
  if (link !== 'clicked') return `sign-in-link:${link}`
  /* The account view paints a loading state first and repaints when the shell
     answers, so the form is waited for rather than assumed to be there. */
  await delay(1800)
  const landed = await route(window)
  if (landed !== 'account') return `landed-on-${landed}`
  await window.waitForVisible('[data-account-home]', 6000)
  return 'clicked'
}

/* ------------------------------------------- the account forms, by hand --- *
 *
 * EVERY STEP REPORTS WHICH STEP IT WAS. The first version of these collapsed
 * "reach the screen, switch the form, type, submit" into one boolean; when it
 * went red the report said only that something in a four-step sequence had not
 * worked, which is a fault report nobody can act on.
 *
 * The password is a parameter and goes exactly one place: an Input.insertText
 * over the local debugger. Nothing here logs it or returns it.
 */

export async function createAccountOnScreen(window, person, password) {
  const reached = await gotoAccount(window)
  if (reached !== 'clicked' && reached !== 'already-there') return `reach-account:${reached}`
  const creating = await window.evaluate('Boolean(document.querySelector(\'[data-account-form="create"]\'))')
  if (creating !== true) {
    const swap = await window.clickVisible('[data-account-mode="create"]')
    if (swap !== 'clicked') return `switch-to-create:${swap}`
    await delay(800)
  }
  const name = await window.typeInto('[data-account-form="create"] [name="username"]', person.username)
  if (name !== 'typed') return `username:${name}`
  if (person.displayName) {
    const shown = await window.typeInto('[data-account-form="create"] [name="displayName"]', person.displayName)
    if (shown !== 'typed') return `displayName:${shown}`
  }
  const secret = await window.typeInto('[data-account-form="create"] [name="password"]', password)
  if (secret !== 'typed') return `password-field:${secret}`
  const submitted = await window.clickVisible('[data-account-form="create"] button[type="submit"]')
  if (submitted !== 'clicked') return `submit:${submitted}`
  /* WAITED FOR, NOT SLEPT THROUGH.
   *
   * This was `await delay(11000)` with the note "scrypt at N=2^17 twice -- once
   * to create, once to sign in". The number was a guess at how long two key
   * derivations take on the machine that happens to be running, and it is the
   * wrong SHAPE of answer: a fixed sleep is right only on a machine exactly as
   * fast as the one it was written on. Measured 2026-08-18 on a staged packaged
   * build, tools/owner-account-packaged-qa read the screen at 11s and found the
   * create question still on it, and reported "the window says who is signed in
   * -- Who is using this copy?" -- four failures, on a run whose OWN later
   * checks proved the account existed, was signed in, and took a payment card.
   * The product had repainted; the harness had stopped looking.
   *
   * So the screen is polled for the outcome the person is waiting for, and the
   * wait ENDS on a refusal too: src/views/account.js paints "That did not work."
   * on a refused create, and a harness that waited out the full budget for that
   * would turn a fast, correct refusal into a slow timeout. */
  const settled = await waitForAccountOutcome(window)
  return settled.signedIn ? 'submitted' : `create-did-not-settle:${settled.detail}`
}

/**
 * Wait until the account screen has an ANSWER on it: signed in, or a refusal.
 *
 * The budget is generous rather than tuned. Two scrypt derivations at the
 * shipped cost are seconds of real work, and a slower machine is not a defect;
 * what would be a defect is the screen never changing, and that is what running
 * out of budget here reports.
 */
export async function waitForAccountOutcome(window, { timeoutMs = 60_000 } = {}) {
  const until = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await window.evaluate(`(() => {
      const title = document.querySelector('.setup-title')
      const notice = document.querySelector('.fleet-profile-status[role="alert"], .fleet-profile-status[role="status"], [data-account-notice], .setup-notice')
      return {
        title: title ? title.textContent.trim() : '',
        notice: notice ? notice.textContent.trim().slice(0, 160) : '',
        tone: notice ? (notice.getAttribute('data-tone') || notice.className) : '',
      }
    })()`)
    if (/^Signed in as /.test(last?.title || '')) return { signedIn: true, detail: last.title, waitedMs: timeoutMs - (until - Date.now()) }
    if (/did not work/i.test(last?.notice || '')) return { signedIn: false, detail: `refused: ${last.notice}` }
    if (Date.now() >= until) {
      /* SAY WHAT THE SCREEN ACTUALLY HAS ON IT. "the screen still reads X" was
         not enough to act on: it cannot tell a create that was refused in words
         this poll does not recognise from one that never answered at all. */
      const wider = await window.evaluate(`(() => {
        const body = document.querySelector('.setup-shell, .account-page, main') || document.body
        return (body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400)
      })()`)
      return { signedIn: false, detail: `after ${Math.round(timeoutMs / 1000)}s the screen still reads ${JSON.stringify(last?.title || '(no title)')}; notice=${JSON.stringify(last?.notice || '')}; screen=${JSON.stringify(wider)}` }
    }
    await delay(400)
  }
}

export async function signInOnScreen(window, person, password) {
  const reached = await gotoAccount(window)
  if (reached !== 'clicked' && reached !== 'already-there') return `reach-account:${reached}`
  const signingIn = await window.evaluate('Boolean(document.querySelector(\'[data-account-form="sign-in"]\'))')
  if (signingIn !== true) {
    const swap = await window.clickVisible('[data-account-mode="sign-in"]')
    if (swap !== 'clicked') return `switch-to-sign-in:${swap}`
    await delay(800)
  }
  const name = await window.typeInto('[data-account-form="sign-in"] [name="username"]', person.username)
  if (name !== 'typed') return `username:${name}`
  const secret = await window.typeInto('[data-account-form="sign-in"] [name="password"]', password)
  if (secret !== 'typed') return `password-field:${secret}`
  const submitted = await window.clickVisible('[data-account-form="sign-in"] button[type="submit"]')
  if (submitted !== 'clicked') return `submit:${submitted}`
  /* Same reasoning as createAccountOnScreen: one derivation here, not two, but
     a fixed sleep is the wrong shape of answer either way. */
  const settled = await waitForAccountOutcome(window)
  return settled.signedIn ? 'submitted' : `sign-in-did-not-settle:${settled.detail}`
}

export async function signOutOnScreen(window, { everywhere = false } = {}) {
  const reached = await gotoAccount(window)
  if (reached !== 'clicked' && reached !== 'already-there') return `reach-account:${reached}`
  const selector = everywhere ? '[data-account-sign-out-everywhere]' : '[data-account-sign-out]'
  const clicked = await window.clickVisible(selector)
  if (clicked !== 'clicked') return `sign-out-button:${clicked}`
  await delay(2200)
  return 'clicked'
}

export async function changePasswordOnScreen(window, currentPassword, newPassword) {
  const reached = await gotoAccount(window)
  if (reached !== 'clicked' && reached !== 'already-there') return `reach-account:${reached}`
  const onForm = await window.evaluate('Boolean(document.querySelector(\'[data-account-form="change-password"]\'))')
  if (onForm !== true) {
    const swap = await window.clickVisible('[data-account-mode="change-password"]')
    if (swap !== 'clicked') return `switch-to-change:${swap}`
    await delay(900)
  }
  const now = await window.typeInto('[data-account-form="change-password"] [name="currentPassword"]', currentPassword)
  if (now !== 'typed') return `current-password-field:${now}`
  const next = await window.typeInto('[data-account-form="change-password"] [name="newPassword"]', newPassword)
  if (next !== 'typed') return `new-password-field:${next}`
  const submitted = await window.clickVisible('[data-account-form="change-password"] button[type="submit"]')
  if (submitted !== 'clicked') return `submit:${submitted}`
  await delay(11000)
  return 'submitted'
}

/** The account state as the page itself sees it -- the same read the view does. */
export async function accountState(window) {
  return window.evaluate(`(async () => {
    const bridge = globalThis.mcAccount
    if (!bridge) return { bridge: false }
    const [availability, current] = await Promise.all([
      bridge.availability().catch(error => ({ threw: String(error && error.message) })),
      bridge.current().catch(error => ({ threw: String(error && error.message) })),
    ])
    return { bridge: true, availability, current }
  })()`)
}

/* -------------------------------------------------------------- scratch --- */

export function scratchDirectory(prefix) {
  /* Under the OS temp dir, never under the repository. artifacts/ is not
     gitignored, tools/require-clean-tree.mjs refuses to build from a dirty tree,
     and a harness that wrote its own evidence in-tree would break `npm run dist`
     every time it ran. */
  /* AND PRIVATE, WHICH UNTIL 1.0.45 IT WAS NOT. This host's umask is 002, so
     this mkdir produced 0775 and every launch whose userData sits under the
     directory was refused by shell/linux-account-state.cjs before it opened
     anything -- see makePrivateDirectory() in tools/lib/packaged-platform.mjs
     for the measurement. 22 drivers take their scratch root from here, so the
     one line fixes all of them; on Windows the mode is ignored. */
  const base = process.env.TEST_ACCOUNT_QA_SCRATCH || os.tmpdir()
  mkdirSync(base, { recursive: true })
  const directory = path.join(base, `${prefix}-${crypto.randomBytes(5).toString('hex')}`)
  return makePrivateDirectory(directory)
}

export function writeEvidence(scratch, name, body) {
  const file = path.join(scratch, name)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8')
  return file
}

export function readJsonIfPresent(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    /* Only ENOENT answers the question in this function's name. An exhausted
       descriptor table, a busy/unreadable device, or invalid bytes mean the
       instrument could not read an answer; returning null for those used to
       assert that the file was absent. This result is made afresh on every
       call: a transient read failure must never be latched for the drive. */
    if (error && error.code === 'ENOENT') return null
    return {
      code: 'JSON_READ_COULD_NOT_TELL',
      reason: `Could not read ${file}; this is not claiming the file is absent.`,
      errorCode: error && typeof error.code === 'string' ? error.code : 'UNKNOWN',
    }
  }
}
