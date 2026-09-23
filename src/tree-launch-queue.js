import { refusalSentence } from './refusal-copy.js'

// A launch queue holds identities, not live sessions. A retry is permitted only
// for a proved pre-spawn resource refusal; an uncertain start is never replayed.
export const isResourceHold = code => code === 'AGENT_MEMORY_LOW' || /^AGENT_RESOURCE_(?:UNKNOWN|PRESSURE|WARMING|STARTS_BUSY|PACING|CONTROLLER_UNKNOWN|CONTROLLER_HOLD)$/.test(code || '')

/* A HOLD IS RETRIED A SMALL, NAMED NUMBER OF TIMES, THEN ABANDONED OUT LOUD.
 *
 * MEASURED in the owner's signed spawn record (agent-spawn-records.jsonl),
 * 2026-09-14T09Z: one node was refused AGENT_RESOURCE_PRESSURE 558 times in
 * one hour, median 1.46 s apart, 648 times in all. The branch below that
 * unshifts a held node back onto `pending` had no attempt counter, no
 * growing wait (the clamp reads as a back-off and is not one) and no terminal
 * state, so a computer that stays short of memory or CPU re-asks the same
 * question for ever and the person sees a "waiting" line that never resolves.
 * The owner's words: "why is one of your agents trying to sign into claude
 * 40 times" (ledger T395).
 *
 * The rule now: each node gets MAX_RESOURCE_HOLD_ATTEMPTS starts. The wait
 * between them doubles from HOLD_BACKOFF_BASE_MS up to HOLD_BACKOFF_MAX_MS,
 * never shorter than what the monitor asked for. After the last refusal the
 * node leaves the queue with a result whose code is LAUNCH_ABANDONED_CODE and
 * whose message names what it waited for, in the monitor's own measured words,
 * so the circle can carry it. Nothing here starts an account switch: every
 * code in isResourceHold is about THIS COMPUTER's room, not an account, and
 * an account refusal is never replayed by this queue at all. */
export const MAX_RESOURCE_HOLD_ATTEMPTS = 6
export const HOLD_BACKOFF_BASE_MS = 1000
export const HOLD_BACKOFF_MAX_MS = 30000
export const LAUNCH_ABANDONED_CODE = 'AGENT_LAUNCH_ABANDONED_RESOURCE_HOLD'

/* Which scarcity a hold code is about, in the person's words. The monitor's
   `measured.cause` is preferred when it rides on the result (the engine's
   admission now says whether pressure was CPU, a loop stall or an unreadable
   sample), because a code alone cannot tell memory paging from CPU. */
export function resourceHoldKind(code, measured = null) {
  const cause = measured && typeof measured.cause === 'string' ? measured.cause : null
  if (code === 'AGENT_MEMORY_LOW' || cause === 'memory') return 'memory'
  if (cause === 'loop-lag') return 'memory-or-responsiveness'
  if (cause === 'cpu-ceiling' || code === 'AGENT_RESOURCE_PRESSURE') return 'cpu'
  if (code === 'AGENT_RESOURCE_UNKNOWN' || code === 'AGENT_RESOURCE_WARMING' || cause === 'unreadable-sample') return 'measurement'
  if (code === 'AGENT_RESOURCE_STARTS_BUSY' || code === 'AGENT_RESOURCE_PACING') return 'other-starts'
  if (code === 'AGENT_RESOURCE_CONTROLLER_UNKNOWN' || code === 'AGENT_RESOURCE_CONTROLLER_HOLD') return 'controller'
  return 'resources'
}
const HOLD_KIND_WORDS = Object.freeze({
  memory: 'free memory on this computer',
  'memory-or-responsiveness': 'this app to catch up (its event loop stalled, which is usually memory paging rather than CPU)',
  cpu: 'CPU headroom on this computer',
  measurement: 'a readable, steady resource measurement',
  'other-starts': 'other starts on this computer to settle',
  controller: 'the resource controller to allow another start',
  resources: 'room on this computer',
})
export function abandonedLaunchMessage({ attempts, code, kind, reason }) {
  const waited = HOLD_KIND_WORDS[kind] || HOLD_KIND_WORDS.resources
  return refusalSentence({ code, reason }, {
    remedy: `Not started: this agent was refused ${attempts} times while waiting for ${waited}, so the start was abandoned. It stays set; start it again when the computer has room.`,
  })
}

export function createTreeLaunchQueue({ nodes, start, prepare = null, onChange = () => {}, now = Date.now,
  schedule = setTimeout, unschedule = clearTimeout, concurrency = 4 }) {
  const pending = [...new Map(nodes.map(node => [node.id, node])).values()]
  const pendingIds = new Set(pending.map(node => node.id))
  const activeIds = new Set()
  const holdAttempts = new Map()
  const abandonedIds = new Set()
  const total = pending.length
  const preparation = prepare ? [...pending] : []
  let prepared = 0
  const results = []
  let active = 0
  let paused = false
  let cancelled = false
  let reason = ''
  let blockedUntil = 0
  let timer = null
  let finished = false
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const limit = Math.max(1, Math.min(16, Math.floor(concurrency) || 4))
  function snapshot() {
    return { total, pending: pending.length, active, preparing: prepared < preparation.length, prepared, started: results.filter(row => row.ok).length,
      refused: results.filter(row => !row.ok).length, abandoned: abandonedIds.size, paused, cancelled, waiting: !paused && blockedUntil > now(), reason, finished }
  }
  function changed() { onChange(snapshot()) }
  function nodeState(nodeId) {
    if (activeIds.has(nodeId)) return { phase: 'admitting', reason: '' }
    if (abandonedIds.has(nodeId)) return { phase: 'abandoned', reason: results.find(row => row.nodeId === nodeId)?.message || '' }
    if (!pendingIds.has(nodeId)) return null
    return { phase: cancelled ? 'cancelled' : paused ? 'paused' : prepared < preparation.length ? 'preparing'
      : blockedUntil > now() ? 'waiting' : 'queued', reason }
  }
  function finish() {
    if (finished || active || (!cancelled && pending.length)) return
    finished = true
    if (timer !== null) unschedule(timer)
    timer = null
    changed()
    resolveDone({ ...snapshot(), results: [...results], remainingIds: pending.map(node => node.id) })
  }
  function wake(delay = 0) {
    if (timer !== null || paused || cancelled || finished) return
    timer = schedule(() => { timer = null; pump() }, Math.max(0, delay))
  }
  function pump() {
    if (paused || cancelled || finished) { finish(); return }
    // Declare every identity before ANY parallel start captures the org
    // revision. A later seat write must not invalidate an earlier fresh bind.
    if (prepared < preparation.length) {
      if (active) return
      const node = preparation[prepared]
      active++
      Promise.resolve().then(() => cancelled ? { ok: false, notStarted: true } : prepare(node)).catch(error => ({ ok: false, message: error?.message || 'This identity could not be prepared.' })).then(result => {
        active--; prepared++
        if (!result?.ok && !result?.notStarted) {
          const index = pending.findIndex(row => row.id === node.id)
          if (index >= 0) pending.splice(index, 1)
          pendingIds.delete(node.id)
          results.push({ ...result, nodeId: node.id })
        }
        changed(); finish(); wake()
      })
      changed()
      return
    }
    if (blockedUntil > now()) { wake(blockedUntil - now()); return }
    reason = ''
    while (active < limit && pending.length && !paused && !cancelled) {
      const node = pending.shift()
      pendingIds.delete(node.id)
      activeIds.add(node.id)
      active++
      Promise.resolve().then(() => cancelled ? { ok: false, notStarted: true } : start(node)).catch(error => ({ ok: false, message: error?.message || 'The start did not return a receipt.' })).then(result => {
        active--
        activeIds.delete(node.id)
        const held = result?.retryable === true && !result.sessionId && isResourceHold(result.code)
        const attempts = held ? (holdAttempts.get(node.id) || 0) + 1 : 0
        if (held) holdAttempts.set(node.id, attempts)
        if (held && attempts >= MAX_RESOURCE_HOLD_ATTEMPTS && !cancelled) {
          // The cap. The node leaves the queue with a named, readable outcome
          // instead of going back on the front of the line one more time.
          const kind = resourceHoldKind(result.code, result.measured)
          abandonedIds.add(node.id)
          results.push({ ok: false, abandoned: true, code: LAUNCH_ABANDONED_CODE, holdCode: result.code, holdKind: kind, attempts,
            measured: result.measured || null, nodeId: node.id,
            message: abandonedLaunchMessage({ attempts, code: result.code, kind, reason: result.message }) })
          reason = ''
        } else if ((result?.notStarted && cancelled) || held) {
          pending.unshift(node)
          pendingIds.add(node.id)
          if (!cancelled) {
            reason = result.message || 'Waiting for resource admission.'
            // The wait GROWS: the monitor's own retry-after is a floor, never
            // the whole answer, so a monitor that keeps saying "one second"
            // no longer earns a one-second loop.
            const backoff = Math.min(HOLD_BACKOFF_MAX_MS, HOLD_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
            blockedUntil = now() + Math.max(250, backoff, Math.min(HOLD_BACKOFF_MAX_MS, result.retryAfterMs || 0))
          }
        } else results.push({ ...result, nodeId: node.id })
        changed()
        finish()
        wake(Math.max(0, blockedUntil - now()))
      })
    }
    changed()
    finish()
  }
  const queue = Object.freeze({ done, snapshot, nodeState,
    pause() { if (finished || cancelled) return; paused = true; if (timer !== null) unschedule(timer); timer = null; changed() },
    resume() { if (finished || cancelled) return; paused = false; changed(); wake() },
    cancel() { if (finished) return; cancelled = true; if (timer !== null) unschedule(timer); timer = null; changed(); finish() },
  })
  wake()
  return queue
}
