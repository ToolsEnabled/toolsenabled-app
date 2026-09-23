import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactProofCounts, planFor } from '../packaged-qa-suite.mjs'

test('source overlays, synthetic installers and substituted engines have instrumented proof scopes', () => {
  const names = [
    'agent-start-flow-qa.mjs', 'refusal-copy-qa.mjs', 'nsis-upgrade-roundtrip-qa.mjs',
    'agent-dispatch-packaged-qa.mjs', 'chat-history-drive.mjs', 'context-window-drive.mjs',
    'node-remove-drive.mjs', 'rail-lifecycle-drive.mjs', 'session-end-record-drive.mjs',
    'tree-panel-audit-drive.mjs', 'compose-start-layout-qa.cjs',
    'send-actually-sends-qa.mjs', 'metrics-usage-live-qa.mjs',
  ]
  const plan = planFor(names)
  assert.equal(plan.length, names.length)
  for (const entry of plan) assert.equal(entry.artifactProof, 'instrumented-copy', entry.name)
  assert.deepEqual(artifactProofCounts(plan.map(entry => ({ ...entry, verdict: 'PASS' }))),
    { exact: 0, instrumented: names.length, unclassified: 0 })
})

test('unreviewed proof scopes do not become exact by default or by driver registration', () => {
  const entries = planFor(['invented-unreviewed-proof-qa.mjs', 'appearance-persistence-drive.mjs'])
  assert.equal(entries[0].registered, false)
  assert.equal(entries[1].registered, true)
  for (const entry of entries) assert.equal(entry.artifactProof, 'unclassified', entry.name)
})

test('proof summaries count only passing explicit exact scopes and retain unknown scope debt', () => {
  assert.deepEqual(artifactProofCounts([
    { verdict: 'PASS', artifactProof: 'exact-candidate' },
    { verdict: 'PASS', artifactProof: 'instrumented-copy' },
    { verdict: 'PASS', artifactProof: 'unclassified' },
    { verdict: 'PASS' },
    { verdict: 'PASS', artifactProof: 'invented-proof' },
    { verdict: 'FAIL', artifactProof: 'exact-candidate' },
    { verdict: 'SKIP', artifactProof: 'exact-candidate' },
  ]), { exact: 1, instrumented: 1, unclassified: 3 })
  assert.deepEqual(artifactProofCounts([]), { exact: 0, instrumented: 0, unclassified: 0 })
})

test('an explicitly reviewed exact-artifact driver keeps its narrower proof scope', () => {
  const [entry] = planFor(['account-cart-row-qa.mjs'])
  assert.equal(entry.artifactProof, 'exact-candidate')
  assert.deepEqual(artifactProofCounts([{ ...entry, verdict: 'PASS' }]),
    { exact: 1, instrumented: 0, unclassified: 0 })
})
