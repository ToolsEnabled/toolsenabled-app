#!/usr/bin/env node
// Offline measurements only. This tool neither launches nor qualifies a runtime.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const UNKNOWN = 'UNKNOWN';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = v => Number.isFinite(v) && v >= 0;
const hasIdentifier = value => typeof value === 'string' && value.trim().length > 0;
const ordered = obj => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b, 'en')));
const digest = value => createHash('sha256').update(value).digest('hex');
function requireThat(ok, reason) { if (!ok) { const error = new Error(reason); error.code = 'MEASUREMENT_INPUT_INVALID'; throw error; } }
function parseJson(text) { try { return JSON.parse(text); } catch { requireThat(false, 'input is not valid JSON'); } }

export function summarizeLag(rows) {
  requireThat(Array.isArray(rows), 'lag rows must be an array');
  const stalls = [], samples = [];
  let readyMarkers = 0, slotReads = 0;
  for (const row of rows) {
    requireThat(object(row), 'invalid diagnostic row');
    if (isNonLagDiagnosticRow(row)) continue;
    if (row.event === 'diagnostic-sink-ready' && row.producer === 'main-lag') { readyMarkers++; continue; }
    requireThat(number(row.lagMs) && Number.isFinite(Date.parse(row.at)) && Number.isSafeInteger(row.pid) && row.pid > 0 && object(row.blockers), 'invalid main-lag observation');
    let syncTotal = 0, awaitedTotal = 0;
    for (const [label, span] of Object.entries(row.blockers)) {
      requireThat(object(span) && number(span.totalMs) && Number.isSafeInteger(span.count) && span.count >= 0, 'invalid blocker measurement');
      if (label.startsWith('await:')) awaitedTotal += span.totalMs;
      else syncTotal += span.totalMs;
    }
    const count = row.blockers['mc-settings:tree-slots']?.count ?? 0;
    slotReads += count;
    samples.push({ at: row.at, pid: row.pid, lagMs: row.lagMs, observedSlotReads: count });
    if (row.lagMs >= 1000) stalls.push({
      at: row.at, pid: row.pid, lagMs: row.lagMs,
      threadCpuMs: number(row.threadCpuMs) ? row.threadCpuMs : UNKNOWN,
      recordedSyncTotalMs: syncTotal, recordedAwaitedTotalMs: awaitedTotal,
      unexplainedByRecordedTotalsMs: Math.max(0, row.lagMs - syncTotal),
      attribution: UNKNOWN,
    });
  }
  return { rows: samples.length, readyMarkers, observedSlotReads: slotReads,
    wholeRunSlotReads: UNKNOWN, countsScope: 'threshold-emitted retained rows only',
    reason: 'Quiet ticks reset counters without emitting a row; rounded and possibly nested spans are not a CPU partition.',
    stallsAtLeast1000Ms: stalls, samples };
}

const OBSERVATION_VERSION = 1;
const IPC_WINDOW_MS = 5000;
const isIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const nonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const rowIdentity = row => hasIdentifier(row.monitorId) && positiveInteger(row.pid)
  ? `${row.monitorId}\u0000${row.pid}` : null;
const routeName = value => typeof value === 'string' ? value.replace(/^\/+/, '') : null;
const OBSERVED_ROUTES = new Set(['home', 'computers', 'agent', 'metrics', 'research', 'comms', 'ledger', 'vault',
  'checkout', 'settings', 'tools', 'setup', 'account', 'subscribe']);

function observationCommon(row) {
  return row.diagnosticsVersion === OBSERVATION_VERSION
    && hasIdentifier(row.monitorId)
    && positiveInteger(row.sequence)
    && isIso(row.at)
    && positiveInteger(row.pid)
    && nonNegativeInteger(row.writeFailures);
}

function observationLag(row) {
  return Object.hasOwn(row, 'lagMs') || Object.hasOwn(row, 'blockers');
}

function validPageLifecycle(row) {
  return OBSERVED_ROUTES.has(routeName(row.route)) && ['mount', 'unmount'].includes(row.phase)
    && positiveInteger(row.mountId) && positiveInteger(row.senderId);
}

function validObservationWindow(row) {
  const startMs = isIso(row.windowStart) ? Date.parse(row.windowStart) : NaN;
  const endMs = isIso(row.windowEnd) ? Date.parse(row.windowEnd) : NaN;
  const duration = endMs - startMs;
  return row.channel === 'mc-settings:tree-slots' && row.windowMs === IPC_WINDOW_MS
    && nonNegativeInteger(row.windowIndex) && nonNegativeInteger(row.count)
    && nonNegativeInteger(row.cumulativeCount) && row.cumulativeCount >= row.count
    && typeof row.partial === 'boolean'
    && Number.isFinite(startMs) && Number.isFinite(endMs) && duration >= 0 && duration <= IPC_WINDOW_MS
    && (row.partial
      ? duration < IPC_WINDOW_MS && (duration > 0 || row.count > 0)
      : duration === IPC_WINDOW_MS);
}

export function isNonLagDiagnosticRow(row) {
  if (!object(row) || !observationCommon(row) || observationLag(row)) return false;
  if (row.event === 'diagnostic-observation-start') {
    return row.windowMs === IPC_WINDOW_MS && isIso(row.windowStart);
  }
  if (row.event === 'diagnostic-observation-stop') return true;
  if (row.event === 'diagnostic-observation-gap') return ['clock-gap', 'clock-regressed'].includes(row.reason);
  if (row.event === 'ipc-count-window') return validObservationWindow(row);
  if (row.event === 'page-lifecycle') return validPageLifecycle(row);
  return false;
}

function addObservationReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function summarizeObservationLog(rows) {
  requireThat(Array.isArray(rows), 'observation rows must be an array');
  const reasons = [], limits = [], lagCandidates = [], windows = [], lifecycles = [], starts = [], stops = [], identities = [];
  let readyMarkers = 0;

  for (const [index, row] of rows.entries()) {
    requireThat(object(row), 'invalid diagnostic row');
    if (row.event === 'diagnostic-sink-ready' && row.producer === 'main-lag') {
      readyMarkers++;
      continue;
    }
    const identity = rowIdentity(row);
    identities.push({ row, identity });
    const common = observationCommon(row);
    if (!common) addObservationReason(reasons, `row ${index} is missing valid observation metadata`);
    if (observationLag(row)) {
      const valid = number(row.lagMs) && object(row.blockers);
      if (!valid) addObservationReason(reasons, `row ${index} is not a valid lag observation`);
      lagCandidates.push({ row, identity, valid });
    }
    if (observationLag(row) && row.event !== undefined) {
      addObservationReason(reasons, `row ${index} combines a lag observation with event ${String(row.event)}`);
    }
    if (row.event === 'diagnostic-observation-gap') {
      addObservationReason(reasons, 'diagnostic-observation-gap was emitted');
      if (!['clock-gap', 'clock-regressed'].includes(row.reason)) {
        addObservationReason(reasons, 'invalid diagnostic-observation-gap reason');
      }
    } else if (row.event === 'diagnostic-observation-start') {
      starts.push({ row, identity, common });
      if (row.windowMs !== IPC_WINDOW_MS || !isIso(row.windowStart)) addObservationReason(reasons, 'invalid observation start window');
    } else if (row.event === 'diagnostic-observation-stop') {
      stops.push({ row, identity, common });
    } else if (row.event === 'ipc-count-window') {
      windows.push({ row, identity, common });
    } else if (row.event === 'page-lifecycle') {
      lifecycles.push({ row, identity, common });
      if (!validPageLifecycle(row)) {
        addObservationReason(reasons, 'invalid page-lifecycle marker');
      }
    } else if (!observationLag(row)) {
      addObservationReason(reasons, `unrecognized observation event at row ${index}`);
    }
  }

  const computersMounts = lifecycles.filter(item => routeName(item.row.route) === 'computers'
    && item.row.phase === 'mount' && item.common && item.identity);
  const computersMountIdentities = new Set(computersMounts.map(item => item.identity));
  const firstComputersMount = computersMounts[0];
  if (computersMountIdentities.size > 1) addObservationReason(reasons, 'multiple computers mount identities require an explicit selection');
  if (!firstComputersMount || !firstComputersMount.common || !firstComputersMount.identity) {
    addObservationReason(reasons, 'first computers mount anchor is missing');
  }
  const anchor = firstComputersMount?.identity || undefined;
  const primary = item => anchor !== undefined && item.identity === anchor;
  const primaryRows = identities.filter(primary);
  const primaryStarts = starts.filter(primary);
  const primaryStops = stops.filter(primary);
  const primaryWindows = windows.filter(primary);
  const primaryLifecycle = lifecycles.filter(primary);
  const anchorSequence = firstComputersMount?.row.sequence ?? Infinity;
  const anchoredLagRows = lagCandidates.filter(item => primary(item) && item.valid && item.row.sequence >= anchorSequence);
  const foreignSessionRows = anchor === undefined ? 0 : identities.filter(item => item.identity && item.identity !== anchor).length;

  const sequenceByPrimary = new Map();
  for (const item of identities.filter(primary)) {
    const row = item.row;
    const previous = sequenceByPrimary.get(anchor);
    if (previous) {
      if (row.sequence !== previous.sequence + 1) addObservationReason(reasons, `sequence discontinuity for ${row.monitorId}/${row.pid}`);
      const elapsed = Date.parse(row.at) - Date.parse(previous.at);
      if (elapsed < 0 || elapsed > IPC_WINDOW_MS) addObservationReason(reasons, `clock gap or regression for ${row.monitorId}/${row.pid}`);
      if (row.writeFailures < previous.writeFailures) addObservationReason(reasons, `writeFailures regressed for ${row.monitorId}/${row.pid}`);
    } else if (row.sequence !== 1) {
      addObservationReason(reasons, `sequence did not start at one for ${row.monitorId}/${row.pid}`);
    }
    sequenceByPrimary.set(anchor, row);
    if (row.writeFailures > 0) addObservationReason(reasons, `writeFailures is nonzero for ${row.monitorId}/${row.pid}`);
  }

  if (primaryStarts.length !== 1) addObservationReason(reasons, primaryStarts.length === 0 ? 'observation start is missing' : 'multiple observation starts');
  if (primaryStops.length > 1) addObservationReason(reasons, 'multiple observation stops');
  if (primaryStops.length === 0) limits.push('observation stop is missing; trailing open window is UNKNOWN');
  const start = primaryStarts[0]?.row;
  const stop = primaryStops[0]?.row;
  if (start && firstComputersMount && isIso(start.windowStart) && primaryWindows[0]?.row.windowStart
    && Date.parse(start.windowStart) !== Date.parse(primaryWindows[0].row.windowStart)) {
    addObservationReason(reasons, 'first IPC window does not start at observation start');
  }
  if (stop && primaryRows.length && primaryRows.at(-1).row.sequence !== stop.sequence) {
    addObservationReason(reasons, 'observation rows follow stop');
  }

  let previousWindow = null;
  let observedSlotReads = 0;
  let maxSlotReadsPerWindow = 0;
  let completeWindowCount = 0;
  let partialWindowCount = 0;
  let previousCumulative = null;
  const validWindowItems = [];
  for (const { row } of primaryWindows) {
    const startMs = isIso(row.windowStart) ? Date.parse(row.windowStart) : NaN;
    const endMs = isIso(row.windowEnd) ? Date.parse(row.windowEnd) : NaN;
    const valid = validObservationWindow(row);
    if (!valid) {
      addObservationReason(reasons, 'invalid IPC count window');
      continue;
    }
    if (!previousWindow) {
      if (row.windowIndex !== 0) addObservationReason(reasons, 'IPC window index did not start at zero');
    } else {
      if (row.windowIndex !== previousWindow.windowIndex + 1) addObservationReason(reasons, 'IPC window index discontinuity');
      if (startMs !== previousWindow.endMs) addObservationReason(reasons, 'IPC window time discontinuity');
      if (row.cumulativeCount < previousCumulative) addObservationReason(reasons, 'IPC cumulative count regressed');
    }
    const expectedCumulative = previousWindow ? previousCumulative + row.count : row.count;
    if (row.cumulativeCount !== expectedCumulative) addObservationReason(reasons, 'IPC cumulative count is not exact');
    observedSlotReads += row.count;
    if (!row.partial) maxSlotReadsPerWindow = Math.max(maxSlotReadsPerWindow, row.count);
    if (row.partial) partialWindowCount++;
    else completeWindowCount++;
    previousWindow = { windowIndex: row.windowIndex, endMs };
    previousCumulative = row.cumulativeCount;
    validWindowItems.push({ row, startMs, endMs });
  }
  if (partialWindowCount > 1 || (partialWindowCount === 1 && !primaryWindows.at(-1)?.row.partial)) {
    addObservationReason(reasons, 'partial IPC window is not the final window');
  }
  const anchorAt = firstComputersMount?.row && isIso(firstComputersMount.row.at)
    ? Date.parse(firstComputersMount.row.at) : NaN;
  const closedWindows = validWindowItems.filter(item => !item.row.partial);
  if (primaryWindows.length === 0) addObservationReason(reasons, 'IPC count windows are missing');
  if (primaryStops.length === 1 && primaryWindows.length > 0) {
    const finalWindow = primaryWindows.at(-1).row;
    if (Date.parse(stop.at) !== Date.parse(finalWindow.windowEnd)) {
      addObservationReason(reasons, 'observation stop does not match final IPC window end');
    }
  } else if (primaryStops.length === 0 && primaryWindows.length > 0) {
    if (primaryWindows.at(-1).row.partial) addObservationReason(reasons, 'partial IPC window requires an observation stop');
    else limits.push('trailing open window is UNKNOWN after the last contiguous closed 5s window');
  }

  const stopIsFinalPrimaryRow = primaryStops.length === 1 && primaryRows.at(-1)?.row.sequence === stop.sequence;
  const validatedStopAt = stopIsFinalPrimaryRow && primaryWindows.length > 0
    && Date.parse(stop.at) === Date.parse(primaryWindows.at(-1).row.windowEnd)
    ? Date.parse(stop.at) : NaN;
  const lastClosedEnd = closedWindows.at(-1)?.endMs;
  const intervalStart = anchorAt;
  const intervalEnd = Number.isFinite(validatedStopAt) ? validatedStopAt : lastClosedEnd;
  const intervalKnown = Number.isFinite(intervalStart) && Number.isFinite(intervalEnd) && intervalEnd > intervalStart;
  if (!intervalKnown) {
    addObservationReason(reasons, 'Computers anchor has no later proven observation interval');
  }
  if (primaryStops.length === 0 && !closedWindows.some(item => Number.isFinite(anchorAt) && item.endMs > anchorAt)) {
    addObservationReason(reasons, 'no closed IPC window follows the Computers anchor');
  }
  const primaryLagRows = [];
  let lagOutsideInterval = 0;
  for (const { row } of anchoredLagRows) {
    const atMs = isIso(row.at) ? Date.parse(row.at) : NaN;
    if (intervalKnown && atMs >= intervalStart && atMs <= intervalEnd) primaryLagRows.push(row);
    else lagOutsideInterval++;
  }
  if (lagOutsideInterval > 0) {
    limits.push(`${lagOutsideInterval} lag observation(s) fall outside the proven Computers observation interval`);
  }
  // Global IPC accounting is deliberately independent of the Computers route:
  // the main listener observes all routes, while the lag interval is anchored
  // to the first Computers mount above.
  observedSlotReads = validWindowItems.reduce((total, item) => total + item.row.count, 0);
  partialWindowCount = validWindowItems.filter(item => item.row.partial).length;
  completeWindowCount = closedWindows.length;
  maxSlotReadsPerWindow = closedWindows.reduce((max, item) => Math.max(max, item.row.count), 0);
  if (primaryStops.length === 0 && partialWindowCount > 0) {
    limits.push('partial tail is outside the proven closed IPC interval');
  }
  const lag = summarizeLag(primaryLagRows);
  const coverageKnown = reasons.length === 0;
  const wholeRunKnown = coverageKnown && Number.isFinite(validatedStopAt) && intervalKnown;
  return {
    ...lag,
    readyMarkers,
    wholeRunSlotReads: wholeRunKnown ? observedSlotReads : UNKNOWN,
    slotWindows: {
      windowMs: IPC_WINDOW_MS,
      scope: 'all routes observed by the main-process mc-settings:tree-slots listener',
      count: validWindowItems.length,
      completeCount: completeWindowCount,
      partialCount: partialWindowCount,
      observedSlotReads,
      wholeRunSlotReads: wholeRunKnown ? observedSlotReads : UNKNOWN,
      maxSlotReadsPerContinuous5sWindow: maxSlotReadsPerWindow,
      partialWindowCounts: validWindowItems.filter(item => item.row.partial).map(item => item.row.count),
    },
    lifecycle: {
      rows: primaryLifecycle.length,
      firstComputersMount: Boolean(firstComputersMount && primary(firstComputersMount)),
      foreignSessionRows,
    },
    coverage: {
      status: coverageKnown ? 'OBSERVED' : UNKNOWN,
      scope: wholeRunKnown ? 'complete observation interval' : 'closed IPC windows only; whole-run acceptance is UNKNOWN',
      interval: {
        start: Number.isFinite(intervalStart) ? new Date(intervalStart).toISOString() : UNKNOWN,
        end: Number.isFinite(intervalEnd) ? new Date(intervalEnd).toISOString() : UNKNOWN,
      },
      monitorId: firstComputersMount?.row.monitorId ?? UNKNOWN,
      pid: firstComputersMount?.row.pid ?? UNKNOWN,
      startSeen: primaryStarts.length === 1,
      stopSeen: primaryStops.length === 1,
      complete: wholeRunKnown,
      sequenceRows: primaryRows.length,
      writeFailures: primaryRows.length ? Math.max(...primaryRows.map(item => item.row.writeFailures)) : UNKNOWN,
      reasons,
      limits,
    },
  };
}

export function summarizeHandlers(value) {
  if (value == null) return { status: UNKNOWN, reason: 'No retained handler-count artifact supplied.' };
  requireThat(object(value) && object(value.handlerCounts), 'handler-count artifact requires handlerCounts');
  requireThat(Number.isSafeInteger(value.totalLines) && value.totalLines >= 0, 'handler-count artifact requires totalLines');
  for (const [handler, count] of Object.entries(value.handlerCounts)) {
    requireThat(/^mc-[a-z0-9:_-]+$/i.test(handler) && Number.isSafeInteger(count) && count >= 0, 'invalid per-handler count');
  }
  const total = Object.values(value.handlerCounts).reduce((a, b) => a + b, 0);
  requireThat(value.handlerErrorBlocks == null || value.handlerErrorBlocks === total, 'handlerErrorBlocks disagrees with handlerCounts');
  return { status: 'OBSERVED', counts: ordered(value.handlerCounts), handlerErrorBlocks: total,
    totalLines: value.totalLines, countsScope: 'supplied retained count artifact; timestamp coverage and raw-log binding unverified' };
}

export function postflightSummary(value) {
  if (value == null) return { identity: UNKNOWN, nodes: null, reason: 'No postflight snapshot supplied.' };
  requireThat(value.schema === 2 && value.fleet?.file?.present === true && object(value.fleet?.perNode), 'expected postflight schema 2 with fleet.perNode');
  requireThat(Number.isFinite(Date.parse(value.collectedAt)), 'invalid postflight collectedAt');
  const nodes = value.fleet.perNode;
  requireThat(Number.isSafeInteger(value.fleet.nodes) && value.fleet.nodes === Object.keys(nodes).length, 'postflight node total disagrees with perNode');
  for (const node of Object.values(nodes)) {
    requireThat(object(node) && typeof node.status === 'string', 'invalid postflight node');
  }
  const current = value.runtime?.current;
  const valid = object(current) && typeof current.generation === 'string' && /^gen-[a-z0-9-]+$/i.test(current.generation)
    && typeof current.appRef === 'string' && typeof current.engineRef === 'string'
    && /^[a-f0-9]{40,64}$/i.test(current.appRef) && /^[a-f0-9]{40,64}$/i.test(current.engineRef);
  return { identity: valid ? { generation: current.generation, appRef: current.appRef, engineRef: current.engineRef } : UNKNOWN,
    collectedAt: value.collectedAt, nodes, nodeCount: Object.keys(nodes).length,
    identityScope: 'snapshot declaration; not qualification or diagnostic-process custody' };
}

export function comparePostflights(before, after) {
  const a = postflightSummary(before), b = postflightSummary(after);
  const identity = { before: a.identity, after: b.identity,
    sameGeneration: a.identity !== UNKNOWN && b.identity !== UNKNOWN ? a.identity.generation === b.identity.generation : UNKNOWN,
    sameSourcePair: a.identity !== UNKNOWN && b.identity !== UNKNOWN ? a.identity.appRef === b.identity.appRef && a.identity.engineRef === b.identity.engineRef : UNKNOWN };
  if (!a.nodes || !b.nodes) return { identity, endpointTransitions: UNKNOWN, reason: 'Both per-node snapshots are required.' };
  requireThat(Date.parse(b.collectedAt) > Date.parse(a.collectedAt), 'after snapshot must be later than before');
  const changed = [], missing = [], added = [];
  for (const key of Object.keys(a.nodes).sort()) {
    const prev = a.nodes[key], next = b.nodes[key];
    if (!next) { missing.push(key); continue; }
    if (prev.status === 'finished' && ['turn-failed', 'failed'].includes(next.status)) {
      changed.push({ node: key, from: prev.status, to: next.status,
        sameSession: hasIdentifier(prev.session) && hasIdentifier(next.session) ? prev.session === next.session : UNKNOWN,
        sameLastTurn: hasIdentifier(prev.lastTurn) && hasIdentifier(next.lastTurn) ? prev.lastTurn === next.lastTurn : UNKNOWN });
    }
  }
  for (const key of Object.keys(b.nodes).sort()) if (!Object.hasOwn(a.nodes, key)) added.push(key);
  return { identity, endpointTransitions: changed, missingNodes: missing, addedNodes: added,
    intervalTransitions: UNKNOWN, reason: 'Endpoint snapshots cannot exclude transient finished-to-failed-to-finished changes.' };
}

function readBounded(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    requireThat(before.isFile() && before.size <= MAX_INPUT_BYTES, 'input exceeds 64 MiB bound or is not a regular file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0, got;
    while (length < bytes.length && (got = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += got;
    const after = fs.fstatSync(fd);
    requireThat(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs, 'input changed while reading; use a retained copy');
    return { text: bytes.subarray(0, length).toString('utf8'), bytes: length, sha256: digest(bytes.subarray(0, length)) };
  } finally { fs.closeSync(fd); }
}

function parseNdjson(text) {
  return text.split(/\r?\n/).filter(line => line.trim()).map(parseJson);
}

export function loadObservationLog(logPath) {
  requireThat(typeof logPath === 'string' && logPath.length > 0, 'observation log path must be a nonempty string');
  const file = path.resolve(logPath);
  const read = readBounded(file);
  return {
    source: { path: file, bytes: read.bytes, sha256: read.sha256 },
    summary: summarizeObservationLog(parseNdjson(read.text)),
  };
}

export function loadCapture(manifestPath) {
  const manifest = readBounded(manifestPath), spec = parseJson(manifest.text);
  requireThat(spec.schema === 1 && object(spec.inputs), 'capture manifest requires schema 1 and inputs');
  const sources = {}, values = {};
  for (const key of ['postflight', 'lag', 'handlerCounts']) {
    const input = spec.inputs[key];
    if (input == null) { values[key] = null; sources[key] = { status: UNKNOWN, reason: 'input not supplied' }; continue; }
    requireThat(typeof input === 'string' && input.length > 0, 'input path must be a nonempty string');
    const file = path.resolve(path.dirname(manifestPath), input);
    const read = readBounded(file);
    sources[key] = { path: file, bytes: read.bytes, sha256: read.sha256 };
    if (key === 'lag') values[key] = parseNdjson(read.text);
    else values[key] = parseJson(read.text);
  }
  const postflight = postflightSummary(values.postflight);
  return { manifest: { path: path.resolve(manifestPath), bytes: manifest.bytes, sha256: manifest.sha256 }, sources,
    postflight: values.postflight, identity: postflight.identity,
    lag: values.lag === null ? { status: UNKNOWN, reason: 'No lag sink supplied.' } : summarizeLag(values.lag),
    handlers: summarizeHandlers(values.handlerCounts) };
}

export function compareMeasurements(before, after) {
  const a = before.handlers, b = after?.handlers;
  const handlerDelta = a?.status === 'OBSERVED' && b?.status === 'OBSERVED'
    ? Object.fromEntries([...new Set([...Object.keys(a.counts), ...Object.keys(b.counts)])].sort().map(key => [key, (b.counts[key] ?? 0) - (a.counts[key] ?? 0)])) : UNKNOWN;
  return { observedHandlerCountDelta: handlerDelta,
    observedSlotReadDelta: number(before.lag?.observedSlotReads) && number(after?.lag?.observedSlotReads)
      ? after.lag.observedSlotReads - before.lag.observedSlotReads : UNKNOWN,
    wholeRunSlotReadDelta: UNKNOWN,
    scope: 'Arithmetic between supplied retained artifacts only; differing coverage prevents an improvement claim.' };
}

export function compareCaptures(before, after = null) {
  const view = c => c && ({ manifest: c.manifest, sources: c.sources, identity: c.identity, lag: c.lag, handlers: c.handlers });
  return { schema: 1, acceptance: 'NOT-ENOUGH-DATA', limits: { maxInputBytes: MAX_INPUT_BYTES, sampling: 'none; every row of each supplied file',
    runtimeCustody: UNKNOWN, agentsOpenInterval: UNKNOWN },
    before: view(before), after: view(after),
    measurements: compareMeasurements(before, after),
    postflight: comparePostflights(before.postflight, after?.postflight),
    reason: 'Retained observations are not real-user acceptance. No after input means after counts remain UNKNOWN.' };
}

export function main(args) {
  if (args[0] === '--log') {
    requireThat(args.length === 2, 'usage: --log observation.ndjson');
    const loaded = loadObservationLog(args[1]);
    return { schema: 1, source: loaded.source, ...loaded.summary };
  }
  requireThat(args.length === 2 || args.length === 4, 'usage: --before manifest.json [--after manifest.json]');
  requireThat(args[0] === '--before' && (args.length === 2 || args[2] === '--after'), 'usage: --before manifest.json [--after manifest.json]');
  return compareCaptures(loadCapture(args[1]), args.length === 4 ? loadCapture(args[3]) : null);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { const reason = error.code === 'MEASUREMENT_INPUT_INVALID' ? error.message : /^[A-Z_]+$/.test(error.code || '') ? error.code : 'INPUT_READ_OR_PARSE_FAILED'; process.stderr.write('REFUSED: ' + reason + '\n'); process.exitCode = 2; }
}
