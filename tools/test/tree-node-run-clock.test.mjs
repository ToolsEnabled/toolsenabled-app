// THE TWO THINGS THE OWNER SAW ON PAGE 2, PROVED WITH VALUES.
//
// "sometimes the rings disappear on pg2 around the workers and their timeers
//  not always accurate to their time ran - sometimes it logs time they werent
//  running"
//
// They are separate defects with separate mechanisms, so they are separate
// halves of this file:
//
//   THE RING is a custom property. `--rc` reaches a circle through one channel
//   only -- a `role-<key>` class -- and `.node-glass` is `border: 1.5px solid
//   var(--rc)`. A tree node's role is a one-line string the record takes
//   verbatim, and the ids that reach it come from the organisation's Role
//   library, so `role-worker` was a real class with no `--rc` behind it. An
//   undeclared custom property does not leave a default colour: the shorthand
//   is invalid at computed-value time, every longhand takes its initial value,
//   and the initial `border-style` is `none`. src/vocab.js rimRole() is the
//   rule that keeps the class inside the set the sheets declare.
//
//   THE TIMER measured wall time from `createdAt`, the moment the CIRCLE was
//   drawn. Every minute a draft waited for its brief, and every idle hour
//   between two runs, was billed to the agent. The store now measures the
//   intervals it was running and nothing else.
//
// Every figure below is asserted through fmtRuntime -- the same formatter the
// canvas prints -- so what is checked is the string a person reads, not an
// intermediate this file could get right while the screen stays wrong.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { createFleetTreeStore, fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { treeNodeClock } from '../../src/tree-session-liveness.js'
import { fmtRuntime } from '../../src/runtime-clock.js'
import { ROLES, rimRole } from '../../src/vocab.js'
import { ENGINE_ROLES } from '../../src/orchestration-controls.js'
import { roleColorStyle } from '../../src/role-colors.js'

const COMPUTER = 'computer-run-clock'
const START = Date.parse('2026-09-03T09:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

function memoryStorage(seed = new Map()) {
  const cells = new Map(seed)
  return {
    cells,
    read(key) { return cells.has(key) ? JSON.parse(cells.get(key)) : null },
    write(key, value) { cells.set(key, JSON.stringify(value)); return true },
  }
}

/* A clock the test moves by hand. Every stamp the store writes comes from
   here, so "six hours pass" is one line and no test sleeps. */
function bench(storage = memoryStorage()) {
  let at = START
  let count = 0
  const store = createFleetTreeStore({
    computerId: COMPUTER,
    storage,
    now: () => new Date(at).toISOString(),
    makeId: kind => { count += 1; return `${kind}-${count}` },
  })
  return {
    store,
    storage,
    pass(ms) { at += ms },
    get nowMs() { return at },
    /* A second store over the same cells IS the next launch: its constructor
       is the only place parseFleetTrees runs. */
    reopen() {
      return createFleetTreeStore({
        computerId: COMPUTER,
        storage,
        now: () => new Date(at).toISOString(),
        makeId: kind => { count += 1; return `${kind}-${count}` },
      })
    },
  }
}

/* What the circle shows. `running` binds a live clock in src/tree-graph.js, so
   the second argument is Date.now() there and the bench clock here. */
function digits(node, ownedSessions, nowMs) {
  const clock = treeNodeClock(node, ownedSessions)
  if (clock.runtimeEpoch === null) return null
  return fmtRuntime(clock.runtimeEpoch, clock.stoppedAt ?? nowMs)
}

test('a draft that waited is not billed for waiting', () => {
  const rig = bench()
  const added = rig.store.addNode({ role: 'coordinator', message: 'go' })
  assert.equal(added.ok, true, added.problems?.[0])
  const id = added.node.id

  /* The panel opens AFTER the placeholder is pressed. Two hours of deciding
     what to ask for is a completely ordinary thing to do to a draft. */
  rig.pass(2 * HOUR)
  assert.equal(rig.store.attachSession(id, 'session-a').ok, true)
  rig.pass(5 * SECOND)

  const owned = new Set(['session-a'])
  assert.equal(
    digits(rig.store.getNode(id), owned, rig.nowMs), '0:00:05',
    'the circle billed the agent for time it spent as an unstarted draft',
  )
  assert.notEqual(
    digits(rig.store.getNode(id), owned, rig.nowMs), '2:00:05',
    'the clock is still counting from createdAt, which is when the circle was drawn',
  )
})

test('a node that starts, stops and starts again counts the two runs and not the gap', () => {
  const rig = bench()
  const id = rig.store.addNode({ role: 'manager', message: 'collect the answers' }).node.id
  const owned = new Set(['session-b'])

  rig.pass(47 * MINUTE)                                   // sat as a draft
  rig.store.attachSession(id, 'session-b')                // RUN 1 begins
  rig.pass(30 * SECOND)
  rig.store.setNodeStatus(id, 'running')                  // the turn starts
  rig.pass(90 * SECOND)
  rig.store.setNodeStatus(id, 'finished')                 // RUN 1 ends: 120s

  const afterFirst = rig.store.getNode(id)
  assert.equal(afterFirst.runMs, 120 * SECOND, 'the first run was not measured as the 120s it lasted')
  assert.equal(
    digits(afterFirst, owned, rig.nowMs), '0:02:00',
    'a finished run did not show the time it actually ran',
  )

  rig.pass(6 * HOUR)                                      // nothing running
  rig.store.setNodeStatus(id, 'running')                  // RUN 2 begins
  rig.pass(15 * SECOND)

  const live = rig.store.getNode(id)
  assert.equal(live.runMs, 120 * SECOND, 'the open interval was banked before it closed')
  assert.equal(
    digits(live, owned, rig.nowMs), '0:02:15',
    'the second run did not resume from the first run\'s total',
  )
  /* THE DEFECT ITSELF, named so a regression cannot pass as a rounding
     difference: 47m draft + 2m run + 6h idle + 15s is what `now - createdAt`
     produces, and it is six hours of work this agent did not do. */
  assert.notEqual(
    digits(live, owned, rig.nowMs), fmtRuntime(Date.parse(live.createdAt), rig.nowMs),
    'the clock counts wall time from the circle being drawn again',
  )

  rig.pass(45 * SECOND)
  rig.store.setNodeStatus(id, 'finished')                 // RUN 2 ends: 15s + 45s
  assert.equal(rig.store.getNode(id).runMs, 180 * SECOND, 'the second run was not added to the first')
  assert.equal(
    digits(rig.store.getNode(id), owned, rig.nowMs), '0:03:00',
    'the two runs did not sum to the time actually run',
  )
})

test('a write that is not about running moves no digit', () => {
  const rig = bench()
  const id = rig.store.addNode({ role: 'helper', message: 'first' }).node.id
  rig.store.attachSession(id, 'session-c')
  rig.pass(20 * SECOND)
  rig.store.setNodeStatus(id, 'finished')
  const before = digits(rig.store.getNode(id), new Set(['session-c']), rig.nowMs)

  rig.pass(40 * MINUTE)
  rig.store.setNodeReply(id, 'here is what I found')

  assert.equal(before, '0:00:20', 'the run was not measured')
  assert.equal(
    digits(rig.store.getNode(id), new Set(['session-c']), rig.nowMs), before,
    'saving what the agent said forty minutes later changed how long it says it ran',
  )
})

test('the hours the application was shut are not hours the agent ran', () => {
  const rig = bench()
  const id = rig.store.addNode({ role: 'default', message: 'long job' }).node.id
  rig.store.attachSession(id, 'session-d')
  rig.pass(90 * SECOND)
  rig.store.setNodeStatus(id, 'running')                  // the last write before the close

  /* The window closes here. The child process dies with it; the record does
     not. Nine hours later the person opens the app again. */
  rig.pass(9 * HOUR)
  const next = rig.reopen()
  const reloaded = next.getNode(id)

  assert.equal(reloaded.runStartedAt, null, 'an interval survived a launch it could not have been running through')
  assert.equal(reloaded.runMs, 90 * SECOND, 'the run was not folded shut at the last thing measured about it')
  assert.equal(reloaded.status, 'starting', 'the saved-mid-turn status rule changed')

  /* Nothing in this run owns that session, so the canvas freezes rather than
     ticking -- and the figure it freezes on is the run, not the outage. */
  const clock = treeNodeClock(reloaded, new Set())
  assert.equal(clock.endedWithApp, true, 'a session orphaned by shutdown stopped being recoverable state')
  assert.equal(clock.running, false, 'a dead child kept a ticking clock')
  assert.equal(
    digits(reloaded, new Set(), rig.nowMs), '0:01:30',
    'the circle counted the hours the application was closed',
  )
})

test('a record written before the run clock keeps the only answer it can support', () => {
  /* Not a happy answer -- it is the over-counting one this change replaces --
     but a finished agent whose runtime became "no runtime" would be history
     deleted to avoid showing a wrong number. The distinction is carried by
     null vs 0, so it cannot be reached by anything this version writes. */
  const legacy = {
    sessionId: 'session-old',
    status: 'finished',
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:03:00.000Z',
  }
  const clock = treeNodeClock(legacy, new Set())
  assert.equal(clock.runMs, null, 'a record that was never measured claimed a measurement')
  assert.equal(clock.runtimeEpoch, Date.parse(legacy.createdAt))
  assert.equal(clock.stoppedAt, Date.parse(legacy.updatedAt))
  assert.equal(digits(legacy, new Set(), Date.parse(legacy.updatedAt)), '0:03:00')

  const measuredButIdle = { ...legacy, runMs: 0, runStartedAt: null }
  assert.equal(
    digits(measuredButIdle, new Set(), Date.parse(legacy.updatedAt)), '0:00:00',
    'a measured record fell back to the createdAt reading, so nothing is actually fixed',
  )
})

test('never-started circles still say nothing rather than zero', () => {
  const rig = bench()
  const id = rig.store.addNode({ role: 'default', message: 'not yet' }).node.id
  rig.pass(3 * HOUR)
  const clock = treeNodeClock(rig.store.getNode(id), new Set())
  assert.equal(clock.runtimeEpoch, null, 'a circle nobody started was given a clock')
  assert.equal(clock.stoppedAt, null)
  assert.equal(clock.runMs, 0, 'a fresh circle is measured, and it has run for none of it')
})

/* ---------------------------------------------------------------- the ring */

const readSource = name => readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), 'utf8')

test('every role a circle can be given resolves to a key the sheets declare', () => {
  assert.equal(rimRole('coordinator'), 'coordinator', 'a declared role stopped being itself')
  assert.equal(rimRole('spawned'), 'spawned')
  /* The ids that actually reach the canvas. These used to fall to 'default'
     because src/vocab.js ROLES carried only the fleet page's own legacy six;
     src/views/computers.js's now-removed graphRole() translated the FLEET
     projection's roles to that legacy set for the same reason, and the TREE
     path (this file) passed them straight through with no translation at
     all, so an org role reaching the tree lost its ring outright. ROLES now
     carries every declared org role directly (ENGINE_ROLES in
     src/orchestration-controls.js), so each keeps its own key here too. */
  assert.equal(rimRole('worker'), 'worker', 'a declared org role stopped being itself')
  assert.equal(rimRole('shadow-manager'), 'shadow-manager')
  assert.equal(rimRole('coordinator-assistant'), 'coordinator-assistant')
  assert.equal(rimRole('builder'), 'builder')
  /* And everything a person can type into the Role library. */
  assert.equal(rimRole(''), 'default', 'an empty role produced the class `role-`')
  assert.equal(rimRole(undefined), 'default')
  assert.equal(rimRole(null), 'default')
  assert.equal(rimRole('constructor'), 'default', 'a prototype name was read as a declared role')
  assert.equal(rimRole('toString'), 'default')
})

test('a --rc is declared for every key rimRole can return', () => {
  /* The invariant the ring depends on, and it spans two files: the class comes
     from JS and the colour from CSS, so neither file alone can prove it. */
  const sheet = readSource('tree-graph.css')
  const declared = new Set(
    [...sheet.matchAll(/\.role-([a-z-]+)[^{]*\{[^}]*--rc\s*:/g)].map(match => match[1]),
  )
  assert.ok(declared.size > 0, 'no --rc declarations were found at all, so this check proves nothing')
  for (const key of Object.keys(ROLES)) {
    assert.ok(declared.has(key), `role-${key} has no --rc, so a circle wearing it draws no ring`)
  }
  const reachable = new Set(['worker', 'shadow-manager', '', 'anything-the-owner-types'].map(rimRole))
  for (const key of reachable) {
    assert.ok(declared.has(key), `rimRole can return ${key}, which no sheet declares a --rc for`)
  }

  /* The backstop, and the source order it depends on. A resting --rc declared
     BEFORE the role rules is overridden by every one of them -- they share its
     specificity, so order is the whole mechanism -- and it is what keeps the
     failure from being total if a surface ever writes the class itself.
     Declared after them, it would repaint every circle on the canvas neutral. */
  const resting = sheet.search(/\.static-tree-graph \.node,\s*\n\.static-tree-chip \{ --rc:/)
  const firstRole = sheet.search(/\.role-[a-z-]+[^{]*\{[^}]*--rc\s*:/)
  assert.notEqual(resting, -1, 'the resting --rc is gone, so an unstyled role class draws no ring at all')
  assert.ok(resting < firstRole, 'the resting --rc is declared after the role rules, so it now overrides all of them')
})

test('every declared org role\'s ring resolves to its own accent variable and class, never spawned/default', () => {
  /* MEASURED, not read from CSS text: src/tree-graph.js paints every node,
     chip, leader and dot INLINE -- `style="...${roleColorStyle(agent.declaredRole
     || agent.role)}"` at creation, and `paintRoleColor(element, ...)` for
     every later repaint (both call sites quoted in the report). An inline
     `style` declaration outranks any class selector in CSS, including
     `.role-<key> { --rc: ... }` in tree-graph.css, so what actually reaches
     the screen is whatever roleColorStyle()/paintRoleColor() compute, not
     what the stylesheet happens to say. This test reads THAT, through the
     same functions tree-graph.js calls, rather than parsing the stylesheet
     a second time. */
  for (const id of ENGINE_ROLES) {
    assert.equal(rimRole(id), id,
      `rimRole("${id}") did not return the role itself -- its class would read role-default instead of role-${id}`)
    const style = roleColorStyle(id)
    assert.match(style, new RegExp(`--rc:var\\(--role-accent-${id}\\b`),
      `roleColorStyle("${id}")'s --rc does not read --role-accent-${id} -- got: ${style}`)
    assert.doesNotMatch(style, /--rc:var\(--role-accent-(spawned|default)\b/,
      `role ${id}'s inline --rc silently falls back to the generic spawned/default accent -- got: ${style}`)
  }
  /* The rule this does not change: a key nothing declares still falls to
     'default' as its CLASS -- rimRole's own fallback, for any role ROLES
     does not carry, regardless of shape. roleColorCss's fallback to
     'default' is narrower and a genuinely different case: it only fires for
     an INVALIDLY shaped id (validRoleColorId() false, e.g. empty). A
     validly-shaped but undeclared custom role id is passed through as its
     own accent variable name and relies on the CSS var() fallback chain
     (--role-fallback-accent) to resolve a sensible colour instead -- correct
     behaviour, not the gap this test exists to catch, so it is not asserted
     here as if it were the same fallback. */
  assert.equal(rimRole('a-role-nobody-declared'), 'default')
  assert.match(roleColorStyle(''), /--rc:var\(--role-accent-default\b/)
})

test('the canvas asks rimRole for every role class it writes', () => {
  /* A source pin, in the style tools/test/zombie-session.test.mjs uses for the
     same reason: the failure is a missing CSS custom property, which no
     assertion in a node process can observe. What CAN be observed is that no
     class-writing site has gone back to interpolating the raw role. */
  const graph = readSource('tree-graph.js')
  const emitted = [...graph.matchAll(/role-\$\{([^}]+)\}/g)].map(match => match[1].trim())
  assert.ok(emitted.length >= 4, 'the graph stopped writing role classes; this pin is looking at the wrong thing')
  for (const expression of emitted) {
    assert.match(
      expression, /^rimRole\(/,
      `a role class is built from ${expression}, which can name a key no sheet declares`,
    )
  }
})
