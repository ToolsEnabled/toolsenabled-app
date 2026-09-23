/* AN IMAGE FILE COPIED IN EXPLORER IS STILL AN IMAGE THE PERSON PASTED.
 *
 * The second silent path in the paste feature, traced by Controller 2 from
 * source (REPORT-DH-C-paste-image-20260907.md section 0d): when a person copies
 * a picture in File Explorer and presses Ctrl+V in the composer, the clipboard
 * carries a DataTransferItem of kind 'file' whose `type` is NOT `image/...`
 * (Explorer supplies a file descriptor, not a bitmap). The composer's listener
 * looked only for `item.type.startsWith('image/')`, found nothing, and returned
 * without a word -- the same silence the agent page had, on a surface where
 * pasting already worked for a screenshot.
 *
 * Silence is the outcome this product treats as a defect. The person cannot
 * tell "this build cannot do that" from "this build is broken", and both look
 * exactly like a key that did nothing.
 *
 * These cases drive the REAL buildChat composer with fixture clipboard items
 * and read what the paste adapter actually received. The mime is derived from
 * the file's own extension and restricted to the four kinds the main process
 * already allows (PASTE_IMAGE_MIME_EXTENSIONS in shell/main.cjs: png, jpeg,
 * gif, webp), so no caller-chosen string can reach the filesystem as an
 * extension.
 *
 * THE NON-IMAGE CASE IS THE IMPORTANT ONE. A pasted .txt must be left entirely
 * alone -- no bridge call, no note, and the event NOT claimed -- because
 * claiming it would break ordinary text pasting, which is what the box is for.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { restore } = installDomStandIn(globalThis)

const { buildChat } = await import('../../src/components.js')
const { PALETTE_PANEL } = await import('../../src/fleet-tree-copy.js')

after(() => restore())

/* A bitmap item, the path that already worked: kind 'file', a real image type. */
function bitmapItem(type, byteArray) {
  return { kind: 'file', type, getAsFile: () => ({ name: 'clipboard', arrayBuffer: async () => Uint8Array.from(byteArray).buffer }) }
}

/* What Explorer puts on the clipboard for a copied file: kind 'file' with a
   type that is not an image mime (empty here; Windows also supplies
   descriptor types), and a real filename carrying the extension. */
function explorerFileItem(name, byteArray, { type = '' } = {}) {
  return { kind: 'file', type, getAsFile: () => ({ name, arrayBuffer: async () => Uint8Array.from(byteArray).buffer }) }
}

function mount(onPasteAttachment) {
  const calls = []
  const root = buildChat({
    title: 'composer',
    seed: 0,
    onSend: async () => {},
    onPasteAttachment: async (data, mime) => {
      calls.push({ data, mime })
      return onPasteAttachment ? onPasteAttachment(data, mime) : { ok: true, path: `C:\\scratch\\${calls.length}.png`, size: 3 }
    },
  })
  return { root, input: root.querySelector('.chat-input input'), calls }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const notesOf = root => root.querySelectorAll('.msg').filter(node => node.classList.contains('note')).map(node => node.textContent)

test('a PNG copied in Explorer attaches, with the mime read from its own name', async () => {
  const fixture = mount()
  const event = fixture.input.dispatch('paste', { clipboardData: { items: [explorerFileItem('holiday shot.png', [1, 2, 3])] } })
  await settle()

  assert.equal(fixture.calls.length, 1, 'an image file copied in Explorer reached nothing at all, silently')
  assert.equal(fixture.calls[0].mime, 'image/png', 'the file was sent to the boundary under the wrong kind')
  assert.equal(fixture.calls[0].data, 'AQID')
  assert.equal(event.defaultPrevented, true, 'the composer let the file paste through as text as well as attaching it')
  const strip = fixture.root.querySelector('.chat-attach-strip')
  assert.equal(strip.hidden, false, 'the attached file never appeared in the composer')
  fixture.root.dispose()
})

test('the four allowed kinds are recognised by extension, upper case included', async () => {
  for (const [name, expected] of [
    ['a.png', 'image/png'],
    ['b.JPG', 'image/jpeg'],
    ['c.jpeg', 'image/jpeg'],
    ['d.gif', 'image/gif'],
    ['e.WEBP', 'image/webp'],
  ]) {
    const fixture = mount()
    fixture.input.dispatch('paste', { clipboardData: { items: [explorerFileItem(name, [7])] } })
    await settle()
    assert.equal(fixture.calls.length, 1, `${name} was not recognised as an image file`)
    assert.equal(fixture.calls[0].mime, expected, `${name} was sent under the wrong kind`)
    fixture.root.dispose()
  }
})

test('a pasted file that is not an image is left completely alone', async () => {
  const fixture = mount()
  const event = fixture.input.dispatch('paste', { clipboardData: { items: [explorerFileItem('notes.txt', [1])] } })
  await settle()

  assert.equal(fixture.calls.length, 0, 'a text file was sent to the image boundary')
  assert.ok(!event.defaultPrevented,
    'the composer claimed a paste it does not handle, which breaks ordinary pasting into the message box')
  assert.deepEqual(notesOf(fixture.root), [], 'a plain paste produced a note the person did not need')
  assert.equal(fixture.root.querySelector('.chat-attach-strip').hidden, true)
  fixture.root.dispose()
})

test('a file with no extension at all is left alone rather than guessed at', async () => {
  const fixture = mount()
  const event = fixture.input.dispatch('paste', { clipboardData: { items: [explorerFileItem('screenshot', [1])] } })
  await settle()

  assert.equal(fixture.calls.length, 0, 'a file of unknown kind was sent to the boundary anyway')
  assert.ok(!event.defaultPrevented, 'the composer claimed a paste it could not identify as an image')
  fixture.root.dispose()
})

test('a real bitmap item still takes the path it always took', async () => {
  const fixture = mount()
  const event = fixture.input.dispatch('paste', { clipboardData: { items: [bitmapItem('image/png', [1, 2, 3])] } })
  await settle()

  assert.equal(fixture.calls.length, 1, 'the screenshot paste that already worked stopped working')
  assert.equal(fixture.calls[0].mime, 'image/png', 'the bitmap item lost its own declared type')
  assert.equal(event.defaultPrevented, true)
  fixture.root.dispose()
})

test('a bitmap item is preferred over a file item in the same clipboard', async () => {
  /* Windows puts several representations on the clipboard at once. The bitmap
     is the one the person is looking at, and its own declared type is better
     evidence than a filename, so it wins and the file is not attached twice. */
  const fixture = mount()
  fixture.input.dispatch('paste', {
    clipboardData: { items: [explorerFileItem('other.gif', [9]), bitmapItem('image/png', [1, 2, 3])] },
  })
  await settle()

  assert.equal(fixture.calls.length, 1, 'one paste produced two attachments')
  assert.equal(fixture.calls[0].mime, 'image/png', 'the filename beat the bitmap the person was actually looking at')
  fixture.root.dispose()
})

test('a file item that yields no file says nothing and attaches nothing', async () => {
  const fixture = mount()
  const event = fixture.input.dispatch('paste', {
    clipboardData: { items: [{ kind: 'file', type: '', getAsFile: () => null }] },
  })
  await settle()

  assert.equal(fixture.calls.length, 0)
  assert.ok(!event.defaultPrevented, 'the composer claimed a paste it could not read anything from')
  assert.deepEqual(notesOf(fixture.root), [])
  fixture.root.dispose()
})

test('a refusal from the boundary is still said, on the file path too', async () => {
  const fixture = mount(async () => ({ ok: false }))
  fixture.input.dispatch('paste', { clipboardData: { items: [explorerFileItem('shot.png', [1])] } })
  await settle()

  assert.ok(notesOf(fixture.root).some(text => text.replace(/\s+/g, '').includes(PALETTE_PANEL.pasteFailed.replace(/\s+/g, ''))),
    'a refused file paste told the person nothing')
  fixture.root.dispose()
})
