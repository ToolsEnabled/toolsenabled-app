import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { digestRecord, measureFile } from '../lib/adapters/artifact-files.mjs';
import { parseLinuxDpkgStatus, readLinuxInstalledState, assertLinuxInstalledState } from '../lib/guest/linux-installed-state.mjs';
import { readLinuxLifecycleEvidence, LINUX_EVIDENCE_MAX_AGE_MS } from '../lib/drivers/linux-lifecycle-evidence.mjs';
import { getLinuxInstalledLifecycleAdapter, linuxInstalledLifecycleScenarioCensus, linuxInstalledLifecycleImplementationIdentity,
  LINUX_INSTALLED_LIFECYCLE_REQUIREMENTS as REQUIREMENTS } from '../lib/adapters/linux-installed-lifecycle.mjs';

if (process.platform !== 'linux') throw new Error('This suite requires native Linux; Windows qualification is not tested here.');
const hash = text => createHash('sha256').update(text).digest('hex');
const identity = text => ({ bytes: Buffer.byteLength(text), sha256: hash(text) });
const status = 'Package: toolsenabled\nStatus: install ok installed\nArchitecture: amd64\nVersion: 1.0.49\nDescription: Test fixture\n continuation\n';
const roots = [];
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-lifecycle-primitives-'));
  fs.chmodSync(root, 0o700); roots.push(root); return root;
}
function write(root, name, bytes, mode = 0o600) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode); return file;
}
function rootfs(text = status) {
  const root = fixtureRoot();
  write(root, 'var/lib/dpkg/status', text);
  fs.mkdirSync(path.join(root, 'var/lib/dpkg/updates'));
  return root;
}
function installedFixture() {
  const files = { toolsenabled: identity('fixture ELF placeholder'),
    'resources/app.asar': identity('fixture ASAR placeholder'),
    'resources/capability/PAYLOAD.json': identity('fixture payload placeholder') };
  const desktopText = '[Desktop Entry]\nName=ToolsEnabled\nExec=/opt/ToolsEnabled/toolsenabled %U\nType=Application\n';
  const state = { schema: 'toolsenabled.linux-installed-state', schemaVersion: 1, state: 'installed',
    package: parseLinuxDpkgStatus(status), pendingDpkgUpdates: 0, observedAt: new Date().toISOString(),
    files, stageSha256: digestRecord(files),
    runtimeSha256: digestRecord({ toolsenabled: files.toolsenabled }),
    permissions: [
      ...['.', './resources', './resources/capability'].map(name => ({ path: name, kind: 'directory', uid: 0, gid: 0, mode: 0o755 })),
      ...Object.keys(files).map(name => ({ path: './' + name, kind: 'file', uid: 0, gid: 0, mode: name === 'toolsenabled' ? 0o755 : 0o644 }))],
    desktop: { ...identity(desktopText), text: desktopText, uid: 0, gid: 0, mode: 0o644 } };
  const subject = { product: 'toolsenabled', target: { platform: 'linux', arch: 'x64' },
    artifact: identity('explicitly synthetic deb fixture'), sourceRefs: { app: '1'.repeat(40), engine: '2'.repeat(40) },
    sourceSha256: hash('source fixture'), stageSha256: state.stageSha256, runtimeSha256: state.runtimeSha256 };
  return { state, subject };
}

test('dpkg records distinguish absent, installed, removed and unknown', () => {
  assert.equal(parseLinuxDpkgStatus('').state, 'absent');
  assert.equal(parseLinuxDpkgStatus('Package: another\nStatus: install ok installed\n').state, 'absent');
  assert.equal(parseLinuxDpkgStatus(status).state, 'installed');
  assert.equal(parseLinuxDpkgStatus(status.replace('install ok installed', 'hold ok installed')).state, 'installed');
  for (const value of ['install ok unpacked', 'install reinstreq half-installed']) {
    assert.equal(parseLinuxDpkgStatus(status.replace('install ok installed', value)).state, 'unknown');
  }
  assert.equal(parseLinuxDpkgStatus(status.replace('install ok installed', 'deinstall ok config-files')).state, 'removed');
  assert.equal(parseLinuxDpkgStatus(status.replace('amd64', 'arm64')).state, 'unknown');
  for (const text of [status + '\n' + status, status + 'STATUS: install ok installed\n', ' orphan\n', 'bad', '\0', 'Version: 2\n']) assert.throws(() => parseLinuxDpkgStatus(text));
});

test('native filesystem read distinguishes absent, unowned remnants and pending dpkg transactions', () => {
  const root = rootfs('');
  assert.equal(readLinuxInstalledState({ root }).state, 'absent');
  write(root, 'opt/ToolsEnabled/leftover', 'not installed');
  assert.equal(readLinuxInstalledState({ root }).state, 'unknown');
  const pending = rootfs('');
  write(pending, 'var/lib/dpkg/updates/0000', 'pending');
  assert.equal(readLinuxInstalledState({ root: pending }).state, 'unknown');
  assert.throws(() => readLinuxInstalledState({ root, package: 'another' }));
  assert.throws(() => readLinuxInstalledState({ root: fixtureRoot() }), { code: 'ENOENT' });
});

test('native read hashes bytes and marks its proof as measurement only', () => {
  const root = rootfs();
  write(root, 'opt/ToolsEnabled/toolsenabled', 'runtime', 0o755);
  write(root, 'opt/ToolsEnabled/resources/app.asar', 'shell');
  write(root, 'opt/ToolsEnabled/resources/capability/PAYLOAD.json', 'payload');
  write(root, 'usr/share/applications/toolsenabled.desktop', '[Desktop Entry]\nExec=/opt/ToolsEnabled/toolsenabled %U\nType=Application\n');
  const first = readLinuxInstalledState({ root });
  assert.equal(first.state, 'installed');
  assert.equal(first.attested, false);
  assert.equal(first.proofScope, 'filesystem-measurement-only');
  write(root, 'opt/ToolsEnabled/toolsenabled', 'changed runtime', 0o755);
  const second = readLinuxInstalledState({ root });
  assert.notEqual(first.runtimeSha256, second.runtimeSha256);
  assert.notEqual(first.stageSha256, second.stageSha256);
  fs.renameSync(path.join(root, 'opt/ToolsEnabled/toolsenabled'), path.join(root, 'archived-runtime'));
  fs.symlinkSync(path.join(root, 'archived-runtime'), path.join(root, 'opt/ToolsEnabled/toolsenabled'));
  assert.throws(() => readLinuxInstalledState({ root }), /linked/);
});

test('structural installed fixture matches exact payload, never attests execution', () => {
  const { state, subject } = installedFixture();
  assert.equal(assertLinuxInstalledState(state, subject).proofScope, 'filesystem-measurement-only');
});

const installedMutations = {
  'unknown installation': x => { x.state.state = 'unknown'; },
  'wrong package': x => { x.state.package.package = 'another'; },
  'pending dpkg transaction': x => { x.state.pendingDpkgUpdates = 1; },
  'runtime mutation': x => { x.state.files.toolsenabled = identity('mutated'); },
  'subject mutation': x => { x.subject.stageSha256 = hash('different'); },
  'runtime binding': x => { x.subject.runtimeSha256 = hash('different runtime'); },
  'missing payload': x => { delete x.state.files['resources/app.asar']; },
  'wrong target': x => { x.subject.target.platform = 'win32'; },
  'writable directory': x => { x.state.permissions[0].mode = 0o777; },
  'unowned runtime': x => { x.state.permissions[0].uid = 123; },
  'incomplete permissions': x => { x.state.permissions.pop(); },
  'duplicate permissions': x => { x.state.permissions.push(x.state.permissions[0]); },
  'desktop redirect': x => { x.state.desktop.text = x.state.desktop.text.replace('/opt/ToolsEnabled/toolsenabled', '/bin/true'); },
  'desktop bytes': x => { x.state.desktop.sha256 = hash('wrong'); },
};
for (const [name, mutate] of Object.entries(installedMutations)) test('installed-state rejects ' + name, () => {
  const fixture = installedFixture(); mutate(fixture);
  assert.throws(() => assertLinuxInstalledState(fixture.state, fixture.subject));
});

function evidenceFixture() {
  const root = fixtureRoot(), { state, subject } = installedFixture();
  subject.context = { evidenceRoot: root };
  const run = { id: randomUUID(), scope: 'full-release-qualification', startedAt: new Date(Date.now() - 2000).toISOString() };
  const required = { id: 'fresh-install', ...structuredClone(REQUIREMENTS['fresh-install']) };
  const implementationSha256 = linuxInstalledLifecycleImplementationIdentity();
  const environment = { platform: 'linux', arch: 'x64', profile: 'linux-x64-standard',
    isolation: 'disposable-machine', isolated: true, runtimeUid: 1000, guestId: randomUUID(), epochId: randomUUID() };
  const record = { schema: 'toolsenabled.linux-lifecycle-execution', schemaVersion: 1, product: subject.product,
    subjectSha256: digestRecord(subject), artifact: subject.artifact, runtimeSha256: subject.runtimeSha256,
    stageSha256: subject.stageSha256, sourceSha256: subject.sourceSha256, sourceRefs: subject.sourceRefs,
    profile: environment.profile, environment, runId: run.id, implementationSha256,
    startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(),
    complete: true, cleanupConfirmed: true, fixture: false,
    cleanup: { guestId: environment.guestId, epochId: environment.epochId, runId: run.id,
      ownedJobsRemaining: 0, baselineRestored: true, evidenceSha256: hash('synthetic cleanup') },
    installedState: state,
    assertions: required.assertions.map(id => ({ id, status: 'passed', evidenceSha256: hash(id) })) };
  const file = write(root, 'report.json', JSON.stringify(record));
  const observation = { id: required.id, scope: required.scope, adapterId: 'linux:fresh-install:v1',
    adapterSha256: implementationSha256, subjectSha256: digestRecord(subject), profile: environment.profile,
    runId: run.id, startedAt: record.startedAt, finishedAt: record.finishedAt,
    observedRuntimeSha256: subject.runtimeSha256, installer: subject.artifact, environment,
    assertions: structuredClone(record.assertions), report: { path: file, ...measureFile(file) } };
  return { root, file, record, observation, subject, run, required, implementationSha256 };
}
function inspect(x, options = {}) {
  return readLinuxLifecycleEvidence(x.observation, x.subject, {
    run: x.run, required: x.required, implementationSha256: x.implementationSha256, ...options,
  });
}
function persist(x) {
  fs.writeFileSync(x.file, JSON.stringify(x.record));
  x.observation.report = { path: x.file, ...measureFile(x.file) };
}

test('independent raw-file reread validates integrity but never grants native authority', async () => {
  const x = evidenceFixture(), result = inspect(x);
  assert.equal(result.qualified, false);
  assert.equal(result.attested, false);
  assert.equal(result.proofScope, 'raw-report-integrity-only');
  assert.equal(result.measurement.sha256, measureFile(x.file).sha256);
  assert.equal(await getLinuxInstalledLifecycleAdapter('fresh-install').verifyExecutionEvidence(x.observation, x.subject), false);
  fs.appendFileSync(x.file, ' ');
  assert.throws(() => inspect(x), /hash or length/);
});

const reportMutations = {
  'artifact identity': x => { x.record.artifact = identity('other deb'); },
  'source pair': x => { x.record.sourceRefs = { app: '3'.repeat(40), engine: '4'.repeat(40) }; },
  'source tree hash': x => { x.record.sourceSha256 = hash('other sources'); },
  'installed runtime': x => { x.record.runtimeSha256 = hash('other runtime'); },
  'wrong profile': x => { x.record.profile = 'linux-x64-install-authorized'; },
  'replayed run': x => { x.record.runId = randomUUID(); },
  'stale report': x => { x.record.startedAt = new Date(Date.parse(x.run.startedAt) - 1).toISOString(); x.observation.startedAt = x.record.startedAt; },
  'stale installed measurement': x => { x.record.installedState.observedAt = new Date(Date.parse(x.run.startedAt) - 1).toISOString(); },
  'future report': x => { x.record.finishedAt = new Date(Date.now() + 60000).toISOString(); x.observation.finishedAt = x.record.finishedAt; },
  'Windows environment': x => { x.record.environment = { ...x.record.environment, platform: 'win32' }; x.observation.environment = x.record.environment; },
  'elevated runtime': x => { x.record.environment = { ...x.record.environment, runtimeUid: 0 }; x.observation.environment = x.record.environment; },
  'absent guest identity': x => { x.record.environment = { ...x.record.environment, guestId: undefined }; x.observation.environment = x.record.environment; },
  'unowned cleanup': x => { x.record.cleanup.guestId = randomUUID(); },
  'remaining jobs': x => { x.record.cleanup.ownedJobsRemaining = 1; },
  'unrestored baseline': x => { x.record.cleanup.baselineRestored = false; },
  'missing assertion': x => { x.record.assertions.pop(); x.observation.assertions = x.record.assertions; },
  'duplicate assertion': x => { x.record.assertions[1] = x.record.assertions[0]; x.observation.assertions = x.record.assertions; },
  'assertion digest changed': x => { x.record.assertions[0].evidenceSha256 = hash('another'); },
  'unknown installed state': x => { x.record.installedState.state = 'unknown'; },
};
for (const [name, mutate] of Object.entries(reportMutations)) test('raw evidence rejects ' + name + ' even after rehash', () => {
  const x = evidenceFixture(); mutate(x); persist(x); assert.throws(() => inspect(x));
});

test('raw evidence rejects stale harness, cancellation, shared files and escaped paths', () => {
  const x = evidenceFixture();
  assert.throws(() => inspect(x, { signal: AbortSignal.abort() }), /cancelled/);
  x.run.startedAt = new Date(Date.now() - LINUX_EVIDENCE_MAX_AGE_MS - 1).toISOString();
  assert.throws(() => inspect(x), /stale harness/);
  x.run.startedAt = new Date(Date.now() - 5000).toISOString();
  fs.chmodSync(x.file, 0o644);
  assert.throws(() => inspect(x), /private/);
  fs.chmodSync(x.file, 0o600);
  fs.chmodSync(x.root, 0o755);
  assert.throws(() => inspect(x), /private/);
  fs.chmodSync(x.root, 0o700);
  const other = evidenceFixture();
  x.observation.report = other.observation.report;
  assert.throws(() => inspect(x), /escapes/);
});

test('seven frozen Linux adapters refuse execution and acceptance without guest proof', async () => {
  const census = linuxInstalledLifecycleScenarioCensus();
  assert.equal(census.length, 7);
  for (const row of census) {
    assert.equal(row.executableScenario, false);
    assert.ok(row.refusal.reason.includes('attested Linux guest'));
    const adapter = getLinuxInstalledLifecycleAdapter(row.id), { subject } = installedFixture();
    assert.ok(Object.isFrozen(adapter));
    assert.deepEqual(adapter.supportedProfiles, ['linux-x64-standard', 'linux-x64-install-authorized']);
    assert.equal(adapter.sha256, linuxInstalledLifecycleImplementationIdentity());
    for (const profile of adapter.supportedProfiles) {
      const input = { required: { id: row.id, ...REQUIREMENTS[row.id], adapter: { id: adapter.id, sha256: adapter.sha256 } },
        profile, subject, subjectSha256: digestRecord(subject), run: { id: randomUUID() } };
      await assert.rejects(adapter.execute(input), { code: 'LINUX_INSTALLED_LIFECYCLE_BLOCKED', reason: 'LINUX_GUEST_UNAVAILABLE' });
      await assert.rejects(adapter.execute({ ...input, profile: 'windows-x64-standard' }), { reason: 'CONTRACT_MISMATCH' });
      await assert.rejects(adapter.execute({ ...input, subjectSha256: hash('other') }), { reason: 'SUBJECT_MISMATCH' });
      assert.equal(await adapter.verifyExecutionEvidence({ complete: true, guest: { attested: true } }, subject), false);
    }
  }
  assert.throws(() => getLinuxInstalledLifecycleAdapter('invented'), { reason: 'UNKNOWN_REQUIREMENT' });
});

test.after(() => {
  // Retain only these bounded private fixture roots; no product or user files
  // are removed. Their paths are printed for operator inspection/cleanup.
  process.stdout.write('Private fixture roots retained: ' + JSON.stringify(roots) + '\n');
});

test('unreadable or aliased inputs never become absence or private evidence', () => {
  const root = rootfs(''), target = fixtureRoot();
  fs.symlinkSync(target, path.join(root, 'opt'));
  assert.throws(() => readLinuxInstalledState({ root }), /linked/);
  const x = evidenceFixture();
  fs.linkSync(x.file, path.join(x.root, 'report-alias.json'));
  assert.throws(() => inspect(x), /singly linked/);
});

test('bounded status and exact subject inputs reject malformed or oversized values', () => {
  assert.throws(() => parseLinuxDpkgStatus(status.replace('Description: Test fixture', 'Description: ' + 'x'.repeat(16 * 1024 * 1024))), { code: 'LINUX_INSTALLED_STATE_BLOCKED' });
  const x = evidenceFixture(); x.subject.target = { platform: 'win32', arch: 'x64' };
  x.observation.subjectSha256 = digestRecord(x.subject);
  x.record.subjectSha256 = x.observation.subjectSha256; persist(x);
  assert.throws(() => inspect(x), { code: 'LINUX_LIFECYCLE_EVIDENCE_BLOCKED' });
});

test('self-consistent payload without product markers remains unknown', () => {
  const { state, subject } = installedFixture();
  delete state.files['resources/app.asar'];
  state.stageSha256 = subject.stageSha256 = digestRecord(state.files);
  state.permissions = state.permissions.filter(row => row.path !== './resources/app.asar');
  assert.throws(() => assertLinuxInstalledState(state, subject), { code: 'LINUX_INSTALLED_STATE_BLOCKED' });
});

test('real dpkg file replacement during read refuses inconsistent snapshots', () => {
  const root = rootfs(''), file = path.join(root, 'var/lib/dpkg/status');
  const open = fs.openSync, close = fs.closeSync; let opens = 0, targetFd;
  fs.openSync = function(name, ...args) {
    const fd = open.call(this, name, ...args);
    if (name === file && args[0] === 'r' && ++opens === 2) targetFd = fd;
    return fd;
  };
  fs.closeSync = function(fd) {
    const change = fd === targetFd; if (change) targetFd = undefined;
    close.call(this, fd);
    if (change) fs.writeFileSync(file, status);
  };
  try { assert.throws(() => readLinuxInstalledState({ root }), { code: 'LINUX_INSTALLED_STATE_BLOCKED' }); }
  finally { fs.openSync = open; fs.closeSync = close; }
});

test('loaded implementation refuses changes to its actual measurement component', async () => {
  const root = fixtureRoot();
  for (const name of ['adapters/linux-installed-lifecycle.mjs', 'adapters/artifact-files.mjs',
    'guest/linux-installed-state.mjs', 'drivers/linux-lifecycle-evidence.mjs']) {
    write(root, name, fs.readFileSync(new URL('../lib/' + name, import.meta.url)));
  }
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(path.join(root, 'adapters/linux-installed-lifecycle.mjs')).href);
  const adapter = module.getLinuxInstalledLifecycleAdapter('fresh-install');
  fs.appendFileSync(path.join(root, 'guest/linux-installed-state.mjs'), '\n// changed measurement component\n');
  assert.notEqual(module.linuxInstalledLifecycleImplementationIdentity(), adapter.sha256);
  await assert.rejects(adapter.execute({}), { reason: 'IMPLEMENTATION_CHANGED' });
});

test('outer observation is independently bound to the installed runtime', () => {
  const x = evidenceFixture(); x.observation.observedRuntimeSha256 = hash('wrong runtime');
  assert.throws(() => inspect(x), { code: 'LINUX_LIFECYCLE_EVIDENCE_BLOCKED' });
});

test('reviewed implementation hash is required even when report fields agree', () => {
  const x = evidenceFixture();
  x.implementationSha256 = x.observation.adapterSha256 = x.record.implementationSha256 = 'invalid';
  persist(x);
  assert.throws(() => inspect(x), { code: 'LINUX_LIFECYCLE_EVIDENCE_BLOCKED' });
});

for (const phase of ['during read', 'after read']) test('real raw report mutation ' + phase + ' refuses inconsistent evidence', () => {
  const x = evidenceFixture(), original = fs.readFileSync(x.file);
  const open = fs.openSync, close = fs.closeSync; let opens = 0;
  const descriptors = new Map();
  fs.openSync = function(name, ...args) {
    const fd = open.call(this, name, ...args);
    if (name === x.file && args[0] === 'r') descriptors.set(fd, ++opens);
    return fd;
  };
  fs.closeSync = function(fd) {
    const number = descriptors.get(fd); descriptors.delete(fd); close.call(this, fd);
    if (phase === 'during read' && number === 1) fs.writeFileSync(x.file, Buffer.concat([original, Buffer.from(' ')]));
    if (phase === 'during read' && number === 2) fs.writeFileSync(x.file, original);
    if (phase === 'after read' && number === 2) fs.writeFileSync(x.file, Buffer.concat([original, Buffer.from(' ')]));
  };
  try { assert.throws(() => inspect(x), { code: 'LINUX_LIFECYCLE_EVIDENCE_BLOCKED' }); }
  finally { fs.openSync = open; fs.closeSync = close; }
});

test('real installed permission change during the snapshot is refused', () => {
  const root = rootfs(), app = path.join(root, 'opt/ToolsEnabled');
  write(root, 'opt/ToolsEnabled/toolsenabled', 'runtime', 0o755);
  write(root, 'usr/share/applications/toolsenabled.desktop', 'desktop');
  const readdir = fs.readdirSync; let visits = 0;
  fs.readdirSync = function(directory, ...args) {
    if (directory === app && ++visits === 6) fs.chmodSync(path.join(app, 'toolsenabled'), 0o644);
    return readdir.call(this, directory, ...args);
  };
  try { assert.throws(() => readLinuxInstalledState({ root }), { code: 'LINUX_INSTALLED_STATE_BLOCKED' }); }
  finally { fs.readdirSync = readdir; }
});
