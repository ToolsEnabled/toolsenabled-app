import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { measureLicenseDependencyInputs } from '../lib/adapters/artifact-dependencies.mjs';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';

function fixture(t, { hoistedDevelopment = false } = {}) {
  const parent = ownedFixtureTempRoot();
  const scratch = fs.mkdtempSync(path.join(parent, 'artifact-dependency-closure-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(parent));
    assert.ok(path.basename(scratch).startsWith('artifact-dependency-closure-'));
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const root = path.join(scratch, 'source');
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const packageJson = { name: 'fixture', version: '1.0.0', dependencies: { parent: '1.0.0' },
    ...(hoistedDevelopment ? { devDependencies: { child: '9.0.0' } } : {}) };
  const lock = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: {
    '': packageJson,
    'node_modules/parent': { version: '1.0.0' },
    'node_modules/parent/node_modules/child': { version: '1.0.0' },
    ...(hoistedDevelopment ? { 'node_modules/child': { version: '9.0.0', dev: true } } : {}),
  } };
  write('package.json', packageJson);
  write('package-lock.json', lock);
  write('node_modules/parent/package.json', { name: 'parent', version: '1.0.0', dependencies: { child: '1.0.0' } });
  write('node_modules/parent/LICENSE', 'Parent production notice');
  write('node_modules/parent/node_modules/child/package.json', { name: 'child', version: '1.0.0' });
  write('node_modules/parent/node_modules/child/LICENSE', 'Nested production notice');
  if (hoistedDevelopment) {
    write('node_modules/child/package.json', { name: 'child', version: '9.0.0' });
    write('node_modules/child/LICENSE', 'Unrelated development notice');
  }
  return { root, scratch, write, lock, nested: path.join(root, 'node_modules/parent/node_modules/child') };
}

test('license closure measures nested-only production packages and their own notices', t => {
  const tree = fixture(t);
  const measured = measureLicenseDependencyInputs(tree.root);
  assert.deepEqual(Object.keys(measured.packages).sort(), ['node_modules/parent', 'node_modules/parent/node_modules/child']);
  assert.ok(measured.inputs['node_modules/parent/node_modules/child/package.json']);
  assert.ok(measured.inputs['node_modules/parent/node_modules/child/LICENSE']);
  const before = measured.sha256;
  tree.write('node_modules/parent/node_modules/child/LICENSE', 'Changed nested production notice');
  assert.notEqual(measureLicenseDependencyInputs(tree.root).sha256, before);
});

test('a hoisted development version cannot replace or add to nested production license inputs', t => {
  const tree = fixture(t, { hoistedDevelopment: true });
  const before = measureLicenseDependencyInputs(tree.root);
  assert.equal(before.packages['node_modules/parent/node_modules/child'].version, '1.0.0');
  assert.equal(before.packages['node_modules/child'], undefined);
  assert.equal(before.inputs['node_modules/child/LICENSE'], undefined);
  tree.write('node_modules/child/LICENSE', 'Changed unrelated development notice');
  assert.deepEqual(measureLicenseDependencyInputs(tree.root), before);
});

test('two production versions of one name retain separate package and license identities', t => {
  const tree = fixture(t, { hoistedDevelopment: true });
  const rootPackage = JSON.parse(fs.readFileSync(path.join(tree.root, 'package.json'), 'utf8'));
  delete rootPackage.devDependencies;
  rootPackage.dependencies.child = '9.0.0';
  tree.lock.packages[''] = rootPackage;
  delete tree.lock.packages['node_modules/child'].dev;
  tree.write('package.json', rootPackage);
  tree.write('package-lock.json', tree.lock);
  const measured = measureLicenseDependencyInputs(tree.root);
  assert.equal(measured.packages['node_modules/child'].version, '9.0.0');
  assert.equal(measured.packages['node_modules/parent/node_modules/child'].version, '1.0.0');
  assert.notEqual(measured.inputs['node_modules/child/LICENSE'].sha256,
    measured.inputs['node_modules/parent/node_modules/child/LICENSE'].sha256);
});

test('missing transitive dependencies cannot resolve outside the explicit source', t => {
  const tree = fixture(t);
  fs.unlinkSync(path.join(tree.nested, 'package.json'));
  fs.unlinkSync(path.join(tree.nested, 'LICENSE'));
  fs.rmdirSync(tree.nested);
  const outside = path.join(tree.scratch, 'node_modules', 'child');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'child', version: '1.0.0' }));
  assert.throws(() => measureLicenseDependencyInputs(tree.root), /absent inside the explicit source: child/);
});

test('each resolved production instance must match its exact lockfile version', t => {
  const tree = fixture(t);
  tree.lock.packages['node_modules/parent/node_modules/child'].version = '2.0.0';
  tree.write('package-lock.json', tree.lock);
  assert.throws(() => measureLicenseDependencyInputs(tree.root), /identity\/version differs from the candidate lockfile/);
});

test('a linked dependency is refused before its target can be traversed', t => {
  const tree = fixture(t);
  fs.unlinkSync(path.join(tree.nested, 'package.json'));
  fs.unlinkSync(path.join(tree.nested, 'LICENSE'));
  fs.rmdirSync(tree.nested);
  const outside = path.join(tree.scratch, 'linked-target');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, tree.nested, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => measureLicenseDependencyInputs(tree.root), /linked\/reparse-point input refused/);
});

test('a linked license file cannot become production evidence', t => {
  const tree = fixture(t);
  const license = path.join(tree.nested, 'LICENSE');
  const outside = path.join(tree.scratch, 'outside-notice');
  fs.writeFileSync(outside, 'A different file must not be adopted');
  fs.unlinkSync(license);
  fs.linkSync(outside, license);
  assert.throws(() => measureLicenseDependencyInputs(tree.root), /ordinary permitted-link file/);
});
