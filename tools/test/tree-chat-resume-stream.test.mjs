import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildChat } from '../../src/components.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const methods = ['unregisterChatSurface', 'registerChatSurface', 'broadcastChatSpeech', 'scheduleChatSpeech', 'broadcastAction']
  .map(name => declaredFunctionSource(source, name)).join('\n')
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function setup(t, { busy = true } = {}) {
  const { document, restore } = installDomStandIn()
  const frames = new Map(), surfaces = [], subscriptions = new Set()
  let nextFrame = 0
  const scope = {
    destroyed: false, railChat: null, chatSurfaces: new Map(), chatSurfaceSessions: new WeakMap(),
    chatSpeech: new WeakMap(), chatSpeechMounts: new WeakMap(), chatSpeechPending: new Set(), chatSpeechFrame: 0,
    standaloneSettledTurns: new Map(), sessionPendingApprovals: new Map(), sessionTurnText: new Map(busy ? [['session', 'Already spoken']] : []),
    sessionOpenTurns: new Map(busy ? [['session', 'turn-a']] : []), sessionCompletedTurnIds: new Map(), nativeReconcileSessions: new Set(),
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame }, queueMicrotask,
  }
  const api = new Function(...Object.keys(scope), `${methods}\nreturn {register:registerChatSurface,unregister:unregisterChatSurface,broadcast:broadcastChatSpeech,schedule:scheduleChatSpeech,action:broadcastAction,destroy(){destroyed=true; for(const roots of chatSurfaces.values())for(const root of [...roots])unregisterChatSurface(root);}}`)(...Object.values(scope))
  const mount = ({ attach = true, sessionId = 'session', history = [{ who: 'you', text: 'Earlier request' }] } = {}) => {
    const root = buildChat({ title: 'Actual shared chat', seed: 0,
      history,
      onReady: root => api.register(sessionId, root),
      status: { busy: () => busy, subscribe: listener => { subscriptions.add(listener); return () => { subscriptions.delete(listener); api.unregister(root) } } },
    })
    surfaces.push(root)
    if (attach) document.body.appendChild(root)
    return root
  }
  const paint = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) }
  const complete = (text, turnId = 'turn-a') => {
    scope.sessionTurnText.delete('session'); scope.sessionOpenTurns.delete('session'); busy = false
    api.broadcast('session', text, { turnId, complete: true })
    for (const listener of subscriptions) listener()
  }
  t.after(() => { api.destroy(); surfaces.forEach(root => { root.dispose(); root.remove() }); restore() })
  return { ...scope, api, mount, paint, complete, frames, document }
}

test('a reopened real chat shares one partial stream, batched deltas and one completed turn', async t => {
  const h = setup(t), chat = h.mount()
  await settle()
  assert.equal(chat.querySelectorAll('.them').length, 1)
  assert.match(chat.textContent, /Already spoken/)
  h.sessionTurnText.set('session', 'Already spoken and later words')
  h.api.schedule('session'); h.api.schedule('session')
  assert.equal(h.frames.size, 1)
  h.paint(); assert.match(chat.textContent, /Already spoken and later words/)
  h.complete('Full final answer'); h.complete('Duplicate late completion')
  assert.equal(chat.querySelectorAll('.them').length, 1)
  assert.match(chat.textContent, /Full final answer/)
  assert.doesNotMatch(chat.textContent, /Duplicate late completion/)
  assert.equal(chat.querySelectorAll('.them')[0].hasAttribute('aria-busy'), false)
  h.api.broadcast('session', 'Independent next reply', { turnId: 'turn-b' })
  h.api.broadcast('session', 'Independent next final', { turnId: 'turn-b', complete: true })
  assert.equal(chat.querySelectorAll('.them').length, 2)
  assert.match(chat.querySelectorAll('.them')[1].textContent, /Independent next final/)
})

test('completion after onReady but before append is painted once, without losing final words', async t => {
  const h = setup(t), chat = h.mount({ attach: false })
  h.complete('Finished before insertion')
  h.document.body.appendChild(chat)
  await settle()
  assert.equal(chat.querySelectorAll('.them').length, 1)
  assert.match(chat.textContent, /Finished before insertion/)
  assert.doesNotMatch(chat.textContent, /Already spoken/)
  assert.equal(chat.querySelectorAll('.them')[0].hasAttribute('aria-busy'), false)
})

test('different turns completing in the mount gap retain their own bubbles in order', async t => {
  const h = setup(t), chat = h.mount({ attach: false })
  h.complete('First turn final')
  h.api.broadcast('session', 'Next turn partial', { turnId: 'turn-b' })
  h.api.broadcast('session', 'Next turn final', { turnId: 'turn-b', complete: true })
  h.document.body.appendChild(chat)
  await settle()
  assert.equal(chat.querySelectorAll('.them').length, 2)
  assert.match(chat.querySelectorAll('.them')[0].textContent, /First turn final/)
  assert.match(chat.querySelectorAll('.them')[1].textContent, /Next turn final/)
})

test('an idle chat and a never-inserted chat acquire no stream; removal releases registration', async t => {
  const h = setup(t, { busy: false }), idle = h.mount()
  await settle(); assert.equal(idle.querySelectorAll('.them').length, 0)
  const removed = h.mount({ attach: false })
  await settle()
  assert.equal(removed.querySelectorAll('.them').length, 0)
  assert.equal(h.chatSurfaces.get('session').size, 1)
  idle.dispose(); idle.remove()
  assert.equal(h.chatSurfaces.size, 0)
})

test('session replacement cancels a pending old mount and settles an already mounted stream', async t => {
  const h = setup(t), chat = h.mount()
  h.api.register('replacement', chat)
  h.api.broadcast('session', 'Must not arrive', { turnId: 'turn-a', complete: true })
  await settle()
  assert.equal(chat.querySelectorAll('.them').length, 0)
  h.api.broadcast('replacement', 'Replacement words', { turnId: 'turn-b' })
  h.api.register('third', chat)
  assert.equal(chat.querySelectorAll('.them')[0].hasAttribute('aria-busy'), false)
  await settle()
  h.api.broadcast('replacement', 'Late replacement words', { turnId: 'turn-b' })
  assert.doesNotMatch(chat.textContent, /Late replacement|Must not arrive/)
  assert.equal(h.chatSurfaces.has('replacement'), false)
  assert.equal(h.chatSurfaces.get('third').size, 1)
})

test('destroy during mount and detached broadcasts release ownership without native operations', async t => {
  const h = setup(t), chat = h.mount()
  h.api.destroy(); await settle()
  assert.equal(chat.querySelectorAll('.them').length, 0)
  assert.equal(h.chatSurfaces.size, 0)
})

test('only an explicitly named unique agent history entry can be resumed, preserving its position and evidence', t => {
  const { document, restore } = installDomStandIn()
  const chat = buildChat({ title: 'Actual history', seed: 0, history: [
    { id: 'earlier', who: 'agent', text: 'Earlier answer', at: 1000, turnStamp: 'old-turn' },
    { id: 'halted', who: 'agent', text: 'Saved partial without a provider stamp', at: 2000 },
    { id: 'owner', who: 'you', text: 'A later owner message', at: 3000 },
  ] })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove(); restore() })
  chat.importDraft({ text: 'Unsent draft', attachments: [{ path: '/fixture/image.png', name: 'image.png' }], start: 2, end: 5 })
  chat.querySelector('.chat-input input').selectionStart = 2
  chat.querySelector('.chat-input input').selectionEnd = 5
  const row = chat.querySelectorAll('.them')[1], footer = row.querySelector('.chat-msg-footer'), before = [...row.parentNode.children]
  const stream = chat.openStream({ entryId: 'halted', at: 999999, turnStamp: 'must-not-invent-evidence' })
  stream.push('Saved partial plus real late words'); stream.close('Actual final words')
  assert.equal(chat.querySelectorAll('.them').length, 2)
  assert.deepEqual([...row.parentNode.children], before)
  assert.equal(chat.querySelectorAll('.them')[1], row)
  assert.equal(row.querySelector('.chat-msg-footer'), footer)
  assert.equal(row.querySelector('.turn-stamp'), null)
  assert.match(row.textContent, /Actual final words/)
  assert.match(chat.querySelectorAll('.them')[0].textContent, /Earlier answer/)
  assert.equal(chat.exportDraft().text, 'Unsent draft')
  assert.deepEqual([chat.exportDraft().start, chat.exportDraft().end], [2, 5])
  assert.equal(chat.exportDraft().attachments.length, 1)
  stream.push('Late after real completion'); stream.close('Second completion')
  assert.doesNotMatch(row.textContent, /Late after real completion|Second completion/)
  const unrelated = chat.openStream({ at: 999999, turnStamp: 'old-turn' })
  unrelated.close('New stream even when a stamp matches history')
  assert.equal(chat.querySelectorAll('.them').length, 3)
  chat.openStream({ entryId: 'halted' }).close('An already claimed row is not reusable again')
  assert.equal(chat.querySelectorAll('.them').length, 4)
})

test('ambiguous or owner history identities cannot be used to overwrite an agent reply', t => {
  const { document, restore } = installDomStandIn()
  const chat = buildChat({ title: 'Actual history', seed: 0, history: [
    { id: 'duplicate', who: 'agent', text: 'First original' },
    { id: 'duplicate', who: 'agent', text: 'Second original' },
    { id: 'owner', who: 'you', text: 'Owner original' },
  ] })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove(); restore() })
  chat.openStream({ entryId: 'duplicate' }).close('New reply one')
  chat.openStream({ entryId: 'owner' }).close('New reply two')
  assert.equal(chat.querySelectorAll('.them').length, 4)
  assert.match(chat.querySelectorAll('.them')[0].textContent, /First original/)
  assert.match(chat.querySelectorAll('.them')[1].textContent, /Second original/)
  assert.match(chat.querySelectorAll('.me')[0].textContent, /Owner original/)
})

test('only a provisional Halt close permits later real words before terminal completion', t => {
  const { document, restore } = installDomStandIn()
  const chat = buildChat({ title: 'Actual stream', seed: 0, history: [] })
  document.body.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove(); restore() })
  const stream = chat.openStream({ turnStamp: 'real-turn' })
  stream.push('Actual partial'); stream.close('Actual partial', { provisional: true })
  assert.equal(chat.querySelectorAll('.them')[0].hasAttribute('aria-busy'), false)
  stream.push('Actual partial and late provider words')
  stream.close('Final provider answer')
  stream.push('Forbidden later overwrite'); stream.close('Repeated completion')
  assert.equal(chat.querySelectorAll('.them').length, 1)
  assert.match(chat.textContent, /Final provider answer/)
  assert.doesNotMatch(chat.textContent, /Forbidden|Repeated/)
})


test('a Halt completion in the insertion gap retains the exact saved row identity after settlement clears', async t => {
  const h = setup(t)
  h.standaloneSettledTurns.set('session', { id: 'saved-halt', turnId: 'turn-a' })
  const chat = h.mount({ attach: false, history: [{ id: 'saved-halt', who: 'agent', text: 'Already spoken', turnStamp: 'turn-a' }] })
  const row = chat.querySelectorAll('.them')[0]
  // The actual completion persists first and clears the provisional marker
  // before it reaches the broadcaster. The pending mount keeps its row id.
  h.standaloneSettledTurns.delete('session')
  h.complete('Final words received during insertion')
  h.document.body.appendChild(chat)
  await settle()
  assert.equal(chat.querySelectorAll('.them').length, 1)
  assert.equal(chat.querySelectorAll('.them')[0], row)
  assert.match(row.textContent, /Final words received during insertion/)
  assert.equal(row.hasAttribute('aria-busy'), false)
})


test('an action in the insertion gap cannot unregister the chat before its reply completes', async t => {
  const h = setup(t), chat = h.mount({ attach: false })
  h.api.action('session', { id: 'real-action', tool: 'read', detail: 'Actual tool observation', state: 'done' })
  h.complete('Reply after the tool')
  h.document.body.appendChild(chat)
  await settle()
  assert.equal(chat.querySelectorAll('.them').length, 1)
  assert.match(chat.textContent, /Reply after the tool/)
  assert.equal(h.chatSurfaces.get('session')?.size, 1)
})
