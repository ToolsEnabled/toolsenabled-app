import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectLinuxElf, assertLinuxSystemElfIdentity, linuxElfClosure, measureLinuxSystemElf } from '../lib/transport/linux-elf-inputs.mjs';
import { measureLinuxToolchain } from '../lib/transport/linux-toolchain.mjs';
import { runOwnedJob } from '../lib/transport/owned-job.mjs';
import { measureFile } from '../lib/adapters/artifact-files.mjs';

const linux = { skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 90000 };
const app = fileURLToPath(new URL('../..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-elf-inputs-'));
  fs.chmodSync(root, 0o700);
  for (const name of ['work', 'evidence']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd: path.join(root, 'work'), evidenceRoot: path.join(root, 'evidence') };
}

test('actual Node and Python owner extensions have a closed measured system ELF graph', linux, () => {
  const actual = measureLinuxToolchain();
  assert.deepEqual(actual.elf.nodeLibraries, ['dl', 'gcc', 'libc', 'libm', 'loader', 'pthread', 'stdcpp']);
  assert.deepEqual(actual.elf.ownerLibraries, ['expat', 'ffi', 'libc', 'libm', 'loader', 'zlib']);
  assert.deepEqual(actual.elf.roots.ctypes.needed, ['libffi.so.8', 'libc.so.6']);
  assert.deepEqual(actual.elf.roots.json.needed, []);
  assert.equal(actual.elf.roots.node.interpreter, '/lib64/ld-linux-x86-64.so.2');
  assert.equal(actual.elf.resolver.resolutions['libstdc++.so.6'], '/lib/x86_64-linux-gnu/libstdc++.so.6');
  assert.ok(actual.elf.resolver.absentInputs.includes('/etc/ld.so.preload'));
  assert.equal(actual.elf.runtimeData.gconv.path, '/usr/lib/x86_64-linux-gnu/gconv/gconv-modules.cache');
  assert.equal(actual.elf.scope, 'fixed-owner-and-checker-ELF-inputs');
  assert.match(actual.elf.limits.join(' '), /arbitrary dlopen is not qualified/);
});

test('fixed identities, loader profiles and unresolved dependency names are refused', linux, () => {
  const actual = measureLinuxSystemElf('owner');
  for (const [role, input] of Object.entries(actual.inputs)) {
    assertLinuxSystemElfIdentity(role, input);
    for (const change of [{ path: input.path + '.replacement' }, { sha256: '0'.repeat(64) }, { bytes: 0 }])
      assert.throws(() => assertLinuxSystemElfIdentity(role, { ...input, ...change }), /unapproved/);
    assert.throws(() => { input.sha256 = 'changed'; }, TypeError);
  }
  assert.throws(() => measureLinuxSystemElf('arbitrary'), /unregistered/);
  assert.throws(() => measureLinuxSystemElf('owner', {}), /unregistered/);
  assert.throws(() => linuxElfClosure([{ needed: ['libunregistered.so'], interpreter: null }], actual.images), /unresolved/);
  assert.throws(() => linuxElfClosure([{ needed: [], interpreter: '/other/loader' }], actual.images), /unsupported/);
  const noFfi = { ...actual.images }; delete noFfi.ffi;
  assert.throws(() => linuxElfClosure([{ needed: ['libffi.so.8'], interpreter: null }], noFfi), /unresolved/);
});

test('real native addons disclose extra ELF dependencies without registering arbitrary addons', linux, () => {
  const system = measureLinuxSystemElf('owner');
  for (const name of ['@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node', '@electron-internal/extract-zip/index.linux-x64-gnu.node']) {
    const file = fs.realpathSync(path.join(app, 'node_modules', name));
    const image = inspectLinuxElf(file);
    assert.equal(image.interpreter, null);
    const closure = linuxElfClosure([image], system.images);
    assert.ok(closure.includes('gcc'));
    if (name.startsWith('@rollup/')) {
      assert.ok(closure.includes('rt'));
      const initialOnly = { ...system.images }; delete initialOnly.rt;
      assert.throws(() => linuxElfClosure([image], initialOnly), /unresolved.*librt/);
    }
  }
});

test('malformed ELF headers, search paths, symlinks and parsing-generation substitutions refuse', linux, t => {
  const f = fixture(t), file = path.join(f.cwd, 'library.so');
  const original = fs.readFileSync('/usr/lib/x86_64-linux-gnu/libdl.so.2');
  const valid = () => fs.writeFileSync(file, original);
  valid(); assert.deepEqual(inspectLinuxElf(file).needed, ['libc.so.6']);
  for (const mutate of [bytes => { bytes[4] = 1; }, bytes => { bytes.writeUInt16LE(3, 18); }, bytes => { bytes.writeUInt16LE(0xffff, 56); }]) {
    const changed = Buffer.from(original); mutate(changed); fs.writeFileSync(file, changed);
    assert.throws(() => inspectLinuxElf(file), /ELF/);
  }
  const searchPath = Buffer.from(original), phoff = Number(searchPath.readBigUInt64LE(32));
  let dynamic;
  for (let n = 0; n < searchPath.readUInt16LE(56); n++) {
    const at = phoff + n * 56;
    if (searchPath.readUInt32LE(at) === 2) dynamic = Number(searchPath.readBigUInt64LE(at + 8));
  }
  assert.ok(dynamic); searchPath.writeBigUInt64LE(29n, dynamic); fs.writeFileSync(file, searchPath);
  assert.throws(() => inspectLinuxElf(file), /search paths/);
  valid(); const link = path.join(f.cwd, 'linked.so'); fs.symlinkSync(file, link);
  assert.throws(() => inspectLinuxElf(link), /reparse|symbolic|link/i);
  const read = fs.readSync;
  let changed = false;
  fs.readSync = function(fd, buffer, offset, length, position) {
    const result = read.call(this, fd, buffer, offset, length, position);
    if (!changed && length === 64 && position === 0 && fs.readlinkSync(`/proc/self/fd/${fd}`) === file) {
      changed = true;
      const writable = fs.openSync(file, 'r+');
      try { fs.writeSync(writable, Buffer.from([original.at(-1) ^ 1]), 0, 1, original.length - 1); fs.writeSync(writable, original.subarray(-1), 0, 1, original.length - 1); }
      finally { fs.closeSync(writable); }
    }
    return result;
  };
  try { assert.throws(() => inspectLinuxElf(file), /changed while parsing/); }
  finally { fs.readSync = read; }
  assert.equal(changed, true); assert.equal(digest(fs.readFileSync(file)), digest(original), 'same final bytes do not erase mutation');
});

test('direct retained execution preserves Node child/fork and real native addon loading', linux, async t => {
  const f = fixture(t), source = path.join(f.cwd, 'checker.cjs');
  const addon = fs.realpathSync(path.join(app, 'node_modules/@rollup/rollup-linux-x64-gnu/rollup.linux-x64-gnu.node'));
  fs.writeFileSync(source, `const fs=require('node:fs'),cp=require('node:child_process');
if(process.argv[2]==='fork-child'){process.send({execPath:process.execPath,argv:process.argv.slice(2)});process.disconnect();}
else{const spawned=cp.spawnSync(process.execPath,['-e','process.stdout.write(process.execPath)'],{encoding:'utf8'});
require(${JSON.stringify(addon)});let forked;const child=cp.fork(__filename,['fork-child'],{silent:true});
child.on('message',value=>forked=value);child.on('exit',code=>process.stdout.write(JSON.stringify({execPath:process.execPath,
spawned:{status:spawned.status,stdout:spawned.stdout,stderr:spawned.stderr},forked,forkExit:code,
nodeMaps:fs.readFileSync('/proc/self/maps','utf8'),ownerMaps:fs.readFileSync('/proc/'+process.ppid+'/maps','utf8')})));}
`);
  const result = await runOwnedJob({ command: process.execPath, args: [source], cwd: f.cwd, evidenceRoot: f.evidenceRoot, timeoutMs: 10000 });
  assert.equal(result.complete, true); assert.equal(result.exitCode, 0); assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.hadRemainingChildren, false);
  const raw = fs.readFileSync(result.stdout.path); assert.equal(digest(raw), result.stdout.sha256);
  const actual = JSON.parse(raw);
  assert.equal(actual.execPath, process.execPath); assert.equal(actual.spawned.status, 0);
  assert.equal(actual.spawned.stdout, process.execPath); assert.equal(actual.spawned.stderr, '');
  assert.equal(actual.forked.execPath, process.execPath); assert.equal(actual.forkExit, 0);
  const names = value => [...new Set(value.split('\n').filter(line => line.includes('/')).map(line => line.trim().split(/\s+/).at(-1)))];
  const nodeMaps = names(actual.nodeMaps), ownerMaps = names(actual.ownerMaps);
  assert.ok(nodeMaps.includes(addon)); assert.ok(nodeMaps.includes(result.transport.toolchain.elf.inputs.rt.path));
  assert.ok(ownerMaps.includes(result.transport.toolchain.elf.roots.ctypes.path));
  assert.ok(ownerMaps.includes(result.transport.toolchain.elf.roots.json.path));
  const allowed = new Set([...Object.values(result.transport.toolchain.elf.inputs),
    ...Object.values(result.transport.toolchain.elf.runtimeData),
    ...Object.values(result.transport.toolchain.elf.roots)].map(input => input.path));
  allowed.add(addon);
  for (const mapped of [...nodeMaps, ...ownerMaps])
    assert.ok(allowed.has(mapped), `unmeasured actual system mapping ${mapped}`);
  assert.equal(result.nativeOwnerLaunch.descriptor, 10);
});

test('same-byte executable rename during a real owned execution invalidates its retained generation', linux, t => {
  const f = fixture(t), executable = path.join(f.root, 'node'), ready = path.join(f.cwd, 'ready');
  // Only this disposable copy is renamed. The maintained runtime is untouched.
  fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_FICLONE); fs.chmodSync(executable, 0o755);
  const module = new URL('../lib/transport/owned-job.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs';import assert from 'node:assert/strict';import {runOwnedJob} from ${JSON.stringify(module)};
const ready=${JSON.stringify(ready)},executable=process.execPath;
const running=runOwnedJob({command:executable,args:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},350)`)}],cwd:${JSON.stringify(f.cwd)},evidenceRoot:${JSON.stringify(f.evidenceRoot)},timeoutMs:5000});
const observed=running.then(()=>({passed:true}),error=>({passed:false,message:error.message,cleanupUnconfirmed:error.cleanupUnconfirmed===true}));
const deadline=Date.now()+15000;while(!fs.existsSync(ready)){if(Date.now()>deadline)throw Error('fixture start timeout');await new Promise(r=>setTimeout(r,5));}
fs.renameSync(executable,executable+'.held');fs.renameSync(executable+'.held',executable);
const result=await observed;assert.equal(result.passed,false);assert.match(result.message,/changed during execution/);assert.equal(result.cleanupUnconfirmed,false);
const next=await runOwnedJob({command:executable,args:['-e','process.exitCode=0'],cwd:${JSON.stringify(f.cwd)},evidenceRoot:${JSON.stringify(f.evidenceRoot)},timeoutMs:5000});
assert.equal(next.complete,true);assert.equal(next.cleanupConfirmed,true);result.followupCompleted=true;
process.stdout.write(JSON.stringify(result));`;
  const actual = spawnSync(executable, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, TMPDIR: os.tmpdir() } });
  assert.equal(actual.status, 0, actual.stderr); assert.equal(JSON.parse(actual.stdout).passed, false);
  assert.equal(JSON.parse(actual.stdout).followupCompleted, true);
  assert.deepEqual(measureFile(executable), measureFile(process.execPath));
});
