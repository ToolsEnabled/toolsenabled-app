/* A real native image refusal must reach both actual chat surfaces. The
 * fixture runs production custody and dispatch over private IPC. Provider
 * activity/transport alone are synthetic; no refusal or admission is invented. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pastePictureInRealWindow } from './helpers/paste-picture-native.mjs'
import { sendRefusalSentence } from '../../src/fleet-tree-copy.js'

test('an unsupported picture stays saved and visibly not sent on both surfaces, without sending the words alone', async t => {
  const { observations, evidence } = await pastePictureInRealWindow({ provider: 'local' })
  t.diagnostic('evidence: ' + evidence)

  assert.equal(observations.failure, undefined, 'the window run failed: ' + JSON.stringify(observations.failure))
  assert.deepEqual(observations.pageErrors, [], 'the real window logged renderer errors')
  assert.equal(observations.surfaces.length, 2, 'both surfaces must be exercised')

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'
    assert.equal(surface.provider, 'local')
    assert.equal(surface.pasted.pastedCalls, 1, `the paste never reached the attachment seam in ${where}`)
    assert.equal(surface.result.sent.length, 0, `neither words nor images may be sent from ${where}`)
    const dispatch = surface.result.operations.find(row => row.operation === 'dispatch')
    assert.equal(dispatch.code, 'IMAGE_CUSTODY_PROVIDER_UNSUPPORTED')
    assert.equal(dispatch.deliveryDisposition, 'not-sent')
    assert.equal(dispatch.result.entries[0].state, 'not-sent')
    assert.equal(dispatch.result.entries[0].text, 'what is in this picture?')
    const said = surface.result.diagnostic.text || ''
    assert.match(said, /cannot receive images.*Choose an agent with image support/s)
    assert.match(said, /Saved · not sent/)
    assert.doesNotMatch(said, /message was sent without it|Image message accepted/)
  }
})

/* Revoke the issued capability before the real command-surface send gate. */
test('a revoked picture grant refuses with actionable image advice instead of unconfirmed delivery', async t => {
  const { observations, evidence } = await pastePictureInRealWindow({ revokeAttachment: true })
  t.diagnostic('evidence: ' + evidence)

  assert.equal(observations.failure, undefined, 'the window run failed: ' + JSON.stringify(observations.failure))
  assert.deepEqual(observations.pageErrors, [], 'the real window logged renderer errors')
  assert.equal(observations.surfaces.length, 2, 'both surfaces must be exercised')

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'
    assert.equal(surface.revokeAttachment, true)
    assert.equal(surface.pasted.pastedCalls, 1, `the paste never reached the attachment seam in ${where}`)
    assert.equal(surface.result.sent.length, 0, 'a revoked grant must never reach the provider')
    const dispatch = surface.result.operations.find(row => row.operation === 'dispatch')
    assert.equal(dispatch.code, 'MC_AGENT_ATTACHMENT_UNKNOWN')
    assert.equal(dispatch.deliveryDisposition, 'not-sent')
    assert.equal(dispatch.result.entries[0].state, 'not-sent')
    const diagnostic = surface.result.diagnostic
    const notes = diagnostic.noteMessages || []
    const generic = [sendRefusalSentence('A_CODE_NO_TABLE_IN_THIS_PRODUCT_KNOWS'), sendRefusalSentence('MC_AGENT_UNKNOWN_SESSION')]
    for (const fallback of generic) assert.ok(!notes.some(note => note.includes(fallback)),
      `${where} answered an image refusal with unrelated advice: ${JSON.stringify(notes)}`)
    assert.ok(notes.some(note => note.includes(sendRefusalSentence('MC_AGENT_ATTACHMENT_UNKNOWN'))),
      `${where} showed no actionable image refusal: ${JSON.stringify(notes)}`)
    assert.match(diagnostic.text, /Saved · not sent/)
    assert.doesNotMatch(diagnostic.text, /Delivery unconfirmed|Image message accepted/)
  }
})

test('a picture that DID ride the turn adds no such sentence', async t => {
  /* THE CONTROL, and it is what makes the case above mean something: the same
     window, the same paste, the same Enter, with the host answering an ordinary
     receipt. A surface that simply always printed a line would pass the first
     test and fail this one. */
  const { observations, evidence } = await pastePictureInRealWindow()
  t.diagnostic('evidence: ' + evidence)
  assert.equal(observations.failure, undefined, 'the control run failed: ' + JSON.stringify(observations.failure))

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'
    assert.equal(surface.provider, 'claude')
    assert.equal(surface.revokeAttachment, false)
    assert.equal(surface.result.sent.length, 1)
    assert.notEqual(surface.result.sent[0].images[0].path, surface.result.pasted[0].path)
    assert.equal(surface.result.sent[0].imageBytes[0], surface.result.pasted[0].data,
      `the pasted picture did not ride the turn sent from ${where}`)
    const notes = surface.result.diagnostic.noteMessages || []
    assert.ok(!notes.some(note => note.includes('was not sent')),
      `${where} told the person a delivered picture had not been sent: ${JSON.stringify(notes)}`)
  }
})
