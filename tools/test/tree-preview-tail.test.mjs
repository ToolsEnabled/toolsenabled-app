import assert from 'node:assert/strict'
import test from 'node:test'
import { buildChat } from '../../src/components.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { fitTreePreview } from '../../src/tree-preview-fit.js'
import { createSessionTextReader } from '../../src/agent-session-events.js'
import { NODE_CARD_OUTPUT_CHARS } from '../../src/node-card-context.js'
import { chatPreviewText } from '../../src/chat-markdown.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Actual graph renderers and fitter with a controlled layout measurement seam.
// Painted font wrapping is qualified separately in the isolated browser fixture.
function fixture(t, style = 'circles') {
  const world = installDomStandIn()
  t.after(world.restore)
  let feed = {}, watched
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    nodeStyle: style, cardSize: 'large', computer: { agents: [] },
    contextFeed: () => feed, _contextCardProfile: () => ({ value: 'large' }),
    previewFitter: { watch(_record, container) { watched = container } },
    _canExtend: () => true, _scopeModel: () => ({ summary: () => ({ total: 1 }), groups: new Map() }),
  })
  const root = document.createElement('div')
  document.body.appendChild(root)
  root.innerHTML = style === 'circles' ? '<div class="chip-preview"></div>' : `
    <span class="nn-t"></span><span class="node-role"></span><span class="tree-box-status"></span>
    <div class="tree-box-latest-action"></div>
    <div class="tree-box-context"><div class="tree-box-thinking"><span class="tree-box-thinking-text"></span></div><p></p></div>
    <div class="tree-box-context-indicators"></div><button class="tree-box-branch"></button>
    <button class="tree-box-add-agent"></button><button class="tree-box-chat"></button>`
  const query = root.querySelector.bind(root)
  root.querySelector = selector => query(selector === '.tree-box-context > p' ? '.tree-box-context p' : selector)
  const record = { id: 'child', agent: { id: 'child', name: 'Builder', role: 'builder', treeNode: { sessionId: 'session-a' } }, el: root, chip: root }
  const paint = value => { feed = value; graph._renderChipPreview(record); return root.querySelector(style === 'circles' ? '.cl-chat .chip-context-text' : '.tree-box-context p') }
  return { root, record, graph, paint, container: () => watched }
}

function geometry(t, container, content, { width = 18, lines = 3 } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  const lineHeight = 18
  const fullHeight = () => Math.max(1, Math.ceil(content.textContent.length / width)) * lineHeight
  Object.defineProperties(content, {
    scrollHeight: { configurable: true, get: fullHeight },
    clientHeight: { configurable: true, get: () => Math.min(fullHeight(),
      parseFloat(content.style.maxHeight) || (Number(content.style.webkitLineClamp) || 10000) * lineHeight) },
  })
  content.getClientRects = () => [{}]
  content.getBoundingClientRect = () => ({ bottom: content.clientHeight, height: content.clientHeight })
  const query = container.querySelectorAll.bind(container)
  container.querySelectorAll = selector => selector === '.chip-context-text, p' || selector === '*' ? [content] : query(selector)
  container.clientHeight = container.offsetHeight = lines * lineHeight
  container.getBoundingClientRect = () => ({ bottom: container.clientHeight, height: container.clientHeight })
  globalThis.getComputedStyle = node => ({ display: node.hidden ? 'none' : node.style.display || 'block',
    lineHeight: String(lineHeight), paddingBottom: '0' })
  t.after(() => original ? Object.defineProperty(globalThis, 'getComputedStyle', original) : delete globalThis.getComputedStyle)
}

for (const style of ['circles', 'boxes']) {
  test(style + ': the response viewport follows the latest end while full text and controls survive', t => {
    const f = fixture(t, style)
    const response = 'Opening sentence. ' + 'Earlier context. '.repeat(55) + 'LATEST RESPONSE.'
    const content = f.paint({ chat: response, current: 'Working', tool: 'Reading files' })
    geometry(t, f.container(), content)
    fitTreePreview(f.container())
    assert.ok(content.textContent.endsWith('LATEST RESPONSE.'))
    assert.ok(content.scrollTop + content.clientHeight >= content.scrollHeight - 1,
      'the bottom of the latest response must be inside the compact viewport')
    assert.ok(content.clientHeight <= f.container().clientHeight)
    assert.ok(content.textContent.includes('Opening sentence.'), 'viewport following must not rewrite full response history')
    if (style === 'boxes') assert.equal(f.root.querySelector('.tree-box-add-agent').hidden, false)
  })
  test(style + ': public response keeps Markdown meaning and excludes reasoning payloads', t => {
    const f = fixture(t, style)
    const response = '# Result\n\n- **First** result\n- [Latest](https://example.test/private-path)\n\n```js\nconst complete = true\n```'
    const content = f.paint({ chat: response, thinking: 'INTERNAL_REASONING_SENTINEL', tool: 'Read source files' })
    assert.equal(content.textContent, chatPreviewText(response))
    assert.ok(!f.root.textContent.includes('INTERNAL_REASONING_SENTINEL'), 'compact public response must not display internal reasoning')
    assert.ok(!content.textContent.includes('private-path'))
  })
  test(style + ': actual text reader stream and final reconciliation retain legitimate repeats across session replacement', t => {
    const f = fixture(t, style), reader = createSessionTextReader()
    let text = ''
    const deliver = (sessionId, event) => { const next = reader.read({ sessionId, event }, 'session-a'); if (next?.text) text += (next.breakBefore && text ? '\n\n' : '') + next.text }
    deliver('session-a', { type: 'assistant_text_delta', turnId: 'turn-a', itemId: 'first', text: 'Repeated result.' })
    deliver('session-a', { type: 'assistant_text', turnId: 'turn-a', itemId: 'first', text: 'Repeated result.' })
    deliver('session-a', { type: 'thinking', turnId: 'turn-a', text: 'INTERNAL_REASONING_SENTINEL' })
    deliver('session-a', { type: 'tool_result', turnId: 'turn-a', output: 'RAW_TOOL_SENTINEL' })
    deliver('session-a', { type: 'assistant_text', turnId: 'turn-a', itemId: 'second', text: 'Repeated result.' })
    deliver('other-session', { type: 'assistant_text', text: 'FOREIGN_SESSION_SENTINEL' })
    const content = f.paint({ chat: text })
    assert.equal(content.textContent, 'Repeated result. Repeated result.')
    assert.equal(text.match(/Repeated result\./g).length, 2)
    f.record.chipPreviewKey = null; f.record.boxPreviewKey = null
    const restored = f.paint({ chat: text })
    assert.equal(restored.textContent, content.textContent, 'saved final output uses the same preview renderer')
    f.record.agent = { ...f.record.agent, treeNode: { sessionId: 'session-b' } }
    const replacement = f.paint({ chat: 'New session response.' })
    assert.equal(replacement.textContent, 'New session response.')
    assert.ok(!f.root.textContent.includes('Repeated result.'))
  })
}

for (const style of ['circles', 'boxes']) {
  test(style + ': long formatted history and repeated stream updates keep the newest end through a narrow resize', t => {
    const f = fixture(t, style)
    const opening = '# Earlier heading\n\n'
    let source = opening + '- **Earlier** context.\n'.repeat(200)
    const saved = source
    const updates = ['Public progress one.', 'Public progress two.', 'Final result.']
    for (const update of updates) {
      source += '\n\n' + update
      const content = f.paint({ chat: source, tool: 'Read files' })
      assert.ok(content.textContent.startsWith('…'))
      assert.ok(content.textContent.length <= NODE_CARD_OUTPUT_CHARS)
      assert.ok(!content.textContent.includes('# Earlier'))
      assert.ok(content.textContent.endsWith(update))
      for (const width of [24, 8]) {
        geometry(t, f.container(), content, { width, lines: 2 })
        fitTreePreview(f.container())
        assert.equal(content.scrollTop + content.clientHeight, content.scrollHeight)
        assert.ok(content.clientHeight <= f.container().clientHeight)
      }
    }
    assert.equal(saved, opening + '- **Earlier** context.\n'.repeat(200), 'preview projection leaves the saved history intact')
  })
}
test('compact tail follows while an actual selected chat preserves an older reading position', t => {
  const f = fixture(t)
  const chat = buildChat({ title: 'Selected child', history: [{ who: 'agent', text: 'Earlier answer.' }], seed: 0 })
  document.body.appendChild(chat)
  try {
    const log = chat.querySelector('.chat-log')
    log.scrollHeight = 2000; log.clientHeight = 400; log.scrollTop = 73; log.dispatch('scroll')
    const response = 'Earlier words. '.repeat(40) + 'Newest response.'
    const stream = chat.openStream()
    stream.push(response)
    stream.close(response)
    const content = f.paint({ chat: response })
    geometry(t, f.container(), content)
    fitTreePreview(f.container())
    assert.equal(log.scrollTop, 73)
    assert.ok(chat.querySelector('.chat-new-below').hidden === false)
    assert.ok(chat.textContent.includes('Newest response.'))
    assert.ok(content.scrollTop > 0)
  } finally { chat.dispose(); chat.remove() }
})

test('a group box retains separate member names instead of a response tail', t => {
  const f = fixture(t, 'boxes')
  const members = [{ name: 'First member' }, { name: 'Second member' }]
  f.record.agent.treeScope = { group: true, members, summary: { total: 2 } }
  f.graph._scopeModel = () => ({ summary: () => ({ total: 2 }), groups: new Map([['child', { memberIds: ['first', 'second'] }]]), agent: id => members[id === 'first' ? 0 : 1] })
  const content = f.paint({ chat: 'Unrelated response' })
  assert.ok(!content.textContent.includes('Unrelated response'))
  assert.ok(content.textContent.includes('First member'))
  assert.ok(content.textContent.includes('Second member'))
  assert.notEqual(content.dataset.previewTail, 'true')
})

for (const style of ['circles', 'boxes']) {
  test(style + ': a long link destination does not turn into visible response text when the preview is bounded', t => {
    const f = fixture(t, style)
    const response = '# Report\n\n[Public result](https://example.test/' + 'path-part/'.repeat(200) + ')\n\nFinal answer.'
    const content = f.paint({ chat: response })
    assert.equal(content.textContent, 'Report Public result Final answer.')
    assert.ok(!content.textContent.includes('path-part'))
  })
}


test('a box switches from a long fallback to an equal public response tail, then stays stable', t => {
  const f = fixture(t, 'boxes')
  const response = 'Earlier public context. '.repeat(160) + 'LATEST EQUAL RESPONSE.'
  const base = { current: 'Working', previous: 'asked: ' + response, task: response, tool: 'Read source files' }
  const content = f.paint(base)
  geometry(t, f.container(), content, { width: 18, lines: 3 })
  fitTreePreview(f.container())
  const before = content.textContent
  assert.ok(content.scrollTop + content.clientHeight < content.scrollHeight,
    'the overflowing fallback starts as a top-clamped brief')
  f.paint({ ...base, chat: response })
  assert.equal(content.textContent, before, 'the public response parses to exactly the same bounded text')
  fitTreePreview(f.container())
  assert.equal(content.scrollTop + content.clientHeight, content.scrollHeight,
    'the equal-text public response must reveal its latest end')
  const position = content.scrollTop
  f.paint({ ...base, chat: response })
  fitTreePreview(f.container())
  assert.equal(content.textContent, before)
  assert.equal(content.scrollTop, position, 'an unchanged refresh preserves the visible response end')
  assert.equal(f.root.querySelector('.tree-box-add-agent').hidden, false)
})
