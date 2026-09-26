/* THE WORDS AT THE MOMENT OF CHOOSING FULL ACCESS, held against the product's
 * encoded Terms contract. Every load-bearing phrase has to be present verbatim,
 * and every sentence has to pass the same plain-language limit as the rest of
 * the product.
 *
 * The rest of the suite exercises the gate for real -- ask, confirm, decline,
 * ask again -- and the sentence the Settings row prints about the record, with
 * particular care for the state that must never be rounded up: a machine at
 * the widest level with no confirmation on record.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  UNRESTRICTED_CONFIRM_LABEL,
  UNRESTRICTED_DECLINE_LABEL,
  UNRESTRICTED_RISK_LEAD,
  UNRESTRICTED_RISK_QUESTION,
  UNRESTRICTED_RISK_STATEMENTS,
  UNRESTRICTED_RISK_TEXT,
  UNRESTRICTED_TIER,
  createRiskGate,
  describeConsentRecord,
  requiresRiskConsent,
  riskConsent,
  unrestrictedRiskMarkup,
} from '../../src/unrestricted-consent.js'
import { DEFAULT_TIER, TIER_CHOICES, TIER_IDS } from '../../src/setup-state.js'
import { sentencesOf, wordsOf } from '../lib/user-visible-strings.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* THE PHRASES §2 IS MADE OF. Each is quoted from the Terms, and each names one
   of the four things the ruling says the words must name: what the agent can
   do, that the person is accepting the risk knowingly, that a mistake is not
   contained or reversible, and that a safer confined default exists. */
const TERMS_PHRASES = Object.freeze([
  'read, change, and delete any file on your computer',
  'run any program on it',
  'without asking you first',
  'you are knowingly accepting that risk',
  'not limited to any one folder',
  'not automatically reversible',
  'recommended default',
  'confine an agent to a folder you pick',
  'enforced by the operating system rather than by an on-screen promise',
])

test('the widest level is the one the gate is for, and it is not the default', () => {
  assert.equal(UNRESTRICTED_TIER, 'unrestricted')
  assert.ok(TIER_IDS.includes(UNRESTRICTED_TIER), 'the gate names a level the product does not offer')
  assert.equal(requiresRiskConsent(UNRESTRICTED_TIER), true)
  for (const tier of TIER_IDS.filter(id => id !== UNRESTRICTED_TIER)) {
    assert.equal(requiresRiskConsent(tier), false, `${tier} would be gated as though it were the widest level`)
  }
  /* DEFAULT OFF, as the ruling puts it: the level a person lands on by not
     deciding is a confined one. */
  assert.notEqual(DEFAULT_TIER, UNRESTRICTED_TIER, 'the walkthrough preselects the widest level')
  assert.equal(DEFAULT_TIER, 'standard')
  assert.deepEqual(TIER_CHOICES.filter(choice => choice.note === 'Recommended').map(choice => choice.tier), [DEFAULT_TIER], 'only the default row carries the recommendation')
})

test('every phrase the Terms use for the risk is on the glass, verbatim', () => {
  const shown = [UNRESTRICTED_RISK_LEAD, ...UNRESTRICTED_RISK_STATEMENTS, UNRESTRICTED_RISK_QUESTION].join(' ')
  for (const phrase of TERMS_PHRASES) {
    assert.ok(shown.includes(phrase), `the shown words no longer contain the Terms’ phrase: “${phrase}”`)
  }
  assert.match(UNRESTRICTED_RISK_LEAD, /complete, unsandboxed control of your computer/,
    'the lead no longer says what §2’s own heading says')
  assert.match(UNRESTRICTED_RISK_QUESTION, /full access to this computer\?$/, 'the question stopped being a question')
  assert.equal(UNRESTRICTED_RISK_TEXT, shown, 'the recorded text is not the shown text')
})

test('every sentence shown is within the plain-language limit the rest of the product keeps', () => {
  for (const text of [UNRESTRICTED_RISK_LEAD, ...UNRESTRICTED_RISK_STATEMENTS, UNRESTRICTED_RISK_QUESTION, UNRESTRICTED_CONFIRM_LABEL, UNRESTRICTED_DECLINE_LABEL]) {
    for (const sentence of sentencesOf(text)) {
      const words = wordsOf(sentence)
      assert.ok(words.length <= 25, `${words.length} words in one sentence: “${sentence}”`)
    }
    /* No tier KEY in front of a person, the rule tools/check-plain-language.mjs
       enforces; the words say what the level does, never what it is called
       inside the program. */
    assert.doesNotMatch(text, /["'“”`]\s*(guided|standard|unrestricted)\s*["'“”`]/i)
  }
})

test('the gate asks for the widest level, and for nothing else', () => {
  const gate = createRiskGate({ via: 'settings', now: () => 1_000 })
  assert.equal(gate.pending, null)
  assert.deepEqual(gate.request('guided'), { ask: false, tier: 'guided' })
  assert.equal(gate.pending, null)
  assert.deepEqual(gate.request('standard'), { ask: false, tier: 'standard' })
  assert.deepEqual(gate.request('unrestricted'), { ask: true, tier: 'unrestricted' })
  assert.equal(gate.pending, 'unrestricted')
})

test('confirming yields a consent object with the words attached; declining yields nothing and keeps nothing', () => {
  const gate = createRiskGate({ via: 'setup', now: () => 5_000 })
  assert.equal(gate.confirm(), null, 'a confirm with nothing pending produced a consent')

  gate.request('unrestricted')
  const consent = gate.confirm()
  assert.deepEqual(consent, {
    riskShown: true,
    confirmed: true,
    riskText: UNRESTRICTED_RISK_TEXT,
    shownAtMs: 5_000,
    via: 'setup',
  })
  assert.equal(gate.pending, null, 'the gate stayed pending after a confirmation')

  gate.request('unrestricted')
  assert.equal(gate.decline(), null)
  assert.equal(gate.pending, null, 'the gate stayed pending after a decline')
  assert.equal(gate.confirm(), null, 'a decline left a confirmation available')
})

test('down and back up asks again: the gate keeps no memory of an earlier yes', () => {
  const gate = createRiskGate()
  gate.request('unrestricted')
  assert.ok(gate.confirm())
  gate.request('guided')
  assert.equal(gate.pending, null)
  assert.deepEqual(gate.request('unrestricted'), { ask: true, tier: 'unrestricted' },
    'the second request for the widest level did not ask')
})

test('riskConsent refuses to call anything confirmed that was not', () => {
  assert.equal(riskConsent({ confirmed: 'yes' }).confirmed, false)
  assert.equal(riskConsent({ confirmed: 1 }).confirmed, false)
  assert.equal(riskConsent({}).confirmed, false)
  assert.equal(riskConsent({ confirmed: true }).confirmed, true)
  assert.equal(riskConsent({ confirmed: true, via: 'anything-else' }).via, 'settings')
  assert.equal(riskConsent({ confirmed: true, via: 'setup' }).via, 'setup')
})

test('the block carries the words, the question and both controls, escaped', () => {
  const markup = unrestrictedRiskMarkup({ id: 'x' })
  assert.match(markup, /data-unrestricted-risk/)
  assert.match(markup, /role="group" aria-labelledby="x-lead"/)
  assert.match(markup, /id="x-lead"/)
  for (const statement of UNRESTRICTED_RISK_STATEMENTS) {
    assert.ok(markup.includes(statement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')), 'a statement is missing from the block')
  }
  assert.match(markup, /data-unrestricted-confirm[^>]*>Yes, give it full access</)
  assert.match(markup, /data-unrestricted-decline[^>]*>No, keep the safer level</)
  assert.match(unrestrictedRiskMarkup({ declineLabel: 'No, keep “<b>”' }), /No, keep “&lt;b&gt;”/, 'the decline label is not escaped')
  assert.match(unrestrictedRiskMarkup({ busy: true }), /data-unrestricted-confirm disabled/)
})

test('the sentence about the record never rounds absence up to consent', () => {
  const at = Date.UTC(2026, 7, 18, 12, 0, 0)
  assert.equal(describeConsentRecord({ ok: true, recorded: true, atMs: at }, { tier: 'guided' }), null,
    'a narrower level got a sentence about the widest level’s record')
  assert.match(describeConsentRecord({ ok: false }, { tier: 'unrestricted' }), /could not be read/)
  assert.doesNotMatch(describeConsentRecord({ ok: false }, { tier: 'unrestricted' }), /confirmed on/)
  const absent = describeConsentRecord({ ok: true, recorded: false }, { tier: 'unrestricted' })
  assert.match(absent, /No confirmation of the risk is on record/)
  assert.match(absent, /before this program asked, or from outside it/)
  assert.doesNotMatch(absent, /was confirmed/)
  const present = describeConsentRecord({ ok: true, recorded: true, atMs: at }, { tier: 'unrestricted', locale: 'en-US' })
  assert.match(present, /Full access was confirmed on August 18, 2026, after the risk was shown in these words/)
  assert.match(present, /Choosing it again will ask again/)
  /* And every one of those sentences is plain. */
  for (const text of [absent, present, describeConsentRecord({ ok: false }, { tier: 'unrestricted' })]) {
    for (const sentence of sentencesOf(text)) assert.ok(wordsOf(sentence).length <= 25, sentence)
  }
})
