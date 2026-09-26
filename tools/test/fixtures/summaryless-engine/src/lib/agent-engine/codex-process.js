'use strict'

// A payload cut BEFORE src/lib/agent-tool-summary.js existed: it starts
// sessions and records what the adapter is handed, and its engine root
// deliberately carries no tool-summary module. The injection suite uses it to
// prove absence injects nothing and refuses nothing.
const calls = []
const adapterCalls = []

async function startCodexSession(options) {
  calls.push(options)
  return {
    adapter: {
      sendTurn: async request => { adapterCalls.push({ method: 'sendTurn', request }); return { turnId: 't1' } },
      interrupt: async request => { adapterCalls.push({ method: 'interrupt', request }) },
    },
    threadId: 'thread-1',
    close() {},
  }
}

module.exports = { startCodexSession, calls, adapterCalls }
