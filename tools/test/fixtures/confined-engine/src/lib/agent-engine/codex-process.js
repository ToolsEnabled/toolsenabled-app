'use strict'

// Records exactly what the agent host handed the engine, so a test can assert
// the RECORDED LEVEL reached the spawn rather than assert that some source file
// mentions it. Starts no process.
const calls = []
const adapterCalls = []

/* A TURN THE ENGINE IS SLOW TO ACCEPT, ON DEMAND. The host's sendTurn()
   settles on whichever comes first, the adapter's acknowledgement or the
   turn's first event; a Claude turn that is still thinking has produced
   neither, so the host's hand-off stays pending for as long as that takes.
   With `control.holdTurns` set, sendTurn() records the request and parks it
   on `pendingTurns` until the test resolves it, which is that shape exactly. */
const control = { holdTurns: false }
const pendingTurns = []

function adapter() {
  return {
    sendTurn: async request => {
      adapterCalls.push({ method: 'sendTurn', request })
      if (!control.holdTurns) return { turnId: 't1' }
      return new Promise((resolve, reject) => { pendingTurns.push({ request, resolve, reject }) })
    },
    steerTurn: async request => { adapterCalls.push({ method: 'steerTurn', request }); return { threadId: request.threadId, turnId: request.turnId } },
    interrupt: async request => { adapterCalls.push({ method: 'interrupt', request }) },
    answerApproval: answer => { adapterCalls.push({ method: 'answerApproval', answer }) },
    forkThread: async (threadId, forkOptions) => {
      adapterCalls.push({ method: 'forkThread', threadId, forkOptions })
      return { threadId: 'thread-forked' }
    },
  }
}

async function startCodexSession(options) {
  calls.push(options)
  return {
    adapter: adapter(),
    threadId: 'thread-1',
    close() {},
  }
}

// A resume records like a start and hands back the thread it was asked for,
// so a test can prove what the host injects on a RESUMED session's first turn.
async function resumeCodexSession(options) {
  calls.push({ resumed: true, ...options })
  return {
    adapter: adapter(),
    /* WHAT THE ENGINE SAYS IT RESTORED, which the host's own start path treats
       as the only honest source. Normally the thread that was asked for; the
       override lets a test stand where the engine answers with a different id,
       the same device as MC_TEST_RESUMED_THREAD_CWD below. */
    threadId: process.env.MC_TEST_RESUMED_THREAD_ID
      || (options && options.threadId ? options.threadId : 'thread-resumed'),
    resumed: { turns: [], turnCount: 0 },
    threadCwd: process.env.MC_TEST_RESUMED_THREAD_CWD || null,
    close() {},
  }
}

module.exports = { startCodexSession, resumeCodexSession, calls, adapterCalls, control, pendingTurns }
