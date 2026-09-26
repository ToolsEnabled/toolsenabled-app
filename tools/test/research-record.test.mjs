// The recording policy: which fields of a draw's envelope are kept.
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyRecordPolicy, emptyRecordPolicy, normalizeRecordPolicy, recordProblems, recordSummary } from '../../src/research-record.mjs'

const envelope = () => ({ output: 'Answer:\n```python\nprint(1)\n```\nDone', identity: { provider: 'anthropic', id: 'claude-sonnet-5-20260101', surface: 'claude-cli' },
  usage: { inputTokens: 10, outputTokens: 5, generationMs: 900, toolCalls: 2, turns: 3 }, harness: { requestedModel: 'claude-sonnet-5', servedModel: 'claude-sonnet-5-20260101', argv: ['claude', '-p'], wallMs: 1200, evidence: { exit: 0 } } })

test('the default keeps everything and only failure evidence', () => {
  assert.deepEqual(normalizeRecordPolicy(undefined), emptyRecordPolicy())
  assert.deepEqual(applyRecordPolicy(emptyRecordPolicy(), envelope()), envelope())
  assert.equal(recordSummary({}), 'The full response text; token counts, timing, provider and served model, tool calls and turns, the command line; failure evidence failures.')
})

test('extracted output keeps the match with the full text\'s length, and unchecked fields are removed', () => {
  const policy = normalizeRecordPolicy({ output: 'extracted', pattern: '```python\\n([\\s\\S]*?)```', flags: 'gxi', tokens: false, provider: false, argv: false, toolCalls: false, time: false, evidence: 'never', keepDraws: true })
  assert.equal(policy.flags, 'i', 'only real flags survive; g never applies to one match')
  const kept = applyRecordPolicy(policy, envelope())
  assert.equal(kept.output, 'print(1)\n')
  assert.deepEqual(kept.harness.extraction, { pattern: policy.pattern, flags: 'i', matched: true, fullChars: 35 })
  assert.deepEqual(kept.usage, {})
  assert.deepEqual(kept.identity, { provider: 'anthropic', id: 'claude-sonnet-5', surface: 'claude-cli' }, 'without provider recording, the requested model stands in')
  assert.deepEqual(Object.keys(kept.harness).sort(), ['extraction', 'requestedModel'])
  const unmatched = applyRecordPolicy({ output: 'extracted', pattern: 'nothing-like-this' }, envelope())
  assert.equal(unmatched.output, ''); assert.equal(unmatched.harness.extraction.matched, false)
  assert.match(recordSummary(policy), /working directories kept/)
})

test('problems name a missing or invalid pattern and warn when the served model is dropped', () => {
  assert.deepEqual(recordProblems({ output: 'extracted' }).map(problem => problem.kind), ['pattern'])
  assert.match(recordProblems({ output: 'extracted', pattern: '(' })[0].text, /not a valid regular expression/)
  assert.deepEqual(recordProblems({ provider: false }).map(problem => problem.kind), ['provider'])
  assert.deepEqual(recordProblems({}), [])
})
