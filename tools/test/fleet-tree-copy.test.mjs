import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  UNKNOWN_ROLE_LABEL,
  TIER_ANSWER_UNKNOWN,
  TIER_CANNOT_START_HERE,
  TIER_NOT_INSTALLED,
  TREE_DEFAULT_STARTABLE_TIERS,
  isKnownRole,
  notInstalledProviderIds,
  roleLabel,
  signedOutProviderIds,
  startableTierAnswer,
  startableTierIds,
  tierNoLauncherSentence,
  tierChoicesFor,
} from '../../src/fleet-tree-copy.js'

test('a reading says whether the shell spoke, not only what it would have said', () => {
  /* The defect: the fallback list and a real Codex-only answer were the same
     value, so a thrown probe printed "cannot start from a tree yet" over seven
     tiers this build starts. The list is unchanged; the provenance is new. */
  for (const [name, reply] of [
    ['no reply at all', undefined],
    ['a rejected reply', { ok: false, tiers: ['astra'] }],
    ['a malformed reply', { ok: true, tiers: 'astra' }],
    ['tiers from another product', { ok: true, tiers: ['not-a-tier-this-build-has'] }],
  ]) {
    const answer = startableTierAnswer(reply)
    assert.equal(answer.answered, false,
      `mutation \`report an unlearned reading as answered\` survived: expected ${name} to teach nothing`)
    assert.deepEqual([...answer.tiers], [...TREE_DEFAULT_STARTABLE_TIERS],
      `mutation \`widen the fallback when nothing was learned\` survived: expected ${name} to keep the pessimistic list`)
  }

  const spoke = startableTierAnswer({ ok: true, tiers: ['claude-opus', 'astra'] })
  assert.equal(spoke.answered, true,
    'mutation `report a real answer as unlearned` survived: expected a well-formed reply to be an answer')
  assert.deepEqual([...spoke.tiers], ['claude-opus', 'astra'],
    'mutation `discard the named tiers` survived: expected the shell\'s own list')

  const empty = startableTierAnswer({ ok: true, tiers: [] })
  assert.equal(empty.answered, true,
    'mutation `treat an empty answer as silence` survived: an empty list is an answer and is honoured')

  assert.deepEqual([...startableTierIds(undefined)], [...TREE_DEFAULT_STARTABLE_TIERS],
    'mutation `change the long-standing startableTierIds contract` survived: the older reader is unchanged')
})

test('a row blames the build only when the build is what answered', () => {
  const answered = tierChoicesFor(['astra'], [], [], 'this computer').find(row => row.id === 'claude-opus')
  assert.equal(answered.why, TIER_CANNOT_START_HERE,
    'mutation `print the silence sentence over a real answer` survived: a shell that answered still says the build cannot start it')

  const silent = tierChoicesFor(TREE_DEFAULT_STARTABLE_TIERS, [], [], 'this computer', { answered: false })
    .find(row => row.id === 'claude-opus')
  assert.equal(silent.enabled, false,
    'mutation `enable a row nothing is known about` survived: an unlearned row must still refuse the press')
  assert.equal(silent.why, TIER_ANSWER_UNKNOWN,
    'mutation `keep the no-launcher sentence when nothing was learned` survived: expected the silence sentence')
  assert.notEqual(TIER_ANSWER_UNKNOWN, TIER_CANNOT_START_HERE,
    'mutation `collapse the two refusals into one sentence` survived: they are claims about different things')

  /* A tier the shell DID name starts, whether or not other rows are unknown --
     the flag only ever changes the words on a row that already refuses. */
  const named = tierChoicesFor(['astra'], [], [], 'this computer', { answered: false }).find(row => row.id === 'astra')
  assert.equal(named.enabled, true,
    'mutation `refuse every row when the reading is unlearned` survived: the listed tiers still start')
})

test('tier choices carry the refusal as control data as well as reader-facing words', () => {
  const cannotStart = tierChoicesFor(['luna']).find(row => row.id === 'terra')
  assert.equal(cannotStart.enabled, false,
    'mutation `omit enabled from a refused choice` survived: expected the refused choice enabled flag to be false')
  assert.equal(cannotStart.why, TIER_CANNOT_START_HERE,
    'mutation `discard the computed refusal after building the label` survived: expected the choice reason to match TIER_CANNOT_START_HERE')

  const notInstalled = tierChoicesFor(['luna'], [], ['codex']).find(row => row.id === 'luna')
  assert.equal(notInstalled.why, TIER_NOT_INSTALLED('Codex'),
    'mutation `replace the missing-program reason with the launcher reason` survived: expected the choice reason to match TIER_NOT_INSTALLED')
})

test('desk phrases name the reader\'s subject at the two fleet-tree painters', () => {
  const subject = 'the computer you are driving'
  const installedReadings = [
    tierChoicesFor(['luna'], [], ['codex']).find(row => row.id === 'luna').why,
    tierChoicesFor(['luna'], [], ['codex'], subject).find(row => row.id === 'luna').why,
  ]
  assert.deepEqual(installedReadings, [
    'Codex is not installed on this computer',
    'Codex is not installed on the computer you are driving',
  ], 'mutation `discard the tier-row subject` survived: expected local and relay missing-program readings')

  const launcherReadings = [
    tierNoLauncherSentence('local'),
    tierNoLauncherSentence('local', { subject }),
  ]
  assert.deepEqual(launcherReadings.map(reading => reading.match(/the part that runs an agent on .+? itself/)[0]), [
    'the part that runs an agent on this computer itself',
    'the part that runs an agent on the computer you are driving itself',
  ], 'mutation `discard the local-launcher subject` survived: expected local and relay missing-launcher readings')
})

test('saved role keys are translated for readers and unknown keys never leak', () => {
  assert.equal(isKnownRole('  coordinator  '), true, 'a saved role key should still be recognised around wire whitespace')
  assert.notEqual(roleLabel('coordinator'), 'coordinator', 'a known role must be shown as its reader-facing label, not its storage key')
  assert.equal(roleLabel('role-from-a-newer-copy'), UNKNOWN_ROLE_LABEL, 'an unknown saved role must use the neutral reader-facing label')
  assert.equal(roleLabel(null), UNKNOWN_ROLE_LABEL, 'a missing saved role must use the neutral reader-facing label')
})

test('a failed or unreadable capability reply remains unknown, while a definite empty answer is honoured', () => {
  const fallback = startableTierIds(undefined)
  assert.ok(fallback.length > 0, 'a could-not-read tier reply must retain the pessimistic known-safe fallback')
  assert.deepEqual(
    startableTierIds({ ok: false, tiers: [] }),
    fallback,
    'a rejected tier read must not collapse into the definite answer that nothing can start',
  )
  assert.deepEqual(
    startableTierIds({ ok: true, tiers: [] }),
    [],
    'a successful empty tier reply must be honoured as the definite answer that nothing can start',
  )
})

test('provider read failures do not become absence claims, and proven negatives compose an actionable row', () => {
  const unreadable = { ok: false, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }
  assert.deepEqual(notInstalledProviderIds(unreadable), [], 'a could-not-read provider reply must not claim that a program is absent')
  assert.deepEqual(signedOutProviderIds(unreadable), [], 'a could-not-read provider reply must not claim that a sign-in is absent')

  const uncertain = { ok: true, providers: [{ id: 'codex', installed: 'unknown', signedIn: 'unknown' }] }
  assert.deepEqual(notInstalledProviderIds(uncertain), [], 'an unknown installation state must not be rounded down to not installed')
  assert.deepEqual(signedOutProviderIds(uncertain), [], 'an unknown sign-in state must not be rounded down to signed out')

  const proven = { ok: true, providers: [{ id: 'codex', installed: 'no', signedIn: 'no' }] }
  const rows = tierChoicesFor(startableTierIds(undefined), signedOutProviderIds(proven), notInstalledProviderIds(proven))
  const codexRow = rows.find(row => row.id === 'luna')
  assert.ok(codexRow, 'the real caller default tier must have a menu row')
  assert.match(codexRow.label, /not installed/i, 'a proven missing program must tell the reader what prerequisite is missing')
  assert.doesNotMatch(codexRow.label, /sign(?:ed)?[ -]?in/i, 'a missing-program row must not send the reader to sign in before the program exists')
})
