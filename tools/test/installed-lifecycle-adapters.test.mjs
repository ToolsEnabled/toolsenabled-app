import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { assertContractAdaptersAvailable, assertReadinessAdaptersAvailable, executeReadinessContract,
  getReadinessContract, readinessDigest } from '../lib/release-readiness.mjs';
import { getInstalledLifecycleAdapter, installedLifecycleImplementationIdentity, installedLifecycleScenarioCensus,
  INSTALLED_LIFECYCLE_IDS, INSTALLED_LIFECYCLE_PROFILES, INSTALLED_LIFECYCLE_REQUIREMENTS } from '../lib/adapters/installed-lifecycle.mjs';

// Before these adapters existed, assertReadinessAdaptersAvailable('toolsenabled')
// threw on every platform and the Windows cutter could not start a cut at all.
// Registration is the thing under test here; it is not a claim that any row
// passes. The refusal tests below are the other half and matter just as much.
const IDS = ['fresh-install', 'durable-critical-journey', 'upgrade', 'uninstall-reinstall',
  'privilege-isolation-recovery', 'advertised-integrations', 'update-delivery'];
const EXECUTABLE = ['fresh-install', 'durable-critical-journey', 'upgrade', 'uninstall-reinstall', 'privilege-isolation-recovery'];
const WITHOUT_SCENARIO = ['advertised-integrations', 'update-delivery'];
const PROFILES = ['windows-x64-standard', 'windows-x64-administrator'];
const TEST_TEMP = ownedFixtureTempRoot();
const HASH = 'a'.repeat(64);
const subject = () => ({ product: 'toolsenabled', artifact: { sha256: HASH, bytes: 7 }, runtimeSha256: HASH, shellSha256: HASH,
  context: { evidenceRoot: TEST_TEMP } });
const row = id => getReadinessContract('toolsenabled').requirements.find(item => item.id === id);
function invocation(id, overrides = {}) {
  const required = row(id), value = subject();
  return { required, profile: PROFILES[0], subject: value, subjectSha256: readinessDigest(value), run: { id: '3f2b6d1e-8d2a-4d0e-9d0e-1f2a3b4c5d6e' },
    context: { evidenceRoot: TEST_TEMP, harnessRoot: TEST_TEMP, sourceRoots: { app: TEST_TEMP, engine: TEST_TEMP } }, ...overrides };
}

test('every installed requirement of the ToolsEnabled contract is registered with both runtime profiles', () => {
  assert.deepEqual([...INSTALLED_LIFECYCLE_IDS].sort(), [...IDS].sort());
  const contract = assertReadinessAdaptersAvailable('toolsenabled');
  for (const id of IDS) {
    const required = contract.requirements.find(item => item.id === id);
    assert.ok(required, `mutation \`drop ${id} from the contract\` survived: expected the row to exist`);
    assert.deepEqual(required.profiles, PROFILES,
      `mutation \`qualify ${id} on one privilege level only\` survived: expected both Windows runtime profiles`);
    assert.equal(required.adapter.id, `${id}:v1`);
    assert.equal(required.adapter.execution, 'real');
    assert.equal(required.adapter.proofScope, INSTALLED_LIFECYCLE_REQUIREMENTS[id].scope);
    assert.equal(required.adapter.sha256, installedLifecycleImplementationIdentity(),
      `mutation \`register ${id} against a stale implementation digest\` survived: expected the measured closure`);
    assert.deepEqual(Object.keys(INSTALLED_LIFECYCLE_REQUIREMENTS[id].assertions), required.assertions,
      `mutation \`let ${id} answer a different assertion set\` survived: expected exactly the contract's assertions`);
    assert.equal(Object.hasOwn(required, 'unavailableReason'), false);
  }
  assert.equal(contract.requirements.some(item => !item.adapter), false,
    'mutation `leave one contract row without an executor` survived: expected every row to name one');
});

test('the installed adapters are registered for ToolsEnabled only, not for every product sharing the row id', () => {
  // These row ids are shared by all four desktop contracts, but the adapters
  // measure and drive the ToolsEnabled subject and refuse any other
  // subject.product. A standalone product must keep reading as unimplemented.
  for (const product of ['scribe', 'web-editor', 'presentation-suite']) {
    const rows = getReadinessContract(product).requirements.filter(item => INSTALLED_LIFECYCLE_IDS.includes(item.id));
    assert.ok(rows.length, product);
    for (const item of rows) {
      assert.equal(item.adapter, null,
        `mutation \`register the ToolsEnabled executor on ${product}/${item.id}\` survived: expected no adapter`);
      assert.match(item.unavailableReason, /qualifies the ToolsEnabled desktop subject only/, `${product}/${item.id}`);
    }
    assert.throws(() => assertReadinessAdaptersAvailable(product), /required qualification adapters are unavailable/,
      `mutation \`let ${product} inherit the ToolsEnabled executors\` survived: expected the unavailable-adapter refusal`);
  }
});

test('an unregistered or wrongly scoped adapter still refuses; the gate was registered past, not removed', async () => {
  const synthetic = { schemaVersion: 1, product: 'toolsenabled', target: { platform: 'win32', arch: 'x64' },
    subjectMeasurer: { id: 'artifact-subject:v1', sha256: HASH },
    requirements: [{ id: 'fresh-install', scope: 'exact-installer-lifecycle', profiles: PROFILES, assertions: ['exact-installer-executed'], adapter: null }] };
  assert.throws(() => assertContractAdaptersAvailable(synthetic), error => {
    assert.equal(error.code, 'RELEASE_READINESS_BLOCKED');
    assert.match(error.message, /required qualification adapters are unavailable \(fresh-install\)/);
    return true;
  }, 'mutation `accept a row whose adapter is null` survived: expected the unavailable-adapter refusal');
  const named = { ...synthetic, requirements: [{ ...synthetic.requirements[0],
    adapter: { id: 'nobody-wrote-this:v1', sha256: HASH, proofScope: 'exact-installer-lifecycle', execution: 'real' } }] };
  await assert.rejects(() => executeReadinessContract({ contract: named, adapters: new Map(), measurers: new Map(), artifactPath: 'x', sourceRefs: {} }),
    /no trusted executor and execution-evidence verifier are registered for fresh-install/,
    'mutation `trust a contract row that names an adapter nothing implements` survived: expected the executor refusal');
  // A build-profile adapter must not be able to stand in for an installed row.
  const buildOnly = new Map([['nobody-wrote-this:v1', { id: 'nobody-wrote-this:v1', sha256: HASH, proofScope: 'exact-installer-lifecycle',
    execution: 'real', supportedProfiles: Object.freeze(['build']), execute() {}, verifyExecutionEvidence() {} }]]);
  await assert.rejects(() => executeReadinessContract({ contract: named, adapters: buildOnly, measurers: new Map(), artifactPath: 'x', sourceRefs: {} }),
    /registered adapter cannot satisfy the exact required scope\/profile for fresh-install/,
    'mutation `let a build-scope adapter answer an installed row` survived: expected the profile refusal');
});

test('adapters are frozen, name a frozen profile descriptor and expose an executor and verifier', () => {
  for (const id of IDS) {
    const adapter = getInstalledLifecycleAdapter(id);
    assert.equal(Object.isFrozen(adapter), true, `mutation \`leave ${id} mutable\` survived: expected a frozen adapter`);
    assert.equal(adapter.supportedProfiles, INSTALLED_LIFECYCLE_PROFILES);
    assert.equal(Object.isFrozen(adapter.supportedProfiles), true);
    assert.deepEqual([...adapter.supportedProfiles], PROFILES);
    assert.equal(typeof adapter.execute, 'function');
    assert.equal(typeof adapter.verifyExecutionEvidence, 'function');
  }
  assert.throws(() => getInstalledLifecycleAdapter('source:app'), /unknown installed lifecycle requirement/);
  assert.equal(new Set(IDS.map(id => getInstalledLifecycleAdapter(id).id)).size, IDS.length);
});

test('the scenario census is explicit: five rows execute the lifecycle driver, two are named refusals', () => {
  assert.deepEqual(IDS.filter(id => getInstalledLifecycleAdapter(id).executableScenario), EXECUTABLE);
  const census = installedLifecycleScenarioCensus();
  assert.deepEqual(census.map(item => item.id), INSTALLED_LIFECYCLE_IDS);
  for (const item of census) {
    const selectors = Object.values(INSTALLED_LIFECYCLE_REQUIREMENTS[item.id].assertions);
    assert.equal(selectors.every(select => typeof select === 'function'), item.executableScenario, item.id);
    if (item.executableScenario) { assert.equal(Object.hasOwn(item, 'refusal'), false, item.id); continue; }
    // A reason nobody can act on is the failure mode this row exists to avoid.
    assert.ok(item.refusal.reason.length > 120, `mutation \`shorten ${item.id} to a bare "unavailable"\` survived: expected the measured reason`);
    assert.ok(item.refusal.remedy.length > 120, `mutation \`drop the remedy for ${item.id}\` survived: expected what a person can do about it`);
  }
  assert.deepEqual(census.filter(item => !item.executableScenario).map(item => item.id), WITHOUT_SCENARIO);
});

test('execution refuses a wrong requirement, scope, profile or assertion set before reading the subject', async () => {
  const adapter = getInstalledLifecycleAdapter('fresh-install');
  for (const [label, required, profile] of [
    ['requirement', { ...row('upgrade') }, PROFILES[0]],
    ['scope', { ...row('fresh-install'), scope: 'exact-installed-desktop' }, PROFILES[0]],
    ['profile', row('fresh-install'), 'build'],
    ['assertions', { ...row('fresh-install'), assertions: ['exact-installer-executed'] }, PROFILES[1]],
  ]) {
    let accesses = 0;
    const value = {};
    Object.defineProperty(value, 'product', { enumerable: true, get() { accesses += 1; throw new Error('subject read'); } });
    await assert.rejects(() => adapter.execute({ required, profile, subject: value, subjectSha256: HASH, run: { id: 'run' } }),
      error => error.code === 'INSTALLED_LIFECYCLE_BLOCKED' && /contract invocation|assertions differ/.test(error.message));
    assert.equal(accesses, 0, `mutation \`check the ${label} after touching the subject\` survived: expected no subject access`);
  }
});

test('rows without an executable scenario refuse by name, with the remedy, before any guest or installer work', async () => {
  for (const id of WITHOUT_SCENARIO) {
    const adapter = getInstalledLifecycleAdapter(id);
    await assert.rejects(() => adapter.execute(invocation(id)), error => {
      assert.equal(error.code, 'INSTALLED_LIFECYCLE_BLOCKED');
      assert.match(error.message, new RegExp(`no executable scenario produces evidence for ${id}/`));
      assert.ok(error.message.includes(INSTALLED_LIFECYCLE_REQUIREMENTS[id].refusal.remedy),
        `mutation \`refuse ${id} without saying what to build\` survived: expected the remedy in the refusal`);
      assert.equal(error.cleanupUnconfirmed, false);
      return true;
    });
    // The verifier cannot rescue what the executor refuses to produce.
    assert.equal(await adapter.verifyExecutionEvidence({ id, scope: INSTALLED_LIFECYCLE_REQUIREMENTS[id].scope,
      profile: PROFILES[0], environment: { profile: PROFILES[0] }, adapterId: `${id}:v1`,
      adapterSha256: installedLifecycleImplementationIdentity(), subjectSha256: readinessDigest(subject()), runId: 'run' }, subject()), false,
    `mutation \`let ${id} verify evidence it can never execute\` survived: expected false`);
  }
});

test('executable rows never pass off the Windows x64 qualification host', async t => {
  if (process.platform === 'win32' && process.arch === 'x64') { t.skip('the off-platform refusal is exercised on non-Windows runners'); return; }
  for (const id of EXECUTABLE) {
    const adapter = getInstalledLifecycleAdapter(id);
    await assert.rejects(() => adapter.execute(invocation(id)), error => {
      assert.equal(error.code, 'INSTALLED_LIFECYCLE_BLOCKED');
      assert.match(error.message, /execute only on a Windows x64 qualification host/);
      return true;
    }, `mutation \`let ${id} qualify a Windows installer from this host\` survived: expected the host refusal`);
  }
});

test('execution refuses a subject digest mismatch, a foreign product and a wrong adapter identity', async () => {
  const adapter = getInstalledLifecycleAdapter('fresh-install');
  await assert.rejects(() => adapter.execute(invocation('fresh-install', { subjectSha256: HASH })), /only the measured toolsenabled subject/);
  const foreign = { ...subject(), product: 'scribe' };
  await assert.rejects(() => adapter.execute(invocation('fresh-install', { subject: foreign, subjectSha256: readinessDigest(foreign) })), /only the measured toolsenabled subject/);
  await assert.rejects(() => adapter.execute(invocation('fresh-install', { required: { ...row('fresh-install'), adapter: { id: 'fresh-install:v1', sha256: HASH } } })), /wrong adapter identity/);
});

test('evidence verification refuses unbound, foreign or fabricated reports without throwing', async t => {
  const adapter = getInstalledLifecycleAdapter('fresh-install');
  const value = subject();
  const base = { id: 'fresh-install', scope: 'exact-installer-lifecycle', profile: PROFILES[0], environment: { profile: PROFILES[0] },
    adapterId: adapter.id, adapterSha256: adapter.sha256, subjectSha256: readinessDigest(value), runId: 'run' };
  assert.equal(await adapter.verifyExecutionEvidence({ ...base, id: 'upgrade' }, value), false);
  assert.equal(await adapter.verifyExecutionEvidence({ ...base, adapterSha256: HASH }, value), false);
  assert.equal(await adapter.verifyExecutionEvidence({ ...base, report: { path: path.join(TEST_TEMP, 'absent.json'), sha256: HASH, bytes: 1 } }, value), false);
  const root = mkdtempSync(path.join(TEST_TEMP, 'installed-lifecycle-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'report.json');
  const fabricated = { schema: 'toolsenabled.installed-lifecycle-execution', schemaVersion: 1, product: 'toolsenabled', profile: PROFILES[0], runId: 'run',
    subjectSha256: base.subjectSha256, implementationSha256: adapter.sha256, startedAt: 's', finishedAt: 'f',
    driverReport: { schema: 'toolsenabled.artifact-lifecycle-report', schemaVersion: 1, scope: 'exact-installer-lifecycle', fixture: false, complete: true,
      cleanupConfirmed: true, product: 'toolsenabled', profile: PROFILES[0], runId: 'run', subjectSha256: base.subjectSha256, scenarios: [], observations: [],
      inventory: { sha256: HASH } } };
  const bytes = JSON.stringify(fabricated);
  writeFileSync(file, bytes);
  const report = { path: file, bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  const observation = { ...base, report, startedAt: 's', finishedAt: 'f', observedRuntimeSha256: HASH,
    assertions: [{ id: 'exact-installer-executed', status: 'passed', evidenceSha256: HASH }] };
  assert.equal(await adapter.verifyExecutionEvidence(observation, value), false,
    'mutation `accept a report from outside the private evidence root` survived: expected false');
  assert.equal(await adapter.verifyExecutionEvidence(observation, { ...value, context: { evidenceRoot: root } }), false,
    'mutation `accept a driver report with no executed scenario` survived: expected false');
  const controller = new AbortController();
  controller.abort();
  assert.equal(await adapter.verifyExecutionEvidence(observation, { ...value, context: { evidenceRoot: root } }, { signal: controller.signal }), false);
});

test('durable-critical-journey selectors refuse missing identity and keep advertised rows unfinished', () => {
  const select = INSTALLED_LIFECYCLE_REQUIREMENTS['durable-critical-journey'].assertions;
  assert.throws(() => select['installed-ui-starts-shipped-engine']({ scenarios: [] }), /exact toolsenabled/);
  assert.equal(INSTALLED_LIFECYCLE_REQUIREMENTS['advertised-integrations'].driver, null);
  assert.equal(INSTALLED_LIFECYCLE_REQUIREMENTS['update-delivery'].driver, null);
});

test('advertised-integrations and update-delivery remain named refusals with no selectors', () => {
  for (const id of ['advertised-integrations', 'update-delivery']) {
    const definition = INSTALLED_LIFECYCLE_REQUIREMENTS[id];
    assert.equal(definition.driver, null);
    assert.ok(definition.refusal.reason.length > 120);
    assert.equal(Object.values(definition.assertions).every(select => select === null), true, id);
  }
});
