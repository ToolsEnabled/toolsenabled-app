'use strict'

// Records what the agent host asked the per-prompt recommender for, and -- only
// when asked to -- answers a marker the injection test can find in the outgoing
// turn text. The REAL module's own behaviour (the index, the scoring, the
// agent.capability_recall settings row, the allowlist derivation) is proved by
// the engine suite tests/capability-recall.test.js; this fixture proves the
// HOST's wiring without loading a 650 KB index or every provider.
//
// SILENT BY DEFAULT, WHICH IS ALSO THE REAL MODULE'S COMMON ANSWER. Most turns
// deserve nothing, so `{ text: '' }` is the default here and the suites that
// predate this feature keep asserting on exact turn text with nothing appended.
//
// It holds the prompt in memory because that is the only way a test can prove
// the host passed the person's words to the thing that needs them. Nothing here
// writes them anywhere, and the real module does not keep them at all.
const calls = []

function allowedIdsForTier(tier) {
  calls.push({ kind: 'allowlist', tier })
  if (process.env.MC_TEST_CAPABILITY_RECALL === 'no-allowlist') return null
  return new Set([`${tier}.first_tool`, `${tier}.second_tool`])
}

function recommend(promptText, options = {}) {
  calls.push({ kind: 'recommend', promptText, allowedIds: options.allowedIds })
  if (process.env.MC_TEST_CAPABILITY_RECALL !== 'on') {
    return { text: '', tools: [], outcome: 'silent', code: null, estimatedTokens: 0 }
  }
  return {
    text: `FIXTURE CAPABILITY BLOCK (${promptText})`,
    tools: [{ id: 'screen.capture' }],
    outcome: 'hit',
    code: null,
    estimatedTokens: 9,
  }
}

module.exports = {
  CAPABILITY_RECALL_SETTING_ID: 'agent.capability_recall',
  allowedIdsForTier,
  recommend,
  calls,
}
