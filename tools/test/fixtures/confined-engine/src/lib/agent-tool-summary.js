'use strict'

// Records what the agent host asked the tool-summary module for, and answers a
// marker the injection test can find in the outgoing turn text. The REAL
// module's own behaviour (derivation, budget, the settings row) is proved by
// the engine suite tests/agent-tool-summary.test.js; this fixture proves the
// HOST's wiring on both sides of the switch without loading every provider.
const calls = []

function briefToolSummary(request) {
  calls.push(request)
  if (process.env.MC_TEST_TOOL_SUMMARY === 'off') {
    return { enabled: false, text: null, code: 'TOOL_SUMMARY_DISABLED', estimatedTokens: 0 }
  }
  return {
    enabled: true,
    tier: request && request.tier,
    text: `FIXTURE TOOL SUMMARY (${request && request.tier})`,
    estimatedTokens: 8,
  }
}

module.exports = { TOOL_SUMMARY_SETTING_ID: 'agent.tool_summary', briefToolSummary, calls }
