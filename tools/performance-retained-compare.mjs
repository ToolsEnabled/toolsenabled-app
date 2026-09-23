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
    if (key === 'lag') values[key] = read.text.split(/\r?\n/).filter(s => s.trim()).map(s => parseJson(s));
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
  requireThat(args.length === 2 || args.length === 4, 'usage: --before manifest.json [--after manifest.json]');
  requireThat(args[0] === '--before' && (args.length === 2 || args[2] === '--after'), 'usage: --before manifest.json [--after manifest.json]');
  return compareCaptures(loadCapture(args[1]), args.length === 4 ? loadCapture(args[3]) : null);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n'); }
  catch (error) { const reason = error.code === 'MEASUREMENT_INPUT_INVALID' ? error.message : /^[A-Z_]+$/.test(error.code || '') ? error.code : 'INPUT_READ_OR_PARSE_FAILED'; process.stderr.write('REFUSED: ' + reason + '\n'); process.exitCode = 2; }
}
