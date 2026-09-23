import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registeredToolPaths } from '../lib/transport/registered-toolchain.mjs';
import { relativeName, digestRecord } from '../lib/adapters/artifact-files.mjs';
import { parseSourceOutput } from '../lib/adapters/source-suites.mjs';

const options = { reporter: 'app:chat-control-coverage' };
const report = ({ controls = 12, files = 40, evidence = 90, findings = 0, accepted = 0, extra = '' } = {}) =>
  `SUMMARY: inventory controls=${controls}; scanned candidate files=${files}; evidence records=${evidence}; findings=${findings}; canonical baseline accepted entries=${accepted}\n${extra}`;
const parse = output => parseSourceOutput(output, '', options);

test('chat coverage consumes measured numeric populations and retains accepted findings', () => {
  assert.deepEqual(parse(report()), { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 });
  assert.equal(parse(report({ findings: 1, accepted: 1, extra: 'FINDING: composer:example\n' })).failed, 0);
});

test('chat coverage refuses missing, duplicate, malformed and empty measured populations', () => {
  for (const output of ['', 'Every check passed', report() + report(),
    ...['controls', 'files', 'evidence'].flatMap(key => [report({ [key]: 0 }), report({ [key]: 'd' }),
      report({ [key]: -1 }), report({ [key]: '9007199254740992' })])]) {
    assert.throws(() => parse(output), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  }
});

test('chat coverage refuses omitted findings, noncanonical debt and explicit failed observations', () => {
  for (const output of [report({ findings: 1, accepted: 1 }),
    report({ findings: 1, accepted: 0, extra: 'FINDING: composer:example\n' }),
    report({ findings: 0, accepted: 1 }),
    report({ controls: 1, findings: 2, accepted: 2, extra: 'FINDING: a\nFINDING: b\n' }),
    report({ findings: 2, accepted: 2, extra: 'FINDING: a\nFINDING: a\n' }),
    ...['UNACCEPTED: a', 'STALE: a', 'PROPOSAL: unreviewed', 'SETUP ERROR: missing input'].map(extra => report({ extra }))]) {
    assert.throws(() => parse(output), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  }
  assert.throws(() => parseSourceOutput(report(), 'Lower the canonical baseline: accepted identities are stale.', options),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
});

const actionExamples = [
  ['app:node-version', 'check-node-version: node v22.19.0 matches the package.json engines.node pin (/synthetic/node).', 'node v22.19.0', 'node v0.0.0'],
  ['app:benchmark-core', 'core modules: 12  vertical: 4  seam: 3\ncore modules importing a vertical module: 2 (known remaining: 2)\nOK: no new core->vertical coupling. 2 module(s) still to invert, exactly as recorded.', 'known remaining: 2', 'known remaining: 1'],
  ['app:profile-paths', 'check-no-profile-paths: scanned 100 tracked or untracked-not-ignored file(s), 0 absolute profile paths outside the allowlist.', 'scanned 100', 'scanned 0'],
  ['app:shipped-source-privacy', 'Scanned 100 files (1000 bytes). Total matches: 0.\nShipped-source owner-data gate: clean. 100 file(s) (1000 bytes) across ["shell","src","public","config"] carry no owner data; 0 allowlisted.', 'Total matches: 0', 'Total matches: 1'],
  ['app:payload-reconciliation', 'Files seen: 10 (informational -- this guard asserts on named paths, never on a count).\nClassified (distinct paths across 1 root(s)): open=10 pending=0 paid=0 excluded=0 unclassified=0\nPayload boundary: clean. Nothing paid, excluded or unclassified is present.\ncheck-payload-boundary-reconciled: every file the engine will pack is classified by config/payload-boundary.json.', 'unclassified=0', 'unclassified=1'],
];
for (const [reporter, output, match, broken] of actionExamples) {
  test(reporter + ' requires a measured complete report and refuses a failed or omitted observation', () => {
    const input = { reporter, cwd: process.cwd() };
    assert.equal(parseSourceOutput(output, '', input).tests, 0);
    for (const invalid of ['', output.replace(match, broken), output + '\n' + output]) {
      assert.throws(() => parseSourceOutput(invalid, '', input), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
    }
    assert.throws(() => parseSourceOutput(output, 'failed observation', input), { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  });
}


// Run the real producer with in-memory I/O and a simulated npm child. The
// producer builds its own header/footer; no consumer-derived header fixture,
// native launch, private file, or cleanup operation participates in this proof.
const appRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const engineRoot = path.resolve(appRoot, '../engine');
const node = registeredToolPaths().node;
const fingerprint = value => ({ bytes: Buffer.byteLength(value),
  sha256: createHash('sha256').update(value).digest('hex') });

async function authenticStrictTranscript() {
  const script = new URL('../test-strict.mjs', import.meta.url);
  const scratch = path.join(os.userInfo().homedir, 'strict-protocol-value-fixture');
  const state = path.join(scratch, 'state'), temp = path.join(scratch, 'temp');
  const appRef = 'a'.repeat(40), engineRef = 'b'.repeat(40);
  const deps = path.join(appRoot, 'node_modules');
  const dependencies = deps + ' (real directory, repository root, 2 entries)';
  const captured = [
    'Dependency resolution: ' + dependencies + '.',
    'Measurement environment: node v22.19.0 at ' + node + '; TOOLSENABLED_STATE_ROOT=' + state +
      '; MC_CANONICAL_ROOT=' + engineRoot + '; TOOLSENABLED_TEST_STRICT=1; TOOLSENABLED_NIGHTLY=(unset).',
    'Test ratchet: running \`npm test\` ...',
    'Raw suite output retained at ' + path.join(temp, 'toolsenabled-test-output-fixture'),
    'Ran 1 tests: 1 pass, 0 fail, 0 skipped (0 failing top-level test(s), suite exit 0).',
    'UNEXECUTED (skipped) tests: 0.',
    'Strict verification OK: 1 passed, no failures; no failure baseline was accepted; 1 required control(s) passed; 0 test(s) unexecuted and named, 0 unexecuted and unnamed.',
    '',
  ].join('\n');
  let stdout = '', stderr = '', child;
  const writes = new Map(), launches = [];
  const scope = {
    path, os, fileURLToPath,
    process: { platform: process.platform, version: 'v22.19.0', execPath: node,
      argv: [node, fileURLToPath(script), '--canonical-root', engineRoot, '--scratch', scratch],
      env: {}, getuid: () => 1000,
      stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } },
    existsSync: file => [path.join(engineRoot, 'package.json'),
      path.join(appRoot, 'private/capability-source.owner.json')].includes(file),
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40700 }),
    readdirSync: directory => {
      if (directory === deps) return ['alpha', 'beta'];
      if (directory === path.join(appRoot, 'capability')) return ['payload.js'];
      throw new Error('Unexpected directory read in producer fixture: ' + directory);
    },
    readFileSync: file => {
      assert.equal(file, path.join(appRoot, 'private/capability-source.owner.json'));
      return JSON.stringify({ path: engineRoot, ref: engineRef });
    },
    writeFileSync: (file, value) => { writes.set(file, value); },
    mkdirSync: () => assert.fail('The producer should consume the existing source record'),
    mkdtempSync: () => assert.fail('The producer should use its explicit scratch'),
    prepareStrictScratch: directory => {
      assert.equal(directory, scratch);
      return { ok: true, state, temp };
    },
    spawnSync: (command, args) => {
      assert.equal(command, 'git');
      assert.deepEqual(Array.from(args).filter((_, index) => index !== 1), ['-C', 'rev-parse', 'HEAD']);
      assert.ok([appRoot, engineRoot].includes(args[1]));
      return { status: 0, stdout: args[1] === appRoot ? appRef : engineRef };
    },
    spawn: (command, args, options) => {
      launches.push({ command, args: Array.from(args), cwd: options.cwd, env: { ...options.env } });
      child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      queueMicrotask(() => { child.stdout.emit('data', captured); child.emit('close', 0, null); });
      return child;
    },
  };
  const source = fs.readFileSync(script, 'utf8').replace(/^#![^\n]*\r?\n/, '')
    .replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll(['import', 'meta', 'url'].join('.'), JSON.stringify(script.href));
  await vm.runInNewContext('(async () => {\n' + source + '\n})()', scope,
    { filename: fileURLToPath(script), timeout: 1000 });
  assert.equal(scope.process.exitCode, 0, stderr);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, ['run', 'verify:release']);
  assert.equal(launches[0].cwd, appRoot);
  for (const key of ['TOOLSENABLED_STATE_ROOT', 'MC_TEST_STATE_ROOT']) assert.equal(launches[0].env[key], state);
  assert.equal(launches[0].env.TOOLSENABLED_VAULT_PATH, path.join(state, 'vault', 'secrets.json'));
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(launches[0].env[key], temp);
  assert.equal(launches[0].env.MC_CANONICAL_ROOT, engineRoot);
  assert.equal(writes.get(path.join(scratch, 'strict-output.log')), captured);
  return { stdout, stderr, scratch, state, temp, writes, job: {
    reporter: 'app:strict-release', command: node, cwd: appRoot,
    args: [fileURLToPath(script), '--canonical-root', engineRoot, '--scratch', scratch],
    strictBinding: { root: appRoot, canonicalRoot: engineRoot, scratch, appRef, engineRef,
      dependencyEntries: 2, capabilityEntries: 1 },
  } };
}

test('strict parser consumes the actual producer header and its isolated vault/temp environment', async () => {
  const f = await authenticStrictTranscript();
  let parsed;
  assert.doesNotThrow(() => { parsed = parseSourceOutput(f.stdout, f.stderr, f.job); },
    'The authentic strict producer must be accepted by the source parser');
  assert.equal(parsed.tests, 0);
  assert.deepEqual(parseSourceOutput(f.stdout.replaceAll('\n', '\r\n'), '', f.job),
    parseSourceOutput(f.stdout, '', f.job));
  assert.ok(f.stdout.startsWith(f.writes.get(path.join(f.scratch, 'strict-header.txt'))));
});

for (const [label, value] of [
  ['state roots', f => f.state],
  ['vault path', f => path.join(f.state, 'vault', 'secrets.json')],
  ['TEMP/TMP/TMPDIR', f => f.temp],
]) {
  test('strict parser refuses missing, duplicated or substituted producer ' + label, async () => {
    const f = await authenticStrictTranscript();
    const line = f.stdout.split('\n').find(row => row.startsWith(label + ' '));
    assert.ok(line, 'The actual producer must declare this isolation field');
    assert.equal(line.trimEnd().endsWith(value(f)), true);
    for (const replacement of ['', line + '\n' + line, line.replace(value(f), value(f) + '-different')]) {
      assert.throws(() => parseSourceOutput(f.stdout.replace(line + '\n', replacement ? replacement + '\n' : ''), '', f.job),
        error => error.code === 'SOURCE_QUALIFICATION_INCOMPLETE' && /header differs/.test(error.message));
    }
  });
}

test('strict parser retains exact producer source, command, count and raw-output bindings', async () => {
  const f = await authenticStrictTranscript();
  for (const key of ['root', 'canonicalRoot', 'scratch', 'appRef', 'engineRef']) {
    const binding = { ...f.job.strictBinding, [key]: f.job.strictBinding[key] + '-different' };
    assert.throws(() => parseSourceOutput(f.stdout, '', { ...f.job, strictBinding: binding }),
      { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
  }
  for (const [from, to] of [
    ['Ran 1 tests: 1 pass', 'Ran 0 tests: 0 pass'],
    ['1 required control(s) passed', '0 required control(s) passed'],
    ['verify:release exit   0', 'verify:release exit   1'],
    ['UNEXECUTED (skipped) tests: 0.', ''],
    [path.join(f.temp, 'toolsenabled-test-output-fixture'), path.join(f.scratch, 'outside-temp')],
  ]) assert.throws(() => parseSourceOutput(f.stdout.replace(from, to), '', f.job),
    { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });
});

// Exercise the real harness comparison logic over authentic local source bytes.
// Filesystem/Git custody is modeled here; native clean-snapshot proof stays a
// separate gate. No fixture directory is created and no global API is replaced.
const roleDependencies = [
  'tools/lib/page2-native-role-scenarios.cjs',
  'tools/lib/page2-native-scenarios.cjs',
  'tools/lib/page2-native-state-evidence.cjs',
  'tools/lib/page2-native-compose-evidence.cjs',
  'tools/lib/native-driver-dependencies.cjs',
  'shell/install-profile-guard.cjs',
];
function harnessValues({ beforeLoad = {}, afterLoad = {} } = {}) {
  const script = new URL('../lib/adapters/source-harness.mjs', import.meta.url);
  const producerRoot = path.join(os.userInfo().homedir, 'source-harness-producer-values');
  const original = new Map(), consumer = new Map();
  const readOriginal = name => {
    if (!original.has(name)) original.set(name, fs.readFileSync(path.join(appRoot, name)));
    return original.get(name);
  };
  const measurement = file => {
    const producer = file === producerRoot || file.startsWith(producerRoot + path.sep);
    const root = producer ? producerRoot : appRoot;
    const name = path.relative(root, file).split(path.sep).join('/');
    assert.ok(name && name !== '..' && !name.startsWith('../') && !path.isAbsolute(name));
    const bytes = readOriginal(name);
    return fingerprint(producer ? bytes : consumer.get(name) || bytes);
  };
  for (const [name, suffix] of Object.entries(beforeLoad)) consumer.set(name, Buffer.concat([readOriginal(name), Buffer.from(suffix)]));
  const snapshot = root => ({ ref: root === appRoot ? 'c'.repeat(40) : 'd'.repeat(40),
    files: Object.fromEntries([...original.keys()].map(name => [name, measurement(path.join(root, name))])) });
  const scope = {
    path, fileURLToPath, relativeName, digestRecord,
    plainPath: value => value, measureFile: measurement,
    sourceRepositoryRoot: () => appRoot, sourceHead: root => snapshot(root).ref,
    cleanSourceSnapshot: root => snapshot(root),
  };
  const source = fs.readFileSync(script, 'utf8').replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll(['import', 'meta', 'url'].join('.'), JSON.stringify(script.href)).replace(/^export /gm, '');
  vm.runInNewContext(source + '\nglobalThis.harness = { measureSourceHarnesses, sourceHarnessImplementationIdentity };',
    scope, { filename: fileURLToPath(script), timeout: 1000 });
  const loadedIdentity = scope.harness.sourceHarnessImplementationIdentity();
  for (const [name, suffix] of Object.entries(afterLoad)) consumer.set(name, Buffer.concat([readOriginal(name), Buffer.from(suffix)]));
  // A fixed recorded execution and unchanged adapter are carried through each
  // test; only the helper measurement changes. We never relaunch that execution.
  const recorded = Object.freeze({ command: node, args: Object.freeze(['recorded-role-driver']),
    exitCode: 0, verifier: fingerprint(readOriginal('tools/lib/adapters/role-studio-source.mjs')) });
  return { ...scope.harness, producerRoot, loadedIdentity, recorded };
}

test('source harness accepts unchanged authentic Role dependencies across producer and consumer', () => {
  const f = harnessValues();
  const actual = f.measureSourceHarnesses('toolsenabled', f.producerRoot);
  assert.equal(actual.componentSha256, f.loadedIdentity);
  assert.equal(actual.producer.ref, 'd'.repeat(40));
  assert.equal(actual.consumer.ref, 'c'.repeat(40));
});

for (const dependency of roleDependencies) {
  test('source harness refuses helper-only producer/consumer drift: ' + dependency, () => {
    const control = harnessValues();
    const f = harnessValues({ beforeLoad: { [dependency]: '\n// changed consumer helper\n' } });
    assert.deepEqual(f.recorded, control.recorded);
    assert.notEqual(f.loadedIdentity, control.loadedIdentity);
    assert.throws(() => f.measureSourceHarnesses('toolsenabled', f.producerRoot), error =>
      error.code === 'SOURCE_HARNESS_BLOCKED' &&
      error.message.includes('producer/consumer source dependency bytes differ:') &&
      error.message.endsWith(path.basename(dependency)));
  });
  test('source harness refuses a helper changed after verifier load: ' + dependency, () => {
    const f = harnessValues({ afterLoad: { [dependency]: '\n// changed loaded helper\n' } });
    assert.throws(() => f.sourceHarnessImplementationIdentity(), error =>
      error.code === 'SOURCE_HARNESS_BLOCKED' &&
      error.message.includes('executing source dependency changed after module load:') &&
      error.message.endsWith(path.basename(dependency)));
  });
}
