/* PRESSING STOP WHILE A SESSION IS STARTING MUST NOT END IN "refused".
 *
 * THE DEFECT. Stop is enabled for the whole of `await bridge.start(...)` --
 * setStarted(true) runs before it -- and starting is slow by design: account
 * resolution plus a real child process. The continuation after that await
 * re-checked only `destroyed`, so a person who pressed Stop mid-start watched
 * the panel answer "running · session open", open a busy bubble for a session
 * that was already closing, and then paint "refused · ..." over the
 * "stopped · session closed" their own Stop had correctly just written. Told it
 * was running, then told the product refused -- for the one action that worked.
 *
 * The catch had the mirror of it: it painted the refusal whenever the view was
 * not destroyed, and a bridge.send() rejecting against a closing session is the
 * EXPECTED consequence of the stop rather than news about a fault.
 *
 * These drive the real surface with a bridge whose start() is held open, so the
 * interleaving is produced rather than described.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

/** A promise plus its resolver, to hold `start` open across the press. */
function deferred () {
  let settle
  let fail
  const promise = new Promise((resolve, reject) => { settle = resolve; fail = reject })
  return { promise, settle, fail }
}

/** Mount the surface against a bridge we control, and hand back the pieces a
 *  person would press. This contract supplies its DOM stand-in and write flag,
 *  so a failed mount is a product-test failure rather than a platform skip. */
async function mountPanel (bridge) {
  const { document, restore } = installDomStandIn(globalThis)
  /* The Start control is behind the write-action flag a person turns on
     themselves (src/write-flags.js reads localStorage). Arranging the SUBJECT
     into the state where the control exists is setup; every assertion below
     still observes what the product then does. */
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
    const dispose = mountAgentSessionSurface(root, { live: true, agentId: 'agent-1', bridge })
    const button = (label) => root.querySelectorAll('button').find((node) =>
      String(node.textContent || '').toLowerCase().includes(label))
    return { root, dispose, restore, document, button }
  } catch (error) {
    restore()
    throw error
  }
}

test('a Stop that lands while the session is starting is not overwritten by "refused"', async (t) => {
  const start = deferred()
  const calls = []
  const bridge = {
    availability: async () => ({ ok: true }),
    onEvent: () => () => {},
    /* Held open on purpose: this is the window the person presses Stop in. */
    start: async (arg) => { calls.push(['start', arg]); return start.promise },
    /* What the host really does to a send against a session it is closing. */
    send: async (arg) => { calls.push(['send', arg]); throw Object.assign(new Error('closing'), { code: 'AGENT_SESSION_NOT_READY' }) },
    close: async (arg) => { calls.push(['close', arg]); return { ok: true } },
    interrupt: async () => ({ ok: true }),
    subscribe: () => () => {},
  }

  const panel = await mountPanel(bridge)
  t.after(() => {
    panel.dispose?.()
    panel.restore?.()
  })

  /* The engine-availability answer arrives asynchronously and is what enables
     Start; without this wait the press below would land on a disabled control
     and the race would never be entered. */
  await new Promise((resolve) => setTimeout(resolve, 10))
  const form = panel.root.querySelector('[data-session-form]')
  if (form && form.elements && form.elements.text) form.elements.text.value = 'do the thing'
  const startButton = panel.root.querySelector('[data-session-start]')
  assert.ok(startButton,
    'the mounted surface exposed no Start control, so the start/stop race was not exercised')

  /* Start is a form submit, not a bare click -- the handler is on the form
     (agent-session.js form.addEventListener('submit')), so pressing the button
     in a real browser submits. Dispatch what the product listens for. */
  form.dispatchEvent({ type: 'submit', preventDefault () {} })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(calls.map((call) => call[0]), ['start'],
    'the start never began, so the race below would prove nothing')

  const stopButton = panel.root.querySelector('[data-session-stop]')
  assert.ok(stopButton, 'Stop is not present during a start -- the race this guards cannot happen, or the panel changed')
  assert.equal(stopButton.disabled, false, 'Stop was disabled during the start, so a person could not have raced it')

  stopButton.click()
  await new Promise((resolve) => setTimeout(resolve, 0))

  start.settle({ ok: true })
  await new Promise((resolve) => setTimeout(resolve, 20))

  const text = String(panel.root.textContent || '')
  assert.ok(!/refused/i.test(text),
    `the panel says "refused" after a successful Stop: ${JSON.stringify(text.slice(0, 200))}`)
  assert.ok(!/running · session open/.test(text),
    `the panel claims the session is running after it was stopped: ${JSON.stringify(text.slice(0, 200))}`)

})

test('the stopped-while-starting refusal has words of its own', async () => {
  const { unavailableReason } = await import('../../src/agent-availability-copy.js')
  const sentence = unavailableReason('AGENT_SESSION_STOPPED_WHILE_STARTING')
  assert.ok(sentence && sentence.length > 0,
    'the code has no sentence, so a person would be shown a bare identifier')
  assert.ok(!/refused/i.test(sentence), 'the sentence blames a refusal for something the person chose')
  assert.match(sentence, /stopp?ed/i, 'the sentence does not say that stopping is what happened')
})
