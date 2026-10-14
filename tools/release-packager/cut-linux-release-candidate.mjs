#!/usr/bin/env node
/* THE ONE COMMAND, ON LINUX: produce a declarable ToolsEnabled .deb release candidate.
 *
 * This is the Linux counterpart of cut-release-candidate.mjs, and it keeps that
 * file's four rules on purpose:
 *
 *   1. NEVER build in the shared day-to-day worktree. Every cut is a fresh
 *      `git worktree add --detach` checkout of one exact commit.
 *   2. NEVER let the version number lie. The bump is written with the same
 *      lib/version-bump.mjs and verified by the same verify-version-transition.mjs.
 *   3. COPY THE ARTIFACT OUT BEFORE ANYTHING IS CLEANED UP, and re-hash the copy.
 *   4. DECLARE ONLY WHAT WAS MEASURED. declaration-facts-<version>.json carries
 *      hashes, dpkg fields and exit codes, never intent.
 *
 * Native packaging differs from the Windows cutter: NSIS/PE operations have
 * dpkg/ELF counterparts here -- `dpkg-deb --field` identity,
 * the .deb installed manifest (produce + verify-binding), the sealed ELF smoke
 * (smoke-linux-sealed.mjs) and, behind an operator decision, the installed
 * proof (`dpkg -i` + installed smoke + onboarding). These are additional
 * measurements, not replacements for the shared readiness scenario graph.
 * Both cutters require its exact-artifact receipt before a release tag.
 *
 * THE STATE ROOTS ARE OURS. Every dist-chain child receives the environment
 * the release packager itself builds -- cut-release-candidate.mjs's
 * buildDistChainEnvironment: TOOLSENABLED_STATE_ROOT, MC_TEST_STATE_ROOT,
 * TEMP, TMP and TMPDIR at <output>/scratch-<v>/ and MC_CANONICAL_ROOT at the
 * engine checkout, the set tools/test-strict.mjs establishes -- so the strict
 * test ratchet never measures (or writes) this machine's LIVE installation.
 * There is deliberately no second scratch set here: one containment rule,
 * one exhaustive leak test (tools/test/cut-dist-chain-environment.test.mjs)
 * covering both cutters.
 *
 * EVERY STEP IS A RECORDED CHILD PROCESS. Each one runs with cwd = the build
 * worktree, is wrapped in `/usr/bin/time -v` when that binary exists (peak RSS
 * lands in the record as peakRssKb), writes its own log beside the record, and
 * the record is rewritten after every step so a killed run still leaves the
 * steps that finished on disk. The real cut stops at the first non-zero exit.
 * `--continue-on-red` exists for a REHEARSAL only: it collects the whole
 * picture of a known-red base so a reader is not surprised one gate at a time.
 *
 * WHERE THE TOOLING COMES FROM. This file is written to live at
 * tools/release-packager/ next to cut-release-candidate.mjs and to load its
 * siblings (lib/version-bump.mjs, lib/git.mjs, lib/hash.mjs,
 * generate-declaration.mjs, cut-release-candidate.mjs's exported preflights)
 * relative to itself. A copy kept OUTSIDE the repository (the evidence copy a
 * rehearsal runs) has no siblings, so it resolves the same modules from
 * `--tooling-root`, which defaults to <--repo>/tools/release-packager. The
 * loaded tooling is therefore always the reviewed release packager of the
 * source repository, never a private copy of it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXACT_COMMIT = /^[0-9a-f]{40}$/
const SEMVER = /^\d+\.\d+\.\d+$/
const SHA256_LOWER = /^[0-9a-f]{64}$/
const TIME_BINARY = '/usr/bin/time'
const INSTALL_ROOT = '/opt/ToolsEnabled'
const DEB_PACKAGE = 'toolsenabled'
const DEB_ARCH = 'amd64'
/* Both are required, not just the owner-data patterns: tools/check-test-inputs.mjs
 * (the first command of `npm test`, which test-ratchet --strict runs) exits 3
 * without private/capability-source.owner.json, and the ratchet then reports
 * exit 2 "could not measure" -- measured on the second base-pair rehearsal.
 * The setting is operator-authored for the exact pair: its ref must equal
 * --engine-source-ref and its path --engine-repo (checked below, never
 * rewritten here). */
const REQUIRED_PRIVATE_INPUTS = Object.freeze(['owner-data-patterns.owner.json', 'capability-source.owner.json'])
const CAPABILITY_SOURCE_SETTING = 'capability-source.owner.json'
const GATES_SCHEMA = 'toolsenabled.linux-cut-gates'
const FACTS_SCHEMA = 'toolsenabled.linux-declaration-facts'
const NODE_MODULES_MODES = Object.freeze(['link', 'copy', 'npm-ci'])
/* Kept equal to KNOWN_PLATFORMS in tools/check-release-notes.mjs by
   tools/test/check-release-notes-platform-scope.test.mjs: a name this cutter
   accepts and that guard does not would pass a flag straight through to a
   refusal nobody could act on. */
const RELEASE_PLATFORMS = Object.freeze(['linux', 'windows', 'macos'])
/* The scope a caller who says nothing gets. Named once and read in both places
   that need it -- parseArgs() for a real invocation, planSteps() for a context
   built directly -- because two spellings of one default is how a plan and a
   run come to disagree about what is being cut. */
const DEFAULT_RELEASE_PLATFORMS = Object.freeze(['linux'])
/* The session keys tools/smoke-linux-sealed.mjs launchEnvironment() forwards. */
const SESSION_KEYS = Object.freeze(['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION'])
/* Exit codes: 0 cut complete; 1 refused or a required step failed; 2 usage.
 * Historical versions used 3/4 for post-tag notes and non-stopping UI failures.
 * Every gate now stops before the cut can be reported complete. */

function pad(index) {
  return String(index).padStart(2, '0')
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function sha256FileLower(filePath) {
  return sha256Hex(await readFile(filePath))
}

function usageError(message) {
  const error = new Error(message)
  error.usage = true
  return error
}

export function parseArgs(argv) {
  const args = {
    rehearsal: false, continueOnRed: false, plan: false, help: false, allowSameVersion: false,
    installedProof: false, removeWorktree: false, nodeModules: 'npm-ci',
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const valueFor = (noun = 'value') => {
      if (seen.has(arg)) throw usageError(`${arg} accepts exactly one ${noun}`)
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) throw usageError(`${arg} requires one ${noun}`)
      seen.add(arg)
      index += 1
      return value
    }
    if (arg === '--repo') args.repo = valueFor('path')
    else if (arg === '--engine-repo') args.engineRepo = valueFor('path')
    else if (arg === '--source-ref') args.sourceRef = valueFor('commit')
    else if (arg === '--engine-source-ref') args.engineSourceRef = valueFor('commit')
    else if (arg === '--version') args.version = valueFor('version')
    else if (arg === '--worktree') args.worktree = valueFor('path')
    else if (arg === '--output') args.output = valueFor('path')
    else if (arg === '--tooling-root') args.toolingRoot = valueFor('path')
    else if (arg === '--private-inputs') args.privateInputs = valueFor('path')
    else if (arg === '--onboarding-script') args.onboardingScript = valueFor('path')
    else if (arg === '--readiness-evidence') args.readinessEvidence = valueFor('path')
    else if (arg === '--readiness-output') args.readinessOutput = valueFor('path')
    else if (arg === '--readiness-context') args.readinessContext = valueFor('path')
    else if (arg === '--node-modules') args.nodeModules = valueFor('mode')
    else if (arg === '--resume-from-step') args.resumeFromStep = valueFor('step number')
    else if (arg === '--release-platform') {
      /* Repeatable, so it does not go through valueFor()'s exactly-one rule:
         a two-platform release names two. */
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
        throw usageError('--release-platform requires one platform name')
      }
      index += 1
      args.releasePlatforms = [...(args.releasePlatforms || []), value.trim().toLowerCase()]
    }
    else if (arg === '--rehearsal') args.rehearsal = true
    else if (arg === '--continue-on-red') args.continueOnRed = true
    else if (arg === '--allow-same-version') args.allowSameVersion = true
    else if (arg === '--installed-proof') args.installedProof = true
    else if (arg === '--remove-worktree') args.removeWorktree = true
    else if (arg === '--plan') args.plan = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw usageError(`unrecognised argument: ${arg}`)
  }
  if (args.help) return args
  for (const name of ['repo', 'engineRepo', 'sourceRef', 'engineSourceRef', 'version', 'worktree', 'output']) {
    if (!args[name]) throw usageError(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  }
  if (!EXACT_COMMIT.test(args.sourceRef)) throw usageError('--source-ref must be one exact 40-character lowercase commit id')
  if (!EXACT_COMMIT.test(args.engineSourceRef)) throw usageError('--engine-source-ref must be one exact 40-character lowercase commit id')
  if (!SEMVER.test(args.version)) throw usageError('--version must be major.minor.patch')
  if (!NODE_MODULES_MODES.includes(args.nodeModules)) throw usageError(`--node-modules must be one of ${NODE_MODULES_MODES.join(', ')}`)
  if (!args.rehearsal && args.nodeModules !== 'npm-ci') throw usageError('dependency reuse is rehearsal only; a release requires --node-modules npm-ci')
  /* WHICH PLATFORMS THE RELEASE SHIPS, WHICH IS NOT WHICH PLATFORM THIS CUTS.
     This cutter builds the Linux package and nothing else. What it also has to
     know is whether a Windows cutter is going to run for the SAME release,
     because that is the only thing that makes a pending Windows install record
     in the note a promise rather than a lie -- see the check-release-notes step
     and tools/test/check-release-notes-platform-scope.test.mjs.
     Defaulting to linux alone keeps 1.0.44's behaviour exactly: a release that
     does not say otherwise is the Linux-only release this flag was written for. */
  args.releasePlatforms = args.releasePlatforms?.length ? [...new Set(args.releasePlatforms)] : [...DEFAULT_RELEASE_PLATFORMS]
  const unknownPlatforms = args.releasePlatforms.filter((name) => !RELEASE_PLATFORMS.includes(name))
  if (unknownPlatforms.length > 0) {
    throw usageError(`--release-platform must be one of ${RELEASE_PLATFORMS.join(', ')}; got ${unknownPlatforms.join(', ')}`)
  }
  if (!args.releasePlatforms.includes('linux')) {
    throw usageError('--release-platform must include linux: this cutter builds the Linux package, so a release that omits it has nothing for this run to do')
  }
  if (args.continueOnRed && !args.rehearsal) throw usageError('--continue-on-red is rehearsal diagnostics only; the real cut stops at the first red step')
  if (args.resumeFromStep !== undefined) {
    if (!/^\d+$/.test(args.resumeFromStep) || Number(args.resumeFromStep) < 1) throw usageError('--resume-from-step needs a step number of 1 or more')
    args.resumeFromStep = Number(args.resumeFromStep)
    if (args.plan) throw usageError('--plan prints the whole plan; it does not resume')
    if (!args.rehearsal) throw usageError('--resume-from-step is rehearsal only: prior Linux records do not bind all mutable build inputs. Cut into a fresh worktree and output directory to qualify a release')
  }
  if (args.onboardingScript && !args.installedProof) throw usageError('--onboarding-script only runs with --installed-proof')
  if (args.rehearsal && (args.readinessEvidence || args.readinessOutput || args.readinessContext)) {
    throw usageError('rehearsal is diagnostic scope; readiness evidence/output/context belongs to a full cut/qualification')
  }
  return args
}

function printHelp() {
  console.log(`usage: node cut-linux-release-candidate.mjs [options]

Produces a declarable ToolsEnabled Linux (.deb) release candidate end to end:
isolated detached worktree -> private inputs -> capability payload -> version
bump commit -> verified transition -> the full dist chain with Linux targets ->
.deb identity, hashes and installed manifest -> (operator) installed proof ->
immutable build/<version> tag -> declaration-facts-<version>.json ->
checks the measured packet release note before creating the immutable tag.
All shared native qualification requirements apply. Missing Linux adapters
refuse before a build; smoke results cannot authorize a release on their own.

Qualification (same receipt admission as the Windows cutter):
  --readiness-evidence <file>  existing private receipt for the exact Linux artifact and refs
  --readiness-output <file>    private receipt destination (required for fresh qualification)
  --readiness-context <file>   paths-only native qualification context (required when producing)

Required:
  --repo <dir>                  application git checkout (a linked worktree is fine)
  --engine-repo <dir>           engine git checkout; its HEAD must equal --engine-source-ref
  --source-ref <sha>            exact 40-character application commit to cut
  --engine-source-ref <sha>     exact 40-character engine commit staged into the payload
  --version <X.Y.Z>             the version to cut (explicit; nothing is guessed)
  --worktree <dir>              NEW directory for the isolated build worktree (refused if present)
  --output <dir>                evidence directory: gates-<version>.json, per-step logs,
                                deb-manifest-<version>.json, declaration-facts-<version>.json,
                                the staged .deb copy and the sealed-smoke evidence

Optional:
  --rehearsal                   diagnostics run: worktree gets a -rehearsal suffix, no tag is
                                created (the would-be tag is written into the gates record)
  --continue-on-red             with --rehearsal only: keep running after a red step
  --plan                        print the resolved step list and exit; creates nothing, runs nothing
  --resume-from-step <n>        rehearsal diagnostics only; re-run from an existing gates record.
                                Release qualification always starts in a fresh worktree.
  --release-platform <name>     a platform THIS RELEASE ships, repeatable (default: linux).
                                Not which platform is being cut -- this cutter always cuts
                                Linux -- but which install records the release note is
                                allowed to carry. A two-platform release passes
                                --release-platform linux --release-platform windows
  --allow-same-version          the source already carries --version (no bump commit; buildRef =
                                --source-ref; the transition verifier is recorded not-applicable)
  --tooling-root <dir>          where lib/, generate-declaration.mjs and cut-release-candidate.mjs
                                are loaded from (default: this file's own directory when it lives
                                at tools/release-packager/, else <--repo>/tools/release-packager)
  --private-inputs <dir>        owner's untracked private inputs (default: <--repo>/private);
                                owner-data-patterns.owner.json is required, capability-source
                                .owner.json must agree with --engine-source-ref when present
  --node-modules <mode>         npm-ci (default, required for a release). Rehearsals may use link
                                or copy for diagnostics; lockfile equality does not prove the
                                installed dependency bytes or isolate a shared dependency tree.
  --installed-proof             run the operator steps inline: sudo -n dpkg -i, the installed
                                sealed smoke, and --onboarding-script if given. Without it those
                                steps are recorded as requiresOperator with their exact commands
  --onboarding-script <file>    the installed onboarding driver (argv: manifest manifestSha256
                                deb debSha256 appRef engineRef), run with --installed-proof
  --remove-worktree             after a complete cut, unlink node_modules and remove the worktree
                                (default: keep it; the installed proof needs it as --app-source)
  --help                        this text

Cutter attribution (required before a cut, same as cut-release-candidate.mjs):
  TOOLSENABLED_CUT_MODEL and TOOLSENABLED_CUT_EMAIL together, plus a unique
  TOOLSENABLED_CUT_SESSION of 4-200 characters using only A-Z, a-z, 0-9, _ or -.
  That validated pair is the version-bump commit's author and committer, with
  Git's Signed-off-by trailer. TOOLSENABLED_CUT_LANE is optional.

Exit codes: 0 cut complete; 1 refused or a stop step went red; 2 usage;
3 reserved for historical cuts whose release-notes check ran after tagging.
`)
}

/* ---------------------------------------------------------------- tooling */

function resolveToolingRoot(args) {
  if (args.toolingRoot) return path.resolve(args.toolingRoot)
  if (existsSync(path.join(HERE, 'lib', 'version-bump.mjs')) && existsSync(path.join(HERE, 'cut-release-candidate.mjs'))) return HERE
  return path.join(path.resolve(args.repo), 'tools', 'release-packager')
}

async function loadTooling(toolingRoot) {
  for (const relative of ['lib/git.mjs', 'lib/hash.mjs', 'lib/version-bump.mjs', 'cut-release-candidate.mjs', 'generate-declaration.mjs']) {
    if (!existsSync(path.join(toolingRoot, relative))) throw new Error(`tooling root ${toolingRoot} has no ${relative}; pass --tooling-root <repo>/tools/release-packager`)
  }
  const load = (relative) => import(pathToFileURL(path.join(toolingRoot, relative)).href)
  const [git, hash, versionBump, cutter, declaration] = await Promise.all([
    load('lib/git.mjs'), load('lib/hash.mjs'), load('lib/version-bump.mjs'), load('cut-release-candidate.mjs'), load('generate-declaration.mjs'),
  ])
  return { root: toolingRoot, git, hash, versionBump, cutter, declaration }
}

// An evidence-local copy loads the same reviewed policy from --tooling-root.
// A caller cannot provide adapters, an alternate scenario list or a verifier.
async function readinessTooling(ctx) {
  const root = ctx.tooling?.root ?? HERE
  const load = relative => import(pathToFileURL(path.join(root, relative)).href)
  const [core, handoff, planning] = await Promise.all([
    load('../lib/release-readiness.mjs'), load('lib/readiness-handoff.mjs'), load('lib/readiness-plan.mjs'),
  ])
  return { core, handoff, planning }
}

export async function measureLinuxCandidateArtifact(ctx) {
  const filename = debNameOf(ctx.version)
  if (ctx.deb?.file !== filename || !SHA256_LOWER.test(ctx.deb.sha256 || '') ||
      !Number.isSafeInteger(ctx.deb.bytes) || ctx.deb.bytes <= 0) {
    throw new Error('Release readiness blocked: the staged candidate identity is missing or names a different version')
  }
  const artifactPath = path.join(ctx.output, filename)
  const measured = await ctx.tooling.hash.measureFile(artifactPath)
  if (measured.sha256.toLowerCase() !== ctx.deb.sha256 || measured.bytes !== ctx.deb.bytes) {
    throw new Error('Release readiness blocked: staged installer bytes changed after the measured cut identity')
  }
  return { artifactPath, artifact: { sha256: measured.sha256, bytes: measured.bytes } }
}

async function qualifyCandidate(ctx, record) {
  const { core, handoff } = await readinessTooling(ctx)
  const target = core.LINUX_READINESS_TARGET
  core.assertReadinessAdaptersAvailable('toolsenabled', target)
  if (ctx.rehearsal) throw new Error('Release readiness blocked: a rehearsal cannot produce qualification evidence')
  const sourceRefs = { app: ctx.buildRef, engine: ctx.engineRef }
  const { artifactPath, artifact } = await measureLinuxCandidateArtifact(ctx)
  const paths = ctx.readinessPaths
  if (!paths) throw new Error('Release readiness blocked: no private receipt handoff was prepared')
  const context = paths.inputPath ? undefined : core.readQualificationContext(ctx.readinessContext, 'toolsenabled', {
    sourceRoots: { app: ctx.worktree, engine: ctx.engineRepo }, stageRoot: path.join(ctx.worktree, unpackedOf(ctx)),
    evidenceRoot: path.dirname(paths.outputPath),
  })
  ctx.readiness = paths.inputPath
    ? await core.readReleaseReadiness(paths.inputPath, { product: 'toolsenabled', target, artifact, sourceRefs })
    : await core.qualifyReleaseArtifact({ product: 'toolsenabled', target, artifactPath, sourceRefs, context })
  await measureLinuxCandidateArtifact(ctx)
  ctx.readinessHandoff = handoff.preserveReadinessReceipt(ctx.readiness, {
    ...paths, excludedRoots: [ctx.repo, ctx.worktree, ctx.output],
  })
  ctx.readinessSummary = handoff.publicReadinessSummary(ctx.readiness)
  record.note = 'Shared native qualification independently verified for the exact Linux artifact and App/Engine refs; private receipt retained'
}

async function assertCandidateReadiness(ctx) {
  const { core } = await readinessTooling(ctx)
  const target = core.LINUX_READINESS_TARGET
  // Refuse unavailable native implementations before touching any candidate.
  core.assertReadinessAdaptersAvailable('toolsenabled', target)
  const { artifact } = await measureLinuxCandidateArtifact(ctx)
  const receipt = await core.assertReleaseReadiness(ctx.readiness, {
    product: 'toolsenabled', target, artifact,
    sourceRefs: { app: ctx.buildRef, engine: ctx.engineRef },
  })
  // A supplied receipt may bind an independent identical artifact copy. The
  // staged download itself must still have the measured bytes after replay.
  await measureLinuxCandidateArtifact(ctx)
  return receipt
}

/* ---------------------------------------------------------------- process */

function parseTimeReport(text) {
  const result = { peakRssKb: null, timeExit: null, timeSignal: null, elapsed: null }
  for (const line of text.split(/\r?\n/)) {
    const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(line)
    if (rss) result.peakRssKb = Number(rss[1])
    const status = /Command exited with non-zero status (\d+)/.exec(line)
    if (status) result.timeExit = Number(status[1])
    const signal = /Command terminated by signal (\d+)/.exec(line)
    if (signal) result.timeSignal = Number(signal[1])
    const elapsed = /Elapsed \(wall clock\) time [^:]*: (.+)$/.exec(line)
    if (elapsed) result.elapsed = elapsed[1].trim()
  }
  return result
}

function timeBinaryAvailable() {
  if (!existsSync(TIME_BINARY)) return false
  const probe = spawnSync(TIME_BINARY, ['-v', 'true'], { encoding: 'utf8' })
  return probe.status === 0 && /Maximum resident set size/.test(probe.stderr || '')
}

/** One recorded child process: log file, time file, exit, signal, peak RSS. */
function runChild(command, { cwd, env, logPath, timePath, useTime, stdinText = null }) {
  return new Promise((resolve, reject) => {
    const argv = useTime ? [TIME_BINARY, '-v', '-o', timePath, ...command] : command
    const startedAt = new Date().toISOString()
    let output = ''
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const collect = (chunk) => {
      process.stdout.write(chunk)
      output += chunk.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    if (stdinText !== null) child.stdin.end(stdinText)
    child.once('error', reject)
    child.once('close', async (code, signal) => {
      const finishedAt = new Date().toISOString()
      await writeFile(logPath, output, 'utf8')
      let timing = { peakRssKb: null, timeExit: null, timeSignal: null, elapsed: null }
      if (useTime && existsSync(timePath)) timing = parseTimeReport(await readFile(timePath, 'utf8'))
      /* GNU time exits 128+N when the command dies by signal N, and passes a
         non-zero status through unchanged. Report the child's own facts. */
      const childSignal = signal ?? (timing.timeSignal != null ? timing.timeSignal : null)
      const childExit = childSignal != null && useTime ? null : code
      resolve({ exit: childExit, signal: childSignal, startedAt, finishedAt, output, peakRssKb: timing.peakRssKb, elapsed: timing.elapsed })
    })
  })
}

function gitOut(cwd, gitArgs) {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8' })
  if (result.error) throw new Error(`git ${gitArgs.join(' ')} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed (exit ${result.status}) in ${cwd}:\n${result.stderr || result.stdout}`)
  return result.stdout
}

function gitBytes(cwd, ref, relative) {
  const result = spawnSync('git', ['show', `${ref}:${relative}`], { cwd, encoding: null, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git show ${ref}:${relative} failed in ${cwd}: ${result.stderr?.toString('utf8') ?? ''}`)
  return result.stdout
}

/* ------------------------------------------------------------- preflights */

export function assertExactRefInRepo(repo, ref, label) {
  const resolved = gitOut(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
  if (resolved !== ref) throw new Error(`${label} ${ref} does not resolve to itself in ${repo}`)
  return resolved
}

/* The engine checkout is what pack-capability-layer.mjs and every
 * --engine-source consumer bind to (tools/lib/capability-source-git.mjs
 * assertCapabilitySourceGitBinding): HEAD must equal the declared ref and the
 * tree must be clean with no untracked files. Refusing here costs a second;
 * refusing inside the packer costs a worktree. */
export function assertEngineBinding(engineRepo, engineRef) {
  assertExactRefInRepo(engineRepo, engineRef, 'engine source ref')
  const head = gitOut(engineRepo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (head !== engineRef) throw new Error(`--engine-repo HEAD ${head} differs from --engine-source-ref ${engineRef}; check out the exact engine commit first`)
  const status = gitOut(engineRepo, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.trim().length > 0) throw new Error('--engine-repo is dirty or has untracked files; the capability packer refuses such a source')
  if (!existsSync(path.join(engineRepo, 'tools', 'mission-bridge.js'))) throw new Error('--engine-repo does not contain tools/mission-bridge.js; it is not the engine checkout')
}

export async function withEngineBinding({ engineRepo, engineRef }, operation) {
  // The source suite reads this checkout as well as the staged payload. A
  // check at cut startup alone cannot bind a long run to one source pair.
  assertEngineBinding(engineRepo, engineRef)
  const result = await operation()
  assertEngineBinding(engineRepo, engineRef)
  return result
}

/* Which private files travel into the worktree: exactly the ones
 * cut-release-candidate.mjs copyPrivateInputs() copies -- files under the
 * private inputs directory that are NOT git-tracked at the source commit.
 * Tracked private/ files (fleet-profile.owner.json, research-queue.authored.json)
 * are already in the checkout with their reviewed content and are left alone.
 * Nothing else goes in (owner privacy rule D3). */
export function classifyPrivateInputs(privateDir, trackedRelativePaths) {
  const tracked = new Set(trackedRelativePaths)
  return async function classify() {
    if (!existsSync(privateDir)) return { copied: [], skippedTracked: [] }
    const entries = await readdir(privateDir, { withFileTypes: true, recursive: true })
    const copied = []
    const skippedTracked = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const sourceFile = path.join(entry.parentPath ?? entry.path, entry.name)
      const relativeFromPrivate = path.relative(privateDir, sourceFile)
      if (tracked.has(path.posix.join('private', relativeFromPrivate.split(path.sep).join('/')))) {
        skippedTracked.push(relativeFromPrivate)
        continue
      }
      copied.push(relativeFromPrivate)
    }
    return { copied, skippedTracked }
  }
}

/* The private inputs are inspected, never invented. Every problem is a
 * refusal for a cut; --plan lists them instead so the reader sees what the
 * real run would refuse before it is started. */
async function inspectPrivateInputs(privateDir, repo, sourceRef, engineRepo, engineRef) {
  const problems = []
  for (const required of REQUIRED_PRIVATE_INPUTS) {
    if (!existsSync(path.join(privateDir, required))) {
      problems.push(required === 'capability-source.owner.json'
        ? `private input ${required} is missing from ${privateDir}. tools/check-test-inputs.mjs (first command of npm test, run by test-ratchet --strict) exits 3 without it. Write {"path": "<--engine-repo>", "ref": "<--engine-source-ref>"} there by hand for this exact pair. Nothing is invented here.`
        : `private input ${required} is missing from ${privateDir}. tools/check-no-owner-data.mjs exits 2 without it; start from config/owner-data-patterns.example.json. Nothing is invented here.`)
    }
  }
  const setting = path.join(privateDir, CAPABILITY_SOURCE_SETTING)
  let capabilitySource = null
  if (existsSync(setting)) {
    let parsed = null
    try { parsed = JSON.parse(await readFile(setting, 'utf8')) } catch (error) { problems.push(`${CAPABILITY_SOURCE_SETTING} is not valid JSON: ${error.message}`) }
    capabilitySource = { path: parsed?.path ?? null, ref: parsed?.ref ?? null }
    if (parsed && parsed.ref !== engineRef) {
      problems.push(`${CAPABILITY_SOURCE_SETTING} in ${privateDir} declares ref ${parsed.ref ?? '(none)'}, but this cut declares --engine-source-ref ${engineRef}. docs/REPRODUCIBLE-BUILD.md: the setting's ref, --engine-source-ref and the engine HEAD must agree. Update the setting by hand (it is never rewritten here) or remove it.`)
    }
    if (parsed && typeof parsed.path === 'string' && parsed.path.trim() && realpathSafe(path.resolve(parsed.path)) !== realpathSafe(engineRepo)) {
      problems.push(`${CAPABILITY_SOURCE_SETTING} names a different engine checkout than --engine-repo; conflicting declarations are refused rather than resolved silently`)
    }
  }
  const tracked = gitOut(repo, ['ls-tree', '-r', '--name-only', sourceRef, '--', 'private']).split(/\r?\n/).filter(Boolean)
  const classified = await classifyPrivateInputs(privateDir, tracked)()
  // Names and sizes only, from stat: the contents are the operator's identity
  // profile and are never read here. Digests are measured by the packager's
  // copyPrivateInputs on the bytes that actually land in the worktree.
  const files = []
  for (const relative of classified.copied) files.push({ file: relative.split(path.sep).join('/'), bytes: (await stat(path.join(privateDir, relative))).size })
  return { directory: privateDir, files, skippedTracked: classified.skippedTracked, capabilitySource, problems }
}

/* CHROMIUM'S SANDBOX DECIDES WHETHER THE SEALED SMOKE CAN LAUNCH AT ALL. With
 * kernel.apparmor_restrict_unprivileged_userns=1 (Ubuntu 24.04 default) a
 * process with no AppArmor profile cannot create the user namespace Chromium's
 * sandbox needs, and an unpacked build's chrome-sandbox is not root:4755, so
 * the application aborts before it is ready. Measured on the second base-pair
 * rehearsal: exit 133 "The SUID sandbox helper binary was found, but is not
 * configured correctly" from a bare user service (label "unconfined"); the same
 * binary launches from a shell whose label is the toolsenabled-linux-live
 * profile in unconfined mode. Refuse up front rather than at step 41. */
export function sandboxReport({ label = readSafe('/proc/self/attr/current'), restrict = readSafe('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') } = {}) {
  const unconfinedWithoutProfile = label === 'unconfined'
  return { apparmorLabel: label, apparmorRestrictUnprivilegedUserns: restrict, unconfinedWithoutProfile,
    launchable: !(restrict === '1' && unconfinedWithoutProfile) }
}
function readSafe(file) { try { return readFileSync(file, 'utf8').trim() } catch { return null } }

export function sessionEnvironmentReport(env) {
  const present = SESSION_KEYS.filter((key) => typeof env[key] === 'string' && env[key].trim().length > 0)
  return { keys: SESSION_KEYS, present, absent: SESSION_KEYS.filter((key) => !present.includes(key)) }
}

function realpathSafe(target) {
  try { return realpathSync(target) } catch { return path.resolve(target) }
}

/* Same identity rule as lib/node-modules-reuse.mjs, on POSIX: the source tree's
 * node_modules is reused only when its package-lock.json is byte-identical to
 * the SOURCE COMMIT's (the bump commit changes the lock's root version and
 * nothing else, so the source commit's lock is the honest comparison), and the
 * two shims `npm run dist` invokes by name plus electron/dist are present. */
function nodeModulesReusePlan(repo, sourceRef, requestedMode) {
  const source = path.join(repo, 'node_modules')
  const resolvedSource = existsSync(source) ? realpathSafe(source) : null
  const reasons = []
  if (!resolvedSource) reasons.push('source node_modules is absent')
  else {
    const repoLock = path.join(repo, 'package-lock.json')
    if (!existsSync(repoLock)) reasons.push('source package-lock.json is absent')
    else {
      const repoLockBytes = spawnSync('cat', [repoLock], { encoding: null, maxBuffer: 64 * 1024 * 1024 }).stdout
      if (!repoLockBytes.equals(gitBytes(repo, sourceRef, 'package-lock.json'))) reasons.push('source package-lock.json differs from the source commit')
    }
    for (const shim of ['.bin/vite', '.bin/electron-builder', 'electron/dist/electron']) {
      if (!existsSync(path.join(resolvedSource, shim))) reasons.push(`${shim} is missing under the source node_modules`)
    }
  }
  if (requestedMode === 'npm-ci') return { mode: 'npm-ci', source: null, reasons }
  if (reasons.length > 0) {
    if (requestedMode === 'link' || requestedMode === 'copy') return { mode: 'npm-ci', source: null, reasons, fellBackFrom: requestedMode }
  }
  return { mode: requestedMode, source: resolvedSource, reasons }
}

/* --------------------------------------------------------------- the plan */

function unpackedOf(ctx) {
  return `release/cut-${ctx.version}/linux-unpacked`
}

function debNameOf(version) {
  return `${DEB_PACKAGE}_${version}_${DEB_ARCH}.deb`
}

/** Every step, in order. Children, driver actions and inline installed proofs
 * stop on failure. Only an explicit rehearsal may continue after a red step. */
/** Pure. The dist-chain environment for a Linux cut is the release packager's
 * buildDistChainEnvironment (the ONE containment rule: scratch state/temp
 * roots, strict marker, dirty-build override stripped, engine ref bound),
 * with the engine checkout additionally bound as the packer's source:
 * tools/pack-capability-layer.mjs and capability-source-git.mjs read
 * TOOLSENABLED_SOURCE beside TOOLSENABLED_SOURCE_REF, and the Windows cutter
 * sets only the ref because its packer resolves the path itself. A packager
 * that has no builder is refused outright; this file never falls back to a
 * scratch set of its own. */
export function linuxDistChainEnvironment(processEnv, cutter, { scratchState, scratchTemp, engineRepo, engineRef, sourceRepo = null, workspaceSegments = undefined } = {}) {
  if (typeof cutter?.buildDistChainEnvironment !== 'function') {
    throw new Error('the release packager at --tooling-root exports no buildDistChainEnvironment; a Linux cut needs the packager whose dist chain owns its state and temp roots, and never builds a scratch set of its own')
  }
  if (!engineRepo || !EXACT_COMMIT.test(String(engineRef ?? ''))) throw new Error('the Linux dist-chain environment binds the engine checkout and its exact 40-character ref')
  // T334: the packager derives the owner's workspace names from the app repo
  // being cut and the engine checkout (plus any live roots the shell carries) and
  // refuses by name when it can produce none; the Linux driver hands it the same
  // two roots so the owner-data scan inside the cut is not shell-dependent.
  const env = cutter.buildDistChainEnvironment(processEnv, { scratchState, scratchTemp, canonicalRoot: engineRepo, engineSourceRef: engineRef, sourceRepo, workspaceSegments })
  env.TOOLSENABLED_SOURCE = engineRepo
  return env
}

export function planSteps(ctx) {
  const node = ctx.node
  const outDir = `release/cut-${ctx.version}`
  const unpacked = unpackedOf(ctx)
  const debRel = path.posix.join(outDir, debNameOf(ctx.version))
  const debAbs = path.join(ctx.worktree, debRel)
  const unpackedAbs = path.join(ctx.worktree, unpacked)
  const capability = path.posix.join(unpacked, 'resources', 'capability')
  const manifest = path.join(ctx.output, `deb-manifest-${ctx.version}.json`)
  const buildRef = () => ctx.buildRef ?? '<buildRef>'
  const debSha = () => ctx.debSha256 ?? '<debSha256>'
  const manifestSha = () => ctx.manifestSha256 ?? '<manifestSha256>'
  const steps = []
  const child = (name, group, command, extra = {}) => steps.push({ kind: 'child', stop: true, name, group, command, ...extra })
  const driver = (name, group, command, run, extra = {}) => steps.push({ kind: 'driver', stop: true, name, group, command, run, ...extra })
  const operator = (name, group, command, extra = {}) => steps.push({ kind: 'operator', stop: true, requiresOperator: true, name, group, command, ...extra })

  // THE APPLICATION REPOSITORY IS SHALLOW (app/.git/shallow). A detached
  // worktree inherits the marker; a clone would silently drop it and a later
  // history walk would fail on the missing parents. Prove, in the throwaway
  // checkout, that its history is countable and connected before anything is
  // staged. Every later walk in this driver is one commit deep
  // (verify-version-transition.mjs: rev-parse, rev-list -n 1, diff-tree,
  // cat-file on source-ref..build-ref only), so the boundary is never crossed.
  child('git-rev-list-count-head', 'preflight', ['git', 'rev-list', '--count', 'HEAD'], { after: recordRevListCount })
  child('git-fsck-connectivity-only', 'preflight', ['git', 'fsck', '--connectivity-only'], { after: recordFsck })

  // Discovery imports the packaged-QA parser from rollup. A fresh worktree
  // needs its measured dependencies before any wrapper gate can load that
  // parser; a dependency tree elsewhere in the developer checkout is not enough.
  if (ctx.nodeModules.mode === 'link') child('node-modules-link', 'cutter', ['ln', '-s', ctx.nodeModules.source, 'node_modules'])
  else if (ctx.nodeModules.mode === 'copy') child('node-modules-copy', 'cutter', ['cp', '-a', ctx.nodeModules.source, 'node_modules'])
  else child('node-modules-npm-ci', 'cutter', ['npm', 'ci'])
  child('native-test-dependencies', 'cutter', [node, 'tools/prepare-native-test-dependencies.mjs'])

  // release:cut wrapper gates (package.json "release:cut"), after the payload
  // exists so check:boundary:ship has a staged capability/ to inspect.
  child('pack-capability-layer-source-ref', 'cutter', [node, 'tools/pack-capability-layer.mjs', '--source', ctx.engineRepo, '--source-ref', ctx.engineRef])
  child('check-boundary-ship', 'release-cut-wrapper', [node, 'tools/check-payload-boundary.mjs', '--ship'])
  child('check-naming', 'release-cut-wrapper', [node, 'tools/check-product-naming.mjs'])
  child('check-github-claims-wrapper', 'release-cut-wrapper', [node, 'tools/check-github-claims.mjs'])
  child('check-drivers-discovered', 'release-cut-wrapper', [node, 'tools/check-drivers-discovered.mjs'])
  /* --receipts is what makes this a gate. Without it the guard only checks that
     every run-*.mjs is DECLARED and returns green ("discovered is not
     executed"), so a required proof with a red, stale or missing receipt could
     not redden the cut (Lane B, 2026-09-18, T396). With it, every required
     proof must carry an attributable passing receipt from one real execution
     against this tree, and a missing one is a failure, never a skip (R1228). */
  child('check-browser-proofs-discovered', 'release-cut-wrapper', [node, 'tools/check-browser-proofs-discovered.mjs', '--receipts', 'private/browser-proof-receipts'])
  // T339: a committed capture carrying a real machine's profile path must
  // stop the cut here, in the fresh worktree, not be discovered in the .deb.
  child('check-no-profile-paths', 'release-cut-wrapper', [node, 'tools/check-no-profile-paths.mjs'])

  // version bump commit + independent transition proof (cutter :834-869)
  driver('version-bump-commit', 'cutter',
    ['git', 'add', '--', 'package.json', 'package-lock.json', '&&', 'git', 'commit', '--signoff', '-F', '-', '--', 'package.json', 'package-lock.json'],
    versionBumpCommit, { notApplicable: ctx.sameVersion ? 'source already carries this version (--allow-same-version); buildRef = sourceRef' : null })
  child('verify-version-transition', 'cutter',
    () => [node, 'tools/release-packager/verify-version-transition.mjs', '--repo', ctx.repo, '--source-ref', ctx.sourceRef, '--build-ref', buildRef(), '--version', ctx.version],
    { notApplicable: ctx.sameVersion ? 'no bump commit exists to verify; buildRef equals sourceRef' : null, env: () => ({}) })
  child('worktree-clean-before-build', 'cutter', ['git', 'status', '--porcelain'], { expectEmptyOutput: true })

  // package.json "dist", in order, with Linux targets where the Windows chain names win-unpacked
  child('predist-report-build-scope', 'dist', [node, 'tools/report-build-scope.mjs'])
  // T240: retain a renderer for diagnosis when the later ratchet refuses.
  // Preflight/version/cleanliness checks stay above; all release gates still stop.
  child('npm-run-build', 'dist', ['npm', 'run', 'build'])
  child('verify-release-test-ratchet-strict', 'dist', [node, 'tools/test-ratchet.mjs', '--strict'],
    { env: () => ({ TOOLSENABLED_TEST_STRICT: '1', TOOLSENABLED_TEST_EVIDENCE_ROOT: path.join(ctx.output, 'source-suite') }) })
  child('check-plain-language', 'dist', [node, 'tools/check-plain-language.mjs'])
  child('check-github-claims', 'dist', [node, 'tools/check-github-claims.mjs'])
  child('check-composed-output', 'dist', [node, 'tools/check-composed-output.mjs'])
  child('check-research-queue', 'dist', [node, 'tools/check-research-queue.mjs'])
  child('check-data-schemas', 'dist', [node, 'tools/check-data-schemas.mjs'])
  child('check-license-notices-source', 'dist', [node, 'tools/check-license-notices.mjs'])
  child('check-dist-current-record', 'dist', [node, 'tools/check-dist-current.mjs', 'dist', '--record'])
  child('check-renderer-payload-source', 'dist', [node, 'tools/check-renderer-payload.mjs'])
  child('check-dist-current', 'dist', [node, 'tools/check-dist-current.mjs', 'dist'])
  child('pack-capability', 'dist', [node, 'tools/pack-capability-layer.mjs'])
  child('check-product-naming', 'dist', [node, 'tools/check-product-naming.mjs'])
  child('check-payload-current-capability', 'dist', [node, 'tools/check-payload-current.mjs', 'capability'])
  child('check-payload-boundary-capability', 'dist', [node, 'tools/check-payload-boundary.mjs', 'capability'])
  child('require-clean-tree', 'dist', [node, 'tools/require-clean-tree.mjs', 'dist'])
  child('check-electron-runtime-files-prepare', 'dist', [node, 'tools/check-electron-runtime-files.mjs', '--prepare', unpacked])
  child('launch-readiness-sync-packed-payload', 'dist', [node, 'tools/launch-readiness-sync-packed-payload.mjs', '--packed', capability])
  child('electron-builder-linux-deb', 'dist', [node, 'node_modules/electron-builder/out/cli/cli.js', '--linux', 'deb', '--x64', `--config.directories.output=${outDir}`])
  child('check-electron-runtime-files', 'dist', [node, 'tools/check-electron-runtime-files.mjs', unpacked])
  child('strip-build-diagnostics', 'dist', [node, 'tools/strip-build-diagnostics.mjs', outDir])
  child('check-asar-manifest', 'dist', [node, 'tools/check-asar-manifest.mjs', unpacked])
  child('check-renderer-payload', 'dist', [node, 'tools/check-renderer-payload.mjs', unpacked])
  child('check-no-owner-data-unpacked', 'dist', [node, 'tools/check-no-owner-data.mjs', unpacked])
  child('check-license-notices-unpacked', 'dist', [node, 'tools/check-license-notices.mjs', unpacked])
  child('check-payload-boundary-unpacked', 'dist', [node, 'tools/check-payload-boundary.mjs', capability])
  child('check-artifact-private', 'dist', [node, 'tools/check-artifact-private.mjs', unpacked])
  child('seal-artifact-record', 'dist', [node, 'tools/seal-artifact.mjs', '--record', unpacked])
  child('smoke-linux-sealed-unpacked', 'dist',
    () => [node, 'tools/smoke-linux-sealed.mjs', '--artifact', unpackedAbs, '--app-source', ctx.worktree, '--engine-source', ctx.engineRepo,
      '--expected-app-ref', buildRef(), '--expected-engine-ref', ctx.engineRef, '--proof-mode', 'unpacked',
      '--evidence-dir', path.join(ctx.output, `sealed-unpacked-${ctx.version}`)],
    { replaces: 'tools/smoke-packaged.mjs (Windows .exe launch); the sealed ELF smoke brackets itself with seal-artifact --verify' })
  child('seal-artifact-verify', 'dist', [node, 'tools/seal-artifact.mjs', '--verify', unpacked],
    { replaces: 'the in-place half of tools/check-install-dir-immutable.mjs (.exe launch); the installed-tree half is the installed smoke below' })
  child('check-payload-boundary-unpacked-after', 'dist', [node, 'tools/check-payload-boundary.mjs', capability])
  child('check-no-owner-data-release', 'dist', [node, 'tools/check-no-owner-data.mjs', 'release'])

  // provenance, identity and hashes (cutter :888-1004, PE identity replaced by dpkg fields)
  driver('build-info-provenance', 'cutter', ['<driver>', 'assertBuildProvenance', 'dist/build-info.json'], buildInfoProvenance)
  child('dpkg-deb-field-identity', 'identity', ['dpkg-deb', '--field', debRel, 'Package', 'Version', 'Architecture'], { after: assertDebIdentity })
  child('deb-chmod-0644', 'identity', ['chmod', '0644', debRel])
  child('deb-sha256sum', 'identity', ['sha256sum', debRel], { after: recordDebSha256 })
  child('deb-stat', 'identity', ['stat', '-c', '%n %s %a %U:%G %y', debRel])
  driver('stage-deb-copy-and-rehash', 'cutter', ['cp', debRel, path.join(ctx.output, debNameOf(ctx.version)), '&&', 'sha256', 'both'], stageDeb)
  child('linux-installed-manifest-produce', 'identity',
    () => [node, 'tools/linux-installed-manifest.mjs', 'produce', '--deb', debAbs, '--package-sha256', debSha(), '--app-source', ctx.worktree,
      '--engine-source', ctx.engineRepo, '--app-ref', buildRef(), '--engine-ref', ctx.engineRef, '--output', manifest],
    { after: recordManifestSha256 })
  child('linux-installed-manifest-verify-binding', 'identity',
    () => [node, 'tools/linux-installed-manifest.mjs', 'verify-binding', '--deb', debAbs, '--package-sha256', debSha(), '--app-ref', buildRef(),
      '--engine-ref', ctx.engineRef, '--manifest', manifest, '--manifest-sha256', manifestSha()])

  // Exact-artifact UI failures stop before installation and the immutable tag.
  // The .45 acceptance requirement supersedes the historical Linux disclosure
  // exception. A host refusal, timeout or driver failure must be repaired and
  // measured again; the sealed smoke cannot substitute for these journeys.
  child('packaged-qa-suite', 'cutter', [node, 'tools/packaged-qa-suite.mjs', '--release', unpackedAbs])
  child('worktree-clean-after-qa', 'cutter', ['git', 'status', '--porcelain'], { expectEmptyOutput: true })

  // installed proof: the .43 commands, exactly; sudo means an operator decision
  operator('dpkg-install', 'installed', ['sudo', '-n', 'dpkg', '-i', debAbs])
  operator('smoke-linux-sealed-installed', 'installed',
    () => [node, 'tools/smoke-linux-sealed.mjs', '--artifact', INSTALL_ROOT, '--app-source', ctx.worktree, '--engine-source', ctx.engineRepo,
      '--expected-app-ref', buildRef(), '--expected-engine-ref', ctx.engineRef, '--proof-mode', 'installed', '--deb', debAbs,
      '--expected-package-sha256', debSha(), '--installed-manifest', manifest, '--expected-manifest-sha256', manifestSha(),
      '--evidence-dir', path.join(ctx.output, `installed-sealed-${ctx.version}`)])
  operator('installed-onboarding', 'installed',
    () => [node, ctx.onboardingScript ?? '<onboarding-script>', manifest, manifestSha(), debAbs, debSha(), buildRef(), ctx.engineRef],
    { note: 'the .43 driver lived in the .43 evidence directory (installed-onboarding-final-43.mjs); pass an adapted copy with --onboarding-script' })

  driver('release-readiness', 'qualification',
    ['<shared qualifier>', 'toolsenabled', 'linux-x64', 'exact artifact and App/Engine refs'], qualifyCandidate,
    { note: 'Every required shared scenario/profile must pass; package and smoke records cannot substitute for native qualification' })

  // Complete the packet note from the measured artifact; changing the tracked
  // source note after building would break the source/artifact identity.
  driver('stage-release-notes', 'cutter', ['<driver>', 'fill measured Linux install record'], stageReleaseNotes)
  const releasePlatforms = ctx.releasePlatforms?.length ? ctx.releasePlatforms : DEFAULT_RELEASE_PLATFORMS
  child('check-release-notes', 'release-cut-final',
    [node, 'tools/check-release-notes.mjs', '--notes', path.join(ctx.output, `RELEASE-NOTES-${ctx.version}.md`),
      ...releasePlatforms.flatMap((platform) => ['--platform', platform]), '--packet-platform', 'linux'])

  driver('excluded-wip-and-other-candidates', 'cutter', ['git', 'status', '--porcelain', '(--repo)', '&&', 'scan', 'for', 'other', debNameOf(ctx.version)], excludedWipAndOtherCandidates)
  driver('tag-build-version', 'cutter', ['git', '-C', ctx.repo, 'tag', `build/${ctx.version}`, '<buildRef>'], tagCandidate)
  driver('declaration-facts', 'cutter', ['<driver>', 'write', `declaration-facts-${ctx.version}.json`, '(measured facts only)'], writeFacts)
  child('declaration-facts-owner-data-scan', 'cutter', [node, 'tools/check-no-owner-data.mjs', path.join(ctx.output, `facts-scan-${ctx.version}`)], { after: publishFacts })

  steps.forEach((step, index) => { step.index = index + 1 })
  return steps
}

function resolveCommand(step, ctx) {
  const command = typeof step.command === 'function' ? step.command(ctx) : step.command
  return command.map((part) => String(part))
}

/* ----------------------------------------------------------- driver steps */

async function versionBumpCommit(ctx, record) {
  const { versionBump, git } = ctx.tooling
  const packageJsonPath = path.join(ctx.worktree, 'package.json')
  const bump = await versionBump.writePackageVersion(packageJsonPath, ctx.version)
  const message = `package files: bump version to ${ctx.version} for release candidate\n\n`
    + 'Automated by tools/release-packager/cut-linux-release-candidate.mjs. Built from '
    + `${ctx.sourceRef} in an isolated, detached worktree; the day-to-day worktree was never entered.\n\n`
    + `${ctx.attribution.cutterAttribution}\n`
  ctx.buildRef = git.commitPaths(ctx.worktree, ['package.json', 'package-lock.json'], message, { identity: ctx.attribution.cutterIdentity, signoff: true })
  record.note = `${bump.previousVersion} -> ${bump.newVersion}; commit ${ctx.buildRef}`
  ctx.derived.buildRef = ctx.buildRef
}

async function recordRevListCount(ctx, record, result) {
  const count = result.output.trim()
  if (!/^\d+$/.test(count)) throw new Error('git rev-list --count HEAD printed no number; the checkout history is not countable')
  ctx.history = { ...(ctx.history ?? {}), revListCountHead: Number(count), shallow: gitOut(ctx.worktree, ['rev-parse', '--is-shallow-repository']).trim() === 'true' }
  ctx.derived.history = ctx.history
  record.note = `${count} commit(s) reachable from HEAD; shallow=${ctx.history.shallow}`
}

async function recordFsck(ctx, record, result) {
  const excerpt = result.output.trim().split(/\r?\n/).filter(Boolean).slice(-5)
  ctx.history = { ...(ctx.history ?? {}), fsckConnectivityOnlyExit: 0, fsckOutputTail: excerpt }
  ctx.derived.history = ctx.history
  record.note = `connectivity check exit 0${excerpt.length ? `; last line: ${excerpt[excerpt.length - 1]}` : ''}`
}

async function buildInfoProvenance(ctx, record) {
  const buildInfoPath = path.join(ctx.worktree, 'dist', 'build-info.json')
  if (!existsSync(buildInfoPath)) throw new Error('dist/build-info.json is missing after the dist chain; require-clean-tree.mjs should always write it')
  const buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'))
  ctx.tooling.cutter.assertBuildProvenance(buildInfo, { buildRef: ctx.buildRef, engineSourceRef: ctx.engineRef })
  ctx.buildInfo = { ref: buildInfo.ref, dirty: buildInfo.dirty, overridden: buildInfo.overridden, payloadRef: buildInfo.payload?.ref }
  ctx.derived.buildInfo = ctx.buildInfo
  record.note = `dirty=${buildInfo.dirty} overridden=${buildInfo.overridden} ref=${buildInfo.ref} payload=${buildInfo.payload?.ref}`
}

async function assertDebIdentity(ctx, record, result) {
  const lines = result.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const fields = {}
  for (const line of lines) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (match) fields[match[1]] = match[2]
  }
  ctx.dpkg = { Package: fields.Package ?? null, Version: fields.Version ?? null, Architecture: fields.Architecture ?? null }
  ctx.derived.dpkg = ctx.dpkg
  const expected = { Package: DEB_PACKAGE, Version: ctx.version, Architecture: DEB_ARCH }
  const mismatches = Object.entries(expected).filter(([key, value]) => ctx.dpkg[key] !== value)
  if (mismatches.length > 0) {
    throw new Error(`.deb identity does not match release ${ctx.version}: ${mismatches.map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, measured ${JSON.stringify(ctx.dpkg[key])}`).join('; ')}`)
  }
  record.note = `${ctx.dpkg.Package}/${ctx.dpkg.Version}/${ctx.dpkg.Architecture}`
}

async function recordDebSha256(ctx, record, result) {
  const match = /^([0-9a-f]{64})\s/m.exec(result.output)
  if (!match) throw new Error('sha256sum printed no digest for the .deb')
  ctx.debSha256 = match[1]
  ctx.derived.debSha256 = ctx.debSha256
  record.note = ctx.debSha256
}

async function stageDeb(ctx, record) {
  const { hash } = ctx.tooling
  const built = path.join(ctx.worktree, `release/cut-${ctx.version}`, debNameOf(ctx.version))
  const staged = path.join(ctx.output, debNameOf(ctx.version))
  const builtMeasured = await hash.measureFile(built)
  if (builtMeasured.sha256.toLowerCase() !== ctx.debSha256) throw new Error('the .deb measured by the driver differs from the sha256sum step; refusing to stage it')
  await cp(built, staged)
  await chmod(staged, 0o644)
  const stagedMeasured = await hash.measureFile(staged)
  if (!hash.sameBytes(builtMeasured, stagedMeasured)) throw new Error('staged .deb copy is not byte-identical to the built .deb')
  const info = await stat(staged)
  ctx.deb = { file: debNameOf(ctx.version), bytes: stagedMeasured.bytes, sha256: stagedMeasured.sha256.toLowerCase(), mode: (info.mode & 0o777).toString(8).padStart(4, '0') }
  ctx.derived.deb = ctx.deb
  record.note = `${ctx.deb.bytes} bytes, sha256 ${ctx.deb.sha256}, staged copy mode ${ctx.deb.mode}`
}

async function recordManifestSha256(ctx, record) {
  const manifest = path.join(ctx.output, `deb-manifest-${ctx.version}.json`)
  const bytes = await readFile(manifest)
  ctx.manifestSha256 = sha256Hex(bytes)
  ctx.derived.manifestSha256 = ctx.manifestSha256
  const parsed = JSON.parse(bytes.toString('utf8'))
  ctx.manifest = { file: path.basename(manifest), bytes: bytes.length, sha256: ctx.manifestSha256, entries: Array.isArray(parsed.entries) ? parsed.entries.length : null }
  ctx.derived.manifest = ctx.manifest
  record.note = `manifest sha256 ${ctx.manifestSha256}, entries ${ctx.manifest.entries}`
}

async function excludedWipAndOtherCandidates(ctx, record) {
  const dirtyFiles = ctx.tooling.git.porcelainStatus(ctx.repo)
  ctx.excludedWip = { measuredAt: new Date().toISOString(), dirtyFiles }
  const wanted = debNameOf(ctx.version)
  const staged = path.join(ctx.output, wanted)
  const roots = [path.join(ctx.repo, 'release'), ctx.output].filter((root) => existsSync(root))
  const others = []
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== wanted) continue
      const full = path.join(entry.parentPath ?? entry.path, entry.name)
      if (path.resolve(full) === path.resolve(staged)) continue
      others.push({ role: root === ctx.output ? 'evidence directory' : 'the day-to-day worktree release/ directory', relative: path.relative(root, full), sha256: await sha256FileLower(full) })
    }
  }
  ctx.otherCandidates = others
  record.note = `${dirtyFiles.length} uncommitted path(s) in --repo excluded from the build; ${others.length} other ${wanted} file(s) found`
}

export function fillLinuxInstallRecord(text, deb) {
  if (!deb || !SHA256_LOWER.test(deb.sha256) || !Number.isSafeInteger(deb.bytes) || deb.bytes <= 0
      || !/^toolsenabled_[0-9]+\.[0-9]+\.[0-9]+_amd64\.deb$/.test(deb.file)) {
    throw new Error('A measured Linux package identity is required for the release note')
  }
  let changed = 0
  const filled = text.replace(/^## Install\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m, (section) =>
    section.split(/(?=^### )/m).map(block => {
      if (!/^\|\s*Platform\s*\|\s*Linux\s*\|/im.test(block)) return block
      changed += 1
      const cells = { Package: deb.file, Bytes: String(deb.bytes), 'SHA-256': deb.sha256,
        Signed: 'Unsigned (no embedded package signature)' }
      for (const [field, value] of Object.entries(cells)) {
        const pattern = new RegExp('^\\|\\s*' + field + '\\s*\\|([^|]*)\\|[ \\t]*$', 'gm')
        const rows = [...block.matchAll(pattern)]
        if (rows.length !== 1) throw new Error(`Linux install record needs exactly one ${field} row`)
        const previous = rows[0][1].trim().replace(/`/g, '')
        if (field === 'SHA-256' && previous !== 'pending' && previous !== value) {
          throw new Error('The source release note names a different package digest')
        }
        block = block.replace(pattern, `| ${field} | ${value} |`)
      }
      return block
    }).join(''))
  if (changed !== 1) throw new Error('The source release note needs exactly one Linux install record')
  return filled
}

export async function stageReleaseNotes(ctx, record) {
  const { assertSourceInstallPlan, packetReleaseNotes } = await import(pathToFileURL(path.resolve(ctx.tooling?.root ?? HERE, '..', 'check-release-notes.mjs')).href)
  const artifact = path.join(ctx.output, debNameOf(ctx.version))
  if (await sha256FileLower(artifact) !== ctx.deb?.sha256
      || (await stat(artifact)).size !== ctx.deb?.bytes) throw new Error('Staged package changed before release notes')
  const members = spawnSync('ar', ['t', artifact], { encoding: 'utf8', windowsHide: true })
  if (members.status !== 0 || /^_gpg/m.test(members.stdout)) {
    throw new Error('Could not establish an unsigned package; signature verification is required')
  }
  const source = await readFile(path.join(ctx.worktree, 'docs', `RELEASE-NOTES-${ctx.version}.md`), 'utf8')
  const platforms = ctx.releasePlatforms?.length ? ctx.releasePlatforms : DEFAULT_RELEASE_PLATFORMS
  assertSourceInstallPlan(source, platforms)
  const packet = packetReleaseNotes(fillLinuxInstallRecord(source, ctx.deb), { platforms, packetPlatform: 'linux' })
  await writeFile(path.join(ctx.output, `RELEASE-NOTES-${ctx.version}.md`), packet, { mode: 0o644 })
  record.note = 'Packet note binds the rehashed staged package; source note unchanged'
}

async function tagCandidate(ctx, record) {
  const { git } = ctx.tooling
  const tag = `build/${ctx.version}`
  if (ctx.rehearsal) {
    const existing = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { cwd: ctx.repo, encoding: 'utf8' })
    ctx.tag = { name: tag, commit: ctx.buildRef, created: false, rehearsal: true, wouldBe: `git -C <repo> tag ${tag} ${ctx.buildRef}`,
      existing: existing.status === 0 ? existing.stdout.trim() : null }
    record.note = `rehearsal: no tag created; would be ${tag} -> ${ctx.buildRef}${ctx.tag.existing ? ` (tag already resolves to ${ctx.tag.existing})` : ''}`
    return
  }
  // A pending operator action is not proof, even when an old resume record
  // relabelled it accepted-from-prior-run. Derive the required list from this
  // plan so a missing record cannot disappear from the completion predicate.
  const steps = planSteps(ctx)
  const tagIndex = steps.find(step => step.name === 'tag-build-version').index
  for (const step of steps.filter(step => step.index < tagIndex && step.stop !== false)) {
    const proof = ctx.records?.find(row => row.index === step.index && row.name === step.name)
    const passed = proof?.status === 'green' && proof.exit === 0 && !proof.signal
    const inapplicable = !!step.notApplicable && proof?.status === 'not-applicable'
    if (!passed && !inapplicable) throw new Error(`Required cut proof ${step.name} is missing or incomplete; no release tag was created`)
  }
  // Revalidate the receipt and current artifact, even when a prior step record
  // says green or this immutable tag already exists. Records are not evidence.
  await assertCandidateReadiness(ctx)
  const result = git.tagCommit(ctx.repo, tag, ctx.buildRef)
  ctx.tag = { name: tag, commit: result.commit, created: result.created, rehearsal: false }
  record.note = `${result.created ? 'created' : 'confirmed'} immutable tag ${tag} -> ${result.commit}`
}

function summarizeGates(records) {
  const summary = { total: records.length, green: 0, red: 0, requiresOperator: 0, notApplicable: 0, acceptedFromPriorRun: 0, notRun: 0 }
  for (const record of records) {
    if (record.status === 'green') summary.green += 1
    else if (record.status === 'red') summary.red += 1
    else if (record.status === 'requiresOperator') summary.requiresOperator += 1
    else if (record.status === 'not-applicable') summary.notApplicable += 1
    else if (record.status === 'accepted-from-prior-run') summary.acceptedFromPriorRun += 1
    else summary.notRun += 1
  }
  return summary
}

/* Measured facts only, and no absolute paths: a fact file travels with the
 * candidate, and the day-to-day machine layout is owner data (see
 * lib/portable-paths.mjs). Roles and repo-relative names replace paths. */
/** Pure. What the published declaration facts may say about a private input:
 * its name and size, nothing else (no digest, no content, no path). Exhaustive
 * by construction: every other key is dropped, not just the ones we know. */
const PACKAGED_QA_STAND_INS = Object.freeze(['smoke-linux-sealed-unpacked', 'linux-installed-manifest-produce', 'linux-installed-manifest-verify-binding', 'smoke-linux-sealed-installed', 'installed-onboarding'])
function readLogTailSync(file, bytes = 600) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.slice(-bytes).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim()
  } catch { return null }
}
/** Pure. The declaration facts' account of the packaged QA suite on Linux: whether
 * it ran green, or what its refusal said and which recorded steps stood in for
 * it. Never a claim that it passed when it did not. */
export function packagedQaDisclosure(records, { readLog = () => null } = {}) {
  const byName = new Map((records ?? []).map((record) => [record.name, record]))
  const record = byName.get('packaged-qa-suite')
  const stoodInFor = PACKAGED_QA_STAND_INS.map((name) => {
    const stand = byName.get(name)
    return { step: name, status: stand?.status ?? 'not-run', exit: stand?.exit ?? null }
  })
  if (!record) return { ran: false, status: 'not-run', exit: null, refusal: null, disclosure: 'The packaged QA suite step was not reached in this run.', stoodInFor, deferred: null }
  if (record.status === 'green') return { ran: true, status: 'green', exit: record.exit, refusal: null, disclosure: 'The packaged QA suite ran green against this exact artifact.', stoodInFor, deferred: null }
  const refusal = record.log ? readLog(record.log) : null
  return {
    ran: false,
    status: record.status,
    exit: record.exit,
    refusal,
    disclosure: `The packaged QA suite (tools/packaged-qa-suite.mjs) was NOT run to a result on Linux for this candidate: it exited ${record.exit ?? 'without a code'} and the text it ended with is recorded here. As of 1.0.45 the suite is ported (tools/lib/packaged-platform.mjs) and does run on Linux, so this is a measured outcome to be read rather than a harness that could not start -- read the recorded text to tell a driver failure from a host precondition this machine did not meet. The other exact-candidate proofs on Linux are the sealed-unpacked smoke, the installed manifest binding, the installed sealed smoke and the onboarding driver, each with its own recorded status in stoodInFor.`,
    stoodInFor,
    deferred: null,
  }
}

export function declarationPrivateInputs(files) {
  return (files ?? []).map((entry) => ({ file: String(entry.file), bytes: Number(entry.bytes) }))
}

export async function writeFacts(ctx, record) {
  if (!ctx.rehearsal) await assertCandidateReadiness(ctx)
  const records = ctx.records
  const stepRow = (entry) => ({ index: entry.index, name: entry.name, status: entry.status, exit: entry.exit, signal: entry.signal, peakRssKb: entry.peakRssKb ?? null })
  const facts = {
    schema: FACTS_SCHEMA,
    schemaVersion: 1,
    rehearsal: ctx.rehearsal,
    date: new Date().toISOString().slice(0, 10),
    version: ctx.version,
    previousVersion: ctx.currentVersion,
    appRef: ctx.sourceRef,
    engineRef: ctx.engineRef,
    buildRef: ctx.buildRef,
    sameVersionCut: ctx.sameVersion,
    candidate: ctx.deb ? { file: ctx.deb.file, bytes: ctx.deb.bytes, sha256: ctx.deb.sha256, mode: ctx.deb.mode } : null,
    dpkg: ctx.dpkg ?? null,
    installedManifest: ctx.manifest ?? null,
    buildInfo: ctx.buildInfo ?? null,
    history: ctx.history ?? null,
    // Owner rule D3, Controller ruling: the PUBLISHED declaration facts carry
    // the private inputs' names and sizes, never their digests -- a digest of
    // a guessable file is a confirmation oracle. The digests stay in the
    // private gates record (writeGates), which never leaves the evidence dir.
    privateInputs: declarationPrivateInputs(ctx.privateInputs.files),
    packagedQaSuite: packagedQaDisclosure(records, { readLog: (file) => readLogTailSync(file) }),
    privateInputsSkippedTracked: ctx.privateInputs.skippedTracked,
    nodeModules: { method: ctx.nodeModules.mode, fellBackFrom: ctx.nodeModules.fellBackFrom ?? null, reasons: ctx.nodeModules.reasons },
    excludedWip: ctx.excludedWip ?? null,
    otherCandidates: ctx.otherCandidates ?? [],
    tag: ctx.tag ?? null,
    installedProof: ctx.installedProof ? 'run-inline' : 'pending-operator',
    gateSummary: summarizeGates(records),
    ...(ctx.readinessSummary ? { readinessSummary: ctx.readinessSummary } : {}),
    steps: records.map(stepRow),
    treeState: { worktreeRole: '<isolated build worktree>', worktreeRemoved: false },
    cutterAttribution: ctx.attribution.cutterAttribution,
  }
  const scanDir = path.join(ctx.output, `facts-scan-${ctx.version}`)
  await rm(scanDir, { recursive: true, force: true })
  await mkdir(scanDir, { recursive: true })
  const text = `${JSON.stringify(facts, null, 2)}\n`
  const fileName = `declaration-facts-${ctx.version}.json`
  await writeFile(path.join(scanDir, fileName), text, 'utf8')
  const decoded = text.replace(/\\{2,}/g, '\\')
  if (decoded !== text) await writeFile(path.join(scanDir, `decoded-backslashes-${fileName}`), decoded, 'utf8')
  ctx.factsScanDir = scanDir
  record.note = `written to ${path.relative(ctx.output, scanDir)}; published only after the owner-data scan`
}

async function publishFacts(ctx, record) {
  if (!ctx.rehearsal) await assertCandidateReadiness(ctx)
  const fileName = `declaration-facts-${ctx.version}.json`
  const target = path.join(ctx.output, fileName)
  await rename(path.join(ctx.factsScanDir, fileName), target)
  await rm(ctx.factsScanDir, { recursive: true, force: true })
  ctx.factsPath = target
  record.note = `owner-data scan clean; ${fileName} published`
}

/* ------------------------------------------------------------------ main */

function logLine(ctx, text) {
  const line = `[cut-linux-release-candidate] ${text}`
  console.log(line)
  ctx.driverLog.push(`${new Date().toISOString()} ${line}`)
}

export async function writeGates(ctx) {
  const record = {
    schema: GATES_SCHEMA,
    schemaVersion: 1,
    version: ctx.version,
    rehearsal: ctx.rehearsal,
    continueOnRed: ctx.continueOnRed,
    resumedFromStep: ctx.resumeFromStep ?? null,
    repo: ctx.repo,
    engineRepo: ctx.engineRepo,
    sourceRef: ctx.sourceRef,
    engineSourceRef: ctx.engineRef,
    buildRef: ctx.buildRef ?? null,
    sameVersionCut: ctx.sameVersion,
    worktree: ctx.worktree,
    output: ctx.output,
    toolingRoot: ctx.tooling.root,
    timeWrapper: ctx.useTime ? `${TIME_BINARY} -v` : null,
    startedAt: ctx.startedAt,
    finishedAt: ctx.finishedAt ?? null,
    privateInputs: ctx.privateInputs,
    nodeModules: ctx.nodeModules,
    scratch: ctx.scratch ?? null,
    environment: ctx.environment ?? null,
    session: ctx.session ?? null,
    sandbox: ctx.sandbox ?? null,
    derived: ctx.derived,
    readinessSummary: ctx.readinessSummary ?? null,
    tag: ctx.tag ?? null,
    summary: summarizeGates(ctx.records),
    ok: ctx.ok ?? null,
    steps: ctx.records,
    driverLog: ctx.driverLog,
  }
  await writeFile(ctx.gatesPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function printPlan(ctx, steps) {
  console.log(`plan for ${ctx.rehearsal ? 'REHEARSAL' : 'CUT'} ${ctx.version}: nothing below is executed and no directory is created`)
  console.log(`  repo:        ${ctx.repo} @ ${ctx.sourceRef} (package.json ${ctx.currentVersion}${ctx.sameVersion ? ', same version: no bump commit' : ` -> ${ctx.version}`})`)
  console.log(`  engine:      ${ctx.engineRepo} @ ${ctx.engineRef}`)
  console.log(`  worktree:    ${ctx.worktree} (does not exist yet)`)
  console.log(`  output:      ${ctx.output}`)
  console.log(`  tooling:     ${ctx.tooling.root}`)
  console.log(`  readiness:   ${ctx.readinessPlan.status} (${ctx.readinessPlan.target.platform}/${ctx.readinessPlan.target.arch}); ${ctx.readinessPlan.contractSha256}`)
  for (const row of ctx.readinessPlan.requirements) {
    console.log(`    required ${row.id} [${row.profiles.join(', ')}]: ${row.implementation.status}`)
    if (row.implementation.reason) console.log(`      ${row.implementation.reason}`)
  }
  if (ctx.readinessPlan.subjectMeasurer.status === 'missing') console.log(`    ${ctx.readinessPlan.subjectMeasurer.reason}`)
  console.log(`  private:     ${ctx.privateInputs.directory}: ${ctx.privateInputs.files.map((file) => `${file.file} (${file.bytes} B; digest measured at copy time)`).join(', ') || '(none)'}; tracked, left alone: ${ctx.privateInputs.skippedTracked.join(', ') || '(none)'}`)
  console.log(`  node_modules: ${ctx.nodeModules.mode}${ctx.nodeModules.source ? ` from ${ctx.nodeModules.source}` : ''}${ctx.nodeModules.fellBackFrom ? ` (fell back from ${ctx.nodeModules.fellBackFrom}: ${ctx.nodeModules.reasons.join('; ')})` : ''}`)
  console.log(`  env:         MC_ALLOW_DIRTY_BUILD removed; TOOLSENABLED_SOURCE=${ctx.engineRepo}; TOOLSENABLED_SOURCE_REF=${ctx.engineRef}; umask 022`)
  console.log(`  scratch:     ${path.join(ctx.output, `scratch-${ctx.version}`)}/state -> TOOLSENABLED_STATE_ROOT, MC_TEST_STATE_ROOT; /tmp/te-cut-XXXXXX (socket-budgeted, packager createShortTempRoot) -> TEMP, TMP, TMPDIR; MC_CANONICAL_ROOT=${ctx.engineRepo}; TOOLSENABLED_TEST_STRICT=1 on the ratchet step (tools/test-strict.mjs convention)`)
  console.log(`  time:        ${ctx.useTime ? `${TIME_BINARY} -v wraps every child (peakRssKb recorded)` : 'no /usr/bin/time -v; peakRssKb will be null'}`)
  console.log(`  tag:         ${ctx.rehearsal ? 'none (rehearsal); would-be tag recorded' : `build/${ctx.version} in --repo after the cut`}`)
  console.log(`  history:     --repo is ${gitOut(ctx.repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true' ? 'SHALLOW (the detached worktree inherits the marker; steps 01-02 prove the checkout is countable and connected)' : 'not shallow'}`)
  for (const problem of ctx.privateInputs.problems) console.log(`  WOULD REFUSE: ${problem}`)
  const session = sessionEnvironmentReport(process.env)
  console.log(`  session:     present ${session.present.join(', ') || '(none)'}; absent ${session.absent.join(', ') || '(none)'} (forwarded to the sealed smoke's packaged launch)`)
  if (!session.present.includes('DISPLAY')) console.log('  WOULD REFUSE: DISPLAY is not set; the sealed smoke launches the packaged application on the desktop session')
  const sandbox = sandboxReport()
  console.log(`  sandbox:     apparmor label "${sandbox.apparmorLabel}", kernel.apparmor_restrict_unprivileged_userns=${sandbox.apparmorRestrictUnprivilegedUserns}`)
  if (!sandbox.launchable) console.log('  WOULD REFUSE: no AppArmor profile and unprivileged user namespaces restricted; the packaged application cannot create its sandbox (run from a desktop shell or with -p AppArmorProfile=toolsenabled-linux-live)')
  if (!ctx.attributionPresent) console.log('  WOULD REFUSE: cutter attribution is not set (TOOLSENABLED_CUT_MODEL, TOOLSENABLED_CUT_EMAIL, TOOLSENABLED_CUT_SESSION); a cut refuses before touching anything')
  console.log('')
  for (const step of steps) {
    const command = resolveCommand(step, ctx)
    const flags = [step.kind === 'operator' ? (ctx.installedProof ? 'operator, runs inline' : 'requiresOperator') : step.kind,
      step.notApplicable ? 'not-applicable' : null, step.stop === false ? 'recorded, does not stop' : null].filter(Boolean).join('; ')
    console.log(`${pad(step.index)}. ${step.name} [${step.group}; ${flags}]`)
    console.log(`    ${command.join(' ')}`)
    if (step.replaces) console.log(`    replaces: ${step.replaces}`)
    if (step.note) console.log(`    note: ${step.note}`)
    if (step.notApplicable) console.log(`    not applicable: ${step.notApplicable}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return 0
  }
  /* Files this run creates (build output, the .deb, evidence) must not be
     group-writable: linux-installed-manifest.mjs verify-binding and
     smoke-linux-sealed.mjs refuse anything with mode & 0o022. */
  process.umask(0o022)

  const repo = path.resolve(args.repo)
  const engineRepo = path.resolve(args.engineRepo)
  if (!existsSync(path.join(repo, 'package.json'))) throw new Error(`--repo ${repo} has no package.json`)
  const toolingRoot = resolveToolingRoot(args)
  const tooling = await loadTooling(toolingRoot)
  const qualification = await readinessTooling({ tooling })
  const readinessPlan = qualification.planning.createReadinessPlan('toolsenabled', { target: qualification.core.LINUX_READINESS_TARGET })
  if (!args.plan && !args.rehearsal) {
    tooling.cutter.assertCutQualification(args.readinessEvidence, args.readinessOutput, args.readinessContext, qualification.core.LINUX_READINESS_TARGET)
    if (args.readinessEvidence) qualification.core.assertReceiptNamesRegisteredAdapters(args.readinessEvidence, 'toolsenabled', qualification.core.LINUX_READINESS_TARGET)
  }

  const sourceRef = tooling.cutter.resolveExactAppSourceRef(repo, args.sourceRef)
  assertEngineBinding(engineRepo, args.engineSourceRef)
  const engineRef = args.engineSourceRef

  const packageJsonAtRef = JSON.parse(gitBytes(repo, sourceRef, 'package.json').toString('utf8'))
  const currentVersion = packageJsonAtRef.version
  const version = tooling.versionBump.computeNextVersion({ currentVersion, explicitVersion: args.version, allowSameVersion: args.allowSameVersion })
  const sameVersion = version === currentVersion

  const worktree = path.resolve(args.rehearsal ? `${args.worktree}-rehearsal` : args.worktree)
  const output = path.resolve(args.output)
  const privateDir = path.resolve(args.privateInputs ?? path.join(repo, 'private'))
  const privateInputs = await inspectPrivateInputs(privateDir, repo, sourceRef, engineRepo, engineRef)
  if (privateInputs.problems.length > 0 && !args.plan) throw new Error(privateInputs.problems.join('\n'))
  const nodeModules = nodeModulesReusePlan(repo, sourceRef, args.nodeModules)

  const ctx = {
    node: process.execPath, repo, engineRepo, sourceRef, engineRef, version, currentVersion, sameVersion, worktree, output,
    rehearsal: args.rehearsal, continueOnRed: args.continueOnRed, installedProof: args.installedProof, onboardingScript: args.onboardingScript ? path.resolve(args.onboardingScript) : null,
    resumeFromStep: args.resumeFromStep ?? null, tooling, privateInputs, nodeModules, useTime: timeBinaryAvailable(),
    records: [], derived: {}, driverLog: [], buildRef: sameVersion ? sourceRef : null, attribution: null,
    releasePlatforms: args.releasePlatforms,
    readinessPlan, readinessContext: args.readinessContext,
  }
  if (sameVersion) ctx.derived.buildRef = sourceRef

  if (args.plan) {
    // --plan is read-only by construction: no worktree, no output directory,
    // no child process. It stops here after printing the resolved steps.
    ctx.attributionPresent = !tooling.declaration.attributionBlocksCommit()
    printPlan(ctx, planSteps(ctx))
    return 0
  }
  if (!ctx.rehearsal) ctx.readinessPaths = qualification.handoff.assertReadinessHandoffPaths({
    inputPath: args.readinessEvidence, outputPath: args.readinessOutput, excludedRoots: [repo, worktree, output],
  })

  /* Refuse in a second rather than at the commit, minutes in (cutter :106). */
  ctx.attribution = tooling.cutter.assertCutterAttribution()
  /* THE SEALED SMOKE NEEDS THE DESKTOP SESSION. tools/smoke-linux-sealed.mjs
     launchEnvironment() forwards only these session keys to the packaged
     application; run from a bare unit (DISPLAY alone) the application exits
     before it is ready and the step is red for a reason that has nothing to do
     with the build (measured on the first base-pair rehearsal, step 41:
     SEALED_GUI_EXITED_BEFORE_READY from a user unit; exit 0 for the same
     artifact from the desktop shell). Refuse without DISPLAY; record which of
     the others are present so a red smoke can be read against them. */
  ctx.session = sessionEnvironmentReport(process.env)
  if (!ctx.session.present.includes('DISPLAY')) throw new Error(`DISPLAY is not set; the sealed smoke (tools/smoke-linux-sealed.mjs) launches the packaged application on the desktop session. Run the cut from a desktop shell, or export the session keys ${SESSION_KEYS.join(', ')} into the unit.`)
  logLine(ctx, `[session] present: ${ctx.session.present.join(', ') || '(none)'}; absent: ${ctx.session.absent.join(', ') || '(none)'}`)
  ctx.sandbox = sandboxReport()
  if (!ctx.sandbox.launchable) throw new Error(`this process has no AppArmor profile (label "${ctx.sandbox.apparmorLabel}") and kernel.apparmor_restrict_unprivileged_userns=1, so the packaged application cannot create Chromium's sandbox and the sealed smoke would abort before ready. Run the cut from a desktop shell, or as a unit with -p AppArmorProfile=<a profile allowed user namespaces, e.g. toolsenabled-linux-live>.`)
  logLine(ctx, `[sandbox] apparmor label "${ctx.sandbox.apparmorLabel}", restrict_unprivileged_userns=${ctx.sandbox.apparmorRestrictUnprivilegedUserns}: launchable`)
  if (ctx.installedProof) {
    const sudo = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' })
    if (sudo.status !== 0) throw new Error('--installed-proof needs non-interactive sudo (sudo -n true failed); run the installed steps as an operator instead')
    if (ctx.onboardingScript && !existsSync(ctx.onboardingScript)) throw new Error(`--onboarding-script does not exist: ${ctx.onboardingScript}`)
  }

  await mkdir(output, { recursive: true })
  ctx.output = realpathSync(output)
  ctx.gatesPath = path.join(ctx.output, `gates-${version}.json`)
  ctx.startedAt = new Date().toISOString()

  const steps = planSteps(ctx)
  let firstStep = 1
  if (ctx.resumeFromStep) {
    firstStep = await prepareResume(ctx, steps)
  } else {
    if (existsSync(ctx.gatesPath)) throw new Error(`${ctx.gatesPath} already exists; this version's evidence slot is occupied. Use a new --output, or --resume-from-step for the worktree that record names.`)
    if (existsSync(worktree)) throw new Error(`build directory already exists: ${worktree}. A cut always starts from a fresh detached worktree.`)
    logLine(ctx, `repo=${repo} sourceRef=${sourceRef} engineRef=${engineRef} version ${currentVersion} -> ${version}${sameVersion ? ' (same version; buildRef = sourceRef)' : ''} rehearsal=${ctx.rehearsal}`)
    logLine(ctx, `creating isolated detached worktree at ${worktree} from ${sourceRef}`)
    tooling.git.worktreeAddDetached(repo, worktree, sourceRef)
    if (!tooling.git.isClean(worktree)) throw new Error('freshly created worktree is not clean; aborting without touching anything else')
    logLine(ctx, 'fresh worktree confirmed clean')
    /* ONE COPY STEP FOR BOTH CUTTERS. The packager's copyPrivateInputs lands
       the operator's untracked private inputs in the worktree and measures the
       digests of the bytes that landed (owner rules D3/A3: bound by digest,
       never recorded by content). This file only checks that what landed is
       exactly what the preflight inspected. */
    if (typeof tooling.cutter.copyPrivateInputs !== 'function') throw new Error('the release packager at --tooling-root exports no copyPrivateInputs; a Linux cut needs the packager that records private inputs by digest, and never copies them itself')
    const landed = await tooling.cutter.copyPrivateInputs(repo, worktree, { log: (line) => logLine(ctx, line), sourcePrivate: privateDir, mode: 0o600 })
    const expectedFiles = privateInputs.files.map((file) => file.file).sort()
    const landedFiles = (landed.digests ?? []).map((entry) => entry.file).sort()
    if (JSON.stringify(expectedFiles) !== JSON.stringify(landedFiles)) throw new Error(`private inputs changed between inspection and copy: expected ${expectedFiles.join(', ') || '(none)'}; landed ${landedFiles.join(', ') || '(none)'}`)
    for (const entry of landed.digests ?? []) {
      const inspected = privateInputs.files.find((file) => file.file === entry.file)
      if (inspected.bytes !== entry.bytes) throw new Error(`private input ${entry.file} changed size between inspection (${inspected.bytes}) and copy (${entry.bytes})`)
    }
    // Every digest in this cutter's records is lower-case hex (SHA256_LOWER); the packager's measureFile reports upper-case.
    ctx.privateInputs = { ...privateInputs, files: (landed.digests ?? []).map((entry) => ({ file: entry.file, bytes: entry.bytes, sha256: String(entry.sha256).toLowerCase() })), skippedTracked: landed.skippedTracked }
    if (!tooling.git.isClean(worktree)) throw new Error('copying private inputs dirtied the worktree; refusing to proceed')
  }
  await writeGates(ctx)

  /* THE STATE ROOTS ARE OURS, NOT THIS MACHINE'S. Every shell on a machine
     that runs this product inherits TOOLSENABLED_STATE_ROOT pointing at the
     LIVE installation, and the suite that test-ratchet --strict measures
     starts real sessions and writes real ledger rows. The environment the
     dist chain receives is built by the release packager's own
     buildDistChainEnvironment (cut-release-candidate.mjs), never by a private
     scratch set in this file, so both cutters share one containment rule and
     one exhaustive leak test. The scratch directory stays under <output>, as
     the rehearsal records expect, and the engine checkout is bound as the
     canonical root and as the packer's source (linuxDistChainEnvironment). */
  const scratch = path.join(ctx.output, `scratch-${version}`)
  const scratchState = path.join(scratch, 'state')
  await mkdir(scratchState, { recursive: true })
  /* THE TEMP ROOT IS SHORT. The state root may live under the (long) evidence
     output, but TEMP/TMP/TMPDIR must fit the Unix-socket budget or the suites
     that open sockets under it are refused before any assertion runs
     (measured: 112 bytes on the base-pair rehearsal; packager TMPDIR_BYTE_BUDGET).
     The packager makes it under /tmp and records its byte length. */
  if (typeof tooling.cutter.createShortTempRoot !== 'function') throw new Error('the release packager at --tooling-root exports no createShortTempRoot; a Linux cut needs the packager that budgets TMPDIR for Unix sockets')
  const shortTemp = await tooling.cutter.createShortTempRoot()
  const scratchTemp = shortTemp.directory
  ctx.shortTemp = shortTemp
  const buildEnv = linuxDistChainEnvironment(process.env, tooling.cutter, { scratchState, scratchTemp, engineRepo, engineRef, sourceRepo: ctx.repo })
  ctx.scratch = { directory: scratch, stateRoot: scratchState, temp: scratchTemp, tempBytes: shortTemp.bytes, tempBudgetBytes: shortTemp.budgetBytes, canonicalRoot: engineRepo }
  ctx.environment = tooling.cutter.describeDistChainEnvironment(buildEnv, { scratch })
  ctx.buildEnv = buildEnv
  logLine(ctx, `[scratch] TOOLSENABLED_STATE_ROOT=MC_TEST_STATE_ROOT=${buildEnv.TOOLSENABLED_STATE_ROOT}; TEMP=TMP=TMPDIR=${buildEnv.TMPDIR}; MC_CANONICAL_ROOT=${buildEnv.MC_CANONICAL_ROOT}; TOOLSENABLED_SOURCE=${buildEnv.TOOLSENABLED_SOURCE}@${buildEnv.TOOLSENABLED_SOURCE_REF} (buildDistChainEnvironment)`)

  let stopped = null
  for (const step of steps) {
    if (step.index < firstStep) continue
    const record = { index: step.index, name: step.name, group: step.group, kind: step.kind, command: null, cwd: ctx.worktree, exit: null, signal: null,
      startedAt: null, finishedAt: null, log: null, time: null, peakRssKb: null, status: 'not-run', stop: step.stop !== false, note: step.note ?? null }
    ctx.records.push(record)
    if (stopped) {
      record.status = 'skipped-after-red'
      record.note = `not run: step ${stopped.index} (${stopped.name}) was red`
      continue
    }
    if (step.notApplicable) {
      record.status = 'not-applicable'
      record.command = resolveCommand(step, ctx)
      record.note = step.notApplicable
      await writeGates(ctx)
      continue
    }
    if (step.kind === 'operator' && !ctx.installedProof) {
      record.status = 'requiresOperator'
      record.command = resolveCommand(step, ctx)
      record.note = [step.note, 'needs sudo / a desktop session; run by an operator with --installed-proof or by hand, exactly as recorded'].filter(Boolean).join('. ')
      await writeGates(ctx)
      continue
    }
    if (step.kind === 'operator' && step.name === 'installed-onboarding' && !ctx.onboardingScript) {
      record.status = 'requiresOperator'
      record.command = resolveCommand(step, ctx)
      record.note = 'no --onboarding-script was given; the command shape is recorded for the operator'
      await writeGates(ctx)
      continue
    }
    record.command = resolveCommand(step, ctx)
    record.startedAt = new Date().toISOString()
    logLine(ctx, `step ${pad(step.index)} ${step.name}: ${record.command.join(' ')}`)
    try {
      await withEngineBinding(ctx, async () => {
        if (step.kind === 'driver') {
          await step.run(ctx, record)
          record.exit = 0
        } else {
          const logPath = path.join(ctx.output, `step-${pad(step.index)}-${step.name}.log`)
          const timePath = path.join(ctx.output, `step-${pad(step.index)}-${step.name}.time`)
          const env = { ...buildEnv, ...(typeof step.env === 'function' ? step.env(ctx) : (step.env ?? {})) }
          const result = await runChild(record.command, { cwd: ctx.worktree, env, logPath, timePath, useTime: ctx.useTime })
          record.log = logPath
          record.time = ctx.useTime ? timePath : null
          record.exit = result.exit
          record.signal = result.signal
          record.peakRssKb = result.peakRssKb
          record.elapsed = result.elapsed
          if (result.exit === 0 && step.expectEmptyOutput && result.output.trim().length > 0) {
            record.exit = 1
            record.note = 'command printed output where an empty result was required (the worktree is not clean)'
          }
          if (record.exit === 0 && step.after) await step.after(ctx, record, result)
        }
      })
    } catch (error) {
      record.exit = record.exit === 0 ? 1 : (record.exit ?? 1)
      record.note = [record.note, error.message].filter(Boolean).join(' | ')
    }
    record.finishedAt = new Date().toISOString()
    record.status = record.exit === 0 ? 'green' : 'red'
    logLine(ctx, `step ${pad(step.index)} ${step.name}: ${record.status}${record.exit !== null ? ` (exit ${record.exit})` : ''}${record.signal ? ` signal ${record.signal}` : ''}${record.peakRssKb != null ? ` peakRssKb=${record.peakRssKb}` : ''}${record.note ? ` -- ${record.note}` : ''}`)
    await writeGates(ctx)
    if (record.status === 'red' && step.stop !== false && !ctx.continueOnRed) stopped = record
  }

  ctx.finishedAt = new Date().toISOString()
  const stopSteps = ctx.records.filter((record) => record.stop)
  const acceptedStatuses = ctx.rehearsal
    ? ['green', 'not-applicable', 'requiresOperator', 'accepted-from-prior-run']
    : ['green', 'not-applicable']
  const cutComplete = !stopped && stopSteps.every((record) => acceptedStatuses.includes(record.status))
  const notes = ctx.records.find((record) => record.name === 'check-release-notes')
  const packagedQa = ctx.records.find((record) => record.name === 'packaged-qa-suite')
  ctx.ok = cutComplete
  await writeGates(ctx)

  // Independent receipt verification remeasures its original source/stage
  // inputs. Keep a qualified worktree available just as the Windows cutter
  // does; deleting it would invalidate the receipt handed to the publisher.
  if (cutComplete && args.removeWorktree && !ctx.readiness?.subject?.context) {
    const { releaseNodeModulesJunction } = await import(pathToFileURL(path.join(tooling.root, 'lib', 'node-modules-reuse.mjs')).href)
    releaseNodeModulesJunction(worktree, { log: (text) => logLine(ctx, text) })
    tooling.git.worktreeRemove(repo, worktree)
    logLine(ctx, `removed build worktree: ${worktree}`)
    await writeGates(ctx)
  }
  if (cutComplete && args.removeWorktree && ctx.readiness?.subject?.context) {
    logLine(ctx, `retaining exact qualification source/stage inputs: ${worktree}`)
  }

  if (ctx.shortTemp) {
    // The short temp root holds nothing declarable (the artifact, records and
    // sealed-smoke evidence live under --output); remove it with the run.
    await rm(ctx.shortTemp.directory, { recursive: true, force: true })
    logLine(ctx, `removed short temp root ${ctx.shortTemp.directory} (${ctx.shortTemp.bytes} bytes, budget ${ctx.shortTemp.budgetBytes})`)
    await writeGates(ctx)
  }

  console.log('')
  console.log('='.repeat(72))
  console.log(`[cut-linux-release-candidate] ${ctx.rehearsal ? 'REHEARSAL' : 'CUT'} ${version}: ${cutComplete ? 'complete' : `stopped${stopped ? ` at step ${pad(stopped.index)} ${stopped.name}` : ''}`}`)
  const summary = summarizeGates(ctx.records)
  console.log(`  steps:       ${summary.green} green, ${summary.red} red, ${summary.requiresOperator} requiresOperator, ${summary.notApplicable} not-applicable, ${summary.acceptedFromPriorRun} accepted from a prior run, ${summary.notRun} not run`)
  console.log(`  build ref:   ${ctx.buildRef ?? '(no bump commit was made)'}`)
  if (ctx.deb) console.log(`  deb:         ${ctx.deb.file} ${ctx.deb.bytes} bytes sha256 ${ctx.deb.sha256}`)
  if (ctx.dpkg) console.log(`  dpkg:        ${ctx.dpkg.Package} ${ctx.dpkg.Version} ${ctx.dpkg.Architecture}`)
  if (ctx.manifest) console.log(`  manifest:    ${ctx.manifest.file} sha256 ${ctx.manifest.sha256}`)
  if (ctx.readinessHandoff) console.log(`  private readiness: ${ctx.readinessHandoff.path}`)
  console.log(`  tag:         ${ctx.tag ? (ctx.tag.created ? `created ${ctx.tag.name}` : ctx.tag.rehearsal ? `rehearsal, would be ${ctx.tag.name} -> ${ctx.tag.commit}` : `confirmed ${ctx.tag.name}`) : '(not reached)'}`)
  console.log(`  facts:       ${ctx.factsPath ?? '(not written)'}`)
  console.log(`  gates:       ${ctx.gatesPath}`)
  console.log(`  worktree:    ${existsSync(worktree) ? `kept at ${worktree}` : 'removed'}`)
  if (notes) console.log(`  release notes (required before the tag): ${notes.status}${notes.exit !== null ? ` (exit ${notes.exit})` : ''}`)
  if (packagedQa) console.log(`  packaged QA (Linux): ${packagedQa.status}${packagedQa.exit !== null ? ` (exit ${packagedQa.exit})` : ''}; required before installation and tagging`)
  console.log('='.repeat(72))
  if (!cutComplete) return 1
  return 0
}

/* Resume only from a record that proves every earlier step: the prior gates
 * record must exist, name this worktree, and show each step before the resume
 * point green, not-applicable or requiresOperator. A red or missing earlier
 * step cannot be resumed past; it is re-cut. */
async function prepareResume(ctx, steps) {
  if (!existsSync(ctx.worktree)) throw new Error(`--resume-from-step names a worktree that does not exist: ${ctx.worktree}`)
  if (!existsSync(ctx.gatesPath)) throw new Error(`--resume-from-step needs the prior record ${ctx.gatesPath}`)
  const priorBytes = await readFile(ctx.gatesPath)
  const prior = JSON.parse(priorBytes.toString('utf8'))
  if (prior.schema !== GATES_SCHEMA || prior.worktree !== ctx.worktree || prior.sourceRef !== ctx.sourceRef || prior.engineSourceRef !== ctx.engineRef || prior.version !== ctx.version) {
    throw new Error('the prior gates record describes a different cut (worktree, refs or version differ); refusing to resume')
  }
  const from = ctx.resumeFromStep
  if (from > steps.length) throw new Error(`--resume-from-step ${from} is past the last step (${steps.length})`)
  const priorSha = sha256Hex(priorBytes)
  for (const step of steps) {
    if (step.index >= from) break
    const entry = (prior.steps ?? []).find((row) => row.index === step.index && row.name === step.name)
    if (!entry || !['green', 'not-applicable', 'requiresOperator', 'accepted-from-prior-run'].includes(entry.status)) {
      throw new Error(`step ${pad(step.index)} ${step.name} is not green in the prior record; a resume never skips a red or missing step`)
    }
    ctx.records.push({ ...entry, status: 'accepted-from-prior-run', priorGatesSha256: priorSha, priorStatus: entry.status })
  }
  if (!ctx.tooling.git.isClean(ctx.worktree)) throw new Error('the resume worktree is not clean; a resumed cut declares only committed bytes plus the gated build output')
  const head = ctx.tooling.git.revParse(ctx.worktree, 'HEAD')
  if (ctx.sameVersion) {
    if (head !== ctx.sourceRef) throw new Error(`the resume worktree HEAD ${head} is not the declared source ${ctx.sourceRef}`)
  } else if (from > steps.find((step) => step.name === 'version-bump-commit').index) {
    const parent = ctx.tooling.git.revParse(ctx.worktree, 'HEAD^')
    if (parent !== ctx.sourceRef) throw new Error(`the resume worktree HEAD ${head} is not one commit on top of ${ctx.sourceRef}`)
    ctx.buildRef = head
  }
  Object.assign(ctx.derived, prior.derived ?? {})
  for (const key of ['buildRef', 'debSha256', 'manifestSha256', 'dpkg', 'deb', 'manifest', 'buildInfo', 'history']) if (ctx.derived[key] !== undefined) ctx[key] = ctx.derived[key]
  if (ctx.buildRef && ctx.derived.buildRef && ctx.buildRef !== ctx.derived.buildRef) throw new Error('the prior record names a different build ref than the resume worktree HEAD')
  ctx.privateInputs = prior.privateInputs ?? ctx.privateInputs
  ctx.nodeModules = prior.nodeModules ?? ctx.nodeModules
  ctx.startedAt = prior.startedAt ?? ctx.startedAt
  logLine(ctx, `resuming from step ${pad(from)} in ${ctx.worktree}; ${ctx.records.length} earlier step(s) accepted from the prior record (sha256 ${priorSha})`)
  return from
}

const invokedDirectly = process.argv[1]
  && existsSync(process.argv[1])
  && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`[cut-linux-release-candidate] ${error.usage ? 'USAGE' : 'FAILED'}: ${error.message}`)
    process.exitCode = error.usage ? 2 : 1
  })
}
