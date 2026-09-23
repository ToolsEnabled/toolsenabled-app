import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { canonicalRootForTests } from '../canonical-root.mjs'
import { checkCapabilityIndex } from '../lib/capability-index-check.mjs'
import { computeClosure } from '../pack-capability-layer.mjs'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = canonicalRootForTests()

/* The pack fixture copies private/owner-data-patterns.owner.json out of this
   checkout. That file is gitignored (/private/), so it exists only where an
   owner has configured the machine and NEVER in a fresh clone or worktree --
   these tests then failed with a bare ENOENT that reads like a product fault.
   Skip with the reason instead, the same shape generator-failures.test.mjs
   uses for its missing engine fixture. */
const OWNER_PATTERNS = 'private/owner-data-patterns.owner.json'

function ownerPatternsMissing() {
  return !existsSync(path.join(APP, OWNER_PATTERNS))
}

const SKIP_REASON =
  `Owner data patterns not found at ${path.join(APP, OWNER_PATTERNS)}: the pack gate copies this ` +
  'gitignored owner file into its fixture, so a fresh clone or worktree cannot run these tests.'

function put(root, relative, bytes) {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}

function commit(source) {
  git(source, 'add', '--all')
  git(source, 'commit', '-m', 'capability index fixture')
  return git(source, 'rev-parse', 'HEAD')
}

function registrySource(tools) {
  return `module.exports = { TOOL_REGISTRY: ${JSON.stringify(tools)} };\n`
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capability-index-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'app')
  const source = path.join(root, 'engine')
  const out = path.join(root, 'staged')
  const appFiles = [
    'package.json', 'tools/pack-capability-layer.mjs', 'tools/lib/capability-source-git.mjs',
    'tools/lib/provider-runtime-payload.mjs',
    'tools/lib/sterile-launch.cjs', 'shell/install-profile-guard.cjs', 'shell/capability-path-environment.cjs',
    'tools/check-no-owner-data.mjs', 'private/owner-data-patterns.owner.json',
    'capability-defaults/config/agent-org.json',
  ]
  // This also allows the regression to exercise the preceding packer, which
  // had no index check at all, without rewriting that packer for the test.
  const checker = 'tools/lib/capability-index-check.mjs'
  if (existsSync(path.join(APP, checker))) appFiles.push(checker)
  for (const relative of appFiles) put(app, relative, readFileSync(path.join(APP, relative)))

  const manifest = {
    entrypoints: ['tools/mission-bridge.js'], hostModules: [], spawnedPrograms: [], helperPrograms: [], dynamicRequires: [],
    dataFiles: ['config/capability-index.json'],
    neutralDefaults: ['config/agent-org.json', 'config/managed-processes.json'],
  }
  put(app, 'tools/capability-manifest.json', JSON.stringify(manifest))
  put(app, 'capability-defaults/config/managed-processes.json', JSON.stringify({
    processes: { fixture: { entryPoint: '', entryPattern: '' } },
  }))
  put(source, 'tools/mission-bridge.js', '// fixture entrypoint\n')
  put(source, 'config/agent-org.example.json', readFileSync(path.join(app, 'capability-defaults/config/agent-org.json')))

  // Run the real selected engine's builder and scorer, unchanged. Only the
  // registry is fixture data; importing it cannot execute an agent or provider.
  const closure = computeClosure(ENGINE, ['tools/build-capability-index.js', 'src/lib/capability-recall/score.js'])
  assert.deepEqual(closure.unresolved, [])
  assert.deepEqual(closure.external, [])
  for (const relative of [...closure.files, 'config/actions.json', 'config/objects.json', 'config/phrases.json']) {
    put(source, relative, readFileSync(path.join(ENGINE, relative)))
  }
  const docs = JSON.parse(readFileSync(path.join(ENGINE, 'config/capability-index.json'), 'utf8')).docs
  const tools = docs.map(doc => ({ name: doc.id, description: doc.summary, effect: doc.effect, provider: doc.provider }))
  put(source, 'src/lib/tool-registry.js', registrySource(tools))
  git(source, 'init', '--initial-branch=main')
  git(source, 'config', 'user.email', 'fixture@example.test')
  git(source, 'config', 'user.name', 'Capability Index Fixture')
  commit(source)
  const built = spawnSync(process.execPath, ['tools/build-capability-index.js', '--engine-root', source], {
    cwd: source, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(built.status, 0, `the unchanged builder must create a valid fixture: ${built.stdout}${built.stderr}`)
  const sourceRef = commit(source)
  put(out, 'previous-payload.txt', 'retain this payload until preflight passes\n')
  return { root, app, source, out, sourceRef, tools }
}

function pack(made, sourceRef = made.sourceRef) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^(TOOLSENABLED_SOURCE|TOOLSENABLED_SOURCE_REF|MC_CANONICAL_ROOT)$/i.test(name)) delete env[name]
  return spawnSync(process.execPath, [path.join(made.app, 'tools/pack-capability-layer.mjs'),
    '--source', made.source, '--source-ref', sourceRef, '--out', made.out, '--quiet'], {
    cwd: made.app, env, encoding: 'utf8', windowsHide: true, timeout: 45000,
  })
}

test('packing accepts an index checked by the real engine builder', t => {
  if (ownerPatternsMissing()) return t.skip(SKIP_REASON)
  const made = fixture(t)
  const result = pack(made)
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.ok(!existsSync(path.join(made.out, 'previous-payload.txt')))
  assert.deepEqual(readFileSync(path.join(made.out, 'config/capability-index.json')),
    readFileSync(path.join(made.source, 'config/capability-index.json')))
})

for (const mutation of ['addition', 'description']) {
  test(`packing refuses a stale index after a committed registry ${mutation} and preserves the prior payload`, t => {
    if (ownerPatternsMissing()) return t.skip(SKIP_REASON)
  const made = fixture(t)
    if (mutation === 'addition') {
      made.tools.push({ name: 'agent.spawn_fixture', description: 'Launch a unique fixture agent for a disposable build exercise.', effect: 'local-write' })
    } else {
      made.tools.find(tool => tool.name === 'agent.spawn').description += ' Preserve this newly reviewed description in capability recall.'
    }
    put(made.source, 'src/lib/tool-registry.js', registrySource(made.tools))
    const sourceRef = commit(made.source)
    assert.equal(git(made.source, 'status', '--porcelain'), '', 'the stale index belongs to a clean exact source commit')
    const result = pack(made, sourceRef)
    assert.equal(result.status, 1, `the stale committed index was packed: ${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /capability index.*(?:STALE|does not match|REFUSED)/is)
    assert.equal(readFileSync(path.join(made.out, 'previous-payload.txt'), 'utf8'), 'retain this payload until preflight passes\n')
    assert.ok(!existsSync(path.join(made.out, 'PAYLOAD.json')), 'a refused check cannot mint payload evidence')
  })
}

test('packing refuses a matching index with an unreachable agent tool and preserves the prior payload', t => {
  if (ownerPatternsMissing()) return t.skip(SKIP_REASON)
  const made = fixture(t)
  made.tools.find(tool => tool.name === 'agent.spawn').description = ''
  put(made.source, 'src/lib/tool-registry.js', registrySource(made.tools))
  // Construct an already present bad artifact using the actual builder API.
  // Currentness still passes; the real CLI must enforce reachability too.
  const construct = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const builder = require('./tools/build-capability-index.js');
    const built = builder.build({
      engineRoot: process.cwd(), withPacks: false, constants: null,
      actions: 'config/actions.json', objects: 'config/objects.json', phrases: 'config/phrases.json',
    });
    assert.deepEqual(built.stats.unreachable, [
      { id: 'agent.spawn', why: 'no description to be found by' },
    ]);
    fs.writeFileSync('config/capability-index.json', builder.serialise(built.artifact));
  `], { cwd: made.source, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(construct.status, 0, `${construct.stdout}${construct.stderr}`)
  const sourceRef = commit(made.source)
  assert.equal(git(made.source, 'status', '--porcelain'), '')
  const result = pack(made, sourceRef)
  assert.equal(result.status, 1, `an unreachable agent tool was packed: ${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /CAPABILITY_TOOL_UNREACHABLE/)
  assert.match(result.stderr, /agent\.spawn/)
  assert.equal(readFileSync(path.join(made.out, 'previous-payload.txt'), 'utf8'), 'retain this payload until preflight passes\n')
  assert.ok(!existsSync(path.join(made.out, 'PAYLOAD.json')), 'a refused check cannot mint payload evidence')
})

test('packing refuses a missing index checker before replacing the prior payload', t => {
  if (ownerPatternsMissing()) return t.skip(SKIP_REASON)
  const made = fixture(t)
  rmSync(path.join(made.source, 'tools/build-capability-index.js'))
  const result = pack(made, commit(made.source))
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /capability index.*build-capability-index/is)
  assert.equal(readFileSync(path.join(made.out, 'previous-payload.txt'), 'utf8'), 'retain this payload until preflight passes\n')
})

test('packing refuses a checker that exits successfully without comparing the index', t => {
  if (ownerPatternsMissing()) return t.skip(SKIP_REASON)
  const made = fixture(t)
  put(made.source, 'tools/build-capability-index.js', "process.stdout.write('builder imported without running\\n')\n")
  const result = pack(made, commit(made.source))
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /without a CURRENT registry comparison/)
  assert.equal(readFileSync(path.join(made.out, 'previous-payload.txt'), 'utf8'), 'retain this payload until preflight passes\n')
})

test('packing requires the index as engine-derived data, including before the first pack', t => {
  if (ownerPatternsMissing()) return t.skip(SKIP_REASON)
  const made = fixture(t)
  const manifestFile = path.join(made.app, 'tools/capability-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.dataFiles = []
  writeFileSync(manifestFile, JSON.stringify(manifest))
  const result = pack(made)
  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
  assert.match(result.stderr, /capability index must be declared as engine-derived payload data/)
  assert.equal(readFileSync(path.join(made.out, 'previous-payload.txt'), 'utf8'), 'retain this payload until preflight passes\n')
})

test('the checker child uses scratch state and rejects inherited source, state, and preload overrides', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capability-check-environment-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'engine')
  const reportFile = path.join(root, 'report.json')
  const preloadFile = path.join(root, 'ambient-preload.cjs')
  const sentinel = path.join(root, 'preload-ran.txt')
  writeFileSync(preloadFile, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ambient preload ran');\n`)
  put(source, 'config/capability-index.json', '{"N":1}\n')
  put(source, 'tools/build-capability-index.js', [
    "const fs = require('node:fs'); const path = require('node:path');",
    'fs.writeFileSync(process.env.CHECK_FIXTURE_REPORT, JSON.stringify({',
    '  cwd: process.cwd(), args: process.argv.slice(2), state: process.env.TOOLSENABLED_STATE_ROOT,',
    '  temp: process.env.TEMP, profile: process.env.USERPROFILE,',
    '  overrides: Object.keys(process.env).filter(key => /^(?:TOOLSENABLED_ENGINE_ROOT|TOOLSENABLED_AUDIT_DB|TOOLSENABLED_STATE_PATH|MC_CANONICAL_ROOT|NODE_OPTIONS|NODE_PATH|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_0)$/i.test(key))',
    '}));',
    "console.log('CURRENT -- ' + path.resolve('config/capability-index.json') + ' matches the 1-tool registry.');",
  ].join('\n'))
  const result = await checkCapabilityIndex({ source, environment: {
    ...process.env,
    CHECK_FIXTURE_REPORT: reportFile,
    TOOLSENABLED_ENGINE_ROOT: path.join(root, 'wrong-engine'),
    toolsEnabled_audit_db: path.join(root, 'ambient-audit.sqlite3'),
    TOOLSENABLED_STATE_PATH: path.join(root, 'ambient-state.sqlite3'),
    MC_CANONICAL_ROOT: path.join(root, 'wrong-source'),
    NODE_OPTIONS: `--require ${JSON.stringify(preloadFile)}`,
    NODE_PATH: path.join(root, 'ambient-node-path'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fixture.shouldNotReachGit',
  } })
  assert.equal(result.toolCount, 1)
  assert.ok(!existsSync(sentinel), 'the inherited preload must never run')
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  assert.deepEqual(report.overrides, [])
  assert.equal(report.cwd, source)
  assert.deepEqual(report.args, ['--engine-root', source, '--out', path.join(source, 'config/capability-index.json'), '--check'])
  const scratch = path.dirname(report.temp)
  for (const selected of [report.state, report.temp, report.profile]) {
    const relative = path.relative(scratch, selected)
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'all selected state must belong to this check')
  }
  assert.ok(!existsSync(scratch), 'a completed checker must release its owned scratch')
})

test('a stuck checker is bounded and its scratch is retained on uncertain descendant cleanup', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capability-check-timeout-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'engine')
  const pidFile = path.join(root, 'child-pid.txt')
  put(source, 'config/capability-index.json', '{"N":1}\n')
  // This fixture owns one actual Node child and never spawns a descendant.
  put(source, 'tools/build-capability-index.js',
    "require('node:fs').writeFileSync(process.env.CHECK_FIXTURE_PID, String(process.pid)); setInterval(() => {}, 1000);\n")
  let failure
  try {
    await checkCapabilityIndex({ source, timeoutMs: 1000, environment: { ...process.env, CHECK_FIXTURE_PID: pidFile } })
    assert.fail('the stuck checker passed')
  } catch (error) { failure = error }
  assert.equal(failure.cause?.killed, true)
  const scratch = failure.message.match(/scratch retained at (.+)$/)?.[1]
  assert.ok(scratch && existsSync(scratch), 'unproven cleanup must not delete scratch')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the exact fixture child must actually be gone')
  const relative = path.relative(os.tmpdir(), path.resolve(scratch))
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.basename(scratch).startsWith('capability-index-check-'))
  // Now this test has proved its child gone and knows it spawned no others.
  rmSync(scratch, { recursive: true, force: true })
})
