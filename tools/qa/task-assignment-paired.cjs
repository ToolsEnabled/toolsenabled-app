'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { validateWindowsFixtureIdentity } = require('./settings-source-paired.cjs')

const SUITE = 'tests/suites/task-assignment.txt'
const STATE_CONTRACT = 'tools/qa/settings-source-paired.cjs'
const FIXTURE_HELPER = 'tools/test/lib/source-fixture-root.mjs'
const ENVIRONMENT_HELPER = 'tests/lib/isolated-environment.js'
const LEAVES = [
  'tests/task-assignment-authority.test.js',
  'tests/task-assignment-transaction.test.js',
  'tests/task-assignment-composition.test.js',
  'tests/owner-host-task-assignment-transport.test.js',
]
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
  engine: ['T1630_ENGINE_ROOT', 'TOOLSENABLED_TEST_ENGINE_ROOT', 'MC_CANONICAL_ROOT'],
})
const fail = message => { throw new Error(`Task-assignment paired runner refused: ${message}`) }

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

function requireFile(root, relative) {
  const file = path.join(root, relative)
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`missing paired input ${relative}`)
  return file
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function selectorMatchesRoot(value, bound) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) return false
  const resolved = path.resolve(value)
  let real
  try { real = fs.realpathSync.native(resolved) } catch { return false }
  return samePath(real, resolved) && samePath(resolved, bound)
}

function isOwnerHostCloseDiagnostic(line) {
  let row;
  try { row = JSON.parse(line); } catch { return false; }
  return row && !Array.isArray(row) &&
    Object.keys(row).sort().join(',') === 'atMs,event,reason,sessionId' &&
    row.event === 'owner-host-session-retired' && row.reason === 'owner-host-closed' &&
    typeof row.sessionId === 'string' && row.sessionId.length > 0 && row.sessionId.length <= 256 &&
    !/[\x00-\x1f]/.test(row.sessionId) && Number.isSafeInteger(row.atMs) && row.atMs > 0;
}

function retainedStateStderr(stderr, contract, readRetainedState) {
  const lines = String(stderr || '').replaceAll('\r\n', '\n').split('\n').filter(Boolean)
  const notices = []
  for (const line of lines) {
    if (/^Isolated test state retained by request: /.test(line)) notices.push(line)
    else if (!isOwnerHostCloseDiagnostic(line)) fail('child stderr contains an unknown warning or error')
  }
  const state = readRetainedState(notices.join('\n') + '\n', contract)
  return { stderr: String(stderr || ''), root: state.root }
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

function repositoryDescriptor(root, expectedRef, name, required = []) {
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
  for (const row of index) {
    if (!row) fail(`${name} tracked index record is malformed`)
    const expected = committed.get(row[4]);
    if (!expected || expected.mode !== row[1] || expected.sha !== row[2]) fail(`${name} index differs from committed HEAD`)
    const file = path.join(resolved, row[4]);
    let stat;
    try { stat = fs.lstatSync(file) } catch (error) {
      if (entries.some(entry => entry.slice(2) === row[4] && entry[0] === 'S')) continue
      fail(`${name} tracked materialization is missing ${row[4]}`)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name} tracked materialization is not a regular file`)
    const bytes = fs.readFileSync(file);
    const actual = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
    if (actual !== row[2]) fail(`${name} tracked materialization differs from committed blob ${row[4]}`)
  }
  for (const relative of required) {
    if (!['100644', '100755'].includes(committed.get(relative)?.mode)) fail(`missing pinned ${name} input ${relative}`)
    requireFile(resolved, relative)
  }
  return { root: resolved, toplevel: realTop, head,
    trackedSha256: crypto.createHash('sha256').update(Buffer.concat([tracked, Buffer.from('\0'), Buffer.from(JSON.stringify(index))])).digest('hex') }
}

function verifyBoundInputs(binding) {
  if (!REFS.test(binding.appRef) || !REFS.test(binding.engineRef)) fail('source refs are not exact commit ids')
  if (binding.appRoot === binding.engineRoot) fail('app and engine roots must be distinct')
  const app = repositoryDescriptor(binding.appRoot, binding.appRef, 'app', [STATE_CONTRACT, FIXTURE_HELPER])
  const engine = repositoryDescriptor(binding.engineRoot, binding.engineRef, 'engine', [ENVIRONMENT_HELPER])
  if (app.root === engine.root) fail('resolved app and engine roots must be distinct')
  requireFile(binding.appRoot, 'shell/main.cjs')
  requireFile(binding.appRoot, 'shell/task-assignment-target-authority.cjs')
  requireFile(binding.engineRoot, 'tests/run-isolated.js')
  const suite = requireFile(binding.engineRoot, SUITE)
  const listed = fs.readFileSync(suite, 'utf8').split(/\r?\n/)
    .map(line => line.replace(/#.*/, '').trim()).filter(Boolean)
  if (JSON.stringify(listed) !== JSON.stringify(LEAVES)) fail('task-assignment suite does not list the exact four leaves once')
  for (const leaf of LEAVES) requireFile(binding.engineRoot, leaf)
  return { app, engine }
}

function rejectForeignAmbient(binding) {
  for (const key of SELECTORS.app) {
    if (process.env[key] !== undefined && !selectorMatchesRoot(process.env[key], binding.appRoot)) fail(`foreign inherited app selector ${key}`)
  }
  for (const key of SELECTORS.engine) {
    if (process.env[key] !== undefined && !selectorMatchesRoot(process.env[key], binding.engineRoot)) fail(`foreign inherited engine selector ${key}`)
  }
}

function childEnvironment(binding) {
  rejectForeignAmbient(binding)
  const env = { ...process.env }
  for (const key of SELECTORS.app) env[key] = binding.appRoot
  for (const key of SELECTORS.engine) env[key] = binding.engineRoot
  return env
}

function strictLeafCount(stdout) {
  const lines = stdout.replaceAll('\r\n', '\n').trimEnd().split('\n')
  const markers = lines.map(line => /^STRICT EVIDENCE: ([^ ]+) -- reconciled-tap; (\d+) passed; 0 UNEXECUTED \(within-suite skips\)$/.exec(line)).filter(Boolean)
  if (markers.length !== LEAVES.length) fail('child output lacks exactly four strict evidence markers')
  markers.forEach((marker, index) => {
    if (marker[1] !== LEAVES[index] || Number(marker[2]) < 1) fail('child strict evidence is duplicated, reordered or empty')
  })
  return lines
}

async function main() {
  const binding = parseArgs(process.argv.slice(2))
  if (process.env.TOOLSENABLED_TEST_STRICT !== '1') fail('paired runner requires TOOLSENABLED_TEST_STRICT=1')
  validateWindowsFixtureIdentity()
  const before = verifyBoundInputs(binding)
  const env = childEnvironment(binding)
  const { engineStateBase, retainedStateStderr: readRetainedState } = require(path.join(binding.appRoot, STATE_CONTRACT))
  const { prepareRetainedSourceFixture } = await import(require('node:url').pathToFileURL(path.join(binding.appRoot, FIXTURE_HELPER)))
  const fixture = prepareRetainedSourceFixture()
  Object.assign(env, fixture.environment)
  const { isolatedTemporaryRoot } = require(path.join(binding.engineRoot, ENVIRONMENT_HELPER))
  const stateBase = engineStateBase(fixture.root, isolatedTemporaryRoot)
  if (!samePath(fs.realpathSync.native(stateBase), stateBase) || !fs.lstatSync(stateBase).isDirectory())
    fail('engine state base is not an ordinary owned directory')
  const stateContract = { base: stateBase, startedAtMs: Date.now(), leafCount: LEAVES.length }
  const child = spawnSync(process.execPath, [path.join(binding.engineRoot, 'tests/run-isolated.js'), '--config-integrity',
    '--timeout-ms', '600000', '--from', SUITE], {
    cwd: binding.engineRoot, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false,
  })
  // Preserve the actual child evidence even when its diagnostics refuse qualification.
  if (child.stdout) process.stdout.write(child.stdout)
  let retainedStderr
  try { retainedStderr = retainedStateStderr(child.stderr, stateContract, readRetainedState) } catch (error) {
    if (child.stderr) process.stderr.write(child.stderr)
    throw error
  }
  if (retainedStderr.stderr) process.stdout.write(retainedStderr.stderr)
  if (child.error) fail(`bound child could not start: ${child.error.code || child.error.message}`)
  if (child.status !== 0 || child.signal) fail(`bound child exited ${child.status === null ? child.signal : child.status}`)
  strictLeafCount(child.stdout || '')
  const after = verifyBoundInputs(binding)
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('bound app or engine tracked inputs changed during child execution')
  if (!String(child.stdout || '').endsWith('\n')) process.stdout.write('\n')
  process.stdout.write(`TASK ASSIGNMENT PAIRED: ${JSON.stringify({
    schema: 'toolsenabled.task-assignment-paired.v1', appRoot: binding.appRoot, engineRoot: binding.engineRoot,
    appRef: binding.appRef, engineRef: binding.engineRef, files: LEAVES, childExitCode: 0, skipped: 0,
    retainedFixtureRoot: fixture.root, retainedEngineStateRoot: retainedStderr.root,
  })}\n`)
}

module.exports = { retainedStateStderr }
if (require.main === module) main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
