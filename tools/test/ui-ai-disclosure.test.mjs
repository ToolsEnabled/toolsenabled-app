import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const world = installDomStandIn()
after(() => world.restore())
const { buildChat } = await import('../../src/components.js')

for (const [state, options] of [
  ['new chat', { title: 'Coordinator', history: [] }],
  ['resumed chat', { title: 'Coordinator', history: [{ who: 'owner', text: 'Resume my task' }, { who: 'agent', text: 'Saved response' }] }],
  ['changed agent', { title: 'Reviewer', history: [] }],
  ['changed model', { title: 'Coordinator', history: [{ who: 'agent', text: 'Conversation carried onto the selected model' }], chips: { model: () => ({ label: 'selected-model' }) } }],
]) test(`${state} discloses AI identity before the transcript and keeps it through new output`, t => {
  const chat = buildChat({ ...options, onSend() {} })
  document.body.append(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  const disclosure = chat.querySelector('[data-chat-ai-disclosure]')
  assert.ok(disclosure, 'the chat must explain the assistant’s AI identity')
  assert.match(disclosure.textContent, /\bAI\b|artificial intelligence/i)
  assert.equal(disclosure.hidden, false)
  assert.equal(disclosure.parentNode, chat, 'identity must stay outside scrolling and replayed messages')
  const log = chat.querySelector('.chat-log')
  assert.ok([...chat.children].indexOf(disclosure) < [...chat.children].indexOf(log))
  assert.doesNotMatch(disclosure.textContent, /endors|partner|approved by/i)
  chat.openStream().close('New response')
  assert.equal(chat.querySelector('[data-chat-ai-disclosure]'), disclosure)
  assert.equal(disclosure.hidden, false)
})

test('a retained chat continues to disclose AI identity when its model changes', t => {
  let model = 'initial-model', repaint
  const chat = buildChat({ title: 'Coordinator', history: [], onSend() {}, chips: {
    model: () => ({ label: model }),
    subscribe: listener => { repaint = listener; return () => {} },
  } })
  document.body.append(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  model = 'chosen-model'
  repaint()
  assert.equal(chat.querySelector('[data-chat-chip="model"]').textContent, model)
  assert.match(chat.querySelector('[data-chat-ai-disclosure]').textContent, /\bAI\b|artificial intelligence/i)
})
