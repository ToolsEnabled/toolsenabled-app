import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { readinessDigest } from '../release-readiness.mjs';
import { plainPath, readBounded, measureFile } from '../adapters/artifact-files.mjs';
import { cleanSourceSnapshot, sourceHead } from '../adapters/artifact-source.mjs';
import { DESKTOP_JOURNEYS, executeDesktopJourney } from './desktop-journeys.mjs';
import { validateLifecycleInventory } from './lifecycle-inventory-contract.mjs';

// Source-inspected contracts, not evidence that any current installer passed.
// Exact release identities are deliberate: a renamed test installer does not
// prove the release installer. Isolation belongs to the attested disposable VM.
// This is an OS-account measurement, not an environment or caller override.
// The guest must independently attest this same owning profile before use.
const PROFILE = path.win32.normalize(userInfo().homedir);
const PROGRAMS = `${PROFILE}\\AppData\\Local\\Programs`;
const START_MENU = `${PROFILE}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs`;
const UNINSTALL_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const standalone = (slug, displayName, contentKinds, contentRoots, readySelector) => ({
  source: 'website/software/installers/{build-installer.mjs,nsis-template.nsi}',
  displayName, installDir: `${PROGRAMS}\\${slug}`, registryKey: `${UNINSTALL_KEY}${slug}`,
  runtime: 'runtime\\electron\\electron.exe', shell: 'shell\\main.js', uninstaller: 'Uninstall.exe',
  shortcut: `${START_MENU}\\${displayName}\\${displayName}.lnk`, shortcutArgs: ['{installDir}\\shell'],
  installerToken: 'standard', elevatedSetupExitCode: null, uninstallArgs: ['/S'],
  uninstallModes: ['retain-user-content'], contentKinds, contentRoots, readySelector,
  // NSIS writes config.json, so the ordinary installed first launch does NOT
  // redirect to /setup. The documented setup is still exercised explicitly.
  firstRun: 'installed-default-config-and-explicit-setup',
});

export const INSTALLER_IDENTITIES = freeze({
  toolsenabled: {
    source: 'app/{package.json,build/installer.nsh,tools/installer-identity.mjs}',
    displayName: 'ToolsEnabled', installDir: `${PROGRAMS}\\toolsenabled`,
    registryKey: `${UNINSTALL_KEY}21cb002d-a6ac-5e62-b88d-ba3c87d67396`,
    runtime: 'ToolsEnabled.exe', shell: 'resources\\app.asar', uninstaller: 'Uninstall ToolsEnabled.exe',
    shortcut: `${START_MENU}\\ToolsEnabled.lnk`, shortcutArgs: [],
    installerToken: 'standard', elevatedSetupExitCode: 740, uninstallArgs: ['/currentuser', '/S'],
    uninstallModes: ['ask-silent', 'keep-my-data', 'remove-everything'],
    contentKinds: ['local-account'], contentRoots: ['roaming-product', 'local-service', 'external-workspace'],
    readySelector: '.home', firstRun: 'permission-workspace-account-autonomy-review',
  },
  scribe: standalone('scribe', 'ToolsEnabled Scribe', ['document'],
    ['app-data', 'scribe-drafts', 'scribe-originals', 'scribe-output'], '#paper'),
  'web-editor': standalone('web-editor', 'ToolsEnabled Web Studio', ['working-page', 'published-page'],
    ['app-data', 'web-working-copy', 'external-publish'], '#composer'),
  'presentation-suite': standalone('presentation-suite', 'ToolsEnabled Presentation Editor', ['presentation'],
    ['app-data', 'presentation-project'], '#deckTitle'),
});

const HASH = /^[a-f0-9]{64}$/i;
const REF = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PROFILES = new Set(['windows-x64-standard', 'windows-x64-administrator']);
const inventories = new WeakSet();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameHash = (a, b) => HASH.test(a || '') && HASH.test(b || '') && a.toLowerCase() === b.toLowerCase();
const sameArtifact = (a, b) => sameHash(a?.sha256, b?.sha256) && a.bytes === b.bytes && Number.isSafeInteger(a.bytes) && a.bytes > 0;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const processIdentity = value => value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt));
const sameProcess = (a, b) => processIdentity(a) && processIdentity(b) && a.pid === b.pid && a.startedAt === b.startedAt;

function refuse(message, uncertain = false) {
  const error = new Error(`Installer lifecycle blocked: ${message}`);
  error.code = 'INSTALLER_LIFECYCLE_BLOCKED'; error.cleanupUncertain = uncertain; error.cleanupUnconfirmed = uncertain; throw error;
}
const cleanupUnknown = error => error?.cleanupUncertain === true || error?.cleanupUnconfirmed === true || error?.terminationConfirmed === false;
function exactSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some(item => !actual.includes(item))) refuse(`incomplete or unknown ${label}`);
}
function subjectValid(subject) {
  if (subject && Object.hasOwn(subject, 'installer')) refuse('ambiguous or legacy installer identity; the canonical measured subject uses artifact only');
  if (!sameArtifact(subject?.artifact, subject?.artifact) || !HASH.test(subject?.runtimeSha256 || '') || !HASH.test(subject?.shellSha256 || '')) refuse('exact installer/runtime/shell subject is missing');
}
function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 512 && !value.includes('\\') &&
    !/[:<>"|?*\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function guestFile(filename) {
  if (typeof filename !== 'string' || !filename.toLowerCase().startsWith(`${PROFILE.toLowerCase()}\\`) || filename.includes('/') || !relativeFile(filename.slice(PROFILE.length + 1).replaceAll('\\', '/'))) refuse('guest executable path is not a plain fenced account path', true);
  return filename;
}
function observationDigest(value) {
  // A 32 MB Uint8Array must not expand into 32 million JSON property names.
  const compact = item => item instanceof Uint8Array ? { sha256: hash(item), bytes: item.length }
    : Array.isArray(item) ? item.map(compact)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, compact(child)])) : item;
  return readinessDigest(compact(value));
}
function registryCommandMatches(value, executable, args) {
  if (typeof value !== 'string') return false;
  const command = /^"([^"]+)"(?:\s+(.*))?$/.exec(value.trim());
  return !!command && samePath(command[1], executable) &&
    readinessDigest(command[2]?.trim() ? command[2].trim().split(/\s+/) : []) === readinessDigest(args);
}
function validateInventory(value, product) {
  return validateLifecycleInventory(value, product, INSTALLER_IDENTITIES);
}

function fencedFile(filename) {
  if (typeof filename !== 'string' || !path.win32.isAbsolute(filename)) refuse('inventory must name an absolute Dev-side file');
  return plainPath(filename, { kind: 'file' });
}
function inventoryRepository(filename) {
  // Inspect only this explicitly fenced file's Dev-side ancestors. Git cannot
  // follow a worktree pointer, config include or ambient GIT_DIR before the
  // shared metadata fence has inspected it.
  for (let cursor = path.dirname(filename); ; cursor = path.dirname(cursor)) {
    const marker = plainPath(path.join(cursor, '.git'), { missingLeaf: true });
    try { lstatSync(marker); return cursor; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (samePath(cursor, PROFILE) || path.dirname(cursor) === cursor) break;
  }
  refuse('lifecycle inventory has no source-controlled Dev-side repository');
}

// No production JSON injection seam: both inventory and its policy declaration
// must be unchanged regular files at the same Git HEAD. Parent qualification
// authority must additionally authorize this repository/ref as product policy.
export function readLifecycleInventory(inventoryPath, { product } = {}) {
  const full = fencedFile(inventoryPath), repository = inventoryRepository(full);
  const ref = sourceHead(repository), snapshot = cleanSourceSnapshot(repository, ref);
  if (!REF.test(ref)) refuse('lifecycle inventory source ref is invalid');
  const relative = path.relative(repository, full).split(path.sep).join('/');
  if (!relativeFile(relative)) refuse('inventory escaped its source repository');
  const readCommitted = rel => {
    const filename = fencedFile(path.join(repository, ...rel.split('/')));
    const bytes = readBounded(filename, 1024 * 1024);
    if (!snapshot.files[rel] || !sameArtifact(snapshot.files[rel], measureFile(filename))) refuse('lifecycle inventory or data declaration is not committed unchanged source');
    return bytes;
  };
  const bytes = readCommitted(relative);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { refuse('baseline inventory is not readable JSON'); }
  validateInventory(value, product);
  const declaration = readCommitted(value.dataPolicy.declaration);
  if (!declaration.length) refuse('data policy declaration is empty');
  if (readinessDigest(cleanSourceSnapshot(repository, ref)) !== readinessDigest(snapshot) || !readFileSync(full).equals(bytes)) refuse('inventory source changed during verification');
  const inventory = freeze({ value, provenance: { repository, ref, path: relative, sha256: hash(bytes), declarationSha256: hash(declaration) } });
  inventories.add(inventory); return inventory;
}

// Serialized into the owned installed Electron renderer. It reads DOM state
// and scrolls existing controls into view; all actions use native CDP Input.
function domRead(spec) {
  const { selector, text, textSelector, frame } = typeof spec === 'string' ? { selector: spec } : spec;
  const visible = node => {
    if (!node || node.hidden || node.closest('[hidden],[inert]')) return false;
    for (let p = node; p; p = p.parentElement) { const s = node.ownerDocument.defaultView.getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
    return node.getClientRects().length > 0;
  };
  let doc = document;
  if (frame) {
    const frames = [...doc.querySelectorAll(frame)];
    if (frames.length !== 1 || !visible(frames[0]) || !frames[0].contentDocument) return { url: location.href, rows: [] };
    doc = frames[0].contentDocument;
  }
  return { url: location.href, rows: [...doc.querySelectorAll(selector)].filter(node => text === undefined || (textSelector ? node.querySelector(textSelector)?.textContent : node.textContent)?.trim() === text).map(node => {
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = node.getBoundingClientRect();
    return { text: String(node.innerText ?? node.textContent ?? ''), value: node.value, visible: visible(node),
      disabled: !!node.disabled || node.getAttribute('aria-disabled') === 'true', pressed: node.getAttribute('aria-pressed'),
      x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }) };
}

async function execute(options, fixture) {
  const { product, profile, subject: suppliedSubject, runId, guest, signal } = options || {};
  const identity = INSTALLER_IDENTITIES[product];
  if (!identity || !Object.hasOwn(INSTALLER_IDENTITIES, product)) refuse('unknown product identity');
  if (!PROFILES.has(profile) || !UUID.test(runId || '')) refuse('supported runtime profile and run identity are required');
  subjectValid(suppliedSubject);
  const subject = freeze(structuredClone(suppliedSubject));
  const inventory = fixture
    ? freeze({ value: validateInventory(structuredClone(options.inventory), product), provenance: { fixture: true, sha256: readinessDigest(options.inventory) } })
    : options.inventory && inventories.has(options.inventory) ? options.inventory : readLifecycleInventory(options.inventoryPath, { product });
  if (!fixture && !inventories.has(inventory)) refuse('source-controlled lifecycle inventory authority is missing');
  validateInventory(inventory.value, product);
  if (inventory.value.supportedBaselines.some(row => sameArtifact(row.subject.artifact, subject.artifact))) refuse('candidate installer cannot stand in for a supported prior baseline');
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000, operationTimeoutMs = options.operationTimeoutMs ?? 120000, cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30000;
  if (![timeoutMs, operationTimeoutMs, cleanupTimeoutMs].every(n => Number.isSafeInteger(n) && n > 0) || timeoutMs > 2 * 60 * 60 * 1000 || operationTimeoutMs > 600000 || cleanupTimeoutMs > 60000) refuse('invalid bounded lifecycle budget');
  const required = ['attest', 'verifyObservation', 'preflightArtifacts', 'resetBaseline', 'restoreBaseline', 'quarantine', 'stageInstaller', 'measureFile', 'observeInstallation', 'startOwned', 'waitOwned', 'waitInstallerCheckpoint', 'terminateOwned', 'launch', 'stop', 'captureUserContent'];
  for (const method of required) if (typeof guest?.[method] !== 'function') refuse(`guest capability is unavailable: ${method}`);
  if (guest.mode !== (fixture ? 'fixture' : 'attested-disposable-guest')) refuse('a real attested disposable guest is required; a redirected install directory is not isolation');
  if (!fixture) {
    for (const method of ['assertCapabilities', 'stageInput', 'armDownload', 'collectDownload', 'readProductOutput', 'collectProviderEvidence', 'openExport']) {
      if ((method === 'openExport' && product !== 'presentation-suite') || (method === 'stageInput' && product !== 'scribe' && product !== 'toolsenabled') ||
          (['readProductOutput', 'collectProviderEvidence'].includes(method) && product === 'scribe') ||
          (['armDownload', 'collectDownload'].includes(method) && (product === 'web-editor' || product === 'toolsenabled'))) continue;
      if (typeof guest[method] !== 'function') refuse(`installed content journey transport is unavailable: ${method}`);
    }
  }
  const binding = freeze({ product, profile, runId, journeyId: null, subjectSha256: readinessDigest(subject), inventorySha256: inventory.provenance.sha256 });
  const report = { schema: 'toolsenabled.artifact-lifecycle-report', schemaVersion: 1, ...binding,
    scope: fixture ? 'synthetic-lifecycle-fixture' : 'exact-installer-lifecycle', fixture, fullProductCoverage: false,
    complete: false, cleanupConfirmed: false, inventory: inventory.provenance, observations: [], scenarios: [], startedAt: new Date().toISOString() };
  const pending = new Set(), observations = new Set(), processIds = new Set();
  const deadline = Date.now() + timeoutMs;
  let attestation, epoch = null, phaseId = null, current = null, activeJob = null, mutated = false, uncertain = false, failure = null;
  const context = () => ({ ...binding, phaseId, epochId: epoch?.epochId, guestId: attestation?.guestId });
  async function bounded(label, action, cleanup = false, scopeBudget = operationTimeoutMs) {
    const ms = cleanup ? cleanupTimeoutMs : Math.min(scopeBudget, deadline - Date.now());
    if (ms <= 0 || (!cleanup && signal?.aborted)) refuse(`${label}: cancelled or execution budget exhausted`, mutated || pending.size > 0);
    let timer, abort;
    const operation = Promise.resolve().then(action); pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        const cancel = reason => { const error = new Error(`Installer lifecycle blocked: ${label}: ${reason}`); error.code = 'INSTALLER_LIFECYCLE_BLOCKED'; error.cleanupUncertain = true; error.cleanupUnconfirmed = true; reject(error); };
        timer = setTimeout(() => cancel('timed out'), ms);
        if (!cleanup && signal) { abort = () => cancel('cancelled'); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }
      })]);
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }
  async function observation(value, kind, { root = false, cleanup = false, launchRequest } = {}) {
    if (!value || value.kind !== kind || value.runId !== runId || value.guestId !== attestation?.guestId || value.synthetic !== fixture || typeof value.observationId !== 'string' || !value.observationId || observations.has(value.observationId) ||
        value.journeyId !== null || (!root && (value.phaseId !== phaseId || value.epochId !== epoch?.epochId))) refuse(`${kind}: missing, stale or mismatched raw guest observation`, mutated);
    if (Object.hasOwn(value, 'installer')) refuse(`${kind}: ambiguous or legacy installer identity; artifact only is required`, mutated);
    if (!fixture && await bounded(`verify ${kind}`, () => guest.verifyObservation(value, { ...context(), kind, root, inventory: inventory.provenance, ...(launchRequest ? { launchRequest } : {}) }), cleanup) !== true) refuse(`${kind}: trusted guest evidence verification failed`, mutated);
    observations.add(value.observationId);
    // The raw report stays guest-side. Do not copy credentials, file contents,
    // local-account passwords or unbounded command output into this receipt.
    report.observations.push({ kind, observationId: value.observationId, sha256: observationDigest(value), phaseId, epochId: epoch?.epochId });
    return value;
  }
  async function observe(expected, expectedSubject) {
    const value = await observation(await bounded('observe exact installation', () => guest.observeInstallation({ ...context(), identity, expectedSubject })), 'installation');
    if (value.profileRoot !== PROFILE || value.reparsePoints?.length !== 0 || !samePath(value.installDir, identity.installDir) || value.unreadable?.length !== 0) refuse('installation path/isolation is unknown or unreadable', mutated);
    if (value.registry?.hive !== 'HKCU' || value.registry.key !== identity.registryKey || value.registry.view !== '64') refuse('wrong per-user uninstall registry identity', mutated);
    if (!Array.isArray(value.shortcuts) || !Array.isArray(value.files) || value.duplicateIdentities?.length !== 0) refuse('unmeasured or duplicate release installation identity', mutated);
    const links = value.shortcuts.filter(row => samePath(row.path, identity.shortcut));
    const executable = value.files.find(row => row.relativePath === identity.runtime);
    if (!expected) {
      if (value.registry.present !== false || links.length || executable || value.files.some(row => [identity.shell, identity.uninstaller].includes(row.relativePath))) refuse('uninstall/fresh state still contains a registered executable, shell or shortcut', mutated);
    } else {
      if (value.registry.present !== true || value.registry.values?.DisplayName !== identity.displayName || links.length !== 1 || !sameArtifact(links[0], links[0]) ||
          !samePath(links[0].target, path.win32.join(identity.installDir, identity.runtime)) || !Array.isArray(links[0].args) || readinessDigest(links[0].args) !== readinessDigest(identity.shortcutArgs.map(arg => arg.replace('{installDir}', identity.installDir)))) refuse('installed registry or required Start Menu shortcut is wrong', mutated);
      const shell = value.files.find(row => row.relativePath === identity.shell);
      if (!executable || !shell || !sameHash(executable.sha256, expectedSubject.runtimeSha256) || !sameHash(shell.sha256, expectedSubject.shellSha256) || !sameArtifact(value.artifact, expectedSubject.artifact) || value.subjectSha256 !== readinessDigest(expectedSubject)) refuse('installed bytes are not the exact candidate/baseline runtime and shell', mutated);
      if (!samePath(value.registry.uninstallExecutable, path.win32.join(identity.installDir, identity.uninstaller))) refuse('uninstaller registry executable does not belong to the exact installation', mutated);
      const uninstaller = path.win32.join(identity.installDir, identity.uninstaller);
      if (!registryCommandMatches(value.registry.values.UninstallString, uninstaller, product === 'toolsenabled' ? ['/currentuser'] : []) ||
          (product === 'toolsenabled' && !registryCommandMatches(value.registry.values.QuietUninstallString, uninstaller, ['/currentuser', '/S']))) refuse('actual registered uninstall command is wrong or unmeasured', mutated);
      if (product !== 'toolsenabled' && value.registry.values.Publisher !== 'ToolsEnabled') refuse('standalone installer publisher identity is missing', mutated);
    }
    return value;
  }
  async function reset(name) {
    if (current || activeJob || pending.size) refuse('cannot reset while an owned operation may be alive', true);
    phaseId = name; epoch = null; mutated = true;
    const value = await bounded('restore clean disposable baseline', () => guest.resetBaseline({ ...binding, phaseId, baselineId: attestation.baselineId }));
    if (!value || value.phaseId !== phaseId || !UUID.test(value.epochId || '') || value.baselineId !== attestation.baselineId || value.restored !== true || value.ownedJobsRemaining !== 0 || value.cleanUserData !== true || value.accountProfile !== PROFILE) refuse('clean isolated machine baseline was not measured', true);
    epoch = freeze(structuredClone(value));
    await observation(epoch, 'baseline-reset');
    await observe(false);
  }
  async function measuredFile(filename, expected) {
    guestFile(filename);
    const value = await observation(await bounded('measure exact executable bytes', () => guest.measureFile({ ...context(), path: filename })), 'file');
    if (!samePath(value.path, filename) || value.owned !== true || value.reparse !== false || !sameArtifact(value, value) || (expected && !sameArtifact(value, expected))) refuse('owned executable path or exact installer bytes changed', mutated);
    return { sha256: value.sha256, bytes: value.bytes };
  }
  async function stage(installerSubject) {
    const value = await observation(await bounded('stage exact installer in guest', () => guest.stageInstaller({ ...context(), artifact: installerSubject.artifact })), 'installer-stage');
    guestFile(value.path);
    if (!sameArtifact(value.artifact, installerSubject.artifact) || value.owned !== true || value.reparse !== false || value.path.toLowerCase().includes('\\programs\\')) refuse('exact installer is absent or was staged outside the owned guest scratch', mutated);
    await measuredFile(value.path, installerSubject.artifact); return value.path;
  }
  async function command(executable, args, expected, { token = 'standard', exitCode = 0, interruptAt = null } = {}) {
    if (current || activeJob) refuse('lifecycle command overlaps a running owned process', true);
    const before = await measuredFile(executable, expected);
    const spec = freeze({ executable, args, token, shell: false, hidden: true, installerIdentity: product, timeoutMs: operationTimeoutMs });
    mutated = true;
    const job = await bounded('start contained installer command', () => guest.startOwned({ ...context(), command: spec }));
    activeJob = job;
    await observation(job, 'job-start');
    if (!job.jobId || !job.leaseId || !processIdentity(job.process) || job.killOnClose !== true || job.breakawayAllowed !== false ||
        job.token !== token || !sameArtifact(job.executable, before) || job.commandSha256 !== readinessDigest(spec)) refuse('installer was not started in a verified owned non-breakaway job', true);
    const processKey = `${job.process.pid}:${job.process.startedAt}`;
    if (processIds.has(processKey)) refuse('installer process creation identity was replayed', true);
    processIds.add(processKey);
    if (interruptAt) {
      const point = await observation(await bounded('observe installer interruption checkpoint', () => guest.waitInstallerCheckpoint(job, { ...context(), point: interruptAt, relativePath: identity.runtime })), 'installer-checkpoint');
      if (point.jobId !== job.jobId || point.leaseId !== job.leaseId || !sameProcess(point.process, job.process) || point.alive !== true || point.point !== interruptAt || point.relativePath !== identity.runtime || point.operation !== (interruptAt === 'uninstall-files-removed' ? 'delete' : 'write') || point.changeObserved !== true || !HASH.test(point.eventTraceSha256 || '')) refuse('interruption did not observe real file mutation while the owned job was alive', true);
      const stopped = await observation(await bounded('terminate exact owned installer job', () => guest.terminateOwned(job, { ...context(), timeoutMs: cleanupTimeoutMs })), 'job-terminate');
      if (stopped.jobId !== job.jobId || stopped.leaseId !== job.leaseId || !sameProcess(stopped.process, job.process) || stopped.terminationConfirmed !== true || stopped.ownedChildrenConfirmed !== true) refuse('interrupted installer tree termination is unconfirmed', true);
    }
    const ended = await observation(await bounded('wait for entire owned installer tree', () => guest.waitOwned(job, { ...context(), timeoutMs: operationTimeoutMs })), 'job-exit');
    if (ended.jobId !== job.jobId || ended.leaseId !== job.leaseId || !sameProcess(ended.process, job.process) || ended.terminationConfirmed !== true || ended.ownedChildrenConfirmed !== true || ended.activeProcesses !== 0 || !Number.isInteger(ended.exitCode) || !Number.isFinite(Date.parse(ended.finishedAt)) || Date.parse(ended.finishedAt) < Date.parse(job.process.startedAt)) refuse('installer command completion or descendant containment is unmeasured', true);
    activeJob = null;
    if (interruptAt ? ended.interrupted !== true || ended.exitCode === 0 : ended.exitCode !== exitCode || ended.interrupted === true || ended.signal) refuse('installer command did not produce the required terminal outcome');
    return { commandSha256: job.commandSha256, process: job.process, jobId: job.jobId, exitCode: ended.exitCode, interrupted: !!interruptAt };
  }
  async function install(installerSubject, interruptAt = null, token = 'standard') {
    const filename = await stage(installerSubject);
    return command(filename, ['/S'], installerSubject.artifact, { token, exitCode: token === 'administrator' ? identity.elevatedSetupExitCode : 0, interruptAt });
  }
  async function uninstall(interruptAt = null) {
    const executable = path.win32.join(identity.installDir, identity.uninstaller);
    // _?= prevents NSIS's detached temporary-copy path. It is NOT a /D install
    // redirect and does not alter registry/data identity. Owned jobs still must
    // prove every descendant gone; a bootstrap exit is never completion.
    return command(executable, [...identity.uninstallArgs, `_?=${identity.installDir}`], null, { interruptAt });
  }
  async function launch(installerSubject) {
    if (current || activeJob) refuse('installed runtime launch overlaps an owned operation', true);
    // A correct shortcut census does not prove that launch used that shortcut.
    // Re-observe and measure it for every activation, including retained-data
    // and interrupted-recovery launches. The guest must activate this .lnk;
    // directly spawning its resolved target cannot satisfy the trace contract.
    const installation = freeze(structuredClone(await observe(true, installerSubject)));
    const shortcut = installation.shortcuts.find(row => samePath(row.path, identity.shortcut));
    const measuredShortcut = await measuredFile(identity.shortcut, shortcut);
    const launchRequest = freeze({
      mechanism: 'installed-start-menu-shortcut',
      shortcut: { path: identity.shortcut, ...measuredShortcut },
      resolvedTarget: path.win32.join(identity.installDir, identity.runtime),
      resolvedArgs: identity.shortcutArgs.map(arg => arg.replace('{installDir}', identity.installDir)),
      token: profile.endsWith('administrator') ? 'administrator' : 'standard',
      subjectSha256: readinessDigest(installerSubject),
      installationObservationId: installation.observationId,
      installationObservationSha256: observationDigest(installation),
    });
    const value = await bounded('launch measured installed Start Menu shortcut', () => guest.launch({ ...context(), subject: installerSubject, subjectSha256: readinessDigest(installerSubject), installDir: identity.installDir, launchRequest }));
    current = value;
    const proof = value?.attestation;
    await observation(proof, 'runtime-launch', { launchRequest });
    if (!value.id || typeof value.cdp?.send !== 'function' || proof.sessionId !== value.id || proof.installed !== true || proof.exact !== true || proof.isolated !== true || proof.hostRuntime !== false || proof.sourceOverlay !== false ||
        proof.product !== product || proof.profile !== profile || proof.token !== (profile.endsWith('administrator') ? 'administrator' : 'standard') || !sameArtifact(proof.artifact, installerSubject.artifact) || proof.subjectSha256 !== readinessDigest(installerSubject) ||
        !sameHash(proof.runtimeSha256, installerSubject.runtimeSha256) || !sameHash(proof.shellSha256, installerSubject.shellSha256) || !processIdentity(proof.process) || !proof.userDataIdentity ||
        Object.hasOwn(proof, 'processIdentity') || Object.hasOwn(proof, 'serverIdentity') ||
        (product !== 'toolsenabled' && (!processIdentity(proof.serverProcess) || sameProcess(proof.process, proof.serverProcess)))) refuse('installed runtime subject, requested token or durable account identity is wrong', true);
    const activation = proof.shortcutLaunch;
    if (activation?.mechanism !== launchRequest.mechanism || activation.requestSha256 !== readinessDigest(launchRequest) ||
        !samePath(activation.shortcut?.path, launchRequest.shortcut.path) || !sameArtifact(activation.shortcut, launchRequest.shortcut) ||
        activation.shortcut.owned !== true || activation.shortcut.reparse !== false ||
        !samePath(activation.resolvedTarget, launchRequest.resolvedTarget) || !Array.isArray(activation.resolvedArgs) || readinessDigest(activation.resolvedArgs) !== readinessDigest(launchRequest.resolvedArgs) ||
        !samePath(activation.runtime?.path, launchRequest.resolvedTarget) || !sameHash(activation.runtime?.sha256, installerSubject.runtimeSha256) || !sameProcess(activation.runtime?.process, proof.process) ||
        !HASH.test(activation.eventTraceSha256 || '')) refuse('installed Start Menu shortcut activation or its measured runtime process is unproven', true);
    guestFile(activation.shortcut.path); guestFile(activation.resolvedTarget); guestFile(activation.runtime.path);
    const key = `${proof.process.pid}:${proof.process.startedAt}`;
    if (processIds.has(key)) refuse('runtime relaunch reused an earlier process', true);
    processIds.add(key);
    if (proof.serverProcess) {
      if (!processIdentity(proof.serverProcess)) refuse('installed server creation identity is unmeasured', true);
      const serverKey = `${proof.serverProcess.pid}:${proof.serverProcess.startedAt}`;
      if (serverKey !== key && processIds.has(serverKey)) refuse('runtime relaunch reused an earlier server process', true);
      processIds.add(serverKey);
    }
    let url;
    try { url = new URL(proof.origin); } catch { refuse('owned renderer origin is unavailable', true); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !url.port) refuse('installed renderer is not the attested owned loopback origin', true);
    return value;
  }
  async function stop() {
    if (!current) return;
    const session = current;
    const value = await observation(await bounded('stop exact installed runtime tree', () => guest.stop(session, { ...context(), timeoutMs: cleanupTimeoutMs }), true), 'runtime-stop', { cleanup: true });
    if (value.sessionId !== session.id || value.product !== product || value.profile !== profile || value.subjectSha256 !== session.attestation.subjectSha256 ||
        !sameProcess(value.process, session.attestation.process) || (session.attestation.serverProcess && !sameProcess(value.serverProcess, session.attestation.serverProcess)) ||
        value.terminationConfirmed !== true || value.ownedChildrenConfirmed !== true) refuse('installed runtime cleanup is uncertain', true);
    current = null;
  }
  const cdp = (method, params = {}) => bounded(method, () => current.cdp.send(method, params, { signal }));
  async function read(selector) {
    const answer = await cdp('Runtime.evaluate', { expression: `(${domRead.toString()})(${JSON.stringify(selector)})`, returnByValue: true });
    if (answer?.exceptionDetails || !answer?.result?.value || !Array.isArray(answer.result.value.rows)) refuse('installed DOM could not be observed');
    if (!answer.result.value.url.startsWith(`${current.attestation.origin}/`)) refuse('renderer left its attested installed origin');
    return answer.result.value;
  }
  async function wait(label, predicate) {
    const until = Math.min(deadline, Date.now() + operationTimeoutMs);
    for (;;) { const value = await predicate(); if (value) return value; if (Date.now() >= until) refuse(`${label} did not become true`); await bounded('wait for observed renderer state', () => new Promise(resolve => setTimeout(resolve, 50))); }
  }
  async function visible(selector) {
    return wait(`visible ${selector}`, async () => { const rows = (await read(selector)).rows.filter(row => row.visible); return rows.length === 1 && !rows[0].disabled ? rows[0] : false; });
  }
  async function click(selector) {
    const row = await visible(selector);
    if (![row.x, row.y].every(Number.isFinite)) refuse('control has no measured click point');
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: row.x, y: row.y, button: 'left', clickCount: 1 });
  }
  async function fill(selector, text) {
    await click(selector);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp('Input.insertText', { text });
    await wait('native input accepted', async () => (await visible(selector)).value === text);
  }
  async function navigate(route) { await cdp('Page.navigate', { url: `${current.attestation.origin}/${route}` }); }
  async function firstRun(installerSubject, fresh) {
    await launch(installerSubject);
    if (product === 'toolsenabled') {
      const initial = await read('body');
      if (fresh) {
        await wait('fresh permission question', async () => (await read('[data-setup-section]')).url.endsWith('#/setup'));
        await click('[data-setup-continue]');
        await visible('.setup-root-path'); await click('[data-setup-next="account"]');
        await click('[data-setup-next="autonomy"]');
        await click('[data-setup-set="autonomy"][data-setup-value="assisted"]');
        await click('[data-setup-next="review"]'); await click('[data-setup-next="finish"]');
      } else if (initial.url.endsWith('#/setup')) refuse('retained installation unexpectedly lost its completed first run');
      await visible(identity.readySelector);
    } else {
      // The installed default config is present; reaching the ordinary product
      // UI and then its documented setup is checked, never assumed from HTTP.
      await visible(identity.readySelector);
      if (fresh) {
        await navigate('setup'); await visible('#config'); await click('#save');
        await wait('documented configuration save', async () => (await visible('#saved')).text === 'Saved. Restart to apply server settings.');
        const refusal = (await read('#refusal')).rows;
        if (refusal.some(row => row.text.trim())) refuse('documented first-run config was refused');
        await click('a.start'); await visible(identity.readySelector);
      }
    }
    const userDataIdentity = current.attestation.userDataIdentity;
    await stop(); return userDataIdentity;
  }
  async function contentSnapshot(marker, expectedKinds = identity.contentKinds) {
    const value = await observation(await bounded('measure persisted customer content', () => guest.captureUserContent({ ...context(), identity, marker, kinds: expectedKinds, roots: identity.contentRoots, maxBytes: 32 * 1024 * 1024 })), 'user-content');
    if (!Array.isArray(value.files) || value.files.length > 4096 || !Array.isArray(value.roots) || value.unreadable?.length !== 0 || value.reparsePoints?.length !== 0) refuse('customer content census is unreadable or linked');
    exactSet(value.roots.map(row => row.id), identity.contentRoots, 'measured customer-data roots');
    if (value.roots.some(row => !['present', 'absent'].includes(row.state) || row.owned !== true ||
        (row.state === 'present' ? !HASH.test(row.sha256 || '') : row.sha256 !== null))) refuse('customer-data root ownership or complete content census is unknown');
    const seen = new Set(); let totalBytes = 0;
    for (const file of value.files) {
      const key = `${file.root}/${file.relativePath}`.toLowerCase();
      if (!identity.contentRoots.includes(file.root) || !relativeFile(file.relativePath) || seen.has(key) || !sameArtifact(file, file) || file.owned !== true || file.createdThroughUi !== true || !identity.contentKinds.includes(file.kind)) refuse('customer file is not a unique observed UI-created owned output');
      seen.add(key);
      // Raw customer bytes establish the requested marker, not a callback's
      // ok:true. They are discarded from the returned host report.
      totalBytes += file.bytes;
      if (!(file.data instanceof Uint8Array) || file.data.length !== file.bytes || totalBytes > 32 * 1024 * 1024 || !sameHash(hash(file.data), file.sha256) || !Buffer.from(file.data).toString('utf8').includes(marker)) refuse('persisted customer bytes are absent, changed or unrelated to this journey');
    }
    if (expectedKinds.some(kind => !value.files.some(file => file.kind === kind))) refuse('a required customer-content kind was never created and measured');
    return { files: value.files.map(({ root, relativePath, kind, sha256, bytes }) => ({ root, relativePath, kind, sha256: sha256.toLowerCase(), bytes })), roots: value.roots.map(({ id, state, sha256 }) => ({ id, state, sha256: sha256?.toLowerCase() ?? null })) };
  }
  async function seed(installerSubject) {
    const journeyId = randomUUID(), marker = journeyId.replaceAll('-', '');
    if (product === 'toolsenabled') {
      await launch(installerSubject); await navigate('#/account');
      if (!(await read('[data-account-form="create"]')).rows.some(row => row.visible)) await click('[data-account-mode="create"]');
      await fill('[data-account-form="create"] [name="username"]', `lifecycle-${marker.slice(0, 16)}`);
      await fill('[data-account-form="create"] [name="displayName"]', `Lifecycle ${marker}`);
      // A newly generated local test password only. Never a provider login or
      // owner credential, and never copied into this driver's evidence.
      await fill('[data-account-form="create"] [name="password"]', `${randomUUID()}Aa!9`);
      await click('[data-account-form="create"] button[type="submit"]');
      await wait('actual local account creation', async () => (await visible('.setup-title')).text === `Signed in as Lifecycle ${marker}`);
      await stop();
    }
    if (product !== 'toolsenabled' || phaseId === 'fresh-install') {
      await runContentJourney(installerSubject, journeyId, marker);
    }
    return { marker, snapshot: await contentSnapshot(marker) };
  }
  async function runContentJourney(installerSubject, journeyId = randomUUID(), marker = journeyId.replaceAll('-', '')) {
    // Production uses the concrete native-DOM desktop driver, not a caller
    // supplied content callback or direct file/state writes. Fixture injection
    // is deliberately confined to the explicitly synthetic exported seam.
    const result = fixture
      ? await bounded('synthetic content mechanics', () => options.fixtureContentJourney({ ...context(), product, subject: installerSubject, journeyId, epoch, marker }))
      : await bounded('installed customer content journey', () => executeDesktopJourney({ product, profile, subject: installerSubject, runId, journeyId, epoch, guest, signal, timeoutMs: Math.min(600000, Math.max(1, deadline - Date.now())), operationTimeoutMs, cleanupTimeoutMs }), false, 600000);
    if (result?.complete !== true || result.cleanupConfirmed !== true || result.runId !== runId || result.journeyId !== journeyId || result.epochId !== epoch.epochId || result.phaseId !== phaseId || result.guestId !== attestation.guestId ||
        result.epoch?.observationId !== epoch.observationId || result.epoch?.sha256 !== readinessDigest(epoch) ||
        result.product !== product || result.profile !== profile || result.fixture !== fixture || result.scope !== (fixture ? 'synthetic-driver-fixture' : 'exact-installed-desktop-journey') || result.subjectSha256 !== readinessDigest(installerSubject) || !Array.isArray(result.assertions) || result.assertions.length !== DESKTOP_JOURNEYS[product].assertions.length) refuse('real installed customer-content journey did not complete', result?.cleanupConfirmed !== true);
    exactSet(result.assertions.map(row => row.id), DESKTOP_JOURNEYS[product].assertions, 'installed customer-content assertions');
    if (result.assertions.some(row => row.status !== 'passed' || !HASH.test(row.evidenceSha256 || ''))) refuse('a named installed customer-content assertion has no passing evidence');
    if (product === 'toolsenabled' && readinessDigest(installerSubject) === readinessDigest(subject)) {
      passed(`durable-critical-journey:${phaseId}`, {
        journey: {
          complete: result.complete, cleanupConfirmed: result.cleanupConfirmed, scope: result.scope, fixture: result.fixture,
          product: result.product, profile: result.profile, runId: result.runId, subjectSha256: result.subjectSha256, journeyId: result.journeyId,
          phaseId: result.phaseId, epochId: result.epochId, guestId: result.guestId, epoch: result.epoch,
          assertions: result.assertions,
        },
      });
    }
  }
  async function preserved(content) {
    const after = await contentSnapshot(content.marker);
    const ordered = files => [...files].sort((a, b) => {
      const left = `${a.root}/${a.relativePath}`, right = `${b.root}/${b.relativePath}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (readinessDigest(ordered(after.files)) !== readinessDigest(ordered(content.snapshot.files))) refuse('the installer lost or changed persisted customer content');
    // Roots include customer files not named by the representative document
    // journey. Losing drafts, outputs or another setting cannot be hidden by
    // retaining only the one marker file. The guest census excludes ONLY the
    // known disclosure note, not arbitrary caller-supplied ignore patterns.
    const roots = value => [...value].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (readinessDigest(roots(after.roots)) !== readinessDigest(roots(content.snapshot.roots))) refuse('the installer changed the complete customer-data root census');
    return after;
  }
  async function reopen(installerSubject, content, expectedUserData) {
    await launch(installerSubject);
    if (current.attestation.userDataIdentity !== expectedUserData) refuse('runtime reopened a different user-data namespace');
    if (product === 'toolsenabled') {
      if ((await read('body')).url.endsWith('#/setup')) refuse('retained installation unexpectedly lost its completed first run');
      await navigate('#/account');
      await wait('retained local account reopened', async () => (await visible('.setup-title')).text === `Signed in as Lifecycle ${content.marker}`);
    } else if (product === 'scribe') {
      await wait('retained document reopened', async () => (await read('#paper .para')).rows.some(row => row.visible && row.text.includes(content.marker)));
    } else if (product === 'web-editor') {
      const filename = `qualification-${content.marker}.html`;
      await click({ selector: '#files button.file', textSelector: 'code', text: filename });
      await wait('retained working page opened', async () => (await visible('#chrome-path')).text.includes(filename));
      const frame = 'iframe[title="Live website preview"]';
      await wait('retained page content rendered', async () =>
        (await visible({ selector: 'h1', frame })).text === `Edited ${content.marker}` &&
        (await visible({ selector: 'p', frame })).text === `Durable content ${content.marker}`);
    } else await wait('retained presentation reopened', async () => (await visible('#deckTitle')).text.includes(content.marker));
    await stop();
  }
  async function chooseRetention(mode, installerSubject) {
    if (product !== 'toolsenabled') return;
    await launch(installerSubject); await navigate('#/settings?category=data-privacy');
    const value = mode === 'ask-silent' ? 'ask' : mode;
    const selector = `[data-setting-id="uninstall_data"] [data-setting-value="${value}"]`;
    await click(selector);
    await wait('recorded account uninstall preference', async () => (await visible(selector)).pressed === 'true');
    await stop();
    const policy = await observation(await bounded('read product-recorded uninstall consent', () => guest.measureFile({ ...context(), path: `${PROFILE}\\AppData\\Roaming\\ToolsEnabled\\uninstall-data-policy.txt`, readText: true })), 'file');
    if (policy.text?.trimEnd() !== value || policy.owned !== true || policy.reparse !== false || !sameArtifact(policy, policy) || !sameHash(hash(Buffer.from(policy.text)), policy.sha256)) refuse('UI choice was not durably recorded for the real uninstaller');
  }
  const passed = (id, details) => report.scenarios.push({ id, ...details });
  async function quarantine(reason) {
    const value = await observation(await bounded('durably quarantine uncertain lifecycle guest', () => guest.quarantine({ ...context(), reason }), true), 'guest-quarantine', { root: !epoch, cleanup: true });
    if (value.quarantined !== true || !value.leaseId || !HASH.test(value.markerSha256 || '')) refuse('durable quarantine could not be confirmed', true);
    report.quarantineConfirmed = true;
  }
  try {
    const requirements = ['disposable-machine', 'standard-installer-token', profile, 'kill-on-close-nonbreakaway-job', 'installer-file-checkpoint', 'installed-start-menu-shortcut-launch', 'durable-quarantine', 'no-owner-data',
      ...(identity.elevatedSetupExitCode !== null ? ['administrator-installer-token-for-refusal'] : []), ...(DESKTOP_JOURNEYS[product]?.capabilities || ['provider-egress-denied'])];
    const raw = await bounded('attest disposable guest authority', () => guest.attest({ ...binding, inventory: inventory.provenance, requirements }));
    attestation = raw;
    if (!raw?.guestId || !raw.baselineId || raw.isolation !== 'disposable-machine' || raw.dedicated !== true || raw.poweredOffBaseline !== true || raw.accountProfile !== PROFILE || raw.runId !== runId || raw.synthetic !== fixture || raw.inventorySha256 !== binding.inventorySha256 || raw.capabilitiesComplete !== true) refuse('disposable guest, policy authority or required capabilities are not attested');
    exactSet(raw.capabilities, requirements, 'attested guest capabilities');
    await observation(raw, 'guest-attestation', { root: true });
    const artifacts = [subject.artifact, ...inventory.value.supportedBaselines.map(row => row.subject.artifact)];
    const available = await observation(await bounded('locate every exact supported installer', () => guest.preflightArtifacts({ ...binding, artifacts })), 'artifact-preflight', { root: true });
    if (!Array.isArray(available.artifacts) || available.artifacts.length !== artifacts.length || artifacts.some(expected => available.artifacts.filter(row => sameArtifact(row, expected) && row.available === true).length !== 1)) refuse('a required candidate/baseline installer is absent; upgrade coverage is unmeasured');

    if (identity.elevatedSetupExitCode !== null) {
      await reset('elevated-setup-refusal');
      const result = await install(subject, null, 'administrator'); await observe(false);
      passed('elevated-setup-refusal', result);
    }
    await reset('fresh-install');
    const installed = await install(subject); await observe(true, subject);
    const userData = await firstRun(subject, true), content = await seed(subject);
    await reopen(subject, content, userData);
    passed('fresh-install-and-documented-first-run', { installed, userDataIdentity: userData, customerFiles: content.snapshot.files });

    for (const baseline of inventory.value.supportedBaselines) {
      await reset(`upgrade:${baseline.id}`);
      await install(baseline.subject); await observe(true, baseline.subject);
      const oldUserData = await firstRun(baseline.subject, true), oldContent = await seed(baseline.subject);
      const upgraded = await install(subject); await observe(true, subject); await preserved(oldContent);
      await reopen(subject, oldContent, oldUserData);
      // The baseline account flow creates data to preserve. Do not require
      // an old installer to expose the candidate's current agent controls:
      // the provider/runtime journey executes AFTER the candidate upgrade.
      if (product === 'toolsenabled') await runContentJourney(subject);
      passed(`upgrade:${baseline.id}`, { baseline: baseline.subject.artifact, upgraded, customerFiles: oldContent.snapshot.files });
    }
    for (const mode of identity.uninstallModes) {
      await reset(`uninstall-reinstall:${mode}`);
      await install(subject); await observe(true, subject);
      const priorUserData = await firstRun(subject, true), priorContent = await seed(subject);
      await chooseRetention(mode, subject);
      // The preference itself is a legitimate user mutation; capture the data
      // only AFTER it was persisted, immediately before the real uninstaller.
      priorContent.snapshot = await contentSnapshot(priorContent.marker);
      const removed = await uninstall(); await observe(false);
      if (mode === 'remove-everything') {
        const empty = await contentSnapshot(priorContent.marker, []);
        if (empty.files.length || empty.roots.some(row => ['roaming-product', 'local-service'].includes(row.id) && row.state !== 'absent')) refuse('remove-everything left product state behind');
        const external = roots => roots.filter(row => row.id === 'external-workspace');
        if (readinessDigest(external(empty.roots)) !== readinessDigest(external(priorContent.snapshot.roots))) refuse('remove-everything changed the customer-owned external workspace');
      } else await preserved(priorContent);
      if (mode === 'ask-silent') {
        const note = await observation(await bounded('read silent-uninstall retention disclosure', () => guest.measureFile({ ...context(), path: `${PROFILE}\\AppData\\Roaming\\ToolsEnabled\\DATA-KEPT-AFTER-UNINSTALL.txt`, readText: true })), 'file');
        if (note.owned !== true || note.reparse !== false || !note.text?.includes('YOUR DATA IS STILL ON THIS COMPUTER') || !sameHash(hash(Buffer.from(note.text)), note.sha256)) refuse('silent uninstall did not truthfully disclose retained data');
      }
      await install(subject); await observe(true, subject);
      if (mode === 'remove-everything') { await firstRun(subject, true); await seed(subject); }
      else { await preserved(priorContent); await reopen(subject, priorContent, priorUserData); }
      passed(`uninstall-reinstall:${mode}`, { removed, customerFiles: priorContent.snapshot.files });
    }
    const interruptions = [{ id: 'interrupted-fresh-install', point: 'fresh-install-files-written', baseline: null },
      ...inventory.value.supportedBaselines.map(baseline => ({ id: `interrupted-upgrade:${baseline.id}`, point: 'upgrade-files-written', baseline })),
      { id: 'interrupted-uninstall', point: 'uninstall-files-removed', baseline: { subject } }];
    for (const row of interruptions) {
      await reset(row.id);
      let previous = null, previousUserData = null;
      if (row.baseline) {
        await install(row.baseline.subject); await observe(true, row.baseline.subject);
        previousUserData = await firstRun(row.baseline.subject, true); previous = await seed(row.baseline.subject);
        if (row.point === 'uninstall-files-removed') { await chooseRetention(product === 'toolsenabled' ? 'keep-my-data' : 'retain-user-content', subject); previous.snapshot = await contentSnapshot(previous.marker); }
      }
      const interrupted = row.point === 'uninstall-files-removed' ? await uninstall(row.point) : await install(subject, row.point);
      if (previous) await preserved(previous);
      const recovered = await install(subject); await observe(true, subject);
      if (previous) { await preserved(previous); await reopen(subject, previous, previousUserData); }
      else { await firstRun(subject, true); await seed(subject); }
      passed(row.id, { interrupted, recovered, customerFiles: previous?.snapshot.files || [] });
    }
  } catch (error) { failure = error; uncertain ||= cleanupUnknown(error); }
  finally {
    if (current) { try { await stop(); } catch (error) { uncertain = true; failure ||= error; } }
    if (activeJob || pending.size) uncertain = true;
    if (uncertain) {
      try {
        await quarantine(failure?.message || 'owned process state is unknown');
      } catch (error) { report.quarantineError = error.message; failure ||= error; }
    } else if (mutated) {
      try {
        const value = await observation(await bounded('power off and restore owned baseline', () => guest.restoreBaseline({ ...context(), baselineId: attestation.baselineId }), true), 'baseline-restored', { cleanup: true });
        if (value.poweredOff !== true || value.restored !== true || value.baselineId !== attestation.baselineId || value.ownedJobsRemaining !== 0) refuse('final guest recovery is unconfirmed', true);
        report.cleanupConfirmed = true;
      } catch (error) {
        failure ||= error; uncertain = true;
        try { await quarantine(error.message); }
        catch (quarantineError) { report.quarantineError = quarantineError.message; }
      }
    } else report.cleanupConfirmed = !pending.size;
    report.finishedAt = new Date().toISOString();
  }
  const journeyScenarios = product === 'toolsenabled' ? 1 + inventory.value.supportedBaselines.length : 0;
  const expected = (identity.elevatedSetupExitCode === null ? 0 : 1) + 1 + inventory.value.supportedBaselines.length + identity.uninstallModes.length + 2 + inventory.value.supportedBaselines.length + journeyScenarios;
  report.cleanupUnconfirmed = uncertain || !report.cleanupConfirmed;
  report.complete = !failure && !uncertain && report.cleanupConfirmed && report.scenarios.length === expected;
  if (!report.complete) { failure ||= new Error('Installer lifecycle blocked: a required scenario or cleanup was not measured'); failure.code ||= 'INSTALLER_LIFECYCLE_BLOCKED';
    failure.cleanupUnconfirmed = report.cleanupUnconfirmed; failure.cleanupUncertain = report.cleanupUnconfirmed;
    report.error = failure.message; failure.report = report; throw failure; }
  return report;
}

/**
 * Guest RPC contract: all methods execute inside one pre-armed, explicitly
 * configured disposable guest; no host installer invocation exists here.
 *
 * Every observation carries kind, observationId, runId, guestId, synthetic,
 * phaseId, epochId and journeyId (null for lifecycle-owned operations). The
 * fixed trusted guest verifier must bind its raw trace
 * to those fields; caller-written JSON is not execution authority. Inventory
 * provenance must be authorized by that verifier, not just a local Git commit.
 * resetBaseline creates a fresh epoch from the powered-off clean baseline;
 * restoreBaseline must leave it powered off, restored and without owned jobs.
 * stageInstaller + measureFile read the exact artifact and refuse links/ADS;
 * startOwned uses the fixed executable/argv/token in a suspended process joined
 * to a kill-on-close, non-breakaway Windows job before resuming it. waitOwned
 * reports the root creation identity AND zero active owned descendants.
 * waitInstallerCheckpoint observes a real write/delete of the installed runtime
 * while that same job is alive; terminateOwned addresses its retained job lease,
 * never a PID lookup after root exit. A missed checkpoint is unmeasured, not a
 * successful interruption. No elapsed-time kill or detached bootstrap success.
 * observeInstallation reads the fixed HKCU key, mandatory Start Menu shortcut
 * (sha256, bytes, resolved target and argument vector),
 * exact installed runtime/shell, duplicate identities and unreadable/link census.
 * launch/stop use the same canonical runtime observations as desktop journeys:
 * artifact, subjectSha256, process, and serverProcess for a standalone's separate
 * server, plus product/profile/session and the full run/phase/epoch binding.
 * Every lifecycle launch receives a frozen launchRequest with mechanism
 * installed-start-menu-shortcut, the fixed measured shortcut, resolvedTarget,
 * resolvedArgs, token, subjectSha256 and the fresh installation observation.
 * The guest must activate that shortcut under the requested token, remeasure it
 * at activation, and refuse any changed bytes, link/reparse path or resolution.
 * runtime-launch.shortcutLaunch binds mechanism, requestSha256, the actual
 * shortcut {path, sha256, bytes, owned, reparse}, resolvedTarget/resolvedArgs,
 * runtime {path, sha256, process}, and eventTraceSha256. verifyObservation
 * receives the expected launchRequest and must check the retained native trace
 * proves shortcut activation and its causal runtime creation identity; copied
 * request fields, a direct target spawn, or an existing process are not proof.
 * Nested desktop journeys preserve the parent runId, receive its verified reset
 * observation and use a distinct journeyId; no unrelated child run is invented.
 * captureUserContent reads only the run's UI-created customer files and censuses
 * every fixed data root; it returns bytes for marker/hash verification, never
 * success booleans. External workspace/publish roots must already be explicitly
 * owned inside the guest. No profile/env redirects or account/credential import.
 * quarantine must be durable even when RPC completion/cleanup is uncertain.
 * The outward error AND report normalize every uncertain cleanup to
 * cleanupUnconfirmed:true for the aggregate orchestrator. Confirmed ordinary
 * failures remain failed but may report cleanupConfirmed:true after recovery.
 *
 * Production guest integration and all real executions remain required. This
 * driver is not registered as a trusted qualifier and cannot emit releaseReady.
 */
async function normalizedExecute(options, fixture) {
  try { return await execute(options, fixture); }
  catch (error) {
    // Provenance helpers run before guest entry and may report an uncertain
    // bounded read-only subprocess with terminationConfirmed:false instead.
    if (cleanupUnknown(error)) { error.cleanupUnconfirmed = true; error.cleanupUncertain = true; }
    throw error;
  }
}
export function executeInstallerLifecycle(options) { return normalizedExecute(options, false); }

// Explicit fixture mechanics seam only; never emits exact-installer proof scope.
export function executeInstallerLifecycleFixture(options) { return normalizedExecute(options, true); }
