import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { APPROVED_EXTRACTOR, verifyExtractorIdentity, verifyArtifactCheckerInputs,
  verifyArtifactToolchainBinding } from '../lib/adapters/artifact-subject.mjs';
import { measureRegisteredToolchain } from '../lib/transport/owned-job.mjs';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';

const SOURCE = fileURLToPath(new URL('../../', import.meta.url));
const windows = { skip: process.platform !== 'win32' && 'Windows artifact qualification toolchain' };
const CHECKERS = ['check-no-owner-data.mjs', 'check-license-notices.mjs', 'check-renderer-payload.mjs', 'check-payload-boundary.mjs'];

function scratch(t) {
  const parent = ownedFixtureTempRoot();
  const root = fs.mkdtempSync(path.join(parent, 'artifact-toolchain-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(parent));
    assert.ok(path.basename(root).startsWith('artifact-toolchain-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('artifact checkers admit only the reviewed current scripts and exact LF/CRLF forms', t => {
  assert.equal(Object.keys(verifyArtifactCheckerInputs(SOURCE)).length, CHECKERS.length);
  const root = scratch(t);
  fs.mkdirSync(path.join(root, 'tools'));
  for (const newline of ['\n', '\r\n']) {
    for (const name of CHECKERS) {
      const source = fs.readFileSync(path.join(SOURCE, 'tools', name), 'utf8').replaceAll('\r\n', '\n');
      fs.writeFileSync(path.join(root, 'tools', name), source.replaceAll('\n', newline));
    }
    assert.equal(Object.keys(verifyArtifactCheckerInputs(root)).length, CHECKERS.length);
  }
  fs.appendFileSync(path.join(root, 'tools', CHECKERS[0]), '\nprocess.exitCode = 0;\n');
  assert.throws(() => verifyArtifactCheckerInputs(root), /reviewed artifact checker changed/);
  assert.throws(() => verifyArtifactCheckerInputs(root, { approved: true }), /only the explicit source root/);
});

test('decoder identity accepts no caller-selected path, hash or policy', () => {
  assert.ok(Object.isFrozen(APPROVED_EXTRACTOR));
  assert.throws(() => verifyExtractorIdentity({ executable: process.execPath, sha256: '0'.repeat(64) }), /no caller path or policy/);
});

test('the native decoder remains the exact registered 7-Zip 24.08 pair after relocation', windows, () => {
  const measured = verifyExtractorIdentity();
  const ownerRoot = path.join(os.userInfo().homedir, 'AppData', 'Local', 'ToolsEnabledQualification', 'tools', '7zip-24.08-x64');
  const ownerPairPresent = ['7z.exe', '7z.dll'].some(name => fs.existsSync(path.join(ownerRoot, name)));
  assert.equal(APPROVED_EXTRACTOR.executable, path.join(ownerPairPresent ? ownerRoot : 'C:\\Program Files\\7-Zip', '7z.exe'));
  assert.equal(measured.executable.sha256, '707f415d7d581edd9bce99a0429ad4629d3be0316c329e8b9ebd576f7ab50b71');
  assert.equal(measured.library.sha256, 'e79ddfb6319dbf9bac6382035d23597dad979db5e71a605d81a61ee817c1e812');
  assert.equal(measured.executable.bytes, 562176);
  assert.equal(measured.library.bytes, 1892864);
});

for (const role of ['executable', 'library']) {
  test(`changed ${role} decoder bytes are rejected by actual file measurement`, windows, t => {
    // Synthetic read boundary only. Neither decoder file is modified and no
    // command is executed; real measurement reads an ordinary changed file.
    const root = scratch(t), changed = path.join(root, 'changed.bin');
    fs.writeFileSync(changed, 'unapproved decoder bytes');
    const selected = path.resolve(APPROVED_EXTRACTOR[role]);
    const originalLstat = fs.lstatSync.bind(fs), originalOpen = fs.openSync.bind(fs);
    const redirect = file => typeof file === 'string' && path.resolve(file) === selected ? changed : file;
    t.mock.method(fs, 'lstatSync', (file, ...args) => originalLstat(redirect(file), ...args));
    t.mock.method(fs, 'openSync', (file, ...args) => originalOpen(redirect(file), ...args));
    assert.throws(() => verifyExtractorIdentity(), /approved archive decoder bytes changed/);
  });
}

test('an incomplete selected decoder pair cannot fall back to a different installation', windows, t => {
  const selected = path.resolve(APPROVED_EXTRACTOR.library);
  const original = fs.lstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (typeof file === 'string' && path.resolve(file) === selected) throw Object.assign(new Error('missing selected decoder library'), { code: 'ENOENT' });
    return original(file, ...args);
  });
  assert.throws(() => verifyExtractorIdentity(), /missing selected decoder library/);
});

test('unregistered extra decoder modules cannot enter through the portable cache', windows, t => {
  const codecPath = path.join(path.dirname(APPROVED_EXTRACTOR.executable), 'Codecs');
  const original = fs.lstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (file, ...args) => file === codecPath ? {} : original(file, ...args));
  assert.throws(() => verifyExtractorIdentity(), /codecs\/formats are not registered/);
});

test('artifact subject replay requires the exact registered runtime and policy binding', windows, () => {
  const actual = measureRegisteredToolchain();
  assert.equal(actual.tools.node.path, process.execPath);
  assert.deepEqual(verifyArtifactToolchainBinding(actual), actual);
  for (const mutate of [
    value => { value.tools.node.sha256 = '0'.repeat(64); },
    value => { value.tools.node.path = path.join(os.userInfo().homedir, 'caller-node.exe'); },
    value => { value.tools.powershell.sha256 = '0'.repeat(64); },
    value => { value.policy.sha256 = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(actual);
    mutate(changed);
    assert.throws(() => verifyArtifactToolchainBinding(changed), /differs from the measured subject/);
  }
  assert.throws(() => verifyArtifactToolchainBinding(), /requires its measured subject binding/);
});
