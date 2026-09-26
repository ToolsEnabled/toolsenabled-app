import assert from 'node:assert/strict';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { executeReadinessContract, getReadinessContract, readinessDigest,
  assertReadinessAdaptersAvailable, assertReadinessAgainstContract, assertReleaseReadiness,
  WINDOWS_READINESS_TARGET, LINUX_READINESS_TARGET } from '../lib/release-readiness.mjs';
import { getSourceSuiteAdapter } from '../lib/adapters/source-suites.mjs';

const SOURCE_IDS = ['app', 'engine', 'scribe', 'shared', 'shell', 'web-editor',
  'presentation-suite', 'reaper', 'loops', 'agents'];
const SOURCE_SCOPE = 'complete-source-suite';
const BUILD = 'build';
const SOURCE_REF = 'a'.repeat(40);
const TEST_TEMP = ownedFixtureTempRoot();

test('native targets instantiate one complete required graph without relabelling Windows implementations', () => {
  const windows = getReadinessContract('toolsenabled', WINDOWS_READINESS_TARGET);
  const linux = getReadinessContract('toolsenabled', LINUX_READINESS_TARGET);
  assert.equal(getReadinessContract('toolsenabled'), windows, 'omitted target preserves the Windows contract');
  assert.deepEqual(linux.target, { platform: 'linux', arch: 'x64' });
  assert.deepEqual(windows.installer, { format: 'nsis', architecture: 'x64' });
  assert.deepEqual(linux.installer, { format: 'deb', architecture: 'amd64' });
  const behavior = contract => contract.requirements.map(({ id, scope, assertions }) => ({ id, scope, assertions }));
  assert.deepEqual(behavior(linux), behavior(windows));
  assert.equal(linux.requirements.length, 10);
  assert.equal(linux.runtimeAccount, 'owning-non-elevated');
  assert.equal(windows.runtimeAccount, 'owning-non-elevated');
  for (const row of linux.requirements) {
    assert.equal(Object.isFrozen(row.profiles), true);
    if (row.id.startsWith('source:') || row.id === 'artifact-integrity') {
      assert.deepEqual(row, windows.requirements.find(item => item.id === row.id));
    } else {
      assert.equal(row.adapter, null, `${row.id} must not claim a Windows implementation`);
      assert.match(row.unavailableReason, /linux\/x64 deb/);
      assert.deepEqual(row.profiles, ['linux-x64-standard', 'linux-x64-install-authorized']);
    }
  }
  assert.deepEqual(linux.subjectMeasurer, windows.subjectMeasurer);
  assert.equal(Object.hasOwn(linux, 'subjectMeasurerUnavailableReason'), false);
  assert.notEqual(readinessDigest(linux), readinessDigest(windows));
  assert.throws(() => assertReadinessAdaptersAvailable('toolsenabled', LINUX_READINESS_TARGET),
    error => error.code === 'RELEASE_READINESS_BLOCKED' && error.details.length === 7);
});

test('Linux artifact registration is limited to the implemented desktop product', () => {
  for (const product of ['scribe', 'web-editor', 'presentation-suite']) {
    const linux = getReadinessContract(product, LINUX_READINESS_TARGET);
    const windows = getReadinessContract(product, WINDOWS_READINESS_TARGET);
    assert.equal(linux.subjectMeasurer, null);
    assert.match(linux.subjectMeasurerUnavailableReason, /no reviewed.*subject measurer/i);
    assert.equal(linux.requirements.find(row => row.id === 'artifact-integrity').adapter, null);
    assert.ok(windows.subjectMeasurer);
    assert.ok(windows.requirements.find(row => row.id === 'artifact-integrity').adapter);
  }
});

test('target selection refuses unsupported architectures and caller-supplied profile policy', () => {
  for (const target of [null, 'linux-x64', {}, { platform: 'linux' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' }, { platform: 'linux', arch: 'x64', profiles: ['build'] },
    { platform: 'linux', arch: 'x64', adapters: [] }]) {
    assert.throws(() => getReadinessContract('toolsenabled', target), { code: 'RELEASE_READINESS_BLOCKED' });
  }
});

// Pure admission protocol fixture. This deliberately uses an unregistered
// product and fixture-only adapter IDs. It is never a production receipt and
// cannot satisfy assertReleaseReadiness or authorize either cutter.
function protocolFixture(target) {
  const contract = structuredClone(getReadinessContract('toolsenabled', target));
  contract.product = 'synthetic-native-admission-protocol';
  contract.subjectMeasurer = { id: 'fixture-subject', sha256: '1'.repeat(64) };
  for (const row of contract.requirements) row.adapter = {
    id: `fixture:${row.id}`, sha256: '2'.repeat(64), proofScope: row.scope, execution: 'real',
  };
  const now = Date.now(), startedAt = new Date(now - 1000).toISOString(), finishedAt = new Date(now).toISOString();
  const artifact = { sha256: '3'.repeat(64), bytes: 100 };
  const sourceRefs = { app: 'a'.repeat(40), engine: 'b'.repeat(40) };
  const subject = { artifact, sourceRefs, target: { ...target }, sourceSha256: '4'.repeat(64),
    stageSha256: '5'.repeat(64), runtimeSha256: '6'.repeat(64), shellSha256: '7'.repeat(64),
    harness: { clean: true, ref: 'c'.repeat(40), sha256: '8'.repeat(64) } };
  const run = { id: '00000000-0000-4000-8000-000000000001', scope: 'full-release-qualification', complete: true, startedAt, finishedAt };
  const receipt = { schema: 'toolsenabled.product-release-readiness', schemaVersion: 1, product: contract.product,
    contractSha256: readinessDigest(contract), ready: true, unmeasured: [], subject, run,
    observations: contract.requirements.flatMap(row => row.profiles.map(profile => ({
      id: row.id, scope: row.scope, profile, adapterId: row.adapter.id, adapterSha256: row.adapter.sha256,
      subjectSha256: readinessDigest(subject), runId: run.id, startedAt, finishedAt,
      execution: { complete: true, exitCode: 0, signal: null, cleanupConfirmed: true,
        synthetic: false, sourceOverlay: false, hostRuntime: false, command: ['fixture-protocol-only'] },
      environment: { ...target, profile, osBuild: 'fixture-protocol-only', isolated: true, isolation: 'disposable-machine' },
      observedRuntimeSha256: subject.runtimeSha256, installer: artifact, report: { sha256: '9'.repeat(64), bytes: 100 },
      counts: { tests: row.assertions.length, passed: row.assertions.length, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 },
      assertions: row.assertions.map(id => ({ id, status: 'passed', evidenceSha256: 'd'.repeat(64) })),
    }))),
  };
  return { contract, receipt, options: { artifact, sourceRefs, now } };
}

for (const target of [WINDOWS_READINESS_TARGET, LINUX_READINESS_TARGET]) {
  test(`shared admission requires the full graph and exact identity for ${target.platform}`, async () => {
    const { contract, receipt, options } = protocolFixture(target);
    assert.equal(assertReadinessAgainstContract(receipt, contract, options), receipt);
    for (const mutate of [
      copy => { copy.observations.pop(); },
      copy => { copy.run.startedAt = new Date(options.now - 25 * 60 * 60 * 1000).toISOString(); },
      copy => { copy.subject.target.platform = target.platform === 'linux' ? 'win32' : 'linux'; },
      copy => { copy.subject.sourceRefs.engine = 'e'.repeat(40); },
      copy => { copy.subject.artifact.sha256 = 'f'.repeat(64); },
      copy => { copy.observations.at(-1).environment.platform = 'other'; },
      copy => { copy.observations.at(-1).counts.failed = 1; },
      copy => { copy.observations.at(-1).execution.cleanupConfirmed = false; },
    ]) {
      const copy = structuredClone(receipt); mutate(copy);
      assert.throws(() => assertReadinessAgainstContract(copy, contract, options), { code: 'RELEASE_READINESS_BLOCKED' });
    }
    await assert.rejects(assertReleaseReadiness(receipt, { product: contract.product, target, ...options }), /unknown product/);
  });
}

function sourceRequirement() {
  const row = getReadinessContract('toolsenabled').requirements.find(item => item.id === 'source:app');
  assert.ok(row, 'the fixed ToolsEnabled contract must retain the app source requirement');
  return structuredClone(row);
}

function syntheticSourceContract() {
  return {
    schemaVersion: 1,
    product: 'synthetic-source-profile-check',
    target: { platform: 'linux', arch: process.arch },
    subjectMeasurer: { id: 'synthetic-subject:v1', sha256: 'f'.repeat(64) },
    requirements: [sourceRequirement()],
  };
}

function adapterWithProfiles(supportedProfiles) {
  const base = getSourceSuiteAdapter('app');
  const adapter = { ...base };
  if (supportedProfiles === undefined) delete adapter.supportedProfiles;
  else adapter.supportedProfiles = supportedProfiles;
  return adapter;
}

function orchestrationInput(adapter, contract = syntheticSourceContract()) {
  return {
    contract,
    adapters: new Map([[adapter.id, adapter]]),
    artifactPath: '/tmp/readiness-adapter-profiles-missing-installer.exe',
    sourceRefs: { app: SOURCE_REF },
  };
}

test('all fixed source-suite adapters expose an immutable build-only profile descriptor', () => {
  for (const id of SOURCE_IDS) {
    const adapter = getSourceSuiteAdapter(id);
    assert.deepEqual(adapter.supportedProfiles, [BUILD], id);
    assert.equal(Object.isFrozen(adapter.supportedProfiles), true, `${id} profile list is mutable`);
    assert.equal(Object.isFrozen(adapter), true, `${id} adapter is not frozen`);
  }
});

for (const [label, supportedProfiles] of [
  ['incorrect', Object.freeze(['build', 7])],
  ['missing', undefined],
  ['mutable', ['build']],
  ['sparse', Object.freeze([BUILD, ,])],
  ['unsupported', Object.freeze(['windows-x64-standard'])],
]) {
  test(`the executable registry refuses ${label} source profile descriptors before artifact access`, async () => {
    const adapter = adapterWithProfiles(supportedProfiles);
    await assert.rejects(() => executeReadinessContract(orchestrationInput(adapter)), error => {
      assert.equal(error.code, 'RELEASE_READINESS_BLOCKED');
      assert.match(error.message, /scope|profile|executor/i);
      return true;
    });
  });
}

test('a valid frozen build descriptor reaches the next subject-measurer boundary', async t => {
  const root = mkdtempSync(path.join(TEST_TEMP, 'readiness-adapter-profiles-positive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactPath = path.join(root, 'candidate.exe');
  writeFileSync(artifactPath, 'synthetic artifact boundary');
  const sentinel = new Error('subject measurer boundary reached');
  const adapter = adapterWithProfiles(Object.freeze([BUILD]));
  const input = orchestrationInput(adapter);
  input.artifactPath = artifactPath;
  input.measurers = new Map([['synthetic-subject:v1', {
    sha256: 'f'.repeat(64),
    measure(input) {
      assert.deepEqual(input.target, syntheticSourceContract().target);
      assert.equal(Object.isFrozen(input.target), true);
      throw sentinel;
    },
  }]]);
  await assert.rejects(() => executeReadinessContract(input), error => error === sentinel);
});

test('the executable registry refuses an adapter whose proof scope is not exact', async () => {
  const base = getSourceSuiteAdapter('app');
  const adapter = { ...base, proofScope: 'exact-installed-desktop' };
  await assert.rejects(() => executeReadinessContract(orchestrationInput(adapter)), error => {
    assert.equal(error.code, 'RELEASE_READINESS_BLOCKED');
    assert.match(error.message, /scope|profile|executor/i);
    return true;
  });
});

test('source execution rejects wrong scope and unsupported profile before reading the subject', async () => {
  const adapter = getSourceSuiteAdapter('app');
  for (const [label, required, profile] of [
    ['scope', { id: 'source:app', scope: 'exact-installed-desktop' }, BUILD],
    ['profile', { id: 'source:app', scope: SOURCE_SCOPE }, 'windows-x64-standard'],
  ]) {
    let accesses = 0;
    const sentinel = new Error(`${label} subject access`);
    const subject = {};
    Object.defineProperty(subject, 'product', { enumerable: true, get() { accesses += 1; throw sentinel; } });
    await assert.rejects(() => adapter.execute({ required, profile, subject, subjectSha256: '0'.repeat(64), run: { id: 'run' } }),
      /wrong source contract invocation/);
    assert.equal(accesses, 0, `${label} was checked after subject access`);
  }
});

test('source verification rejects an unsupported profile before reading submitted evidence', async () => {
  const adapter = getSourceSuiteAdapter('app');
  let accesses = 0;
  const observation = {
    id: 'source:app', adapterId: adapter.id, adapterSha256: adapter.sha256,
    scope: SOURCE_SCOPE, profile: 'windows-x64-administrator', runId: 'run', subjectSha256: readinessDigest({}),
    get report() { accesses += 1; throw new Error('submitted report must remain unread'); },
  };
  assert.equal(await adapter.verifyExecutionEvidence(observation, {}), false);
  assert.equal(accesses, 0);
});

test('the production registry registers every installed adapter with both runtime profiles', () => {
  // The guard this replaces required profiles to be exactly ['build'], which
  // was the only reason a correctly scoped installed adapter could not be
  // registered. The replacement must still keep build and installed apart.
  const contract = assertReadinessAdaptersAvailable('toolsenabled');
  const installed = contract.requirements.filter(row => !row.profiles.includes(BUILD));
  assert.equal(installed.length, 7,
    'mutation `move an installed row onto the build profile` survived: expected seven installed rows');
  for (const row of installed) {
    assert.deepEqual(row.profiles, ['windows-x64-standard', 'windows-x64-administrator'], row.id);
    assert.equal(row.adapter.id, `${row.id}:v1`);
    assert.equal(row.adapter.execution, 'real');
    assert.equal(row.adapter.proofScope, row.scope,
      `mutation \`register ${row.id} under a weaker proof scope\` survived: expected the row's own scope`);
  }
});

test('fixed source and artifact requirements retain their build profile and assertion sets', () => {
  const sourceAssertions = ['selection-reconciled', 'required-tests-executed', 'zero-unexplained-skips'];
  for (const product of ['toolsenabled', 'scribe', 'web-editor', 'presentation-suite']) {
    for (const row of getReadinessContract(product).requirements.filter(item => item.id.startsWith('source:'))) {
      const id = row.id.slice('source:'.length);
      assert.deepEqual(row.profiles, [BUILD], `${product}/${id} profile changed`);
      assert.deepEqual(row.assertions, sourceAssertions, `${product}/${id} assertions changed`);
      assert.equal(row.adapter.proofScope, SOURCE_SCOPE, `${product}/${id} scope changed`);
      assert.equal(row.adapter.execution, 'real', `${product}/${id} execution changed`);
      assert.equal(row.adapter.sha256, getSourceSuiteAdapter(id).sha256, `${product}/${id} adapter identity changed`);
    }
  }
  const artifact = getReadinessContract('toolsenabled').requirements.find(item => item.id === 'artifact-integrity');
  assert.deepEqual(artifact.profiles, [BUILD]);
  assert.deepEqual(artifact.assertions, ['source-and-payload-bound', 'runtime-and-dependency-closure', 'privacy-and-license-checks']);
  assert.equal(artifact.adapter.proofScope, 'exact-packaged-artifact');
  assert.equal(artifact.adapter.execution, 'real');
});
