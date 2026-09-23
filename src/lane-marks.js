/* THE SWARM BOX AND THE DRIFT LIGHT — the only two things a cloud lane may
 * add to a node on page 2's tree.
 *
 * Owner, 2026-08-24: the tree itself does not change. No rim tint (tried,
 * and the feedback was that it wasn't good), no new geometry. Two overlays:
 *
 *   THE SWARM BOX — nine dots in a 3×3, riding the bottom-right of whichever
 *   node spawned the batch, sweep always going while the swarm runs. Its HUE
 *   is token burn on STATIC thresholds — one scale for everyone, not a share
 *   of the person's quota. That is deliberate: red says this batch is pulling
 *   serious volume, and a lane that never leaves blue is quietly telling a
 *   light-quota user there is headroom they are not using.
 *
 *   THE DRIFT LIGHT — three waves in the coolant-lamp register. TWO stages
 *   only (gold, then red) and absent entirely below them: a lamp that is
 *   always lit is a decoration, not a warning. It takes the box's corner,
 *   and when the box is showing too, the light sits directly above it.
 *
 * This module is the pure half: it reads the agent's `cloudLane` record and
 * says what to draw. The DOM half lives in tree-graph.js (_renderLaneMarks)
 * and draws exactly what this returns, so the tree and any future surface
 * cannot disagree about when a mark appears.
 *
 * THE CONTRACT this reads — explicitly reported metadata, when available.
 * This module does not infer a task's owner, token use, or drift:
 *   agent.cloudLane = {
 *     running: boolean,          // a swarm is in flight for this node
 *     tokens:  number | absent,  // tokens burned so far, when reported
 *     drift:   'drifting' | 'off-course' | absent,
 *   }
 */

/* Static burn thresholds, in tokens. A FIRST CUT awaiting calibration
 * against real lane runs — the owner's anchor is "red is the 100+ class".
 * An unreported count is NOT mapped to blue: blue claims light burn, and
 * nobody measured that. It renders neutral instead (the "outcome nobody
 * measured keeps the neutral edge" rule the action rows already follow). */
export const LANE_BURN_STEPS = Object.freeze([
  Object.freeze({ below: 1_000_000, hue: 'blue', word: 'light burn' }),
  Object.freeze({ below: 5_000_000, hue: 'green', word: 'steady burn' }),
  Object.freeze({ below: 10_000_000, hue: 'gold', word: 'heavy burn' }),
  Object.freeze({ below: Infinity, hue: 'red', word: 'very heavy burn' }),
])

/** tokens (finite number) -> one of LANE_BURN_STEPS; anything else -> null. */
export function laneBurnStep(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return null
  return LANE_BURN_STEPS.find(step => tokens < step.below) || null
}

/* The light's two stages, from the drift word the mechanical layer files.
 * Any other value — including absence, and including a hypothetical "green /
 * on target" — draws nothing: below gold the lamp does not exist. */
const DRIFT_STAGES = Object.freeze({
  'drifting': Object.freeze({ stage: 'gold', word: 'drifting' }),
  'off-course': Object.freeze({ stage: 'red', word: 'off course' }),
})

/** Copy only explicitly supplied lane measurements; absent data stays absent. */
export function readCloudLane(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  let running, tokens, drift
  try {
    // Reading data descriptors avoids inheriting a signal or evaluating a
    // getter while normalizing a record from another layer.
    running = Object.getOwnPropertyDescriptor(value, 'running')?.value
    tokens = Object.getOwnPropertyDescriptor(value, 'tokens')?.value
    drift = Object.getOwnPropertyDescriptor(value, 'drift')?.value
  } catch { return null }
  const result = {}
  if (typeof running === 'boolean') result.running = running
  if (Number.isFinite(tokens) && tokens >= 0) result.tokens = tokens
  if (typeof drift === 'string' && Object.hasOwn(DRIFT_STAGES, drift)) result.drift = drift
  return Object.keys(result).length ? Object.freeze(result) : null
}

/**
 * Everything the tree needs to draw for one node's cloud lane, decided here.
 *
 * @returns {{
 *   box: {hue: string|null, word: string} | null,
 *   light: {stage: 'gold'|'red', word: string} | null,
 * }}
 */
export function laneMarksView(cloudLane) {
  cloudLane = readCloudLane(cloudLane)
  if (!cloudLane) return { box: null, light: null }
  const step = laneBurnStep(cloudLane.tokens)
  const box = cloudLane.running === true
    ? { hue: step ? step.hue : null, word: step ? step.word : 'cloud swarm running' }
    : null
  const light = cloudLane.drift ? DRIFT_STAGES[cloudLane.drift] : null
  return { box, light }
}
