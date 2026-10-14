/* THE OWNER'S RULE FOR WHO MAY REMOVE A CIRCLE, EXERCISED BY CALLING IT.
 *
 * Owner, 2026-09-03, verbatim: "agents that were spawned by agents AND who the
 * user hasnt prompted - THEY can be removed by parent agents. AGENTS that a
 * user prompts even if created by another agent can remain".
 *
 * WHY THIS SUITE EXISTS BESIDE agent-lifecycle-tree-commands.test.mjs. That one
 * asserted the four combinations against a truth table WRITTEN IN THE TEST:
 *
 *     const removable = node => node.createdByAgent === true && node.promptedByPerson !== true
 *
 * Nothing in the product is called by that line, so it stays green while the
 * rule is deleted. Every assertion here goes through executeRemoveNode with a
 * real fleet-tree store and real values, so breaking the rule turns it red.
 *
 *   node --test tools/test/agent-removal-rule.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REMOVAL_REFUSALS,
  circleIsBelow,
  executeRemoveNode,
  notePersonSpokeTo,
  personTurnPromptsCircle,
} from '../../src/agent-removal-rule.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import refusals from '../../shell/tree-command-refusal-sentences.cjs'

/* The store's own test seam, the same shapes its suite uses. */
function memoryStorage() {
  const cells = new Map()
  return {
    cells,
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

function stamps() {
  let tick = 0
  return () => new Date(Date.UTC(2026, 8, 3, 0, 0, tick += 1)).toISOString()
}

function counterIds() {
  let count = 0
  return kind => `${kind}-${count += 1}`
}

const store = () => createFleetTreeStore({
  computerId: 'c1', storage: memoryStorage(), now: stamps(), makeId: counterIds(),
})

function circle(s, { parentId = null, madeByAgent = false } = {}) {
  const answer = s.addNode({ parentId, role: 'worker', message: 'do one bounded thing', tier: 'claude-sonnet', madeByAgent })
  assert.equal(answer.ok, true, JSON.stringify(answer.problems || []))
  return answer.node
}

/* A manager circle with one worker under it, bound to the manager's live
   session exactly as the view binds one: sessionNodeIds is the application's
   own record of which circle a session belongs to, and the request never
   carries it. */
function tree({ madeByAgent = true, prompted = false } = {}) {
  const s = store()
  const manager = circle(s)
  const worker = circle(s, { parentId: manager.id, madeByAgent })
  if (prompted) assert.equal(s.markPromptedByPerson(worker.id).ok, true)
  const sessionNodeIds = new Map([['ses-manager', manager.id]])
  const removed = []
  const call = (overrides = {}) => executeRemoveNode({
    command: { action: 'remove-node', nodeId: worker.id, parentSessionId: 'ses-manager' },
    node: s.getNode(worker.id),
    treeStore: s,
    sessionNodeIds,
    removeCircle: async node => { removed.push(node.id); return true },
    ...overrides,
  })
  return { s, manager, worker, sessionNodeIds, removed, call }
}

test("the owner's four combinations, decided by the code that decides them", async () => {
  /* 1. Agent-made, never prompted -- the one case the owner allows. */
  const allowed = tree({ madeByAgent: true, prompted: false })
  const yes = await allowed.call()
  assert.equal(yes.ok, true, 'an assistant may remove a circle it made that nobody has spoken to')
  assert.equal(yes.code, null)
  assert.deepEqual(allowed.removed, [allowed.worker.id], 'the view\'s own removal is the one that ran')

  /* 2. Agent-made, prompted -- "AGENTS that a user prompts even if created by
        another agent can remain". */
  const spoken = tree({ madeByAgent: true, prompted: true })
  const no = await spoken.call()
  assert.equal(no.ok, false)
  assert.equal(no.code, REMOVAL_REFUSALS.personSpoke)
  assert.deepEqual(spoken.removed, [], 'nothing was removed')

  /* 3. Person-made, never prompted -- not "spawned by agents", so not the
        owner's removable case. */
  const byHand = tree({ madeByAgent: false, prompted: false })
  const handNo = await byHand.call()
  assert.equal(handNo.ok, false)
  assert.equal(handNo.code, REMOVAL_REFUSALS.notAgentMade)
  assert.deepEqual(byHand.removed, [])

  /* 4. Person-made and prompted -- refused, and refused with the reason that
        will never stop being true. Which of the two answers is given matters:
        "the person has spoken to it" is the durable one, so it is checked
        first and is the sentence the assistant reads. */
  const both = tree({ madeByAgent: false, prompted: true })
  const bothNo = await both.call()
  assert.equal(bothNo.ok, false)
  assert.equal(bothNo.code, REMOVAL_REFUSALS.personSpoke)
  assert.deepEqual(both.removed, [])
})

test('the facts are read from the store at decision time, not from the node handed in', async () => {
  /* A removal waits in the broker's queue. If the person types at the circle
     while it waits, the fact recorded a moment ago must decide -- otherwise the
     rule loses exactly the race it exists to win. */
  const t = tree({ madeByAgent: true, prompted: false })
  const stale = t.s.getNode(t.worker.id)
  assert.equal(stale.promptedByPerson, false)
  assert.equal(t.s.markPromptedByPerson(t.worker.id).ok, true)

  const answer = await t.call({ node: stale })
  assert.equal(answer.ok, false, 'the stale node said nobody had spoken; the store knew better')
  assert.equal(answer.code, REMOVAL_REFUSALS.personSpoke)
  assert.deepEqual(t.removed, [])
})

test('a circle is removed by one above it, and the asker is read from its session', async () => {
  const s = store()
  const manager = circle(s)
  const mine = circle(s, { parentId: manager.id, madeByAgent: true })
  const sibling = circle(s, { parentId: manager.id, madeByAgent: true })
  const grandchild = circle(s, { parentId: mine.id, madeByAgent: true })
  const sessionNodeIds = new Map([['ses-mine', mine.id]])
  const removed = []
  const ask = (nodeId, parentSessionId = 'ses-mine') => executeRemoveNode({
    command: { action: 'remove-node', nodeId, parentSessionId },
    node: s.getNode(nodeId),
    treeStore: s,
    sessionNodeIds,
    removeCircle: async node => { removed.push(node.id); return true },
  })

  assert.equal((await ask(sibling.id)).code, REMOVAL_REFUSALS.notBelowCaller,
    'a circle beside it on the tree is not its to remove')
  assert.equal((await ask(manager.id)).code, REMOVAL_REFUSALS.notBelowCaller,
    'the circle ABOVE it is certainly not its to remove')
  assert.equal((await ask(mine.id)).code, REMOVAL_REFUSALS.notBelowCaller,
    'a circle cannot ask for its own removal')
  assert.deepEqual(removed, [], 'not one of those three touched the tree')

  const own = await ask(grandchild.id)
  assert.equal(own.ok, true, 'a circle under it is within its own branch')
  assert.deepEqual(removed, [grandchild.id])
})

test('a session bound to no circle is told that, not quietly allowed or quietly refused', async () => {
  const t = tree({ madeByAgent: true, prompted: false })
  const answer = await t.call({ command: { action: 'remove-node', nodeId: t.worker.id, parentSessionId: 'ses-nobody' } })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, REMOVAL_REFUSALS.callerUnknown,
    '"could not place the asker" is its own answer, never merged into "not below you"')
  assert.deepEqual(t.removed, [])
})

test('the store keeping a circle is passed through as a refusal, not reported as a removal', async () => {
  const t = tree({ madeByAgent: true, prompted: false })
  const answer = await t.call({ removeCircle: async () => false })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, REMOVAL_REFUSALS.storeRefused)
})

test('circleIsBelow walks a bounded chain and never loops on a damaged record', () => {
  /* tree-nodes.json has been hand-edited on this fleet before, and a cycle in
     it would hang the renderer rather than refuse. */
  const cyclic = new Map([
    ['a', { id: 'a', parentId: 'b' }],
    ['b', { id: 'b', parentId: 'a' }],
  ])
  assert.equal(circleIsBelow(id => cyclic.get(id) || null, 'a', 'nobody'), false)
  assert.equal(circleIsBelow(id => cyclic.get(id) || null, 'a', 'b'), true, 'the first step still answers')
  assert.equal(circleIsBelow(null, 'a', 'b'), false, 'no reader is not an answer of yes')
})

test('which typed lines count as the person prompting a circle', () => {
  /* The console's own vocabulary drives the PRODUCT. Only the lines whose words
     reach the model are the person prompting the assistant. */
  assert.equal(personTurnPromptsCircle('finish the report'), true)
  assert.equal(personTurnPromptsCircle('/queue finish the report'), true, 'queued words are still the person\'s words')
  assert.equal(personTurnPromptsCircle('/queue'), false, 'nothing was queued, so nothing was said')
  assert.equal(personTurnPromptsCircle('/interrupt'), false)
  assert.equal(personTurnPromptsCircle('/help'), false)
  assert.equal(personTurnPromptsCircle('/goal R1234 ship the thing'), false, 'a build-queue item is not a message to the agent')
  assert.equal(personTurnPromptsCircle('/RequestTree keep the tests green'), false, 'a filed rule is not a message to the agent')
  assert.equal(personTurnPromptsCircle('/nonsense'), false, 'an unknown command is never sent, so nothing was said')
  assert.equal(personTurnPromptsCircle('   '), false)
  assert.equal(personTurnPromptsCircle(null), false)
})

test('a circle the person queued words at while it worked is no longer removable', async () => {
  /* THE DEFECT THIS SUITE WAS WRITTEN FOR. The fact was recorded only on the
     live-send route, which a typed line takes ONLY when the circle happens to
     be idle. A tree circle that is working queues the person's words instead --
     and stayed removable by the assistant above it. */
  const t = tree({ madeByAgent: true, prompted: false })
  assert.equal(notePersonSpokeTo(t.s, t.worker, '/queue read the report when you are free'), true)
  assert.equal(t.s.getNode(t.worker.id).promptedByPerson, true)

  const answer = await t.call()
  assert.equal(answer.ok, false)
  assert.equal(answer.code, REMOVAL_REFUSALS.personSpoke)
  assert.deepEqual(t.removed, [])
})

test('driving the product does not make a circle the person never spoke to unremovable', async () => {
  const t = tree({ madeByAgent: true, prompted: false })
  assert.equal(notePersonSpokeTo(t.s, t.worker, '/interrupt'), false)
  assert.equal(t.s.getNode(t.worker.id).promptedByPerson, false)

  const answer = await t.call()
  assert.equal(answer.ok, true, 'stopping a turn is not speaking to the agent')
})

test('every refusal the rule can give has a sentence a person can read', () => {
  const codes = Object.values(REMOVAL_REFUSALS)
  assert.ok(codes.length >= 6, 'the rule still has refusals to answer for')
  for (const code of codes) {
    const sentence = refusals.treeCommandRefusalSentence('remove-node', code)
    assert.ok(sentence.length > 20, `${code} has no sentence`)
    assert.ok(!sentence.includes(code), `${code} fell through to the identifier-in-brackets fallback`)
    assert.ok(/[.!]$/.test(sentence), `${code} is not written as a sentence`)
  }
})

test('a refusal with no sentence of its own still names the errand it refused', () => {
  /* The line this replaces answered every verb with "could not add that
     assistant to the tree", so a failed stop was reported as a failed spawn. */
  const stop = refusals.treeCommandRefusalSentence('stop-node', 'MC_TREE_COMMAND_STOP_FAILED')
  assert.match(stop, /stop that circle/)
  assert.match(stop, /MC_TREE_COMMAND_STOP_FAILED/, 'an unnamed code is still handed over, never swallowed')
  assert.doesNotMatch(stop, /add that assistant/)

  const spawn = refusals.treeCommandRefusalSentence('create-and-start-node', 'MC_TREE_SPAWN_ROLE_UNKNOWN')
  assert.match(spawn, /add that assistant to the tree/, 'the spawn wording it always had is unchanged')

  const unknown = refusals.treeCommandRefusalSentence('who-knows', null)
  assert.match(unknown, /MC_TREE_COMMAND_RENDERER_FAILED/, 'a missing code is named rather than left blank')
})

/* THE SAME LOOKUP DEFECT THE BROKER'S OWN TABLE WAS ALREADY FIXED FOR, STILL
 * LIVE IN ITS SIBLING.
 *
 * shell/tree-node-command-broker.cjs's treeNodeCommandRefusalSentence guards
 * its table lookup with Object.prototype.hasOwnProperty.call and carries its
 * own regression test for exactly this ("Inherited object properties are not
 * sentences"). This file's treeCommandRefusalSentence does the identical kind
 * of lookup on TWO plain objects -- TREE_COMMAND_REFUSAL_SENTENCES for `code`,
 * TREE_COMMAND_ERRANDS for `action` -- with a bare `obj[key]` and no such
 * guard.
 *
 * MEASURED: `refusals.treeCommandRefusalSentence('create-and-start-node',
 * 'toString')` answers the FUNCTION Object.prototype.toString, not a string,
 * because `TREE_COMMAND_REFUSAL_SENTENCES['toString']` resolves the inherited
 * built-in rather than undefined and the code accepts anything truthy as a
 * "named" sentence. shell/main.cjs's resolveLocalTreeCommand hands this
 * straight to `new Error(message)` when rejecting a waiting agent.spawn /
 * .stop / .restart / .remove call, which stringifies it to
 * "function toString() { [native code] }" as the tool's own error text. The
 * broker's complete() only checks requestId for a LOCAL envelope -- nothing
 * constrains what `code` a renderer reply carries the way
 * normalizeRendererResult constrains the file-spool path -- so an ordinary
 * string reaches this function unfiltered. Nothing exercised this path
 * before, which is exactly how it stayed unfixed after its sibling was. */
test('a code or action that names something every object inherits is never mistaken for a sentence', () => {
  for (const code of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'toLocaleString', 'isPrototypeOf']) {
    const said = refusals.treeCommandRefusalSentence('remove-node', code)
    assert.equal(typeof said, 'string', `code ${code} must answer a string, never an inherited function`)
    assert.match(said, /remove that circle/, `an unmapped code still names the real errand (${code})`)
    assert.match(said, new RegExp(code), `the code itself is still handed over uninterpreted (${code})`)
  }
  for (const action of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    const said = refusals.treeCommandRefusalSentence(action, 'MC_TREE_COMMAND_SOMETHING_UNLISTED')
    assert.equal(typeof said, 'string', `action ${action} must answer a string, never an inherited function`)
    assert.match(said, /carry out that request on the tree/, `an unmapped action still falls to the generic errand (${action})`)
  }
})
