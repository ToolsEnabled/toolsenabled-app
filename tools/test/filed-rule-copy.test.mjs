/* USER-VISIBLE COPY FOR A RULE FILED BY AN AGENT.
 *
 * These are direct tests of src/filed-rule-copy.js. The real callers in the
 * two chat views pass the filing result, optionally pair it with the words
 * from the tool call, and supply the event time. Keep the checks about what a
 * person can learn from the row rather than pinning the sentence byte for
 * byte, so harmless copy and markup improvements remain possible. */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FILED_RULE_TOOL_LABEL,
  FILED_RULE_WORDS_MAX,
  filedRuleChatRow,
  filedRuleSentence,
  filedRuleState,
} from '../../src/filed-rule-copy.js'

test('the sentence identifies the filed rule, its reach, its author, and the person\'s next action', () => {
  const sentence = filedRuleSentence({
    id: 'RTH3',
    appliesTo: 'this agent, this conversation only',
    filedBy: 'codex',
    words: '  Keep   generated files out of commits.  ',
  })

  assert.match(sentence, /RTH3/, 'the filing sentence must identify the rule')
  assert.match(sentence, /this agent, this conversation only/, 'the filing sentence must state the supplied reach')
  assert.match(sentence, /filed by codex/i, 'the filing sentence must attribute the agent')
  assert.match(sentence, /edit or delete it by hand/i, 'the filing sentence must explain how the person can change the rule')
  assert.match(sentence, /Keep generated files out of commits\./, 'the filing sentence must preserve a recognisable, whitespace-normalised excerpt')
})

test('a long remark is recognisable without putting the whole rule on the chat row', () => {
  const words = `Remember ${'carefully '.repeat(20)}before changing the release.`
  const sentence = filedRuleSentence({ id: 'R2010', scope: 'global', words })

  assert.ok(sentence.includes(words.slice(0, 24)), 'the shortened remark must retain its beginning so the person can recognise it')
  assert.ok(!sentence.includes(words), 'the chat row must not reproduce a long rule in full')
  assert.match(sentence, /…/, 'the shortened remark must signal that words were omitted')
  assert.ok(FILED_RULE_WORDS_MAX > 0 && FILED_RULE_WORDS_MAX < words.length, 'the exported excerpt limit must be a useful finite prefix')
})

test('missing optional call details do not invent an author, quotation, or definite reach', () => {
  const sentence = filedRuleSentence({ id: 'RS9' })

  assert.match(sentence, /RS9/, 'a partially read filing must still identify the known rule')
  assert.doesNotMatch(sentence, /filed by/i, 'a filing with no readable author must not invent one')
  assert.doesNotMatch(sentence, /[“”]/, 'a filing with no readable words must not invent a quotation')
  assert.match(sentence, /your agents/i, 'an unread reach must remain generic rather than become a definite scope')
  assert.equal(filedRuleState({}), 'filed', 'an unread author must produce the unattributed state')
})

test('the chat row carries one consistent sentence, stable identity, caller time, and immutable data', () => {
  const filed = { id: 'RTR8', toolCallId: 'call-17', scope: 'tree', filedBy: 'claude', words: 'Prefer the local fixture.' }
  const row = filedRuleChatRow(filed, { at: 1_725_000_000_000 })

  assert.equal(row.tool, FILED_RULE_TOOL_LABEL, 'the row must use the exported standing-rule label')
  assert.match(row.id, /RTR8.*call-17/, 'the row identity must distinguish the rule and originating call')
  assert.equal(row.state, filedRuleState(filed), 'the row state must describe the same filing')
  assert.equal(row.detail, row.body, 'collapsed and opened rows must communicate the same filing')
  assert.equal(row.at, 1_725_000_000_000, 'the row must preserve the event time supplied by its caller')
  assert.ok(Object.isFrozen(row), 'the action row must be immutable after composition')
})
