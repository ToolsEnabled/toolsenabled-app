/* STOP AND RESTART ARE ALSO "BY THE ONE ABOVE IT".
 *
 * Owner, 2026-09-03: "THE AGENTS NEED TO BE ABLE TO DELETE AND START AND
 * RESTART AGENTS UNDER THEM". Three verbs, one word: UNDER. The removal rule
 * (src/agent-removal-rule.js, executeRemoveNode) reads where the asker stands
 * from the session the application bound and refuses a circle that is not
 * below it. The stop and restart routes in runTreeNodeCommand read nothing of
 * the kind: an assistant could name ANY circle on the tree -- a sibling, its
 * own manager, the person's root -- and the view closed or wiped it.
 *
 * The engine's own handler says the application answers this
 * (src/lib/tool-registry.js treeLifecycle: "whether the named circle is
 * really below this one ... those facts live in the tree store"), and for two
 * of the three verbs nobody did.
 *
 * Every assertion here calls the gate with a real fleet-tree store; the last
 * one pins that the view asks it before either verb acts.
 *
 *   node tools/test/agent-lifecycle-caller-gate.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'

/* Only the real-mount case below needs this: computers.js pulls in font and
   stylesheet assets that only a bundler resolves under a plain `node --test`
   process. Registered unconditionally at module scope, same as the
   projection-bound suite, since a loader hook must be in place before any
   import -- including one four tests down -- reaches it. */
register('./helpers/css-stub-loader.mjs', import.meta.url)

import { LIFECYCLE_REFUSALS, callerCircleRefusal } from '../../src/agent-removal-rule.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import refusals from '../../shell/tree-command-refusal-sentences.cjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function memoryStorage() {
  const cells = new Map()
  return {
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

function stamps() {
  let tick = 0
  return () => new Date(Date.UTC(2026, 8, 4, 0, 0, tick += 1)).toISOString()
}

function counterIds() {
  let count = 0
  return kind => `${kind}-${count += 1}`
}

function circle(s, parentId = null) {
  const answer = s.addNode({ parentId, role: 'worker', message: 'do one bounded thing', tier: 'claude-sonnet', madeByAgent: parentId !== null })
  assert.equal(answer.ok, true, JSON.stringify(answer.problems || []))
  return answer.node
}

/* Two managers side by side, one worker under each, and the first manager's
   session bound the way the view binds it. */
function forest() {
  const s = createFleetTreeStore({ computerId: 'c1', storage: memoryStorage(), now: stamps(), makeId: counterIds() })
  const manager = circle(s)
  const worker = circle(s, manager.id)
  const grandchild = circle(s, worker.id)
  const otherManager = circle(s)
  const otherWorker = circle(s, otherManager.id)
  const sessionNodeIds = new Map([['ses-manager', manager.id], ['ses-other', otherManager.id]])
  const ask = (action, nodeId, parentSessionId = 'ses-manager') => callerCircleRefusal({
    command: { action, nodeId, parentSessionId },
    node: s.getNode(nodeId),
    treeStore: s,
    sessionNodeIds,
  })
  return { s, manager, worker, grandchild, otherManager, otherWorker, ask }
}

test('a circle below the asker may be stopped or restarted; a circle elsewhere may not', () => {
  const { manager, worker, grandchild, otherManager, otherWorker, ask } = forest()
  for (const action of ['stop-node', 'fresh-start-existing-node']) {
    assert.equal(ask(action, worker.id), null, `${action}: the worker directly below is allowed`)
    assert.equal(ask(action, grandchild.id), null, `${action}: a circle further down the same branch is allowed`)
    assert.equal(ask(action, otherWorker.id)?.code, LIFECYCLE_REFUSALS.notBelowCaller, `${action}: another manager's worker is refused`)
    assert.equal(ask(action, otherManager.id)?.code, LIFECYCLE_REFUSALS.notBelowCaller, `${action}: a sibling manager is refused`)
    assert.equal(ask(action, manager.id)?.code, LIFECYCLE_REFUSALS.notBelowCaller, `${action}: a circle never stands below itself`)
    assert.equal(ask(action, manager.id, 'ses-other')?.code, LIFECYCLE_REFUSALS.notBelowCaller, `${action}: the other manager cannot reach across`)
  }
})

test('an asker the application cannot place is told that, and a person\'s own errand is not gated', () => {
  const { worker, ask } = forest()
  const refused = ask('stop-node', worker.id, 'ses-nobody')
  assert.equal(refused.code, LIFECYCLE_REFUSALS.callerUnknown)
  assert.equal(refused.ok, false)
  assert.equal(refused.nodeId, worker.id)
  /* The file-spool coordinator's fresh-start-existing-node never names a
     session: it is the person's own tool, and the person may restart any
     circle. Absence is not an unknown caller. */
  assert.equal(ask('fresh-start-existing-node', worker.id, null), null)
  assert.equal(ask('fresh-start-existing-node', worker.id, undefined), null)
})

test('every refusal the gate can give has a sentence, for both verbs, and neither says "remove"', () => {
  for (const code of Object.values(LIFECYCLE_REFUSALS)) {
    for (const action of ['stop-node', 'fresh-start-existing-node']) {
      const sentence = refusals.treeCommandRefusalSentence(action, code)
      assert.ok(sentence.length > 20, `${code} has no sentence`)
      assert.ok(!sentence.includes(code), `${code} fell through to the identifier-in-brackets fallback`)
      assert.doesNotMatch(sentence, /remov/i, `${code} explains a stop or restart in the words of a removal`)
    }
  }
})

test('the view asks the gate before it closes a session and before it replaces one', () => {
  const view = readFileSync(path.join(repoRoot, 'src', 'views', 'computers.js'), 'utf8')
  const body = view.slice(view.indexOf('async runTreeNodeCommand(command) {'))
  const gateAt = body.indexOf('callerCircleRefusal({')
  assert.ok(gateAt > 0, 'runTreeNodeCommand never asks where the asker stands')
  /* The restart branch no longer returns the primitive's answer straight
     through: it passes an afterBind step (the assistant's restart keeps the
     node's brief) and reconciles the open rail before returning, so the pin is
     on the CALL, whatever its argument list, not on a `return` of it. */
  const restartAt = body.indexOf('freshStartExistingNode(node')
  const stopAt = body.indexOf("if (command.action === 'stop-node') {")
  assert.ok(restartAt > 0 && gateAt < restartAt, 'a restart is performed before the gate is asked')
  assert.ok(stopAt > 0 && gateAt < stopAt, 'a stop is performed before the gate is asked')
})

/* THE SAME GUARANTEE, DRIVEN THROUGH A REAL MOUNT rather than read off the
 * source. The test above proves the gate is CALLED before either verb acts;
 * this proves it actually REFUSES a caller the application cannot place,
 * through runTreeNodeCommand itself, on a real (non-mock) computersView. */
test('a real mount refuses stop-node for an asker the application cannot place, and does not gate an ungated errand', async () => {
  const { installWorld, mountView, seedTreeNode, fleetFetch, COMPUTER_ID } =
    await import('./lib/tree-command-real-mount.mjs')
  const world = await installWorld(fleetFetch())
  seedTreeNode(world.storage, { nodeId: 'node-1', sessionId: null, status: 'draft' })
  let view = null
  try {
    view = await mountView(world)
    const base = {
      protocol: 'mc.tree-node-command', schemaVersion: 1, requestId: 'tnc-caller-gate-1',
      action: 'stop-node', computerId: COMPUTER_ID, treeId: null, nodeId: 'node-1',
      expectedSessionId: null,
    }
    const unknownCaller = await view.runTreeNodeCommand({ ...base, parentSessionId: 'ses-nobody' })
    assert.equal(unknownCaller.code, LIFECYCLE_REFUSALS.callerUnknown,
      `an unrecognised parentSessionId reached the stop instead of being refused as an unplaceable caller (got ${unknownCaller.code})`)

    const ungatedErrand = await view.runTreeNodeCommand({ ...base, requestId: 'tnc-caller-gate-2', parentSessionId: null })
    assert.notEqual(ungatedErrand.code, LIFECYCLE_REFUSALS.callerUnknown,
      'a command naming no caller at all must not be gated the same way an unrecognised one is')
    assert.notEqual(ungatedErrand.code, LIFECYCLE_REFUSALS.notBelowCaller,
      'a command naming no caller at all must not be gated the same way an unrecognised one is')
  } finally {
    view?.destroy()
    world.restore()
  }
})
