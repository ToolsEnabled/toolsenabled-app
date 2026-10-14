import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseLinuxDpkgStatus } from '../guest/linux-installed-state.mjs';
import { LINUX_QUALIFICATION_PROFILES } from '../transport/linux-qualification-rpc.mjs';

const HASH = /^[a-f0-9]{64}$/;
const PRODUCT = 'toolsenabled';
const hash = value => createHash('sha256').update(value).digest('hex');
function refuse(message, details = {}) {
  const error = new Error('Linux package scenario blocked: ' + message);
  error.code = 'LINUX_PACKAGE_SCENARIO_BLOCKED';
  error.details = details;
  throw error;
}
export function validateLinuxDebControl(text, expected) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || /[\0\r]/.test(text) ||
      !expected || typeof expected.version !== 'string') refuse('bounded Debian control and expected version required');
  const fields = Object.create(null);
  let prior;
  for (const line of text.trimEnd().split('\n')) {
    if (/^[ \t]/.test(line)) { if (!prior) refuse('orphan Debian control continuation'); continue; }
    const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) refuse('malformed or duplicate Debian control field');
    fields[match[1]] = match[2]; prior = match[1];
  }
  if (fields.Package !== PRODUCT || fields.Architecture !== 'amd64' ||
      fields.Version !== expected.version || !/^[0-9][^\s\0]*$/.test(fields.Version)) refuse('Debian package/version/architecture differs');
  return { package: fields.Package, version: fields.Version, architecture: fields.Architecture };
}
function artifactRecord(artifact) {
  if (!artifact || !HASH.test(artifact.sha256 || '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 ||
      typeof artifact.path !== 'string' || !path.isAbsolute(artifact.path) ||
      !/^[0-9][^\s\0]*$/.test(artifact.version || '')) refuse('exact Debian path/hash/size/version required');
  const stat = fs.lstatSync(artifact.path);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(artifact.path) !== artifact.path ||
      stat.size !== artifact.bytes || hash(fs.readFileSync(artifact.path)) !== artifact.sha256) refuse('Debian artifact bytes changed');
  return { sha256: artifact.sha256, bytes: artifact.bytes, version: artifact.version };
}

/** Actual guest package-manager transitions only. Desktop, persistence,
 * provider and independent cleanup proof remain separate required work. */
export async function runLinuxPackageTransition({ kind, artifact, previousArtifact, transport, profile } = {}) {
  if (!['fresh-install', 'upgrade', 'uninstall-reinstall'].includes(kind) ||
      !LINUX_QUALIFICATION_PROFILES.includes(profile) || transport?.version !== 1 ||
      transport.identity?.qualification !== false || !transport.identity.machineRoot ||
      typeof transport.execute !== 'function') refuse('native transport/scenario/profile required');
  const candidate = artifactRecord(artifact);
  const steps = [];
  const command = async (name, argv, executionProfile = 'linux-x64-standard', timeoutSeconds = 30) => {
    const response = await transport.execute({ argv, profile: executionProfile, timeoutSeconds });
    const result = response.result;
    steps.push({ name, profile: executionProfile, exitCode: result.exitCode,
      stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr),
      stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) });
    if (result.exitCode !== 0) refuse(name + ' exited ' + result.exitCode, { steps, guestId: transport.identity.guestId });
    return result.stdout;
  };
  const standardUid = (await command('ordinary-user', ['id', '-u'])).trim();
  if (!/^[1-9][0-9]*$/.test(standardUid) || Number(standardUid) !== transport.identity.native.userUid) refuse('desktop user is privileged or changed');
  const readPackage = async () => parseLinuxDpkgStatus(await command('read-dpkg-status', ['cat', '/var/lib/dpkg/status']));
  const stage = async value => {
    artifactRecord(value);
    const machineRoot = transport.identity.machineRoot;
    const input = path.join(machineRoot, 'input');
    const plainDirectory = directory => {
      try {
        const stat = fs.lstatSync(directory);
        if (!path.isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink() ||
            fs.realpathSync(directory) !== directory) refuse('linked or invalid artifact input directory');
      } catch (error) {
        if (error.code === 'LINUX_PACKAGE_SCENARIO_BLOCKED') throw error;
        refuse('artifact input directory could not be measured: ' + error.code);
      }
    };
    plainDirectory(machineRoot);
    plainDirectory(input);
    const folder = path.join(input, 'installer-artifacts');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 });
    plainDirectory(folder);
    const hostFile = path.join(folder, value.sha256 + '.deb');
    if (fs.existsSync(hostFile)) {
      if (fs.lstatSync(hostFile).isSymbolicLink() || hash(fs.readFileSync(hostFile)) !== value.sha256) refuse('staged artifact path changed');
    } else fs.copyFileSync(value.path, hostFile, fs.constants.COPYFILE_EXCL);
    if (hash(fs.readFileSync(hostFile)) !== value.sha256) refuse('staged Debian bytes differ');
    const incoming = path.posix.join(transport.identity.guestInputRoot, 'installer-artifacts', value.sha256 + '.deb');
    const guestFile = path.posix.join('/var/cache/toolsenabled-qualification', value.sha256 + '.deb');
    const script = 'import os,shutil,sys\nfrom pathlib import Path\np=Path(sys.argv[2]);p.parent.mkdir(mode=0o755,parents=True,exist_ok=True)\nshutil.copyfile(sys.argv[1],p)\nos.chmod(p,0o644)\n';
    await command('copy-installer-to-guest', ['python3', '-c', script, incoming, guestFile], 'linux-x64-install-authorized', 120);
    const measured = (await command('measure-guest-installer', ['sha256sum', guestFile])).split(/\s/)[0];
    if (measured !== value.sha256) refuse('guest installer hash differs');
    validateLinuxDebControl(await command('read-debian-control', ['dpkg-deb', '--field', guestFile]), value);
    return guestFile;
  };
  const install = async value => {
    const guestFile = await stage(value);
    await command('install-exact-debian', ['env', 'DEBIAN_FRONTEND=noninteractive', 'dpkg', '--install', guestFile], 'linux-x64-install-authorized', 180);
    const state = await readPackage();
    if (state.state !== 'installed' || state.version !== value.version) refuse('installed package differs after transition');
    return state;
  };
  const before = await readPackage();
  let prior = null;
  if (kind === 'fresh-install') {
    if (before.state !== 'absent') refuse('fresh install requires an absent package in the restored baseline');
  } else if (kind === 'upgrade') {
    if (!previousArtifact) refuse('upgrade requires the measured supported prior installer');
    prior = artifactRecord(previousArtifact);
    if (prior.version === candidate.version) refuse('upgrade source equals candidate version');
    await command('verify-upgrade-version-order', ['dpkg', '--compare-versions', prior.version, 'lt', candidate.version]);
    if (before.state === 'absent') await install(previousArtifact);
    else if (before.state !== 'installed' || before.version !== prior.version) refuse('upgrade baseline package differs');
  } else {
    if (before.state !== 'installed') refuse('uninstall/reinstall requires an installed product');
    await command('uninstall-product', ['apt-get', '--no-download', '--yes', 'remove', PRODUCT], 'linux-x64-install-authorized', 120);
    const removed = await readPackage();
    if (!['absent', 'removed'].includes(removed.state)) refuse('package remains installed after removal');
  }
  const after = await install(artifact);
  return { schema: 'toolsenabled.linux-package-transition', schemaVersion: 1, kind, profile,
    guestId: transport.identity.guestId, artifact: candidate, previousArtifact: prior,
    before, after, steps, nativeQualified: false,
    outstanding: ['independent installed runtime/tree measurement', 'actual desktop launch and first-run',
      'real user-data persistence/relaunch', 'owned cleanup and baseline restoration'] };
}
