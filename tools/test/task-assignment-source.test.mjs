import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TASK_ASSIGNMENT_LEAVES, TASK_ASSIGNMENT_SOURCE_ACTION,
  parseTaskAssignmentSourceTranscript, planTaskAssignmentSourceJob } from '../lib/adapters/task-assignment-source.mjs';
import { SOURCE_COMMAND_ACTIONS, SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs';
import { parseSourceOutput } from '../lib/adapters/source-suites.mjs';
import { reconcileSourceCommands } from '../lib/adapters/source-command-plan.mjs';

const binding = { root: path.resolve('/tmp/task-assignment-app'), canonicalRoot: path.resolve('/tmp/task-assignment-engine'),
  appRef: 'a'.repeat(40), engineRef: 'b'.repeat(40) };
const DRIVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa/task-assignment-paired.cjs');
const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
const APP = path.resolve(path.dirname(DRIVER), '../..');
const ENGINE = process.env.MC_CANONICAL_ROOT;
assert.ok(typeof ENGINE === 'string' && path.isAbsolute(ENGINE), 'explicit engine root is required for the producer fixture');
const STATE_CONTRACT = 'tools/qa/settings-source-paired.cjs';
const FIXTURE_HELPER = 'tools/test/lib/source-fixture-root.mjs';
const ENVIRONMENT_HELPER = 'tests/lib/isolated-environment.js';
const environmentSource = fs.readFileSync(path.join(ENGINE, ENVIRONMENT_HELPER), 'utf8');
const runnerSource = fs.readFileSync(path.join(ENGINE, 'tests/run-isolated.js'), 'utf8');
const scratchProducerSource = runnerSource.slice(runnerSource.indexOf("const SUITE_ROOT_PREFIX = 'te-';"),
  runnerSource.indexOf('function removeIsolatedDirectory('));
assert.ok(scratchProducerSource.includes('function scratchBase()'));
const builtinRequire = createRequire(import.meta.url);
const fixtureRoot = path.resolve('/tmp/te-source-fixture-abc123');
// Synthetic Windows account home, assembled at runtime so the source carries no literal user path.
const WINDOWS_ACCOUNT_HOME = ['C:', 'Users', 'BuildAccount-Dev'].join('\\');
const engineStateRoot = root => path.join(process.platform === 'win32'
  ? `${WINDOWS_ACCOUNT_HOME}\\AppData\\Local\\Temp` : root, 'te-abcdef');


function transcript(files = TASK_ASSIGNMENT_LEAVES, retainedFixtureRoot = fixtureRoot) {
  const markers = files.map(file => `STRICT EVIDENCE: ${file} -- reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)`);
  return `${markers.join('\n')}\nTASK ASSIGNMENT PAIRED: ${JSON.stringify({
    schema: 'toolsenabled.task-assignment-paired.v1', appRoot: binding.root, engineRoot: binding.canonicalRoot,
    appRef: binding.appRef, engineRef: binding.engineRef, files, childExitCode: 0, skipped: 0,
    retainedFixtureRoot, retainedEngineStateRoot: engineStateRoot(retainedFixtureRoot),
  })}\n`;
}

test('paired source action is context-bound and cannot be discharged by a generic command', () => {
  const action = SOURCE_COMMAND_ACTIONS.app.find(row => row.id === TASK_ASSIGNMENT_SOURCE_ACTION.id);
  assert.deepEqual(action?.pairedLeaves, TASK_ASSIGNMENT_LEAVES);
  const input = { aliases: { 'test:task-assignment': 'node tools/qa/task-assignment-paired.cjs' }, selectedFiles: [],
    coveredCommands: [TASK_ASSIGNMENT_SOURCE_ACTION.command] };
  assert.equal(reconcileSourceCommands(input).complete, false);
  assert.equal(reconcileSourceCommands({ ...input, contextCommands: [TASK_ASSIGNMENT_SOURCE_ACTION] }).complete, true);
});

test('engine leaves require an explicit paired action and are dispatched once', () => {
  const manifest = SOURCE_MANIFESTS.engine;
  const suiteAlias = 'test:task-assignment';
  const suite = manifest.aliases[suiteAlias];
  assert.equal(suite, 'node tests/run-isolated.js --from tests/suites/task-assignment.txt');
  const readSuiteList = file => file === 'tests/suites/task-assignment.txt' ? `${TASK_ASSIGNMENT_LEAVES.join('\n')}\n` : '';
  const input = { aliases: { [suiteAlias]: suite }, selectedFiles: [], coveredCommands: [], readSuiteList };
  const missing = reconcileSourceCommands(input);
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.obligations.filter(row => row.id === 'unselected-required-test').map(row => row.file), TASK_ASSIGNMENT_LEAVES);
  const pair = manifest.pairedActions.find(row => row.action === TASK_ASSIGNMENT_SOURCE_ACTION.id);
  assert.deepEqual(pair?.files, TASK_ASSIGNMENT_LEAVES);
  const complete = reconcileSourceCommands({ ...input, pairedActions: [pair] });
  assert.equal(complete.complete, true);
  const dispatched = complete.actions.filter(row => row.command[0] === 'node' && TASK_ASSIGNMENT_LEAVES.includes(row.command[1]));
  assert.deepEqual(dispatched.map(row => row.command[1]), TASK_ASSIGNMENT_LEAVES);
  assert.equal(new Set(dispatched.map(row => row.command[1])).size, TASK_ASSIGNMENT_LEAVES.length);
  const incomplete = reconcileSourceCommands({ ...input, pairedActions: [{ ...pair, files: TASK_ASSIGNMENT_LEAVES.slice(0, -1) }] });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.obligations.filter(row => row.id === 'unselected-required-test').length, 1);
  assert.equal(incomplete.obligations.find(row => row.id === 'unselected-required-test')?.file, TASK_ASSIGNMENT_LEAVES.at(-1));
});

test('pair mismatch is refused before a child selector can be planned', () => {
  assert.throws(() => planTaskAssignmentSourceJob({ id: 'app', root: path.resolve('/tmp/foreign-app'), canonicalRoot: binding.canonicalRoot },
    path.resolve('/tmp/evidence'), binding), /measured app\/engine inputs/);
});

test('paired transcript accounts each engine leaf exactly once', () => {
  const options = { ...TASK_ASSIGNMENT_SOURCE_ACTION, taskAssignmentBinding: binding };
  assert.equal(parseSourceOutput(transcript(), '', options).tests, TASK_ASSIGNMENT_LEAVES.length);
  const retainedFixtureRoot = fixtureRoot;
  const retainedNotice = 'Isolated test state retained by request: ' + engineStateRoot(retainedFixtureRoot) + '\n';
  assert.equal(parseTaskAssignmentSourceTranscript(transcript(), retainedNotice, { ...binding, retainedFixtureRoot }).tests,
    TASK_ASSIGNMENT_LEAVES.length);
  assert.throws(() => parseTaskAssignmentSourceTranscript(transcript(), 'unexpected warning\n', binding),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  assert.throws(() => parseTaskAssignmentSourceTranscript(transcript([TASK_ASSIGNMENT_LEAVES[0], ...TASK_ASSIGNMENT_LEAVES]), '', binding),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  assert.throws(() => parseSourceOutput(transcript(TASK_ASSIGNMENT_LEAVES.slice(0, -1)), '', options),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
});

function gitEnv(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'no-global'),
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/nonexistent' };
}

function fixtureRepository(scratch, name, files) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const env = gitEnv(scratch);
  const run = args => execFileSync(GIT, ['-C', root, ...args], { cwd: root, env, encoding: 'utf8' });
  run(['init', '--quiet']);
  run(['config', 'user.email', 'task-assignment-fixture@example.invalid']);
  run(['config', 'user.name', 'task-assignment-fixture']);
  run(['add', '.']);
  run(['commit', '--quiet', '-m', 'fixture']);
  const ref = run(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  return { root, ref };
}

function boundaryFixture() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'task-assignment-runner-boundary-'));
  const app = fixtureRepository(scratch, 'app', {
    'shell/main.cjs': 'module.exports = {}\n',
    'shell/task-assignment-target-authority.cjs': 'module.exports = {}\n',
    [STATE_CONTRACT]: fs.readFileSync(path.join(APP, STATE_CONTRACT)),
    [FIXTURE_HELPER]: fs.readFileSync(path.join(APP, FIXTURE_HELPER)),
  });
  const engine = fixtureRepository(scratch, 'engine', {
    'tests/run-isolated.js': [
      "const fs = require('node:fs'), path = require('node:path'), os = require('node:os');",
      "const { isolatedTemporaryRoot } = require('./lib/isolated-environment');",
      scratchProducerSource,
      "const retainedStateRoot = fs.mkdtempSync(path.join(scratchBase(), SUITE_ROOT_PREFIX));",
      "for (let index=1; index<=4; index++) fs.mkdirSync(path.join(retainedStateRoot, String(index).padStart(3, '0')));",
      "const marker = process.env.TASK_ASSIGNMENT_FIXTURE_MARKER || path.join(__dirname, '..', 'dispatch.marker'); fs.writeFileSync(marker, 'dispatched\\n');",
      "console.error('Isolated test state retained by request: ' + (process.env.TASK_ASSIGNMENT_RETAINED_NOTICE || retainedStateRoot));",
      "if (process.env.TASK_ASSIGNMENT_UNEXPECTED_STDERR) console.error(process.env.TASK_ASSIGNMENT_UNEXPECTED_STDERR);",
      ...TASK_ASSIGNMENT_LEAVES.map(file => `console.log(${JSON.stringify(`STRICT EVIDENCE: ${file} -- reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)`)});`),
      '',
    ].join('\n'),
    [ENVIRONMENT_HELPER]: environmentSource,
    'tests/suites/task-assignment.txt': `${TASK_ASSIGNMENT_LEAVES.join('\n')}\n`,
    ...Object.fromEntries(TASK_ASSIGNMENT_LEAVES.map(file => [file, '']))
  });
  return { scratch, app, engine, markerFor: label => path.join(engine.root, 'dispatch-' + label + '.marker') };
}

function invokeRunner(fixture, appRoot = fixture.app.root, envOverrides = {}, appRef = fixture.app.ref,
  markerPath = fixture.markerFor('default')) {
  const env = { ...process.env, TOOLSENABLED_TEST_STRICT: '1' };
  for (const key of ['IMAGE_APP_ROOT', 'TOOLSENABLED_TEST_APP_ROOT', 'T1139_B6_APP_ROOT',
    'T1630_ENGINE_ROOT', 'TOOLSENABLED_TEST_ENGINE_ROOT', 'MC_CANONICAL_ROOT']) delete env[key];
  Object.assign(env, envOverrides);
  env.TASK_ASSIGNMENT_FIXTURE_MARKER = markerPath;
  env.TOOLSENABLED_TEST_RETAIN_FIXTURES = '1';
  env.TMPDIR = fixture.scratch;
  env.TEMP = fixture.scratch;
  env.TMP = fixture.scratch;
  return spawnSync(process.execPath, [DRIVER, '--app', appRoot, '--engine', fixture.engine.root,
    '--app-ref', appRef, '--engine-ref', fixture.engine.ref], { cwd: fixture.app.root, env, encoding: 'utf8' });
}

test('driver refuses wrong refs, foreign roots, ambient selectors and dirty tracked inputs before dispatch', () => {
  const fixture = boundaryFixture();
  execFileSync(GIT, ['-C', fixture.app.root, 'update-index', '--skip-worktree', 'shell/main.cjs'], {
    cwd: fixture.app.root, env: gitEnv(fixture.scratch), encoding: 'utf8'
  });
  const sparseMarker = fixture.markerFor('sparse');
  const sparse = invokeRunner(fixture, fixture.app.root, {}, fixture.app.ref, sparseMarker);
  assert.equal(sparse.status, 0, sparse.stderr || sparse.stdout);
  assert.equal(fs.readFileSync(sparseMarker, 'utf8'), 'dispatched\n');
  assert.match(sparse.stdout, /Isolated test state retained by request:/);
  assert.match(sparse.stdout, /TASK ASSIGNMENT PAIRED:/);
  const trailingMarker = fixture.markerFor('trailing');
  const sameRootWithTrailingSlash = invokeRunner(fixture, fixture.app.root,
    { IMAGE_APP_ROOT: fixture.app.root + path.sep }, fixture.app.ref, trailingMarker);
  assert.equal(sameRootWithTrailingSlash.status, 0, sameRootWithTrailingSlash.stderr || sameRootWithTrailingSlash.stdout);
  assert.equal(fs.readFileSync(trailingMarker, 'utf8'), 'dispatched\n');
  const wrongMarker = fixture.markerFor('wrong-ref');
  const wrongRef = invokeRunner(fixture, fixture.app.root, {}, 'c'.repeat(40), wrongMarker);
  assert.notEqual(wrongRef.status, 0);
  assert.equal(fs.existsSync(wrongMarker), false);
  const foreignMarker = fixture.markerFor('foreign-root');
  const foreign = invokeRunner(fixture, path.join(fixture.scratch, 'foreign-root'), {}, fixture.app.ref, foreignMarker);
  assert.notEqual(foreign.status, 0);
  assert.equal(fs.existsSync(foreignMarker), false);
  if (process.platform !== 'win32') {
    const linked = path.join(fixture.scratch, 'app-link');
    fs.symlinkSync(fixture.app.root, linked, 'dir');
    const symlinkMarker = fixture.markerFor('symlink-root');
    const symlink = invokeRunner(fixture, linked, {}, fixture.app.ref, symlinkMarker);
    assert.notEqual(symlink.status, 0);
    assert.equal(fs.existsSync(symlinkMarker), false);
  }
  const ambientMarker = fixture.markerFor('ambient-selector');
  const ambient = invokeRunner(fixture, fixture.app.root,
    { IMAGE_APP_ROOT: path.join(fixture.scratch, 'foreign-selector') }, fixture.app.ref, ambientMarker);
  assert.notEqual(ambient.status, 0);
  assert.equal(fs.existsSync(ambientMarker), false);
  fs.writeFileSync(path.join(fixture.app.root, 'shell/main.cjs'), 'dirty\n');
  const dirtyMarker = fixture.markerFor('dirty');
  const dirty = invokeRunner(fixture, fixture.app.root, {}, fixture.app.ref, dirtyMarker);
  assert.notEqual(dirty.status, 0);
  assert.equal(fs.existsSync(dirtyMarker), false);
});


test('refused child diagnostics preserve stdout and stderr without a success marker', () => {
  const fixture = boundaryFixture();
  const result = invokeRunner(fixture, fixture.app.root,
    { TASK_ASSIGNMENT_UNEXPECTED_STDERR: 'fixture: unexpected child failure' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /STRICT EVIDENCE: tests\/task-assignment-authority.test.js/);
  assert.match(result.stderr, /fixture: unexpected child failure/);
  assert.match(result.stderr, /child stderr contains an unknown warning or error/);
  assert.doesNotMatch(result.stdout, /TASK ASSIGNMENT PAIRED:/);
});


test('paired diagnostics accept exact owner-host closure rows and refuse altered envelopes', () => {
  const row = { event: 'owner-host-session-retired', reason: 'owner-host-closed',
    sessionId: 'fixture-session', atMs: 1700000000000 };
  const notice = JSON.stringify(row) + '\n';
  assert.equal(parseTaskAssignmentSourceTranscript(transcript(), notice, binding).passed, 4);
  const fixture = boundaryFixture();
  const accepted = invokeRunner(fixture, fixture.app.root, { TASK_ASSIGNMENT_UNEXPECTED_STDERR: notice.trim() });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /owner-host-session-retired/);
  assert.match(accepted.stdout, /TASK ASSIGNMENT PAIRED:/);
  for (const malformed of [
    { ...row, reason: 'authorize' }, { ...row, event: 'owner-host-error' },
    { ...row, atMs: '1700000000000' }, { ...row, sessionId: '' }, { ...row, error: 'lost data' },
  ]) {
    assert.throws(() => parseTaskAssignmentSourceTranscript(transcript(), JSON.stringify(malformed), binding),
      { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  }
});


test('retention diagnostics must belong to the declared fixture root', () => {
  const fixture = boundaryFixture();
  const foreignRoot = path.dirname(fixture.scratch);
  const refused = invokeRunner(fixture, fixture.app.root, { TASK_ASSIGNMENT_RETAINED_NOTICE: foreignRoot });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /foreign retention path/);
  assert.doesNotMatch(refused.stdout, /TASK ASSIGNMENT PAIRED:/);
  const notice = 'Isolated test state retained by request: ' + foreignRoot + '\n';
  assert.throws(() => parseTaskAssignmentSourceTranscript(transcript(), notice,
    { ...binding, retainedFixtureRoot: fixture.scratch }), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  assert.throws(() => parseTaskAssignmentSourceTranscript(transcript(), notice, binding),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
});

test('assignment retention uses the actual Linux and Windows producer and requires all four leaf directories', () => {
  const contractSource = fs.readFileSync(path.join(APP, STATE_CONTRACT), 'utf8');
  const driverSource = fs.readFileSync(DRIVER, 'utf8');
  for (const platform of ['linux', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const home = platform === 'win32' ? WINDOWS_ACCOUNT_HOME : '/home/fixture';
    const fixture = paths.join(home, 'te-source-fixture-abc123');
    const probes = [];
    let missingLeaf = null;
    const fakeFs = { lstatSync(file) {
      probes.push(file);
      if (paths.basename(file) === missingLeaf) throw new Error('fixture missing fourth leaf directory');
      return { isDirectory: () => true, isSymbolicLink: () => false, birthtimeMs: 1100, uid: 1234 };
    }, realpathSync: { native(file) { probes.push(file); return file; } } };
    const fakeOs = { userInfo: () => ({ homedir: home }), homedir: () => home, tmpdir: () => fixture };
    const processView = { platform, env: {}, getuid: () => 1234, stderr: { write() { assert.fail('unexpected fallback'); } } };
    const load = name => ({ 'node:fs': fakeFs, 'node:path': paths, 'node:os': fakeOs }[name] || builtinRequire(name));
    const environment = { module: { exports: {} }, require: load, process: processView };
    vm.runInNewContext(environmentSource, environment, { filename: ENVIRONMENT_HELPER });
    const isolatedTemporaryRoot = environment.module.exports.isolatedTemporaryRoot;
    const producer = { module: { exports: {} }, isolatedTemporaryRoot, process: processView, os: fakeOs, Buffer };
    vm.runInNewContext(scratchProducerSource + '\nmodule.exports = scratchBase;', producer);
    const base = producer.module.exports();
    const shared = { module: { exports: {} }, require: load, process: processView, Buffer, Date: { now: () => 1200 } };
    vm.runInNewContext(contractSource, shared, { filename: STATE_CONTRACT });
    const contractApi = shared.module.exports;
    assert.equal(contractApi.engineStateBase(fixture, isolatedTemporaryRoot), base);
    const consumer = { module: { exports: {} }, process: processView, Buffer,
      require: name => name === './settings-source-paired.cjs' ? contractApi : load(name) };
    vm.runInNewContext(driverSource, consumer, { filename: DRIVER });
    const state = paths.join(base, 'te-AbCdEf');
    const notice = target => 'Isolated test state retained by request: ' + target + '\n';
    const close = JSON.stringify({ event: 'owner-host-session-retired', reason: 'owner-host-closed', sessionId: 'fixture', atMs: 1700000000000 });
    const contract = { base, startedAtMs: 1000, leafCount: 4 };
    const read = stderr => consumer.module.exports.retainedStateStderr(stderr, contract, contractApi.retainedStateStderr);
    const stderr = notice(state) + close + '\n';
    assert.equal(read(stderr).root, state);
    assert.equal(read(stderr).stderr, stderr);
    for (const leaf of ['001', '002', '003', '004']) assert.ok(probes.includes(paths.join(state, leaf)));
    missingLeaf = '004';
    assert.throws(() => read(notice(state)), /missing fourth leaf directory/);
    missingLeaf = null;
    probes.length = 0;
    assert.throws(() => read(notice(paths.join(home, 'foreign-state', 'te-AbCdEf'))), /foreign retention path/);
    assert.deepEqual(probes, [], 'foreign retention must refuse before filesystem access');
    assert.throws(() => read(notice(state) + close.replace('owner-host-closed', 'authorize')), /unknown warning or error/);
    assert.deepEqual(probes, [], 'unknown diagnostics must not trigger state-directory probing');
  }
});

test('full assignment driver preflights foreign Windows allocator and producer identities before filesystem work', async () => {
  const driverSource = fs.readFileSync(DRIVER, 'utf8');
  const contractSource = fs.readFileSync(path.join(APP, STATE_CONTRACT), 'utf8');
  const allowed = WINDOWS_ACCOUNT_HOME;
  for (const homes of [{ owner: 'D:\\foreign-account', producer: allowed }, { owner: allowed, producer: 'D:\\foreign-account' }]) {
    const observed = { filesystem: 0, fixtureImports: 0, children: 0, stderr: [] };
    const noFilesystem = new Proxy({}, { get() { observed.filesystem++; throw new Error('premature filesystem probe'); } });
    const processView = { platform: 'win32', env: { TOOLSENABLED_TEST_STRICT: '1' },
      argv: ['node', DRIVER, '--app', 'C:\\source-app', '--engine', 'C:\\source-engine', '--app-ref', 'a'.repeat(40), '--engine-ref', 'b'.repeat(40)],
      stderr: { write(value) { observed.stderr.push(value); } }, exitCode: 0 };
    const load = name => {
      if (name === 'node:fs') return noFilesystem;
      if (name === 'node:path') return path.win32;
      if (name === 'node:os') return { userInfo: () => ({ homedir: homes.owner }), homedir: () => homes.producer };
      if (name === 'node:child_process') return { spawnSync() { observed.children++; throw new Error('premature child'); } };
      return builtinRequire(name);
    };
    const shared = { module: { exports: {} }, require: load, process: processView, Buffer };
    vm.runInNewContext(contractSource, shared, { filename: STATE_CONTRACT });
    const module = { exports: {} };
    const driverRequire = name => name === './settings-source-paired.cjs' ? shared.module.exports : load(name);
    driverRequire.main = module;
    const context = { module, require: driverRequire, process: processView, Buffer };
    vm.runInNewContext(driverSource + '\n;globalThis.SETTLED = Promise.resolve().then(() => Promise.resolve());', context, {
      filename: DRIVER, importModuleDynamically() { observed.fixtureImports++; throw new Error('premature fixture import'); },
    });
    await context.SETTLED;
    assert.equal(processView.exitCode, 1);
    assert.match(observed.stderr.join(''), /BuildAccount-Dev profile/);
    assert.equal(observed.filesystem, 0);
    assert.equal(observed.fixtureImports, 0);
    assert.equal(observed.children, 0);
  }
});
