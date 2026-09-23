/* Transcript appends for a live agent session.
 *
 * Split out for the same reason agent-session-events.js is: this is the part
 * worth testing directly, and a test should not have to build a whole fake
 * form, textarea and write-surface to reach it. It touches four DOM
 * operations, all injectable, so a test can drive it with a few lines of stub.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * The engine emits one `assistant_text_delta` per token
 * (capability/src/lib/agent-engine/codex-adapter.js), so a single long turn
 * produces tens of thousands of appends. The original implementation was
 * `node.textContent += text` once per delta, which re-reads and rewrites the
 * entire transcript every time -- quadratic in the transcript's length.
 *
 * MEASURED in the real renderer, appending identical content one delta at a
 * time:
 *
 *      2,000 deltas     14.8 ms
 *      5,000 deltas     88.4 ms
 *     10,000 deltas    334.8 ms
 *     20,000 deltas   1051.0 ms
 *
 * Doubling the work roughly quadrupled the cost. None of it was rendering; it
 * was string copying, on the main thread, and it grew worse the longer a
 * session ran and multiplied by the number of live sessions.
 *
 * WHAT THIS DOES INSTEAD -- and it drops nothing. Every character still
 * arrives, in order, and the transcript is still uncapped:
 *
 * 1. BATCH PER FRAME. Deltas accumulate and are written once per animation
 *    frame. Writing more often than the screen refreshes cannot be seen. A
 *    backgrounded window does no transcript work at all and flushes what it
 *    buffered when it returns -- buffered, never dropped.
 * 2. BOUNDED-CHUNK APPEND. Text goes into a trailing text node until that node
 *    reaches `chunkMax`, then a new one starts. One forever-growing node would
 *    reintroduce the quadratic copy; one node per flush would leave tens of
 *    thousands of nodes for layout. Capping the chunk bounds each copy at
 *    `chunkMax` and keeps the node count at total/chunkMax.
 */

export const DEFAULT_CHUNK_MAX = 8192

export function createTranscriptAppender({
  node,
  createTextNode,
  scheduleFrame,
  cancelFrame,
  chunkMax = DEFAULT_CHUNK_MAX,
} = {}) {
  if (!node) throw new TypeError('createTranscriptAppender requires a node')
  if (typeof createTextNode !== 'function') throw new TypeError('createTranscriptAppender requires createTextNode')
  if (typeof scheduleFrame !== 'function') throw new TypeError('createTranscriptAppender requires scheduleFrame')
  if (typeof cancelFrame !== 'function') throw new TypeError('createTranscriptAppender requires cancelFrame')
  if (!Number.isInteger(chunkMax) || chunkMax <= 0) throw new TypeError('chunkMax must be a positive integer')

  let pending = []
  let frame = 0
  let tail = null
  let disposed = false

  function flush() {
    frame = 0
    if (disposed || pending.length === 0) return
    const chunk = pending.join('')
    pending = []
    /* `tail.length + chunk.length <= chunkMax` and not `<` : a chunk that
       exactly fills the cap still belongs in the current node, and starting a
       new one for it would leave a node one character short forever. */
    if (tail && tail.length + chunk.length <= chunkMax) {
      tail.appendData(chunk)
    } else {
      tail = createTextNode(chunk)
      node.appendChild(tail)
    }
    node.hidden = false
  }

  return {
    /* Buffer one delta. Cheap by construction: an array push and, at most, one
       frame request. No DOM is touched here. */
    push(text) {
      if (disposed || typeof text !== 'string' || text.length === 0) return
      pending.push(text)
      if (!frame) frame = scheduleFrame(flush)
    },
    /* Write everything buffered right now. Used when a turn completes, so the
       status never flips beside a transcript missing that turn's last output. */
    flushNow() {
      if (frame) { cancelFrame(frame); frame = 0 }
      flush()
    },
    /* A new session starts an empty transcript. Any frame already scheduled
       would otherwise write the previous session's tail into it. */
    reset() {
      if (frame) { cancelFrame(frame); frame = 0 }
      pending = []
      tail = null
      node.textContent = ''
      node.hidden = true
    },
    /* A scheduled frame outlives the element it would write into. */
    dispose() {
      disposed = true
      if (frame) { cancelFrame(frame); frame = 0 }
      pending = []
      tail = null
    },
    get pendingCount() { return pending.length },
    get frameScheduled() { return frame !== 0 },
  }
}
