/* The central clock behind every "how long has this agent been up" readout.
 *
 * One interval in src/main.js drives every runtime element in the app rather
 * than each element owning a timer. This module holds the registry and the
 * tick, and is deliberately dependency-free so it can be tested directly --
 * the same reason agent-session-events.js is split out. Importing
 * components.js pulls in sim.js, which schedules timers at import time, so a
 * test that reached this through components.js would never exit.
 *
 * WHAT THE TICK COSTS WHEN NOTHING HAS CHANGED is the thing to keep in mind
 * here: it runs twice a second for the entire life of the process, on every
 * machine, including one sitting idle with no fleet attached. Three things it
 * used to do have been removed for that reason:
 *
 *   1. It copied the whole registry into a fresh array (`[...runtimeEls]`) on
 *      every tick. Iterating the Set directly is safe: deleting the entry the
 *      loop is currently on is defined behaviour for Set iterators, and that
 *      is the only deletion performed.
 *   2. Removing one disconnected element scanned the entire registry to find
 *      it, so tearing down a view with n readouts cost O(n^2). The entry is
 *      already in hand, so deletion is O(1).
 *   3. It assigned `textContent` unconditionally. A runtime readout changes at
 *      most once a second and this runs twice a second, so at least half of
 *      all writes -- and every write on a machine whose digits are parked on a
 *      placeholder -- rewrote the value that was already there. Assigning
 *      textContent dirties the node and costs layout even when the string is
 *      identical. Comparing first makes an unchanged tick a string compare and
 *      no DOM mutation at all.
 *
 * Same digits, same cadence, same elements: only the redundant work is gone.
 *
 * ---------------------------------------------------------------------------
 * AND THE FOURTH THING, WHICH IS THE WHOLE INTERVAL.
 *
 * The three repairs above made an idle tick cheap. They could not make it
 * free, because the wake itself is the cost: twice a second the renderer is
 * pulled out of idle, whatever is on screen. MEASURED 2026-09-03 with
 * tools/renderer-idle-poll-inventory.mjs over ten virtual minutes: 120.00
 * ticks per minute, on every screen, for the life of the window -- 96.5% of
 * everything the idle home window scheduled (124.30 ticks/min in total).
 *
 * WHAT THOSE 120 WAKES WERE FOR, ALMOST ALWAYS: nothing. Grep the tree for
 * bindRuntime and there are exactly two callers -- src/tree-graph.js and
 * src/phone-ledger.js. On every other screen, home included, and on the tree
 * before a node is drawn, the registry is EMPTY, and each of those 120 wakes
 * iterated an empty Set and returned.
 *
 * That answer is not merely unchanged, it is STRUCTURALLY FIXED: a registry
 * with nothing in it has nothing it could write, so the tick cannot have an
 * effect. So the interval now exists only while at least one readout is
 * registered. bindRuntime wakes it; the last unbind puts it back to sleep, and
 * so does the tick that releases the last disconnected element -- which is how
 * a view torn down without unbinding still stops the clock.
 *
 * The guarantee is unchanged in both directions. While anything is on screen
 * the same elements get the same strings at the same 500ms cadence. A readout
 * bound while the clock is asleep gets its first tick within 500ms, exactly as
 * it would have waited up to 500ms for the next tick of a free-running
 * interval. What is gone is the wake that had nothing to wake for.
 */

const runtimeEls = new Set()

/* The cadence, named here rather than at the call site, because this module is
   now the thing that owns it. */
export const RUNTIME_TICK_MS = 500

/* null until a window starts the clock. A test that only calls bindRuntime and
   tickRuntimes by hand therefore schedules nothing at all, which is what makes
   the registry tests above possible to write without a fake timer. */
let clock = null

function wakeClock() {
  if (!clock || clock.handle !== null || runtimeEls.size === 0) return
  clock.handle = clock.schedule(() => tickRuntimes(clock.fmt), clock.everyMs)
}

function sleepClock() {
  if (!clock || clock.handle === null || runtimeEls.size > 0) return
  clock.cancel(clock.handle)
  clock.handle = null
}

export function bindRuntime(elm, bornAtFn) {
  const entry = { elm, bornAtFn, last: undefined }
  runtimeEls.add(entry)
  wakeClock()
  return () => { runtimeEls.delete(entry); sleepClock() }
}

export function tickRuntimes(fmt) {
  for (const entry of runtimeEls) {
    const { elm, bornAtFn } = entry
    if (!elm.isConnected) { runtimeEls.delete(entry); continue }
    const next = fmt(bornAtFn())
    if (entry.last !== next) {
      elm.textContent = next
      entry.last = next
    }
  }
  /* The tick above is the ONLY thing that releases an element a view forgot to
     unbind, so it is also the only place that can notice the registry has just
     become empty. Without this line a page that left its readouts behind would
     keep the clock running for the life of the window. */
  sleepClock()
}

/**
 * Hand this module the window's timer, once, at boot. It schedules nothing
 * until something is registered, and unschedules as soon as nothing is.
 * Returns the teardown, and is idempotent: starting twice replaces the first.
 */
export function startRuntimeClock({
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = handle => clearInterval(handle),
  fmt = fmtRuntime,
  everyMs = RUNTIME_TICK_MS,
} = {}) {
  stopRuntimeClock()
  clock = { schedule, cancel, fmt, everyMs, handle: null }
  wakeClock()
  return stopRuntimeClock
}

export function stopRuntimeClock() {
  if (!clock) return
  if (clock.handle !== null) clock.cancel(clock.handle)
  clock = null
}

/* Test-only view of the scheduling, for the same reason runtimeRegistrySize
   exists: a wake that should not be happening is invisible from the outside. */
export function runtimeClockScheduled() {
  return Boolean(clock && clock.handle !== null)
}

/* Test-only view of the registry. Exported so a test can prove that a
   disconnected element is actually released rather than merely skipped -- a
   leak here is invisible from the outside and would grow for the life of the
   process. */
export function runtimeRegistrySize() {
  return runtimeEls.size
}

/* ---------- the formatters, re-homed out of the simulation engine ----------
 *
 * fmtRuntime and uptimeParts lived in sim.js, which made every LIVE surface
 * that prints a runtime import the demonstration engine to format a number.
 * sim.js is being deleted (the separate simulated render is gone; mock data
 * feeds the one real render instead), and these two were never simulation:
 * they format elapsed time, whoever measured it. They land HERE because this
 * file is already the app's clock module and already holds the rule that
 * matters -- dependency-free, testable directly.
 *
 * Byte-for-byte the same implementations as sim.js carried, deliberately:
 * half the product's screenshots show these digits, and a re-home that also
 * "improved" the formatting would make every one of them stale for no reason
 * anyone asked.
 *
 * (An earlier pass this session put these in a NEW file at this path without
 * noticing the path was taken -- overwriting the registry above and breaking
 * components.js's re-export of it. Restored from HEAD and merged. The lesson
 * is recorded where lessons go; the code is whole here.)
 */

const now = () => Date.now()

export function fmtRuntime(bornAt, stoppedAt = now()) {
  let s = Math.max(0, Math.floor((stoppedAt - bornAt) / 1000))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const pad = (n) => String(n).padStart(2, '0')
  return d > 0 ? `${d}:${pad(h)}:${pad(m)}:${pad(s)}` : `${h}:${pad(m)}:${pad(s)}`
}

export function uptimeParts(epoch) {
  let s = Math.max(0, Math.floor((now() - epoch) / 1000))
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  const pad = (n) => String(n).padStart(2, '0')
  return { d: String(d), h: pad(h), m: pad(m), s: pad(s), frac: ((now() - epoch) % 60000) / 60000 }
}
