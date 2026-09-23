'use strict'

/* THE MAIN PROCESS WATCHING ITS OWN HEAP, so that if it ever does die of one,
 * it leaves a note.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT A FIX FOR.
 * The owner's app died roughly every ten to twenty minutes on 2026-09-03 with
 * no crash dump, no shutdown record, and about fifteen seconds of 100% CPU
 * first -- the exact signature of a V8 heap running out. Nobody had ever
 * measured the main process's heap, so "it ran out of memory" was a story, not
 * a finding.
 *
 * MEASURED 2026-09-04 (lane H) on this Electron 43.3.0, an isolated instance
 * driven through 3,300 turns across 9 concurrent sessions in twelve minutes:
 *
 *   heap_size_limit  4192 MB     (v8.getHeapStatistics() in the MAIN process)
 *   heapUsed         14 MB idle -> 23-34 MB under that load, FLAT
 *
 * So the main process was nowhere near its ceiling, the ceiling is four
 * gigabytes rather than the half-gigabyte a reader might assume, and
 * --max-old-space-size buys this process nothing. This guard is therefore NOT
 * the repair for that crash. It is the instrument that was missing: the next
 * time the heap climbs, the app writes down what it is holding BEFORE it dies,
 * and a person reading main-heap.log afterwards has a named cache to look at
 * instead of a silent exit and a guess.
 *
 * TWO THRESHOLDS, AND THEY DO DIFFERENT JOBS.
 *   85%  SAY SO. One line per check, naming every cache the main process can
 *        measure and how big it is. Nothing is dropped, because at 85% the
 *        honest answer is still "this is unusual", and a guard that silently
 *        threw away state at the first sign of pressure would destroy the
 *        evidence it exists to collect.
 *   92%  DROP WHAT IS SAFE TO DROP. Only caches whose contents are recomputable
 *        or expendable are pruned, and every prune is written down with what it
 *        released. Live sessions, queued commands and pending turn readings are
 *        never touched: losing those is losing the person's work, which is
 *        worse than the crash this is trying to avoid.
 *
 * IT NEVER THROWS AND IT NEVER HOLDS THE PROCESS OPEN. A guard that could fail
 * a launch, or that kept an app alive because its own timer was pending, would
 * be a worse defect than the one it watches for. Every callback is wrapped, the
 * timer is unref'd, and a log that cannot be written is dropped rather than
 * escalated -- there is nowhere better for it to go from inside the process
 * that is running out of room.
 *
 * EVERY CLOCK, READER AND WRITER IS INJECTED so the whole file is testable with
 * no Electron, no V8 pressure and no real file:
 * tools/test/heap-guard.test.mjs.
 */

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_WARN_AT = 0.85
const DEFAULT_PRUNE_AT = 0.92

/* A log that only ever grows is the same defect this file is about, one
 * directory over. Above the warn line one short line is written every interval,
 * so an app that sits at 86% for a day would write about three thousand of
 * them; the file is re-started from empty once it passes this size, which keeps
 * the most recent -- and therefore the most relevant -- lines. */
const MAX_LOG_BYTES = 1024 * 1024

function fraction(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  return used / limit
}

function megabytes(bytes) {
  return Number.isFinite(bytes) ? Math.round((bytes / 1048576) * 10) / 10 : null
}

/* WHAT ONE CACHE LOOKS LIKE TO THIS FILE.
 *
 * `name` is what a person reads in the log. `size` is a number the caller can
 * produce cheaply -- an entry count, not a byte estimate, because a byte
 * estimate of a JS structure is a guess and a count is a fact. `prune`, when
 * present, releases what the cache holds and answers how many entries went; a
 * cache with no prune is reported and never touched.
 *
 * A caller that throws while being measured is reported as unreadable rather
 * than allowed to break the round: this runs when the process is already in
 * trouble, and one bad accessor must not silence the whole note. */
function readCache(entry) {
  const name = entry && typeof entry.name === 'string' ? entry.name : 'unnamed'
  let size = null
  try {
    const value = typeof entry?.size === 'function' ? entry.size() : entry?.size
    if (Number.isFinite(value)) size = value
  } catch { size = null }
  return { name, size, prunable: typeof entry?.prune === 'function' }
}

function describe(caches) {
  return caches.map(cache => `${cache.name}=${cache.size === null ? '?' : cache.size}`).join(' ')
}

/**
 * Build the guard.
 *
 * @param {object} options
 * @param {() => {heapUsed:number}} options.memoryUsage        process.memoryUsage
 * @param {() => {heap_size_limit:number}} options.heapStatistics  v8.getHeapStatistics
 * @param {() => Array} options.caches   the caches to name, newest inventory each round
 * @param {(line:string) => void} options.write   appends one line to main-heap.log
 * @param {() => number} [options.logBytes]  current size of that file, for the reset rule
 * @param {() => void} [options.resetLog]    empties it when it passes MAX_LOG_BYTES
 */
function createHeapGuard({
  memoryUsage,
  heapStatistics,
  caches = () => [],
  write,
  logBytes = () => 0,
  resetLog = () => {},
  now = () => new Date(),
  intervalMs = DEFAULT_INTERVAL_MS,
  warnAt = DEFAULT_WARN_AT,
  pruneAt = DEFAULT_PRUNE_AT,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  if (typeof memoryUsage !== 'function' || typeof heapStatistics !== 'function') {
    throw new TypeError('The heap guard needs memoryUsage() and heapStatistics().')
  }
  if (typeof write !== 'function') throw new TypeError('The heap guard needs write().')
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('The heap guard interval must be positive.')
  if (!(warnAt > 0 && warnAt < 1) || !(pruneAt > 0 && pruneAt <= 1) || pruneAt < warnAt) {
    throw new TypeError('The heap guard thresholds must be fractions with warnAt <= pruneAt.')
  }

  let timer = null
  let lastLevel = 'ok'
  let sealedForErase = false
  const sealedReading = (pruned = 0) => ({ level: 'sealed', share: null, pruned })

  function check() {
    if (sealedForErase) return sealedReading()
    let used = null
    let limit = null
    try { used = memoryUsage().heapUsed } catch { used = null }
    if (sealedForErase) return sealedReading()
    try { limit = heapStatistics().heap_size_limit } catch { limit = null }
    if (sealedForErase) return sealedReading()
    const share = fraction(used, limit)
    if (share === null) return { level: 'unknown', share: null, pruned: 0 }

    const level = share >= pruneAt ? 'prune' : (share >= warnAt ? 'warn' : 'ok')
    if (level === 'ok') {
      /* SAY WHEN IT CAME BACK DOWN, once. A log that records only the climb
         leaves a reader unable to tell a recovered spike from the last thing
         the app ever managed to write. */
      if (lastLevel !== 'ok') {
        lastLevel = 'ok'
        emit(`recovered heapUsed=${megabytes(used)}MB (${Math.round(share * 100)}% of ${megabytes(limit)}MB)`)
      }
      if (sealedForErase) return sealedReading()
      return { level, share, pruned: 0 }
    }

    let inventory = []
    try { inventory = caches().map(entry => sealedForErase ? null : readCache(entry)).filter(Boolean) } catch { inventory = [] }
    if (sealedForErase) return sealedReading()
    let rss = null
    try { rss = memoryUsage().rss } catch { rss = null }
    if (sealedForErase) return sealedReading()
    emit(`${level} heapUsed=${megabytes(used)}MB (${Math.round(share * 100)}% of ${megabytes(limit)}MB) rss=${megabytes(rss)}MB ${describe(inventory)}`)
    if (sealedForErase) return sealedReading()

    let pruned = 0
    if (level === 'prune') {
      let entries = []
      try { entries = caches() } catch { entries = [] }
      if (sealedForErase) return sealedReading()
      for (const entry of entries) {
        if (sealedForErase) return sealedReading(pruned)
        if (typeof entry?.prune !== 'function') continue
        let released = null
        try { released = entry.prune() } catch { released = null }
        if (Number.isFinite(released)) pruned += released
        if (sealedForErase) return sealedReading(pruned)
        emit(`pruned ${entry.name || 'unnamed'} released=${Number.isFinite(released) ? released : '?'}`)
        if (sealedForErase) return sealedReading(pruned)
      }
    }
    lastLevel = level
    return { level, share, pruned }
  }

  function emit(text) {
    if (sealedForErase) return
    try {
      const bytes = logBytes()
      if (sealedForErase) return
      if (bytes > MAX_LOG_BYTES) resetLog()
    } catch { /* a size that cannot be read is not a reason to stop writing */ }
    if (sealedForErase) return
    try {
      const at = now().toISOString()
      if (!sealedForErase) write(`${at} main-heap ${text}\n`)
    } catch { /* see the header */ }
  }

  function start() {
    if (sealedForErase || timer) return false
    timer = setTimer(() => { try { check() } catch { /* see the header */ } }, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    return true
  }

  function stop() {
    if (!timer) return false
    clearTimer(timer)
    timer = null
    return true
  }

  function sealForErase() {
    // The result window stays alive after removal. An ordinary stop permits
    // restart; this terminal gate also blocks a retained callback, direct check
    // or recovery/prune continuation from recreating its erased log. Seal before
    // cancellation, retaining the timer for retry if cancellation throws.
    sealedForErase = true
    stop()
    lastLevel = 'ok'
    return { ok: true, sealed: true }
  }

  return Object.freeze({ check, start, stop, sealForErase })
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_PRUNE_AT,
  DEFAULT_WARN_AT,
  MAX_LOG_BYTES,
  createHeapGuard,
}
