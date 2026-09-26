import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runOwnedJob, runOwnedJobBatch, registeredToolEnvironment, measureRegisteredToolchain,
  createInertExecutionScopeFixture } from '../lib/transport/owned-job.mjs';
import { linuxToolPaths, assertLinuxToolIdentity } from '../lib/transport/linux-toolchain.mjs';
import { getReadinessContract, LINUX_READINESS_TARGET } from '../lib/release-readiness.mjs';
import ownerModule from '../../shell/owned-claim-process.cjs';

const linux = { skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 60000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
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

test('old shared-owner receipt shape stays compatible while new native facts are additive', linux, async t => {
  const f = fixture(t);
  const owner = ownerModule.spawnOwnedClaim({ spawn, command: process.execPath, args: ['-e', 'process.exitCode=0'],
    payloadRoot: f.cwd, stateRoot: f.cwd, environment: { PATH: '/usr/bin' } });
  owner.child.stdout.resume(); owner.child.stderr.resume(); t.after(() => owner.cancel());
  const actual = await owner.completion;
  assert.deepEqual(actual, { quiescent: true, started: true, exitedNormally: true, exitCode: 0, hadRemainingChildren: false });
});
