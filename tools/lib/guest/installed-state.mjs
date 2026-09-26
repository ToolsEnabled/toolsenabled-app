import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { INSTALLER_IDENTITIES } from '../drivers/installer-lifecycle.mjs';
import { readinessDigest } from '../release-readiness.mjs';
import { DEV_PROFILE, DEV_TEMP, plainPath, readBounded, measureFile } from '../adapters/artifact-files.mjs';
import { fileIdentity, parseOwnedRuntimeObservation, runOwnedJob } from '../transport/owned-job.mjs';

const HELPER = fileURLToPath(new URL('./Read-InstalledState.ps1', import.meta.url));
const LOADED_HELPER = Object.freeze(measureFile(HELPER));
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const REGISTRY_ROOT = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const VALUE_NAMES = ['DisplayName', 'Publisher', 'UninstallString', 'QuietUninstallString', 'InstallLocation', 'DisplayVersion'];
const HASH = /^[a-f0-9]{64}$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contexts = new WeakSet();
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const isHash = value => typeof value === 'string' && HASH.test(value);
const sameHash = (a, b) => isHash(a) && isHash(b) && a.toLowerCase() === b.toLowerCase();
const identityOf = product => {
  if (typeof product !== 'string' || !Object.hasOwn(INSTALLER_IDENTITIES, product)) block('unknown fixed product identity');
  return INSTALLER_IDENTITIES[product];
};
function block(message, cleanupUnconfirmed = false) {
  const error = new Error(`Installed-state measurement blocked: ${message}`);
  error.code = 'INSTALLED_STATE_BLOCKED'; error.cleanupUnconfirmed = cleanupUnconfirmed; throw error;
}
function optionsOnly(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) block('arbitrary path, registry, tool or policy overrides are not accepted');
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) block(`missing or unknown ${label}`);
}
function subjectFor(product, subject) {
  if (!subject || subject.product !== product || Object.hasOwn(subject, 'installer') || !isHash(subject.artifact?.sha256) ||
      !Number.isSafeInteger(subject.artifact?.bytes) || subject.artifact.bytes <= 0 || !isHash(subject.runtimeSha256) || !isHash(subject.shellSha256)) block('a full canonical product subject with artifact identity is required');
  const copy = structuredClone(subject);
  if (JSON.stringify(copy).length > 2 * 1024 * 1024) block('subject exceeds its byte budget');
  return copy;
}
function measuredFile(row) {
  return row && isHash(row.sha256) && Number.isSafeInteger(row.bytes) && row.bytes >= 0;
}
function array(value, limit, label) {
  if (!Array.isArray(value) || value.length > limit) block(`missing or oversized ${label}`);
  return value;
}

/** Fixed request context only. Creating it neither measures nor attests an installation. */
export function createInstalledStateContext(options) {
  optionsOnly(options, ['product', 'subject']);
  const product = options.product, identity = identityOf(product), subject = subjectFor(product, options.subject);
  const context = freeze({ product, subject, expectedSubjectSha256: readinessDigest(subject), fixedIdentitySha256: readinessDigest(identity) });
  contexts.add(context);
  return context;
}

// Windows quote/backslash tokenization, not a shell. No expansion, execution,
// path lookup, or registry value is ever passed to a command interpreter.
export function splitWindowsArguments(text) {
  if (typeof text !== 'string' || text.length > 32767 || /[\0\r\n]/.test(text)) block('invalid raw Windows command arguments');
  const args = []; let i = 0;
  while (i < text.length) {
    while (/[ \t]/.test(text[i] || '') && i < text.length) i++;
    if (i === text.length) break;
    let value = '', quoted = false;
    while (i < text.length && (quoted || !/[ \t]/.test(text[i]))) {
      let slashes = 0;
      while (text[i] === '\\') { slashes++; i++; }
      if (text[i] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) { value += '"'; i++; }
        else if (quoted && text[i + 1] === '"') { value += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else { value += '\\'.repeat(slashes); if (i < text.length && (quoted || !/[ \t]/.test(text[i]))) value += text[i++]; }
    }
    if (quoted) block('unterminated Windows argument quote');
    args.push(value);
  }
  return args;
}
function uninstallExecutable(entry) {
  try { return entry.values.UninstallString === undefined ? null : splitWindowsArguments(entry.values.UninstallString)[0] || null; }
  catch { return null; }
}
function registryViews(input) {
  const views = array(input, 2, 'registry views');
  if (views.length !== 2 || new Set(views.map(view => view.view)).size !== 2 || views.some(view => !['32', '64'].includes(view.view) || typeof view.rootPresent !== 'boolean')) block('both native registry views must be measured');
  return views.map(view => {
    const entries = array(view.entries, 4096, 'registry entries'), names = new Set();
    if (!view.rootPresent && entries.length) block('absent registry root contains claimed entries');
    for (const entry of entries) {
      const suffix = typeof entry.key === 'string' && entry.key.startsWith(`${REGISTRY_ROOT}\\`) ? entry.key.slice(REGISTRY_ROOT.length + 1) : '';
      if (!suffix || suffix.includes('\\') || /[\0\r\n]/.test(suffix) || names.has(entry.key.toLowerCase())) block('duplicate or out-of-scope native registry key');
      names.add(entry.key.toLowerCase());
      if (!entry.values || typeof entry.values !== 'object' || Array.isArray(entry.values) || !entry.valueTypes || typeof entry.valueTypes !== 'object' || Array.isArray(entry.valueTypes)) block('native registry values/types were not measured');
      for (const [key, value] of Object.entries(entry.values)) {
        if (!VALUE_NAMES.includes(key) || (value !== null && (typeof value !== 'string' || value.length > 32768 || value.includes('\0'))) || !Number.isInteger(entry.valueTypes[key])) block('malformed or unbounded registry value');
        if ([1, 2].includes(entry.valueTypes[key]) !== (typeof value === 'string')) block('registry value type and raw text disagree');
      }
      if (Object.keys(entry.valueTypes).some(key => !Object.hasOwn(entry.values, key))) block('registry type lacks its observed value');
    }
    return { view: view.view, rootPresent: view.rootPresent, entries: [...entries].sort((a, b) => a.key.toLowerCase() < b.key.toLowerCase() ? -1 : 1) };
  }).sort((a, b) => a.view < b.view ? -1 : 1);
}
function scopedRegistry(views, identity, product) {
  const selected = [];
  for (const view of views) {
    for (const entry of view.entries) {
      const display = entry.values.DisplayName?.toLowerCase();
      const command = uninstallExecutable(entry), location = entry.values.InstallLocation;
      const sharedPath = value => typeof value === 'string' && (samePath(value, identity.installDir) || value.toLowerCase().startsWith(`${identity.installDir.toLowerCase()}\\`));
      if (entry.key.toLowerCase() === identity.registryKey.toLowerCase() || display === identity.displayName.toLowerCase() ||
          product === 'toolsenabled' && display === 'mission control' || sharedPath(command) || sharedPath(location)) selected.push({ ...entry, view: view.view });
    }
  }
  const primary = selected.find(row => row.view === '64' && row.key.toLowerCase() === identity.registryKey.toLowerCase());
  const duplicates = [], aliases = primary ? ['64'] : [];
  for (const entry of selected) {
    if (entry === primary) continue;
    if (primary && entry.key.toLowerCase() === primary.key.toLowerCase() && readinessDigest(entry.values) === readinessDigest(primary.values) && readinessDigest(entry.valueTypes) === readinessDigest(primary.valueTypes)) { aliases.push(entry.view); continue; }
    const existing = duplicates.find(row => row.key.toLowerCase() === entry.key.toLowerCase() && readinessDigest(row.values) === readinessDigest(entry.values));
    if (existing) existing.views.push(entry.view);
    else duplicates.push({ key: entry.key, values: entry.values, views: [entry.view] });
  }
  return { registry: { hive: 'HKCU', key: identity.registryKey, view: '64', present: !!primary, values: primary?.values || {}, valueTypes: primary?.valueTypes || {},
    uninstallExecutable: primary ? uninstallExecutable(primary) : null, viewAliases: aliases.sort() }, duplicateIdentities: duplicates };
}

/** Parse-only seam. Caller JSON never becomes native execution/attestation. */
export function parseNativeInstalledState(bytes, options) {
  optionsOnly(options, ['product', 'subject']);
  const { product } = options, identity = identityOf(product), subject = subjectFor(product, options.subject);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 16 * 1024 * 1024) block('native report is absent or oversized');
  let raw;
  try { raw = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { block('native report is not a complete JSON object'); }
  if (!raw || raw.schema !== 'toolsenabled.native-installed-state' || raw.schemaVersion !== 1 || raw.product !== product || !samePath(raw.profileRoot, DEV_PROFILE) ||
      typeof raw.accountSid !== 'string' || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(raw.accountSid) || raw.registryRoot !== REGISTRY_ROOT || typeof raw.complete !== 'boolean' ||
      typeof raw.installRootPresent !== 'boolean' || !Number.isSafeInteger(raw.censusEntries) || raw.censusEntries < 0 || raw.censusEntries > 100000) block('native account, scope or census metadata is invalid');
  for (const key of ['displayName', 'runtime', 'shell', 'uninstaller']) if (raw.identity?.[key] !== identity[key]) block('native helper fixed identity differs from the lifecycle contract');
  for (const key of ['installDir', 'registryKey', 'shortcut']) if (!samePath(raw.identity?.[key], identity[key])) block('native helper fixed paths differ from the lifecycle contract');
  if (!samePath(raw.installDir, identity.installDir) || raw.identity?.product !== product) block('caller-selected native installation policy was substituted');
  const issues = list => array(list, 100000, 'native issue census').map(row => {
    if (!row || typeof row.location !== 'string' || row.location.length > 2048 || typeof row.code !== 'string' || row.code.length > 2048) block('native issue lacks a bounded location/reason');
    return { location: row.location, code: row.code };
  });
  const unreadable = issues(raw.unreadable), reparsePoints = issues(raw.reparsePoints);
  if (raw.complete && (unreadable.length || reparsePoints.length)) block('native report claims a complete census despite unreadable/linked input');
  const views = registryViews(raw.views), after = registryViews(raw.viewsAfter);
  if (readinessDigest(views) !== readinessDigest(after)) unreadable.push({ location: 'HKCU uninstall census', code: 'registry-changed-during-measurement' });
  const registry = scopedRegistry(views, identity, product);
  const files = array(raw.files, 3, 'installed file selection'), names = new Set();
  for (const row of files) {
    if (!row || ![identity.runtime, identity.shell, identity.uninstaller].includes(row.relativePath) || names.has(row.relativePath.toLowerCase()) || !measuredFile(row)) block('unmeasured, duplicate or caller-selected installed file');
    names.add(row.relativePath.toLowerCase());
  }
  if (!raw.installRootPresent && files.length) block('absent install root contains claimed measured files');
  const shortcuts = array(raw.shortcuts, 1, 'fixed Start Menu shortcut').map(row => {
    if (!row || !samePath(row.path, identity.shortcut) || typeof row.target !== 'string' || row.target.length > 32767 || row.target.includes('\0') || !measuredFile(row) || !row.bytes || row.bytes > 1024 * 1024) block('unmeasured or caller-selected shortcut');
    return { ...row, args: splitWindowsArguments(row.argumentsRaw) };
  });
  const runtime = files.find(row => row.relativePath === identity.runtime), shell = files.find(row => row.relativePath === identity.shell);
  return {
    schema: 'toolsenabled.installed-state-measurement', schemaVersion: 1, scope: 'parsed-native-report-only', attested: false, exactArtifactVerified: false,
    product, profileRoot: DEV_PROFILE, accountSid: raw.accountSid, installDir: identity.installDir, installRootPresent: raw.installRootPresent,
    expectedSubjectSha256: readinessDigest(subject), nativeReportSha256: hash(bytes), censusEntries: raw.censusEntries,
    ...registry, files, shortcuts, unreadable, reparsePoints,
    measurementComplete: raw.complete && unreadable.length === 0 && reparsePoints.length === 0,
    selectedFilesMatchSubject: { runtime: !!runtime && sameHash(runtime.sha256, subject.runtimeSha256), shell: !!shell && sameHash(shell.sha256, subject.shellSha256) },
    // No copied artifact/subject digest posing as proof that the installer ran.
    // Caller binding and measured installed file identities remain distinct.
  };
}

/**
 * Bind a fixed native reader reply to its captured parent startup and raw files.
 * This is read-only measurement, not guest/installer execution attestation.
 * Paths below are derived from the original transport startup, never a reply's
 * selected parent directory. Only startOwnedSession supplies native provenance.
 */
export function bindOwnedInstalledState(envelope, options) {
  optionsOnly(options, ['context', 'start', 'profile']);
  const { context, start, profile } = options;
  if (!contexts.has(context)) block('a captured fixed installed-state context is required');
  if (!['windows-x64-standard', 'windows-x64-administrator'].includes(profile)) block('an explicit reader/root privilege profile is required');
  exactKeys(envelope, ['scope', 'schema', 'schemaVersion', 'controlId', 'requestId', 'operation', 'product', 'observedAt',
    'rootBefore', 'rootAfter', 'reader', 'helper', 'executable', 'stdout', 'stderr', 'record'], 'owned reader envelope');
  if (envelope.scope !== 'owned-installed-state-reader-only' || envelope.schema !== 'toolsenabled.owned-installed-state-reader' ||
      envelope.schemaVersion !== 1 || envelope.operation !== 'observe-installed-state' || envelope.product !== context.product ||
      !Number.isSafeInteger(envelope.requestId) || envelope.requestId < 1 || envelope.requestId > 128) block('wrong fixed reader operation, product or request');
  const reader = envelope.reader;
  exactKeys(reader, ['processCreated', 'rootExited', 'timedOut', 'outputLimitExceeded', 'hadRemainingChildren', 'cleanupConfirmed',
    'cancelled', 'exitCode', 'stdoutBytes', 'stderrBytes', 'error', 'startIdentity', 'activeProcesses', 'stdoutDrained', 'stderrDrained'], 'native reader result');
  if (reader.processCreated !== true || reader.rootExited !== true || reader.exitCode !== 0 || reader.cleanupConfirmed !== true ||
      reader.timedOut !== false || reader.outputLimitExceeded !== false || reader.hadRemainingChildren !== false || reader.cancelled !== false ||
      reader.error !== null || reader.activeProcesses !== 0 || reader.stdoutDrained !== true || reader.stderrDrained !== true) block('reader did not finish with drained streams and a measured empty subgroup');
  if (readinessDigest(envelope.rootBefore) !== readinessDigest(envelope.rootAfter)) block('parent root identity changed around its fixed reader');
  // Reuse the strict, lexical-only identity parser. It performs no native calls
  // or file lookup for any path claimed by the root or reader packet.
  parseOwnedRuntimeObservation(Buffer.from(JSON.stringify({ schema: 'toolsenabled.owned-runtime-observation', schemaVersion: 1,
    controlId: envelope.controlId, requestId: envelope.requestId, operation: 'observe-runtime', observedAt: envelope.observedAt,
    root: envelope.rootBefore, processes: [envelope.rootBefore, reader.startIdentity], windows: [], listeners: [],
  })), { controlId: envelope.controlId, requestId: envelope.requestId, start });
  const administrator = profile === 'windows-x64-administrator';
  if (envelope.rootBefore.elevated !== administrator || envelope.rootBefore.integrityLevel !== (administrator ? 12288 : 8192) ||
      !samePath(reader.startIdentity.imagePath, POWERSHELL)) block('actual reader/root token or fixed reader executable differs');

  const descriptor = (value, expectedPath, label) => {
    exactKeys(value, ['path', 'sha256', 'bytes'], label);
    if (!measuredFile(value) || typeof value.path !== 'string' || !samePath(value.path, expectedPath)) block(`${label} is not its fixed measured file`);
  };
  const stream = (value, expectedPath, maximum, label) => {
    descriptor(value, expectedPath, label);
    const bytes = readBounded(expectedPath, maximum);
    if (bytes.length !== value.bytes || !sameHash(hash(bytes), value.sha256)) block(`${label} changed after native observation`);
    return bytes;
  };
  // Validate before following the startup path; every reader output is a fixed
  // sibling/child of this already-captured, byte-bound native startup file.
  if (start?.scope !== 'owned-process-start-observation' || typeof start.record?.path !== 'string' ||
      path.basename(start.record.path) !== 'native-start.json') block('original transport startup record is required');
  descriptor(start.record, start.record.path, 'startup record');
  const startPath = plainPath(start.record.path, { kind: 'file' });
  const startupBytes = stream(start.record, startPath, 16384, 'startup record');
  let recordedStart;
  try { recordedStart = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(startupBytes)); }
  catch { block('native startup record is not complete UTF-8 JSON'); }
  if (!startupBytes.equals(Buffer.from(JSON.stringify(recordedStart))) || readinessDigest(recordedStart) !== readinessDigest(start.processIdentity)) block('captured root startup differs from its raw native record');

  descriptor(envelope.helper, HELPER, 'fixed reader helper');
  const currentHelper = measureFile(HELPER);
  if (currentHelper.bytes !== LOADED_HELPER.bytes || !sameHash(currentHelper.sha256, LOADED_HELPER.sha256) ||
      envelope.helper.bytes !== LOADED_HELPER.bytes || !sameHash(envelope.helper.sha256, LOADED_HELPER.sha256)) block('reader helper differs from its loaded fixed implementation');
  descriptor(envelope.executable, POWERSHELL, 'fixed reader executable');
  const currentExecutable = fileIdentity(POWERSHELL, { system: true });
  if (envelope.executable.bytes !== currentExecutable.bytes || !sameHash(envelope.executable.sha256, currentExecutable.sha256)) block('reader executable changed after native observation');

  const stem = 'installed-state-' + String(envelope.requestId).padStart(4, '0'), parent = path.dirname(startPath);
  const stdout = stream(envelope.stdout, path.join(parent, stem, 'stdout.bin'), 16 * 1024 * 1024, 'reader stdout');
  const stderr = stream(envelope.stderr, path.join(parent, stem, 'stderr.bin'), 16 * 1024 * 1024, 'reader stderr');
  if (reader.stdoutBytes !== stdout.length || reader.stderrBytes !== stderr.length || stderr.length !== 0) block('reader stream accounting differs or fixed reader emitted unexpected stderr');
  const nativeBytes = stream(envelope.record, path.join(parent, stem + '.json'), 512 * 1024, 'native reader record');
  let native;
  try { native = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(nativeBytes)); }
  catch { block('native reader envelope is not complete UTF-8 JSON'); }
  const expectedNative = Object.fromEntries(['schema', 'schemaVersion', 'controlId', 'requestId', 'operation', 'product', 'observedAt',
    'rootBefore', 'rootAfter', 'reader'].map(key => [key, envelope[key]]));
  expectedNative.stdout = { sha256: envelope.stdout.sha256, bytes: envelope.stdout.bytes };
  expectedNative.stderr = { sha256: envelope.stderr.sha256, bytes: envelope.stderr.bytes };
  if (!nativeBytes.equals(Buffer.from(JSON.stringify(native))) || readinessDigest(native) !== readinessDigest(expectedNative)) block('decorated reader result differs from its canonical raw native envelope');
  const report = parseNativeInstalledState(stdout, { product: context.product, subject: context.subject });
  if (report.accountSid !== reader.startIdentity.userSid || report.accountSid !== start.processIdentity.userSid) block('native report account SID differs from its actual reader/root');
  return freeze({ ...report, scope: 'read-only-installed-state-session', fixedIdentitySha256: context.fixedIdentitySha256,
    helper: { path: HELPER, ...currentHelper }, readerExecution: structuredClone(envelope) });
}

/**
 * Guest-side READ-ONLY measurement, not a trusted production adapter. The only
 * physical subject paths/registry policy come from INSTALLER_IDENTITIES and
 * the fixed companion helper; callers supply no overrides or executable hook.
 * Prerequisites: Windows x64, native token whose actual profile is literal Dev,
 * readable unlinked installed paths, ShellLink COM, and owned-job prerequisites.
 * evidenceRoot must be an existing fenced private directory outside this module.
 * The future guest controller must verify isolated run/epoch and installer
 * execution provenance separately before decorating this as an observation.
 */
export async function observeInstalledState(options) {
  optionsOnly(options, ['product', 'subject', 'evidenceRoot', 'signal', 'timeoutMs']);
  const identity = identityOf(options.product), subject = subjectFor(options.product, options.subject);
  if (process.platform !== 'win32' || process.arch !== 'x64') block('Windows x64 guest measurement is required');
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) block('invalid bounded native measurement budget');
  options.signal?.throwIfAborted();
  const evidenceRoot = plainPath(options.evidenceRoot, { kind: 'directory' });
  const before = measureFile(HELPER);
  const execution = await runOwnedJob({ command: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Product', options.product],
    cwd: path.dirname(HELPER), evidenceRoot, signal: options.signal, timeoutMs, maxOutputBytes: 16 * 1024 * 1024, cleanupMs: 5000 });
  if (!execution || execution.complete !== true || execution.exitCode !== 0 || execution.cleanupConfirmed !== true || execution.notRun || execution.signal || execution.error || execution.timedOut || execution.outputLimitExceeded || execution.hadRemainingChildren) block('native read-only probe did not complete with confirmed owned cleanup', execution?.cleanupConfirmed !== true);
  const after = measureFile(HELPER);
  if (readinessDigest(before) !== readinessDigest(after)) block('native observation helper changed during measurement');
  const bytes = readBounded(execution.stdout.path, 16 * 1024 * 1024);
  if (!sameHash(hash(bytes), execution.stdout.sha256) || bytes.length !== execution.stdout.bytes) block('native output changed after owned execution');
  const report = parseNativeInstalledState(bytes, { product: options.product, subject });
  return { ...report, scope: 'read-only-installed-state', helper: before, execution,
    fixedIdentitySha256: readinessDigest(identity), cleanupConfirmed: true };
}

// Explicit synthetic filesystem mechanics seam. It only opens a disposable
// Dev TEMP child and fixed install/shortcut leaves; never the actual program.
export function measureInstalledStateFixture(options) {
  optionsOnly(options, ['product', 'subject', 'fixtureRoot', 'nativeMetadata']);
  const identity = identityOf(options.product), subject = subjectFor(options.product, options.subject);
  if (typeof options.fixtureRoot !== 'string' || !path.isAbsolute(options.fixtureRoot)) block('synthetic input must name an absolute owned Dev TEMP child');
  const selected = path.resolve(options.fixtureRoot);
  // Reject an actual install/root selection lexically, before even statting it.
  if (!samePath(path.dirname(selected), DEV_TEMP) || !path.basename(selected).startsWith('installed-state-fixture-')) block('synthetic input must be an owned disposable Dev TEMP child');
  const root = plainPath(selected, { kind: 'directory' });
  const raw = structuredClone(options.nativeMetadata);
  const install = path.join(root, 'install');
  raw.files = []; raw.shortcuts = []; raw.censusEntries = 0; raw.reparsePoints ||= []; raw.unreadable ||= [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}\\${entry.name}` : entry.name;
      if (++raw.censusEntries > 100000) block('fixture file census exceeds its budget');
      if (entry.isSymbolicLink()) { raw.reparsePoints.push({ location: relative, code: 'reparse-point' }); continue; }
      const file = plainPath(path.join(directory, entry.name));
      if (entry.isDirectory()) walk(file, relative);
      else if ([identity.runtime, identity.shell, identity.uninstaller].includes(relative)) raw.files.push({ relativePath: relative, ...measureFile(file) });
    }
  }
  try { plainPath(install, { kind: 'directory' }); raw.installRootPresent = true; walk(install); }
  catch (error) { if (error.code === 'ENOENT') raw.installRootPresent = false; else throw error; }
  if (raw.reparsePoints.length) raw.complete = false;
  // Fixture metadata supplies inert decoded LNK fields; the real reader uses
  // IPersistFile.Load + IShellLinkW.GetPath(SLGP_RAWPATH)/GetArguments, not this.
  if (options.nativeMetadata.shortcuts?.length) {
    const shortcut = plainPath(path.join(root, 'shortcut.lnk'), { kind: 'file' });
    raw.shortcuts.push({ ...options.nativeMetadata.shortcuts[0], ...measureFile(shortcut), path: identity.shortcut });
  }
  const parsed = parseNativeInstalledState(Buffer.from(JSON.stringify(raw)), { product: options.product, subject });
  return { ...parsed, scope: 'synthetic-installed-state-fixture', fixture: true };
}
