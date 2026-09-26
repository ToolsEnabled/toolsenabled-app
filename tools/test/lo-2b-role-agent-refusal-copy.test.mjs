import test from 'node:test'
import assert from 'node:assert/strict'
import { unavailableReason } from '../../src/agent-availability-copy.js'

const EXPECTED_MEANING = {
  MC_AGENT_ROLE_AGENT_UNKNOWN: [
    /agent is no longer in the organisation/i,
    /not started/i,
    /reload the agent page/i,
  ],
  MC_AGENT_ROLE_AGENT_DISABLED: [
    /agent is disabled in the current organisation/i,
    /not started/i,
    /enable it or choose another agent/i,
  ],
}

test('LO-2b role-agent refusals give actionable role-specific reasons', () => {
  for (const [code, meaning] of Object.entries(EXPECTED_MEANING)) {
    const sentence = unavailableReason(code)
    assert.equal(typeof sentence, 'string', code + ' must produce a sentence')
    assert.ok(sentence.length > 20, code + ' must be actionable')
    assert.doesNotMatch(sentence, /MC_AGENT_ROLE_AGENT_(?:UNKNOWN|DISABLED)/)
    for (const fragment of meaning) assert.match(sentence, fragment, code + ' must explain the refused role-agent start')
  }
})
