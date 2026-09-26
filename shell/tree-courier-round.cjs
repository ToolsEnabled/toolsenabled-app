/* WHO THE TREE COURIER READS FOR THIS TICK, AND WHETHER IT SHOULD TICK AT ALL.
 *
 * THE DEFECT THIS EXISTS TO REMOVE, MEASURED 2026-09-03. The courier asked the
 * engine one question per running circle per tick, every 1200 ms, for ever.
 * Measured on an isolated state root with three circles, forty messages already
 * on the wire and a 12,608-byte broker spool:
 *
 *   the first inbox() of a tick      11.45 / 12.24 / 14.25 ms   min / med / max
 *   every later inbox() of that tick  1.18 /  1.32 /  2.25 ms
 *   the whole tick, three circles    13.96 / 15.10 / 17.19 ms
 *   the same tick, six circles       25.66 / 30.70 / 49.05 ms
 *
 * Two separate wastes are in those numbers. The first call of every tick paid a
 * whole engine runtime rebuild -- spool lock, spool read, claim reconciliation,
 * spool rewrite -- because the engine memoized that build for 1000 ms while the
 * poll that used it ran every 1200 ms (fixed in the engine, and measured there).
 * The rest is this file's business: every one of those calls repeated the same
 * directory read and the same roster check before it could read one page, and
 * those answers are identical for every circle in the same tick.
 *
 * AND IT KEPT TICKING WITH NOBODY ON THE TREE. startTreePolling() had no
 * counterpart short of closing the whole host, so a computer whose circles had
 * all ended still woke this loop 0.83 times a second until the app quit.
 *
 * WHAT THIS MODULE IS. One decision, alone and pure, so it can be tested by
 * calling it with values rather than by driving a host with real engines:
 * given the sessions as they are right now, is there anybody on the tree at
 * all, and which of them should this round read for. It reads nothing, sends
 * nothing, and cannot widen what any caller may reach.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE. Who gets a turn boundary: that is
 * tree-turn-priority.cjs, and the person still wins it. Nothing here can make
 * the courier take a turn, only which inboxes are worth asking about.
 */
'use strict'

/* A session that is on the tree is one that has been told its own circle name
   and holds a durable address. Everything else in a host -- a session starting,
   a session from the single-agent page, a session already ended -- is not on
   the tree and is not this courier's business. */
function isOnTree(session) {
  return Boolean(session
    && session.treeAddress
    && typeof session.treeAddress.agentId === 'string'
    && session.treeAddress.agentId.length > 0)
}

/**
 * Plan one round of the tree courier.
 *
 * @param {Iterable<object>} sessions   the host's sessions, as they are now.
 * @param {object} [options]
 * @param {number} [options.inboxLimit] how many records one page may carry.
 * @returns {{idle: boolean, requests: ReadonlyArray<object>}} frozen.
 *   `idle` -- NOBODY holds a tree address, so the courier has nothing to carry
 *   for anyone and its timer should stop until a circle registers again.
 *   `requests` -- the circles to read for this round, each {sessionId, agentId,
 *   cursor, limit}.
 */
function planTreeRound(sessions, { inboxLimit = 10 } = {}) {
  /* ONE PASS, BECAUSE `sessions` IS AN ITERATOR. The caller passes
     sessions.values(); walking it twice leaves the second walk empty, and an
     empty second walk here silently meant "nobody is waiting" -- which stopped
     the courier's timer, which is the only clock the registration retry rides.
     Both questions are answered in the single pass this is given. */
  const onTree = []
  const awaiting = []
  for (const session of sessions || []) {
    if (isOnTree(session)) {
      onTree.push(session)
    } else if (session && session.treeIdentity && session.state === 'ready') {
      awaiting.push(session)
    }
  }
  /* IDLE IS ABOUT THE TREE, NOT ABOUT TRAFFIC. A circle that is on the tree and
     merely quiet still has to be read -- silence is the normal state of an
     agent between messages, and a courier that stopped for it would deliver the
     next arrival only when something else happened to wake it. What makes the
     courier pointless is nobody being addressable at all. */
  /* A CIRCLE THAT KNOWS ITS NAME BUT HOLDS NO ADDRESS IS NOT IDLE, IT IS
     WAITING. It is not on the tree -- it has nothing to be read from -- but the
     courier's timer is the only clock its registration retry rides. Reporting
     idle here stopped that timer, and a circle whose directory was unreadable
     at brief time then waited forever: the one thing that would have asked
     again was the thing that had just been switched off. */
  if (onTree.length === 0) {
    return Object.freeze({
      idle: awaiting.length === 0,
      requests: Object.freeze([]),
      awaiting: Object.freeze(awaiting.map(session => session.sessionId)),
    })
  }

  const requests = []
  for (const session of onTree) {
    /* NOT READY IS NOT UNREACHABLE. A session that is starting or closing still
       holds its address and will be read on a later round; skipping it here is
       a deferral, never a delivery. */
    if (session.state !== 'ready') continue
    /* ONE READ-AND-DELIVER PASS PER CIRCLE AT A TIME. A slow durable read can
       outlive the interval, and a second read from the same cursor would queue
       the same records twice -- the receiving agent would be told the same
       thing twice and answer it twice. The latch is checked HERE, before the
       round's single batched read is built, because that read is now shared and
       a duplicate cannot be caught afterwards. */
    if (session.treePumpPromise) continue
    requests.push(Object.freeze({
      sessionId: session.sessionId,
      agentId: session.treeAddress.agentId,
      cursor: Number.isFinite(session.treeCursor) ? session.treeCursor : 0,
      limit: inboxLimit,
    }))
  }
  return Object.freeze({ idle: false, requests: Object.freeze(requests) })
}

module.exports = { planTreeRound }
