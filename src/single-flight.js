/* ONE OF THIS THING AT A TIME, PER KEY.
 *
 * The tree view had grown three hand-rolled versions of the same guard --
 * startingNodeIds, recoveringNodes, and (after a measured defect) a third for
 * resume -- each a Set with an add before the first await and a delete in a
 * finally. Hand-rolled is where they diverge: the resume one did not exist at
 * all until a second press on a dead node was found starting a SECOND live
 * agent, because the only gate was the node's status and the status does not
 * change until the new session opens. Both agents then ran, the later one
 * owned the node, and the earlier kept working and spending with nothing on
 * screen able to reach it.
 *
 * WHY A HELPER AND NOT A FOURTH SET: the shape is three lines and the mistake
 * is never in the lines, it is in forgetting one of them -- most often the
 * finally, which turns a transient guard into a permanent refusal. Here the
 * release is structural: the caller cannot hold the slot open by throwing,
 * and cannot forget to free it, because freeing is not something the caller
 * does. It is also directly testable, which a closure-private Set inside a
 * 9,000-line view is not.
 *
 * DELIBERATELY NOT A QUEUE. A second call while the first is in flight is
 * REFUSED, not deferred: these guard actions a person took, and a person who
 * presses twice wants one agent, not two in sequence. The caller decides what
 * to say about the refusal, because only the caller knows the words for it.
 */

export function createSingleFlight() {
  const inFlight = new Set()

  return {
    /** True while a run for this key has started and not yet settled. */
    busy(key) { return inFlight.has(key) },

    /** Run `work` unless one is already running for `key`.
     *
     *  Returns `{ ran: true, value }` when it ran, `{ ran: false }` when it
     *  refused. The two are distinguishable on purpose: a caller that cannot
     *  tell "did not run" from "ran and returned false" would report a
     *  refusal as a failure, which is how a person gets told something broke
     *  when the product correctly did nothing.
     *
     *  A null/undefined key is NOT guarded -- an unidentifiable subject
     *  cannot be told apart from another one, and silently collapsing them
     *  all onto a single slot would refuse unrelated work. */
    async run(key, work) {
      if (key === null || key === undefined) return { ran: true, value: await work() }
      if (inFlight.has(key)) return { ran: false }
      inFlight.add(key)
      try {
        return { ran: true, value: await work() }
      } finally {
        inFlight.delete(key)
      }
    },
  }
}
