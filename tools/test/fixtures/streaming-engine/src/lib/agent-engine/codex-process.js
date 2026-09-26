'use strict'

/* AN ENGINE THAT REPORTS A TURN BY STREAMING IT, which is the shape the second
 * engine really has and the shape nothing above the host was written for.
 *
 * The confined-engine fixture beside this one models the codex adapter:
 * sendTurn() answers `turn/start` immediately with a turn id, and the turn's
 * events arrive afterwards. Everything above shell/agent-host.cjs was written
 * against that, because for one engine it was the only shape there was.
 *
 * MEASURED 2026-08-17, one host, both engines, the same question:
 *
 *   codex  luna           sendTurn() resolved at +3ms, first delta at +33.8s
 *   claude claude-sonnet  sendTurn() resolved at +3884ms, first delta at +3867ms
 *
 * The Claude CLI has no acknowledgement to answer with. Its adapter resolves
 * the turn from the `result` packet, so its promise settles only when the turn
 * is OVER -- after the whole answer has already been emitted. A caller waiting
 * on that promise to learn the turn started waits for the entire turn.
 *
 * This fixture holds the adapter's promise open under the test's control and
 * emits the turn's events through the host's own onEvent, so the host's
 * behaviour can be measured against an engine of that shape WITHOUT a network,
 * a subscription or a child process. It starts nothing.
 */

const control = {
  onEvent: null,
  resolveTurn: null,
  rejectTurn: null,
  duringSend: null,
  sends: 0,
  requests: [],
}

function reset() {
  control.onEvent = null
  control.resolveTurn = null
  control.rejectTurn = null
  control.duringSend = null
  control.sends = 0
  control.requests = []
}

async function startCodexSession(options) {
  control.onEvent = options && typeof options.onEvent === 'function' ? options.onEvent : null
  return {
    adapter: {
      /* Held open deliberately. The test decides when -- and whether -- this
         engine ever answers for the turn, which is the whole variable. */
      sendTurn: request => {
        control.sends += 1
        control.requests.push(request)
        return new Promise((resolve, reject) => {
          control.resolveTurn = resolve
          control.rejectTurn = reject
          if (typeof control.duringSend === 'function') control.duringSend()
        })
      },
      interrupt: async () => {},
      answerApproval: () => {},
      forkThread: async () => ({ threadId: 'thread-forked' }),
    },
    threadId: 'thread-1',
    close() {},
  }
}

/* The engine narrating its own turn, exactly as the Claude adapter does: the
   events carry the turn id, and they arrive before the engine has answered for
   the turn at all. */
function narrate(event) {
  if (!control.onEvent) throw new Error('no session has been started on this fixture engine')
  control.onEvent(event)
}

module.exports = { startCodexSession, control, narrate, reset }
