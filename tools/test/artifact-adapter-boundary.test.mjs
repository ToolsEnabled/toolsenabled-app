import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactImplementationIdentity, executeArtifactIntegrity,
  verifyArtifactIntegrityEvidence } from '../lib/adapters/artifact-subject.mjs';
import { assertReadinessAdaptersAvailable, getReadinessContract, readinessDigest } from '../lib/release-readiness.mjs';

const requirement = () => getReadinessContract('toolsenabled').requirements.find(row => row.id === 'artifact-integrity');
const run = { id: 'b95b77db-20cb-44ae-8c9c-d2e99a77f0ac' };

// These controls stop at the adapter boundary. They do not substitute report
// bytes, a decoder, a source tool or a successful native execution result.
function observedSubject() {
  let accesses = 0;
  const sentinel = new Error('subject measurement boundary reached');
  return {
    subject: { get product() { accesses += 1; throw sentinel; } },
    accesses: () => accesses, sentinel,
  };
}

for (const [label, mutate] of [
  ['installed scope', input => { input.required.scope = 'exact-installer-lifecycle'; }],
  ['missing scope', input => { delete input.required.scope; }],
  ['wrong adapter identity', input => { input.required.adapter.id = 'caller-selected-adapter'; }],
  ['changed adapter implementation', input => { input.required.adapter.sha256 = '0'.repeat(64); }],
]) {
  test(`artifact execution refuses ${label} before subject or native measurement`, async () => {
    const probe = observedSubject();
    const input = { required: structuredClone(requirement()), profile: 'build', subject: probe.subject, run };
    mutate(input);
    await assert.rejects(executeArtifactIntegrity(input), /wrong required scope\/profile|wrong artifact adapter identity/);
    assert.equal(probe.accesses(), 0);
  });
}

test('the registered build descriptor reaches the existing subject measurement boundary', async () => {
  const probe = observedSubject();
  await assert.rejects(executeArtifactIntegrity({ required: requirement(), profile: 'build', subject: probe.subject, run }), error => error === probe.sentinel);
  assert.equal(probe.accesses(), 1);
});

function observedReport() {
  let accesses = 0;
  const sentinel = Object.assign(new Error('report access requires unresolved cleanup'), { cleanupUnconfirmed: true });
  const subject = { product: 'toolsenabled', context: {} };
  const observation = {
    id: requirement().id, scope: requirement().scope, profile: 'build',
    adapterId: requirement().adapter.id, adapterSha256: artifactImplementationIdentity(),
    subjectSha256: readinessDigest(subject), environment: { profile: 'build' },
    get report() { accesses += 1; throw sentinel; },
  };
  return { observation, subject, sentinel, accesses: () => accesses };
}

for (const [label, mutate] of [
  ['wrong requirement', value => { value.id = 'fresh-install'; }],
  ['installed scope', value => { value.scope = 'exact-installer-lifecycle'; }],
  ['installed profile', value => { value.profile = 'windows-x64-standard'; }],
  ['wrong environment profile', value => { value.environment.profile = 'windows-x64-administrator'; }],
  ['missing environment profile', value => { delete value.environment; }],
  ['wrong adapter identity', value => { value.adapterId = 'caller-selected-adapter'; }],
  ['changed adapter implementation', value => { value.adapterSha256 = '0'.repeat(64); }],
  ['different subject binding', value => { value.subjectSha256 = '0'.repeat(64); }],
]) {
  test(`artifact verifier refuses ${label} before reading submitted evidence`, async () => {
    const probe = observedReport();
    mutate(probe.observation);
    assert.equal(await verifyArtifactIntegrityEvidence(probe.observation, probe.subject), false);
    assert.equal(probe.accesses(), 0);
  });
}

test('valid artifact labels still reach report verification and preserve cleanup uncertainty', async () => {
  const probe = observedReport();
  await assert.rejects(verifyArtifactIntegrityEvidence(probe.observation, probe.subject), error => error === probe.sentinel && error.cleanupUnconfirmed === true);
  assert.equal(probe.accesses(), 1);
});

test('cancelled artifact verification does not read submitted evidence', async () => {
  const probe = observedReport();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await verifyArtifactIntegrityEvidence(probe.observation, probe.subject, { signal: controller.signal }), false);
  assert.equal(probe.accesses(), 0);
});

test('artifact hardening preserves fixed build registration beside the installed adapter registration', () => {
  assert.equal(requirement().adapter.sha256, artifactImplementationIdentity());
  // Registering the seven installed adapters generalised the profile guard in
  // release-readiness.mjs. The artifact row must stay build-only through it:
  // an exact-packaged-artifact check never observes an installed machine.
  assert.deepEqual(requirement().profiles, ['build']);
  assert.equal(requirement().adapter.proofScope, 'exact-packaged-artifact');
  assert.equal(assertReadinessAdaptersAvailable('toolsenabled').requirements.every(row => row.adapter), true,
    'mutation `leave an installed row unregistered again` survived: expected every row to name an executor');
});
