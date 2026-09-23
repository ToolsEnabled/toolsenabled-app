'use strict'

/* AN ENGINE THAT FAILS A TURN THE WAY AN ACCOUNT USAGE LIMIT ACTUALLY FAILS IT.
 *
 * T17. The observed failure is not a structured quota error. The provider ends
 * the turn with PROSE and NO CODE -- the sentence the person reads on screen is
 *
 *   "You've hit your session limit · resets 1:30am (America/Los_Angeles)"
 *
 * and nothing carries a machine-readable `code`. That shape matters, because
 * every classifier downstream of it reads `code` and only the shell's
 * limitReason() also reads the words. A fixture that helpfully attaches
 * `code: 'usage_limit_reached'` would exercise a path the real failure never
 * takes and would go green while the defect stood.
 *
 * NO REAL LIMIT IS INDUCED AND NO CREDENTIAL IS INVOLVED. There is no process
 * behind this engine and no provider is contacted; the sentence is a literal.
 *
 * Three turn shapes, selected by the text of the turn:
 *
 *   'limit'   announce with one delta, then reject with the limit prose and no
 *             code -- the single-turn shape
 *   'hold'    announce, then stay open until release() is called, so a second
 *             turn's completion can arrive while this send promise is still
 *             outstanding (the session.activeTurnId / completedDuringSend race)
 *   anything  announce, then resolve normally
 */

let turnCount = 0

const LIMIT_SENTENCE = "You've hit your session limit · resets 1:30am (America/Los_Angeles)"

async function startCodexSession(options) {
  const onEvent = options && typeof options.onEvent === 'function' ? options.onEvent : null
  const timers = new Set()
  const open = new Map()
  let closed = false

  const later = (ms, run) => {
    const timer = setTimeout(() => { timers.delete(timer); run() }, ms)
    timers.add(timer)
  }

  const adapter = {
    sendTurn: ({ text }) => new Promise((resolve, reject) => {
      turnCount += 1
      const turnId = `turn-limiting-${turnCount}`
      const body = String(text == null ? '' : text)
      open.set(turnId, { resolve, reject, body })
      later(30, () => {
        if (closed || !onEvent) return
        onEvent({ type: 'assistant_text_delta', turnId, text: 'Working on it' })
      })
      if (body.includes('limit')) {
        later(120, () => {
          if (!open.has(turnId)) return
          open.delete(turnId)
          /* PROSE ONLY. No `code` is set on purpose -- that is the defect's
             precondition, not an oversight in the fixture. */
          reject(new Error(LIMIT_SENTENCE))
        })
      } else if (!body.includes('hold')) {
        later(120, () => {
          if (!open.has(turnId)) return
          open.delete(turnId)
          resolve({ turnId })
        })
      }
    }),
    interrupt: async () => {},
    answerApproval: () => {},
    forkThread: async () => ({ threadId: 'thread-limiting-forked' }),
  }

  return {
    adapter,
    threadId: 'thread-limiting-1',
    /* Test-only control so a suite can decide WHEN a held turn ends, and with
       which outcome, without racing a timer. */
    releaseHeldTurn(outcome) {
      for (const [turnId, turn] of [...open]) {
        if (!turn.body.includes('hold')) continue
        open.delete(turnId)
        if (outcome === 'limit') turn.reject(new Error(LIMIT_SENTENCE))
        else turn.resolve({ turnId })
      }
    },
    emit(event) { if (!closed && onEvent) onEvent(event) },
    close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const [turnId, turn] of open) {
        open.delete(turnId)
        const error = new Error('This session was closed while a turn was running.')
        error.code = 'CLAUDE_CLI_CLOSED'
        turn.reject(error)
      }
    },
  }
}

module.exports = { startCodexSession, LIMIT_SENTENCE }
