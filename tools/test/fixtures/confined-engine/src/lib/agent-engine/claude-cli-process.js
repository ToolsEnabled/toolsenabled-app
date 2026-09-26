'use strict'

// The app-host fixture records Claude starts through the same call ledger as
// its Codex sibling. It starts no provider process and exists only so a host
// behavior test can prove the provider-specific launch request at the engine
// boundary.
const engine = require('./codex-process.js')

module.exports = {
  startClaudeSession: engine.startCodexSession,
  resumeClaudeSession: engine.resumeCodexSession,
  calls: engine.calls,
}
