import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyFiledScope } from '../lib/page2-native-scenarios.cjs'

test('native scoped-command credit requires the exact retained family, scope, key and words', () => {
  const expected = { id: 'T3', kind: 'T', scope: 'session', scopeKey: 'session-current', words: 'Owned QA task' }
  const ledger = { ok: true, chain: { ok: true }, records: [{ ...expected }] }
  assert.deepEqual(verifyFiledScope(ledger, expected), { id: 'T3', kind: 'T', scope: 'session', scopeKey: 'session-current' })
  for (const [key, value] of Object.entries({ kind: 'R', scope: 'tree', scopeKey: 'session-stale', words: 'Different task' })) {
    assert.throws(() => verifyFiledScope({ ...ledger, records: [{ ...expected, [key]: value }] }, expected))
  }
  assert.throws(() => verifyFiledScope({ ...ledger, records: [{ ...expected }, { ...expected }] }, expected), /exactly one/)
  assert.throws(() => verifyFiledScope({ ...ledger, chain: { ok: false } }, expected), /history must verify/)
})
