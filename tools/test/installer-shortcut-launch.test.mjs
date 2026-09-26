import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeInstallerLifecycle, executeInstallerLifecycleFixture, INSTALLER_IDENTITIES } from '../lib/drivers/installer-lifecycle.mjs';
import { DESKTOP_JOURNEYS } from '../lib/drivers/desktop-journeys.mjs';
import { readinessDigest } from '../lib/release-readiness.mjs';

// All guest operations below are in-memory synthetic mechanics. The Windows
// strings are contract data only: no Windows filesystem, process, account,
// registry, shortcut activation, provider or transport is touched by this test.
const PROFILE = path.win32.normalize(os.userInfo().homedir);
const sha = value => createHash('sha256').update(value).digest('hex');
const measured = value => ({ sha256: sha(value), bytes: Buffer.byteLength(value) });
const subject = name => ({ artifact: measured(`synthetic installer ${name}`), runtimeSha256: sha(`synthetic runtime ${name}`), shellSha256: sha(`synthetic shell ${name}`) });
const CANDIDATE = subject('candidate'), BASELINES = [subject('previous'), subject('oldest-supported')];
const profileToken = profile => profile.endsWith('administrator') ? 'administrator' : 'standard';
const clone = value => structuredClone(value);

function inventoryFor(product) {
  const identity = INSTALLER_IDENTITIES[product];
  return {
    schemaVersion: 1, product,
    supportedBaselines: BASELINES.map((value, i) => ({ id: `baseline-${i}`, version: `1.0.${i}`, subject: value, contentLayout: 'current' })),
    dataPolicy: { id: 'synthetic-policy', declaration: 'policy.md', uninstallModes: [...identity.uninstallModes], contentKinds: [...identity.contentKinds], contentRoots: [...identity.contentRoots] },
    interruptionPolicy: { points: ['fresh-install-files-written', 'upgrade-files-written', 'uninstall-files-removed'], recovery: 'rerun-exact-candidate-and-reopen' },
  };
}

function mechanics({ product = 'scribe', profile = 'windows-x64-standard', synthetic = true, mutate = () => {}, rejectVerification } = {}) {
  const identity = INSTALLER_IDENTITIES[product], inventory = inventoryFor(product), runId = randomUUID();
  const records = { calls: [], launches: [], commands: [], checkpoints: [], verified: [], journeys: [], stops: 0, restores: 0, quarantines: 0 };
  const staged = new Map(), jobs = new Map(), sessions = new Map();
  let observationSequence = 0, pid = 1000, installed = null, marker = null, initialized = false, policy = 'ask', dataGeneration = 0;
  let userDataIdentity, origin = 'http://127.0.0.1:41234', url = `${origin}/`, lastSelector, focusedSelector;
  const input = new Map();
  const process = () => ({ pid: ++pid, startedAt: new Date(1700000000000 + pid * 1000).toISOString() });
  const shortcutBytes = () => measured(`synthetic shortcut ${product} ${readinessDigest(installed)}`);
  const target = path.win32.join(identity.installDir, identity.runtime);
  const args = identity.shortcutArgs.map(value => value.replace('{installDir}', identity.installDir));
  const alter = (kind, value, context) => { mutate(kind, value, context, records); return value; };
  const observe = (kind, context, value = {}) => {
    records.calls.push(kind);
    return alter(kind, { kind, observationId: `synthetic-observation-${++observationSequence}`, runId, guestId: 'synthetic-guest', synthetic,
      phaseId: context.phaseId ?? null, epochId: context.epochId, journeyId: null, ...value }, context);
  };
  function clearData() { marker = null; initialized = false; policy = 'ask'; input.clear(); userDataIdentity = `synthetic-user-data-${++dataGeneration}`; }
  function fileIdentity(filename) {
    if (staged.has(filename)) return staged.get(filename).artifact;
    if (filename === identity.shortcut) { assert.ok(installed); return shortcutBytes(); }
    if (filename === path.win32.join(identity.installDir, identity.uninstaller)) { assert.ok(installed); return measured(`synthetic uninstaller ${product}`); }
    throw new Error(`Unimplemented synthetic file ${filename}`);
  }
  function applyJob(job) {
    const state = jobs.get(job.jobId);
    if (state.applied) return;
    state.applied = true;
    if (state.command.token === 'administrator' && identity.elevatedSetupExitCode !== null) return;
    if (state.subject) installed = state.subject;
    else { installed = null; if (policy === 'remove-everything') clearData(); }
  }
  const cdp = {
    async send(method, params) {
      records.calls.push(method);
      if (method === 'Runtime.evaluate') {
        // Parse only the driver's serialized selector argument, never eval JS.
        const spec = JSON.parse(params.expression.slice(params.expression.lastIndexOf('})(') + 3, -1));
        const selector = typeof spec === 'string' ? spec : spec.selector;
        lastSelector = selector;
        const row = { text: '', value: input.get(selector), visible: true, disabled: false, pressed: 'true', x: 10, y: 20 };
        if (selector === '#saved') row.text = 'Saved. Restart to apply server settings.';
        if (selector === '#refusal') return { result: { value: { url, rows: [] } } };
        if (selector === '.setup-title') row.text = `Signed in as Lifecycle ${marker}`;
        if (selector === '#paper .para' || selector === '#deckTitle') row.text = `Retained ${marker}`;
        if (selector === '#chrome-path') row.text = `qualification-${marker}.html`;
        if (selector === 'h1') row.text = `Edited ${marker}`;
        if (selector === 'p') row.text = `Durable content ${marker}`;
        return { result: { value: { url, rows: [row] } } };
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        focusedSelector = lastSelector;
        if (lastSelector === '[data-setup-next="finish"]') { initialized = true; url = `${origin}/#/home`; }
        if (lastSelector === 'a.start') { initialized = true; url = `${origin}/`; }
        if (lastSelector === '[data-account-form="create"] button[type="submit"]') marker = input.get('[data-account-form="create"] [name="displayName"]').replace('Lifecycle ', '');
        const selected = /\[data-setting-value="([^"]+)"\]/.exec(lastSelector);
        if (selected) policy = selected[1];
      } else if (method === 'Input.insertText') input.set(focusedSelector, params.text);
      else if (method === 'Page.navigate') url = params.url;
      else assert.ok(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent'].includes(method), `Unexpected synthetic CDP method: ${method}`);
      return {};
    },
  };
  const guest = {
    mode: synthetic ? 'fixture' : 'attested-disposable-guest',
    async attest(context) {
      return observe('guest-attestation', context, { baselineId: 'synthetic-powered-off-baseline', isolation: 'disposable-machine', dedicated: true, poweredOffBaseline: true,
        accountProfile: PROFILE, inventorySha256: context.inventory.sha256, capabilitiesComplete: true, capabilities: [...context.requirements] });
    },
    async verifyObservation(value, context) {
      records.verified.push({ kind: value.kind, context: clone(context), value: clone(value) });
      if (context.kind === 'runtime-launch') {
        assert.ok(Object.isFrozen(context.launchRequest));
        assert.equal(context.launchRequest.mechanism, 'installed-start-menu-shortcut');
        assert.equal(context.launchRequest.shortcut.path, identity.shortcut);
      }
      return value.kind !== rejectVerification;
    },
    async preflightArtifacts(context) { return observe('artifact-preflight', context, { artifacts: context.artifacts.map(value => ({ ...value, available: true })) }); },
    async resetBaseline(context) {
      assert.equal([...sessions.values()].filter(row => !row.stopped).length, 0);
      installed = null; clearData();
      return observe('baseline-reset', context, { epochId: randomUUID(), baselineId: context.baselineId, restored: true, ownedJobsRemaining: 0, cleanUserData: true, accountProfile: PROFILE });
    },
    async restoreBaseline(context) {
      records.restores++;
      assert.equal([...sessions.values()].filter(row => !row.stopped).length, 0);
      return observe('baseline-restored', context, { baselineId: context.baselineId, poweredOff: true, restored: true, ownedJobsRemaining: 0 });
    },
    async quarantine(context) { records.quarantines++; return observe('guest-quarantine', context, { quarantined: true, leaseId: 'synthetic-quarantine-lease', markerSha256: sha('synthetic durable quarantine') }); },
    async stageInstaller(context) {
      const value = [CANDIDATE, ...BASELINES].find(row => row.artifact.sha256 === context.artifact.sha256);
      assert.ok(value, 'only the exact candidate or declared baseline may be staged');
      const filename = `${PROFILE}\\AppData\\Local\\Temp\\synthetic-lifecycle\\${value.artifact.sha256}.exe`;
      staged.set(filename, value);
      return observe('installer-stage', context, { path: filename, artifact: value.artifact, owned: true, reparse: false });
    },
    async measureFile(context) {
      let text;
      if (context.readText) text = context.path.endsWith('uninstall-data-policy.txt') ? `${policy}\n` : 'YOUR DATA IS STILL ON THIS COMPUTER\n';
      return observe('file', context, { path: context.path, ...(text ? { ...measured(text), text } : fileIdentity(context.path)), owned: true, reparse: false });
    },
    async observeInstallation(context) {
      const uninstaller = path.win32.join(identity.installDir, identity.uninstaller);
      return observe('installation', context, { profileRoot: PROFILE, installDir: identity.installDir, reparsePoints: [], unreadable: [], duplicateIdentities: [],
        registry: { hive: 'HKCU', key: identity.registryKey, view: '64', present: !!installed, uninstallExecutable: installed ? uninstaller : null,
          values: installed ? { DisplayName: identity.displayName, Publisher: 'ToolsEnabled', UninstallString: `"${uninstaller}"${product === 'toolsenabled' ? ' /currentuser' : ''}`,
            QuietUninstallString: `"${uninstaller}" /currentuser /S` } : {} },
        artifact: installed?.artifact, subjectSha256: installed ? readinessDigest(installed) : null,
        files: installed ? [{ relativePath: identity.runtime, sha256: installed.runtimeSha256 }, { relativePath: identity.shell, sha256: installed.shellSha256 }, { relativePath: identity.uninstaller, ...fileIdentity(uninstaller) }] : [],
        shortcuts: installed ? [{ path: identity.shortcut, target, args: [...args], ...shortcutBytes() }] : [],
      });
    },
    async startOwned(context) {
      const command = context.command;
      assert.equal(command.shell, false); assert.equal(command.hidden, true); assert.ok(Object.isFrozen(command));
      assert.equal(command.installerIdentity, product); assert.ok(!command.args.some(value => /^\/D=/i.test(value)));
      assert.deepEqual(command.args, staged.has(command.executable) ? ['/S'] : [...identity.uninstallArgs, `_?=${identity.installDir}`]);
      const job = observe('job-start', context, { jobId: randomUUID(), leaseId: randomUUID(), process: process(), killOnClose: true, breakawayAllowed: false,
        token: command.token, executable: fileIdentity(command.executable), commandSha256: readinessDigest(command) });
      jobs.set(job.jobId, { command, subject: staged.get(command.executable), applied: false, interrupted: false });
      records.commands.push(clone(command)); return job;
    },
    async waitInstallerCheckpoint(job, context) {
      applyJob(job); records.checkpoints.push(context.point);
      return observe('installer-checkpoint', context, { jobId: job.jobId, leaseId: job.leaseId, process: job.process, alive: true,
        point: context.point, relativePath: context.relativePath, operation: context.point === 'uninstall-files-removed' ? 'delete' : 'write', changeObserved: true, eventTraceSha256: sha(`synthetic checkpoint ${context.point}`) });
    },
    async terminateOwned(job, context) {
      jobs.get(job.jobId).interrupted = true;
      return observe('job-terminate', context, { jobId: job.jobId, leaseId: job.leaseId, process: job.process, terminationConfirmed: true, ownedChildrenConfirmed: true });
    },
    async waitOwned(job, context) {
      applyJob(job);
      const state = jobs.get(job.jobId);
      return observe('job-exit', context, { jobId: job.jobId, leaseId: job.leaseId, process: job.process, terminationConfirmed: true, ownedChildrenConfirmed: true, activeProcesses: 0,
        exitCode: state.interrupted ? 1 : state.command.token === 'administrator' && identity.elevatedSetupExitCode !== null ? 740 : 0,
        interrupted: state.interrupted, finishedAt: new Date(Date.parse(job.process.startedAt) + 1000).toISOString() });
    },
    async launch(context) {
      assert.ok(installed); assert.equal(records.calls.at(-1), 'file', 'activation must follow a fresh shortcut measurement');
      const request = context.launchRequest;
      assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.shortcut)); assert.ok(Object.isFrozen(request.resolvedArgs));
      assert.equal(request.mechanism, 'installed-start-menu-shortcut');
      assert.deepEqual(request.shortcut, { path: identity.shortcut, ...shortcutBytes() });
      assert.equal(request.resolvedTarget, target); assert.deepEqual(request.resolvedArgs, args);
      assert.equal(request.token, profileToken(profile)); assert.equal(request.subjectSha256, readinessDigest(installed));
      assert.ok(request.installationObservationId); assert.match(request.installationObservationSha256, /^[a-f0-9]{64}$/);
      records.launches.push(clone(context));
      const id = randomUUID(), runtime = process();
      const value = observe('runtime-launch', context, { sessionId: id, product, profile, token: profileToken(profile), installed: true, exact: true, isolated: true,
        hostRuntime: false, sourceOverlay: false, artifact: installed.artifact, subjectSha256: readinessDigest(installed), runtimeSha256: installed.runtimeSha256, shellSha256: installed.shellSha256,
        process: runtime, ...(product === 'toolsenabled' ? {} : { serverProcess: process() }), origin, userDataIdentity,
        shortcutLaunch: { mechanism: 'installed-start-menu-shortcut', requestSha256: readinessDigest(request), shortcut: { ...request.shortcut, owned: true, reparse: false },
          resolvedTarget: target, resolvedArgs: [...args], runtime: { path: target, sha256: installed.runtimeSha256, process: clone(runtime) }, eventTraceSha256: sha(`synthetic shortcut trace ${id}`) },
      });
      url = product === 'toolsenabled' && !initialized ? `${origin}/#/setup` : `${origin}/`;
      const session = { id, attestation: value, cdp }; sessions.set(id, { session, stopped: false }); return session;
    },
    async stop(session, context) {
      records.stops++; sessions.get(session.id).stopped = true;
      return observe('runtime-stop', context, { sessionId: session.id, product, profile, subjectSha256: session.attestation.subjectSha256,
        process: session.attestation.process, ...(session.attestation.serverProcess ? { serverProcess: session.attestation.serverProcess } : {}), terminationConfirmed: true, ownedChildrenConfirmed: true });
    },
    async captureUserContent(context) {
      const roots = identity.contentRoots.map(id => {
        const present = marker !== null || id === 'external-workspace';
        return { id, owned: true, state: present ? 'present' : 'absent', sha256: present ? sha(id === 'external-workspace' ? 'synthetic external customer workspace' : `synthetic census ${id} ${marker} ${policy}`) : null };
      });
      const files = marker === null ? [] : identity.contentKinds.map((kind, index) => {
        const data = Buffer.from(`Synthetic UI-created ${kind} ${marker}`);
        return { root: identity.contentRoots[0], relativePath: `content-${index}.txt`, kind, owned: true, createdThroughUi: true, ...measured(data), data };
      });
      return observe('user-content', context, { roots, files, unreadable: [], reparsePoints: [] });
    },
    // Production-dispatch refusal fixtures stop at the first lifecycle launch,
    // before any nested journey. Calling these would invalidate that boundary.
    async assertCapabilities() { throw new Error('synthetic production dispatch must not enter a desktop journey'); },
    async stageInput() { throw new Error('synthetic production dispatch must not stage real input'); },
    async armDownload() { throw new Error('synthetic production dispatch must not arm a real download'); },
    async collectDownload() { throw new Error('synthetic production dispatch must not collect a real download'); },
  };
  const options = { product, profile, subject: CANDIDATE, inventory, runId, guest, timeoutMs: 20000, operationTimeoutMs: 1000, cleanupTimeoutMs: 1000,
    async fixtureContentJourney(context) {
      records.journeys.push({ subjectSha256: readinessDigest(context.subject), phaseId: context.phaseId });
      marker = context.marker;
      return { complete: true, cleanupConfirmed: true, runId, journeyId: context.journeyId, epochId: context.epochId, phaseId: context.phaseId, guestId: context.guestId,
        epoch: { observationId: context.epoch.observationId, sha256: readinessDigest(context.epoch) }, product, profile, fixture: true, scope: 'synthetic-driver-fixture',
        subjectSha256: readinessDigest(context.subject), assertions: DESKTOP_JOURNEYS[product].assertions.map(id => ({ id, status: 'passed', evidenceSha256: sha(`synthetic assertion ${id}`) })) };
    },
  };
  return { options, records, identity };
}

for (const product of Object.keys(INSTALLER_IDENTITIES)) {
  for (const profile of ['windows-x64-standard', 'windows-x64-administrator']) {
    test(`synthetic full lifecycle preserves scenario and shortcut contracts: ${product}, ${profile}`, async () => {
      const fixture = mechanics({ product, profile });
      const result = await executeInstallerLifecycleFixture(fixture.options);
      assert.equal(result.scope, 'synthetic-lifecycle-fixture'); assert.equal(result.fixture, true);
      assert.equal(result.complete, true); assert.equal(result.cleanupConfirmed, true); assert.equal(result.cleanupUnconfirmed, false);
      assert.equal(result.fullProductCoverage, false); assert.equal(result.releaseReady, undefined);
      const expected = [
        ...(product === 'toolsenabled' ? ['elevated-setup-refusal', 'durable-critical-journey:fresh-install'] : []),
        'fresh-install-and-documented-first-run',
        ...(product === 'toolsenabled' ? ['durable-critical-journey:upgrade:baseline-0'] : []), 'upgrade:baseline-0',
        ...(product === 'toolsenabled' ? ['durable-critical-journey:upgrade:baseline-1'] : []), 'upgrade:baseline-1',
        ...fixture.identity.uninstallModes.map(mode => `uninstall-reinstall:${mode}`),
        'interrupted-fresh-install', 'interrupted-upgrade:baseline-0', 'interrupted-upgrade:baseline-1', 'interrupted-uninstall',
      ];
      assert.deepEqual(result.scenarios.map(row => row.id), expected);
      if (product === 'toolsenabled') {
        assert.equal(fixture.records.journeys.length, 3, 'only the candidate uses its current critical-journey UI; baseline content is seeded by its account flow');
        assert.ok(fixture.records.journeys.every(row => row.subjectSha256 === readinessDigest(CANDIDATE)));
        const journeys = result.scenarios.filter(row => row.id.startsWith('durable-critical-journey:'));
        for (const row of journeys) {
          assert.equal(row.journey.subjectSha256, readinessDigest(CANDIDATE), 'upgrade journey must run the installed candidate');
          assert.equal(row.journey.phaseId, row.id.slice('durable-critical-journey:'.length));
          assert.equal(row.journey.profile, profile);
          assert.ok(row.journey.epochId);
        }
      }
      assert.deepEqual(fixture.records.checkpoints, ['fresh-install-files-written', 'upgrade-files-written', 'upgrade-files-written', 'uninstall-files-removed']);
      assert.equal(fixture.records.stops, fixture.records.launches.length); assert.equal(fixture.records.restores, 1); assert.equal(fixture.records.quarantines, 0);
      assert.equal(fixture.records.verified.length, 0, 'the explicit synthetic API must not promote a fixture through a fake trusted verifier');
      assert.equal(new Set(fixture.records.launches.map(row => row.launchRequest.installationObservationId)).size, fixture.records.launches.length);
      assert.deepEqual(new Set(fixture.records.launches.map(row => row.subject.artifact.sha256)), new Set([CANDIDATE, ...BASELINES].map(row => row.artifact.sha256)));
      const elevated = fixture.records.commands.filter(row => row.token === 'administrator');
      assert.equal(elevated.length, product === 'toolsenabled' ? 1 : 0, 'runtime profile must not elevate ordinary installer commands');
    });
  }
}

async function rejectedFixture(mutate, pattern, { beforeLaunch = false, product = 'scribe', stopAttempts = beforeLaunch ? 0 : 1 } = {}) {
  const fixture = mechanics({ product, mutate });
  const error = await executeInstallerLifecycleFixture(fixture.options).then(() => assert.fail('synthetic refusal unexpectedly completed'), error => error);
  assert.match(error.message, pattern); assert.equal(error.code, 'INSTALLER_LIFECYCLE_BLOCKED');
  assert.equal(error.report.complete, false); assert.equal(error.cleanupUnconfirmed, true); assert.equal(error.cleanupUncertain, true);
  assert.equal(error.report.cleanupConfirmed, false); assert.equal(error.report.quarantineConfirmed, true);
  assert.equal(fixture.records.restores, 0); assert.equal(fixture.records.quarantines, 1);
  assert.equal(fixture.records.launches.length, beforeLaunch ? 0 : 1);
  assert.equal(fixture.records.stops, stopAttempts, 'failed proof/cleanup must retain the returned session for cleanup');
  return { fixture, error };
}

const installationFaults = {
  'omitted shortcut': value => { value.shortcuts = []; },
  'wrong shortcut path': value => { value.shortcuts[0].path += '.wrong'; },
  'wrong shortcut target': value => { value.shortcuts[0].target += '.wrong'; },
  'omitted shortcut arguments': value => { delete value.shortcuts[0].args; },
  'wrong shortcut arguments': value => { value.shortcuts[0].args = []; },
  'omitted shortcut hash': value => { delete value.shortcuts[0].sha256; },
  'unmeasured shortcut bytes': value => { value.shortcuts[0].bytes = 0; },
};
for (const [name, change] of Object.entries(installationFaults)) {
  test(`refuses ${name} before guest launch`, () => rejectedFixture((kind, value, context) => {
    if (kind === 'installation' && context.expectedSubject) change(value);
  }, /required Start Menu shortcut/, { beforeLaunch: true }));
}
for (const fault of ['changed bytes', 'wrong measurement path', 'reparse', 'unowned']) {
  test(`refuses shortcut ${fault} between census and activation`, () => rejectedFixture((kind, value, context) => {
    if (kind !== 'file' || context.path !== INSTALLER_IDENTITIES.scribe.shortcut) return;
    if (fault === 'changed bytes') value.sha256 = sha('changed synthetic shortcut');
    if (fault === 'wrong measurement path') value.path += '.wrong';
    if (fault === 'reparse') value.reparse = true;
    if (fault === 'unowned') value.owned = false;
  }, /owned executable path or exact installer bytes changed/, { beforeLaunch: true }));
}
test('a mutated guest census object cannot rewrite the already-verified shortcut expectation', () => {
  let returnedShortcut;
  return rejectedFixture((kind, value, context) => {
    if (kind === 'installation' && context.expectedSubject) returnedShortcut = value.shortcuts[0];
    if (kind === 'file' && context.path === INSTALLER_IDENTITIES.scribe.shortcut) {
      returnedShortcut.sha256 = value.sha256 = sha('changed after the synthetic census was returned');
    }
  }, /owned executable path or exact installer bytes changed/, { beforeLaunch: true });
});

const activationFaults = {
  'omitted activation proof': proof => { delete proof.shortcutLaunch; },
  'direct executable launch': proof => { proof.shortcutLaunch.mechanism = 'direct-executable'; },
  'stale launch request': proof => { proof.shortcutLaunch.requestSha256 = sha('earlier synthetic request'); },
  'wrong activated shortcut': proof => { proof.shortcutLaunch.shortcut.path += '.wrong'; },
  'omitted activated shortcut bytes': proof => { delete proof.shortcutLaunch.shortcut.bytes; },
  'changed activated shortcut bytes': proof => { proof.shortcutLaunch.shortcut.bytes++; },
  'changed activated shortcut hash': proof => { proof.shortcutLaunch.shortcut.sha256 = sha('replacement synthetic link'); },
  'unowned activated shortcut': proof => { proof.shortcutLaunch.shortcut.owned = false; },
  'linked activated shortcut': proof => { proof.shortcutLaunch.shortcut.reparse = true; },
  'wrong resolved target': proof => { proof.shortcutLaunch.resolvedTarget += '.wrong'; },
  'omitted resolved arguments': proof => { delete proof.shortcutLaunch.resolvedArgs; },
  'wrong resolved arguments': proof => { proof.shortcutLaunch.resolvedArgs = []; },
  'wrong observed runtime path': proof => { proof.shortcutLaunch.runtime.path += '.wrong'; },
  'wrong observed runtime bytes': proof => { proof.shortcutLaunch.runtime.sha256 = sha('wrong synthetic runtime'); },
  'different observed runtime PID': proof => { proof.shortcutLaunch.runtime.process.pid++; },
  'different observed runtime creation time': proof => { proof.shortcutLaunch.runtime.process.startedAt = '2025-01-01T00:00:00.000Z'; },
  'omitted native activation trace': proof => { delete proof.shortcutLaunch.eventTraceSha256; },
};
for (const [name, change] of Object.entries(activationFaults)) {
  test(`refuses ${name} and quarantines after attempted session cleanup`, () => rejectedFixture((kind, value) => {
    if (kind === 'runtime-launch') change(value);
  }, /Start Menu shortcut activation.*unproven/));
}

const priorRuntimeFaults = {
  'wrong runtime token': proof => { proof.token = 'administrator'; },
  'wrong installer artifact': proof => { proof.artifact = BASELINES[0].artifact; },
  'wrong installed shell': proof => { proof.shellSha256 = BASELINES[0].shellSha256; },
  'missing durable account identity': proof => { delete proof.userDataIdentity; },
  'host runtime': proof => { proof.hostRuntime = true; },
  'source overlay': proof => { proof.sourceOverlay = true; },
  'unisolated runtime': proof => { proof.isolated = false; },
  'legacy process identity': proof => { proof.processIdentity = clone(proof.process); },
  'missing standalone server identity': proof => { delete proof.serverProcess; },
};
for (const [name, change] of Object.entries(priorRuntimeFaults)) {
  test(`preserves refusal for ${name}`, () => rejectedFixture((kind, value) => {
    if (kind === 'runtime-launch') change(value);
  }, /installed runtime subject, requested token or durable account identity/));
}
test('a stale epoch launch refuses before shortcut evidence can be credited', () => rejectedFixture((kind, value) => {
  if (kind === 'runtime-launch') value.epochId = randomUUID();
}, /runtime-launch: missing, stale or mismatched/));
test('an unconfirmed runtime stop retains quarantine and never restores the baseline', () => rejectedFixture((kind, value) => {
  if (kind === 'runtime-stop') value.ownedChildrenConfirmed = false;
}, /installed runtime cleanup is uncertain/, { stopAttempts: 2 }));

test('shortcut capability is mandatory before installer mutation', async () => {
  const fixture = mechanics({ mutate(kind, value) {
    if (kind === 'guest-attestation') value.capabilities = value.capabilities.filter(item => item !== 'installed-start-menu-shortcut-launch');
  } });
  await assert.rejects(() => executeInstallerLifecycleFixture(fixture.options), /attested guest capabilities/);
  assert.equal(fixture.records.commands.length, 0); assert.equal(fixture.records.launches.length, 0); assert.equal(fixture.records.restores, 0);
});
test('production export refuses an unbranded fixture inventory and guest', async () => {
  const fixture = mechanics();
  await assert.rejects(() => executeInstallerLifecycle(fixture.options), /inventory must name an absolute Dev-side file/);
  assert.equal(fixture.records.calls.length, 0);
});
const inventoryFaults = {
  'an empty upgrade inventory': [value => { value.supportedBaselines = []; }, /baseline inventory is absent or empty/],
  'an unsupported baseline migration': [value => { value.supportedBaselines[0].contentLayout = 'caller-selected-paths'; }, /content-layout migration driver is unavailable/],
  'caller-selected uninstall modes': [value => { value.dataPolicy.uninstallModes = ['skip-uninstall']; }, /uninstall\/data decisions/],
  'an incomplete customer-content census': [value => { value.dataPolicy.contentKinds = []; }, /real customer-content kinds/],
  'caller-selected content roots': [value => { value.dataPolicy.contentRoots = ['arbitrary-directory']; }, /customer-data root census/],
  'omitted recovery coverage': [value => { value.interruptionPolicy.points = []; }, /interruption points/],
};
for (const [name, [change, pattern]] of Object.entries(inventoryFaults)) {
  test(`shared inventory validation still refuses ${name} through lifecycle entry`, async () => {
    const fixture = mechanics(); change(fixture.options.inventory);
    const error = await executeInstallerLifecycleFixture(fixture.options).then(() => assert.fail('invalid inventory was accepted'), error => error);
    assert.match(error.message, pattern); assert.equal(error.code, 'INSTALLER_LIFECYCLE_BLOCKED');
    assert.equal(error.cleanupUnconfirmed, false); assert.equal(fixture.records.calls.length, 0);
  });
}

// Import the unchanged production module with ONLY its Git-authority dependency
// replaced for dispatch tests. Real bounded file reads and private inventory
// branding still run in an owned temporary directory. This dependency exists
// only in a tagged test module instance; it cannot authorize the real module.
// No native Git is invoked and no production success is ever returned below.
async function syntheticProductionDispatch(config, check) {
  const fixture = mechanics({ ...config, synthetic: false });
  const tempRoot = os.tmpdir();
  const root = await mkdtemp(path.join(tempRoot, 'synthetic-shortcut-dispatch-'));
  try {
    const inventoryBytes = Buffer.from(JSON.stringify(fixture.options.inventory)), policyBytes = Buffer.from('Synthetic dispatch policy. No execution authority.\n');
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'inventory.json'), inventoryBytes); await writeFile(path.join(root, 'policy.md'), policyBytes);
    const files = { 'inventory.json': measured(inventoryBytes), 'policy.md': measured(policyBytes) };
    const ref = 'a'.repeat(40), snapshot = { ref, clean: true, files, sha256: readinessDigest(files) };
    const moduleUrl = new URL(`../lib/drivers/installer-lifecycle.mjs?synthetic-git-dispatch=${randomUUID()}`, import.meta.url).href;
    const dependencyUrl = `data:text/javascript,${encodeURIComponent(`
      export function sourceHead(root) { if (root !== ${JSON.stringify(root)}) throw new Error('synthetic root escaped'); return ${JSON.stringify(ref)}; }
      export function cleanSourceSnapshot(root, ref) { if (root !== ${JSON.stringify(root)} || ref !== ${JSON.stringify(ref)}) throw new Error('synthetic snapshot escaped'); return ${JSON.stringify(snapshot)}; }
    `)}`;
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === moduleUrl && specifier === '../adapters/artifact-source.mjs') return { url: dependencyUrl, shortCircuit: true };
      return next(specifier, context);
    } });
    let production;
    try { production = await import(moduleUrl); } finally { hooks.deregister(); }
    const options = { ...fixture.options, inventory: undefined, inventoryPath: path.join(root, 'inventory.json') };
    const error = await production.executeInstallerLifecycle(options).then(() => assert.fail('synthetic production dispatch must never complete'), error => error);
    assert.equal(error.report?.complete, false); assert.equal(error.report?.quarantineConfirmed, true);
    assert.equal(error.cleanupUnconfirmed, true); assert.equal(fixture.records.launches.length, 1);
    assert.equal(fixture.records.stops, 1); assert.equal(fixture.records.quarantines, 1); assert.equal(fixture.records.restores, 0);
    assert.ok(fixture.records.verified.some(row => row.kind === 'installation'));
    const verifiedLaunch = fixture.records.verified.find(row => row.kind === 'runtime-launch');
    assert.ok(verifiedLaunch, 'the production export must reach its real runtime-launch verification call');
    assert.equal(verifiedLaunch.context.launchRequest.shortcut.path, fixture.identity.shortcut);
    await check(error, fixture, verifiedLaunch);
  } finally {
    assert.equal(path.dirname(root), path.resolve(tempRoot));
    await rm(root, { recursive: true, force: true });
  }
}
test('production dispatch reaches mandatory shortcut refusal under synthetic Git and guest dependencies', () => syntheticProductionDispatch({ mutate(kind, value) {
  if (kind === 'runtime-launch') delete value.shortcutLaunch;
} }, error => assert.match(error.message, /Start Menu shortcut activation.*unproven/)));
test('production dispatch rejects wrong resolution even when a synthetic verifier returns true', () => syntheticProductionDispatch({ mutate(kind, value) {
  if (kind === 'runtime-launch') value.shortcutLaunch.resolvedArgs = [];
} }, error => assert.match(error.message, /Start Menu shortcut activation.*unproven/)));
test('production dispatch cannot credit copied shortcut evidence when trusted verification refuses', () => syntheticProductionDispatch({ rejectVerification: 'runtime-launch' }, (error, fixture, verification) => {
  assert.match(error.message, /runtime-launch: trusted guest evidence verification failed/);
  assert.equal(verification.value.shortcutLaunch.requestSha256, readinessDigest(verification.context.launchRequest));
  assert.ok(fixture.records.verified.some(row => row.kind === 'runtime-stop'));
  assert.ok(fixture.records.verified.some(row => row.kind === 'guest-quarantine'));
}));
