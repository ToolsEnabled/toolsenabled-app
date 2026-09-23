'use strict'

/* AN ENGINE WHOSE TURN PROMISE OUTLIVES ITS ANNOUNCEMENT, the Claude CLI shape.
 *
 * The vendored Claude CLI adapter (capability/src/lib/agent-engine/
 * claude-cli-adapter.js) resolves sendTurn() only when the turn is OVER, and
 * its close() rejects a turn still running with CLAUDE_CLI_CLOSED, "This Claude
 * session was closed while a turn was running." The host announces the turn on
 * its first event, so by the time a person presses Stop the send has already
 * been answered and the adapter's later rejection reaches only the host's
 * post-announcement handler -- the one that turns a rejection into a
 * `turn_completed` with status `failed`.
 *
 * This fixture reproduces exactly that shape with no process behind it:
 *
 *   sendTurn('work')   announces with one delta, then stays open until close()
 *                      rejects it the way the Claude adapter does
 *   sendTurn('die')    announces, then rejects ON ITS OWN a moment later -- a
 *                      turn that really failed, which the host must still
 *                      report as one
 *
 * No transport handle is exposed on purpose: observeEngineExit() returns null
 * for it, so nothing here is about a child exiting. It is about a promise.
 */

let turnCount = 0

async function startCodexSession(options) {
  const onEvent = options && typeof options.onEvent === 'function' ? options.onEvent : null
  const timers = new Set()
  const open = new Map()
  let closed = false

  const later = (ms, run) => {
    const timer = setTimeout(() => { timers.delete(timer); run() }, ms)
    timers.add(timer)
  }

  return {
    adapter: {
      sendTurn: ({ text }) => new Promise((resolve, reject) => {
        turnCount += 1
        const turnId = `turn-closing-${turnCount}`
        open.set(turnId, { resolve, reject })
        later(30, () => {
          if (closed || !onEvent) return
          onEvent({ type: 'assistant_text_delta', turnId, text: 'Working on it' })
        })
        if (String(text).includes('die')) {
          later(120, () => {
            if (!open.has(turnId)) return
            open.delete(turnId)
            const error = new Error('The program stopped answering this turn.')
            error.code = 'FIXTURE_TURN_DIED'
            reject(error)
          })
        }
      }),
      interrupt: async () => {},
      answerApproval: () => {},
      forkThread: async () => ({ threadId: 'thread-closing-forked' }),
    },
    threadId: 'thread-closing-1',
    close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const [turnId, turn] of open) {
        open.delete(turnId)
        const error = new Error('This Claude session was closed while a turn was running.')
        error.code = 'CLAUDE_CLI_CLOSED'
        turn.reject(error)
      }
    },
  }
}

module.exports = { startCodexSession }
