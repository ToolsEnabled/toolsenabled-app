/* An assistant on the tree hands work to a new circle beside it.
 *
 * The order is the safety property, so it is what these drive: a parent that is
 * not bound or not running cannot become one; an unknown role or tier is
 * refused before anything is drawn; the store's own placement sentence is the
 * one the person reads; the circle is on the canvas BEFORE its session starts;
 * and a failed start leaves the circle standing rather than tidying away the
 * evidence.
 *
 * The most important assertion in this file is the one that says the launch is
 * DELEGATED: the seam calls the view's own startDraftNode, the same function
 * the person's Start button calls, so a circle made by an assistant and one
 * made by hand cannot drift apart. */
import test from 'node:test'
import assert from 'node:assert/strict'

import { executeCreateAndStartNode } from '../../src/create-and-start-node.js'
import { createFleetTreeStore, FLEET_TREE_LIMITS } from '../../src/fleet-trees.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

const COMMAND = Object.freeze({
  action: 'create-and-start-node',
  computerId: 'this-computer',
  parentSessionId: 'chat-parent-1',
  role: 'worker',
  tier: 'claude-sonnet',
  brief: 'Carry out one bounded piece of work and report the evidence.',
})

/* A tree with one running parent, and a store that mints ids the way the real
   one does: the caller never chooses them. */
function fixture({ parentStatus = 'running', parentSessionId = null, addNode = null, startResult = { ok: true } } = {}) {
  let minted = 0
  const nodes = new Map([['node-1-parent', { id: 'node-1-parent', treeId: 'tree-1', status: parentStatus, parentId: null, ...(parentSessionId ? { sessionId: parentSessionId } : {}) }]])
  const calls = { added: [], started: [], refreshed: 0, notes: [], statusNotes: [] }
  const treeStore = {
    getNode: id => nodes.get(id) || null,
    addNode: addNode || (fields => {
      calls.added.push(fields)
      minted += 1
      const node = { id: `node-${minted + 1}-child`, treeId: 'tree-1', status: 'draft', parentId: fields.parentId, role: fields.role }
      nodes.set(node.id, node)
      return { ok: true, node, tree: { id: 'tree-1' } }
    }),
    setNodeStatus: (id, status, options = {}) => {
      calls.statusNotes.push({ id, status, note: options.note })
      const existing = nodes.get(id)
      if (existing) nodes.set(id, { ...existing, status, statusNote: options.note })
      return { ok: true }
    },
  }
  return {
    calls,
    nodes,
    args: {
      command: COMMAND,
      treeStore,
      sessionNodeIds: new Map([['chat-parent-1', 'node-1-parent']]),
      sessionThreadIds: new Map([['chat-child-1', 'thread-child-1']]),
      roleRecordFor: role => (['worker', 'manager'].includes(role) ? { id: role } : null),
      launchTiers: [{ id: 'claude-sonnet' }, { id: 'claude-opus' }],
      startDraftNode: async (node, options) => {
        calls.started.push({ node, options, refreshedFirst: calls.refreshed })
        if (startResult.ok) {
          const live = { ...nodes.get(node.id), status: 'running', sessionId: 'chat-child-1' }
          nodes.set(node.id, live)
        }
        return startResult
      },
      treeNodeName: node => (node && node.status === 'running' ? 'Worker 1' : 'draft'),
      refreshTree: () => { calls.refreshed += 1 },
      noteStoreRefusal: sentence => calls.notes.push(sentence),
    },
  }
}

test('a reserved identity mismatch cannot start a different circle', async () => {
  const { args, calls } = fixture()
  const answer = await executeCreateAndStartNode({ ...args, command: { ...COMMAND,
    reservedNodeId: 'node-reserved-expected', delegationToken: 'opaque-start-token' } })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'TREE_DELEGATION_REFUSED')
  assert.equal(calls.added[0].reservedNodeId, 'node-reserved-expected')
  assert.equal(calls.started.length, 0)
})

test('the reserved identity and opaque authority reference reach the ordinary start path', async () => {
  const { args, calls } = fixture()
  const answer = await executeCreateAndStartNode({ ...args, command: { ...COMMAND,
    reservedNodeId: 'node-2-child', delegationToken: 'opaque-start-token' } })
  assert.equal(answer.ok, true)
  assert.equal(calls.started[0].options.delegationToken, 'opaque-start-token')
})

test('host launchSettings receipt is forwarded unchanged and omitted when absent', async () => {
  const receipt = { schemaVersion: 1, sessionId: 'host-session', threadId: null, provider: 'codex', model: 'gpt-test', effort: null, source: 'host-launch-configuration' }
  for (const [startResult, expected] of [
    [{ ok: true, sessionId: 'chat-child-1', launchSettings: receipt }, receipt],
    [{ ok: true, sessionId: 'chat-child-1', launchSettings: null }, null],
    [{ ok: true, sessionId: 'chat-child-1' }, undefined],
  ]) {
    const { args } = fixture({ startResult })
    const answer = await executeCreateAndStartNode(args)
    if (expected === undefined) assert.equal(Object.hasOwn(answer, 'launchSettings'), false)
    else assert.strictEqual(answer.launchSettings, expected)
  }
})
test('a circle is added under the parent, drawn, then started, and its id and name come back', async () => {
  const { args, calls } = fixture()
  const answer = await executeCreateAndStartNode(args)
  assert.deepEqual(answer, {
    ok: true,
    code: null,
    nodeId: 'node-2-child',
    sessionId: 'chat-child-1',
    threadId: 'thread-child-1',
    displayName: 'Worker 1',
  })
  assert.deepEqual(calls.added, [{
    /* madeByAgent is recorded HERE because here is where it is true, and the
       owner's removal rule reads it later: "agents that were spawned by agents
       AND who the user hasnt prompted - THEY can be removed by parent agents".
       Nothing on the removal path gets to claim it. */
    madeByAgent: true,
    parentId: 'node-1-parent',
    role: 'worker',
    message: COMMAND.brief,
    tier: 'claude-sonnet',
    effort: '',
  }], 'the brief opens the circle, the parent is the circle that asked, and it is marked agent-made')
  assert.equal(calls.started.length, 1)
  assert.equal(calls.started[0].refreshedFirst, 1, 'the circle is on the canvas before its session is started')
  assert.deepEqual(calls.started[0].options, { effort: null, closePanel: false })
})

test('a roleless circle is handed to the same start path and is not refused by the spawn gate', async () => {
  const { args, calls } = fixture({})
  const answer = await executeCreateAndStartNode({
    ...args,
    command: { ...COMMAND, role: '' },
  })
  assert.equal(answer.ok, true)
  assert.equal(calls.added[0].role, '')
  assert.equal(calls.started.length, 1)
})

/* Anonymous success was the silent form of this defect: a parent saw `ok`, but
 * the new circle could never delegate. The view now refuses before it opens
 * that session. Keep a defensive check here too, because this is the last hop
 * before agent.spawn receives an answer. */
test('an anonymous start is refused instead of being reported to its parent as a successful circle', async () => {
  const { args, calls } = fixture({ startResult: { ok: true, anonymous: true, reason: '"Worker 1" is starting without a declared identity, so it can talk and work but cannot start or change assistants under it.' } })
  const answer = await executeCreateAndStartNode(args)
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'MC_TREE_COMMAND_START_FAILED')
  assert.equal(answer.reason, '"Worker 1" is starting without a declared identity, so it can talk and work but cannot start or change assistants under it.')
  assert.deepEqual(calls.statusNotes, [], 'the hand-off must not turn an anonymous launch into a successful status note')
})

test('a circle that got a real seat carries no statusNote, and nothing is written to its note', async () => {
  const { args, calls } = fixture()
  const answer = await executeCreateAndStartNode(args)
  assert.equal('statusNote' in answer, false, 'an ordinary spawn never grows a new field')
  assert.deepEqual(calls.statusNotes, [])
})

test('the launch is delegated to the view\'s own start, never reimplemented here', async () => {
  const { args, calls } = fixture()
  await executeCreateAndStartNode(args)
  assert.equal(calls.started[0].node.id, 'node-2-child',
    'startDraftNode receives the created node, so the seat, role binding, model and tree address all come from the one launch path the person\'s own Start button uses')
})

test('the parent is resolved from the session, and a session that is not bound to a circle cannot be a parent', async () => {
  const { args } = fixture()
  const answer = await executeCreateAndStartNode({ ...args, sessionNodeIds: new Map() })
  assert.deepEqual(answer, { ok: false, code: 'MC_TREE_SPAWN_PARENT_NOT_BOUND', nodeId: null, sessionId: null, threadId: null })
})

test('a parent that is not running cannot hand work down', async () => {
  for (const status of ['draft', 'finished', 'failed', 'interrupted']) {
    const { args, calls } = fixture({ parentStatus: status })
    const answer = await executeCreateAndStartNode(args)
    assert.equal(answer.code, 'MC_TREE_SPAWN_PARENT_NOT_RUNNING', status)
    assert.equal(calls.added.length, 0, 'nothing is drawn for a parent that is not there')
  }
  for (const status of ['running', 'starting']) {
    const { args } = fixture({ parentStatus: status })
    assert.equal((await executeCreateAndStartNode(args)).ok, true, status)
  }
})

test('a working circle wearing a stale label can still hand work down', async () => {
  /* MEASURED 2026-09-03 on the owner's own fleet: all nine circles read
     'finished' on the tree while their sessions were heartbeating and their
     agents were working. Eight spawns were refused across twenty-three minutes
     and the Controller reported "delegation is currently impossible".

     The status field is the view's bookkeeping and it is set to 'finished' on
     every turn completion; a turn started by the shell's tree pump completes
     with nothing setting it back. The session ASKING is alive by construction,
     because the application resolves it from the live call. */
  for (const status of ['finished', 'failed', 'interrupted']) {
    const { args } = fixture({ parentStatus: status, parentSessionId: COMMAND.parentSessionId })
    const answer = await executeCreateAndStartNode(args)
    assert.equal(answer.ok, true, `${status}: the circle asking is the proof it is running`)
  }

  /* A draft has never run, so it has no session and is still refused -- the
     case the status gate was written for is untouched. */
  const draft = fixture({ parentStatus: 'draft' })
  assert.equal((await executeCreateAndStartNode(draft.args)).code, 'MC_TREE_SPAWN_PARENT_NOT_RUNNING')

  /* And a finished circle whose session is some OTHER session is still refused:
     the rule is "this session is asking", not "any session exists". */
  const other = fixture({ parentStatus: 'finished', parentSessionId: 'chat-somebody-else' })
  assert.equal((await executeCreateAndStartNode(other.args)).code, 'MC_TREE_SPAWN_PARENT_NOT_RUNNING')
})

test('an unknown role or tier is refused before anything is drawn', async () => {
  const unknownRole = fixture()
  assert.equal((await executeCreateAndStartNode({ ...unknownRole.args, command: { ...COMMAND, role: 'overseer' } })).code, 'MC_TREE_SPAWN_ROLE_UNKNOWN')
  assert.equal(unknownRole.calls.added.length, 0)

  const unknownTier = fixture()
  assert.equal((await executeCreateAndStartNode({ ...unknownTier.args, command: { ...COMMAND, tier: 'claude-fable' } })).code, 'MC_TREE_SPAWN_TIER_UNKNOWN')
  assert.equal(unknownTier.calls.added.length, 0)
})

test('the store\'s own refusal sentence is what the person is shown', async () => {
  const { args, calls } = fixture({
    addNode: () => ({ ok: false, problems: ['This agent already has four agents under it. Add the next one somewhere else.'] }),
  })
  const answer = await executeCreateAndStartNode(args)
  assert.equal(answer.code, 'MC_TREE_SPAWN_PLACE_REFUSED')
  assert.equal(answer.nodeId, 'node-1-parent')
  assert.deepEqual(calls.notes, ['This agent already has four agents under it. Add the next one somewhere else.'],
    'the placement rules have one owner, and its words reach the screen unchanged')
})

/* THE FIXTURE ABOVE STUBS addNode, WHICH HIDES THE BUG THIS FILE IS ABOUT.
 *
 * MEASURED 2026-09-03 (REPORT-controller-2-tree-spawn-regression-20260903.md):
 * engine/src/lib/tool-registry.js's MAX_TREE_BRIEF_CHARS accepts an expanded
 * contract up to 12,000 characters -- eighteen real spawns were refused in one
 * evening with contracts of 4,229 to 5,035 characters before that ceiling was
 * raised from 4,000. But src/fleet-trees.js's FLEET_TREE_LIMITS.maxMessageChars,
 * the number the REAL store checks the same brief against when this function's
 * treeStore.addNode call lands it, was left at 4,000: a brief the engine had
 * already accepted was refused a second time, here, with the store's own
 * "Shorten the message" sentence. This test uses the real store instead of the
 * fixture's fake addNode, so a regression that re-splits the two numbers fails
 * here rather than passing every test in this file that never leaves the fake. */
test('a real store accepts a brief past the old 4,000-character ceiling, up to the one the engine actually enforces', async () => {
  let saved = null
  const treeStore = createFleetTreeStore({
    computerId: 'c1',
    // A successful write must be readable by the next mutation's freshness
    // guard. This fixture used to claim success while discarding every save.
    storage: { read: () => saved, write: (_key, value) => { saved = JSON.parse(JSON.stringify(value)); return true } },
    now: () => '2026-09-03T00:00:00.000Z',
    makeId: (kind => {
      let count = 0
      return prefix => { count += 1; return `${prefix}-${count}` }
    })(),
  })
  const tree = treeStore.createTree({ name: 'Ops' })
  const parent = treeStore.addNode({ treeId: tree.tree.id, role: 'manager' })
  assert.equal(treeStore.attachSession(parent.node.id, COMMAND.parentSessionId).ok, true)

  const longBrief = 'x'.repeat(5000)
  assert.ok(longBrief.length > 4000 && longBrief.length <= FLEET_TREE_LIMITS.maxMessageChars,
    'this length is only a meaningful regression check while it sits between the old ceiling and the real one')

  const answer = await executeCreateAndStartNode({
    command: { ...COMMAND, brief: longBrief },
    treeStore,
    sessionNodeIds: new Map([[COMMAND.parentSessionId, parent.node.id]]),
    roleRecordFor: role => (role === 'worker' ? { id: role } : null),
    launchTiers: [{ id: 'claude-sonnet' }],
    startDraftNode: async node => {
      assert.equal(treeStore.attachSession(node.id, 'chat-child-1').ok, true)
      return { ok: true, sessionId: 'chat-child-1' }
    },
  })
  assert.equal(answer.ok, true,
    `a ${longBrief.length}-character brief must be accepted: it is inside the engine's own MAX_TREE_BRIEF_CHARS`)
  assert.equal(treeStore.getNode(answer.nodeId).message, longBrief, 'the full brief is what the store kept, not a truncation')

  const tooLong = 'x'.repeat(FLEET_TREE_LIMITS.maxMessageChars + 1)
  const refused = await executeCreateAndStartNode({
    command: { ...COMMAND, brief: tooLong },
    treeStore,
    sessionNodeIds: new Map([[COMMAND.parentSessionId, parent.node.id]]),
    roleRecordFor: role => (role === 'worker' ? { id: role } : null),
    launchTiers: [{ id: 'claude-sonnet' }],
    startDraftNode: async () => ({ ok: true, sessionId: 'chat-child-2' }),
  })
  assert.equal(refused.code, 'MC_TREE_SPAWN_PLACE_REFUSED', 'the real ceiling still refuses something past it -- this is not a widened bound, it is the SAME bound stated once')
})

test('a store that throws is a refusal, not a crash mid-spawn', async () => {
  const { args, calls } = fixture({ addNode: () => { throw new Error('the saved tree could not be read') } })
  const answer = await executeCreateAndStartNode(args)
  assert.equal(answer.code, 'MC_TREE_SPAWN_PLACE_REFUSED')
  assert.deepEqual(calls.notes, ['the saved tree could not be read'])
})

test('a start that fails leaves the circle standing, and says the start failed', async () => {
  const { args, calls } = fixture({ startResult: { ok: false, code: 'MC_AGENT_SESSION_LIMIT' } })
  const answer = await executeCreateAndStartNode(args)
  assert.deepEqual(answer, { ok: false, code: 'MC_TREE_COMMAND_START_FAILED', nodeId: 'node-2-child', sessionId: null, threadId: null })
  assert.equal(calls.added.length, 1, 'the circle was added and is not removed: the person can read why it failed')
})

test('a start that throws is refused with the same code rather than escaping', async () => {
  const { args } = fixture()
  const answer = await executeCreateAndStartNode({ ...args, startDraftNode: async () => { throw new Error('bridge gone') } })
  assert.equal(answer.code, 'MC_TREE_COMMAND_START_FAILED')
  assert.equal(answer.reason, 'bridge gone')
})

/* THE SENTENCE THE PERSON WAS SHOWN IS THE SENTENCE THE ASSISTANT IS TOLD.
   startDraftNode returns its refusal as `message` -- the same words it put on
   the org-status line and the circle's own note. This result used to carry
   the code alone; the assistant read "(MC_TREE_COMMAND_START_FAILED)" and
   nothing else about a start it could see nothing of. */
test('a start refusal carries the start\'s own sentence as its reason', async () => {
  const { args } = fixture({ startResult: { ok: false, message: 'No launcher for that tier on this computer.' } })
  const answer = await executeCreateAndStartNode(args)
  assert.equal(answer.code, 'MC_TREE_COMMAND_START_FAILED')
  assert.equal(answer.reason, 'No launcher for that tier on this computer.')
})

test('a placement refusal carries the store\'s own sentence as its reason, whether the store refused or threw', async () => {
  const refusedBy = await executeCreateAndStartNode(fixture({
    addNode: () => ({ ok: false, problems: ['That circle already has as many circles under it as the tree allows.'] }),
  }).args)
  assert.equal(refusedBy.code, 'MC_TREE_SPAWN_PLACE_REFUSED')
  assert.equal(refusedBy.reason, 'That circle already has as many circles under it as the tree allows.')

  const threwBy = await executeCreateAndStartNode(fixture({ addNode: () => { throw new Error('the saved tree could not be read') } }).args)
  assert.equal(threwBy.code, 'MC_TREE_SPAWN_PLACE_REFUSED')
  assert.equal(threwBy.reason, 'the saved tree could not be read')
})

test('a refusal with no sentence to give carries no reason key at all', async () => {
  const { args } = fixture({ startResult: { ok: false, code: 'MC_AGENT_SESSION_LIMIT' } })
  const answer = await executeCreateAndStartNode(args)
  assert.equal(Object.prototype.hasOwnProperty.call(answer, 'reason'), false)
})

test('a view with no tree open refuses rather than pretending', async () => {
  const { args } = fixture()
  for (const missing of [{ treeStore: null }, { sessionNodeIds: null }, { startDraftNode: null }, { command: null }]) {
    const answer = await executeCreateAndStartNode({ ...args, ...missing })
    assert.equal(answer.code, 'MC_TREE_SPAWN_TREE_NOT_OPEN', JSON.stringify(Object.keys(missing)))
  }
})

test('with no namer, the new circle comes back unnamed rather than wearing its id', async () => {
  /* `displayName` is spoken back to the assistant that asked for the circle
     and lands in a transcript a person reads. The seam's default used to
     answer node.id, so a caller that forgot to hand one in would put
     node-2-child under the words "the name the person sees on the circle" --
     a name nobody sees and nobody can say. null is this field's own word for
     "not named", and the caller already has to handle it. */
  const { args } = fixture()
  const { treeNodeName, ...withoutNamer } = args
  assert.equal(typeof treeNodeName, 'function', 'the fixture stopped handing a namer in, so this proves nothing')
  const answer = await executeCreateAndStartNode(withoutNamer)
  assert.equal(answer.ok, true)
  assert.equal(answer.nodeId, 'node-2-child', 'the id still comes back on its own field, where a caller can use it')
  assert.equal(answer.displayName, null, 'an unnameable circle was handed back wearing its id as a name')

  /* And a namer with nothing to say is the same answer. */
  const blank = await executeCreateAndStartNode({ ...args, treeNodeName: () => '' })
  assert.equal(blank.displayName, null)
})

/* THE DEPTH, PROVIDER AND MODEL AN ASSISTANT CHOSE WHEN IT ASKED FOR A CIRCLE.
 *
 * Owner, 2026-09-19: "you NEED to be able to select effort level when you spawn
 * agents". Measured the same morning: this seam wrote `effort: ''` on every
 * circle it added and passed `effort: null` into the start, so a spawn that
 * named a depth produced a circle running at its model's default and said
 * nothing about it.
 *
 * These drive the REAL tier table rather than the fixture's two-id stand-in.
 * A test whose own launchTiers invented a provider column would pass against a
 * product table that no longer has one. */
test('the depth an assistant chose is written on the circle and carried into its start', async () => {
  /* CLAUDE TIERS FIRST, BECAUSE THEY ARE THE COMMON CASE and because they are
     the ones an earlier version of this seam refused: it keyed on the tier
     row's `effort` column, which every claude row leaves null because that
     column is the tier's DEFAULT depth, not its allowed set. The owner's own
     managers run claude-opus at xhigh and his builders claude-opus at medium. */
  const claude = LAUNCH_TIERS.find(tier => tier.provider === 'claude')
  const codex = LAUNCH_TIERS.find(tier => tier.provider === 'codex')
  assert.ok(claude && codex, 'the tier table no longer offers both providers, so this proves nothing')
  assert.equal(claude.effort, null, 'a claude row carries no default depth, which is exactly what must not be read as "no depth allowed"')

  for (const [tier, effort] of [[claude.id, 'xhigh'], [claude.id, 'medium'], [codex.id, 'xhigh']]) {
    const { args, calls } = fixture()
    const answer = await executeCreateAndStartNode({
      ...args,
      launchTiers: LAUNCH_TIERS,
      command: { ...COMMAND, tier, effort },
    })
    assert.equal(answer.ok, true, `${tier}/${effort}`)
    assert.equal(calls.added[0].effort, effort,
      `${tier}: the depth is on the node, so a later Start from the tree - which has no panel to carry an override - still uses it`)
    assert.equal(calls.started[0].options.effort, effort,
      `${tier}: and it is carried into this immediate start, which is the one that actually opens the session`)
  }

  /* Choosing nothing still means the model decides, exactly as before: the
     empty string is this field's own word for "not set", and the start is
     handed null rather than a depth this seam invented. */
  const unchosen = fixture()
  await executeCreateAndStartNode({ ...unchosen.args, launchTiers: LAUNCH_TIERS, command: { ...COMMAND, tier: claude.id } })
  assert.equal(unchosen.calls.added[0].effort, '')
  assert.equal(unchosen.calls.started[0].options.effort, null)
})

test('a depth, provider or model that contradicts the chosen model refuses before a circle is drawn', async () => {
  const codex = LAUNCH_TIERS.find(tier => tier.provider === 'codex')
  /* `local` is the one provider whose launcher carries no thinking depth at
     all: shell/agent-host.cjs has a branch for codex, one for claude and one
     for acp/antigravity, and none for local. */
  const noDepth = LAUNCH_TIERS.find(tier => tier.provider === 'local')
  assert.ok(codex && noDepth, 'the tier table no longer contains both shapes, so this proves nothing')

  for (const [label, command] of [
    ['a depth for a provider that has none', { tier: noDepth.id, effort: 'xhigh' }],
    ['another vendor', { tier: codex.id, provider: 'claude' }],
    ['another vendor’s model', { tier: codex.id, model: 'claude/opus' }],
  ]) {
    const { args, calls } = fixture()
    const answer = await executeCreateAndStartNode({ ...args, launchTiers: LAUNCH_TIERS, command: { ...COMMAND, ...command } })
    assert.equal(answer.ok, false, label)
    assert.equal(answer.code, 'MC_TREE_SPAWN_TIER_REFUSED', label)
    assert.equal(calls.added.length, 0, `${label}: nothing is drawn on the person's tree`)
    assert.equal(calls.started.length, 0, `${label}: and nothing is started, so nobody is billed for it`)
    assert.match(answer.reason, /Nothing was started/, `${label}: the person is told what happened`)
  }

  /* And the depth check must NOT fire for a provider that does carry one,
     whatever that tier's own default column says. */
  for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
    const row = LAUNCH_TIERS.find(tier => tier.provider === provider)
    if (!row) continue
    const { args, calls } = fixture()
    const answer = await executeCreateAndStartNode({ ...args, launchTiers: LAUNCH_TIERS, command: { ...COMMAND, tier: row.id, effort: 'high' } })
    assert.equal(answer.ok, true, `${provider}/${row.id} must accept a depth`)
    assert.equal(calls.started[0].options.effort, 'high', `${provider}: the depth reaches the start`)
  }
})

test('a provider or model that confirms the chosen model is accepted, in either spelling the table carries', async () => {
  /* The two can only ever agree or contradict -- every row in LAUNCH_TIERS
     fixes both -- so agreement must not be a refusal, or an assistant that
     states what it believes it is starting gets nothing. */
  const withCli = LAUNCH_TIERS.find(tier => tier.cliModel && tier.model)
  assert.ok(withCli, 'no row carries both spellings, so this proves nothing')

  for (const model of [withCli.model, withCli.cliModel]) {
    const { args, calls } = fixture()
    const answer = await executeCreateAndStartNode({
      ...args,
      launchTiers: LAUNCH_TIERS,
      command: { ...COMMAND, tier: withCli.id, provider: withCli.provider, model },
    })
    assert.equal(answer.ok, true, model)
    assert.equal(calls.started.length, 1, `${model}: the circle is started`)
  }
})
