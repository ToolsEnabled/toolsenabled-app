/* THE STOP PROGRESS INDICATOR MUST NEVER BE THE LAST THING A PERSON SEES.
 *
 * src/agent-session.js's stopSession() disables Stop and paints the pending
 * "stopping" state BEFORE it awaits closeSession(), and the click handler runs
 * it as `void stopSession()`. Together those mean any path that leaves without
 * repainting strands the panel: a disabled Stop above a permanent "stopping",
 * for a session that may well already be closed, with no control left to press.
 *
 * The first test drives the real surface through the reachable version of that
 * hazard -- a close the host refuses -- and asserts the panel hands the control
 * back. The second reads the source, in the style of
 * tools/test/stop-node-race-guard.test.mjs, because the unreachable version
 * (closeSession() itself rejecting) has no injectable seam: its bridge calls
 * are already wrapped and agent-session-registry.js calls every subscriber in
 * its own try. The guard exists for closeSession()'s unguarded tail --
 * resetLiveMetrics(), relay.flushNow(), turnStream.close() -- and a structural
 * assertion is the honest way to hold a guard whose trigger a test cannot reach.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installDomStandIn } from './lib/dom-stand-in.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

const settled = () => new Promise(resolve => setTimeout(resolve, 10))

async function mountPanel (bridge) {
  const { document, restore } = installDomStandIn(globalThis)
  const store = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  try {
    const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
    const root = document.createElement('div')
    document.body.appendChild(root)
    const dispose = mountAgentSessionSurface(root, { live: true, agentId: 'agent-b14', bridge })
    return { root, dispose, restore, document }
  } catch (error) {
    restore()
    throw error
  }
}

test('a refused close hands the Stop control back instead of leaving stopping on screen', async (t) => {
  const calls = []
  const bridge = {
    availability: async () => ({ ok: true }),
    onEvent: () => () => {},
    start: async (arg) => { calls.push('start'); return { ok: true, sessionId: arg?.sessionId } },
    send: async () => { calls.push('send'); return { ok: true } },
    close: async () => {
      calls.push('close')
      throw Object.assign(new Error('the child did not confirm it closed'), { code: 'AGENT_SESSION_CLOSE_FAILED' })
    },
    interrupt: async () => ({ ok: true }),
    subscribe: () => () => {},
  }

  const panel = await mountPanel(bridge)
  t.after(() => { panel.dispose?.(); panel.restore?.() })

  await settled()
  const form = panel.root.querySelector('[data-session-form]')
  assert.ok(form, 'the mounted surface exposed no session form')
  if (form.elements && form.elements.text) form.elements.text.value = 'do the thing'
  form.dispatchEvent({ type: 'submit', preventDefault () {} })
  await settled()

  const status = panel.root.querySelector('[data-session-status]')
  const stopButton = panel.root.querySelector('[data-session-stop]')
  assert.ok(status && stopButton, 'the surface exposed no status or Stop control')
  assert.ok(calls.includes('start'), 'the session never started; bridge saw ' + JSON.stringify(calls))
  assert.equal(stopButton.disabled, false, 'Stop was not available over a started session, so the stop path was never entered')

  stopButton.click()
  await settled()

  assert.ok(calls.includes('close'), 'Stop never reached the host')
  assert.notEqual(status.dataset.state, 'pending',
    'the panel still shows the pending stopping indicator after the close was refused -- the person is left watching a progress state that will never advance')
  assert.equal(status.dataset.state, 'refused',
    'a refused close must be reported as refused, got ' + JSON.stringify(status.dataset.state))
  assert.equal(stopButton.disabled, false,
    'Stop is still disabled after a refused close, so the person has no way to try again')
})

test('the await on closeSession is inside a try whose catch restores the controls', () => {
  const source = read('src/agent-session.js')

  const stopAt = source.indexOf('const stopSession = async () => {')
  assert.notEqual(stopAt, -1, 'stopSession is gone or renamed; this guard no longer measures anything')
  const stopEnd = source.indexOf("stopButton.addEventListener('click'", stopAt)
  assert.notEqual(stopEnd, -1, 'could not find the end of the stopSession body')
  const body = source.slice(stopAt, stopEnd)

  const awaitAt = body.indexOf('await closeSession()')
  assert.notEqual(awaitAt, -1, 'stopSession no longer awaits closeSession()')

  const tryAt = body.lastIndexOf('try {', awaitAt)
  assert.notEqual(tryAt, -1,
    'stopSession awaits closeSession() with no try before it -- a rejection would leave the pending stopping indicator and a disabled Stop, and nobody observes it')

  const catchAt = body.indexOf('} catch', awaitAt)
  assert.notEqual(catchAt, -1, 'the try around closeSession() has no catch')

  const catchBody = body.slice(catchAt, body.indexOf('\n    }', catchAt) + 1)
  assert.match(catchBody, /setStarted\(true\)/,
    'the catch does not call setStarted(true), so the Stop control is never handed back')
  assert.match(catchBody, /actionState\(status, 'refused'/,
    'the catch does not replace the pending indicator with a refusal')
})