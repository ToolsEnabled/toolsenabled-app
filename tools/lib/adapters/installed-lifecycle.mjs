import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile, plainPath, contains, readJson } from './artifact-files.mjs';

// The seven installed-product rows of the fixed release contract had no
// registered executor, so assertReadinessAdaptersAvailable('toolsenabled')
// threw on every platform and tools/release-packager/cut-release-candidate.mjs
// could not start a cut at all (measured 2026-09-11 on Node 22.19.0:
// "required qualification adapters are unavailable (fresh-install,
// durable-critical-journey, upgrade, uninstall-reinstall,
// privilege-isolation-recovery, advertised-integrations, update-delivery)").
//
// Registration here names exactly one reviewed executor per row. It is not a
// claim that any row currently passes: five rows execute the disposable-guest
// driver under tools/lib/drivers and refuse until that guest exists, and two
// rows have no executable scenario at all and refuse by name with the reason
// and the remedy below. Nothing in this module synthesizes an observation, and
// an adapter reports a pass only after the driver returned a complete,
// cleanup-confirmed, exact-subject report from an attested disposable guest.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.dirname(HERE);
const REPORT_SCHEMA = 'toolsenabled.installed-lifecycle-execution';
const LIFECYCLE_SCOPE = 'exact-installer-lifecycle';
const DESKTOP_SCOPE = 'exact-installed-desktop';
export const INSTALLED_LIFECYCLE_PROFILES = Object.freeze(['windows-x64-standard', 'windows-x64-administrator']);
// The implementation identity spans every file that can change what these
// adapters accept as evidence: the selectors here, the drivers they read, the
// guest transport that produces the raw observations, and the contract module
// itself. Editing any of them changes the adapter sha256, and the registry
// then no longer matches the contract row, which is a loud refusal rather than
// a quietly different meaning of "qualified".
const COMPONENTS = Object.freeze(['adapters/installed-lifecycle.mjs', 'adapters/artifact-files.mjs',
  'drivers/installer-lifecycle.mjs', 'drivers/desktop-journeys.mjs', 'drivers/lifecycle-inventory-contract.mjs',
  'guest/disposable-guest.mjs', 'guest/installed-state.mjs', 'guest/Read-InstalledState.ps1',
  'transport/owned-job.mjs', 'transport/owned-session.mjs', 'transport/cdp-client.mjs',
  'transport/registered-toolchain.mjs', 'transport/QualificationVm.psm1', 'release-readiness.mjs'].slice().sort());
const matches = (left, right) => left?.bytes === right?.bytes && left?.sha256?.toLowerCase() === right?.sha256?.toLowerCase();
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
function refuse(message, cleanupUnconfirmed = false) {
  const error = new Error(`Installed lifecycle qualification blocked: ${message}`);
  error.code = 'INSTALLED_LIFECYCLE_BLOCKED';
  error.cleanupUnconfirmed = cleanupUnconfirmed;
  throw error;
}

// Evidence selectors read the driver's own raw report (the scenarios and
// observations installer-lifecycle.mjs pushes). Each selector must locate the
// executed scenario it names; an absent scenario refuses instead of passing,
// so a shorter run cannot silently satisfy a row it never exercised.
const scenario = (report, id) => {
  const rows = report.scenarios.filter(row => row.id === id);
  if (rows.length !== 1) refuse(`driver report does not contain the executed scenario ${id}`);
  return rows[0];
};
const scenarios = (report, prefix) => {
  const rows = report.scenarios.filter(row => row.id.startsWith(prefix));
  if (!rows.length) refuse(`driver report contains no executed ${prefix} scenario`);
  return rows;
};
const observed = (report, kind, phasePrefix, minimum = 1) => {
  const rows = report.observations.filter(row => row.kind === kind && typeof row.phaseId === 'string' && row.phaseId.startsWith(phasePrefix));
  if (rows.length < minimum) refuse(`driver report lacks ${kind} observations for ${phasePrefix}`);
  return rows.map(({ observationId, sha256, phaseId }) => ({ observationId, sha256, phaseId }));
};
const completedCommand = (value, label) => {
  if (!value || value.exitCode !== 0 || value.interrupted !== false || !/^[a-f0-9]{64}$/i.test(value.commandSha256 || '')) refuse(`${label} was not a completed owned command`);
  return value;
};

// A row with no executable scenario is registered so the contract names one
// executor for it, and refuses with the reason and the remedy. The alternative
// considered and rejected was a selector that returns a constant: that would
// turn "unqualified" into a green assertion on a public release, which is
// worse than the unregistered state this replaces.
const noScenario = (reason, remedy) => Object.freeze({ reason, remedy });
const HASH = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const journeyAssertion = (report, id) => {
  if (report?.product !== 'toolsenabled' || report.scope !== LIFECYCLE_SCOPE || report.fixture !== false) {
    refuse('journey evidence is not the exact toolsenabled installer-lifecycle report');
  }
  const upgrades = report.scenarios.filter(row => typeof row.id === 'string' && row.id.startsWith('upgrade:')).map(row => row.id);
  const required = ['fresh-install', ...upgrades];
  const journeyIds = new Set();
  return required.map(phase => {
    const rows = report.scenarios.filter(row => row.id === `durable-critical-journey:${phase}`);
    if (rows.length !== 1) refuse(`driver report does not contain the executed journey for ${phase}`);
    const row = rows[0], journey = row.journey || {};
    if (journey.complete !== true || journey.cleanupConfirmed !== true || journey.fixture !== false ||
        journey.scope !== 'exact-installed-desktop-journey' || journey.product !== 'toolsenabled' ||
        journey.runId !== report.runId || journey.subjectSha256 !== report.subjectSha256 || journey.profile !== report.profile ||
        journey.phaseId !== phase || !UUID.test(journey.journeyId || '') || journeyIds.has(journey.journeyId) ||
        !UUID.test(journey.epochId || '') || !journey.guestId) {
      refuse(`executed journey ${row.id} does not bind the exact product, run and subject`);
    }
    journeyIds.add(journey.journeyId);
    const resets = (report.observations || []).filter(row => row.kind === 'baseline-reset' && row.phaseId === phase);
    if (resets.length !== 1 || resets[0].epochId !== journey.epochId ||
        resets[0].observationId !== journey.epoch?.observationId || !HASH.test(journey.epoch?.sha256 || '') ||
        resets[0].sha256 !== journey.epoch.sha256) refuse(`executed journey ${row.id} does not bind its verified baseline epoch`);
    const found = Array.isArray(journey.assertions) ? journey.assertions.filter(item => item.id === id) : [];
    if (found.length !== 1 || found[0].status !== 'passed' || !HASH.test(found[0].evidenceSha256 || '')) {
      refuse(`executed journey ${row.id} does not contain verified assertion ${id}`);
    }
    return { scenario: row.id, phase, assertion: found[0], journeyId: journey.journeyId, subjectSha256: journey.subjectSha256, runId: journey.runId, profile: journey.profile,
      guestId: journey.guestId, epochId: journey.epochId, epoch: journey.epoch };
  });
};
export const INSTALLED_LIFECYCLE_REQUIREMENTS = freeze({
  'fresh-install': { scope: LIFECYCLE_SCOPE, driver: 'installer-lifecycle', refusal: null, assertions: {
    'exact-installer-executed': report => ({ installed: completedCommand(scenario(report, 'fresh-install-and-documented-first-run').installed, 'fresh install'),
      jobs: observed(report, 'job-exit', 'fresh-install') }),
    'shortcut-starts-installed-product': report => ({ launches: observed(report, 'runtime-launch', 'fresh-install', 3) }),
    'first-run-completes': report => { const row = scenario(report, 'fresh-install-and-documented-first-run');
      if (!row.userDataIdentity || !Array.isArray(row.customerFiles) || !row.customerFiles.length) refuse('first run did not persist customer content');
      return { userDataIdentity: row.userDataIdentity, customerFiles: row.customerFiles }; } } },
  'upgrade': { scope: LIFECYCLE_SCOPE, driver: 'installer-lifecycle', refusal: null, assertions: {
    'supported-upgrade-source-installed': report => ({ baselines: scenarios(report, 'upgrade:').map(row => row.baseline), inventory: report.inventory }),
    'exact-candidate-upgrade-executed': report => ({ upgrades: scenarios(report, 'upgrade:').map(row => completedCommand(row.upgraded, 'upgrade')) }),
    'user-data-survives': report => ({ customerFiles: scenarios(report, 'upgrade:').map(row => row.customerFiles), content: observed(report, 'user-content', 'upgrade:', 2) }),
    'upgraded-product-relaunches': report => ({ launches: observed(report, 'runtime-launch', 'upgrade:', 3) }) } },
  'uninstall-reinstall': { scope: LIFECYCLE_SCOPE, driver: 'installer-lifecycle', refusal: null, assertions: {
    'installed-product-uninstalled': report => ({ removals: scenarios(report, 'uninstall-reinstall:').map(row => completedCommand(row.removed, 'uninstall')) }),
    'documented-data-policy-preserved': report => ({ modes: scenarios(report, 'uninstall-reinstall:').map(row => row.id.slice('uninstall-reinstall:'.length)).sort(),
      declarationSha256: report.inventory.declarationSha256, content: observed(report, 'user-content', 'uninstall-reinstall:', 3) }),
    'exact-candidate-reinstalled': report => ({ jobs: observed(report, 'job-exit', 'uninstall-reinstall:', 6) }),
    'reinstalled-product-relaunches': report => ({ launches: observed(report, 'runtime-launch', 'uninstall-reinstall:', 6) }) } },
  'privilege-isolation-recovery': { scope: DESKTOP_SCOPE, driver: 'installer-lifecycle', refusal: null, assertions: {
    'chosen-privilege-observed': report => ({ profile: report.profile, launches: observed(report, 'runtime-launch', '', 3) }),
    'profile-boundary-enforced': report => ({ installations: observed(report, 'installation', '', 3), refusal: scenario(report, 'elevated-setup-refusal') }),
    'failure-is-observable': report => { const row = scenario(report, 'elevated-setup-refusal');
      if (row.exitCode === 0 || row.interrupted !== false) refuse('elevated setup refusal was not observed');
      return { refusal: row, interruptions: scenarios(report, 'interrupted-').map(item => item.interrupted) }; },
    'recovery-preserves-user-data': report => ({ recoveries: scenarios(report, 'interrupted-').map(row => ({ id: row.id, recovered: completedCommand(row.recovered, 'recovery'), customerFiles: row.customerFiles })) }) } },
  'durable-critical-journey': { scope: DESKTOP_SCOPE, driver: 'installer-lifecycle', refusal: null, assertions: {
    'installed-ui-starts-shipped-engine': report => journeyAssertion(report, 'installed-ui-starts-shipped-engine'),
    'supported-provider-start-response-stop': report => journeyAssertion(report, 'supported-provider-start-response-stop'),
    'result-persists-after-full-relaunch': report => journeyAssertion(report, 'result-persists-after-full-relaunch') } },
  'advertised-integrations': { scope: DESKTOP_SCOPE, driver: null, assertions: {
    'supported-provider-matrix-complete': null, 'supported-multi-machine-path-complete': null, 'payments-remain-inert': null },
  refusal: noScenario(
    'No driver walks the advertised provider matrix, exercises the multi-machine path, or observes that the payment surfaces stay inert in the installed product. ' +
    'The present transport also cannot reach either: Assert-QualificationVmConfig pins networkPolicy to offline and Get-QualificationVm refuses a machine attached to a virtual switch, so a real provider and a second machine are both unreachable from the disposable guest.',
    'This row needs three separate pieces before it can be qualified: a driver that reads the advertised matrix from the shipped source of truth and exercises every entry; a reviewed egress policy for the guest that is not the current offline policy; and a second attested guest for the multi-machine path. Until all three exist this row must stay a refusal, not an assumption that payments are inert because the launch surface has none.'
  ) },
  'update-delivery': { scope: LIFECYCLE_SCOPE, driver: null, assertions: {
    'actual-update-delivery-path': null, 'exact-candidate-selected': null, 'interrupted-update-recovers': null },
  refusal: noScenario(
    'The lifecycle driver covers interrupted-upgrade:<baseline> recovery only. Nothing exercises the delivery path the product actually offers a user, and nothing proves the exact candidate is the build that path selects. ' +
    'tools/release-packager/lifecycle-inventory.toolsenabled.json is also absent, so there is not even a supported baseline to update from.',
    'Commit the lifecycle inventory (shape enforced by validateLifecycleInventory in tools/lib/drivers/lifecycle-inventory-contract.mjs, checkable with tools/release-packager/check-lifecycle-inputs.mjs), then add a delivery driver that observes the real update check, download and apply path with the exact candidate as its only acceptable outcome, and reuse the existing interruption points for the third assertion.'
  ) },
});
export const INSTALLED_LIFECYCLE_IDS = Object.freeze(Object.keys(INSTALLED_LIFECYCLE_REQUIREMENTS));

// Consumed by tools/release-packager/lib/readiness-plan.mjs so a planning
// report states which registered rows can never produce evidence today. A
// registered adapter that always refuses must not read as "ready to run".
export function installedLifecycleScenarioCensus() {
  return INSTALLED_LIFECYCLE_IDS.map(id => {
    const definition = INSTALLED_LIFECYCLE_REQUIREMENTS[id];
    return { id, adapterId: `${id}:v1`, scope: definition.scope, driver: definition.driver,
      executableScenario: Boolean(definition.driver),
      ...(definition.refusal ? { refusal: { reason: definition.refusal.reason, remedy: definition.refusal.remedy } } : {}) };
  });
}

export function installedLifecycleImplementationIdentity() {
  return digestRecord(Object.fromEntries(COMPONENTS.map(name => [name, measureFile(path.join(BUNDLE, name))])));
}
const LOADED_IDENTITY = installedLifecycleImplementationIdentity();
function assertLoadedImplementation() {
  if (installedLifecycleImplementationIdentity() !== LOADED_IDENTITY) refuse('installed lifecycle implementation changed after registration');
}

function assertInvocation(id, required, profile) {
  const definition = INSTALLED_LIFECYCLE_REQUIREMENTS[id];
  if (required?.id !== id || required.scope !== definition.scope || !INSTALLED_LIFECYCLE_PROFILES.includes(profile)) refuse('wrong installed lifecycle contract invocation');
  const expected = Object.keys(definition.assertions);
  if (!Array.isArray(required.assertions) || required.assertions.length !== expected.length || expected.some(name => !required.assertions.includes(name))) refuse(`${id} assertions differ from the reviewed evidence contract`);
  return definition;
}

function assertionsFor(id, report) {
  const definition = INSTALLED_LIFECYCLE_REQUIREMENTS[id];
  return Object.entries(definition.assertions).map(([name, select]) => {
    if (typeof select !== 'function') refuse(`no executable scenario produces evidence for ${id}/${name}. ${definition.refusal.reason} ${definition.refusal.remedy}`);
    return { id: name, status: 'passed', evidenceSha256: digestRecord(select(report)) };
  });
}

function assertDriverReport(report, { product, profile, runId, subjectSha256 }) {
  if (report?.schema !== 'toolsenabled.artifact-lifecycle-report' || report.schemaVersion !== 1 || report.scope !== LIFECYCLE_SCOPE ||
      report.fixture !== false || report.complete !== true || report.cleanupConfirmed !== true || report.cleanupUnconfirmed === true ||
      report.product !== product || report.profile !== profile || report.runId !== runId || report.subjectSha256 !== subjectSha256 ||
      !Array.isArray(report.scenarios) || !Array.isArray(report.observations) || !report.inventory || !/^[a-f0-9]{64}$/i.test(report.inventory.sha256 || '')) refuse('driver report is not a complete, clean, exact-subject lifecycle execution');
  return report;
}

// One real lifecycle execution per qualification run and profile. Every row
// that draws on it binds to the same raw report file; nothing is re-run to
// manufacture a second, unrelated success. A refusal is never cached, so a
// transient host failure does not become a permanent verdict for the run.
const executions = new Map();
async function lifecycleReport(input, subjectSha256) {
  const { subject, profile, run, context } = input;
  const key = `${run.id}/${profile}/${subjectSha256}`;
  if (!executions.has(key)) {
    executions.set(key, (async () => {
      if (process.platform !== 'win32' || process.arch !== 'x64') refuse(`installed lifecycle scenarios execute only on a Windows x64 qualification host, not ${process.platform}/${process.arch}. Run the cut on the Windows cutter.`);
      if (!context?.evidenceRoot || !context.sourceRoots?.app) refuse('installed lifecycle qualification needs the explicit evidence root and app source root from --readiness-context');
      assertLoadedImplementation();
      const [{ createDisposableGuest, DISPOSABLE_GUEST_MODE }, { executeInstallerLifecycle }] = await Promise.all([
        import('../guest/disposable-guest.mjs'), import('../drivers/installer-lifecycle.mjs')]);
      const inventoryPath = path.join(context.sourceRoots.app, 'tools', 'release-packager', `lifecycle-inventory.${subject.product}.json`);
      const startedAt = new Date().toISOString();
      // The guest refusal already names every unmet prerequisite and its
      // remedy; keep that text and add which requirement and profile asked.
      let guest;
      try {
        guest = await createDisposableGuest({ product: subject.product, profile, runId: run.id,
          evidenceRoot: context.evidenceRoot, harnessRoot: context.harnessRoot, runnerConfigPath: context.runnerConfigPath });
      } catch (error) {
        if (error?.cleanupUnconfirmed === true) throw error;
        refuse(`the attested disposable guest is unavailable for ${profile}: ${error?.message || error}`);
      }
      if (guest?.mode !== DISPOSABLE_GUEST_MODE) refuse('guest transport is not an attested disposable guest');
      let report;
      try { report = await executeInstallerLifecycle({ product: subject.product, profile, subject, runId: run.id, guest, inventoryPath }); }
      catch (error) { if (error?.cleanupUnconfirmed === true) throw error; refuse(`installer lifecycle did not complete: ${error?.message || error}`, false); }
      assertDriverReport(report, { product: subject.product, profile, runId: run.id, subjectSha256 });
      const record = { schema: REPORT_SCHEMA, schemaVersion: 1, product: subject.product, profile, runId: run.id, subjectSha256,
        implementationSha256: LOADED_IDENTITY, host: { platform: process.platform, arch: process.arch, osBuild: os.release() },
        command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], inventoryPath, driverReport: report,
        startedAt, finishedAt: new Date().toISOString() };
      const reportPath = path.join(context.evidenceRoot, `installed-lifecycle-${profile}-${randomUUID()}.json`);
      fs.writeFileSync(reportPath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      assertLoadedImplementation();
      return freeze({ record, report: { ...measureFile(reportPath), path: reportPath } });
    })().catch(error => { executions.delete(key); throw error; }));
  }
  return executions.get(key);
}

async function execute(id, input) {
  const definition = assertInvocation(id, input?.required, input?.profile);
  assertLoadedImplementation();
  if (input.required.adapter?.id !== `${id}:v1` || input.required.adapter.sha256 !== LOADED_IDENTITY) refuse('installed lifecycle adapter received the wrong adapter identity');
  // Rows without an executable scenario refuse here, before the subject is
  // read and before any host, guest or installer work is attempted.
  if (!definition.driver) assertionsFor(id, null);
  const subjectSha256 = digestRecord(input.subject);
  if (subjectSha256 !== input.subjectSha256 || input.subject?.product !== 'toolsenabled') refuse('installed lifecycle adapters qualify only the measured toolsenabled subject');
  const { record, report } = await lifecycleReport(input, subjectSha256);
  const assertions = assertionsFor(id, record.driverReport);
  assertLoadedImplementation();
  return { id, profile: input.profile, scope: definition.scope, adapterId: `${id}:v1`, adapterSha256: LOADED_IDENTITY,
    subjectSha256, runId: input.run.id, startedAt: record.startedAt, finishedAt: record.finishedAt,
    execution: { command: record.command, adapterFunction: 'executeInstallerLifecycle', complete: true, exitCode: 0, signal: null,
      cleanupConfirmed: true, synthetic: false, sourceOverlay: false, hostRuntime: false },
    environment: { platform: 'win32', arch: 'x64', profile: input.profile, osBuild: record.host.osBuild, isolated: true, isolation: 'disposable-machine' },
    observedRuntimeSha256: input.subject.runtimeSha256, installer: { ...input.subject.artifact },
    report, assertions, counts: { tests: assertions.length, passed: assertions.length, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 } };
}

// Re-reads the retained raw report and recomputes every assertion's evidence
// digest from the driver's executed scenarios. A stored pass flag, a report
// outside the private evidence root, or evidence for a different subject, run,
// profile or adapter build is not verification.
async function verifyExecutionEvidence(id, observation, subject, { signal } = {}) {
  try {
    if (signal?.aborted) return false;
    const definition = INSTALLED_LIFECYCLE_REQUIREMENTS[id];
    if (observation?.id !== id || observation.scope !== definition.scope || !INSTALLED_LIFECYCLE_PROFILES.includes(observation.profile) ||
        observation.environment?.profile !== observation.profile || observation.adapterId !== `${id}:v1` ||
        observation.adapterSha256 !== installedLifecycleImplementationIdentity() || observation.subjectSha256 !== digestRecord(subject)) return false;
    const file = plainPath(observation?.report?.path, { kind: 'file' });
    if (!subject?.context?.evidenceRoot || !contains(subject.context.evidenceRoot, file) || !matches(measureFile(file), observation.report)) return false;
    const record = readJson(file);
    if (record.schema !== REPORT_SCHEMA || record.schemaVersion !== 1 || record.subjectSha256 !== observation.subjectSha256 ||
        record.profile !== observation.profile || record.runId !== observation.runId || record.implementationSha256 !== observation.adapterSha256 ||
        record.product !== subject.product || record.startedAt !== observation.startedAt || record.finishedAt !== observation.finishedAt) return false;
    assertDriverReport(record.driverReport, { product: subject.product, profile: observation.profile, runId: observation.runId, subjectSha256: observation.subjectSha256 });
    if (!/^[a-f0-9]{64}$/i.test(subject.runtimeSha256 || '') || observation.observedRuntimeSha256 !== subject.runtimeSha256) return false;
    return JSON.stringify(assertionsFor(id, record.driverReport)) === JSON.stringify(observation.assertions);
  } catch (error) {
    if (error?.cleanupUnconfirmed === true) throw error;
    return false;
  }
}

const ADAPTERS = new Map(INSTALLED_LIFECYCLE_IDS.map(id => [id, Object.freeze({
  id: `${id}:v1`, sha256: LOADED_IDENTITY, proofScope: INSTALLED_LIFECYCLE_REQUIREMENTS[id].scope, execution: 'real',
  supportedProfiles: INSTALLED_LIFECYCLE_PROFILES, executableScenario: Boolean(INSTALLED_LIFECYCLE_REQUIREMENTS[id].driver),
  execute: input => execute(id, input),
  verifyExecutionEvidence: (observation, subject, options) => verifyExecutionEvidence(id, observation, subject, options),
})]));

export function getInstalledLifecycleAdapter(id) {
  if (!ADAPTERS.has(id)) refuse(`unknown installed lifecycle requirement ${id}`);
  return ADAPTERS.get(id);
}
