/* WHAT THE CONVERSATION LOOKS LIKE AFTER A RESUME.
 *
 * WHY THIS IS A MODULE AND NOT SIX LINES INSIDE THE VIEW. It decides what a
 * person sees of their own past, and what src/views/computers.js then writes
 * over the only durable copy of it -- and that view cannot be imported by a
 * test process (echarts, a canvas and a ResizeObserver at module load). Six
 * lines that can only be pinned as TEXT are six lines nothing drives, and the
 * defect below lived in them.
 *
 * THE DEFECT, driven on a packaged build 2026-08-20. Close the app, reopen it,
 * open a node whose agent ended with the app, and ask one more question. The
 * engine still had the thread, so the resume was a real one -- and the chat
 * came back missing the person's opening request and the only row showing what
 * the agent had actually DONE. It survived a relaunch, because the shortened
 * list was persisted straight over the record.
 *
 * The view rebuilt the conversation from `engineResumed.turns[].said`, on the
 * stated belief that the engine's turns are "longer and truer than the excerpt
 * we kept". Measured, they are neither -- they are a DIFFERENT PROJECTION, and
 * the engine says so itself. codex-adapter.js's parseThreadTurn keeps only
 * `userMessage` and `agentMessage` items: "anything richer (tool payloads,
 * reasoning) is deliberately left on the engine side -- this crosses into a
 * UI", pinned by the engine's own suite as "only what was said crosses into a
 * UI". So a rebuild from `said`:
 *
 *   - cannot contain one `who:'action'` row, because none crossed the wire;
 *   - returns the product's TWO opening `you` lines (the person's words, then
 *     the tree address block) as the ONE user message that really went out --
 *     which markTreeContext folds shut WHOLE, because readTreeAddress matches
 *     the address contract anywhere in the blob. The person's own question is
 *     then drawn inside the plumbing aside: measured as the tree-context row
 *     growing 105 -> 442 words while the YOU row above it disappeared;
 *   - carries no timestamps, so a restored action row can no longer rejoin the
 *     output the live buffer still holds for it (mergeActionsIntoHistory joins
 *     on `at`).
 *
 * THE RULE. A resume that really restored the thread changed NOTHING about the
 * past -- that is what makes it free -- so the conversation must not change
 * either. The kept excerpt is this product's own record of what it drew, and
 * it wins. The engine's turns are used for exactly the case they were added
 * for: a thread the engine still holds and the driven machine's durable record
 * does not contain.
 *
 * Nothing here touches a DOM, a store or a bridge, so the suite drives the real
 * rule rather than matching the source of it.
 */

/** The engine's speech-only view of a thread, in this page's line shape. */
function engineSpokenLines(engineResumed) {
  if (!engineResumed || !Array.isArray(engineResumed.turns)) return []
  return engineResumed.turns.flatMap(turn => (
    (turn && Array.isArray(turn.said) ? turn.said : []).map(line => ({ who: line.who, text: line.text, at: null }))
  ))
}

/**
 * The lines a resumed session opens on.
 *
 * @param {object|null} engineResumed  what the engine handed back, or null when
 *   it could not restore the thread and a fresh agent was seeded instead.
 * @param {Array<object>} savedLines   the node's kept excerpt, which is the
 *   record of what this product actually drew -- speech AND actions.
 * @param {string} marker  the line that tells a person a FRESH agent read the
 *   conversation above. Said only on the seeded path, because only there is it
 *   true.
 */
export function resumedTranscriptLines({ engineResumed = null, savedLines = [], marker = '', now = Date.now() } = {}) {
  const kept = Array.isArray(savedLines) ? savedLines : []
  /* THE EXCERPT FIRST, AND THE ORDER IS THE WHOLE FIX. This branch used to sit
     BELOW the engine one, so a real resume over a kept conversation always took
     the poorer projection -- and then persisted it. */
  if (kept.length > 0) {
    return engineResumed ? kept.slice() : [...kept, { who: 'you', text: marker, at: now }]
  }
  /* Nothing kept: the engine's turns are the only history there is, and a
     thread it still holds is worth restoring speech-only rather than opening
     a conversation that plainly happened as an empty one. */
  const spoken = engineSpokenLines(engineResumed)
  if (spoken.length > 0) return spoken
  /* A plain start, with no engine thread and nothing saved. This conversation
     begins empty, which is a DECISION and is recorded as one: transcriptAppend
     seeds an unheld session from the durable record, so a caller that left the
     session absent here would have re-seeded it from a record this start
     already chose not to use. */
  return []
}
