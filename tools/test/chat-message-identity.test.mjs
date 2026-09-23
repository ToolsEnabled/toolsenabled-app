/* ONE CONVERSATION, PAINTED THREE DIFFERENT WAYS.
 *
 * Owner, items 2 and 4: the messages "pile" and "combine into each other".
 * MEASURED on a staged packaged build: nothing geometrically overlapped
 * (overlaps [], textSpill [], clipped [], the log scrolled correctly) -- so
 * this was never a layout collision. It was identity.
 *
 * buildChat once rendered a reply arriving through its OWN handlers with the
 * ROLE KEY as the bubble class, for which no `.msg.<role>` rule existed. So a
 * live reply was measured as bare full-width text directly beneath a restored
 * reply from the same agent that carried the proper bubble treatment. The
 * person's own live message also lacked the label its restored form carried.
 *
 * The rule pinned here: a message paints by WHO SAID IT, never by which code
 * path delivered it, and every kind the log can produce is styled. There are
 * four: the agent, the person, the product's own notes, and the words the
 * product sent on the person's behalf.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const standInModule = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(standInModule)
const { document, restore } = installDomStandIn(globalThis)
const components = new Map()

after(() => {
  for (const [root, dispose] of components) { dispose(); root.remove() }
  restore()
})

const { buildChat } = await import('../../src/components.js')
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8')

const marker = '·'
function chat(options) {
  const root = buildChat(options)
  components.set(root, root.dispose)
  document.documentElement.appendChild(root)
  return root
}
function disposeChat(root) {
  const dispose = components.get(root)
  try {
    assert.equal(typeof dispose, 'function', 'the chat root did not expose a disposer')
    dispose()
  } finally {
    components.delete(root)
    root.remove()
  }
}

function messages(root) { return root.querySelector('.chat-log').children.filter(node => node.classList.contains('msg')) }
function speaker(row) { return row.querySelector('.who')?.textContent ?? null }
function send(root, text) { const input = root.querySelector('.chat-input input'); input.value = text; root.querySelector('.chat-send').dispatch('click') }

test('live and restored replies paint as the same agent kind', async () => {
  let reply
  const root = chat({ title: marker, seed: 0, history: [{ who: 'agent', text: marker }], onSend: (_text, handlers) => { reply = handlers.reply } })
  send(root, marker)
  await Promise.resolve()
  reply(marker)
  const [restored, _person, live] = messages(root)
  assert.equal(restored.className, 'msg them', 'a restored agent reply is not painted as the agent')
  assert.equal(live.className, restored.className, 'a live reply is not painted as the same agent kind as restored history')
  disposeChat(root)
})

test('a refusal is product speech, not agent speech', async () => {
  let fail
  const root = chat({ title: marker, seed: 0, onSend: (_text, handlers) => { fail = handlers.fail } })
  send(root, marker)
  await Promise.resolve()
  fail(marker)
  assert.equal(messages(root).at(-1).className, 'msg note', 'a sender refusal is attributed to the agent instead of the product')
  disposeChat(root)
})

test('sender labels follow speaker changes across restored and live paths', async () => {
  let reply
  const root = chat({ title: marker, seed: 0, history: [{ who: 'agent', text: marker }], onSend: (_text, handlers) => { reply = handlers.reply } })
  send(root, marker)
  await Promise.resolve()
  reply(marker)
  const observedSpeakers = messages(root).map(speaker)
  assert.deepEqual(observedSpeakers, [marker, 'you', marker], 'restored and live rows did not preserve the complete speaker sequence')
  disposeChat(root)
})

test('a streamed turn has the same identity as a finished agent turn', () => {
  const root = chat({ title: marker, seed: 0, history: [{ who: 'agent', text: marker }], composerReason: marker })
  const stream = root.openStream()
  stream.push(marker)
  const [restored, live] = messages(root)
  assert.equal(live.className, restored.className, 'a streamed reply is not painted as the same agent kind as a finished reply')
  assert.equal(speaker(live), null, 'a consecutive streamed reply repeats the sender label')
  stream.close(marker)
  disposeChat(root)
})

test('every message kind emitted by representative behaviour has a style rule', async () => {
  let handlers
  const root = chat({
    title: marker, seed: 0,
    history: [{ who: 'context', text: marker, label: marker, summary: marker }],
    onSend: (_text, value) => { handlers = value },
  })
  send(root, marker)
  await Promise.resolve()
  handlers.reply(marker)
  handlers.fail(marker)
  const kinds = [...new Set(messages(root).map(row => row.className.split(/\s+/)[1]))].sort()
  assert.deepEqual(kinds, ['context', 'me', 'note', 'them'], 'representative chat behaviour did not emit every message identity')
  for (const kind of kinds) assert.match(styles, new RegExp(`\\.msg\\.${kind}\\b`), `.msg.${kind} has no style rule; that emitted kind paints as bare text`)
  disposeChat(root)
})

test('the four visual identities remain distinguishable in the stylesheet', () => {
  /* Computed visual behaviour needs a browser. These static checks are kept
     narrowly on the distinctions, rather than the component implementation. */
  assert.match(styles, /\.msg\.me\s*\{[^}]*border-left:\s*2px solid/s, "the person's quote rule is gone; re-measure this distinction")
  assert.match(styles, /\.msg\.context\s*\{[^}]*border:\s*1px dashed/s, 'the context row no longer reads as a product aside')
  assert.match(styles, /\.msg\.them::before/, "the agent's gutter mark is gone")
  assert.match(styles, /var\(--chat-role/, 'the agent mark no longer uses the panel role colour')
})
