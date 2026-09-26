/* B22 leftover: a delete-on-exit cleanup the app held (an earlier session's
 * Ledger operation it may not continue) must be told to the person, beside
 * the setting, without claiming what the earlier close did or promising that
 * the next close finishes it. The startup log says only what this launch did. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createSettingsDraft } from '../../src/settings-draft.js'
import * as transcriptSettings from '../../src/transcript-settings.js'
const { createTranscriptSettings } = transcriptSettings
const { createNodePrivacyCleanup, HELD_KEY } = createRequire(import.meta.url)('../../shell/node-privacy-cleanup.cjs')

const mainSource = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const saved = deleteNodesOnExit => ({ archiveDirectory: '/archive', archiveMaxBytes: 256 * 1024 * 1024, deleteNodesOnExit })

async function settingsMarkup(answer) {
  const handlers = new Map(), panel = { outerHTML: '' }
  const controller = createTranscriptSettings({ draft: createSettingsDraft(), bridge: {
    getSettings: async () => answer,
    configure: async value => ({ ok: true, transcript: value }),
  } })
  controller.bind({ addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener() {}, querySelector: () => panel })
  controller.afterRender()
  await new Promise(resolve => setImmediate(resolve))
  const html = controller.markup()
  controller.destroy()
  return html
}
const heldNote = html => html.match(/<p[^>]*data-transcript-privacy-held[^>]*>([^<]*)<\/p>/)?.[1] ?? null

test('Data & Privacy says, beside the setting, that a held delete-on-exit did not finish (setting on)', async () => {
  const html = await settingsMarkup({ ok: true, transcript: saved(true), privacyCleanupHeld: true })
  const note = heldNote(html)
  assert.ok(note, 'the held note is shown')
  assert.ok(html.indexOf('data-transcript-privacy-held') > html.indexOf('data-transcript-delete'), 'the note sits after the setting')
  assert.match(note, /did not finish/)
  assert.match(note, /may still be on this computer/)
  assert.match(note, /Remove this agent/)
  assert.match(note, /tries again at the next close/)
  assert.doesNotMatch(note, /were deleted|nothing was deleted|will be deleted/i, 'it claims nothing it cannot know')
})

test('the held note says filing tasks is paused, which is what an unfinished delete holds', async () => {
  for (const on of [true, false]) {
    const note = heldNote(await settingsMarkup({ ok: true, transcript: saved(on), privacyCleanupHeld: true }))
    assert.match(note, /filing tasks is paused/)
  }
})

/* c5 review: A KEPT OPERATION IS NOT THE LAST CLOSE. After a later close with
   the setting on deleted everything under its own operation, the earlier one
   stays unfinished in the task list for good, and heldCleanup() reports it at
   every launch. The held note then said the last close did not finish (it
   did), that it tries again (nothing does), and to remove agents (which cannot
   clear it), and never that filing tasks stays paused. */
test('a kept earlier operation gets its own note: filing tasks stays paused, the later close did its job', async () => {
  for (const on of [true, false]) {
    const html = await settingsMarkup({ ok: true, transcript: saved(on), privacyCleanupHeld: true, privacyCleanupKept: true })
    const note = heldNote(html)
    assert.ok(note, 'the note is shown')
    assert.match(note, /filing tasks stays paused/)
    assert.match(note, /later close deleted your agents/)
    assert.doesNotMatch(note, /last closed did not finish|tries again|Remove this agent|Turn it on/,
      'THE DEFECT: the kept note repeats the held note, which is false for it')
  }
})

test('heldCleanup() marks an operation kept on record, and not one this launch could not continue', async () => {
  const values = {}
  const prefs = {
    snapshot: () => ({ ok: true, values: { ...values } }),
    set: (key, value) => { values[key] = value; return { ok: true } },
    remove: key => { delete values[key]; return { ok: true } },
  }
  const cleanup = createNodePrivacyCleanup({ prefs, org: { resetOrg: () => ({ ok: true }) }, transcripts: { clearForPrivacy: async () => {} } })
  assert.equal(cleanup.heldCleanup(), null)
  values[HELD_KEY] = JSON.stringify([{ operationId: 'privacy-earlier', code: 'T_LEDGER_WRITER_POLICY_DENIED' }])
  assert.equal(cleanup.heldCleanup()?.operationId, 'privacy-earlier')
  assert.equal(cleanup.heldCleanup()?.kept, true, 'an operation kept on record says so')
})

test('with the setting off, the held note says it does not try again and how to act', async () => {
  const note = heldNote(await settingsMarkup({ ok: true, transcript: saved(false), privacyCleanupHeld: true }))
  assert.ok(note)
  assert.match(note, /does not try again while this setting is off/)
  assert.match(note, /Turn it on/)
  assert.doesNotMatch(note, /tries again at the next close/)
})

test('no note when nothing is held', async () => {
  assert.equal(heldNote(await settingsMarkup({ ok: true, transcript: saved(true) })), null)
  assert.equal(heldNote(await settingsMarkup({ ok: true, transcript: saved(true), privacyCleanupHeld: false })), null)
})

test('the note sentences stay plain: at most 25 words each', () => {
  assert.ok(transcriptSettings.PRIVACY_HELD_COPY, 'the note copy is exported for the plain-language gate')
  for (const text of Object.values(transcriptSettings.PRIVACY_HELD_COPY)) {
    for (const sentence of text.split(/(?<=\.)\s+/)) assert.ok(sentence.split(/\s+/).length <= 25, sentence)
  }
})

test('main answers getSettings with the held flag beside the settings, from the privacy cleanup', () => {
  const start = mainSource.indexOf('const withPrivacyCleanupHold')
  assert.ok(start >= 0, 'main has the held-flag helper')
  const end = mainSource.indexOf('\n}\n', start) + 2
  const helper = cleanup => new Function('nodePrivacyCleanup', `${mainSource.slice(start, end)}\nreturn withPrivacyCleanupHold`)(cleanup)
  const settingsAnswer = { ok: true, transcript: saved(true) }
  assert.deepEqual(helper({ heldCleanup: () => ({ operationId: 'privacy-1', code: 'T_LEDGER_WRITER_POLICY_DENIED' }) })(settingsAnswer),
    { ...settingsAnswer, privacyCleanupHeld: true })
  assert.deepEqual(helper({ heldCleanup: () => ({ operationId: 'privacy-0', code: 'T_LEDGER_WRITER_POLICY_DENIED', kept: true }) })(settingsAnswer),
    { ...settingsAnswer, privacyCleanupHeld: true, privacyCleanupKept: true }, 'a kept operation is told apart')
  assert.equal(helper({ heldCleanup: () => null })(settingsAnswer), settingsAnswer)
  const refused = { ok: false, error: { message: 'x' } }
  assert.equal(helper({ heldCleanup: () => ({ operationId: 'privacy-1' }) })(refused), refused)
  assert.match(mainSource, /if \(operation === 'getSettings'\) return withConversationStorageState\(withPrivacyCleanupHold\(await nodeTranscripts\.getSettings\(request\)\)\)/,
    'the getSettings route carries the flag')
})

test('the startup log for a held cleanup says this launch deleted nothing, and promises no retry', async () => {
  const startup = mainSource.match(/^\s*return (initializeSavedDraftGraphReader\(\)(?:\n\s*\.then\([^\n]+\))+)/m)?.[1]
  assert.ok(startup, 'the startup chain is available')
  const logged = []
  const run = new Function('nodePrivacyCleanup', 'initializeNodeRecovery', 'initializeSavedDraftGraphReader', 'recoverFullResetOwnerGone',
    'showElevatedRunWarning', 'createWindow', 'console', `return ${startup}`)
  const opened = await run(
    { recover: async () => ({ ok: false, held: true, operationId: 'privacy-1', code: 'T_LEDGER_WRITER_POLICY_DENIED' }) },
    async () => {}, async () => {}, () => ({ ok: true, unchanged: true }), async () => {}, () => 'opened',
    { error: line => logged.push(line), log() {}, warn() {} })
  assert.equal(opened, 'opened')
  assert.equal(logged.length, 1)
  assert.match(logged[0], /privacy-1/)
  assert.match(logged[0], /this launch deleted nothing/)
  assert.doesNotMatch(logged[0], /nothing was deleted|runs again at the next quit/)
})
