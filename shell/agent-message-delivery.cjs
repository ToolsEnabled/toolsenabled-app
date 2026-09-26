'use strict'

// Delivery never interrupts a turn. An adapter may accept additional input
// during that turn; otherwise the durable courier keeps it for the boundary.
function messageDeliveryDecision({ mode, intervalMs, queuedSince, now, active,
  canSteer, boundaryAllowed, paused = false, queued = 0 }) {
  if (!queued || paused) return 'wait'
  if (mode === 'timer' && (!Number.isFinite(queuedSince) || now - queuedSince < intervalMs)) return 'wait'
  if (!active) return boundaryAllowed ? 'turn' : 'wait'
  return mode !== 'end-of-turn' && canSteer ? 'steer' : 'wait'
}

module.exports = { messageDeliveryDecision }
