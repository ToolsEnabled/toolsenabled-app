/* RESPAWN REPLAYS THE WORDS AND NOT THE PICTURE, AND NOW SAYS SO.
 *
 * Respawn is "this work again, in a new process": it replays `lastPrompt`,
 * which is text. Re-uploading a picture the person attached to one turn into a
 * child process they never attached it to is a decision, not a default, and
 * tools/test/agent-page-paste-send.test.mjs holds that decision.
 *
 * But the person could not see it. They attached a picture, got a bad answer,
 * pressed Respawn, and the new turn went without the picture with nothing on
 * screen saying so -- so a wrong answer looked like the agent ignoring an image
 * it had actually never been given. Approved by Controller 2 as one plain
 * sentence; the person may reword it.
 *
 * The sentence is said ONLY when the replayed turn really did carry a picture.
 * A note that appears after every respawn would be noise, and noise is how a
 * real notice stops being read.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

function bitmapItem(byteArray) {
  return { kind: 'file', type: 'image/png', getAsFile: () => ({ name: 'clipboard', arrayBuffer: async () => Uint8Array.from(byteArray).buffer }) }
}

function recordingBridge() {
  const sends = []
  return {
    sends,
    availability: async () => ({ ok: true }),
    onEvent: () => () => {},
    start: async () => ({ ok: true }),
    send: async (arg) => { sends.push(arg); return { ok: true, turnId: `turn-${sends.length}` } },
    close: async () => ({ ok: true }),
    interrupt: async () => ({ ok: true }),
    pasteAttachment: async () => ({ ok: true, path: 'C:\\scratch\\held.png', size: 3 }),
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
    return {
      root,
      control,
      form: root.querySelector('[data-session-form]'),
      prompt: root.querySelector('textarea'),
      output: root.querySelector('[data-action-output]'),
      dispose: () => { dispose(); restore() },
    }
  } catch (error) { restore(); throw error }
}

const said = panel => String(panel.output?.textContent || '')

test('a respawn of a turn that carried a picture says the picture did not go again', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1, 2, 3])] } })
    await settle()
    panel.prompt.value = 'what is in this picture'
    panel.form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()
    assert.ok(bridge.sends[0].images, 'the first turn did not carry the picture, so this case tests nothing')

    await panel.control.respawn()
    await settle()

    assert.equal(bridge.sends.length, 2, 'the respawn never sent the words again')
    assert.equal(bridge.sends[1].text, 'what is in this picture')
    assert.equal(Object.prototype.hasOwnProperty.call(bridge.sends[1], 'images'), false,
      'the respawn re-uploaded a picture to a process the person never attached it to')
    assert.match(said(panel), /picture/i,
      'the picture silently stopped riding the turn, so a wrong answer looks like the agent ignoring an image it never got')
  } finally { panel.dispose() }
})

test('a respawn of a plain turn says nothing extra', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    panel.prompt.value = 'just words'
    panel.form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()
    const before = said(panel)

    await panel.control.respawn()
    await settle()

    assert.equal(bridge.sends.length, 2)
    assert.doesNotMatch(said(panel).replace(before, ''), /picture/i,
      'a respawn with no picture involved told the person about a picture')
  } finally { panel.dispose() }
})

test('the sentence does not claim the picture was sent', async () => {
  const bridge = recordingBridge()
  const panel = await mountPanel(bridge)
  try {
    panel.prompt.dispatch('paste', { clipboardData: { items: [bitmapItem([1])] } })
    await settle()
    panel.prompt.value = 'look'
    panel.form.dispatchEvent({ type: 'submit', preventDefault() {} })
    await settle()
    await panel.control.respawn()
    await settle()

    const text = said(panel)
    assert.match(text, /without/i, 'the notice does not say the picture was left out')
    assert.doesNotMatch(text, /attached again|sent your picture|with the picture/i,
      'the notice implies the picture went with the replayed words')
  } finally { panel.dispose() }
})
