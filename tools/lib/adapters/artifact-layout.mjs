import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { blocked, plainPath, relativeName, readBounded, readJson, measureFile, measureTree, readAsar, assertSameTree, digestRecord } from './artifact-files.mjs';
import { measureCapabilityClosure, inComment } from './artifact-capability.mjs';
import { nativeRuntimeTarget, nativeApplicationExecutable, measureNativeRuntime } from './artifact-native-runtime.mjs';

const same = (a, b) => a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
const NATIVE_HELPERS = Object.freeze(['shell/screen-control-native.ps1', 'shell/screen-control-native.py']);
const STANDALONE = {
  scribe: { name: 'ToolsEnabled Scribe', server: 'server.js', portEnv: 'SCRIBE_PORT', startupTimeoutMs: 60000 },
  'web-editor': { name: 'ToolsEnabled Web Studio', server: 'web-server.js', portEnv: 'WEB_EDITOR_PORT', startupTimeoutMs: 45000 },
  'presentation-suite': { name: 'ToolsEnabled Presentation Editor', server: 'server.js', portEnv: 'SUITE_PORT', startupTimeoutMs: 60000 },
};
const STANDALONE_EXCLUDED = new Set(['data', 'worktree', 'test', 'tests', 'example-sources', 'drafts', 'originals',
  'output', '__pycache__', '.pytest_cache', 'node_modules', '.git', 'diagnostics']);
const standaloneIncluded = name => !name.split('/').some(part => STANDALONE_EXCLUDED.has(part) ||
  /^REPORT-.*\.md$/i.test(part) || /\.log$/i.test(part) || /\.test\.(?:js|mjs|cjs|py|ps1)$/i.test(part) ||
  /^test_.*\.(?:js|mjs|py)$/i.test(part) || /^(?:cdp|fixture_docx|isolated_server)\.js$/i.test(part));

function compareFileSets(expected, actual, label) {
  const left = Object.keys(expected).sort(), right = Object.keys(actual).sort();
  if (JSON.stringify(left) !== JSON.stringify(right) || left.some(name => !same(expected[name], actual[name]))) blocked(`${label} file selection/bytes differ from measured source`);
}

function subset(files, prefix) {
  return Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [name.slice(prefix.length), value]));
}

export function verifyStaticModuleClosure(root, relativeRoots) {
  const tree = measureTree(root), builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), 'electron']);
  const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
  let checked = 0;
  for (const name of Object.keys(tree.files)) {
    if (!relativeRoots.some(prefix => name.startsWith(`${prefix}/`)) || !/\.(?:cjs|mjs|js)$/.test(name)) continue;
    const source = readBounded(path.join(root, name)).toString('utf8');
    for (const match of source.matchAll(new RegExp(String.raw`\b(?:require|import)${gap}\(${gap}([^)]*)\)`, 'g'))) {
      if (!inComment(source, match.index) && !new RegExp(String.raw`^(['"])[^'"]+\1${gap}$`).test(match[1].trim())) blocked('computed standalone module dependency has no reviewed declared closure');
    }
    const patterns = [new RegExp(String.raw`\brequire${gap}\(${gap}['"]([^'"]+)['"]${gap}\)`, 'g'),
      new RegExp(String.raw`\bfrom${gap}['"]([^'"]+)['"]`, 'g'),
      new RegExp(String.raw`\bimport${gap}(?:\(${gap})?['"]([^'"]+)['"]`, 'g')];
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
      if (inComment(source, match.index)) continue;
      const specifier = match[1];
      if (builtins.has(specifier)) continue;
      if (/^(?:https?:|data:)/.test(specifier)) blocked('remote/runtime-fetched module is outside the packaged dependency closure');
      checked++;
      const candidates = [];
      if (specifier.startsWith('.')) {
        const full = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
        relativeName(full);
        candidates.push(full);
      } else {
        if (specifier.startsWith('/') || specifier.includes(':') || specifier.includes('\\')) blocked('module dependency escapes the packaged layout');
        let current = path.posix.dirname(name);
        for (;;) {
          candidates.push(path.posix.join(current, 'node_modules', specifier));
          if (current === '.') break;
          current = path.posix.dirname(current);
        }
      }
      let found = false;
      for (const candidate of candidates) {
        for (const suffix of ['', '.js', '.cjs', '.mjs', '.json', '/index.js']) if (tree.files[`${candidate}${suffix}`]) found = true;
        if (tree.files[`${candidate}/package.json`]) {
          const pkg = readJson(path.join(root, `${candidate}/package.json`));
          if (typeof pkg.main === 'string') {
            const target = relativeName(path.posix.normalize(path.posix.join(candidate, pkg.main)));
            if (tree.files[target] || tree.files[`${target}.js`]) found = true;
          }
        }
      }
      if (!found) blocked(`packaged module dependency is absent: ${name} -> ${specifier}`);
    }
  }
  return { staticReferencesChecked: checked };
}

export function measurePackagedLayout({ product, stageRoot, sourceRoots, sourceRefs, target }) {
  const native = nativeRuntimeTarget(target);
  plainPath(stageRoot, { kind: 'directory' });
  const stage = measureTree(stageRoot);
  if (product === 'toolsenabled') {
    const sourcePackage = readJson(path.join(sourceRoots.app, 'package.json'));
    if (!Array.isArray(sourcePackage.build?.asarUnpack) ||
        JSON.stringify([...sourcePackage.build.asarUnpack].sort()) !== JSON.stringify(NATIVE_HELPERS)) blocked('application native helper selection differs from the reviewed layout');
    const archive = readAsar(path.join(stageRoot, 'resources', 'app.asar'), { allowedUnpacked: NATIVE_HELPERS });
    const record = archive.provenance;
    if (record?.schemaVersion !== 2 || record.ref !== sourceRefs.app || record.app?.ref !== sourceRefs.app || record.payload?.ref !== sourceRefs.engine ||
        record.dirty !== false || record.overridden !== false || record.app?.dirty !== false || record.payload?.dirty !== false || record.payload?.resolved !== true ||
        [record.dirtyFiles, record.app?.dirtyFiles, record.payload?.dirtyFiles].some(files => !Array.isArray(files) || files.length)) blocked('ASAR does not prove the exact clean app and engine refs');
    if (archive.packageJson.main !== sourcePackage.main || archive.packageJson.version !== sourcePackage.version) blocked('ASAR package identity differs from source');
    for (const name of Object.keys(archive.files)) if (!['package.json', 'config/google-signin.json'].includes(name) && !name.startsWith('shell/') && !name.startsWith('dist/')) blocked('ASAR includes a file outside the fixed application payload');
    if (!same(archive.files['config/google-signin.json'], measureFile(path.join(sourceRoots.app, 'config', 'google-signin.json')))) blocked('ASAR application configuration differs from source');
    compareFileSets(measureTree(path.join(sourceRoots.app, 'shell')).files, subset(archive.files, 'shell/'), 'packaged shell');
    compareFileSets(measureTree(path.join(sourceRoots.app, 'dist')).files, subset(archive.files, 'dist/'), 'packaged renderer');
    const payloadRoot = path.join(stageRoot, 'resources', 'capability'), payload = measureTree(payloadRoot);
    const closure = measureCapabilityClosure({ appRoot: sourceRoots.app, engineRoot: sourceRoots.engine, payloadRoot, payload, sourceRef: sourceRefs.engine });
    const executable = nativeApplicationExecutable(sourcePackage, target);
    measureNativeRuntime(stageRoot, executable, sourcePackage.build?.electronVersion, target);
    const runtimeFiles = Object.fromEntries(Object.entries(stage.files).filter(([name]) => !name.startsWith('resources/')));
    assertSameTree(stage, measureTree(stageRoot));
    return { stage, shellSha256: digestRecord(subset(archive.files, 'shell/')), runtimeSha256: digestRecord(runtimeFiles),
      sourceAndPayload: { archive: archive.identity, unpackedSha256: archive.unpacked.sha256,
        payloadSha256: payload.sha256, rendererSha256: digestRecord(subset(archive.files, 'dist/')) },
      runtimeAndClosure: { runtimeFiles: Object.keys(runtimeFiles).length, executable, version: sourcePackage.build.electronVersion, closure },
    };
  }
  const selected = STANDALONE[product];
  if (!selected) blocked('no packaged layout is registered for this product');
  const website = sourceRoots.website;
  for (const prefix of ['app', 'shared', 'shell']) {
    const from = prefix === 'app' ? path.join(website, 'software', product) : path.join(website, 'software', prefix);
    const include = name => standaloneIncluded(name) && !(prefix === 'app' && name === 'config.json') &&
      !(prefix === 'shell' && ['product.json', 'icon.ico'].includes(name));
    const expected = measureTree(from, { include }).files;
    const actual = Object.fromEntries(Object.entries(subset(stage.files, `${prefix}/`)).filter(([name]) => !(prefix === 'shell' && ['product.json', 'icon.ico'].includes(name))));
    compareFileSets(expected, actual, `standalone ${prefix}`);
  }
  const icon = path.join(website, 'software', 'brand', 'assets', `${product}.ico`);
  let iconIdentity = null;
  try { iconIdentity = measureFile(icon); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (iconIdentity && (!same(stage.files['ToolsEnabled.ico'], iconIdentity) || !same(stage.files['shell/icon.ico'], iconIdentity))) blocked('standalone branded icon bytes differ from source');
  if (!iconIdentity && (stage.files['ToolsEnabled.ico'] || stage.files['shell/icon.ico'])) blocked('standalone includes an unmeasured generated icon');
  for (const name of Object.keys(stage.files)) if (name !== 'ToolsEnabled.ico' && !['app/', 'shared/', 'shell/', 'runtime/electron/'].some(prefix => name.startsWith(prefix))) blocked('standalone includes an unaccounted payload file');
  if (JSON.stringify(readJson(path.join(stageRoot, 'shell', 'product.json'))) !== JSON.stringify(selected)) blocked('standalone shell product binding differs from the registered product');
  const runtime = measureNativeRuntime(path.join(stageRoot, 'runtime', 'electron'), native.standaloneExecutable, '43.3.0', target);
  const closure = verifyStaticModuleClosure(stageRoot, ['app', 'shared', 'shell']);
  assertSameTree(stage, measureTree(stageRoot));
  return { stage, shellSha256: digestRecord(subset(stage.files, 'shell/')), runtimeSha256: runtime.sha256,
    sourceAndPayload: { product, sourceRef: sourceRefs.website, stageSha256: stage.sha256 }, runtimeAndClosure: closure };
}

// This byte checker is intentionally supplemental. Complete owner-pattern and
// license-policy verification is run by the pinned existing app gates below;
// standalone policy is not silently inferred from the app's different package.
export function assertNoObviousPackagedSecrets(stageRoot) {
  const tree = measureTree(stageRoot);
  let files = 0;
  for (const name of Object.keys(tree.files)) {
    if (/(?:^|\/)(?:\.git|\.env|vault|state|captures)(?:\/|$)|\.(?:sqlite3?|db)(?:-wal|-shm)?$/i.test(name)) blocked('runtime/secret state is present in packaged files');
    if (tree.files[name].bytes > 64 * 1024 * 1024) continue; // binary executables get the complete pinned scanner, not a partial green here.
    const bytes = readBounded(path.join(stageRoot, name), 64 * 1024 * 1024);
    for (const text of [bytes.toString('utf8'), bytes.toString('utf16le')]) if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[a-zA-Z0-9_-]{24,}/.test(text)) blocked('secret material found in packaged bytes');
    files++;
  }
  return { supplementalFilesScanned: files, wholeProductPrivacyCertified: false };
}
