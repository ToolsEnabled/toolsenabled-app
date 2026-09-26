import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nativeCleanSourceSnapshot, nativeSourceHead } from '../lib/adapters/artifact-source.mjs';
import { readSourceMetadata } from '../lib/adapters/artifact-source-inputs.mjs';
import { runOwnedJob, runOwnedJobBatch } from '../lib/transport/owned-job.mjs';
import { LINUX_GIT, GIT_SOURCE_OPTIONS, assertLinuxGitInput, assertLinuxGitArguments,
  linuxGitEnvironment, measureLinuxGitToolchain } from '../lib/transport/linux-git-toolchain.mjs';
const linux = { skip: process.platform !== 'linux' || process.arch !== 'x64', timeout: 120000 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { PATH: '/usr/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
function git(root, args) {
  const result = spawnSync('/usr/bin/git', ['-C', root, ...args], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-source-linux-'));
  fs.chmodSync(root, 0o700);
  const cwd = path.join(root, 'repo'), evidenceRoot = path.join(root, 'evidence');
  for (const directory of [cwd, evidenceRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(cwd, ['init', '-q']); git(cwd, ['config', 'user.name', 'Fixture']); git(cwd, ['config', 'user.email', 'fixture@invalid']);
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'source bytes\n');
  fs.writeFileSync(path.join(cwd, 'space and ☃.txt'), Buffer.from([0, 255, 13, 10]));
  git(cwd, ['add', '.']); git(cwd, ['commit', '-qm', 'local fixture']);
  const ref = git(cwd, ['rev-parse', 'HEAD']);
  return { root, cwd, ref, evidenceRoot, options: { target: { platform: 'linux', arch: 'x64' }, evidenceRoot } };
}
const query = (f, tail, extra = {}) => ({ command: LINUX_GIT,
  args: [...GIT_SOURCE_OPTIONS, ...readSourceMetadata(f.cwd).filters, `--work-tree=${f.cwd}`, '-C', f.cwd, ...tail],
  cwd: f.cwd, evidenceRoot: f.evidenceRoot, timeoutMs: 30000, ...extra });

test('real native Git binds exact committed bytes and records the retained ELF dependency closure', linux, async t => {
  const f = fixture(t), actual = await nativeCleanSourceSnapshot(f.cwd, f.ref, f.options);
  assert.equal(actual.ref, f.ref); assert.equal(actual.clean, true);
  assert.deepEqual(Object.keys(actual.files).sort(), ['file.txt', 'space and ☃.txt']);
  for (const [name, record] of Object.entries(actual.files)) {
    const bytes = fs.readFileSync(path.join(f.cwd, name));
    assert.equal(record.sha256, digest(bytes)); assert.equal(record.bytes, bytes.length);
  }
  for (const record of actual.nativeExecution.records) {
    assert.equal(record.complete, true); assert.equal(record.exitCode, 0);
    assert.equal(record.cleanupConfirmed, true); assert.equal(record.hadRemainingChildren, false);
    assert.equal(record.nativeLaunch.descriptorInputs.length, 5);
    assert.equal(record.nativeLaunch.args.includes('--inhibit-cache'), true);
    assert.equal(record.executable.path, '/usr/bin/git');
    assert.equal(digest(fs.readFileSync(record.stdout.path)), record.stdout.sha256);
    assert.equal(record.transport.toolchain.git.inputs.git.sha256, record.executable.sha256);
  }
  assert.equal((await nativeSourceHead(f.cwd, f.options)).ref, f.ref);
});

test('real wrong commit, dirty worktree, hidden index input and committed links refuse', linux, async t => {
  const f = fixture(t);
  await assert.rejects(nativeCleanSourceSnapshot(f.cwd, '1'.repeat(40), f.options), /exact candidate commit/);
  fs.writeFileSync(path.join(f.cwd, 'file.txt'), 'dirty\n');
  await assert.rejects(nativeCleanSourceSnapshot(f.cwd, f.ref, f.options), /dirty source|source bytes differ/);
  git(f.cwd, ['checkout', '--', 'file.txt']);
  git(f.cwd, ['update-index', '--assume-unchanged', 'file.txt']);
  await assert.rejects(nativeCleanSourceSnapshot(f.cwd, f.ref, f.options), /hides or excludes/);
  git(f.cwd, ['update-index', '--no-assume-unchanged', 'file.txt']);
  fs.symlinkSync('file.txt', path.join(f.cwd, 'link'));
  git(f.cwd, ['add', 'link']); git(f.cwd, ['commit', '-qm', 'unsupported linked source']);
  await assert.rejects(nativeCleanSourceSnapshot(f.cwd, git(f.cwd, ['rev-parse', 'HEAD']), f.options), /link\/submodule/);
});

test('metadata links, partial clones and includes refuse before creating native execution evidence', linux, async t => {
  const f = fixture(t), config = path.join(f.cwd, '.git/config'), original = fs.readFileSync(config);
  for (const extra of ['[include]\npath = /never-read\n', '[remote "origin"]\npromisor = true\n']) {
    fs.writeFileSync(config, Buffer.concat([original, Buffer.from(extra)]));
    await assert.rejects(nativeCleanSourceSnapshot(f.cwd, f.ref, f.options), /includes|partial.clone/);
    assert.deepEqual(fs.readdirSync(f.evidenceRoot), []);
  }
  fs.writeFileSync(config, original);
  fs.symlinkSync('/never-read', path.join(f.cwd, '.git/objects/info/alternates'));
  await assert.rejects(nativeSourceHead(f.cwd, f.options), /linked\/reparse/);
  assert.deepEqual(fs.readdirSync(f.evidenceRoot), []);
});

test('native Git independently refuses omitted filter neutralization and never launches the configured helper', linux, async t => {
  const f = fixture(t), marker = path.join(f.root, 'must-not-run');
  git(f.cwd, ['config', 'filter.fixture.clean', `/bin/sh -c 'echo wrong > ${marker}'`]);
  git(f.cwd, ['config', 'filter.fixture.required', 'true']);
  const actual = query(f, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']);
  const omitted = actual.args.filter(arg => !arg.startsWith('filter.fixture.'));
  // Remove the now-empty option pairs, leaving the exact normal prefix.
  omitted.splice(GIT_SOURCE_OPTIONS.length, 4);
  await assert.rejects(runOwnedJob({ ...actual, args: omitted }), /filter neutralization/);
  assert.equal(fs.existsSync(marker), false);
  const result = await runOwnedJob(actual);
  assert.equal(result.complete, true); assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('a repository metadata mutation during an actual query invalidates its receipt with confirmed cleanup', linux, async t => {
  const f = fixture(t), config = path.join(f.cwd, '.git/config');
  const pending = runOwnedJob(query(f, ['rev-parse', '--verify', 'HEAD^{commit}']));
  // Admission/preflight run synchronously; native process completion awaits.
  // Alter actual repo bytes in that window, without a mocked process/result.
  fs.appendFileSync(config, '\n[core]\ndescription = changed during measurement\n');
  const changed = await pending;
  assert.equal(changed.complete, false); assert.equal(changed.cleanupConfirmed, true);
  assert.match(changed.error, /metadata changed/);
  assert.equal(JSON.parse(fs.readFileSync(changed.record.path)).complete, false);
  assert.equal(JSON.parse(fs.readFileSync(changed.nativeResult.path)).quiescent, true);
  const next = await runOwnedJob(query(f, ['rev-parse', '--verify', 'HEAD^{commit}']));
  assert.equal(next.complete, true); assert.equal(next.cleanupConfirmed, true);
});

test('a real file write after the final Git query cannot pass the shared byte snapshot', linux, async t => {
  const f = fixture(t);
  const watcher = spawn(process.execPath, ['-e', `
    const fs=require('node:fs'),path=require('node:path');
    const [root,file]=process.argv.slice(1),deadline=Date.now()+90000;
    const timer=setInterval(()=>{
      let finalIndexes=0;
      for(const name of fs.readdirSync(root).filter(n=>n.startsWith('owned-job-'))){
        try{const spec=JSON.parse(fs.readFileSync(path.join(root,name,'launch-spec.json')));
          if(spec.jobs[0].args.slice(-3).join(' ')==='ls-files -v -z' && fs.existsSync(path.join(root,name,'0001/native-result.json')))finalIndexes++;
        }catch{}
      }
      if(finalIndexes===2){fs.writeFileSync(file,'changed after last query\\n');clearInterval(timer);process.stdout.write('changed');}
      else if(Date.now()>deadline){clearInterval(timer);process.exitCode=2;}
    },2);`, f.evidenceRoot, path.join(f.cwd, 'file.txt')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; watcher.stdout.on('data', data => { output += data; }); watcher.stderr.resume();
  const closed = new Promise(resolve => watcher.once('close', resolve));
  try {
    await assert.rejects(nativeCleanSourceSnapshot(f.cwd, f.ref, f.options), /source file bytes changed during measurement/);
    assert.equal(await closed, 0); assert.equal(output, 'changed');
  } finally { if (watcher.exitCode === null) watcher.kill('SIGTERM'); await closed; }
});

test('Git tool/dependency identities, environment and command roles reject substitutions', linux, async t => {
  const f = fixture(t), tools = measureLinuxGitToolchain();
  for (const [role, identity] of Object.entries(tools.inputs)) {
    assertLinuxGitInput(role, identity);
    assert.throws(() => assertLinuxGitInput(role, { ...identity, sha256: '0'.repeat(64) }), /dependency identity/);
    assert.throws(() => assertLinuxGitInput(role, { ...identity, path: path.join(f.root, path.basename(identity.path)) }), /dependency identity/);
    assert.throws(() => { identity.sha256 = '0'.repeat(64); }, TypeError);
  }
  assert.throws(() => linuxGitEnvironment({ GIT_CONFIG_GLOBAL: '/tmp/foreign' }), /environment overrides/);
  assert.throws(() => assertLinuxGitArguments(['clone', '/tmp/source'], f.cwd), /configuration changed/);
  await assert.rejects(nativeSourceHead(f.cwd, { ...f.options, target: { platform: 'win32', arch: 'x64' } }), /explicit registered/);
  const copy = path.join(f.root, 'git-copy'); fs.copyFileSync(LINUX_GIT, copy); fs.chmodSync(copy, 0o700);
  await assert.rejects(runOwnedJob({ command: copy, args: ['--version'], cwd: f.cwd, evidenceRoot: f.evidenceRoot }), /not a registered/);
});

test('a failed native Git query stops later jobs and preserves its real cleanup evidence', linux, async t => {
  const f = fixture(t);
  const records = await runOwnedJobBatch({ evidenceRoot: f.evidenceRoot, jobs: [
    query(f, ['ls-tree', '-r', '--full-tree', '-z', '1'.repeat(40)]),
    query(f, ['rev-parse', '--verify', 'HEAD^{commit}'])] });
  assert.equal(records[0].complete, true); assert.notEqual(records[0].exitCode, 0);
  assert.equal(records[0].cleanupConfirmed, true); assert.equal(records[0].hadRemainingChildren, false);
  assert.equal(records[1].notRun, true); assert.equal(records[1].complete, false);
});
