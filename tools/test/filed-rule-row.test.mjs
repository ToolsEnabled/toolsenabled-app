/* THE ROW THE CHAT SHOWS WHEN AN AGENT FILED ONE OF THE PERSON'S RULES.
 *
 * O7, the visible half. With "Turning something you said into a standing
 * rule" on, an agent calls r_ledger.file and the engine answers
 * `{ filed: true, id, scope, key, filedBy, appliesTo, note }`. The registry row
 * promises "the chat shows you a line saying what was filed and where", and
 * the line has to come from that RESULT -- the engine's own word -- never
 * from the agent's prose about what it did.
 *
 *   READ      src/agent-session-events.js reads the call (for the person's
 *             words) and the result (for the id, reach and author) in both
 *             engines' measured shapes; exact session, exact shape, null for
 *             everything else -- and a result that does not say filed:true
 *             with a ledger id is not a filing, whatever the agent said.
 *   SAY       src/filed-rule-copy.js turns those fields into one plain row:
 *             the id, the reach, the first stretch of the person's words,
 *             the agent's name. No key, no path, no session id.
 *   LIST      the rules panel says who filed an entry when it was an agent
 *             (src/tree-standing-requests.js, through the reader in
 *             shell/standing-requests-read.cjs that now carries filedBy).
 *   WIRE      the maintained filing branch and its actual call-pairing and
 *             panel-refresh helpers run with an explicit store/panel boundary.
 *             The call is remembered, the result draws the row and a mounted
 *             rules panel refreshes while preserving an edit in progress.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)

const { sessionFiledRule, sessionRuleFilingCall } = await import('../../src/agent-session-events.js')
const copy = await import('../../src/filed-rule-copy.js')
const { createStandingRequestsPanel } = await import('../../src/tree-standing-requests.js')
const { readStandingRequests } = require_(path.join(ROOT, 'shell', 'standing-requests-read.cjs'))

/* Placeholder words only. No fixture in this repository carries a real
   remark of the owner's. */
const WORDS = 'Placeholder words that a person said and an agent filed as a rule for this test, long enough to pass the cap.'
/* The one canonical ledger's ids (2026-09-02): R-only for every tier, with
   dotted refinements. A refinement id is used here on purpose -- it is the
   shape the old per-scope grammar could never draw a row for. */
const REPLY = Object.freeze({ filed: true, id: 'R3.1', scope: 'thread', key: 'node-7', filedBy: 'codex', stamp: '2026-08-22T00:00:00.000Z', appliesTo: 'this agent, this conversation only', note: 'Filed R3.1.' })

const packet = (sessionId, event) => ({ sessionId, event })

/* The codex adapter's shapes: the tool is named on the call's payload, the
   MCP reply rides the result's payload as `result`. */
const codexCall = () => packet('s1', { type: 'tool_call', turnId: 't1', toolCallId: 'item-1', tool: 'mcpToolCall', payload: { server: 'toolsenabled', tool: 'r_ledger.file', arguments: { actor: 'codex', scope: 'thread', key: 'node-7', words: WORDS } } })
const codexResult = (reply = REPLY) => packet('s1', { type: 'tool_result', turnId: 't1', toolCallId: 'item-1', tool: 'mcpToolCall', payload: { status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(reply, null, 2) }], structuredContent: reply } } })

/* The Claude CLI's shapes: the tool is named on the call, the input is the
   payload, and the result comes back as text blocks. */
const claudeCall = () => packet('s1', { type: 'tool_call', turnId: 't1', toolCallId: 'toolu_1', tool: 'mcp__toolsenabled__r_ledger_file', payload: { actor: 'claude', scope: 'global', words: WORDS } })
const claudeResult = (reply = { ...REPLY, id: 'R2010', scope: 'global', key: null, filedBy: 'claude', appliesTo: 'every agent' }) =>
  packet('s1', { type: 'tool_result', turnId: 't1', toolCallId: 'toolu_1', payload: [{ type: 'text', text: JSON.stringify(reply) }], status: 'ok' })

test('the call is read for the person\'s words, in both engines\' shapes', () => {
  assert.deepEqual(sessionRuleFilingCall(codexCall(), 's1'), { toolCallId: 'item-1', words: WORDS })
  assert.deepEqual(sessionRuleFilingCall(claudeCall(), 's1'), { toolCallId: 'toolu_1', words: WORDS })
  /* Another session's call is not this session's. */
  assert.equal(sessionRuleFilingCall(codexCall(), 's2'), null)
  /* A different tool is not a filing, however similar its arguments. */
  const propose = codexCall()
  propose.event.payload.tool = 'r_ledger.propose'
  assert.equal(sessionRuleFilingCall(propose, 's1'), null)
  const command = packet('s1', { type: 'tool_call', toolCallId: 'c1', tool: 'commandExecution', payload: { command: 'node --version' } })
  assert.equal(sessionRuleFilingCall(command, 's1'), null)
})

test('the result is read for the id, reach and author -- only when it says filed:true with a ledger id', () => {
  const codex = sessionFiledRule(codexResult(), 's1')
  assert.deepEqual(codex, { toolCallId: 'item-1', id: 'R3.1', scope: 'thread', key: 'node-7', appliesTo: 'this agent, this conversation only', filedBy: 'codex' })
  const claude = sessionFiledRule(claudeResult(), 's1')
  assert.equal(claude.id, 'R2010')
  assert.equal(claude.filedBy, 'claude')
  assert.equal(claude.appliesTo, 'every agent')

  assert.equal(sessionFiledRule(codexResult(), 's2'), null, 'another session\'s result leaked')
  assert.equal(sessionFiledRule(codexResult({ ...REPLY, filed: false }), 's1'), null, 'a result that did not file is not a filing')
  assert.equal(sessionFiledRule(codexResult({ ...REPLY, id: 'not-an-id' }), 's1'), null, 'an id that is not a ledger id is refused')
  /* The retired per-scope prefixes are not ids of the one ledger. */
  for (const retired of ['RTH3', 'RS1', 'RT2', 'R0', 'R3.0', 'R3.', 'r3']) {
    assert.equal(sessionFiledRule(codexResult({ ...REPLY, id: retired }), 's1'), null, `${retired} drew a row`)
  }
  for (const accepted of ['R1', 'R01', 'R9999', 'R5.1.2']) {
    assert.equal(sessionFiledRule(codexResult({ ...REPLY, id: accepted }), 's1').id, accepted, `${accepted} drew no row`)
  }
  /* A proposal's result (filed:false, proposalId) is not a filing. */
  assert.equal(sessionFiledRule(codexResult({ filed: false, proposalId: 'x.json', scope: 'thread' }), 's1'), null)
  /* A refused call (isError) carries no filed:true and is not a filing. */
  assert.equal(sessionFiledRule(packet('s1', { type: 'tool_result', toolCallId: 'item-1', tool: 'mcpToolCall', payload: { status: 'failed', error: 'Agents may not file standing rules on this computer' } }), 's1'), null)
  /* A command whose OUTPUT happens to print the right JSON is refused by the
     tool's name: prose and printed text are not the engine's word. */
  const printed = packet('s1', { type: 'tool_result', toolCallId: 'c1', tool: 'commandExecution', payload: { status: 'completed', exitCode: 0, aggregatedOutput: JSON.stringify(REPLY) } })
  assert.equal(sessionFiledRule(printed, 's1'), null)
  /* And the agent's prose is never read at all. */
  assert.equal(sessionFiledRule(packet('s1', { type: 'assistant_text', text: `I filed RTH3: ${JSON.stringify(REPLY)}` }), 's1'), null)
})

test('the row is built from the result and the call\'s words, and says who filed it', () => {
  const filed = { ...sessionFiledRule(codexResult(), 's1'), words: WORDS }
  const row = copy.filedRuleChatRow(filed, { at: 1234 })
  assert.equal(row.tool, copy.FILED_RULE_TOOL_LABEL)
  assert.equal(row.stateKey, 'done')
  assert.equal(row.state, 'filed by codex')
  assert.equal(row.at, 1234)
  assert.ok(row.id.startsWith('rule:R3.1:'), 'the row is keyed by the rule id so a repaint replaces it')
  assert.equal(row.detail, row.body, 'the detail is the sentence and the body is the same sentence whole')
  const sentence = row.detail
  assert.ok(sentence.startsWith('Your agent filed R3.1 as a standing rule for this agent, this conversation only: “'), sentence)
  assert.ok(sentence.includes('— filed by codex.'), sentence)
  assert.ok(sentence.endsWith(' It is in your rules; edit or delete it by hand.'), sentence)
  /* The quote is the first stretch of the words, ellipsised at the cap. */
  assert.ok(sentence.includes(`“${WORDS.slice(0, copy.FILED_RULE_WORDS_MAX).trimEnd()}…”`), sentence)
  assert.ok(!sentence.includes(WORDS), 'the whole remark rode the row; only the first stretch may')
  /* No key, no path, no session id in the sentence. */
  assert.ok(!sentence.includes('node-7'), 'the scope key reached the screen')
  assert.ok(!sentence.includes('s1'), 'the session id reached the screen')
})

test('short words are quoted whole, and a result with no words still makes a row', () => {
  const short = copy.filedRuleSentence({ id: 'R2010', appliesTo: 'every agent', filedBy: 'claude', words: 'Keep it short.' })
  assert.ok(short.includes('“Keep it short.”'), short)
  assert.ok(!short.includes('…'), 'a short remark must not be ellipsised')
  const bare = copy.filedRuleSentence({ id: 'R2010', scope: 'global', filedBy: 'claude' })
  assert.equal(bare, 'Your agent filed R2010 as a standing rule for every agent — filed by claude. It is in your rules; edit or delete it by hand.')
  const nobody = copy.filedRuleSentence({ id: 'RS2', appliesTo: 'this session and everything it spawns' })
  assert.equal(nobody, 'Your agent filed RS2 as a standing rule for this session and everything it spawns. It is in your rules; edit or delete it by hand.')
  assert.equal(copy.filedRuleState({}), 'filed')
})

test('the rules panel names the agent that filed an entry, and only then', () => {
  const body = { innerHTML: '', querySelector: () => null }
  const panel = createStandingRequestsPanel(body)
  panel.show({ groups: [{ entries: [{ id: 'RTH2', words: 'Filed by an agent.', filedBy: 'codex' }] }] })
  assert.ok(body.innerHTML.includes('filed by your agent codex'), 'the panel does not name the agent that filed an entry')
  const stub = () => ({
    readLedger: (scope, key) => ({
      scope, key, path: 'C:/somewhere/state/r-ledger/thread-node-7.md', exists: true, warnings: [],
      entries: [
        { id: 'RTH1', words: 'Typed by the person.', filedBy: null, number: 1, stamp: 's', line: 1 },
        { id: 'RTH2', words: 'Filed by an agent.', filedBy: 'codex', number: 2, stamp: 's', line: 4 },
      ],
    }),
  })
  const answer = readStandingRequests({ scope: 'thread', key: 'node-7', loadModule: stub })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.entries, [
    { id: 'RTH1', words: 'Typed by the person.' },
    { id: 'RTH2', words: 'Filed by an agent.', filedBy: 'codex' },
  ])
  assert.equal(JSON.stringify(answer).includes('C:/somewhere'), false, 'the reply must not carry the ledger path')
})

test('the view pairs the actual call and result, draws its receipt and refreshes the mounted rules without losing an edit', () => {
  const view = readFileSync(path.join(ROOT, 'src', 'views', 'computers.js'), 'utf8')
  assert.match(view, /import \{ filedRuleChatRow \} from '\.\.\/filed-rule-copy\.js'/, 'the view does not import the copy module')
  assert.match(view, /sessionFiledRule, sessionMessageBoundary, sessionRuleFilingCall/, 'the view does not import both readers')
  const start = view.indexOf('const ruleCall = sessionRuleFilingCall(packet, sessionId)')
  const handler = view.slice(view.lastIndexOf('const receivedAt = Date.now()', start), view.indexOf('const activity = sessionActivityEvent(packet, sessionId)', start))
  assert.ok(handler.length > 0, 'the filed-rule branch is where this test expects it, ahead of the action rows')
  const declarations = ['rememberRuleCall', 'takeRuleCall', 'refreshStandingRequests']
    .map(name => declaredFunctionSource(view, name)).join('\n')
  const limit = /^\s*const RULE_CALLS_MAX = (\d+)\s*$/m.exec(view)
  assert.ok(limit, 'the pairing retention bound must come from the maintained source')
  for (const [call, result] of [[codexCall, codexResult], [claudeCall, claudeResult]]) {
    const node = { id: 'node-7' }, slot = {}, actions = [], mounts = []
    const scope = {
      sessionRuleFilingCall, sessionFiledRule, filedRuleChatRow: copy.filedRuleChatRow,
      sessionRuleCalls: new Map(), RULE_CALLS_MAX: Number(limit[1]), currentRailTreeNode: node,
      treeStore: { getNode: id => id === node.id ? node : null },
      controlsPage: { querySelector: selector => { assert.equal(selector, '[data-requests-slot]'); return slot } },
      mountStandingRequests: (...args) => mounts.push(args),
      broadcastAction: (...args) => actions.push(args),
    }
    const api = new Function(...Object.keys(scope), `${declarations}; return {
      receive(packet, sessionId) { ${handler} }, setRail(value) { currentRailTreeNode = value }
    }`)(...Object.values(scope))
    api.receive(call(), 's1')
    assert.equal(actions.length, 0, 'a tool call alone must not claim a rule was filed')
    assert.equal(mounts.length, 0)
    api.receive(result(), 'other-session')
    assert.equal(actions.length, 0, 'another session must not consume this session\'s call')
    api.receive(result(), 's1')
    const filed = sessionFiledRule(result(), 's1')
    assert.equal(actions.length, 1)
    assert.equal(actions[0][0], 's1')
    assert.deepEqual(actions[0][1], copy.filedRuleChatRow({ ...filed, words: WORDS }, { at: actions[0][1].at }))
    assert.deepEqual(mounts, [[node, slot, { preserveEditing: true }]])
    assert.equal(scope.sessionRuleCalls.get('s1').size, 0, 'the matching call must be consumed once')
    api.setRail(null)
    api.receive(call(), 's1')
    api.receive(result(), 's1')
    assert.equal(actions.length, 2, 'a closed rail must not hide the filed-rule chat receipt')
    assert.equal(mounts.length, 1, 'a closed rail must not mount a rules panel')
  }
  /* The panel says who filed an entry. Its body is built in
     src/tree-standing-requests.js (the view hands that module the body to
     paint, so node can drive the panel's presses), and that is where the
     author is named. */
  assert.match(view, /standingRequestsPanelFor\(body/, 'the view no longer paints the panel through the shared module')
})

test('the single-agent page wires the same call, result and row', () => {
  /* src/views/agent.js imports a stylesheet too, so it is pinned by source
     the same way. It paints no other tool rows, which is why an agent filing
     a rule from that page used to do so unseen; the row is the ONE row the
     tree chat draws, from the SAME two readers, and the words are paired with
     the result by toolCallId exactly as computers.js pairs them. */
  const view = readFileSync(path.join(ROOT, 'src', 'views', 'agent.js'), 'utf8')
  assert.match(view, /import \{ filedRuleChatRow \} from '\.\.\/filed-rule-copy\.js'/, 'the agent page does not import the copy module')
  assert.match(view, /sessionFiledRule, sessionMessageBoundary, sessionRuleFilingCall/, 'the agent page does not import both readers')
  const handler = view.slice(view.indexOf('const ruleCall = sessionRuleFilingCall(packet, chatSessionId)'), view.indexOf('const text = sessionEventText(packet, chatSessionId)'))
  assert.ok(handler.length > 0, 'the filed-rule branch is where this test expects it, ahead of the words')
  assert.match(handler, /rememberRuleCall\(ruleCall\)/, 'the call\'s words are not remembered')
  assert.match(handler, /takeRuleCall\(filedRule\.toolCallId\)/, 'the result is not paired with its call')
  assert.match(handler, /chat\.addAction\?\.\(filedRuleChatRow\(/, 'the row is not painted into the page\'s chat')
  /* Ahead of the reply gate: a filing rides a tool_result, which is neither
     words nor a completion, so a listener that returned first on "no reply
     pending" would drop the row whenever the turn had already been answered. */
  const listener = view.slice(view.indexOf('const detachAgentEvents'), view.indexOf('const startOrContinue'))
  const gateAt = listener.indexOf('if (!chatReply) return')
  assert.ok(gateAt !== -1, 'the reply gate this order is measured against is gone')
  assert.ok(listener.indexOf('const filedRule = sessionFiledRule(packet, chatSessionId)') < gateAt, 'the result is read only while a reply is pending')
  assert.ok(listener.indexOf('chat.addAction?.(filedRuleChatRow(') < gateAt, 'the row is painted only while a reply is pending')
})
