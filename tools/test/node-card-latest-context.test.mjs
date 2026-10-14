import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'

import { latestNodeOutput, latestNodeResponse, NODE_CARD_OUTPUT_CHARS } from '../../src/node-card-context.js'
import { treeSessionEventSource } from './lib/tree-session-event-source.mjs'
import { cssRules, cssSelectors, selectorSubject } from './lib/css-rule-source.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { readableTextPrefix } from '../../src/chat-readable-stream.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')

test('compact output keeps the latest bounded excerpt and marks truncation', () => {
  const opening = 'opening words that must fall out; '
  const ending = 'latest answer that must remain'
  // A space between the filler and `ending` (absent from this fixture
  // before W16e) means the word-boundary-safe cut this lane added lands
  // exactly at the start of `ending`, not partway through it -- this test's
  // job is "latest content survives, opening does not," not the forward-trim
  // arithmetic itself, which tools/test/node-card-latest-context.test.mjs's
  // own next test covers on purpose-built, hand-checked input.
  const source = `${opening}${'x'.repeat(NODE_CARD_OUTPUT_CHARS)} ${ending}`
  const excerpt = latestNodeOutput(source)
  assert.ok(excerpt.length <= NODE_CARD_OUTPUT_CHARS, 'the excerpt grew past its own character budget')
  assert.ok(excerpt.startsWith('…'), 'a truncated excerpt looks falsely complete')
  assert.ok(excerpt.endsWith(ending), 'the compact card kept the oldest output instead of the latest')
  assert.ok(!excerpt.includes(opening), 'the bounded excerpt did not discard obsolete opening text')
  assert.equal(latestNodeOutput('  short answer  '), 'short answer')
})

test('a truncated excerpt opens on a whole word, not wherever the character budget ran out', () => {
  // Reader-visible behaviour, called with values -- never a spelling of the
  // slice. Manager 4 measured the defect this guards on the person's own
  // card: a hard character cut opened mid-word ("…ders await the grouped
  // admission path"). Fixed-width "abcd " tokens make the expected cut point
  // arithmetic, not eyeballed: 200 tokens (1000 chars) + a 6-char "LATEST"
  // marker, cut to the last 19 characters of a 20-character budget, lands
  // inside a token ("cd abcd abcd LATEST") -- the fix must drop forward to
  // that token's own end rather than open on "cd".
  const filler = 'abcd '.repeat(200)
  const marker = 'LATEST'
  const excerpt = latestNodeOutput(filler + marker, 20)
  assert.equal(excerpt, '…abcd abcd LATEST', 'the excerpt did not drop forward to the next whole word')
  for (const word of excerpt.slice(1).split(' ')) {
    assert.ok(word === 'abcd' || word === marker, `"${word}" is a fragment, not one of the source's own whole words`)
  }

  // The fallback: one token longer than the whole window, with no whitespace
  // anywhere inside it to drop forward to. Word-boundary-safe must not empty
  // the excerpt in that case -- it keeps the plain hard cut, same as before
  // this fix, which is still better than showing nothing.
  const unbroken = 'x'.repeat(30)
  const fallback = latestNodeOutput(unbroken, 20)
  assert.equal(fallback, `…${'x'.repeat(19)}`, 'a token with no whitespace anywhere in the window must fall back to the hard cut')

  // Never grows past the budget: dropping forward can only shorten.
  assert.ok(excerpt.length <= 20 && fallback.length <= 20)
})

test('the last tool line survives turn completion but clears with conversation state', () => {
  const view = read('src/views/computers.js')
  assert.match(view, /const nodeLastTool = new Map\(\)/)
  assert.match(view, /nodeActivity\.set\(nodeId, line\)/, 'activity no longer records the live working row')
  /* RUN THE ROUTING, do not pin its spelling. This used to require
     `nodeLastTool.set` to sit immediately after `nodeActivity.set` with only
     whitespace between them, which R1205 broke by putting a branch there --
     a thinking event must NOT overwrite the last real action with the word
     "Thinking." (see nodeThinking, src/views/computers.js). Adjacency was
     never the guarantee; "an action records the durable tool line" is, and
     that is executable, the same way the completion deletions below are. */
  const routing = view.match(/if \(activity\.kind === 'thinking'\) \{[\s\S]*?\} else nodeLastTool\.set\(nodeId, line\)/)
  assert.ok(routing, 'the activity branch no longer routes the durable tool line at all')
  const route = (activity, line) => {
    const nodeLastTool = new Map(), nodeThinking = new Map()
    new Function('activity', 'nodeId', 'line', 'nodeLastTool', 'nodeThinking', 'readableTextPrefix', routing[0])(activity, 'node', line, nodeLastTool, nodeThinking, readableTextPrefix)
    return { tool: nodeLastTool.get('node'), thinking: nodeThinking.get('node') }
  }
  assert.deepEqual(route({ kind: 'call', output: '' }, 'Running a command: ls'),
    { tool: 'Running a command: ls', thinking: undefined },
    'an action must still record the compact card\'s durable tool line')
  assert.deepEqual(route({ kind: 'result', exitCode: 0 }, 'The last command finished.'),
    { tool: 'The last command finished.', thinking: undefined },
    'a result must still record the durable tool line')
  assert.deepEqual(route({ kind: 'thinking', output: 'weighing two approaches' }, 'Thinking.'),
    { tool: undefined, thinking: 'weighing two approaches' },
    'thinking must leave the last real action alone and record its own reasoning instead')
  assert.deepEqual(route({ kind: 'thinking', output: '' }, 'Thinking.'),
    { tool: undefined, thinking: '' },
    'a textless start clears obsolete thinking without inventing a summary')
  assert.deepEqual(route({ kind: 'thinking', status: 'inProgress', output: 'A sentence. Pending fragment' }, 'Thinking.'),
    { tool: undefined, thinking: 'A sentence. ' }, 'the live card must not reveal individual token fragments')

  const { dispatcherNode } = treeSessionEventSource(view)
  const statements = dispatcherNode.body.body
  const completionStart = statements.findIndex(statement => statement.type === 'VariableDeclaration'
    && statement.declarations.some(declaration => declaration.id.name === 'completingTurnId'))
  const completionEnd = statements.findIndex((statement, index) => index > completionStart
    && statement.type === 'ExpressionStatement'
    && view.slice(statement.expression.callee?.start, statement.expression.callee?.end) === 'nodeReplies.set')
  assert.ok(completionStart >= 0 && completionEnd > completionStart,
    'bound ordinary completion from its captured turn identity to its reply write')
  const completion = statements.slice(completionStart, completionEnd)
  assert.doesNotMatch(view.slice(completion[0].start, completion.at(-1).end), /nodeLastTool\.delete/,
    'completion must not erase the last tool in a conditional branch either')
  const deletions = completion.filter(statement => {
    const call = statement.type === 'ExpressionStatement' && statement.expression
    return call?.type === 'CallExpression' && ['nodeActivity.delete', 'nodeLastTool.delete']
      .includes(view.slice(call.callee.start, call.callee.end))
  })
  assert.ok(deletions.length, 'the ordinary completion must clear live activity')
  const nodeActivity = new Map([['node', 'Read source']]), nodeLastTool = new Map(nodeActivity)
  new Function('nodeId', 'nodeActivity', 'nodeLastTool',
    deletions.map(statement => view.slice(statement.start, statement.end)).join('\n'))('node', nodeActivity, nodeLastTool)
  assert.equal(nodeActivity.has('node'), false, 'completion clears the live working row')
  assert.equal(nodeLastTool.get('node'), 'Read source', 'completion preserves the last tool line')

  assert.match(view, /nodeReplies\.delete\(node\.id\)\s*nodeActivity\.delete\(node\.id\)\s*nodeLastTool\.delete\(node\.id\)/,
    'rewind or clear can leave a tool line from erased history')
  assert.match(view, /nodeReplies\.delete\(live\.id\)\s*nodeActivity\.delete\(live\.id\)\s*nodeLastTool\.delete\(live\.id\)/,
    'removing a node leaks its last tool line')
})

test('the feed and graph preserve separate status, tool and latest-output context', () => {
  const view = read('src/views/computers.js')
  const feed = view.slice(view.indexOf('function treeContextFeed'), view.indexOf('function treeContextFeed') + 2400)
  assert.match(feed, /current: treeNodeStatusWord\(node\)/,
    'the status and tool line share one slot again')
  assert.match(feed, /tool: nodeLastTool\.get\(node\.id\) \|\| null/)

  const graph = read('src/tree-graph.js')
  assert.match(graph, /tool: clean\(supplied\?\.tool\)/,
    'the graph whitelist silently drops the tool field')
  const declaration = parseAst(graph).body.find(node => node.declaration?.id?.name === 'StaticTreeGraph').declaration
  const method = declaration.body.body.find(node => node.key.name === '_screenContext')
  const screenContext = new Function('branchSummaryText', 'measuredNumber', `return function ${graph.slice(method.start, method.end)}`)(() => '', Number)
  const values = { current: 'Reviewing the patch', tool: 'Reading src/tree-workspace.js', chat: { text: 'The mounted chat retained the draft.' }, task: 'Check navigation and drafts.' }
  const result = screenContext.call({ contextFeed: () => values }, { agent: {} })
  assert.equal(result.current, values.current)
  assert.equal(result.tool, values.tool)
  assert.equal(result.chat, values.chat.text)
  assert.equal(result.task, values.task)
  // The actual browser now owns the presentation proof across every size
  // and theme: fixtures/run-tree-circle-cards.mjs checks distinct sections,
  // complete visible lines, and the original conversation's mounted draft.
  // Cascade applies per property. A later font-size rule does not erase an
  // earlier line clamp, and a descendant's declaration does not style its parent.
  const clamps = cssRules(read('src/tree-graph.css')).flatMap(({ selector, body }) => {
    if (!cssSelectors(selector).some(part => selectorSubject(part) === '.cl-chat')) return []
    return [...body.matchAll(/-webkit-line-clamp:\s*([^;]+)/g)].map(match => match[1].trim())
  })
  assert.ok(clamps.length, 'the compact output must have a line clamp')
  const declared = clamps.at(-1)
  const clampLines = Number(declared.match(/^var\(\s*--tree-chat-lines\s*,\s*(\d+)\s*\)$/)?.[1] ?? declared)
  assert.ok(Number.isInteger(clampLines) && clampLines >= 2,
    'the final line-clamp declaration or selected-size fallback must leave room for multiple lines')
})

test('the actual card feed displays complete live chunks and keeps finished replies intact', () => {
  const source = declaredFunctionSource(read('src/views/computers.js'), 'treeContextFeed')
  const sessionTurnText = new Map(), nodeReplies = new Map([['node', 'Previous complete reply']])
  const dependencies = { sessionTurnText, nodeReplies, nodeLastTool: new Map(), nodeThinking: new Map(),
    treeNodeStatusWord: () => 'working', projectionMonitorContext: () => ({}), readerRemedy: value => value,
    currentDataSource: () => 'desktop', latestNodeOutput, readableTextPrefix }
  const feed = new Function(...Object.keys(dependencies), `return (${source})`)(...Object.values(dependencies))
  const agent = { treeNode: { id: 'node', sessionId: 'session', message: 'An assigned task' } }
  sessionTurnText.set('session', 'A sentence still arriving')
  assert.equal(feed(agent).chat, 'Previous complete reply')
  sessionTurnText.set('session', 'A sentence has arrived. More unfinished')
  assert.equal(latestNodeResponse(feed(agent).chat), 'A sentence has arrived.')
  sessionTurnText.delete('session')
  nodeReplies.set('node', 'The final fragment needs no punctuation')
  assert.equal(feed(agent).chat, 'The final fragment needs no punctuation')
  const longReply = '# Final response\n\n' + '- **Result** with context.\n'.repeat(100) + '\nLatest result.'
  nodeReplies.set('node', longReply)
  assert.equal(feed(agent).chat, longReply, 'the feed preserves Markdown boundaries until the renderer parses and bounds the preview')

})
