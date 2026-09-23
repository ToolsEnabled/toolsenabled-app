import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { createDisposableGuest, createAttestedGuestAgent, probeDisposableGuest, DISPOSABLE_GUEST_METHODS, DISPOSABLE_GUEST_MODE,
  DISPOSABLE_GUEST_PROFILES, WORKER_CONFIG_SCHEMA, ADMISSION_REFUSALS, attestationBindingFailure,
  GUEST_AGENT_SCHEMA } from '../lib/guest/disposable-guest.mjs';

// tools/lib/adapters/installed-lifecycle.mjs will only run the installer
// lifecycle through this module, so what it refuses is what the Windows cut
// refuses. The point of these tests is that it cannot quietly hand back a
// half-capable guest: the driver would then start a phase it cannot finish,
// and an unfinished phase is exactly the state quarantine exists for.
const TEST_TEMP = ownedFixtureTempRoot();
const DRIVER = new URL('../lib/drivers/installer-lifecycle.mjs', import.meta.url);
const scratch = t => {
  const root = mkdtempSync(path.join(TEST_TEMP, 'disposable-guest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const workerConfig = (overrides = {}) => ({ schema: WORKER_CONFIG_SCHEMA, schemaVersion: 1,
  vmId: '11111111-2222-3333-4444-555555555555', vmName: 'ToolsEnabled-Qualification-cut45',
  baselineCheckpointId: '66666666-7777-8888-9999-aaaaaaaaaaaa', machineRoot: TEST_TEMP,
  guestProfile: 'C:\\Users\\ToolsEnabled-Dev', networkPolicy: 'offline', ...overrides });
const check = (report, id) => report.checks.find(row => row.id === id);
function configFile(t, value) {
  const root = scratch(t), file = path.join(root, 'worker.json');
  writeFileSync(file, JSON.stringify(value));
  return { root, file };
}

test('the declared RPC surface is exactly what the lifecycle driver enforces', () => {
  const source = readFileSync(DRIVER, 'utf8');
  const literal = /const required = \[([^\]]*)\];/.exec(source);
  assert.ok(literal, 'mutation `rename the driver\'s guest capability list` survived: expected to find it in the driver source');
  const enforced = [...literal[1].matchAll(/'([a-zA-Z]+)'/g)].map(match => match[1]);
  assert.deepEqual([...DISPOSABLE_GUEST_METHODS].sort(), [...enforced].sort(),
    'mutation `let the declared guest surface drift from the driver\'s` survived: expected the same method set');
  assert.ok(source.includes(`'${DISPOSABLE_GUEST_MODE}'`),
    `mutation \`change the attested guest mode\` survived: expected the driver to still require ${DISPOSABLE_GUEST_MODE}`);
});

test('the probe never throws and reports every unmet prerequisite at once', () => {
  const report = probeDisposableGuest();
  assert.equal(report.available, false);
  assert.deepEqual(report.methods, [...DISPOSABLE_GUEST_METHODS]);
  for (const id of ['product', 'profile', 'evidence-root', 'harness-root', 'worker-config', 'guest-agent']) {
    assert.equal(check(report, id).status, 'blocked', `mutation \`assume ${id} on a bare host\` survived: expected a blocker`);
    assert.ok(check(report, id).remedy, `mutation \`blame the host for ${id} without a remedy\` survived: expected what to do about it`);
  }
  assert.deepEqual(report.blockers, report.checks.filter(row => row.status === 'blocked').map(row => row.id));
  // A probe that started a machine to find out would defeat its own purpose.
  assert.equal(report.scope, 'guest-precondition-probe');
  assert.match(report.authority, /No machine, installer, job or product was started/);
});

test('a satisfied precondition is reported satisfied, and the host check is honest about this platform', t => {
  const { file } = configFile(t, workerConfig({ machineRoot: scratch(t) }));
  const evidenceRoot = scratch(t);
  const report = probeDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0],
    evidenceRoot, harnessRoot: TEST_TEMP, runnerConfigPath: file });
  for (const id of ['product', 'profile', 'evidence-root', 'harness-root', 'worker-config', 'evidence-survives-teardown']) {
    assert.equal(check(report, id).status, 'satisfied', `${id}: ${check(report, id).detail}`);
  }
  const host = check(report, 'qualification-host');
  if (process.platform === 'win32' && process.arch === 'x64') assert.equal(host.status, 'satisfied');
  else {
    assert.equal(host.status, 'blocked');
    assert.match(host.remedy, /Windows x64 cutter/);
  }
  assert.equal(check(report, 'hyperv-host').status, 'not-checked',
    'mutation `claim Hyper-V readiness without measuring it` survived: expected the PowerShell probe to remain the measurement');
});

test('the missing guest agent blocks the guest even when everything else is satisfied', t => {
  const { file } = configFile(t, workerConfig({ machineRoot: scratch(t) }));
  const evidenceRoot = scratch(t);
  const report = probeDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[1],
    evidenceRoot, harnessRoot: TEST_TEMP, runnerConfigPath: file });
  const agent = check(report, 'guest-agent');
  assert.equal(agent.status, 'blocked',
    'mutation `let a provisioned machine stand in for the guest agent` survived: expected the session transport to remain missing');
  assert.equal(report.available, false);
  for (const method of DISPOSABLE_GUEST_METHODS) assert.ok(agent.remedy.includes(method), `${method} is not named in the remedy`);
  assert.match(agent.remedy, /installer-lifecycle\.mjs/);
  assert.match(agent.remedy, /one-shot batch run/);
});

test('the worker description is validated field by field, not accepted on trust', t => {
  for (const [label, value, pattern] of [
    ['unknown field', { ...workerConfig(), extra: 1 }, /unknown field extra/],
    ['wrong schema', workerConfig({ schema: 'something-else' }), /schema must be/],
    ['reusable machine name', workerConfig({ vmName: 'DevBox' }), /vmName must match/],
    ['no baseline checkpoint', workerConfig({ baselineCheckpointId: 'latest' }), /baselineCheckpointId must be/],
    ['unknown network policy', workerConfig({ networkPolicy: 'provider' }), /networkPolicy must be offline or allow-list/],
    ['machine root missing', workerConfig({ machineRoot: path.join(TEST_TEMP, 'no-such-machine-root') }), /machineRoot is not a plain directory/],
  ]) {
    const { file } = configFile(t, value);
    const report = probeDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0],
      evidenceRoot: TEST_TEMP, harnessRoot: TEST_TEMP, runnerConfigPath: file });
    assert.equal(check(report, 'worker-config').status, 'blocked', label);
    assert.match(check(report, 'worker-config').detail, pattern, label);
  }
});

test('the egress policy accepts only explicit DNS endpoints and the named switch', t => {
  const valid = workerConfig({ networkPolicy: 'allow-list', allowedEndpoints: ['api.example.test'],
    egressSwitchName: 'ToolsEnabled-Qualification-Egress-cut45', machineRoot: scratch(t) });
  const { file } = configFile(t, valid);
  const report = probeDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0],
    evidenceRoot: TEST_TEMP, harnessRoot: TEST_TEMP, runnerConfigPath: file });
  assert.equal(check(report, 'worker-config').status, 'satisfied');
  const bad = workerConfig({ networkPolicy: 'allow-list', allowedEndpoints: ['*.example.test'],
    egressSwitchName: 'ToolsEnabled-Qualification-Egress-cut45', machineRoot: scratch(t) });
  const badFile = configFile(t, bad).file;
  const refused = probeDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0],
    evidenceRoot: TEST_TEMP, harnessRoot: TEST_TEMP, runnerConfigPath: badFile });
  assert.match(check(refused, 'worker-config').detail, /explicit endpoint names/);
});

test('the attested guest client binds every RPC call and rejects unbound observations', async () => {
  const calls = [];
  const agent = createAttestedGuestAgent({ runId: 'run-1', guestId: '11111111-2222-3333-4444-555555555555',
    attestation: { schema: 'toolsenabled.attested-disposable-guest-agent', guestId: '11111111-2222-3333-4444-555555555555', baselineId: '66666666-7777-8888-9999-aaaaaaaaaaaa', traceId: 'trace-1' },
    rpc: { call: async (method, payload) => { calls.push([method, payload]); return { method, guestId: payload.guestId, runId: payload.runId, synthetic: false }; } } });
  const result = await agent.measureFile({ path: 'runtime.exe' });
  assert.equal(result.method, 'measureFile');
  assert.equal(calls[0][1].attestation.traceId, 'trace-1');
  assert.throws(() => createAttestedGuestAgent({ runId: 'run-1', guestId: '11111111-2222-3333-4444-555555555555', attestation: {}, rpc: { call() {} } }), /incomplete native attestation/);
});

test('evidence stored inside the disposable machine tree is refused before any machine is touched', t => {
  const { root, file } = configFile(t, workerConfig({ machineRoot: TEST_TEMP }));
  const report = probeDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0],
    evidenceRoot: root, harnessRoot: TEST_TEMP, runnerConfigPath: file });
  assert.equal(check(report, 'evidence-survives-teardown').status, 'blocked',
    'mutation `keep the evidence inside the machine that gets restored` survived: expected the teardown refusal');
  assert.match(check(report, 'evidence-survives-teardown').remedy, /Restoring the baseline discards everything inside the machine tree/);
});

test('createDisposableGuest refuses rather than returning a partial guest, and names every blocker', async () => {
  await assert.rejects(() => createDisposableGuest({ product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0] }), error => {
    assert.equal(error.code, 'DISPOSABLE_GUEST_BLOCKED');
    // Nothing here starts a machine, so this refusal must not push the driver
    // onto its quarantine path, which exists for genuinely uncertain cleanup.
    assert.equal(error.cleanupUnconfirmed, false,
      'mutation `report a precondition refusal as uncertain cleanup` survived: expected cleanupUnconfirmed false');
    for (const id of error.details.map(row => row.id)) assert.ok(error.message.includes(id), `${id} is not named in the refusal`);
    assert.ok(error.details.some(row => row.id === 'guest-agent'));
    return true;
  });
});

// ---------------------------------------------------------------------------
// Admission: a guest may not vouch for itself.
//
// Until 2026-09-17 createDisposableGuest admitted on shape alone. Each test
// below is one of the shapes that used to be admitted, and each asserts WHICH
// refusal fired, so a later change that collapses them into one generic error
// is visible here rather than at a cut.
//
// The ADMITTING path is deliberately absent: it needs a qualifying VM and a
// guest credential, and neither exists on this host, so it is unproven rather
// than asserted. See REPORT-T240.
const HOST_VM = '9f1d4c2b-1111-4a2b-8c3d-000000000001';
const HOST_BASELINE = '9f1d4c2b-2222-4a2b-8c3d-000000000002';
const resolvedMachine = { vmId: HOST_VM, vmName: 'ToolsEnabled-Qualification-cut45', baselineId: HOST_BASELINE, state: 'Off' };
const CHALLENGE = 'a'.repeat(64);
const goodAttestation = (overrides = {}) => ({ schema: GUEST_AGENT_SCHEMA, challenge: CHALLENGE,
  virtualMachineId: HOST_VM, baselineId: HOST_BASELINE, traceId: 'native-trace-1', ...overrides });
const admissionRequest = (t, guestAgent, configOverrides = {}) => {
  const { file } = configFile(t, workerConfig({ machineRoot: scratch(t), ...configOverrides }));
  return { product: 'toolsenabled', profile: DISPOSABLE_GUEST_PROFILES[0],
    evidenceRoot: scratch(t), harnessRoot: scratch(t), runnerConfigPath: file, guestAgent };
};
// Returns what admission ACTUALLY did, never just whether it matched. An
// assertion that names only its expectation cannot be diagnosed by whoever
// sees it fail on a host the author never ran on: `error.code` is undefined
// for anything that throws outside the refuseAs path, and reporting a bare
// undefined is how a real defect reads as a mystery.
const admissionOutcome = async (t, guestAgent, configOverrides) => {
  try {
    await createDisposableGuest(admissionRequest(t, guestAgent, configOverrides));
    return { code: 'ADMITTED', message: 'createDisposableGuest returned a guest' };
  } catch (error) {
    return { code: error?.code ?? `UNCODED(${error?.constructor?.name ?? typeof error})`, message: error?.message ?? String(error) };
  }
};
const saw = outcome => `actually got ${outcome.code}: ${outcome.message}`;
// The host decides WHICH refusal admission reaches, so the test measures that
// rather than assuming it. On a host whose node/python/powershell bytes are the
// reviewed ones, admission gets as far as Hyper-V and refuses MACHINE_UNRESOLVED;
// on any other host it refuses TOOLCHAIN_UNAPPROVED before contacting a machine.
// Both are correct, both are named, and the test asserts the right one either
// way instead of passing on whichever interpreter happened to launch it.
// MEASUREMENT AND ITS WIDTH, for everything below.
//
// A mutation proves an assertion is FALSIFIABLE. It does not prove the
// assertion says the RIGHT thing: an assertion can verify a false premise
// faithfully and pass its mutation honestly. So each premise here states what
// was measured and how wide that measurement was.
//
// PREMISE: admission's answer for an unresolvable machine is one of exactly two
//   codes, MACHINE_UNRESOLVED or TOOLCHAIN_UNAPPROVED.
// MEASURED: 2026-09-17, by running this suite under both interpreters present
//   on one Windows 10 x64 host — C:\agent-apps\node-v22.19.0\node.exe
//   (sha256 995a3fb3…, the approved identity) and C:\Program Files\nodejs\
//   node.exe (sha256 33b1bc1a…). The two selected DIFFERENT branches and both
//   agreed with what admission returned.
// WIDTH: TWO INTERPRETERS ON ONE WINDOWS BOX. One OS, one architecture, one
//   Hyper-V configuration, one account. It is not a cross-platform result and
//   must not be read as one.
//
// OUTSIDE THAT WIDTH THE PREMISE IS FALSE, and this is derived from the code
// plus a measurement of the equivalent Windows-reachable path, NOT from a run
// on Linux — no Linux host was available to this lane, so "derived" is the
// honest word:
//   createDisposableGuest calls probeDisposableGuest FIRST. The probe's
//   qualification-host check is satisfied only when
//   `process.platform === 'win32' && process.arch === 'x64'`, so on Linux it is
//   blocked permanently and admission refuses at that first gate with
//   DISPOSABLE_GUEST_BLOCKED — a code that is NOT a member of
//   ADMISSION_REFUSALS. Measured on Windows by making the probe unavailable:
//   `probe unavailable -> DISPOSABLE_GUEST_BLOCKED; is that code in
//   ADMISSION_REFUSALS? false`.
//   So on Linux the two-code premise never applies, assertNamedAdmissionRefusal
//   would fail, and even the shape-only tests never reach their own clause.
//   A consequence worth its own line: resolveQualificationMachine's platform
//   refusal is therefore UNREACHABLE through createDisposableGuest, because the
//   probe rejects a non-Windows host before it is ever called.
//
// THEREFORE THE ADMISSION TESTS ARE GATED TO win32/x64 BELOW. The gate is
// itself an exemption, so its own measurement is stated: it rests on the
// platform condition read from disposable-guest.mjs and on the
// DISPOSABLE_GUEST_BLOCKED measurement above, not on a Linux run. If this suite
// is ever run on Linux, the right change is to MEASURE the off-Windows codes
// and assert them, not to widen these assertions by assumption.
const WINDOWS_ADMISSION = process.platform === 'win32' && process.arch === 'x64';
const OFF_WINDOWS_SKIP = WINDOWS_ADMISSION ? false
  : `admission refuses at the probe's qualification-host check on ${process.platform}/${process.arch}, ` +
    'before any clause these tests assert; the off-Windows codes are underived and must be measured, not assumed';

async function expectedMachineRefusal() {
  // The import is deliberately OUTSIDE the catch. A bare `catch` around both
  // would answer TOOLCHAIN_UNAPPROVED for any failure at all — including a
  // broken import — and could then "agree" with an admission that failed for a
  // completely unrelated reason. Only the measurement itself may select the
  // branch; anything else must throw and fail the test loudly. Caught in this
  // lane when a probe with the wider catch reported the wrong branch under the
  // approved interpreter and still looked plausible.
  const { measureRegisteredToolchain } = await import('../lib/transport/owned-job.mjs');
  try {
    measureRegisteredToolchain();
  } catch (error) {
    assert.match(error.message, /Registered qualification toolchain blocked/,
      `the toolchain discriminator failed for an unexpected reason: ${error.message}`);
    return ADMISSION_REFUSALS.TOOLCHAIN_UNAPPROVED;
  }
  return ADMISSION_REFUSALS.MACHINE_UNRESOLVED;
}
// True on every host: admission refuses, by a NAMED code, before any guest call.
function assertNamedAdmissionRefusal(outcome, label) {
  assert.notEqual(outcome.code, 'ADMITTED', `${label}: admission returned a guest, ${saw(outcome)}`);
  assert.ok(Object.values(ADMISSION_REFUSALS).includes(outcome.code),
    `${label}: admission must refuse by a named code, never an uncoded throw, ${saw(outcome)}`);
}
const attestedAgent = (attest, guestId = HOST_VM) => createAttestedGuestAgent({
  rpc: { call: async (method, payload) => method === 'attest'
    ? attest(payload)
    : { guestId, runId: 'run-1', synthetic: false } },
  attestation: { schema: GUEST_AGENT_SCHEMA, guestId, baselineId: HOST_BASELINE, traceId: 't' },
  runId: 'run-1', guestId });

test('admission refuses a caller-supplied mode constant by its own name', { skip: OFF_WINDOWS_SKIP }, async t => {
  // The exact object that used to be admitted: the right mode string, nothing behind it.
  const declaration = { mode: DISPOSABLE_GUEST_MODE, guestId: HOST_VM };
  const declared = await admissionOutcome(t, declaration);
  assert.equal(declared.code, ADMISSION_REFUSALS.SHAPE_ONLY,
    `mutation \`admit an object that merely declares the attested mode\` survived: expected ${ADMISSION_REFUSALS.SHAPE_ONLY}, ${saw(declared)}`);
  await assert.rejects(() => createDisposableGuest(admissionRequest(t, declaration)), error => {
    assert.match(error.message, /does not implement/);
    assert.match(error.message, /A mode constant is a declaration, not a guest/);
    assert.equal(error.cleanupUnconfirmed, false);
    return true;
  });
});

test('admission refuses a guest whose declared surface is incomplete, naming the missing methods', { skip: OFF_WINDOWS_SKIP }, async t => {
  const partial = { mode: DISPOSABLE_GUEST_MODE, guestId: HOST_VM };
  for (const method of DISPOSABLE_GUEST_METHODS) if (method !== 'launch' && method !== 'stop') partial[method] = async () => ({});
  await assert.rejects(() => createDisposableGuest(admissionRequest(t, partial)), error => {
    assert.equal(error.code, ADMISSION_REFUSALS.SHAPE_ONLY);
    assert.match(error.message, /launch/);
    assert.match(error.message, /stop/);
    return true;
  });
});

test('admission refuses a vmId Hyper-V cannot resolve, and an RPC channel with no machine behind it', { skip: OFF_WINDOWS_SKIP }, async t => {
  // Fully formed agent over a channel that answers nothing: the transport is
  // fine, there is simply no machine. Admission must not get past resolution.
  const agent = attestedAgent(() => { throw new Error('no machine behind this channel'); });
  const expected = await expectedMachineRefusal();
  const unresolved = await admissionOutcome(t, agent);
  assertNamedAdmissionRefusal(unresolved, 'no machine behind the channel');
  assert.equal(unresolved.code, expected,
    `mutation \`admit a guest without resolving its machine\` survived: expected ${expected} on this host, ${saw(unresolved)}`);
  // The machineRoot is a real but empty directory, which is the other half of
  // the original demonstration: an existing path is not a provisioned machine.
  const emptyRoot = await admissionOutcome(t, agent, { machineRoot: scratch(t) });
  assertNamedAdmissionRefusal(emptyRoot, 'empty machineRoot');
  assert.equal(emptyRoot.code, expected,
    `an existing but empty machineRoot must not resolve: expected ${expected} on this host, ${saw(emptyRoot)}`);
});

test('admission never reaches attest() when the machine does not resolve', { skip: OFF_WINDOWS_SKIP }, async t => {
  let attestCalls = 0;
  const agent = attestedAgent(() => { attestCalls += 1; return goodAttestation(); });
  const expected = await expectedMachineRefusal();
  const outcome = await admissionOutcome(t, agent);
  assertNamedAdmissionRefusal(outcome, 'attest must not be reached');
  assert.equal(outcome.code, expected,
    `expected ${expected} before any attest() call on this host, ${saw(outcome)}`);
  assert.equal(attestCalls, 0,
    'mutation `ask the guest to vouch before the host resolved anything` survived: expected no attest() call');
});

test('a stub attestation cannot satisfy the binding: every mismatch shape is refused', () => {
  assert.equal(attestationBindingFailure(goodAttestation(), resolvedMachine, CHALLENGE), null,
    'a complete matching attestation must be the one accepted shape');
  const cases = [
    ['no attestation at all', undefined, /returned no attestation record/],
    ['a bare truthy value', true, /returned no attestation record/],
    // The stub shape: it implements attest() and answers, but has no machine.
    ['a stub that answers without a machine', { schema: GUEST_AGENT_SCHEMA, challenge: CHALLENGE, traceId: 't' }, /no virtualMachineId/],
    ['a guest inside a different machine', goodAttestation({ virtualMachineId: '00000000-0000-4000-8000-00000000dead' }), /but the host resolved/],
    ['a replayed answer to an older challenge', goodAttestation({ challenge: 'b'.repeat(64) }), /cannot be fresh/],
    ['a baseline the host did not resolve', goodAttestation({ baselineId: '00000000-0000-4000-8000-00000000beef' }), /but the host resolved/],
    ['an attestation with no native trace', goodAttestation({ traceId: '' }), /no retained native trace/],
    ['a record of the wrong schema', goodAttestation({ schema: 'toolsenabled.something-else' }), /is not a toolsenabled\.attested-disposable-guest-agent record/],
    ['a guest admitting its own answer is synthetic', goodAttestation({ synthetic: true }), /reported its own attestation as synthetic/],
  ];
  for (const [label, attestation, expected] of cases) {
    const failure = attestationBindingFailure(attestation, resolvedMachine, CHALLENGE);
    assert.ok(failure, 'mutation `accept ' + label + '` survived: expected a refusal');
    assert.match(failure, expected, 'refusal for ' + label + ' lost its distinguishing reason');
  }
});

test('the binding refuses when the host issued no challenge, so admission cannot skip freshness', () => {
  for (const challenge of [undefined, '', 'short', 'z'.repeat(64)]) {
    const failure = attestationBindingFailure(goodAttestation({ challenge }), resolvedMachine, challenge);
    assert.ok(failure, 'mutation `let a guest pick its own challenge` survived: expected a refusal');
    assert.match(failure, /host challenge/);
  }
});

test('every admission refusal stays distinguishable from every other', () => {
  const codes = Object.values(ADMISSION_REFUSALS);
  assert.equal(new Set(codes).size, codes.length,
    `mutation \`collapse two admission refusals onto one code\` survived: expected ${codes.length} distinct codes, got ${new Set(codes).size}`);
  // Each admission clause that can fail has its own name. TOOLCHAIN_UNAPPROVED
  // joined on 2026-09-17: it was previously an uncoded throw, which is how an
  // unapproved interpreter reached a reader as a crash rather than a refusal.
  assert.deepEqual([...codes].sort(), [
    'DISPOSABLE_GUEST_ATTESTATION_MISMATCH',
    'DISPOSABLE_GUEST_ATTESTATION_NOT_EXECUTED',
    'DISPOSABLE_GUEST_MACHINE_UNRESOLVED',
    'DISPOSABLE_GUEST_SHAPE_ONLY',
    'DISPOSABLE_GUEST_TOOLCHAIN_UNAPPROVED',
  ], 'mutation `add or drop an admission refusal without naming it here` survived');
  for (const code of codes) assert.match(code, /^DISPOSABLE_GUEST_/);
});
