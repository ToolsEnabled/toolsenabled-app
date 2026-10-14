/* THE PERSON'S TYPED WORDS SURVIVE THE TURN, OR THE TURN WAS NOT DURABLE.
 *
 * O7, "agents manage the ledgers", the application half. With "Turning
 * something you said into a standing rule" on, the agent decides whether a
 * remark was a rule -- so the remark has to be on disk BEFORE the agent reads
 * it, under the engine's own write-ahead spool (src/lib/owner-capture-spool.js,
 * anchored where src/lib/r-ledger-proposals.js anchors it: state/r-ledger/
 * owner-capture-spool/), and it has to be answered for when the turn ends:
 * moved to reconciled/ carrying the rule id it became, or left pending and
 * marked unfiled with the one fixed reason. Bytes are kept either way; the
 * spool never deletes, and only a decision takes a record out of the queue.
 *
 * Proved here against the confined-engine fixture, whose spool is a verbatim
 * copy of the engine module with a throw hook (MC_TEST_SPOOL_THROW) and a
 * call log, and whose gate takes its mode from MC_TEST_AGENT_FILING:
 *
 *   SPOOLED     a person's turn, with the switch on, lands under the scratch
 *               state root at state/r-ledger/owner-capture-spool/pending/,
 *               verbatim, before the engine is handed the turn.
 *   NOT SPOOLED with the switch off -- and no directory is even created;
 *               for origin 'agent' (a tree message); for the tree brief; for a
 *               turn with no origin at all (an older caller cannot put words
 *               in the spool by forgetting to say).
 *   FAIL OPEN   a spool that throws does not refuse or delay the turn.
 *   SETTLED     turn_completed after an r_ledger.file result with filed:true
 *               reconciles the record under that id; without one, the record
 *               stays PENDING marked unfiled, where the person can still read
 *               and file it, and an engine with no markUnfiled leaves it
 *               plainly pending rather than discarding it.
 *   NAMED       the local-data reset plan names the spool directory.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const FIXTURE_SPOOL = require_(path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/owner-capture-spool.js'))
/* Resolved through its real path: in a worktree node_modules can be a
   junction, and the host refuses a working folder that crosses one. */
const SCRATCH_PARENT = testScratchRoot('.toolsenabled-owner-spool-test')
mkdirSync(SCRATCH_PARENT, { recursive: true })
const TEST_SCRATCH_ROOT = realpathSync.native(SCRATCH_PARENT)
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

/* A turn the PERSON typed. The words are a placeholder, never a real remark:
   no fixture in this repository may carry the owner's words. */
const TYPED = 'Placeholder words a person typed for this test.'

function standardPlan(workdir) {
  return {
    ok: true, tier: 'standard', isolated: true,
    threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly', 'toolsenabled'],
  }
}

async function inWorld({ mode = 'auto', spoolThrows = false } = {}, run) {
  const workdir = testScratch('mc-spool-')
  const stateRoot = path.join(workdir, 'state-root')
  mkdirSync(stateRoot, { recursive: true })
  const previous = {
    root: process.env.MC_TEST_STATE_ROOT,
    mode: process.env.MC_TEST_AGENT_FILING,
    throws: process.env.MC_TEST_SPOOL_THROW,
  }
  process.env.MC_TEST_STATE_ROOT = stateRoot
  process.env.MC_TEST_AGENT_FILING = mode
  if (spoolThrows) process.env.MC_TEST_SPOOL_THROW = '1'
  else delete process.env.MC_TEST_SPOOL_THROW
  FIXTURE_SPOOL.calls.length = 0
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir, confinementPlanner: () => standardPlan(workdir) })
  const spoolDir = path.join(stateRoot, 'state', 'r-ledger', 'owner-capture-spool')
  try {
    return await run({ host, workdir, stateRoot, spoolDir })
  } finally {
    await host.closeAll().catch(() => {})
    for (const [key, name] of [['root', 'MC_TEST_STATE_ROOT'], ['mode', 'MC_TEST_AGENT_FILING'], ['throws', 'MC_TEST_SPOOL_THROW']]) {
      if (previous[key] === undefined) delete process.env[name]
      else process.env[name] = previous[key]
    }
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

function engine() { return require_(CONFINED_ENGINE) }
function lastStart() { return engine().calls.at(-1) }
function listJson(directory) {
  try { return readdirSync(directory).filter(name => name.endsWith('.json')).sort() } catch { return [] }
}
function readRecords(directory) {
  return listJson(directory).map(name => JSON.parse(readFileSync(path.join(directory, name), 'utf8')))
}

async function start(host, sessionId) {
  await host.startSession({ sessionId, requestKeys: { treeAnchors: ['node-7'], threadId: 'node-7' } })
}

test('a person\'s turn with the switch on is spooled verbatim, under this session, before the engine gets it', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    await start(host, 'spool-1')
    const before = engine().adapterCalls.length
    await host.sendTurn({ sessionId: 'spool-1', text: TYPED, origin: 'person' })
    const pending = readRecords(path.join(spoolDir, 'pending'))
    assert.equal(pending.length, 1, 'exactly one record for one typed turn')
    const [record] = pending
    assert.equal(record.text, TYPED, 'the words are stored exactly as typed')
    assert.equal(record.mode, 'ingress')
    assert.equal(record.source, 'product/sendTurn')
    assert.equal(record.scope, 'session')
    assert.equal(record.threadId, 'spool-1', 'the session id is the record\'s key')
    assert.equal(record.ledgerOutcome, 'pending')
    /* ORDER: the spool call precedes the adapter's sendTurn in the fixture's
       own logs -- the words were durable before the engine was asked. */
    assert.equal(FIXTURE_SPOOL.calls[0].method, 'writeAhead')
    assert.equal(engine().adapterCalls.length, before + 1, 'the turn still reached the engine')
    /* THE RECORD NEVER REACHES THE PROMPT. Only the agent's paragraph rides. */
    const sent = engine().adapterCalls[before].request.text
    assert.ok(sent.startsWith(TYPED), 'the person\'s own words lead the turn as always')
    assert.ok(!sent.includes('spooled'), 'no line about the spool rides the turn -- no read tool exists for it')
  })
})

test('with the switch off nothing is written -- not even an empty directory', async () => {
  await inWorld({ mode: 'off' }, async ({ host, spoolDir, stateRoot }) => {
    await start(host, 'off-1')
    await host.sendTurn({ sessionId: 'off-1', text: TYPED, origin: 'person' })
    assert.equal(FIXTURE_SPOOL.calls.length, 0, 'the spool was asked for something with the switch off')
    assert.ok(!existsSync(spoolDir), 'a spool directory appeared with the switch off')
    assert.ok(!existsSync(path.join(stateRoot, 'state', 'r-ledger')) || readdirSync(path.join(stateRoot, 'state', 'r-ledger')).length === 0,
      'the ledger directory was written to with the switch off')
  })
})

test('an agent\'s turn, the tree brief, and an untagged turn are never spooled', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    const end = () => lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    await start(host, 'origins-1')
    /* The brief: the product's address block, tagged person by the window
       because the window sent it -- and still not the person's words. */
    await host.sendTurn({ sessionId: 'origins-1', text: 'Tree address: you are "child", and your manager is "boss"\n\nDo the thing.', origin: 'person' })
    end()
    await host.sendTurn({ sessionId: 'origins-1', text: TYPED, origin: 'agent' })
    end()
    await host.sendTurn({ sessionId: 'origins-1', text: TYPED })
    end()
    await host.sendTurn({ sessionId: 'origins-1', text: TYPED, origin: 'brief' })
    end()
    assert.equal(FIXTURE_SPOOL.calls.length, 0, `the spool was written for a turn that was not the person's: ${JSON.stringify(FIXTURE_SPOOL.calls)}`)
    assert.ok(!existsSync(spoolDir))
  })
})

test('a spool that throws does not refuse or delay the turn', async () => {
  await inWorld({ mode: 'auto', spoolThrows: true }, async ({ host, spoolDir }) => {
    await start(host, 'throws-1')
    const before = engine().adapterCalls.length
    const answer = await host.sendTurn({ sessionId: 'throws-1', text: TYPED, origin: 'person' })
    assert.equal(answer.sessionId, 'throws-1')
    assert.equal(answer.turnId, 't1', 'the turn was refused because the spool threw -- the net stopped the person talking')
    assert.equal(engine().adapterCalls.length, before + 1)
    assert.equal(FIXTURE_SPOOL.calls[0].method, 'writeAhead', 'the spool was at least asked')
    assert.ok(!existsSync(path.join(spoolDir, 'pending')) || listJson(path.join(spoolDir, 'pending')).length === 0)
    /* And the completion does not try to settle a record that was never
       written. */
    lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    assert.ok(!FIXTURE_SPOOL.calls.some(call => call.method !== 'writeAhead'), 'a settle was attempted on a record that does not exist')
  })
})

/* The engine's own event shapes for an MCP call and its result, as
   codex-adapter.js emits them: the tool is named on the CALL's payload and
   the MCP reply rides the RESULT's payload. */
/* Ids are the one canonical ledger's (2026-09-02): R-only for every tier,
   dotted for a refinement. */
function codexFiling(onEvent, { id = 'R3', filedBy = 'codex', toolCallId = 'call-1', tool = 'r_ledger.file' } = {}) {
  onEvent({ type: 'tool_call', threadId: 'thread-1', turnId: 't1', itemId: toolCallId, toolCallId, tool: 'mcpToolCall',
    payload: { server: 'toolsenabled', tool, arguments: { actor: filedBy, scope: 'thread', key: 'node-7', words: TYPED } } })
  const reply = tool === 'r_ledger.propose'
    ? { filed: false, proposalId: id, id, scope: 'thread', key: 'node-7', proposedBy: filedBy, appliesTo: 'this agent, this conversation only', note: 'Filed as a proposal.' }
    : { filed: true, id, scope: 'thread', key: 'node-7', filedBy, stamp: '2026-08-22T00:00:00.000Z', appliesTo: 'this agent, this conversation only', note: 'Filed.' }
  onEvent({ type: 'tool_result', threadId: 'thread-1', turnId: 't1', itemId: toolCallId, toolCallId, tool: 'mcpToolCall',
    payload: { status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(reply, null, 2) }], structuredContent: reply } } })
}

test('turn_completed after a filed:true result reconciles the record under the rule id; bytes kept', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    await start(host, 'settle-1')
    await host.sendTurn({ sessionId: 'settle-1', text: TYPED, origin: 'person' })
    const [pendingName] = listJson(path.join(spoolDir, 'pending'))
    assert.ok(pendingName, 'nothing was spooled to settle')
    codexFiling(lastStart().onEvent, { id: 'R3.1' })
    lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    assert.deepEqual(listJson(path.join(spoolDir, 'pending')), [], 'the record is still pending after the turn ended')
    const [settled] = readRecords(path.join(spoolDir, 'reconciled'))
    assert.ok(settled, 'the record did not move to reconciled/')
    assert.equal(settled.name, pendingName, 'the same record, moved -- never a copy under a new name')
    assert.equal(settled.ledgerOutcome, 'in-ledger')
    assert.equal(settled.ledgerRevision, 'R3.1', 'the record carries the id it became -- a dotted refinement is an id')
    assert.equal(settled.text, TYPED, 'the bytes are kept')
    const settle = FIXTURE_SPOOL.calls.find(call => call.method === 'markReconciled')
    assert.ok(settle && settle.revision === 'R3.1')
  })
})

/* A PROPOSAL IS A RECORD TOO (one canonical ledger, 2026-09-02). r_ledger.propose
   files a record with status 'proposed' that waits for the person on the
   Ledger page, so a turn that became one settles under its id -- it was not
   "read and filed nothing". */
test('turn_completed after an r_ledger.propose result reconciles the record under the proposal id', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    await start(host, 'settle-propose')
    await host.sendTurn({ sessionId: 'settle-propose', text: TYPED, origin: 'person' })
    codexFiling(lastStart().onEvent, { id: 'R4', tool: 'r_ledger.propose' })
    lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    assert.deepEqual(listJson(path.join(spoolDir, 'pending')), [])
    const [settled] = readRecords(path.join(spoolDir, 'reconciled'))
    assert.ok(settled, 'the record did not move to reconciled/')
    assert.equal(settled.ledgerOutcome, 'in-ledger')
    assert.equal(settled.ledgerRevision, 'R4', 'a proposal settles the turn under the record it became')
    assert.ok(!FIXTURE_SPOOL.calls.some(call => call.method === 'markDiscarded'), 'a proposal was discarded as "filed nothing"')
  })
})

test('a retired per-scope id in a result is not a filing', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    await start(host, 'settle-retired')
    await host.sendTurn({ sessionId: 'settle-retired', text: TYPED, origin: 'person' })
    codexFiling(lastStart().onEvent, { id: 'RTH3' })
    lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    assert.deepEqual(listJson(path.join(spoolDir, 'reconciled')), [],
      'an id the one ledger cannot mint reconciled a record')
    const [pending] = readRecords(path.join(spoolDir, 'pending'))
    assert.ok(pending)
    assert.equal(pending.ledgerOutcome, 'unfiled', 'the turn filed nothing the ledger recognises, so it is still waiting')
  })
})

/* MEASURED 2026-09-03 on the owner's install: 228 of 231 settled records read
   ledgerOutcome 'discarded', reason "agent read it and filed nothing", decided
   by an agent -- the ledger held one request. This host was writing the
   PERSON'S verdict for them and taking the record out of pending/, the only
   queue owner-spool-review and the reconciler can reach. A turn that ended with
   nothing filed decides nothing, so it settles nothing. */
test('turn_completed with no filing leaves the record pending, marked unfiled with the one reason', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    await start(host, 'settle-2')
    await host.sendTurn({ sessionId: 'settle-2', text: TYPED, origin: 'person' })
    const [spooledName] = listJson(path.join(spoolDir, 'pending'))
    /* An unrelated tool result during the turn is not a filing. */
    lastStart().onEvent({ type: 'tool_call', threadId: 'thread-1', turnId: 't1', itemId: 'c9', toolCallId: 'c9', tool: 'commandExecution', payload: { command: 'node --version' } })
    lastStart().onEvent({ type: 'tool_result', threadId: 'thread-1', turnId: 't1', itemId: 'c9', toolCallId: 'c9', tool: 'commandExecution', payload: { status: 'completed', exitCode: 0, aggregatedOutput: '{"filed":true,"id":"R2001"}' } })
    lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
    const pending = readRecords(path.join(spoolDir, 'pending'))
    assert.equal(pending.length, 1, 'the person\'s unfiled request left the queue that can still reach it')
    assert.equal(pending[0].name, spooledName, 'the same record, annotated where it stands')
    assert.equal(pending[0].ledgerOutcome, 'unfiled')
    assert.equal(pending[0].unfiledReason, 'agent read it and filed nothing')
    assert.equal(pending[0].unfiledBy, 'codex', 'the record names who was reading when nothing was filed')
    assert.equal(pending[0].text, TYPED, 'the note keeps the bytes')
    assert.deepEqual(listJson(path.join(spoolDir, 'reconciled')), [], 'nothing was settled: nobody decided anything')
    const settle = FIXTURE_SPOOL.calls.find(call => call.method === 'markUnfiled')
    assert.ok(settle && settle.reason === 'agent read it and filed nothing')
    assert.ok(!FIXTURE_SPOOL.calls.some(call => call.method === 'markDiscarded'),
      'an agent that filed nothing recorded the person\'s discard for them')
    assert.ok(!FIXTURE_SPOOL.calls.some(call => call.method === 'markReconciled'),
      'a command that merely printed the right words reconciled the record')

    /* The next person's turn starts a fresh record, and the unfiled one keeps
       its place in the queue rather than being re-dated or replaced. */
    await host.sendTurn({ sessionId: 'settle-2', text: TYPED, origin: 'person' })
    const both = readRecords(path.join(spoolDir, 'pending'))
    assert.equal(both.length, 2)
    assert.equal(both.filter(record => record.ledgerOutcome === 'unfiled').length, 1)
    assert.equal(both.filter(record => record.ledgerOutcome === 'pending').length, 1)
  })
})

/* The spool now refuses a discard that cannot say a person decided, so an
   engine payload old enough to have no markUnfiled must leave the record
   plainly pending -- never reach for markDiscarded and never throw the turn. */
test('an engine payload without markUnfiled leaves the record pending rather than discarding it', async () => {
  const saved = FIXTURE_SPOOL.markUnfiled
  delete FIXTURE_SPOOL.markUnfiled
  try {
    await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
      await start(host, 'settle-old')
      await host.sendTurn({ sessionId: 'settle-old', text: TYPED, origin: 'person' })
      lastStart().onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
      const pending = readRecords(path.join(spoolDir, 'pending'))
      assert.equal(pending.length, 1, 'the words left the queue on an engine that cannot mark them')
      assert.equal(pending[0].ledgerOutcome, 'pending', 'the record is untouched, not settled')
      assert.deepEqual(listJson(path.join(spoolDir, 'reconciled')), [])
      assert.ok(!FIXTURE_SPOOL.calls.some(call => call.method === 'markDiscarded'),
        'the host fell back to recording the person\'s discard for them')
    })
  } finally {
    FIXTURE_SPOOL.markUnfiled = saved
  }
})

test('the Claude CLI\'s shape settles the same way: named call, text-block result', async () => {
  await inWorld({ mode: 'auto' }, async ({ host, spoolDir }) => {
    await start(host, 'claude-1')
    await host.sendTurn({ sessionId: 'claude-1', text: TYPED, origin: 'person' })
    const onEvent = lastStart().onEvent
    const reply = { filed: true, id: 'R2007', scope: 'global', key: null, filedBy: 'claude', stamp: 's', appliesTo: 'every agent', note: 'Filed.' }
    onEvent({ type: 'tool_call', threadId: 'thread-1', turnId: 't1', toolCallId: 'toolu_1', tool: 'mcp__toolsenabled__r_ledger_file', payload: { actor: 'claude', scope: 'global', words: TYPED } })
    onEvent({ type: 'tool_result', threadId: 'thread-1', turnId: 't1', toolCallId: 'toolu_1', payload: [{ type: 'text', text: JSON.stringify(reply) }], status: 'ok' })
    onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'success' })
    const [settled] = readRecords(path.join(spoolDir, 'reconciled'))
    assert.ok(settled && settled.ledgerOutcome === 'in-ledger' && settled.ledgerRevision === 'R2007')
  })
})

test('the local-data reset plan names the spool directory when it exists', () => {
  const { planReset } = require_(path.join(ROOT, 'shell/local-data-reset.cjs'))
  const root = testScratch('mc-spool-reset-')
  try {
    const userData = path.join(root, 'ToolsEnabledUserData')
    const spool = path.join(userData, 'capability', 'state', 'r-ledger', 'owner-capture-spool', 'pending')
    mkdirSync(spool, { recursive: true })
    writeFileSync(path.join(spool, 'x.json'), '{}', 'utf8')
    const services = path.join(root, 'services')
    mkdirSync(services, { recursive: true })
    const plan = planReset({ userDataDir: userData, servicesRoot: services, env: { LOCALAPPDATA: path.join(root, 'elsewhere') }, homedir: () => path.join(root, 'home') })
    const user = plan.roots.find(entry => entry.kind === 'user-data')
    assert.ok(user && user.guarded, 'the scratch user-data root was refused')
    const named = user.named.map(entry => entry.rel.split(path.sep).join('/'))
    assert.ok(named.includes('capability/state/r-ledger/owner-capture-spool'),
      `the plan must name the spool directory so the person knows it goes: ${JSON.stringify(named)}`)
    assert.ok(user.files >= 1, 'the sweep measures the spool\'s files')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

/* THE SOURCE PIN: the person's words never enter a log line or a prompt from
   the host. The spool helper is the only place the text is handled, and it
   hands it to writeAhead and nothing else. */
test('the host never logs or prompts the spooled words', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'agent-host.cjs'), 'utf8')
  const helper = source.slice(source.indexOf('function spoolPersonTurn'), source.indexOf('function noteRuleFiling'))
  assert.ok(helper.length > 0, 'spoolPersonTurn is where this test expects it')
  assert.ok(!/console\./.test(helper), 'the spool helper logs')
  assert.ok(!/emitWarning/.test(helper), 'the spool helper warns with the words in reach')
  assert.ok(!/emit\(/.test(helper), 'the spool helper emits an event')
  assert.match(helper, /mode: OWNER_TURN_SPOOL_MODE/, 'the record mode is not the ingress mode')
  assert.match(helper, /source: OWNER_TURN_SPOOL_SOURCE/, 'the record source is not product/sendTurn')
})
