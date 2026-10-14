import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fileIdentity } from '../lib/transport/owned-job.mjs';
import { measureFile } from '../lib/adapters/artifact-files.mjs';

// Real disposable file reads, with only the OS file identifier substituted.
// Adjacent NTFS identifiers beyond Number's precision must remain distinct.
for (const [name, measure] of [['owned process', fileIdentity], ['artifact', measureFile]]) {
  for (const changed of [false, true]) {
    test(`${name}: large file identifiers ${changed ? 'detect replacement' : 'retain stable files'}`, t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'large-file-identity-'));
      const file = path.join(root, 'input.txt');
      fs.writeFileSync(file, 'measured bytes');
      const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
      const inode = 2n ** 54n;
      assert.equal(Number(inode), Number(inode + 1n), 'the fixture must expose integer rounding');
      let reads = 0;
      function identify(stat, value, options) {
        Object.defineProperty(stat, 'ino', { value: options?.bigint ? value : Number(value) });
        return stat;
      }
      t.after(() => {
        fs.lstatSync = originalLstat; fs.fstatSync = originalFstat;
        fs.rmSync(root, { recursive: true, force: true });
      });
      fs.lstatSync = (target, options) => {
        const stat = originalLstat(target, options);
        return String(target) === file ? identify(stat, inode, options) : stat;
      };
      fs.fstatSync = (fd, options) => identify(originalFstat(fd, options),
        inode + (changed && reads++ > 0 ? 1n : 0n), options);
      if (changed) assert.throws(() => measure(file), /changed/);
      else assert.equal(measure(file).bytes, Buffer.byteLength('measured bytes'));
    });
  }
}

// Complete production body, with only ESM import/export wiring removed. These
// portable fixtures simulate filesystem/process facts; they never create a
// special file, inspect a process, or give production a filesystem override.
const readerUrl = new URL('../lib/transport/owned-job-files.mjs', import.meta.url);
const readerBody = fs.readFileSync(readerUrl, 'utf8').replace(/^import [\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const fixtureHash = bytes => createHash('sha256').update(bytes).digest('hex');
function simulatedReader(config = {}) {
  const platform = config.platform || 'linux', paths = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? '\x43:\\fixture-home' : '/fixture-owner';
  const file = paths.join(home, 'input.bin'), metadataFd = config.metadataFd ?? 11, dataFd = config.dataFd ?? 12;
  const content = Buffer.from(config.content ?? 'fixture-bytes'), payload = Buffer.from(config.payload ?? content);
  const events = [], opened = [], closed = [];
  let clock = 0n, position = 0, ended = false, procPass = 0, metadataStats = 0, dataStats = 0, dataAttempts = 0;
  const record = (stage, extra = {}) => {
    events.push({ stage, ...extra });
    if (config.expireAt === stage) clock = 120_000_000_000n;
    if (config.throwAt === stage || config.closeFailures?.includes(stage)) throw new Error('fixture failure at ' + stage);
  };
  const stats = (kind = 'file', extra = {}) => ({
    dev: 1n, ino: 2n ** 54n, mode: kind === 'directory' ? 0o40500n : 0o100600n,
    size: BigInt(content.length), mtimeMs: 10n, ctimeMs: 10n, nlink: 2n, uid: 1000n, gid: 1000n,
    ...extra, isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink',
  });
  const selected = stats('file', config.selected);
  const constants = Object.freeze({ O_RDONLY: 0, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 });
  const fake = {
    constants,
    lstatSync(target, options) {
      assert.equal(options?.bigint, true);
      if (target === file) {
        record(ended ? 'path-final-stat' : 'path-stat', { path: target });
        return stats('file', { ...selected, ...(ended ? config.finalPath : {}) });
      }
      if (target === home) { record('parent-stat', { path: target }); return stats('directory'); }
      if (target === '/proc/self') {
        record('proc-self'); return stats('symlink', { uid: 0n });
      }
      if (['/proc', '/proc/4242', '/proc/4242/fd'].includes(target)) {
        if (target === '/proc') procPass++;
        record(procPass > 1 ? 'proc-final-stat' : 'proc-stat', { path: target });
        if (config.proc === 'missing') throw Object.assign(new Error('synthetic missing procfs'), { code: 'ENOENT' });
        const last = target.endsWith('/fd');
        return stats(config.proc === 'linked-fd' && last ? 'symlink' : 'directory', {
          uid: target === '/proc' ? 0n : config.proc === 'wrong-owner' && last ? 2000n : 1000n,
          mode: config.proc === 'writable-fd' && last ? 0o40777n : 0o40500n,
          ino: config.proc === 'changed-final' && last && procPass > 1 ? 99n : 55n,
        });
      }
      throw new Error('unexpected synthetic lstat: ' + target);
    },
    statfsSync(target, options) {
      record('proc-magic', { path: target }); assert.equal(options?.bigint, true);
      return { type: config.proc === 'wrong-magic' ? 1n : 0x9fa0n };
    },
    readlinkSync(target) {
      record('proc-readlink', { path: target }); assert.equal(target, '/proc/self');
      return config.proc === 'wrong-pid' ? '4243' : '4242';
    },
    openSync(target, flags) {
      if (typeof flags === 'number' && flags & 0x200000) {
        record('metadata-open', { path: target, flags });
        assert.equal(target, file); assert.equal(flags, 0x200000 | constants.O_NOFOLLOW);
        opened.push(metadataFd); return metadataFd;
      }
      // Count BEFORE any assertion/throw. Baseline pathname data-open attempts
      // must fail the zero-attempt assertion, not pass via a fixture exception.
      dataAttempts++;
      record('data-open', { path: target, flags });
      if (platform === 'linux') {
        assert.equal(target, `/proc/4242/fd/${metadataFd}`);
        assert.equal(flags, constants.O_RDONLY | constants.O_NONBLOCK);
      } else { assert.equal(target, file); assert.equal(flags, 'r'); }
      opened.push(dataFd); return dataFd;
    },
    fstatSync(fd, options) {
      assert.equal(options?.bigint, true);
      if (platform === 'linux' && fd === metadataFd) {
        metadataStats++;
        record(metadataStats > 1 ? 'metadata-final-stat' : 'metadata-stat', { fd });
        return stats(config.heldKind || 'file', { ...selected, ...config.held,
          ...(metadataStats > 1 ? config.finalHeld : {}) });
      }
      assert.equal(fd, dataFd); dataStats++;
      record(dataStats > 1 ? 'data-final-stat' : 'data-stat', { fd });
      return stats('file', { ...selected, ...config.reopened, ...(dataStats > 1 ? config.finalData : {}) });
    },
    readSync(fd, buffer, offset, length, at) {
      record('read', { fd }); assert.equal(fd, dataFd); assert.equal(at, null);
      if (config.invalidCount) return length + 1;
      const count = Math.min(length, payload.length - position);
      payload.copy(buffer, offset, position, position + count); position += count;
      if (!count) ended = true;
      return count;
    },
    closeSync(fd) {
      closed.push(fd);
      record(platform === 'linux' && fd === metadataFd ? 'close-metadata' : 'close-data', { fd });
    },
  };
  const filesystem = new Proxy(fake, { get(target, key) {
    if (!(key in target)) throw new Error('unexpected synthetic filesystem operation: ' + String(key));
    return target[key];
  } });
  const processFacts = { platform, pid: 4242, geteuid: () => 1000,
    hrtime: { bigint: () => { events.push({ stage: 'clock', now: String(clock) }); return clock; } } };
  const context = vm.createContext({ Buffer, process: processFacts });
  const api = vm.compileFunction(readerBody + '\nreturn {fileIdentity,captureBytes};',
    ['fs', 'path', 'userInfo', 'tmpdir', 'createHash'], { parsingContext: context, filename: fileURLToPath(readerUrl) })(
    filesystem, paths, () => ({ homedir: home }), () => paths.join(home, 'temp'), createHash);
  return { api, file, content, events, opened, closed, metadataFd, dataFd,
    get dataAttempts() { return dataAttempts; } };
}
function completedSyntheticControl() {
  const fixture = simulatedReader();
  const result = fixture.api.captureBytes(fixture.file, 100);
  assert.equal(result.identity.path, fixture.file); assert.equal(result.identity.bytes, fixture.content.length);
  assert.equal(result.identity.sha256, fixtureHash(fixture.content)); assert.deepEqual(result.data, fixture.content);
  assert.deepEqual(fixture.closed, [fixture.dataFd, fixture.metadataFd]);
  return fixture;
}
function failureOf(action) {
  try { action(); } catch (error) { return error; }
  assert.fail('synthetic refusal must throw');
}
function allAcquiredClosesAttempted(fixture) {
  assert.deepEqual([...fixture.closed].sort((a, b) => a - b), [...fixture.opened].sort((a, b) => a - b));
  assert.equal(fixture.events.at(-1).stage, 'clock');
}

test('T2087 synthetic Linux regular capture preserves bytes and held-descriptor ordering', () => {
  const fixture = completedSyntheticControl(), stages = fixture.events.map(event => event.stage);
  assert.equal(fixture.dataAttempts, 1);
  assert.ok(stages.indexOf('metadata-open') < stages.indexOf('metadata-stat'));
  assert.ok(stages.indexOf('metadata-stat') < stages.indexOf('proc-stat'));
  assert.ok(stages.indexOf('proc-readlink') < stages.indexOf('data-open'));
  assert.ok(stages.indexOf('data-stat') < stages.indexOf('read'));
  assert.ok(stages.indexOf('metadata-final-stat') < stages.indexOf('close-data'));
});

test('T2087 synthetic Linux descriptor zero remains owned and closes', () => {
  for (const config of [{ metadataFd: 0 }, { dataFd: 0 }]) {
    const fixture = simulatedReader(config);
    assert.equal(fixture.api.fileIdentity(fixture.file).sha256, fixtureHash(fixture.content));
    assert.deepEqual(fixture.closed, [fixture.dataFd, fixture.metadataFd]);
    assert.equal(fixture.closed.includes(0), true);
  }
});

test('T2087 synthetic nonregular metadata refuses before every data-open attempt', () => {
  completedSyntheticControl();
  for (const heldKind of ['fifo', 'device', 'socket', 'directory', 'symlink']) {
    const fixture = simulatedReader({ heldKind });
    const error = failureOf(() => fixture.api.fileIdentity(fixture.file));
    assert.equal(fixture.dataAttempts, 0, `${heldKind}: data-open was attempted before type admission`);
    assert.match(error.message, /not ordinary/);
    assert.deepEqual(fixture.closed, [fixture.metadataFd]);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic selected generation and budgets refuse before data open', () => {
  completedSyntheticControl();
  assert.equal(Number(2n ** 54n), Number(2n ** 54n + 1n));
  for (const config of [{ held: { ino: 2n ** 54n + 1n } }, { selected: { nlink: 0n } },
    { selected: { nlink: 2n ** 54n } }, { selected: { size: -1n } }, { selected: { size: 1001n } }]) {
    const fixture = simulatedReader(config);
    failureOf(() => fixture.api.fileIdentity(fixture.file, { maximum: 1000 }));
    assert.equal(fixture.dataAttempts, 0); assert.deepEqual(fixture.closed, [fixture.metadataFd]);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic procfs rejection never falls back to the input pathname', () => {
  completedSyntheticControl();
  for (const proc of ['missing', 'wrong-magic', 'linked-fd', 'writable-fd', 'wrong-owner', 'wrong-pid']) {
    const fixture = simulatedReader({ proc });
    const error = failureOf(() => fixture.api.fileIdentity(fixture.file));
    assert.match(error.message, /procfs descriptor view/); assert.equal(fixture.dataAttempts, 0);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic reopened and final generations cannot earn an identity', () => {
  completedSyntheticControl();
  for (const config of [{ reopened: { ino: 99n } }, { finalData: { ctimeMs: 99n } },
    { finalHeld: { ino: 99n } }, { finalPath: { ino: 99n } }, { proc: 'changed-final' }]) {
    const fixture = simulatedReader(config);
    const error = failureOf(() => fixture.api.fileIdentity(fixture.file));
    assert.match(error.message, /changed|not ordinary/); assert.equal(fixture.dataAttempts, 1);
    if (config.reopened) assert.equal(fixture.events.some(event => event.stage === 'read'), false);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic bounded loop preserves empty exact growth and short-read behavior', () => {
  for (const content of ['', 'exact']) {
    const fixture = simulatedReader({ content });
    const result = fixture.api.captureBytes(fixture.file, fixture.content.length);
    assert.equal(result.identity.sha256, fixtureHash(fixture.content)); assert.deepEqual(result.data, fixture.content);
    allAcquiredClosesAttempted(fixture);
  }
  for (const config of [{ content: 'x', payload: 'xy' }, { content: 'xy', payload: 'x' }, { invalidCount: true }]) {
    const fixture = simulatedReader(config);
    assert.match(failureOf(() => fixture.api.fileIdentity(fixture.file)).message, /changed|read count/);
    allAcquiredClosesAttempted(fixture);
  }
  const budget = simulatedReader({ content: 'x', payload: 'xy' });
  assert.match(failureOf(() => budget.api.fileIdentity(budget.file, { maximum: 1 })).message, /byte budget/);
  allAcquiredClosesAttempted(budget);
});

test('T2087 synthetic acquisition and read failures attempt every acquired close', () => {
  completedSyntheticControl();
  for (const throwAt of ['metadata-open', 'metadata-stat', 'proc-stat', 'data-open', 'data-stat', 'read',
    'data-final-stat', 'path-final-stat', 'metadata-final-stat', 'proc-final-stat']) {
    const fixture = simulatedReader({ throwAt });
    failureOf(() => fixture.api.fileIdentity(fixture.file));
    assert.ok(fixture.events.some(event => event.stage === throwAt), throwAt);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic close failures still attempt both closes and the final deadline', () => {
  completedSyntheticControl();
  for (const closeFailures of [['close-data'], ['close-metadata'], ['close-data', 'close-metadata']]) {
    const fixture = simulatedReader({ closeFailures });
    assert.match(failureOf(() => fixture.api.fileIdentity(fixture.file)).message, /fixture failure at close/);
    assert.deepEqual(fixture.closed, [fixture.dataFd, fixture.metadataFd]);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic cooperative deadline refusals retain descriptor closure', () => {
  completedSyntheticControl();
  for (const expireAt of ['metadata-open', 'metadata-stat', 'proc-stat', 'data-open', 'data-stat', 'read', 'close-data']) {
    const fixture = simulatedReader({ expireAt });
    assert.match(failureOf(() => fixture.api.fileIdentity(fixture.file)).message, /deadline expired/);
    allAcquiredClosesAttempted(fixture);
  }
});

test('T2087 synthetic non-Linux branch preserves pathname open and close ordering', () => {
  const fixture = simulatedReader({ platform: 'win32', selected: { nlink: 1n } });
  assert.equal(fixture.api.fileIdentity(fixture.file).sha256, fixtureHash(fixture.content));
  assert.equal(fixture.events.some(event => event.stage.startsWith('proc') || event.stage.startsWith('metadata')), false);
  assert.deepEqual(fixture.closed, [fixture.dataFd]); assert.equal(fixture.events.at(-1).stage, 'clock');
  const failedClose = simulatedReader({ platform: 'win32', selected: { nlink: 1n }, closeFailures: ['close-data'] });
  assert.match(failureOf(() => failedClose.api.fileIdentity(failedClose.file)).message, /close-data/);
  assert.equal(failedClose.events.at(-1).stage, 'close-data', 'preserve the original non-Linux close/check ordering');
});
