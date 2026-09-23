// WHAT THIS PINS.
//
// Windows recorded this application as hung four times on 2026-09-03 (AppHangB1
// 17:12:58, AppHangTransient 17:12:13 / 19:12:44 / 20:57:38) and wrote NO dump
// for any of them: the WER report folder holds Report.wer and nothing else, and
// LocalDumps is configured only for unrelated vendors. So there was no way, after
// the fact, to ask which piece of work stopped the loop.
//
// shell/main-lag.cjs answers that question at the time. This file pins the four
// properties the answer has to have to be worth anything:
//
//   1. A late tick is written down, and it NAMES the longest synchronous span
//      seen in the window that went missing -- not the nearest handler, not a
//      guess. Below the threshold nothing is written at all.
//   2. instrument() attributes lag to the IPC channel by name, through ipcMain's
//      own registration methods, so all 120 channels are covered by one hook and
//      the wrapped listener still returns what the real one returned.
//   3. The record is bounded and rotates, because a diagnostic that fills a disk
//      is a second defect.
//   4. It can never throw. A monitor that raises inside an IPC handler or inside
//      a timer with no catch above it would be worse than the hang.
//
// Discrimination: with shell/main-lag.cjs absent -- the state before this change
// -- every case fails at the import. With the threshold comparison removed, case
// 1's "quiet" assertion fails. With the blame reduced to "the last channel seen"
// rather than the longest span, case 1 fails on the name. With rotation removed,
// case 3 fails on the file size.
//
// The clock and the timer are injected, so nothing here sleeps and nothing here
// depends on how loaded this machine is.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { canonicalRootForTests } from "../canonical-root.mjs";
import { lagObservationBinding, readLagObservation, assessLagObservation } from "../main-thread-stall-packaged-qa.mjs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { createMainLagMonitor, UNATTRIBUTED } = require_("../../shell/main-lag.cjs");

function harness({ thresholdMs = 500, intervalMs = 250, maxBytes = 512 * 1024, fsImpl = fs } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "main-lag-"));
  const file = path.join(directory, "main-lag.log");
  let wall = 1_000_000;
  let mono = 0;
  const timers = [];
  const monitor = createMainLagMonitor({
    file,
    intervalMs,
    thresholdMs,
    maxBytes,
    fs: fsImpl,
    now: () => wall,
    monotonic: () => mono,
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimer: () => { timers.length = 0; },
  });
  return {
    monitor,
    file,
    directory,
    advanceWall: (ms) => { wall += ms; },
    advanceMono: (ms) => { mono += ms; },
    fire: () => { for (const fn of timers.slice()) fn(); },
    lines: () => (fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : []),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test("a late tick is written down and names the longest span in the window it missed", () => {
  const h = harness({ thresholdMs: 500, intervalMs: 250 });
  try {
    h.monitor.start();

    // A tick that is on time says nothing.
    h.advanceWall(250);
    h.fire();
    assert.deepEqual(h.lines(), [], "an on-time tick must not write a line");

    // A tick 90 ms late is still under the threshold and says nothing.
    h.advanceWall(340);
    h.fire();
    assert.deepEqual(h.lines(), [], "a lag below the threshold must not write a line");

    // Two spans run while the loop is held; the LONGER one is the blocker, and
    // it is deliberately not the most recent.
    const longer = h.monitor.span("mc-agent:start");
    h.advanceMono(1_800);
    longer();
    const shorter = h.monitor.span("mc-prefs:write");
    h.advanceMono(40);
    shorter();

    h.advanceWall(2_100);
    h.fire();

    const lines = h.lines();
    assert.equal(lines.length, 1, "a lag over the threshold must write exactly one line");
    assert.equal(lines[0].blocker, "mc-agent:start", "the line must name the LONGEST span, not the most recent one");
    assert.equal(lines[0].blockerMs, 1_800, "the line must carry how long that span held the thread");
    assert.equal(lines[0].lagMs, 2_100 - 250, "the line must carry how late the tick was");
    assert.equal(lines[0].pid, process.pid, "the line must say which process it is about");
    assert.ok(Number.isFinite(Date.parse(lines[0].at)), "the line must carry a readable time");

    // The window resets: the next late tick must not re-blame a span that has
    // already been reported.
    h.advanceWall(3_000);
    h.fire();
    const after = h.lines();
    assert.equal(after.length, 2, "a second late tick must write a second line");
    assert.equal(after[1].blocker, UNATTRIBUTED, "a window with no measured span must say so rather than repeat the last name");
  } finally {
    h.cleanup();
  }
});

test("a drained burst of many small spans under one label is named by topTotal, while blocker/blockerMs still name the single longest span", () => {
  // The previous generation's own record (gen-6bfe1887, pid 20464) named this
  // exact shape: a stall of lagMs 6544 attributed to agent-event:forward with
  // blockerMs 0, and eleven of twelve stalls carrying a blockerMs far below
  // their lagMs -- a contended lock's retry loop, calling its sleeper many
  // times without ever yielding, so no SINGLE span was the stall even though
  // the label's own total was.
  const h = harness({ thresholdMs: 500, intervalMs: 250 });
  try {
    h.monitor.start();

    // Twenty 1ms spans under one label: no single one is remarkable, but
    // together they hold the thread for 20ms.
    for (let round = 0; round < 20; round += 1) {
      const end = h.monitor.span("tree-lock:wait:heartbeat");
      h.advanceMono(1);
      end();
    }
    // One other span, longer than any single burst span but shorter than the
    // burst's own total.
    const single = h.monitor.span("mc-agent:start");
    h.advanceMono(15);
    single();

    // intervalMs (250) + thresholdMs (500), plus margin, so the tick is
    // unambiguously late regardless of the monotonic time spent above.
    h.advanceWall(900);
    h.fire();

    const lines = h.lines();
    assert.equal(lines.length, 1, "a lag over the threshold must write exactly one line");

    // blocker/blockerMs are UNCHANGED: the single longest SPAN still wins
    // that comparison, so an existing reader of those two fields sees exactly
    // what it always saw.
    assert.equal(lines[0].blocker, "mc-agent:start", "blocker must still name the single longest span, unchanged");
    assert.equal(lines[0].blockerMs, 15, "blockerMs must still carry that span's own duration, unchanged");

    // topTotal answers the question blocker cannot: which label held the
    // thread the longest IN AGGREGATE. 20ms of burst outranks the 15ms
    // single span, even though no burst span was individually the longest.
    assert.equal(lines[0].topTotal, "tree-lock:wait:heartbeat",
      "topTotal must name the label with the highest TOTAL, not the label with the longest single span");
    assert.deepEqual(lines[0].blockers["tree-lock:wait:heartbeat"], { totalMs: 20, count: 20, maxMs: 1 },
      "the burst label's own total/count/max must all be carried");
    assert.deepEqual(lines[0].blockers["mc-agent:start"], { totalMs: 15, count: 1, maxMs: 15 },
      "a label with one span must still appear, with count 1 and its span as both total and max");
  } finally {
    h.cleanup();
  }
});

test("blockers/topTotal reset with the same window blocker/blockerMs already reset with", () => {
  const h = harness({ thresholdMs: 500, intervalMs: 250 });
  try {
    h.monitor.start();

    const end = h.monitor.span("mc-agent:start");
    h.advanceMono(900);
    end();
    h.advanceWall(1_200);
    h.fire();

    const first = h.lines();
    assert.equal(first.length, 1);
    assert.equal(first[0].topTotal, "mc-agent:start");

    // A second late tick with nothing measured in its own window must not
    // repeat the previous window's totals any more than it repeats blocker.
    h.advanceWall(3_000);
    h.fire();
    const after = h.lines();
    assert.equal(after.length, 2);
    assert.equal(after[1].blocker, UNATTRIBUTED);
    assert.equal(after[1].topTotal, UNATTRIBUTED, "topTotal must reset with the window, not repeat the last one attributed");
    assert.deepEqual(after[1].blockers, {}, "an empty window must carry an empty blockers map, not the previous window's");
  } finally {
    h.cleanup();
  }
});

test("instrument() attributes lag to the IPC channel by name and preserves the listener's answer", () => {
  const h = harness({ thresholdMs: 500, intervalMs: 250 });
  try {
    const registered = new Map();
    const ipcMain = {
      handle(channel, listener) { registered.set(`handle:${channel}`, listener); },
      on(channel, listener) { registered.set(`on:${channel}`, listener); },
    };
    assert.equal(h.monitor.instrument(ipcMain), true, "the first instrument() must install the wrappers");
    assert.equal(h.monitor.instrument(ipcMain), false, "a second instrument() must be a no-op rather than a double wrap");

    ipcMain.handle("mc-settings:read", (event, value) => {
      h.advanceMono(1_400);
      return { ok: true, echoed: value, sender: event.id };
    });
    ipcMain.on("mc-prefs:write", () => { h.advanceMono(20); });

    h.monitor.start();
    const answer = registered.get("handle:mc-settings:read")({ id: 7 }, "asked");
    assert.deepEqual(answer, { ok: true, echoed: "asked", sender: 7 }, "the wrapper must return the listener's own answer unchanged");
    registered.get("on:mc-prefs:write")({});

    h.advanceWall(1_700);
    h.fire();

    const lines = h.lines();
    assert.equal(lines.length, 1, "the late tick must be recorded");
    assert.equal(lines[0].blocker, "mc-settings:read", "the channel that held the thread must be named");
    assert.equal(lines[0].blockerMs, 1_400, "the channel's synchronous span must be measured");
  } finally {
    h.cleanup();
  }
});

test("the record is bounded and rotates rather than growing without limit", () => {
  // Small enough that a handful of lines crosses it, so the bound is exercised
  // rather than asserted about.
  const h = harness({ thresholdMs: 100, intervalMs: 10, maxBytes: 400 });
  try {
    h.monitor.start();
    for (let round = 0; round < 40; round += 1) {
      const end = h.monitor.span(`mc-channel-${round}`);
      h.advanceMono(200);
      end();
      h.advanceWall(1_000);
      h.fire();
    }
    const live = fs.statSync(h.file).size;
    assert.ok(live > 0, "the live record must hold the most recent events");
    assert.ok(live <= 400, `the live record must stay within its bound, got ${live} bytes`);

    const rolled = `${h.file}.1`;
    assert.ok(fs.existsSync(rolled), "the previous half of the record must be kept as one rolled copy");
    assert.ok(fs.statSync(rolled).size <= 400, "the rolled copy must be within the same bound");
    assert.equal(fs.existsSync(`${h.file}.2`), false, "only ONE rolled copy is kept, so the total stays bounded");

    const newest = h.lines();
    assert.ok(newest.length > 0, "the live record must still parse as one event per line");
    assert.equal(newest[newest.length - 1].blocker, "mc-channel-39", "the live record must hold the newest event");
  } finally {
    h.cleanup();
  }
});

test("a monitor that cannot write, and a listener that throws, never take the process down", () => {
  const exploding = {
    mkdirSync() { throw new Error("no directory"); },
    statSync() { throw new Error("no stat"); },
    appendFileSync() { throw new Error("no write"); },
    renameSync() { throw new Error("no rename"); },
    writeFileSync() { throw new Error("no truncate"); },
    rmSync() { throw new Error("no remove"); },
  };
  const h = harness({ thresholdMs: 100, intervalMs: 10, fsImpl: exploding });
  try {
    const ipcMain = { handle(channel, listener) { this.last = listener; } };
    h.monitor.instrument(ipcMain);
    ipcMain.handle("mc-agent:send", () => { h.advanceMono(900); throw new Error("the handler failed"); });

    h.monitor.start();
    assert.throws(() => ipcMain.last({}), /the handler failed/, "the wrapper must not swallow the listener's own error");

    h.advanceWall(2_000);
    h.fire();

    const stats = h.monitor.stats();
    assert.equal(stats.writeFailures, 1, "a write that could not land must be counted, not thrown");
    assert.equal(stats.depth, 0, "a listener that threw must still close its span");
    assert.equal(h.monitor.stop(), true, "the monitor must still stop cleanly");
  } finally {
    h.cleanup();
  }
});


// Managed gate tests use the real producer/store with memory-only IO. They do
// not call the legacy disk harness above or the packaged executable/CDP route.
function managedLagFixture({ attach = true } = {}) {
  const { createDiagnosticStore, resolveDiagnosticPolicy } = require_(path.join(canonicalRootForTests({ requireConfigured: true }), "src/lib/diagnostic-retention.js"));
  const directory = path.resolve('synthetic-stall-profile/local/userdata/diagnostics-v1');
  const files = new Map(), directories = new Set(), inodes = new Map();
  let identity = 0, wall = 1000000, mono = 0, tick;
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const disk = {
    promises: {},
    mkdirSync(p) { directories.add(p); },
    realpathSync: p => p,
    lstatSync(p) {
      if (!files.has(p) && !directories.has(p)) throw missing();
      return { isFile: () => files.has(p), isDirectory: () => directories.has(p), isSymbolicLink: () => false,
        size: files.get(p)?.length || 0, nlink: 1, dev: 1, ino: inodes.get(p) || 1, mtimeMs: 1 };
    },
    writeFileSync(p, value, options) {
      if (options?.flag === 'wx' && files.has(p)) throw new Error('exclusive creation refused');
      files.set(p, Buffer.from(value)); inodes.set(p, ++identity);
    },
    appendFileSync(p, value) { files.set(p, Buffer.concat([files.get(p), Buffer.from(value)])); },
    readFileSync(p, encoding) { if (!files.has(p)) throw missing(); const b = files.get(p); return encoding ? b.toString(encoding) : Buffer.from(b); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); inodes.set(to, ++identity); },
  };
  Object.assign(disk.promises, { lstat: async p => disk.lstatSync(p), realpath: async p => p,
    readFile: async (p, encoding) => disk.readFileSync(p, encoding),
    opendir: async p => {
      if (!directories.has(p)) throw missing();
      const names = [...files.keys()].filter(f => path.dirname(f) === p).map(f => ({ name: path.basename(f) }));
      let index = 0; return { read: async () => names[index++] || null, close: async () => {} };
    },
  });
  const store = createDiagnosticStore({ directory, fs: disk, now: () => wall, pid: process.pid,
    uuid: () => (++identity).toString(16).padStart(8, '0') + '-0000-0000-0000-000000000000',
    readPolicy: () => resolveDiagnosticPolicy(), isAlive: () => true });
  const writer = store.createWriter('main-lag');
  const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('const mainLagMonitor = createMainLagMonitor('), end = main.indexOf('\n/* T180:', start);
  assert.ok(start >= 0 && end > start, 'actual main monitor construction is present');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [wall])); } }
  const monitor = vm.runInNewContext(main.slice(start, end) + '\nmainLagMonitor', {
    path, SHELL_USER_DATA_PATH: 'unused-legacy', mainLagThresholdOverride: { thresholdMs: 50 },
    mainLagDiagnosticWriter: writer, process: { pid: process.pid }, Date: Clock,
    ipcMain: { __mainLagInstrumented: !attach, handle() {}, on() {} },
    createMainLagMonitor: options => createMainLagMonitor({ ...options, now: () => wall, monotonic: () => mono,
      setTimer: fn => { tick = fn; return { unref() {} }; }, clearTimer() {},
      fs: new Proxy({}, { get() { throw new Error('legacy diagnostic IO forbidden'); } }) }),
  });
  const binding = { directory, pid: process.pid, startedAt: wall };
  const observe = overrides => readLagObservation({ binding, inspect: request => store.inspect(request), fileSystem: disk, now: () => wall, ...overrides });
  return { files, disk, store, writer, binding, observe,
    stall(label, worst = null) {
      monitor.start(); const done = monitor.span(label); mono += 90; done();
      if (worst) { const endSpan = monitor.span(worst); mono += 150; endSpan(); }
      wall += 1000; tick();
    } };
}


test('packaged stall gate observes the actual attached managed sink without a manufactured stall', async () => {
  const f = managedLagFixture(); const result = await f.observe();
  assert.equal(result.ok, true, result.reason); assert.equal(result.rows.length, 0);
  assert.equal(result.marker.event, 'diagnostic-sink-ready'); assert.equal(assessLagObservation(result).ok, true);
  assert.equal((await managedLagFixture({ attach: false }).observe()).ok, false);
});

test('packaged stall gate refuses real guarded producer rows through both attribution paths', async () => {
  for (const worst of [null, 'unrelated-slower-channel']) {
    const f = managedLagFixture(); f.stall('mc-prefs:write', worst); const observation = await f.observe();
    assert.equal(observation.ok, true, observation.reason);
    const result = assessLagObservation(observation); assert.equal(result.ok, false); assert.equal(result.offenders.length, 1);
  }
});

test('packaged stall gate never turns absent incomplete or unreadable inventories into success', async () => {
  for (const change of [v => ({ ...v, ok: false }), v => ({ ...v, complete: false }),
    v => ({ ...v, scanComplete: false, files: [] }), v => ({ ...v, unknownCount: 1 }),
    v => ({ ...v, writers: [] }), v => ({ ...v, directory: '/wrong-root' })]) {
    const f = managedLagFixture(); let calls = 0;
    const result = await f.observe({ inspect: async request => { calls++; return change(await f.store.inspect(request)); } });
    assert.equal(assessLagObservation(result).ok, false); assert.ok(calls <= 8);
  }
});

test('packaged stall gate refuses suppressed failed closed and unowned writers', async () => {
  for (const delta of [{ dropped: 1 }, { failure: 'EACCES' }, { closed: true }, { id: null }, { pid: process.pid + 1 }, { totalBytes: 1 }]) {
    const f = managedLagFixture();
    const result = await f.observe({ inspect: async request => { const v = await f.store.inspect(request); v.writers[0] = { ...v.writers[0], ...delta }; return v; } });
    assert.equal(assessLagObservation(result).ok, false, JSON.stringify(delta));
  }
});

test('packaged stall gate refuses malformed missing suppressed and foreign segment evidence', async () => {
  for (const corrupt of [
    (f, data, meta) => f.files.set(meta, Buffer.from('{')),
    (f, data) => f.files.set(data, Buffer.from('{broken}\n')),
    (f, data) => f.files.delete(data),
    (f, data, meta) => { const v = JSON.parse(f.files.get(meta)); v.outputSuppressed = 'diagnostic-output-budget'; f.files.set(meta, Buffer.from(JSON.stringify(v))); },
    (f, data, meta) => { const v = JSON.parse(f.files.get(meta)); v.pid++; f.files.set(meta, Buffer.from(JSON.stringify(v))); },
    (f, data) => { const v = JSON.parse(f.files.get(data)); v.at = new Date(0).toISOString(); f.files.set(data, Buffer.from(JSON.stringify(v) + '\n')); },
  ]) {
    const f = managedLagFixture(), data = path.join(f.binding.directory, f.writer.state().id); corrupt(f, data, data + '.meta.json');
    assert.equal(assessLagObservation(await f.observe()).ok, false);
  }
  const f = managedLagFixture();
  for (const code of ['ENOENT', 'EACCES']) {
    const result = await f.observe({ fileSystem: { ...f.disk, readFileSync() { throw Object.assign(new Error(code), { code }); } } });
    assert.equal(result.reason, code); assert.equal(assessLagObservation(result).ok, false);
  }
});

test('packaged stall gate reads every page once and refuses duplicate segment identities', async () => {
  const f = managedLagFixture(), value = await f.store.inspect(); const requests = [];
  const result = await f.observe({ inspect: async request => {
    requests.push(request); return requests.length === 1 ? { ...value, files: [], complete: false, scanComplete: false } : value;
  } });
  assert.equal(result.ok, true, result.reason); assert.deepEqual(requests, [{ next: false }, { next: true }]);
  assert.equal((await f.observe({ inspect: async () => ({ ...value, files: [...value.files, ...value.files] }) })).ok, false);
});

test('packaged stall gate binds the real services resolver to the sterile profile instead of user-data-dir alone', () => {
  const { qaProfileDirectories, sterileLaunchEnvironment } = require_('../lib/sterile-launch.cjs');
  const { resolveServicesRoot } = require_(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/durable-memory-file.js'));
  const profile = path.resolve('synthetic-stall-profile'), userData = path.join(profile, 'userdata');
  const environment = sterileLaunchEnvironment(qaProfileDirectories(profile), { LOCALAPPDATA: '/ambient-owner',
    TOOLSENABLED_STATE_ROOT: '/ambient-owner/capability', TOOLSENABLED_SETTINGS_PATH: '/ambient-owner/settings.json' });
  const binding = lagObservationBinding({ profile, userData, environment, pid: process.pid, startedAt: 1 });
  const actual = resolveServicesRoot({ env: { ...environment, TOOLSENABLED_STATE_ROOT: path.join(userData, 'capability') }, platform: 'linux',
    fileSystem: { lstatSync() { throw Object.assign(new Error('fresh profile has no marker'), { code: 'ENOENT' }); } } });
  assert.equal(binding.directory, path.join(actual, 'diagnostics-v1')); assert.equal(environment.TOOLSENABLED_SETTINGS_PATH, undefined);
  assert.throws(() => lagObservationBinding({ profile, userData, environment: { ...environment, LOCALAPPDATA: '/ambient-owner' }, pid: process.pid, startedAt: 1 }), /not isolated/);
});

// T837 (STALLS-01). Two 9 s main-thread stalls on gen-ca97a363 ran in the courier's delivery path,
// which no timed span covered. The spans that now cover it carry how big the work was, and only that.
test("a span's counts ride with its label's longest span into the record, numbers only, and a bad description costs nothing", () => {
  const h = harness({ thresholdMs: 500, intervalMs: 250 });
  try {
    h.monitor.start();
    assert.equal(h.monitor.note("tree-courier:batch", () => { h.advanceMono(4); return 42; }, () => ({ messages: 1, chars: 120 })), 42,
      "note() still returns what the wrapped call returned");
    h.monitor.note("tree-courier:batch", () => h.advanceMono(31),
      () => ({ messages: 16, chars: 63999.6, text: "must not appear", nested: { chars: 1 }, "not a key": 5, negative: -1 }));
    h.monitor.note("tree-courier:batch", () => h.advanceMono(2), () => ({ messages: 2, chars: 300 }));
    h.monitor.note("tree-courier:decide", () => h.advanceMono(1));
    h.monitor.note("tree-courier:send-sync", () => h.advanceMono(3), () => { throw new Error("a description that throws"); });
    assert.throws(() => h.monitor.note("tree-courier:send-sync", () => { throw new Error("the wrapped call failed"); }, () => ({ messages: 9 })),
      /the wrapped call failed/, "a wrapped call that throws still throws, and its description is not asked for");
    h.advanceWall(250 + 900);
    h.fire();
    const [row] = h.lines();
    assert.ok(row, "the late tick was recorded");
    assert.deepEqual(row.blockers["tree-courier:batch"],
      { totalMs: 37, count: 3, maxMs: 31, detail: { messages: 16, chars: 64000 } },
      "the counts are those of the longest span of the label, whole numbers only");
    assert.deepEqual(row.blockers["tree-courier:decide"], { totalMs: 1, count: 1, maxMs: 1 }, "a span with no counts keeps the shape it always had");
    assert.deepEqual(row.blockers["tree-courier:send-sync"], { totalMs: 3, count: 2, maxMs: 3 }, "a description that throws is dropped, not raised");
    assert.equal(JSON.stringify(row).includes("must not appear"), false, "no text reaches the record");
  } finally {
    h.cleanup();
  }
});
