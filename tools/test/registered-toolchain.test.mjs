import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { registeredToolPaths, registeredToolSearchPath, registeredToolchainPolicyIdentity,
  assertRegisteredToolIdentity } from '../lib/transport/registered-toolchain.mjs';
import { fileIdentity, measureRegisteredToolchain, registeredToolEnvironment } from '../lib/transport/owned-job.mjs';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';

const windows = { skip: process.platform !== 'win32' && 'Windows qualification toolchain' };

test('tool selection uses the executing Node and does not accept caller paths or policy', () => {
  const selected = registeredToolPaths();
  assert.equal(selected.node, process.execPath);
  assert.ok(Object.isFrozen(selected));
  for (const read of [registeredToolPaths, registeredToolSearchPath, registeredToolchainPolicyIdentity, measureRegisteredToolchain]) {
    assert.throws(() => read({ node: 'caller.exe', sha256: 'a'.repeat(64) }), /caller/);
  }
  const digest = '995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362';
  const expected = { path: selected.node, bytes: 1, sha256: digest };
  for (const changed of [
    { ...expected, path: 'caller.exe' }, { ...expected, sha256: '0'.repeat(64) },
    { ...expected, bytes: 0 }, { ...expected, bytes: Number.NaN },
  ]) assert.throws(() => assertRegisteredToolIdentity('node', changed), /unapproved/);
  assert.throws(() => assertRegisteredToolIdentity('unregistered', expected), /unknown tool/);
  assert.throws(() => assertRegisteredToolIdentity('node', expected, { approved: true }), /override/);
});

test('native toolchain binds the selected portable Node and reviewed system binaries', windows, () => {
  const measured = measureRegisteredToolchain();
  assert.deepEqual(measured.tools.node, fileIdentity(process.execPath, { system: true }));
  assert.deepEqual(Object.keys(measured.tools), ['node', 'python', 'powershell']);
  assert.ok(Object.isFrozen(measured) && Object.isFrozen(measured.tools));
  for (const [role, identity] of Object.entries(measured.tools)) {
    assert.deepEqual(identity, fileIdentity(registeredToolPaths()[role], { system: true }));
    assertRegisteredToolIdentity(role, identity);
  }
  const loaded = registeredToolchainPolicyIdentity();
  const actual = fileIdentity(loaded.path);
  assert.deepEqual(measured.policy, { sha256: actual.sha256, bytes: actual.bytes });
});

test('registered child PATH resolves the selected Node and refuses environment redirection', windows, () => {
  const environment = registeredToolEnvironment();
  assert.equal(environment.PATH.split(';')[0], path.dirname(process.execPath));
  assert.equal(environment.PATH, registeredToolSearchPath());
  assert.equal(environment.USERPROFILE, os.userInfo().homedir);
  for (const extra of [
    { PATH: path.dirname(process.execPath) + ';C:\\caller' },
    { NODE_OPTIONS: '--require caller.js' }, { NODE_PATH: 'C:\\caller' },
    { PATH: environment.PATH, path: environment.PATH },
  ]) assert.throws(() => registeredToolEnvironment(extra), /reserved|unregistered|duplicate/);
  assert.equal(registeredToolEnvironment({ PATH: 'C:\\Windows\\System32;C:\\Windows' }).PATH,
    'C:\\Windows\\System32;C:\\Windows');
});

test('an executable changed after selection is rejected by real byte measurement', windows, t => {
  // Synthetic read boundary only: route the selected Node's ordinary file reads
  // to a disposable changed file. No executable or qualification job is run.
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'toolchain-byte-refusal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const changed = path.join(root, 'changed-node.bin');
  fs.writeFileSync(changed, 'unapproved executable bytes');
  const originalLstat = fs.lstatSync.bind(fs), originalOpen = fs.openSync.bind(fs);
  const node = path.resolve(process.execPath);
  const redirect = file => typeof file === 'string' && path.resolve(file) === node ? changed : file;
  t.mock.method(fs, 'lstatSync', (file, ...args) => originalLstat(redirect(file), ...args));
  t.mock.method(fs, 'openSync', (file, ...args) => originalOpen(redirect(file), ...args));
  assert.throws(() => measureRegisteredToolchain(), /unapproved node.*bytes/);
});

test('later process-path mutation cannot redirect the captured runtime selection', windows, t => {
  // Change only the OS-reported path in this synthetic boundary test; do not
  // create, inspect or execute anything in a different account.
  const actual = process.execPath;
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
  assert.equal(descriptor.writable, true);
  // The selected runtime is captured when the trusted module loads, so later
  // process/env mutation must not redirect any selected path.
  t.after(() => { process.execPath = actual; });
  process.execPath = path.join(path.dirname(os.userInfo().homedir), 'Foreign-Toolchain-Sentinel', 'node.exe');
  assert.equal(registeredToolPaths().node, actual);
  assert.throws(() => assertRegisteredToolIdentity('node', {
    path: process.execPath, bytes: 1,
    sha256: '995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362',
  }), /unapproved node path/);
});

test('changed loaded policy bytes cannot redefine runtime approval', windows, t => {
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'toolchain-policy-refusal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const changed = path.join(root, 'changed-policy.mjs');
  fs.writeFileSync(changed, 'export const arbitraryExecutableIsTrusted = true;');
  const selected = path.resolve(registeredToolchainPolicyIdentity().path);
  const originalLstat = fs.lstatSync.bind(fs), originalOpen = fs.openSync.bind(fs);
  const redirect = file => typeof file === 'string' && path.resolve(file) === selected ? changed : file;
  t.mock.method(fs, 'lstatSync', (file, ...args) => originalLstat(redirect(file), ...args));
  t.mock.method(fs, 'openSync', (file, ...args) => originalOpen(redirect(file), ...args));
  assert.throws(() => measureRegisteredToolchain(), /loaded tool policy changed/);
});

test('a relocated genuine Node keeps its byte approval without the legacy machine directory', windows, t => {
  const root = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'toolchain-relocated-node-'));
  const binary = path.join(root, 'node.exe');
  const selected = fileIdentity(process.execPath, { system: true });
  assertRegisteredToolIdentity('node', selected);
  fs.copyFileSync(process.execPath, binary, fs.constants.COPYFILE_EXCL);
  const script = path.join(root, 'inspect.mjs');
  const transport = new URL('../lib/transport/owned-job.mjs', import.meta.url).href;
  fs.writeFileSync(script, `import { measureRegisteredToolchain } from ${JSON.stringify(transport)};\n` +
    'const result=measureRegisteredToolchain(); console.log(JSON.stringify(result.tools.node));\n');
  const result = spawnSync(binary, [script], { windowsHide: true, encoding: 'utf8',
    timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
  if (result.error || result.signal) {
    t.diagnostic('Relocated Node scratch retained: child completion was not confirmed: ' + root);
    throw result.error || new Error('Relocated Node did not close normally');
  }
  try {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ...selected, path: binary });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
