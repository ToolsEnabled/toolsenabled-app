import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { THEME_CHOICES } from '../../src/theme-choice.js'
import { FONT_CHOICES } from '../../src/font-choice.js'
import { TEXT_SIZES } from '../../src/text-size.js'
import { DEFAULT_GLOW, GLOW_MIN, GLOW_MAX, DEFAULT_REDUCE_MOTION } from '../../src/appearance-persistence.js'

const require = createRequire(import.meta.url)
const { PREFERENCES, FONT_STACKS, scenarios, ownedPreferenceFile, readPreferenceFile, readStartIdentity,
  assertPreferenceReceipt, assertPreferenceChange, assertPreferenceRestored, withRestoration, assertBoundaryKey } = require('../lib/page2-native-preference-scenarios.cjs')
const preference = id => PREFERENCES.find(item => item.id === id)
const hash = '1'.repeat(64)

function receipt() {
  const raw = Object.fromEntries(PREFERENCES.map(item => [item.key, null]))
  return { source: { available: true, accountReady: true, signedIn: false, file: '/owned/profile/renderer-prefs.json',
    notice: { damaged: null, preservedAt: null, refused: null } },
  raw, host: Object.fromEntries(PREFERENCES.map(item => [item.key, { ok: true, value: null }])),
  disk: { file: '/owned/profile/renderer-prefs.json', sha256: hash, protectedSha256: hash, values: structuredClone(raw) }, starts: { count: 0, sha256: hash },
  applied: { theme: 'white', themeBackground: '#ffffff', fontStack: FONT_STACKS.plex, bodyFont: FONT_STACKS.plex,
    zoom: '', layoutZoom: '', glow: '1', reduceMotion: false, reading: null } }
}
function changed(before, id, value) {
  const after = structuredClone(before), item = preference(id)
  const raw = ['glow', 'reduce_motion'].includes(id) && value === item.default ? null : String(value)
  after.raw[item.key] = raw; after.host[item.key].value = raw; after.disk.values[item.key] = raw
  if (id === 'theme') { after.applied.theme = value; after.applied.themeBackground = `theme ${value}` }
  else if (id === 'ui_font') { after.applied.fontStack = FONT_STACKS[value]; after.applied.bodyFont = FONT_STACKS[value] }
  else if (id === 'text_size') { after.applied.zoom = value === '1' ? '' : value; after.applied.layoutZoom = after.applied.zoom }
  else if (id === 'glow') after.applied.glow = String(value / 100)
  else if (id === 'reduce_motion') after.applied.reduceMotion = value
  else after.applied.reading = { width: value, max: value === 'wide' ? '1400px' : '920px',
    label: value === 'wide' ? 'Wide' : 'Comfortable', pressed: String(value === 'wide'), subject: 'coordinator', exampleShown: false }
  return after
}
const mountedHome = before => ({ ...before, applied: { ...before.applied, reading: changed(before, 'reading_width', 'comfortable').applied.reading } })

test('the reviewed native preference vocabulary matches the actual source options and defaults', () => {
  assert.deepEqual(preference('theme').choices, THEME_CHOICES.map(item => item.id))
  assert.deepEqual(preference('ui_font').choices, FONT_CHOICES.map(item => item.id))
  assert.deepEqual(FONT_STACKS, Object.fromEntries(FONT_CHOICES.map(item => [item.id, item.stack])))
  assert.deepEqual(preference('text_size').choices, TEXT_SIZES.map(String))
  assert.deepEqual(preference('glow').choices, [GLOW_MIN, GLOW_MAX])
  assert.equal(preference('glow').default, DEFAULT_GLOW)
  assert.equal(preference('reduce_motion').default, DEFAULT_REDUCE_MOTION)
})

for (const [id, value] of [['theme', 'cobalt'], ['ui_font', 'mono'], ['text_size', '1.12'], ['glow', 200], ['reduce_motion', true], ['reading_width', 'wide']]) {
  test(`preference proof accepts the exact ${id} change and a reported visible restoration`, () => {
    const before = id === 'reading_width' ? mountedHome(receipt()) : receipt(), item = preference(id)
    assertPreferenceReceipt(before)
    const after = changed(before, id, value)
    assertPreferenceChange(before, after, item, value)
    const restored = changed(after, id, item.default)
    if (id === 'theme') restored.applied.themeBackground = before.applied.themeBackground
    const proof = assertPreferenceRestored(before, restored, item)
    assert.equal(proof.originalRaw, null)
    assert.equal(proof.effectiveValue, item.default)
    assert.equal(proof.canonicalDefaultWritten, !['glow', 'reduce_motion'].includes(id))
  })
}

for (const [name, mutate] of [
  ['a browser-only receipt', value => { value.source.available = false }],
  ['unsettled account hydration', value => { value.source.accountReady = false }],
  ['a signed-in product account', value => { value.source.signedIn = true }],
  ['an unknown product account', value => { delete value.source.signedIn }],
  ['a refused durable save', value => { value.source.notice.refused = { key: 'mc.theme', code: 'MC_PREFS_WRITE_FAILED' } }],
  ['a different durable file', value => { value.disk.file = '/another/profile/renderer-prefs.json' }],
  ['a renderer-only updated cache', value => { value.host['mc.theme'].value = null; value.disk.values['mc.theme'] = null }],
  ['a host-only saved value', value => { value.disk.values['mc.theme'] = null }],
  ['a refused host read', value => { value.host['mc.theme'] = { ok: false, value: 'cobalt' } }],
  ['a stale applied theme', value => { value.applied.theme = 'white' }],
  ['a changed unrelated preference', value => { value.raw['mc.font'] = 'mono'; value.host['mc.font'].value = 'mono'; value.disk.values['mc.font'] = 'mono'; value.applied.fontStack = FONT_STACKS.mono; value.applied.bodyFont = FONT_STACKS.mono }],
  ['a changed permission or agent record', value => { value.disk.protectedSha256 = '2'.repeat(64) }],
  ['an unexpected provider start', value => { value.starts = { count: 1, sha256: '2'.repeat(64) } }],
  ['missing provider-start evidence', value => { delete value.starts }],
  ['theme CSS that never changed', value => { value.applied.themeBackground = '#ffffff' }],
]) {
  test(`preference proof rejects ${name}`, () => {
    const before = receipt(), after = changed(before, 'theme', 'cobalt')
    mutate(after)
    assert.throws(() => assertPreferenceChange(before, after, preference('theme'), 'cobalt'))
  })
}

test('applied-style evidence rejects font, zoom and reading controls that only changed storage', () => {
  for (const [id, target, mutate] of [
    ['ui_font', 'mono', value => { value.applied.bodyFont = FONT_STACKS.plex }],
    ['text_size', '1.12', value => { value.applied.layoutZoom = '' }],
    ['reading_width', 'wide', value => { value.applied.reading.max = '920px' }],
    ['reading_width', 'wide', value => { value.applied.reading.pressed = 'false' }],
    ['reading_width', 'wide', value => { value.applied.reading.label = 'Comfortable' }],
  ]) {
    const before = id === 'reading_width' ? mountedHome(receipt()) : receipt(), after = changed(before, id, target); mutate(after)
    assert.throws(() => assertPreferenceChange(before, after, preference(id), target))
  }
})

test('a Home width change cannot switch the actual mounted subject', () => {
  const before = changed(receipt(), 'reading_width', 'comfortable'), after = changed(before, 'reading_width', 'wide')
  after.applied.reading.subject = 'agent:another-agent'
  assert.throws(() => assertPreferenceChange(before, after, preference('reading_width'), 'wide'), /exact current Home subject/)
})

test('a stored width without an actual mounted Home control cannot earn reading-width coverage', () => {
  const before = mountedHome(receipt()), after = changed(before, 'reading_width', 'wide')
  after.applied.reading = null
  assert.throws(() => assertPreferenceChange(before, after, preference('reading_width'), 'wide'), /actual mounted reading controls/)
})

test('slider endpoint evidence requires the actual trusted key and focused native target', () => {
  for (const [key, value] of [['ArrowLeft', 0], ['ArrowRight', 200]]) {
    const receipt = { keys: [{ key, trusted: true }], value: String(value), focused: true }
    assertBoundaryKey(receipt, key, value)
    for (const mutate of [
      copy => { copy.keys = [] },
      copy => { copy.keys[0].trusted = false },
      copy => { copy.keys[0].key = 'Enter' },
      copy => { copy.focused = false },
      copy => { copy.value = '100' },
    ]) {
      const copy = structuredClone(receipt); mutate(copy)
      assert.throws(() => assertBoundaryKey(copy, key, value))
    }
  }
})

test('glow accepts floating representation of a whole percentage and refuses unsupported style values', () => {
  const before = receipt(), after = changed(before, 'glow', 113)
  assertPreferenceChange(before, after, preference('glow'), 113)
  after.applied.glow = '1.135'
  assert.throws(() => assertPreferenceChange(before, after, preference('glow'), 113))
})

test('restoration cannot silently retain the tested value or normalize an unrelated key', () => {
  const before = receipt(), after = changed(before, 'theme', 'cobalt')
  assert.throws(() => assertPreferenceRestored(before, after, preference('theme')))
  const restored = changed(after, 'theme', 'white')
  restored.applied.themeBackground = before.applied.themeBackground
  restored.raw['mc.text'] = '1'; restored.host['mc.text'].value = '1'; restored.disk.values['mc.text'] = '1'
  assert.throws(() => assertPreferenceRestored(before, restored, preference('theme')), /every other selected preference/)
})

test('restoration must recover the original computed theme and clear default zoom overrides', () => {
  const before = receipt(), wrongTheme = changed(before, 'theme', 'white')
  assert.throws(() => assertPreferenceRestored(before, wrongTheme, preference('theme')), /original applied theme background/)
  const wrongZoom = changed(before, 'text_size', '1')
  wrongZoom.applied.zoom = '1'; wrongZoom.applied.layoutZoom = '1'
  assert.throws(() => assertPreferenceRestored(before, wrongZoom, preference('text_size')), /clear the inline body zoom/)
})

test('a failed preference action stays failed after one explicit successful restoration', async () => {
  const before = receipt(), item = preference('theme'), failure = new Error('The native selected value was wrong')
  const calls = [], context = { state: {}, step: async (id, action) => { calls.push(id); return action() } }
  await assert.rejects(withRestoration(context, item, before, async () => { calls.push('action'); throw failure }, async () => {
    calls.push('restore'); const restored = changed(before, 'theme', 'white'); restored.applied.themeBackground = before.applied.themeBackground; return restored
  }), error => error === failure)
  assert.deepEqual(calls, ['action', 'preference-theme-restore-owned-choice', 'restore'])
  assert.deepEqual(context.state, {})
})

test('a failed restoration retains both errors and prevents another preference action', async () => {
  const before = receipt(), item = preference('theme'), context = { state: {}, step: async (_id, action) => action() }
  await assert.rejects(withRestoration(context, item, before, async () => { throw new Error('original action failed') }, async () => {
    throw new Error('owned restore refused')
  }), error => error instanceof AggregateError && error.errors.length === 2 && /owned restore refused/.test(error.message))
  assert.equal(context.state.nativePreferenceRestorationFailed, 'theme')
  let inputAttempted = false
  await assert.rejects(withRestoration(context, preference('ui_font'), before, async () => { inputAttempted = true }, async () => {
    inputAttempted = true; return before
  }), /prior failed preference restoration/)
  assert.equal(inputAttempted, false)
})

function owned(t) {
  const qaRoot = mkdtempSync(path.join(os.tmpdir(), 'native-preference-proof-'))
  t.after(() => rmSync(qaRoot, { recursive: true, force: true }))
  const userData = path.join(qaRoot, 'profile'); mkdirSync(userData)
  const file = path.join(userData, 'renderer-prefs.json')
  writeFileSync(file, JSON.stringify({ storageVersion: 1, values: { 'mc.theme': 'cobalt', 'mc.write.agent-session': 'enabled' }, drainedOrigins: [] }))
  return { paths: { qaRoot, userData }, file }
}

test('the actual durable-file reader binds exact keys and hashes unrelated values without exposing them', t => {
  const { paths, file } = owned(t)
  const first = readPreferenceFile(paths, file)
  assert.equal(first.values['mc.theme'], 'cobalt')
  assert.equal(first.values['mc.font'], null)
  assert.equal(Object.hasOwn(first.values, 'mc.write.agent-session'), false)
  writeFileSync(file, JSON.stringify({ storageVersion: 1, values: { 'mc.theme': 'cobalt', 'mc.write.agent-session': 'disabled' }, drainedOrigins: [] }))
  const second = readPreferenceFile(paths, file)
  assert.notEqual(first.protectedSha256, second.protectedSha256)
})

test('the recorded-start guard distinguishes a new start and rejects a malformed event identity', t => {
  const { paths } = owned(t), file = path.join(paths.userData, 'agent-spawn-records.jsonl')
  const empty = readStartIdentity(paths)
  assert.equal(empty.count, 0)
  const row = { action: 'agent_session_start', sequence: 1, sessionId: 'qa-session', eventHash: hash }
  writeFileSync(file, JSON.stringify(row) + '\n')
  const started = readStartIdentity(paths)
  assert.equal(started.count, 1); assert.notEqual(started.sha256, empty.sha256)
  delete row.eventHash
  writeFileSync(file, JSON.stringify(row) + '\n')
  assert.throws(() => readStartIdentity(paths), /recorded start/)
})

test('a foreign or unexpected preference file is refused lexically before any filesystem probe', t => {
  const { paths, file } = owned(t)
  const noProbe = { lstatSync() { assert.fail('A foreign preference path was probed') } }
  assert.throws(() => ownedPreferenceFile(paths, path.join(paths.qaRoot, '..', 'owner', 'renderer-prefs.json'), noProbe), /exact QA user-data file/)
  assert.throws(() => ownedPreferenceFile({ qaRoot: path.join(paths.qaRoot, 'another-run'), userData: paths.userData }, file, noProbe), /inside this owned QA launch/)
})

test('a role-independent preference guard refuses links and shared durable files', t => {
  const { paths, file } = owned(t)
  const hardlink = path.join(paths.qaRoot, 'shared.json'); linkSync(file, hardlink)
  assert.throws(() => readPreferenceFile(paths, file), /hard-linked/)
  rmSync(hardlink)
  const redirect = path.join(paths.qaRoot, 'redirect')
  symlinkSync(paths.userData, redirect, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readPreferenceFile({ ...paths, userData: redirect }, path.join(redirect, 'renderer-prefs.json')), /link or junction/)
})

test('the six held cases have distinct preference identities and only the actual setup prerequisite', () => {
  assert.equal(scenarios.length, 6)
  assert.equal(new Set(scenarios.map(item => item.id)).size, 6)
  assert.equal(new Set(scenarios.flatMap(item => item.controls)).size, 6)
  for (const scenario of scenarios) assert.deepEqual(scenario.requires, ['setup'])
})
