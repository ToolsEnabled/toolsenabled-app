import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digestRecord, measureFile, measureTree, plainPath, readBounded, assertSameTree, ENTRY_LIMIT, JSON_LIMIT } from '../adapters/artifact-files.mjs';

// Fixed Debian layout from artifact-deb.mjs; caller chooses a filesystem,
// never an executable, account, package, registry or destination override.
const PRODUCT = 'toolsenabled';
const INSTALL = 'opt/ToolsEnabled';
const DESKTOP = 'usr/share/applications/toolsenabled.desktop';
const DATABASE = 'var/lib/dpkg/status';
const HASH = /^[a-f0-9]{64}$/;
const same = (a, b) => a?.sha256 === b?.sha256 && a?.bytes === b?.bytes;
function block(message) {
  const error = new Error(`Linux installed-state measurement blocked: ${message}`);
  error.code = 'LINUX_INSTALLED_STATE_BLOCKED'; throw error;
}
function exists(root, relative) {
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try { plainPath(cursor); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

/** Missing packages differ from malformed and partially configured records. */
export function parseLinuxDpkgStatus(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > JSON_LIMIT || /[\0\r]/.test(text)) block('invalid or oversized dpkg status');
  const matches = [];
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    if (!paragraph.trim()) continue;
    const fields = Object.create(null); let previous;
    for (const line of paragraph.replace(/\n$/, '').split('\n')) {
      if (/^[ \t]/.test(line)) {
        if (!previous) block('orphan dpkg continuation');
        fields[previous] += `\n${line}`; continue;
      }
      const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
      if (!match || Object.hasOwn(fields, match[1].toLowerCase())) block('malformed or duplicate dpkg field');
      previous = match[1].toLowerCase(); fields[previous] = match[2];
    }
    if (!fields.package) block('dpkg paragraph lacks a package identity');
    if (fields.package === PRODUCT) matches.push(fields);
  }
  if (matches.length > 1) block('ambiguous product package records');
  if (!matches.length) return { state: 'absent', package: PRODUCT };
  const row = matches[0];
  const result = { package: PRODUCT, status: row.status, architecture: row.architecture, version: row.version };
  if (['install ok installed', 'hold ok installed'].includes(row.status) && row.architecture === 'amd64' && /^[0-9][^\s\0]*$/.test(row.version || '')) return { state: 'installed', ...result };
  if (['deinstall ok config-files', 'purge ok not-installed'].includes(row.status)) return { state: 'removed', ...result };
  return { state: 'unknown', ...result };
}

function permissions(root) {
  const result = []; let count = 0;
  function visit(file, name) {
    const stat = fs.lstatSync(plainPath(file));
    if (++count > ENTRY_LIMIT || (!stat.isFile() && !stat.isDirectory())) block('nonregular or oversized installed layout');
    result.push({ path: name, kind: stat.isDirectory() ? 'directory' : 'file', uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777 });
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child), `${name}/${child}`);
  }
  visit(root, '.'); return result;
}

/** Read-only filesystem measurement. This is NOT guest attestation,
 * installation execution, runtime launch, cleanup or qualification. */
export function readLinuxInstalledState(options) {
  if (process.platform !== 'linux' || !options || Object.keys(options).sort().join(',') !== 'root') block('explicit Linux root filesystem required; overrides refused');
  const root = plainPath(options.root, { kind: 'directory' });
  const statusPath = path.join(root, DATABASE), statusBefore = measureFile(statusPath, { maximum: JSON_LIMIT });
  const pkg = parseLinuxDpkgStatus(readBounded(statusPath, JSON_LIMIT).toString('utf8'));
  const updates = plainPath(path.join(root, 'var/lib/dpkg/updates'), { kind: 'directory' });
  const pending = fs.readdirSync(updates).sort();
  const app = path.join(root, INSTALL), desktopPath = path.join(root, DESKTOP);
  const appPresent = exists(root, INSTALL), desktopPresent = exists(root, DESKTOP);
  const result = { schema: 'toolsenabled.linux-installed-state', schemaVersion: 1,
    proofScope: 'filesystem-measurement-only', attested: false, root, package: pkg, database: statusBefore,
    observedAt: new Date().toISOString(), state: 'unknown', pendingDpkgUpdates: pending.length };
  if (pkg.state === 'absent' && !appPresent && !desktopPresent && !pending.length) result.state = 'absent';
  else if (pkg.state === 'installed' && appPresent && desktopPresent && !pending.length) {
    const tree = measureTree(app), modes = permissions(app);
    const desktop = measureFile(desktopPath, { maximum: 65536 });
    const desktopText = readBounded(desktopPath, 65536).toString('utf8');
    const desktopStat = fs.lstatSync(plainPath(desktopPath, { kind: 'file' }));
    assertSameTree(tree, measureTree(app));
    if (digestRecord(modes) !== digestRecord(permissions(app)) || !same(desktop, measureFile(desktopPath, { maximum: 65536 }))) block('installation changed during measurement');
    Object.assign(result, { state: 'installed', stageSha256: tree.sha256,
      runtimeSha256: digestRecord(Object.fromEntries(Object.entries(tree.files).filter(([name]) => !name.startsWith('resources/')))),
      files: tree.files, permissions: modes, desktop: { ...desktop, text: desktopText,
        uid: desktopStat.uid, gid: desktopStat.gid, mode: desktopStat.mode & 0o7777 } });
  }
  if (!same(statusBefore, measureFile(statusPath, { maximum: JSON_LIMIT })) ||
      digestRecord(pending) !== digestRecord(fs.readdirSync(updates).sort())) block('dpkg state changed during measurement');
  return result;
}

/** Compare filesystem bytes to the canonical subject; no guest authority. */
export function assertLinuxInstalledState(state, subject) {
  if (subject?.product !== PRODUCT || subject.target?.platform !== 'linux' || subject.target.arch !== 'x64' ||
      !HASH.test(subject.stageSha256 || '') || !HASH.test(subject.runtimeSha256 || '')) block('exact Linux artifact subject required');
  if (state?.schema !== 'toolsenabled.linux-installed-state' || state.schemaVersion !== 1 || state.state !== 'installed' ||
      state.package?.state !== 'installed' || state.package.package !== PRODUCT || state.package.architecture !== 'amd64' ||
      !['install ok installed', 'hold ok installed'].includes(state.package.status) || !/^[0-9][^\s\0]*$/.test(state.package.version || '') ||
      state.pendingDpkgUpdates !== 0) block('unknown or incomplete Linux installation');
  const files = state.files;
  if (!files || !Object.keys(files).length || Object.values(files).some(row => !HASH.test(row?.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) ||
      !['toolsenabled', 'resources/app.asar', 'resources/capability/PAYLOAD.json'].every(name => files[name]?.bytes > 0)) block('installed payload markers or file identities missing');
  const runtime = Object.fromEntries(Object.entries(files).filter(([name]) => !name.startsWith('resources/')));
  if (digestRecord(files) !== subject.stageSha256 || state.stageSha256 !== subject.stageSha256 ||
      digestRecord(runtime) !== subject.runtimeSha256 || state.runtimeSha256 !== subject.runtimeSha256) block('installed artifact/runtime bytes differ from exact subject');
  if (!Array.isArray(state.permissions) || !state.permissions.length || state.permissions.some(row =>
      row.uid !== 0 || row.gid !== 0 || !['file', 'directory'].includes(row.kind) ||
      (row.kind === 'directory' ? row.mode !== 0o755 : ![0o644, 0o755].includes(row.mode)))) block('installed ownership or modes are unsafe');
  const names = state.permissions.filter(row => row.kind === 'file').map(row => row.path.slice(2)).sort();
  const directories = new Set(['.']);
  for (const name of Object.keys(files)) {
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) block('unsafe installed path');
    const parts = name.split('/'); parts.pop();
    while (parts.length) { directories.add('./' + parts.join('/')); parts.pop(); }
  }
  const actualDirectories = state.permissions.filter(row => row.kind === 'directory').map(row => row.path).sort();
  if (new Set(state.permissions.map(row => row.path)).size !== state.permissions.length ||
      state.permissions.some(row => row.kind === 'file' && !row.path.startsWith('./')) ||
      digestRecord(names) !== digestRecord(Object.keys(files).sort()) ||
      digestRecord(actualDirectories) !== digestRecord([...directories].sort()) ||
      state.permissions.find(row => row.path === './toolsenabled')?.mode !== 0o755) block('installed permission census is incomplete');
  const desktop = state.desktop;
  if (!desktop || typeof desktop.text !== 'string' || desktop.uid !== 0 || desktop.gid !== 0 || desktop.mode !== 0o644 ||
      desktop.bytes !== Buffer.byteLength(desktop.text) || desktop.sha256 !== createHash('sha256').update(desktop.text).digest('hex') ||
      !/^\[Desktop Entry\]\n/.test(desktop.text) ||
      desktop.text.split('\n').filter(line => line.startsWith('Exec=')).join('\n') !== 'Exec=/opt/ToolsEnabled/toolsenabled %U' ||
      desktop.text.split('\n').filter(line => line.startsWith('Type=')).join('\n') !== 'Type=Application' ||
      desktop.text.includes('\0')) block('installed desktop entry differs from the fixed product');
  return { proofScope: 'filesystem-measurement-only', subjectSha256: digestRecord(subject),
    stageSha256: state.stageSha256, runtimeSha256: state.runtimeSha256 };
}
