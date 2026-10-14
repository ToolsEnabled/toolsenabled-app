// THE TWO CHAT SURFACES ON THE TREE, AND THE ONE RULE THAT KEEPS THEM EQUAL.
//
// THE DEFECT THIS SUITE EXISTS FOR. Owner, on the installed build: "The
// chatboxes also dont open, we had this right in the past and it had the
// buttons in the chat window so maybe it just got disabled on accident but
// thats a happy path i want resolved." Two separate things were true.
//
//   1. THE BUTTONS. src/views/computers.js builds ONE chat config
//      (treeChatConfigFor) and two surfaces mount it: the rail's Chat tab,
//      which spreads it (`buildChat({ ...config, tall: true })`), and the
//      compact card on the canvas, which src/tree-graph.js mounted from a
//      HAND-PICKED list of six fields written at 4bf6000. Iteration 6
//      (7cce02c) grew the config by four powers -- status, queue, actions,
//      onStop. The rail took all four that day. The card took none, silently,
//      and stayed one composer behind for two iterations. Measured on 4a839f3
//      with real presses against a staged packaged build: rail buttons
//      ["attach","mention","actions","send"], card buttons
//      ["close","attach","mention","send"].
//
//   2. IT DID NOT OPEN AT ALL WITHOUT A SESSION. Both surfaces were gated on
//      node.sessionId, and submitCompose() leaves that null when the START is
//      refused. On a build that cannot start the picked engine, every node a
//      person makes is in exactly that state, so "the chatboxes dont open" was
//      a precise description rather than an exaggeration.
//
// WHY THESE ASSERTIONS ARE SHAPED THIS WAY. buildChat needs a DOM and this
// harness has none, which is why tools/test/chat-composer.test.mjs pins source
// shape too. But a regex over a field name would only catch this defect's
// spelling, not its CLASS -- the class is "the shared config grew and one
// consumer did not notice". So the first test derives buildChat's option names
// from its own signature and requires each surface to forward the config
// wholesale. A future field is then covered on the day it is added, by a test
// nobody has to remember to update.
//
// tools/tree-chatbox-open-qa.mjs is the other half: it presses both surfaces on
// all five node states in a staged packaged build and presses the buttons.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { CHAT_NOT_RUNNING } from '../../src/fleet-tree-copy.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const read = name => readFileSync(join(SRC, name), 'utf8')
const components = read('components.js')
const treeGraph = read('tree-graph.js')
const computers = read('views/computers.js')

/** The option names buildChat destructures, read off its own signature. */
function chatOptionNames() {
  const at = components.indexOf('export function buildChat({')
  assert.ok(at > 0, 'buildChat is no longer declared with a destructured options object')
  const open = components.indexOf('{', at)
  const close = components.indexOf('}', open)
  return components.slice(open + 1, close)
    .split(',')
    .map(part => part.trim().split('=')[0].trim())
    .filter(Boolean)
}

test('buildChat has more options than any one call site remembers', () => {
  const names = chatOptionNames()
  /* The four that were added after the card's call site was written. If this
     list ever fails to be a subset, the powers were renamed and both surfaces
     need re-measuring. */
  for (const grown of ['status', 'queue', 'actions', 'actionsNote', 'onStop']) {
    assert.ok(names.includes(grown), `buildChat lost the ${grown} option; the composer's live powers moved`)
  }
  assert.ok(names.length >= 16, `buildChat takes ${names.length} options; a hand-copied call site cannot be kept correct`)
})

test('BOTH tree chat surfaces mount the whole config, never a copied subset', () => {
  /* THE COMPACT CARD. This is the assertion that fails on 4a839f3: openChat
     listed `onSend`, `onAttach` and `onMention` by hand and never mentioned
     the four powers, so the card composer was missing the actions button. */
  const openChat = treeGraph.slice(treeGraph.indexOf('  openChat(record,'), treeGraph.indexOf('  _openChatCard(record'))
  assert.ok(openChat.length > 0, 'openChat moved; the compact card mount is no longer where this suite looks')
  const cardCall = openChat.slice(openChat.indexOf('this._openChatCard(record, {'))
  assert.match(cardCall, /\.\.\.config/,
    'the compact card mounts a hand-picked subset of the config again — every option added to buildChat after this line was written is silently missing from the card')
  assert.ok(!/onSend: config\.onSend/.test(cardCall),
    'the card re-lists config fields by hand; that is exactly how the actions button went missing')

  /* THE RAIL. It has always spread, and it must keep doing so: a rail that
     started hand-picking would reintroduce the same drift from the other end. */
  const railMount = computers.slice(computers.indexOf("const chatHost = controlsPage.querySelector('[data-rail-chat-host]')"))
    .slice(0, 1400)
  assert.match(railMount, /buildChat\(\{\s*\.\.\.config/,
    'the rail chat stopped spreading the config; the two surfaces can now disagree about what a chat is')
})

test('a node with no session opens a chat instead of nothing', () => {
  const config = computers.slice(computers.indexOf('function treeChatConfigFor(node) {'), computers.indexOf('let chipRefreshFrame'))
  assert.ok(config.length > 0, 'treeChatConfigFor moved')
  assert.ok(!/if \(!node \|\| !node\.sessionId\) return null/.test(config),
    'treeChatConfigFor refuses a node with no session again — a refused start leaves sessionId null, so every node on a build that cannot start would open no chat at all')
  assert.match(config, /composerReason/,
    'the session-less config no longer carries composerReason; without it buildChat has no honest way to open a chat that cannot send')

  /* THE RAIL MARKUP. The host used to be conditional, with prose in its place
     saying "Press its circle on the canvas to start it" -- the gesture that
     opens THAT PANEL and starts nothing. */
  const railBody = computers.slice(computers.indexOf('data-rail-body="chat"'), computers.indexOf('data-rail-body="details"'))
  assert.match(railBody, /data-rail-chat-host/, 'the rail lost its chat host')
  assert.ok(!/node\.sessionId \?/.test(railBody),
    'the rail chat tab is gated on a session again; a node whose start was refused would show prose instead of its conversation')
  /* Comments stripped first: the sentence is quoted in this file's own note and
     in the view's, and a check that cannot tell a comment from a rendered
     string would fail on its own explanation. */
  const rendered = computers.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
  assert.ok(!rendered.includes('Press its circle on the canvas to start it'),
    'the instruction that does not work is back: pressing the circle opens this same panel and starts nothing')
})

test('a chat that cannot send refuses BEFORE the seeded simulator', () => {
  const chat = components.slice(components.indexOf('export function buildChat'))
  assert.match(chat, /const composer = controlState\(\{[\s\S]*?const cannotSend = composer\.disabled/,
    'composerReason no longer passes through the shared render-time control contract')
  const send = chat.slice(chat.indexOf('const send = () => {'))
  const firstLines = send.slice(0, send.indexOf('const v = input.value.trim()'))
  assert.match(firstLines, /if \(cannotSend\) return/,
    'send() no longer refuses a non-sending chat first; buildChat could answer such a chat with its own canned reply')
  /* Disabled in the markup as well as in the handler: the handler is the
     guarantee, the attribute is what stops a person typing into a dead box. */
  assert.match(chat, /cannotSend \? ' disabled' : ''/, 'the message box is no longer disabled when the chat cannot send')

  /* And the tree only routes to a chat that is one of the two honest shapes. */
  const guard = treeGraph.slice(treeGraph.indexOf('  openChat(record,'), treeGraph.indexOf('this._openChatCard(record, {'))
  assert.match(guard, /typeof config\.onSend !== 'function' && !config\.composerReason/,
    'the tree card accepts a config that can neither send nor say why; that config would reach buildChat\'s simulator')
})

test('the words a non-running chat says are the node\'s own, not a rewrite', () => {
  const reason = 'Nothing was started. This copy of ToolsEnabled does not carry the part that runs a Claude agent.'
  const composed = CHAT_NOT_RUNNING.refused(reason)
  assert.ok(composed.startsWith(reason),
    'the refusal is being reworded here instead of composed; this surface and the panel that reported the start would drift')
  assert.match(composed, /Nothing can be sent/, 'the composed sentence stopped saying that nothing can be sent')
  assert.ok(!/not been started yet/.test(CHAT_NOT_RUNNING.neverStarted),
    'the never-started sentence claims a start was attempted; a draft has not attempted one')
  for (const sentence of [CHAT_NOT_RUNNING.neverStarted, composed]) {
    assert.ok(!/session|node|null|sessionId/i.test(sentence), `a mechanism name reached a person: ${sentence}`)
  }
})
