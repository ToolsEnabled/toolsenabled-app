/* Refuse to produce a release build from an uncommitted, unreproducible tree.
 *
 * THE INCIDENT THIS CLOSES: two lanes shared one worktree and branch. One
 * lane's uncommitted, unreviewed, in-progress feature (a different agent's
 * WIP, never committed anywhere) got silently bundled into a `npm run dist`
 * run by the OTHER lane -- and it passed every gate in the pipeline,
 * including the privacy scanner, because it was not a privacy leak. It was
 * caught only because someone happened to run `git status --porcelain` by
 * hand at declaration time, immediately before writing up the build. That is
 * luck, not process. A build whose bytes cannot be reproduced from git
 * history is not a release candidate no matter how clean it scans -- "any
 * changed byte is a new candidate" cuts both ways: an uncommitted byte was
 * never a candidate to begin with.
 *
 * WHERE THIS RUNS: between `vite build` and `electron-builder` in the `dist`
 * script. Late enough that dist/ already exists, so the provenance record
 * below can be written INTO it and therefore ships inside the package
 * (dist/** is already in build.files) -- inspectable by anyone holding only
 * the .exe, not just visible in a terminal nobody kept. Early enough that it
 * fails before the two most expensive steps (native module rebuild and NSIS
 * packaging) run against a build nobody can vouch for.
 *
 * THE OVERRIDE IS NOT AN OFF SWITCH. Sometimes packaging deliberately-unclean
 * work is legitimate (testing a WIP feature end to end before it lands). But
 * a gate with a quiet escape hatch is the gate this repo already had before
 * this incident. So: the override must be an explicit, named, non-default
 * environment variable -- never inferred, never a CLI flag someone could
 * leave in a saved command -- and USING it does not silence the fact, it
 * BROADCASTS it: dirty:true and the exact file list are written into
 * dist/build-info.json and ship inside the artifact. The failure mode this
 * guards against is someone overriding once under time pressure and the
 * resulting exe becoming indistinguishable from a clean one a week later.
 * If a build cannot state its own provenance, that has to be visible in the
 * artifact, not just in a terminal.
 *
 * build-info.json intentionally carries no builder identity (no username, no
 * absolute path, no hostname) -- only relative repo paths and a commit SHA.
 * Recording the builder's OS username here would recreate exactly the class
 * of leak this whole rebuild exists to fix (compare: the old build's appId
 * carried the owner's username). check-no-owner-data.mjs, which runs later
 * in the same `dist` chain, would also be the thing to catch it if this ever
 * regressed -- but the right fix is to never write it, not to rely on that.
 *
 * THE INSTALLER IS BUILT FROM TWO REPOSITORIES, AND THIS ONLY EVER CHECKED
 * ONE. The Electron app is this repo. The 224-file capability payload under
 * resources/capability is cut by pack-capability-layer.mjs from a SEPARATE
 * checkout (the engine tree) that this repo does not contain and git here
 * cannot see. So a build could stamp `dirty: false` -- whose stated meaning
 * above is "reproducible from git history alone" -- on a package whose larger
 * half was uncommitted. That is strictly worse than the gap it replaced: a
 * known blind spot at least reads as unknown, whereas this produced a
 * confident false claim, and the release packager then re-read that claim as
 * independent confirmation (cut-release-candidate.mjs asserts dirty===false).
 *
 * Both repos are now measured and both are recorded. They are held to the SAME
 * standard rather than the payload getting a softer one: dirty is dirty, the
 * one override covers both, and using it still broadcasts the fact and the
 * file list. A second, quieter rule for the payload half would be the same
 * shape of mistake as checking only one repo -- strict where you are looking,
 * lenient where you are not.
 *
 * The payload repo's ABSOLUTE PATH is deliberately never recorded (it names
 * the builder and their machine layout -- which is why the file that
 * configures it, private/capability-source.owner.json, is untracked and says
 * so). Its commit SHA and its repo-relative dirty paths carry the provenance
 * without carrying the identity.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const OVERRIDE_VARIABLE = 'MC_ALLOW_DIRTY_BUILD'

// Resolved from process.cwd(), NOT from this file's location, to stay
// consistent with the app-repo check above -- the setting file belongs to
// whichever checkout is being built, so pointing this script at a different
// checkout has to move both halves or it silently measures one tree's app
// against another tree's payload. In the real `dist` chain the two are the
// same directory, so this changes nothing there. (pack-capability-layer.mjs
// keys the same file off its own location because it always runs inside the
// repo it packs from; this script explicitly does not.)
const settingFile = () => path.join(process.cwd(), 'private', 'capability-source.owner.json')

// Deliberately process.cwd() for the app repo, not a path derived from this
// file's own location: npm always runs package.json scripts with cwd already
// at the repo root, so this matches real usage exactly, and it also means this
// script can be pointed at a DIFFERENT checkout for testing (see its own
// tests) without needing to live inside that checkout.
function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) {
    throw couldNotTell('REPO_INSPECTION_FAILED', `could not inspect git repository ${cwd}; this is NOT claiming it is absent or not a checkout`, result.error)
  }
  if (result.status !== 0) {
    throw couldNotTell(
      'REPO_INSPECTION_FAILED',
      `could not inspect git repository ${cwd}; this is NOT claiming it is absent or not a checkout (git ${args.join(' ')} exited ${result.status}): ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

function couldNotTell(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code })
}

function readIfPresent(file, read = readFileSync) {
  try {
    return read(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.code === 'ENOENT') return null
    throw couldNotTell(
      'PAYLOAD_SOURCE_READ_FAILED',
      `could not read payload source metadata ${file}; this is NOT claiming the file or payload source is absent`,
      error,
    )
  }
}

// Mirrors pack-capability-layer.mjs's resolveSource() precedence exactly, so
// the tree we MEASURE is the tree it PACKS. This is duplicated rather than
// imported on purpose: that module calls main() at import time, so importing
// it here would run the packer. The `--source` branch of its precedence is
// omitted because it is a flag on that script, not this one -- and the `dist`
// chain invokes `pack:capability` with no flags, so env-or-config is the whole
// real-world path. If a future dist script starts passing --source, this
// resolves a different tree than it packs, so keep them together.
function resolvePayloadSource() {
  const candidates = [process.env.TOOLSENABLED_SOURCE, configuredPayloadSource()].filter(Boolean)
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    const marker = readIfPresent(path.join(resolved, 'tools', 'mission-bridge.js'))
    if (marker !== null) return resolved
  }
  return null
}

function configuredPayloadSource(read = readFileSync) {
  const file = settingFile()
  const contents = readIfPresent(file, read)
  if (contents === null) return null
  try {
    const parsed = JSON.parse(contents)
    return typeof parsed?.path === 'string' && parsed.path.trim() ? parsed.path.trim() : null
  } catch (error) {
    throw couldNotTell(
      'PAYLOAD_SOURCE_CONFIG_INVALID',
      `payload source metadata ${file} is invalid; this is NOT claiming the file or payload source is absent`,
      error,
    )
  }
}

// Inspection failures throw: a busy machine is not evidence that a checkout
// is absent, clean, or dirty.
function inspectRepo(cwd) {
  const dirtyFiles = parseDirtyFiles(git(['status', '--porcelain'], cwd))
  return { ref: git(['rev-parse', 'HEAD'], cwd).trim(), dirty: dirtyFiles.length > 0, dirtyFiles }
}

// Best-effort, informational file list: porcelain v1 status lines are two
// status characters, one space, then the path. This does not attempt to
// unquote paths with special characters or split "R  old -> new" rename
// lines apart -- the GATE DECISION is the boolean (any output at all means
// dirty), which does not depend on parsing the path correctly. The list is
// for the human/audit trail, not the control flow.
function parseDirtyFiles(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3))
}

async function writeProvenance(distDirectory, record) {
  const resolved = path.resolve(distDirectory)
  await mkdir(resolved, { recursive: true })
  const target = path.join(resolved, 'build-info.json')
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return target
}

async function requireCleanTree(distDirectory) {
  const checkedAt = new Date().toISOString()

  const app = inspectRepo(process.cwd())

  const payloadRoot = resolvePayloadSource()
  const payloadRepo = payloadRoot ? inspectRepo(payloadRoot) : null

  // Unresolvable or non-git payload source => unknown, and unknown is not
  // clean. Recorded as resolved:false so the artifact says "we could not tell"
  // rather than silently omitting the half nobody measured.
  const payload = payloadRepo
    ? { resolved: true, ref: payloadRepo.ref, dirty: payloadRepo.dirty, dirtyFiles: payloadRepo.dirtyFiles }
    : { resolved: false, ref: null, dirty: null, dirtyFiles: [] }

  const payloadClean = payload.resolved && payload.dirty === false
  const dirty = app.dirty || !payloadClean

  // Namespaced so a reader can never mistake which repo a path belongs to --
  // both trees contain a tools/ and a src/, so a bare merged list would be
  // actively misleading about where to go look.
  const labelled = [
    ...app.dirtyFiles.map((file) => `app: ${file}`),
    ...payload.dirtyFiles.map((file) => `payload: ${file}`),
    ...(payload.resolved ? [] : ['payload: <source tree unresolved -- provenance unknown>']),
  ]

  const record = {
    schemaVersion: 2,
    dirty,
    overridden: false,
    ref: app.ref,
    checkedAt,
    dirtyFiles: labelled,
    app: { ref: app.ref, dirty: app.dirty, dirtyFiles: app.dirtyFiles },
    payload,
  }

  const describe = () =>
    `app ${app.ref.slice(0, 12)}${app.dirty ? ' (dirty)' : ''}, ` +
    (payload.resolved ? `payload ${payload.ref.slice(0, 12)}${payload.dirty ? ' (dirty)' : ''}` : 'payload UNRESOLVED')

  if (!dirty) {
    const target = await writeProvenance(distDirectory, record)
    console.log(`[require-clean-tree] both trees are clean -- ${describe()}. Provenance recorded: ${target}`)
    return { ok: true, dirty: false, overridden: false }
  }

  const overridden = process.env[OVERRIDE_VARIABLE] === '1'

  if (!overridden) {
    console.error('[require-clean-tree] REFUSING TO BUILD: this package cannot state its own provenance.')
    console.error(`  app repo     : ${app.ref} -- ${app.dirty ? `${app.dirtyFiles.length} uncommitted` : 'clean'}`)
    console.error(
      `  payload repo : ${payload.resolved ? `${payload.ref} -- ${payload.dirty ? `${payload.dirtyFiles.length} uncommitted` : 'clean'}` : 'UNRESOLVED -- could not be measured at all'}`,
    )
    console.error('')
    console.error('These bytes could not be reproduced from git history alone:')
    for (const file of labelled) console.error(`  ${file}`)
    console.error('')
    console.error('Both repositories ship inside the installer, so both must be reproducible.')
    console.error('If this is deliberate -- e.g. packaging reviewed, uncommitted work on')
    console.error(`purpose -- set ${OVERRIDE_VARIABLE}=1. That does not silence this: it`)
    console.error('records dirty:true and the exact file list above into dist/build-info.json,')
    console.error('which ships inside the package.')
    return { ok: false, dirty: true, overridden: false }
  }

  console.warn('='.repeat(72))
  console.warn(`[require-clean-tree] ${OVERRIDE_VARIABLE}=1 -- BUILDING FROM A DIRTY TREE.`)
  console.warn(`${describe()}.`)
  console.warn('This build is NOT reproducible from git history alone. dirty:true and')
  console.warn('the file list below are recorded in dist/build-info.json and ship')
  console.warn('inside the package so this fact cannot get lost.')
  for (const file of labelled) console.warn(`  ${file}`)
  console.warn('='.repeat(72))
  const target = await writeProvenance(distDirectory, { ...record, overridden: true })
  console.warn(`[require-clean-tree] provenance recorded: ${target}`)
  return { ok: true, dirty: true, overridden: true }
}

// pathToFileURL handles Windows drive letters and URL-significant path bytes.
// Building a file: URL by interpolation turns `C:\\...` into a URL with a
// host, so this comparison is false on Windows and the release gate never runs.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const distDirectory = process.argv[2] || 'dist'
  const result = await requireCleanTree(distDirectory)
  process.exitCode = result.ok ? 0 : 1
}

export { configuredPayloadSource, requireCleanTree, parseDirtyFiles, OVERRIDE_VARIABLE }
