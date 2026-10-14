import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { runOwnedJob, runOwnedJobBatch, registeredToolEnvironment, measureRegisteredToolchain,
  createInertExecutionScopeFixture } from '../lib/transport/owned-job.mjs';
import { linuxToolPaths, assertLinuxToolIdentity } from '../lib/transport/linux-toolchain.mjs';
import { getReadinessContract, LINUX_READINESS_TARGET } from '../lib/release-readiness.mjs';
import ownerModule from '../../shell/owned-claim-process.cjs';
import { RELEASE_SKIP_REGISTER, skipEntryAppliesOnPlatform } from '../lib/test-suite-result.mjs';

const linux = { skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 60000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const existingInertCases = new Set([
  'the shared durable admission rejects competition and retains unresolved cleanup across objects',
  'shared Linux admission refuses a writable scope or mutable ancestor before acquiring a ledger',
]);
// These named cases exercise only disposable ledgers and module bytes. An
// accidental production-state access or spawn fails; it is never redirected.
test.beforeEach(t => {
  if (!t.name.startsWith('T2086 inert ') && !existingInertCases.has(t.name)) return;
  const blockedRoots = [path.join(os.userInfo().homedir, '.local', 'state', 'ToolsEnabledQualification'),
    path.join(os.userInfo().homedir, 'AppData', 'Local', 'ToolsEnabledQualification')].map(value => path.resolve(value));
  const attempts = [], restores = [];
  const refuse = operation => {
    attempts.push(operation);
    throw new Error(`T2086_INERT_ONLY_TRIPWIRE: ${operation}`);
  };
  const protectedPath = value => {
    if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) return false;
    const selected = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
    return blockedRoots.some(root => selected === root || selected.startsWith(root + path.sep));
  };
  const protect = (object, name, check) => {
    const original = object[name];
    if (typeof original !== 'function') return;
    object[name] = function (...args) {
      if (check(args)) refuse(name);
      return original.apply(this, args);
    };
    restores.push(() => { object[name] = original; });
  };
  for (const name of ['open', 'readFile', 'writeFile', 'appendFile', 'lstat', 'stat', 'mkdir', 'rm',
    'unlink', 'rename', 'copyFile', 'chmod', 'realpath', 'access', 'exists']) {
    protect(fs, name + 'Sync', args => args.some(protectedPath));
    protect(fs.promises, name, args => args.some(protectedPath));
  }
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    protect(childProcess, name, () => true);
  syncBuiltinESMExports();
  t.after(() => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
    assert.deepEqual(attempts, [], 'inert cases must never reach production state or a process launcher');
  });
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qualification-job-test-linux-'));
  fs.chmodSync(root, 0o700);
  for (const name of ['work', 'evidence']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd: path.join(root, 'work'), evidenceRoot: path.join(root, 'evidence') };
}
const job = (f, source, extra = {}) => ({ command: process.execPath, args: ['-e', source], cwd: f.cwd, timeoutMs: 5000, ...extra });
function raw(result, name) {
  const bytes = fs.readFileSync(result[name].path);
  assert.equal(bytes.length, result[name].bytes); assert.equal(digest(bytes), result[name].sha256);
  return bytes;
}

test('real Linux qualification captures binary stdout/stderr from the retained executable', linux, async t => {
  const f = fixture(t);
  const actual = await runOwnedJob({ ...job(f, 'process.stdout.write(Buffer.from([0,255,226,130,172]));process.stderr.write("stderr")'), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.complete, true); assert.equal(actual.exitCode, 0);
  assert.equal(actual.cleanupConfirmed, true); assert.equal(actual.hadRemainingChildren, false);
  assert.deepEqual(raw(actual, 'stdout'), Buffer.from([0, 255, 226, 130, 172]));
  assert.equal(raw(actual, 'stderr').toString(), 'stderr');
  assert.equal(fs.statSync(actual.record.path).mode & 0o777, 0o600);
  assert.equal(actual.transport.toolchain.nativeOwner.helper.sha256.length, 64);
  assert.equal(JSON.parse(fs.readFileSync(actual.nativeResult.path)).hadRemainingChildren, false);
});

test('real nonzero command stops a batch and records the later command as not run', linux, async t => {
  const f = fixture(t), forbidden = path.join(f.cwd, 'must-not-run');
  const actual = await runOwnedJobBatch({ evidenceRoot: f.evidenceRoot, jobs: [job(f, 'process.exitCode=7'),
    job(f, `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'wrong')`)] });
  assert.equal(actual[0].complete, true); assert.equal(actual[0].exitCode, 7);
  assert.equal(actual[1].complete, false); assert.equal(actual[1].notRun, true);
  assert.equal(actual[1].cleanupConfirmed, true); assert.equal(actual[1].exitCode, null);
  assert.equal(fs.existsSync(forbidden), false);
});

test('mutating caller arguments after admission cannot change a later real command', linux, async t => {
  const f = fixture(t), args = ['-e', 'process.stdout.write("SELECTED")'];
  const running = runOwnedJobBatch({ evidenceRoot: f.evidenceRoot, jobs: [job(f, 'process.exitCode=0'), job(f, '', { args })] });
  args[1] = 'process.stdout.write("SUBSTITUTED")';
  const actual = await running;
  assert.equal(actual[1].complete, true); assert.equal(raw(actual[1], 'stdout').toString(), 'SELECTED');
  const spec = JSON.parse(fs.readFileSync(actual[1].launchSpec.path));
  assert.deepEqual(actual[1].command.slice(1), spec.jobs[1].args);
});

test('the native owner executes captured reviewed bytes despite a stale CommonJS cache entry', linux, async t => {
  const f = fixture(t), original = ownerModule.spawnOwnedClaim;
  ownerModule.spawnOwnedClaim = () => { throw new Error('inert stale require cache'); };
  t.after(() => { ownerModule.spawnOwnedClaim = original; });
  const actual = await runOwnedJob({ ...job(f, 'process.stdout.write("captured owner")'), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.complete, true); assert.equal(raw(actual, 'stdout').toString(), 'captured owner');
});

test('a real detached leftover is reaped but never qualifies a zero-exit root', linux, async t => {
  const f = fixture(t), source = path.join(f.cwd, 'descendant.cjs'), heartbeat = path.join(f.cwd, 'heartbeat');
  fs.writeFileSync(source, `const fs=require('node:fs');
if(process.argv[2]==='child'){
  process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(heartbeat)},'ready');process.send('ready');
  setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);
}else{
  const child=require('node:child_process').spawn(process.execPath,[__filename,'child'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  child.once('message',()=>{process.stdout.write('root passed');process.exit(0)});
}
`);
  const actual = await runOwnedJob({ ...job(f, '', { args: [source] }), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.exitCode, 0); assert.equal(actual.complete, false);
  assert.equal(actual.cleanupConfirmed, true); assert.equal(actual.hadRemainingChildren, true);
  assert.match(actual.error, /left descendants/);
  const final = fs.readFileSync(heartbeat);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.deepEqual(fs.readFileSync(heartbeat), final);
});

test('a descendant that works and exits after root death cannot disappear between native polls', linux, async t => {
  const f = fixture(t), source = path.join(f.cwd, 'short-lived-descendant.cjs');
  fs.writeFileSync(source, `if(process.argv[2]==='child'){
  const parent=Number(process.argv[3]);process.send('ready');
  const check=()=>{if(process.ppid===parent){setImmediate(check);return}
    process.stdout.write('DESCENDANT_WORK_AFTER_ROOT_EXIT',()=>process.exit(0));};check();
}else{
  const child=require('node:child_process').spawn(process.execPath,[__filename,'child',String(process.pid)],
    {detached:true,stdio:['ignore','inherit','inherit','ipc']});
  child.once('message',()=>process.exit(0));
}
`);
  const actual = await runOwnedJob({ ...job(f, '', { args: [source] }), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.exitCode, 0); assert.equal(actual.cleanupConfirmed, true);
  assert.equal(actual.hadRemainingChildren, true); assert.equal(actual.complete, false);
  // Whether native cleanup wins before this final write or the child exits
  // first, adoption itself must be observed as work left beyond the root.
  const output = raw(actual, 'stdout').toString();
  assert.ok(output === '' || output === 'DESCENDANT_WORK_AFTER_ROOT_EXIT');
});

test('the exact helper counts an already-finished adopted child before emitting its empty-tree receipt', linux, () => {
  // Deterministic kernel-boundary fixture for the scheduling window found by
  // real native review. Execute the entire current supervise() loop; fake only
  // the OS observations. No real fork, PID signal or qualification occurs.
  const helper = fileURLToPath(new URL('../../shell/owned-claim-process-linux.py', import.meta.url));
  const program = `import importlib.util,json,types
spec=importlib.util.spec_from_file_location('owned_fixture',${JSON.stringify(helper)})
owner=importlib.util.module_from_spec(spec);spec.loader.exec_module(owner)
def scenario(children):
    frames=[];reaped=[];signals=[]
    def waitid(kind,fd,flags):
        if kind==0:
            assert sorted(reaped)==sorted(children)
            raise ChildProcessError()
        if flags==4: reaped.append(fd-100)
        return types.SimpleNamespace(si_status=0,si_code=1)
    owner.os=types.SimpleNamespace(P_PIDFD=3,P_ALL=0,WEXITED=4,WNOHANG=1,WNOWAIT=16,CLD_EXITED=1,
        set_blocking=lambda *a:None,read=lambda *a:b'START\\n',fork=lambda:42,
        pidfd_open=lambda pid:pid+100,waitid=waitid,close=lambda *a:None)
    owner.signal=types.SimpleNamespace(SIGTERM=15,SIGINT=2,SIGKILL=9,
        signal=lambda *a:None,pidfd_send_signal=lambda *a:signals.append(a))
    owner.select=types.SimpleNamespace(select=lambda *a:([0],[],[]))
    owner.time=types.SimpleNamespace(monotonic=lambda:1)
    owner.child_snapshot=lambda:children
    owner.receipt=frames.append
    owner.supervise(['/fixture/never-executed'])
    assert not signals
    return frames[-1]
print(json.dumps([scenario([42]),scenario([42,43])]))
`;
  const result = spawnSync('/usr/bin/python3.12', ['-I', '-S', '-B', '-c', program], {
    env: { PATH: '/usr/bin', LANG: 'C.UTF-8' }, timeout: 5000, maxBuffer: 65536, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const [alone, adopted] = JSON.parse(result.stdout);
  assert.equal(alone.quiescent, true); assert.equal(alone.hadRemainingChildren, false);
  assert.equal(adopted.quiescent, true); assert.equal(adopted.exitCode, 0);
  assert.equal(adopted.hadRemainingChildren, true);
});

test('real timeout preserves cleanup proof and refuses the preceding green output', linux, async t => {
  const f = fixture(t);
  const actual = await runOwnedJob({ ...job(f, 'process.on("SIGTERM",()=>{});process.stdout.write("PASS");setInterval(()=>{},1000)', { timeoutMs: 750 }), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.complete, false); assert.equal(actual.timedOut, true);
  assert.equal(actual.cleanupConfirmed, true); assert.equal(raw(actual, 'stdout').toString(), 'PASS');
  assert.equal(actual.limits.cleanupGraceMs, 250);
});

test('real output limit cancels the owner and keeps raw files within the declared bound', linux, async t => {
  const f = fixture(t);
  const actual = await runOwnedJob({ ...job(f, 'process.stdout.write(Buffer.alloc(65536,65));setInterval(()=>{},1000)', { maxOutputBytes: 128 }), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.complete, false); assert.equal(actual.outputLimitExceeded, true);
  assert.equal(actual.cleanupConfirmed, true); assert.ok(actual.stdout.bytes + actual.stderr.bytes <= 128);
});

test('a real command cannot rewrite captured stdout and still publish complete evidence', linux, async t => {
  const f = fixture(t);
  const source = `const fs=require('node:fs'),path=require('node:path');
process.stdout.write('original',()=>setTimeout(()=>{
  const run=fs.readdirSync(${JSON.stringify(f.evidenceRoot)}).find(n=>n.startsWith('owned-job-'));
  fs.writeFileSync(path.join(${JSON.stringify(f.evidenceRoot)},run,'0001','stdout.bin'),'tampered');
},50));`;
  const actual = await runOwnedJob({ ...job(f, source), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.exitCode, 0); assert.equal(actual.cleanupConfirmed, true);
  assert.equal(actual.complete, false); assert.match(actual.error, /raw stream bytes changed/);
  assert.equal(raw(actual, 'stdout').toString(), 'tampered');
});

test('real AbortSignal cancellation confirms ownership cleanup before releasing admission', linux, async t => {
  const f = fixture(t), controller = new AbortController();
  const running = runOwnedJob({ ...job(f, 'setInterval(()=>{},1000)'), evidenceRoot: f.evidenceRoot, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  t.after(() => clearTimeout(timer));
  const actual = await running;
  assert.equal(actual.complete, false); assert.equal(actual.signal, 'ABORT'); assert.equal(actual.cleanupConfirmed, true);
});

test('Linux qualification inherits no ambient loader or Node injection variables', linux, async t => {
  const f = fixture(t);
  const original = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--invalid-inherited-option';
  t.after(() => { if (original === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = original; });
  const actual = await runOwnedJob({ ...job(f, 'process.stdout.write(JSON.stringify([process.env.NODE_OPTIONS,process.env.LD_PRELOAD,process.env.PYTHONPATH]))'), evidenceRoot: f.evidenceRoot });
  assert.equal(actual.complete, true); assert.equal(raw(actual, 'stdout').toString(), '[null,null,null]');
  for (const extra of [{ NODE_OPTIONS: '--inspect' }, { LD_PRELOAD: '/absent' }, { PYTHONPATH: '/absent' },
    { PATH: '/tmp' }, { Path: '/usr/bin' }, { HOME: '/tmp' }, { TMPDIR: '/tmp/other' }]) assert.throws(() => registeredToolEnvironment(extra), /unregistered/);
});

test('Linux tool identities and static-only support cannot be replaced by caller policy', linux, async () => {
  const actual = measureRegisteredToolchain();
  assertLinuxToolIdentity('node', actual.tools.node);
  assert.ok(Object.isFrozen(actual.policy));
  assert.throws(() => { actual.policy.bytes += 1; }, TypeError);
  assert.throws(() => assertLinuxToolIdentity('node', { ...actual.tools.node, sha256: '0'.repeat(64) }), /unapproved/);
  assert.throws(() => assertLinuxToolIdentity('node', { ...actual.tools.node, path: '/tmp/node' }), /unapproved/);
  assert.throws(() => linuxToolPaths({ node: '/tmp/node' }), /no caller/);
  assert.throws(() => measureRegisteredToolchain({ toolchain: actual }), /no caller/);
  const contract = getReadinessContract('toolsenabled', LINUX_READINESS_TARGET);
  assert.ok(contract.subjectMeasurer);
  assert.ok(contract.requirements.find(row => row.id === 'artifact-integrity').adapter);
  await assert.rejects(runOwnedJobBatch({ jobs: [{}], runtimeObservations: true }), /not registered/);
});

test('Linux native grace cannot record a budget the shared owner does not implement', linux, async t => {
  const f = fixture(t);
  await assert.rejects(runOwnedJob({ ...job(f, 'process.exitCode=0', { cleanupGraceMs: 300 }), evidenceRoot: f.evidenceRoot }), /fixed at 250/);
});

test('the shared durable admission rejects competition and retains unresolved cleanup across objects', linux, t => {
  const f = fixture(t);
  const one = createInertExecutionScopeFixture(f.root), two = createInertExecutionScopeFixture(f.root);
  const first = one.acquire({ evidenceRoot: f.evidenceRoot });
  assert.throws(() => two.acquire({ evidenceRoot: f.evidenceRoot }), /no new execution/);
  first.confirmedCleanup();
  const next = two.acquire({ evidenceRoot: f.evidenceRoot });
  const failure = next.quarantine(new Error('inert fixture only; no child launched'));
  assert.equal(failure.cleanupUnconfirmed, true);
  assert.throws(() => one.acquire({ evidenceRoot: f.evidenceRoot }), /no new execution/);
  assert.throws(() => next.confirmedCleanup(), /external cleanup review/);
});

test('shared Linux admission refuses a writable scope or mutable ancestor before acquiring a ledger', linux, t => {
  const f = fixture(t), scope = createInertExecutionScopeFixture(f.root), directory = path.join(f.root, 'inert-admission');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o777);
  assert.throws(() => scope.acquire({ evidenceRoot: f.evidenceRoot }), /private to its owning account/);
  fs.chmodSync(directory, 0o700); fs.chmodSync(f.root, 0o777);
  assert.throws(() => scope.acquire({ evidenceRoot: f.evidenceRoot }), /writable ancestor/);
  fs.chmodSync(f.root, 0o700);
  const exact = scope.acquire({ evidenceRoot: f.evidenceRoot }); exact.confirmedCleanup();
});

test('T2086 inert annotation and closed lease preserve the existing record contract', linux, t => {
  const f = fixture(t), scope = createInertExecutionScopeFixture(f.root);
  const lease = scope.acquire({ evidenceRoot: f.evidenceRoot });
  assert.deepEqual(Object.keys(lease), ['path', 'annotate', 'quarantine', 'confirmedCleanup']);
  assert.equal(Object.isFrozen(lease), true);
  const before = JSON.parse(fs.readFileSync(lease.path));
  assert.equal(before.schema, 'toolsenabled.owned-execution-admission');
  assert.equal(before.schemaVersion, 1); assert.equal(before.state, 'active');
  assert.match(before.id, /^[a-f0-9-]{36}$/);
  assert.equal(fs.statSync(lease.path).mode & 0o777, 0o600);
  lease.annotate({ evidenceDirectory: path.join(f.evidenceRoot, 'synthetic-only') });
  const after = JSON.parse(fs.readFileSync(lease.path));
  assert.equal(after.id, before.id); assert.equal(after.startedAt, before.startedAt);
  assert.equal(after.evidenceDirectory, path.join(f.evidenceRoot, 'synthetic-only'));
  lease.confirmedCleanup();
  assert.equal(fs.existsSync(lease.path), false);
  assert.throws(() => lease.confirmedCleanup(), { code: 'OWNED_EXECUTION_QUARANTINED' });
  const next = scope.acquire({ evidenceRoot: f.evidenceRoot });
  assert.notEqual(JSON.parse(fs.readFileSync(next.path)).id, before.id);
  next.confirmedCleanup();
});

test('T2086 inert same-byte inode replacement cannot be removed by the old lease', linux, t => {
  const f = fixture(t), lease = createInertExecutionScopeFixture(f.root).acquire({ evidenceRoot: f.evidenceRoot });
  const bytes = fs.readFileSync(lease.path), retained = lease.path + '.old';
  fs.renameSync(lease.path, retained);
  fs.writeFileSync(lease.path, bytes, { flag: 'wx', mode: 0o600 });
  assert.notEqual(fs.statSync(retained, { bigint: true }).ino, fs.statSync(lease.path, { bigint: true }).ino);
  assert.throws(() => lease.confirmedCleanup(), { code: 'OWNED_EXECUTION_QUARANTINED' });
  assert.deepEqual(fs.readFileSync(lease.path), bytes);
});

test('T2086 inert changed record bytes cannot be removed by the old lease', linux, t => {
  const f = fixture(t), lease = createInertExecutionScopeFixture(f.root).acquire({ evidenceRoot: f.evidenceRoot });
  const altered = Buffer.from(fs.readFileSync(lease.path, 'utf8') + ' ');
  fs.writeFileSync(lease.path, altered);
  assert.throws(() => lease.confirmedCleanup(), { code: 'OWNED_EXECUTION_QUARANTINED' });
  assert.deepEqual(fs.readFileSync(lease.path), altered);
});

test('T2086 inert admission distinguishes adjacent inode values beyond Number precision', linux, t => {
  const f = fixture(t), ledger = path.join(f.root, 'inert-admission', 'active-or-uncertain.json');
  const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync, inode = 2n ** 54n;
  let replaced = false;
  const identify = (stat, value, options) => {
    Object.defineProperty(stat, 'ino', { value: options?.bigint ? value : Number(value) });
    return stat;
  };
  assert.equal(Number(inode), Number(inode + 1n));
  fs.lstatSync = (file, options) => {
    const stat = originalLstat(file, options);
    return file === ledger ? identify(stat, inode + (replaced ? 1n : 0n), options) : stat;
  };
  fs.fstatSync = (fd, options) => identify(originalFstat(fd, options), inode, options);
  try {
    const lease = createInertExecutionScopeFixture(f.root).acquire({ evidenceRoot: f.evidenceRoot });
    lease.annotate({ fixture: 'stable-inode-control' });
    replaced = true;
    assert.throws(() => lease.confirmedCleanup(), { code: 'OWNED_EXECUTION_QUARANTINED' });
    assert.equal(fs.existsSync(ledger), true);
  } finally { fs.lstatSync = originalLstat; fs.fstatSync = originalFstat; }
});

test('T2086 inert fixture refuses an unrelated temporary directory without creating a ledger', linux, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't2086-unrelated-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => createInertExecutionScopeFixture(directory), /execution-scope fixtures require/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

async function inertFacade(t, changeBeforeLoad) {
  const f = fixture(t), directory = path.join(f.root, 'modules');
  fs.mkdirSync(directory, { mode: 0o700 });
  const names = ['owned-job.mjs', 'owned-job-files.mjs', 'owned-execution-admission.mjs'];
  for (const name of names) fs.copyFileSync(new URL('../lib/transport/' + name, import.meta.url), path.join(directory, name));
  if (changeBeforeLoad) fs.appendFileSync(path.join(directory, changeBeforeLoad), '\n// synthetic byte drift before load\n');
  const context = vm.createContext({ Buffer, process, TextDecoder, URL, setTimeout, clearTimeout });
  const forbidden = () => { throw new Error('T2086 inert module reached a native dependency'); };
  // Execute the actual complete bodies with only import/export syntax removed.
  // This is a synthetic module-wiring fixture, not native execution or an ESM
  // loader proof. compileFunction works under the ordinary registered command.
  function moduleFor(name, bindings) {
    const file = path.join(directory, name);
    const source = fs.readFileSync(file, 'utf8');
    const exports = [...source.matchAll(/^export (?:async )?function (\w+)|^export const (\w+)/gm)]
      .map(match => match[1] || match[2]);
    for (const match of source.matchAll(/^export \{([^}]+)\};/gm))
      exports.push(...match[1].split(',').map(value => value.trim()));
    const body = source.replace(/^import [\s\S]*?;\n/gm, '').replace(/^export \{[^}]+\};\n/gm, '')
      .replace(/^export (?=(?:async )?function |const )/gm, '')
      .replace(/\bimport\.meta\.url/g, JSON.stringify(pathToFileURL(file).href));
    return vm.compileFunction(body + `\nreturn Object.freeze({${exports.join(',')}});`, Object.keys(bindings),
      { parsingContext: context, filename: file })(...Object.values(bindings));
  }
  const files = moduleFor('owned-job-files.mjs', { fs, path, userInfo: os.userInfo, tmpdir: os.tmpdir, createHash });
  const admission = moduleFor('owned-execution-admission.mjs', { fs, path, randomUUID, ...files });
  const facade = moduleFor('owned-job.mjs', { fs, path, mkdir: fs.promises.mkdir, mkdtemp: fs.promises.mkdtemp,
    writeFile: fs.promises.writeFile, spawn: childProcess.spawn,
    createHash, randomUUID, fileURLToPath, isIP, ...files,
    registeredToolPaths: () => ({ powershell: 'inert-never-executed' }), registeredToolSearchPath: forbidden,
    registeredToolchainPolicyIdentity: forbidden, assertRegisteredToolIdentity: forbidden,
    measureLinuxToolchain: forbidden, linuxToolEnvironment: forbidden, runLinuxOwnedJobBatch: forbidden,
    acquireInternalOwnedExecution: admission.acquireOwnedExecution,
    createInertExecutionScopeFixture: admission.createInertExecutionScopeFixture, cleanupError: admission.cleanupError });
  return { directory, exports: facade };
}

for (const name of ['owned-job-files.mjs', 'owned-execution-admission.mjs']) {
  test(`T2086 inert facade rejects changed ${name} before production acquisition`, linux, async t => {
    const actual = await inertFacade(t);
    const before = actual.exports.ownedJobImplementationIdentity();
    const bytes = fs.readFileSync(path.join(actual.directory, 'owned-job.mjs'));
    assert.deepEqual(Object.keys(before), ['path', 'sha256', 'bytes']);
    assert.equal(before.path, path.join(actual.directory, 'owned-job.mjs'));
    assert.equal(before.sha256, digest(bytes)); assert.equal(before.bytes, bytes.length);
    fs.appendFileSync(path.join(actual.directory, name), '\n// synthetic byte drift after load\n');
    assert.throws(() => actual.exports.ownedJobImplementationIdentity(), /loaded owned-job dependency changed/);
    assert.throws(() => actual.exports.acquireOwnedExecution({}), /loaded owned-job dependency changed/);
  });
  test(`T2086 inert facade refuses preloaded drift in ${name}`, linux, async t => {
    await assert.rejects(inertFacade(t, name), /loaded owned-job dependency changed/);
  });
}

test('T2086 inert extracted modules remain in all fixed implementation component lists', linux, () => {
  for (const [file, declaration] of [['source-harness.mjs', 'COMPONENTS'], ['artifact-subject.mjs', 'ARTIFACT_COMPONENTS'],
    ['installed-lifecycle.mjs', 'COMPONENTS']]) {
    const source = fs.readFileSync(new URL('../lib/adapters/' + file, import.meta.url), 'utf8');
    const start = source.indexOf(`const ${declaration} = Object.freeze([`);
    // Evaluate only the actual literal declaration, with no adapter execution.
    const statement = source.slice(start, source.indexOf(';', start) + 1);
    assert.ok(start >= 0 && statement.includes('.sort()'));
    const components = vm.runInNewContext(statement + `\n${declaration}`);
    for (const name of ['transport/owned-job-files.mjs', 'transport/owned-execution-admission.mjs'])
      assert.equal(components.filter(value => value === name).length, 1, `${file}: ${name}`);
  }
});

test('old shared-owner receipt shape stays compatible while new native facts are additive', linux, async t => {
  const f = fixture(t);
  const owner = ownerModule.spawnOwnedClaim({ spawn, command: process.execPath, args: ['-e', 'process.exitCode=0'],
    payloadRoot: f.cwd, stateRoot: f.cwd, environment: { PATH: '/usr/bin' } });
  owner.child.stdout.resume(); owner.child.stderr.resume(); t.after(() => owner.cancel());
  const actual = await owner.completion;
  assert.deepEqual(actual, { quiescent: true, started: true, exitedNormally: true, exitCode: 0, hadRemainingChildren: false });
});

// Portable accounting check; the ten platform fixtures stay unexecuted on
// other systems and are never promoted into Linux runtime evidence.
test('T2086 inert exact platform registrations do not admit unnamed or native-host skips', () => {
  const expected = [
    "T2086 inert annotation and closed lease preserve the existing record contract",
    "T2086 inert same-byte inode replacement cannot be removed by the old lease",
    "T2086 inert changed record bytes cannot be removed by the old lease",
    "T2086 inert admission distinguishes adjacent inode values beyond Number precision",
    "T2086 inert fixture refuses an unrelated temporary directory without creating a ledger",
    "T2086 inert facade rejects changed owned-job-files.mjs before production acquisition",
    "T2086 inert facade refuses preloaded drift in owned-job-files.mjs",
    "T2086 inert facade rejects changed owned-execution-admission.mjs before production acquisition",
    "T2086 inert facade refuses preloaded drift in owned-execution-admission.mjs",
    "T2086 inert extracted modules remain in all fixed implementation component lists"
];
  const entries = RELEASE_SKIP_REGISTER.filter(entry => entry.id.startsWith('linux-owned-job-t2086-'));
  assert.equal(entries.length, 10);
  assert.deepEqual(entries.map(entry => entry.testName).sort(), [...expected].sort());
  for (const entry of entries) {
    assert.equal(RELEASE_SKIP_REGISTER.filter(row => row.testName === entry.testName).length, 1);
    assert.equal(entry.class, 'platform'); assert.equal(entry.requiredPlatform, 'linux');
    assert.deepEqual(entry.stages, ['promotion', 'release']);
    assert.match(entry.reason, /inert.*fixture/);
    assert.equal(skipEntryAppliesOnPlatform(entry, 'win32'), true);
    assert.equal(skipEntryAppliesOnPlatform(entry, 'linux'), false);
  }
  for (const platform of ['win32', 'linux']) {
    const registered = new Map(RELEASE_SKIP_REGISTER
      .filter(entry => entry.stages.includes('release') && skipEntryAppliesOnPlatform(entry, platform))
      .map(entry => [entry.testName, entry]));
    for (const name of expected) assert.equal(registered.has(name), platform === 'win32');
    assert.equal(registered.has('T2086 inert unregistered synthetic fixture'), false);
    assert.equal(registered.has('T2086 inert exact platform registrations do not admit unnamed or native-host skips'), false);
  }
});
