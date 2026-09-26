import { createHash } from 'node:crypto';

// Transport only. The guest owner must independently establish process, token,
// installed bytes and listener ownership BEFORE supplying this exact endpoint.
// There is no browser discovery, first-tab fallback or host-browser launcher.
const METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;
const TARGET = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function error(message, uncertain = true) {
  const result = new Error(`Qualification CDP blocked: ${message}`);
  result.code = 'QUALIFICATION_CDP_BLOCKED'; result.cleanupUncertain = uncertain;
  return result;
}
function budget(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw error(`invalid ${label} budget`, false);
  return value;
}
export function exactCdpEndpoint(endpoint, targetId) {
  if (typeof targetId !== 'string' || !TARGET.test(targetId) || typeof endpoint !== 'string' ||
      !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/devtools\/page\/[A-Za-z0-9_-]+$/.test(endpoint)) throw error('an exact literal-loopback page target is required', false);
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw error('invalid owned target endpoint', false); }
  if (Number(parsed.port) > 65535 || parsed.pathname !== `/devtools/page/${targetId}`) throw error('the endpoint differs from the owned target identity', false);
  return endpoint;
}

export async function connectQualificationCdp({ endpoint, targetId, signal, connectTimeoutMs = 10000,
  commandTimeoutMs = 65000, closeTimeoutMs = 2000, maxMessageBytes = 8 * 1024 * 1024,
  maxSessionBytes = 64 * 1024 * 1024, maxPending = 64 } = {}) {
  endpoint = exactCdpEndpoint(endpoint, targetId);
  budget(connectTimeoutMs, 60000, 'connection'); budget(commandTimeoutMs, 120000, 'command');
  budget(closeTimeoutMs, 10000, 'close'); budget(maxMessageBytes, 32 * 1024 * 1024, 'message');
  budget(maxSessionBytes, 256 * 1024 * 1024, 'session'); budget(maxPending, 256, 'pending-command');
  if (signal?.aborted) throw error('connection was cancelled before opening', false);
  const socket = new WebSocket(endpoint), pending = new Map(), handlers = new Map(), trace = [];
  let sequence = 0, totalBytes = 0, failure = null, opened = false, closed = false, closeRequested = false;
  let openResolve, openReject, closeResolve;
  const connected = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  const disconnected = new Promise(resolve => { closeResolve = resolve; });
  const finishPending = (id, cause, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    if (entry.signal) entry.signal.removeEventListener('abort', entry.abort);
    cause ? entry.reject(cause) : entry.resolve(value);
  };
  const poison = cause => {
    failure ||= cause;
    openReject(failure);
    for (const id of [...pending.keys()]) finishPending(id, failure);
    handlers.clear();
    if (!closeRequested && !closed) {
      closeRequested = true; // Closing during handshake may synchronously emit error.
      try { socket.close(); } catch { /* A close request is never product cleanup proof. */ }
    }
  };
  const record = (direction, body, fields) => {
    const bytes = Buffer.byteLength(body);
    totalBytes += bytes;
    if (bytes > maxMessageBytes || totalBytes > maxSessionBytes || trace.length >= 20000) throw error('bounded protocol evidence limit exceeded');
    // Digests retain protocol identity without persisting document text,
    // provider payloads, cookies or other secrets from Network events.
    trace.push(Object.freeze({ direction, sequence: trace.length + 1, bytes,
      sha256: createHash('sha256').update(body).digest('hex'), ...fields }));
  };
  const abortConnection = () => poison(error('connection was cancelled; owned process cleanup must be confirmed separately'));
  signal?.addEventListener('abort', abortConnection, { once: true });
  socket.addEventListener('open', () => {
    opened = true;
    if (failure || signal?.aborted) { poison(failure || error('connection was cancelled')); return; }
    openResolve();
  }, { once: true });
  socket.addEventListener('error', () => poison(error('socket error; execution state is uncertain')));
  socket.addEventListener('close', () => {
    closed = true;
    signal?.removeEventListener('abort', abortConnection);
    poison(failure || error('socket closed; this does not establish product termination', pending.size > 0));
    closeResolve();
  }, { once: true });
  socket.addEventListener('message', event => {
    if (failure) return;
    try {
      if (typeof event.data !== 'string') throw error('non-text protocol message');
      if (Buffer.byteLength(event.data) > maxMessageBytes) throw error('bounded protocol evidence limit exceeded');
      const message = JSON.parse(event.data);
      if (!object(message) || Object.hasOwn(message, 'sessionId')) throw error('unexpected protocol session or message shape');
      if (Object.hasOwn(message, 'id')) {
        if (!Number.isSafeInteger(message.id) || !pending.has(message.id) || Object.hasOwn(message, 'method') ||
            (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw error('unknown, duplicate or ambiguous command reply');
        record('received', event.data, { id: message.id });
        if (message.error) {
          // A failed mutation can have side effects. Refuse the entire session
          // rather than continue a journey after an ambiguous command result.
          throw error(`command ${pending.get(message.id).method} returned a protocol error`);
        }
        if (!object(message.result)) throw error('invalid command result');
        finishPending(message.id, null, message.result);
      } else {
        if (!METHOD.test(message.method || '') || (message.params !== undefined && !object(message.params))) throw error('invalid protocol event');
        record('received', event.data, { method: message.method });
        for (const handler of [...(handlers.get(message.method) || [])]) {
          const returned = handler(message.params || {});
          if (returned && typeof returned.then === 'function') {
            Promise.resolve(returned).catch(() => {});
            throw error('event observers must finish synchronously; unobserved asynchronous failures are not evidence');
          }
        }
      }
    } catch (cause) { poison(cause.code === 'QUALIFICATION_CDP_BLOCKED' ? cause : error('protocol parsing or event observation failed')); }
  });
  const connectionTimer = setTimeout(() => poison(error('connection deadline elapsed', opened)), connectTimeoutMs);
  try { if (signal?.aborted) abortConnection(); await connected; }
  finally { clearTimeout(connectionTimer); }
  return Object.freeze({
    scope: 'cdp-transport-only', endpoint, targetId,
    send(method, params = {}, options = {}) {
      if (failure || closed) return Promise.reject(failure || error('session is closed'));
      if (!METHOD.test(method || '') || !object(params)) return Promise.reject(error('invalid command input', false));
      if (options.signal?.aborted) return Promise.reject(error('command was cancelled before sending', false));
      if (pending.size >= maxPending || sequence >= Number.MAX_SAFE_INTEGER) { poison(error('pending command budget exceeded')); return Promise.reject(failure); }
      const id = ++sequence;
      let body;
      try { body = JSON.stringify({ id, method, params }); record('sent', body, { id, method }); }
      catch (cause) { poison(cause.code === 'QUALIFICATION_CDP_BLOCKED' ? cause : error('command is not serializable', false)); return Promise.reject(failure); }
      return new Promise((resolve, reject) => {
        const abort = () => poison(error(`command ${method} cancelled after sending; execution remains uncertain`));
        const timer = setTimeout(() => poison(error(`command ${method} deadline elapsed; execution remains uncertain`)), commandTimeoutMs);
        pending.set(id, { resolve, reject, timer, signal: options.signal, abort, method });
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        try { socket.send(body); } catch { poison(error('command send failed')); }
      });
    },
    on(method, handler) {
      if (failure || closed) throw failure || error('session is closed');
      if (!METHOD.test(method || '') || typeof handler !== 'function') throw error('invalid event observer', false);
      const listeners = handlers.get(method) || new Set();
      if (listeners.size >= 64) throw error('event observer budget exceeded', false);
      listeners.add(handler); handlers.set(method, listeners);
      return () => { listeners.delete(handler); if (!listeners.size) handlers.delete(method); };
    },
    evidence() { return { scope: 'cdp-transport-only', opened, closed, failed: Boolean(failure),
      productTerminationConfirmed: false, pending: pending.size, totalBytes, trace: [...trace] }; },
    async close() {
      poison(failure || error('session deliberately closed', pending.size > 0));
      let timer;
      try {
        await Promise.race([disconnected, new Promise((_, reject) => {
          timer = setTimeout(() => reject(error('socket close is unconfirmed')), closeTimeoutMs);
        })]);
      } finally { clearTimeout(timer); }
      return { scope: 'cdp-transport-only', transportClosed: true, productTerminationConfirmed: false };
    },
  });
}
