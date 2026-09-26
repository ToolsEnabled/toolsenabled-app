import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modulePath = process.env.PERFORMANCE_COMPARE_MODULE
  ? path.resolve(process.env.PERFORMANCE_COMPARE_MODULE)
  : fileURLToPath(new URL('../performance-retained-compare.mjs', import.meta.url));
const api = await import(pathToFileURL(modulePath).href);
const { isNonLagDiagnosticRow, loadObservationLog, summarizeLag, summarizeObservationLog } = api;
const require = createRequire(import.meta.url);
const { createMainLagMonitor } = require('../../shell/main-lag.cjs');
const epoch = Date.parse('2026-09-23T20:00:00.000Z');
const at = offset => new Date(epoch + offset).toISOString();
const monitorId = 'monitor-t837-fixture';
const pid = 4242;

function row(sequence, offset, fields = {}) {
  return { diagnosticsVersion: 1, monitorId, sequence, at: at(offset), pid, writeFailures: 0, ...fields };
}

function windowRow(sequence, start, end, index, count, cumulativeCount, partial) {
  return row(sequence, end, { event: 'ipc-count-window', channel: 'mc-settings:tree-slots', windowMs: 5000,
    windowIndex: index, windowStart: at(start), windowEnd: at(end), count, cumulativeCount, partial });
}

function validRows() {
  return [
    row(1, 0, { event: 'diagnostic-observation-start', windowMs: 5000, windowStart: at(0) }),
    row(2, 0, { event: 'page-lifecycle', route: '/computers', phase: 'mount', mountId: 1, senderId: 10 }),
    windowRow(3, 0, 5000, 0, 357, 357, false),
    row(4, 5000, { lagMs: 9670, blockers: {
      'tree-courier:read-dispatch': { count: 1, totalMs: 27 },
      'await:mc-agent:goal': { count: 1, totalMs: 9600 },
    } }),
    windowRow(5, 5000, 10000, 1, 232, 589, false),
    windowRow(6, 10000, 12000, 2, 0, 589, true),
    row(7, 12000, { event: 'diagnostic-observation-stop' }),
  ];
}

function retainedLog(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't837-postflight-diagnostics-'));
  const log = path.join(root, 'main-lag.ndjson');
  fs.writeFileSync(log, rows.map(value => JSON.stringify(value)).join('\n') + '\n');
  return log;
}

test('complete observation log anchors at computers, preserves lag semantics, and bounds IPC windows', () => {
  const out = summarizeObservationLog(validRows());
  assert.equal(out.coverage.status, 'OBSERVED');
  assert.equal(out.coverage.monitorId, monitorId);
  assert.equal(out.coverage.pid, pid);
  assert.equal(out.lifecycle.firstComputersMount, true);
  assert.equal(out.slotWindows.scope, 'all routes observed by the main-process mc-settings:tree-slots listener');
  assert.equal(out.slotWindows.observedSlotReads, 589);
  assert.equal(out.slotWindows.maxSlotReadsPerContinuous5sWindow, 357);
  assert.equal(out.slotWindows.completeCount, 2);
  assert.equal(out.slotWindows.partialCount, 1);
  assert.equal(out.wholeRunSlotReads, 589);
  assert.equal(out.stallsAtLeast1000Ms.length, 1);
  assert.equal(out.stallsAtLeast1000Ms[0].lagMs, 9670);
  assert.equal(out.stallsAtLeast1000Ms[0].attribution, 'UNKNOWN');
});

test('legacy ready rows are ignored without weakening the versioned observation contract', () => {
  const out = summarizeObservationLog([{ event: 'diagnostic-sink-ready', producer: 'main-lag' }, ...validRows()]);
  assert.equal(out.readyMarkers, 1);
  assert.equal(out.coverage.status, 'OBSERVED');
});

test('a live log reports only closed windows and leaves the trailing open interval unknown', () => {
  const out = summarizeObservationLog(validRows().slice(0, 5));
  assert.equal(out.coverage.status, 'OBSERVED');
  assert.equal(out.coverage.complete, false);
  assert.equal(out.coverage.stopSeen, false);
  assert.equal(out.slotWindows.observedSlotReads, 589);
  assert.equal(out.slotWindows.maxSlotReadsPerContinuous5sWindow, 357);
  assert.equal(out.wholeRunSlotReads, 'UNKNOWN');
  assert.deepEqual(out.coverage.interval, { start: at(0), end: at(10000) });
  assert.ok(out.coverage.limits.some(reason => /trailing open window/i.test(reason)));
});

test('a closed log may end at a complete window boundary without a partial tail', () => {
  const rows = validRows().slice(0, 5);
  rows.push(row(6, 10000, { event: 'diagnostic-observation-stop' }));
  const out = summarizeObservationLog(rows);
  assert.equal(out.coverage.status, 'OBSERVED');
  assert.equal(out.coverage.complete, true);
  assert.equal(out.wholeRunSlotReads, 589);
  assert.equal(out.slotWindows.partialCount, 0);

  const afterStop = [...rows, row(7, 10000, {
    event: 'page-lifecycle', route: 'computers', phase: 'unmount', mountId: 1, senderId: 10,
  })];
  const afterStopOut = summarizeObservationLog(afterStop);
  assert.equal(afterStopOut.coverage.status, 'UNKNOWN');
  assert.ok(afterStopOut.coverage.reasons.some(reason => /rows follow stop/i.test(reason)));
});

test('strict non-lag classification accepts only versioned known rows and never consumes lag rows', () => {
  const rows = validRows();
  assert.equal(isNonLagDiagnosticRow(rows[0]), true);
  assert.equal(isNonLagDiagnosticRow(rows[1]), true);
  assert.equal(isNonLagDiagnosticRow(rows[2]), true);
  assert.equal(isNonLagDiagnosticRow(rows[5]), true);
  assert.equal(isNonLagDiagnosticRow(rows[6]), true);
  assert.equal(isNonLagDiagnosticRow({ ...rows[4], event: 'diagnostic-observation-gap', reason: 'clock-gap' }), true);
  assert.equal(isNonLagDiagnosticRow(rows[3]), false);
  assert.equal(isNonLagDiagnosticRow({ ...rows[1], route: 'private-owner' }), false);
  assert.equal(isNonLagDiagnosticRow({ ...rows[6], event: 'diagnostic-observation-gap', reason: 'unknown' }), false);
  assert.equal(isNonLagDiagnosticRow({ ...rows[2], cumulativeCount: 1 }), false);
  assert.equal(summarizeLag(rows).stallsAtLeast1000Ms.length, 1);

  const envelopeOnly = validRows();
  delete envelopeOnly[0].event;
  const envelopeOnlyOut = summarizeObservationLog(envelopeOnly);
  assert.equal(envelopeOnlyOut.coverage.status, 'UNKNOWN');
  assert.ok(envelopeOnlyOut.coverage.reasons.some(reason => /unrecognized observation event/i.test(reason)));
});

test('lag before the computers mount is outside the anchored lag interval', () => {
  const rows = validRows().map((value, index) => index === 1
    ? { ...value, sequence: value.sequence + 1, at: at(1000) }
    : value.sequence >= 2 ? { ...value, sequence: value.sequence + 1 } : value);
  rows.splice(1, 0, row(2, 500, { lagMs: 4000, blockers: {} }));
  const out = summarizeObservationLog(rows);
  assert.equal(out.coverage.status, 'OBSERVED');
  assert.equal(out.stallsAtLeast1000Ms.length, 1);
  assert.equal(out.stallsAtLeast1000Ms[0].at, at(5000));
});

test('foreign monitor and pid rows are reported separately and cannot become the computers anchor', () => {
  const foreign = row(1, 0, { monitorId: 'other-monitor', pid: 5252,
    event: 'page-lifecycle', route: 'home', phase: 'mount', mountId: 1, senderId: 11 });
  const out = summarizeObservationLog([foreign, ...validRows()]);
  assert.equal(out.coverage.status, 'OBSERVED');
  assert.equal(out.lifecycle.foreignSessionRows, 1);
  assert.equal(out.lifecycle.firstComputersMount, true);
  assert.equal(out.coverage.sequenceRows, 7);
});

test('a foreign computers mount before the selected process makes mixed-anchor coverage unknown', () => {
  const foreign = row(1, 0, { monitorId: 'other-monitor', pid: 5252,
    event: 'page-lifecycle', route: 'computers', phase: 'mount', mountId: 1, senderId: 11 });
  const out = summarizeObservationLog([foreign, ...validRows()]);
  assert.equal(out.coverage.status, 'UNKNOWN');
  assert.ok(out.coverage.reasons.some(reason => /multiple computers mount identities/i.test(reason)));
});

test('missing start or sequence continuity refuses whole-run acceptance without fabricating lag rows', () => {
  const missingStart = validRows().slice(1);
  const missingStartOut = summarizeObservationLog(missingStart);
  assert.equal(missingStartOut.coverage.status, 'UNKNOWN');
  assert.equal(missingStartOut.wholeRunSlotReads, 'UNKNOWN');
  assert.ok(missingStartOut.coverage.reasons.some(reason => /start|sequence/i.test(reason)));

  const missingSequence = validRows();
  missingSequence[4] = { ...missingSequence[4], sequence: 8 };
  const missingSequenceOut = summarizeObservationLog(missingSequence);
  assert.equal(missingSequenceOut.coverage.status, 'UNKNOWN');
  assert.equal(missingSequenceOut.stallsAtLeast1000Ms.length, 1);
  assert.ok(missingSequenceOut.coverage.reasons.some(reason => /sequence discontinuity/i.test(reason)));

  const noLag = validRows();
  noLag[3] = row(4, 5000, { event: 'page-lifecycle', route: 'computers', phase: 'unmount', mountId: 1, senderId: 10 });
  const noLagOut = summarizeObservationLog(noLag);
  assert.equal(noLagOut.coverage.status, 'OBSERVED');
  assert.equal(noLagOut.stallsAtLeast1000Ms.length, 0);
  assert.equal(noLagOut.samples.length, 0);

  const unknownEvent = validRows().map((value, index) => index === 3
    ? { ...value, event: 'untrusted-diagnostic-event' } : value);
  const unknownEventOut = summarizeObservationLog(unknownEvent);
  assert.equal(unknownEventOut.coverage.status, 'UNKNOWN');
  assert.ok(unknownEventOut.coverage.reasons.some(reason => /combines a lag observation with event|unrecognized observation event/i.test(reason)));
});

test('clock gaps, explicit gap rows, and write failures make coverage unknown while retaining measured values', () => {
  const clockGap = validRows();
  clockGap[3] = { ...clockGap[3], at: at(60000) };
  const clockGapOut = summarizeObservationLog(clockGap);
  assert.equal(clockGapOut.coverage.status, 'UNKNOWN');
  assert.equal(clockGapOut.slotWindows.observedSlotReads, 589);
  assert.ok(clockGapOut.coverage.reasons.some(reason => /clock gap|regression/i.test(reason)));

  const explicitGap = validRows();
  explicitGap[3] = { ...explicitGap[3], event: 'diagnostic-observation-gap', reason: 'clock-gap' };
  const explicitGapOut = summarizeObservationLog(explicitGap);
  assert.equal(explicitGapOut.coverage.status, 'UNKNOWN');
  assert.ok(explicitGapOut.coverage.reasons.some(reason => /diagnostic-observation-gap/i.test(reason)));

  const writeFailure = validRows().map(value => ({ ...value, writeFailures: value.sequence >= 4 ? 1 : 0 }));
  const writeFailureOut = summarizeObservationLog(writeFailure);
  assert.equal(writeFailureOut.coverage.status, 'UNKNOWN');
  assert.equal(writeFailureOut.coverage.writeFailures, 1);
  assert.equal(writeFailureOut.stallsAtLeast1000Ms.length, 1);

  const wrongCumulative = validRows();
  wrongCumulative[4] = { ...wrongCumulative[4], cumulativeCount: 600 };
  const wrongCumulativeOut = summarizeObservationLog(wrongCumulative);
  assert.equal(wrongCumulativeOut.coverage.status, 'UNKNOWN');
  assert.ok(wrongCumulativeOut.coverage.reasons.some(reason => /cumulative count is not exact/i.test(reason)));

  const partialCount = validRows();
  partialCount[5] = { ...partialCount[5], count: 777, cumulativeCount: 1366 };
  const partialCountOut = summarizeObservationLog(partialCount);
  assert.equal(partialCountOut.coverage.status, 'OBSERVED');
  assert.equal(partialCountOut.slotWindows.maxSlotReadsPerContinuous5sWindow, 357);
  assert.deepEqual(partialCountOut.slotWindows.partialWindowCounts, [777]);

  const lateAnchor = [
    row(1, 0, { event: 'diagnostic-observation-start', windowMs: 5000, windowStart: at(0) }),
    windowRow(2, 0, 5000, 0, 4, 4, false),
    row(3, 6000, { event: 'page-lifecycle', route: 'computers', phase: 'mount', mountId: 1, senderId: 10 }),
    row(4, 7000, { lagMs: 1400, blockers: {} }),
  ];
  const lateAnchorOut = summarizeObservationLog(lateAnchor);
  assert.equal(lateAnchorOut.coverage.status, 'UNKNOWN');
  assert.deepEqual(lateAnchorOut.coverage.interval, { start: at(6000), end: at(5000) });
  assert.ok(lateAnchorOut.coverage.reasons.some(reason => /no closed IPC window follows/i.test(reason)));
  assert.ok(lateAnchorOut.coverage.limits.some(reason => /outside the proven .* interval/i.test(reason)));
});

test('the log CLI reads retained NDJSON and returns source custody with the same summary', () => {
  const log = retainedLog(validRows());
  const output = execFileSync(process.execPath, [modulePath, '--log', log], { encoding: 'utf8' });
  const parsed = JSON.parse(output);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.coverage.status, 'OBSERVED');
  assert.equal(parsed.slotWindows.maxSlotReadsPerContinuous5sWindow, 357);
  assert.equal(parsed.source.bytes > 0, true);
  assert.match(parsed.source.sha256, /^[a-f0-9]{64}$/);
});

test('real main lag monitor rows round-trip through the reader with the Computers anchor', () => {
  let clock = Date.parse('2026-09-23T21:00:00.000Z');
  let timerCallback;
  const rows = [];
  const listeners = new Map();
  const monitor = createMainLagMonitor({
    file: '/inert/t837-main-lag.ndjson',
    observeIpcWindows: true,
    now: () => clock,
    monotonic: () => clock,
    cpuUsage: () => ({ user: 0, system: 0 }),
    threadCpuUsage: null,
    setTimer: callback => { timerCallback = callback; return { unref() {} }; },
    clearTimer() {},
    appendSink: line => {
      rows.push(JSON.parse(line));
      return { written: true };
    },
  });
  const ipc = {
    on(channel, listener) {
      listeners.set(channel, listener);
      return this;
    },
  };
  assert.equal(monitor.instrument(ipc), true);
  ipc.on('mc-settings:tree-slots', event => { event.returnValue = { ok: true }; });
  assert.equal(monitor.start(), true);
  assert.equal(monitor.pageLifecycle({ route: 'computers', phase: 'mount', mountId: 1 }, { senderId: 11 }), true);
  const readSlots = () => {
    const event = {};
    listeners.get('mc-settings:tree-slots')(event);
    assert.deepEqual(event.returnValue, { ok: true });
  };
  clock += 100; readSlots();
  clock += 100; readSlots();
  clock += 4799; readSlots();
  clock += 1; readSlots();
  clock += 2000; readSlots();
  clock += 3000;
  readSlots();
  monitor.stop();
  assert.equal(typeof timerCallback, 'function');

  const summary = summarizeObservationLog(rows);
  assert.equal(summary.coverage.status, 'OBSERVED');
  assert.equal(summary.coverage.complete, true);
  assert.equal(summary.lifecycle.firstComputersMount, true);
  assert.equal(summary.slotWindows.observedSlotReads, 6);
  assert.equal(summary.slotWindows.maxSlotReadsPerContinuous5sWindow, 3);
  assert.equal(summary.slotWindows.completeCount, 2);
  assert.equal(summary.slotWindows.partialCount, 1);
  assert.deepEqual(summary.slotWindows.partialWindowCounts, [1]);
  assert.equal(summary.wholeRunSlotReads, 6);
  assert.equal(summary.coverage.writeFailures, 0);

  let lateClock = Date.parse('2026-09-23T22:00:00.000Z');
  let lateTimer;
  const lateRows = [];
  const lateListeners = new Map();
  const lateMonitor = createMainLagMonitor({
    file: '/inert/t837-main-lag-mid-window.ndjson',
    observeIpcWindows: true,
    intervalMs: 250,
    thresholdMs: 1,
    now: () => lateClock,
    monotonic: () => lateClock,
    cpuUsage: () => ({ user: 0, system: 0 }),
    threadCpuUsage: null,
    setTimer: callback => { lateTimer = callback; return { unref() {} }; },
    clearTimer() {},
    appendSink: line => {
      lateRows.push(JSON.parse(line));
      return { written: true };
    },
  });
  const lateIpc = {
    on(channel, listener) {
      lateListeners.set(channel, listener);
      return this;
    },
  };
  assert.equal(lateMonitor.instrument(lateIpc), true);
  lateIpc.on('mc-settings:tree-slots', event => { event.returnValue = { ok: true }; });
  assert.equal(lateMonitor.start(), true);
  const lateReadSlots = () => {
    const event = {};
    lateListeners.get('mc-settings:tree-slots')(event);
    assert.deepEqual(event.returnValue, { ok: true });
  };
  lateClock += 500; lateReadSlots(); // global count before the Computers anchor
  lateClock += 500;
  assert.equal(lateMonitor.pageLifecycle({ route: 'computers', phase: 'mount', mountId: 1 }, { senderId: 12 }), true);
  lateClock += 1000; lateTimer(); lateReadSlots(); // lag after mount, before the first boundary
  lateClock += 3000; lateReadSlots(); // close [0, 5000], then count [5000, 6000)
  lateClock += 1000; lateTimer(); lateReadSlots();
  lateMonitor.stop();
  const lateSummary = summarizeObservationLog(lateRows);
  assert.equal(lateSummary.coverage.status, 'OBSERVED');
  assert.equal(lateSummary.coverage.complete, true);
  assert.deepEqual(lateSummary.coverage.interval, {
    start: '2026-09-23T22:00:01.000Z', end: '2026-09-23T22:00:06.000Z',
  });
  assert.equal(lateSummary.slotWindows.observedSlotReads, 4);
  assert.equal(lateSummary.slotWindows.maxSlotReadsPerContinuous5sWindow, 2);
  assert.equal(lateSummary.slotWindows.partialCount, 1);
  assert.equal(lateSummary.stallsAtLeast1000Ms.length, 2);
  assert.equal(typeof lateTimer, 'function');
});
