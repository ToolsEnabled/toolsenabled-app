import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { stageLinuxInstalledMeasurementInputs, prepareLinuxInstalledMeasurement } from '../lib/transport/linux-installed-measurement.mjs';
import { LINUX_MEASUREMENT_NODE } from '../lib/guest/linux-installed-measurement.mjs';
import { requiredNativeSourceCases, sourceCaseExecutionRequirement } from '../lib/adapters/source-command-plan.mjs';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const NODE = process.execPath;
const LINUX_CASE = 'host-only measurement staging admits exact files and refuses unsafe copy boundaries';
const STAGING_TEST = 'tools/test/linux-installed-measurement-staging.test.mjs';
const linux = process.platform === 'linux' && process.arch === 'x64' && process.getuid() > 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['tools/lib/guest/linux-installed-measurement.mjs', 'tools/lib/guest/linux-installed-state.mjs', 'tools/lib/adapters/artifact-files.mjs'];
const options = () => ({ subject: { product: 'toolsenabled', version: '1.0.49', target: { platform: 'linux', arch: 'x64' },
  artifact: { sha256: 'a'.repeat(64), bytes: 24 }, stageSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64),
  sourceSha256: 'd'.repeat(64), sourceRefs: { app: 'e'.repeat(40), engine: 'f'.repeat(40) } },
  run: { id: randomUUID(), startedAt: new Date(Date.now() - 1000).toISOString() }, phaseId: 'after-install' });
function patchFs(changes, run) {
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, fs[key]]));
  Object.assign(fs, changes);
  try { return run(); } finally { Object.assign(fs, before); }
}
function refusal(action, { empty = true } = {}) {
  let caught;
  assert.throws(action, error => {
    caught = error; assert.equal(error.staging.complete, false);
    assert.equal(error.staging.cleanupAttempted, false);
    if (empty) assert.deepEqual(error.staging.createdPaths, []);
    return true;
  });
  return caught;
}

test('the staging filesystem case keeps its exact Linux companion obligation', () => {
  const context = { suite: 'app', files: [STAGING_TEST], testName: LINUX_CASE };
  assert.deepEqual(requiredNativeSourceCases('app', context.files), [
    { suite: 'app', file: STAGING_TEST, testName: LINUX_CASE, requiredPlatform: 'linux' },
  ]);
  for (const platform of ['linux', 'win32']) {
    const requirement = sourceCaseExecutionRequirement({ ...context, platform });
    assert.equal(requirement.kind, platform === 'linux' ? 'native-prerequisite-unmet' : 'companion-platform-required');
    assert.equal(requirement.requiredPlatform, 'linux'); assert.equal(requirement.status, 'unexecuted');
  }
  assert.equal(sourceCaseExecutionRequirement({ ...context, files: [], platform: 'win32' }).kind, 'unmapped-execution-prerequisite');
});

test(LINUX_CASE, { skip: linux ? false : 'Requires the owning non-root Linux x64 account; Linux companion case remains unexecuted' }, async t => {
  // The source checkout already belongs beneath an admitted private ancestor
  // chain. A fresh sibling supplies that premise without inherited TMPDIR,
  // modifying the checkout, or placing fixtures in a live profile/state root.
  const suite = fs.mkdtempSync(path.join(path.dirname(path.resolve(APP)), 'linux-measurement-staging-'));
  fs.chmodSync(suite, 0o700);
  const fixture = name => {
    const root = path.join(suite, name); fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'input'), { mode: 0o755 }); return root;
  };
  const root = fixture('positive'), stage = (machineRoot = root, nodePath = NODE) => stageLinuxInstalledMeasurementInputs({ machineRoot, nodePath });
  const moduleBefore = Object.fromEntries(sourceFiles.map(file => [file, { bytes: fs.readFileSync(path.join(APP, file)), mode: fs.statSync(path.join(APP, file)).mode }]));
  let positive, positiveControlPassed = false;
  try {
    await t.test('positive stage uses actual pinned bytes and deliberate modes before prepare admission', () => {
      positive = stage();
      assert.equal(positive.created, true); assert.equal(positive.reused, false);
      assert.equal(positive.proofScope, 'host-staging-only');
      for (const flag of ['guestReadabilityVerified', 'guestExecutionVerified', 'qualified', 'attested']) assert.equal(positive[flag], false);
      assert.equal(positive.lifecycleEpoch.available, false); assert.equal(positive.cleanupProof.available, false);
      assert.equal(Object.hasOwn(positive, 'requestContext'), false);
      assert.equal(positive.stagedInputs.runtime.sha256, LINUX_MEASUREMENT_NODE.sha256);
      assert.equal(positive.stagedInputs.runtime.bytes, LINUX_MEASUREMENT_NODE.bytes);
      for (const [name, record] of Object.entries(positive.stagedInputs)) {
        assert.equal(fs.statSync(record.path).mode & 0o7777, name === 'runtime' ? 0o755 : 0o644);
        assert.equal(hash(fs.readFileSync(record.path)), positive.sourceInputs[name].sha256);
      }
      for (const file of sourceFiles) {
        assert.deepEqual(fs.readFileSync(path.join(APP, file)), moduleBefore[file].bytes);
        assert.equal(fs.statSync(path.join(APP, file)).mode, moduleBefore[file].mode);
      }
      const prepared = prepareLinuxInstalledMeasurement(root, options());
      assert.deepEqual(prepared.request.expectedInputs.runtime,
        { sha256: LINUX_MEASUREMENT_NODE.sha256, bytes: LINUX_MEASUREMENT_NODE.bytes });
      fs.writeFileSync(path.join(suite, 'positive-receipt.json'), JSON.stringify(positive, null, 2));
      positiveControlPassed = true;
    });
    assert.equal(positiveControlPassed, true, 'dependent negatives require successful actual stage and prepare admission');
    await t.test('exact reuse does not change target generations', () => {
      const reused = stage(); assert.equal(reused.reused, true); assert.equal(reused.created, false);
      assert.deepEqual(reused.createdPaths, []); assert.deepEqual(reused.stagedInputs, positive.stagedInputs);
    });
    await t.test('unknown module, root, pin, context and epoch overrides refuse before mutation', () => {
      for (const extra of [{ root: root }, { modules: {} }, { expectedInputs: {} }, { requestContext: {} }, { epochId: randomUUID() }]) {
        refusal(() => stageLinuxInstalledMeasurementInputs({ machineRoot: root, nodePath: NODE, ...extra }));
      }
    });
    for (const [name, relative] of [['ancestor', ''], ['machine', 'writable-machine'], ['input', 'writable-input/input']]) {
      for (const mode of [0o775, 0o757]) await t.test(`${name} group/world writable mode ${mode.toString(8)} refuses before creation`, () => {
        const machine = relative ? fixture(relative.split('/')[0] + '-' + mode) : fixture('writable-ancestor-' + mode);
        const target = relative ? (name === 'input' ? path.join(machine, 'input') : machine) : suite;
        const original = fs.statSync(target).mode & 0o7777; fs.chmodSync(target, mode);
        try { refusal(() => stage(machine)); assert.equal(fs.existsSync(path.join(machine, 'input/measurement')), false); }
        finally { fs.chmodSync(target, original); }
      });
    }
    await t.test('synthetic foreign ancestor owner refuses before creation', () => {
      const machine = fixture('foreign-owner'), lstat = fs.lstatSync;
      patchFs({ lstatSync(file, ...args) {
        const value = lstat.call(fs, file, ...args);
        if (file === machine) value.uid = typeof value.uid === 'bigint' ? 987654n : 987654;
        return value;
      } }, () => refusal(() => stage(machine)));
      assert.equal(fs.existsSync(path.join(machine, 'input/measurement')), false);
    });
    for (const type of ['ancestor', 'input', 'target']) await t.test(`linked ${type} refuses without outside writes`, () => {
      const machine = fixture('linked-' + type), outside = path.join(suite, 'outside-' + type);
      fs.mkdirSync(outside, { mode: 0o700 });
      let supplied = machine;
      if (type === 'ancestor') { supplied = path.join(suite, 'alias'); fs.symlinkSync(machine, supplied); }
      else if (type === 'input') { fs.rmdirSync(path.join(machine, 'input')); fs.symlinkSync(outside, path.join(machine, 'input')); }
      else fs.symlinkSync(outside, path.join(machine, 'input/measurement'));
      refusal(() => stage(supplied)); assert.deepEqual(fs.readdirSync(outside), []);
    });
    await t.test('linked and hard-linked runtime source refuse before copying', () => {
      const machine = fixture('source-links'), link = path.join(suite, 'runtime-link');
      fs.symlinkSync(NODE, link); refusal(() => stage(machine, link));
      const original = path.join(suite, 'owned-node'), alias = path.join(suite, 'source-hardlink');
      fs.copyFileSync(NODE, original, fs.constants.COPYFILE_EXCL); fs.linkSync(original, alias);
      refusal(() => stage(machine, alias)); assert.equal(fs.existsSync(path.join(machine, 'input/measurement')), false);
      fs.unlinkSync(alias);
    });
    await t.test('actual pathname replacement with symlink is rejected by O_PATH before data open', () => {
      const machine = fixture('source-path-race'), source = path.join(suite, 'owned-node'), backup = source + '.held';
      const open = fs.openSync; let dataOpened = false, changed = false;
      try {
        patchFs({ openSync(file, flags, ...rest) {
          if (file === source && (flags & 0x200000)) {
            fs.renameSync(source, backup); fs.symlinkSync(backup, source); changed = true;
          }
          if (String(file).startsWith('/proc/self/fd/')) dataOpened = true;
          return open.call(fs, file, flags, ...rest);
        } }, () => refusal(() => stage(machine, source)));
        assert.equal(changed, true); assert.equal(dataOpened, false);
      } finally { if (changed) { fs.unlinkSync(source); fs.renameSync(backup, source); } }
    });
    await t.test('wrong runtime and changed module bytes refuse before destination creation', () => {
      const machine = fixture('wrong-bytes'), wrong = path.join(suite, 'wrong-runtime'); fs.writeFileSync(wrong, 'not pinned Node');
      refusal(() => stage(machine, wrong));
      const read = fs.readSync, open = fs.openSync, close = fs.closeSync, source = path.join(APP, sourceFiles[1]);
      let sourcePathFd, dataFd;
      patchFs({ openSync(file, flags, ...rest) {
        const fd = open.call(fs, file, flags, ...rest);
        if (file === source && (flags & 0x200000)) sourcePathFd = fd;
        if (file === `/proc/self/fd/${sourcePathFd}`) dataFd = fd;
        return fd;
      }, readSync(fd, buffer, ...rest) {
        const count = read.call(fs, fd, buffer, ...rest); if (fd === dataFd && count) buffer[0] ^= 1; return count;
      }, closeSync(fd) { if (fd === dataFd) dataFd = undefined; return close.call(fs, fd); }
      }, () => refusal(() => stage(machine)));
      assert.equal(fs.existsSync(path.join(machine, 'input/measurement')), false);
    });
    for (const kind of ['fifo', 'device']) await t.test(`raced ${kind} inode is refused before any data open`, () => {
      const machine = fixture('raced-' + kind), open = fs.openSync, fstat = fs.fstatSync;
      let pathFd, dataOpened = false, admittedPath = false;
      patchFs({ openSync(file, flags, ...rest) {
        if (file === NODE && (flags & 0x200000)) { pathFd = open.call(fs, file, flags, ...rest); admittedPath = true; return pathFd; }
        if (file === `/proc/self/fd/${pathFd}`) dataOpened = true;
        return open.call(fs, file, flags, ...rest);
      }, fstatSync(fd, ...args) {
        const value = fstat.call(fs, fd, ...args);
        if (fd === pathFd) { value.isFile = () => false; value.mode = kind === 'fifo' ? 0o10600n : 0o20600n; }
        return value;
      } }, () => refusal(() => stage(machine)));
      assert.equal(admittedPath, true); assert.equal(dataOpened, false);
      assert.equal(fs.existsSync(path.join(machine, 'input/measurement')), false);
    });
    await t.test('source generation change after pinned type validation refuses before data open', () => {
      const machine = fixture('generation'), open = fs.openSync, fstat = fs.fstatSync;
      let pathFd, dataOpened = false;
      patchFs({ openSync(file, flags, ...rest) {
        if (file === `/proc/self/fd/${pathFd}`) dataOpened = true;
        const fd = open.call(fs, file, flags, ...rest); if (file === NODE && (flags & 0x200000)) pathFd = fd; return fd;
      }, fstatSync(fd, ...args) { const value = fstat.call(fs, fd, ...args); if (fd === pathFd) value.mtimeNs += 1n; return value; }
      }, () => refusal(() => stage(machine)));
      assert.equal(dataOpened, false);
    });
    for (const defect of ['early EOF', 'generation after read']) await t.test(`source ${defect} during actual capture refuses before copy`, () => {
      const machine = fixture('capture-' + defect.replaceAll(' ', '-')), open = fs.openSync, read = fs.readSync, fstat = fs.fstatSync;
      let pathFd, dataFd, readFinished = false;
      patchFs({ openSync(file, flags, ...rest) {
        const fd = open.call(fs, file, flags, ...rest);
        if (file === NODE && (flags & 0x200000)) pathFd = fd;
        if (file === `/proc/self/fd/${pathFd}`) dataFd = fd;
        return fd;
      }, readSync(fd, ...args) {
        if (fd === dataFd && defect === 'early EOF') return 0;
        const count = read.call(fs, fd, ...args); if (fd === dataFd && count === 0) readFinished = true; return count;
      }, fstatSync(fd, ...args) {
        const value = fstat.call(fs, fd, ...args); if (fd === dataFd && readFinished) value.mtimeNs += 1n; return value;
      } }, () => refusal(() => stage(machine)));
      if (defect === 'generation after read') assert.equal(readFinished, true);
      assert.equal(fs.existsSync(path.join(machine, 'input/measurement')), false);
    });
    for (const defect of ['extra', 'partial', 'mode', 'bytes', 'link', 'hardlink']) await t.test(`existing ${defect} stage refuses without repair`, () => {
      const reader = positive.stagedInputs.reader.path, bytes = fs.readFileSync(reader);
      const backup = path.join(suite, 'reader.backup'), extra = defect === 'hardlink' ? path.join(suite, 'reader.alias') : path.join(root, 'input/measurement/extra');
      const mutation = { extra() { fs.writeFileSync(extra, 'extra'); }, partial() { fs.renameSync(reader, backup); },
        mode() { fs.chmodSync(reader, 0o664); }, bytes() { fs.writeFileSync(reader, Buffer.alloc(bytes.length, 65)); },
        link() { fs.renameSync(reader, backup); fs.symlinkSync(backup, reader); },
        hardlink() { fs.linkSync(reader, extra); } }[defect];
      mutation();
      try { refusal(() => stage()); if (defect === 'mode') assert.equal(fs.statSync(reader).mode & 0o777, 0o664); }
      finally {
        if (['extra', 'hardlink'].includes(defect)) fs.unlinkSync(extra);
        if (defect === 'link') fs.unlinkSync(reader);
        if (['partial', 'link'].includes(defect)) fs.renameSync(backup, reader);
        if (defect === 'mode') fs.chmodSync(reader, 0o644);
        if (defect === 'bytes') fs.writeFileSync(reader, bytes);
      }
    });
    await t.test('partial copy failure retains only created-path evidence and never retries over it', () => {
      const machine = fixture('partial-copy'), write = fs.writeSync;
      let writes = 0;
      const error = patchFs({ writeSync(...args) { if (++writes === 2) throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); return write.apply(fs, args); }
      }, () => refusal(() => stage(machine), { empty: false }));
      assert.equal(writes, 2); assert.ok(error.staging.createdPaths.length > 0);
      const file = error.staging.createdPaths.find(row => row.kind === 'file');
      assert.ok(fs.statSync(file.path).size > 0); assert.ok(fs.statSync(file.path).size < LINUX_MEASUREMENT_NODE.bytes);
      fs.writeFileSync(path.join(suite, 'partial-copy-receipt.json'), JSON.stringify(error.staging, null, 2));
      refusal(() => stage(machine)); assert.equal(fs.existsSync(file.path), true);
    });
    await t.test('subsequently changed staged closure is refused by existing prepare', () => {
      const reader = positive.stagedInputs.reader.path, bytes = fs.readFileSync(reader);
      fs.writeFileSync(reader, 'changed');
      try { assert.throws(() => prepareLinuxInstalledMeasurement(root, options()), { code: 'LINUX_INSTALLED_MEASUREMENT_REFUSED' }); }
      finally { fs.writeFileSync(reader, bytes); }
    });
  } finally {
    // These are solely this test's owned fixtures. Production staging never
    // recursively removes failed output. The evidence preload retains them.
    fs.rmSync(suite, { recursive: true, force: true });
  }
});
