import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

/* This deliberately drives buildChat's public streaming door. The shared DOM
   stand-in supplies every generic browser surface; the adapter below supplies
   only this scenario's unit-per-character layout model. CHAT_COMPONENTS_MODULE
   exists solely so the same behavior test can run against a mutated scratch
   copy. Browser globals must be installed before components.js is imported. */
const domModuleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn, Element, ClassList } = await import(domModuleUrl)
const { document, restore } = installDomStandIn(globalThis)

const sharedCreateElement = document.createElement.bind(document)
document.createElement = (tag) => {
  const node = sharedCreateElement(tag)
  let assignedHeight = 0
  Object.defineProperty(node, 'offsetHeight', {
    configurable: true,
    enumerable: true,
    get() {
      const minimumHeight = Number.parseFloat(this.style.minHeight) || 0
      return Math.max(this.textContent.length, assignedHeight, minimumHeight)
    },
    set(value) { assignedHeight = Number(value) || 0 },
  })
  return node
}

const componentsUrl = process.env.CHAT_COMPONENTS_MODULE
  ? pathToFileURL(process.env.CHAT_COMPONENTS_MODULE).href
  : new URL('../../src/components.js', import.meta.url).href
const { buildChat } = await import(componentsUrl)

test.after(() => restore())

test('the shared selector distinguishes exact sibling attribute values', () => {
  const host = document.createElement('div')
  const first = document.createElement('i')
  const second = document.createElement('i')
  first.setAttribute('data-probe', '0')
  second.setAttribute('data-probe', '1')
  host.append(first, second)

  assert.equal(Object.getPrototypeOf(first), Element.prototype)
  assert.ok(first.classList instanceof ClassList)
  assert.equal(host.querySelector('[data-probe="1"]'), second)
  assert.equal(host.querySelector('[data-probe="2"]'), null)
})

test('a streaming bubble reserves its tallest live height and releases it on close', () => {
  const chat = buildChat({ title: '@@', history: [], composerReason: '##' })
  document.documentElement.appendChild(chat)
  const stream = chat.openStream({ at: 0 })
  const bubble = chat.querySelectorAll('.msg').at(-1)
  /* A plain letter, not '~': this bubble is now drawn through
     src/chat-markdown.js's renderChatMarkdown (an agent turn, same as every
     other buildChat() window -- see components.js's own note beside
     openStream's paint), which reads a long run of tildes as repeated
     strikethrough delimiters ('~~x~~' -> one <del> two characters wide) and
     folds most of the run away, so raw length stopped being a stand-in for
     rendered length the moment paint stopped calling formatInlineText. 'x'
     carries no meaning to either renderer, so it stays the fixture this test
     was always trying to be: filler whose only property is its length. */
  const tallestLiveContent = 'x'.repeat(240)
  const shorterLiveContent = 'x'.repeat(12)
  const finalContent = 'x'

  stream.push(tallestLiveContent)
  /* MEASURED AFTER THE FIRST PUSH, NOT AT OPEN. A freshly opened stream is
     no longer empty: openStream marks a row `pending` and gives it the
     temporary "working" note (STREAM_PENDING_NOTE), which is replaced by the
     real words the moment classified content arrives. So the row's fixed
     chrome at OPEN includes a placeholder that is gone by the time the
     tallest content is painted, and adding the streamed length to it
     over-counts by exactly the placeholder. Reading the row once the tallest
     content is actually in it keeps this test measuring what it has always
     measured -- the tallest height the live row ever really had -- instead
     of a sum that silently assumed the row's chrome never changes. The
     assertions below are untouched: the reservation must equal that height
     and must survive a shorter repaint. */
  const tallestLiveHeight = bubble.textContent.length
  stream.push(shorterLiveContent)

  assert.equal(bubble.getAttribute('aria-busy'), 'true', 'the selected final message must be live')
  assert.equal(Number.parseFloat(bubble.style.minHeight), tallestLiveHeight, 'the live style must hold the tallest observed height')
  assert.ok(bubble.offsetHeight >= tallestLiveHeight, `live height fell from ${tallestLiveHeight} units to ${bubble.offsetHeight} units`)

  stream.close(finalContent)
  assert.equal(bubble.style.minHeight, '', 'closing must release the live height reservation')
  assert.equal(bubble.hasAttribute('aria-busy'), false, 'closing must remove the live state')
  assert.ok(bubble.offsetHeight < tallestLiveHeight, 'the final content must settle below the tallest live height')
})
