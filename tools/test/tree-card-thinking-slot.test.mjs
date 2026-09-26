import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { activityLine } from '../../src/fleet-tree-copy.js'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
import { readableTextPrefix } from '../../src/chat-readable-stream.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const read = relative => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const computers = read('src/views/computers.js')
const packet = (event, sessionId = 'session-a') => ({ sessionId, event })

test('reasoning stays available to its transcript reader and separate from the public activity summary', () => {
  const reasoning = 'Two approaches fit; the second avoids another pass.'
  const activity = sessionActivityEvent(packet({ type: 'thinking', turnId: 'turn-a', text: reasoning }), 'session-a')
  assert.equal(activity.kind, 'thinking')
  assert.equal(activity.output, reasoning)
  assert.equal(activityLine(activity), 'Thinking.')
  assert.ok(!activityLine(activity).includes(reasoning))
})

test('thinking is routed to its own slot, never over the last real action', () => {
  const routing = computers.match(/if \(activity\.kind === 'thinking'\) \{[\s\S]*?\} else nodeLastTool\.set\(nodeId, line\)/)
  assert.ok(routing)
  const nodeThinking = new Map(), nodeLastTool = new Map([['node', 'Last tool result']])
  const route = new Function('activity', 'nodeId', 'line', 'nodeThinking', 'nodeLastTool', 'readableTextPrefix', routing[0])
  route({ kind: 'thinking', status: 'inProgress', output: 'A complete sentence. Pending' }, 'node', 'Thinking.', nodeThinking, nodeLastTool, readableTextPrefix)
  assert.equal(nodeLastTool.get('node'), 'Last tool result')
  assert.equal(nodeThinking.get('node'), 'A complete sentence. ')
  assert.match(computers, /thinking: latestNodeOutput\(nodeThinking\.get\(node\.id\)\) \|\| null,/,
    'the card model no longer carries a thinking slot')
})

test('thinking is forgotten exactly when the rest of the conversation is', () => {
  const clearBlock = computers.slice(computers.indexOf('nodeLastTool.delete(node.id)'))
  assert.match(clearBlock.slice(0, 200), /nodeThinking\.delete\(node\.id\)/,
    'nodeThinking outlives a rewind or clear. Stale reasoning from a discarded turn would keep showing '
    + 'on the card as though the agent were still working through it.')
})


for (const size of ['mini', 'small', 'medium', 'large']) {
  test(size + ': compact circles retain response and tool summary without internal reasoning', t => {
    const world = installDomStandIn()
    t.after(world.restore)
    const chip = document.createElement('div')
    chip.innerHTML = '<div class="chip-preview"></div>'
    document.body.appendChild(chip)
    const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
      nodeStyle: 'circles', cardSize: size, computer: { agents: [] },
      _contextCardProfile: () => ({ value: size }), previewFitter: { watch() {} },
      contextFeed: () => ({ chat: '# Response\n\n- **Public** latest result.',
        thinking: 'PRIVATE_REASONING_SENTINEL', tool: 'Read source files', current: 'Working' }),
    })
    graph._renderChipPreview({ chip, agent: { role: 'builder', name: 'Builder' } })
    assert.equal(chip.querySelector('.cl-chat .chip-context-text').textContent, 'Response Public latest result.')
    assert.ok(chip.textContent.includes('Read source files'))
    assert.ok(!chip.textContent.includes('PRIVATE_REASONING_SENTINEL'))
  })
}
