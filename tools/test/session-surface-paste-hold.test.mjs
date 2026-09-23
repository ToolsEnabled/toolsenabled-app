/* A PICTURE PASTED AT THE PROMPT, BEFORE THERE IS ANY SESSION AT ALL.
 *
 * The home page (src/home-chat-takeover.js) mounts this surface for a live
 * agent subject. MEASURED 2026-09-07: it has no composer -- its chat panel is
 * composerReason-gated ("composerReason, NOT onSend ... a second window onto
 * the SAME session"), and the only place a person can type is the Prompt
 * textarea beside Start. So there was no paste listener anywhere on that page
 * and Ctrl+V with a picture did nothing whatsoever.
 *
 * It cannot be fixed the way the tree rail was. On the rail a session id
 * exists to name, even a stale one; here the person is pasting BEFORE they
 * press Start, so there is no session and nothing to save the file against --
 * the boundary requires one (agent:paste-attachment -> ownedAgentSession).
 *
 * So the bytes are held in the surface until Start mints a session, saved the
 * moment it exists, and sent with that first turn. The person is told the
 * picture is waiting rather than left to guess, and if it cannot be attached
 * once the session is up they are told THAT rather than having it vanish --
 * a held image is never dropped silently.
 *
 * The clipboard is read by the SAME exported function the composer uses
 * (pastedImageFromClipboard), so the two surfaces cannot disagree about what
 * an image is.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

function bitmapItem(byteArray, type = 'image/png') {
  return { kind: 'file', type, getAsFile: () => ({ name: 'clipboard', arrayBuffer: async () => Uint8Array.from(byteArray).buffer }) }
}

function recordingBridge(overrides = {}) {
  const sends = []
  const pastes = []
  return {
    sends,
    pastes,
    availability: async () => ({ ok: true }),
    onEvent: () => () => {},
    start: async () => ({ ok: true }),
    send: async (arg) => { sends.push(arg); return { ok: true, turnId: `turn-${sends.length}` } },
    close: async () => ({ ok: true }),
    interrupt: async () => ({ ok: true }),
    pasteAttachment: async (arg) => {
      pastes.push(arg)
      return { ok: true, path: `C:\\scratch\\held-${pastes.length}.png`, size: 3 }
    },
    ...overrides,
  }
}

async function mountPanel(bridge) {
  const { document, restore } = installDomStandIn(globalThis)
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
  try {
    const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
    const root = document.createElement('div')
    document.body.appendChild(root)
    let control = null
    const dispose = mountAgentSessionSurface(root, {
      live: true, agentId: 'agent-1', bridge, onController: (value) => { control = value },
    })
    await settle()
    const form = root.querySelector('[data-session-form]')
    return {
      root,
      control,
      form,
      prompt: root.querySelector('textarea'),
      output: root.querySelector('[data-action-output]'),
      dispose: () => { dispose(); restore() },
    }
  } catch (error) { restore(); throw error }
}

const said = panel => String(panel.output?.textContent || '')

test('a picture pasted at the Prompt is held, and the person is told it is waiting', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    const event = panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1, 2, 3])] } })
    await settle()

    assert.equal(event.defaultPrevented, true, 'the picture fell through into the Prompt box as text')
    assert.equal(bridge.pastes.length, 0, 'the surface tried to save a picture before any session existed')
    assert.notEqual(said(panel), '', 'the person pasted a picture and the page said nothing at all')
  } finally { panel.dispose() }
})

test('pressing Start sends the held picture with the very first message', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1, 2, 3])] } })
    await settle()
    panel.prompt.value = 'what is in this picture'
    panel.form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()

    assert.equal(bridge.pastes.length, 1, 'the held picture was never saved once the session existed')
    assert.equal(bridge.pastes[0].data, 'AQID', 'the bytes the person pasted are not the bytes that were saved')
    assert.equal(bridge.sends.length, 1, 'the first turn never reached the bridge')
    assert.deepEqual(bridge.sends[0].images, [{ path: 'C:\\scratch\\held-1.png' }],
      'the first message went without the picture the person had already pasted')
  } finally { panel.dispose() }
})

test('the held picture rides one message only, never every later one', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1, 2, 3])] } })
    await settle()
    panel.prompt.value = 'first'
    panel.form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()
    await panel.control.pause()
    await panel.control.send('second')
    await settle()

    assert.equal(bridge.sends.length, 2)
    assert.equal(Object.prototype.hasOwnProperty.call(bridge.sends[1], 'images'), false,
      'the picture was attached again to a later message the person did not attach it to')
  } finally { panel.dispose() }
})

test('a picture that cannot be attached once the session is up is said, not dropped in silence', async () => {
  const bridge = recordingBridge({ pasteAttachment: async () => { throw new Error('MC_AGENT_PASTE_IMAGE_TOO_LARGE') } })
  const panel = await mountPanel(bridge)
  try {
    panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1, 2, 3])] } })
    await settle()
    panel.prompt.value = 'look'
    panel.form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()

    assert.equal(bridge.sends.length, 1, 'the words were thrown away because the picture failed')
    assert.equal(Object.prototype.hasOwnProperty.call(bridge.sends[0], 'images'), false,
      'a picture that was never saved was announced to the boundary anyway')
    assert.match(said(panel), /picture|image/i, 'the picture vanished without a word')
  } finally { panel.dispose() }
})

test('an ordinary text paste at the Prompt is left completely alone', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    const before = said(panel)
    const event = panel.prompt.dispatch('paste', {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] },
    })
    await settle()

    assert.ok(!event.defaultPrevented, 'pasting words into the Prompt box was claimed by the picture handler')
    assert.equal(said(panel), before, 'an ordinary paste made the page say something')
  } finally { panel.dispose() }
})

test('a build whose bridge cannot save a paste offers nothing and claims nothing', async () => {
  const bridge = recordingBridge()
  delete bridge.pasteAttachment
  const panel = await mountPanel(bridge)
  try {
    const event = panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1, 2, 3])] } })
    await settle()

    assert.ok(!event.defaultPrevented,
      'the surface swallowed a paste it has no way to save, so the picture went nowhere and the box stayed empty')
  } finally { panel.dispose() }
})
