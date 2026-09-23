import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'

import { sessionUsageEvent } from '../../src/agent-session-events.js'
import { buildChat } from '../../src/components.js'
import { usageSentence } from '../../src/fleet-tree-copy.js'
import { parseFleetTrees } from '../../src/fleet-trees.js'
import { parseSlashCommand, slashHelpSentence, SLASH_COMMANDS } from '../../src/slash-commands.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = file => readFileSync(resolve(ROOT, file), 'utf8')

// Use the shared component fixture so the actual template, dataset and
// lifecycle APIs evolve together. Geometry here is synthetic, not native UI.
async function renderedChatLines(history) {
  const dom = installDomStandIn()
  let chat
  try {
    chat = buildChat({ title: 'Ada', history, seed: 3, onSend() {} })
    // Let the fixture document's already-ready font promise finish before its
    // global DOM is restored; it is part of the mounted component lifecycle.
    await Promise.resolve()
    return chat.querySelector('.chat-log').children.map(row => row.querySelector('.chat-msg-text')?.textContent).filter(Boolean)
  } finally { chat?.dispose(); dom.restore() }
}

/* C1: what the session says and what it costs; C2: the console vocabulary.
   The usage events crossed the wire from day one and were dropped; the card
   opened empty over nodes that had plainly spoken. These pin the repairs. */

test('the usage reader admits numbers from its own session and nothing else', () => {
  const packet = {
    sessionId: 'chat-1',
    event: { type: 'usage', turnId: 'turn-9', usage: { input_tokens: 1200, output_tokens: 300, note: 'prose', path: 'C:/x', nested: { a: 1 }, bad: Infinity } },
  }
  const reading = sessionUsageEvent(packet, 'chat-1')
  assert.deepEqual(reading, { turnId: 'turn-9', usage: { input_tokens: 1200, output_tokens: 300 } },
    'only finite numeric fields may survive — prose or a path in a usage record must never reach a screen')
  assert.equal(sessionUsageEvent(packet, 'chat-2'), null, 'another session\'s usage is not yours')
  assert.equal(sessionUsageEvent({ sessionId: 'chat-1', event: { type: 'assistant_text' } }, 'chat-1'), null)
})

test('the reader unwraps the engine\'s measured nested shape (total + modelContextWindow)', () => {
  /* Captured live from codex 0.146 app-server, 2026-08-14. */
  const packet = {
    sessionId: 'chat-1',
    event: {
      type: 'usage', turnId: 'turn-2',
      usage: {
        total: { totalTokens: 28246, inputTokens: 28180, cachedInputTokens: 23040, cacheWriteInputTokens: 0, outputTokens: 66, reasoningOutputTokens: 31 },
        last: { totalTokens: 14133, inputTokens: 14127, cachedInputTokens: 13056, cacheWriteInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 },
        modelContextWindow: 258400,
      },
    },
  }
  const reading = sessionUsageEvent(packet, 'chat-1')
  assert.equal(reading.usage.totalTokens, 28246, 'the session-lifetime total is the reading')
  assert.equal(reading.usage.inputTokens, 28180)
  assert.equal(reading.usage.modelContextWindow, 258400)
  assert.equal(reading.usage.last, undefined, 'nested records do not ride whole')
  const sentence = usageSentence(reading.usage)
  assert.match(sentence, /28 thousand tokens/, 'the lifetime total renders in words')
  assert.match(sentence, /window holds/, 'the context window is worth a sentence')
})

test('the usage sentence is words, never bare token codes, and admits ignorance', () => {
  const sentence = usageSentence({ input_tokens: 52_000, output_tokens: 900, cached_input_tokens: 21_000 })
  assert.match(sentence, /thousand tokens/, 'counts render as words')
  assert.match(sentence, /read/, 'input renders as reading')
  assert.match(sentence, /cache/, 'cache savings are worth a clause')
  assert.ok(!/input_tokens|output_tokens/.test(sentence), 'field names are not sentences')
  assert.match(usageSentence({ mystery_field: 5 }), /does not recognise/, 'an unrecognised shape says so instead of inventing a number')
})

test('slash commands map only onto actions the palette already binds', () => {
  const view = read('src/views/computers.js')
  for (const command of SLASH_COMMANDS) {
    assert.ok(view.includes(`'${command.action}'`), `/${command.name} names palette action ${command.action}, which the view does not bind`)
  }
  assert.deepEqual(parseSlashCommand('/interrupt'), { kind: 'action', action: 'interrupt', rest: '' })
  assert.deepEqual(parseSlashCommand('/queue check the tests'), { kind: 'action', action: 'queue', rest: 'check the tests' })
  assert.equal(parseSlashCommand('/help').kind, 'help')
  assert.match(slashHelpSentence(), /\/interrupt/, 'help names the real commands')
})

test('a typo is caught, a path is not eaten, plain text passes through', () => {
  const typo = parseSlashCommand('/interupt')
  assert.equal(typo.kind, 'unknown')
  assert.match(typo.sentence, /not a command here, so nothing was sent/)
  assert.equal(parseSlashCommand('/usr/bin/thing --flag'), null, 'a path sends as text')
  assert.equal(parseSlashCommand('read C:/data/notes.md'), null)
  assert.equal(parseSlashCommand('  plain words  '), null)
})

test('the view intercepts the vocabulary at both send paths, before anything queues', () => {
  /* Two paths carry typed words to an agent now (iteration 6): an idle send
     through treeCardSend, and a busy send through the composer's queue.add
     closure. BOTH must parse the console vocabulary before anything queues —
     /interrupt while busy is exactly when it matters, and the old queue box
     this test once pinned retired into the second path. */
  const view = read('src/views/computers.js')
  const card = view.slice(view.indexOf('function treeCardSend'))
  assert.ok(card.indexOf('parseSlashCommand') !== -1
    && card.indexOf('parseSlashCommand') < card.indexOf('outboxEnqueue'),
    'the card parses commands after it queues — /interrupt while busy is exactly when it matters')
  const queueAdd = view.slice(view.indexOf('add: text => {'))
  assert.ok(queueAdd.indexOf('parseSlashCommand') !== -1
    && queueAdd.indexOf('parseSlashCommand') < queueAdd.indexOf('outboxEnqueue'),
    'the composer queue closure no longer understands the vocabulary — a busy /interrupt would wait in line behind the turn it exists to stop')
})

test('the conversation is kept and the card opens over it, never empty and never simulated', async () => {
  const view = read('src/views/computers.js')
  assert.match(view, /sessionTranscripts/, 'the transcript map is gone')
  for (const anchor of ['transcriptAppend(node.sessionId', 'transcriptAppend(sessionId']) {
    assert.ok(view.includes(anchor), `sends or completions no longer file into the transcript (${anchor})`)
  }
  assert.match(view, /history = sessionTranscripts\.get\(node\.sessionId\)/, 'the card no longer reads the real transcript')
  assert.match(view, /turnLogAppend/, 'the turn log (the rewind anchor) is gone')
  const supplied = [{ who: 'you', text: 'Keep this exact question.' }, { who: 'agent', text: 'Keep this exact answer.' }]
  assert.deepEqual(await renderedChatLines(supplied), supplied.map(entry => entry.text),
    'a chat with real history must render those entries, in order, without adding a simulated conversation')
  const graph = read('src/tree-graph.js')
  assert.match(graph, /history: Array\.isArray\(config\.history\)/, 'the graph drops the history on the way to the card')
})

test('clear starts the conversation over for real: close, fresh session, nothing re-sent', () => {
  const view = read('src/views/computers.js')
  const clearStart = view.indexOf(`if (id === 'clear')`)
  const clear = view.slice(clearStart, view.indexOf(`if (id === 'resume')`, clearStart))
  assert.ok(clear.length > 100, 'the clear action left the palette')
  assert.match(clear, /freshStartExistingNode\(node\)/,
    'the palette bypasses the guarded clean-replacement lifecycle again')
  assert.doesNotMatch(clear, /bridge\.(?:close|start|send)/,
    'the palette owns a second restart implementation that can drift from the command restart')
  const helper = read('src/fresh-start-existing-node.js')
  assert.ok(helper.indexOf('await bridge.close(') !== -1 && helper.indexOf('await bridge.close(') < helper.indexOf('await bridge.start('),
    'the shared replacement must close the old session before starting the fresh one')
  assert.doesNotMatch(helper, /bridge\.send/,
    'clear re-sends the brief — re-running the original ask uninvited could redo real work')
  for (const wiped of ['sessionTranscripts.delete', 'sessionTurnLog.delete', 'sessionUsage.delete', 'sessionModelOverride.delete']) {
    const mapName = wiped.slice(0, wiped.indexOf('.'))
    assert.match(helper, new RegExp(`sessionState\\.${mapName.replace(/^session/, '').replace(/^./, c => c.toLowerCase())}`),
      `clear no longer wipes ${mapName} — a forgotten agent with a remembered screen is a lie in one direction or the other`)
  }
  assert.match(view, /tier: draft\.tier/, 'the compose panel no longer records the tier a restart honestly reuses')
  const restored = parseFleetTrees(JSON.stringify({
    version: 1, computerId: 'computer-1',
    trees: [{ id: 'tree-1', name: 'One', createdAt: 'a', updatedAt: 'a' }],
    nodes: [{ id: 'node-1', treeId: 'tree-1', parentId: null, role: 'planner', message: 'Plan it', status: 'draft', statusNote: '', sessionId: null, tier: 'local', createdAt: 'a', updatedAt: 'a' }],
  }))
  assert.equal(restored.nodes[0].tier, 'local', 'a recorded tier must survive storage parsing')
})

test('resume never orphans a renderer-owned agent when closing it fails', () => {
  const view = read('src/views/computers.js')
  const resumeStart = view.indexOf('async function resumeNodeSessionUnguarded')
  const resume = view.slice(resumeStart, view.indexOf('async function runPaletteAction', resumeStart))
  assert.match(resume, /replacesSessionId: oldSessionId/,
    'resume no longer hands the predecessor to the host, so nothing closes it after the authority checks pass')
  // A cancelled, already-admitted successor must still be closed by its
  // requesting view. That cleanup is separate from closing the predecessor;
  // exclude its exact function body, not an arbitrary source substring.
  const handler = parseAst(resume).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'resumeNodeSessionUnguarded')
  const cancelledCleanup = handler.body.body.flatMap(node => node.declarations || [])
    .find(node => node.id?.name === 'closeCancelledResumeSession')?.init
  assert.equal(cancelledCleanup?.type, 'ArrowFunctionExpression')
  const predecessorPath = resume.slice(0, cancelledCleanup.start) + resume.slice(cancelledCleanup.end)
  assert.doesNotMatch(predecessorPath, /bridge\.close\(/,
    'the renderer closes the old session itself again -- a refused start then orphans a live agent, which is the exact failure this test exists for; the close belongs to the host, after its checks')
  const host = read('shell/agent-host.cjs')
  assert.match(host, /AGENT_PREDECESSOR_CLEANUP_FAILED/,
    'the host no longer names a failed predecessor cleanup, so a resume can strand a session it could not close')
  assert.match(host, /No replacement was started/,
    'a failed predecessor cleanup must refuse the start outright -- reporting it while starting anyway is how the old agent gets orphaned')
  const forget = resume.indexOf('sessionNodeIds.delete(oldSessionId)')
  const start = resume.indexOf('started = await bridge.start')
  assert.ok(start !== -1 && forget !== -1 && start < forget,
    'resume forgets the old session before the start has returned, so a refused start leaves a live agent nobody can address')
})

test('the usage row exists in the rail and fills from the live ear', () => {
  const view = read('src/views/computers.js')
  assert.match(view, /data-tree-usage/, 'the rail lost its usage row')
  assert.match(view, /sessionUsageEvent\(packet, sessionId\)/, 'the ear no longer reads usage events')
  assert.match(view, /usageSentence\(/, 'usage renders as fields, not words')
})
