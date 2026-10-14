import { requiredNativeSourceCases, sourceCaseExecutionRequirement } from '../lib/adapters/source-command-plan.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fixture } from './helpers/linux-qualification-transport-fixture.mjs';
import { measureTree, digestRecord } from '../lib/adapters/artifact-files.mjs';
import { LINUX_MEASUREMENT_PATHS } from '../lib/guest/linux-installed-measurement.mjs';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const worker = fileURLToPath(new URL('./helpers/linux-installed-measurement-guest.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const refusal = { code: 'LINUX_INSTALLED_MEASUREMENT_REFUSED' };

const linux = { skip: process.platform === 'linux' && process.arch === 'x64' && process.getuid() > 0
  ? false : 'Requires the owning non-root Linux x64 account; required Linux case remains unexecuted' };

const REQUIRED_CASES = [
  [
    "tools/test/linux-installed-measurement.test.mjs",
    "typed measurement executes the actual fixed-root reader and refuses unbound evidence"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "synthetic transport positive control preserves nonce/profile and unqualified state"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "synthetic replay control refuses a changed nonce"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "standard request must refuse a privileged response role"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "changed base image bytes must refuse before admission"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "QMP and RPC endpoints must belong to the declared process"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "a later attestation must retain the initially measured machine identity"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "artifact input share must not resolve outside the dedicated machine root"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "changed process start refuses the next request"
  ],
  [
    "tools/test/linux-qualification-transport-bindings.test.mjs",
    "invalid command/profile bounds refuse without RPC dispatch"
  ],
  [
    "tools/test/linux-qualification-artifact-staging.test.mjs",
    "linked artifact input refuses before creating anything outside the machine root"
  ]
];
test('accepted Linux measurement and transport cases retain exact companion obligations', () => {
  const files = [...new Set(REQUIRED_CASES.map(([file]) => file))];
  assert.deepEqual(requiredNativeSourceCases('app', files), REQUIRED_CASES.map(([file, testName]) =>
    ({ suite: 'app', file, testName, requiredPlatform: 'linux' })));
  for (const [file, testName] of REQUIRED_CASES) for (const platform of ['linux', 'win32']) {
    const requirement = sourceCaseExecutionRequirement({ suite: 'app', files: [file], testName, platform });
    assert.deepEqual(requirement, { kind: platform === 'linux' ? 'native-prerequisite-unmet' : 'companion-platform-required',
      suite: 'app', file, testName, requiredPlatform: 'linux', status: 'unexecuted' });
  }
  assert.equal(sourceCaseExecutionRequirement({ suite: 'app', files, testName: 'unregistered Linux case',
    platform: 'win32' }).kind, 'unmapped-execution-prerequisite');
});

test('typed measurement executes the actual fixed-root reader and refuses unbound evidence', linux, async t => {
  let root, measurementRoot, guestRoot, calls = 0, editReply, rawReply, mutateAfterRead, mutateAfterProducer, observedUid, clockOffsetMs, abortAfterProducer;
  const outputs = [];
  const f = await fixture({ execResult(request) {
    if (request.argv.join(' ') === 'id -u') return { exitCode: 0, stdout: '1000\n', stderr: '', role: request.role };
    calls++;
    assert.equal(request.role, 'standard');
    assert.deepEqual(request.argv.slice(0, 2), [LINUX_MEASUREMENT_PATHS.runtime, LINUX_MEASUREMENT_PATHS.producer]);
    const configPath = path.join(root, `worker-${calls}.json`), tracePath = path.join(root, `trace-${calls}.json`);
    fs.writeFileSync(configPath, JSON.stringify({ measurementRoot, guestRoot, tracePath, uid: observedUid, clockOffsetMs,
      mutateAtReaderEnd: mutateAfterRead }));
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', worker, configPath, request.argv[2]], {
      timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      env: { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    if (child.error) throw child.error;
    fs.writeFileSync(path.join(root, `worker-result-${calls}.json`), JSON.stringify({ pid: child.pid, status: child.status,
      signal: child.signal, stdout: child.stdout, stderr: child.stderr }));
    let stdout = child.stdout;
    if (child.status === 0) {
      const value = JSON.parse(stdout); outputs.push(value);
      editReply?.(value);
      stdout = JSON.stringify(value);
      mutateAfterProducer?.();
      if (abortAfterProducer) f.controller.abort();
    }
    if (rawReply) stdout = rawReply(stdout);
    fs.writeFileSync(path.join(root, `wire-stdout-${calls}.txt`), stdout);
    return { exitCode: child.status ?? 1, stdout, stderr: child.stderr, role: request.role };
  } });
  root = f.root; measurementRoot = path.join(root, 'input/measurement'); guestRoot = path.join(root, 'guest-root');
  const write = (relative, value, mode = 0o644) => {
    const file = path.join(guestRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, value, { mode }); fs.chmodSync(file, mode); return file;
  };
  const statusText = 'Package: toolsenabled\nStatus: install ok installed\nArchitecture: amd64\nVersion: 1.0.49\n';
  const statusFile = write('var/lib/dpkg/status', statusText);
  fs.mkdirSync(path.join(guestRoot, 'var/lib/dpkg/updates'), { mode: 0o755 });
  write('opt/ToolsEnabled/toolsenabled', 'fixture runtime bytes', 0o755);
  const payload = write('opt/ToolsEnabled/resources/app.asar', 'fixture application bytes');
  write('opt/ToolsEnabled/resources/capability/PAYLOAD.json', '{"fixture":true}');
  write('usr/share/applications/toolsenabled.desktop', '[Desktop Entry]\nType=Application\nExec=/opt/ToolsEnabled/toolsenabled %U\n');
  const directoryModes = directory => {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) directoryModes(path.join(directory, entry.name));
    }
  };
  directoryModes(guestRoot);
  fs.mkdirSync(measurementRoot, { recursive: true });
  const paths = {};
  for (const [name, source] of Object.entries({ runtime: process.execPath,
    producer: path.join(APP, 'tools/lib/guest/linux-installed-measurement.mjs'),
    reader: path.join(APP, 'tools/lib/guest/linux-installed-state.mjs'),
    dependency: path.join(APP, 'tools/lib/adapters/artifact-files.mjs') })) {
    const relative = name === 'runtime' ? 'node-v22.19.0' : path.relative(APP, source);
    const destination = path.join(measurementRoot, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, name === 'runtime' ? 0o755 : 0o644);
    paths[name] = destination;
  }
  const originals = Object.fromEntries(['producer', 'reader', 'dependency'].map(name => [name, fs.readFileSync(paths[name])]));
  const runtimeBytes = fs.statSync(paths.runtime).size;
  const tree = measureTree(path.join(guestRoot, 'opt/ToolsEnabled'));
  const subject = { product: 'toolsenabled', version: '1.0.49', target: { platform: 'linux', arch: 'x64' },
    artifact: { sha256: hash('synthetic exact artifact'), bytes: 24 }, stageSha256: tree.sha256,
    runtimeSha256: digestRecord(Object.fromEntries(Object.entries(tree.files).filter(([name]) => !name.startsWith('resources/')))),
    sourceSha256: hash('synthetic source expectation'), sourceRefs: { app: 'a'.repeat(40), engine: 'b'.repeat(40) } };
  const options = () => ({ subject, run: { id: randomUUID(), startedAt: new Date(Date.now() - 1000).toISOString() }, phaseId: 'after-install' });
  let transport;
  try {
    transport = await f.open();
    await t.test('positive control reads real fixture files through unchanged reader and keeps qualification false', async () => {
      const result = await transport.measureInstalledState(options());
      assert.equal(result.observed.installedState.files['resources/app.asar'].sha256, hash('fixture application bytes'));
      assert.equal(result.observed.root, '/'); assert.equal(result.observed.uid, 1000);
      assert.equal(result.transport.guestId, f.config.guestId); assert.equal(result.transport.role, 'standard');
      assert.equal(result.attested, false); assert.equal(result.qualified, false);
      assert.equal(result.lifecycleEpoch.available, false); assert.equal(result.cleanupProof.available, false);
      const trace = JSON.parse(fs.readFileSync(path.join(root, `trace-${calls}.json`)));
      assert.equal(trace.readerEndReached, true);
      assert.ok(trace.fixedRootReads.includes('/var/lib/dpkg/status'));
      assert.ok(trace.fixedRootReads.includes('/opt/ToolsEnabled/resources/app.asar'));
    });
    assert.equal(outputs.length, 1, 'dependent negative cases require the successful actual-reader positive control');
    for (const offset of [-3600000, 3600000]) await t.test(`guest clock skew ${offset} remains a separate observed clock`, async () => {
      clockOffsetMs = offset;
      try {
        const result = await transport.measureInstalledState(options());
        assert.ok(Math.abs(Date.parse(result.observed.finishedAt) - Date.now() - offset) < 10000);
        assert.ok(Math.abs(Date.parse(result.transport.hostFinishedAt) - Date.now()) < 10000);
        assert.match(result.transport.clockAgreement, /^unmeasured;/);
      } finally { clockOffsetMs = undefined; }
    });
    await t.test('measurement reserves its attest/execute/attest sequence against other public calls', async () => {
      const ordinaryBefore = f.requests.filter(row => row.argv?.join(' ') === 'id -u').length;
      const operation = transport.measureInstalledState(options());
      await assert.rejects(transport.execute({ argv: ['id', '-u'], profile: 'linux-x64-standard' }), { code: 'LINUX_GUEST_REFUSED' });
      await assert.rejects(transport.attest(), { code: 'LINUX_GUEST_REFUSED' });
      await assert.rejects(transport.measureInstalledState(options()), error => {
        assert.equal(error.measurementDispatch, 'not-dispatched');
        assert.equal(Object.hasOwn(error, 'remoteMeasurementTerminationConfirmed'), false); return true;
      });
      assert.equal((await operation).qualified, false);
      assert.equal(f.requests.filter(row => row.argv?.join(' ') === 'id -u').length, ordinaryBefore);
    });
    await t.test('already-busy transport refuses measurement without claiming an exec dispatch', async () => {
      const before = calls;
      const operation = transport.execute({ argv: ['id', '-u'], profile: 'linux-x64-standard' });
      await assert.rejects(transport.measureInstalledState(options()), error => {
        assert.equal(error.measurementDispatch, 'not-dispatched');
        assert.equal(Object.hasOwn(error, 'remoteMeasurementTerminationConfirmed'), false); return true;
      });
      await operation; assert.equal(calls, before);
    });
    await t.test('verified lifecycle or caller epoch claims refuse before any RPC', async () => {
      for (const extra of [{ requireVerifiedLifecycleEpoch: true }, { epochId: randomUUID() }, { requestEpochId: randomUUID() }, { root: guestRoot }]) {
        const count = f.requests.length;
        await assert.rejects(transport.measureInstalledState({ ...options(), ...extra }), refusal);
        assert.equal(f.requests.length, count);
      }
    });
    await t.test('missing subject/version and oversized context refuse before dispatch', async () => {
      for (const value of [{ ...options(), subject: undefined }, { ...options(), subject: { ...subject, version: undefined } },
        { ...options(), phaseId: 'a'.repeat(8193) }]) {
        const count = f.requests.length;
        await assert.rejects(transport.measureInstalledState(value), refusal); assert.equal(f.requests.length, count);
      }
    });
    await t.test('wrong guest and replayed outer nonce refuse before measurement execution', async () => {
      const guestId = f.config.guestId, count = calls;
      f.config.guestId = randomUUID();
      await assert.rejects(transport.measureInstalledState(options()), { code: 'LINUX_GUEST_REFUSED' });
      f.config.guestId = guestId;
      f.changeNonce('replayed');
      await assert.rejects(transport.measureInstalledState(options()), { code: 'LINUX_GUEST_REFUSED' });
      f.changeNonce(undefined); assert.equal(calls, count);
    });
    for (const [name, edit] of [
      ['subject', value => { value.requestContext.subjectSha256 = 'c'.repeat(64); }],
      ['phase', value => { value.requestContext.phaseId = 'foreign-phase'; }],
      ['run', value => { value.requestContext.run.id = randomUUID(); }],
      ['measurement nonce', value => { value.measurementNonce = randomUUID(); }],
      ['invented lifecycle epoch', value => { value.lifecycleEpoch = { available: true, epochId: randomUUID() }; }],
      ['reported closure bytes', value => { value.observed.inputs.reader.sha256 = 'd'.repeat(64); }],
      ['extra qualification claim', value => { value.nativeQualified = true; }],
    ]) await t.test(`foreign ${name} response is refused after actual reader execution`, async () => {
      const before = outputs.length;
      editReply = edit;
      try {
        await assert.rejects(transport.measureInstalledState(options()), refusal);
        assert.equal(outputs.length, before + 1, 'the actual producer must complete before reply corruption');
      }
      finally { editReply = undefined; }
    });
    await t.test('actual ordinary UID must match authenticated guest identity', async () => {
      const before = outputs.length;
      observedUid = 1001;
      try {
        await assert.rejects(transport.measureInstalledState(options()), refusal);
        assert.equal(outputs.length, before + 1);
      }
      finally { observedUid = undefined; }
    });
    for (const [name, edit] of [
      ['truncated JSON', text => text.slice(0, -1)],
      ['oversized output', text => text + ' '.repeat(2 * 1024 * 1024)],
    ]) await t.test(`${name} refuses instead of becoming a measurement`, async () => {
      const before = outputs.length; rawReply = edit;
      try {
        await assert.rejects(transport.measureInstalledState(options()), refusal);
        assert.equal(outputs.length, before + 1);
      } finally { rawReply = undefined; }
    });
    for (const name of ['producer', 'reader', 'dependency', 'runtime']) await t.test(`changed staged ${name} refuses before RPC`, async () => {
      const count = f.requests.length; fs.appendFileSync(paths[name], 'changed');
      try { await assert.rejects(transport.measureInstalledState(options()), refusal); assert.equal(f.requests.length, count); }
      finally { name === 'runtime' ? fs.truncateSync(paths[name], runtimeBytes) : fs.writeFileSync(paths[name], originals[name]); }
    });
    for (const [name, file] of [['runtime', paths.runtime], ['reader', paths.reader],
      ['intermediate directory', path.join(measurementRoot, 'tools')], ['input directory', path.dirname(measurementRoot)]]) {
      await t.test(`other-writable ${name} refuses before any RPC`, async () => {
        const mode = fs.statSync(file).mode & 0o7777, count = f.requests.length;
        fs.chmodSync(file, mode | 0o022);
        try { await assert.rejects(transport.measureInstalledState(options()), refusal); assert.equal(f.requests.length, count); }
        finally { fs.chmodSync(file, mode); }
      });
    }
    for (const name of ['reader', 'dependency', 'runtime']) await t.test(`${name} changed during reader execution is refused`, async () => {
      mutateAfterRead = name;
      try {
        await assert.rejects(transport.measureInstalledState(options()), refusal);
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, `trace-${calls}.json`))).readerEndReached, true);
      } finally {
        mutateAfterRead = undefined;
        name === 'runtime' ? fs.truncateSync(paths[name], runtimeBytes) : fs.writeFileSync(paths[name], originals[name]);
      }
    });
    await t.test('host independently rejects changed share bytes even with a previously valid guest reply', async () => {
      const before = outputs.length;
      mutateAfterProducer = () => fs.appendFileSync(paths.reader, 'changed after guest response');
      try {
        await assert.rejects(transport.measureInstalledState(options()), refusal);
        assert.equal(outputs.length, before + 1);
      }
      finally { mutateAfterProducer = undefined; fs.writeFileSync(paths.reader, originals.reader); }
    });
    await t.test('changed installed payload cannot satisfy exact subject', async () => {
      const before = outputs.length;
      fs.appendFileSync(payload, 'changed');
      try {
        await assert.rejects(transport.measureInstalledState(options()), { code: 'LINUX_INSTALLED_STATE_BLOCKED' });
        assert.equal(outputs.length, before + 1);
      }
      finally { fs.writeFileSync(payload, 'fixture application bytes'); }
    });
    await t.test('package version differs from requested exact version', async () => {
      const before = outputs.length;
      await assert.rejects(transport.measureInstalledState({ ...options(), subject: { ...subject, version: '1.0.50' } }), refusal);
      assert.equal(outputs.length, before + 1);
      assert.equal(outputs.at(-1).observed.installedState.package.version, '1.0.49');
    });
    for (const [name, value] of [
      ['partial package', statusText.replace('install ok installed', 'install ok unpacked')],
      ['malformed package', statusText + 'Status: install ok installed\n'],
    ]) await t.test(`${name} is not accepted as installed`, async () => {
      fs.writeFileSync(statusFile, value);
      const before = outputs.length;
      try {
        await assert.rejects(transport.measureInstalledState(options()));
        if (name === 'partial package') {
          assert.equal(outputs.length, before + 1);
          assert.equal(outputs.at(-1).observed.installedState.state, 'unknown');
        } else {
          const child = JSON.parse(fs.readFileSync(path.join(root, `worker-result-${calls}.json`)));
          assert.match(child.stderr, /LINUX_INSTALLED_STATE_BLOCKED:.*malformed or duplicate dpkg field/);
        }
      }
      finally { fs.writeFileSync(statusFile, statusText); }
    });
    await t.test('missing staged dependency refuses before execution', async () => {
      const count = f.requests.length; fs.renameSync(paths.dependency, paths.dependency + '.saved');
      try { await assert.rejects(transport.measureInstalledState(options()), refusal); assert.equal(f.requests.length, count); }
      finally { fs.renameSync(paths.dependency + '.saved', paths.dependency); }
    });
    await t.test('restored exact inputs still produce the measured state without granting authority', async () => {
      const result = await transport.measureInstalledState(options());
      assert.equal(result.observed.installedState.state, 'installed'); assert.equal(result.attested, false);
      assert.equal(result.lifecycleEpoch.available, false); assert.ok(outputs.length > 1);
    });
    await t.test('close during initial attestation prevents measurement dispatch without a remote termination claim', async () => {
      const before = calls, operation = transport.measureInstalledState(options());
      transport.close();
      await assert.rejects(operation, error => {
        assert.equal(error.measurementDispatch, 'not-dispatched');
        assert.equal(Object.hasOwn(error, 'remoteMeasurementTerminationConfirmed'), false); return true;
      });
      assert.equal(calls, before);
    });
    await t.test('abort after measurement dispatch reports an unknown remote outcome without inventing cleanup', async () => {
      transport = await f.open();
      const before = calls; abortAfterProducer = true;
      await assert.rejects(transport.measureInstalledState(options()), error => {
        assert.equal(error.measurementDispatch, 'submitted-to-transport');
        assert.equal(error.remoteMeasurementTerminationConfirmed, false);
        assert.equal(Object.hasOwn(error, 'cleanupConfirmed'), false); return true;
      });
      abortAfterProducer = false; assert.equal(calls, before + 1);
      await assert.rejects(transport.measureInstalledState(options()), error => {
        assert.equal(error.measurementDispatch, 'not-dispatched');
        assert.equal(Object.hasOwn(error, 'remoteMeasurementTerminationConfirmed'), false); return true;
      });
    });
  } finally { transport?.close(); await f.dispose(); }
});
