import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { measureFile, digestRecord } from '../lib/adapters/artifact-files.mjs';
import { inspectDebArchive, captureDebMembers, inspectTarArchive, readVerifiedTarEntry } from '../lib/adapters/artifact-archive.mjs';
import { inspectDebianPackage } from '../lib/adapters/artifact-deb.mjs';
import { verifyInstallerStage } from '../lib/adapters/artifact-subject.mjs';
import { runOwnedJob } from '../lib/transport/owned-job.mjs';
import { LINUX_XZ, linuxXzArguments, assertLinuxXzInput, measureLinuxXzToolchain, linuxXzEnvironment } from '../lib/transport/linux-xz-toolchain.mjs';

const linux = { skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 120000 };
function xz(bytes) {
  const result = spawnSync('/usr/bin/xz', ['--compress', '--stdout'], { input: bytes, env: { PATH: '/usr/bin', LANG: 'C', LC_ALL: 'C' }, timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0); return result.stdout;
}
function nativeFixture(t, bytes) {
  const f = fixture(t), cwd = path.join(f.root, 'input'), evidenceRoot = path.join(f.root, 'evidence');
  for (const directory of [cwd, evidenceRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  const input = f.put('input/data.tar.xz', bytes);
  return { ...f, input, cwd, evidenceRoot, job: { command: LINUX_XZ, args: linuxXzArguments(input), cwd, evidenceRoot, timeoutMs: 30000 } };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-deb-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes, { mode: 0o600 }); return file; };
  return { root, put };
}
function tarEntry(name, bytes = Buffer.alloc(0), { type = '0', mode = 0o644, target = '', uid = 0, gid = 0, uname = '', extension = 0 } = {}) {
  bytes = Buffer.from(bytes);
  const header = Buffer.alloc(512);
  const text = (at, length, value) => { assert.ok(Buffer.byteLength(value) <= length); header.write(value, at, length); };
  const octal = (at, length, value) => text(at, length, value.toString(8).padStart(length - 1, '0') + '\0');
  text(0, 100, name); octal(100, 8, mode); octal(108, 8, uid); octal(116, 8, gid);
  octal(124, 12, bytes.length); octal(136, 12, 0); header.fill(32, 148, 156);
  text(156, 1, type); text(157, 100, target); text(257, 8, 'ustar  \0');
  text(265, 32, uname); header[482] = extension;
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  text(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return Buffer.concat([header, bytes, Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length)]);
}
const tar = rows => Buffer.concat([...rows, Buffer.alloc(1024)]);
function arMember(name, bytes) {
  bytes = Buffer.from(bytes);
  const header = Buffer.from(`${`${name}/`.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(bytes.length).padEnd(10)}\x60\n`);
  assert.equal(header.length, 60);
  return Buffer.concat([header, bytes, bytes.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
}
const deb = (control, data, extra = []) => Buffer.concat([Buffer.from('!<arch>\n'), arMember('debian-binary', '2.0\n'),
  arMember('control.tar.xz', control), arMember('data.tar.xz', data), ...extra]);
const xzMarker = Buffer.from([253, 55, 122, 88, 90, 0]);

function packageFixture(t) {
  const f = fixture(t), appRoot = path.join(f.root, 'source'), stageRoot = path.join(f.root, 'stage');
  const actualRoot = fileURLToPath(new URL('../../', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(actualRoot, 'package.json'))); pkg.version = '0.0.0';
  for (const name of ['shell', 'build/linux']) fs.mkdirSync(path.join(appRoot, name), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stageRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify(pkg), { mode: 0o600 });
  const source = name => fs.readFileSync(path.join(actualRoot, name));
  for (const name of ['shell/icon.png', 'build/linux/deb-maintainer.sh', 'build/linux/toolsenabled-customer.apparmor'])
    fs.writeFileSync(path.join(appRoot, name), source(name), { mode: 0o600 });
  fs.writeFileSync(path.join(stageRoot, 'test.txt'), 'bounded fixture', { mode: 0o644 });
  const desktop = `[Desktop Entry]\nName=ToolsEnabled\nExec=/opt/ToolsEnabled/toolsenabled %U\nTerminal=false\nType=Application\nIcon=toolsenabled\nStartupWMClass=toolsenabled\nComment=${pkg.description}\nCategories=Development;\n`;
  const files = {
    'opt/ToolsEnabled/test.txt': Buffer.from('bounded fixture'),
    'usr/share/applications/toolsenabled.desktop': Buffer.from(desktop),
    'usr/share/icons/hicolor/256x256/apps/toolsenabled.png': source('shell/icon.png'),
    'usr/share/doc/toolsenabled/changelog.gz': gzipSync(`toolsenabled (0.0.0) ; urgency=medium\n\n  * Package created with FPM.\n\n -- ${pkg.build.deb.maintainer}  Sun, 13 Sep 2026 12:00:00 -0700\n`, { level: 9 }),
  };
  function archives({ changeData = {}, extraControl = {}, changeControl = {}, modeData = {}, ownerData = {} } = {}) {
    const selected = { ...files, ...changeData };
    const dirs = new Set(['.']);
    for (const name of Object.keys(selected)) for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) dirs.add(parent);
    const data = tar([...dirs].sort().map(name => tarEntry(name, '', { type: '5', mode: 0o755 }))
      .concat(Object.entries(selected).map(([name, bytes]) => tarEntry(name, bytes, { mode: modeData[name] || 0o644, uname: ownerData[name] || '' }))));
    const size = Math.floor(Object.values(selected).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0) / 1024);
    const controlText = `Package: toolsenabled\nVersion: 0.0.0\nLicense: ${pkg.license}\nVendor: ${pkg.build.deb.maintainer}\nArchitecture: amd64\nMaintainer: ${pkg.build.deb.maintainer}\nInstalled-Size: ${size}\nDepends: ${pkg.build.deb.depends.join(', ')}\nRecommends: libappindicator3-1\nSection: default\nPriority: optional\nHomepage: ${pkg.homepage}\nDescription: \n  ${pkg.description}\n`;
    const md5 = Object.entries(selected).map(([name, bytes]) => `${createHash('md5').update(bytes).digest('hex')}  ${name}\n`).join('');
    const control = tar([tarEntry('.', '', { type: '5', mode: 0o755 }), ...Object.entries({ control: controlText, md5sums: md5,
      postinst: source('build/linux/deb-maintainer.sh'), postrm: source('build/linux/deb-maintainer.sh'), ...changeControl, ...extraControl })
      .map(([name, bytes]) => tarEntry(name, bytes, { mode: ['postinst', 'postrm', 'preinst'].includes(name) ? 0o755 : 0o644 }))]);
    return { control, data };
  }
  const inspect = options => {
    const pair = archives(options), controlTar = f.put('control.tar', pair.control), dataTar = f.put('data.tar', pair.data);
    return inspectDebianPackage({ appRoot, stageRoot, controlTar, dataTar });
  };
  return { ...f, appRoot, stageRoot, pkg, files, archives, inspect };
}

test('shared ar parser accounts for exactly three ordered Debian members and captures exact bytes', t => {
  const f = fixture(t), control = Buffer.concat([xzMarker, Buffer.from('control')]), data = Buffer.concat([xzMarker, Buffer.from('data')]);
  const file = f.put('fixture.deb', deb(control, data));
  const parsed = inspectDebArchive(file);
  assert.deepEqual(parsed.members.map(member => member.name), ['debian-binary', 'control.tar.xz', 'data.tar.xz']);
  const scratch = path.join(f.root, 'compressed'); fs.mkdirSync(scratch, { mode: 0o700 });
  const captured = captureDebMembers(file, scratch);
  assert.deepEqual(captured.artifact, parsed.artifact);
  for (const [name, expected] of [['control.tar.xz', control], ['data.tar.xz', data]]) {
    assert.deepEqual(fs.readFileSync(captured.members[name].path), expected);
    assert.equal(captured.members[name].sha256, createHash('sha256').update(expected).digest('hex'));
  }
});

test('ar parser refuses extra, reordered, truncated, non-XZ and ambiguous members', t => {
  const f = fixture(t), valid = deb(xzMarker, xzMarker);
  const rows = [deb(xzMarker, xzMarker, [arMember('extra', 'bad')]), valid.subarray(0, -1),
    deb(Buffer.from('not XZ'), xzMarker), Buffer.from(valid), Buffer.from(valid)];
  rows[3].write('data.tar.xz/    ', 8 + arMember('debian-binary', '2.0\n').length, 16);
  rows[4].write('-1        ', 8 + 48, 10);
  rows.forEach((bytes, index) => assert.throws(() => inspectDebArchive(f.put(`bad-${index}.deb`, bytes)), /Artifact qualification blocked/));
});

test('shared tar parser binds GNU names, types, permissions, bytes and content hashes', t => {
  const f = fixture(t), value = Buffer.from([0, 255, 13, 10]), long = 'opt/ToolsEnabled/' + 'a'.repeat(140);
  const file = f.put('data.tar', tar([tarEntry('./', '', { type: '5', mode: 0o755 }),
    tarEntry('./opt/', '', { type: '5', mode: 0o755 }), tarEntry('././@LongLink', Buffer.from(long + '\0'), { type: 'L' }), tarEntry('short', value)]));
  const parsed = inspectTarArchive(file);
  assert.deepEqual(parsed.entries.map(entry => [entry.name, entry.type, entry.mode]), [['.', 'directory', 0o755], ['opt', 'directory', 0o755], [long, 'file', 0o644]]);
  assert.equal(parsed.totalBytes, value.length);
  assert.deepEqual(readVerifiedTarEntry(file, parsed, long), value);
  assert.equal(parsed.entries.at(-1).sha256, createHash('sha256').update(value).digest('hex'));
});

test('tar parser rejects escapes, aliases, duplicate paths, specials and unaccounted trailing content', t => {
  const f = fixture(t);
  const rows = [tar([tarEntry('../outside', 'bad')]), tar([tarEntry('/absolute', 'bad')]), tar([tarEntry('a\\b', 'bad')]),
    tar([tarEntry('same', 'a'), tarEntry('same', 'b')]), tar([tarEntry('same', 'a'), tarEntry('SAME', 'b')]),
    tar([tarEntry('device', '', { type: '3' })]), tar([tarEntry('pax', 'bad', { type: 'x' })]),
    Buffer.concat([tar([tarEntry('first', 'a')]), tar([tarEntry('trailing', 'bad')])]),
    tar([tarEntry('dir', 'bytes', { type: '5' })]), tar([tarEntry('file', 'a', { target: 'hidden' })]),
    tar([tarEntry('file', 'a', { extension: 1 })])];
  rows.forEach((bytes, index) => assert.throws(() => inspectTarArchive(f.put(`bad-${index}.tar`, bytes)), /Artifact qualification blocked/));
  const checksum = tar([tarEntry('file', 'a')]); checksum[0] ^= 1;
  assert.throws(() => inspectTarArchive(f.put('checksum.tar', checksum)), /checksum/);
  assert.throws(() => inspectTarArchive(f.put('unterminated.tar', tarEntry('file', 'a'))), /complete|terminator/);
});

test('selected tar content cannot outlive its archive identity or exceed its budget', t => {
  const f = fixture(t), file = f.put('data.tar', tar([tarEntry('file', 'content')]));
  const parsed = inspectTarArchive(file);
  assert.throws(() => readVerifiedTarEntry(file, parsed, 'file', 2), /excessive/);
  fs.writeFileSync(file, tar([tarEntry('file', 'changed')]));
  assert.throws(() => readVerifiedTarEntry(file, parsed, 'file'), /changed/);
});

test('archive parsing rejects symlink and hardlink inputs before reading selected bytes', t => {
  const f = fixture(t), file = f.put('data.tar', tar([tarEntry('file', 'content')]));
  const link = path.join(f.root, 'linked.tar'); fs.symlinkSync(file, link);
  assert.throws(() => inspectTarArchive(link), /linked/);
  fs.unlinkSync(link); fs.linkSync(file, link);
  assert.throws(() => inspectTarArchive(file), /linked/);
});

test('archive mutation during a real descriptor read refuses its otherwise valid file table', t => {
  const f = fixture(t), bytes = tar([tarEntry('file', 'content')]), file = f.put('data.tar', bytes);
  const original = fs.readSync.bind(fs); let changed = false;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const result = original(fd, buffer, offset, length, position);
    if (!changed && position === 512) { changed = true; fs.writeFileSync(file, bytes); }
    return result;
  });
  assert.throws(() => inspectTarArchive(file), /changed/);
  assert.equal(changed, true);
});

test('whole Debian accounting binds stage, source scripts, desktop, icon, dependencies and md5sums', linux, t => {
  const f = packageFixture(t), actual = f.inspect();
  assert.equal(actual.allInstallerEntriesAccounted, true);
  assert.equal(actual.controlEntries.filter(entry => entry.type === 'file').length, 4);
  assert.deepEqual(actual.installedEntries.filter(entry => entry.type === 'file').map(entry => entry.name).sort(), Object.keys(f.files).sort());
});

test('outside-app changes never qualify merely because the complete app subtree still matches', linux, t => {
  const f = packageFixture(t);
  for (const options of [
    { changeData: { 'usr/share/applications/toolsenabled.desktop': Buffer.from('[Desktop Entry]\nExec=/bin/sh\n') } },
    { changeData: { 'usr/share/icons/hicolor/256x256/apps/toolsenabled.png': Buffer.from('different icon') } },
    { changeData: { 'etc/cron.d/unrelated': Buffer.from('unrelated root payload') } },
    { extraControl: { preinst: '#!/bin/sh\necho unexpected\n' } },
    { changeControl: { postinst: '#!/bin/sh\nexit 0\n' } },
    { changeControl: { md5sums: '' } },
    { changeControl: { control: 'Package: toolsenabled\nDepends: omitted\n' } },
    { modeData: { 'usr/share/applications/toolsenabled.desktop': 0o4755 } },
    { modeData: { 'opt/ToolsEnabled/test.txt': 0o664 } },
    { ownerData: { 'opt/ToolsEnabled/test.txt': 'unrelated-account' } },
  ]) assert.throws(() => f.inspect(options), /Artifact qualification blocked/);
});

test('Linux Debian dispatch accepts a real XZ Debian envelope instead of selecting Windows NSIS tools', linux, async t => {
  const f = packageFixture(t), { stageRoot, appRoot } = f, evidenceRoot = path.join(f.root, 'evidence'), candidate = path.join(f.root, 'candidate');
  for (const directory of [evidenceRoot, candidate]) fs.mkdirSync(directory, { mode: 0o700 });
  const pair = f.archives();
  const artifactPath = f.put('candidate/fixture.deb', deb(xz(pair.control), xz(pair.data)));
  const actual = await verifyInstallerStage({ product: 'toolsenabled', artifactPath, appRoot, stageRoot, evidenceRoot,
    target: { platform: 'linux', arch: 'x64' } });
  assert.equal(actual.artifact.sha256, inspectDebArchive(artifactPath).artifact.sha256);
  assert.equal(actual.accounting.allInstallerEntriesAccounted, true);
  assert.equal(actual.runs.length, 2);
  for (const run of actual.runs) {
    assert.equal(run.complete, true); assert.equal(run.cleanupConfirmed, true); assert.equal(run.hadRemainingChildren, false);
    assert.equal(run.nativeLaunch.descriptorInputs.length, 5);
    assert.equal(run.nativeLaunch.descriptorInputs[4].path.endsWith('.tar.xz'), true);
    assert.equal(run.nativeLaunch.output, 'bounded-private-file');
    assert.equal(run.nativeLaunch.args.at(-1), '/proc/self/fd/9');
    assert.equal(createHash('sha256').update(fs.readFileSync(run.stdout.path)).digest('hex'), run.stdout.sha256);
  }
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.artifact-extract-')), false);
  const changed = f.archives({ changeData: { 'usr/share/applications/toolsenabled.desktop': Buffer.from('changed outside app') } });
  fs.writeFileSync(artifactPath, deb(xz(changed.control), xz(changed.data)));
  await assert.rejects(verifyInstallerStage({ product: 'toolsenabled', artifactPath, appRoot, stageRoot, evidenceRoot,
    target: { platform: 'linux', arch: 'x64' } }), /desktop entry differs/);
  assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.artifact-extract-')), false);
});

test('XZ identities, options, environment and large-output privilege cannot be substituted', linux, async t => {
  const f = nativeFixture(t, xz(Buffer.from('native fixture'))), tools = measureLinuxXzToolchain();
  for (const [role, value] of Object.entries(tools.inputs)) {
    assertLinuxXzInput(role, value);
    assert.throws(() => assertLinuxXzInput(role, { ...value, sha256: '0'.repeat(64) }), /unapproved/);
  }
  assert.throws(() => linuxXzEnvironment({ XZ_DEFAULTS: '--single-stream' }), /no environment/);
  await assert.rejects(runOwnedJob({ ...f.job, args: ['--version'] }), /fixed bounded/);
  await assert.rejects(runOwnedJob({ ...f.job, env: { XZ_OPT: '--single-stream' } }), /no environment/);
  await assert.rejects(runOwnedJob({ ...f.job, command: process.execPath, args: ['-e', ''], maxOutputBytes: 65 * 1024 * 1024 }), /output budget/);
  const copy = f.put('xz-copy', fs.readFileSync(LINUX_XZ)); fs.chmodSync(copy, 0o700);
  await assert.rejects(runOwnedJob({ ...f.job, command: copy }), /not a registered/);
  assert.deepEqual(fs.readdirSync(f.evidenceRoot), []);
});

test('native XZ enforces decoded-byte budget and refuses trailing compressed junk with cleanup', linux, async t => {
  const f = nativeFixture(t, xz(Buffer.alloc(1024 * 1024)));
  const limited = await runOwnedJob({ ...f.job, maxOutputBytes: 1024 });
  assert.equal(limited.complete, false); assert.equal(limited.outputLimitExceeded, true); assert.equal(limited.cleanupConfirmed, true);
  assert.ok(limited.stdout.bytes <= 1024);
  fs.writeFileSync(f.input, Buffer.concat([xz(Buffer.from('valid')), Buffer.from('unaccounted trailing bytes')]));
  const trailing = await runOwnedJob(f.job);
  assert.notEqual(trailing.exitCode, 0); assert.equal(trailing.cleanupConfirmed, true);
});

test('a compressed input generation changed during real decoding cannot earn a successful receipt', linux, async t => {
  const bytes = xz(Buffer.alloc(1024 * 1024)), f = nativeFixture(t, bytes);
  const pending = runOwnedJob(f.job);
  // Preflight binds the exact descriptor before awaiting native completion.
  fs.writeFileSync(f.input, bytes);
  await assert.rejects(pending, /input.*changed|executable or transport changed/);
  const again = await runOwnedJob(f.job);
  assert.equal(again.complete, true); assert.equal(again.cleanupConfirmed, true);
});

// Exact shared function bodies with synthetic adapter phases and actual files.
// These regressions check custody across awaits; they are not native decoder,
// source, ASAR, or installed qualification evidence. Native tests above use the
// real decoder; this seam can place mutations at each otherwise lengthy phase.
for (const point of ['unchanged', 'source-before-decoder', 'source-after-decoder', 'checker-await', 'same-byte-replacement']) {
  test(`subject custody preserves exact artifact through ${point}`, async t => {
    const f = fixture(t), app = path.join(f.root, 'app');
    fs.mkdirSync(path.join(app, 'private'), { recursive: true });
    fs.writeFileSync(path.join(app, 'private/owner-data-patterns.owner.json'), '{}');
    fs.writeFileSync(path.join(app, 'checker.mjs'), '// inert; never executed\n');
    const artifactPath = f.put('fixture.deb', 'exact-artifact-A\n'), initial = measureFile(artifactPath);
    const context = { sourceRoots: { app, engine: app }, stageRoot: app, harnessRoot: app, evidenceRoot: f.root };
    const stage = { bytes: 3, sha256: 'synthetic-stage', files: {} };
    const binding = { sources: { app: { ref: 'app-ref' }, engine: { ref: 'engine-ref' } },
      harness: { clean: true, ref: 'app-ref', sha256: 'synthetic-harness' }, nativeExecution: [] };
    const toolchain = { tools: { node: { path: process.execPath } } };
    let sourceCalls = 0;
    const change = () => fs.writeFileSync(artifactPath, 'other-artifact-B\n');
    const scope = { fs, path, process: { platform: process.platform, arch: process.arch }, measureFile, digestRecord,
      checkAbort: () => {}, blocked: message => { throw new Error(message); }, nativeRuntimeTarget: value => value,
      assertMeasurementContext: (_product, value) => value, privateEvidenceForArtifact: () => {}, plainPath: value => value,
      matches: (a, b) => a?.sha256 === b?.sha256 && a?.bytes === b?.bytes,
      sourceInputs: async () => {
        sourceCalls++;
        if (point === 'source-before-decoder' && sourceCalls === 1 || point === 'source-after-decoder' && sourceCalls === 2) change();
        if (point === 'same-byte-replacement' && sourceCalls === 2) {
          fs.renameSync(artifactPath, artifactPath + '.previous'); fs.writeFileSync(artifactPath, 'exact-artifact-A\n');
        }
        return binding;
      },
      measureRegisteredToolchain: () => toolchain, verifyArtifactToolchainBinding: () => toolchain,
      measurePackagedLayout: () => ({ stage, runtimeSha256: 'synthetic-runtime', shellSha256: 'synthetic-shell' }),
      verifyInstallerStage: async () => ({ artifact: measureFile(artifactPath), stage, decoder: 'synthetic-phase', runs: [] }),
      assertSameTree: (a, b) => assert.equal(digestRecord(a), digestRecord(b)), sourceIdentity: ({ nativeExecution, ...value }) => value,
      measureLinuxGitToolchain: () => 'synthetic-source-tool', verifyGitToolIdentity: () => 'synthetic-source-tool',
      assertNoObviousPackagedSecrets: () => {}, measureLicenseDependencyInputs: () => ({ sha256: 'synthetic-dependency', bytes: 1 }),
      verifyArtifactCheckerInputs: () => ({ 'checker.mjs': measureFile(path.join(app, 'checker.mjs')) }),
      CHECKS: [['checker.mjs']], requireCompleted: value => value,
      runOwnedJob: async () => { if (point === 'checker-await') change(); return { complete: true, exitCode: 0, cleanupConfirmed: true }; },
      measureTree: () => stage,
    };
    const source = fs.readFileSync(new URL('../lib/adapters/artifact-subject.mjs', import.meta.url), 'utf8');
    const start = source.includes('function artifactFileGeneration(') ? source.indexOf('function artifactFileGeneration(') : source.indexOf('async function measuredSubject(');
    assert.ok(start >= 0);
    const subjectBody = source.slice(start, source.indexOf('export async function measureArtifactSubject('));
    const checksBody = source.slice(source.indexOf('async function integrityChecks('), source.indexOf('export async function executeArtifactIntegrity('));
    vm.runInNewContext(subjectBody + '\n' + checksBody, scope);
    const input = { product: 'toolsenabled', artifactPath, sourceRefs: { app: 'app-ref', engine: 'engine-ref' },
      target: { platform: process.platform, arch: process.arch }, context };
    const run = async () => { const measured = await scope.measuredSubject(input); await scope.integrityChecks(input, measured); return measured; };
    if (point === 'unchanged') assert.deepEqual((await run()).subject.artifact, initial);
    else {
      await assert.rejects(run(), /artifact|installer/i);
      assert.equal(measureFile(artifactPath).sha256 === initial.sha256, point === 'same-byte-replacement');
    }
  });
}
