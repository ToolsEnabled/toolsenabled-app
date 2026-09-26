'use strict'

// Records exactly what the agent host handed the engine, so a test can assert
// the RECORDED LEVEL reached the spawn rather than assert that some source file
// mentions it. Starts no process.
const calls = []

async function startCodexSession(options) {
  calls.push(options)
  return {
    adapter: { sendTurn: async () => ({ turnId: 't1' }), interrupt: async () => {} },
    threadId: 'thread-1',
    close() {},
  }
}

module.exports = { startCodexSession, calls }
