import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { INSTALLER_IDENTITIES } from '../../lib/drivers/installer-lifecycle.mjs'
import { validateLifecycleInventory } from '../../lib/drivers/lifecycle-inventory-contract.mjs'
import { DEV_PROFILE, DEV_TEMP, plainPath, readBounded, measureFile, relativeName, contains, digestRecord } from '../../lib/adapters/artifact-files.mjs'

const LIMIT = 1024 * 1024
const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git'
const NULL_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sameFile = (left, right) => left.sha256 === right.sha256 && left.bytes === right.bytes

function block(message) {
  const error = new Error(`Lifecycle input preparation blocked: ${message}`)
  error.code = 'LIFECYCLE_INPUT_PREPARATION_BLOCKED'
  throw error
}

function inputPath(value, options = {}) {
  const profile = typeof value === 'string' && /[a-z]:[\\/]Users[\\/][^\\/]+/i.exec(value)
  if (profile && profile[0].replaceAll('/', '\\').toLowerCase() !== DEV_PROFILE.toLowerCase()) block('foreign-profile input refused before probing')
  return plainPath(value, options)
}

function findRepository(file, checkTime) {
  let directory = path.dirname(file)
  for (let depth = 0; depth < 64; depth++) {
    checkTime()
    const marker = inputPath(path.join(directory, '.git'), { missingLeaf: true })
    if (fs.existsSync(marker)) return directory
    const parent = path.dirname(directory)
    if (parent === directory || process.platform === 'win32' && directory.toLowerCase() === DEV_PROFILE.toLowerCase()) break
    directory = parent
  }
  block('inventory has no committed repository within its bounded ancestor search')
}

function refusePartialCloneConfig(text) {
  // git-config permits keys after a section header and booleans without '='.
  // Inspect physical lines conservatively before running Git; a quoted or
  // escaped subsection bracket must not hide the real end of the header.
  for (let line of text.split(/\r?\n/)) {
    line = line.trimStart()
    if (line.startsWith('[')) {
      let quoted = false, escaped = false, end = -1
      for (let index = 1; index < line.length; index++) {
        const character = line[index]
        if (escaped) { escaped = false; continue }
        if (quoted && character === '\\') { escaped = true; continue }
        if (character === '"') { quoted = !quoted; continue }
        if (character === ']' && !quoted) { end = index; break }
      }
      if (end < 0) block('unsupported Git section header in preparation inputs')
      line = line.slice(end + 1).trimStart()
    }
    const key = /^[a-z][a-z0-9-]*/i.exec(line)?.[0]
    if (/^(?:partialClone|promisor)$/i.test(key || '')) block('partial clone configuration is unsupported; preparation cannot fetch missing objects')
  }
}

// The caller supplies the primary repository as trusted source context.
// Pointer bytes never grant authority to inspect another metadata tree.
export function resolveLifecycleMetadataPointer(text, { file, allowed, prefix = '', child = false, platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (!['win32', 'linux'].includes(platform) || !paths.isAbsolute(file || '') || !paths.isAbsolute(allowed || '')) block('explicit metadata path authority is required')
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) block('malformed linked worktree metadata pointer')
  const value = text.replace(/\r?\n$/, '')
  if (!value.startsWith(prefix) || !value.slice(prefix.length) || /[\x00-\x1f\x7f]/.test(value)) block('malformed linked worktree metadata pointer')
  const target = value.slice(prefix.length)
  if (platform === 'linux' && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(target)) block('foreign-profile input refused before probing')
  const targetProfile = /^[a-z]:[\\/]Users[\\/][^\\/]+/i.exec(target)?.[0]
  const permittedProfile = /^[a-z]:[\\/]Users[\\/][^\\/]+/i.exec(allowed)?.[0]
  if (targetProfile && permittedProfile && targetProfile.replaceAll('/', '\\').toLowerCase() !==
      permittedProfile.replaceAll('/', '\\').toLowerCase()) block('foreign-profile input refused before probing')

  const resolved = paths.resolve(paths.dirname(file), target)
  const permitted = paths.resolve(allowed)
  const same = (left, right) => platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  const relative = paths.relative(permitted, resolved)
  if (child ? (!relative || paths.isAbsolute(relative) || relative === '..' || relative.includes(paths.sep) ||
      relativeName(relative) !== relative) : !same(resolved, permitted)) {
    block('linked worktree pointer leaves its explicit repository metadata authority before probing')
  }
  return resolved
}

function inspectMetadata(repository, checkTime, repositoryRoot) {
  const marker = inputPath(path.join(repository, '.git'))
  let metadata = marker, common = marker, authority = repository
  const pointers = {}
  function pointer(file, allowed, options = {}) {
    const bytes = readBounded(inputPath(file, { kind: 'file' }), 65536)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const target = resolveLifecycleMetadataPointer(text, { file, allowed, ...options })
    pointers[file] = hash(bytes)
    return target
  }
  if (fs.lstatSync(marker).isFile()) {
    if (!repositoryRoot) block('linked worktree preparation requires an explicit primary repository root')
    // Only this caller-selected primary repository may supply common metadata.
    // No path derived from .git or commondir reaches inputPath before the
    // lexical authority check inside pointer has accepted it.
    authority = inputPath(repositoryRoot, { kind: 'directory' })
    common = inputPath(path.join(authority, '.git'), { kind: 'directory' })
    metadata = inputPath(pointer(marker, path.join(common, 'worktrees'), { prefix: 'gitdir: ', child: true }), { kind: 'directory' })
    inputPath(pointer(path.join(metadata, 'commondir'), common), { kind: 'directory' })
    const backlink = pointer(path.join(metadata, 'gitdir'), marker)
    inputPath(backlink, { kind: 'file' })
  } else if (!fs.lstatSync(marker).isDirectory()) block('Git metadata is not an ordinary directory or worktree pointer')
  else {
    if (repositoryRoot && path.resolve(repositoryRoot) !== repository) block('ordinary repository differs from the explicit primary repository root')
    if (fs.existsSync(inputPath(path.join(marker, 'commondir'), { missingLeaf: true }))) block('unexpected common-directory redirect in an ordinary repository')
  }
  const packDirectory = path.join(common, 'objects', 'pack')

  let entries = 0
  function visit(directory) {
    const packMarkers = directory === packDirectory || process.platform === 'win32' && directory.toLowerCase() === packDirectory.toLowerCase()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      checkTime()
      if (++entries > 100000) block('Git metadata exceeds its entry budget')
      const file = inputPath(path.join(directory, entry.name))
      const stat = fs.lstatSync(file)
      if (packMarkers && entry.name.endsWith('.promisor')) block('partial clone metadata is unsupported; preparation cannot fetch missing objects')
      if (stat.isDirectory()) visit(file)
      else if (!stat.isFile() || stat.nlink !== 1) block('Git metadata contains a linked or non-regular file')
    }
  }
  visit(common)
  const filters = new Set(), configs = {}
  for (const file of [path.join(common, 'config'), path.join(metadata, 'config.worktree')]) {
    inputPath(file, { missingLeaf: true })
    if (!fs.existsSync(file)) continue
    const bytes = readBounded(file, 256 * 1024), text = bytes.toString('utf8')
    configs[file] = hash(bytes)
    refusePartialCloneConfig(text)
    for (const match of text.matchAll(/^\s*\[([^\]\r\n]+)\]/gm)) {
      const section = match[1].trim()
      if (/^include(?:if)?(?:\s|\.|$)/i.test(section)) block('Git configuration includes are not preparation inputs')
      if (!/^filter(?:\s|\.|$)/i.test(section)) continue
      const name = /^(?:filter\s+"([a-z0-9._-]+)"|filter\.([a-z0-9._-]+))$/i.exec(section)
      if (!name) block('unsupported Git filter name')
      filters.add(name[1] || name[2])
    }
  }
  for (const relative of ['objects/info/alternates', 'objects/info/http-alternates', 'info/grafts']) {
    // A direct repository created without templates need not have .git/info.
    // Stop at the first absent component while still fencing every present one.
    let file = common, present = true
    for (const component of relative.split('/')) {
      file = inputPath(path.join(file, component), { missingLeaf: true })
      if (!fs.existsSync(file)) { present = false; break }
    }
    if (present && readBounded(file, 65536).toString('utf8').trim()) block('Git object alternates and grafts are not preparation inputs')
  }
  return { metadata, common, authority, configs, pointers,
    filterOptions: [...filters].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]) }
}

function gitEnvironment() {
  // No inherited Git directory, executable, include, credential or hook state.
  return {
    ...(process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: DEV_TEMP, TMP: DEV_TEMP,
      USERPROFILE: DEV_PROFILE, APPDATA: `${DEV_PROFILE}\\AppData\\Roaming`, LOCALAPPDATA: `${DEV_PROFILE}\\AppData\\Local` }
      : { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_FILE, GIT_CONFIG_SYSTEM: NULL_FILE,
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', PAGER: '',
  }
}

// Portable read-only source preparation. It deliberately does not call or
// impersonate the pinned Windows qualifier or brand a production inventory.
export function checkLifecycleInputs(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['inventoryPath', 'product', 'repositoryRoot'].includes(key))) block('unknown preparation options; executable or authority overrides are not accepted')
  const { inventoryPath, product = 'toolsenabled', repositoryRoot } = options
  if (typeof product !== 'string' || !Object.hasOwn(INSTALLER_IDENTITIES, product)) block('unknown product identity')
  if (!['linux', 'win32'].includes(process.platform)) block('portable preparation supports Linux and Windows only')
  const deadline = process.hrtime.bigint() + 120_000_000_000n
  const checkTime = () => { if (process.hrtime.bigint() >= deadline) block('source preparation exceeded its time budget') }
  const full = inputPath(inventoryPath, { kind: 'file' })
  const repository = findRepository(full, checkTime)
  const metadata = inspectMetadata(repository, checkTime, repositoryRoot)
  const tool = { path: GIT, ...measureFile(GIT, { maximum: 128 * LIMIT, systemFile: true, allowEmpty: false }) }
  function git(args) {
    checkTime()
    const remaining = Math.max(1, Number((deadline - process.hrtime.bigint()) / 1_000_000n))
    const result = spawnSync(GIT, ['--no-replace-objects', '--literal-pathspecs',
      '-c', `core.hooksPath=${NULL_FILE}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.pager=', '-c', 'diff.external=', '-c', `core.attributesFile=${NULL_FILE}`,
      '-c', `core.excludesFile=${NULL_FILE}`, '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true',
      '-c', `safe.directory=${repository}`, ...metadata.filterOptions,
      `--git-dir=${metadata.metadata}`, `--work-tree=${repository}`, '-C', repository, ...args],
    { env: gitEnvironment(), encoding: 'utf8', windowsHide: true, timeout: Math.min(15000, remaining),
      maxBuffer: 16 * LIMIT, stdio: ['ignore', 'pipe', 'pipe'] })
    checkTime()
    if (result.error || result.signal || result.status !== 0) block(`local Git preparation command ${args[0]} failed (${result.error?.code || result.signal || result.status})`)
    return result.stdout
  }
  const ref = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (!/^[a-f0-9]{40}$/.test(ref)) block('source HEAD is not one resolved lowercase commit')
  if (git(['for-each-ref', '--format=%(refname)', 'refs/replace']).trim()) block('Git replacement refs are not preparation inputs')
  function snapshot() {
    if (git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== ref) block('source HEAD changed during preparation')
    const index = git(['ls-files', '-v', '-z']).split('\0').filter(Boolean)
    if (!index.length || index.length > 100000 || index.some(row => !row.startsWith('H '))) block('source index is empty, excessive or hides tracked files')
    const committed = new Map()
    for (const row of git(['ls-tree', '-r', '--full-tree', '-z', ref]).split('\0').filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row)
      if (!match) block('source contains a symlink, submodule or unsupported object')
      committed.set(relativeName(match[3]), match[2])
    }
    if (index.length !== committed.size) block('source index selection differs from its commit')
    const files = {}, seen = new Set()
    let bytes = 0
    for (const row of index) {
      checkTime()
      const relative = relativeName(row.slice(2)), folded = relative.toLowerCase()
      if (seen.has(folded) || !committed.has(relative)) block('source has duplicate or changed tracked paths')
      seen.add(folded)
      const filename = inputPath(path.join(repository, relative), { kind: 'file' })
      const actual = measureFile(filename, { maximum: 64 * LIMIT, gitBlob: true })
      bytes += actual.bytes
      if (bytes > 512 * LIMIT) block('tracked source exceeds its total byte budget')
      if (actual.gitBlobSha1 !== committed.get(relative)) {
        const content = readBounded(filename, 64 * LIMIT)
        if (content.includes(0)) block('source bytes differ from the exact commit')
        const normalized = Buffer.from(content.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')
        const blob = createHash('sha1').update(`blob ${normalized.length}\0`).update(normalized).digest('hex')
        if (blob !== committed.get(relative)) block('source bytes differ from the exact commit')
      }
      files[relative] = { sha256: actual.sha256, bytes: actual.bytes }
    }
    if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']).length) block('source repository is dirty or has untracked files')
    if (git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== ref) block('source HEAD changed during preparation')
    return { ref, sha256: digestRecord(files), files }
  }
  const before = snapshot()
  function committedFile(filename) {
    filename = inputPath(filename, { kind: 'file' })
    if (!contains(repository, filename)) block('declared input escaped its repository')
    const relative = relativeName(path.relative(repository, filename).split(path.sep).join('/'))
    const bytes = readBounded(filename, LIMIT)
    if (!before.files[relative] || !sameFile(before.files[relative], { sha256: hash(bytes), bytes: bytes.length })) block('inventory or declaration is not committed unchanged source')
    return { path: relative, bytes, sha256: hash(bytes) }
  }
  const inventory = committedFile(full)
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory.bytes)) }
  catch { block('baseline inventory is not readable UTF-8 JSON') }
  validateLifecycleInventory(value, product, INSTALLER_IDENTITIES)
  const declaration = committedFile(path.join(repository, ...value.dataPolicy.declaration.split('/')))
  if (!declaration.bytes.length) block('data policy declaration is empty')
  const after = snapshot()
  if (after.sha256 !== before.sha256 || digestRecord(inspectMetadata(repository, checkTime, repositoryRoot)) !== digestRecord(metadata) ||
      !sameFile(tool, measureFile(GIT, { maximum: 128 * LIMIT, systemFile: true, allowEmpty: false }))) block('source, metadata or preparation tool changed during inspection')
  checkTime()
  return {
    schema: 'toolsenabled.lifecycle-input-preparation', schemaVersion: 1,
    scope: 'preparation-only', status: 'inputs-checked', product,
    authority: 'Committed input preparation only. Installer bytes, guest authority and runtime execution were not measured. This is not a production inventory authority or release receipt.',
    provenance: { repository, primaryRepository: metadata.authority, commonGitDirectory: metadata.common, ref, sourceSha256: before.sha256, preparationTool: tool },
    inventory: { path: inventory.path, sha256: inventory.sha256, bytes: inventory.bytes.length },
    policy: { ...value.dataPolicy, declarationSha256: declaration.sha256, declarationBytes: declaration.bytes.length },
    interruptionPolicy: value.interruptionPolicy,
    baselineDeclarations: value.supportedBaselines.map(({ id, version, contentLayout, subject }) =>
      ({ id, version, contentLayout, declaredSubject: { artifact: { sha256: subject.artifact.sha256, bytes: subject.artifact.bytes },
        runtimeSha256: subject.runtimeSha256, shellSha256: subject.shellSha256 } })),
    remainingPrerequisites: [
      'The pinned Windows reader must validate these inputs, and the trusted guest owner must authorize this policy repository and ref.',
      'Every declared baseline installer must be available and independently measured; declaration hashes do not establish those bytes.',
      'The exact candidate installer, installed runtime and shell must be measured and bound to the selected source pair.',
      'A trusted disposable Windows guest must prove its baseline, requested token, run and reset epoch, job ownership, cleanup and quarantine.',
      'Actual install, supported upgrades, retention choices, interruption recovery and installed relaunches must execute and be independently verified.',
    ],
  }
}
