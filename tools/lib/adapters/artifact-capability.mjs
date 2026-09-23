import path from 'node:path';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { blocked, plainPath, relativeName, readBounded, readJson, measureFile, digestRecord, ENTRY_LIMIT } from './artifact-files.mjs';

const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
const same = (left, right) => left?.bytes === right?.bytes && left?.sha256 === right?.sha256;
const arraysEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// The app packer's declared/static closure model, independently measured with
// fenced reads and without importing or executing the source being qualified.
// Runtime-computed behavior is exercised by the separate installed adapters.
export function inComment(source, until) {
  let line = false, block = false, quote = null;
  for (let index = 0; index < until; index++) {
    const current = source[index], next = source[index + 1];
    if (line) { if (current === '\n') line = false; continue; }
    if (block) { if (current === '*' && next === '/') { block = false; index++; } continue; }
    if (quote) { if (current === '\\') index++; else if (current === quote) quote = null; continue; }
    if ('"\'`'.includes(current)) quote = current;
    else if (current === '/' && next === '/') { line = true; index++; }
    else if (current === '/' && next === '*') { block = true; index++; }
  }
  return line || block;
}

export function measureCapabilityClosure({ appRoot, engineRoot, payloadRoot, payload, sourceRef }) {
  const manifest = readJson(path.join(appRoot, 'tools', 'capability-manifest.json'));
  const list = key => {
    if (!Array.isArray(manifest[key])) blocked(`capability manifest ${key} is missing`);
    const result = manifest[key].map(relativeName);
    if (new Set(result).size !== result.length) blocked('duplicate capability manifest entry');
    return result;
  };
  const entrypoints = list('entrypoints'), hostModules = list('hostModules'), spawnedPrograms = list('spawnedPrograms');
  const helpers = list('helperPrograms'), data = list('dataFiles'), neutralDefaults = list('neutralDefaults');
  if (!entrypoints.length || !hostModules.length || !neutralDefaults.length) blocked('capability manifest roots are empty');
  if (helpers.some(name => !/\.(?:ps1|cmd|bat|py)$/i.test(name))) blocked('capability helper has an undeclared executable type');
  const neutral = new Set(neutralDefaults), observed = new Map(), dynamic = new Map(), used = new Set();
  if (!Array.isArray(manifest.dynamicRequires)) blocked('dynamic capability declarations are absent');
  for (const row of manifest.dynamicRequires) {
    const from = relativeName(row.from);
    if (typeof row.expression !== 'string' || !row.expression || row.expression.length > 80 || !Array.isArray(row.resolvesTo)) blocked('invalid dynamic capability declaration');
    const key = `${from}\0${row.expression}`;
    if (dynamic.has(key)) blocked('duplicate dynamic capability declaration');
    dynamic.set(key, row.resolvesTo.map(relativeName));
  }
  function sourceFile(name, optional = false) {
    name = relativeName(name);
    if (observed.has(name)) return observed.get(name);
    const file = neutral.has(name) ? path.join(appRoot, 'capability-defaults', name) : path.join(engineRoot, name);
    try {
      plainPath(file);
      if (optional && fs.lstatSync(file).isDirectory()) return null;
      const identity = measureFile(file), result = { file, identity };
      observed.set(name, result); return result;
    } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  }
  const expected = new Set(), visited = new Set(), queue = [...entrypoints, ...hostModules, ...spawnedPrograms];
  while (queue.length) {
    const name = relativeName(queue.pop());
    if (visited.has(name)) continue;
    if (visited.size > ENTRY_LIMIT) blocked('capability closure exceeds its budget');
    visited.add(name); expected.add(name);
    const file = sourceFile(name);
    if (name.endsWith('.json')) continue;
    if (!/\.(?:cjs|mjs|js)$/.test(name)) blocked('JavaScript capability root has an unsupported file type');
    const source = readBounded(file.file).toString('utf8');
    for (const match of source.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
      if (inComment(source, match.index)) continue;
      const expression = match[1].trim(), literal = /^(['"])([^'"]+)\1$/.exec(expression);
      if (!literal) {
        const key = `${name}\0${expression.slice(0, 80)}`;
        if (!dynamic.has(key)) blocked(`undeclared computed capability dependency: ${name}`);
        used.add(key); queue.push(...dynamic.get(key)); continue;
      }
      const specifier = literal[2];
      if (builtins.has(specifier)) continue;
      if (!specifier.startsWith('.')) blocked('capability requires an external package that is not shipped');
      const base = relativeName(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier.replaceAll('\\', '/'))));
      const resolved = [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.js`].find(candidate => sourceFile(candidate, true));
      if (!resolved) blocked(`unresolved capability dependency: ${name}`);
      queue.push(resolved);
    }
    for (const match of source.matchAll(/\bimport\s*(?:\(|['"{*])|\bexport\s+[^;\n]*\bfrom\b/g)) {
      if (!inComment(source, match.index)) blocked('ES-module capability imports require a reviewed closure extension');
    }
  }
  if ([...dynamic.keys()].some(key => !used.has(key))) blocked('stale dynamic capability declaration');
  const powershell = helpers.filter(name => /\.(?:ps1|psm1|psd1)$/i.test(name)), psVisited = new Set();
  while (powershell.length) {
    const name = relativeName(powershell.pop());
    if (psVisited.has(name)) continue;
    psVisited.add(name); expected.add(name);
    const source = readBounded(sourceFile(name).file).toString('utf8');
    for (const pattern of [/\$PSScriptRoot[\\/]([A-Za-z0-9_.\\/-]+?\.(?:ps1|psm1|psd1))/gi,
      /Join-Path\s+\$PSScriptRoot\s+['"]([A-Za-z0-9_.\\/-]+?\.(?:ps1|psm1|psd1))['"]/gi]) {
      for (const match of source.matchAll(pattern)) powershell.push(relativeName(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1].replaceAll('\\', '/')))));
    }
  }
  for (const name of [...data, ...helpers, ...neutralDefaults]) { expected.add(name); sourceFile(name); }
  const names = [...expected].sort(), actual = Object.keys(payload.files).filter(name => name !== 'PAYLOAD.json').sort();
  if (!arraysEqual(names, actual)) blocked('capability payload omits/adds files relative to the independently derived closure');
  const digest = createHash('sha256');
  let bytes = 0;
  for (const name of names) {
    if (!same(sourceFile(name).identity, payload.files[name])) blocked(`capability source/default bytes differ: ${name}`);
    digest.update(name).update('\0').update(readBounded(path.join(payloadRoot, name)));
    bytes += payload.files[name].bytes;
  }
  const marker = readJson(path.join(payloadRoot, 'PAYLOAD.json')), payloadSha256 = digest.digest('hex');
  if (marker.schemaVersion !== 1 || marker.sourceRef !== sourceRef || marker.ownerDataClean !== true || marker.fileCount !== names.length ||
      marker.byteCount !== bytes || marker.payloadSha256 !== payloadSha256 || marker.bridgeEntrypoint !== entrypoints[0] || marker.ownerHostModule !== 'src/owner-host.js' ||
      !expected.has(marker.ownerHostModule) || !arraysEqual(marker.entrypoints, entrypoints) || !arraysEqual(marker.hostModules, hostModules) ||
      !arraysEqual(marker.spawnedPrograms, spawnedPrograms) || !arraysEqual(marker.helperPrograms, helpers) || !arraysEqual(marker.neutralDefaults, neutralDefaults)) blocked('capability marker differs from measured closure/source facts');
  return { manifestSha256: measureFile(path.join(appRoot, 'tools', 'capability-manifest.json')).sha256,
    closureSha256: digestRecord(names), fileCount: names.length, byteCount: bytes, payloadSha256,
    staticJavaScriptFiles: visited.size, powershellFiles: psVisited.size, declaredDynamicReferences: used.size };
}
