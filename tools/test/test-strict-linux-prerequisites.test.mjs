import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../test-strict.mjs', import.meta.url));
const linux = { skip: process.platform !== 'linux' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-linux-prerequisites-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = path.join(root, 'engine');
  fs.mkdirSync(canonical, { mode: 0o700 });
  fs.writeFileSync(path.join(canonical, 'package.json'), '{}');
  return { root, canonical };
}
function invoke(canonical, scratch, environment = {}, nodeArguments = []) {
  const run = spawnSync(process.execPath, [...nodeArguments, script, '--canonical-root', canonical,
    ...(scratch ? ['--scratch', scratch] : [])], {
    env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /NOTHING WAS MEASURED/);
  return run;
}

for (const mode of [0o775, 0o777, 0o1777]) {
  test(`strict release refuses a mutable Linux scratch ancestor (${mode.toString(8)}) before mutation`, linux, t => {
    const { root, canonical } = fixture(t);
    const ancestor = path.join(root, 'mutable');
    fs.mkdirSync(ancestor, { mode });
    fs.chmodSync(ancestor, mode);
    const scratch = path.join(ancestor, 'owned-scratch');
    const run = invoke(canonical, scratch);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /REFUSED SCRATCH_ANCESTOR_UNSAFE/);
    assert.ok(run.stderr.includes(`${ancestor} has uid ${process.getuid()} and mode 0${mode.toString(8)}`));
    assert.equal(fs.existsSync(scratch), false);
    assert.equal(fs.statSync(ancestor).mode & 0o7777, mode);
    assert.deepEqual(fs.readdirSync(ancestor), []);
  });
}

test('strict release refuses a linked ancestor without visiting or changing its target', linux, t => {
  const { root, canonical } = fixture(t);
  const target = path.join(root, 'target'), link = path.join(root, 'link');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, link, 'dir');
  const run = invoke(canonical, path.join(link, 'scratch'));
  assert.match(run.stderr, /REFUSED SCRATCH_ANCESTOR_UNSAFE/);
  assert.ok(run.stderr.includes(`${link} is not a regular directory without symbolic links`));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.statSync(target).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('strict release refuses a non-directory ancestor before creating scratch', linux, t => {
  const { root, canonical } = fixture(t);
  const file = path.join(root, 'ordinary-file');
  fs.writeFileSync(file, 'disposable fixture');
  const run = invoke(canonical, path.join(file, 'scratch'));
  assert.match(run.stderr, /REFUSED SCRATCH_ANCESTOR_UNSAFE/);
  assert.ok(run.stderr.includes(file));
  assert.equal(fs.readFileSync(file, 'utf8'), 'disposable fixture');
});

test('strict release refuses a foreign-owner stat result even when its mode is private', linux, t => {
  const { root, canonical } = fixture(t);
  const ancestor = path.join(root, 'foreign-owner-stat');
  fs.mkdirSync(ancestor, { mode: 0o700 });
  // Creating another account's directory would require privilege. Model only
  // that one lstat field in the CLI child; every path and mode is still real.
  const preload = path.join(root, 'foreign-owner-stat.mjs');
  const otherUid = process.getuid() + 1;
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.lstatSync;
fs.lstatSync = function (file, ...args) {
  const result = original.call(this, file, ...args);
  if (file === ${JSON.stringify(ancestor)}) result.uid = ${otherUid};
  return result;
};
syncBuiltinESMExports();
`);
  const run = invoke(canonical, path.join(ancestor, 'scratch'), {}, ['--import', preload]);
  assert.match(run.stderr, /REFUSED SCRATCH_ANCESTOR_UNSAFE/);
  assert.ok(run.stderr.includes(`${ancestor} has uid ${otherUid} and mode 0700`));
  assert.equal(fs.statSync(ancestor).uid, process.getuid());
  assert.deepEqual(fs.readdirSync(ancestor), []);
});

test('strict release checks inherited TMPDIR before creating its default scratch', linux, t => {
  const { root, canonical } = fixture(t);
  const ancestor = path.join(root, 'mutable-default');
  fs.mkdirSync(ancestor); fs.chmodSync(ancestor, 0o775);
  const run = invoke(canonical, null, { TMPDIR: ancestor });
  assert.match(run.stderr, /REFUSED SCRATCH_ANCESTOR_UNSAFE/);
  assert.ok(run.stderr.includes(ancestor));
  assert.deepEqual(fs.readdirSync(ancestor), []);
});

test('strict release preserves the native root-owned sticky ancestor exception', linux, t => {
  const { root, canonical } = fixture(t);
  const ancestor = path.join(root, 'root-sticky-stat');
  fs.mkdirSync(ancestor, { mode: 0o700 });
  // Model root ownership without elevation or changing a shared directory.
  const preload = path.join(root, 'root-sticky-stat.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.lstatSync;
fs.lstatSync = function (file, ...args) {
  const result = original.call(this, file, ...args);
  if (file === ${JSON.stringify(ancestor)}) { result.uid = 0; result.mode = (result.mode & ~0o7777) | 0o1777; }
  return result;
};
syncBuiltinESMExports();
`);
  const run = invoke(canonical, path.join(ancestor, 'scratch'), {}, ['--import', preload]);
  assert.doesNotMatch(run.stderr, /SCRATCH_ANCESTOR_UNSAFE/);
  assert.match(run.stderr, /REFUSED (NO_DEPENDENCIES|CANONICAL_ROOT_HEAD_UNRESOLVED)/);
  assert.equal(fs.statSync(ancestor).uid, process.getuid());
  assert.equal(fs.statSync(ancestor).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(ancestor), []);
});

test('a trusted Linux ancestor chain reaches the next real prerequisite with no release measurement', linux, t => {
  const { root, canonical } = fixture(t);
  // Include an absent intermediate directory: the runner may create its own
  // private directories after prerequisites pass, without altering ancestors.
  const scratch = path.join(root, 'new-parent', 'scratch');
  const run = invoke(canonical, scratch);
  assert.doesNotMatch(run.stderr, /SCRATCH_ANCESTOR_UNSAFE/);
  assert.match(run.stderr, /REFUSED (NO_DEPENDENCIES|CANONICAL_ROOT_HEAD_UNRESOLVED)/);
  assert.equal(fs.existsSync(path.dirname(scratch)), false);
});
