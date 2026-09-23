/* CTRL+V, IMAGE TO THE AGENT -- the owner, verbatim (R10): "I still cant
 * control V and image to you please get that fixed".
 *
 * Controller's ruling this pins: the bytes an attachment is built from come
 * ONLY from the renderer's own paste event -- never Electron's
 * clipboard.readImage() in the main process, which would read whatever is on
 * the clipboard at whatever moment the call happens (ambient machine state)
 * rather than the person's own explicit gesture. This suite mounts the REAL
 * buildChat and dispatches a REAL paste event on the REAL input element, the
 * same "real elements, real values" posture tools/test/chat-queue-doors.test.mjs
 * already established for this file -- a source pin proves a wire is
 * attached; it cannot prove what comes out the other end.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { restore } = installDomStandIn(globalThis)

const { buildChat } = await import('../../src/components.js')
const { PALETTE_PANEL, pasteRefusalSentence } = await import('../../src/fleet-tree-copy.js')
const { refusalCode, unavailableReason } = await import('../../src/agent-availability-copy.js')

// Execute Page 2's real adapter, with only the rejected IPC call substituted.
// A resolved sentence stub cannot reveal a lost code at Electron's boundary.
const page2Source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const pasteAdapter = page2Source.match(/onPasteAttachment: (async \(data, mime\) => \{[\s\S]*?\n      \}) \} : \{\}\)/)
assert.ok(pasteAdapter, 'Page 2 must keep the paste adapter wired')
const makePage2Paste = new Function('pasteAttachment', 'node', 'pasteRefusalSentence',
  `const liveSessionId = () => node.sessionId; return (${pasteAdapter[1]})`)

after(() => restore())

/* A clipboard item shaped exactly the way this component's own paste handler
   reads one -- `.type` and `.getAsFile()` -- with no dependency on a real
   browser File/Blob/DataTransfer, the same "fake the seam, not the browser"
   posture the rest of this fixture already takes for status/queue. */
function imageClipboardItem(type, byteArray) {
  return {
    type,
    getAsFile: () => ({ arrayBuffer: async () => Uint8Array.from(byteArray).buffer }),
  }
}
function textClipboardItem(text) {
  return { type: 'text/plain', getAsFile: () => null, getAsString: (cb) => cb(text) }
}

function mount({ onPasteAttachment = null } = {}) {
  const calls = []
  const root = buildChat({
    title: 'agent',
    seed: 0,
    onAttach: async () => ({ ok: true, path: 'C:\\fake\\dialog-picked.png' }),
    ...(onPasteAttachment ? { onPasteAttachment: async (data, mime) => {
      calls.push({ data, mime })
      return onPasteAttachment(data, mime)
    } } : {}),
  })
  const input = root.querySelector('.chat-input input')
  return { root, input, calls }
}

test('pasting an image on the composer input reaches onPasteAttachment with the pasted bytes, base64, and adds the chip', async () => {
  const fixture = mount({
    onPasteAttachment: async () => ({ ok: true, path: 'C:\\fake\\paste-attachments\\img-1.png', size: 4 }),
  })
  const pngMagic = [0x89, 0x50, 0x4e, 0x47]
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', pngMagic)] } })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.calls.length, 1, 'the paste never reached onPasteAttachment')
  assert.equal(fixture.calls[0].mime, 'image/png', 'the mime the clipboard item carried did not reach the caller')
  assert.equal(fixture.calls[0].data, Buffer.from(pngMagic).toString('base64'),
    'the base64 handed to onPasteAttachment does not decode back to the exact bytes that were pasted')

  const strip = fixture.root.querySelector('.chat-attach-strip')
  assert.equal(strip.hidden, false, 'a successfully attached paste left the attachment strip hidden')
  assert.match(strip.textContent, /img-1\.png/, 'the pasted attachment did not appear in the strip')
  fixture.root.dispose()
})

test('pasting plain text never reaches onPasteAttachment and is not claimed by this listener', async () => {
  const fixture = mount({ onPasteAttachment: async () => ({ ok: true, path: 'should-not-be-called' }) })
  const event = fixture.input.dispatch('paste', { clipboardData: { items: [textClipboardItem('hello')] } })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(fixture.calls.length, 0, 'an ordinary text paste was treated as an image attachment')
  assert.notEqual(event.defaultPrevented, true, 'a plain text paste was claimed by the image listener, which would swallow the browser\'s own paste-into-the-box')
  fixture.root.dispose()
})

test('a paste that fails shows the resolved sentence, never a raw error code, and does not attach', async () => {
  const fixture = mount({ onPasteAttachment: async () => ({ ok: false, sentence: PALETTE_PANEL.pasteTooLarge }) })
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [1, 2, 3])] } })
  await new Promise(resolve => setTimeout(resolve, 0))

  const notes = fixture.root.querySelectorAll('.msg')
    .filter(node => node.classList.contains('note'))
    .map(node => node.textContent)
  assert.ok(notes.some(text => text.includes(PALETTE_PANEL.pasteTooLarge)), 'the too-large refusal sentence never reached the log')
  const strip = fixture.root.querySelector('.chat-attach-strip')
  assert.equal(strip.hidden, true, 'a refused paste still added a chip to the attachment strip')
  fixture.root.dispose()
})

test('paste refusal copy recognizes the exact size code through Electron wrapping and never prints error text', () => {
  const code = 'MC_AGENT_PASTE_IMAGE_TOO_LARGE'
  for (const error of [
    { code },
    new Error(code),
    new Error(`Error invoking remote method 'mc-agent:paste-attachment': Error: ${code}`),
  ]) assert.equal(pasteRefusalSentence(error), PALETTE_PANEL.pasteTooLarge)

  for (const error of [
    undefined, null, {}, { code: 7 },
    new Error(`PREFIX_${code}`),
    new Error(`${code}_EXTRA`),
    new Error(`prefix${code}`),
    new Error('C:\\fixture\\private.png <script>untrusted</script>'),
  ]) assert.equal(pasteRefusalSentence(error), PALETTE_PANEL.pasteFailed)
  for (const classified of ['MC_AGENT_PASTE_REQUIRES_WINDOW', 'MC_AGENT_PASTE_UNAVAILABLE']) {
    assert.equal(pasteRefusalSentence({ code: classified }), unavailableReason(classified))
    assert.equal(pasteRefusalSentence(new Error(classified)), unavailableReason(classified))
    assert.equal(pasteRefusalSentence({ code: classified, message: code }), unavailableReason(classified),
      'a structured refusal wins over another identifier inside its message')
  }
})

test('the actual paste callback maps a wrapped refusal before the composer renders it', async () => {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const callbacks = [...source.matchAll(/onPasteAttachment: (async \(data, mime\) => \{[\s\S]*?\n      \}) \} : \{\}\)/g)]
  assert.equal(callbacks.length, 1, 'the one real paste callback could not be isolated')
  assert.match(callbacks[0][1], /sentence: pasteRefusalSentence\(error\)/,
    'the view stopped using the tested error-to-copy boundary')
  const calls = []
  const pasteAttachment = async request => {
    calls.push(request)
    throw new Error("Error invoking remote method 'mc-agent:paste-attachment': Error: MC_AGENT_PASTE_IMAGE_TOO_LARGE")
  }
  const callback = new Function('pasteAttachment', 'node', 'pasteRefusalSentence', `const liveSessionId = () => node.sessionId; return ${callbacks[0][1]}`)(
    pasteAttachment, { sessionId: 'paste-fixture' }, pasteRefusalSentence,
  )
  const fixture = mount({ onPasteAttachment: callback })
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [1, 2, 3])] } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, [{ sessionId: 'paste-fixture', data: 'AQID', mime: 'image/png' }])
  const notes = fixture.root.querySelectorAll('.msg').filter(node => node.classList.contains('note'))
  assert.ok(notes.some(node => node.textContent.includes(PALETTE_PANEL.pasteTooLarge)))
  assert.ok(notes.every(node => !node.textContent.includes('MC_AGENT_')))
  assert.equal(fixture.root.querySelector('.chat-attach-strip').hidden, true)
  fixture.root.dispose()
})

test('Page 2 preserves message-only Electron paste refusals through the real composer', async () => {
  for (const code of ['MC_AGENT_PASTE_IMAGE_TOO_LARGE', 'MC_AGENT_PASTE_REQUIRES_WINDOW', 'MC_AGENT_PASTE_UNAVAILABLE']) {
    const error = new Error(`Error invoking remote method 'mc-agent:paste-attachment': Error: ${code}`)
    assert.equal(error.code, undefined, 'the fixture must model Electron dropping custom error properties')
    assert.equal(refusalCode(error), code)
    const fixture = mount({
      onPasteAttachment: makePage2Paste(async () => { throw error }, { sessionId: 'paste-refusal' }, pasteRefusalSentence),
    })
    fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [1, 2, 3])] } })
    await new Promise(resolve => setTimeout(resolve, 0))

    const expected = code === 'MC_AGENT_PASTE_IMAGE_TOO_LARGE' ? PALETTE_PANEL.pasteTooLarge : unavailableReason(code)
    const notes = fixture.root.querySelectorAll('.msg').map(node => node.textContent).join('\n')
    assert.ok(notes.includes(expected), `${code} must render its own actionable sentence`)
    assert.ok(!notes.includes(code), 'an IPC identifier must not be shown as the refusal')
    assert.equal(fixture.root.querySelector('.chat-attach-strip').hidden, true)
    fixture.root.dispose()
  }
})

test('an unrecognized paste error cannot put its message or path on screen', async () => {
  const onPaste = makePage2Paste(async () => { throw new Error('Could not write C:/private-untrusted-image.png') },
    { sessionId: 'paste-unknown' }, pasteRefusalSentence)
  assert.deepEqual(await onPaste('AQID', 'image/png'), { ok: false, sentence: PALETTE_PANEL.pasteFailed })
})

test('a composer given no onPasteAttachment adds no paste listener at all', async () => {
  const fixture = mount()
  /* Nothing to call, so nothing should happen -- not a throw, not a
     swallowed image, not a claimed event. */
  const event = fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [1])] } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.notEqual(event.defaultPrevented, true, 'a composer with no paste handler still claimed the paste event')
  fixture.root.dispose()
})

/* THE ATTACHMENT AREA, NOT THE DOCUMENT -- a structural fact a real DOM
   event cannot itself distinguish in this fixture (there is no separate
   "document" surface the stand-in models paste bubbling through), so this is
   asserted directly against the source, the same way this file's own sibling
   (chat-queue-doors.test.mjs, "every enqueue door goes through the one
   helper") pins a wiring fact no mounted click can exercise. */
test('the paste listener is wired to the composer input, and there is no second listener on document', () => {
  const source = readFileSync(new URL('../../src/components.js', import.meta.url), 'utf8')
  assert.match(source, /input\.addEventListener\('paste', async \(event\) => \{/,
    'the paste listener no longer binds to the composer\'s own input')
  assert.doesNotMatch(source, /document\.addEventListener\('paste'/,
    'a second paste listener was added on document -- the ruling is the attachment area only')
})
