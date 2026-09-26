/* HAS THE THING OUTSIDE THIS PRODUCT ACTUALLY BEEN FOUND?
 *
 * src/permission-guidance.js declares the capabilities this app depends on and
 * does not provide. This file is the only place that asks the computer about
 * them, and it answers in three values rather than two.
 *
 *   true       found
 *   false      looked, and it is not there
 *   undefined  could not look
 *
 * THE THIRD ONE IS THE POINT. A probe that cannot run -- because this page is
 * open in a browser rather than the installed app, because the bridge it asks
 * has not started, because the call threw -- must not be rounded to either of
 * the other two. Rounding it to `false` puts an alarming, unfounded "not
 * installed" in front of a person whose machine is fine. Rounding it to `true`
 * is worse: it claims a capability nobody verified, which is the exact thing
 * R1502 forbids. So an unanswerable probe stays unanswered and every surface
 * built on it says "this copy could not check" in those words.
 *
 * NOTHING HERE STARTS, INSTALLS, ELEVATES OR CHANGES ANYTHING. Every call is a
 * read. The whole design of this lane is that the product describes the outside
 * world and never reaches into it.
 *
 * IT IS CACHED AND ONE-SHOT PER PAGE VISIT, not polled. These answers change
 * when a person goes and does something in another window, which is a
 * human-speed event; a poll would spend the bridge's time to learn nothing.
 */

import { cloudAvailability } from './cloud-tasks-controller.js'
import { bridgeReachable } from './mission-bridge.js'

export const CAPABILITY_PROBE_EVENT = 'mc:capability-probes-changed'

/* Absent from the map means unanswered, which is why this is a Map and not an
   object with boolean defaults: `has` and `get` are different questions and
   both are asked. */
const answers = new Map()
let inFlight = null

/** true, false, or undefined for "could not look". Never throws. */
export function probeState(capabilityId) {
  return answers.has(capabilityId) ? answers.get(capabilityId) : undefined
}

/** The function shape src/guided-step.js wants, bound to this cache. */
export const probe = capabilityId => probeState(capabilityId)

function record(capabilityId, value) {
  if (value === true || value === false) answers.set(capabilityId, value)
  else answers.delete(capabilityId)
}

async function probeCodex() {
  /* Running outside the installed app is a reason we CANNOT look, not evidence
     that Codex is missing -- a browser tab has no way to see the programs on
     the computer. */
  if (!globalThis.mcAgent?.availability) return undefined
  try {
    const reply = await globalThis.mcAgent.availability()
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return undefined
    if (['AGENT_CODEX_CLI_NOT_INSTALLED', 'AGENT_CONFINEMENT_SIGNED_OUT'].includes(reply.codexCode)) return false
    if (reply.readyProvider) return undefined
    if (reply.ok === true) return true
    /* Only these two codes mean "Codex itself is missing or signed out". Any
       other refusal is about something else -- a permission level, a folder --
       and answering `false` for those would blame the wrong thing. */
    return reply.code === 'AGENT_CODEX_CLI_NOT_INSTALLED' || reply.code === 'AGENT_CONFINEMENT_SIGNED_OUT'
      ? false
      : undefined
  } catch { return undefined }
}

/* MEASURED, AND THE MEASUREMENT CHANGED THE ANSWER.
 *
 * The obvious probe was cloudAvailability(), and it was written that way first.
 * Run on the packaged window it reported the Codex Cloud account as AVAILABLE on
 * a machine where nothing had ever signed in to Codex Cloud, and the guided step
 * duly hid itself as satisfied. Reading the function explains why:
 * cloudAvailability answers two questions -- is this the desktop app, and is the
 * switch on -- and neither of them is "can this computer reach Codex Cloud". It
 * never contacts anything, and its own `ok` note says "Codex Cloud ready" about
 * a service it has not spoken to.
 *
 * A probe that reports a capability nobody verified is the exact failure R1502
 * names, and it is worse here than reporting nothing: it would have removed the
 * walkthrough from the one screen where a person is deciding whether they need
 * it. So this returns UNKNOWN, and the guided step says "this copy could not
 * check" in those words.
 *
 * WHAT WOULD MAKE IT ANSWERABLE, named rather than left as a shrug: the R1525 T4
 * lane is building Codex Cloud reachability from inside the shipped app. When a
 * read-only reachability call exists, this function calls it and returns its
 * real verdict. Until then the honest answer is that nobody has looked. */
function probeCloud() {
  /* Referenced so this file still fails to load if the module it is waiting on
     is renamed, rather than silently keeping a stale plan in a comment. */
  void cloudAvailability
  return undefined
}

async function probeBridge() {
  try {
    const reach = await bridgeReachable()
    if (reach?.ok === true) return true
    return false
  } catch { return undefined }
}

/**
 * Ask once, cache, and announce. Returns the same promise while one is in
 * flight so several mounting surfaces do not each pay for the round trip.
 */
export function refreshCapabilityProbes() {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const [codex, bridge] = await Promise.all([probeCodex(), probeBridge()])
    record('codex-installed', codex)
    record('audited-connection', bridge)
    record('codex-cloud-account', probeCloud())
    try {
      window.dispatchEvent(new CustomEvent(CAPABILITY_PROBE_EVENT, { detail: Object.freeze({}) }))
    } catch { /* no window: a test harness, and the cache is still filled */ }
    return Object.freeze({
      'codex-installed': probeState('codex-installed'),
      'audited-connection': probeState('audited-connection'),
      'codex-cloud-account': probeState('codex-cloud-account'),
    })
  })().finally(() => { inFlight = null })
  return inFlight
}

/** For tests: forget every answer, so the unanswered case can be exercised. */
export function resetCapabilityProbes() {
  answers.clear()
  inFlight = null
}
