import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contains, plainPath, readJson } from '../adapters/artifact-files.mjs';
import { registeredToolPaths } from '../transport/registered-toolchain.mjs';
import { measureRegisteredToolchain } from '../transport/owned-job.mjs';

// A "disposable guest" here is not a sandbox, a redirected install directory, a
// second OS account or a container. tools/lib/drivers/installer-lifecycle.mjs
// refuses anything else in writing ("a real attested disposable guest is
// required; a redirected install directory is not isolation") and
// tools/lib/release-readiness.mjs then refuses the observation again
// (`environment.isolation !== 'disposable-machine'`). It is one dedicated
// Hyper-V machine that:
//   - is owned by this qualification transport alone (the ownership marker
//     tools/lib/transport/QualificationVm.psm1 writes into VM.Notes),
//   - has an exact powered-off baseline checkpoint the host restores before
//     every lifecycle phase and again after the run,
//   - keeps its configuration, paging and whole virtual-disk parent chain
//     inside one dedicated machine directory, with no DVD/ISO attachment,
//   - is connected to no virtual switch at all, so an installer cannot reach
//     the network and a renderer cannot be reached from off the machine,
//   - runs as the same OS account the host measured natively, and
//   - is durably quarantined, never silently reused, whenever any management
//     operation ends uncertain.
// Those two guarantees - isolation and confirmed teardown - are the entire
// reason this scope is called exact. A guest that cannot prove both must
// refuse; it may never downgrade itself to "close enough" and run anyway.
//
// This module is the single place allowed to hand that guest to the driver.
// It is measured into the installed-lifecycle adapter's implementation
// identity (tools/lib/adapters/installed-lifecycle.mjs), so editing it changes
// the registered adapter sha256 and the registry stops matching the contract.

export const DISPOSABLE_GUEST_MODE = 'attested-disposable-guest';
export const DISPOSABLE_GUEST_PROFILES = Object.freeze(['windows-x64-standard', 'windows-x64-administrator']);
export const WORKER_CONFIG_SCHEMA = 'toolsenabled.hyperv-qualification-worker';
export const PROBE_SCHEMA = 'toolsenabled.disposable-guest-precondition-probe';
export const GUEST_AGENT_SCHEMA = 'toolsenabled.attested-disposable-guest-agent';
const EGRESS_HOST_VECTORS = JSON.parse(readFileSync(new URL('../transport/qualification-egress-host-vectors.json', import.meta.url), 'utf8'));
// Exactly the RPC surface installer-lifecycle.mjs checks before it starts a
// phase. A guest missing one of these is refused there by name; the probe
// reports the whole set so an operator learns the real size of the work
// instead of discovering it one refusal at a time.
export const DISPOSABLE_GUEST_METHODS = Object.freeze(['attest', 'verifyObservation', 'preflightArtifacts',
  'resetBaseline', 'restoreBaseline', 'quarantine', 'stageInstaller', 'measureFile', 'observeInstallation',
  'startOwned', 'waitOwned', 'waitInstallerCheckpoint', 'terminateOwned', 'launch', 'stop', 'captureUserContent']);
const WORKER_CONFIG_KEYS = Object.freeze(['schema', 'schemaVersion', 'vmId', 'vmName',
  'baselineCheckpointId', 'machineRoot', 'guestProfile', 'networkPolicy', 'allowedEndpoints', 'egressSwitchName']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VM_NAME = /^ToolsEnabled-Qualification-[a-zA-Z0-9-]+$/;
const isQualificationEgressHost = value => typeof value === 'string' && value.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
for (const endpoint of EGRESS_HOST_VECTORS.valid) if (!isQualificationEgressHost(endpoint)) throw new Error('Egress host validator drifted from shared vectors.');
for (const endpoint of EGRESS_HOST_VECTORS.invalid) if (isQualificationEgressHost(endpoint)) throw new Error('Egress host validator drifted from shared vectors.');

function refuse(message, details = []) {
  const error = new Error(`Disposable guest unavailable: ${message}`);
  error.code = 'DISPOSABLE_GUEST_BLOCKED';
  // Nothing in this module starts a machine, a job or an installer, so a
  // refusal from here never leaves owned state behind. Saying so explicitly
  // keeps the driver's aggregate quarantine path for real uncertainty only.
  error.cleanupUnconfirmed = false;
  error.details = details;
  throw error;
}

function assertAttestation(attestation) {
  if (!attestation || attestation.schema !== GUEST_AGENT_SCHEMA ||
      typeof attestation.guestId !== 'string' || !UUID.test(attestation.guestId) ||
      typeof attestation.baselineId !== 'string' || !UUID.test(attestation.baselineId) ||
      typeof attestation.traceId !== 'string' || !attestation.traceId) {
    throw new Error('Disposable guest agent refused: incomplete native attestation.');
  }
  return Object.freeze({ ...attestation });
}

// Host-side channel for the native guest service. The service is injected by
// the Hyper-V transport; this client never falls back to a local process or a
// redirected directory. Every call carries the retained attestation and the
// caller binding, and every response must be an observation from that guest.
export function createAttestedGuestAgent({ rpc, attestation, runId, guestId } = {}) {
  if (!rpc || typeof rpc.call !== 'function') throw new Error('Disposable guest agent refused: no attested RPC channel.');
  const fixed = assertAttestation(attestation);
  if (fixed.guestId !== guestId || typeof runId !== 'string' || !runId) throw new Error('Disposable guest agent refused: run binding differs from attestation.');
  const call = async (method, payload = {}) => {
    if (!DISPOSABLE_GUEST_METHODS.includes(method)) throw new Error(`Disposable guest agent refused unknown method: ${method}`);
    const response = await rpc.call(method, { ...payload, runId, guestId: fixed.guestId, attestation: fixed });
    if (method === 'verifyObservation') return response === true;
    if (!response || response.guestId !== fixed.guestId || response.runId !== runId || response.synthetic === true) {
      throw new Error(`Disposable guest agent refused unbound ${method} observation.`);
    }
    return response;
  };
  return Object.freeze({ mode: DISPOSABLE_GUEST_MODE, guestId: fixed.guestId,
    ...Object.fromEntries(DISPOSABLE_GUEST_METHODS.map(method => [method, payload => call(method, payload)])) });
}

const satisfied = (id, detail) => ({ id, status: 'satisfied', detail, remedy: null });
const blocker = (id, detail, remedy) => ({ id, status: 'blocked', detail, remedy });
const unchecked = (id, detail, remedy) => ({ id, status: 'not-checked', detail, remedy });

function directory(label, value) {
  if (typeof value !== 'string' || !value) return `${label} was not supplied`;
  if (!path.isAbsolute(value)) return `${label} is not an absolute path: ${value}`;
  try { plainPath(value, { kind: 'directory' }); } catch (error) { return `${label} is not a plain directory: ${error.message}`; }
  return null;
}

// Validates the same fields Assert-QualificationVmConfig enforces on the
// PowerShell side, so an operator sees every malformed field at once instead
// of one Hyper-V throw per attempt. Passing here is NOT admission: the
// PowerShell side re-reads the live VM, its checkpoint and its disk chain and
// is the only thing that may conclude the machine is actually usable.
function workerConfigCheck(runnerConfigPath, machineRootOut) {
  if (runnerConfigPath === undefined || runnerConfigPath === null) {
    return blocker('worker-config', 'the qualification context carries no runnerConfigPath',
      'Write the dedicated worker description and pass its absolute path as the qualification context\'s runnerConfigPath, ' +
      'inside the private evidence directory and outside the product stage.');
  }
  let config;
  try { config = readJson(plainPath(runnerConfigPath, { kind: 'file' })); }
  catch (error) { return blocker('worker-config', `runnerConfigPath is unreadable: ${error.message}`, 'Supply a readable ordinary JSON file at runnerConfigPath.'); }
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) problems.push('the worker description is not a JSON object');
  else {
    for (const key of Object.keys(config)) if (!WORKER_CONFIG_KEYS.includes(key)) problems.push(`unknown field ${key}`);
    for (const key of WORKER_CONFIG_KEYS.slice(0, 8)) if (!Object.hasOwn(config, key)) problems.push(`missing field ${key}`);
    if (config.schema !== WORKER_CONFIG_SCHEMA || config.schemaVersion !== 1) problems.push(`schema must be ${WORKER_CONFIG_SCHEMA} version 1`);
    if (!VM_NAME.test(config.vmName || '')) problems.push('vmName must match ToolsEnabled-Qualification-<name>');
    if (!UUID.test(config.vmId || '')) problems.push('vmId must be the dedicated machine\'s GUID');
    if (!UUID.test(config.baselineCheckpointId || '')) problems.push('baselineCheckpointId must be the powered-off baseline checkpoint\'s GUID');
    if (!['offline', 'allow-list'].includes(config.networkPolicy)) problems.push('networkPolicy must be offline or allow-list');
    if (config.networkPolicy === 'offline' && (config.allowedEndpoints?.length || config.egressSwitchName)) problems.push('offline policy cannot carry an egress allow-list or switch');
    if (config.networkPolicy === 'allow-list') {
      if (!Array.isArray(config.allowedEndpoints) || config.allowedEndpoints.length < 1 || config.allowedEndpoints.length > 32) problems.push('allow-list policy requires 1 to 32 endpoints');
      else if (config.allowedEndpoints.some(endpoint => !isQualificationEgressHost(endpoint))) problems.push('allow-list entries must be explicit endpoint names; wildcards, CIDR and malformed schemes are refused');
      if (typeof config.egressSwitchName !== 'string' || !/^ToolsEnabled-Qualification-Egress-[a-zA-Z0-9-]+$/.test(config.egressSwitchName)) problems.push('allow-list policy requires its dedicated egress switch');
    }
    const machineRoot = directory('machineRoot', config.machineRoot);
    if (machineRoot) problems.push(machineRoot);
    else machineRootOut.value = path.resolve(config.machineRoot);
    if (typeof config.guestProfile !== 'string' || !config.guestProfile) problems.push('guestProfile must name the owning account profile the guest will attest');
  }
  if (problems.length) {
    return blocker('worker-config', problems.join('; '),
      `Correct the worker description at ${runnerConfigPath}; Assert-QualificationVmConfig in tools/lib/transport/QualificationVm.psm1 enforces the same fields.`);
  }
  return satisfied('worker-config', `dedicated machine ${config.vmName} (${config.vmId}), baseline checkpoint ${config.baselineCheckpointId}, networkPolicy offline`);
}

/**
 * Read-only precondition report. It starts no machine, spawns no child, writes
 * nothing and never throws for a missing prerequisite: an operator on either
 * platform gets the complete list in one call. `available` can only become
 * true when every check is satisfied, and the guest-agent check below is
 * currently unsatisfiable by construction, so it is always false today.
 */
export function probeDisposableGuest({ product, profile, evidenceRoot, harnessRoot, runnerConfigPath, guestAgent } = {}) {
  const checks = [];
  const onHost = process.platform === 'win32' && process.arch === 'x64';
  checks.push(typeof product === 'string' && product
    ? satisfied('product', `qualifying ${product}`)
    : blocker('product', 'no product was named', 'Call createDisposableGuest with the measured subject\'s product.'));
  checks.push(DISPOSABLE_GUEST_PROFILES.includes(profile)
    ? satisfied('profile', `requested runtime profile ${profile}`)
    : blocker('profile', `unsupported runtime profile ${JSON.stringify(profile ?? null)}`,
      `Request one of ${DISPOSABLE_GUEST_PROFILES.join(', ')}; the contract has no other installed runtime profile.`));
  checks.push(onHost
    ? satisfied('qualification-host', `Windows x64 host, OS build ${os.release()}`)
    : blocker('qualification-host', `this host is ${process.platform}/${process.arch}`,
      'Run qualification on the Windows x64 cutter. The readiness contract targets win32/x64 and the installer lifecycle ' +
      'is executed by Hyper-V, NSIS and native Windows job objects; no Linux or emulated host can stand in for it.'));
  const machineRootOut = { value: null };
  const evidence = directory('evidenceRoot', evidenceRoot);
  checks.push(evidence
    ? blocker('evidence-root', evidence, 'Pass the qualification context\'s private evidence directory; it must already exist and contain no links.')
    : satisfied('evidence-root', 'private evidence directory is a plain existing directory'));
  const harness = directory('harnessRoot', harnessRoot);
  checks.push(harness
    ? blocker('harness-root', harness, 'Pass the qualification context\'s harness checkout.')
    : satisfied('harness-root', 'harness checkout is a plain existing directory'));
  checks.push(workerConfigCheck(runnerConfigPath, machineRootOut));
  // Invoke-QualificationVmRun refuses an evidence root inside the machine
  // directory because restoring the baseline would destroy the evidence that
  // says what happened. Check it here too, before any VM is touched.
  if (machineRootOut.value && !evidence) {
    const inside = contains(machineRootOut.value, path.resolve(evidenceRoot)) || contains(path.resolve(evidenceRoot), machineRootOut.value);
    checks.push(inside
      ? blocker('evidence-survives-teardown', 'the private evidence directory and the disposable machine directory contain one another',
        'Move the private evidence directory outside the machine directory. Restoring the baseline discards everything inside the machine tree, including a report written there.')
      : satisfied('evidence-survives-teardown', 'evidence is stored outside the disposable machine tree'));
  } else checks.push(unchecked('evidence-survives-teardown', 'the machine directory is unknown until the worker description validates',
    'Fix the worker description first.'));
  checks.push(onHost
    ? unchecked('hyperv-host', 'Hyper-V presence, the administrator token and the Hyper-V cmdlets are measured by PowerShell, not by this module',
      'Run: powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\\lib\\transport\\Probe-QualificationHost.ps1  (exit 0 = available, exit 2 = the printed blockers apply).')
    : unchecked('hyperv-host', 'not measurable off a Windows host', 'Re-run this probe on the Windows cutter.'));
  // The structural gap, and the reason `available` is false even on a fully
  // provisioned Hyper-V host. Invoke-QualificationVmRun is a one-shot batch
  // transport: it restores the baseline, copies driver.ps1 plus request.json
  // in, runs that script to completion, reads back one bounded result.json and
  // restores the baseline again. installer-lifecycle.mjs instead drives an
  // interleaved session - resetBaseline, install, observeInstallation, launch,
  // then live CDP reads and native input against the running renderer, stop,
  // repeat per phase - and the guest has no virtual switch, so the host cannot
  // reach the guest's loopback CDP endpoint at all. Nothing in the tree spans
  // that gap, and inventing one here would mean inventing its evidence too.
  checks.push(guestAgent && typeof guestAgent === 'object' && guestAgent.mode === DISPOSABLE_GUEST_MODE
    ? satisfied('guest-agent', `an object declaring ${DISPOSABLE_GUEST_MODE} (${guestAgent.guestId}) was supplied. ` +
      'This row is a SHAPE check and is not admission: this probe starts nothing, so it cannot tell a real guest from a ' +
      'declaration. createDisposableGuest resolves the machine through Get-QualificationVm and requires an executed ' +
      'attest() that matches it.')
    : blocker('guest-agent', 'no attested guest agent implements the disposable-guest RPC session',
    `Build the guest-side agent and its host channel for all ${DISPOSABLE_GUEST_METHODS.length} methods (${DISPOSABLE_GUEST_METHODS.join(', ')}). ` +
    'The per-method obligations are the comment block at the end of tools/lib/drivers/installer-lifecycle.mjs. It must hold native ' +
    'owned-job and token handles across calls, carry the guest\'s CDP page target back to the host, and verifyObservation must bind ' +
    'every raw observation to the retained native trace. tools/lib/transport/QualificationVm.psm1 supplies only a one-shot batch run ' +
    'and cannot serve this session as written.'));
  const blockers = checks.filter(check => check.status === 'blocked').map(check => check.id);
  return {
    schema: PROBE_SCHEMA, schemaVersion: 1, scope: 'guest-precondition-probe',
    authority: 'Read-only precondition description. No machine, installer, job or product was started, and this report is not qualification evidence.',
    product: typeof product === 'string' ? product : null, profile: DISPOSABLE_GUEST_PROFILES.includes(profile) ? profile : null,
    mode: DISPOSABLE_GUEST_MODE, methods: [...DISPOSABLE_GUEST_METHODS],
    host: { platform: process.platform, arch: process.arch, osBuild: os.release() },
    measuredAt: new Date().toISOString(), checks, blockers, available: blockers.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Admission.
//
// Everything above this line is shape: JSON fields that match a regex, and an
// object carrying the right `mode` string. Shape is not a machine. Until
// 2026-09-17 admission was shape alone, and it would return a guest for a
// `vmId` that `Get-VM` could not find, against a `machineRoot` that was an
// empty directory, over an RPC channel with nothing behind it, without ever
// calling `attest`. What stopped a fabricated guest reaching the driver was
// that no caller passed `guestAgent` at all - wiring, not an assertion.
//
// The rule these four refusals enforce: A GUEST MAY NOT VOUCH FOR ITSELF.
// `attest()` returning something that looks right proves nothing, because the
// same object supplies both the claim and the evidence for it. So the host
// resolves the machine independently through Get-QualificationVm - which reads
// the live VM, its ownership marker, its powered-off baseline checkpoint, its
// switchless state and its disk chain - and the attestation must then match
// facts that resolution produced:
//   - `virtualMachineId`, which a Windows guest reads from its own registry at
//     HKLM\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters\VirtualMachineId
//     and only a process actually inside that VM can report correctly, and
//   - `baselineId`, which must be the checkpoint Hyper-V resolved, not the one
//     the caller wrote in the worker description, and
//   - a fresh host `challenge`, so a recorded reply cannot be replayed.
// A stub implementing attest() can echo the challenge. It cannot produce a
// virtualMachineId for a VM it is not running inside, and it never reaches the
// comparison anyway unless a real machine resolved first.
//
// The positive path - a guest that actually passes all four - is UNPROVEN
// here. No qualifying VM and no guest credential exist on this host, so every
// test below is a refusal test. See REPORT-T240.
const CHALLENGE_BYTES = 32;
const SHAPE_ONLY = 'DISPOSABLE_GUEST_SHAPE_ONLY';
const TOOLCHAIN_UNAPPROVED = 'DISPOSABLE_GUEST_TOOLCHAIN_UNAPPROVED';
const MACHINE_UNRESOLVED = 'DISPOSABLE_GUEST_MACHINE_UNRESOLVED';
const ATTESTATION_NOT_EXECUTED = 'DISPOSABLE_GUEST_ATTESTATION_NOT_EXECUTED';
const ATTESTATION_MISMATCH = 'DISPOSABLE_GUEST_ATTESTATION_MISMATCH';
export const ADMISSION_REFUSALS = Object.freeze({ SHAPE_ONLY, TOOLCHAIN_UNAPPROVED, MACHINE_UNRESOLVED, ATTESTATION_NOT_EXECUTED, ATTESTATION_MISMATCH });

function refuseAs(code, message) {
  const error = new Error(`Disposable guest unavailable: ${message}`);
  error.code = code;
  // Admission starts no job and no installer. resolveQualificationMachine runs
  // one read-only Hyper-V query and starts no VM, so a refusal from here never
  // leaves owned state behind and must not push the driver into quarantine.
  error.cleanupUnconfirmed = false;
  throw error;
}

// An object carrying the mode constant is not an agent. createAttestedGuestAgent
// builds every method as a bound call over the attested channel; anything that
// merely declares the constant is refused here by its own name.
function assertCallableGuestSurface(agent) {
  if (!agent || typeof agent !== 'object' || agent.mode !== DISPOSABLE_GUEST_MODE) {
    refuseAs(SHAPE_ONLY, 'the supplied guest does not carry the attested disposable-guest mode.');
  }
  const missing = DISPOSABLE_GUEST_METHODS.filter(method => typeof agent[method] !== 'function');
  if (missing.length) {
    refuseAs(SHAPE_ONLY, `the supplied object carries ${DISPOSABLE_GUEST_MODE} but does not implement ` +
      `${missing.length} of the ${DISPOSABLE_GUEST_METHODS.length} RPC methods (${missing.join(', ')}). ` +
      'A mode constant is a declaration, not a guest; build the agent with createAttestedGuestAgent over a real channel.');
  }
  if (!UUID.test(agent.guestId || '')) {
    refuseAs(SHAPE_ONLY, 'the supplied guest carries no guest identity from a native attestation.');
  }
}

// Resolves the machine THROUGH THE POWERSHELL AUTHORITY, not through the
// caller's JSON. Get-QualificationVm calls Assert-QualificationVmConfig itself
// and then re-reads the live VM; this function adds no admission of its own and
// deliberately cannot be overridden by a caller. It starts nothing: the whole
// script is Get-* queries against a machine that must already be powered off.
// THE TOOLCHAIN SEAM, AND WHY IT IS HERE AND NOT ON THE PUBLIC ENTRY.
//
// The two admission tests used to compute their EXPECTATION from the same
// measureRegisteredToolchain the product calls, so a wrong oracle moved product
// and expectation together and the suite stayed green in BOTH directions —
// including the one that matters: an oracle that always passes admits an
// unapproved host past this gate to the PowerShell step, which is the boundary
// FAILING OPEN behind a green test.
//
// createDisposableGuest deliberately takes NO such parameter. A public
// injection point for the toolchain measurement would let any caller hand in a
// no-op and walk through the gate — it would create in production exactly the
// fail-open that was only ever simulated, which is a far worse trade than the
// test problem it would solve. The comment above resolveQualificationMachine
// says this function "adds no admission of its own and deliberately cannot be
// overridden by a caller", and that stays true of the public path.
//
// So the seam is on the PRIVATE function, defaulted, and reached only through
// the test-only export at the bottom of this module. createDisposableGuest
// calls resolveQualificationMachine with ONE argument and cannot be made to do
// otherwise. node:test's mock.module was tried first, as the preferred route
// with no new surface at all: it is unavailable in this runner without
// --experimental-test-module-mocks, which the repository's chain does not pass,
// so a routing test built on it would never actually run.
function resolveQualificationMachine(runnerConfigPath, measureToolchain = measureRegisteredToolchain) {
  if (process.platform !== 'win32') {
    refuseAs(MACHINE_UNRESOLVED, `the disposable machine can only be resolved on a Windows host, not ${process.platform}. ` +
      'Hyper-V is the only reviewed transport for this scope.');
  }
  // Refuses unless the interpreter's bytes are one of the reviewed identities
  // in transport/registered-toolchain.mjs. Relocation does not approve bytes.
  //
  // This MUST refuse by name. Until 2026-09-17 the call was bare, so an
  // unapproved toolchain threw a plain uncoded Error straight out of
  // admission: the caller could not tell "this host's tools are not the
  // reviewed ones" from a crash, and the failure carried no refusal identity
  // at all. Measured: running the suite under a second node on the same box
  // (sha256 33b1bc1a…, against the approved 995a3fb3…) failed exactly the two
  // tests that reach this line, with `UNCODED(Error): Registered qualification
  // toolchain blocked: unapproved node path or executable bytes`.
  //
  // It is deliberately NOT folded into MACHINE_UNRESOLVED. The machine was
  // never asked about; the host's own tools were refused before any question
  // reached Hyper-V. Collapsing the two would make an unapproved interpreter
  // read as a missing VM, which is a different remedy for a different person.
  try {
    measureToolchain();
  } catch (error) {
    refuseAs(TOOLCHAIN_UNAPPROVED, `the qualification toolchain on this host is not the reviewed one: ${error?.message || error}. ` +
      'Run the cut on the registered interpreter; relocation does not approve bytes, and no machine was contacted.');
  }
  const powershell = registeredToolPaths().powershell;
  const module = fileURLToPath(new URL('../transport/QualificationVm.psm1', import.meta.url));
  // Get-QualificationVm is deliberately NOT in the module's Export-ModuleMember
  // list. Calling it in the module's own scope uses that authority without
  // widening the module's public surface, which would be a weakening.
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$module = Import-Module -Name ${quotePowerShell(module)} -Force -PassThru`,
    `$config = Get-Content -LiteralPath ${quotePowerShell(runnerConfigPath)} -Raw | ConvertFrom-Json`,
    '$resolved = & $module { param($c) Get-QualificationVm $c } $config',
    '$vm = $resolved.VM',
    '@{ vmId = [string]$vm.Id; vmName = [string]$vm.Name; state = [string]$vm.State;',
    '   baselineId = [string]$resolved.Snapshot.Id; baselineState = [string]$resolved.Snapshot.State',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.signal || result.status !== 0) {
    const reason = (result.stderr || '').trim().split(/\r?\n/).filter(Boolean)[0] ||
      result.error?.message || `exit ${result.status ?? result.signal}`;
    refuseAs(MACHINE_UNRESOLVED, `Get-QualificationVm did not resolve the declared machine: ${reason}`);
  }
  let value;
  try { value = JSON.parse(result.stdout); }
  catch { refuseAs(MACHINE_UNRESOLVED, 'Get-QualificationVm returned no readable machine identity.'); }
  if (!UUID.test(value?.vmId || '') || !UUID.test(value?.baselineId || '') || !VM_NAME.test(value?.vmName || '')) {
    refuseAs(MACHINE_UNRESOLVED, 'the resolved machine identity is incomplete.');
  }
  if (value.baselineState !== 'Off') {
    refuseAs(MACHINE_UNRESOLVED, `the resolved baseline checkpoint is ${value.baselineState}, not a powered-off checkpoint.`);
  }
  return Object.freeze({ vmId: value.vmId.toLowerCase(), vmName: value.vmName,
    baselineId: value.baselineId.toLowerCase(), state: value.state });
}

function quotePowerShell(value) {
  if (typeof value !== 'string' || !value || /['\r\n\0]/.test(value)) {
    refuseAs(MACHINE_UNRESOLVED, 'the worker description path is not a quotable ordinary path.');
  }
  return `'${value}'`;
}

/**
 * Pure comparison of what the guest said against what the HOST resolved. It is
 * exported so every mismatch shape is asserted directly by
 * tools/test/disposable-guest-contract.test.mjs: the positive path needs a real
 * VM and a guest credential, neither of which exists on this host, so the table
 * of rejections is the only thing that can be proved today.
 *
 * It takes the resolved machine as an argument but is never reachable from
 * createDisposableGuest with a caller-supplied machine - admission resolves it
 * through resolveQualificationMachine, which accepts no override.
 */
export function attestationBindingFailure(attestation, machine, challenge) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return 'the guest returned no attestation record';
  if (attestation.schema !== GUEST_AGENT_SCHEMA) return `the attestation is not a ${GUEST_AGENT_SCHEMA} record`;
  if (attestation.synthetic === true) return 'the guest reported its own attestation as synthetic';
  if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge)) return 'no host challenge was issued for this admission';
  if (attestation.challenge !== challenge) return 'the attestation does not echo this admission\'s host challenge, so it cannot be fresh';
  const guestVm = typeof attestation.virtualMachineId === 'string' ? attestation.virtualMachineId.toLowerCase() : null;
  if (!guestVm || !UUID.test(guestVm)) {
    return 'the attestation carries no virtualMachineId measured inside the guest, so nothing ties it to a machine';
  }
  if (guestVm !== machine.vmId) {
    return `the guest reports it is running inside virtual machine ${guestVm}, but the host resolved ${machine.vmId}`;
  }
  const baseline = typeof attestation.baselineId === 'string' ? attestation.baselineId.toLowerCase() : null;
  if (baseline !== machine.baselineId) {
    return `the attestation names baseline checkpoint ${baseline ?? 'none'}, but the host resolved ${machine.baselineId}`;
  }
  if (typeof attestation.traceId !== 'string' || !attestation.traceId) return 'the attestation carries no retained native trace identity';
  return null;
}

function assertAttestationBinds(attestation, machine, challenge) {
  const failure = attestationBindingFailure(attestation, machine, challenge);
  if (failure) {
    refuseAs(ATTESTATION_MISMATCH, `${failure}. A guest may not vouch for itself: the attestation must match the ` +
      'machine identity the host resolved independently through Get-QualificationVm.');
  }
}

/**
 * The only supported way for the installed-lifecycle adapters to obtain a
 * guest. It returns an object only after the host has independently resolved
 * the declared disposable machine and that machine's own guest has answered a
 * fresh challenge with an attestation that matches it; otherwise it refuses,
 * naming which of the four admission clauses failed. There is deliberately no
 * partial mode and no override: a half-capable guest would be driven into a
 * phase it cannot finish, and an uncertain phase is exactly the state the
 * quarantine path exists to avoid.
 */
export async function createDisposableGuest(request = {}) {
  const report = probeDisposableGuest(request);
  if (!report.available) {
    const details = report.checks.filter(check => check.status !== 'satisfied');
    refuse(`${report.blockers.length} prerequisite(s) are not met (${report.blockers.join(', ')}). ` +
      details.map(check => `${check.id}: ${check.detail}. ${check.remedy}`).join(' '), details);
  }
  // The probe above is a SHAPE check and nothing more: it reads JSON and looks
  // at an object's `mode`. Admission below is where a real machine has to turn
  // up. The three steps are ordered so the cheap, purely local refusals happen
  // before anything spawns, and so each failure has its own name.
  const agent = request.guestAgent;
  assertCallableGuestSurface(agent);
  const machine = resolveQualificationMachine(request.runnerConfigPath);
  const challenge = randomBytes(CHALLENGE_BYTES).toString('hex');
  let attestation;
  try { attestation = await agent.attest({ challenge, vmId: machine.vmId }); }
  catch (error) { refuseAs(ATTESTATION_NOT_EXECUTED, `the guest did not complete attest(): ${error?.message || error}`); }
  assertAttestationBinds(attestation, machine, challenge);
  return agent;
}

/**
 * TEST-ONLY SEAM. Resolves the declared machine with an injected toolchain
 * measurement so the ROUTING can be asserted host-independently: a measurement
 * that RETURNS must route to the machine refusal, one that THROWS must route to
 * the toolchain refusal. Without this the tests can only observe whichever
 * branch the running interpreter happens to take, and an oracle shared with the
 * product moves both sides together.
 *
 * THIS CANNOT ADMIT ANYTHING. It resolves a machine or throws; it never returns
 * a guest, never calls attest, and createDisposableGuest does not accept it or
 * any measurement of its own. Handing a no-op here buys a caller nothing except
 * a machine record they must still match an attestation against.
 */
export function resolveQualificationMachineForTest(runnerConfigPath, measureToolchain) {
  if (typeof measureToolchain !== 'function') throw new TypeError('the test seam requires an explicit toolchain measurement');
  return resolveQualificationMachine(runnerConfigPath, measureToolchain);
}
