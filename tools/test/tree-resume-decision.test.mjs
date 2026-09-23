import assert from 'node:assert/strict'
import test from 'node:test'
import { resumableThread } from '../../src/tree-resume-decision.js'

test('a thread from the same provider is resumed', () => {
  assert.deepEqual(resumableThread({ savedThreadId: 't-1', savedProvider: 'codex', provider: 'codex' }), { threadId: 't-1', reason: null })
})

test('a Codex thread is not handed to a Claude tier, and says why', () => {
  /* Measured 2026-09-02: `claude --resume <codex id>` exits in ~3 s with
     "No conversation found with session ID" and the node shows "did not start".
     UPDATED 2026-09-07 for ledger R51: the decision now also carries the sentence
     that refuses BY NAME, so the renderer can stop degrading in silence. The two
     deepEqual assertions this replaces pinned the whole object and could not
     survive a new field. Every fact they checked is still checked below, plus the
     exact key set — so this is stricter than what it replaces, not looser: an
     unexpected field would now fail here as it did before, AND the sentence has
     to name both providers. */
  for (const [savedProvider, provider, owner, seat] of [
    ['codex', 'claude', 'Codex', 'Claude'],
    ['claude', 'codex', 'Claude', 'Codex'],
  ]) {
    const decision = resumableThread({ savedThreadId: 't-1', savedProvider, provider })
    assert.equal(decision.threadId, null)
    assert.equal(decision.reason, 'provider-changed')
    assert.equal(decision.savedProvider, savedProvider)
    assert.equal(decision.provider, provider)
    assert.deepEqual(Object.keys(decision).sort(),
      ['message', 'provider', 'reason', 'savedProvider', 'threadId'],
      'the decision must carry exactly these fields and no surprises')
    assert.match(decision.message, new RegExp(`belongs to ${owner}`))
    assert.match(decision.message, new RegExp(seat))
  }
})

test('a record that predates the provider field is honoured as before', () => {
  assert.deepEqual(resumableThread({ savedThreadId: 't-1', savedProvider: null, provider: 'claude' }), { threadId: 't-1', reason: null })
  assert.deepEqual(resumableThread({ savedThreadId: 't-1', savedProvider: 'codex', provider: null }), { threadId: 't-1', reason: null })
})

test('no saved thread is no resume', () => {
  assert.deepEqual(resumableThread({ savedThreadId: '', savedProvider: 'codex', provider: 'codex' }), { threadId: null, reason: 'no-thread' })
  assert.deepEqual(resumableThread({}), { threadId: null, reason: 'no-thread' })
})


test('Grok tree continuation uses its saved transcript without reopening the failing native thread', () => {
  for (const savedProvider of ['grok', null]) {
    assert.deepEqual(resumableThread({ savedThreadId: 'saved-grok', savedProvider, provider: 'grok' }),
      { threadId: null, reason: 'transcript-resume' })
  }
  assert.equal(resumableThread({ savedThreadId: 'foreign-thread', savedProvider: 'codex', provider: 'grok' }).reason, 'provider-changed')
})

test('other provider families retain their existing native continuation', () => {
  for (const provider of ['codex', 'claude', 'gemini', 'local']) {
    assert.deepEqual(resumableThread({ savedThreadId: 'owned-thread', savedProvider: provider, provider }),
      { threadId: 'owned-thread', reason: null })
  }
})
