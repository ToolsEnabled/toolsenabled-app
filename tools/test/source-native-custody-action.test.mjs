import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs';
import { canonicalRootForTests } from '../canonical-root.mjs';
import { digestRecord } from '../lib/adapters/artifact-files.mjs';
import { parseSourceOutput, planSourceSuiteJobs, inspectSourceSuite,
  runNativeCustodySourceAction, verifyNativeCustodySourceAction, assertNativeCustodyLinuxProcessEvidence,
  assertNativeCustodySingleJob } from '../lib/adapters/source-suites.mjs';
import { registeredToolEnvironment, fileIdentity } from '../lib/transport/owned-job.mjs';
import { SOURCE_COMMAND_ACTIONS, SOURCE_RUNNER_REQUIREMENTS } from '../lib/adapters/source-suite-manifests.mjs';
import { assertNativeCustodyEvidence, nativeCustodyInputs, nativeCustodyArguments } from '../lib/runners/native-custody-source.mjs';

// Captured assertion vocabulary from the real 6f710 Linux leaf execution.
// This fixture is not produced by the action's parser/manifest.
const linuxBody = "PASS explicit vault boundary unit cases (real Linux custody integration follows)\nPASS fixed Linux startup hygiene proves no-store without D-Bus and refuses unknown/unsafe stores or another key\nPASS real vault, lock, metadata-log and backing-file FIFOs never block, consume, or rewrite fixture bytes\nPASS real isolated libsecret backend is available without an application vault\nPASS one real persistent helper serves warm requests, is reaped on close and restarts cleanly\nPASS audit shutdown drains queued native readers and confirms helper exit\nPASS production runtime persists and reopens encrypted credentials across processes\nPASS concurrent real disconnects remove exactly one authenticated device credential and preserve machine identity\nPASS native disposable pre/at/post-replace and lost-receipt faults preserve truthful mutation evidence; not power-loss proof\nPASS existing native vault hygiene requires trusted custody and refuses protected records without decryption\nPASS asynchronous desktop reads bind an explicit state root without blocking or changing process.env\nPASS coupled writes, definite absence, and oracle refusals use the production backend\nPASS auth-profile lifecycle uses real isolated Linux custody; authenticated browsing remains unavailable\nPASS six real concurrent processes choose exactly one creation candidate\nPASS monotonic writes refuse rollback, forks, and mismatched embedded sequences\nPASS kernel locking refuses contention and releases after the lock holder dies\nPASS real ciphertext tampering, record substitution, unsafe files, and foreign formats refuse\nPASS real Ed25519 audit survives restart and refuses a rolled-back ledger\nPASS vault credentials and signed audit survive a full private GNOME daemon restart\nPASS a missing service key is unreadable and is never silently replaced\nPASS locking the real keyring invalidates warm reads and signed-audit admission; no plaintext reached disk\nPASS a real passwordless GNOME keyring is refused as unsafe";
const windowsName = 'native Windows vault preserves DPAPI format and rechecks changed DACLs and reparse points';
const windowsBody = `TAP version 13
# Subtest: ${windowsName}
ok 1 - ${windowsName}
  ---
  duration_ms: 122.1
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 300.2`;
const action = SOURCE_COMMAND_ACTIONS.engine.find(row => row.id === 'engine:native-custody');
const leaves = { linux: 'tests/linux-vault.test.js', win32: 'tests/vault-native.test.js' };
const PREFIX = 'NATIVE CUSTODY RECEIPT: ', CONTEXT = 'NATIVE CUSTODY CONTEXT: ';
function fixture(platform = 'linux') {
  const root = path.resolve('parser-only-engine'), directory = path.resolve('parser-only-evidence');
  const inputs = Object.fromEntries(action.measuredInputs.map((file, index) => [file,
    { bytes: index + 1, sha256: (index + 1).toString(16).padStart(64, '0') }]));
  const binding = { root, directory, scratch: path.join(directory, 'nc'), platform, inputs, inputsSha256: digestRecord(inputs) };
  const other = platform === 'linux' ? 'win32' : 'linux';
  const receipt = { schema: 'toolsenabled.native-custody-source-execution', platform,
    selected: { file: leaves[platform], sha256: inputs[leaves[platform]].sha256 },
    exitCode: 0, signal: null, errorCode: null, cleanupConfirmed: true, inputsUnchanged: true, passed: true,
    companion: [{ platform: other, file: leaves[other], sha256: inputs[leaves[other]].sha256, status: 'unexecuted' }],
    authority: 'Per-host source execution only; paired exact-source native receipts and installed qualification remain required.' };
  const context = { schema: 'toolsenabled.native-custody-source-context', root, scratch: binding.scratch,
    inputsSha256: binding.inputsSha256, inputsUnchanged: true, exitCode: 0, signal: null, errorCode: null, cleanupConfirmed: true };
  const body = platform === 'linux' ? linuxBody : windowsBody;
  const marker = `STRICT EVIDENCE: ${leaves[platform]} -- ${platform === 'linux'
    ? 'process-exit; assertion count not reported' : 'reconciled-tap; 1 passed; 0 UNEXECUTED (within-suite skips)'}`;
  return { binding, receipt, context, body, marker,
    options: { actionId: action.id, reporter: action.reporter, file: action.command[1], cwd: root, custodyBinding: binding } };
}
const output = row => [row.body, row.marker, PREFIX + JSON.stringify(row.receipt), CONTEXT + JSON.stringify(row.context), ''].join('\n');
const refused = row => assert.throws(() => parseSourceOutput(output(row), '', row.options), /Source qualification incomplete/);

test('fixed native action parses actual Linux phases and Windows TAP without inventing leaf counts or companion execution', () => {
  for (const platform of ['linux', 'win32']) {
    const row = fixture(platform);
    for (const text of [output(row), output(row).replaceAll('\n', '\r\n')]) {
      assert.deepEqual(parseSourceOutput(text, '', row.options),
        { tests: 0, passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0, notRun: 0 });
    }
    assert.equal(row.receipt.companion[0].status, 'unexecuted');
  }
});

test('Linux refuses footer-only, omitted, reordered, duplicate, unknown and failing native phases', () => {
  const lines = linuxBody.split('\n');
  for (const body of [lines.at(-1), '', lines.slice(1).join('\n'), [...lines].reverse().join('\n'),
    [...lines, lines[0]].join('\n'), linuxBody + '\nPASS invented custody', linuxBody + '\nFAIL custody',
    linuxBody.replace(lines[7], 'TODO mutation coverage'), linuxBody.replace('PASS audit shutdown', 'FAIL audit shutdown')]) {
    refused({ ...fixture(), body });
  }
});

test('Windows refuses a renamed case, extra case, skipped case and incomplete or contradictory TAP', () => {
  for (const body of [windowsBody.replaceAll(windowsName, 'unrelated smoke test'), windowsBody.replace('ok 1 -', 'not ok 1 -'),
    windowsBody.replace('ok 1 - ' + windowsName, 'ok 1 - ' + windowsName + ' # SKIP another OS'),
    windowsBody.replace('1..1', '1..2'), windowsBody.replace('# fail 0', '# fail 1'), windowsBody.replace('# tests 1\n', ''),
    windowsBody.replace('1..1', 'ok 2 - extra\n1..2').replace('# tests 1', '# tests 2').replace('# pass 1', '# pass 2'),
    windowsBody + '\nFAIL admission', windowsBody + '\n# Error: custody', windowsBody + '\nPASS invented',
    windowsBody + '\nTAP version 13']) {
    refused({ ...fixture('win32'), body });
  }
});

test('native execution, cleanup, hash and companion fields must all agree with measured selection', () => {
  const mutations = [
    row => row.receipt.exitCode = 7, row => row.receipt.signal = 'SIGTERM', row => row.receipt.errorCode = 'ENOBUFS',
    row => row.receipt.cleanupConfirmed = false, row => row.receipt.inputsUnchanged = false, row => row.receipt.passed = false,
    row => row.receipt.selected.sha256 = 'f'.repeat(64), row => row.receipt.selected.file = leaves.win32,
    row => row.receipt.platform = 'win32', row => row.receipt.companion = [],
    row => row.receipt.companion[0].status = 'passed', row => row.receipt.companion[0].sha256 = 'f'.repeat(64),
    row => row.receipt.extra = true, row => row.receipt.authority = 'release qualified',
    row => row.context.exitCode = 2, row => row.context.signal = 'SIGKILL', row => row.context.errorCode = 'ENOBUFS',
    row => row.context.cleanupConfirmed = false, row => row.context.inputsUnchanged = false,
    row => row.context.inputsSha256 = 'f'.repeat(64), row => row.context.root += '-other',
    row => row.context.scratch += '-other', row => row.context.schema = 'caller-pass',
  ];
  for (const change of mutations) { const row = fixture(); change(row); refused(row); }
});

test('receipt boundaries and isolated child completion cannot be truncated, duplicated or replaced', () => {
  const row = fixture(), text = output(row);
  for (const changed of [
    text.trimEnd(), text + 'extra\n', text + CONTEXT + JSON.stringify(row.context) + '\n',
    text.replace(PREFIX, PREFIX + '{'), text.replace(PREFIX, 'wrong receipt: '),
    text.replace('{"schema":', '{"schema":"duplicate","schema":'),
    text.replace(row.marker + '\n', ''), text.replace(row.marker, row.marker + '\n' + row.marker),
    text.replace(row.marker, row.marker.replace(leaves.linux, leaves.win32)),
    text.replace(PREFIX, PREFIX + JSON.stringify(row.receipt) + '\n' + PREFIX),
  ]) assert.throws(() => parseSourceOutput(changed, '', row.options));
  assert.throws(() => parseSourceOutput(text, 'unexplained stderr', row.options));
  assert.throws(() => parseSourceOutput(text, '', { ...row.options, custodyBinding: undefined }));
  assert.throws(() => parseSourceOutput(text, '', { ...row.options, actionId: 'caller-selected' }));
});

test('binding rejects missing and changed measured helper inputs', () => {
  for (const change of [
    row => delete row.binding.inputs['tests/lib/isolated-child.js'],
    row => row.binding.inputs['tests/lib/isolated-child.js'].sha256 = 'f'.repeat(64),
    row => row.binding.inputs['caller.js'] = { bytes: 1, sha256: 'f'.repeat(64) },
    row => row.binding.inputs['tests/lib/isolated-child.js'].bytes = 0,
    row => row.binding.scratch = '/tmp',
  ]) { const row = fixture(); change(row); refused(row); }
});

test('planner binds fixed wrapper and both exact leaves while keeping other source blockers', () => {
  const selection = inspectSourceSuite('engine', { sourceRoots: { engine: canonicalRootForTests() } });
  const planned = planSourceSuiteJobs(selection, path.resolve('planning-only-evidence'));
  const job = planned.find(row => row.actionId === action.id);
  assert.ok(job);
  assert.deepEqual(job.args, nativeCustodyArguments(selection.root, job.custodyBinding.directory));
  assert.equal(job.custodyBinding.platform, process.platform);
  assert.equal(job.cleanupGraceMs, process.platform === 'linux' ? 250 : 500, 'registered native cleanup policy');
  assert.deepEqual(job.custodyBinding.inputs, nativeCustodyInputs(selection.root));
  for (const file of Object.values(leaves)) assert.ok(selection.files.includes(file));
  const requirement = SOURCE_RUNNER_REQUIREMENTS.engine.find(row => row.runner === action.command[1]);
  assert.deepEqual(requirement.requiredPlatforms, { linux: [leaves.linux], win32: [leaves.win32] });
  assert.equal(selection.complete, false);
  assert.ok(selection.obligations.some(row => row.id === 'empty-required-alias' && row.alias === 'test:provider-release'));
  assert.ok(!selection.obligations.some(row => row.id === 'unmapped-required-command' && row.alias === 'test:key-custody'));
});

const runner = fileURLToPath(new URL('../lib/runners/native-custody-source.mjs', import.meta.url));
function privateFixture(fn) {
  const directory = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'nc-'));
  fs.chmodSync(directory, 0o700);
  try { return fn(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test('actual wrapper refuses unsafe/relative paths, extra arguments and wrong inputs before loading the native child', () => privateFixture(directory => {
  const root = path.join(directory, 'engine'), evidence = path.join(directory, 'e');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(evidence, { mode: 0o700 });
  for (const file of action.measuredInputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, file), '// bounded input fixture\n');
  }
  // Safe continuation deliberately refuses in the fixed helper, before any
  // native work. This is a context test, never a custody qualification claim.
  fs.writeFileSync(path.join(root, 'tests/lib/isolated-child.js'), "throw Error('CONTEXT_REACHED_FIXED_HELPER');\n");
  const args = nativeCustodyArguments(root, evidence);
  const run = argv => spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 5000, env: process.env });
  for (const argv of [
    [...args, '--command', 'caller'], [...args.slice(0, -1), 'f'.repeat(64)],
    args.map((value, index) => index === 2 ? path.relative(process.cwd(), root) : value),
    args.map((value, index) => index === 4 ? path.relative(process.cwd(), evidence) : value),
  ]) {
    const result = run(argv);
    assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, /CONTEXT_REACHED_FIXED_HELPER/);
  }
  if (process.platform === 'linux') {
    fs.chmodSync(evidence, 0o770);
    assert.equal(run(args).status, 2); assert.equal(fs.statSync(evidence).mode & 0o777, 0o770);
    fs.chmodSync(evidence, 0o700);
    const link = path.join(directory, 'linked'); fs.symlinkSync(evidence, link);
    assert.equal(run(args.map((value, index) => index === 4 ? link : value)).status, 2);
    fs.chmodSync(directory, 0o775);
    assert.doesNotMatch(run(args).stderr, /CONTEXT_REACHED_FIXED_HELPER/);
    fs.chmodSync(directory, 0o700);
  }
  const result = run(args);
  // Short Unix socket roots are a native prerequisite; long ordinary test
  // output paths must refuse early instead of manufacturing a continuation.
  if (process.platform === 'linux' && Buffer.byteLength(path.join(evidence, 'nc')) + 56 >= 100) {
    assert.match(result.stderr, /native scratch path is too long/);
    assert.equal(fs.existsSync(path.join(evidence, 'nc')), false);
  } else {
    assert.match(result.stderr, /CONTEXT_REACHED_FIXED_HELPER/);
    const scratch = path.join(evidence, 'nc');
    const entry = fs.lstatSync(scratch);
    // True on every platform: the wrapper makes its own fresh directory rather
    // than adopting whatever already sat at that name.
    assert.equal(entry.isDirectory(), true);
    assert.equal(entry.isSymbolicLink(), false, 'the scratch must be a real directory, never a link');
    assert.equal(path.dirname(scratch), evidence, 'the scratch stays inside the owned evidence root');
    assert.deepEqual(fs.readdirSync(scratch), [], 'a fresh scratch is created, never reused');
    if (process.platform === 'linux') {
      assert.equal(entry.mode & 0o777, 0o700);
    } else {
      // Windows narrows nothing here, and asserting 0o700 said otherwise.
      // node ignores mkdir's mode outside the read-only bit, and
      // assertNativeCustodyEvidence() gates its whole ownership/permission
      // walk on `process.platform === 'linux'`, so this directory simply
      // inherits its parent's ACL -- measured 0o666 through node's stat.
      // Pin that, so a real Windows narrowing step has to update this line
      // rather than quietly satisfying an assertion that was never about it.
      assert.equal(entry.mode & 0o777, 0o666,
        'no ACL step runs on Windows; the scratch inherits the evidence root');
    }
  }
  assert.equal(result.status, 2);
}));

test('Linux evidence fence rejects foreign owners and writable ancestors even when the leaf is private', () => {
  // Execute the actual fence function against explicit ordinary ancestry to
  // exercise ownership without chown, sudo, or touching another account.
  const fence = vm.runInNewContext('(' + assertNativeCustodyEvidence.toString() + ')', {
    path: path.posix, plainPath: value => value,
    process: { platform: 'linux', getuid: () => 1000 },
    fail: message => { throw Error(message); },
    fs: { lstatSync: file => ({ isDirectory: () => true, isSymbolicLink: () => false,
      uid: file === '/safe' ? 1001 : file === '/' ? 0 : 1000,
      mode: file === '/' ? 0o755 : 0o700 }) },
  });
  assert.throws(() => fence('/safe/private'), /unsafe evidence ancestry/);
  const writable = vm.runInNewContext('(' + assertNativeCustodyEvidence.toString() + ')', {
    path: path.posix, plainPath: value => value, process: { platform: 'linux', getuid: () => 1000 },
    fail: message => { throw Error(message); },
    fs: { lstatSync: file => ({ isDirectory: () => true, isSymbolicLink: () => false,
      uid: file === '/' ? 0 : 1000, mode: file === '/safe' ? 0o775 : file === '/' ? 0o755 : 0o700 }) },
  });
  assert.throws(() => writable('/safe/private'), /unsafe evidence ancestry/);
});


// Synthetic protocol facts exercise the decoder on either test host. They
// never become a source report, native receipt, replay or readiness verdict.
test('Linux process facts bind both transports, retained owner, argv, environment, limits and natural closure', () => {
  const tools = { tools: { node: { path: process.execPath, bytes: 1, sha256: '1'.repeat(64) },
    python: { path: path.resolve('fixture-python'), bytes: 2, sha256: '2'.repeat(64) } },
    nativeOwner: { helper: { sha256: '3'.repeat(64) } }, elf: { ownerLibraries: { fixture: '4'.repeat(64) } } };
  const expected = { actionId: action.id, custodyBinding: { platform: 'linux' }, command: process.execPath,
    args: [runner], cwd: path.dirname(runner), env: { TOOLSENABLED_TEST_STRICT: '1' },
    timeoutMs: 610000, maxOutputBytes: 8 * 1024 * 1024, cleanupMs: 5000, cleanupGraceMs: 250 };
  const environment = registeredToolEnvironment(expected.env, { cwd: expected.cwd });
  const limits = { timeoutMs: expected.timeoutMs, maxOutputBytes: expected.maxOutputBytes, cleanupMs: 5000, cleanupGraceMs: 250 };
  const transportHash = name => fileIdentity(fileURLToPath(new URL('../lib/transport/' + name, import.meta.url))).sha256;
  const record = { schema: 'toolsenabled.owned-job-execution', schemaVersion: 1,
    complete: true, exitCode: 0, cleanupConfirmed: true, signal: null, notRun: false, error: null,
    timedOut: false, outputLimitExceeded: false, hadRemainingChildren: false, jobIndex: 0,
    transport: { sha256: transportHash('linux-owned-job.mjs'), sharedSha256: transportHash('owned-job.mjs'),
      helperSha256: tools.nativeOwner.helper.sha256, toolchain: tools },
    nativeOwnerLaunch: { executable: tools.tools.python, descriptor: 10,
      mechanism: 'retained-executable-with-protected-kernel-resolution',
      systemLibraries: tools.elf.ownerLibraries, sourceSha256: tools.nativeOwner.helper.sha256 },
    executable: tools.tools.node, command: [expected.command, ...expected.args], cwd: expected.cwd,
    limits, environmentSha256: digestRecord(environment) };
  const native = { quiescent: true, started: true, exitedNormally: true, exitCode: 0, hadRemainingChildren: false };
  const spec = { batchTimeoutMs: 650000, jobs: [{ command: expected.command, args: expected.args, cwd: expected.cwd,
    git: false, xz: false, sourceMetadata: null, compressedInput: null, executable: tools.tools.node,
    environment, ...limits, expectedProfile: '' }] };
  assert.equal(assertNativeCustodyLinuxProcessEvidence(record, native, spec, expected, tools), undefined);
  for (const mutate of [
    row => row[0].complete = false, row => row[0].cleanupConfirmed = 'true',
    row => row[0].signal = 'SIGTERM', row => row[0].outputLimitExceeded = true,
    row => row[0].transport.sha256 = 'f'.repeat(64), row => row[0].transport.sharedSha256 = 'f'.repeat(64),
    row => row[0].transport.helperSha256 = 'f'.repeat(64), row => row[0].nativeOwnerLaunch.descriptor = 9,
    row => row[0].nativeOwnerLaunch.executable.sha256 = 'f'.repeat(64),
    row => row[0].nativeOwnerLaunch.mechanism = 'process-list-guess',
    row => row[0].command.push('--caller-override'), row => row[0].cwd += '-other',
    row => row[0].executable.sha256 = 'f'.repeat(64), row => row[0].jobIndex = 1,
    row => row[0].limits.cleanupGraceMs = 500, row => row[0].environmentSha256 = 'f'.repeat(64),
    row => row[0].nativeBatchResult = { cleanupConfirmed: true },
    row => row[1].quiescent = false, row => row[1].started = false,
    row => row[1].exitedNormally = false, row => row[1].hadRemainingChildren = true,
    row => row[1].exitCode = 7, row => row[1].processCreated = true,
    row => row[2].jobs[0].environment.CALLER_AUTHORITY = 'yes', row => row[2].jobs[0].args.push('another-test'),
    row => row[2].jobs[0].sourceMetadata = 'caller', row => row[2].jobs[0].expectedProfile = 'elevated',
    row => row[2].jobs[0].timeoutMs = 1, row => row[2].batchTimeoutMs = 1,
  ]) {
    const changed = [structuredClone(record), structuredClone(native), structuredClone(spec)];
    mutate(changed);
    assert.throws(() => assertNativeCustodyLinuxProcessEvidence(...changed, expected, tools), /Source qualification incomplete/);
  }
});

test('standalone custody refuses an original batch containing extra or differently indexed work', () => {
  const record = { jobIndex: 0 }, spec = { batchTimeoutMs: 650000, jobs: [{ args: ['fixed-custody'] }] };
  assert.doesNotThrow(() => assertNativeCustodySingleJob(record, spec));
  assert.doesNotThrow(() => assertNativeCustodySingleJob(record, spec, { attempted: 1 }));
  for (const nativeBatch of [{ attempted: 2 }, { attempted: 0 }, { attempted: '1' }, {}, null])
    assert.throws(() => assertNativeCustodySingleJob(record, spec, nativeBatch), /exactly one original job/);
  for (const [actual, launch] of [
    [{ jobIndex: 1 }, { ...spec, jobs: [{ args: ['unrelated'] }, ...spec.jobs] }],
    [record, { ...spec, jobs: [...spec.jobs, { args: ['unrelated'] }] }],
    [{ jobIndex: '0' }, spec], [{ jobIndex: null }, spec], [record, { ...spec, jobs: [] }],
    [record, { ...spec, jobs: null }], [record, { ...spec, batchTimeoutMs: 640000 }],
  ]) assert.throws(() => assertNativeCustodySingleJob(actual, launch), /exactly one original job/);
});

test('scoped verifier refuses absent provenance before selecting a native replay', async () => {
  const directory = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 'nc-'));
  fs.chmodSync(directory, 0o700);
  try {
    const sourceRoot = canonicalRootForTests(), sourceRef = 'a'.repeat(40);
    const report = { schema: 'toolsenabled.native-custody-action', schemaVersion: 1,
      scope: 'native-custody-source-action', ready: false, platform: process.platform, arch: process.arch,
      companion: { platform: process.platform === 'linux' ? 'win32' : 'linux', status: 'unexecuted' },
      authority: 'Selected native source action only; complete source, paired native replay and installed qualification remain required.',
      sourceRoot, sourceRef, provenance: null, afterProvenance: null };
    const file = path.join(directory, 'null-provenance.json');
    fs.writeFileSync(file, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
    await assert.rejects(verifyNativeCustodySourceAction(fileIdentity(file),
      { sourceRoot, sourceRef, evidenceRoot: directory }), /changed source provenance/);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('n-')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('public scoped execution refuses command, transport and platform overrides before native work', async () => {
  for (const key of ['command', 'args', 'platform', 'harnessRoot', 'runner', 'verify', 'env', 'expectedProvenance']) {
    await assert.rejects(runNativeCustodySourceAction({ [key]: 'caller' }), /exact source inputs/);
    await assert.rejects(verifyNativeCustodySourceAction({}, { [key]: 'caller' }), /exact source inputs/);
  }
});
