'use strict'

/* WHAT STOPPED THE MAIN THREAD, WRITTEN DOWN WHILE IT IS STILL TRUE.
 *
 * WHY THIS EXISTS. Windows recorded this application as hung four times on
 * 2026-09-03 -- AppHangB1 at 17:12:58 ("stopped interacting with Windows and
 * was closed", hang signature a92d7b805a6725e35747c68ed2f88d34) and
 * AppHangTransient at 17:12:13, 19:12:44 and 20:57:38. WER wrote NO dump for
 * any of them (the report folder holds Report.wer and nothing else, and
 * HKLM\...\Windows Error Reporting\LocalDumps has entries only for NVIDIA and
 * SolidWorks), so there is no stack to walk and no way to ask, after the fact,
 * which piece of work held the loop. AppHangB1 is a statement about exactly one
 * thing: the process that owns the window stopped pumping its message queue.
 * In Electron that is this process, and the only way it happens is that
 * something ran synchronously here for several seconds.
 *
 * So the next one names itself. A timer that cannot fire while the loop is
 * blocked measures how late it was, and the handler that was running
 * immediately before it fired is the thing that blocked it.
 *
 * HOW THE BLAME IS ASSIGNED, AND WHY IT IS SOUND. `instrument()` wraps
 * ipcMain's four registration methods once, so every mc-* channel is timed
 * without one line changing at 120 call sites. Each listener's SYNCHRONOUS span
 * is measured -- from entry to the moment it returns or awaits -- because that
 * span, and only that span, is time the loop could not run. The longest such
 * span since the last tick is remembered. A tick that arrives late therefore
 * has a candidate that is not a guess: it is the longest thing that provably
 * held the thread inside the window that went missing.
 *
 * Work that is not an IPC handler -- startup, an agent event fan-out, a timer
 * of somebody else's -- is covered by note()/span(), and anything not claimed
 * by either is written as `unattributed`, which is an honest answer rather than
 * the nearest handler's name.
 *
 * THE SINGLE-WORST-SPAN QUESTION IS NOT THE ONLY ONE, AND A RETRY LOOP THAT
 * NEVER YIELDS IS WHERE IT STOPS BEING ENOUGH. On the previous generation's
 * own record (gen-6bfe1887, pid 20464), a stall of lagMs 6544 was attributed
 * to agent-event:forward with blockerMs 0, and eleven of the twelve recorded
 * stalls carried a blockerMs far below their lagMs: many small synchronous
 * spans under one label, none individually the longest thing seen that tick,
 * summing to the actual block. Every span passed to remember() -- through
 * span()/note() or reported directly through recordDuration() -- is now ALSO
 * accumulated per label since the last tick: total time, call count, and
 * that label's own longest span. The record still carries `blocker`/
 * `blockerMs` exactly as before (the single worst span, unchanged, so an
 * existing reader does not break); it now also carries `blockers` (one entry
 * per label: totalMs/count/maxMs) and `topTotal` (the label with the highest
 * total, which a drained-burst tick answers correctly where `blocker` cannot).
 *
 * THE WRITE IS SYNCHRONOUS, DELIBERATELY. Appending ~200 bytes costs about a
 * tenth of a millisecond, it happens only when a threshold has ALREADY been
 * breached, and the whole point is to survive what usually comes next: a hang
 * that Windows ends with the process still holding an unflushed buffer. A
 * queued asynchronous write is the one that is not there afterwards.
 *
 * IT CANNOT TAKE THE APPLICATION DOWN. Every path here is wrapped: a diagnostic
 * that can throw inside an IPC handler, or inside a timer with no catch above
 * it, is a worse defect than the one it was added to find.
 */

const fsDefault = require('node:fs')
const pathDefault = require('node:path')

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_THRESHOLD_MS = 500
/* One megabyte across the whole record: half of it live, half of it the
   previous half, so a rotation never doubles the budget. */
const DEFAULT_MAX_BYTES = 512 * 1024
const MAX_LABEL_LENGTH = 120
const UNATTRIBUTED = 'unattributed'

function safeLabel(value) {
  if (typeof value !== 'string') return UNATTRIBUTED
  const trimmed = value.trim()
  if (!trimmed) return UNATTRIBUTED
  /* A channel name reaches this file from a registration call, and the line it
     lands on is newline-delimited JSON that a person and a script both read.
     Control characters would break the line; a bound keeps one long name from
     eating the budget the rest of the record needs. */
  const printable = Array.from(trimmed, character => (character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f ? ' ' : character)).join('')
  return printable.slice(0, MAX_LABEL_LENGTH)
}

function createMainLagMonitor({
  file,
  intervalMs = DEFAULT_INTERVAL_MS,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  appendSink = null,
  fs = fsDefault,
  path = pathDefault,
  now = () => Date.now(),
  monotonic = () => Number(process.hrtime.bigint() / 1000n) / 1000,
  setTimer = setInterval,
  clearTimer = clearInterval,
  cpuUsage = () => process.cpuUsage(),
  /* WHOSE CPU WAS IT. `cpuUsage` above is PROCESS-wide, and this process runs a
     worker (shell/canonical-audit-queue.cjs signs the ledger's hash chain on
     one), so a high reading has never been able to name the thread that spent
     it. On the live record for 2026-09-07, `cpuMs` EXCEEDED `lagMs` on 100 of
     139 rows -- impossible for a single thread, and proof that the process-wide
     figure was being read as if it were the main thread's. Read the wrong way
     round it points a fix at code that is already off this thread.

     process.threadCpuUsage() returns the CALLING thread's own CPU, so the same
     subtraction against it answers "did THIS thread work, or wait" outright.
     Null when the runtime does not expose it: measured 2026-09-07, the bundled
     Electron 43.3.0 ships Node 24.18.1 and does expose it, so the null arm is
     the defence for an older payload, not the expected path. A seam, so a suite
     can drive it with values. */
  threadCpuUsage = typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : null,
} = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('createMainLagMonitor requires a file path')

  let timer = null
  let sealedForErase = false
  let expectedAt = 0
  /* Seeded at construction so the first tick's delta covers the first interval
     rather than the whole process lifetime. `cpuUsage` is a seam only so a
     suite can drive it with values; production takes the real reading. */
  const readCpu = cpuUsage
  let lastCpu = readCpu()
  /* Same seeding, and the same reason. A reading that throws is treated exactly
     as a runtime that has none: this is a diagnostic, and it may not become the
     reason the application stops. */
  const readThreadCpu = typeof threadCpuUsage === 'function' ? threadCpuUsage : null
  function threadCpuReading() {
    if (!readThreadCpu) return null
    try {
      const reading = readThreadCpu()
      return reading && Number.isFinite(reading.user) && reading.user >= 0 &&
        Number.isFinite(reading.system) && reading.system >= 0 ? reading : null
    } catch { return null }
  }
  let lastThreadCpu = threadCpuReading()
  /* The longest synchronous span seen since the last tick, and what it was.
     Kept exactly as they were -- existing readers of the record's
     `blocker`/`blockerMs` fields must not break. */
  let worstLabel = null
  let worstMs = 0
  /* W-drained-burst. `remember()` above answers "what was the single longest
     span", and a retry loop that calls its sleeper many times without ever
     returning to the event loop is exactly the case that question answers
     badly for: on the previous generation's own record, eleven of twelve
     recorded stalls carried a blockerMs far below their lagMs, because the
     work that actually held the thread was many small spans under one
     label, none of them individually the longest thing seen that tick. This
     map answers the question `remember()` cannot: per label, since the last
     tick, how much time did it account for in total, how many spans, and
     how long was its own longest one. */
  let totals = new Map()
  let depth = 0
  let writeFailures = 0

  /* HOW BIG WAS THE WORK. A label's longest span may carry a few counts -- a
     batch's messages and characters -- so a stall that names the label also
     says whether the work was large. NUMBERS ONLY, never text: this record is
     read by a person and by scripts, and what was in a message does not belong
     in it. Anything else, and anything that throws, is dropped. */
  function numericDetail(value) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
      const detail = {}
      for (const key of Object.keys(value).slice(0, 6)) {
        const number = value[key]
        if (/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(key) && Number.isFinite(number) && number >= 0) detail[key] = Math.round(number)
      }
      return Object.keys(detail).length ? detail : undefined
    } catch { return undefined }
  }

  function remember(label, elapsedMs, detail) {
    if (sealedForErase) return
    const entry = totals.get(label)
    if (entry) {
      entry.totalMs += elapsedMs
      entry.count += 1
      if (elapsedMs > entry.maxMs) { entry.maxMs = elapsedMs; entry.detail = detail }
    } else {
      totals.set(label, { totalMs: elapsedMs, count: 1, maxMs: elapsedMs, detail })
    }
    if (!(elapsedMs > worstMs)) return
    worstMs = elapsedMs
    worstLabel = label
  }

  /* AWAITED TIME IS NOT HELD TIME, AND MUST NEVER BECOME `blockerMs`.
   *
   * An async ipc listener's span closes when it returns its promise, so a
   * handler that stalls the loop after its first `await` is charged only its
   * synchronous prologue -- measured 2026-09-06: 56 ms attributed out of a
   * 4,050 ms stall. The obvious repair, "close the span when the promise
   * settles", is WRONG in the other direction: settle time is wall clock, and
   * a handler awaiting a slow disk or a worker reply would be reported as a
   * multi-second stall while the loop was in fact free. That would turn every
   * patient handler into a fake blocker and make the record worse, not better.
   *
   * So a settled listener's wall time is remembered under its own `await:`
   * name and kept OUT of the worst-span comparison. It reaches the record's
   * `blockers` map, where it says "this channel was outstanding for 4 s"; it
   * can never reach `blocker`/`blockerMs`, which still mean the single longest
   * span that actually held the thread. The two questions stay separable, and
   * a reader can see a handler that was slow WITHOUT being told the loop was
   * blocked for that long. */
  function rememberAwaited(label, elapsedMs) {
    if (sealedForErase) return
    if (!(typeof elapsedMs === 'number' && elapsedMs >= 0)) return
    const entry = totals.get(label)
    if (entry) {
      entry.totalMs += elapsedMs
      entry.count += 1
      if (elapsedMs > entry.maxMs) entry.maxMs = elapsedMs
      return
    }
    totals.set(label, { totalMs: elapsedMs, count: 1, maxMs: elapsedMs })
  }

  /* Open a span by hand. Returns a function that closes it; calling it twice
     closes it once. */
  function span(label) {
    const name = safeLabel(label)
    const startedAt = monotonic()
    let closed = false
    return function endSpan(detail) {
      if (closed) return 0
      closed = true
      const elapsed = monotonic() - startedAt
      remember(name, elapsed, numericDetail(detail))
      return elapsed
    }
  }

  /* Run `fn` as a named span. Only the SYNCHRONOUS part is charged: if `fn`
     returns a promise, the span closes when the function returns, because the
     awaiting part of a handler is not time the loop was held. */
  function note(label, fn, describe) {
    const end = span(label)
    let result, finished = false
    try { result = fn(); finished = true; return result } finally {
      end(finished && typeof describe === 'function' ? (() => { try { return describe(result) } catch { return undefined } })() : undefined)
    }
  }

  /* W22. A duration this process already measured by other means -- summed
     across several small synchronous calls that individually look nothing
     like a stall (a contended lock's retry loop calls its sleeper many times,
     never returning to the event loop between calls). `note()`/`span()` can
     only time a call they themselves make; this is the same `remember()` for
     a caller that already has the number. Never a substitute for measuring
     for real: a caller states what elapsed, this module still applies the
     same "only the worst SINGLE span since last tick" rule to `blocker`/
     `blockerMs`. What changed: a caller that reports each retry's own small
     duration on its own call to `recordDuration()` -- one call per sleep,
     not one call for the whole loop -- now has its TOTAL summed by
     `remember()`'s `totals` map, written into the record as `blockers` and
     `topTotal`, precisely because the loop itself never had one number to
     report; this module now adds up the many small ones it was already
     being told about. What this module still cannot do is invent that total
     from a SINGLE call that only reports its own span -- the caller must
     still make one call per unit of the work, exactly as it already did. */
  function recordDuration(label, elapsedMs) {
    if (!(typeof elapsedMs === 'number' && elapsedMs >= 0)) return
    remember(safeLabel(label), elapsedMs)
  }

  function rotate() {
    const previous = `${file}.1`
    try { fs.rmSync(previous, { force: true }) } catch { /* a rolled copy that will not delete is not worth a throw */ }
    try { fs.renameSync(file, previous) } catch {
      /* Renaming failed (another handle, a vanished file). Truncating keeps the
         bound, which is the promise that matters here. */
      try { fs.writeFileSync(file, '') } catch { /* see writeFailures */ }
    }
  }

  function append(line) {
    if (sealedForErase) return false
    try {
      if (appendSink) {
        const accepted = appendSink(line)?.written === true
        if (!accepted) writeFailures += 1
        return accepted
      }
      try { fs.mkdirSync(path.dirname(file), { recursive: true }) } catch { /* already there */ }
      let size = 0
      try { size = fs.statSync(file).size } catch { size = 0 }
      if (size + Buffer.byteLength(line, 'utf8') > maxBytes) rotate()
      fs.appendFileSync(file, line, 'utf8')
      return true
    } catch {
      writeFailures += 1
      return false
    }
  }

  /* Chosen by TOTAL, not by max -- the whole point of keeping `totals` at
     all. A label whose single longest span loses the `blocker` comparison
     can still be the thing that actually held the thread the longest, summed
     across many short spans; this is that question's own answer, kept next
     to `blocker`/`blockerMs` rather than instead of them. */
  function topTotalLabel() {
    let label = null
    let best = -1
    for (const [name, entry] of totals) {
      if (entry.totalMs > best) { best = entry.totalMs; label = name }
    }
    return label
  }

  /* WORKED, OR WAITED -- SAID OUT LOUD, so a person reading the log does not
     have to do the division themselves and cannot do it the wrong way round.
     Only the CALLING thread's own CPU can answer this, which is why it is taken
     from `threadCpuMs` and never from the process-wide `cpuMs`.

     The bands are deliberately not adjacent. A stall that is mostly CPU on this
     thread is `worked`; one that spent almost none is `waited`; anything in
     between is `mixed` and is NOT rounded to whichever end is nearer, because a
     half-and-half stall is a real third answer and the whole failure this field
     exists to end was a reading pushed to the end somebody expected. No reading
     at all is `unknown`, never a guess. */
  function mainThreadVerdict(lagMs, threadCpuMs) {
    if (typeof threadCpuMs !== 'number') return 'unknown'
    if (!(lagMs > 0)) return 'unknown'
    if (threadCpuMs >= lagMs * 0.5) return 'worked'
    if (threadCpuMs <= lagMs * 0.25) return 'waited'
    return 'mixed'
  }

  function record(lagMs, cpuMs, threadCpuMs, at) {
    const blockers = {}
    for (const [label, entry] of totals) {
      blockers[label] = { totalMs: Math.round(entry.totalMs), count: entry.count, maxMs: Math.round(entry.maxMs),
        ...(entry.detail ? { detail: entry.detail } : {}) }
    }
    const line = `${JSON.stringify({
      at: new Date(at).toISOString(),
      lagMs: Math.round(lagMs),
      /* WAS THE THREAD WORKING, OR WAITING?
       *
       * A stall says the loop did not come back on time. It does not say why,
       * and the two reasons need opposite fixes: code that HELD the thread, or
       * a thread that was not SCHEDULED. Measured 2026-09-06 on this machine,
       * both were live at once -- 8 logical processors, a run queue of 9, and
       * a durable-write path known to run in the app's own main process.
       * Argued from CPU figures taken at some other moment, the question just
       * changes answer with the weather.
       *
       * So each record carries the process CPU consumed across the same window
       * the lag was measured in. Near zero across a multi-second stall means
       * nothing was executing and the answer is scheduling or a syscall wait;
       * close to lagMs means something really was running.
       *
       * HONEST LIMIT: process.cpuUsage() is PROCESS-wide, not per-thread. A
       * busy worker inflates it while the main thread sits idle. So a LOW
       * value is decisive -- no thread of this process ran -- and a HIGH value
       * is only suggestive, because it cannot tell the main thread from a
       * worker. Read it in that direction, not the other. THAT LIMIT IS WHY
       * `threadCpuMs` AND `mainThread` SIT BESIDE IT: they are this thread's
       * own CPU and the verdict that follows from it, and they are what a
       * reader should use. `cpuMs` stays because the PAIR is the evidence --
       * cpuMs far above threadCpuMs is another thread of this process
       * working, which is precisely the case that was misread before. */
      cpuMs,
      /* Omitted entirely, rather than written as 0 or null, when the runtime
         exposes no reading: a field that is present is a measurement. */
      ...(typeof threadCpuMs === 'number' ? { threadCpuMs } : {}),
      mainThread: mainThreadVerdict(lagMs, threadCpuMs),
      blocker: worstLabel || UNATTRIBUTED,
      blockerMs: Math.round(worstMs),
      blockers,
      topTotal: topTotalLabel() || UNATTRIBUTED,
      pid: process.pid,
    })}\n`
    return append(line)
  }

  function tick() {
    if (sealedForErase) return
    try {
      const at = now()
      const due = expectedAt
      expectedAt = at + intervalMs
      const lag = at - due
      /* Read every tick, not only when a stall is written: the delta has to
         cover the SAME window the lag was measured over, and a reading taken
         only on stalls would span from the last stall instead. */
      const cpu = readCpu()
      const cpuMs = Math.round(((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / 1000)
      lastCpu = cpu
      /* Only consecutive valid readings measure this tick's CPU. A missing
         sample breaks continuity; the next valid sample establishes a new
         baseline. Regressed counters also cannot establish a measured delta. */
      const threadCpu = threadCpuReading()
      const threadCpuMs = threadCpu && lastThreadCpu &&
        threadCpu.user >= lastThreadCpu.user && threadCpu.system >= lastThreadCpu.system
        ? Math.round(((threadCpu.user - lastThreadCpu.user) + (threadCpu.system - lastThreadCpu.system)) / 1000)
        : null
      lastThreadCpu = threadCpu
      if (due > 0 && lag >= thresholdMs) record(lag, cpuMs, threadCpuMs, at)
      worstLabel = null
      worstMs = 0
      totals = new Map()
    } catch { /* a diagnostic that throws in a timer is worse than no diagnostic */ }
  }

  function start() {
    if (sealedForErase || timer) return false
    expectedAt = now() + intervalMs
    timer = setTimer(tick, intervalMs)
    /* Never a reason for the process to stay alive. */
    if (timer && typeof timer.unref === 'function') timer.unref()
    return true
  }

  function stop() {
    if (!timer) return false
    clearTimer(timer)
    timer = null
    return true
  }

  /* Erase leaves the result window and instrumented IPC handlers alive. A
     delayed timer must not recreate the profile after its log was swept, and
     an outstanding handler may still settle after cancellation. Seal before
     touching the timer; even a failed cancellation cannot restore writes.
     Ordinary stop/start remains available outside this terminal transition. */
  function sealForErase() {
    sealedForErase = true
    stop()
    expectedAt = 0
    worstLabel = null
    worstMs = 0
    totals.clear()
    return { ok: true, sealed: true }
  }

  /* ONE HOOK FOR EVERY CHANNEL. ipcMain's registration methods are replaced by
     wrappers that time each listener's synchronous span under the channel's own
     name. Called twice, the second call is a no-op: a double-wrap would charge
     every handler to itself twice and the inner name would win. */
  function instrument(ipcMain) {
    if (!ipcMain || ipcMain.__mainLagInstrumented === true) return false
    for (const method of ['handle', 'handleOnce', 'on', 'once', 'addListener']) {
      const original = ipcMain[method]
      if (typeof original !== 'function') continue
      ipcMain[method] = function instrumented(channel, listener, ...rest) {
        if (typeof listener !== 'function') return original.call(this, channel, listener, ...rest)
        const name = safeLabel(channel)
        const wrapped = function timedListener(...args) {
          const end = span(name)
          depth += 1
          let result
          try { result = listener.apply(this, args) } finally { depth -= 1; end() }
          /* The synchronous span above is unchanged and still owns `blockerMs`.
             If the listener is async, follow its promise so the record can also
             say how long the channel was outstanding -- under `await:` only, per
             rememberAwaited. The listener's own result is returned untouched:
             this observes the promise, it does not replace it, and both arms go
             to the same recorder so a rejection is timed exactly like a
             resolution and is neither swallowed nor converted. */
          if (result && typeof result.then === 'function') {
            const awaitedFrom = monotonic()
            const settled = () => rememberAwaited(`await:${name}`, monotonic() - awaitedFrom)
            try { result.then(settled, settled) } catch { /* a thenable that refuses .then is not worth a throw here */ }
          }
          return result
        }
        return original.call(this, channel, wrapped, ...rest)
      }
    }
    try {
      Object.defineProperty(ipcMain, '__mainLagInstrumented', { value: true, enumerable: false, configurable: true })
    } catch { /* a frozen ipcMain still got its wrappers above */ }
    return true
  }

  return Object.freeze({
    file,
    intervalMs,
    thresholdMs,
    maxBytes,
    start,
    stop,
    sealForErase,
    span,
    note,
    recordDuration,
    instrument,
    /* For the suite, and for a person asking whether the record is being kept:
       never any part of a decision this module makes. */
    stats: () => Object.freeze({ running: timer !== null, sealedForErase, depth, writeFailures, worstLabel, worstMs }),
  })
}

module.exports = {
  createMainLagMonitor,
  DEFAULT_INTERVAL_MS,
  DEFAULT_THRESHOLD_MS,
  DEFAULT_MAX_BYTES,
  UNATTRIBUTED,
}
