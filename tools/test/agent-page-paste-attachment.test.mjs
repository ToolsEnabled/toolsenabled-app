/* CTRL+V, IMAGE TO THE AGENT -- ON THE AGENT'S OWN PAGE.
 *
 * The owner, verbatim (2026-09-07): "pasted images still dont work". Measured
 * cause covered by this file: src/views/computers.js was the ONLY caller that
 * passed `onPasteAttachment`, and components.js attaches its paste listener
 * only when that callback exists. The agent page mounts a LIVE composer -- it
 * sends, it starts sessions -- and passed no paste adapter at all, so Ctrl+V
 * with an image there did nothing whatsoever: no chip, no note, no refusal.
 * Silence is the one outcome this product treats as a defect on every other
 * surface ("A MISSING BRIDGE IS SAID, NOT HIDDEN", src/views/account.js).
 *
 * The adapter is executed here, not described. The one seam is the same one
 * tools/test/chat-paste-attachment.test.mjs already uses for Page 2: lift the
 * real callback out of the real view and drive it, because mounting the whole
 * agent page would drag in the fleet, the org and the live-status fetch. The
 * lift is brace-matched rather than indentation-matched, so reformatting or
 * renaming the callback's own locals cannot fake a red.
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

after(() => restore())

/* Lift the WHOLE conditional spread the view writes -- `...( <guard> ? {
   onPasteAttachment: <fn> } : {} )` -- and hand back its inner expression, so
   the caller EVALUATES the guard rather than reading it. Lifting only the
   arrow body would leave a gate that a mutation like `false && agentBridge`
   walks straight through: the text would still be there, and the composer
   would still get nothing. Paren-matched, not indentation-matched, so
   reformatting cannot fake a red. */
function liftPasteSpread(source) {
  const key = source.indexOf('onPasteAttachment:')
  if (key === -1) return null
  const spread = source.lastIndexOf('...(', key)
  if (spread === -1) return null
  const open = spread + 3
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return null
}

const agentSource = readFileSync(new URL('../../src/views/agent.js', import.meta.url), 'utf8')

function makeAgentPaste({ pasteAttachment, sessionId, bridge = { pasteAttachment } }) {
  const expression = liftPasteSpread(agentSource)
  assert.ok(expression, 'the agent page carries no paste adapter, so an image pasted into its composer reaches nothing')
  /* Every free name the expression closes over, supplied explicitly. A name it
     needs and this list does not have is a ReferenceError here, which is the
     honest outcome: the fixture must not quietly invent one. */
  const config = new Function('agentBridge', 'agent', 'liveSessionFor', 'chatSessionId', 'PALETTE_PANEL', 'pasteRefusalSentence',
    `return (${expression})`)(
    bridge, { id: 'agent-under-test' }, () => (sessionId ? { sessionId } : null), null,
    PALETTE_PANEL, pasteRefusalSentence,
  )
  assert.equal(typeof config.onPasteAttachment, 'function',
    'the agent page hands its composer no paste callback, so an image pasted into it reaches nothing at all')
  return config.onPasteAttachment
}

/* The same lift, with the guard deliberately allowed to fail. */
function pasteConfigFor(bridge) {
  const expression = liftPasteSpread(agentSource)
  assert.ok(expression, 'the agent page carries no paste adapter at all')
  return new Function('agentBridge', 'agent', 'liveSessionFor', 'chatSessionId', 'PALETTE_PANEL', 'pasteRefusalSentence',
    `return (${expression})`)(
    bridge, { id: 'agent-under-test' }, () => null, null, PALETTE_PANEL, pasteRefusalSentence,
  )
}

function imageClipboardItem(type, byteArray) {
  return { type, getAsFile: () => ({ arrayBuffer: async () => Uint8Array.from(byteArray).buffer }) }
}

function mount(onPasteAttachment) {
  const root = buildChat({ title: 'agent', seed: 0, onSend: async () => {}, onPasteAttachment })
  return { root, input: root.querySelector('.chat-input input') }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const notesOf = root => root.querySelectorAll('.msg').filter(node => node.classList.contains('note')).map(node => node.textContent)

/* WHY THE SENTENCES ARE COMPARED WITH THEIR SPACES REMOVED. The DOM stand-in
   trims every text run before it stores one (`_appendText` in
   tools/test/lib/dom-stand-in.mjs does `String(value).trim()`) and joins the
   runs with '', so a sentence the component renders across several runs comes
   back from `textContent` without its inter-run spaces -- in this harness
   only; a real browser keeps those text nodes. Measured here: the adapter
   returned "This agent has not started yet." and the stand-in read it back as
   "Thisagenthas not started yet.". Squashing both sides removes the artefact
   without weakening the check: every word, and their order, is still required
   exactly, and a wrong sentence still fails. */
const squash = text => String(text).replace(/\s+/g, '')

test('an image pasted on the agent page reaches the bridge with that agent\'s live session', async () => {
  const calls = []
  const onPaste = makeAgentPaste({
    sessionId: 'live-session-7',
    pasteAttachment: async request => { calls.push(request); return { ok: true, path: 'C:\\fake\\pasted.png', size: 3 } },
  })
  const fixture = mount(onPaste)
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [1, 2, 3])] } })
  await settle()

  assert.deepEqual(calls, [{ sessionId: 'live-session-7', data: 'AQID', mime: 'image/png' }],
    'the pasted bytes never reached the bridge with this agent\'s own session')
  const strip = fixture.root.querySelector('.chat-attach-strip')
  assert.equal(strip.hidden, false, 'the pasted image did not appear in the composer')
  assert.match(strip.textContent, /pasted\.png/)
  fixture.root.dispose()
})

test('with no session started, the paste says so instead of doing nothing', async () => {
  const calls = []
  const onPaste = makeAgentPaste({ sessionId: null, pasteAttachment: async request => { calls.push(request); return { ok: true, path: 'x' } } })
  const fixture = mount(onPaste)
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [9])] } })
  await settle()

  assert.equal(calls.length, 0, 'a paste with no session must not be sent to the bridge to be refused there')
  assert.ok(notesOf(fixture.root).some(text => squash(text).includes(squash(PALETTE_PANEL.whyNotStarted))),
    'the composer said nothing at all about why the paste did not attach')
  assert.equal(fixture.root.querySelector('.chat-attach-strip').hidden, true)
  fixture.root.dispose()
})

test('a refusal from the boundary becomes its own sentence, never an identifier', async () => {
  const onPaste = makeAgentPaste({
    sessionId: 'live-session-7',
    pasteAttachment: async () => { throw new Error("Error invoking remote method 'mc-agent:paste-attachment': Error: MC_AGENT_PASTE_IMAGE_TOO_LARGE") },
  })
  const fixture = mount(onPaste)
  fixture.input.dispatch('paste', { clipboardData: { items: [imageClipboardItem('image/png', [1])] } })
  await settle()

  const notes = notesOf(fixture.root)
  assert.ok(notes.some(text => squash(text).includes(squash(PALETTE_PANEL.pasteTooLarge))), 'the size refusal never reached the person')
  assert.ok(notes.every(text => !text.includes('MC_AGENT_')), 'an IPC identifier was shown as the refusal')
  assert.equal(fixture.root.querySelector('.chat-attach-strip').hidden, true)
  fixture.root.dispose()
})

test('the agent page only offers paste when this computer really exposes it', () => {
  /* The guard is executed, not read. A build whose bridge has no
     pasteAttachment must hand the composer nothing, so no listener is
     attached and no half-working control appears. */
  assert.equal(pasteConfigFor(null).onPasteAttachment, undefined, 'a page with no bridge at all still offered paste')
  assert.equal(pasteConfigFor({}).onPasteAttachment, undefined, 'a bridge without pasteAttachment still produced a paste callback')
  assert.equal(typeof pasteConfigFor({ pasteAttachment: async () => ({ ok: true, path: 'p' }) }).onPasteAttachment, 'function',
    'a bridge that does carry pasteAttachment was not offered to the composer')
})
