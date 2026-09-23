import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { createMainLagMonitor } = createRequire(import.meta.url)('../../shell/main-lag.cjs');
function harness({ thread = true } = {}) {
  let wall = 10000, mono = 0, cpu = 0, tick;
  const rows = [], handlers = new Map();
  const monitor = createMainLagMonitor({
    file: 'unused-with-memory-sink', appendSink: line => { rows.push(JSON.parse(line)); return { written: true }; },
    now: () => wall, monotonic: () => mono, cpuUsage: () => ({ user: cpu, system: 0 }),
    threadCpuUsage: thread ? () => ({ user: cpu, system: 0 }) : null,
    setTimer: fn => { tick = fn; return { unref() {} }; }, clearTimer: () => {},
  });
  const ipc = { handle: (channel, fn) => handlers.set(channel, fn) };
  monitor.instrument(ipc); monitor.start();
  return { monitor, rows, ipc, call: (name, ...args) => handlers.get(name)(...args),
    advanceMono: ms => { mono += ms; }, fire: (elapsed, threadCpuMs = 0) => { wall += elapsed; cpu += threadCpuMs * 1000; tick(); } };
}
test('quiet IPC reads vanish from retained lag counters on the next tick', () => {
  const h = harness();
  h.ipc.handle('mc-settings:tree-slots', () => 7);
  for (let n = 0; n < 10; n++) assert.equal(h.call('mc-settings:tree-slots'), 7);
  h.fire(250);
  assert.deepEqual(h.rows, []);
  assert.equal(h.call('mc-settings:tree-slots'), 7);
  h.fire(1250);
  assert.equal(h.rows[0].blockers['mc-settings:tree-slots'].count, 1);
  h.monitor.stop();
});
test('async continuation CPU is outside the IPC synchronous prologue', async () => {
  const h = harness();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  h.ipc.handle('mc-test:async', async () => {
    h.advanceMono(27); await pending; h.advanceMono(9600); return 'retained-result';
  });
  const result = h.call('mc-test:async');
  release(); assert.equal(await result, 'retained-result'); await Promise.resolve();
  h.fire(9920, 9513);
  const row = h.rows[0];
  assert.equal(row.lagMs, 9670);
  assert.equal(row.blockers['mc-test:async'].totalMs, 27);
  assert.equal(row.blockers['await:mc-test:async'].totalMs, 9600);
  assert.equal(row.blockerMs, 27);
  h.monitor.stop();
});
test('nested synchronous labels overlap and cannot be treated as a partition of elapsed time', () => {
  const h = harness();
  h.monitor.note('outer', () => {
    h.advanceMono(50);
    h.monitor.note('inner', () => h.advanceMono(50));
  });
  h.fire(1250);
  const row = h.rows[0];
  assert.equal(row.blockers.outer.totalMs, 100);
  assert.equal(row.blockers.inner.totalMs, 50);
  assert.equal(row.blockerMs, 100);
  h.monitor.stop();
});
test('missing thread CPU does not become a zero measurement', () => {
  const h = harness({ thread: false });
  h.fire(1250, 900);
  assert.equal(h.rows[0].mainThread, 'unknown');
  assert.equal(h.rows[0].threadCpuMs, undefined);
  assert.equal(h.rows[0].cpuMs, 900);
  h.monitor.stop();
});
