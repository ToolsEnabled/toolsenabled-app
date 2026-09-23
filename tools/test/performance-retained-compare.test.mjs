import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const api = await import(process.env.PERFORMANCE_COMPARE_MODULE
  ? pathToFileURL(process.env.PERFORMANCE_COMPARE_MODULE).href
  : new URL('../performance-retained-compare.mjs', import.meta.url).href);
const { summarizeLag, summarizeHandlers, comparePostflights, compareCaptures, postflightSummary } = api;
const identity = { generation: 'gen-test', appRef: 'a'.repeat(40), engineRef: 'b'.repeat(40) };
const node = (status, session = 'session-a', lastTurn = 'turn-a') => ({ status, session, lastTurn });
const snapshot = (perNode, at = '2026-09-22T01:00:00Z', current = identity) => ({
  schema: 2, collectedAt: at, runtime: { current }, fleet: { file: { present: true }, nodes: Object.keys(perNode).length, perNode },
});
const lag = (overrides = {}) => ({ at: '2026-09-22T01:01:00Z', pid: 123, lagMs: 9670, threadCpuMs: 9513,
  blockers: { 'tree-courier:read-dispatch': { count: 1, totalMs: 27 },
    'await:mc-agent:goal': { count: 1, totalMs: 9600 } }, ...overrides });

test('awaited time and high thread CPU do not explain the recorded synchronous gap', () => {
  const row = summarizeLag([lag()]).stallsAtLeast1000Ms[0];
  assert.equal(row.recordedSyncTotalMs, 27);
  assert.equal(row.recordedAwaitedTotalMs, 9600);
  assert.equal(row.unexplainedByRecordedTotalsMs, 9643);
  assert.equal(row.attribution, 'UNKNOWN');
});
test('retained slot reads stay a threshold-row count even when the artifact has a ready marker', () => {
  const out = summarizeLag([{ event: 'diagnostic-sink-ready', producer: 'main-lag' },
    lag({ lagMs: 625, blockers: { 'mc-settings:tree-slots': { count: 357, totalMs: 26 } } }),
    lag({ lagMs: 591, blockers: { 'mc-settings:tree-slots': { count: 232, totalMs: 19 } } })]);
  assert.equal(out.observedSlotReads, 589);
  assert.equal(out.wholeRunSlotReads, 'UNKNOWN');
  assert.equal(out.stallsAtLeast1000Ms.length, 0);
  assert.equal(out.samples.length, 2);
});
test('an empty retained sink never proves zero whole-run reads', () => {
  const out = summarizeLag([]);
  assert.equal(out.observedSlotReads, 0);
  assert.equal(out.wholeRunSlotReads, 'UNKNOWN');
});
test('bad counts and malformed lag observations refuse instead of silently disappearing', () => {
  assert.throws(() => summarizeLag([lag({ lagMs: '1000' })]));
  assert.throws(() => summarizeLag([lag({ blockers: { bad: { count: -1, totalMs: 0 } } })]));
  assert.throws(() => summarizeLag([{}]));
});
test('per-handler counts consume existing summaries without counting repeated error-code lines', () => {
  const out = summarizeHandlers({ totalLines: 3059, handlerErrorBlocks: 305, unknownSessionCodes: 610,
    handlerCounts: { 'mc-agent:send': 1, 'mc-agent:models': 303, 'mc-agent:goal': 1 } });
  assert.equal(out.handlerErrorBlocks, 305);
  assert.deepEqual(out.counts, { 'mc-agent:goal': 1, 'mc-agent:models': 303, 'mc-agent:send': 1 });
});
test('inconsistent summaries refuse and missing summaries stay unknown', () => {
  assert.throws(() => summarizeHandlers({ totalLines: 1, handlerCounts: { 'mc-agent:send': 2 }, handlerErrorBlocks: 1 }));
  assert.equal(summarizeHandlers(null).status, 'UNKNOWN');
});
test('finished-to-failed endpoint changes retain session and last-turn comparison', () => {
  const a = snapshot({ a: node('finished'), b: node('finished'), c: node('running') });
  const b = snapshot({ a: node('turn-failed'), b: node('failed', 'new-session', 'new-turn'), c: node('turn-failed') }, '2026-09-22T01:10:00Z');
  const out = comparePostflights(a, b);
  assert.deepEqual(out.endpointTransitions, [
    { node: 'a', from: 'finished', to: 'turn-failed', sameSession: true, sameLastTurn: true },
    { node: 'b', from: 'finished', to: 'failed', sameSession: false, sameLastTurn: false }]);
  assert.equal(out.intervalTransitions, 'UNKNOWN');
});
test('unchanged endpoints cannot rule out a transient status flip', () => {
  const out = comparePostflights(snapshot({ a: node('finished') }), snapshot({ a: node('finished') }, '2026-09-22T01:10:00Z'));
  assert.deepEqual(out.endpointTransitions, []);
  assert.equal(out.intervalTransitions, 'UNKNOWN');
});
test('missing and added nodes are explicit and missing session identity is unknown', () => {
  const out = comparePostflights(snapshot({ a: node('finished', null, null), removed: node('finished') }),
    snapshot({ a: node('turn-failed'), added: node('finished') }, '2026-09-22T01:10:00Z'));
  assert.deepEqual(out.missingNodes, ['removed']);
  assert.deepEqual(out.addedNodes, ['added']);
  assert.equal(out.endpointTransitions[0].sameSession, 'UNKNOWN');
  assert.equal(out.endpointTransitions[0].sameLastTurn, 'UNKNOWN');
});
test('postflight comparison binds both declared generation and source pairs', () => {
  const next = { ...identity, generation: 'gen-next', appRef: 'c'.repeat(40) };
  const out = comparePostflights(snapshot({}), snapshot({}, '2026-09-22T01:10:00Z', next));
  assert.deepEqual(out.identity, { before: identity, after: next, sameGeneration: false, sameSourcePair: false });
});
test('missing identity is unknown and inconsistent snapshots or reversed time refuse', () => {
  assert.equal(postflightSummary(snapshot({}, undefined, {})).identity, 'UNKNOWN');
  assert.throws(() => postflightSummary({ ...snapshot({}), fleet: { nodes: 2, perNode: {} } }));
  assert.throws(() => comparePostflights(snapshot({}), snapshot({})));
  assert.equal(comparePostflights(snapshot({}), null).endpointTransitions, 'UNKNOWN');
});
test('before-only analysis stays deterministic and cannot become runtime acceptance', () => {
  const before = { identity, postflight: snapshot({}), lag: summarizeLag([]), handlers: summarizeHandlers(null) };
  const result = compareCaptures(before);
  assert.equal(result.acceptance, 'NOT-ENOUGH-DATA');
  assert.equal(result.after, null);
  assert.equal(result.limits.runtimeCustody, 'UNKNOWN');
  assert.deepEqual(result, compareCaptures(before));
});

test('missing source fleet refuses instead of becoming an empty successful comparison', () => {
  const missing = snapshot({}); missing.fleet.file.present = false;
  assert.throws(() => postflightSummary(missing));
});
test('comparison computes observed deltas without promoting them to whole-run improvements', () => {
  const before = { handlers: summarizeHandlers({ totalLines: 4, handlerCounts: { 'mc-agent:models': 3 } }), lag: summarizeLag([lag({ blockers: { 'mc-settings:tree-slots': { count: 357, totalMs: 26 } } })]) };
  const after = { handlers: summarizeHandlers({ totalLines: 2, handlerCounts: { 'mc-agent:send': 1 } }), lag: summarizeLag([lag({ blockers: { 'mc-settings:tree-slots': { count: 6, totalMs: 0 } } })]) };
  const result = api.compareMeasurements(before, after);
  assert.deepEqual(result.observedHandlerCountDelta, { 'mc-agent:models': -3, 'mc-agent:send': 1 });
  assert.equal(result.observedSlotReadDelta, -351);
  assert.equal(result.wholeRunSlotReadDelta, 'UNKNOWN');
});

test('array-valued app source references cannot establish a known source identity', () => {
  const malformed = { ...identity, appRef: [identity.appRef] };
  const before = snapshot({}, undefined, malformed);
  const after = snapshot({}, '2026-09-22T01:10:00Z', { ...identity, appRef: [identity.appRef] });
  assert.equal(postflightSummary(before).identity, 'UNKNOWN');
  assert.equal(comparePostflights(before, after).identity.sameSourcePair, 'UNKNOWN');
});
test('array-valued engine source references cannot establish a known source identity', () => {
  const malformed = { ...identity, engineRef: [identity.engineRef] };
  const before = snapshot({}, undefined, malformed);
  const after = snapshot({}, '2026-09-22T01:10:00Z', { ...identity, engineRef: [identity.engineRef] });
  assert.equal(postflightSummary(before).identity, 'UNKNOWN');
  assert.equal(comparePostflights(before, after).identity.sameSourcePair, 'UNKNOWN');
});
test('blank session and last-turn identifiers never establish endpoint identity', () => {
  for (const [left, right] of [['', ''], [' \t', ' \t'], ['', 'known'], ['known', ''], [null, 'known'], ['known', null]]) {
    const out = comparePostflights(snapshot({ a: node('finished', left, left) }),
      snapshot({ a: node('turn-failed', right, right) }, '2026-09-22T01:10:00Z'));
    assert.equal(out.endpointTransitions.length, 1);
    assert.equal(out.endpointTransitions[0].sameSession, 'UNKNOWN');
    assert.equal(out.endpointTransitions[0].sameLastTurn, 'UNKNOWN');
    assert.equal(out.intervalTransitions, 'UNKNOWN');
  }
});
