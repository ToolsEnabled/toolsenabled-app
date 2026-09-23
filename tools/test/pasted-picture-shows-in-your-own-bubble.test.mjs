/* THE PICTURE YOU PASTED SHOWS UP IN THE MESSAGE YOU SENT.
 *
 * The owner, 2026-09-17: "why does my images still not get put into chat".
 *
 * Six paste suites are green and all six stop short of this. They prove the
 * bytes reach the main process, that a file is saved, that a chip appears and
 * that the saved PATH rides the turn to the provider. Not one of them asks
 * what the person SEES after pressing Enter, and the answer was: the words,
 * and nothing else. Measured at 547eaf99, src/components.js creates no <img>
 * element anywhere -- searched both by tag literal and by createElement -- so
 * no chat surface in this product has ever drawn a picture in a bubble.
 *
 * WHAT THESE CASES COVER, AND WHAT THEY DO NOT.
 * They cover the PASTE path only, and only for the lifetime of the mounted
 * composer. The bytes drawn here are the ones the paste handler already read
 * off the clipboard and still has in hand; nothing re-reads the saved file.
 * A reopened conversation, and a picture chosen through the file picker
 * rather than pasted, still show no image -- that needs a main-process route
 * to serve a session's own attachment bytes back to the window, which is
 * filed separately as T290 and is not this commit. These cases are written so
 * that work can be added without rewriting them: they assert what a bubble
 * shows given a picture in hand, not where the picture came from.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { attachmentFilenameText } from '../../src/chat-copy.js'

const { createImageRetentionService } = createRequire(import.meta.url)('../../shell/image-retention-service.cjs')
const digest = value => createHash('sha256').update(value).digest('hex')

const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
/* SUCCESSIVE TURNS, not one long wait. The mounted surface resolves a chain of
   promises and each link needs its own macrotask; a single setTimeout(30) lets
   the clock run but not the chain, so the surface reads as never having come
   up. Same helper, same reason, as agent-session-standalone-approvals. */
const settle = async (turns = 12) => { for (let i = 0; i < turns; i += 1) await tick() }

/* Shaped the way the composer's own paste handler reads a clipboard item --
   `.type` and `.getAsFile()` -- the same seam chat-paste-attachment.test.mjs
   fakes, and for the same reason: no dependency on a real File or DataTransfer. */
const imageClipboardItem = (type, bytes) => ({
  type,
  getAsFile: () => ({ arrayBuffer: async () => Uint8Array.from(bytes).buffer }),
})

const PNG_BYTES = [...Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')]
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64')
const SAVED_PATH = 'C:\\fake\\paste-attachments\\img-1.png'

function mount({ saved = null } = {}) {
  const sent = []
  const root = buildChat({
    title: 'agent',
    seed: 0,
    onSend: (text, context) => { sent.push({ text, context }) },
    onPasteAttachment: async () => saved,
  })
  dom.document.body.appendChild(root)
  return { root, sent, input: root.querySelector('.chat-input input') }
}

async function pasteThenSend(fixture, { words = 'what is in this picture?', bytes = PNG_BYTES, mime = 'image/png' } = {}) {
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem(mime, bytes)] } })
  await tick()
  fixture.input.value = words
  fixture.input.dispatch('keydown', { key: 'Enter' })
  await tick()
}

/* NOT `.msg.me`. The DOM stand-in's querySelectorAll does not implement a
   compound class selector, and it does not say so -- it returns an empty list,
   which reads exactly like "the bubble was never drawn". That cost this suite
   its first RED: three cases failed with "no owner message" while the row was
   sitting in the log with className "msg me". Filtering the class list here is
   the same question asked in a way the instrument can actually answer. */
const ownBubbles = root => root.querySelectorAll('.msg').filter(row => row.className.split(/\s+/).includes('me'))

test('the picture you pasted is drawn in your own message, not just named in a chip', async () => {
  const fixture = mount({ saved: { ok: true, path: SAVED_PATH, size: 8 } })

  /* CONTROL: before the send there is no owner bubble at all, so a picture
     found below cannot be something the surface was already showing. */
  assert.equal(ownBubbles(fixture.root).length, 0, 'the log was not empty before the send, so this case measures nothing')

  await pasteThenSend(fixture)

  const bubbles = ownBubbles(fixture.root)
  assert.equal(bubbles.length, 1, 'exactly one message of the person own must have been drawn')
  const bubble = bubbles[0]
  assert.ok(bubble.textContent.includes('what is in this picture?'), 'the words must still be there')

  const pictures = bubble.querySelectorAll('img')
  assert.equal(pictures.length, 1, 'THE DEFECT: the sender own message carries no picture')
  assert.equal(pictures[0].getAttribute('src'), `data:image/png;base64,${PNG_BASE64}`,
    'the drawn picture is not the bytes that were pasted')
  assert.equal(pictures[0].getAttribute('alt'), attachmentFilenameText(SAVED_PATH),
    'a picture with no name for a screen reader would fail')
})

test('the bytes are drawn locally and are not added to what the send carries', async () => {
  const fixture = mount({ saved: { ok: true, path: SAVED_PATH, size: 8 } })
  await pasteThenSend(fixture)

  assert.equal(fixture.sent.length, 1, 'the send did not happen, so nothing below is measured')
  const attachments = fixture.sent[0].context?.attachments || []
  assert.deepEqual(attachments.map(item => item.path), [SAVED_PATH],
    'the saved path must still be what rides the turn')
  /* A picture is megabytes. Carrying it a second time across the window
     boundary, when the main process already wrote the file and the provider
     is sent the path, would be a cost the person pays for nothing. */
  const carried = JSON.stringify(fixture.sent[0].context)
  assert.equal(carried.includes(PNG_BASE64), false,
    'the pasted bytes reached the sender, so the picture now crosses the boundary twice')
})

test('one pasted picture is drawn once, and does not follow later messages', async () => {
  const fixture = mount({ saved: { ok: true, path: SAVED_PATH, size: 8 } })
  await pasteThenSend(fixture)
  fixture.input.value = 'and what about this sentence'
  fixture.input.dispatch('keydown', { key: 'Enter' })
  await tick()

  const bubbles = ownBubbles(fixture.root)
  assert.equal(bubbles.length, 2, 'the second message was not drawn, so this case measures nothing')
  assert.equal(bubbles[0].querySelectorAll('img').length, 1, 'the first message lost its picture')
  assert.equal(bubbles[1].querySelectorAll('img').length, 0,
    'the picture followed a later message it was never attached to')
})

test('a picture the main process refused is not drawn, and neither is one of a kind this product does not accept', async () => {
  /* NEGATIVE CONTROL 1: nothing was saved, so there is no attachment and must
     be no picture -- otherwise a person would see an image in their own
     message that the agent was never sent. */
  const refused = mount({ saved: { ok: false, path: 'C:\\fake\\refused.png' } })
  await pasteThenSend(refused)
  assert.equal(ownBubbles(refused.root)[0].querySelectorAll('img').length, 0,
    'a refused paste drew a picture the agent never received')

  /* NEGATIVE CONTROL 2: the src of a drawn picture is a data: URL built from
     a mime this file chooses, so the set of kinds it will build one for is
     closed. An item type outside that set must draw nothing rather than put
     an arbitrary media type into a URL. */
  const odd = mount({ saved: { ok: true, path: 'C:\\fake\\odd.bin', size: 8 } })
  await pasteThenSend(odd, { mime: 'image/svg+xml' })
  assert.equal(ownBubbles(odd.root)[0].querySelectorAll('img').length, 0,
    'a kind outside the accepted set was drawn anyway')
})

/* THE + SURFACE, MOUNTED FOR REAL, because it is the second of the two
   surfaces this was asked for and because its paste path is not the tree's.
   src/agent-session.js does not save a file on paste at all: it answers with a
   COMPOSER TOKEN -- `pending-paste:<statusId>/Pasted image 1.png` -- and holds
   the bytes until the first send owns a session. That token is not a
   filesystem path, and it is the string the bubble has to match a picture by.
   Reasoning that "both surfaces call buildChat so both are fixed" is exactly
   the kind of claim that failed an acceptance here before, so this mounts the
   real surface and drives a real paste through it. */
const mountPlusSurface = async (t) => {
  const store = new Map([['mc.write.agent-session', 'enabled']])
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  const sends = []
  /* Use the repository's real image-retention service here. The + surface
     cannot honestly prove its picture path with start/send stubs: its native
     custody route authenticates an owner, retains bytes, binds a conversation,
     and dispatches a durable image row before the bubble is painted. */
  const imageTemp = process.env.IMAGE_TEST_TEMP
  assert.ok(imageTemp, 'strict retained image fixture environment is required')
  const custodyFixtureRoot = fs.mkdtempSync(path.join(fs.realpathSync(imageTemp), 'picture-bubble-'))
  const sourcePath = path.join(custodyFixtureRoot, 'pasted.png')
  const ownerContext = Object.freeze({
    version: 1, ownerId: 'picture-fixture-owner', currentEpoch: 'picture-fixture-epoch', kind: 'local',
  })
  const transcriptBindings = []
  const pastedDigests = []
  const retentionInputDigests = []
  const deliveredDigests = []
  const sessions = new Map()
  let activeSessionId = null
  const authority = request => {
    const record = sessions.get(request.sessionId)
    assert.ok(record, 'image custody was addressed to a session that never started')
    return {
      session: record.session,
      sessionId: request.sessionId,
      accountId: 'picture-fixture-account',
      provider: 'codex',
      model: 'fixture-model',
      effort: null,
      issued: record.issued,
    }
  }
  const transcript = {
    async bind(sessionId, seatId) {
      assert.ok(sessions.has(sessionId), 'transcript binding requires the native start receipt')
      transcriptBindings.push({ sessionId, seatId })
      return { ok: true }
    },
  }
  const imageService = createImageRetentionService({
    root: path.join(custodyFixtureRoot, 'retained'),
    authenticate: context => {
      assert.deepEqual(context, ownerContext)
      return { authenticated: true, productOwnerId: ownerContext.ownerId, currentEpoch: ownerContext.currentEpoch }
    },
    sourceAuthority: authority,
    candidateAuthority: authority,
    authorizeTransfer: ({ destinationSessionId }) => destinationSessionId === activeSessionId,
    engineImageBytes: 8 * 1024 * 1024,
  })
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    ownerContext: async () => ownerContext,
    onOwnerContextChanged: () => () => {},
    onEvent: () => () => {},
    start: async value => {
      activeSessionId = value.sessionId
      sessions.set(activeSessionId, { session: {}, issued: new Set() })
      const bound = await transcript.bind(activeSessionId, 'plus-surface')
      assert.equal(bound.ok, true)
      return { ok: true, sessionId: activeSessionId }
    },
    send: async value => { sends.push(value); return { ok: true, turnId: `turn-${sends.length}` } },
    imageQueue: async request => {
      if (request.operation === 'binding') {
        assert.ok(transcriptBindings.some(binding => binding.sessionId === request.sessionId),
          'image admission preceded transcript binding')
        return {
          ok: true, operation: 'binding', operationId: null,
          result: { sessionId: request.sessionId, conversationId: 'plus-surface', ownerContext },
        }
      }
      if (request.operation === 'dispatch') {
        const result = await imageService.dispatch(request, request.ownerContext, async turn => {
          const bytes = turn.images.map(image => fs.readFileSync(image.path))
          deliveredDigests.push(...bytes.map(digest))
          return { ok: true, deliveryDisposition: 'accepted', result: { turnId: 'image-turn' } }
        })
        return {
          ...result,
          operation: 'dispatch',
          operationId: request.operationId,
          sessionId: request.sessionId,
          conversationId: request.conversationId,
          envelopeId: request.envelopeId,
          ownerContext: request.ownerContext,
        }
      }
      if (request.operation === 'retain') {
        retentionInputDigests.push(...request.images.map(image => digest(fs.readFileSync(image.path))))
      }
      const serviceRequest = request.operation === 'admit' && !request.selection
        ? { ...request, selection: { model: 'fixture-model', effort: null } }
        : request
      return imageService.run(serviceRequest, request.ownerContext)
    },
    interrupt: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
    pasteAttachment: async value => {
      assert.equal(value.mime, 'image/png')
      assert.equal(value.data, PNG_BASE64, 'the native paste handoff changed the pasted PNG bytes')
      const record = sessions.get(value.sessionId)
      assert.ok(record, 'paste retention used a session that never started')
      fs.writeFileSync(sourcePath, Buffer.from(value.data, 'base64'), { encoding: 'binary', flag: 'wx' })
      record.issued.add(sourcePath)
      pastedDigests.push(digest(fs.readFileSync(sourcePath)))
      return { ok: true, path: sourcePath, size: PNG_BYTES.length }
    },
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = dom.document.createElement('div')
  dom.document.body.appendChild(root)
  const dispose = mountAgentSessionSurface(root, {
    live: true, agentId: 'plus-surface', bridge, chatComposer: true,
    chatTitle: 'New agent', publishSession: false,
  })
  t.after(() => {
    try { dispose?.() } catch { /* already gone */ }
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  })
  await settle()
  return { root, sends, pastedDigests, retentionInputDigests, deliveredDigests, transcriptBindings }
}

test('the + surface draws the pasted picture too, over its own pending-paste token', async t => {
  const { root, pastedDigests, retentionInputDigests, deliveredDigests, transcriptBindings } = await mountPlusSurface(t)
  const input = root.querySelector('.chat-input input')
  assert.ok(input, 'the + surface did not mount a composer, so this case measures nothing')

  input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', PNG_BYTES)] } })
  await settle()
  assert.equal(root.querySelectorAll('.chat-attachment-chip').length, 1,
    'the paste never became an attachment on the + surface, so the picture below would be measuring the wrong thing')

  input.value = 'what is in this picture?'
  input.dispatch('keydown', { key: 'Enter' })
  await settle()

  const bubbles = ownBubbles(root)
  assert.equal(bubbles.length, 1, 'the + surface drew no message of the person own')
  const expectedDigest = digest(Buffer.from(PNG_BYTES))
  assert.deepEqual(transcriptBindings.map(binding => binding.seatId), ['plus-surface'],
    'the image conversation was admitted without a transcript binding')
  assert.deepEqual(pastedDigests, [expectedDigest], 'the native paste handoff changed the source bytes')
  assert.deepEqual(retentionInputDigests, [expectedDigest], 'the retention input bytes differed from the pasted PNG')
  assert.deepEqual(deliveredDigests, [expectedDigest], 'the dispatch path delivered bytes other than the retained PNG')
  const pictures = bubbles[0].querySelectorAll('img')
  assert.equal(pictures.length, 1, 'THE DEFECT, on the + surface: the sender own message carries no picture')
  assert.equal(pictures[0].getAttribute('src'), `data:image/png;base64,${PNG_BASE64}`,
    'the + surface drew something other than the bytes that were pasted')
})
