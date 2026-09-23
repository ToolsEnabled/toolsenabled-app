import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createDevelopmentSession, readDevelopmentSession, developmentSessionEnvironment,
  acquireDevelopmentSession, gitEnvironment } from '../lib/development-session.mjs'
import { main, parseDevelopmentArguments } from '../dev-environment.mjs'
import { developmentSandboxProfile } from '../lib/development-sandbox.mjs'

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true,
    env: { ...gitEnvironment(), GIT_AUTHOR_NAME: 'Session fixture', GIT_AUTHOR_EMAIL: 'session@example.invalid',
      GIT_COMMITTER_NAME: 'Session fixture', GIT_COMMITTER_EMAIL: 'session@example.invalid' } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'development-session-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of ['source-app', 'source-engine']) {
    const dir = path.join(root, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, '.gitignore'), '/private/\n/node_modules/\n/dist/\n/capability/\n')
    fs.writeFileSync(path.join(dir, 'source.txt'), name + ': committed\n')
    git(dir, 'init', '--quiet')
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'fixture initial source')
  }
  return { root, app: path.join(root, 'source-app'), engine: path.join(root, 'source-engine'),
    create: (name, options = {}) => createDevelopmentSession({ directory: path.join(root, name),
      app: path.join(root, 'source-app'), engine: path.join(root, 'source-engine'), kind: 'cut', ...options }) }
}

test('CUT snapshots exact commits while dirty DEV continues, and does not share Git objects or checkout state', t => {
  const f = fixture(t)
  const selected = { app: git(f.app, 'rev-parse', 'HEAD'), engine: git(f.engine, 'rev-parse', 'HEAD') }
  fs.writeFileSync(path.join(f.app, 'source.txt'), 'unfinished app edit\n')
  fs.writeFileSync(path.join(f.engine, 'untracked.txt'), 'unfinished engine edit\n')
  const before = { app: git(f.app, 'status', '--porcelain=v1'), engine: git(f.engine, 'status', '--porcelain=v1') }
  const cut = f.create('cut')
  assert.equal(cut.sources.app.ref, selected.app)
  assert.equal(cut.sources.engine.ref, selected.engine)
  assert.equal(fs.readFileSync(path.join(cut.paths.app, 'source.txt'), 'utf8'), 'source-app: committed\n')
  assert.equal(fs.existsSync(path.join(cut.paths.engine, 'untracked.txt')), false)
  assert.deepEqual({ app: git(f.app, 'status', '--porcelain=v1'), engine: git(f.engine, 'status', '--porcelain=v1') }, before)
  git(f.app, 'add', 'source.txt'); git(f.app, 'commit', '--quiet', '-m', 'continue development')
  assert.notEqual(git(f.app, 'rev-parse', 'HEAD'), selected.app)
  assert.equal(readDevelopmentSession(cut.paths.root).sources.app.ref, selected.app)
  // The entire original checkout can move away; CUT retains all objects.
  fs.renameSync(f.app, path.join(f.root, 'moved-app'))
  fs.renameSync(f.engine, path.join(f.root, 'moved-engine'))
  assert.equal(readDevelopmentSession(cut.paths.root).sources.engine.ref, selected.engine)
  for (const name of ['app', 'engine', 'controlApp', 'controlEngine']) {
    assert.equal(fs.lstatSync(path.join(cut.paths[name], '.git')).isDirectory(), true)
    assert.equal(fs.existsSync(path.join(cut.paths[name], '.git/objects/info/alternates')), false)
    assert.equal(git(cut.paths[name], 'remote'), '')
  }
})

function shallowFixture(t) {
  const f = fixture(t)
  for (const source of [f.app, f.engine]) {
    fs.writeFileSync(path.join(source, 'source.txt'), 'selected shallow source\n')
    git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'fixture selected shallow source')
    const shallow = source + '-shallow'
    git(f.root, 'clone', '--quiet', '--depth', '1', pathToFileURL(source).href, shallow)
  }
  return { ...f, app: f.app + '-shallow', engine: f.engine + '-shallow' }
}

test('CUT snapshots retain declared shallow boundaries and independent traversable history', t => {
  const f = shallowFixture(t)
  const cut = f.create('shallow-cut', { app: f.app, engine: f.engine })
  fs.renameSync(f.app, f.app + '-moved'); fs.renameSync(f.engine, f.engine + '-moved')
  for (const name of ['app', 'engine', 'controlApp', 'controlEngine']) {
    const repository = cut.paths[name]
    assert.equal(git(repository, 'rev-parse', '--is-shallow-repository'), 'true')
    assert.equal(git(repository, 'rev-list', '--count', 'HEAD'), '1')
    assert.match(git(repository, 'rev-list', '--objects', '--count', '--missing=error', 'HEAD'), /^[1-9][0-9]*$/)
    assert.equal(git(repository, 'rev-parse', 'HEAD'), cut.sources[name.toLowerCase().includes('engine') ? 'engine' : 'app'].ref)
    assert.equal(fs.existsSync(path.join(repository, '.git/objects/info/alternates')), false)
  }
  assert.equal(readDevelopmentSession(cut.paths.root).id, cut.id)
})

test('frozen source validation refuses missing parent history even when exact tree bytes still match', t => {
  const f = shallowFixture(t)
  const cut = f.create('shallow-boundary-loss', { app: f.app, engine: f.engine })
  fs.rmSync(path.join(cut.paths.controlApp, '.git/shallow'), { force: true })
  assert.throws(() => readDevelopmentSession(cut.paths.root), /Failed to traverse parents|Could not read/)
})

test('two DEV windows and CUT have independent admission, profiles and caches', t => {
  const f = fixture(t), one = f.create('dev-one', { kind: 'dev' }), two = f.create('dev-two', { kind: 'dev' }), cut = f.create('cut')
  const firstLease = acquireDevelopmentSession(one, 'open'), secondLease = acquireDevelopmentSession(two, 'open'), cutLease = acquireDevelopmentSession(cut, 'cut')
  assert.throws(() => acquireDevelopmentSession(one, 'prepare'), { code: 'EEXIST' })
  const environments = [one, two, cut].map(session => developmentSessionEnvironment(session))
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'CODEX_HOME', 'TEMP', 'npm_config_cache', 'ELECTRON_BUILDER_CACHE']) {
    assert.equal(new Set(environments.map(env => env[key])).size, 3, key)
  }
  firstLease.finish({ cleanupConfirmed: true, code: 0 })
  assert.equal(fs.existsSync(path.join(two.paths.root, 'operation.json')), true)
  assert.equal(fs.existsSync(path.join(cut.paths.root, 'operation.json')), true)
  secondLease.finish({ cleanupConfirmed: true, code: 0 })
  cutLease.finish({ cleanupConfirmed: true, code: 0 })
})

test('unconfirmed process cleanup prevents reuse of only the affected session', t => {
  const f = fixture(t), cut = f.create('cut'), dev = f.create('dev', { kind: 'dev' })
  acquireDevelopmentSession(cut, 'cut').finish({ cleanupConfirmed: false, code: null })
  assert.throws(() => acquireDevelopmentSession(cut, 'cut'), { code: 'EEXIST' })
  acquireDevelopmentSession(dev, 'open').finish({ cleanupConfirmed: true, code: 0 })
  assert.equal(fs.readdirSync(cut.paths.evidence).length, 1)
})

test('session creation never imports arbitrary private or uncommitted builder inputs', t => {
  const f = fixture(t), privateRoot = path.join(f.app, 'private')
  fs.mkdirSync(privateRoot)
  fs.writeFileSync(path.join(privateRoot, 'account-private.json'), 'Do not copy this fixture')
  const privacy = path.join(f.root, 'privacy.json')
  fs.writeFileSync(privacy, JSON.stringify({ patterns: ['fixture identity'] }))
  const cut = f.create('cut', { privacyProfile: privacy })
  assert.equal(fs.existsSync(path.join(cut.paths.app, 'private/account-private.json')), false)
  assert.equal(fs.readFileSync(path.join(cut.paths.app, 'private/owner-data-patterns.owner.json'), 'utf8'), fs.readFileSync(privacy, 'utf8'))
  const binding = JSON.parse(fs.readFileSync(path.join(cut.paths.app, 'private/capability-source.owner.json')))
  assert.equal(binding.path, cut.paths.engine)
  fs.writeFileSync(path.join(cut.paths.app, 'private/owner-data-patterns.owner.json'), '{}')
  assert.throws(() => readDevelopmentSession(cut.paths.root), /privacy input changed/)
})

test('frozen source edits and rewritten engine selections refuse; DEV edits stay private', t => {
  const f = fixture(t), cut = f.create('cut'), dev = f.create('dev', { kind: 'dev' })
  fs.writeFileSync(path.join(cut.paths.app, 'source.txt'), 'unqualified change')
  assert.throws(() => readDevelopmentSession(cut.paths.root), /Frozen session source changed/)
  fs.writeFileSync(path.join(dev.paths.app, 'source.txt'), 'local development edit')
  assert.equal(readDevelopmentSession(dev.paths.root).kind, 'dev')
  fs.writeFileSync(path.join(dev.paths.engine, 'source.txt'), 'engine work in progress')
  assert.equal(readDevelopmentSession(dev.paths.root).kind, 'dev')
  assert.equal(fs.readFileSync(path.join(dev.paths.controlApp, 'source.txt'), 'utf8'), 'source-app: committed\n')
  assert.equal(fs.readFileSync(path.join(dev.paths.controlEngine, 'source.txt'), 'utf8'), 'source-engine: committed\n')
  const binding = path.join(dev.paths.app, 'private/capability-source.owner.json')
  fs.writeFileSync(binding, JSON.stringify({ path: f.engine, ref: dev.sources.engine.ref }))
  assert.throws(() => readDevelopmentSession(dev.paths.root), /engine binding changed/)
})

test('DEV cannot replace its pinned controller or process custody with work in progress', t => {
  const f = fixture(t)
  for (const name of ['controlApp', 'controlEngine']) {
    const dev = f.create('dev-' + name, { kind: 'dev' })
    fs.writeFileSync(path.join(dev.paths[name], 'source.txt'), 'forged controller or process owner')
    assert.throws(() => readDevelopmentSession(dev.paths.root), /Frozen session source changed/)
  }
})

test('an existing session delegates to its frozen controller after both source and DEV controller edits', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.app, 'tools'))
  // A small routing witness, not a product/qualification implementation.
  fs.writeFileSync(path.join(f.app, 'tools/dev-environment.mjs'), 'export async function main(argv) { return { controller: "selected", argv } }\n')
  git(f.app, 'add', 'tools/dev-environment.mjs'); git(f.app, 'commit', '--quiet', '-m', 'controller routing witness')
  const dev = f.create('dev', { kind: 'dev' }), args = ['status', '--session', dev.paths.root]
  for (const root of [f.app, dev.paths.app]) fs.writeFileSync(path.join(root, 'tools/dev-environment.mjs'), 'throw Error("mutable controller executed")\n')
  fs.renameSync(f.app, path.join(f.root, 'moved-source-app'))
  fs.renameSync(f.engine, path.join(f.root, 'moved-source-engine'))
  assert.deepEqual(await main(args), { controller: 'selected', argv: args })
  fs.writeFileSync(path.join(dev.paths.controlApp, 'tools/dev-environment.mjs'), 'throw Error("forged controller executed")\n')
  await assert.rejects(main(args), /Frozen session source changed/)
})

test('existing paths, nested sessions and non-exact source refs refuse without clobbering', t => {
  const f = fixture(t), cut = f.create('cut')
  const original = fs.readFileSync(path.join(cut.paths.root, 'session.json'))
  assert.throws(() => f.create('cut'), { code: 'EEXIST' })
  assert.deepEqual(fs.readFileSync(path.join(cut.paths.root, 'session.json')), original)
  assert.throws(() => createDevelopmentSession({ directory: path.join(f.app, 'nested'), app: f.app, engine: f.engine }), /separate/)
  assert.throws(() => f.create('invalid', { appRef: 'HEAD' }), /exact/)
  assert.equal(fs.existsSync(path.join(f.root, 'invalid')), false)
})

test('snapshot Git cannot redirect status to a different clean working tree', t => {
  const f = fixture(t), cut = f.create('cut')
  git(cut.paths.app, 'config', 'core.worktree', f.app)
  fs.writeFileSync(path.join(cut.paths.app, 'source.txt'), 'unqualified snapshot change')
  assert.throws(() => readDevelopmentSession(cut.paths.root), /Git identity redirects/)
})

test('Git clean filters cannot qualify modified raw CUT or process-custody bytes', t => {
  const f = fixture(t), cut = f.create('cut'), dev = f.create('dev', { kind: 'dev' })
  for (const [session, root] of [[cut, cut.paths.app], [dev, dev.paths.controlApp], [dev, dev.paths.controlEngine]]) {
    fs.writeFileSync(path.join(root, '.git/info/attributes'), 'source.txt filter=freeze\n')
    git(root, 'config', 'filter.freeze.clean', 'git show HEAD:source.txt')
    fs.writeFileSync(path.join(root, 'source.txt'), 'changed executable source hidden by a clean filter\n')
    git(root, 'add', 'source.txt')
    assert.equal(git(root, 'status', '--porcelain=v1'), '')
    assert.throws(() => readDevelopmentSession(session.paths.root), /Frozen session source changed: raw file bytes/)
  }
})

test('tracked source cannot borrow an external hardlink', t => {
  const f = fixture(t), cut = f.create('cut')
  const target = path.join(cut.paths.app, 'source.txt')
  fs.unlinkSync(target)
  fs.linkSync(path.join(f.app, 'source.txt'), target)
  assert.equal(git(cut.paths.app, 'status', '--porcelain=v1'), '')
  assert.throws(() => readDevelopmentSession(cut.paths.root), /independent ordinary file/)
})

test('committed source links refuse during materialization on either native platform', t => {
  const f = fixture(t)
  // Git can store a symlink even when a standard Windows checkout has no
  // permission to create one. Construct the real committed tree entry, then
  // exercise the production checkout and materialized-file refusal.
  const blobFile = path.join(f.root, 'link-target')
  fs.writeFileSync(blobFile, path.join(f.engine, 'source.txt'))
  const blob = git(f.app, 'hash-object', '-w', blobFile)
  git(f.app, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',linked-source.txt')
  git(f.app, 'commit', '--quiet', '-m', 'fixture escaping source link')
  assert.throws(() => f.create('cut'), /tracked links/)
})

test('linked profile children and cache destinations refuse before any peer write', t => {
  const f = fixture(t), cut = f.create('cut'), peer = path.join(f.root, 'peer')
  fs.mkdirSync(peer)
  const alias = path.join(cut.paths.runtimeProfile, 'userprofile')
  fs.symlinkSync(peer, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => developmentSessionEnvironment(cut), /cannot traverse links/)
  assert.deepEqual(fs.readdirSync(peer), [])
  fs.rmSync(alias)
  const cache = path.join(cut.paths.cache, 'electron')
  fs.symlinkSync(peer, cache, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => developmentSessionEnvironment(cut), /cannot traverse links/)
  assert.deepEqual(fs.readdirSync(peer), [])
})

test('child environment strips engine, QA, Git and dependency overrides without modifying caller', t => {
  const f = fixture(t), cut = f.create('cut')
  const base = { ...process.env, MISSION_CONTROL_ENGINE: f.engine, MC_BRIDGE_PROOF_FILE: '/elsewhere', MC_ALLOW_DIRTY_BUILD: '1',
    TOOLSENABLED_STATE_ROOT: '/other-instance', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=other.js',
    GIT_DIR: f.app, npm_config_cache: f.app, npm_config_ignore_scripts: 'true', ELECTRON_BUILDER_CACHE: f.app, electron_config_cache: f.app,
    TOOLSENABLED_CUT_MODEL: 'session-test', TOOLSENABLED_CUT_EMAIL: 'session@example.invalid', TOOLSENABLED_CUT_SESSION: 'session-test' }
  const before = { ...base }
  const env = developmentSessionEnvironment(cut, { phase: 'build', base })
  for (const key of ['MISSION_CONTROL_ENGINE', 'MC_BRIDGE_PROOF_FILE', 'MC_ALLOW_DIRTY_BUILD', 'TOOLSENABLED_STATE_ROOT', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'GIT_DIR', 'npm_config_ignore_scripts']) assert.equal(env[key], undefined, key)
  assert.equal(env.TOOLSENABLED_SOURCE, cut.paths.engine)
  assert.equal(env.TOOLSENABLED_SOURCE_REF, cut.sources.engine.ref)
  assert.equal(env.electron_config_cache, path.join(cut.paths.cache, 'electron'))
  assert.equal(env.TOOLSENABLED_CUT_SESSION, 'session-test')
  assert.equal(env.TOOLSENABLED_SHARED_HOST_SESSION, '1')
  assert.equal(env.TOOLSENABLED_PROVIDER_ISOLATION_ROOT, undefined)
  assert.equal(developmentSessionEnvironment(cut, { base }).TOOLSENABLED_PROVIDER_ISOLATION_ROOT, cut.paths.runtimeProfile)
  assert.equal(developmentSessionEnvironment(cut, { base }).TOOLSENABLED_CUT_SESSION, undefined)
  assert.equal(developmentSessionEnvironment(cut, { base }).TOOLSENABLED_SHARED_HOST_SESSION, '1')
  assert.deepEqual(base, before)
})

test('native sandbox policy attaches to one executable and refuses path-pattern injection', t => {
  const f = fixture(t), dev = f.create('dev', { kind: 'dev' })
  if (process.platform !== 'linux') {
    assert.throws(() => developmentSandboxProfile(dev), /only to native Linux/)
    return
  }
  const executable = path.join(dev.paths.app, 'node_modules/electron/dist/electron')
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'fixture')
  const policy = developmentSandboxProfile(dev)
  assert.ok(policy.includes('"' + executable + '"'))
  assert.equal(policy.match(/\bprofile /g)?.length, 1)
  assert.equal(policy.includes('userns,'), true)
  const injectedApp = path.join(f.root, 'app*')
  fs.mkdirSync(path.join(injectedApp, 'node_modules/electron/dist'), { recursive: true })
  fs.writeFileSync(path.join(injectedApp, 'node_modules/electron/dist/electron'), 'fixture')
  assert.throws(() => developmentSandboxProfile({ ...dev, paths: { ...dev.paths, app: injectedApp } }), /exact AppArmor attachment/)
})

test('CLI refuses meaningless or mutating cut flags instead of silently forwarding them', () => {
  assert.throws(() => parseDevelopmentArguments(['cut', '--advance-branch']), /Unknown/)
  assert.throws(() => parseDevelopmentArguments(['open', '--test']), /does not apply/)
  assert.throws(() => parseDevelopmentArguments(['cut', '--session', '/a', '--session', '/b']), /duplicate/)
  assert.equal(parseDevelopmentArguments(['open', '--session', '/a', '--watch']).options.watch, true)
})

test('full CUT refuses on a shared host before launching qualification or acquiring an operation', async t => {
  const f = fixture(t), cut = f.create('cut')
  await assert.rejects(main(['cut', '--session', cut.paths.root]), error => error.code === 'QA_DISPOSABLE_WORKER_REQUIRED')
  assert.equal(fs.existsSync(path.join(cut.paths.root, 'operation.json')), false)
  assert.equal(readDevelopmentSession(cut.paths.root).sources.app.ref, cut.sources.app.ref)
})
