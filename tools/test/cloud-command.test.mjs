import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseSlashCommand, queuedMessageEditRefusal, slashHelpSentence } from '../../src/slash-commands.js'
import { personTurnPromptsCircle } from '../../src/agent-removal-rule.js'
import { CLOUD_REQUEST_MAX_BYTES, parseCloudCommand, composeCloudCommand } from '../../shell/cloud-command.mjs'

test('cloud requests reach the shared host grammar, including bare /cloud and literal option-shaped requests', () => {
  for (const [text, rest, workers] of [
    ['/cloud', '', null], [' /CLOUD  Fix  the tree\nand check chat. ', 'Fix  the tree\nand check chat.', null],
    ['/cloud --workers 10 -- fix it', 'fix it', 10], ['/cloud --workers=1 review it', 'review it', 1],
    ['/cloud -- --workers 2 is text', '--workers 2 is text', null],
  ]) {
    assert.deepEqual(parseSlashCommand(text), { kind: 'cloud', rest, workers })
    assert.deepEqual(parseSlashCommand(text), parseCloudCommand(text))
    assert.equal(personTurnPromptsCircle(text), true)
    assert.equal(queuedMessageEditRefusal(text), null, 'the host also interprets this request after a queue drain')
  }
  assert.match(slashHelpSentence(), /\/cloud <request>/)
  for (const text of ['/cloud/file', '/cloudy', 'discuss /cloud', '/cloud:thing']) assert.equal(parseCloudCommand(text), null)
})

test('bad cloud options and oversized requests refuse before delivery and never lose the request tail', () => {
  for (const text of ['/cloud --workers 0', '/cloud --workers 2 fix', '/cloud --workers 250 fix', '/cloud --workers',
    '/cloud --workers 5 --workers 10 fix', '/cloud --environment guessed', '/cloud contains\0nul']) {
    assert.equal(parseSlashCommand(text).kind, 'cloud')
    assert.equal(typeof parseSlashCommand(text).sentence, 'string')
    assert.equal(personTurnPromptsCircle(text), false)
    assert.equal(typeof queuedMessageEditRefusal(text), 'string')
  }
  const boundary = '🚀'.repeat(CLOUD_REQUEST_MAX_BYTES / 4)
  assert.equal(parseCloudCommand('/cloud ' + boundary).rest, boundary)
  assert.equal(typeof parseCloudCommand('/cloud ' + boundary + 'a').sentence, 'string')
})

test('changing cloud options keeps the request without nesting commands or reinterpreting literal options', () => {
  assert.equal(composeCloudCommand('fix the tree', 10), '/cloud --workers 10 -- fix the tree')
  assert.equal(composeCloudCommand('/cloud --workers 25 -- fix  the tree', 5), '/cloud --workers 5 -- fix  the tree')
  assert.equal(composeCloudCommand('/cloud fix the tree'), '/cloud fix the tree')
  assert.equal(parseCloudCommand(composeCloudCommand('/cloud -- --workers 2 is text')).rest, '--workers 2 is text')
  assert.equal(composeCloudCommand('/cloud --workers typo'), '/cloud /cloud --workers typo')
})

const view = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
test('actual busy-composer handler queues cloud work once without opening setup or launching another turn', () => {
  const begin = view.indexOf('        add: text => {', view.indexOf('        hold: request => {'))
  const end = view.indexOf('\n        },', begin)
  assert.ok(begin > 0 && end > begin)
  const queued = [], prompted = []
  const handler = vm.runInNewContext('(' + view.slice(begin, end).replace('        add: ', '') + '\n})', {
    parseSlashCommand, treeStore: {}, node: { id: 'worker' },
    notePersonSpokeTo: (...args) => prompted.push(args),
    queueForSession: (node, text) => { queued.push({ node, text }); return { ok: true } },
  })
  assert.equal(handler('/cloud check this').ok, true)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].text, '/cloud check this')
  assert.equal(prompted.length, 1)
  assert.equal(handler('/cloud --workers 999').ok, false)
  assert.equal(queued.length, 1)
})

test('actual Send now hold preserves a cloud request in the durable queue through interruption', () => {
  const match = view.match(/hold: (request => \{[\s\S]*?\n        \}),/)
  assert.ok(match)
  const held = []
  const handler = vm.runInNewContext('(' + match[1] + ')', {
    parseSlashCommand, notePersonSpokeTo() {}, treeStore: {}, node: {}, liveSessionId: () => 'session',
    outboxHoldForSend: (session, request) => { held.push({ session, request }); return { ok: true, direct: false } },
  })
  assert.equal(handler({ text: '/cloud check it' }).direct, false)
  assert.equal(held[0].request.text, '/cloud check it')
  assert.equal(handler({ text: '/interrupt' }).direct, true)
  assert.equal(handler({ text: '/cloud --workers nope' }).direct, true)
  assert.equal(held.length, 1)
})
