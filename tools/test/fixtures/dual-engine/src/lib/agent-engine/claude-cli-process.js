'use strict'

// Records exactly what the agent host handed the CLAUDE engine, the same way
// the codex fixture beside it does, so a routing test can assert WHICH engine
// a start reached rather than assert that a source file mentions a provider.
const calls = []
const resumeCalls = []
const adapterCalls = []
const { rootLifecycle } = require('../../../root-lifecycle.cjs')

function sessionHandle(threadId, lifecycle) {
  return {
    adapter: {
      sendTurn: async request => { adapterCalls.push({ method: 'sendTurn', request }); return { turnId: 't1' } },
      interrupt: async request => { adapterCalls.push({ method: 'interrupt', request }) },
    },
    threadId,
    close() { lifecycle.close() },
  }
}

async function startClaudeSession(options) {
  calls.push(options)
  return sessionHandle('claude-thread-1', await rootLifecycle(options.rootLaunch))
}

async function resumeClaudeSession(options) {
  resumeCalls.push(options)
  return sessionHandle(options.threadId, await rootLifecycle(options.rootLaunch))
}

module.exports = { ROOT_ADMISSION_CONTRACT_VERSION: 1, startClaudeSession, resumeClaudeSession, calls, resumeCalls, adapterCalls }
