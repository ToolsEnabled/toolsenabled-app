/* THE GUIDE MUST NAME EVERY CHOICE THE SLIDER OFFERS. T9, owner's question:
 * "what happened to my settings slider for things like autonomous and
 * autonomous+". Nothing happened to it — WORKING_PROFILES has offered all six
 * the whole time. What is missing is any mention of three of them in the guide
 * whose entire job is to introduce the control, so the two most autonomous
 * settings are invisible to someone who reads the guide and does not drag the
 * slider to its end.
 *
 * This pins the list against its source rather than against a copy of the list,
 * so adding a seventh profile fails here until the guide names it too. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_GUIDES } from '../../src/feature-guides.js'
import { WORKING_PROFILES } from '../../src/settings-profile-policy.js'

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* "Autonomous" is a prefix of "Autonomous+", so a plain includes() would call
 * Autonomous named by a sentence that only ever says Autonomous+. The lookahead
 * refuses a match that is really the start of a longer label. */
const namesProfile = (text, label) => new RegExp(`${escape(label)}(?![+\\w])`).test(text)

const profileStep = () => {
  const step = FEATURE_GUIDES.settings?.steps?.find(candidate =>
    (candidate.selectors || []).some(selector => selector.includes('data-working-profile')))
  assert.ok(step, 'the settings guide still has a step that introduces the working-profile picker')
  return step
}

test('the working-profile guide step names every profile the slider offers', () => {
  const step = profileStep()
  const missing = WORKING_PROFILES.filter(profile => !namesProfile(step.text, profile.label))
  assert.deepEqual(missing.map(profile => profile.label), [],
    `the guide introduces the slider but does not name ${missing.map(p => p.label).join(', ')}; its text is: ${step.text}`)
})

test('the two autonomous choices are named distinctly, not one standing in for the other', () => {
  const step = profileStep()
  assert.ok(namesProfile(step.text, 'Autonomous'),
    'Autonomous is named in its own right, not only as the first half of Autonomous+')
  assert.ok(namesProfile(step.text, 'Autonomous+'), 'Autonomous+ is named')
})

/* A guard on the guard: if this ever passes trivially because the step lost its
 * selector or the profile list emptied, that is not a pass worth having. */
test('the check is measuring something', () => {
  assert.ok(WORKING_PROFILES.length >= 6, 'the profile list is populated')
  assert.ok(profileStep().text.length > 40, 'the step still carries real copy')
})
