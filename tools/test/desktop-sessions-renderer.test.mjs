// A signed-in browser opening its computer's own conversations, against a
// stubbed window.mcDesktopSessions that follows the frozen interface: list,
// transcript and send, refusals as rejections with a code, and the session's
// events on the ordinary event channel.

import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const { document, restore } = installDomStandIn(globalThis)
const storageWrites = []
globalThis.localStorage = {
  getItem: () => null,
  setItem: (key, value) => { storageWrites.push([key, value]) },
  removeItem: key => { storageWrites.push([key, null]) },
}
test.after(() => restore())

const { buildChat } = await import('../../src/components.js')
const {
  desktopSessionsBridge,
  desktopSessionsOutsideTree,
  desktopStartedSessions,
  mergeTranscriptEntries,
  mountDesktopSessionChat,
  readDesktopSessionList,
} = await import('../../src/desktop-sessions.js')
const { DESKTOP_SESSION_COPY, DESKTOP_SESSION_SENTENCES, desktopSessionSentence } = await import('../../src/desktop-session-copy.js')
const { declaredFleetData } = await import('../../src/declared-fleet.js')
const { findingsInText } = await import('../check-plain-language.mjs')
const { isBareIdentifier } = await import('../../src/refusal-copy.js')

const tick = (turns = 12) => (async () => { for (let i = 0; i < turns; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) })()
const SID = 'desk-1'

function refusal(code) { return Object.assign(new Error(code), { code }) }

function row(overrides = {}) {
  return Object.freeze({
    sessionId: SID, agentId: 'writer', nodeId: 'n-1', name: 'Writer', provider: 'codex', tier: 'luna',
    busy: false, turnsCompleted: 1, lastTurnStatus: 'completed', transcript: true, openable: true, refusal: null,
    ...overrides,
  })
}

function hub() {
  const listeners = new Set()
  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    emit: packet => { for (const listener of [...listeners]) listener(packet) },
    get size() { return listeners.size },
  }
}

function stub({ transcript, send } = {}) {
  const calls = []
  return {
    calls,
    list: async () => { calls.push(['list']); return { ok: true, mayWrite: true, sessions: [], truncated: false } },
    transcript: async request => { calls.push(['transcript', { ...request }]); return transcript(request) },
    send: async request => { calls.push(['send', { ...request }]); return send ? send(request) : { ok: true, sessionId: request.sessionId, turnId: 't-new' } },
  }
}

function page(entries, extra = {}) {
  return { ok: true, sessionId: SID, bound: true, entries, before: null, ...extra }
}

function mount({ bridge, rowValue = row(), mayWrite = true, draft = null, isCurrent } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const events = hub()
  const chat = mountDesktopSessionChat({
    host, row: rowValue, mayWrite, bridge, subscribe: events.subscribe, buildChat,
    title: 'Writer', draft, isCurrent,
    scheduleFrame: callback => setTimeout(callback, 0), cancelFrame: clearTimeout,
  })
  return { host, chat, events }
}

const bubbles = (host, side) => host.querySelectorAll('.msg')
  .filter(message => message.classList.contains(side))
  .map(message => message.querySelector('.chat-msg-text')?.textContent ?? '')
const notes = host => host.querySelectorAll('.msg').filter(message => message.classList.contains('note')).map(message => message.textContent)
const ownerRows = host => host.querySelectorAll('.msg').filter(message => message.classList.contains('me'))
const stamp = message => message.querySelector('.turn-stamp')?.textContent ?? null
const unresolvedNotes = host => notes(host).filter(note => [
  DESKTOP_SESSION_COPY.sendUnconfirmed, DESKTOP_SESSION_COPY.sendNotShownYet, DESKTOP_SESSION_COPY.sendUncheckable,
].some(copy => note.includes(copy)))
const input = host => host.querySelector('.chat-input input')
async function type(host, text) {
  input(host).value = text
  host.querySelector('.chat-send').dispatch('click', { detail: 1 })
  await tick()
}

test('the list is copied field by field, and a row that is openable and refused is not openable', () => {
  const list = readDesktopSessionList({
    ok: true, mayWrite: false, truncated: false,
    sessions: [
      { sessionId: 'a', agentId: 'writer', name: 'Writer', provider: 'codex', tier: 'luna', busy: true, turnsCompleted: 2, transcript: true, openable: true, refusal: null, cwd: '/home/private', owner: 'window', account: 'secret' },
      { sessionId: 'b', agentId: null, openable: true, refusal: 'MC_AGENT_REMOTE_SESSION_BOUNDED_WORK' },
      { sessionId: 'a', agentId: 'duplicate' },
      { agentId: 'no-session' },
    ],
  })
  assert.equal(list.mayWrite, false)
  assert.deepEqual(list.rows.map(entry => entry.sessionId), ['a', 'b'])
  assert.deepEqual(Object.keys(list.rows[0]).sort(), ['agentId', 'busy', 'lastTurnStatus', 'name', 'nodeId', 'openable', 'provider', 'refusal', 'sessionId', 'tier', 'transcript', 'turnsCompleted'])
  assert.equal(JSON.stringify(list).includes('/home/'), false)
  assert.equal(list.rows[1].openable, false)
  assert.equal(list.rows[1].refusal, 'MC_AGENT_REMOTE_SESSION_BOUNDED_WORK')
  assert.equal(readDesktopSessionList({ ok: false }), null)
})

test('without the global, or without listed rows, the tree receives exactly the argument it had before', () => {
  assert.equal(desktopSessionsBridge({}), null)
  assert.equal(desktopSessionsBridge({ mcDesktopSessions: { list() {} } }), null)
  const live = { agentId: 'writer', sessionId: 'own', phase: 'open' }
  assert.equal(desktopStartedSessions(live, null), live)
  assert.equal(desktopStartedSessions(null, { rows: [] }), null)
})

test('listed rows draw declared agents once; the rest are offered as other conversations', () => {
  const org = { revision: 1, agents: [
    { id: 'writer', displayName: 'Writer', role: 'worker', provider: 'codex' },
    { id: 'reviewer', displayName: 'Reviewer', role: 'reviewer', provider: 'codex' },
  ] }
  const list = readDesktopSessionList({ ok: true, mayWrite: true, sessions: [
    { sessionId: 's-writer', agentId: 'writer', openable: true },
    { sessionId: 's-writer-2', agentId: 'writer', openable: true },
    { sessionId: 's-loose', agentId: null, openable: true },
    { sessionId: 's-unknown', agentId: 'not-declared', openable: true },
    { sessionId: 's-review', agentId: 'reviewer', openable: false, refusal: 'MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION' },
  ] })
  const data = declaredFleetData(org, desktopStartedSessions(null, list))
  assert.deepEqual(data.graph.nodes.map(node => [node.id, node.sessionId, node.origin]), [['writer', 's-writer', 'user'], ['reviewer', 's-review', 'user']])
  const drawn = new Set(data.graph.nodes.map(node => node.sessionId))
  assert.deepEqual(desktopSessionsOutsideTree(list, drawn).map(entry => entry.sessionId), ['s-writer-2', 's-loose', 's-unknown'])
})

test('a listed conversation that cannot be opened explains itself and asks the computer nothing', async () => {
  for (const code of ['MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION', 'MC_AGENT_REMOTE_SESSION_BOUNDED_WORK']) {
    const bridge = stub({ transcript: () => assert.fail('no read for a refused row') })
    const { host, chat, events } = mount({ bridge, rowValue: row({ openable: false, refusal: code }) })
    await chat.ready
    assert.equal(bridge.calls.length, 0)
    assert.equal(events.size, 0)
    assert.equal(host.dataset.refusalCode, code)
    assert.match(host.textContent, new RegExp(desktopSessionSentence(code).slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(input(host).disabled, true)
    chat.dispose()
  }
  assert.equal(desktopSessionSentence('MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION'),
    'This conversation started before this computer’s connection to your account last changed, so it can only be continued at the computer.')
  assert.equal(desktopSessionSentence('MC_AGENT_REMOTE_SESSION_BOUNDED_WORK'),
    'This agent is doing a bounded job that was started at the computer. Follow it there.')
})

test('an older computer is named as needing an update, and a failed read drops held events', async () => {
  let fail
  const bridge = stub({ transcript: () => new Promise((_, reject) => { fail = reject }) })
  const { host, chat, events } = mount({ bridge })
  await tick()
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'desktop', text: 'HELD_WORDS', turnId: 't-9', at: 1 } })
  fail(refusal('AGENT_FACADE_ABSENT'))
  await chat.ready
  assert.match(host.textContent, /needs an update/)
  assert.equal(host.textContent.includes('HELD_WORDS'), false)
  assert.equal(events.size, 0, 'the subscription is released with the refusal')
  assert.equal(input(host).disabled, true)
  chat.dispose()
})

test('the snapshot holds part of a reply and its completion arrives first: the full reply shows once', async () => {
  let releaseSnapshot
  const reads = []
  const bridge = stub({ transcript: request => {
    reads.push(request)
    if (reads.length === 1) return new Promise(resolve => { releaseSnapshot = resolve })
    return page([
      { id: `you:${SID}:t1`, who: 'you', text: 'Question one', at: 10, turnId: 't1', context: null, clipped: false },
      { id: `agent:${SID}:t1`, who: 'agent', text: 'The whole answer to question one.', at: 20, turnId: 't1', context: null, clipped: false },
    ])
  } })
  const { host, chat, events } = mount({ bridge })
  await tick()
  events.emit({ sessionId: SID, event: { type: 'assistant_text_delta', turnId: 't1', text: 'answer to ' } })
  events.emit({ sessionId: SID, event: { type: 'assistant_text_delta', turnId: 't1', text: 'question one.' } })
  events.emit({ sessionId: SID, event: { type: 'turn_completed', turnId: 't1', status: 'completed' } })
  releaseSnapshot(page([
    { id: `you:${SID}:t1`, who: 'you', text: 'Question one', at: 10, turnId: 't1', context: null, clipped: false },
    { id: `agent:${SID}:t1`, who: 'agent', text: 'The whole ', at: 20, turnId: 't1', context: null, clipped: false },
  ]))
  await chat.ready
  await tick()
  await chat.reconciled
  await tick()
  assert.equal(reads.length, 2, 'the held completion reads the transcript again')
  assert.deepEqual(bubbles(host, 'me'), ['Question one'])
  assert.deepEqual(bubbles(host, 'them'), ['The whole answer to question one.'])
  chat.dispose()
})

test('every live completion re-reads, and a reply streamed live is repainted to the saved text once', async () => {
  let saved = [{ id: `you:${SID}:t0`, who: 'you', text: 'Earlier question', at: 1, turnId: 't0', context: null, clipped: false }]
  const bridge = stub({ transcript: () => page(saved) })
  const { host, chat, events } = mount({ bridge })
  await chat.ready
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'desktop', text: 'Typed at the computer', turnId: 't2', at: 5 } })
  events.emit({ sessionId: SID, event: { type: 'assistant_text_delta', turnId: 't2', text: 'Streaming ' } })
  events.emit({ sessionId: SID, event: { type: 'assistant_text_delta', turnId: 't2', text: 'words' } })
  await tick()
  assert.deepEqual(bubbles(host, 'them'), ['Streaming words'])
  saved = [...saved,
    { id: `you:${SID}:t2`, who: 'you', text: 'Typed at the computer', at: 5, turnId: 't2', context: null, clipped: false },
    { id: `agent:${SID}:t2`, who: 'agent', text: 'Streaming words, saved in full.', at: 6, turnId: 't2', context: null, clipped: false }]
  events.emit({ sessionId: SID, event: { type: 'turn_completed', turnId: 't2', status: 'completed' } })
  await tick()
  await chat.reconciled
  assert.equal(bridge.calls.filter(([kind]) => kind === 'transcript').length, 2)
  assert.deepEqual(bubbles(host, 'me'), ['Earlier question', 'Typed at the computer'])
  assert.deepEqual(bubbles(host, 'them'), ['Streaming words, saved in full.'])
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'desktop', text: 'Typed at the computer', turnId: 't2', at: 5 } })
  assert.deepEqual(bubbles(host, 'me'), ['Earlier question', 'Typed at the computer'], 'a repeated person event is not painted twice')
  chat.dispose()
})

test('a person entry is joined by its entry id first; a stamp is only the fallback', () => {
  const merged = mergeTranscriptEntries(
    [{ id: 'you:x:r-1', who: 'you', text: 'one', turnId: 'r-1' }, { id: 'agent:x:t1', who: 'agent', text: 'par' }],
    [{ id: 'agent:x:t1', who: 'agent', text: 'partial done' }, { id: 'you:x:r-2', who: 'you', text: 'one', turnId: 'r-1' }],
  )
  assert.deepEqual(merged.map(entry => [entry.id, entry.text]), [['you:x:r-1', 'one'], ['agent:x:t1', 'partial done'], ['you:x:r-2', 'one']])
})

test('sending: accepted words stay once, and a refusal gives the words back with a plain reason', async () => {
  const answers = [
    () => ({ ok: true, sessionId: SID, turnId: 't-a' }),
    () => { throw refusal('AGENT_TURN_ACTIVE') },
    () => { throw refusal('MC_AGENT_PRINCIPAL_READ_ONLY') },
  ]
  const bridge = stub({ transcript: () => page([]), send: () => answers.shift()() })
  const { host, chat, events } = mount({ bridge })
  await chat.ready
  await type(host, 'First words')
  assert.deepEqual(bridge.calls.at(-1), ['send', { sessionId: SID, text: 'First words' }])
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text: 'First words', turnId: 't-a', at: 3 } })
  assert.deepEqual(bubbles(host, 'me'), ['First words'])
  assert.equal(stamp(ownerRows(host)[0]), 't-a')
  await type(host, 'Second words')
  assert.equal(input(host).value, 'Second words')
  assert.match(notes(host).join('\n'), /still replying/)
  assert.deepEqual(bubbles(host, 'me'), ['First words'])
  input(host).value = ''
  await type(host, 'Third words')
  assert.equal(input(host).value, 'Third words')
  assert.match(notes(host).join('\n'), /Let a signed-in browser drive this computer/)
  assert.equal(host.querySelectorAll('[data-refusal-code]').some(node => node.dataset.refusalCode === 'MC_AGENT_PRINCIPAL_READ_ONLY'), true)
  assert.equal(host.textContent.includes('MC_AGENT_'), false)
  chat.dispose()
})

test('a lost answer is never reported as not sent; the transcript settles it', async () => {
  let saved = []
  const bridge = stub({ transcript: () => page(saved), send: () => { throw refusal('BRIDGE_TIMEOUT') } })
  const { host, chat } = mount({ bridge })
  await chat.ready
  saved = [{ id: `you:${SID}:t-lost`, who: 'you', text: 'Did this arrive', at: 9, turnId: 't-lost', context: null, clipped: false }]
  await type(host, 'Did this arrive')
  await tick()
  assert.deepEqual(bubbles(host, 'me'), ['Did this arrive'], 'the words stay on screen')
  const said = notes(host).join('\n')
  assert.deepEqual(unresolvedNotes(host), [], 'confirmed delivery replaces its earlier warning')
  assert.match(said, /no need to send it again/)
  assert.equal(stamp(ownerRows(host)[0]), 't-lost')
  assert.equal(/not sent|nothing was sent/i.test(said), false)
  assert.equal(input(host).value, '')
  chat.dispose()
})

// The native HTTP forwarding leg can lose a response after accepting a turn.
// Its four bounded unknown-outcome refusals are not provider/admission refusals.
for (const code of ['AGENT_FACADE_TIMEOUT', 'AGENT_FACADE_ABORTED', 'AGENT_FACADE_UNREACHABLE', 'AGENT_FACADE_RESPONSE_TOO_LARGE']) {
  test(`${code}: late acceptance keeps one message and does not restore a duplicate draft`, async () => {
    const text = 'FRA delayed acknowledgement'
    let saved = []
    const bridge = stub({ transcript: () => page(saved), send: () => { throw refusal(code) } })
    const { host, chat, events } = mount({ bridge })
    await chat.ready
    await type(host, text)
    assert.equal(input(host).value, '', 'an uncertain send must not be offered for immediate duplicate retry')
    assert.deepEqual(bubbles(host, 'me'), [text])
    assert.equal(unresolvedNotes(host).length, 1)
    assert.equal(notes(host).some(note => /did not complete|try again|not sent/i.test(note)), false)
    input(host).value = 'A different unfinished thought'
    const turnId = 'delayed-turn'
    saved = [
      { id: `you:${SID}:${turnId}`, who: 'you', text, at: 9, turnId, context: null, clipped: false },
      { id: `agent:${SID}:${turnId}`, who: 'agent', text: 'Acknowledged once', at: 10, turnId, context: null, clipped: false },
    ]
    events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text, turnId, at: 9 } })
    events.emit({ sessionId: SID, event: { type: 'turn_completed', turnId, status: 'success' } })
    await tick()
    assert.deepEqual(bubbles(host, 'me'), [text])
    assert.deepEqual(bubbles(host, 'them'), ['Acknowledged once'])
    assert.match(notes(host).join('\n'), /no need to send it again/)
    assert.deepEqual(unresolvedNotes(host), [])
    assert.equal(stamp(ownerRows(host)[0]), turnId)
    assert.equal(input(host).value, 'A different unfinished thought', 'late confirmation preserves newer drafting')
    assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 1)
    chat.dispose()
  })
}

test('a send whose answer was lost never blocks earlier messages, and stays unconfirmed after the repaint', async () => {
  const bridge = stub({
    transcript: request => request.before === 'cursor-1'
      ? page([{ id: `you:${SID}:t0`, who: 'you', text: 'Oldest question', at: 1, turnId: 't0', context: null, clipped: false }], { before: null })
      : page([{ id: `agent:${SID}:t1`, who: 'agent', text: 'Newest reply', at: 5, turnId: 't1', context: null, clipped: false }], { before: 'cursor-1' }),
    send: () => { throw refusal('BRIDGE_UNREACHABLE') },
  })
  const { host, chat } = mount({ bridge })
  await chat.ready
  await type(host, 'Lost on the way')
  await tick()
  assert.equal(unresolvedNotes(host).length, 1)
  host.querySelector('[data-desktop-chat-earlier]').dispatch('click')
  await tick()
  assert.deepEqual(bridge.calls.filter(([kind, request]) => kind === 'transcript' && request.before === 'cursor-1').length, 1, 'the older page was read')
  assert.deepEqual(bubbles(host, 'me'), ['Oldest question', 'Lost on the way'])
  assert.equal(unresolvedNotes(host).length, 1)
  assert.equal(/not sent|nothing was sent/i.test(notes(host).join('\n')), false)
  chat.dispose()
})

for (const evidence of ['event', 'transcript']) {
  test(`late ${evidence} confirmation updates the repainted owner row and preserves a newer draft`, async () => {
    const text = 'Message awaiting its receipt'
    const turnId = 'repainted-turn'
    let saved = []
    const bridge = stub({
      transcript: request => request.before
        ? page([{ id: 'oldest', who: 'you', text: 'Earlier message', turnId: 'earlier-turn' }])
        : page(saved, { before: 'older' }),
      send: () => { throw refusal('BRIDGE_UNREACHABLE') },
    })
    const { host, chat, events } = mount({ bridge })
    await chat.ready
    await type(host, text)
    const detachedOwner = ownerRows(host)[0]
    host.querySelector('[data-desktop-chat-earlier]').dispatch('click')
    await tick()
    const owner = ownerRows(host).at(-1)
    assert.notEqual(owner, detachedOwner)
    const composer = input(host)
    composer.value = 'Keep this newer draft'
    const unrelatedNote = chat.root.addNote('An unrelated conversation notice')
    saved = [
      { id: `you:${SID}:${turnId}`, who: 'you', text, turnId, at: 9 },
      { id: `agent:${SID}:${turnId}`, who: 'agent', text: 'Reply received', turnId, at: 10 },
    ]
    if (evidence === 'event') events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text, turnId, at: 9 } })
    events.emit({ sessionId: SID, event: { type: 'turn_completed', turnId, status: 'success' } })
    await tick()
    await chat.reconciled
    assert.deepEqual(unresolvedNotes(host), [])
    assert.equal(notes(host).filter(note => note.includes(DESKTOP_SESSION_COPY.sendConfirmed)).length, 1)
    assert.equal(ownerRows(host).at(-1), owner, 'confirmation updates the mounted row in place')
    assert.equal(stamp(owner), turnId)
    assert.equal(stamp(detachedOwner), null, 'no late mutation of the retired chat')
    assert.deepEqual(bubbles(host, 'me'), ['Earlier message', text])
    assert.deepEqual(bubbles(host, 'them'), ['Reply received'])
    assert.equal(input(host), composer)
    assert.equal(composer.value, 'Keep this newer draft')
    assert.equal(unrelatedNote.parentNode !== null, true, 'confirmation leaves unrelated notices alone')
    assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 1)
    chat.dispose()
  })
}

test('a canonical record confirms only one pending send with identical words', async () => {
  const text = 'Repeated intentionally'
  const oldEntry = { id: 'old-person', who: 'you', text, turnId: 'old-turn' }
  let saved = [oldEntry]
  const heldChecks = []
  let reads = 0
  const bridge = stub({
    transcript: () => ++reads > 1 && reads <= 3 ? new Promise(resolve => heldChecks.push(resolve)) : page(saved),
    send: () => { throw refusal('BRIDGE_TIMEOUT') },
  })
  const { host, chat, events } = mount({ bridge })
  await chat.ready
  await type(host, text)
  await type(host, text)
  assert.equal(unresolvedNotes(host).length, 2, 'the historical matching words confirm neither send')
  const [old, first, second] = ownerRows(host)
  const composer = input(host)
  composer.value = 'A third draft'
  events.emit({ sessionId: 'other-session', event: { type: 'person_turn', via: 'remote', text, turnId: 'foreign-turn' } })
  assert.equal(unresolvedNotes(host).length, 2)
  saved = [oldEntry, { id: 'first-person', who: 'you', text, turnId: 'first-turn' }]
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text, turnId: 'first-turn' } })
  for (const release of heldChecks) release(page(saved))
  await tick()
  assert.equal(unresolvedNotes(host).length, 1, 'late lost-answer checks cannot reuse a claimed turn')
  chat.resync()
  await tick()
  assert.equal(unresolvedNotes(host).length, 1)
  assert.equal(stamp(first), 'first-turn')
  assert.equal(stamp(second), null, 'repeated evidence cannot confirm the second send')
  assert.equal(stamp(old), 'old-turn')
  saved.push({ id: 'second-person', who: 'you', text, turnId: 'second-turn' })
  chat.resync()
  await tick()
  assert.deepEqual(unresolvedNotes(host), [])
  assert.equal(stamp(second), 'second-turn')
  assert.deepEqual(ownerRows(host), [old, first, second])
  assert.equal(composer.value, 'A third draft')
  assert.equal(input(host), composer)
  assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 2)
  chat.dispose()
})

test('confirmation that precedes a lost send answer stamps the original row without a warning', async () => {
  let rejectSend
  const bridge = stub({ transcript: () => page([]), send: () => new Promise((_, reject) => { rejectSend = reject }) })
  const { host, chat, events } = mount({ bridge })
  await chat.ready
  await type(host, 'Fast native acceptance')
  const owner = ownerRows(host)[0]
  input(host).value = 'New draft before the lost answer'
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text: 'Fast native acceptance', turnId: 'fast-turn' } })
  rejectSend(refusal('BRIDGE_UNREACHABLE'))
  await tick()
  assert.equal(stamp(owner), 'fast-turn')
  assert.deepEqual(unresolvedNotes(host), [])
  assert.deepEqual(ownerRows(host), [owner])
  assert.equal(input(host).value, 'New draft before the lost answer')
  assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 1)
  chat.dispose()
})

test('an accepted send awaiting its turn id survives earlier-history loading and matches once', async () => {
  const bridge = stub({
    transcript: request => page([], { before: request.before ? null : 'older' }),
    send: () => ({ ok: true, sessionId: SID }),
  })
  const { host, chat, events } = mount({ bridge })
  await chat.ready
  await type(host, 'Accepted without a turn stamp yet')
  host.querySelector('[data-desktop-chat-earlier]').dispatch('click')
  await tick()
  assert.equal(bridge.calls.some(([kind, request]) => kind === 'transcript' && request.before === 'older'), true)
  const owner = ownerRows(host)[0]
  assert.deepEqual(bubbles(host, 'me'), ['Accepted without a turn stamp yet'])
  events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text: 'Accepted without a turn stamp yet', turnId: 'accepted-turn' } })
  assert.equal(stamp(owner), 'accepted-turn')
  assert.deepEqual(unresolvedNotes(host), [])
  assert.deepEqual(ownerRows(host), [owner])
  assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 1)
  chat.dispose()
})

test('a failed check keeps one unknown status until fresh transcript evidence arrives', async () => {
  let saved = null
  let reads = 0
  const bridge = stub({
    transcript: () => ++reads === 1 ? page([]) : saved ? page(saved) : Promise.reject(refusal('BRIDGE_UNREACHABLE')),
    send: () => { throw refusal('BRIDGE_UNREACHABLE') },
  })
  const { host, chat } = mount({ bridge })
  await chat.ready
  await type(host, 'Confirm after reconnect')
  assert.equal(unresolvedNotes(host).length, 1)
  assert.match(unresolvedNotes(host)[0], /could not be checked/)
  const owner = ownerRows(host)[0]
  saved = [{ id: 'reconnected-person', who: 'you', text: 'Confirm after reconnect', turnId: 'reconnected-turn' }]
  chat.resync()
  await tick()
  assert.deepEqual(unresolvedNotes(host), [])
  assert.equal(stamp(owner), 'reconnected-turn')
  assert.equal(host.querySelectorAll('[data-refusal-code]').length, 0)
  assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 1)
  chat.dispose()
})

for (const boundary of ['disposed', 'account changed']) {
  test(`a delayed confirmation after ${boundary} cannot touch the old chat`, async () => {
    let current = true
    let releaseRead
    let reads = 0
    const bridge = stub({
      transcript: () => ++reads === 1 ? page([]) : new Promise(resolve => { releaseRead = resolve }),
      send: () => { throw refusal('BRIDGE_UNREACHABLE') },
    })
    const { host, chat, events } = mount({ bridge, isCurrent: () => current })
    await chat.ready
    await type(host, 'Private pending message')
    if (boundary === 'disposed') chat.dispose()
    else current = false
    const before = host.textContent
    events.emit({ sessionId: SID, event: { type: 'person_turn', via: 'remote', text: 'Private pending message', turnId: 'late-turn' } })
    releaseRead(page([{ id: 'late-person', who: 'you', text: 'Private pending message', turnId: 'late-turn' }]))
    await tick()
    assert.equal(host.textContent, before)
    assert.equal(stamp(ownerRows(host)[0]), null)
    assert.equal(bridge.calls.filter(([kind]) => kind === 'send').length, 1)
    chat.dispose()
  })
}

test('when the computer lets this browser only read, the composer is off and says why; reading still works', async () => {
  const bridge = stub({ transcript: () => page([{ id: `agent:${SID}:t1`, who: 'agent', text: 'Readable reply', at: 1, turnId: 't1', context: null, clipped: false }]) })
  const { host, chat } = mount({ bridge, mayWrite: false })
  await chat.ready
  assert.deepEqual(bubbles(host, 'them'), ['Readable reply'])
  assert.equal(input(host).disabled, true)
  assert.match(host.querySelector('.chat-nosend').textContent, /Let a signed-in browser drive this computer/)
  chat.dispose()
})

test('earlier messages page back by the computer’s cursor and keep the draft', async () => {
  const bridge = stub({ transcript: request => request.before === 'cursor-1'
    ? page([{ id: `you:${SID}:t0`, who: 'you', text: 'Oldest question', at: 1, turnId: 't0', context: null, clipped: false }], { before: null })
    : page([{ id: `agent:${SID}:t1`, who: 'agent', text: 'Newest reply', at: 5, turnId: 't1', context: null, clipped: false }], { before: 'cursor-1' }) })
  const { host, chat } = mount({ bridge })
  await chat.ready
  input(host).value = 'half typed'
  host.querySelector('[data-desktop-chat-earlier]').dispatch('click')
  await tick()
  assert.deepEqual(bridge.calls.filter(([kind]) => kind === 'transcript').map(([, request]) => request.before ?? null), [null, 'cursor-1', null])
  assert.deepEqual(bubbles(host, 'me'), ['Oldest question'])
  assert.deepEqual(bubbles(host, 'them'), ['Newest reply'])
  assert.equal(input(host).value, 'half typed')
  assert.equal(host.querySelector('[data-desktop-chat-earlier]'), null, 'no cursor, no button')
  chat.dispose()
})

test('an answer that lands after the fence moved is dropped', async () => {
  let current = true
  let release
  const bridge = stub({ transcript: () => new Promise(resolve => { release = resolve }) })
  const { host, chat } = mount({ bridge, isCurrent: () => current })
  await tick()
  current = false
  release(page([{ id: `agent:${SID}:t1`, who: 'agent', text: 'LATE_REPLY', at: 1, turnId: 't1', context: null, clipped: false }]))
  await chat.ready
  assert.equal(host.textContent.includes('LATE_REPLY'), false)
  assert.equal(host.querySelector('.chat'), null)
  chat.dispose()
})

test('a failed turn never shows its raw failure text', async () => {
  const bridge = stub({ transcript: () => page([]) })
  const { host, chat, events } = mount({ bridge })
  await chat.ready
  events.emit({ sessionId: SID, event: { type: 'turn_failed', turnId: 't-f', text: 'PROVIDER_STACK at /home/private/secret.js:12' } })
  events.emit({ sessionId: SID, event: { type: 'turn_completed', turnId: 't-g', status: 'failed', text: 'You are out of usage for today.' } })
  await tick()
  await chat.reconciled
  const said = notes(host)
  assert.equal(said.join('\n').includes('/home/private'), false)
  assert.equal(said.join('\n').includes('PROVIDER_STACK'), false)
  assert.equal(said.join('\n').includes('out of usage'), false, 'a failed completion shows no adapter text either')
  assert.equal(said.filter(text => text.includes(DESKTOP_SESSION_COPY.turnFailed)).length, 2)
  chat.dispose()
})

test('no desktop conversation is written to browser storage', () => {
  assert.deepEqual(storageWrites, [])
})

test('every sentence is plain, actionable, and carries no code', () => {
  const sentences = [...Object.values(DESKTOP_SESSION_SENTENCES),
    ...Object.values(DESKTOP_SESSION_COPY).filter(value => typeof value === 'string'),
    ...Object.values(DESKTOP_SESSION_COPY.contextSummary)]
  for (const sentence of sentences) {
    assert.equal(isBareIdentifier(sentence), false, sentence)
    assert.equal(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(sentence), false, sentence)
    assert.deepEqual(findingsInText(sentence), [], sentence)
  }
  for (const sentence of Object.values(DESKTOP_SESSION_SENTENCES)) {
    assert.ok(sentence.length >= 40 && /[.!?]$/.test(sentence), sentence)
  }
})
