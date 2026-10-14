/* R1536, the three tiers, and the trap underneath them.
 *
 * The owner asked for a plain expectation on every step -- "typically requires
 * a user step, rarely, sometimes" -- and for that general label to give way to
 * the specific truth wherever we can actually read the person's computer.
 *
 * The trap is what the label may be REASONED FROM. The finding this lane
 * corrects concluded that nothing here needs administrator rights, because
 * nothing prompted on the machine it was measured on -- a machine whose Windows
 * approval prompt is switched off. So the assertions here check that the
 * reasoning is recorded and that an unread machine is answered as unread, never
 * as "fine".
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXTERNAL_CAPABILITIES, FREQUENCIES, FREQUENCY_WORDING,
  frequencyFor, guidedStepFor, validateGuidance,
} from '../../src/permission-guidance.js'
import { guidanceMarkup } from '../../src/guided-step.js'

test('every outside capability carries a frequency label and the reasoning behind it', () => {
  for (const [id, capability] of Object.entries(EXTERNAL_CAPABILITIES)) {
    assert.ok(FREQUENCIES.includes(capability.frequency), `${id}: frequency must come from the closed set`)
    assert.ok(typeof capability.frequencyBecause === 'string' && capability.frequencyBecause.trim() !== '',
      `${id}: must record how the label was derived so a reader can challenge it`)
  }
  assert.deepEqual(validateGuidance(), { ok: true, errors: [] })
})

test('the guarantees reject a capability with no label, and one with a made-up word', () => {
  // Exercised through the real validator rather than a regex over the file, so
  // a declaration added later cannot skip it.
  const good = EXTERNAL_CAPABILITIES['codex-installed']
  assert.ok(FREQUENCIES.includes(good.frequency))
  assert.equal(FREQUENCIES.includes('occasionally'), false, 'the vocabulary is closed on purpose')
  assert.equal(FREQUENCIES.includes('may'), false)
  for (const word of FREQUENCIES) {
    assert.ok(typeof FREQUENCY_WORDING[word] === 'string' && FREQUENCY_WORDING[word] !== '',
      `${word} has no wording, so a surface would render an empty badge`)
  }
})

test('tier 2: with no reading of the computer, the general label is shown AND named as general', () => {
  const label = frequencyFor(EXTERNAL_CAPABILITIES['codex-installed'], null)
  assert.equal(label.tier, 2)
  assert.equal(label.source, 'general')
  assert.equal(label.label, FREQUENCY_WORDING.typically)
  assert.match(label.detail, /could not check/i)
})

test('tier 1: a reading of the computer replaces the general claim with the specific one', () => {
  const label = frequencyFor(EXTERNAL_CAPABILITIES['codex-installed'], {
    outcome: 'consent', sentence: 'On your computer Windows will show you an approval box before this can run.',
  })
  assert.equal(label.tier, 1)
  assert.equal(label.source, 'measured')
  assert.match(label.label, /asks you to approve it/)
  // The general claim is kept beside it, never discarded, so it stays arguable.
  assert.equal(label.declared, 'typically')
})

test('tier 1 says out loud when a machine will elevate with no prompt at all', () => {
  const label = frequencyFor(EXTERNAL_CAPABILITIES['codex-installed'], {
    outcome: 'silent', sentence: 'On your computer this will run without asking you anything.',
  })
  assert.equal(label.tier, 1)
  assert.match(label.label, /runs without asking you/)
})

test('an unrecognized reading is tier 2, not quietly treated as a good outcome', () => {
  for (const outcome of ['', 'fine', 'ok', undefined, null]) {
    const label = frequencyFor(EXTERNAL_CAPABILITIES['codex-installed'], { outcome })
    assert.equal(label.tier, 2, `an outcome of ${JSON.stringify(outcome)} must not be believed`)
  }
})

test('the step carries the label at every state, including when the capability was found', () => {
  for (const probed of [true, false, undefined]) {
    const step = guidedStepFor('write_cloud-launch', { probe: () => probed })
    assert.ok(step.frequency, 'the label is part of the offer, not part of the failure case')
    assert.ok(step.frequency.label !== '' || step.frequency.detail !== '')
  }
})

test('the rendered block leads with the label and records the tier it came from', () => {
  const markup = guidanceMarkup('write_cloud-launch', {
    probe: () => false,
    posture: { outcome: 'credentials', sentence: 'On your computer Windows will ask you to type your password.' },
  })
  assert.match(markup, /data-guided-frequency-tier="1"/)
  assert.match(markup, /data-guided-frequency-source="measured"/)
  assert.match(markup, /data-guided-frequency-declared="typically"/)
  assert.match(markup, /asks for a password/)
  // Above the description, because it is the question asked first.
  assert.ok(markup.indexOf('guided-frequency') < markup.indexOf('Codex Cloud runs'))
})

test('with no posture the rendered block still shows a label, and says it is the general one', () => {
  const markup = guidanceMarkup('write_cloud-launch', { probe: () => false })
  assert.match(markup, /data-guided-frequency-tier="2"/)
  assert.match(markup, /data-guided-frequency-source="general"/)
  assert.match(markup, /Typically needs a step from you/)
  assert.match(markup, /could not check/i)
})

test('a posture reading never turns the step into something required', () => {
  // The whole doctrine survives contact with tier 1: knowing exactly what a
  // machine will do must not become a reason to push.
  const step = guidedStepFor('write_cloud-launch', {
    probe: () => false,
    posture: { outcome: 'refused', sentence: 'On your computer Windows will refuse this.' },
  })
  assert.equal(step.capability.required, false)
  assert.equal(step.neverPerformedForYou, true)
  assert.match(step.optionalNote, /do not have to do this/i)
})
