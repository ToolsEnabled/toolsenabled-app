'use strict'

/* THE MAIN PROCESS'S END OF THE LEDGER THREAD.
 *
 * shell/canonical-audit-worker.cjs explains what was moved and why it had to
 * move. This is the half that stays behind: it owns the worker, hands it one
 * record at a time, and turns every outcome -- a receipt, a refusal, a wedged
 * thread, a dead thread -- into the SAME plain object shape the synchronous
 * path returned, so no caller has to learn a second vocabulary.
 *
 * FOUR RULES, EACH LOAD BEARING.
 *
 * 1. ONE RECORD IN FLIGHT, IN THE ORDER THEY WERE ASKED FOR. The ledger is a
 *    hash chain and its head anchor is monotonic; two admissions racing inside
 *    one process would contend for the vault's lock and, worse, would make the
 *    order of two of this window's own actions a matter of scheduling. A queue
 *    of one keeps the window's own sequence the sequence it asked for.
 *
 * 2. NOTHING IS EVER REPORTED AS RECORDED THAT WAS NOT. There is no
 *    fire-and-forget path. A caller's promise settles when the worker answers,
 *    and the answer is the payload's own receipt or the payload's own refusal
 *    code. The product's rule -- "an action that could not be recorded is an
 *    action that did not happen" -- is unchanged; only the thread that
 *    establishes it has changed.
 *
 * 3. A THREAD THAT STOPS ANSWERING MUST REFUSE, NEVER HANG. That is the whole
 *    point of the move: the failure this replaces was a window frozen for
 *    fifteen seconds. So the in-flight record has a bound, and when it expires
 *    the worker is torn down and the caller is told AUDIT_UNAVAILABLE. The
 *    bound is generous (a minute) because the vault genuinely does take
 *    seconds under load and a false refusal is a real cost -- but it is a
 *    bound, and it is finite.
 *
 * 4. A TIMEOUT OR A DEAD THREAD IS A REFUSAL, NOT A GUESS. When a record times
 *    out, this side does not know whether the append landed. It reports
 *    AUDIT_UNAVAILABLE, which makes the caller refuse the action -- the same
 *    direction the synchronous path failed in when requireRecord threw partway
 *    through. The ledger may hold a row for an action that did not happen;
 *    that is the safe half of the two, and it is the half that already
 *    shipped.
 */

const path = require('node:path')

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_FLUSH_MS = 5_000

function failure(code, reason) {
  return { ok: false, code, reason }
}

const UNAVAILABLE_REASON = 'The action was not recorded in the signed ledger, so it was not performed.'

/* HOW THE THREAD IS STARTED, AND WHY THERE ARE TWO WAYS.
 *
 * The ordinary way is the file path. The fallback exists because this shell
 * ships inside an asar archive and a worker's entry file is resolved by a
 * module loader running in a thread this process did not bootstrap. Rather
 * than reason about whether that loader sees the archive, the fallback reads
 * the entry with fs -- which unambiguously does see it, in this process, on the
 * thread that already reads every other file here -- and starts the worker from
 * that source. The worker takes every path it needs from workerData and calls
 * require() only on absolute paths, so it behaves identically either way.
 *
 * The fallback is attempted once, only when the first attempt died before it
 * said it was ready. A worker that reports ready and then fails is a real
 * failure and is reported as one. */
function startWorker({ workerFile, workerData, WorkerClass }) {
  return new WorkerClass(workerFile, { workerData })
}

function startWorkerFromSource({ workerFile, workerData, WorkerClass, readFileSync }) {
  const source = readFileSync(workerFile, 'utf8')
  return new WorkerClass(source, { eval: true, workerData })
}

/**
 * A serialized canonical-record lane over one worker thread.
 *
 * @param {object} options
 * @param {object} options.workerData  { stateRoot, payloadRoot, auditModule } -- absolute paths.
 * @param {string} [options.workerFile] the worker entry; defaults to the sibling module.
 * @param {number} [options.timeoutMs]  bound on ONE in-flight record.
 * @param {number} [options.flushMs]    bound on close()'s drain.
 * @param {Function} [options.WorkerClass] injected for tests; defaults to worker_threads.Worker.
 */
function createCanonicalAuditQueue(options = {}) {
  const workerFile = options.workerFile || path.join(__dirname, 'canonical-audit-worker.cjs')
  const workerData = options.workerData || {}
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS
  const flushMs = Number.isFinite(options.flushMs) && options.flushMs >= 0 ? options.flushMs : DEFAULT_FLUSH_MS
  const WorkerClass = options.WorkerClass || require('node:worker_threads').Worker
  const readFileSync = options.readFileSync || require('node:fs').readFileSync
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout

  const queue = []
  let worker = null
  let workerReady = false
  let sourceFallbackUsed = false
  let inFlight = null
  let inFlightTimer = null
  let nextId = 1
  let closed = false
  let started = 0
  let retirement = null
  let closing = null
  const terminations = new Map()
  let terminatedWorkers = 0
  const idleWaiters = []
  function notifyIdle() {
    if (!inFlight && queue.length === 0) for (const resolve of idleWaiters.splice(0)) resolve()
  }

  function settle(entry, result) {
    if (entry.settled) return
    entry.settled = true
    entry.resolve(result)
  }

  function failEverything(code, reason) {
    const pending = inFlight
    inFlight = null
    if (inFlightTimer) { clearTimer(inFlightTimer); inFlightTimer = null }
    if (pending) settle(pending, failure(code, reason))
    while (queue.length > 0) settle(queue.shift(), failure(code, reason))
    notifyIdle()
  }

  function disposeWorker() {
    const dying = worker
    worker = null
    workerReady = false
    if (!dying) return
    // Detaching the dispatch slot does not prove the thread released its
    // handles. Retain every captured termination, including earlier workers
    // replaced after a failed request, until close can report its real result.
    if (terminations.has(dying)) return terminations.get(dying)
    try { dying.removeAllListeners() } catch { /* termination still owns the handle */ }
    const failed = error => failure('AUDIT_CLOSE_FAILED', `The signed record's writer thread did not stop (${error?.code || error?.message || 'no reason given'}).`)
    let termination
    try { termination = Promise.resolve(dying.terminate()).then(() => {
      terminations.delete(dying)
      terminatedWorkers += 1
      return { ok: true, closed: true }
    }, failed) }
    catch (error) { termination = Promise.resolve(failed(error)) }
    terminations.set(dying, termination)
    return termination
  }

  async function finishTerminations() {
    const results = await Promise.all(terminations.values())
    return results.find(result => result.ok === false)
      || { ok: true, closed: terminatedWorkers > 0 }
  }

  function onWorkerGone(code, reason) {
    disposeWorker()
    failEverything(code, reason)
  }

  function ensureWorker() {
    if (worker) return
    let instance
    try {
      instance = sourceFallbackUsed
        ? startWorkerFromSource({ workerFile, workerData, WorkerClass, readFileSync })
        : startWorker({ workerFile, workerData, WorkerClass, readFileSync })
    } catch (error) {
      /* A constructor that throws on this thread is the same class of fact as a
         thread that died before it was ready: try the archive-safe form once. */
      if (!sourceFallbackUsed) {
        sourceFallbackUsed = true
        try {
          instance = startWorkerFromSource({ workerFile, workerData, WorkerClass, readFileSync })
        } catch (second) {
          failEverything('AUDIT_UNAVAILABLE', `The signed record's writer thread could not be started (${(second && (second.code || second.message)) || 'no reason given'}). ${UNAVAILABLE_REASON}`)
          return
        }
      } else {
        failEverything('AUDIT_UNAVAILABLE', `The signed record's writer thread could not be started (${(error && (error.code || error.message)) || 'no reason given'}). ${UNAVAILABLE_REASON}`)
        return
      }
    }
    started += 1
    worker = instance
    workerReady = false
    /* unref() so an idle ledger thread never keeps a node process alive on its
       own. The Electron main process has its own reasons to stay up; a test
       process must not be held open by a thread that is waiting for work. */
    try { instance.unref() } catch { /* not every worker implementation offers it */ }
    instance.on('message', (message) => {
      if (worker !== instance || !message || typeof message !== 'object') return
      if (message.kind === 'ready') { workerReady = true; return }
      if (!inFlight || message.id !== inFlight.id) return
      const entry = inFlight
      inFlight = null
      if (inFlightTimer) { clearTimer(inFlightTimer); inFlightTimer = null }
      settle(entry, message.result)
      pump()
    })
    instance.on('error', (error) => {
      if (worker !== instance) return
      retryOrFail(`The signed record's writer thread failed (${(error && (error.code || error.message)) || 'no reason given'}). ${UNAVAILABLE_REASON}`)
    })
    instance.on('exit', () => {
      if (worker !== instance) return
      retryOrFail(`The signed record's writer thread stopped. ${UNAVAILABLE_REASON}`)
    })
  }

  function retryOrFail(reason) {
    const neverReady = !workerReady
    disposeWorker()
    if (neverReady && !sourceFallbackUsed) {
      /* It died without ever saying it was ready: the entry file was probably
         not resolvable from inside the thread. Take the archive-safe route once
         and re-send whatever was in flight; nothing was recorded, because the
         thread never loaded the writer. */
      sourceFallbackUsed = true
      if (inFlight) { queue.unshift(inFlight); inFlight = null }
      if (inFlightTimer) { clearTimer(inFlightTimer); inFlightTimer = null }
      pump()
      return
    }
    failEverything('AUDIT_UNAVAILABLE', reason)
  }

  function pump() {
    notifyIdle()
    if (closed && queue.length === 0 && !inFlight) return
    if (inFlight || queue.length === 0) return
    ensureWorker()
    if (!worker) return
    const entry = queue.shift()
    inFlight = entry
    inFlightTimer = setTimer(() => {
      inFlightTimer = null
      const timedOut = inFlight
      inFlight = null
      disposeWorker()
      if (timedOut) {
        settle(timedOut, failure(
          'AUDIT_UNAVAILABLE',
          `The signed record did not answer within ${timeoutMs} ms, so this action is refused rather than left waiting. ${UNAVAILABLE_REASON}`,
        ))
      }
      failEverything('AUDIT_UNAVAILABLE', `The signed record's writer thread was torn down after a record exceeded ${timeoutMs} ms. ${UNAVAILABLE_REASON}`)
    }, timeoutMs)
    try {
      worker.postMessage({ id: entry.id, kind: entry.kind, action: entry.action, target: entry.target, details: entry.details, limit: entry.limit, items: entry.items })
    } catch (error) {
      if (inFlightTimer) { clearTimer(inFlightTimer); inFlightTimer = null }
      inFlight = null
      settle(entry, failure('AUDIT_UNAVAILABLE', `The signed record's writer thread could not be reached (${(error && (error.code || error.message)) || 'no reason given'}). ${UNAVAILABLE_REASON}`))
      disposeWorker()
      pump()
    }
  }

  function enqueue(entry) {
    return new Promise((resolve) => {
      entry.id = nextId
      nextId += 1
      entry.resolve = resolve
      entry.settled = false
      queue.push(entry)
      pump()
    })
  }

  const api = {
    /**
     * @returns {Promise<{ok:true,sequence:number,eventHash:string}|{ok:false,code:string,reason:string}>}
     */
    record(action, target, details = {}) {
      if (closed || retirement) {
        return Promise.resolve(failure('AUDIT_UNAVAILABLE', `The signed record's writer thread is shutting down. ${UNAVAILABLE_REASON}`))
      }
      return enqueue({ kind: 'record', action, target, details })
    },

    recordBatch(items) {
      if (closed || retirement) return Promise.resolve(failure('AUDIT_UNAVAILABLE', 'The signed record writer is shutting down.'))
      if (!Array.isArray(items) || items.length < 1 || items.length > 128) {
        return Promise.resolve(failure('AUDIT_BATCH_INVALID', 'An audit batch must contain between 1 and 128 records.'))
      }
      return enqueue({ kind: 'record-batch', items })
    },

    findEvents({ action, target, limit = 100 } = {}) {
      if (closed || retirement) return Promise.resolve(failure('AUDIT_UNAVAILABLE', 'The signed record reader is shutting down.'))
      return enqueue({ kind: 'find-events', action, target, limit })
    },

    retireWhenIdle() {
      if (!retirement) retirement = (async () => {
        // Disabling optional audit cannot use close's bounded shutdown to cut
        // off a required operation. Its original result/timeout settles first.
        if (inFlight || queue.length) await new Promise(resolve => idleWaiters.push(resolve))
        return api.close()
      })()
      return retirement
    },

    /**
     * Drain what was already asked for, ask the thread to let go of the ledger
     * file, and stop it. Bounded: a thread that will not drain is terminated
     * anyway, because the caller is usually either quitting or deleting
     * somebody's data and neither may be blocked by a sick ledger.
     */
    close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        if (!worker && queue.length === 0 && !inFlight) {
          return finishTerminations()
        }
        const drained = new Promise((resolve) => {
          let done = false
          const finish = (answer) => { if (done) return; done = true; resolve(answer) }
          const deadline = setTimer(() => finish('timeout'), flushMs)
          const check = () => {
            if (done) return
            if (!inFlight && queue.length === 0) { clearTimer(deadline); finish('drained'); return }
            setTimer(check, 5)
          }
          check()
        })
        const outcome = await drained
        if (outcome === 'timeout') {
          failEverything('AUDIT_UNAVAILABLE', `The signed record's writer thread did not drain within ${flushMs} ms and was stopped. ${UNAVAILABLE_REASON}`)
          disposeWorker()
          const stopped = await finishTerminations()
          if (!stopped.ok) return stopped
          return failure('AUDIT_CLOSE_FAILED', `The signed record's writer thread did not finish its queued records within ${flushMs} ms.`)
        }
        if (!worker) return finishTerminations()
        const answered = await new Promise((resolve) => {
          const instance = worker
          const deadline = setTimer(() => resolve(failure('AUDIT_CLOSE_FAILED', 'The signed record’s database did not report that it closed.')), flushMs)
          const onMessage = (message) => {
            if (!message || typeof message !== 'object' || message.id !== 0) return
            clearTimer(deadline)
            resolve(message.result?.ok === true && message.result?.closed === true ? message.result
              : failure('AUDIT_CLOSE_FAILED', 'The signed record’s database did not confirm closure.'))
          }
          try {
            instance.on('message', onMessage)
            instance.postMessage({ id: 0, kind: 'close' })
          } catch (error) {
            clearTimer(deadline)
            resolve(failure('AUDIT_CLOSE_FAILED', `The signed record's writer thread could not be asked to close (${(error && (error.code || error.message)) || 'no reason given'}).`))
          }
        })
        disposeWorker()
        const stopped = await finishTerminations()
        return stopped.ok ? answered : stopped
      })()
      return closing
    },

    /* What a test needs to see and nothing a caller should act on. */
    inspect() {
      return { queued: queue.length, inFlight: Boolean(inFlight), workerStarts: started, closed, usedSourceFallback: sourceFallbackUsed, retiring: Boolean(retirement) }
    },
  }
  return api
}

module.exports = { DEFAULT_FLUSH_MS, DEFAULT_REQUEST_TIMEOUT_MS, createCanonicalAuditQueue }
