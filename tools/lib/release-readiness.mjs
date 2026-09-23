import fs from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { getSourceSuiteAdapter } from './adapters/source-suites.mjs';
import { artifactImplementationIdentity, executeArtifactIntegrity, measureArtifactSubject,
  verifyArtifactIntegrityEvidence } from './adapters/artifact-subject.mjs';
import { getInstalledLifecycleAdapter, INSTALLED_LIFECYCLE_IDS } from './adapters/installed-lifecycle.mjs';

export const READINESS_SCHEMA = 'toolsenabled.product-release-readiness';
const DIGEST = /^[a-f0-9]{64}$/i;
const REF = /^[a-f0-9]{40}$/i;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VERIFICATION_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_VERIFICATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const VERIFICATION_CLEANUP_TIMEOUT_MS = 30 * 1000;
// Only reviewed executable/report-verifier implementations belong here. A
// policy edit containing an adapter id/hash, or caller-supplied JSON claiming
// execution, is not an implementation and cannot enable production success.
const SOURCE_SUITE_IDS = ['app', 'engine', 'scribe', 'shared', 'shell', 'web-editor',
  'presentation-suite', 'reaper', 'loops', 'agents'];
const ARTIFACT_IMPLEMENTATION_SHA256 = artifactImplementationIdentity();
function assertArtifactImplementation() {
  if (artifactImplementationIdentity() !== ARTIFACT_IMPLEMENTATION_SHA256) fail('artifact implementation changed since registration');
}
const ARTIFACT_ADAPTER = Object.freeze({
  id: 'artifact-integrity:v1', sha256: ARTIFACT_IMPLEMENTATION_SHA256,
  proofScope: 'exact-packaged-artifact', execution: 'real', supportedProfiles: Object.freeze(['build']),
  async execute(input) {
    assertArtifactImplementation();
    if (input.required?.scope !== ARTIFACT_ADAPTER.proofScope || !ARTIFACT_ADAPTER.supportedProfiles.includes(input.profile)) {
      fail('artifact adapter received the wrong required scope/profile');
    }
    const result = await executeArtifactIntegrity(input);
    assertArtifactImplementation();
    return result;
  },
  async verifyExecutionEvidence(observation, subject, options) {
    assertArtifactImplementation();
    if (observation?.scope !== ARTIFACT_ADAPTER.proofScope || !ARTIFACT_ADAPTER.supportedProfiles.includes(observation?.profile)) return false;
    const result = await verifyArtifactIntegrityEvidence(observation, subject, options);
    assertArtifactImplementation();
    return result;
  },
});
const ARTIFACT_SUBJECT_MEASURER = Object.freeze({
  id: 'artifact-subject:v1', sha256: ARTIFACT_IMPLEMENTATION_SHA256,
  async measure(input) {
    assertArtifactImplementation();
    const result = await measureArtifactSubject(input);
    assertArtifactImplementation();
    return result;
  },
});
// Import/registration measures only this fixed private module closure. It does
// not run Git, a decoder, source tests, installers, products or guest commands.
// Availability of these build-scope implementations does not remove any
// installed-product requirement or authorize a partial full-release receipt.
// The installed lifecycle adapters execute the disposable-guest drivers under
// tools/lib/drivers on a Windows x64 host. Registering them names one reviewed
// executor per installed row; it grants nothing. Five of the seven refuse until
// an attested disposable guest exists and two refuse because no executable
// scenario produces their evidence yet (tools/lib/adapters/installed-lifecycle.mjs).
const REQUIREMENT_ADAPTERS = new Map([
  ...SOURCE_SUITE_IDS.map(id => [`source:${id}`, getSourceSuiteAdapter(id)]),
  ['artifact-integrity', ARTIFACT_ADAPTER],
  ...INSTALLED_LIFECYCLE_IDS.map(id => [id, getInstalledLifecycleAdapter(id)]),
]);
const QUALIFICATION_ADAPTERS = new Map([...REQUIREMENT_ADAPTERS.values()].map(adapter => [adapter.id, adapter]));
const SUBJECT_MEASURERS = new Map([[ARTIFACT_SUBJECT_MEASURER.id, ARTIFACT_SUBJECT_MEASURER]]);
// Native mechanics are separate from the required product journeys. These are
// reviewed targets, not arbitrary caller-supplied platform/profile policy.
export const WINDOWS_READINESS_TARGET = Object.freeze({ platform: 'win32', arch: 'x64' });
export const LINUX_READINESS_TARGET = Object.freeze({ platform: 'linux', arch: 'x64' });
const NATIVE_TARGETS = freeze({
  'win32-x64': { target: WINDOWS_READINESS_TARGET,
    installer: { format: 'nsis', architecture: 'x64' },
    profiles: ['windows-x64-standard', 'windows-x64-administrator'],
    runtimeAccount: 'owning-non-elevated',
    artifactProducts: ['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'],
    subjectMeasurer: ARTIFACT_SUBJECT_MEASURER, adapters: REQUIREMENT_ADAPTERS },
  'linux-x64': { target: LINUX_READINESS_TARGET,
    installer: { format: 'deb', architecture: 'amd64' },
    // Both runs use the owning, non-elevated desktop account. The second
    // profile additionally exercises narrowly authorized installer privilege;
    // it does not start the application as root or omit the isolation journey.
    profiles: ['linux-x64-standard', 'linux-x64-install-authorized'],
    runtimeAccount: 'owning-non-elevated',
    // Only static ToolsEnabled .deb custody/accounting is implemented here.
    // All seven native installation/runtime rows remain unavailable.
    artifactProducts: ['toolsenabled'], subjectMeasurer: ARTIFACT_SUBJECT_MEASURER,
    adapters: new Map([['artifact-integrity', ARTIFACT_ADAPTER]]) },
});
const sameDigest = (left, right) => DIGEST.test(left || '') && DIGEST.test(right || '') && left.toLowerCase() === right.toLowerCase();

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function nativeTarget(target = WINDOWS_READINESS_TARGET) {
  if (!target || typeof target !== 'object' || Array.isArray(target) ||
      Object.keys(target).length !== 2 || !Object.hasOwn(target, 'platform') || !Object.hasOwn(target, 'arch') ||
      typeof target.platform !== 'string' || typeof target.arch !== 'string') fail('native target must name only a registered platform and architecture');
  const native = NATIVE_TARGETS[`${target.platform}-${target.arch}`];
  if (!native || native.target.platform !== target.platform || native.target.arch !== target.arch) fail('unsupported native target; no release contract is registered');
  return native;
}

function requirement(id, scope, assertions, { profiles, reason, product, native } = {}) {
  profiles ??= native.profiles;
  // The installed lifecycle rows are shared row ids, but their adapters measure
  // and drive the ToolsEnabled desktop subject only (they refuse any other
  // subject.product). Registering them on a standalone product's contract would
  // make that product read as "has an executor" when nobody has written one.
  const installedElsewhere = INSTALLED_LIFECYCLE_IDS.includes(id) && product !== 'toolsenabled';
  const artifactElsewhere = id === 'artifact-integrity' && !native.artifactProducts.includes(product);
  const implementation = installedElsewhere || artifactElsewhere ? undefined : id.startsWith('source:')
    ? REQUIREMENT_ADAPTERS.get(id) : native.adapters?.get(id);
  // Until the installed rows had executors this could hard-code "build", which
  // also meant registering one would have silently changed a row's profiles.
  // A registered implementation must earn exactly this scope and cover every
  // profile the row demands with its own frozen descriptor: build-scope
  // adapters stay build-only, and an installed adapter must name every native
  // runtime profile or the row it is registered against refuses here.
  if (implementation && (implementation.proofScope !== scope || !profiles.length || !Array.isArray(implementation.supportedProfiles) ||
    !Object.isFrozen(implementation.supportedProfiles) || profiles.some(profile => !implementation.supportedProfiles.includes(profile)))) fail('registered adapter cannot satisfy a different scope or profile');
  return { id, scope, profiles: [...profiles], assertions,
    adapter: implementation ? { id: implementation.id, sha256: implementation.sha256,
      proofScope: implementation.proofScope, execution: implementation.execution } : null,
    ...(!implementation ? { unavailableReason: reason ||
      (installedElsewhere ? `The registered ${id} adapter qualifies the ToolsEnabled desktop subject only; no reviewed ${product} adapter emits complete, exact-subject execution evidence.`
        : `No reviewed ${native.target.platform}/${native.target.arch} ${native.installer.format} ${id} qualification adapter emits complete, exact-subject execution evidence.`) } : {}) };
}

function desktopContract(product, { suites, journey, extra = [] }, native) {
  const row = (id, scope, assertions, options = {}) => requirement(id, scope, assertions, { ...options, product, native });
  const measurer = native.artifactProducts.includes(product) ? native.subjectMeasurer : null;
  return freeze({ schemaVersion: 1, product, target: { ...native.target },
    installer: { ...native.installer }, runtimeAccount: native.runtimeAccount,
    subjectMeasurer: measurer ? { id: measurer.id, sha256: measurer.sha256 } : null,
    ...(!measurer ? { subjectMeasurerUnavailableReason:
      `No reviewed ${native.target.platform}/${native.target.arch} ${native.installer.format} ${product} exact-installer subject measurer is registered.` } : {}),
    requirements: [
      ...suites.map(id => row(`source:${id}`, 'complete-source-suite',
        ['selection-reconciled', 'required-tests-executed', 'zero-unexplained-skips'], { profiles: ['build'] })),
      row('artifact-integrity', 'exact-packaged-artifact',
        ['source-and-payload-bound', 'runtime-and-dependency-closure', 'privacy-and-license-checks'], { profiles: ['build'] }),
      row('fresh-install', 'exact-installer-lifecycle',
        ['exact-installer-executed', 'shortcut-starts-installed-product', 'first-run-completes']),
      row('durable-critical-journey', 'exact-installed-desktop', journey),
      row('upgrade', 'exact-installer-lifecycle',
        ['supported-upgrade-source-installed', 'exact-candidate-upgrade-executed', 'user-data-survives', 'upgraded-product-relaunches']),
      row('uninstall-reinstall', 'exact-installer-lifecycle',
        ['installed-product-uninstalled', 'documented-data-policy-preserved', 'exact-candidate-reinstalled', 'reinstalled-product-relaunches']),
      row('privilege-isolation-recovery', 'exact-installed-desktop',
        ['chosen-privilege-observed', 'profile-boundary-enforced', 'failure-is-observable', 'recovery-preserves-user-data']),
      ...extra.map(([id, scope, assertions]) => row(id, scope, assertions)),
    ] });
}

// This registry is source-controlled policy, NOT supplied by a receipt or a
// command-line flag. A currently missing adapter is an explicit blocker. Do
// not set an adapter merely because a similarly named source/mock/HTTP test
// exists: its implementation must actually earn this scope and assertions.
const PRODUCTS = freeze({
  toolsenabled: { suites: ['app', 'engine'],
    journey: ['installed-ui-starts-shipped-engine', 'supported-provider-start-response-stop', 'result-persists-after-full-relaunch'], extra: [
      ['advertised-integrations', 'exact-installed-desktop',
        ['supported-provider-matrix-complete', 'supported-multi-machine-path-complete', 'payments-remain-inert']],
      ['update-delivery', 'exact-installer-lifecycle',
        ['actual-update-delivery-path', 'exact-candidate-selected', 'interrupted-update-recovers']],
    ] },
  scribe: { suites: ['scribe', 'shared', 'shell'],
    journey: ['create-edit-save-document', 'document-content-reopened-after-full-relaunch', 'supported-export-opens-correctly'], extra: [
      ['advertised-agent-and-consent-integrations', 'exact-installed-desktop',
        ['installed-claude-and-codex-editing-agent-journeys', 'idle-and-watch-off-produce-no-provider-calls',
          'watch-review-cannot-mutate-document', 'continuation-requires-visible-human-acceptance',
          'pause-blocks-inflight-document-writes', 'save-confirmation-cancel-failure-and-fallback',
          'undo-and-revision-conflict-recovery']],
      ['local-voice', 'exact-installed-desktop',
        ['installed-microphone-permission-and-capture', 'completed-utterance-transcribed-by-local-model',
          'transcription-does-not-start-editing-without-send', 'microphone-refusal-and-local-model-failure-visible']],
    ] },
  'web-editor': { suites: ['web-editor', 'shared', 'shell'],
    journey: ['create-edit-preview-project', 'confirmed-publish-output-is-correct', 'project-content-reopened-after-full-relaunch'] },
  'presentation-suite': { suites: ['presentation-suite', 'reaper', 'loops', 'agents', 'shared', 'shell'],
    journey: ['create-edit-save-presentation', 'presentation-reopened-after-full-relaunch', 'advertised-export-and-agent-paths-work'] },
});
const CONTRACTS = new Map();

function fail(message, details = []) {
  const error = new Error(`Release readiness blocked: ${message}`);
  error.code = 'RELEASE_READINESS_BLOCKED';
  error.details = details;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function readinessDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function getReadinessContract(product, target = WINDOWS_READINESS_TARGET) {
  if (!Object.hasOwn(PRODUCTS, product)) fail('unknown product; no release contract is registered');
  const native = nativeTarget(target), key = `${product}:${native.target.platform}-${native.target.arch}`;
  if (!CONTRACTS.has(key)) CONTRACTS.set(key, desktopContract(product, PRODUCTS[product], native));
  return CONTRACTS.get(key);
}

export function assertContractAdaptersAvailable(contract) {
  if (!contract || !Array.isArray(contract.requirements) || !contract.requirements.length) fail('required coverage contract is empty');
  const missing = contract.requirements.filter(row => !row.adapter ||
    typeof row.adapter.id !== 'string' || !row.adapter.id || !DIGEST.test(row.adapter.sha256 || '') ||
    row.adapter.proofScope !== row.scope || row.adapter.execution !== 'real');
  if (missing.length) fail(`required qualification adapters are unavailable (${missing.map(row => row.id).join(', ')}). Source tests, copied stages and mock/HTTP checks are not substitutes.`,
    missing.map(row => ({ id: row.id, reason: row.unavailableReason || 'No reviewed exact-scope adapter.' })));
  return contract;
}

export function assertReadinessAdaptersAvailable(product, target = WINDOWS_READINESS_TARGET) {
  const contract = assertContractAdaptersAvailable(getReadinessContract(product, target));
  assertExecutableAdapters(contract, QUALIFICATION_ADAPTERS);
  trustedSubjectMeasurer(contract, SUBJECT_MEASURERS);
  return contract;
}

function assertExecutableAdapters(contract, adapters) {
  for (const row of contract.requirements) {
    const adapter = adapters?.get?.(row.adapter.id);
    if (!adapter || adapter.id !== row.adapter.id || !sameDigest(adapter.sha256, row.adapter.sha256) ||
      typeof adapter.execute !== 'function' || typeof adapter.verifyExecutionEvidence !== 'function') {
      fail(`no trusted executor and execution-evidence verifier are registered for ${row.id}`);
    }
    const supportedProfiles = adapter.supportedProfiles;
    const supportedProfileEntries = Array.isArray(supportedProfiles) ? Array.from(supportedProfiles) : [];
    const validProfileDescriptor = Array.isArray(supportedProfiles) && Object.isFrozen(supportedProfiles) && supportedProfiles.length > 0 &&
      new Set(supportedProfileEntries).size === supportedProfiles.length && supportedProfileEntries.length === supportedProfiles.length &&
      supportedProfileEntries.every(profile => typeof profile === 'string' && profile.length > 0) &&
      Array.isArray(row.profiles) && row.profiles.length > 0 && row.profiles.every(profile => supportedProfiles.includes(profile));
    if (adapter.proofScope !== row.scope || adapter.execution !== 'real' || !validProfileDescriptor) {
      fail(`registered adapter cannot satisfy the exact required scope/profile for ${row.id}`);
    }
    verificationDeadline(adapter);
  }
}

function trustedSubjectMeasurer(contract, measurers) {
  const declared = contract.subjectMeasurer;
  const implementation = declared && measurers.get(declared.id);
  if (!implementation || !sameDigest(declared.sha256, implementation.sha256) || typeof implementation.measure !== 'function') fail(contract.subjectMeasurerUnavailableReason || 'no trusted exact-subject measurer is registered');
  return implementation;
}

function artifactIdentity(value) {
  return Boolean(value && DIGEST.test(value.sha256 || '') && Number.isSafeInteger(value.bytes) && value.bytes > 0);
}

function sameArtifact(left, right) {
  return artifactIdentity(left) && artifactIdentity(right) &&
    left.bytes === right.bytes && left.sha256.toLowerCase() === right.sha256.toLowerCase();
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
}

function assertSubject(subject, contract, artifact, sourceRefs) {
  if (!subject || !sameArtifact(subject.artifact, artifact)) fail('receipt names different installer bytes');
  for (const key of ['sourceSha256', 'stageSha256', 'runtimeSha256', 'shellSha256']) if (!DIGEST.test(subject[key] || '')) fail(`missing measured ${key}`);
  if (!subject.harness || subject.harness.clean !== true || !REF.test(subject.harness.ref || '') || !DIGEST.test(subject.harness.sha256 || '')) fail('qualification harness must be identified and clean');
  if (subject.target?.platform !== contract.target.platform || subject.target?.arch !== contract.target.arch) fail('receipt targets an unsupported platform or architecture');
  if (!subject.sourceRefs || typeof subject.sourceRefs !== 'object' || Array.isArray(subject.sourceRefs) ||
    !Object.keys(subject.sourceRefs).length || Object.values(subject.sourceRefs).some(ref => !REF.test(ref || ''))) fail('source references are missing or unresolved');
  if (sourceRefs && Object.entries(sourceRefs).some(([key, ref]) => !REF.test(ref || '') || subject.sourceRefs[key]?.toLowerCase() !== ref.toLowerCase())) fail('receipt source references differ from the candidate');
}

function assertExecution(execution, key, scope) {
  const registeredSourceTool = scope === 'complete-source-suite' && execution?.hostRuntime === true &&
    execution.toolchainScope === 'registered-source-tools' && artifactIdentity(execution.toolchain);
  if (!execution || execution.complete !== true || execution.exitCode !== 0 || execution.signal !== null || execution.cleanupConfirmed !== true ||
    execution.synthetic !== false || execution.sourceOverlay !== false || (execution.hostRuntime !== false && !registeredSourceTool) ||
    !Array.isArray(execution.command) || !execution.command.length || execution.command.some(arg => typeof arg !== 'string' || !arg)) fail(`execution or cleanup is incomplete/non-real for ${key}`);
}

function assertCounts(counts, minimum, key) {
  if (!counts || !Number.isSafeInteger(counts.tests) || counts.tests < minimum || counts.passed !== counts.tests ||
    ['failed', 'skipped', 'cancelled', 'todo', 'notRun'].some(name => counts[name] !== 0)) fail(`required coverage did not completely pass for ${key}`);
}

// Pure protocol validator. Fixture tests may supply their own fully defined
// synthetic contract here. Production consumers MUST use assert/read below,
// which select the fixed registry and never accept caller-defined policy.
export function assertReadinessAgainstContract(receipt, contract, { artifact, sourceRefs, now = Date.now() } = {}) {
  assertContractAdaptersAvailable(contract);
  if (!artifactIdentity(artifact)) fail('the consumer must measure the exact nonempty installer');
  if (!receipt || receipt.schema !== READINESS_SCHEMA || receipt.schemaVersion !== 1 || receipt.product !== contract.product ||
    !sameDigest(receipt.contractSha256, readinessDigest(contract)) || receipt.ready !== true) fail('receipt identity, policy or final verdict is invalid');
  if (!Array.isArray(receipt.unmeasured) || receipt.unmeasured.length) fail('unmeasured required coverage remains');
  const run = receipt.run;
  const start = timestamp(run?.startedAt), finish = timestamp(run?.finishedAt);
  if (!run || typeof run.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(run.id) || run.scope !== 'full-release-qualification' || run.complete !== true ||
    !Number.isFinite(start) || !Number.isFinite(finish) || finish < start || finish > now || start > now || now - start > MAX_AGE_MS) fail('qualification is incomplete, stale, future-dated or outside its full-release scope');
  const subject = receipt.subject;
  assertSubject(subject, contract, artifact, sourceRefs);
  const expected = new Map();
  for (const row of contract.requirements) {
    if (!Array.isArray(row.profiles) || !row.profiles.length || !Array.isArray(row.assertions) || !row.assertions.length) fail('required coverage definition is incomplete');
    for (const profile of row.profiles) {
      const key = `${row.id}/${profile}`;
      if (expected.has(key)) fail('required coverage definition is duplicated');
      expected.set(key, row);
    }
  }
  if (!Array.isArray(receipt.observations) || receipt.observations.length !== expected.size) fail('required suite, journey or environment profile is missing or duplicated');
  const seen = new Set();
  for (const observation of receipt.observations) {
    const key = `${observation?.id}/${observation?.profile}`;
    const required = expected.get(key);
    if (!required || seen.has(key)) fail('unexpected or duplicated qualification observation');
    seen.add(key);
    assertObservation(observation, required, contract, { artifact, subject, run, start, finish });
  }
  return receipt;
}

function assertObservation(observation, required, contract, { artifact, subject, run, start, finish }) {
  const key = `${required.id}/${observation.profile}`, subjectHash = readinessDigest(subject);
  if (observation.scope !== required.scope || observation.adapterId !== required.adapter.id || !sameDigest(observation.adapterSha256, required.adapter.sha256) ||
    !sameDigest(observation.subjectSha256, subjectHash) || observation.runId !== run.id) fail(`wrong proof scope, adapter or tested subject for ${key}`);
  assertExecution(observation.execution, key, required.scope);
  const began = timestamp(observation.startedAt), ended = timestamp(observation.finishedAt);
  if (!Number.isFinite(began) || !Number.isFinite(ended) || began < start || ended < began || ended > finish) fail(`observation time is outside its qualification run for ${key}`);
  const environment = observation.environment;
  if (!environment || environment.platform !== contract.target.platform || environment.arch !== contract.target.arch || environment.profile !== observation.profile ||
    typeof environment.osBuild !== 'string' || !environment.osBuild || environment.isolated !== true) fail(`supported environment was not observed for ${key}`);
  if (required.scope === 'exact-installer-lifecycle' && environment.isolation !== 'disposable-machine') fail(`installer lifecycle needs an isolated machine, not a redirected stage directory, for ${key}`);
  if (required.scope.startsWith('exact-installed') || required.scope === 'exact-installer-lifecycle') {
    if (!sameDigest(observation.observedRuntimeSha256, subject.runtimeSha256) || !sameArtifact(observation.installer, artifact)) fail(`installed runtime or installer was not observed for ${key}`);
  }
  if (!artifactIdentity(observation.report)) fail(`raw execution report is unbound for ${key}`);
  assertCounts(observation.counts, required.assertions.length, key);
  if (!Array.isArray(observation.assertions) || observation.assertions.length !== required.assertions.length ||
    new Set(observation.assertions.map(item => item?.id)).size !== required.assertions.length ||
    observation.assertions.some(item => !required.assertions.includes(item?.id) || item.status !== 'passed' || !DIGEST.test(item.evidenceSha256 || ''))) fail(`required behavioral assertions are missing or not passing for ${key}`);
}

function verificationDeadline(adapter, override) {
  const timeoutMs = override !== undefined ? override :
    adapter.verificationTimeoutMs !== undefined ? adapter.verificationTimeoutMs : VERIFICATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_VERIFICATION_TIMEOUT_MS) fail('invalid execution-evidence verification deadline');
  return timeoutMs;
}

function verificationCleanupDeadline(override = VERIFICATION_CLEANUP_TIMEOUT_MS) {
  if (!Number.isSafeInteger(override) || override <= 0 || override > VERIFICATION_CLEANUP_TIMEOUT_MS) fail('invalid verification cleanup deadline');
  return override;
}

async function verifyObservation(adapter, observation, subject, override, cleanupOverride) {
  // Longer replay budgets belong to reviewed implementations, never receipt
  // fields or production caller options. The explicit override is fixture-only.
  const timeoutMs = verificationDeadline(adapter, override);
  const cleanupMs = verificationCleanupDeadline(cleanupOverride);
  const controller = new AbortController();
  let timer, cleanupTimer;
  const verification = Promise.resolve().then(() => adapter.verifyExecutionEvidence(observation, subject, { signal: controller.signal }))
    .then(result => ({ settled: true, result }), error => ({ settled: true, error }));
  const expired = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ settled: false });
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([verification, expired]);
    if (!outcome.settled || controller.signal.aborted) {
      // Aborting work is not proof that its owned processes have stopped. Give
      // the adapter a bounded chance to complete cleanup before returning; a
      // timeout can never become success even if the verifier later says true.
      const cleanup = await Promise.race([verification, new Promise(resolve => {
        cleanupTimer = setTimeout(() => resolve({ settled: false }), cleanupMs);
      })]);
      const error = new Error(`Release readiness blocked: execution-evidence verification timed out for ${observation.id}/${observation.profile}; unfinished work is not proof`);
      error.code = 'RELEASE_READINESS_BLOCKED';
      error.cleanupUnconfirmed = !cleanup.settled || cleanup.error?.cleanupUnconfirmed === true;
      error.verificationSettled = cleanup.settled;
      throw error;
    }
    if (outcome.error) throw outcome.error;
    if (outcome.result !== true) fail(`execution evidence was not verified for ${observation.id}/${observation.profile}`);
  } finally { clearTimeout(timer); clearTimeout(cleanupTimer); }
}

// Synthetic consumer seam, not production authority. Production selects its
// private contract and adapter registry below and accepts no caller substitutes.
export async function verifyReadinessContractEvidence(receipt, contract, adapters, { artifact, sourceRefs } = {}) {
  contract = freeze(structuredClone(assertContractAdaptersAvailable(contract)));
  assertExecutableAdapters(contract, adapters);
  // Awaited verifiers must not race mutations of a caller's JSON object.
  receipt = freeze(structuredClone(receipt));
  assertReadinessAgainstContract(receipt, contract, { artifact, sourceRefs });
  const ordered = contract.requirements.flatMap(row => row.profiles.map(profile =>
    receipt.observations.find(observation => observation.id === row.id && observation.profile === profile)));
  const artifacts = ordered.filter(observation => observation.scope === 'exact-packaged-artifact');
  if (!artifacts.length) fail('consumer verification requires an independent exact-artifact observation');
  const verify = observation => verifyObservation(adapters.get(observation.adapterId), observation, receipt.subject);
  // Submitted reports/context are untrusted. Independently validate exact,
  // clean source/harness/payload identity BEFORE any source replay executes.
  // Repeat after the other verifiers to reject drift during their execution.
  for (const observation of artifacts) await verify(observation);
  for (const observation of ordered) if (observation.scope !== 'exact-packaged-artifact') await verify(observation);
  for (const observation of artifacts) await verify(observation);
  assertReadinessAgainstContract(receipt, contract, { artifact, sourceRefs });
  return receipt;
}

export async function assertReleaseReadiness(receipt, { product, artifact, sourceRefs, target = WINDOWS_READINESS_TARGET } = {}) {
  const contract = assertReadinessAdaptersAvailable(product, target);
  return verifyReadinessContractEvidence(receipt, contract, QUALIFICATION_ADAPTERS, { artifact, sourceRefs });
}

function fencedEntry(file, kind = 'file') {
  if (typeof file !== 'string' || !file || (process.platform === 'win32' &&
    (/^[\\/]{2}/.test(file) || /:/.test(file.replace(/^[a-z]:/i, '')) || file.split(/[\\/]/).some(part => /[. ]$/.test(part) && part !== '.' && part !== '..')))) fail('evidence path is missing or uses an alternate/device spelling');
  const resolved = path.resolve(file);
  const fence = process.platform === 'win32' ? userInfo().homedir : path.parse(resolved).root;
  const rel = path.relative(fence, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('evidence path leaves the permitted profile or is not a file');
  let cursor = fence;
  const rootStat = fs.lstatSync(cursor);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('evidence profile root is not a plain directory');
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('evidence path contains a link');
    if (cursor !== resolved && !stat.isDirectory()) fail('evidence parent is not a directory');
  }
  const entry = fs.lstatSync(resolved);
  if (kind === 'file' ? !entry.isFile() : !entry.isDirectory()) fail(`qualification input is not a regular ${kind}`);
  return resolved;
}

const regularFile = file => fencedEntry(file);

// Context locates actual inputs; it cannot define coverage, executable tools,
// hashes, assertions or a verdict. Fixed measurers independently bind all of
// these directories to the assembled artifact and selected source refs.
export function normalizeQualificationContext(context, product) {
  getReadinessContract(product);
  const keys = ['sourceRoots', 'stageRoot', 'harnessRoot', 'evidenceRoot', 'runnerConfigPath'];
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key => !keys.includes(key))) fail('qualification context contains missing or caller-defined policy/tool fields');
  const names = product === 'toolsenabled' ? ['app', 'engine'] : ['website'];
  if (!context.sourceRoots || typeof context.sourceRoots !== 'object' || Array.isArray(context.sourceRoots) ||
    Object.keys(context.sourceRoots).length !== names.length || names.some(name => !Object.hasOwn(context.sourceRoots, name))) fail('qualification context must locate every required source checkout');
  const directory = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('qualification directories must be explicit absolute paths');
    return fencedEntry(value, 'directory');
  };
  const normalized = { sourceRoots: Object.fromEntries(names.map(name => [name, directory(context.sourceRoots[name])])),
    stageRoot: directory(context.stageRoot), harnessRoot: directory(context.harnessRoot), evidenceRoot: directory(context.evidenceRoot) };
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if ([...Object.values(normalized.sourceRoots), normalized.stageRoot, normalized.harnessRoot].some(root => inside(root, normalized.evidenceRoot) || inside(normalized.evidenceRoot, root))) fail('private evidence must be separate from source, stage and harness trees');
  if (context.runnerConfigPath !== undefined) {
    if (typeof context.runnerConfigPath !== 'string' || !path.isAbsolute(context.runnerConfigPath)) fail('runner configuration must have an explicit absolute path');
    normalized.runnerConfigPath = regularFile(context.runnerConfigPath);
    if (inside(normalized.stageRoot, normalized.runnerConfigPath)) fail('private runner configuration cannot be in the product stage');
  }
  return freeze(normalized);
}

export function readQualificationContext(file, product, expected = {}) {
  const resolved = regularFile(file), handle = fs.openSync(resolved, 'r');
  let context;
  try {
    const before = fs.fstatSync(handle);
    if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > 64 * 1024) fail('qualification context exceeds its nonempty byte budget');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('qualification context was truncated during reading');
      offset += count;
    }
    const current = fs.lstatSync(regularFile(resolved));
    if ([current, fs.fstatSync(handle)].some(entry => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => entry[key] !== before[key]))) fail('qualification context changed during reading');
    try { context = JSON.parse(bytes.toString('utf8')); } catch { fail('qualification context is not JSON'); }
  } finally { fs.closeSync(handle); }
  context = normalizeQualificationContext(context, product);
  const location = path.relative(context.evidenceRoot, resolved);
  if (!location || location === '..' || location.startsWith(`..${path.sep}`) || path.isAbsolute(location)) fail('qualification context must remain in its private evidence directory');
  for (const [key, value] of Object.entries(expected)) {
    if (!['sourceRoots', 'stageRoot', 'harnessRoot', 'evidenceRoot'].includes(key)) fail('unknown expected qualification location');
    const pairs = key === 'sourceRoots' ? Object.entries(value).map(([name, root]) => [context.sourceRoots[name], root, `sourceRoots.${name}`]) : [[context[key], value, key]];
    for (const [actual, wanted, label] of pairs) {
      if (typeof actual !== 'string' || typeof wanted !== 'string' || !path.isAbsolute(wanted) || path.relative(actual, wanted) !== '') fail(`qualification context ${label} differs from the actual build input`);
    }
  }
  return context;
}

function measureArtifact(file) {
  const resolved = regularFile(file);
  const handle = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(handle);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0) fail('installer is not a nonempty regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0, count;
    while ((count = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const after = fs.fstatSync(handle), current = fs.lstatSync(regularFile(resolved));
    if (bytes !== before.size || [after, current].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) fail('installer changed while its bytes were measured');
    return { sha256: hash.digest('hex'), bytes };
  } finally { fs.closeSync(handle); }
}

// Dependency-injected orchestration seam for explicitly synthetic unit tests.
// It is NOT a production qualification authority. Production entry points use
// qualifyReleaseArtifact and independently assert the fixed registry below.
export async function executeReadinessContract({ contract, adapters, measurers, artifactPath, sourceRefs, context,
  verificationTimeoutMs, verificationCleanupTimeoutMs }) {
  contract = freeze(structuredClone(assertContractAdaptersAvailable(contract)));
  assertExecutableAdapters(contract, adapters);
  if (verificationTimeoutMs !== undefined) verificationDeadline({}, verificationTimeoutMs);
  verificationCleanupDeadline(verificationCleanupTimeoutMs);
  const measurer = trustedSubjectMeasurer(contract, measurers);
  if (!sourceRefs || typeof sourceRefs !== 'object' || Array.isArray(sourceRefs) || !Object.keys(sourceRefs).length ||
    Object.values(sourceRefs).some(ref => !REF.test(ref || ''))) fail('qualification producer needs resolved candidate source references');
  sourceRefs = freeze(structuredClone(sourceRefs));
  const startedAt = new Date().toISOString();
  const artifact = freeze(measureArtifact(artifactPath));
  artifactPath = regularFile(artifactPath);
  const measurement = freeze({ product: contract.product, target: { ...contract.target }, artifactPath, artifact, sourceRefs,
    ...(context ? { context: freeze(structuredClone(context)) } : {}) });
  const subject = freeze(structuredClone(await measurer.measure(measurement)));
  assertSubject(subject, contract, artifact, sourceRefs);
  const subjectSha256 = readinessDigest(subject);
  async function assertStableSubject() {
    if (!sameArtifact(measureArtifact(artifactPath), artifact)) fail('installer changed during qualification');
    if (!sameDigest(readinessDigest(await measurer.measure(measurement)), subjectSha256)) fail('source, payload, runtime or harness changed during qualification');
    if (!sameArtifact(measureArtifact(artifactPath), artifact)) fail('installer changed during subject measurement');
  }
  const run = freeze({ id: randomUUID(), scope: 'full-release-qualification', startedAt });
  const observations = [];
  for (const required of contract.requirements) {
    for (const profile of required.profiles) {
      await assertStableSubject();
      const adapter = adapters.get(required.adapter.id);
      // Each adapter owns bounded execution and confirmed cleanup in its
      // authorized disposable environment; throwing can never earn a receipt.
      const observation = freeze(structuredClone(await adapter.execute(freeze({ required, profile, subject, subjectSha256, run, artifactPath,
        ...(measurement.context ? { context: measurement.context } : {}) }))));
      await assertStableSubject();
      if (observation?.id !== required.id || observation?.profile !== profile) fail(`execution evidence was not verified for ${required.id}/${profile}`);
      await verifyObservation(adapter, observation, subject, verificationTimeoutMs, verificationCleanupTimeoutMs);
      // In particular, never start another driver after uncertain cleanup.
      assertExecution(observation.execution, `${required.id}/${profile}`, required.scope);
      assertCounts(observation.counts, required.assertions.length, `${required.id}/${profile}`);
      observations.push(observation);
    }
  }
  await assertStableSubject();
  const receipt = freeze({ schema: READINESS_SCHEMA, schemaVersion: 1, product: contract.product,
    contractSha256: readinessDigest(contract), ready: true, unmeasured: [],
    run: { ...run, complete: true, finishedAt: new Date().toISOString() }, subject, observations });
  assertReadinessAgainstContract(receipt, contract, { artifact, sourceRefs });
  for (const observation of observations) await verifyObservation(adapters.get(observation.adapterId), observation, subject, verificationTimeoutMs, verificationCleanupTimeoutMs);
  await assertStableSubject();
  assertReadinessAgainstContract(receipt, contract, { artifact, sourceRefs });
  return receipt;
}

// A deliberately separate production entry point: no synthetic registry,
// narrowed full-release contract, receipt import, or caller-selected executor.
// Static artifact success never earns installed/runtime/source-suite coverage.
export async function checkArtifactIntegrity(options = {}) {
  const keys = ['product', 'artifactPath', 'sourceRefs', 'context', 'target'];
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !keys.includes(key))) fail('artifact check accepts input locations and exact refs only');
  const { product, target } = options;
  if (!target) fail('artifact check requires an explicit native target');
  const contract = getReadinessContract(product, target);
  const required = contract.requirements.find(row => row.id === 'artifact-integrity');
  if (!required?.adapter) fail(required?.unavailableReason || 'no artifact adapter is registered');
  assertExecutableAdapters({ requirements: [required] }, QUALIFICATION_ADAPTERS);
  const measurer = trustedSubjectMeasurer(contract, SUBJECT_MEASURERS);
  if (contract.target.platform !== process.platform || contract.target.arch !== process.arch) fail('artifact check requires its actual native target');
  const names = product === 'toolsenabled' ? ['app', 'engine'] : ['website'];
  if (!options.sourceRefs || typeof options.sourceRefs !== 'object' || Array.isArray(options.sourceRefs) ||
      Object.keys(options.sourceRefs).sort().join(',') !== names.join(',') ||
      Object.values(options.sourceRefs).some(ref => typeof ref !== 'string' || !REF.test(ref))) fail('artifact check needs every exact candidate source reference');
  const sourceRefs = freeze(Object.fromEntries(names.map(name => [name, options.sourceRefs[name].toLowerCase()])));
  const context = normalizeQualificationContext(options.context, product);
  const artifactPath = regularFile(options.artifactPath);
  const generation = () => {
    const entry = fs.lstatSync(regularFile(artifactPath), { bigint: true });
    return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(entry[key])).join(':');
  };
  const originalGeneration = generation(), artifact = freeze(measureArtifact(artifactPath));
  const stableArtifact = () => {
    if (generation() !== originalGeneration || !sameArtifact(measureArtifact(artifactPath), artifact) ||
        generation() !== originalGeneration) fail('installer changed during artifact check');
  };
  stableArtifact();
  const run = freeze({ id: randomUUID(), scope: 'artifact-integrity-only', startedAt: new Date().toISOString() });
  const measurement = freeze({ product, target: { ...contract.target }, artifactPath, artifact, sourceRefs, context });
  const subject = freeze(structuredClone(await measurer.measure(measurement)));
  stableArtifact();
  assertSubject(subject, contract, artifact, sourceRefs);
  const subjectSha256 = readinessDigest(subject), adapter = QUALIFICATION_ADAPTERS.get(required.adapter.id);
  const observation = freeze(structuredClone(await adapter.execute(freeze({ required, profile: 'build', subject,
    subjectSha256, run, artifactPath, context }))));
  stableArtifact();
  const validate = () => {
    if (observation?.id !== required.id || observation?.profile !== 'build') fail('artifact check returned different execution evidence');
    assertObservation(observation, required, contract, { artifact, subject, run,
      start: timestamp(run.startedAt), finish: Date.now() });
  };
  validate();
  // This awaits a new native decode and the fixed checks against the report;
  // a stored green report or an executed-but-unverified result cannot pass.
  await verifyObservation(adapter, observation, subject);
  stableArtifact();
  const finalSubject = await measurer.measure(measurement);
  stableArtifact();
  if (!sameDigest(readinessDigest(finalSubject), subjectSha256)) fail('source, payload, runtime or harness changed during artifact check');
  validate();
  return freeze({ schema: 'toolsenabled.artifact-integrity-check', schemaVersion: 1,
    scope: 'artifact-integrity-only', status: 'passed', releaseReady: false, product, target: { ...contract.target },
    authority: 'Exact artifact integrity only; source suites and installed product qualification remain required.',
    run: { ...run, complete: true, finishedAt: new Date().toISOString() }, subject, observation,
    remainingRequirements: contract.requirements.filter(row => row.id !== required.id).map(row => ({
      id: row.id, scope: row.scope, profiles: [...row.profiles], status: 'not-run',
      ...(row.unavailableReason ? { unavailableReason: row.unavailableReason } : {}) })) });
}

export async function qualifyReleaseArtifact({ product, artifactPath, sourceRefs, context, target = WINDOWS_READINESS_TARGET } = {}) {
  // No candidate filesystem/build/product work until reviewed production drivers and
  // an exact-subject measurer are available; callers cannot supply substitutes.
  const contract = assertReadinessAdaptersAvailable(product, target);
  context = normalizeQualificationContext(context, product);
  const receipt = await executeReadinessContract({ contract, adapters: QUALIFICATION_ADAPTERS,
    measurers: SUBJECT_MEASURERS, artifactPath, sourceRefs, context });
  return assertReleaseReadiness(receipt, { product, target: contract.target, artifact: measureArtifact(artifactPath), sourceRefs });
}

// The part of assertReleaseReadiness that needs no assembled installer, so a
// caller-supplied receipt can be refused before Git, staging, the build or any
// candidate measurement. While the installed rows had no registered adapter,
// assertReadinessAdaptersAvailable refused every cut first and this gap was
// invisible; with those adapters registered, a receipt naming an executor
// nobody implemented would otherwise survive a full build before being read.
// This is a strict subset of the full check: passing here qualifies nothing.
export function assertReceiptNamesRegisteredAdapters(file, product, target = WINDOWS_READINESS_TARGET) {
  const contract = assertReadinessAdaptersAvailable(product, target);
  let receipt;
  try {
    const resolved = regularFile(file);
    if (fs.lstatSync(resolved).size > 2 * 1024 * 1024) fail('readiness receipt exceeds its size budget');
    receipt = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    if (error.code === 'RELEASE_READINESS_BLOCKED') throw error;
    fail(`the supplied readiness receipt could not be read (${error.code || 'invalid'}); name one existing private receipt file`);
  }
  if (!receipt || receipt.schema !== READINESS_SCHEMA || receipt.schemaVersion !== 1 || receipt.product !== contract.product ||
    !sameDigest(receipt.contractSha256, readinessDigest(contract)) || receipt.ready !== true) fail('receipt identity, policy or final verdict is invalid');
  const rows = new Map(contract.requirements.map(row => [row.id, row]));
  if (!Array.isArray(receipt.observations) || !receipt.observations.length) fail('receipt carries no qualification observations');
  for (const observation of receipt.observations) {
    const row = rows.get(observation?.id);
    const adapter = row && QUALIFICATION_ADAPTERS.get(observation.adapterId);
    if (!row || !adapter || adapter.id !== row.adapter.id || !sameDigest(observation.adapterSha256, adapter.sha256)) {
      fail(`the receipt names an executor this build does not register for ${observation?.id ?? 'an unknown requirement'}. Only the reviewed adapters in this source tree can produce qualification evidence.`);
    }
  }
  return contract;
}

export async function readReleaseReadiness(file, options = {}) {
  // Fail before I/O when this product cannot yet earn full qualification.
  assertReadinessAdaptersAvailable(options.product, options.target);
  const resolved = regularFile(file);
  if (fs.lstatSync(resolved).size > 2 * 1024 * 1024) fail('readiness receipt exceeds its size budget');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch { fail('readiness receipt is missing or malformed'); }
  return assertReleaseReadiness(receipt, options);
}
