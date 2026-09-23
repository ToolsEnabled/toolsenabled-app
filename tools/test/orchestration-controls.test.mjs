/* THE CONTROLS ON PAGE 2, AND THE ONE RULE THEY HAVE TO OBEY.
 *
 * Owner, verbatim: "dont lie like we cant control temperature."
 *
 * A control on this page is a claim about a child process. This suite is what
 * stops that claim from drifting away from the engine that has to honour it.
 * It proves three separate things, and they fail for three different reasons:
 *
 *   1. ANTI-DRIFT. The renderer cannot import the capability layer, so the
 *      tier table has to be restated in src/orchestration-controls.js. A
 *      restated table is a table that can silently go stale — a tier renamed
 *      or re-modelled in the engine would leave page 2 offering a launch that
 *      resolves to something else. So these tests PARSE the engine's own
 *      source and compare, rather than asserting the copy against itself.
 *
 *   2. THE ARGV IS REAL. What the panel prints under the tier selector must be
 *      the fragment the engine actually builds, flag for flag.
 *
 *   3. THE ABSENCES ARE REAL. Every "not controllable" entry has to point at a
 *      file:line that exists, and no knob the engine does not have may appear
 *      as a control. This is the direction the defect actually travels: nobody
 *      adds a fake control on purpose, they add a plausible one and nothing
 *      contradicts them.
 *
 * WHAT THIS SUITE CANNOT SEE: whether the control is rendered, reachable, or
 * wired to anything. Source text cannot see reachability — dead code matches a
 * text search exactly as well as live code does. tools/page2-qa.cjs drives the
 * real window for that half.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  DISPATCH_TIERS as LAUNCH_TIERS,
  launchTier,
  tierArgvFragment,
  UNSUPPORTED_CONTROLS,
  ENGINE_ROLES,
  RELATION_TYPES,
  CAP_BOUNDS,
  clampCapMs,
  capMinutes,
  resolveChatChannel,
  SANDBOX_LEVELS,
  sandboxLevel,
} from '../../src/orchestration-controls.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(ROOT, relative), 'utf8')

const ACTIONS = 'capability/src/lib/mission-bridge/actions.js'
const AGENT_ORG = 'capability/src/lib/agent-org.js'

/* ---------------------------------------------------------------
   1 · anti-drift against the engine's own source
   --------------------------------------------------------------- */

test('the tier table matches the engine tier table, name for name', () => {
  const source = read(ACTIONS)
  const block = source.slice(source.indexOf('const TIERS = Object.freeze({'))
  assert.ok(block.startsWith('const TIERS'), 'engine TIERS table not found — this test is checking air')

  const engine = new Map()
  const row = /'?([a-z-]+)'?:\s*Object\.freeze\(\{([^}]*)\}\)/g
  let match
  while ((match = row.exec(block.slice(0, block.indexOf('});')))) !== null) {
    const fields = Object.fromEntries([...match[2].matchAll(/(\w+):\s*'([^']*)'/g)].map(f => [f[1], f[2]]))
    engine.set(match[1], fields)
  }

  assert.equal(engine.size, LAUNCH_TIERS.length,
    `engine declares ${engine.size} tiers, page 2 offers ${LAUNCH_TIERS.length}`)
  for (const tier of LAUNCH_TIERS) {
    const declared = engine.get(tier.id)
    assert.ok(declared, `page 2 offers tier "${tier.id}" which the engine does not declare`)
    assert.equal(tier.provider, declared.provider, `tier ${tier.id} provider drifted`)
    assert.equal(tier.model, declared.model, `tier ${tier.id} model drifted`)
    assert.equal(tier.effort ?? undefined, declared.effort, `tier ${tier.id} effort drifted`)
    if (tier.cliModel) assert.equal(tier.cliModel, declared.cliModel, `tier ${tier.id} cliModel drifted`)
  }
})

test('the nine roles match the engine role vocabulary', () => {
  const source = read(AGENT_ORG)
  const line = /const ROLES = Object\.freeze\(\[([^\]]*)\]\)/.exec(source)
  assert.ok(line, 'engine ROLES list not found — this test is checking air')
  const engine = [...line[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1])
  assert.deepEqual([...ENGINE_ROLES], engine)
})

test('the relationship types match the engine relationship vocabulary', () => {
  const source = read(AGENT_ORG)
  const line = /const RELATION_TYPES = Object\.freeze\(\[([^\]]*)\]\)/.exec(source)
  assert.ok(line, 'engine RELATION_TYPES not found — this test is checking air')
  assert.deepEqual([...RELATION_TYPES], [...line[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]))
})

/* ---------------------------------------------------------------
   2 · the printed argv is the built argv
   --------------------------------------------------------------- */

test('a codex tier prints the flags the engine actually builds', () => {
  const source = read(ACTIONS)
  assert.ok(source.includes("'--model', tier.model, '-c', `model_reasoning_effort=${tier.effort}`"),
    'the codex argv builder no longer ends in --model + model_reasoning_effort; the panel is now printing a fiction')
  assert.deepEqual(tierArgvFragment('sol'), ['--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=xhigh'])
})

test('a claude tier prints --model with the CLI model, and claims no effort', () => {
  const source = read(ACTIONS)
  assert.ok(source.includes("'--model', tier.cliModel"),
    'the claude argv builder no longer passes --model tier.cliModel')
  assert.deepEqual(tierArgvFragment('claude-opus'), ['--model', 'opus'])
  assert.equal(launchTier('claude-opus').effort, null,
    'a claude tier must not advertise a reasoning effort: the claude argv builder passes none')
})

test('an unknown tier yields nothing rather than a plausible default', () => {
  assert.equal(tierArgvFragment('gpt-9'), null)
  assert.equal(launchTier('gpt-9'), null)
})

/* ---------------------------------------------------------------
   3 · the absences are real, and no fake control has crept back
   --------------------------------------------------------------- */

test('every "not controllable" entry points at a file:line that exists', () => {
  assert.ok(UNSUPPORTED_CONTROLS.length > 0, 'the named-absence list is empty')
  for (const item of UNSUPPORTED_CONTROLS) {
    const [file, lineText] = item.evidence.split(':')
    const line = Number(lineText)
    assert.ok(Number.isInteger(line) && line > 0, `${item.id} evidence is not a file:line`)
    const lines = read(file).split(/\r?\n/)
    assert.ok(lines.length >= line, `${item.id} cites ${item.evidence}, but that file has only ${lines.length} lines`)
    assert.ok(item.reason.length > 40, `${item.id} gives a reason too short to be a reason`)
  }
})

test('temperature and top-p are named as absent, never offered as tiers', () => {
  const named = new Set(UNSUPPORTED_CONTROLS.map(item => item.id))
  assert.ok(named.has('temperature'), 'temperature must be NAMED as unavailable, not silently omitted')
  assert.ok(named.has('top-p'), 'top-p must be NAMED as unavailable, not silently omitted')
  for (const tier of LAUNCH_TIERS) {
    for (const key of Object.keys(tier)) {
      assert.ok(!/temperature|top_?p/i.test(key), `tier ${tier.id} carries a "${key}" field the engine cannot send`)
    }
  }
})

test('the engine really has no temperature or top-p on any spawn path', () => {
  /* If this ever fails it is GOOD NEWS and the panel is now the stale one:
     a real knob appeared and page 2 is still telling people it does not exist.
     Either way the two must be reconciled, which is why it is asserted rather
     than assumed. */
  const argvRegion = read(ACTIONS)
  const codex = argvRegion.slice(argvRegion.indexOf('function codexArgs'), argvRegion.indexOf('function laneStartupError'))
  assert.ok(codex.length > 100, 'could not isolate the argv builders — this test is checking air')
  assert.ok(!/temperature|top_p/i.test(codex),
    'the argv builders now mention temperature or top_p; src/orchestration-controls.js must stop claiming they do not exist')
})

test('the page 2 view carries no slider claiming to tune an agent', () => {
  const view = read('src/views/computers.js')
  /* The three that were here — "Context budget", "Wake interval", "Autonomy" —
     wrote a formatted string into a span and did nothing else. Their absence is
     asserted by name so that re-adding one is a deliberate act with a failing
     test attached, not a copy-paste. */
  for (const label of ['Context budget', 'Wake interval', 'Autonomy']) {
    assert.ok(!new RegExp(`<span class="cl">${label}</span>`).test(view),
      `the inert "${label}" slider is back on page 2`)
  }
  assert.ok(!/data-t="(ctx|wake|auto)"/.test(view), 'the inert tuning rows are back on page 2')
})

test('the agent view carries no slider claiming to tune an agent either', () => {
  /* THE SAME THREE SLIDERS, ON A SECOND PAGE, FOUND LATER.
   *
   * Page 2 lost them; src/views/agent.js kept its copy -- "Context budget 124k",
   * "Wake interval 20m", "Verbosity low" -- and that copy was WORSE, because it
   * had no click handler at all. Page 2's at least wrote a formatted string into
   * the span beside them; these three only had `rangeFill`, which paints the
   * track behind the thumb. Dragging one moved the thumb, left the readout on
   * its hardcoded value, and stored, sent and reported nothing. They sat on the
   * page whose own banner says "no control on this page reaches a real session".
   *
   * They were removed rather than wired, because there is no setting, no stored
   * value and no bridge action in this product for any of the three, and wiring
   * them would mean inventing the features first.
   *
   * ASSERTED BY NAME, and asserted for BOTH files in the same suite, because
   * the reason one page fixed this and the other did not is that nothing was
   * looking at the other one. */
  const view = read('src/views/agent.js')
  for (const label of ['Context budget', 'Wake interval', 'Verbosity']) {
    assert.ok(!new RegExp(`<span class="cl">${label}</span>`).test(view),
      `the inert "${label}" slider is back on the agent page`)
  }
  assert.ok(!/input type="range"/.test(view),
    'a range input is back on the agent page; nothing on that page has a value to set')
  /* The absence has to be SAID, not merely left blank. A rail that simply lost
     three rows reads as a panel that failed to load. */
  assert.match(view, /ctl-absent/,
    'the agent page lost the sliders and says nothing where they were; an unexplained gap is its own defect')
})

/* ---------------------------------------------------------------
   4 · the run cap, which is real
   --------------------------------------------------------------- */

test('the cap is clamped to the bounds rather than trusted', () => {
  assert.equal(clampCapMs(0), CAP_BOUNDS.minMs)
  assert.equal(clampCapMs(Number.MAX_SAFE_INTEGER), CAP_BOUNDS.maxMs)
  assert.equal(clampCapMs('not a number'), CAP_BOUNDS.defaultMs)
  assert.equal(clampCapMs(null), CAP_BOUNDS.defaultMs)
  assert.equal(capMinutes(CAP_BOUNDS.defaultMs), 20)
})

test('the cap the engine applies is a real kill, not a label', () => {
  assert.ok(read(ACTIONS).includes('capMs: input.cap.capMs'),
    'dispatch no longer forwards cap.capMs to the lane runner; the time cap control is now decoration')
})

/* ---------------------------------------------------------------
   5 · sandbox is reported, and the levels are the engine's
   --------------------------------------------------------------- */

test('each sandbox level names both engines and says what it refuses', () => {
  for (const [id, level] of Object.entries(SANDBOX_LEVELS)) {
    assert.equal(sandboxLevel(id), level)
    assert.ok(level.codex && level.claude, `${id} does not name both engines`)
    assert.ok(level.summary.length > 20, `${id} does not say what it refuses`)
  }
  assert.equal(sandboxLevel('invented'), null)
})

/* ---------------------------------------------------------------
   6 · the chat channel, which is the next thing that could become a lie
   --------------------------------------------------------------- */

test('a composer is offered only for a session this app owns', () => {
  const owned = resolveChatChannel({ live: true, sessionAvailable: true, sessionAgentId: 'a1', agentId: 'a1' })
  assert.equal(owned.kind, 'session')
  assert.equal(owned.canSend, true)
})

test('a live node with no app-owned session cannot be typed at, and says why', () => {
  const none = resolveChatChannel({ live: true, sessionAvailable: false, agentId: 'a1' })
  assert.equal(none.kind, 'none')
  assert.equal(none.canSend, false)
  assert.ok(none.reason && none.reason.length > 10, 'a refusal with no reason is just a broken box')
})

test("someone else's session does not become this agent's channel", () => {
  const other = resolveChatChannel({ live: true, sessionAvailable: true, sessionAgentId: 'a2', agentId: 'a1' })
  assert.equal(other.kind, 'none')
  assert.equal(other.canSend, false)
  assert.match(other.reason, /a2/)
  assert.match(other.reason, /the computer you are driving/,
    'a relay reader must not be told that the driven machine is this computer')
})

test('the simulated fleet says it is simulated', () => {
  const sim = resolveChatChannel({ live: false, agentId: 'a1' })
  assert.equal(sim.kind, 'simulated')
  assert.equal(sim.canSend, true)
  assert.ok(sim.reason)
})
