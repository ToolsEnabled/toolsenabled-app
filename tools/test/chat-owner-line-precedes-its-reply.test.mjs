/* THE AGENT'S ANSWER PAINTED ABOVE THE QUESTION IT ANSWERS.
 *
 * THE DEFECT (owner, LIVE hand test 2026-09-12, Local Observer
 * node-16-8a2ff6c3-2ccf-4a17-9e9c-69b14106daae, evidence
 * local-post-cut-success.json): the transcript read
 *
 *     Observer (8a2ff6c3)   LOCAL_POST_CUT linux            02:05  1c3f7e96...
 *     you                   Use host.exec with command ...  02:05  1c3f7e96...
 *
 * Both rows carry the SAME turn id and the SAME minute, and the reply is
 * above the request. A reader cannot tell what was asked.
 *
 * WHY A TIMESTAMP SORT CANNOT FIX IT. The two rows are stamped in the same
 * minute, and the component is explicit that "timestamps and array positions
 * are not proof of a turn identity" (makeMsg). The turn id is the only thing
 * that relates them, so the placement has to use it.
 *
 * WHERE IT COMES FROM. Two surfaces have the same shape: the tree rail
 * (src/views/computers.js, broadcastChatSpeech then acceptRemotePersonTurn)
 * and a browser session's chat (src/desktop-sessions.js, streamWords then
 * paintPerson). Both open the reply bubble on the first delta, stamped with
 * that turn, and paint the person's line only when the shell announces it. A
 * fast local turn can complete first, so the bubble is already in the log when
 * the person's line lands -- and addMsg ended in log.appendChild, which put it
 * underneath. The race is driven through the real page mount in
 * desktop-late-person-turn-order.test.mjs; this file pins the component
 * invariants that mount cannot observe.
 *
 * THIS SUITE DRIVES THE REAL COMPONENT over the real DOM stand-in, in the
 * order the race actually produces: reply first, person's line second.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn } = await import(moduleUrl)
const { restore } = installDomStandIn(globalThis)
after(() => { restore() })

const { buildChat } = await import('../../src/components.js')

const TURN = '1c3f7e96-15f7-40bf-92e4-44cdce4a67a8'
const EARLIER_TURN = 'ca518ea0-95e6-4768-80ff-283afe872c99'
const AT = Date.UTC(2026, 8, 12, 2, 5, 0)

function chat() {
  return buildChat({
    title: 'Observer (8a2ff6c3)',
    seed: 0,
    status: { busy: () => false, subscribe: () => () => {} },
    chips: {},
    onSend: () => {},
  })
}

function rows(root) {
  return [...root.querySelector('.chat-log').children].filter(node => node.classList.contains('msg'))
}
function roleOf(node) {
  for (const role of ['me', 'them', 'thinking', 'context', 'diff']) if (node.classList.contains(role)) return role
  return 'other'
}
function stampOf(node) {
  return node.querySelector('.turn-stamp')?.textContent || null
}
function textOf(node) {
  return node.querySelector('.chat-msg-text')?.textContent || ''
}
function shape(root) {
  return rows(root).map(node => `${roleOf(node)}:${stampOf(node) || '-'}`)
}

test("the person's line is placed above the reply that already arrived for the same turn", () => {
  const root = chat()
  /* The race, in the order it really happens: the local engine answers and its
     bubble is opened and closed before the send is acknowledged. */
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  /* Then the host acknowledges the person's turn and the line finally lands. */
  root.addOwnerMessage('Use host.exec with command "node -p process.platform".', { at: AT, turnStamp: TURN })

  const order = shape(root)
  const me = order.findIndex(entry => entry === `me:${TURN}`)
  const them = order.findIndex(entry => entry === `them:${TURN}`)
  assert.ok(me >= 0, `the person's line is missing: ${order.join(' | ')}`)
  assert.ok(them >= 0, `the reply is missing: ${order.join(' | ')}`)
  assert.ok(me < them,
    `the reply is painted above the request it answers. Order was: ${order.join(' | ')}`)
})

test('placing it there does not reorder turns that are not this one', () => {
  const root = chat()
  /* An unrelated, genuinely earlier turn, complete and in order. */
  root.addOwnerMessage('the earlier request', { at: AT - 60_000, turnStamp: EARLIER_TURN })
  const earlier = root.openStream({ at: AT - 59_000, turnStamp: EARLIER_TURN })
  earlier.push('the earlier answer')
  earlier.close('the earlier answer')
  /* Now the racing turn, reply first again. */
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  root.addOwnerMessage('the later request', { at: AT, turnStamp: TURN })

  assert.deepEqual(shape(root), [
    `me:${EARLIER_TURN}`,
    `them:${EARLIER_TURN}`,
    `me:${TURN}`,
    `them:${TURN}`,
  ], 'an earlier finished turn must stay above, and the repair must stay inside its own turn')
})

test('a line with no turn id is still appended, because a stamp is the only proof of a turn', () => {
  const root = chat()
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  /* No stamp: makeMsg's rule is that array positions and timestamps are not
     proof of a turn identity, so an unstamped line may not be hoisted above a
     stamped reply on a guess. */
  root.addOwnerMessage('an unstamped line', { at: AT })
  assert.deepEqual(shape(root), [`them:${TURN}`, 'me:-'],
    'an unstamped line was reordered on a guess')
})

/* ---------- interactions the placement must not disturb ---------- */

function labelled(root) {
  return rows(root).map(node => `${roleOf(node)}:${node.querySelector('.who')?.textContent || '-'}`)
}

test('a hoisted line does not claim the label state from the row still at the tail', () => {
  const root = chat()
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  root.addOwnerMessage('the request', { at: AT, turnStamp: TURN })
  /* The agent speaks again straight after. The row visually above it is still
     the agent's, so this must group with it and NOT be named again. Only the
     tail row may own the label state; the hoisted line is not the tail. */
  const next = root.openStream({ at: AT + 1000 })
  next.push('a following line')
  next.close('a following line')
  const shapes = labelled(root)
  assert.equal(shapes.length, 3, shapes.join(' | '))
  assert.equal(shapes[2], 'them:-',
    `the agent was named again after its own row, so grouping broke: ${shapes.join(' | ')}`)
})

test('tool rows already painted for the fast turn stay under the request, not above it', () => {
  const root = chat()
  /* The documented live sequence: the reply bubble opens first, then the tool
     rows land in a run beneath it. Both belong to the racing turn. */
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  root.addAction({ id: 'act-1', stateKey: 'finished', label: 'node -p process.platform' })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  root.addOwnerMessage('the request', { at: AT, turnStamp: TURN })
  const children = [...root.querySelector('.chat-log').children]
  const firstMe = children.findIndex(node => node.classList.contains('msg') && node.classList.contains('me'))
  const firstRun = children.findIndex(node => node.classList.contains('chat-action-run'))
  const firstThem = children.findIndex(node => node.classList.contains('msg') && node.classList.contains('them'))
  assert.ok(firstMe >= 0 && firstThem >= 0, 'both rows must exist')
  assert.ok(firstMe < firstThem, 'the request must precede its answer')
  if (firstRun >= 0) {
    assert.ok(firstMe < firstRun,
      'a tool run for this turn is painted above the request that caused it')
  }
})

test('a second line for the same turn does not leapfrog the first', () => {
  const root = chat()
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('an answer')
  stream.close('an answer')
  root.addOwnerMessage('first line', { at: AT, turnStamp: TURN })
  root.addOwnerMessage('second line', { at: AT, turnStamp: TURN })
  assert.deepEqual(rows(root).map(node => `${roleOf(node)}:${textOf(node)}`), [
    'me:first line',
    'me:second line',
    'them:an answer',
  ], 'a second line for the same turn must land under the first, still above the answer')
})

test('the exact turn id is preserved on every row the placement touches', () => {
  const root = chat()
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  root.addOwnerMessage('the request', { at: AT, turnStamp: TURN })
  for (const node of rows(root)) {
    assert.equal(stampOf(node), TURN, 'a turn id was altered or dropped by the placement')
  }
})

/* ---------- restore ---------- */

function restored(history) {
  return buildChat({
    title: 'Observer (8a2ff6c3)',
    seed: 0,
    status: { busy: () => false, subscribe: () => () => {} },
    chips: {},
    history,
    onSend: () => {},
  })
}

test('a restore follows the record wherever no turn stamp relates two rows', () => {
  /* Already in order, and rendered in order. */
  const good = restored([
    { who: 'you', text: 'the request', at: AT, turnStamp: TURN },
    { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT, turnStamp: TURN },
  ])
  assert.deepEqual(rows(good).map(roleOf), ['me', 'them'])

  /* The same inverted pair with no stamps stays exactly as saved. A stamp is
     the only thing that relates two rows, so without one the record's order is
     the only order there is, and a replay must not invent another. */
  const unstamped = restored([
    { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT },
    { who: 'you', text: 'the request', at: AT },
  ])
  assert.deepEqual(rows(unstamped).map(roleOf), ['them', 'me'],
    'an unstamped record was reordered on a guess')
})

test('a restored conversation keeps unrelated turns in the order it was given', () => {
  const root = restored([
    { who: 'you', text: 'the earlier request', at: AT - 60_000, turnStamp: EARLIER_TURN },
    { who: 'agent', text: 'the earlier answer', at: AT - 59_000, turnStamp: EARLIER_TURN },
    { who: 'you', text: 'the later request', at: AT, turnStamp: TURN },
    { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT, turnStamp: TURN },
  ])
  assert.deepEqual(rows(root).map(node => `${roleOf(node)}:${stampOf(node) || '-'}`), [
    `me:${EARLIER_TURN}`,
    `them:${EARLIER_TURN}`,
    `me:${TURN}`,
    `them:${TURN}`,
  ])
})

test('a tool run painted before the turn had any words is part of the turn, not of the one above', () => {
  const root = chat()
  const earlier = root.openStream({ at: AT - 60_000, turnStamp: EARLIER_TURN })
  earlier.push('the earlier answer')
  earlier.close('the earlier answer')
  /* The fast turn runs a tool before it says anything, so its run is painted
     while the log still ends with the previous turn's words. */
  root.addAction({ id: 'call-1', kind: 'call', tool: 'Bash', command: 'uname -a', status: 'running' })
  const stream = root.openStream({ at: AT, turnStamp: TURN })
  stream.push('LOCAL_POST_CUT linux')
  stream.close('LOCAL_POST_CUT linux')
  root.addOwnerMessage('the later request', { at: AT, turnStamp: TURN })

  const log = root.querySelector('.chat-log')
  const kinds = [...log.children].map(node => (node.classList.contains('chat-action') ? 'tool' : roleOf(node)))
  assert.deepEqual(kinds, ['them', 'me', 'tool', 'them'],
    'the request must sit above its own turn s tool run and below the earlier turn')
})

/* ---------- a saved history that is itself inverted ----------
 *
 * shell/node-transcript-capture.cjs stamps and appends the owner row only once
 * the send is acknowledged, while packet() can already have flushed the
 * assistant row. So the saved conversation can hold the inverted pair, and a
 * reload has to read correctly from a record nobody may rewrite. */

const LATER_TURN = '7d2b41c6-0a55-4e39-bb90-16f0c4b8e2d1'
const invertedHistory = () => [
  { who: 'you', text: 'the earlier request', at: AT - 120_000, turnStamp: EARLIER_TURN },
  { who: 'agent', text: 'the earlier answer', at: AT - 119_000, turnStamp: EARLIER_TURN },
  { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT, turnStamp: TURN },
  { who: 'you', text: 'Use host.exec to print the platform', at: AT, turnStamp: TURN },
  { who: 'you', text: 'the later request', at: AT + 600_000, turnStamp: LATER_TURN },
  { who: 'agent', text: 'the later answer', at: AT + 601_000, turnStamp: LATER_TURN },
]

test('a reload of an inverted saved history still reads request then answer', () => {
  const history = invertedHistory()
  const before = structuredClone(history)
  const root = restored(history)

  assert.deepEqual(rows(root).map(node => `${roleOf(node)}:${textOf(node)}`), [
    'me:the earlier request',
    'them:the earlier answer',
    'me:Use host.exec to print the platform',
    'them:LOCAL_POST_CUT linux',
    'me:the later request',
    'them:the later answer',
  ], 'the reload must show the question above the answer it asked for')

  assert.deepEqual(rows(root).map(stampOf), [
    EARLIER_TURN, EARLIER_TURN, TURN, TURN, LATER_TURN, LATER_TURN,
  ], 'every stored turn id survives the reload exactly')
  assert.deepEqual(history, before, 'the supplied history must not be rewritten')
})

test('a reload keeps each row on its own stored minute', () => {
  const root = restored(invertedHistory())
  const titles = rows(root).map(node => node.title)
  assert.equal(titles[2], titles[3], 'the two rows of one turn were saved in the same minute')
  assert.notEqual(titles[0], titles[2], 'an earlier turn keeps its own stored time, not the later one')
  assert.notEqual(titles[4], titles[2], 'a later turn keeps its own stored time too')
  for (const title of titles) assert.ok(title, 'a restored row is titled from its stored time')
})

test('a saved tool row is not claimed by a turn it does not name', () => {
  /* An action row in a saved conversation carries no turn id at all
     (sessionActionChatRow: id, tool, detail, state, body, at), so the reload
     cannot know whose turn it belonged to and must leave it where it was. */
  const root = restored([
    { who: 'you', text: 'the earlier request', at: AT - 120_000, turnStamp: EARLIER_TURN },
    { who: 'agent', text: 'the earlier answer', at: AT - 119_000, turnStamp: EARLIER_TURN },
    { who: 'action', id: 'action:call-1', tool: 'Bash', detail: 'uname -a', state: 'done', at: AT - 1000 },
    { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT, turnStamp: TURN },
    { who: 'you', text: 'Use host.exec to print the platform', at: AT, turnStamp: TURN },
  ])

  const log = root.querySelector('.chat-log')
  const kinds = [...log.children].map(node => (node.classList.contains('chat-action') ? 'tool' : roleOf(node)))
  assert.deepEqual(kinds, ['me', 'them', 'tool', 'me', 'them'],
    'the unnamed tool row stays where the record put it')
})

test("a saved turn's own context block stays with the line it was sent with", () => {
  /* The capture seam writes the person's line and its context parts in ONE
     append, with the same turn stamp, so the record holds them contiguously
     (node-transcript-capture.cjs, recordAcceptedTranscriptSend). Seating the
     line alone would leave its context under the answer. */
  const root = restored([
    { who: 'you', text: 'the earlier request', at: AT - 120_000, turnStamp: EARLIER_TURN },
    { who: 'agent', text: 'the earlier answer', at: AT - 119_000, turnStamp: EARLIER_TURN },
    { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT, turnStamp: TURN },
    { who: 'you', text: 'Use host.exec to print the platform', at: AT, turnStamp: TURN },
    { who: 'context', text: 'Standing rules: keep replies short.', at: AT, turnStamp: TURN,
      label: 'Added by ToolsEnabled', summary: 'Standing rules', openKey: 'session:requests' },
  ])

  const log = root.querySelector('.chat-log')
  assert.deepEqual([...log.children].map(node => roleOf(node)), [
    'me', 'them', 'me', 'context', 'them',
  ], 'the context block belongs under its own request and above the answer')
})

test('a context block from another turn is left where the record put it', () => {
  const root = restored([
    { who: 'you', text: 'the earlier request', at: AT - 120_000, turnStamp: EARLIER_TURN },
    { who: 'context', text: 'Standing rules: keep replies short.', at: AT - 120_000, turnStamp: EARLIER_TURN,
      label: 'Added by ToolsEnabled', summary: 'Standing rules', openKey: 'session:requests' },
    { who: 'agent', text: 'the earlier answer', at: AT - 119_000, turnStamp: EARLIER_TURN },
    { who: 'agent', text: 'LOCAL_POST_CUT linux', at: AT, turnStamp: TURN },
    { who: 'you', text: 'Use host.exec to print the platform', at: AT, turnStamp: TURN },
  ])

  const log = root.querySelector('.chat-log')
  assert.deepEqual([...log.children].map(node => roleOf(node)), [
    'me', 'context', 'them', 'me', 'them',
  ], 'an earlier turn and its context keep their saved places')
})

test('legacy ACP turn stamps reused by a later session cannot pull its request and context into the earlier turn', () => {
  for (const inverted of [false, true]) {
    const old = [
      { who: 'you', text: 'old request', at: AT, turnStamp: 'acp-turn-1' },
      { who: 'agent', text: 'old answer', at: AT, turnStamp: 'acp-turn-1' },
    ]
    const request = { who: 'you', text: 'new request', at: AT + 100000, turnStamp: 'acp-turn-1' }
    const answer = { who: 'agent', text: 'new answer', at: AT + 100000, turnStamp: 'acp-turn-1' }
    const context = { who: 'context', text: 'new context', at: AT + 100000, turnStamp: 'acp-turn-1',
      label: 'Added by ToolsEnabled', summary: 'New context', openKey: 'new-context' }
    const history = [...old, ...(inverted ? [answer, request, context] : [request, context, answer])]
    const before = structuredClone(history)
    const root = restored(history)
    assert.deepEqual(rows(root).filter(node => roleOf(node) !== 'context').map(textOf), inverted
      ? ['old request', 'old answer', 'new answer', 'new request']
      : ['old request', 'old answer', 'new request', 'new answer'],
    'a reused stamp is ambiguous; preserve the later stored order instead of moving it into the first turn')
    const children = [...root.querySelector('.chat-log').children]
    const contextIndex = children.findIndex(node => roleOf(node) === 'context')
    assert.equal(textOf(children[contextIndex - 1]), 'new request', 'the later context stays with its own request')
    assert.deepEqual(history, before, 'legacy records are never rewritten')
  }
})

async function sendFixture(t) {
  const sends = []
  const root = buildChat({ title: 'Observer', seed: 0, onSend: (text, callbacks) => sends.push({ text, callbacks }) })
  t.after(() => root.dispose())
  const send = async text => {
    root.querySelector('.chat-input input').value = text
    root.querySelector('.chat-send').dispatch('click')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    return sends.at(-1).callbacks
  }
  return { root, send }
}

test('late acceptance stamps each exact optimistic row without changing its words, time or copy control', async t => {
  const { root, send } = await sendFixture(t)
  const first = await send('identical words'), second = await send('identical words')
  const owners = rows(root).filter(row => roleOf(row) === 'me')
  const time = owners[0].querySelector('.chat-message-time')
  const copy = owners[0].querySelector('.chat-message-copy')
  second.accepted({ turnId: 'second-turn' }); first.accepted({ turnId: 'first-turn' })
  first.accepted({ turnId: 'wrong-later-turn' })
  assert.deepEqual(owners.map(stampOf), ['first-turn', 'second-turn'])
  assert.deepEqual(owners.map(textOf), ['identical words', 'identical words'])
  assert.equal(owners[0].querySelector('.chat-message-time'), time)
  assert.equal(owners[0].querySelector('.chat-message-copy'), copy)
  assert.equal(owners[0].querySelectorAll('.turn-stamp').length, 1)
})

test('queue acceptance and malformed receipts never invent a turn badge', async t => {
  const { root, send } = await sendFixture(t), callbacks = await send('waiting words')
  for (const receipt of [undefined, {}, { turnId: '' }, { turnId: ' ' }, { turnId: 42 }, { turnId: 'x'.repeat(513) }]) callbacks.accepted(receipt)
  assert.equal(stampOf(rows(root).find(row => roleOf(row) === 'me')), null)
})

test('late acceptance cannot restore a retracted row or change a disposed chat', async t => {
  const { root, send } = await sendFixture(t), queued = await send('queued later')
  const retracted = rows(root).find(row => roleOf(row) === 'me')
  queued.queued('Waiting in the queue.')
  queued.accepted({ turnId: 'late-queued-turn' })
  assert.equal(stampOf(retracted), null)
  assert.equal(rows(root).includes(retracted), false)
  const later = await send('a later row'), owner = rows(root).find(row => roleOf(row) === 'me')
  root.dispose(); later.accepted({ turnId: 'after-dispose' })
  assert.equal(stampOf(owner), null)
})

test('restored owner confirmation stamps only an exact mounted owner row', t => {
  const root = buildChat({ title: 'Observer', seed: 0, history: [
    { who: 'you', text: 'Restored owner' }, { who: 'agent', text: 'Restored answer' },
  ] })
  const foreign = buildChat({ title: 'Other', seed: 0 })
  t.after(() => { root.dispose(); foreign.dispose() })
  const [owner, answer] = rows(root)
  const otherOwner = foreign.addOwnerMessage('Other owner')
  const detached = root.addOwnerMessage('Detached owner')
  detached.remove()
  for (const row of [answer, otherOwner, detached, null]) root.confirmOwnerMessage(row, { turnId: 'wrong-turn' })
  for (const row of [answer, otherOwner, detached]) assert.equal(stampOf(row), null)
  root.confirmOwnerMessage(owner, { turnId: 'restored-turn' })
  root.confirmOwnerMessage(owner, { turnId: 'wrong-later-turn' })
  assert.equal(stampOf(owner), 'restored-turn')
  assert.equal(owner.querySelectorAll('.turn-stamp').length, 1)
})
