/* A CROSS-PROVIDER RESUME MUST REFUSE BY NAME, NOT DEGRADE IN SILENCE.
 *
 * Ledger R51: refuse by provider name, NOT a forced fresh start. The engine and
 * the shell already do exactly that — `RESUME_PROVIDER_MISMATCH` and
 * `AGENT_RESUME_PROVIDER_MISMATCH`, each naming both providers before anything
 * spawns. The renderer did the opposite: `resumableThread()` returned
 * `threadId: null` on a provider change and `src/views/computers.js` read only
 * `.threadId`, never `.reason`. A null thread id falls through to the excerpt
 * path, so the person's agent quietly started a NEW conversation and the
 * continuity was gone with nothing said.
 *
 * That left the release contradicting itself: rc1 ships shell- and engine-side
 * refusals that name the provider, over a renderer that performs the silent fresh
 * start the ledger forbids.
 *
 * THE BAR, set by the Controller: the refusal names BOTH providers — the one that
 * owns the conversation and the one being asked to continue it. "This cannot be
 * resumed" sends a person to check everything; naming both tells them what
 * happened and what to change.
 *
 * THE WORDING IS NOT NEW. It is the sentence the shell gate already ships
 * (shell/agent-host.cjs, resumeProviderRefusal). One wording across three layers,
 * so a person who meets this twice does not read two different explanations of
 * one rule. No customer-facing copy is invented here.
 *
 *   node --test tools/test/tree-resume-decision-names-both.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resumableThread } from '../../src/tree-resume-decision.js'

test('a provider change is refused with a sentence naming BOTH providers', () => {
  const decision = resumableThread({ savedThreadId: 't-1', savedProvider: 'codex', provider: 'claude' })

  assert.equal(decision.threadId, null, 'the thread must still not be handed to the wrong program')
  assert.equal(decision.reason, 'provider-changed')
  assert.equal(typeof decision.message, 'string', 'a refusal the caller cannot show is not a refusal')
  assert.match(decision.message, /Codex/, 'the sentence must name the provider that OWNS the conversation')
  assert.match(decision.message, /Claude/, 'the sentence must name the provider being asked to continue it')
})

test('the other direction names both too, in the right roles', () => {
  const decision = resumableThread({ savedThreadId: 't-1', savedProvider: 'claude', provider: 'codex' })

  assert.match(decision.message, /belongs to Claude/,
    'the OWNER of the conversation is the saved provider, not the current tier')
  assert.match(decision.message, /Codex/, 'and the current tier is named as the one that cannot continue it')
})

test('the sentence matches the one the shell already ships, so a person meets one wording', () => {
  /* Asserted as a property rather than a pinned string: it must name both, say it
     cannot be continued, and offer the next step. A better sentence that does all
     three still passes; a sentence that drops one of them does not. */
  const decision = resumableThread({ savedThreadId: 't-1', savedProvider: 'codex', provider: 'claude' })

  assert.match(decision.message, /cannot be continued|cannot be resumed/i, 'it must say what did not happen')
  assert.match(decision.message, /new conversation/i, 'it must offer the next step a person can take')
})

test('a same-provider resume carries no refusal and no message', () => {
  const decision = resumableThread({ savedThreadId: 't-1', savedProvider: 'codex', provider: 'codex' })
  assert.equal(decision.threadId, 't-1')
  assert.equal(decision.reason, null)
  assert.equal(decision.message, undefined, 'a permitted resume must not carry a refusal sentence')
})

test('a record from before the provider field is still honoured, and still says nothing', () => {
  /* The compatibility case. Refusing every pre-1.0.42 record would turn one
     measured defect into a regression for everyone who never changed a tier —
     the same legacy-permitted rule the engine and shell gates follow. */
  for (const decision of [
    resumableThread({ savedThreadId: 't-1', savedProvider: null, provider: 'claude' }),
    resumableThread({ savedThreadId: 't-1', savedProvider: 'codex', provider: null }),
  ]) {
    assert.equal(decision.threadId, 't-1', 'an absent provider is permitted, exactly as before')
    assert.equal(decision.reason, null)
    assert.equal(decision.message, undefined)
  }
})

test('no saved thread is still no resume, and not a provider complaint', () => {
  const decision = resumableThread({ savedThreadId: '', savedProvider: 'codex', provider: 'claude' })
  assert.equal(decision.reason, 'no-thread',
    'a node that never had a thread has no provider quarrel to report')
  assert.equal(decision.message, undefined)
})

test('an unrecognised provider name is still named, not swallowed', () => {
  /* The store bounds these to a known set, but a record written by a newer build
     can carry something this one does not know. Naming it verbatim is better than
     "another program": the person can at least recognise it. */
  const decision = resumableThread({ savedThreadId: 't-1', savedProvider: 'some-future-engine', provider: 'claude' })
  assert.equal(decision.reason, 'provider-changed')
  assert.match(decision.message, /some-future-engine/)
  assert.match(decision.message, /Claude/)
})
