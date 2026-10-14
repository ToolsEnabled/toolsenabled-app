/* THE ANSWER THAT CANNOT CHANGE WHILE THE LAYER IS UP, ASKED ONCE INSTEAD OF
 * EVERY TIME THE RESEARCH PAGE PAINTS.
 *
 * WHAT WAS HAPPENING. src/views/research.js calls localTiersStatus() from
 * renderLiveWorld(), which runs on mount AND again on every DATA_SOURCE_EVENT,
 * so one visit to the page asks the same question twice. On this installation
 * the question has one answer and always the same one:
 *
 *   MODEL_NO_GPU_PEER_CONFIGURED, HTTP 409
 *   "No GPU peer machine is configured, so no local model backend is reachable
 *    (no machine profile is configured, so this installation describes one
 *    computer). Add one in config/machines.profile.json to enable local model
 *    inference."
 *
 * MEASURED 2026-09-03 in the owner's own audit ledger
 * (ToolsEnabled-Live/capability/logs/actions.jsonl and its legacy archive):
 * twenty-one calls to research.local_tiers_status between 2026-08-29T21:38Z and
 * 2026-09-03T04:17Z, TWENTY-ONE FAILURES, NOT ONE SUCCESS, every one of them
 * that same code; median server time 19 ms. Each call is a loopback round trip
 * the page waits on before it can draw the tiers panel, and each one lands two
 * durable audit records on the capability layer -- mcp.tool.failed, then its
 * share of a controller.meter.tool_batch -- on the process that is also serving
 * every running agent's tool calls.
 *
 * WHY IT IS SAFE TO REMEMBER THIS PARTICULAR ANSWER. The refusal is
 * STRUCTURAL, not transient: engine src/lib/providers/model.js raises
 * MODEL_NO_GPU_PEER_CONFIGURED when config/machines.profile.json declares no
 * peer at all. That file is configuration read by the capability layer, so the
 * fact cannot change under a page that is merely repainting. A transport
 * failure, a timeout, a 401, a different refusal code and a SUCCESSFUL read are
 * all deliberately NOT remembered -- readiness of a tier that exists genuinely
 * moves, and a failure that might be a blip must be retried at once.
 *
 * AND IT IS STILL ASKED AGAIN. This is a back-off, not a latch: after
 * RECHECK_MS the next caller asks for real, so a person who configures a peer
 * and restarts the layer sees it without restarting the application. Five
 * minutes is the same window src/account-switcher-state.js USAGE_STALE_MS uses
 * for the other read on this app that costs a process to take.
 *
 * NOTHING HERE HAS AN OPINION ABOUT TIME OR TRANSPORT. The clock is injected
 * and the caller supplies the key, so a suite drives both without waiting.
 */

/* THE TWO CODES THAT MEAN "THIS INSTALLATION HAS NO PEER MACHINE".
 *
 * Both are the engine's own words for one condition. model.js raises the first
 * from its peer check; research-hermes.js re-labels the same cause as the
 * second when the Hermes tier is the one that asked
 * (src/lib/providers/research-hermes.js failure()). Matching the CODE and not
 * the sentence is deliberate: the sentence carries a file name and a remedy and
 * is edited for readability, the code is the contract. */
export const SETTLED_REFUSAL_CODES = Object.freeze([
  'MODEL_NO_GPU_PEER_CONFIGURED',
  'HERMES_NO_GPU_PEER_CONFIGURED',
])

/* HOW LONG A SETTLED ANSWER MAY BE SERVED FROM MEMORY BEFORE IT IS ASKED
   AGAIN. See the header: long enough that repainting a page is free, short
   enough that configuring a peer is noticed without a relaunch. */
export const RECHECK_MS = 5 * 60 * 1000

/* THE SAME FACT, NOW THAT THE ENGINE ANSWERS IT INSTEAD OF THROWING.
 *
 * Engine src/lib/providers/research-strong.js status() used to let model.js's
 * MODEL_NO_GPU_PEER_CONFIGURED escape, so this read arrived here as
 * { ok: false, code }. It now returns a READING --
 * { ok: true, receipt: { available: false, reason } } -- because "this
 * installation declares no local model backend" is an answer, and a status
 * probe that answers must not be filed in the durable ledger as
 * mcp.tool.failed. Nothing about the person's situation changed; only the
 * shape of the reply did.
 *
 * Both shapes settle, because an app build meets whichever engine is
 * installed beside it, and a build that only understood the new one would
 * silently go back to asking twice a visit on an older layer.
 *
 * These are the engine's own machine-readable reasons for the condition
 * (resolveGpuPeerHost() raises the first two; the ambiguity check the third).
 * A reason this build does not recognise is NOT settled -- an unfamiliar
 * absence is something to ask about again, not something to remember. */
export const SETTLED_ABSENCE_REASONS = Object.freeze([
  'no_gpu_peer_configured',
  'gpu_peer_missing_address',
  'gpu_peer_ambiguous',
])

const CODES = new Set(SETTLED_REFUSAL_CODES)
const REASONS = new Set(SETTLED_ABSENCE_REASONS)

/**
 * Is this reply the fixed structural fact "this installation has no local
 * model backend", as opposed to a reading that moves or a failure that might
 * not repeat?
 *
 * Two shapes qualify and nothing else: an `{ ok: false }` carrying one of the
 * refusal codes (the older engine, which threw), and an `{ ok: true }` whose
 * receipt reads `available: false` with one of the recognised absence reasons
 * (the current engine, which answers). A malformed reply is not a fact this
 * module understands, so it answers false and is never remembered.
 *
 * A receipt with `available: true` is a MEASUREMENT of free RAM, VRAM,
 * temperature and residency. Those move, so remembering one would be a
 * different defect entirely.
 */
export function answerIsSettled(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
  if (answer.ok === true) {
    const receipt = answer.receipt
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false
    return receipt.available === false
      && typeof receipt.reason === 'string' && REASONS.has(receipt.reason)
  }
  if (answer.ok !== false) return false
  return typeof answer.code === 'string' && CODES.has(answer.code)
}

/**
 * A one-slot memo for a settled answer.
 *
 * `key` is which machine answered. request() in src/mission-bridge.js speaks
 * either to this computer's own loopback layer or through a host-supplied relay
 * transport to a DIFFERENT computer, and those two are not required to agree
 * about whether a peer is configured. So a remembered answer is only served
 * back to the same key that produced it; anything else is a miss and asks for
 * real.
 */
export function createSettledAnswerMemo({
  recheckMs = RECHECK_MS,
  isSettled = answerIsSettled,
  clock = Date.now,
} = {}) {
  if (!Number.isFinite(recheckMs) || recheckMs <= 0) {
    throw new TypeError('a settled-answer memo needs a positive recheck window')
  }
  let held = null

  return Object.freeze({
    /** The remembered answer, or null when the next caller must ask for real. */
    read(key = 'local') {
      if (!held) return null
      if (held.key !== key) return null
      if (clock() - held.at > recheckMs) {
        /* Dropped rather than merely skipped: a stale slot kept around would
           answer a later read for a key it no longer describes. */
        held = null
        return null
      }
      return held.answer
    },

    /**
     * File an answer. A reply that is not settled clears any slot instead of
     * leaving an older one to be served -- an installation that has just
     * started answering something else must not keep hearing the refusal.
     */
    remember(answer, key = 'local') {
      if (!isSettled(answer)) { held = null; return false }
      held = { key, at: clock(), answer }
      return true
    },

    /** Forget everything. The transport seam calls this when the machine on the
        other end changes. */
    forget() { held = null },

    /** Test view: 1 while an answer is held, 0 otherwise. */
    heldCount() { return held ? 1 : 0 },
  })
}
