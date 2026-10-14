/* AN ASSISTANT CAN STOP, RESTART AND REMOVE A CIRCLE BELOW IT.
 *
 * Owner, 2026-09-03, verbatim: "THE AGENTS NEED TO BE ABLE TO DELETE AND START
 * AND RESTART AGENTS UNDER THEM AND BE ABLE TO MESSAGE EACH". Start and message
 * already had a route. Stop, restart and remove did not -- although this view
 * performs all three for the person's own press, and the page shipped three
 * DISABLED buttons with excuse text where the behaviour should have been.
 *
 * AND THE RULE THAT DECIDES A REMOVAL, also verbatim: "agents that were spawned
 * by agents AND who the user hasnt prompted - THEY can be removed by parent
 * agents. AGENTS that a user prompts even if created by another agent can
 * remain."
 *
 * Both halves are FACTS ABOUT WHAT HAPPENED, recorded where they happen:
 * `createdByAgent` when an assistant makes the circle, `promptedByPerson` the
 * first time a person's own words are sent to it. Neither is claimed by the
 * caller asking for the removal, which is the whole point -- an assistant that
 * could assert "nobody prompted this" could delete the person's work.
 *
 *   node --test tools/test/agent-lifecycle-tree-commands.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createFleetTreeStore } from '../../src/fleet-trees.js'

/* The same storage seam and the same shapes the store's own suite uses, so a
   change to either is a change to one thing. */
function memoryStorage(seed = new Map()) {
  const cells = new Map(seed)
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

const storeOn = storage => createFleetTreeStore({
  computerId: 'c1', storage, now: stamps(), makeId: counterIds(),
})

const store = () => storeOn(memoryStorage())

function addCircle(s, { madeByAgent = false, parentId = null } = {}) {
  const answer = s.addNode({ parentId, role: 'worker', message: 'do one bounded thing', tier: 'claude-sonnet', madeByAgent })
  assert.equal(answer.ok, true, JSON.stringify(answer.problems || []))
  return answer.node
}

test('a circle records who made it, and the record survives a reload', () => {
  const s = store()
  const byHand = addCircle(s)
  const byAgent = addCircle(s, { madeByAgent: true })

  assert.equal(byHand.createdByAgent, false, 'a circle the person made is not agent-made')
  assert.equal(byAgent.createdByAgent, true)
  assert.equal(byHand.promptedByPerson, false, 'nobody has spoken to a new circle')
  assert.equal(byAgent.promptedByPerson, false)

  /* Read back through the store rather than through the object just returned,
     so this asserts what a later reader sees. */
  assert.equal(s.getNode(byAgent.id).createdByAgent, true)
  assert.equal(s.getNode(byHand.id).createdByAgent, false)
})

test('the person speaking to a circle is recorded once and never unset', () => {
  const s = store()
  const node = addCircle(s, { madeByAgent: true })
  assert.equal(s.getNode(node.id).promptedByPerson, false)

  const first = s.markPromptedByPerson(node.id)
  assert.equal(first.ok, true)
  assert.equal(s.getNode(node.id).promptedByPerson, true)

  /* Saying it twice is the same fact, not an error and not a second write. */
  const again = s.markPromptedByPerson(node.id)
  assert.equal(again.ok, true)
  assert.equal(s.getNode(node.id).promptedByPerson, true)

  assert.equal(s.markPromptedByPerson('node-nobody').ok, false, 'an unknown circle is refused, not invented')
})

test("an older record carries neither fact, and absent reads as the cautious answer", () => {
  /* A circle written before this change was never proven agent-made, so an
     assistant may not remove it. Absent must not read as permission. */
  const storage = memoryStorage()
  const first = storeOn(storage)
  const made = addCircle(first, { madeByAgent: true })
  assert.equal(first.getNode(made.id).createdByAgent, true)

  /* Strip both fields the way an older record would have them: absent. */
  for (const [key, raw] of storage.cells) {
    let parsed
    try { parsed = JSON.parse(raw) } catch { continue }
    const nodes = parsed && parsed.nodes
    if (!Array.isArray(nodes)) continue
    for (const entry of nodes) { delete entry.createdByAgent; delete entry.promptedByPerson }
    storage.cells.set(key, JSON.stringify(parsed))
  }

  const reloaded = storeOn(storage)
  const back = reloaded.getNode(made.id)
  assert.ok(back, 'the older circle still loads')
  assert.equal(back.createdByAgent, false, 'not proven agent-made, so not removable by an assistant')
  assert.equal(back.promptedByPerson, false)
})

/* THE FOUR COMBINATIONS USED TO BE ASSERTED HERE, AGAINST A LAMBDA WRITTEN IN
   THIS FILE:

     const removable = node => node.createdByAgent === true && node.promptedByPerson !== true

   That reaches nothing in the product. Deleting the rule from the view left it
   green, which is the one thing a test for a rule must not do. The truth table
   now lives in tools/test/agent-removal-rule.test.mjs and is driven through
   executeRemoveNode -- the code the view actually calls -- so it goes red when
   the rule does. This file keeps what it can genuinely prove: the two facts the
   rule reads, and how the store records them. */
import { resumeNodeCommandResult } from '../../src/resume-node-command-result.js'

test('resume command success requires a new actual session binding, including an idle native resume', () => {
  const input = { nodeId: 'n', previousSessionId: 'old', sessionNodeIds: new Map([['new', 'n']]), sessionThreadIds: new Map([['new', 'native-thread']]) }
  assert.equal(resumeNodeCommandResult({ ...input, node: { sessionId: 'old', status: 'finished' } }).ok, false)
  assert.equal(resumeNodeCommandResult({ ...input, node: { sessionId: 'new', status: 'failed' } }).ok, false)
  assert.equal(resumeNodeCommandResult({ ...input, node: { sessionId: 'unmapped', status: 'running' } }).ok, false)
  assert.equal(resumeNodeCommandResult({ ...input, node: null }).ok, false)
  const idle = resumeNodeCommandResult({ ...input, node: { sessionId: 'new', status: 'finished' } })
  assert.equal(idle.ok, true)
  assert.equal(idle.threadId, 'native-thread')
})
