import fs from 'node:fs';
import path from 'node:path';
import { blocked, contains, plainPath, relativeName, readJson, measureFile, digestRecord, ENTRY_LIMIT } from './artifact-files.mjs';

const packageName = value => {
  if (typeof value !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(value)) blocked('invalid dependency package name');
  return relativeName(value);
};

function optionalDirectory(file) {
  try { return plainPath(file, { kind: 'directory' }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Mirror the reviewed license checker's production-instance resolution, but stop at the
// explicit source boundary BEFORE spawning it. No missing transitive dependency
// is allowed to cause its legacy upward lookup to inspect another source tree.
// Only metadata/license inputs are read here; dependency JavaScript never runs.
export function measureLicenseDependencyInputs(sourceRoot) {
  sourceRoot = plainPath(sourceRoot, { kind: 'directory' });
  const rootPackage = readJson(path.join(sourceRoot, 'package.json'));
  const lock = readJson(path.join(sourceRoot, 'package-lock.json'));
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') blocked('a package-lock with concrete installed package entries is required');
  const inputs = {}, packages = {}, queue = [];
  function remember(file) {
    const name = relativeName(path.relative(sourceRoot, file));
    inputs[name] = measureFile(file);
  }
  remember(path.join(sourceRoot, 'package.json')); remember(path.join(sourceRoot, 'package-lock.json'));
  function dependencies(pkg, from) {
    const declared = pkg.dependencies || {};
    if (typeof declared !== 'object' || Array.isArray(declared)) blocked('invalid production dependencies');
    for (const name of Object.keys(declared)) queue.push({ name: packageName(name), from });
  }
  dependencies(rootPackage, sourceRoot);
  if (!queue.length) blocked('production dependency closure is empty');
  function resolve(from, name) {
    for (let directory = from; contains(sourceRoot, directory); directory = path.dirname(directory)) {
      const found = optionalDirectory(path.join(directory, 'node_modules', name));
      if (found) return found;
      if (directory === sourceRoot) break;
    }
    blocked(`declared production dependency is absent inside the explicit source: ${name}`);
  }
  while (queue.length) {
    if (Object.keys(packages).length + queue.length > ENTRY_LIMIT) blocked('production dependency closure exceeds its budget');
    const { name, from } = queue.pop(), directory = resolve(from, name);
    const relative = relativeName(path.relative(sourceRoot, directory));
    if (packages[relative]) continue;
    const file = path.join(directory, 'package.json'), pkg = readJson(file), expected = lock.packages[relative];
    if (pkg.name !== name || typeof pkg.version !== 'string' || !expected || expected.link || expected.version !== pkg.version) blocked('installed dependency identity/version differs from the candidate lockfile');
    remember(file);
    packages[relative] = { name, version: pkg.version };
    // The scanner enumerates only license-like names and reads their contents.
    // Refuse a link before that read; no recursive dependency/code scan needed.
    for (const child of fs.readdirSync(directory).sort()) if (/^(LICEN[CS]E|COPYING)/i.test(child)) {
      const license = plainPath(path.join(directory, relativeName(child)));
      if (fs.lstatSync(license).isFile()) remember(license);
    }
    dependencies(pkg, directory);
  }
  // check-license-notices.mjs retains each resolved directory (2b36a900), so
  // nested production versions keep their own notices. Re-resolving names from
  // the root would instead select unrelated hoisted development copies.
  const sorted = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)));
  return { sha256: digestRecord(sorted), bytes: Object.values(sorted).reduce((sum, item) => sum + item.bytes, 0), packages, inputs: sorted };
}
