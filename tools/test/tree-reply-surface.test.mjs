import { createSessionTextReader, sessionEventTurnId } from '../../src/agent-session-events.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'
import vm from 'node:vm'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

import { SAID_PANEL, turnCompletionWords } from '../../src/fleet-tree-copy.js'
/* THE REAL ONE, not a stand-in. _renderChipPreview names chatPreviewText, which
   src/tree-graph.js imports from src/chat-markdown.js, and the lifted scope below
   did not supply it -- so the region threw ReferenceError on its first call and
   the case below asserted nothing while the other eight went on passing. A stub
   here could disagree with the product about what a preview says and this suite
   would still be green, which is the whole reason it is imported rather than
   faked: src/tree-graph.js's own comment says chatPreviewText "reads the SAME
   parser renderChatMarkdown uses". */
import { latestNodeResponse } from '../../src/node-card-context.js'

/* THE ANSWER MUST REACH THE PAGE THE QUESTION WAS ASKED ON.
 *
 * Measured 2026-08-13 on the installed 1.0.7: a tree-started agent ran on a
 * live codex app-server child, the engine answered, and the tree page rendered
 * none of it -- no onEvent subscription, no reply surface, status frozen on
 * "starting". The owner's words for that state were "the agents dont respond",
 * and he was right about everything a person can see.
 *
 * These are source-shape guards in the same spirit as the fleet-trees suite:
 * each one pins the specific absence that produced that state, so it cannot
 * come back silently. They read the source, not the DOM, because the defect
 * was structural (nothing subscribed) rather than cosmetic.
 */

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

function nodesWithin(root, predicate) {
  const found = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (predicate(node)) found.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(root)
  return found
}

function assertSessionHandoffOrder(source) {
  const ast = parseAst(source)
  const named = name => nodesWithin(ast, node => node.type === 'FunctionDeclaration' && node.id.name === name)[0]
  const start = named('startDraftNodeUnguarded')
  const helper = named('startAgentForNode')
  assert.ok(start && helper, 'both actual start functions must exist')
  const handoff = nodesWithin(start, node => node.type === 'Property' && node.key.name === 'onSessionOpen')[0]?.value
  assert.ok(handoff, 'the compose start must receive the session as it opens')
  const bindings = nodesWithin(handoff, node => node.type === 'CallExpression'
    && source.slice(node.callee.start, node.callee.end) === 'sessionNodeIds.set')
  assert.ok(bindings.some(node => node.arguments[0]?.name === 'sessionId'
    && source.slice(node.arguments[1]?.start, node.arguments[1]?.end) === 'node.id'),
  'the session-to-node map must be written from onSessionOpen')
  const opened = nodesWithin(helper, node => node.type === 'CallExpression' && node.callee.name === 'onSessionOpen')[0]
  const sent = nodesWithin(helper, node => node.type === 'CallExpression'
    && source.slice(node.callee.start, node.callee.end) === 'bridge.send')[0]
  assert.ok(opened && sent && opened.start < sent.start, 'session handoff must precede the first send')
  assert.ok(opened.arguments[0]?.properties?.some(property => property.key.name === 'sessionId'
    && property.value.name === 'sessionId'), 'handoff must carry the actual session id')
}

test('the tree view subscribes to the session stream and detaches with the view', () => {
  const source = read('src/views/computers.js')
  assert.match(source, /window\.mcAgent\.onEvent\(/,
    'computers.js no longer subscribes to session events; tree-started agents answer into a void again')
  assert.match(source, /unsubs\.push\(window\.mcAgent\.onEvent/,
    'the session listener is not registered through unsubs, so closing the view leaks it -- the exact leak the preload comment warns about')
})

test('the actual tree text consumer reconciles whole and delta output without importing tool bodies', () => {
  const source = read('src/views/computers.js')
  const ast = parseAst(source)
  const dispatcher = nodesWithin(ast, node => node.type === 'AssignmentExpression' && node.left.name === 'handleAgentEvent')[0].right
  const body = dispatcher.body.body
  const begin = body.findIndex(node => node.type === 'VariableDeclaration' && node.declarations.some(row => row.id.name === 'speech'))
  assert.ok(begin >= 0, 'locate the maintained text consumer')
  const statements = body.slice(begin, begin + 3)
  const sessionTurnText = new Map(), repaints = []
  const scope = { sessionTextReader: createSessionTextReader(), sessionEventTurnId, sessionTurnText,
    sessionNodeIds: new Map([['session', 'node']]), railSaid: null, railChat: null,
    settleTurnBoundary() {}, scheduleChatSpeech: id => repaints.push(id), scheduleChipRefresh() {} }
  const consume = new Function(...Object.keys(scope), 'packet', 'sessionId',
    statements.map(node => source.slice(node.start, node.end)).join('\n')).bind(null, ...Object.values(scope))
  const deliver = event => consume({ sessionId: 'session', event }, 'session')
  deliver({ type: 'assistant_text_delta', itemId: 'one', turnId: 'turn', text: 'Public reply.' })
  deliver({ type: 'assistant_text', itemId: 'one', turnId: 'turn', text: 'Public reply.' })
  deliver({ type: 'thinking', text: 'PRIVATE_BODY' })
  deliver({ type: 'tool_result', text: 'RAW_TOOL_BODY' })
  deliver({ type: 'assistant_text', itemId: 'two', turnId: 'turn', text: 'Public reply.' })
  assert.equal(sessionTurnText.get('session'), 'Public reply.\n\nPublic reply.')
  assert.deepEqual(repaints, ['session', 'session'])
})

test('a session is mapped to its node BEFORE its message is sent', () => {
  /* MEASURED 2026-08-17: the Claude CLI streams a turn, so its first words --
     and, for a short answer, its completion too -- reach this page before the
     send is answered. This map is what the listener filters on, so a map
     written after the send dropped that whole turn and left the node at
     `running` with nothing in it. Writing it from onSessionOpen is what makes
     the binding earlier than any event can be, for every engine rather than
     for the fast one. */
  const source = read('src/views/computers.js')
  // Additional receipt fields must not invalidate the binding/order contract.
  assertSessionHandoffOrder(source)
})

test('handoff guards reject an absent callback binding, missing session id, or send before handoff', () => {
  const fixture = (binding, opened) => `
    function startDraftNodeUnguarded() { startAgentForNode({ onSessionOpen: ({ sessionId }) => { ${binding} } }) }
    async function startAgentForNode() { ${opened} }
  `
  const binding = 'sessionNodeIds.set(sessionId, node.id)'
  const handoff = 'onSessionOpen({ sessionId, resourceAdmission });'
  const send = 'await bridge.send({ sessionId });'
  assert.doesNotThrow(() => assertSessionHandoffOrder(fixture(binding, handoff + send)))
  assert.throws(() => assertSessionHandoffOrder(fixture('', handoff + send)), /map must be written/)
  assert.throws(() => assertSessionHandoffOrder(fixture(binding, send + handoff)), /precede the first send/)
  assert.throws(() => assertSessionHandoffOrder(fixture(binding, 'onSessionOpen({ resourceAdmission });' + send)), /actual session id/)
})

test('the reply is delivered once per turn, never once per token', () => {
  const source = read('src/views/computers.js')
  /* A turn that ends without a
     turn_completed packet still said something, and until 2026-08-18 those
     words were silently carried into the next turn instead of being filed --
     the owner's "combine into each other". settleTurnBoundary files them once,
     when the engine names a different turn. A child-exit packet is a separate
     terminal path: it files the words plus the honest ended sentence exactly
     once before retiring the dead session. A confirmed Stop can also settle
     observed words before the last provider packet. The remaining writes are
     ordinary completion, store rehydration, and standalone adoption/confirmed Halt; none delivers each delta. */
  const ast = parseAst(source)
  const writes = nodesWithin(ast, node => node.type === 'CallExpression'
    && source.slice(node.callee.start, node.callee.end) === 'nodeReplies.set')
  const allowed = [
    ['settleTurnBoundary', 1], ['settleStoppedSession', 1], ['openTreeStore', 1],
    // An idle native session can finish while the page is away. Recovery
    // restores its durable last reply; the live busy stream is never replaced.
    ['reconnectSavedNativeSessions', 1],
    ['placeStandaloneAgent', 2],
  ]
  const reviewedWrites = new Set()
  for (const [name, count] of allowed) {
    const declaration = nodesWithin(ast, node => node.type === 'FunctionDeclaration' && node.id.name === name)[0]
    assert.ok(declaration, `the ${name} settlement path must exist`)
    const held = writes.filter(write => write.start > declaration.start && write.end < declaration.end)
    assert.equal(held.length, count, `unexpected reply writes inside ${name}`)
    held.forEach(write => reviewedWrites.add(write))
  }
  const eventSubscription = nodesWithin(ast, node => node.type === 'CallExpression'
    && source.slice(node.callee.start, node.callee.end) === 'window.mcAgent.onEvent')[0]
  assert.ok(eventSubscription, 'the actual session listener must exist')
  const dispatcher = nodesWithin(ast, node => node.type === 'AssignmentExpression'
    && node.left.type === 'Identifier' && node.left.name === 'handleAgentEvent')[0]?.right
  assert.ok(dispatcher, 'the shared live/history dispatcher must exist')
  const forwarded = nodesWithin(eventSubscription, node => node.type === 'CallExpression'
    && node.callee.name === 'handleAgentEvent')
  assert.equal(forwarded.length, 1, 'the sequence-fenced subscription must forward one packet')
  assert.equal(forwarded[0].arguments[0]?.name, 'packet')
  const eventWrites = writes.filter(write => write.start > dispatcher.start && write.end < dispatcher.end)
  assert.equal(eventWrites.length, 2, 'the session listener has only child-exit and turn-completed reply writes')
  eventWrites.forEach(write => reviewedWrites.add(write))
  assert.equal(reviewedWrites.size, writes.length, 'a new reply writer needs an explicit settlement contract')
  assert.match(source, /function settleTurnBoundary/, 'the boundary write disappeared; a later turn could absorb the earlier words')
  const terminal = source.slice(source.indexOf('const ended = sessionEndedEvent(packet, sessionId)'))
  assert.match(terminal.slice(0, terminal.indexOf('const status = sessionTurnStatus(packet, sessionId)')), /nodeReplies\.set\(nodeId, said\)/,
    'the fourth write is not bounded by the child-exit packet; a per-delta write may have crept in')
  assert.match(source, /nodeReplies\.set\(node\.id, node\.reply\)/,
    'the rehydration write must copy the store\'s persisted reply, not compute one')
  const handler = source.slice(dispatcher.start, dispatcher.end)
  const ordinary = handler.slice(handler.indexOf('const status = sessionTurnStatus(packet, sessionId)'))
  const statusCheck = ordinary.indexOf('sessionTurnStatus(packet, sessionId)')
  const replyWrite = ordinary.indexOf('nodeReplies.set(')
  assert.ok(statusCheck !== -1 && replyWrite > statusCheck,
    'the reply is written before the turn-completed check, i.e. per delta -- tens of thousands of one-word messages')
  /* The stream that MOVES during the turn is the appender, and it must flush
     before the reply takes over -- a truncated stream beside a complete reply
     would read as two different answers. */
  assert.match(ordinary, /flushNow\(\)/, 'the rail stream is not flushed on turn completion')
  /* Persistence: the turn's reply must reach the store, not only the cache.
     `said` is turnCompletionWords' answer -- streamed words, a failed turn's
     engine sentence, or the honest empty-turn line. */
  assert.match(ordinary, /setNodeReply\(nodeId, said\)/,
    'the completed reply is no longer persisted on the node')

  // Execute the additional confirmed-Stop path. Its observed partial words
  // reach transcript, saved reply and waiting surface exactly once; calling it
  // again after retirement cannot manufacture another reply.
  const replies = [], transcripts = [], delivered = [], closed = []
  const context = vm.createContext({
    nodeReplies: new Map(), sessionNodeIds: new Map([['session', 'node']]),
    RUN_NATIVE_WORK_CLOSE_LISTENERS: new Set(),
    sessionOpenTurns: new Map([['session', 'turn']]), sessionTurnText: new Map([['session', 'Observed words.']]),
    sessionPendingApprovals: new Map(),
    treeStore: { getNode: () => ({ id: 'node', sessionId: 'session', status: 'running' }),
      setNodeReply: (nodeId, text) => replies.push({ nodeId, text }) },
    transcriptAppend: (sessionId, row) => transcripts.push({ sessionId, ...row }),
    deliverTurnReply: (...args) => delivered.push(args), recordTurnActions: () => {},
    railChat: { sessionId: 'session', stream: { close: text => closed.push(text) } },
    clearInlineApproval: () => {}, turnCompletionWords,
  })
  context.retireTreeSessionRuntime = sessionId => context.sessionNodeIds.delete(sessionId)
  vm.runInContext(declaredFunctionSource(source, 'settleStoppedSession'), context)
  context.settleStoppedSession('session')
  context.settleStoppedSession('session')
  const said = turnCompletionWords({ spoken: 'Observed words.', userStopped: true })
  assert.deepEqual(replies, [{ nodeId: 'node', text: said }])
  assert.deepEqual(delivered, [['session', said, 'turn']])
  assert.deepEqual(closed, [said])
  assert.equal(transcripts.length, 1)
  assert.equal(transcripts[0].turnStamp, 'turn')
  assert.equal(transcripts[0].text, said)
})

test('the rail renders the said panel from the copy module, for sessions only', () => {
  const source = read('src/views/computers.js')
  assert.match(source, /SAID_PANEL\.title/, 'the rail no longer renders the "What it said" box')
  assert.match(source, /node\.sessionId \? `/,
    'the said box must exist only for nodes that hold a session; a draft node has nothing to have said')
})

test('the chip is a context window, never a telemetry card, for tree nodes', () => {
  /* Owner, 2026-08-13: "I dont see anything just nonsense. Its supposed to be
     a context window." The nonsense was deterministic: chat hardcoded null,
     statusNote cleared on success, so every successful run printed "nothing
     has run for this agent yet" under "telemetry unavailable". These pin the
     repair's three load-bearing pieces. */
  const view = read('src/views/computers.js')
  const feed = view.slice(view.indexOf('function treeContextFeed'), view.indexOf('function treeContextFeed') + 2200)
  assert.ok(!/chat:\s*null/.test(feed), 'treeContextFeed hardcodes chat null again — the context window went dark')
  assert.match(feed, /sessionTurnText\.get\(node\.sessionId\)/, 'the chip no longer streams the turn in flight')
  assert.match(feed, /nodeReplies\.get\(node\.id\) \|\| node\.reply/, 'the chip no longer shows the persisted reply')
  assert.match(feed, /asked: /, 'the chip no longer shows what was asked')

  const graph = read('src/tree-graph.js')
  const declaration = parseAst(graph).body.find(node => node.declaration?.id?.name === 'StaticTreeGraph').declaration
  const method = declaration.body.body.find(node => node.key.name === '_renderChipPreview')
  const renderPreview = new Function('formatInlineText', 'roleAppearance', 'escapeMarkup', 'TREE_PREVIEW_OPEN', 'latestNodeResponse', `return function ${graph.slice(method.start, method.end)}`)(text => text, () => ({ label: 'Builder' }), text => String(text), 'Open conversation', latestNodeResponse)
  const render = feed => {
    const preview = { innerHTML: '', querySelector: () => ({ hidden: false }) }
    renderPreview.call({ nodeStyle: 'circles', cardSize: 'large', computer: { agents: [] },
      previewFitter: { watch() {} },
      _contextCardProfile: () => ({ value: 'large' }), _screenContext: () => feed }, {
      agent: { name: 'Builder', role: 'builder' }, chip: { querySelector: () => preview },
    })
    return preview.innerHTML
  }
  for (const context of [{ chat: 'Actual latest reply' }, { previous: 'Actual saved context' }, { tool: 'Reading the patch' }, { task: 'Review the changes' }]) {
    const html = render(context)
    assert.ok(html.includes(Object.values(context)[0]), 'real context must reach the preview')
    assert.doesNotMatch(html, /telemetry unavailable|No additional context reported/,
      'a missing-context fallback must not replace a real reply, brief, or action')
  }
  assert.match(render({}), /No additional context reported/, 'an empty context stays explicit')
  assert.match(graph, /refreshChip\(agentId\)/, 'the narrow one-chip repaint is gone; streaming cannot reach the glass')
  assert.match(view, /scheduleChipRefresh\(/, 'nothing schedules chip repaints from the event stream')
  assert.match(view, /requestAnimationFrame\(/, 'chip repaints are not frame-batched')
})

test('the role menu says what a person can observe, not an internal lease', () => {
  const source = read('src/org-controls.js')
  assert.ok(!/reserve work/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the option label asserts the reserve-work mechanic again — no customer surface exhibits it')
  assert.match(source, /can be given jobs/, 'the enforced flag lost its observable-consequence label')
})

test('the said panel copy is whole, plain, and actionable', () => {
  for (const [key, sentence] of Object.entries(SAID_PANEL)) {
    assert.equal(typeof sentence, 'string', `${key} is not a sentence`)
    assert.ok(sentence.length > 10, `${key} is too short to mean anything: ${sentence}`)
  }
  /* Rule 3 of the copy module: a failure sentence ends with something to do. */
  assert.match(SAID_PANEL.emptyTurn, /Ask again/,
    'the empty-turn sentence no longer tells the person what to do next')
})
