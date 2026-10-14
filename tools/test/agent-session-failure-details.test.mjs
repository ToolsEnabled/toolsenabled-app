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
  return { root, control, sessionId,
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

for (const code of ['misalignmentPolicyViolation', 'misalignment_policy_violation']) test(`standalone retains queued text after safety refusal: ${code}`, async t => {
  const s = await mount(t)
  const { enqueue, list, clearSession } = await import('../../src/session-outbox.js')
  t.after(() => clearSession(s.sessionId))
  enqueue(s.sessionId, 'Synthetic queued follow-up.')
  const sentence = 'This request was blocked by our safety systems. Reason: Synthetic prohibited action.'
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'completed', text: sentence,
    payload: { failure: { code, summary: sentence, category: 'safety-policy', retryable: false } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.control.snapshot().lastTurnStatus, 'failed')
  assert.equal(s.counts().sends, 1)
  assert.equal(list(s.sessionId).length, 1)
  assert.match(s.control.snapshot().transcript.at(-1).text, /Synthetic prohibited action/)
  assert.equal(s.root.querySelector('[data-session-stop]').disabled, false)
  assert.equal((await s.control.send('A distinct synthetic new request.')).ok, true)
  s.emit({ type: 'turn_completed', turnId: 'turn-2', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.control.snapshot().lastTurnStatus, 'completed')
  assert.equal(s.counts().sends, 2, 'later success must not release the older queued request')
  assert.equal(list(s.sessionId).length, 1)
})

/* 1.0.50 REVIEW, ACCOUNTS D. A circle's queue waits while its account is at a
   usage limit; a New agent tab's own queue did not, so each waiting message went
   to the spent account, failed, and left the queue as delivered. It now waits,
   says why on the row, and goes once a turn succeeds (the person's own message
   after the reset). An ordinary failure still lets the queue go, as before. */
for (const [label, ending] of [
  ['the engine usage-limit marker', { text: 'This Codex account has reached its usage limit.', payload: { limit: 'usage' } }],
  ['the shell verdict', { failureReason: 'account-limit' }],
  ['a limit code', { code: 'usage_limit_reached' }],
]) test(`standalone holds its queue after an account usage limit (${label}) until a turn succeeds`, async t => {
  const s = await mount(t)
  const { enqueue, list, clearSession } = await import('../../src/session-outbox.js')
  t.after(() => clearSession(s.sessionId))
  enqueue(s.sessionId, 'Synthetic queued follow-up.')
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', ...ending })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.counts().sends, 1, 'the waiting message was sent into the spent account')
  assert.equal(list(s.sessionId).length, 1)
  assert.equal(list(s.sessionId)[0].heldReason, 'ACCOUNT_LIMIT_HELD', 'the row does not say why it waits')
  assert.equal((await s.control.send('After the reset.')).ok, true)
  s.emit({ type: 'turn_completed', turnId: 'turn-2', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.counts().sends, 3, 'once a turn succeeds the waiting message goes')
  assert.equal(list(s.sessionId).length, 0)
})
test('standalone still sends its queue after an ordinary failed turn', async t => {
  const s = await mount(t)
  const { enqueue, list, clearSession } = await import('../../src/session-outbox.js')
  t.after(() => clearSession(s.sessionId))
  enqueue(s.sessionId, 'Synthetic queued follow-up.')
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', text: 'Something else went wrong.' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.counts().sends, 2)
  assert.equal(list(s.sessionId).length, 0)
})

/* 1.0.50 review CM-2. After the provider refuses this tab's model, the queued message is not sent to be refused
   again; the person's own send is taken, and once a turn succeeds the queued message goes. */
test('standalone holds queued text after a model refusal until a turn succeeds', async t => {
  const s = await mount(t)
  const { enqueue, list, clearSession } = await import('../../src/session-outbox.js')
  t.after(() => clearSession(s.sessionId))
  enqueue(s.sessionId, 'Synthetic queued follow-up.')
  const sentence = "Codex refused this model: The 'my-typed-model' model is not supported."
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', text: sentence,
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: sentence, category: 'model-refused' } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.control.snapshot().lastTurnStatus, 'failed')
  assert.equal(s.counts().sends, 1, 'the queued message is not sent to the refused model')
  assert.equal(list(s.sessionId).length, 1)
  assert.match(s.control.snapshot().transcript.at(-1).text, /my-typed-model/)
  assert.equal((await s.control.send('A distinct synthetic new request.')).ok, true)
  assert.equal(s.counts().sends, 2)
  s.emit({ type: 'turn_completed', turnId: 'turn-2', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.counts().sends, 3, 'a successful turn releases the queued message')
  assert.equal(list(s.sessionId).length, 0)
})

/* 1.0.50 REVIEW-1050 #10. After a model refusal a New agent tab held its queued text with no label (the tree's
   PROVIDER_MODEL_REFUSED sentence was never used in a tab). The row now says why it waits, in words for the tab:
   a tab's running session keeps its model, and a tab draws no Respawn (its session stays out of the controls
   registry and its Actions menu has none), so the sentence names what the tab does draw -- the row's Unqueue, the
   model chooser and Stop, whose own hint says queued messages are dropped. A turn that succeeds clears the label. */
test('standalone labels the model-refusal hold in words that name the tab\'s own controls', async t => {
  const s = await mount(t)
  const { enqueue, list, clearSession } = await import('../../src/session-outbox.js')
  const { QUEUE_PANEL, PALETTE_PANEL } = await import('../../src/fleet-tree-copy.js')
  t.after(() => clearSession(s.sessionId))
  enqueue(s.sessionId, 'First synthetic queued follow-up.')
  enqueue(s.sessionId, 'Second synthetic queued follow-up.')
  const sentence = "Codex refused this model: The 'my-typed-model' model is not supported."
  s.emit({ type: 'turn_completed', turnId: 'turn-1', status: 'failed', text: sentence,
    payload: { failure: { provider: 'codex', source: 'turn', code: 'other', summary: sentence, category: 'model-refused' } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.counts().sends, 1)
  assert.deepEqual(list(s.sessionId).map(row => row.heldReason ?? null), ['PROVIDER_MODEL_REFUSED_TAB', 'PROVIDER_MODEL_REFUSED_TAB'],
    'the held rows do not say why they wait')
  const held = QUEUE_PANEL.heldReasons.PROVIDER_MODEL_REFUSED_TAB
  assert.doesNotMatch(held, /Respawn/, 'a New agent tab draws no Respawn')
  assert.ok(held.includes(QUEUE_PANEL.unqueue), 'the row\'s own Unqueue is named')
  assert.match(held, /\bpress Stop\b/)
  assert.match(PALETTE_PANEL.stopHint, /Queued messages are dropped/, 'which is why the row is taken back before Stop')
  // The person's own message is taken; once a turn succeeds the label goes and one held message is sent.
  assert.equal((await s.control.send('A distinct synthetic new request.')).ok, true)
  s.emit({ type: 'turn_completed', turnId: 'turn-2', status: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(s.counts().sends, 3)
  assert.deepEqual(list(s.sessionId).map(row => [row.text, row.heldReason ?? null]), [['Second synthetic queued follow-up.', null]])
})
