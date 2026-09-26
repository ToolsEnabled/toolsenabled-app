import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FINDING_CLAIM_MAX,
  buildFindingSave,
  findingStateWord,
  readFindings,
  saveFinding,
} from '../../src/research-findings.js'

/* The findings client: pure shapes in, the bridge envelope out VERBATIM on
   failure, and a receipt that must actually name the finding to count. */

test('finding state words are plain and unknown states render as themselves', () => {
  assert.equal(findingStateWord('open'), 'open')
  assert.equal(findingStateWord('confirmed'), 'confirmed')
  assert.equal(findingStateWord('refuted'), 'refuted')
  assert.equal(findingStateWord('superseded'), 'superseded')
  assert.equal(findingStateWord('something_new'), 'something_new')
  assert.equal(findingStateWord(undefined), 'unrecorded')
})

test('buildFindingSave refuses what cannot travel, with a sentence a person can act on', () => {
  const noProject = buildFindingSave({ claim: 'a claim' })
  assert.equal(noProject.ok, false)
  assert.match(noProject.sentence, /pick one above/)

  const noClaim = buildFindingSave({ projectId: 'rp-1', claim: '   ' })
  assert.equal(noClaim.ok, false)
  assert.match(noClaim.sentence, /Write the claim first/)

  const oversize = buildFindingSave({ projectId: 'rp-1', claim: 'x'.repeat(FINDING_CLAIM_MAX + 1) })
  assert.equal(oversize.ok, false)
  assert.match(oversize.sentence, /Shorten it/)
})

test('buildFindingSave trims the claim and defaults the status to open', () => {
  const built = buildFindingSave({ projectId: 'rp-1', claim: '  the retries recovered nine of eleven  ' })
  assert.equal(built.ok, true)
  assert.deepEqual(built.body, { projectId: 'rp-1', claim: 'the retries recovered nine of eleven', status: 'open' })
  const explicit = buildFindingSave({ projectId: 'rp-1', claim: 'held', status: 'confirmed' })
  assert.equal(explicit.body.status, 'confirmed')
})

test('saveFinding passes the bridge refusal through verbatim, as the same object', async () => {
  const refusal = { ok: false, reason: 'The research pipeline is switched off in settings.', code: 'RESEARCH_PIPELINE_DISABLED' }
  const passed = await saveFinding({ projectId: 'rp-1', claim: 'a claim' }, { postAction: async () => refusal })
  assert.equal(passed, refusal, 'the envelope must survive untouched, not be re-worded')
})

test('saveFinding posts the shaped body and unwraps the receipt', async () => {
  const saved = await saveFinding({ projectId: 'rp-1', claim: ' a claim ' }, {
    postAction: async (action, body) => {
      assert.equal(action, 'research-finding-save')
      assert.deepEqual(body, { projectId: 'rp-1', claim: 'a claim', status: 'open' })
      return { ok: true, receipt: { findingId: 'rf-9' } }
    },
  })
  assert.deepEqual(saved, { ok: true, findingId: 'rf-9' })
})

test('a receipt without the finding name is a refusal, never a silent success', async () => {
  const hollow = await saveFinding({ projectId: 'rp-1', claim: 'a claim' }, { postAction: async () => ({ ok: true, receipt: {} }) })
  assert.equal(hollow.ok, false)
  assert.equal(hollow.code, 'RESEARCH_FINDING_RECEIPT_INVALID')
  const absent = await saveFinding({ projectId: 'rp-1', claim: 'a claim' }, { postAction: async () => undefined })
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /did not reach/)
})

test('readFindings passes the envelope through verbatim and validates the list shape', async () => {
  const refusal = { ok: false, reason: 'down', code: 'BRIDGE_UNREACHABLE' }
  const passed = await readFindings('rp-1', { postAction: async () => refusal })
  assert.equal(passed, refusal, 'the envelope must survive untouched')

  const hollow = await readFindings('rp-1', { postAction: async () => ({ ok: true, receipt: {} }) })
  assert.equal(hollow.code, 'RESEARCH_FINDINGS_INVALID')

  const good = await readFindings('rp-1', {
    postAction: async (action, body) => {
      assert.equal(action, 'research-findings')
      assert.deepEqual(body, { projectId: 'rp-1' })
      return { ok: true, receipt: { findings: [{ findingId: 'rf-1', claim: 'held', status: 'open' }] } }
    },
  })
  assert.equal(good.ok, true)
  assert.equal(good.findings.length, 1)
  assert.equal(good.findings[0].findingId, 'rf-1')

  const absent = await readFindings('rp-1', { postAction: async () => null })
  assert.equal(absent.ok, false)
  assert.match(absent.reason, /did not answer/)
})
