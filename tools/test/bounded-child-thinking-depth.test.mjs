/* THE DEPTH A BOUNDED CHILD IS STARTED AT, ON EVERY PROVIDER THAT HAS ONE.
 *
 * src/views/computers.js startBoundedChild read the chosen depth only for
 * codex:
 *
 *   effort: launchTier(request.tier)?.provider === 'codex' ? (request.effort || tierEffortOf(request.tier)) : ''
 *   effort: launchTier(request.tier)?.provider === 'codex' ? request.effort : null
 *
 * so a bounded child on any claude tier was added with `effort: ''` and started
 * with `effort: null`, ran at the vendor default, and recorded nothing. The
 * owner's managers run claude-opus at xhigh and his builders claude-opus at
 * medium; this is the same defect agent.spawn was corrected for, in the second
 * doorway. The `effort` column on a tier row is that tier's DEFAULT depth, not
 * its allowed set -- every claude row reads null and Claude takes `--effort`
 * (engine src/lib/agent-engine/claude-cli-adapter.js baseClaudeArgs).
 *
 * THIS DRIVES THE REAL FUNCTION WITH REAL VALUES. startBoundedChild is lifted
 * out of the view by name and run against the product's own LAUNCH_TIERS, so
 * what is asserted is the depth the store and the start actually receive, not
 * the spelling of the condition that chose it.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/bounded-child-thinking-depth.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { LAUNCH_TIERS, launchTier } from '../../src/orchestration-controls.js'
import { PROVIDERS_WITH_A_THINKING_DEPTH } from '../../src/create-and-start-node.js'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const START_CONTROL_FLAG = 'start'
const tierEffortOf = tierId => launchTier(tierId)?.effort || null

/* Every free identifier startBoundedChild reads, supplied by name. The view
   itself cannot be imported under plain node. */
function liftStartBoundedChild() {
  const body = declaredFunctionSource(source, 'startBoundedChild')
  const factory = new Function(
    'window', 'readOrg', 'orgAvailability', 'mockSource', 'sessionNodeIds', 'isWriteEnabled',
    'START_CONTROL_FLAG', 'roleRecordFor', 'PROVIDERS_WITH_A_THINKING_DEPTH', 'launchTier',
    'tierEffortOf', 'refreshTree', 'startDraftNode',
    `return (${body}\n)`,
  )
  return deps => factory(
    deps.window, deps.readOrg, deps.orgAvailability, deps.mockSource, deps.sessionNodeIds,
    deps.isWriteEnabled, START_CONTROL_FLAG, deps.roleRecordFor, PROVIDERS_WITH_A_THINKING_DEPTH,
    launchTier, tierEffortOf, deps.refreshTree, deps.startDraftNode,
  )
}

/* One running parent, a store that records what it was asked to add, and a
   start that records the options it was handed. */
function fixture() {
  const added = []
  const started = []
  const parent = { id: 'node-1-parent', treeId: 'tree-1', sessionId: 'parent-session' }
  const nodes = new Map([[parent.id, parent]])
  const bridge = { workStatus: async () => ({ ok: true }) }
  const store = {
    snapshot: () => ({ computerId: 'computer-1' }),
    getNode: id => nodes.get(id) || null,
    addNode: fields => {
      added.push(fields)
      const node = { id: 'node-2-child', treeId: 'tree-1', ...fields }
      nodes.set(node.id, node)
      return { ok: true, node }
    },
  }
  const deps = {
    window: { mcAgent: bridge },
    readOrg: async () => ({ state: 'ready' }),
    orgAvailability: { state: 'ready' },
    mockSource: () => false,
    sessionNodeIds: new Map([[parent.sessionId, parent.id]]),
    isWriteEnabled: () => true,
    roleRecordFor: role => (role === 'worker' ? { id: 'worker', capabilities: {} } : null),
    refreshTree: () => {},
    startDraftNode: async (node, options) => {
      started.push({ node, options })
      return { ok: true, sessionId: 'child-session' }
    },
  }
  const request = {
    computerId: 'computer-1',
    treeId: 'tree-1',
    parentNodeId: parent.id,
    parentSessionId: parent.sessionId,
    brief: 'Carry out one bounded piece of work.',
    capMs: 30 * 60 * 1000,
  }
  return { added, started, store, bridge, deps, request }
}

const run = async (overrides = {}) => {
  const f = fixture()
  const startBoundedChild = liftStartBoundedChild()(f.deps)
  const answer = await startBoundedChild({ ...f.request, ...overrides }, f.store, f.bridge)
  return { ...f, answer }
}

test('a bounded child on a Claude model is started at the depth that was chosen, not the vendor default', async () => {
  const claude = LAUNCH_TIERS.find(tier => tier.provider === 'claude')
  assert.ok(claude, 'the tier table no longer offers a claude model, so this proves nothing')
  assert.equal(claude.effort, null,
    'a claude row carries no default depth -- which is exactly what must not be read as "no depth allowed"')

  for (const effort of ['xhigh', 'medium', 'low', 'max']) {
    const { answer, added, started } = await run({ tier: claude.id, effort })
    assert.equal(answer.ok, true, `${claude.id}/${effort}`)
    assert.equal(added[0].effort, effort,
      `${effort}: the circle was added without the depth, so a later Start from the tree runs at the default`)
    assert.equal(started[0].options.effort, effort,
      `${effort}: the start that opens the session was handed no depth`)
  }
})

test('every provider whose launcher carries a depth gets one, and the one that has none still gets nothing', async () => {
  for (const provider of ['codex', 'claude', 'gemini', 'grok']) {
    const row = LAUNCH_TIERS.find(tier => tier.provider === provider)
    if (!row) continue
    const { answer, added, started } = await run({ tier: row.id, effort: 'high' })
    assert.equal(answer.ok, true, `${provider}/${row.id}`)
    assert.equal(added[0].effort, 'high', `${provider}: the chosen depth must reach the node`)
    assert.equal(started[0].options.effort, 'high', `${provider}: and the start`)
  }

  /* `local` has no reasoning-depth switch anywhere in the engine's local-node
     modules, so a depth named for it is not carried to a launch that cannot
     use it. */
  const local = LAUNCH_TIERS.find(tier => tier.provider === 'local')
  assert.ok(local, 'the tier table no longer offers a local model, so this proves nothing')
  const { answer, added, started } = await run({ tier: local.id, effort: 'high' })
  assert.equal(answer.ok, true)
  assert.equal(added[0].effort, '', 'local carries no depth')
  assert.equal(started[0].options.effort, null, 'and its start is handed none')
})

test("choosing nothing leaves the model's own default in charge, on every provider", async () => {
  const codex = LAUNCH_TIERS.find(tier => tier.provider === 'codex' && tier.effort)
  const claude = LAUNCH_TIERS.find(tier => tier.provider === 'claude')

  /* A codex row has a default in the table, and that is what an unchosen
     depth still resolves to -- unchanged by this fix. */
  const withDefault = await run({ tier: codex.id })
  assert.equal(withDefault.added[0].effort, codex.effort)
  assert.equal(withDefault.started[0].options.effort, undefined,
    'an unchosen depth is not invented for the start; the host resolves the tier default')

  /* A claude row has none, so the node records "not set" rather than a depth
     this seam made up. */
  const withoutDefault = await run({ tier: claude.id })
  assert.equal(withoutDefault.added[0].effort, '')
  assert.equal(withoutDefault.started[0].options.effort, undefined)
})

test('the panel offers the depth control for every provider that has one, not only codex', () => {
  /* The visible half of the same defect: the control was disabled unless a
     codex tier was selected, so the owner could not choose a depth for a
     Claude child even once the code above could carry it. */
  const box = source.slice(source.indexOf('data-native-work='), source.indexOf('data-native-work=') + 4000)
  assert.doesNotMatch(box, /Codex effort/,
    'the control still calls itself Codex-only while carrying a depth for four providers')

  const enable = source.slice(source.indexOf("querySelector('[data-work-effort]').disabled"))
  assert.match(enable.slice(0, 300), /PROVIDERS_WITH_A_THINKING_DEPTH\.has\(launchTier\(value\)\?\.provider\)/,
    'the depth control is still enabled only for codex')

  /* And the set really does name more than codex, or the line above would be
     a no-op dressed as a fix. */
  assert.ok(PROVIDERS_WITH_A_THINKING_DEPTH.has('claude'))
  assert.ok(PROVIDERS_WITH_A_THINKING_DEPTH.has('codex'))
  assert.equal(PROVIDERS_WITH_A_THINKING_DEPTH.has('local'), false)
})
