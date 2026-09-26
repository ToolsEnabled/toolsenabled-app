import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SOURCE_PAIRED_DRIVER as DRIVER, SETTINGS_SOURCE_PAIRED_LEAVES as LEAVES,
  SETTINGS_SOURCE_PAIRED_ACTION as ACTION, parseSettingsSourcePairedTranscript,
  planSettingsSourcePairedJob } from '../lib/adapters/settings-source-paired.mjs';
import { SOURCE_COMMAND_ACTIONS, SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs';
import { parseSourceOutput, planSourceSuiteJobs } from '../lib/adapters/source-suites.mjs';
import { reconcileSourceCommands } from '../lib/adapters/source-command-plan.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = process.env.MC_CANONICAL_ROOT;
assert.ok(typeof ENGINE === 'string' && path.isAbsolute(ENGINE), 'the test needs its explicit paired engine root');
const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git';
// Synthetic Windows profile paths, assembled at runtime so the source carries no literal user path.
const WINDOWS_USERS = ['C:', 'Users'].join('\\');
const WINDOWS_BUILD_HOME = WINDOWS_USERS + '\\BuildAccount-Dev';
const PAIR_HELPER = 'tests/lib/settings-source-pair.js';
const FIXTURE_HELPER = 'tools/test/lib/source-fixture-root.mjs';
const ENVIRONMENT_HELPER = 'tests/lib/isolated-environment.js';
const environmentSource = fs.readFileSync(path.join(ENGINE, ENVIRONMENT_HELPER), 'utf8');
const isolatedRunnerSource = fs.readFileSync(path.join(ENGINE, 'tests/run-isolated.js'), 'utf8');
// Exercise the producer implementation at the bound engine, including its
// Windows branch. The rest of that runner is not launched by boundary fixtures.
const scratchProducerSource = isolatedRunnerSource.slice(isolatedRunnerSource.indexOf("const SUITE_ROOT_PREFIX = 'te-';"),
  isolatedRunnerSource.indexOf('function removeIsolatedDirectory('));
assert.ok(scratchProducerSource.includes('function scratchBase()'));
const builtinRequire = createRequire(import.meta.url);
const SELECTORS = ['IMAGE_APP_ROOT', 'TOOLSENABLED_TEST_APP_ROOT', 'T1139_B6_APP_ROOT',
  'IMAGE_ENGINE_ROOT', 'T1630_ENGINE_ROOT', 'TOOLSENABLED_TEST_ENGINE_ROOT', 'MC_CANONICAL_ROOT',
  'TOOLSENABLED_SETTINGS_SOURCE_PAIR'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const syntheticBinding = { root: path.resolve('/tmp/settings-app'), canonicalRoot: path.resolve('/tmp/settings-engine'),
  appRef: 'a'.repeat(40), engineRef: 'b'.repeat(40) };

function transcript({ files = LEAVES, summaryChanges = {} } = {}) {
  const descriptor = { appRoot: syntheticBinding.root, engineRoot: syntheticBinding.canonicalRoot,
    appRef: syntheticBinding.appRef, engineRef: syntheticBinding.engineRef };
  const retainedFixtureRoot = path.resolve('/tmp/te-source-fixture-abcdef');
  const summary = { schema: 'toolsenabled.settings-source-paired.v1', ...descriptor, files,
    childExitCode: 0, skipped: 0, retainedFixtureRoot,
    retainedEngineStateRoot: path.join(process.platform === 'win32'
      ? WINDOWS_BUILD_HOME + '\\AppData\\Local\\Temp' : retainedFixtureRoot, 'te-abcdef'),
    descriptor: { path: path.join(retainedFixtureRoot, 'settings-source-pair.json'), sha256: hash(JSON.stringify(descriptor) + '\n') },
    ...summaryChanges };
  return files.map(file => `STRICT EVIDENCE: ${file} -- reconciled-tap; 18 passed; 0 UNEXECUTED (within-suite skips)\n`).join('')
    + `SETTINGS SOURCE PAIRED: ${JSON.stringify(summary)}\n`;
}

function git(root, args) {
  return execFileSync(GIT, ['-c', 'core.hooksPath=', '-C', root, ...args], { cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
}

function fixtureRepository(scratch, name, files) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root);
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'settings-pair-fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Settings pair fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'inert paired runner boundary fixture']);
  return { root, ref: git(root, ['rev-parse', 'HEAD']).trim() };
}

function fixture({ omitLeaf = false } = {}) {
  // Retained by design. These tiny Git repositories only test the runner
  // boundary; the real settings audit is the separately registered action.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-pair-boundary-'));
  const runner = `const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
${scratchProducerSource}
const retainedStateRoot = fs.mkdtempSync(path.join(scratchBase(), SUITE_ROOT_PREFIX));
fs.mkdirSync(path.join(retainedStateRoot, '001'));
const descriptorPath = process.env.TOOLSENABLED_SETTINGS_SOURCE_PAIR;
const descriptor = JSON.parse(fs.readFileSync(descriptorPath));
fs.writeFileSync(process.env.SETTINGS_PAIR_MARKER, JSON.stringify({descriptorPath, descriptor,
  argv: process.argv.slice(2), app: process.env.IMAGE_APP_ROOT, engine: process.env.MC_CANONICAL_ROOT,
  retained: process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES, temp: process.env.TMPDIR, retainedStateRoot}));
if (process.env.SETTINGS_PAIR_TAMPER === 'descriptor') fs.appendFileSync(descriptorPath, ' ');
if (process.env.SETTINGS_PAIR_TAMPER === 'source') fs.appendFileSync(path.join(descriptor.appRoot, 'shell/product-settings.cjs'), '// drift\\n');
if (process.env.SETTINGS_PAIR_STDERR) console.error(process.env.SETTINGS_PAIR_STDERR);
console.error('Isolated test state retained by request: ' + (process.env.SETTINGS_PAIR_RETAINED_NOTICE || retainedStateRoot));
console.log('STRICT EVIDENCE: tests/settings-rows-inert.test.js -- reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)');
`;
  const engine = fixtureRepository(scratch, 'engine', {
    'tests/run-isolated.js': runner,
    [PAIR_HELPER]: fs.readFileSync(path.join(ENGINE, PAIR_HELPER)),
    [ENVIRONMENT_HELPER]: environmentSource,
    'src/lib/settings-registry.js': 'module.exports = {};\n',
    ...(omitLeaf ? {} : { [LEAVES[0]]: '// inert boundary fixture only\n' }),
  });
  const recordBytes = Buffer.from(JSON.stringify({ path: engine.root, ref: engine.ref }));
  const app = fixtureRepository(scratch, 'app', {
    [DRIVER]: fs.readFileSync(path.join(APP, DRIVER)),
    [FIXTURE_HELPER]: fs.readFileSync(path.join(APP, FIXTURE_HELPER)),
    'shell/product-settings.cjs': "module.exports = { id: 'fleet.tree_width' };\n",
    'shell/tree-slot-policy.mjs': "export const id = 'fleet.tree_depth';\n",
    'private/capability-source.owner.json': recordBytes,
  });
  return { scratch, app, engine, sourceRecord: { bytes: recordBytes.length, sha256: hash(recordBytes) } };
}

function invoke(pair, label, { env: overrides = {}, args, appRoot = pair.app.root, appRef = pair.app.ref,
  engineRoot = pair.engine.root } = {}) {
  const marker = path.join(pair.scratch, label + '.json');
  const env = { ...process.env, TOOLSENABLED_TEST_STRICT: '1', SETTINGS_PAIR_MARKER: marker };
  for (const key of SELECTORS) delete env[key];
  Object.assign(env, overrides);
  const result = spawnSync(process.execPath, [path.join(pair.app.root, DRIVER), ...(args ?? [
    '--app', appRoot, '--engine', engineRoot, '--app-ref', appRef, '--engine-ref', pair.engine.ref])],
  { cwd: pair.app.root, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000 });
  return { ...result, marker };
}

function refused(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(result.marker), false, 'refused binding dispatched a child');
  assert.doesNotMatch(result.stdout, /SETTINGS SOURCE PAIRED:/);
}

test('normal source inventory and actual npm test/orphans chain account the settings leaf once', () => {
  assert.equal(SOURCE_COMMAND_ACTIONS.app.filter(row => row.id === ACTION.id).length, 1);
  assert.deepEqual(SOURCE_COMMAND_ACTIONS.app.find(row => row.id === ACTION.id), ACTION);
  assert.deepEqual(SOURCE_MANIFESTS.engine.inventory.find(row => row.file === PAIR_HELPER), {
    file: PAIR_HELPER, reason: 'Imported pinned app/engine source audit helper; executed by settings-rows-inert.test.js.' });
  assert.equal(SOURCE_MANIFESTS.engine.inventory.find(row => row.file === LEAVES[0]).reason, 'paired-action:' + ACTION.id);
  const selectedFiles = SOURCE_MANIFESTS.engine.inventory.filter(row => !row.reason).map(row => row.file);
  assert.equal(selectedFiles.includes(LEAVES[0]), false, 'generic engine dispatch would duplicate the pair');
  const pair = SOURCE_MANIFESTS.engine.pairedActions.find(row => row.action === ACTION.id);
  assert.deepEqual(pair, { action: ACTION.id, files: LEAVES });
  const actualScripts = JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'))).scripts;
  assert.equal(actualScripts.test, SOURCE_MANIFESTS.engine.aliases.test);
  assert.match(actualScripts.test, /--id orphans-wired-0901 node tests\/run-isolated.js --from tests\/suites\/orphans-wired-0901.txt/);
  const orphanList = fs.readFileSync(path.join(ENGINE, 'tests/suites/orphans-wired-0901.txt'), 'utf8');
  assert.equal(orphanList.split(/\r?\n/).filter(line => line.trim() === LEAVES[0]).length, 1);
  const input = { aliases: SOURCE_MANIFESTS.engine.aliases, selectedFiles,
    coveredCommands: SOURCE_COMMAND_ACTIONS.engine.map(row => row.command),
    contextCommands: SOURCE_COMMAND_ACTIONS.engine,
    readSuiteList: file => fs.readFileSync(path.join(ENGINE, file), 'utf8') };
  const missing = reconcileSourceCommands({ ...input,
    pairedActions: SOURCE_MANIFESTS.engine.pairedActions.filter(row => row.action !== ACTION.id) });
  assert.ok(missing.obligations.some(row => row.id === 'unselected-required-test' && row.file === LEAVES[0]));
  const accounted = reconcileSourceCommands({ ...input, pairedActions: SOURCE_MANIFESTS.engine.pairedActions });
  assert.equal(accounted.obligations.some(row => row.file === LEAVES[0]), false);
  assert.equal(accounted.actions.filter(row => row.command[0] === 'node' && row.command[1] === LEAVES[0]).length, 1);
  const commandInput = { aliases: { 'test:settings-source-paired': 'node ' + DRIVER }, selectedFiles: [], coveredCommands: [ACTION.command] };
  assert.equal(reconcileSourceCommands(commandInput).complete, false);
  assert.equal(reconcileSourceCommands({ ...commandInput, contextCommands: [ACTION] }).complete, true);
});

test('normal source dispatcher plans one pinned action without publishing a parent descriptor', () => {
  const pair = fixture();
  const selection = { id: 'app', root: pair.app.root, canonicalRoot: pair.engine.root,
    files: [], crossFiles: [], commands: [ACTION] };
  const strictInputs = { root: pair.app.root, canonicalRoot: pair.engine.root,
    appRef: pair.app.ref, engineRef: pair.engine.ref, sourceRecord: pair.sourceRecord };
  const jobs = planSourceSuiteJobs(selection, pair.scratch, { strictInputs });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].actionId, ACTION.id);
  assert.deepEqual(jobs[0].args, [path.join(pair.app.root, DRIVER), '--app', pair.app.root,
    '--engine', pair.engine.root, '--app-ref', pair.app.ref, '--engine-ref', pair.engine.ref]);
  assert.equal(jobs[0].env.TOOLSENABLED_SETTINGS_SOURCE_PAIR, undefined);
  assert.throws(() => planSettingsSourcePairedJob(selection, pair.scratch), /measured app\/engine inputs/);
  assert.throws(() => planSettingsSourcePairedJob({ ...selection, root: pair.engine.root }, pair.scratch, strictInputs), /measured app\/engine inputs/);
});

test('paired transcript refuses missing, duplicate, mismatched and altered descriptor evidence', () => {
  const options = { ...ACTION, settingsSourcePairBinding: syntheticBinding };
  assert.equal(parseSourceOutput(transcript(), '', options).passed, 1);
  for (const output of [transcript({ files: [] }), transcript({ files: [...LEAVES, ...LEAVES] }),
    transcript({ summaryChanges: { appRef: 'c'.repeat(40) } }), transcript({ summaryChanges: { descriptor: {} } }),
    transcript({ summaryChanges: { retainedEngineStateRoot: path.resolve('/foreign/te-abcdef') } })]) {
    assert.throws(() => parseSettingsSourcePairedTranscript(output, '', syntheticBinding), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  }
  assert.throws(() => parseSourceOutput(transcript(), '', ACTION), /missing its measured source context/);
  assert.throws(() => parseSettingsSourcePairedTranscript(transcript(), 'unexpected warning\n', syntheticBinding),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
});

test('driver derives a retained descriptor and exact child selection from the explicit pair', () => {
  const pair = fixture();
  const result = invoke(pair, 'valid', { env: { IMAGE_APP_ROOT: pair.app.root + path.sep } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observed = JSON.parse(fs.readFileSync(result.marker));
  assert.deepEqual(observed.descriptor, { appRoot: pair.app.root, engineRoot: pair.engine.root, appRef: pair.app.ref, engineRef: pair.engine.ref });
  assert.equal(observed.app, pair.app.root);
  assert.equal(observed.engine, pair.engine.root);
  assert.equal(observed.retained, '1');
  assert.equal(observed.descriptorPath, path.join(observed.temp, 'settings-source-pair.json'));
  assert.deepEqual(observed.argv, ['--config-integrity', '--timeout-ms', '60000', ...LEAVES]);
  assert.equal(parseSettingsSourcePairedTranscript(result.stdout, result.stderr, {
    root: pair.app.root, canonicalRoot: pair.engine.root, appRef: pair.app.ref, engineRef: pair.engine.ref }).passed, 1);
});

test('missing or foreign root/ref/ambient bindings refuse before any child starts', () => {
  const pair = fixture();
  refused(invoke(pair, 'missing-arguments', { args: [] }), /complete app\/engine path and ref/);
  refused(invoke(pair, 'wrong-ref', { appRef: 'c'.repeat(40) }), /HEAD differs/);
  refused(invoke(pair, 'foreign-app', { appRoot: pair.engine.root }), /distinct|executing paired driver/);
  refused(invoke(pair, 'missing-engine', { engineRoot: path.join(pair.scratch, 'missing') }), /root cannot be resolved/);
  for (const key of SELECTORS) {
    refused(invoke(pair, 'foreign-' + key, { env: { [key]: path.join(pair.scratch, 'foreign-unread') } }),
      /foreign inherited|inherited settings descriptor/);
  }
  const missing = fixture({ omitLeaf: true });
  refused(invoke(missing, 'missing-leaf'), /missing ordinary pinned engine input/);
  git(pair.app.root, ['update-index', '--skip-worktree', 'shell/product-settings.cjs']);
  fs.appendFileSync(path.join(pair.app.root, 'shell/product-settings.cjs'), '// concealed change\n');
  refused(invoke(pair, 'hidden-dirty'), /materialization differs from committed blob/);
});

test('child diagnostics and post-dispatch source or descriptor drift cannot produce success', () => {
  const pair = fixture();
  for (const [label, env, expected] of [
    ['diagnostic', { SETTINGS_PAIR_STDERR: 'fixture warning' }, /unknown warning/],
    ['foreign-notice', { SETTINGS_PAIR_RETAINED_NOTICE: path.join(pair.scratch, 'te-AbCdEf') }, /foreign retention path/],
    ['descriptor', { SETTINGS_PAIR_TAMPER: 'descriptor' }, /descriptor changed/],
    ['source', { SETTINGS_PAIR_TAMPER: 'source' }, /tracked source is dirty/],
  ]) {
    const result = invoke(pair, label, { env });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(result.marker), true, 'the negative must exercise the child boundary');
    assert.match(result.stdout, /STRICT EVIDENCE:/);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stdout, /SETTINGS SOURCE PAIRED:/);
  }
});


test('actual engine Linux and Windows scratch producers satisfy only the bound fresh state contract', () => {
  const driverSource = fs.readFileSync(path.join(APP, DRIVER), 'utf8');
  for (const platform of ['linux', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const home = platform === 'win32' ? WINDOWS_BUILD_HOME : '/home/fixture';
    const fixtureRoot = paths.join(home, 'te-source-fixture-abc123');
    const probes = [];
    let birthtimeMs = 1100;
    const fakeFs = {
      lstatSync(file) { probes.push(file); return { isDirectory: () => true, isSymbolicLink: () => false,
        birthtimeMs, uid: 1234 }; },
      realpathSync: { native(file) { probes.push(file); return file; } },
    };
    const fakeOs = { userInfo: () => ({ homedir: home }), homedir: () => home, tmpdir: () => fixtureRoot };
    const processView = { platform, env: {}, getuid: () => 1234, stderr: { write() { assert.fail('unexpected producer fallback'); } } };
    const requireWith = name => ({ 'node:fs': fakeFs, 'node:path': paths, 'node:os': fakeOs }[name] || builtinRequire(name));
    const environmentContext = { require: requireWith, module: { exports: {} }, process: processView };
    vm.runInNewContext(environmentSource, environmentContext, { filename: ENVIRONMENT_HELPER });
    const isolatedTemporaryRoot = environmentContext.module.exports.isolatedTemporaryRoot;
    const producerContext = { isolatedTemporaryRoot, process: processView, os: fakeOs, Buffer, module: { exports: {} } };
    vm.runInNewContext(scratchProducerSource + '\nmodule.exports = scratchBase;', producerContext,
      { filename: 'actual-engine-scratch-producer.js' });
    const producedBase = producerContext.module.exports();
    const expected = platform === 'win32' ? paths.join(home, 'AppData', 'Local', 'Temp') : fixtureRoot;
    assert.equal(producedBase, expected);
    if (platform === 'win32') assert.notEqual(producedBase, fixtureRoot, 'Windows producer ignores redirected TMPDIR');
    const driverContext = { require: requireWith, module: { exports: {} }, process: processView, Buffer,
      Date: { now: () => 1200 } };
    vm.runInNewContext(driverSource, driverContext, { filename: DRIVER });
    const { engineStateBase, retainedStateStderr } = driverContext.module.exports;
    const base = engineStateBase(fixtureRoot, isolatedTemporaryRoot);
    assert.equal(base, producedBase);
    const root = paths.join(producedBase, 'te-AbCdEf');
    const notice = target => 'Isolated test state retained by request: ' + target + '\n';
    assert.equal(retainedStateStderr(notice(root), { base, startedAtMs: 1000 }).root, root);
    probes.length = 0;
    const foreign = paths.join(home, 'unowned-location', 'te-AbCdEf');
    assert.throws(() => retainedStateStderr(notice(foreign), { base, startedAtMs: 1000 }), /foreign retention path/);
    assert.deepEqual(probes, [], 'a foreign notice must refuse before filesystem access');
    assert.throws(() => retainedStateStderr(notice(base), { base, startedAtMs: 1000 }), /foreign retention path/);
    assert.deepEqual(probes, [], 'the temp base itself is never an owned suite');
    birthtimeMs = 999;
    assert.throws(() => retainedStateStderr(notice(root), { base, startedAtMs: 1000 }), /not created during this invocation/);
    if (platform === 'win32') {
      fakeOs.homedir = () => 'D:\\foreign-account';
      let producerCalls = 0;
      assert.throws(() => engineStateBase(fixtureRoot, () => { producerCalls++; return expected; }), /BuildAccount-Dev profile/);
      assert.equal(producerCalls, 0, 'a foreign profile must refuse before evaluating its producer path');
    }
  }
});


test('full Windows driver refuses foreign allocator or producer homes before any filesystem work', async () => {
  const driverSource = fs.readFileSync(path.join(APP, DRIVER), 'utf8');
  const allowed = WINDOWS_BUILD_HOME;
  for (const scenario of [
    { owner: 'D:\\foreign-account', producer: allowed },
    { owner: allowed, producer: 'D:\\foreign-account' },
    { owner: allowed, producer: allowed, explicit: WINDOWS_USERS + '\\Other-Profile' },
  ]) {
    const observations = { filesystem: 0, fixtureImports: 0, childDispatches: 0, stderr: [] };
    const noFilesystem = new Proxy({}, { get() { observations.filesystem++; throw new Error('filesystem probe before preflight'); } });
    const module = { exports: {} };
    const processView = { platform: 'win32', env: { TOOLSENABLED_TEST_STRICT: '1',
      ...(scenario.explicit ? { TOOLSENABLED_WINDOWS_FIXTURE_PARENT: scenario.explicit } : {}) },
      argv: ['node', DRIVER, '--app', 'C:\\source-app', '--engine', 'C:\\source-engine',
        '--app-ref', 'a'.repeat(40), '--engine-ref', 'b'.repeat(40)],
      stderr: { write(value) { observations.stderr.push(value); } }, exitCode: 0 };
    const load = name => {
      if (name === 'node:fs') return noFilesystem;
      if (name === 'node:path') return path.win32;
      if (name === 'node:os') return { userInfo: () => ({ homedir: scenario.owner }), homedir: () => scenario.producer };
      if (name === 'node:child_process') return { spawnSync() { observations.childDispatches++; throw new Error('child dispatched'); } };
      return builtinRequire(name);
    };
    load.main = module;
    const context = { module, require: load, process: processView, Buffer };
    vm.runInNewContext(driverSource + '\n;globalThis.SETTLED = Promise.resolve().then(() => Promise.resolve());', context, {
      filename: DRIVER, importModuleDynamically() { observations.fixtureImports++; throw new Error('fixture allocator imported'); },
    });
    await context.SETTLED;
    assert.equal(processView.exitCode, 1);
    assert.match(observations.stderr.join(''), /BuildAccount-Dev profile|foreign Windows profile/);
    assert.equal(observations.filesystem, 0);
    assert.equal(observations.fixtureImports, 0);
    assert.equal(observations.childDispatches, 0);
  }
});
