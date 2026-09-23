import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/* Per-surface pin for the tree conversation shelf. This deliberately follows the
 * card all the way to buildChat's identity marker rather than merely finding
 * buildChat somewhere in tree-graph.js: the panel identity is what lets the
 * surface inventory detect a mount that drifts or disappears. */
const ROOT = process.env.CHAT_SURFACE_TREE_CARD_ROOT
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = path => readFileSync(join(ROOT, path), 'utf8')
const treeGraph = read('src/tree-graph.js')
const components = read('src/components.js')
const computers = read('src/views/computers.js')

function between(source, start, end) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing source boundary: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(to, -1, `missing source boundary: ${end}`)
  return source.slice(from, to)
}

const codeOnly = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

function assertWholeCardConfig(source) {
  const openChat = codeOnly(between(source, '  openChat(record,', '  _openChatCard(record, chatOptions, { focus = true } = {}) {'))
  const treeNodeMount = openChat.slice(openChat.indexOf('if (record.agent.treeNode)'))
  assert.match(treeNodeMount, /this\._openChatCard\(record,\s*\{\s*\.\.\.config,/,
    'the tree card must spread its shared config whole, not copy a remembered field list')
}

test('tree conversation shelf mounts the identity-marked chat panel', () => {
  const cardMount = codeOnly(between(treeGraph, '  _openChatCard(record, chatOptions, { focus = true } = {}) {', '  _buildConversationShelf() {'))
  assert.match(cardMount, /const chat = buildChat\(\{[\s\S]*?\.\.\.chatOptions,/,
    'the shelf mount no longer passes its options into buildChat')
  assert.match(cardMount, /panel\.appendChild\(chat\)/,
    'the chat returned for the shelf is no longer mounted on its own conversation panel')

  const buildChat = between(components, 'export function buildChat({', 'export function sparkline(')
  assert.match(buildChat, /<div class="chat[^"`]*" data-chat-panel\b/,
    'buildChat lost data-chat-panel, so this mount has no stable panel identity')
})

test('tree-card configs choose exactly one honest composer path', () => {
  const factory = codeOnly(between(computers, '  function treeChatConfigFor(node) {', '  let chipRefreshFrame'))
  const readOnly = between(factory, '    if (!node.sessionId) {', '    let history =')
  const live = factory.slice(factory.indexOf('    return {\n      title: treeNodeName(node)', readOnly.length))

  assert.match(readOnly, /\bcomposerReason\s*:/, 'a session-less card must explain why it cannot send')
  assert.doesNotMatch(readOnly, /\bonSend\s*:/, 'a session-less card must not also receive a sender')
  assert.doesNotMatch(readOnly, /\bsampleConversation\s*:\s*true/, 'a session-less card must not answer itself')

  assert.match(live, /\bonSend\s*:/, 'a live tree card must receive its real sender')
  assert.doesNotMatch(live, /\bcomposerReason\s*:/, 'a live card must not also be composer-disabled')
  assert.doesNotMatch(live, /\bsampleConversation\s*:\s*true/, 'a live card must not answer with the sample conversation')
})

test('tree card spreads the shared config whole', () => {
  assertWholeCardConfig(treeGraph)
})

test('mutation check: a hand-picked six-field scratch copy is rejected', () => {
  const handPicked = [
    'title: config.title',
    'subtitle: config.subtitle',
    'roleKey: config.roleKey',
    'history: config.history',
    'onSend: config.onSend',
    'onAttach: config.onAttach',
  ].join(',\n        ')
  const scratch = treeGraph.replace(/(this\._openChatCard\(record,\s*\{\s*)\.\.\.config,/, `$1${handPicked},`)
  assert.notEqual(scratch, treeGraph, 'the scratch mutation did not reach the tree-card mount')
  assert.throws(
    () => assertWholeCardConfig(scratch),
    /spread its shared config whole/,
    'the pin stayed green after replacing the spread with the historical hand-picked shape',
  )
})
