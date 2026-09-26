import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChat } from '../../src/components.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createDrafts, createRailView, functionSource } from './helpers/tree-rail-chat-harness.mjs'
import vm from 'node:vm'

// Execute the real rail mount, registration and shared broadcaster together.
// Previously the rail was excluded from the broadcaster but never seeded its
// own stream, so opening it during a tool burst lost all earlier live speech.
function fixture(t, { text = 'I found the cause.\n\nChecking the fix now.', turn = 'turn-current', history = [], recovered = false } = {}) {
  const dom = installDomStandIn()
  const extra = {
    destroyed: false, chatSurfaces: new Map(), chatSurfaceSessions: new WeakMap(),
    chatSpeech: new WeakMap(), chatSpeechMounts: new WeakMap(),
    sessionPendingApprovals: new Map(), standaloneSettledTurns: new Map(),
    sessionTurnText: new Map(text === null ? [] : [['session', text]]),
    sessionOpenTurns: new Map(turn ? [['session', turn]] : []),
    nativeReconcileSessions: new Set(recovered ? ['session'] : []), queueMicrotask,
  }
  let view
  view = createRailView({ buildChat, drafts: createDrafts(), extra,
    configFor: node => ({ history, status: { busy: () => Boolean(turn) },
      onReady: root => view.context.registerChatSurface(node.sessionId, root) }),
  })
  vm.runInContext(['unregisterChatSurface', 'registerChatSurface', 'broadcastChatSpeech']
    .map(functionSource).join('\n'), view.context)
  const chat = view.mount({ id: 'builder', sessionId: 'session' })
  t.after(() => { view.destroy(); dom.restore() })
  return { view, chat, ...extra }
}

test('opening the actual rail during a tool burst immediately shows earlier agent speech', async t => {
  const h = fixture(t)
  await Promise.resolve() // same deferred registration as the real rail
  assert.match(h.chat.textContent, /I found the cause/)
  assert.equal(h.chat.querySelectorAll('.them').length, 1)
  assert.equal(h.chat.querySelector('.turn-stamp').textContent, 'turn-current')
  assert.ok(h.view.rail().stream, 'later events must reuse the seeded rail stream')
  h.view.rail().stream.push('I found the cause.\n\nThe fix is ready.')
  h.view.rail().stream.close('## Result\n\nThe fix is ready.')
  assert.equal(h.chat.querySelectorAll('.them').length, 1)
  assert.equal(h.chat.querySelector('.md-h').textContent, 'Result')
  assert.equal(h.chat.querySelector('.them').hasAttribute('aria-busy'), false)
})

test('an active tool-only turn has a visible pending reply and can receive its outcome', async t => {
  const h = fixture(t, { text: null })
  await Promise.resolve()
  assert.ok(h.view.rail().stream, 'a named active turn must not disappear behind completed tools')
  assert.ok(h.chat.querySelector('.chat-stream-pending'))
  h.view.rail().stream.close('The agent finished without a text reply.')
  assert.match(h.chat.textContent, /finished without a text reply/)
  assert.equal(h.chat.querySelector('.chat-stream-pending'), null)
})

test('reopening an idle rail does not invent a pending answer', async t => {
  const h = fixture(t, { text: null, turn: null, history: [{ who: 'agent', text: 'Saved answer.' }] })
  await Promise.resolve()
  assert.equal(h.view.rail().stream, null)
  assert.equal(h.chat.querySelectorAll('.them').length, 1)
  assert.equal(h.chat.querySelector('.chat-stream-pending'), null)
})

test('a recovered live rail refines its identified saved row without duplicating it', async t => {
  const h = fixture(t, { recovered: true, history: [
    { id: 'agent:session:turn-current', who: 'agent', text: 'Earlier partial.', turnStamp: 'turn-current' },
  ] })
  await Promise.resolve()
  assert.equal(h.chat.querySelectorAll('.them').length, 1)
  assert.match(h.chat.textContent, /Checking the fix now/)
  assert.doesNotMatch(h.chat.textContent, /Earlier partial/)
})

test('switching to another rail cannot replay the previous agent into it', async t => {
  const h = fixture(t)
  const next = h.view.mount({ id: 'other-builder', sessionId: 'other-session' })
  await Promise.resolve()
  assert.doesNotMatch(next.textContent, /I found the cause|Checking the fix/)
  assert.equal(h.view.rail().stream, null)
})
