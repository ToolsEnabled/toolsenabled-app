import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sourceExecutor from '../lib/adapters/source-suites.mjs';
import { contains, digestRecord, plainPath } from '../lib/adapters/artifact-files.mjs';
import { ROLE_STUDIO_SOURCE_ACTION } from '../lib/adapters/role-studio-source.mjs';
import { declaredFunctionSource } from './lib/declared-function-source.mjs';
import { registeredToolPaths } from '../lib/transport/registered-toolchain.mjs';
import { registeredToolEnvironment } from '../lib/transport/owned-job.mjs';
import { ENGINE_PERFORMANCE_ACTIONS, parseEnginePerformanceTranscript } from '../lib/adapters/engine-performance-source.mjs';
import { SOURCE_COMMAND_ACTIONS } from '../lib/adapters/source-suite-manifests.mjs';
import { reconcileSourceCommands } from '../lib/adapters/source-command-plan.mjs';
import { planSourceSuiteJobs, parseSourceOutput, assertIsolatedSourceSummary } from '../lib/adapters/source-suites.mjs';

const root = path.resolve('engine-performance-value-fixture');
const directory = path.join(os.tmpdir(), 'engine-performance-report-values');
function job(id) {
  const action = ENGINE_PERFORMANCE_ACTIONS.find(value => value.id === id);
  const summaryPath = path.join(directory, id.replace(':', '-') + '.json');
  const file = path.join(root, action.command[1]);
  return { command: registeredToolPaths().node, cwd: root, actionId: id,
    reporter: action.reporter, file, summaryPath, env: { TOOLSENABLED_TEST_STRICT: '1' },
    args: [path.join(root, 'tests/run-isolated.js'), '--config-integrity', '--timeout-ms',
      String(action.timeoutMs), '--summary', summaryPath, action.command[1]],
    performanceBinding: { root, summaryPath, actionId: id, sourceRef: 'a'.repeat(40),
      platform: process.platform, arch: process.arch } };
}
const cold = [
  'Measuring cold start: spawn ' + path.join('src', 'mcp-server.js') + ', send initialize, time the first response.',
  '  attempt 1: 0.85s', '  attempt 2: 1.20s', '  attempt 3: 0.97s',
  'Slowest of 3: 1.20s.  Ceiling: 2.5s.',
  'PASS: cold start is within the stated ceiling.',
  'STRICT EVIDENCE: tools/cold-start-check.js -- process-exit; assertion count not reported', '',
].join('\n');
const idle = [
  'Spawning ' + path.join('src', 'mcp-server.js') + ' exactly as a real MCP client would (stdin open, unwritten)...',
  "Startup was already quiet at the first look (<= 7.0s, this check's floor); sampling idle from here.",
  'pid 321: 0.0600s CPU consumed over 30.01s idle (no requests sent) = 0.1999% of one core.',
  'Ceiling: 1% of one core, sustained while idle.',
  'PASS: idle CPU is within the stated ceiling.',
  'STRICT EVIDENCE: tools/idle-cpu-check.js -- process-exit; assertion count not reported', '',
].join('\n');
const parseCold = value => parseEnginePerformanceTranscript(value, '', job('engine:cold-start'));
const parseIdle = value => parseEnginePerformanceTranscript(value, '', job('engine:idle-cpu'));
const refused = fn => assert.throws(fn, { code: 'SOURCE_QUALIFICATION_INCOMPLETE' });

test('native performance reports remain supplemental and consume complete observed intervals', () => {
  assert.equal(parseCold(cold).tests, 0);
  assert.equal(parseIdle(idle).tests, 0);
  assert.deepEqual(parseCold(cold.replaceAll('\n', '\r\n')), parseCold(cold));
  const zero = idle.replace('0.0600s CPU', '0.0000s CPU').replace('0.1999%', '0.0000%');
  assert.equal(parseIdle(zero).failed, 0);
});
test('cold-start observation requires all three distinct ordered initialize attempts', () => {
  for (const output of ['', cold.replace('  attempt 2: 1.20s\n', ''),
    cold.replace('  attempt 2:', '  attempt 1:'), cold.replace('  attempt 2:', '  attempt 3:'),
    cold + cold, cold.replace('send initialize', 'send notification')]) refused(() => parseCold(output));
});
test('cold-start observation retains the slowest-attempt ceiling and exact completion', () => {
  for (const output of [cold.replace('Slowest of 3: 1.20s', 'Slowest of 3: 0.97s'),
    cold.replaceAll('1.20s', '2.51s'), cold.replace('Ceiling: 2.5s.', 'Ceiling: 3.0s.'),
    cold.replace('PASS:', 'FAIL:'), cold.replace('  attempt 1: 0.85s', '  attempt 1: NaNs')]) refused(() => parseCold(output));
});
test('idle observation requires actual settled startup and a full thirty-second sample', () => {
  const settled = idle.replace("Startup was already quiet at the first look (<= 7.0s, this check's floor); sampling idle from here.",
    'Startup settled 12.2s after spawn; sampling idle from here.');
  assert.equal(parseIdle(settled).failed, 0);
  for (const output of [idle.replace('30.01s idle', '29.99s idle'), idle.replace('30.01s idle', '0.00s idle'),
    idle.replace("<= 7.0s", "<= 1.0s"), settled.replace('12.2s after spawn', '0.0s after spawn'),
    idle.split('\n').filter(line => !line.startsWith('Startup')).join('\n')]) refused(() => parseIdle(output));
});
test('idle observation refuses counter, PID, percentage and fixed-ceiling disagreement', () => {
  for (const output of [idle.replace('pid 321:', 'pid 0:'), idle.replace('pid 321:', 'pid 9007199254740993:'),
    idle.replace('0.0600s CPU', '-0.0600s CPU'), idle.replace('0.1999%', '0.1000%'),
    idle.replace('0.1999%', '1.0001%'), idle.replace('Ceiling: 1%', 'Ceiling: 2%'),
    idle.replace('PASS:', 'COULD NOT MEASURE:')]) refused(() => parseIdle(output));
});
test('native performance transcript cannot substitute its isolated child or command context', () => {
  for (const [output, id] of [[cold, 'engine:cold-start'], [idle, 'engine:idle-cpu']]) {
    const expected = job(id);
    refused(() => parseEnginePerformanceTranscript(output, 'unexplained failure', expected));
    refused(() => parseEnginePerformanceTranscript(output.replace('STRICT EVIDENCE:', 'SKIP:'), '', expected));
    for (const change of [{ args: expected.args.concat('--unknown') }, { cwd: directory },
      { file: path.join(root, 'tools/other.js') }, { summaryPath: path.join(directory, 'old.json') },
      { env: {} }, { actionId: 'engine:unknown' },
      { performanceBinding: { ...expected.performanceBinding, sourceRef: 'unknown' } },
      { performanceBinding: { ...expected.performanceBinding, platform: process.platform === 'linux' ? 'win32' : 'linux' } }]) {
      refused(() => parseEnginePerformanceTranscript(output, '', { ...expected, ...change }));
    }
  }
});

test('production performance dispatcher requires the native observations and never invents assertion counts', () => {
  for (const [output, id] of [[cold, 'engine:cold-start'], [idle, 'engine:idle-cpu']]) {
    assert.deepEqual(parseSourceOutput(output, '', job(id)), {
      tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 });
    refused(() => parseSourceOutput('', '', job(id)));
    refused(() => parseSourceOutput(output.replace('PASS:', 'FAIL:'), '', job(id)));
  }
});
test('registered native performance aliases require their contextual executor even with generic coverage', () => {
  for (const action of ENGINE_PERFORMANCE_ACTIONS) {
    assert.deepEqual(SOURCE_COMMAND_ACTIONS.engine.filter(row => row.id === action.id), [action]);
    const input = { aliases: { check: action.command.join(' ') }, selectedFiles: [action.command[1]],
      coveredCommands: [action.command] };
    assert.equal(reconcileSourceCommands(input).complete, false);
    assert.equal(reconcileSourceCommands({ ...input, contextCommands: [action] }).complete, true);
    for (const contextCommands of [[], [{ ...action, context: 'generic' }]]) {
      assert.equal(reconcileSourceCommands({ ...input, contextCommands }).complete, false);
    }
    assert.equal(reconcileSourceCommands({ ...input, contextCommands: [action],
      aliases: { check: action.command.join(' ') + ' --different-mode' } }).complete, false);
  }
});
test('production performance planning binds actual source and relative isolated-summary argv without running it', () => {
  assert.ok(process.env.MC_CANONICAL_ROOT, 'the suite needs its actual canonical Engine context');
  const engineRoot = path.resolve(process.env.MC_CANONICAL_ROOT);
  const selection = { id: 'engine', root: engineRoot, files: [], crossFiles: [],
    commands: SOURCE_COMMAND_ACTIONS.engine.filter(row => row.context === 'engine-isolated-performance') };
  const evidence = os.tmpdir();
  const sourceRef = 'b'.repeat(40);
  const jobs = planSourceSuiteJobs(selection, evidence, { sourceRef });
  assert.equal(jobs.length, 2);
  for (const actual of jobs) {
    const action = ENGINE_PERFORMANCE_ACTIONS.find(row => row.id === actual.actionId);
    assert.ok(action);
    assert.deepEqual(actual.args, [path.join(engineRoot, 'tests/run-isolated.js'), '--config-integrity',
      '--timeout-ms', String(action.timeoutMs), '--summary',
      path.join(evidence, action.id.replace(':', '-') + '.json'), action.command[1]]);
    assert.equal(actual.cwd, engineRoot);
    assert.equal(actual.file, path.join(engineRoot, action.command[1]));
    assert.equal(actual.performanceBinding.sourceRef, sourceRef);
    assert.equal(actual.performanceBinding.platform, process.platform);
    assert.equal(actual.performanceBinding.arch, process.arch);
    assert.deepEqual(actual.env, { TOOLSENABLED_TEST_STRICT: '1' });
    assert.equal(parseSourceOutput(action.id === 'engine:cold-start' ? cold : idle, '', actual).tests, 0);
  }
  refused(() => planSourceSuiteJobs(selection, evidence));
  for (const change of [{ command: ['node', 'tools/other.js'] }, { timeoutMs: 1 }, { reporter: 'source-tests' }]) {
    const altered = { ...selection, commands: [{ ...selection.commands[0], ...change }] };
    refused(() => planSourceSuiteJobs(altered, evidence, { sourceRef }));
  }
});

// Exercise the real admission function up to its first descriptor-binding read.
// That boundary throws before files, leases or children can be created. This is
// contract evidence, not an executed native-job or cleanup receipt.
function linuxAdmission() {
  const source = fs.readFileSync(new URL('../lib/transport/linux-owned-job.mjs', import.meta.url), 'utf8');
  const admitted = new Error('reached native descriptor binding');
  const toolchain = { tools: { node: { path: registeredToolPaths().node } } };
  const context = {
    process: { platform: 'linux', arch: 'x64' }, structuredClone,
    privateDirectory: value => value,
    positive: (value, maximum) => assert.ok(Number.isSafeInteger(value) && value > 0 && value <= maximum),
    measureLinuxToolchain: () => toolchain, capturedOwner: () => ({}),
    identity: () => ({}), digestRecord: JSON.stringify, MODULE: '', LOADED_IMPLEMENTATION: {},
    ownedJobImplementationIdentity: () => ({}), LINUX_GIT: 'unused-git', LINUX_XZ: 'unused-xz',
    MAX_OUTPUT: 8 * 1024 * 1024, MAX_XZ_OUTPUT_BYTES: 1024 * 1024 * 1024,
    plainPath: value => value, contains: () => false,
    registeredToolEnvironment: value => value,
    fs: { lstatSync: () => { throw admitted; } },
  };
  const run = vm.runInNewContext('(' + declaredFunctionSource(source.replace(/^export /gm, ''), 'runLinuxOwnedJobBatch') + ')', context);
  return { run, admitted };
}

function genericEngineJobs() {
  assert.ok(process.env.MC_CANONICAL_ROOT, 'actual Engine source is required');
  const engineRoot = path.resolve(process.env.MC_CANONICAL_ROOT);
  return planSourceSuiteJobs({ id: 'engine', root: engineRoot,
    files: ['tests/agent-slot-functions.test.js', 'tests/process-cpu-sample.test.js'], crossFiles: [],
    commands: [SOURCE_COMMAND_ACTIONS.engine.find(action => !action.context)] }, directory);
}

test('generic source leaf and supplemental plans satisfy the actual Linux transport admission', async () => {
  const jobs = genericEngineJobs();
  assert.equal(jobs.length, 3);
  // Windows keeps its existing 500 ms policy; Linux must reach descriptor
  // binding through the production admission checks with the unchanged jobs.
  if (process.platform !== 'linux') for (const job of jobs) assert.equal(job.cleanupGraceMs, 500);
  const { run, admitted } = linuxAdmission();
  const linuxJobs = process.platform === 'linux' ? jobs : jobs.map(job => ({ ...job, cleanupGraceMs: 250 }));
  await assert.rejects(run({ jobs: linuxJobs, evidenceRoot: directory }), error => error === admitted);
  for (let index = 0; index < linuxJobs.length; index++) {
    const wrong = linuxJobs.map((job, at) => at === index ? { ...job, cleanupGraceMs: 500 } : job);
    await assert.rejects(run({ jobs: wrong, evidenceRoot: directory }), /fixed at 250 ms/);
  }
});

test('generic engine plans preserve producer summary names accepted by the actual verifier', () => {
  const jobs = genericEngineJobs().filter(job => job.summaryPath);
  assert.equal(jobs.length, 2);
  const source = fs.readFileSync(path.join(jobs[0].cwd, 'tests/run-isolated.js'), 'utf8');
  let summary;
  const context = { path, process: { env: {} }, STRICT: true, DEFAULT_TIMEOUT_MS: 180000,
    fs: { mkdirSync() {}, writeFileSync(file, bytes) { summary = JSON.parse(bytes); } } };
  vm.runInNewContext(['parsePositiveInteger', 'parseArguments', 'writeSummary']
    .map(name => declaredFunctionSource(source, name)).join('\n'), context);
  for (const job of jobs) {
    const parsed = context.parseArguments(job.args.slice(1));
    assert.equal(parsed.scripts.length, 1);
    assert.equal(path.resolve(job.cwd, parsed.scripts[0]), job.file);
    // run-isolated preserves the requested spelling when writing a completed
    // leaf. Supply only its process result; retain the real parser and writer.
    context.writeSummary(parsed.summaryPath, Date.now(), parsed.scripts.map(file => ({
      file: file.replaceAll('\\', '/'), status: 'pass', exitCode: 0,
    })));
    assert.doesNotThrow(() => assertIsolatedSourceSummary(summary, job));
    for (const change of [{ file: job.file }, { file: 'tests/unrelated.test.js' }, { status: 'not-run' }, { exitCode: 1 }]) {
      refused(() => assertIsolatedSourceSummary({ ...summary, files: [{ ...summary.files[0], ...change }] }, job));
    }
    refused(() => assertIsolatedSourceSummary({ ...summary, requested: 2 }, job));
    refused(() => assertIsolatedSourceSummary({ ...summary, files: [] }, job));
  }
});


// Actual producer and persisted-job reader with an in-memory filesystem and
// injected native completion. Protocol correspondence, never native evidence.
async function producedLinuxSourceJob(planned = genericEngineJobs().find(job => job.summaryPath), { preservePlan = false } = {}) {
  const expected = preservePlan ? structuredClone(planned) : { ...planned, cleanupGraceMs: 250 };
  const files = new Map(), handles = new Map();
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const here = fileURLToPath(new URL('../lib/adapters', import.meta.url));
  const moduleFile = fileURLToPath(new URL('../lib/transport/linux-owned-job.mjs', import.meta.url));
  const sharedFile = fileURLToPath(new URL('../lib/transport/owned-job.mjs', import.meta.url));
  const tools = { tools: { node: { path: expected.command, bytes: 1, sha256: '1'.repeat(64) },
    python: { path: path.resolve('protocol-python'), bytes: 2, sha256: '2'.repeat(64) } },
    nativeOwner: { helper: { sha256: '3'.repeat(64) } },
    elf: { inputs: {}, runtimeData: {}, ownerLibraries: { fixture: '4'.repeat(64) },
      roots: { ctypes: { path: '/protocol/ctypes', bytes: 1, sha256: '5'.repeat(64) },
        json: { path: '/protocol/json', bytes: 1, sha256: '6'.repeat(64) } },
      resolver: { cache: { path: '/protocol/cache', bytes: 1, sha256: '7'.repeat(64) } } } };
  const pinned = new Map([tools.tools.node, tools.tools.python, ...Object.values(tools.elf.roots), tools.elf.resolver.cache].map(row => [row.path, row]));
  const bytesOf = file => files.has(file) ? files.get(file) : fs.readFileSync(file);
  const identity = file => pinned.get(file) || { path: file, bytes: bytesOf(file).length, sha256: hash(bytesOf(file)) };
  const stat = { dev: 1n, ino: 2n, mode: 0o100600n, nlink: 1n, size: 1n, mtimeNs: 1n, ctimeNs: 1n };
  const memory = {
    constants: fs.constants, lstatSync: () => stat, fstatSync: () => stat,
    openSync(file, flags) { const fd = handles.size + 10; handles.set(fd, file); if (flags === 'wx') files.set(file, Buffer.alloc(0)); return fd; },
    closeSync() {}, mkdirSync() {}, chmodSync() {}, mkdtempSync: prefix => prefix + 'ABC123',
    writeFileSync(file, bytes) { files.set(file, Buffer.from(bytes)); },
    readFileSync(file, encoding) { const bytes = bytesOf(file); return encoding ? bytes.toString(encoding) : bytes; },
  };
  const transcript = 'TAP version 13\nok 1 - protocol result\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n' + (expected.isolatedFiles ? 'STRICT EVIDENCE: ' + expected.isolatedFiles[0] + ' -- reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)\n' : '');
  const native = { quiescent: true, started: true, exitedNormally: true, exitCode: 0, hadRemainingChildren: false };
  const environment = registeredToolEnvironment;
  const context = { fs: memory, path, process: { platform: 'linux', arch: 'x64', hrtime: process.hrtime },
    Date, Buffer, structuredClone, identity, MODULE: moduleFile, LOADED_IMPLEMENTATION: identity(moduleFile),
    MAX_OUTPUT: 64 * 1024 * 1024, LINUX_GIT: '/protocol/git', LINUX_XZ: '/protocol/xz',
    positive(value, maximum) { assert.ok(Number.isSafeInteger(value) && value > 0 && value <= maximum); },
    privateDirectory: value => value, plainPath: value => value,
    contains: (root, value) => value === root || value.startsWith(root + path.sep),
    measureLinuxToolchain: () => tools, capturedOwner: () => ({}), ownedJobImplementationIdentity: () => identity(sharedFile),
    digestRecord, measureFile: file => { const { path: ignored, ...value } = identity(file); return value; },
    registeredToolEnvironment: environment, sameGeneration: (a, b) => a === b,
    acquireOwnedExecution: () => ({ annotate() {}, confirmedCleanup() {}, quarantine: error => error }),
    async execute(job, outputs) {
      memory.writeFileSync(handles.get(outputs[0]), transcript); memory.writeFileSync(handles.get(outputs[1]), '');
      return { receipt: native, complete: true, cleanupConfirmed: true, notRun: false,
        timedOut: false, outputLimitExceeded: false, cancelled: false, error: null,
        streams: outputs.map(fd => identity(handles.get(fd))) };
    },
  };
  // Production record construction and serialization retains the Linux
  // environment object, nativeOwnerLaunch, transport and fixed limit fields.
  const source = fs.readFileSync(moduleFile, 'utf8');
  vm.runInNewContext(['writeRecord', 'runLinuxOwnedJobBatch'].map(name => declaredFunctionSource(source.replace(/^export /gm, ''), name)).join('\n'), context);
  const [record] = await context.runLinuxOwnedJobBatch({ jobs: [expected], evidenceRoot: directory });
  if (expected.summaryPath) memory.writeFileSync(expected.summaryPath, JSON.stringify({ requested: 1, files: [{ file: path.relative(expected.cwd, expected.file).replaceAll('\\', '/'), status: 'pass', exitCode: 0 }] }));

  const consumerSource = fs.readFileSync(new URL('../lib/adapters/source-suites.mjs', import.meta.url), 'utf8');
  const consumer = { ...sourceExecutor, path, fs: memory, process: { platform: 'linux' },
    HERE: here, NATIVE_CUSTODY_ACTION: { id: 'engine:native-custody' },
    json: JSON.stringify, canonicalDigest: digestRecord, digest: digestRecord, identity, fileIdentity: identity,
    inside: context.contains, fencedPath: value => value, unlinkedPath: value => value,
    readJson: file => JSON.parse(memory.readFileSync(file, 'utf8')), registeredToolEnvironment: environment,
    fail: message => { const error = Error('Source qualification incomplete: ' + message); error.code = 'SOURCE_QUALIFICATION_INCOMPLETE'; throw error; } };
  for (const name of ['assertLinuxSourceProcessEvidence', 'assertNativeCustodyLinuxProcessEvidence', 'verifyJob']) {
    if (consumerSource.includes('function ' + name + '(')) vm.runInNewContext(declaredFunctionSource(consumerSource.replace(/^export /gm, ''), name), consumer);
  }
  function persist(value) {
    const { record: location, ...raw } = value;
    memory.writeFileSync(location.path, JSON.stringify(raw, null, 2) + '\n');
    value.record = identity(location.path); return value;
  }
  function alterRaw(value, key, change) {
    const contents = JSON.parse(memory.readFileSync(value[key].path, 'utf8')); change(contents);
    memory.writeFileSync(value[key].path, JSON.stringify(contents)); value[key] = identity(value[key].path); return persist(value);
  }
  return { expected, record, native, tools, files, memory, persist, alterRaw,
    verify: value => consumer.verifyJob(value, expected, directory, tools),
    verifyProcess: value => consumer.assertLinuxSourceProcessEvidence(value,
      JSON.parse(memory.readFileSync(value.nativeResult.path, 'utf8')),
      JSON.parse(memory.readFileSync(value.launchSpec.path, 'utf8')), expected, tools) };
}

test('generic Linux execution records reach the actual persisted source verifier and summary gate', async () => {
  const fixture = await producedLinuxSourceJob();
  let measured;
  assert.doesNotThrow(() => { measured = fixture.verify(fixture.record); });
  assert.equal(measured.tests, 1);
  assert.equal(measured.failed, 0);
  fixture.memory.writeFileSync(fixture.expected.summaryPath, JSON.stringify({ requested: 1,
    files: [{ file: 'tests/another-source.js', status: 'pass', exitCode: 0 }] }));
  refused(() => fixture.verify(fixture.record));
});

test('generic Linux persisted evidence refuses altered custody, bytes, environment and invocation', async () => {
  for (const mutate of [
    (f, r) => { r.transport.sharedSha256 = 'f'.repeat(64); return f.persist(r); },
    (f, r) => { r.nativeOwnerLaunch.descriptor = 9; return f.persist(r); },
    (f, r) => { r.cleanupConfirmed = 'true'; return f.persist(r); },
    (f, r) => { r.limits.cleanupGraceMs = 500; return f.persist(r); },
    (f, r) => { r.command.push('--different'); return f.persist(r); },
    (f, r) => f.alterRaw(r, 'nativeResult', raw => { raw.quiescent = false; }),
    (f, r) => f.alterRaw(r, 'nativeResult', raw => { raw.hadRemainingChildren = true; }),
    (f, r) => f.alterRaw(r, 'launchSpec', raw => { raw.jobs[0].environment.CALLER_AUTHORITY = 'yes'; }),
    (f, r) => f.alterRaw(r, 'launchSpec', raw => { raw.jobs[0].sourceBinding = { caller: 'foreign' }; }),
    (f, r) => { f.memory.writeFileSync(r.stdout.path, 'substituted bytes'); return r; },
    (f, r) => { r.stdout.path = path.resolve('foreign-evidence/stdout'); return r; },
  ]) {
    const fixture = await producedLinuxSourceJob();
    // A successful actual producer/consumer pair precedes each mutation;
    // rejecting every input cannot pass these controls.
    assert.doesNotThrow(() => assert.equal(fixture.verify(fixture.record).tests, 1));
    refused(() => fixture.verify(mutate(fixture, structuredClone(fixture.record))));
  }
});


test('generic Linux App jobs retain the actual measured source environment binding', async () => {
  const appRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const record = fs.readFileSync(path.join(appRoot, 'private/capability-source.owner.json'));
  const source = JSON.parse(record);
  const strictInputs = { root: appRoot, canonicalRoot: source.path, appRef: 'a'.repeat(40), engineRef: source.ref,
    sourceRecord: { bytes: record.length, sha256: createHash('sha256').update(record).digest('hex') } };
  const [planned] = planSourceSuiteJobs({ id: 'app', root: appRoot, canonicalRoot: source.path,
    files: ['tools/test/engine-performance-source.test.mjs'], crossFiles: [], commands: [] }, directory, { strictInputs });
  const fixture = await producedLinuxSourceJob(planned);
  assert.doesNotThrow(() => assert.equal(fixture.verify(fixture.record).tests, 1));
  const changed = fixture.alterRaw(structuredClone(fixture.record), 'launchSpec',
    raw => { raw.jobs[0].sourceBinding.appRef = 'b'.repeat(40); });
  refused(() => fixture.verify(changed));
});


// Evaluate the actual platform branches with ordinary existing source paths.
// No component, shell runner, native owner, directory or profile is launched.
function contextualPlannerJobs(platform) {
  const appRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const record = fs.readFileSync(path.join(appRoot, 'private/capability-source.owner.json'));
  const source = JSON.parse(record);
  const strictInputs = { root: appRoot, canonicalRoot: source.path, appRef: 'a'.repeat(40), engineRef: source.ref,
    sourceRecord: { bytes: record.length, sha256: createHash('sha256').update(record).digest('hex') } };
  const roleSource = fs.readFileSync(new URL('../lib/adapters/role-studio-source.mjs', import.meta.url), 'utf8');
  const plannerSource = fs.readFileSync(new URL('../lib/adapters/source-suites.mjs', import.meta.url), 'utf8');
  const context = { path, process: { platform }, plainPath, contains, registeredToolPaths, registeredToolEnvironment,
    structuredClone, ROLE_STUDIO_SOURCE_ACTION, MAX_REPORT: 1024 * 1024,
    DRIVER: ROLE_STUDIO_SOURCE_ACTION.command[1], REF: /^[a-f0-9]{40}$/,
    NODE: registeredToolPaths().node, json: JSON.stringify,
    fail: message => { throw Error(message); } };
  vm.runInNewContext(['binding', 'planRoleStudioSourceJob'].map(name =>
    declaredFunctionSource(roleSource.replace(/^export /gm, ''), name)).join('\n'), context);
  vm.runInNewContext(declaredFunctionSource(plannerSource, 'jobsAtBundle'), context);
  const bundle = fileURLToPath(new URL('../lib', import.meta.url));
  // The planner only inspects this existing parent; the proposed child is not created.
  const parent = os.tmpdir();
  const [role] = context.jobsAtBundle({ id: 'app', root: appRoot, canonicalRoot: source.path,
    files: [], crossFiles: [], commands: [ROLE_STUDIO_SOURCE_ACTION] }, parent, { strictInputs }, bundle);
  const [shell] = context.jobsAtBundle({ id: 'shell', root: appRoot }, parent, {}, bundle);
  return { role: structuredClone(role), shell: structuredClone(shell) };
}

test('Role Studio Linux plan reaches real admission and preserves its limits in produced custody', async () => {
  const { role } = contextualPlannerJobs('linux');
  const { run, admitted } = linuxAdmission();
  await assert.rejects(run({ jobs: [role], evidenceRoot: directory }), error => error === admitted);
  const fixture = await producedLinuxSourceJob(role, { preservePlan: true });
  assert.doesNotThrow(() => fixture.verifyProcess(fixture.record));
  assert.deepEqual(structuredClone(fixture.record.limits), {
    timeoutMs: ROLE_STUDIO_SOURCE_ACTION.timeoutMs, maxOutputBytes: 1024 * 1024,
    cleanupMs: 5000, cleanupGraceMs: 250 });
  // Custody correspondence cannot substitute the required component evidence.
  refused(() => fixture.verify(fixture.record));
  const wrong = { ...role, cleanupGraceMs: 500 };
  await assert.rejects(run({ jobs: [wrong], evidenceRoot: directory }), /fixed at 250 ms/);
});

test('shell Linux plan survives the actual producer and persisted verifier without filled-in planner limits', async () => {
  const { shell } = contextualPlannerJobs('linux');
  const fixture = await producedLinuxSourceJob(shell, { preservePlan: true });
  assert.doesNotThrow(() => assert.equal(fixture.verify(fixture.record).tests, 1));
  assert.deepEqual(structuredClone(fixture.record.limits), {
    timeoutMs: 30000, maxOutputBytes: 8 * 1024 * 1024, cleanupMs: 5000, cleanupGraceMs: 250 });
  for (const missing of ['maxOutputBytes', 'cleanupMs', 'cleanupGraceMs']) {
    const incomplete = { ...shell }; delete incomplete[missing];
    const control = await producedLinuxSourceJob(incomplete, { preservePlan: true });
    refused(() => control.verify(control.record));
  }
});

test('contextual platform branches preserve Role Studio and implicit Windows shell transport budgets', () => {
  const { role, shell } = contextualPlannerJobs('win32');
  assert.equal(role.cleanupGraceMs, 500);
  assert.equal(role.cleanupMs, 5000);
  assert.equal(role.maxOutputBytes, 1024 * 1024);
  // These were the Windows transport defaults for the shell's omitted fields.
  assert.equal(shell.cleanupGraceMs ?? 300, 300);
  assert.equal(shell.cleanupMs ?? 5000, 5000);
  assert.equal(shell.maxOutputBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024);
  assert.equal(shell.timeoutMs, 30000);
  assert.deepEqual(shell.env, { QUALIFICATION_SHELL_ROOT: shell.cwd });
  assert.equal(shell.args.at(-1), fileURLToPath(new URL('../lib/runners/shell-source.mjs', import.meta.url)));
});
