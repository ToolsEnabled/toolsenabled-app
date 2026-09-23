import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// The saved-conversation browser has one control, in a header, and never sits below the
// chat. The actual buildChat and the actual archive browser, on the shared DOM stand-in:
// component placement proof, not a browser layout.
const dom = installDomStandIn()
const { buildChat } = await import('../../src/components.js')
const { mountTranscriptHistory } = await import('../../src/node-transcript-history.js')
test.after(() => dom.restore())

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const store = { readPage: async () => ({ entries: [{ who: 'agent', text: 'Saved answer from yesterday' }], before: null }) }
function chatIn(host) {
  const chat = buildChat({ title: 'Fixture agent', seed: 0, history: [] })
  host.appendChild(chat)
  return chat
}
const allButtons = root => root.querySelectorAll('button')

test('Page 2 rail: one Saved conversation button in the chat header beside Search, and nothing below the chat', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const chat = chatIn(host)
  mountTranscriptHistory({ host, store, nodeId: 'fixture-node', chat })
  const head = chat.querySelector('.chat-head')
  const toggle = head.querySelector('.saved-conversation-toggle')
  assert.ok(toggle, 'the Saved conversation button must be in the chat header')
  const search = head.querySelector('.chat-search-toggle')
  assert.equal(head.children.indexOf(toggle) + 1, head.children.indexOf(search), 'it sits immediately before Search')
  assert.equal(host.children.length, 1, 'nothing is added to the rail host below the chat')
  assert.equal(chat.querySelectorAll('.saved-conversation-toggle').length, 1, 'exactly one button')
  assert.equal(allButtons(host).filter(button => /saved conversation/i.test(button.textContent)).length, 1)
  const section = chat.querySelector('[data-saved-conversation]')
  assert.ok(section, 'the browser belongs to this chat')
  assert.equal(section.hidden, true, 'closed, the browser is not drawn at all')
  assert.ok(chat.children.indexOf(section) < chat.children.indexOf(chat.querySelector('.chat-log')), 'it opens under the header, above the log')
  assert.ok(chat.children.indexOf(section) < chat.children.indexOf(chat.querySelector('.chat-composer-dock')), 'never below the composer')
  toggle.click(); await tick()
  assert.equal(section.hidden, false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.match(section.textContent, /Saved answer from yesterday/)
  toggle.click()
  assert.equal(section.hidden, true)
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
})

test('Home Full view panes: no button in any pane; the view keeps one and opens the focused pane', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const chat = chatIn(host)
  const section = mountTranscriptHistory({ host, store, nodeId: 'fixture-node', chat, toggle: 'none' })
  assert.equal(chat.querySelectorAll('.saved-conversation-toggle').length, 0)
  assert.equal(allButtons(host).filter(button => /saved conversation/i.test(button.textContent)).length, 0, 'no per-pane button')
  assert.equal(host.children.length, 1, 'nothing below the pane chat either')
  assert.equal(section.hidden, true)
  assert.equal(section.toggleSavedConversation(), true); await tick()
  assert.equal(section.hidden, false)
  assert.equal(section.isSavedConversationOpen(), true)
  assert.match(section.textContent, /Saved answer from yesterday/)
  assert.equal(section.toggleSavedConversation(), false)
  assert.equal(section.hidden, true)
})

test('the Full view header carries the one Saved conversation button and wires it to the focused pane', async () => {
  const { readFileSync } = await import('node:fs')
  const home = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
  const toolbar = home.slice(home.indexOf('<div class="home-takeover-toolbar">'), home.indexOf('</div>', home.indexOf('<div class="home-takeover-tools"')))
  assert.equal((toolbar.match(/data-chat-saved/g) || []).length, 1, 'one button in the Full view header')
  assert.match(home, /takeoverSurface\?\.activeHost\?\.querySelector\?\.\('\[data-saved-conversation\]'\)/, 'it acts on the focused pane')
  const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  assert.match(view, /mountTranscriptHistory\(\{ host: surface\.host, store: transcriptStore, nodeId: node\.id, chat, toggle: 'none' \}\)/, 'panes mount without a button')
  assert.match(view, /mountTranscriptHistory\(\{ host: chatHost, store: transcriptStore, nodeId: node\.id, chat \}\)/, 'the rail mounts into its chat header')
})
