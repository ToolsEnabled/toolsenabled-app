import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLinuxDebControl, runLinuxPackageTransition } from '../lib/drivers/linux-qualification-scenarios.mjs';

const control = 'Package: toolsenabled\nVersion: 1.0.49\nArchitecture: amd64\nDescription: Desktop application\n continued description\n';
test('reads exact Debian artifact identity with a multiline description', () => {
  assert.deepEqual(validateLinuxDebControl(control, { version: '1.0.49' }),
    { package: 'toolsenabled', version: '1.0.49', architecture: 'amd64' });
});
for (const [name, text, expected] of [
  ['different product', control.replace('toolsenabled', 'unrelated'), { version: '1.0.49' }],
  ['different architecture', control.replace('amd64', 'arm64'), { version: '1.0.49' }],
  ['different version', control, { version: '1.0.48' }],
  ['duplicate field', control + 'Version: 1.0.49\n', { version: '1.0.49' }],
  ['orphan continuation', ' orphan\n' + control, { version: '1.0.49' }],
  ['malformed field', control + 'bad\n', { version: '1.0.49' }],
  ['NUL input', control + '\0', { version: '1.0.49' }],
  ['oversized input', control + 'Extra: ' + 'a'.repeat(65537), { version: '1.0.49' }],
  ['missing expected identity', control, null],
]) test('refuses ' + name, () => assert.throws(() => validateLinuxDebControl(text, expected), { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' }));

test('missing real transport cannot start a package transition', async () => {
  await assert.rejects(runLinuxPackageTransition({ kind: 'fresh-install', profile: 'linux-x64-standard' }),
    { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
});
test('a declared qualification pass cannot substitute for transport', async () => {
  await assert.rejects(runLinuxPackageTransition({ kind: 'upgrade', profile: 'linux-x64-install-authorized',
    transport: { version: 1, identity: { qualification: true, machineRoot: '/synthetic' }, execute() { throw Error('unexpected execution'); } } }),
    { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
function fixture(t, { installed = null, uid = 1000, installerExit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-package-behavior-'));
  fs.mkdirSync(path.join(root, 'input'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = version => {
    const file = path.join(root, version + '.deb'), bytes = Buffer.from('synthetic package ' + version);
    fs.writeFileSync(file, bytes);
    return { path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version };
  };
  const candidate = artifact('1.0.49'), previous = artifact('1.0.48');
  let selected = candidate;
  const calls = [];
  const transport = { version: 1, identity: { qualification: false, machineRoot: root,
    guestInputRoot: '/synthetic-input', native: { userUid: 1000 }, guestId: 'synthetic-unit-fixture' },
    async execute(request) {
      calls.push(request); const a = request.argv; let stdout = '', exitCode = 0;
      if (a[0] === 'id') stdout = String(uid) + '\n';
      else if (a[0] === 'cat') stdout = installed ? `Package: toolsenabled\nStatus: install ok installed\nArchitecture: amd64\nVersion: ${installed}\n` : '';
      else if (a[0] === 'python3') selected = a.at(-1).includes(previous.sha256) ? previous : candidate;
      else if (a[0] === 'sha256sum') stdout = selected.sha256 + '  installer.deb\n';
      else if (a[0] === 'dpkg-deb') stdout = control.replace('1.0.49', selected.version);
      else if (a[0] === 'dpkg') exitCode = a[2] === '1.0.48' && a[4] === '1.0.49' ? 0 : 1;
      else if (a.includes('remove')) installed = null;
      else if (a.includes('install') || a.includes('--install')) { exitCode = installerExit; if (!exitCode) installed = selected.version; }
      else throw Error('Unexpected fixture operation');
      return { result: { exitCode, stdout, stderr: exitCode ? 'synthetic refusal' : '' } };
    } };
  return { candidate, previous, transport, calls };
}

test('fresh transition records absent to exact installed state, without qualification', async t => {
  const f = fixture(t);
  const result = await runLinuxPackageTransition({ kind: 'fresh-install', artifact: f.candidate,
    transport: f.transport, profile: 'linux-x64-standard' });
  assert.equal(result.before.state, 'absent');
  assert.equal(result.after.version, '1.0.49');
  assert.equal(result.nativeQualified, false);
  assert.ok(result.outstanding.length > 0);
});
test('installer failure remains a named blocker with measured nonzero result', async t => {
  const f = fixture(t, { installerExit: 42 });
  await assert.rejects(runLinuxPackageTransition({ kind: 'fresh-install', artifact: f.candidate,
    transport: f.transport, profile: 'linux-x64-standard' }), error => {
      assert.equal(error.code, 'LINUX_PACKAGE_SCENARIO_BLOCKED');
      assert.equal(error.details.steps.at(-1).exitCode, 42); return true;
    });
});
test('ordinary desktop UID cannot become privileged', async t => {
  const f = fixture(t, { uid: 0 });
  await assert.rejects(runLinuxPackageTransition({ kind: 'fresh-install', artifact: f.candidate,
    transport: f.transport, profile: 'linux-x64-standard' }), { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
  assert.equal(f.calls.length, 1);
});
test('fresh install refuses a pre-existing product before installer execution', async t => {
  const f = fixture(t, { installed: '1.0.48' });
  await assert.rejects(runLinuxPackageTransition({ kind: 'fresh-install', artifact: f.candidate,
    transport: f.transport, profile: 'linux-x64-standard' }), { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
  assert.equal(f.calls.length, 2);
});
test('upgrade records real prior and final versions', async t => {
  const f = fixture(t, { installed: '1.0.48' });
  const result = await runLinuxPackageTransition({ kind: 'upgrade', artifact: f.candidate,
    previousArtifact: f.previous, transport: f.transport, profile: 'linux-x64-install-authorized' });
  assert.equal(result.before.version, '1.0.48'); assert.equal(result.after.version, '1.0.49');
  assert.equal(result.previousArtifact.sha256, f.previous.sha256); assert.equal(result.nativeQualified, false);
});
test('downgrade cannot be presented as an upgrade', async t => {
  const f = fixture(t, { installed: '1.0.49' });
  await assert.rejects(runLinuxPackageTransition({ kind: 'upgrade', artifact: f.previous,
    previousArtifact: f.candidate, transport: f.transport, profile: 'linux-x64-install-authorized' }),
    { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
});
test('uninstall/reinstall measures package removal and exact reinstall', async t => {
  const f = fixture(t, { installed: '1.0.49' });
  const result = await runLinuxPackageTransition({ kind: 'uninstall-reinstall', artifact: f.candidate,
    transport: f.transport, profile: 'linux-x64-install-authorized' });
  assert.equal(result.before.version, '1.0.49'); assert.equal(result.after.version, '1.0.49');
  assert.equal(result.nativeQualified, false);
});
test('changed installer bytes refuse before calling the guest', async t => {
  const f = fixture(t); fs.appendFileSync(f.candidate.path, 'changed');
  await assert.rejects(runLinuxPackageTransition({ kind: 'fresh-install', artifact: f.candidate,
    transport: f.transport, profile: 'linux-x64-standard' }), { code: 'LINUX_PACKAGE_SCENARIO_BLOCKED' });
  assert.equal(f.calls.length, 0);
});
