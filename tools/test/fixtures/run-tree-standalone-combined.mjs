import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst } from 'rollup/parseAst'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_STANDALONE_COMBINED_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-standalone-combined-'))
mkdirSync(out, { recursive: true })
const files = ['src/views/computers.js', 'src/components.js', 'src/tree-standalone-adoption.js', 'src/tree-standalone-placement.js', 'src/tree-standalone-agent.js', 'src/agent-session.js', 'src/tree-graph.js', 'src/tree-workspace.js', 'src/fleet-trees.js', 'src/session-transcript-store.js',
  'tools/test/tree-chat-resume-stream.test.mjs', 'tools/test/fixtures/tree-standalone-combined.html', 'tools/test/fixtures/tree-standalone-combined.mjs', 'tools/test/fixtures/run-tree-standalone-combined.mjs']
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes(), results = [], errors = []
const source = readFileSync(path.join(root, 'src/views/computers.js'), 'utf8')
const ast = parseAst(source)
const body = ast.body.find(node => node.declaration?.id?.name === 'computersView').declaration.body.body
const names = ['treeAnchorsFor', 'nodeRequestKeys', 'nodeTreeIdentity', 'placeStandaloneAgent', 'rebindRailToSession', 'transcriptAppend', 'persistTranscript', 'markTurnRunning', 'settleTurnBoundary', 'unregisterChatSurface', 'registerChatSurface', 'broadcastChatSpeech', 'scheduleChatSpeech', 'deliverTurnReply', 'awaitTurnReply', 'dropTurnReply', 'treeChatConfigFor', 'treeCardSend', 'turnLogAppend', 'scheduleChipRefresh']
const methods = names.map(name => { const node = body.find(node => node.id?.name === name); assert.ok(node, name); return source.slice(node.start, node.end) })
let eventHandler, eventDispatcher
const visit = node => {
  if (!node || typeof node !== 'object') return
  if (node.type === 'AssignmentExpression' && node.left?.name === 'handleAgentEvent') {
    assert.equal(eventDispatcher, undefined); eventDispatcher = source.slice(node.right.start, node.right.end)
  }
  if (node.type === 'CallExpression' && source.slice(node.callee.start, node.callee.end) === 'window.mcAgent.onEvent') {
    assert.equal(eventHandler, undefined); eventHandler = source.slice(node.arguments[0].start, node.arguments[0].end)
  }
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value)
}
visit(ast); assert.ok(eventHandler && eventDispatcher)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error', plugins: [{ name: 'actual-page-methods', configureServer(server) { server.middlewares.use('/__standalone-page-code', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ methods, eventHandler, eventDispatcher })) }) } }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page, stage = 'load'
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 950 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-standalone-combined.html`)
  await page.waitForFunction(() => window.combined?.ready)
  await page.evaluate(() => document.fonts.ready)
  const active = () => page.locator('.tree-standalone-conversation:not([hidden])')
  const add = async () => {
    await page.locator('.tree-chat-add').click(); await page.locator('.tree-new-agent').click()
    if (await page.locator('.tree-agent-notice').isVisible()) await page.locator('.tree-agent-continue').click()
    await active().locator('.chat-input input').waitFor()
    return page.evaluate(() => {
      const r = graph.workspace.standalone.get(graph.activeChatId)
      combined.originals.set(r.id, { record: r, panel: r.chatPanel, session: r.session, chat: r.chatPanel.querySelector('[data-chat-panel]') })
      return r.id
    })
  }
  const send = async text => {
    const count = await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'send').length)
    await active().locator('.chat-input input').fill(text); await active().locator('.chat-input input').press('Enter')
    await page.waitForFunction(count => combined.calls.filter(([kind]) => kind === 'send').length > count, count)
    await page.waitForTimeout(50)
  }
  const exactOwner = id => page.evaluate(id => {
    const r = graph.workspace.standalone.get(id), saved = combined.originals.get(id)
    return r === saved.record && r.chatPanel === saved.panel && r.session === saved.session && r.chatPanel.querySelector('[data-chat-panel]') === saved.chat
  }, id)
  stage = 'never-started placement then correctly addressed first send'
  const first = await add()
  await active().locator('.chat-input input').fill('Draft retained in the real session surface')
  const result = await page.evaluate(id => graph.workspace.placeStandalone(id, combined.parent.id), first)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(await exactOwner(first), true)
  assert.deepEqual(await page.evaluate(() => combined.calls), [])
  assert.equal(await page.evaluate(id => combined.store.getNode(id).sessionId, result.nodeId), null)
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), result.nodeId)
  assert.equal(await page.evaluate(() => graph.activeChatId), first)
  assert.equal(await active().locator('.chat-head .t').textContent(), await page.evaluate(id => graph._agentFor(id).name, result.nodeId))
  assert.equal(await active().locator('.chat-input input').inputValue(), 'Draft retained in the real session surface')
  await send('First real composer send after placement')
  const sent = await page.evaluate(() => ({ start: combined.calls.find(([kind]) => kind === 'start')[1], send: combined.calls.find(([kind]) => kind === 'send')[1] }))
  assert.equal(sent.start.surface, 'fleet-tree')
  assert.equal(sent.start.requestKeys.threadId, result.nodeId)
  assert.deepEqual(sent.start.requestKeys.treeAnchors, [await page.evaluate(() => combined.parent.id), result.nodeId])
  assert.equal(await page.evaluate(id => combined.maps.sessionNodeIds.get(id), sent.start.sessionId), result.nodeId)
  await page.evaluate(id => {
    combined.emit(id, { type: 'assistant_text_delta', text: 'Answered after adoption', turnId: 'turn-1' })
    combined.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  }, sent.start.sessionId)
  await page.waitForTimeout(100)
  assert.match(await active().textContent(), /Answered after adoption/)
  assert.equal(await page.evaluate(id => combined.store.getNode(id).reply, result.nodeId), 'Answered after adoption')
  assert.deepEqual(await page.evaluate(id => combined.transcripts.get(id).lines.map(line => line.text), result.nodeId), ['First real composer send after placement', 'Answered after adoption'])
  results.push({ stage, nodeId: result.nodeId, sessionId: sent.start.sessionId })

  stage = 'running adoption includes words received while IPC waits'
  await page.locator('.tree-home-tab').click()
  const second = await add()
  await send('Already running before tree placement')
  const id = await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'start').at(-1)[1].sessionId)
  await page.evaluate(id => combined.emit(id, { type: 'assistant_text_delta', text: 'Before acknowledgment', turnId: 'turn-2' }), id)
  await page.evaluate(second => {
    const r = graph.workspace.standalone.get(second)
    r.chatPanel.querySelector('[data-chat-panel]').importDraft({ text: 'Keep this follow-up', attachments: [{ path: '/fixture/kept.png', name: 'kept.png' }], start: 3, end: 8 })
    combined.held = true; combined.pending = graph.workspace.placeStandalone(second, combined.parent.id)
  }, second)
  await page.waitForFunction(() => !!combined.finish)
  await page.evaluate(id => combined.emit(id, { type: 'assistant_text_delta', text: ' and during IPC', turnId: 'turn-2' }), id)
  const adopted = await page.evaluate(async () => { combined.finish(); return combined.pending })
  assert.equal(adopted.ok, true, JSON.stringify(adopted))
  assert.equal(await exactOwner(second), true)
  assert.equal(await page.evaluate(id => combined.maps.sessionTurnText.get(id), id), 'Before acknowledgment and during IPC')
  assert.equal(await page.evaluate(id => combined.maps.sessionOpenTurns.get(id), id), 'turn-2')
  assert.equal(await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'start').length), 2)
  assert.equal(await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'close' || kind === 'interrupt').length), 0)
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), adopted.nodeId)
  assert.equal(await page.evaluate(() => graph.activeChatId), second)
  assert.equal(await active().locator('.chat-head .t').textContent(), await page.evaluate(id => graph._agentFor(id).name, adopted.nodeId))
  assert.equal(await active().locator('.chat-input input').inputValue(), 'Keep this follow-up')
  assert.equal(await page.evaluate(id => graph.workspace.standalone.get(id).chatPanel.querySelector('[data-chat-panel]').exportDraft().attachments.length, second), 1)
  assert.match(await active().textContent(), /Before acknowledgment and during IPC/)
  results.push({ stage, nodeId: adopted.nodeId, sessionId: id })

  stage = 'close adopted tab and reopen active node without losing current turn'
  await page.evaluate(id => graph.workspace.close(graph.workspace.standalone.get(id)), second)
  assert.equal(await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'close' || kind === 'interrupt').length), 0)
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), adopted.nodeId)
  const reopened = page.locator('.tree-conversation:not([hidden])')
  await reopened.waitFor()
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(out, 'reopened-active-node.png') })
  const reopenedText = await reopened.textContent()
  results.push({ stage, textBeforeNextDelta: reopenedText, snapshot: await page.evaluate(id => ({ partial: combined.maps.sessionTurnText.get(id), history: combined.maps.sessionTranscripts.get(id) }), id) })
  assert.match(reopenedText, /Before acknowledgment and during IPC/, 'reopening the tree-owned chat must retain the in-flight answer')
  assert.equal(await reopened.locator('.them').count(), 1, 'exactly one owner paints the resumed partial reply')
  const reopenedDraft = await page.evaluate(id => graph.nodes.get(id).chatRoot.exportDraft(), adopted.nodeId)
  assert.equal(reopenedDraft.text, 'Keep this follow-up')
  assert.equal(reopenedDraft.attachments.length, 1)
  assert.equal(reopenedDraft.attachments[0].path, '/fixture/kept.png')
  assert.deepEqual([reopenedDraft.start, reopenedDraft.end], [3, 8])
  await page.evaluate(id => combined.emit(id, { type: 'assistant_text_delta', text: ' and after reopening', turnId: 'turn-2' }), id)
  await page.waitForTimeout(100)
  assert.match(await reopened.textContent(), /Before acknowledgment and during IPC and after reopening/)
  assert.equal(await page.evaluate(id => combined.maps.chatSurfaces.get(id)?.size || 0, id), 1)
  // Explicit close releases the shared surface, with no separate reply waiter;
  // reopening acquires exactly one surface on the still-running session.
  await page.evaluate(id => graph.closeChat(graph.nodes.get(id)), adopted.nodeId)
  await page.waitForTimeout(50)
  assert.equal(await page.evaluate(id => combined.maps.chatSurfaces.get(id)?.size || 0, id), 0)
  assert.equal(await page.evaluate(id => combined.maps.turnReplies.get(id)?.size || 0, id), 0)
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), adopted.nodeId)
  await page.waitForTimeout(50)
  assert.equal(await page.evaluate(id => combined.maps.chatSurfaces.get(id)?.size || 0, id), 1)
  await page.evaluate(id => combined.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-2' }), id)
  await page.waitForTimeout(100)
  assert.match(await reopened.textContent(), /Before acknowledgment and during IPC and after reopening/)
  assert.equal(await reopened.locator('.them').count(), 1)
  assert.equal(await page.evaluate(id => combined.maps.turnReplies.get(id)?.size || 0, id), 0)
  assert.equal(await page.evaluate(id => combined.transcripts.get(id).lines.filter(line => line.who === 'agent').length, adopted.nodeId), 1)
  stage = 'accepted Halt without a provider completion preserves its partial reply on reopen'
  await page.locator('.tree-home-tab').click()
  const third = await add()
  await send('A turn that the person stops')
  const haltedId = await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'start').at(-1)[1].sessionId)
  await page.evaluate(id => combined.emit(id, { type: 'assistant_text_delta', text: 'Keep the words spoken before Halt', turnId: 'turn-3' }), haltedId)
  const haltedNode = await page.evaluate(async id => { combined.held = false; return graph.workspace.placeStandalone(id, combined.parent.id) }, third)
  assert.equal(haltedNode.ok, true)
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), haltedNode.nodeId)
  await active().locator('.chat-send').click()
  await page.waitForFunction(id => !graph.workspace.standalone.get(id).session.snapshot().phase.includes('working'), third)
  await page.evaluate(id => graph.workspace.close(graph.workspace.standalone.get(id)), third)
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), haltedNode.nodeId)
  await page.waitForTimeout(100)
  const haltedText = await page.locator('.tree-conversation:not([hidden])').textContent()
  results.push({ stage, text: haltedText, saved: await page.evaluate(id => combined.transcripts.get(id), haltedNode.nodeId) })
  assert.match(haltedText, /Keep the words spoken before Halt/)
  assert.equal(await page.locator('.tree-conversation:not([hidden]) .them').count(), 1, 'Halt history and buffered partial are one visible answer')
  stage = 'late provider words refine one Halt reply; a new provider turn remains independent'
  await page.evaluate(id => combined.emit(id, { type: 'assistant_text_delta', text: ' and actual late provider words', turnId: 'turn-3' }), haltedId)
  await page.waitForTimeout(100)
  assert.equal(await page.locator('.tree-conversation:not([hidden]) .them').count(), 1)
  assert.match(await page.locator('.tree-conversation:not([hidden]) .them').textContent(), /Keep the words spoken before Halt and actual late provider words/)
  await page.evaluate(id => combined.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-3' }), haltedId)
  assert.deepEqual(await page.evaluate(id => combined.transcripts.get(id).lines.filter(row => row.who === 'agent').map(row => row.text), haltedNode.nodeId), ['Keep the words spoken before Halt and actual late provider words'])
  assert.equal(await page.locator('.tree-conversation:not([hidden]) .them').count(), 1, 'late completion refines the same Halt answer')
  assert.equal(await page.evaluate(id => combined.store.getNode(id).reply, haltedNode.nodeId), 'Keep the words spoken before Halt and actual late provider words')
  await page.evaluate(id => {
    combined.emit(id, { type: 'assistant_text_delta', text: 'New independent provider turn', turnId: 'next-provider-turn' })
    combined.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-3' })
  }, haltedId)
  assert.equal(await page.evaluate(id => combined.maps.sessionTurnText.get(id), haltedId), 'New independent provider turn')
  await page.evaluate(id => combined.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'next-provider-turn' }), haltedId)
  const finalReplies = await page.evaluate(id => combined.transcripts.get(id).lines.filter(row => row.who === 'agent').map(row => row.text), haltedNode.nodeId)
  assert.deepEqual(finalReplies, ['Keep the words spoken before Halt and actual late provider words', 'New independent provider turn'])
  assert.equal(await page.evaluate(id => combined.store.getNode(id).reply, haltedNode.nodeId), 'New independent provider turn')
  results.push({ stage, finalReplies })
  stage = 'the reopened shared composer sends the next turn with one visible answer'
  const conversation = page.locator('.tree-conversation:not([hidden])')
  const sendsBefore = await page.evaluate(() => combined.calls.filter(([kind]) => kind === 'send').length)
  await conversation.locator('.chat-input input').fill('Continue from the tree-owned composer')
  await conversation.locator('.chat-input input').press('Enter')
  await page.waitForFunction(count => combined.calls.filter(([kind]) => kind === 'send').length === count + 1, sendsBefore)
  await page.waitForTimeout(50)
  await page.evaluate(async ({ id, turnId }) => {
    await combined.emit(id, { type: 'assistant_text_delta', text: 'One shared composer answer', turnId })
    await combined.emit(id, { type: 'turn_completed', status: 'completed', turnId })
  }, { id: haltedId, turnId: `turn-${sendsBefore + 1}` })
  await page.waitForTimeout(100)
  assert.equal(await conversation.locator('.them').count(), 3)
  assert.equal(await conversation.locator('.them').filter({ hasText: 'One shared composer answer' }).count(), 1)
  assert.equal(await page.evaluate(id => combined.maps.turnReplies.get(id)?.size || 0, haltedId), 0)
  assert.deepEqual(await page.evaluate(id => combined.transcripts.get(id).lines.filter(row => row.who === 'agent').map(row => row.text), haltedNode.nodeId), [...finalReplies, 'One shared composer answer'])
  results.push({ stage, totalVisibleAnswers: 3, providerSends: sendsBefore + 1 })
  await page.evaluate(() => combined.destroy())
  assert.equal(await page.evaluate(() => combined.listeners.size), 0)
  assert.deepEqual(errors, [])
  const after = hashes()
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, sourceChangedDuringRun: JSON.stringify(before) !== JSON.stringify(after), before, after, results, errors }, null, 2))
  process.stdout.write(JSON.stringify({ passed: true, out, stages: results.length }) + '\n')
} catch (error) {
  const after = hashes()
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: false, stage, error: error.stack, sourceChangedDuringRun: JSON.stringify(before) !== JSON.stringify(after), before, after, results, errors }, null, 2))
  process.stderr.write(JSON.stringify({ passed: false, out, stage, error: error.message, errors }) + '\n'); process.exitCode = 1
} finally { await browser?.close(); await server.close() }
