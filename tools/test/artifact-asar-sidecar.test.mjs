import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readAsar, measureFile, measureTree, assertWindowsX64Pe } from '../lib/adapters/artifact-files.mjs';
import { measurePackagedLayout } from '../lib/adapters/artifact-layout.mjs';
import { nativeRuntimeTarget } from '../lib/adapters/artifact-native-runtime.mjs';
import { getReadinessContract, assertReadinessAdaptersAvailable } from '../lib/release-readiness.mjs';

const { createPackageWithOptions } = createRequire(import.meta.url)('@electron/asar');
const helpers = ['shell/screen-control-native.py', 'shell/screen-control-native.ps1'];

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-asar-sidecar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), stage = path.join(root, 'stage'), archive = path.join(stage, 'resources', 'app.asar');
  const sourceRefs = { app: 'a'.repeat(40), engine: 'b'.repeat(40) };
  fs.mkdirSync(path.join(source, 'shell'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dist'));
  fs.mkdirSync(path.join(source, 'config'));
  fs.writeFileSync(path.join(source, 'config/google-signin.json'), '{}');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ main: 'shell/main.cjs', version: '1.0.45', build: { asarUnpack: helpers } }));
  fs.writeFileSync(path.join(source, 'shell/main.cjs'), '// packed entry point\n');
  fs.writeFileSync(path.join(source, 'dist/build-info.json'), JSON.stringify({ schemaVersion: 2,
    ref: sourceRefs.app, dirty: false, overridden: false, dirtyFiles: [],
    app: { ref: sourceRefs.app, dirty: false, dirtyFiles: [] },
    payload: { ref: sourceRefs.engine, dirty: false, dirtyFiles: [], resolved: true } }));
  for (const name of helpers) fs.writeFileSync(path.join(source, name), '// inert fixture for ' + name + '\n');
  await createPackageWithOptions(source, archive, { unpack: '**/shell/screen-control-native.{py,ps1}' });
  for (const name of helpers) assert.ok(fs.statSync(path.join(archive + '.unpacked', name)).isFile());
  return { root, source, stage, archive, sourceRefs, unpackedRoot: archive + '.unpacked', allowedUnpacked: helpers };
}

test('real ASAR native helper sidecars are measured with the packed source files', async t => {
  const f = await fixture(t);
  const actual = readAsar(f.archive, f);
  assert.equal(actual.packageJson.main, 'shell/main.cjs');
  for (const name of helpers) assert.deepEqual(actual.files[name], measureFile(path.join(f.source, name)));
  assert.deepEqual(Object.keys(actual.unpacked.files).sort(), helpers.toSorted());
  assert.equal(Object.keys(actual.files).length, 6);
});

test('ordinary archive reads do not silently opt into external sidecar files', async t => {
  const f = await fixture(t);
  assert.throws(() => readAsar(f.archive), /unpacked|sidecar/);
  assert.throws(() => readAsar(f.archive, { unpackedRoot: f.unpackedRoot }), /unpacked|sidecar/);
});

test('missing, extra and differently sized native helpers are refused', async t => {
  const f = await fixture(t), name = helpers[0], file = path.join(f.unpackedRoot, name);
  const original = fs.readFileSync(file);
  fs.unlinkSync(file);
  assert.throws(() => readAsar(f.archive, f), /ENOENT|sidecar/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(f.unpackedRoot, 'extra.js'), 'unaccounted bytes');
  assert.throws(() => readAsar(f.archive, f), /sidecar/);
  fs.unlinkSync(path.join(f.unpackedRoot, 'extra.js'));
  fs.appendFileSync(file, 'changed size');
  assert.throws(() => readAsar(f.archive, f), /sidecar/);
});

test('the declared sidecar set cannot authorize an undeclared helper or packed entry point', async t => {
  const f = await fixture(t);
  assert.throws(() => readAsar(f.archive, { ...f, allowedUnpacked: [helpers[0]] }), /unpacked|sidecar/);
  assert.throws(() => readAsar(f.archive, { ...f, allowedUnpacked: [...helpers, 'shell/main.cjs'] }), /sidecar/);
  assert.throws(() => readAsar(f.archive, { ...f, allowedUnpacked: [...helpers, '../escape'] }), /unsafe/);
});

test('same-length modified sidecar bytes remain visible to the source comparison', async t => {
  const f = await fixture(t), file = path.join(f.unpackedRoot, helpers[0]);
  const original = readAsar(f.archive, f);
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  const changed = readAsar(f.archive, f);
  assert.notEqual(changed.files[helpers[0]].sha256, original.files[helpers[0]].sha256);
  assert.notEqual(changed.sha256, original.sha256);
});

test('the real product layout compares native sidecar bytes with shell source before payload qualification', async t => {
  const f = await fixture(t);
  const input = { product: 'toolsenabled', stageRoot: f.stage,
    sourceRoots: { app: f.source, engine: path.join(f.root, 'engine') }, sourceRefs: f.sourceRefs };
  // This fixture deliberately has no engine payload or native runtime. Correct
  // shell binding reaches that next boundary; it does not earn qualification.
  assert.throws(() => measurePackagedLayout(input), error => error.code === 'ENOENT' && /capability/.test(error.path));
  const file = path.join(f.unpackedRoot, helpers[0]), bytes = fs.readFileSync(file);
  bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => measurePackagedLayout(input), /packaged shell file selection\/bytes differ/);
  fs.writeFileSync(file, fs.readFileSync(path.join(f.source, helpers[0])));
  const pkg = JSON.parse(fs.readFileSync(path.join(f.source, 'package.json')));
  pkg.build.asarUnpack.push('shell/main.cjs');
  fs.writeFileSync(path.join(f.source, 'package.json'), JSON.stringify(pkg));
  assert.throws(() => measurePackagedLayout(input), /native helper selection differs/);
});

// Complete static layout fixture only. Inert binary headers are never run;
// these checks cannot produce a native installer or qualification receipt.
async function completeLayoutFixture(t, target) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-race-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'), engine = path.join(root, 'engine'), stage = path.join(root, 'stage');
  const write = (base, name, data) => { const full = path.join(base, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, data); };
  const sourceRefs = { app: 'a'.repeat(40), engine: 'b'.repeat(40) };
  const linux = target?.platform === 'linux';
  write(app, 'package.json', JSON.stringify({ main: 'shell/main.cjs', version: '9.9.9', productName: 'ToolsEnabled',
    build: { electronVersion: '43.3.0', asarUnpack: helpers, linux: { executableName: 'toolsenabled' } } }));
  write(app, 'shell/main.cjs', '// inert main\n');
  for (const name of helpers) write(app, name, '// inert source helper ' + name + '\n');
  write(app, 'config/google-signin.json', '{}');
  write(app, 'dist/build-info.json', JSON.stringify({ schemaVersion: 2, ref: sourceRefs.app, dirty: false,
    overridden: false, dirtyFiles: [], app: { ref: sourceRefs.app, dirty: false, dirtyFiles: [] },
    payload: { ref: sourceRefs.engine, dirty: false, dirtyFiles: [], resolved: true } }));
  // Pack only the real shell/config/renderer entries. The external closure
  // inputs are created below, after @electron/asar has captured this tree.
  const archive = path.join(stage, 'resources/app.asar');
  await createPackageWithOptions(app, archive, { unpack: '**/shell/screen-control-native.{py,ps1}' });
  const manifest = { entrypoints: ['tools/mission-bridge.js'], hostModules: ['src/owner-host.js'], spawnedPrograms: [],
    helperPrograms: [], dataFiles: [], neutralDefaults: ['defaults.json'], dynamicRequires: [] };
  write(app, 'tools/capability-manifest.json', JSON.stringify(manifest));
  const contents = { 'defaults.json': '{}', 'tools/mission-bridge.js': '// inert bridge\n', 'src/owner-host.js': '// inert owner host\n' };
  const payload = path.join(stage, 'resources/capability');
  const digest = createHash('sha256'); let byteCount = 0;
  for (const name of Object.keys(contents).sort()) {
    write(name === 'defaults.json' ? path.join(app, 'capability-defaults') : engine, name, contents[name]);
    write(payload, name, contents[name]); digest.update(name).update('\0').update(contents[name]); byteCount += Buffer.byteLength(contents[name]);
  }
  write(payload, 'PAYLOAD.json', JSON.stringify({ schemaVersion: 1, sourceRef: sourceRefs.engine, ownerDataClean: true,
    fileCount: 3, byteCount, payloadSha256: digest.digest('hex'), bridgeEntrypoint: manifest.entrypoints[0],
    ownerHostModule: 'src/owner-host.js', ...manifest }));
  const common = ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin',
    'v8_context_snapshot.bin', 'LICENSES.chromium.html', 'locales/en-US.pak'];
  const native = linux ? ['chrome-sandbox', 'chrome_crashpad_handler', 'libffmpeg.so', 'libEGL.so', 'libGLESv2.so',
    'libvk_swiftshader.so', 'libvulkan.so.1', 'vk_swiftshader_icd.json'] : ['ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'd3dcompiler_47.dll'];
  for (const name of [...common, ...native]) write(stage, name, 'fixture');
  write(stage, 'version', '43.3.0');
  if (linux) {
    const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    elf.writeUInt16LE(3, 16); elf.writeUInt16LE(62, 18); elf.writeUInt32LE(1, 20); elf.writeUInt16LE(64, 52);
    write(stage, 'toolsenabled', elf);
  } else {
    const pe = Buffer.alloc(90); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x20b, 88);
    write(stage, 'ToolsEnabled.exe', pe);
  }
  return { input: { product: 'toolsenabled', stageRoot: stage, sourceRoots: { app, engine }, sourceRefs, ...(target ? { target } : {}) },
    stage, app, helper: path.join(archive + '.unpacked', helpers[0]), sourceHelper: path.join(app, helpers[0]) };
}

test('static complete layout fixture returns its actually measured stage', async t => {
  const f = await completeLayoutFixture(t), measured = measurePackagedLayout(f.input);
  assert.equal(measured.stage.sha256, measureTree(f.stage).sha256);
});

test('explicit Linux layout reuses the complete source and capability checks while selecting native runtime files', async t => {
  const target = { platform: 'linux', arch: 'x64' };
  const linux = await completeLayoutFixture(t, target), windows = await completeLayoutFixture(t);
  const result = measurePackagedLayout(linux.input), baseline = measurePackagedLayout(windows.input);
  assert.equal(result.runtimeAndClosure.executable, 'toolsenabled');
  assert.equal(baseline.runtimeAndClosure.executable, 'ToolsEnabled.exe');
  assert.equal(result.shellSha256, baseline.shellSha256);
  assert.equal(result.sourceAndPayload.payloadSha256, baseline.sourceAndPayload.payloadSha256);
  assert.equal(result.stage.sha256, measureTree(linux.stage).sha256);
  fs.writeFileSync(path.join(linux.stage, 'resources/capability/extra.js'), '// unaccounted');
  assert.throws(() => measurePackagedLayout(linux.input), /payload omits\/adds/);
  // Linux release readiness registers the artifact subject measurer and
  // adapter used by the cut gate; the static layout still selects the Linux
  // executable and preserves the shared payload checks above.
  assert.equal(getReadinessContract('toolsenabled', target).subjectMeasurer?.id, 'artifact-subject:v1');
  assert.throws(() => assertReadinessAdaptersAvailable('toolsenabled', target), { code: 'RELEASE_READINESS_BLOCKED' });
});

test('Linux native inspection rejects missing dependencies, wrong machine/class/endianness/type and version', async t => {
  const f = await completeLayoutFixture(t, { platform: 'linux', arch: 'x64' });
  const file = path.join(f.stage, 'toolsenabled'), original = fs.readFileSync(file);
  for (const mutate of [bytes => bytes.writeUInt16LE(183, 18), bytes => { bytes[4] = 1; },
    bytes => { bytes[5] = 2; }, bytes => bytes.writeUInt16LE(1, 16), bytes => bytes.writeUInt32LE(0, 20),
    bytes => bytes.writeUInt16LE(63, 52)]) {
    const bytes = Buffer.from(original); mutate(bytes); fs.writeFileSync(file, bytes);
    assert.throws(() => measurePackagedLayout(f.input), /Linux x64 ELF64/);
  }
  fs.writeFileSync(file, original);
  fs.unlinkSync(path.join(f.stage, 'libffmpeg.so'));
  assert.throws(() => measurePackagedLayout(f.input), /dependency is absent: libffmpeg/);
  fs.writeFileSync(path.join(f.stage, 'libffmpeg.so'), 'fixture');
  fs.writeFileSync(path.join(f.stage, 'version'), '0.0.0');
  assert.throws(() => measurePackagedLayout(f.input), /Electron version differs/);
});

test('native layout target is closed and never inferred from the test host', () => {
  for (const target of [null, {}, { platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64', requiredFiles: [] }]) {
    assert.throws(() => measurePackagedLayout({ product: 'toolsenabled', stageRoot: '/absent-stage', target }),
      /native.*target/);
  }
  assert.equal(nativeRuntimeTarget().platform, 'win32');
  for (const platform of ['win32', 'linux']) {
    const target = { platform, arch: 'x64' }, native = nativeRuntimeTarget(target);
    assert.deepEqual({ platform: native.platform, arch: native.arch }, getReadinessContract('toolsenabled', target).target);
    assert.equal(Object.isFrozen(native.requiredFiles), true);
  }
});

test('standalone layout also refuses source-bound files changed after their comparison', async t => {
  const f = await completeLayoutFixture(t), root = path.dirname(f.stage);
  const website = path.join(root, 'website'), stage = path.join(root, 'standalone-stage');
  const write = (base, name, bytes) => { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  for (const [prefix, source, name] of [['app', 'scribe', 'server.js'], ['shared', 'shared', 'shared.js'], ['shell', 'shell', 'main.js']]) {
    write(website, `software/${source}/${name}`, '// inert source');
    write(stage, `${prefix}/${name}`, '// inert source');
  }
  write(stage, 'shell/product.json', JSON.stringify({ name: 'ToolsEnabled Scribe', server: 'server.js', portEnv: 'SCRIBE_PORT', startupTimeoutMs: 60000 }));
  for (const name of fs.readdirSync(f.stage)) if (name !== 'resources') {
    const destination = path.join(stage, 'runtime/electron', name === 'ToolsEnabled.exe' ? 'electron.exe' : name);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(path.join(f.stage, name), destination, { recursive: true });
  }
  const input = { product: 'scribe', stageRoot: stage, sourceRoots: { website }, sourceRefs: { website: 'c'.repeat(40) } };
  assert.equal(measurePackagedLayout(input).stage.sha256, measureTree(stage).sha256);
  const original = fs.openSync, executable = path.join(stage, 'runtime/electron/electron.exe');
  let opens = 0, changed = false;
  fs.openSync = function(file, ...args) {
    // First executable read belongs to the initial whole-stage capture. The
    // second belongs to runtime inspection, after app source comparison.
    if (file === executable && ++opens === 2) { changed = true; fs.writeFileSync(path.join(stage, 'app/server.js'), '// other bytes'); }
    return original.call(fs, file, ...args);
  };
  try { assert.throws(() => measurePackagedLayout(input), /tree|differs/); }
  finally { fs.openSync = original; assert.equal(changed, true); }
});

test('changing a sidecar between initial stage capture and source comparison must refuse', async t => {
  const f = await completeLayoutFixture(t), sourceBytes = fs.readFileSync(f.sourceHelper), changedBytes = Buffer.from(sourceBytes);
  changedBytes[0] ^= 1; fs.writeFileSync(f.helper, changedBytes);
  const original = fs.openSync; let restored = false, result;
  fs.openSync = function(file, ...args) {
    if (!restored && file === path.join(f.app, 'package.json')) {
      restored = true;
      fs.writeFileSync(f.helper, sourceBytes);
    }
    return original.call(fs, file, ...args);
  };
  try {
    assert.throws(() => { result = measurePackagedLayout(f.input); }, /changed|differs/);
  } finally {
    fs.openSync = original;
    assert.equal(restored, true);
    if (result) console.log(JSON.stringify({ returnedStage: result.stage.sha256, actualStage: measureTree(f.stage).sha256,
      consistent: result.stage.sha256 === measureTree(f.stage).sha256 }));
  }
});

test('ASAR bytes must come from the same identity that the result names', async t => {
  const f = await fixture(t);
  const before = measureFile(f.archive), originalMain = fs.readFileSync(path.join(f.source, 'shell/main.cjs'));
  originalMain[0] ^= 1; fs.writeFileSync(path.join(f.source, 'shell/main.cjs'), originalMain);
  const alternate = path.join(f.root, 'alternate.asar');
  await createPackageWithOptions(f.source, alternate, { unpack: '**/shell/screen-control-native.{py,ps1}' });
  assert.equal(measureFile(alternate).bytes, before.bytes);
  const alternateMain = measureFile(path.join(f.source, 'shell/main.cjs'));
  const original = fs.openSync; let opens = 0, switched = false, result;
  fs.openSync = function(file, ...args) {
    if (file === f.archive && ++opens === 2) {
      const saved = f.archive + '.saved'; fs.renameSync(f.archive, saved); fs.copyFileSync(alternate, f.archive);
      const fd = original.call(fs, file, ...args);
      fs.unlinkSync(f.archive); fs.renameSync(saved, f.archive); switched = true;
      return fd;
    }
    return original.call(fs, file, ...args);
  };
  try { assert.throws(() => { result = readAsar(f.archive, f); }, /changed|identity|archive/); }
  finally {
    fs.openSync = original; assert.equal(switched, true);
    if (result) console.log(JSON.stringify({ namedIdentityMatchesOriginal: result.identity.sha256 === before.sha256,
      measuredPackedMainMatchesDifferentArchive: result.files['shell/main.cjs'].sha256 === alternateMain.sha256 }));
  }
});

test('native PE inspection cannot borrow a different file for its parsing descriptor', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-identity-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'not-pe.exe'), alternate = path.join(root, 'fixture-pe.exe');
  const pe = Buffer.alloc(90); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68); pe.writeUInt16LE(0x20b, 88);
  fs.writeFileSync(alternate, pe); fs.writeFileSync(file, Buffer.alloc(90));
  const original = fs.openSync; let swapped = false;
  fs.openSync = function(name, ...args) {
    if (!swapped && name === file) {
      const saved = file + '.saved'; fs.renameSync(file, saved); fs.copyFileSync(alternate, file);
      const fd = original.call(fs, name, ...args);
      fs.unlinkSync(file); fs.renameSync(saved, file); swapped = true;
      return fd;
    }
    return original.call(fs, name, ...args);
  };
  try { assert.throws(() => assertWindowsX64Pe(file), /identity|changed|PE/); }
  finally { fs.openSync = original; assert.equal(swapped, true); }
});
