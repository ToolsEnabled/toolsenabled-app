import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sterileProfileDirectories, prepareSterileProfile, sterileLaunchEnvironment } = require('./sterile-launch.cjs')
const { windowsProfileReferences } = require('../../shell/install-profile-guard.cjs')
const EXACT = /^[a-f0-9]{40}$/
const SCHEMA = 'toolsenabled.development-session'
// Node's Windows device-namespace os.devNull is not a Git config pathname.
const GIT_NULL = process.platform === 'win32' ? 'NUL' : os.devNull
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

// Reject foreign Windows profiles lexically, before filesystem inspection.
// A session is ordinary owned storage, never a pointer into a working lane.
export function ordinaryPath(input, { missing = false, directory = true } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw Error('An absolute session path is required')
  const selected = path.resolve(input)
  if (process.platform === 'win32') {
    if (/^[\\/]{2}/.test(input) || /:/.test(input.slice(2))) throw Error('Unsupported Windows path namespace')
    // USERPROFILE/HOME deliberately point into session storage in children;
    // OS account identity must not be recovered from those redirected values.
    const owner = os.userInfo().homedir.toLowerCase()
    if (windowsProfileReferences(selected).some(root => root.toLowerCase() !== owner)) throw Error('Path leaves the owning Windows account')
  }
  let cursor = path.parse(selected).root
  const components = path.relative(cursor, selected).split(path.sep).filter(Boolean)
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component)
    let stat
    try { stat = fs.lstatSync(cursor) } catch (error) {
      if (missing && error.code === 'ENOENT') return selected
      throw error
    }
    if (stat.isSymbolicLink()) throw Error('Session paths cannot traverse links: ' + cursor)
    if (index < components.length - 1 || directory) {
      if (!stat.isDirectory()) throw Error('Session path is not an ordinary directory: ' + cursor)
    } else if (!stat.isFile() || stat.nlink !== 1) throw Error('Session input is not an independent ordinary file: ' + cursor)
  }
  return selected
}

export function gitEnvironment(base = process.env) {
  const environment = Object.fromEntries(Object.entries(base).filter(([key]) => !/^git_/i.test(key)))
  return { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL,
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}

function git(root, args) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
    '-c', 'core.autocrlf=false', '-C', root, ...args], {
    env: gitEnvironment(), encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) throw Error('Session Git operation failed: ' + (result.error?.message || result.stderr.trim()))
  return result.stdout.trim()
}

function resolveSource(root, ref) {
  ordinaryPath(root)
  if (ref !== undefined && !EXACT.test(ref)) throw Error('Source refs must be exact lowercase commit IDs')
  const top = git(root, ['rev-parse', '--show-toplevel'])
  if (path.resolve(top) !== path.resolve(root)) throw Error('Source must name the Git root')
  const commit = git(root, ['rev-parse', '--verify', (ref || 'HEAD') + '^{commit}'])
  if (!EXACT.test(commit) || (ref && commit !== ref)) throw Error('Source did not resolve to the declared commit')
  return { origin: path.resolve(root), ref: commit, tree: git(root, ['rev-parse', commit + '^{tree}']) }
}

function snapshot(source, target) {
  fs.mkdirSync(target, { mode: 0o700 })
  git(target, ['init', '--quiet'])
  // Preserve source-declared shallow boundaries as well as its copied objects;
  // otherwise Git accepts the pinned tree but later walks missing parents.
  // Ordinary fetch copies Git objects. No --shared, alternates, hardlinks,
  // linked worktree metadata, source checkout or source-ref writes are used.
  git(target, ['fetch', '--quiet', '--no-tags', '--update-shallow', '--', source.origin, source.ref])
  git(target, ['checkout', '--quiet', '--detach', source.ref])
  if (fs.existsSync(path.join(target, '.git', 'objects', 'info', 'alternates'))) throw Error('Snapshot borrowed source Git objects')
  assertFrozenSource(target, source)
}

function assertRepositoryIdentity(root) {
  ordinaryPath(root)
  ordinaryPath(path.join(root, '.git'))
  for (const entry of ['objects', 'refs']) ordinaryPath(path.join(root, '.git', entry))
  ordinaryPath(path.join(root, '.git', 'config'), { directory: false })
  const top = path.resolve(git(root, ['rev-parse', '--show-toplevel']))
  const gitDir = path.resolve(git(root, ['rev-parse', '--absolute-git-dir']))
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']))
  if (top !== path.resolve(root) || gitDir !== path.join(root, '.git') || common !== gitDir) {
    throw Error('Session Git identity redirects to another worktree or object database')
  }
}

export function assertFrozenSource(root, source) {
  assertRepositoryIdentity(root)
  if (git(root, ['rev-parse', 'HEAD']) !== source.ref || git(root, ['rev-parse', 'HEAD^{tree}']) !== source.tree) throw Error('Frozen session source changed: ' + root)
  if (git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])) throw Error('Snapshot replacement refs are forbidden')
  if (fs.existsSync(path.join(root, '.git', 'objects', 'info', 'alternates')) || fs.existsSync(path.join(root, '.git', 'info', 'grafts'))) {
    throw Error('Snapshot Git objects or history are not independent')
  }
  // Exact tree bytes alone cannot detect an omitted shallow boundary or a
  // missing historical object. Count avoids materializing a full object list.
  git(root, ['rev-list', '--objects', '--count', '--missing=error', source.ref])
  if (git(root, ['ls-files', '-v']).split('\n').some(line => /^[a-zS]/.test(line))) throw Error('Snapshot index hides worktree changes')
  // Git status compares filtered bytes and cached metadata. Neither proves
  // the bytes that Node, Electron or a build actually reads. Hash each regular
  // materialized file as a Git blob without filters, index caches or diff
  // drivers. Tracked links/submodules could reconnect to a mutable checkout.
  for (const entry of git(root, ['ls-tree', '-rz', '--full-tree', source.ref]).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry)
    if (!match) throw Error('Frozen source requires ordinary files; tracked links and submodules are unsupported')
    const [, mode, blob, relative] = match
    const file = path.resolve(root, relative)
    if (!inside(root, file) || file === root) throw Error('Frozen source path leaves its snapshot')
    ordinaryPath(file, { directory: false })
    const bytes = fs.readFileSync(file)
    const actual = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
    const executable = process.platform !== 'win32' && Boolean(fs.statSync(file).mode & 0o111)
    if (actual !== blob || (process.platform !== 'win32' && executable !== (mode === '100755'))) {
      throw Error('Frozen session source changed: raw file bytes or mode differ at ' + file)
    }
  }
  const info = path.join(root, '.git', 'info')
  ordinaryPath(info, { missing: true })
  try {
    fs.lstatSync(path.join(info, 'attributes'))
    throw Error('Snapshot local Git attributes are forbidden')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (git(root, ['config', '--local', '--list', '--null']).split('\0').some(entry => /^(filter\.|include\.|includeif\.|core\.attributesfile\n)/i.test(entry))) {
    throw Error('Snapshot local Git filters and configuration indirection are forbidden')
  }
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) throw Error('Frozen session source changed: ' + root)
}

export function sessionPaths(root) {
  return Object.freeze({ root, app: path.join(root, 'app'), engine: path.join(root, 'engine'),
    controlApp: path.join(root, 'control-app'),
    controlEngine: path.join(root, 'control-engine'),
    evidence: path.join(root, 'evidence'), staging: path.join(root, 'candidates'), build: path.join(root, 'build'),
    runtimeProfile: path.join(root, 'profiles', 'runtime'), buildProfile: path.join(root, 'profiles', 'build'),
    userData: path.join(root, 'profiles', 'runtime', 'ToolsEnabled-Development'), cache: path.join(root, 'cache') })
}

export function createDevelopmentSession({ directory, kind = 'dev', app, engine, appRef, engineRef, privacyProfile }) {
  if (!['dev', 'cut'].includes(kind)) throw Error('Session kind must be dev or cut')
  const root = ordinaryPath(directory, { missing: true })
  if (process.platform === 'win32' && !inside(os.userInfo().homedir, root)) throw Error('Windows session storage must stay in the owning account')
  // Resolve both inputs before copying either one. Later source changes are
  // normal development; they cannot change this selected pair.
  const sources = { app: resolveSource(app, appRef), engine: resolveSource(engine, engineRef) }
  for (const source of Object.values(sources)) {
    if (inside(source.origin, root) || inside(root, source.origin)) throw Error('Session must be separate from each source checkout')
  }
  let privacy
  if (privacyProfile) {
    ordinaryPath(privacyProfile, { directory: false })
    privacy = fs.readFileSync(privacyProfile)
    JSON.parse(privacy.toString('utf8'))
  }
  // Exclusive directory creation protects existing sessions and evidence.
  fs.mkdirSync(root, { mode: 0o700 })
  const paths = sessionPaths(root)
  try {
    snapshot(sources.app, paths.app)
    snapshot(sources.engine, paths.engine)
    // DEV may edit both trees. The controller, renderer watcher and lifetime
    // custody keep executing the selected source, including on later reopen.
    snapshot(sources.app, paths.controlApp)
    snapshot(sources.engine, paths.controlEngine)
    for (const name of ['evidence', 'staging', 'cache', 'runtimeProfile', 'buildProfile']) fs.mkdirSync(paths[name], { recursive: true, mode: 0o700 })
    const privateRoot = path.join(paths.app, 'private')
    fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(privateRoot, 'capability-source.owner.json'), json({ path: paths.engine, ref: sources.engine.ref }), { flag: 'wx', mode: 0o600 })
    if (privacy) fs.writeFileSync(path.join(privateRoot, 'owner-data-patterns.owner.json'), privacy, { flag: 'wx', mode: 0o600 })
    const manifest = { schema: SCHEMA, schemaVersion: 3, id: randomUUID(), kind,
      createdAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
      sources, privacySha256: privacy ? hash(privacy) : null, qualification: 'pending' }
    fs.writeFileSync(path.join(root, 'session.json'), json(manifest), { flag: 'wx', mode: 0o600 })
    assertFrozenSource(paths.app, sources.app)
    assertFrozenSource(paths.engine, sources.engine)
    return { ...manifest, paths }
  } catch (error) {
    // A failed snapshot is preserved for inspection; never recurse into a
    // source, remove another lane's files, or recycle a partially used root.
    fs.writeFileSync(path.join(root, 'snapshot-failure.json'), json({ at: new Date().toISOString(), message: error.message }), { flag: 'wx', mode: 0o600 })
    throw error
  }
}

export function readDevelopmentSession(directory) {
  const root = ordinaryPath(directory)
  const manifestFile = ordinaryPath(path.join(root, 'session.json'), { directory: false })
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.schema !== SCHEMA || manifest.schemaVersion !== 3 || !['dev', 'cut'].includes(manifest.kind)
      || !/^[a-f0-9-]{36}$/.test(manifest.id) || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw Error('Unsupported or non-native development session; create a new snapshot with frozen app and engine controllers')
  }
  const paths = sessionPaths(root)
  for (const name of ['app', 'engine', 'controlApp', 'controlEngine', 'evidence', 'staging', 'cache', 'runtimeProfile', 'buildProfile']) ordinaryPath(paths[name])
  for (const name of ['app', 'engine']) {
    const source = manifest.sources?.[name]
    if (!EXACT.test(source?.ref || '') || !EXACT.test(source?.tree || '')) throw Error('Session source identity is incomplete')
    if (manifest.kind === 'cut') assertFrozenSource(paths[name], source)
    else assertRepositoryIdentity(paths[name])
  }
  assertFrozenSource(paths.controlApp, manifest.sources.app)
  assertFrozenSource(paths.controlEngine, manifest.sources.engine)
  const selection = JSON.parse(fs.readFileSync(ordinaryPath(path.join(paths.app, 'private', 'capability-source.owner.json'), { directory: false }), 'utf8'))
  if (selection.path !== paths.engine || selection.ref !== manifest.sources.engine.ref) throw Error('Session engine binding changed')
  if (manifest.privacySha256) {
    const privacy = ordinaryPath(path.join(paths.app, 'private', 'owner-data-patterns.owner.json'), { directory: false })
    if (hash(fs.readFileSync(privacy)) !== manifest.privacySha256) throw Error('Session privacy input changed')
  }
  return { ...manifest, paths }
}

export function developmentSessionEnvironment(session, { phase = 'runtime', base = process.env } = {}) {
  if (!['runtime', 'build'].includes(phase)) throw Error('Unknown session environment phase')
  const profileRoot = phase === 'runtime' ? session.paths.runtimeProfile : session.paths.buildProfile
  ordinaryPath(profileRoot, { missing: true })
  const directories = sterileProfileDirectories(profileRoot)
  for (const directory of Object.values(directories)) ordinaryPath(directory, { missing: true })
  // A profile root being ordinary does not make its children ordinary. Inspect
  // every derived destination before mkdir or passing it to a child process.
  for (const directory of [path.join(directories.localAppData, 'cache'), path.join(directories.localAppData, 'state'),
    path.join(directories.localAppData, 'Microsoft', 'Windows', 'PowerShell'), session.paths.userData,
    ...['npm', 'electron', 'electron-builder', 'playwright', 'job-wrapper'].map(name => path.join(session.paths.cache, name))]) {
    ordinaryPath(directory, { missing: true })
  }
  for (const file of ['npmrc', 'npmrc-global']) ordinaryPath(path.join(profileRoot, file), { missing: true, directory: false })
  const profile = prepareSterileProfile(directories)
  const environment = sterileLaunchEnvironment(profile, base)
  // Build tools need private scratch, not Chromium's shared short socket path.
  // The runtime window supplies its separately owned short socket directory.
  if (phase === 'build' && process.platform === 'linux') environment.TMPDIR = profile.temp
  // None of the developer's engine/proof/dirty-build seams or mutable caches
  // may retarget a frozen build or another DEV window.
  for (const key of Object.keys(environment)) {
    if (/^(MC_|MISSION_CONTROL_|TOOLSENABLED_|GIT_|NPM_CONFIG_|npm_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_|PSModuleAnalysisCachePath$|PLAYWRIGHT_BROWSERS_PATH$)/i.test(key)) delete environment[key]
  }
  environment.npm_config_cache = path.join(session.paths.cache, 'npm')
  environment.npm_config_userconfig = path.join(profileRoot, 'npmrc')
  environment.npm_config_globalconfig = path.join(profileRoot, 'npmrc-global')
  environment.ELECTRON_CACHE = path.join(session.paths.cache, 'electron')
  environment.electron_config_cache = path.join(session.paths.cache, 'electron')
  environment.ELECTRON_BUILDER_CACHE = path.join(session.paths.cache, 'electron-builder')
  environment.PLAYWRIGHT_BROWSERS_PATH = path.join(session.paths.cache, 'playwright')
  environment.PSModuleAnalysisCachePath = path.join(profile.localAppData, 'Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache')
  ordinaryPath(environment.PSModuleAnalysisCachePath, { missing: true, directory: false })
  fs.mkdirSync(path.dirname(environment.PSModuleAnalysisCachePath), { recursive: true, mode: 0o700 })
  environment.ELECTRON_INSTALL_PLATFORM = process.platform
  environment.ELECTRON_INSTALL_ARCH = process.arch
  const inheritedPathKey = Object.keys(environment).find(key => /^path$/i.test(key))
  const searchPath = (environment[inheritedPathKey] || '').split(path.delimiter).filter(entry => path.isAbsolute(entry)
    && !Object.values(session.sources).some(source => inside(source.origin, entry)))
  if (inheritedPathKey) delete environment[inheritedPathKey]
  environment.PATH = [path.dirname(process.execPath), path.join(session.paths.app, 'node_modules', '.bin'), ...searchPath].join(path.delimiter)
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = GIT_NULL
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GIT_OPTIONAL_LOCKS = '0'
  environment.TOOLSENABLED_SOURCE = session.paths.engine
  environment.TOOLSENABLED_SOURCE_REF = session.sources.engine.ref
  environment.TOOLSENABLED_DRIVE_IMAGE = 'toolsenabled/dev-drive:session-' + session.id
  environment.TOOLSENABLED_SHARED_HOST_SESSION = '1'
  if (phase === 'runtime') environment.TOOLSENABLED_PROVIDER_ISOLATION_ROOT = session.paths.runtimeProfile
  if (phase === 'build') {
    for (const key of ['TOOLSENABLED_CUT_MODEL', 'TOOLSENABLED_CUT_EMAIL', 'TOOLSENABLED_CUT_SESSION', 'TOOLSENABLED_CUT_LANE']) {
      if (base[key]) environment[key] = base[key]
    }
  }
  return environment
}

// Only this session is locked. No LIVE marker, process name or global DEV
// lock participates. Unknown cleanup preserves admission for investigation.
export function acquireDevelopmentSession(session, operation) {
  const file = path.join(session.paths.root, 'operation.json')
  const record = { schema: 'toolsenabled.session-operation', id: randomUUID(), sessionId: session.id,
    operation, pid: process.pid, startedAt: new Date().toISOString(), state: 'active' }
  const fd = fs.openSync(file, 'wx', 0o600)
  fs.writeFileSync(fd, json(record)); fs.fsyncSync(fd)
  const original = fs.fstatSync(fd)
  let finished = false
  return {
    finish({ cleanupConfirmed, ...outcome }) {
      if (finished) throw Error('Session operation is already finished')
      finished = true
      try {
        const current = fs.lstatSync(file)
        if (current.ino !== original.ino || current.dev !== original.dev || fs.readFileSync(file, 'utf8') !== json(record)) throw Error('Session operation ownership changed')
        const terminal = { ...record, ...outcome, cleanupConfirmed, finishedAt: new Date().toISOString(), state: cleanupConfirmed ? 'closed' : 'cleanup-unconfirmed' }
        fs.writeFileSync(path.join(session.paths.evidence, 'operation-' + record.id + '.json'), json(terminal), { flag: 'wx', mode: 0o600 })
        if (cleanupConfirmed === true) fs.unlinkSync(file)
      } finally { fs.closeSync(fd) }
    },
  }
}
