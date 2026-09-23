import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

async function mount(t) {
  const { document, restore } = installDomStandIn(globalThis)
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'mc.write.agent-session' ? 'enabled' : null,
    setItem() {}, removeItem() {},
  } })
  let dispose, control, listener, sessionId, sends = 0, closes = 0
  t.after(() => {
    dispose?.(); restore()
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior)
    else delete globalThis.localStorage
  })
  const bridge = {
    availability: async () => ({ ok: true }),
    onEvent(fn) { listener = fn; return () => {} },
    async start(request) { sessionId = request.sessionId; return { ok: true, sessionId } },
    async send() { return { ok: true, turnId: `turn-${++sends}` } },
    async close() { closes++; return { ok: true } },
    interrupt: async () => ({ ok: true }),
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = document.createElement('div'); document.body.appendChild(root)
  dispose = mountAgentSessionSurface(root, { live: true, chatComposer: true,
    agentId: 'failure-detail-test', bridge, onController(value) { control = value } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await control.send('Bounded check.')).ok, true)
  return { root, control,
    emit: (event, id = sessionId) => listener({ sessionId: id, event }),
    counts: () => ({ sends, closes }),
  }
}

for (const spoken of ['', 'Partial answer.']) {
  test(`standalone failure reason remains visible and saved with ${spoken ? 'partial' : 'no'} assistant output`, async t => {
    const s = await mount(t)
    if (spoken) s.emit({ type: 'assistant_text_delta', turnId: 'turn-1', text: spoken })
    s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', text: 'This Codex account has reached its usage limit.' })
    assert.match(s.root.querySelector('[data-session-status]').textContent, /account has reached its usage limit/)
    const saved = s.control.snapshot()
    assert.equal(saved.phase, 'open')
    assert.equal(saved.lastTurnStatus, 'failed')
    const replies = saved.transcript.filter(row => row.who === 'agent')
    assert.equal(replies.length, 1)
    assert.match(replies[0].text, /The last turn failed: This Codex account has reached its usage limit\./)
    if (spoken) assert.ok(replies[0].text.startsWith(spoken))
    assert.equal(replies[0].turnStamp, 'turn-1')
    assert.deepEqual(s.counts(), { sends: 1, closes: 0 })
    assert.equal(s.root.querySelector('[data-session-stop]').disabled, false)
  })
}

for (const status of ['completed', 'interrupted', 'cancelled']) test(`standalone ${status} completion does not append a contradictory failure sentence`, async t => {
  const s = await mount(t)
  s.emit({ type: 'assistant_text_delta', turnId: 'turn-1', text: 'Done.' })
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status, text: 'Incorrect failure detail.' })
  assert.deepEqual(s.control.snapshot().transcript.filter(row => row.who === 'agent').map(row => row.text), ['Done.'])
  assert.doesNotMatch(s.root.textContent, /Incorrect failure detail/)
})

test('standalone foreign and stale failure sentences do not end or overwrite the next turn', async t => {
  const s = await mount(t)
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'completed' })
  assert.equal((await s.control.send('Next bounded check.')).ok, true)
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', text: 'Stale quota detail.' })
  s.emit({ type: 'turn_completed', turnId: 'turn-2', status: 'failed', text: 'Foreign quota detail.' }, 'another-session')
  const saved = s.control.snapshot()
  assert.equal(saved.phase, 'working')
  assert.equal(saved.turnId, 'turn-2')
  assert.doesNotMatch(JSON.stringify(saved), /Stale quota|Foreign quota/)
  assert.doesNotMatch(s.root.textContent, /Stale quota|Foreign quota/)
})
