import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

async function mount(t, bridge) {
  const { document, restore } = installDomStandIn(globalThis)
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'mc.write.agent-session' ? 'enabled' : null,
    setItem() {}, removeItem() {},
  } })
  let dispose
  t.after(() => {
    dispose?.()
    restore()
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
  })
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = document.createElement('div')
  document.body.appendChild(root)
  let control
  dispose = mountAgentSessionSurface(root, {
    live: true, agentId: 'rejected-start-proof', bridge,
    onController(value) { control = value },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(control, 'The actual session surface must provide its composer controller')
  return { root, control }
}

const refusal = code => Object.assign(new Error(code), { code })

for (const ipcMessage of [false, true]) {
  test(`retry after a refused start creates a fresh session when cleanup confirms absence (${ipcMessage ? 'IPC message' : 'error code'})`, async t => {
    const starts = [], sends = [], closes = []
    const bridge = {
      availability: async () => ({ ok: true }), onEvent: () => () => {},
      async start(request) {
        starts.push(request)
        /* NOT A RESOURCE CODE ANY MORE, and the swap keeps this suite pointed
           at what it was written for. Its subject is the CLEANUP path: a
           refused start whose close confirms the session is absent must let
           the person's next send mint a fresh one. T289 made the resource
           codes retry themselves, so using one here would have turned a
           two-send case into a one-send case and quietly stopped measuring
           the manual retry. This code refuses permanently, which is exactly
           the case where a person retries by hand. The automatic path has its
           own suite (held-start-waits-and-retries), including that each
           attempt mints a fresh session id. */
        if (starts.length === 1) throw refusal('AGENT_TIER_SESSION_ACTOR_UNSUPPORTED')
        return { ok: true, sessionId: request.sessionId }
      },
      async close(request) {
        closes.push(request)
        if (request.sessionId === starts[0].sessionId) {
          if (ipcMessage) throw new Error("Error invoking remote method 'mc-agent:close': Error: MC_AGENT_UNKNOWN_SESSION")
          throw refusal('MC_AGENT_UNKNOWN_SESSION')
        }
        return { ok: true }
      },
      async send(request) { sends.push(request); return { ok: true, turnId: 'retry-turn' } },
      interrupt: async () => ({ ok: true }),
    }
    const { root, control } = await mount(t, bridge)
    const first = await control.send('Preserve this customer message.')
    assert.equal(first.code, 'AGENT_TIER_SESSION_ACTOR_UNSUPPORTED')
    assert.equal(sends.length, 0, 'An unaccepted start must not receive a turn')
    assert.equal(closes[0].sessionId, starts[0].sessionId)
    assert.equal(root.querySelector('[data-session-stop]').disabled, true,
      'The confirmed absent session must no longer be presented as open')
    const retry = await control.send('Preserve this customer message.')
    assert.equal(retry.ok, true)
    assert.equal(starts.length, 2, 'Retry must cross the start boundary again')
    assert.notEqual(starts[0].sessionId, starts[1].sessionId)
    assert.equal(sends.length, 1)
    assert.equal(sends[0].sessionId, starts[1].sessionId)
    assert.equal(sends[0].text, 'Preserve this customer message.')
  })
}

test('an unconfirmed startup cleanup retains its exact Stop target', async t => {
  const closes = []
  let requestedId, cleanupReady = false
  const bridge = {
    availability: async () => ({ ok: true }), onEvent: () => () => {},
    async start(request) { requestedId = request.sessionId; throw refusal('AGENT_SESSION_CLEANUP_FAILED') },
    async close(request) {
      closes.push(request.sessionId)
      if (!cleanupReady) throw refusal('AGENT_SESSION_CLEANUP_FAILED')
      return { ok: true }
    },
    async send() { assert.fail('A rejected start cannot send the initial turn') },
    interrupt: async () => ({ ok: true }),
  }
  const { root, control } = await mount(t, bridge)
  const result = await control.send('Do not lose the cleanup target.')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AGENT_SESSION_CLEANUP_FAILED')
  assert.equal(root.querySelector('[data-session-stop]').disabled, false)
  cleanupReady = true
  assert.equal((await control.terminate()).ok, true)
  assert.deepEqual(closes, [requestedId, requestedId])
  assert.equal(root.querySelector('[data-session-stop]').disabled, true)
})
