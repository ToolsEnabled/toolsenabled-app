import { randomUUID } from 'node:crypto';
import { runOwnedJob } from './owned-job.mjs';
import { bindOwnedInstalledState, createInstalledStateContext } from '../guest/installed-state.mjs';

function failure(message, execution, cause) {
  const error = new Error(`Owned session blocked: ${message}`, cause ? { cause } : undefined);
  error.code = 'OWNED_SESSION_BLOCKED';
  error.cleanupUnconfirmed = cause?.cleanupUnconfirmed === true || execution?.cleanupConfirmed !== true;
  if (execution) error.execution = execution;
  if (cause?.executionScope) error.executionScope = cause.executionScope;
  return error;
}

function unstarted(message) {
  const error = failure(message);
  error.cleanupUnconfirmed = false;
  return error;
}

// This primitive owns a real process tree; it is NOT guest/installed-artifact
// attestation. Native startup identity is obtained from retained process/token
// handles. Its caller still must bind guest, installed bytes, CDP listener and
// durable user data. No PID lookup is ever used to stop this session.
export async function startOwnedSession(options = {}) {
  const { startupTimeoutMs = 15000, signal, installedState, ...job } = options;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0 || startupTimeoutMs > 120000) throw unstarted('invalid startup deadline');
  if (!['windows-x64-standard', 'windows-x64-administrator'].includes(job.expectedProfile)) throw unstarted('an explicit chosen privilege profile is required');
  if (Object.hasOwn(job, 'onStarted')) throw unstarted('caller startup observers cannot replace session ownership');
  if (Object.hasOwn(job, 'runtimeObservations')) throw unstarted('caller options cannot replace the private runtime channel');
  if (Object.hasOwn(job, 'installedStateProduct')) throw unstarted('caller options cannot replace the fixed installed-state context');
  const installedContext = Object.hasOwn(options, 'installedState') ? createInstalledStateContext(installedState) : null;
  job.timeoutMs ??= 10 * 60 * 1000;
  if (!Number.isSafeInteger(job.timeoutMs) || job.timeoutMs <= 0 || job.timeoutMs > 2 * 60 * 60 * 1000) throw unstarted('invalid session lifetime deadline');
  signal?.throwIfAborted();
  const id = randomUUID(), controller = new AbortController();
  let observed = null, runtimeChannel = null, settled = null, timer, stopPromise;
  let resolveStart, rejectStart;
  const startup = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const abort = () => {
    controller.abort();
    rejectStart(failure('startup cancelled'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const terminal = runOwnedJob({ ...job, signal: controller.signal, runtimeObservations: true,
    ...(installedContext ? { installedStateProduct: installedContext.product } : {}), onStarted(value, channel) {
    if (!channel || typeof channel.observeRuntime !== 'function') throw unstarted('native runtime channel is unavailable');
    if (installedContext && typeof channel.observeInstalledState !== 'function') throw unstarted('native installed-state channel is unavailable');
    runtimeChannel = channel; observed = value; resolveStart(value);
  } }).then(execution => {
    settled = { execution };
    if (!observed) rejectStart(failure('process never yielded a native startup identity', execution));
    return settled;
  }, error => {
    settled = { error };
    rejectStart(error);
    return settled;
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  timer = setTimeout(() => {
    controller.abort();
    rejectStart(failure('native startup deadline expired'));
  }, startupTimeoutMs);
  try {
    await startup;
    clearTimeout(timer);
    signal?.throwIfAborted();
    // Fast natural exit can be observed before the asynchronous startup reader.
    // Do not hand a closed command to a caller as an interactive session.
    if (settled || !runtimeChannel.active()) throw failure('process finished before session handoff', settled?.execution, settled?.error);
  } catch (error) {
    controller.abort();
    // Native abort owns a bounded fallback and durable quarantine. Do not
    // return while its cleanup is still running or substitute a green flag.
    const result = await terminal;
    if (result.error?.cleanupUnconfirmed) throw result.error;
    error.cleanupUnconfirmed = result.error ? result.error.cleanupUnconfirmed === true : result.execution?.cleanupConfirmed !== true;
    if (result.execution) error.execution = result.execution;
    throw error;
  }
  const completion = terminal.then(result => {
    if (result.error) throw result.error;
    return result.execution;
  });
  // Consumers may drive CDP before awaiting completion; retain a rejection
  // handler without changing the promise/error returned to their own await.
  completion.catch(() => {});
  const observe = async (method, transform) => {
    if (settled || controller.signal.aborted) throw failure('runtime session is no longer live', settled?.execution, settled?.error);
    // The fixed installed-reader budget includes the JS binder's raw-file reads,
    // hashes and freeze. Its native reply timer cannot cover those later stalls.
    const deadlineNs = method === 'observeInstalledState' ? process.hrtime.bigint() + 65_000_000_000n : null;
    const checkDeadline = () => {
      if (deadlineNs !== null && process.hrtime.bigint() >= deadlineNs) throw failure('installed-state observation deadline expired');
    };
    try {
      const raw = await runtimeChannel[method]();
      checkDeadline();
      if (settled || controller.signal.aborted) throw failure('runtime session ended during observation', settled?.execution, settled?.error);
      const result = transform ? transform(raw) : raw;
      checkDeadline();
      if (settled || controller.signal.aborted) throw failure('runtime session ended during observation', settled?.execution, settled?.error);
      return result;
    } catch (error) {
      controller.abort();
      // Reader or query failure does not prove the product and parent Job empty.
      // Await actual terminal cleanup and preserve any durable uncertainty.
      const result = await terminal;
      if (result.error?.cleanupUnconfirmed) throw result.error;
      error.cleanupUnconfirmed = result.error ? result.error.cleanupUnconfirmed === true : result.execution?.cleanupConfirmed !== true;
      if (result.execution) error.execution = result.execution;
      throw error;
    }
  };
  return Object.freeze({
    id, scope: 'owned-process-session-only', start: observed, completion,
    state() { return settled ? 'settled' : controller.signal.aborted ? 'stopping' : 'owned'; },
    async observeRuntime(...args) {
      if (args.length) throw unstarted('runtime observations take no caller targets, paths or overrides');
      return observe('observeRuntime');
    },
    async observeInstalledState(...args) {
      if (args.length) throw unstarted('installed-state observations take no caller targets, paths or overrides');
      if (!installedContext) throw unstarted('installed-state context was not selected before session creation');
      return observe('observeInstalledState', raw => bindOwnedInstalledState(raw, {
        context: installedContext, start: observed, profile: job.expectedProfile,
      }));
    },
    stop() {
      if (!stopPromise) {
        controller.abort();
        stopPromise = terminal.then(result => {
          if (result.error) throw result.error;
          if (result.execution.cleanupConfirmed !== true) throw failure('native process tree cleanup was not confirmed', result.execution);
          return Object.freeze({ sessionId: id, scope: 'owned-process-session-only', terminationConfirmed: true,
            ownedChildrenConfirmed: true, execution: result.execution });
        });
      }
      return stopPromise;
    },
  });
}
