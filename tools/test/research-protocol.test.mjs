// Protocol decisions of record and pipeline settings: the registry composes
// into the frozen decisions text, settings carry LeanBench's value as a
// changeable default, decisions are undecided until decided with their origin
// named, and a draft from before the page freezes exactly what it always did.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DECISION_FIELDS, ORIGIN_LABELS, PROTOCOL_MANAGED_FIELDS, PROTOCOL_FIELDS, PROTOCOL_SECTIONS, SETTING_FIELDS, atDefault, decidedCount, decisionsText, effectiveValue, emptyProtocolDecisions, matchesDecisionsText, normalizeProtocolDecisions, normalizeValue, previousProtocolEntries, protocolField, settingsCount, withLeanBench, withRulings, withoutSection } from '../../src/research-protocol.mjs'
import { PROTOCOL_OPTION_CHOICES, PROTOCOL_OPTION_LABELS, PROTOCOL_OPTION_SECTIONS, PROTOCOL_ORIGIN_LABELS } from '../../src/research-protocol-options.mjs'

test('every field has a unique id, an accepted LeanBench value, a reason and a named origin', () => {
  const ids = PROTOCOL_FIELDS.map(field => field.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.ok(PROTOCOL_SECTIONS.length >= 10 && PROTOCOL_FIELDS.length >= 100, 'the inventory is the LeanBench corpus, not a sketch')
  assert.equal(DECISION_FIELDS.length + SETTING_FIELDS.length + Object.keys(PROTOCOL_MANAGED_FIELDS).length, PROTOCOL_FIELDS.length)
  for (const field of PROTOCOL_FIELDS) {
    assert.notEqual(normalizeValue(field, field.lb), undefined, `${field.id}: LeanBench value normalizes`)
    assert.ok(field.why.length > 20, `${field.id}: carries its measured reason`)
    assert.ok(Object.hasOwn(ORIGIN_LABELS, field.origin) && field.source.length > 10, `${field.id}: names where it came from`)
    if (field.kind === 'choice') assert.ok(field.options.some(([id]) => id === field.lb), `${field.id}: LeanBench value is an option`)
  }
  assert.equal(PROTOCOL_FIELDS.filter(field => field.origin === 'owner').length, 29, 'the owner\'s rulings are the ones found in the owner\'s words')
})

test('nothing decided and every setting at its default freezes the notes alone', () => {
  const state = emptyProtocolDecisions(); state.notes = 'Apparatus controls only. Declare the actual systems before a counted experiment.'
  assert.equal(decisionsText(state), state.notes)
  assert.equal(decisionsText(emptyProtocolDecisions()), '')
  assert.deepEqual(settingsCount(state), { changed: 0, total: SETTING_FIELDS.length })
  assert.equal(effectiveValue(state, protocolField('output-cap')), 64000, 'a setting reads its default')
  assert.equal(effectiveValue(state, protocolField('study-kind')), undefined, 'a decision has no default')
})

test('settings print with their default marked, decided fields print, notes follow, undecided are named', () => {
  let state = withLeanBench(emptyProtocolDecisions(), 'cleanroom')
  state.values['in-flight'] = 4; state.values['study-kind'] = 'exploratory'; state.notes = 'Stop at the registered cells.'
  const text = decisionsText(state)
  assert.match(text, /^DECISIONS OF RECORD\n\nStudy scope and registration\n- Kind of study: Exploratory/)
  assert.match(text, /\nClean room and canary\n- Generation runs in an instruction-bare clean room: A dedicated root[^\n]*\(default\)\n/)
  assert.match(text, /\n- Cells in flight at once: 4 cells\n/, 'a changed setting prints without the default mark')
  assert.match(text, /\n- Output token ceiling: 64,000 tokens \(default\)\n/, 'an untouched setting prints its default')
  assert.match(text, /\nNOTES\n\nStop at the registered cells\./)
  const { decided, total } = decidedCount(state)
  assert.equal(decided, 1)
  assert.match(text, new RegExp(`NOT YET DECIDED \\(${total - decided}\\)\\n`))
  assert.ok(text.includes('Hypotheses committed before the confirmatory draws; Scope closed'), 'undecided decisions are listed by label')
  assert.ok(!text.includes('Kind of study;'), 'a decided field is not listed as undecided')
  assert.equal(atDefault(state, protocolField('cleanroom')), true, 'a setting set to its own default still counts as default')
})

test('rulings fill only the owner\'s fields; LeanBench fills all or only the undecided; clearing keeps settings', () => {
  const rulings = withRulings(emptyProtocolDecisions())
  assert.equal(rulings.values['scope-closed'], 'yes'); assert.equal(rulings.values['noask'], undefined, 'retired example instructions are never filled')
  assert.equal(decidedCount(rulings).decided, DECISION_FIELDS.filter(field => field.origin === 'owner').length)
  const all = withLeanBench(emptyProtocolDecisions())
  assert.deepEqual(decidedCount(all), { decided: DECISION_FIELDS.length, total: DECISION_FIELDS.length })
  const mine = emptyProtocolDecisions(); mine.values['in-flight'] = 4; mine.values['study-kind'] = 'exploratory'
  const filled = withLeanBench(mine, null, { onlyUndecided: true })
  assert.equal(filled.values['in-flight'], 4); assert.equal(filled.values['study-kind'], 'exploratory'); assert.equal(filled.values['scope-closed'], 'yes')
  const cleared = withoutSection(filled, null, { settingsToo: false })
  assert.equal(cleared.values['study-kind'], undefined); assert.equal(cleared.values['in-flight'], 4, 'clearing decisions keeps the settings')
  assert.equal(withoutSection(filled, 'schedule').values['in-flight'], undefined)
})

test('duplicate settings survive old drafts as reference only and cannot return through bulk actions', () => {
  const values = { noask: 'yes', 'noask-text': 'Do not ask.', 'system-line': 'An old instruction.', 'draw-timeout': 40, 'n-eligible': 99, models: ['old-model'], 'study-kind': 'exploratory' }
  const state = normalizeProtocolDecisions({ version: 1, values, notes: 'My study notes.' })
  assert.deepEqual(state.values, values, 'loading does not discard previous entries')
  assert.deepEqual(previousProtocolEntries(state).map(entry => entry.field.id).sort(), Object.keys(values).filter(id => id !== 'study-kind').sort())
  const text = decisionsText(state)
  assert.match(text, /Kind of study: Exploratory/)
  assert.match(text, /My study notes\./)
  for (const id of Object.keys(PROTOCOL_MANAGED_FIELDS)) {
    assert.ok(!PROTOCOL_SECTIONS.some(section => section.fields.some(field => field.id === id)), `${id} has no second editor`)
    const label = protocolField(id).label
    assert.ok(!text.includes(`\n- ${label}:`) && !text.split('\n').at(-1).split('; ').includes(label), `${id} is neither frozen nor listed as undecided`)
    assert.equal(withLeanBench(emptyProtocolDecisions()).values[id], undefined, `${id} is not added by an example`)
  }
  for (const next of [withLeanBench(state), withRulings(state), withoutSection(state)]) {
    for (const id of Object.keys(values).filter(id => id !== 'study-kind')) assert.deepEqual(next.values[id], values[id], `${id} remains in the saved record`)
  }
  const legacy = decisionsText(state, { includeManaged: true })
  assert.equal(matchesDecisionsText(state, legacy), true)
  assert.equal(matchesDecisionsText(state, legacy.replace('Yes: append the no-ask instruction below to the prompt, identically across models and lanes.', 'A registered instruction is appended to the prompt in one condition, byte-identical across models and lanes.')), true)
  assert.equal(matchesDecisionsText(state, 'Handwritten replacement'), false)
  delete state.values['study-kind']
  assert.equal(decisionsText(state), 'My study notes.', 'previous entries alone do not freeze a second set of settings')
  assert.deepEqual(decidedCount(state), { decided: 0, total: DECISION_FIELDS.length })
  assert.deepEqual(settingsCount(state), { changed: 0, total: SETTING_FIELDS.length })
})

test('normalization drops unknown ids and malformed values and bounds the notes', () => {
  const state = normalizeProtocolDecisions({ version: 1, values: { 'canary-scope': 'surface', 'canary-cadence': 'weekly', 'n-eligible': 'thirty', 'env-allowlist': 'PATH\n\n TEMP ', ghost: 'yes', 'output-cap': '64000' }, notes: 'x'.repeat(30000) })
  assert.deepEqual(state.values, { 'canary-scope': 'surface', 'env-allowlist': ['PATH', 'TEMP'], 'output-cap': 64000 })
  assert.equal(state.notes.length, 20000)
  assert.deepEqual(normalizeProtocolDecisions(null), emptyProtocolDecisions())
  assert.equal(protocolField('ghost'), null)
  assert.equal(normalizeValue(protocolField('judge-threshold'), '0.7'), 0.7)
  assert.equal(normalizeValue(protocolField('fairness'), true), 'yes')
})

test('the grouped options cover every editable field once, with generic labels and no benchmark, vendor or cell-role jargon', () => {
  const ids = PROTOCOL_OPTION_SECTIONS.flatMap(section => section.groups.flatMap(group => group.fields))
  assert.equal(new Set(ids).size, ids.length, 'no option appears twice')
  assert.deepEqual(ids.slice().sort(), PROTOCOL_FIELDS.filter(field => !field.managedBy).map(field => field.id).sort(), 'every editable field is grouped and no managed field is')
  const jargon = /\b(claude|codex|gemini|openai|vertex|leanbench|lean bench|anchor|donor|placebo|pin|council|lattice)\b/i
  const titles = PROTOCOL_OPTION_SECTIONS.flatMap(section => [section.title, ...section.groups.map(group => group.title)])
  for (const title of titles) assert.doesNotMatch(title, jargon, title)
  for (const id of ids) {
    const label = PROTOCOL_OPTION_LABELS[id]
    assert.ok(typeof label === 'string' && label.length >= 8 && label.length <= 60, `${id}: has a short label`)
    assert.doesNotMatch(label, jargon, `${id}: ${label}`)
    assert.ok(!/[()]/.test(label), `${id}: the short label carries no parenthetical`)
    for (const choice of PROTOCOL_OPTION_CHOICES[id] || []) assert.doesNotMatch(choice, jargon, `${id}: ${choice}`)
    if (PROTOCOL_OPTION_CHOICES[id]) assert.equal(PROTOCOL_OPTION_CHOICES[id].length, protocolField(id).options.length, `${id}: one menu label per registered option`)
  }
  assert.deepEqual(Object.keys(PROTOCOL_ORIGIN_LABELS).sort(), Object.keys(ORIGIN_LABELS).sort(), 'every provenance tag has a display name')
})
