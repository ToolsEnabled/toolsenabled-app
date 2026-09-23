import path from 'node:path';
import { blocked, readBounded, readJson, measureFile, measureTree, assertSameTree, digestRecord } from './artifact-files.mjs';
import { verifyStaticModuleClosure } from './artifact-layout.mjs';
import { measureStandalonePrivacy } from './artifact-privacy.mjs';

// Fixed source-controlled packaging requirements, not a caller policy file.
// The product owner supplies the actual grant in each source LICENSE. This
// checker does not invent a grant, replace a legal review, or treat "private"
// package metadata as permission to omit delivered license terms.
export const STANDALONE_INTEGRITY_POLICY = Object.freeze({
  schemaVersion: 1,
  products: Object.freeze(['scribe', 'web-editor', 'presentation-suite']),
  licensedRoots: Object.freeze(['app', 'shared', 'shell']),
  electronVersion: '43.3.0',
  runtimeNotices: Object.freeze(['runtime/electron/LICENSE', 'runtime/electron/LICENSES.chromium.html']),
  privatePatternInput: 'private/owner-data-patterns.owner.json',
});

const same = (a, b) => a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
function declaredLicense(pkg) {
  if (typeof pkg.license !== 'string' || !pkg.license.trim() || pkg.license.length > 256 || /^(?:UNLICENSED|NONE|NOASSERTION)$/i.test(pkg.license.trim())) blocked('standalone package has no declared distributable license; the owner must supply its actual grant');
  return pkg.license.trim();
}
function licenseText(file) {
  const text = readBounded(file, 2 * 1024 * 1024).toString('utf8').trim();
  if (text.length < 100 || !/copyright/i.test(text) || !/(?:permission|license|licence|redistribution|rights reserved)/i.test(text)) blocked('standalone delivered license notice is empty/incomplete');
  return measureFile(file);
}

export async function measureStandaloneIntegrity({ product, sourceRoot, stageRoot, expectedStage, signal }) {
  if (!STANDALONE_INTEGRITY_POLICY.products.includes(product)) blocked('no standalone integrity policy for this product');
  if (signal?.aborted) throw new Error('standalone integrity verification cancelled');
  const stage = measureTree(stageRoot);
  if (expectedStage) assertSameTree(expectedStage, stage);
  const licenses = {}, packages = {};
  for (const root of STANDALONE_INTEGRITY_POLICY.licensedRoots) {
    const from = path.join(sourceRoot, 'software', root === 'app' ? product : root);
    const sourcePackage = readJson(path.join(from, 'package.json')), installed = readJson(path.join(stageRoot, root, 'package.json'));
    const license = declaredLicense(sourcePackage);
    if (declaredLicense(installed) !== license || !same(measureFile(path.join(from, 'package.json')), stage.files[`${root}/package.json`])) blocked('standalone license/package declaration differs from measured source');
    const original = licenseText(path.join(from, 'LICENSE'));
    if (!same(original, stage.files[`${root}/LICENSE`])) blocked('source license text did not reach the exact standalone artifact');
    licenses[`${root}/LICENSE`] = original;
  }
  for (const [name, identity] of Object.entries(stage.files)) {
    if (!name.endsWith('/package.json') || name.startsWith('runtime/')) continue;
    const pkg = readJson(path.join(stageRoot, name));
    packages[name] = { ...identity, license: declaredLicense(pkg) };
    // Current standalone packaging excludes node_modules entirely. A new
    // runtime dependency must gain real staged closure/license support, not a
    // metadata exception that manufactures proof for missing package bytes.
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (pkg[field] !== undefined && (!pkg[field] || typeof pkg[field] !== 'object' || Array.isArray(pkg[field]) || Object.keys(pkg[field]).length)) blocked('standalone declares external runtime dependencies without a reviewed staged closure');
    }
    const folder = path.posix.dirname(name), own = `${folder}/LICENSE`;
    const coveringRoot = STANDALONE_INTEGRITY_POLICY.licensedRoots.find(root => name.startsWith(`${root}/`));
    if (!coveringRoot) blocked('standalone package lies outside the licensed source roots');
    if (stage.files[own]) licenses[own] = licenseText(path.join(stageRoot, own));
    else if (packages[name].license !== readJson(path.join(stageRoot, coveringRoot, 'package.json')).license.trim()) blocked('nested standalone package declares different terms without its own delivered license');
  }
  const runtime = {};
  for (const name of STANDALONE_INTEGRITY_POLICY.runtimeNotices) {
    const bytes = readBounded(path.join(stageRoot, name), 32 * 1024 * 1024);
    const text = bytes.toString('utf8');
    if (bytes.length < 100 || !/copyright/i.test(text) || !/(?:permission|license|redistribution)/i.test(text)) blocked('bundled Electron notices are absent/incomplete');
    if (name.endsWith('.html') && !/<html\b|<!doctype html/i.test(text)) blocked('bundled Chromium notice index is not the delivered HTML document');
    runtime[name] = measureFile(path.join(stageRoot, name));
  }
  if (readBounded(path.join(stageRoot, 'runtime', 'electron', 'version'), 128).toString('utf8').trim() !== STANDALONE_INTEGRITY_POLICY.electronVersion) blocked('standalone bundled runtime version differs from its fixed license/closure policy');
  const closure = verifyStaticModuleClosure(stageRoot, ['app', 'shared', 'shell']);
  const privacy = await measureStandalonePrivacy({ sourceRoot, stageRoot, expectedStage: stage, signal });
  assertSameTree(stage, measureTree(stageRoot));
  return { policySha256: digestRecord(STANDALONE_INTEGRITY_POLICY), licenses, packages, runtime, closure, privacy };
}
