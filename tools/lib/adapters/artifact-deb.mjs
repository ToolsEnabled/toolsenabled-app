import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { blocked, plainPath, contains, readBounded, readJson, measureFile, measureTree, digestRecord, FILE_LIMIT } from './artifact-files.mjs';
import { captureDebMembers, inspectTarArchive, readVerifiedTarEntry } from './artifact-archive.mjs';
import { runLinuxOwnedJobBatch } from '../transport/linux-owned-job.mjs';
import { LINUX_XZ, linuxXzArguments, measureLinuxXzToolchain } from '../transport/linux-xz-toolchain.mjs';

const APP_PREFIX = 'opt/ToolsEnabled/';
const DESKTOP = 'usr/share/applications/toolsenabled.desktop';
const CHANGELOG = 'usr/share/doc/toolsenabled/changelog.gz';
const same = (a, b) => a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const desktopEscape = value => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t');
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);

function packagePolicy(appRoot) {
  appRoot = plainPath(appRoot, { kind: 'directory' });
  const pkg = readJson(path.join(appRoot, 'package.json')), linux = pkg.build?.linux, deb = pkg.build?.deb;
  if (pkg.productName !== 'ToolsEnabled' || pkg.desktopName !== 'toolsenabled.desktop' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version || '') ||
      !boundedText(pkg.description) || !boundedText(pkg.license) || !boundedText(pkg.homepage) ||
      linux?.executableName !== 'toolsenabled' || linux?.icon !== 'shell/icon.png' || linux?.syncDesktopName !== true ||
      linux?.category !== 'Development' || deb?.packageName !== 'toolsenabled' || !boundedText(deb.maintainer) ||
      deb?.afterInstall !== 'build/linux/deb-maintainer.sh' || deb?.afterRemove !== deb.afterInstall ||
      deb?.appArmorProfile !== 'build/linux/toolsenabled-customer.apparmor') blocked('Debian product/source policy differs from the maintained package');
  if (Object.keys(linux).some(key => !['executableName', 'icon', 'syncDesktopName', 'category', 'target'].includes(key)) ||
      Object.keys(deb).some(key => !['packageName', 'maintainer', 'depends', 'appArmorProfile', 'afterInstall', 'afterRemove'].includes(key)) ||
      pkg.build.protocols || pkg.build.fileAssociations || pkg.build.buildNumber) blocked('Debian package options have no reviewed archive accounting');
  if (!Array.isArray(deb.depends) || !deb.depends.length || deb.depends.some(value => !/^[a-z0-9][a-z0-9+.-]*$/.test(value)) ||
      new Set(deb.depends).size !== deb.depends.length) blocked('Debian dependency declaration is ambiguous');
  const iconPath = path.join(appRoot, 'shell/icon.png'), icon = readBounded(iconPath, 4 * 1024 * 1024);
  if (!icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || icon.length < 33 ||
      icon.readUInt32BE(8) !== 13 || icon.subarray(12, 16).toString('ascii') !== 'IHDR') blocked('source desktop icon is not a PNG');
  const width = icon.readUInt32BE(16), height = icon.readUInt32BE(20);
  if (width !== height || width < 16 || width > 1024) blocked('source desktop icon has an unsupported size');
  const iconName = `usr/share/icons/hicolor/${width}x${height}/apps/toolsenabled.png`;
  // The maintained builder returns a PNG source directly for Linux "set"
  // output. The exact source bytes are required, not merely a plausible image.
  const desktop = '[Desktop Entry]\nName=ToolsEnabled\nExec=/opt/ToolsEnabled/toolsenabled %U\nTerminal=false\nType=Application\nIcon=toolsenabled\nStartupWMClass=toolsenabled\n' +
    `Comment=${desktopEscape(pkg.description)}\nCategories=Development;\n`;
  const scriptPath = path.join(appRoot, deb.afterInstall), script = readBounded(scriptPath, 1024 * 1024);
  if (/\$\{[A-Za-z]+\}/.test(decode(script))) blocked('maintainer template requires unaccounted builder substitutions');
  return { pkg, version: pkg.version.replaceAll('-', '~'), iconName, desktop, script,
    inputs: { package: measureFile(path.join(appRoot, 'package.json')), icon: measureFile(iconPath),
      script: measureFile(scriptPath), appArmor: measureFile(path.join(appRoot, deb.appArmorProfile)) } };
}

function controlFields(bytes) {
  const text = decode(bytes);
  if (!text.endsWith('\n') || text.includes('\r') || text.includes('\0') || text.length > 65536) blocked('Debian control text is malformed');
  const fields = {}, names = new Set(); let key = null;
  for (const line of text.slice(0, -1).split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (key !== 'Description') blocked('unexpected Debian control continuation');
      fields[key] += '\n' + line.slice(1); continue;
    }
    const match = /^([A-Za-z][A-Za-z-]*): (.*)$/.exec(line);
    if (!match || names.has(match[1].toLowerCase())) blocked('duplicate or malformed Debian control field');
    key = match[1]; names.add(key.toLowerCase()); fields[key] = match[2];
  }
  return fields;
}

function assertProtected(entries, { control = false } = {}) {
  for (const entry of entries) {
    if (entry.uid !== 0 || entry.gid !== 0 || !['', 'root'].includes(entry.uname) || !['', 'root'].includes(entry.gname) ||
        (entry.mode & ~0o777) !== 0) blocked('Debian entries require ordinary root ownership and no special permission bits');
    if (!['directory', 'file'].includes(entry.type)) blocked('Debian link or special-file entry is not in the maintained payload');
    if (entry.type === 'directory') {
      // The archive's virtual root is not installed; GNU/FPM records its
      // private staging mode. All actual managed directories are protected.
      if (entry.name === '.' ? ![0o700, 0o755, 0o775].includes(entry.mode) : entry.mode !== 0o755) blocked('Debian directory permissions are unsafe');
    } else {
      const script = control && ['postinst', 'postrm'].includes(entry.name);
      if (script ? entry.mode !== 0o755 : control ? entry.mode !== 0o644 : ![0o644, 0o755].includes(entry.mode)) blocked('Debian file permissions are unsafe');
    }
  }
}

function assertDirectories(entries, expectedFiles) {
  const expected = new Set(['.']);
  for (const name of expectedFiles) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) expected.add(parent);
  const actual = entries.filter(entry => entry.type === 'directory').map(entry => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) blocked('Debian directories are missing or outside the exact payload');
}

export function inspectDebianPackage({ appRoot, stageRoot, controlTar, dataTar }) {
  const policy = packagePolicy(appRoot), stage = measureTree(stageRoot);
  const control = inspectTarArchive(controlTar, { maximumBytes: 4 * 1024 * 1024 });
  const data = inspectTarArchive(dataTar);
  assertProtected(control.entries, { control: true }); assertProtected(data.entries);
  const controlFiles = control.entries.filter(entry => entry.type === 'file');
  const controlNames = ['control', 'md5sums', 'postinst', 'postrm'];
  if (JSON.stringify(controlFiles.map(entry => entry.name).sort()) !== JSON.stringify(controlNames)) blocked('Debian control/script selection differs from the maintained installer');
  assertDirectories(control.entries, controlNames);
  const readControl = name => readVerifiedTarEntry(controlTar, control, name);
  for (const name of ['postinst', 'postrm']) if (!readControl(name).equals(policy.script)) blocked('Debian maintainer script differs from selected source');
  const files = data.entries.filter(entry => entry.type === 'file'), byName = new Map(files.map(entry => [entry.name, entry]));
  const expected = Object.fromEntries(Object.entries(stage.files).map(([name, value]) => [APP_PREFIX + name, value]));
  expected[policy.iconName] = policy.inputs.icon;
  const expectedNames = [...Object.keys(expected), DESKTOP, CHANGELOG].sort();
  if (JSON.stringify([...byName.keys()].sort()) !== JSON.stringify(expectedNames)) blocked('Debian installed files differ from the whole declared package');
  assertDirectories(data.entries, expectedNames);
  for (const [name, expectedFile] of Object.entries(expected)) if (!same(byName.get(name), expectedFile)) blocked(`Debian payload bytes differ from source/stage: ${name}`);
  for (const [name] of Object.entries(stage.files)) {
    const mode = fs.lstatSync(plainPath(path.join(stageRoot, name), { kind: 'file' })).mode & 0o7777;
    if (byName.get(APP_PREFIX + name).mode !== mode) blocked('Debian application permissions differ from the sealed stage');
  }
  for (const name of [DESKTOP, CHANGELOG, policy.iconName]) if (byName.get(name).mode !== 0o644) blocked('Debian desktop/document data has executable or writable permissions');
  if (decode(readVerifiedTarEntry(dataTar, data, DESKTOP)) !== policy.desktop) blocked('Debian desktop entry differs from selected product metadata');
  const changelog = readVerifiedTarEntry(dataTar, data, CHANGELOG, 16384);
  if (changelog.length < 18 || !changelog.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0]))) blocked('Debian changelog gzip has unaccounted header metadata');
  const unzipped = gunzipSync(changelog, { maxOutputLength: 8192, info: true });
  if (unzipped.engine.bytesWritten !== changelog.length) blocked('Debian changelog has trailing encoded content');
  const text = decode(unzipped.buffer), head = `toolsenabled (${policy.version}) ; urgency=medium\n\n  * Package created with FPM.\n\n -- ${policy.pkg.build.deb.maintainer}  `;
  if (!text.startsWith(head)) blocked('Debian changelog differs from package identity or generated body');
  const timestamp = text.slice(head.length);
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 20\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}\n(?:\n)?$/.test(timestamp) ||
      !Number.isFinite(Date.parse(timestamp.trim()))) blocked('Debian changelog build timestamp is malformed');
  const fields = controlFields(readControl('control'));
  const expectedFields = { Package: 'toolsenabled', Version: policy.version, License: policy.pkg.license,
    Vendor: policy.pkg.build.deb.maintainer, Architecture: 'amd64', Maintainer: policy.pkg.build.deb.maintainer,
    'Installed-Size': String(Math.floor(data.totalBytes / 1024)), Depends: policy.pkg.build.deb.depends.join(', '),
    Recommends: 'libappindicator3-1', Section: 'default', Priority: 'optional', Homepage: policy.pkg.homepage,
    Description: '\n ' + policy.pkg.description };
  if (digestRecord(fields) !== digestRecord(expectedFields)) blocked('Debian control identity, dependencies or metadata differs from source');
  const md5 = decode(readControl('md5sums'));
  if (!md5.endsWith('\n')) blocked('Debian md5sums is incomplete');
  const rows = md5.slice(0, -1).split('\n'), listed = new Map();
  for (const line of rows) {
    const match = /^([a-f0-9]{32})  (.+)$/.exec(line);
    if (!match || listed.has(match[2]) || byName.get(match[2])?.md5 !== match[1]) blocked('Debian md5sums selection/content differs');
    listed.set(match[2], match[1]);
  }
  if (listed.size !== files.length) blocked('Debian md5sums omits installed payload');
  const afterPolicy = packagePolicy(appRoot), afterStage = measureTree(stageRoot);
  if (digestRecord(afterPolicy.inputs) !== digestRecord(policy.inputs) || digestRecord(afterStage) !== digestRecord(stage)) blocked('Debian source/stage inputs changed during accounting');
  return { stage, control: control.identity, data: data.identity, sourceInputs: policy.inputs,
    controlFields: fields, installedEntries: data.entries, controlEntries: control.entries,
    generatedChangelogTimestamp: timestamp.trim(), allInstallerEntriesAccounted: true };
}

// Decode into native-owner file sinks, then inspect bytes in place. No tar
// entry ever becomes an extraction pathname or executes a maintainer script.
export async function verifyLinuxDebianStage({ artifactPath, stageRoot, appRoot, evidenceRoot, signal }) {
  signal?.throwIfAborted();
  artifactPath = plainPath(artifactPath, { kind: 'file' });
  stageRoot = plainPath(stageRoot, { kind: 'directory' });
  appRoot = plainPath(appRoot, { kind: 'directory' });
  evidenceRoot = plainPath(evidenceRoot, { kind: 'directory' });
  for (const root of [path.dirname(artifactPath), stageRoot, appRoot])
    if (contains(root, evidenceRoot) || contains(evidenceRoot, root)) blocked('Debian evidence must be outside candidate/source/stage trees');
  const before = fs.lstatSync(artifactPath, { bigint: true });
  const generation = stat => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':');
  const stage = measureTree(stageRoot), decoder = measureLinuxXzToolchain();
  const parent = path.dirname(evidenceRoot), scratch = fs.mkdtempSync(path.join(parent, '.artifact-extract-'));
  fs.chmodSync(scratch, 0o700);
  let cleanupSafe = true;
  try {
    const captured = captureDebMembers(artifactPath, scratch);
    const count = Object.keys(stage.files).length;
    const dataLimit = Math.min(FILE_LIMIT, stage.bytes + (count + 32) * 8192 + 16 * 1024 * 1024);
    const jobs = ['control.tar.xz', 'data.tar.xz'].map(name => ({ command: LINUX_XZ, args: linuxXzArguments(captured.members[name].path), cwd: scratch,
      timeoutMs: 180000, maxOutputBytes: name === 'control.tar.xz' ? 4 * 1024 * 1024 : dataLimit }));
    cleanupSafe = false;
    const runs = await runLinuxOwnedJobBatch({ jobs, evidenceRoot, signal, batchTimeoutMs: 6 * 60 * 1000 });
    cleanupSafe = runs.length === 2 && runs.every(result => result.cleanupConfirmed === true);
    for (const result of runs) if (!result.complete || result.exitCode !== 0 || !result.cleanupConfirmed || result.notRun ||
        result.timedOut || result.outputLimitExceeded || result.hadRemainingChildren) {
      const error = new Error('bounded Debian decoder did not complete cleanly');
      error.execution = result; throw error;
    }
    if (!cleanupSafe) blocked('Debian decoder did not account for both archive streams');
    signal?.throwIfAborted();
    const accounting = inspectDebianPackage({ appRoot, stageRoot, controlTar: runs[0].stdout.path, dataTar: runs[1].stdout.path });
    if (!same(accounting.control, runs[0].stdout) || !same(accounting.data, runs[1].stdout)) blocked('decoded Debian stream changed before inspection');
    if (generation(before) !== generation(fs.lstatSync(artifactPath, { bigint: true })) || !same(captured.artifact, measureFile(artifactPath)) ||
        digestRecord(stage) !== digestRecord(accounting.stage) || digestRecord(decoder) !== digestRecord(measureLinuxXzToolchain()))
      blocked('Debian installer, stage or decoder changed during verification');
    return { artifact: captured.artifact, stage, decoder, runs, accounting };
  } catch (error) {
    if (!cleanupSafe) { error.cleanupUnconfirmed = true; error.terminationConfirmed = false; error.extractionDirectory = scratch; }
    throw error;
  } finally {
    if (cleanupSafe) {
      // Only our two captured members may exist here. Unknown entries or links
      // retain the directory instead of recursively deleting outside custody.
      plainPath(scratch, { kind: 'directory' });
      for (const name of fs.readdirSync(scratch)) {
        if (!['control.tar.xz', 'data.tar.xz'].includes(name)) blocked('unexpected Debian scratch entry retained');
        fs.unlinkSync(plainPath(path.join(scratch, name), { kind: 'file' }));
      }
      fs.rmdirSync(scratch);
    }
  }
}
