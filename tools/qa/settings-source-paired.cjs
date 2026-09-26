'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const DRIVER = 'tools/qa/settings-source-paired.cjs'
const LEAVES = ['tests/settings-rows-inert.test.js']
const PAIR_HELPER = 'tests/lib/settings-source-pair.js'
const ENVIRONMENT_HELPER = 'tests/lib/isolated-environment.js'
const FIXTURE_HELPER = 'tools/test/lib/source-fixture-root.mjs'
const REFS = /^[a-f0-9]{40}$/
const REGISTERED_GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git'
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const GIT_ENV = Object.freeze({ HOME: process.platform === 'win32' ? 'NUL' : '/nonexistent', PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/nonexistent',
  LANG: 'C', LC_ALL: 'C', GIT_EXEC_PATH: process.platform === 'win32' ? 'NUL' : '/nonexistent',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' })
const GIT_SOURCE_OPTIONS = Object.freeze(['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false', '-c', 'core.pager=', '-c', 'diff.external=', `-c`, `core.attributesFile=${NULL_DEVICE}`,
  `-c`, `core.excludesFile=${NULL_DEVICE}`, '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true'])
const SELECTORS = Object.freeze({
  app: ['IMAGE_APP_ROOT', 'TOOLSENABLED_TEST_APP_ROOT', 'T1139_B6_APP_ROOT'],
  engine: ['IMAGE_ENGINE_ROOT', 'T1630_ENGINE_ROOT', 'TOOLSENABLED_TEST_ENGINE_ROOT', 'MC_CANONICAL_ROOT'],
})
const fail = message => { throw new Error(`Settings source paired runner refused: ${message}`) }

function ordinaryAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f]/.test(value))
    fail(`${name} must be an ordinary absolute path`)
  return value
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--app', '--engine', '--app-ref', '--engine-ref'].includes(flag) || value === undefined || values[flag])
      fail('only one complete --app/--engine/--app-ref/--engine-ref binding is accepted')
    values[flag] = value
  }
  if (argv.length !== 8 || !values['--app'] || !values['--engine'] || !values['--app-ref'] || !values['--engine-ref'])
    fail('the complete app/engine path and ref binding is required')
  return { appRoot: ordinaryAbsolute(values['--app'], 'app root'),
    engineRoot: ordinaryAbsolute(values['--engine'], 'engine root'),
    appRef: values['--app-ref'], engineRef: values['--engine-ref'] }
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function selectorMatchesRoot(value, bound) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) return false
  const resolved = path.resolve(value)
  if (!samePath(resolved, bound)) return false
  let real
  try { real = fs.realpathSync.native(resolved) } catch { return false }
  return samePath(real, resolved) && samePath(resolved, bound)
}

// The Dev account's Windows profile. The account name is a placeholder, and the
// path is joined at run time so the source carries no literal profile path.
function devAccountHome() {
  return path.win32.join('C:\\', 'Users', 'BuildAccount-Dev')
}

function validateWindowsFixtureIdentity() {
  if (process.platform !== 'win32') return
  const os = require('node:os')
  const allowedHome = devAccountHome()
  if (!samePath(os.userInfo().homedir, allowedHome) || !samePath(os.homedir(), allowedHome))
    fail('Windows fixture and engine state require the BuildAccount-Dev profile')
  const explicit = process.env.TOOLSENABLED_WINDOWS_FIXTURE_PARENT
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit)) fail('explicit fixture parent must be absolute')
    const normalized = path.normalize(explicit)
    const profiles = path.dirname(allowedHome)
    const under = (root, candidate) => samePath(root, candidate) || candidate.toLowerCase().startsWith(root.toLowerCase() + path.sep)
    if (under(profiles, normalized) && !under(allowedHome, normalized)) fail('explicit fixture parent is in a foreign Windows profile')
  }

}

function engineStateBase(fixtureRoot, isolatedTemporaryRoot) {
  if (process.platform !== 'win32') return fixtureRoot
  validateWindowsFixtureIdentity()
  // e66's outer runner deliberately uses the canonical account temp on
  // Windows, even when TEMP/TMPDIR point at the descriptor fixture. Refuse
  // a foreign profile lexically before invoking or probing that producer.
  const home = require('node:os').homedir()
  const allowedHome = devAccountHome()
  if (!samePath(home, allowedHome)) fail('Windows engine state requires the BuildAccount-Dev profile')
  const expected = path.join(allowedHome, 'AppData', 'Local', 'Temp')
  const produced = isolatedTemporaryRoot()
  if (!samePath(produced, expected)) fail('engine temporary-root producer differs from the owned account temp')
  return expected
}

function retainedStateStderr(stderr, { base, startedAtMs, leafCount = 1 }) {
  if (![1, 4].includes(leafCount)) fail('unregistered paired leaf directory count')
  const lines = String(stderr || '').replaceAll('\r\n', '\n').split('\n').filter(Boolean)
  if (lines.length !== 1) fail('child stderr contains an unknown warning or lacks exactly one retention notice')
  const match = /^Isolated test state retained by request: (.+)$/.exec(lines[0])
  const target = match && path.isAbsolute(match[1]) && path.normalize(match[1]) === match[1]
    && !/[\x00-\x1f]/.test(match[1]) ? match[1] : null
  // Bind the actual run-isolated mkdtemp producer, never a whole temp tree.
  // Reject foreign paths before any filesystem observation of their bytes.
  if (!target || !samePath(path.dirname(target), base) || !/^te-[A-Za-z0-9]{6}$/.test(path.basename(target)))
    fail('child stderr contains an unknown warning or foreign retention path')
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(target), target))
    fail('child retention path is not an ordinary suite directory')
  for (let index = 1; index <= leafCount; index++) {
    const child = path.join(target, String(index).padStart(3, '0'))
    const childStat = fs.lstatSync(child)
    if (!childStat.isDirectory() || childStat.isSymbolicLink() || !samePath(fs.realpathSync.native(child), child))
      fail('child retention path lacks its ordinary leaf directories')
  }
  if (!Number.isFinite(stat.birthtimeMs) || stat.birthtimeMs < startedAtMs || stat.birthtimeMs > Date.now())
    fail('child retention directory was not created during this invocation')
  if (process.platform !== 'win32' && stat.uid !== process.getuid()) fail('child retention directory belongs to another account')
  return { stderr: String(stderr), root: target }
}

// The same registered Git, ref, clean index and materialized-blob custody as
// task-assignment-paired.cjs. Its fixed four-leaf driver remains independent.
function regularBytes(root, relative) {
  let cursor = root
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index])
    const stat = fs.lstatSync(cursor)
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()))
      fail(`tracked materialization is not an ordinary file: ${relative}`)
  }
  return fs.readFileSync(cursor)
}

function git(root, args, encoding = 'utf8') {
  try {
    return require('node:child_process').execFileSync(REGISTERED_GIT,
      [...GIT_SOURCE_OPTIONS, '-C', root, ...args],
      { cwd: root, env: GIT_ENV, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    fail(`registered Git refused ${args[0]} for ${root}: ${error.code || error.message}`)
  }
}

function repositoryDescriptor(root, expectedRef, name, required) {
  const resolved = path.resolve(root)
  let real
  try { real = fs.realpathSync.native(resolved) } catch (error) { fail(`${name} root cannot be resolved: ${error.code || error.message}`) }
  if (!samePath(real, resolved)) fail(`${name} root is a symlink or foreign resolved path`)
  const top = String(git(resolved, ['rev-parse', '--show-toplevel'])).trim()
  let realTop
  try { realTop = fs.realpathSync.native(path.resolve(top)) } catch (error) { fail(`${name} Git toplevel cannot be resolved`) }
  if (!samePath(realTop, resolved)) fail(`${name} Git toplevel differs from the bound root`)
  const head = String(git(resolved, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim().toLowerCase()
  if (head !== expectedRef) fail(`${name} HEAD differs from the supplied source ref`)
  const status = String(git(resolved, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=none'])).trim()
  if (status) fail(`${name} tracked source is dirty`)
  const tracked = git(resolved, ['ls-files', '-v', '-z'], null)
  const entries = tracked.toString('utf8').split('\0').filter(Boolean)
  if (entries.some(entry => /^[a-z]/.test(entry))) fail(`${name} tracked source contains hidden assume-unchanged bytes`)
  const index = git(resolved, ['ls-files', '--stage', '-z'], null).toString('utf8').split('\0').filter(Boolean)
    .map(entry => /^([^ ]+) ([0-9a-f]{40}) (\d+)\t(.+)$/.exec(entry));
  if (index.some(entry => !entry || entry[3] !== '0')) fail(`${name} tracked index has an unresolved stage`)
  const tree = git(resolved, ['ls-tree', '-r', '--full-tree', '-z', head], null).toString('utf8').split('\0').filter(Boolean);
  const committed = new Map(tree.map(entry => {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    return match ? [match[3], { mode: match[1], sha: match[2] }] : [entry, null];
  }));
  const materialized = new Set()
  if (index.length !== committed.size) fail(`${name} index omits committed paths`)
  for (const row of index) {
    if (!row) fail(`${name} tracked index record is malformed`)
    const expected = committed.get(row[4]);
    if (!expected || expected.mode !== row[1] || expected.sha !== row[2]) fail(`${name} index differs from committed HEAD`)
    let bytes
    try { bytes = regularBytes(resolved, row[4]) } catch (error) {
      if (error.code === 'ENOENT' && entries.some(entry => entry.slice(2) === row[4] && entry[0] === 'S')) continue
      throw error
    }
    materialized.add(row[4])
    const actual = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
    if (actual !== row[2]) fail(`${name} tracked materialization differs from committed blob ${row[4]}`)
  }
  for (const file of required) {
    if (!materialized.has(file) || !['100644', '100755'].includes(committed.get(file)?.mode))
      fail(`missing ordinary pinned ${name} input ${file}`)
  }
  return { root: resolved, toplevel: realTop, head,
    trackedSha256: crypto.createHash('sha256').update(Buffer.concat([tracked, Buffer.from('\0'), Buffer.from(JSON.stringify(index))])).digest('hex') }
}

function verifyBoundInputs(binding) {
  if (!REFS.test(binding.appRef) || !REFS.test(binding.engineRef)) fail('source refs are not exact commit ids')
  if (samePath(binding.appRoot, binding.engineRoot)) fail('app and engine roots must be distinct')
  if (!samePath(path.resolve(__dirname, '../..'), binding.appRoot)) fail('app root differs from the executing paired driver')
  const app = repositoryDescriptor(binding.appRoot, binding.appRef, 'app',
    [DRIVER, FIXTURE_HELPER, 'shell/product-settings.cjs', 'shell/tree-slot-policy.mjs'])
  const engine = repositoryDescriptor(binding.engineRoot, binding.engineRef, 'engine',
    ['tests/run-isolated.js', PAIR_HELPER, ENVIRONMENT_HELPER, ...LEAVES])
  return { app, engine }
}

function rejectForeignAmbient(binding) {
  if (process.env.TOOLSENABLED_SETTINGS_SOURCE_PAIR !== undefined) fail('an inherited settings descriptor is not execution authority')
  for (const key of SELECTORS.app) {
    if (process.env[key] !== undefined && !selectorMatchesRoot(process.env[key], binding.appRoot)) fail(`foreign inherited app selector ${key}`)
  }
  for (const key of SELECTORS.engine) {
    if (process.env[key] !== undefined && !selectorMatchesRoot(process.env[key], binding.engineRoot)) fail(`foreign inherited engine selector ${key}`)
  }
}

function childEnvironment(binding, fixture, descriptorPath) {
  const env = { ...process.env, ...fixture.environment, TOOLSENABLED_SETTINGS_SOURCE_PAIR: descriptorPath }
  for (const key of SELECTORS.app) env[key] = binding.appRoot
  for (const key of SELECTORS.engine) env[key] = binding.engineRoot
  return env
}

function strictLeafCount(stdout) {
  const lines = stdout.replaceAll('\r\n', '\n').trimEnd().split('\n')
  const markers = lines.map(line => /^STRICT EVIDENCE: ([^ ]+) -- reconciled-tap; (\d+) passed; 0 UNEXECUTED \(within-suite skips\)$/.exec(line)).filter(Boolean)
  if (markers.length !== LEAVES.length) fail('child output lacks exactly one strict settings evidence marker')
  markers.forEach((marker, index) => {
    if (marker[1] !== LEAVES[index] || Number(marker[2]) < 1) fail('child strict evidence is duplicated, reordered or empty')
  })
  return lines
}

async function main() {
  const binding = parseArgs(process.argv.slice(2))
  if (process.env.TOOLSENABLED_TEST_STRICT !== '1') fail('paired runner requires TOOLSENABLED_TEST_STRICT=1')
  // Identity is checked before selectors, repositories, fixture imports or writes.
  validateWindowsFixtureIdentity()
  // Reject a foreign selector lexically before probing any supplied root.
  rejectForeignAmbient(binding)
  const before = verifyBoundInputs(binding)
  // Only load the helper after its bytes and repository have been validated.
  const { validateSettingsSourcePair, readSettingsSourcePair } = require(path.join(binding.engineRoot, PAIR_HELPER))
  validateSettingsSourcePair(binding, { expectedEngineRoot: binding.engineRoot }).sourceBodies()
  const { prepareRetainedSourceFixture } = await import(require('node:url').pathToFileURL(path.join(binding.appRoot, FIXTURE_HELPER)))
  const fixture = prepareRetainedSourceFixture()
  const descriptorPath = path.join(fixture.root, 'settings-source-pair.json')
  const descriptorBytes = Buffer.from(JSON.stringify(binding) + '\n')
  fs.writeFileSync(descriptorPath, descriptorBytes, { flag: 'wx', mode: 0o600 })
  const env = childEnvironment(binding, fixture, descriptorPath)
  readSettingsSourcePair(descriptorPath, { expectedEngineRoot: binding.engineRoot, env })
  const { isolatedTemporaryRoot } = require(path.join(binding.engineRoot, ENVIRONMENT_HELPER))
  const stateBase = engineStateBase(fixture.root, isolatedTemporaryRoot)
  if (!samePath(fs.realpathSync.native(stateBase), stateBase) || !fs.lstatSync(stateBase).isDirectory())
    fail('engine state base is not an ordinary owned directory')
  const stateContract = { base: stateBase, startedAtMs: Date.now() }
  const child = spawnSync(process.execPath, [path.join(binding.engineRoot, 'tests/run-isolated.js'), '--config-integrity',
    '--timeout-ms', '60000', ...LEAVES], {
    cwd: binding.engineRoot, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: 60000, windowsHide: true, shell: false,
  })
  // Preserve failed child evidence; only verified retention notices move to stdout.
  if (child.stdout) process.stdout.write(child.stdout)
  let retainedStderr
  try { retainedStderr = retainedStateStderr(child.stderr, stateContract) } catch (error) {
    if (child.stderr) process.stderr.write(child.stderr)
    throw error
  }
  if (retainedStderr.stderr) process.stdout.write(retainedStderr.stderr)
  if (child.error) fail(`bound child could not complete: ${child.error.code || child.error.message}`)
  if (child.status !== 0 || child.signal) fail(`bound child exited ${child.status === null ? child.signal : child.status}`)
  strictLeafCount(child.stdout || '')
  const after = verifyBoundInputs(binding)
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('bound tracked inputs changed during child execution')
  if (!regularBytes(fixture.root, 'settings-source-pair.json').equals(descriptorBytes)) fail('descriptor changed during child execution')
  readSettingsSourcePair(descriptorPath, { expectedEngineRoot: binding.engineRoot, env })
  if (!String(child.stdout || '').endsWith('\n')) process.stdout.write('\n')
  process.stdout.write(`SETTINGS SOURCE PAIRED: ${JSON.stringify({
    schema: 'toolsenabled.settings-source-paired.v1', ...binding, files: LEAVES,
    childExitCode: 0, skipped: 0, retainedFixtureRoot: fixture.root, retainedEngineStateRoot: retainedStderr.root,
    descriptor: { path: descriptorPath, sha256: crypto.createHash('sha256').update(descriptorBytes).digest('hex') },
  })}\n`)
}

module.exports = { validateWindowsFixtureIdentity, engineStateBase, retainedStateStderr }
if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
