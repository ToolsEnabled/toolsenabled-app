#!/usr/bin/env node
'use strict';
/*
 * A closed EventSource can still have a queued error/message callback. That
 * callback belongs to its original stream, never whichever stream replaced it.
 * Exercise each real connect() body with a deterministic fake EventSource and
 * fake timer queue, including a manual reconnect that must cancel an old retry.
 */
const fs = require('fs');
const path = require('path');

function take(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`SSE markers missing: ${start}`);
  return source.slice(a, b);
}

function makeHarness(file, endMarker) {
  const source = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  const connectSource = take(source, 'function connect() {', endMarker);
  const elements = { connDot: { className: '', title: '' } };
  class FakeEventSource {
    static instances = [];
    constructor(url) { this.url = url; this.closed = false; FakeEventSource.instances.push(this); }
    close() { this.closed = true; }
  }
  let nextTimer = 1;
  const timers = new Map();
  const setTimeoutFake = (fn, delay) => {
    const id = nextTimer++;
    timers.set(id, { fn, delay });
    return id;
  };
  const clearTimeoutFake = (id) => timers.delete(id);
  const listeners = new Map();
  const fakeDocument = {
    hidden: false,
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    fire(type) { for (const listener of listeners.get(type) || []) listener(); },
  };
  const client = new Function('$', 'document', 'EventSource', 'setTimeout', 'clearTimeout', 'timerCount', `
    let model = { title: 'before' };
    let es = null, backoff = 1000, reconnectTimer = null;
    ${connectSource}
    return {
      connect,
      current: () => es,
      model: () => model,
      timerCount: () => timerCount(),
      setHidden: (hidden) => {
        document.hidden = hidden;
        document.fire('visibilitychange');
      }
    };
  `)(
    (id) => elements[id], fakeDocument, FakeEventSource,
    setTimeoutFake, clearTimeoutFake, () => timers.size
  );
  const runOnlyTimer = () => {
    if (timers.size !== 1) throw new Error(`expected one reconnect timer, found ${timers.size}`);
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    timer.fn();
  };
  return { client, elements, FakeEventSource, runOnlyTimer };
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

function exercise(label, file, endMarker) {
  const { client, elements, FakeEventSource, runOnlyTimer } = makeHarness(file, endMarker);
  client.connect();
  const first = FakeEventSource.instances[0];
  first.onopen();
  check(`${label}: opens the first stream`, client.current() === first && elements.connDot.className === 'dot ok');

  first.onerror();
  check(`${label}: current error closes only its own stream and queues one retry`, first.closed && client.current() === null && client.timerCount() === 1);
  runOnlyTimer();
  const second = FakeEventSource.instances[1];
  second.onopen();
  check(`${label}: retry creates a healthy replacement`, client.current() === second && !second.closed && elements.connDot.className === 'dot ok');

  const modelBeforeStale = client.model();
  first.onerror();
  first.onmessage({ data: JSON.stringify({ type: 'snapshot', model: { title: 'stale' } }) });
  check(`${label}: stale error/message cannot close or repaint the replacement`,
    client.current() === second && !second.closed && client.timerCount() === 0 && client.model() === modelBeforeStale);

  second.onerror();
  second.onerror();
  check(`${label}: duplicate current-stream errors queue only one retry`, client.current() === null && client.timerCount() === 1);
  client.connect();
  const third = FakeEventSource.instances[2];
  check(`${label}: manual connect cancels the old retry`, client.current() === third && !third.closed && client.timerCount() === 0);

  client.setHidden(true);
  check(`${label}: hiding the tab closes its stream and cancels retries`,
    third.closed && client.current() === null && client.timerCount() === 0);
  const countWhileHidden = FakeEventSource.instances.length;
  client.connect();
  check(`${label}: a hidden tab cannot consume a new SSE connection`,
    client.current() === null && FakeEventSource.instances.length === countWhileHidden);
  client.setHidden(false);
  const fourth = FakeEventSource.instances[3];
  check(`${label}: a visible tab reconnects and receives a fresh stream`,
    client.current() === fourth && !fourth.closed);
}

exercise('Studio', 'studio.js', '\n\n// ---- toast');
exercise('Dashboard', 'app.js', '\n\n// ------------------------------------------------------------------ actions');

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
