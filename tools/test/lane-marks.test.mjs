/* THE SWARM BOX AND THE DRIFT LIGHT, PROVED AS DECISIONS.
 *
 * src/lane-marks.js is the pure half of the cloud lane's two tree marks: given
 * an agent's cloudLane record, what is drawn. These tests walk that decision —
 * the honest-absence rules especially, because the failure worth catching is a
 * mark that appears for a node with nothing to say, or a burn hue claimed for
 * tokens nobody measured.
 *
 * What this file CANNOT see: whether tree-graph.js places the marks, or whether
 * the sheet's blanket animation kill still lets the sweep run. Those halves are
 * proven by driving the packaged window, like every other tree behaviour.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { LANE_BURN_STEPS, laneBurnStep, laneMarksView, readCloudLane } from '../../src/lane-marks.js'

test('no cloudLane record means no marks at all', () => {
  for (const cloudLane of [undefined, null, 'running', 42, [], true]) {
    assert.deepEqual(laneMarksView(cloudLane), { box: null, light: null })
  }
})

test('the box appears only while a swarm is running', () => {
  assert.equal(laneMarksView({ running: false, tokens: 5 }).box, null)
  assert.equal(laneMarksView({ tokens: 5 }).box, null)
  assert.notEqual(laneMarksView({ running: true }).box, null)
})

test('unmeasured tokens keep the neutral edge, never blue', () => {
  const { box } = laneMarksView({ running: true })
  assert.equal(box.hue, null)
  assert.equal(box.word, 'cloud swarm running')
  for (const tokens of [NaN, -1, Infinity, 'many']) {
    assert.equal(laneMarksView({ running: true, tokens }).box.hue, null)
  }
})

test('the burn scale is static and walks blue -> green -> gold -> red', () => {
  assert.equal(laneBurnStep(0).hue, 'blue')
  assert.equal(laneBurnStep(999_999).hue, 'blue')
  assert.equal(laneBurnStep(1_000_000).hue, 'green')
  assert.equal(laneBurnStep(4_999_999).hue, 'green')
  assert.equal(laneBurnStep(5_000_000).hue, 'gold')
  assert.equal(laneBurnStep(9_999_999).hue, 'gold')
  assert.equal(laneBurnStep(10_000_000).hue, 'red')
  assert.equal(laneBurnStep(Number.MAX_SAFE_INTEGER).hue, 'red')
})

test('every burn step carries a word for the title', () => {
  for (const step of LANE_BURN_STEPS) {
    assert.equal(typeof step.word, 'string')
    assert.ok(step.word.length > 0)
  }
})

test('the drift light has exactly two stages and no third', () => {
  assert.deepEqual(laneMarksView({ drift: 'drifting' }).light, { stage: 'gold', word: 'drifting' })
  assert.deepEqual(laneMarksView({ drift: 'off-course' }).light, { stage: 'red', word: 'off course' })
  /* below gold the lamp does not exist — including any "good" word a future
     layer might file, and junk */
  for (const drift of [undefined, null, '', 'ok', 'on-target', 'green', 'yellow', 'red', 0, {}]) {
    assert.equal(laneMarksView({ running: true, drift }).light, null)
  }
})

test('the light does not need the box: drift can outlive the run', () => {
  const view = laneMarksView({ running: false, drift: 'off-course' })
  assert.equal(view.box, null)
  assert.equal(view.light.stage, 'red')
})

test('the metadata reader returns a separate immutable copy of only measured fields', () => {
  const input = { running: true, tokens: 1_000_000, drift: 'drifting', taskCount: 100, usedPercent: 80 }
  const result = readCloudLane(input)
  assert.deepEqual(result, { running: true, tokens: 1_000_000, drift: 'drifting' })
  assert.notEqual(result, input)
  assert.ok(Object.isFrozen(result))
  input.running = false
  input.tokens = 10_000_000
  input.drift = 'off-course'
  assert.deepEqual(result, { running: true, tokens: 1_000_000, drift: 'drifting' }, 'later source writes cannot alter a forwarded measurement')
})

test('invalid records and unrecognized fields cannot invent cloud lane state', () => {
  for (const input of [undefined, null, false, true, 0, 'running', [], new Date(), {},
    { taskCount: 100, state: 'RUNNING', usedPercent: 90 }, { running: 'true', tokens: '100', drift: 'red' }]) {
    assert.equal(readCloudLane(input), null)
    assert.deepEqual(laneMarksView(input), { box: null, light: null })
  }
})

test('only literal booleans declare whether a swarm is running', () => {
  assert.deepEqual(readCloudLane({ running: false }), { running: false })
  assert.deepEqual(readCloudLane({ running: true }), { running: true })
  for (const running of [1, 0, 'true', 'false', [], {}, new Boolean(true), null]) {
    assert.equal(readCloudLane({ running }), null)
    assert.equal(laneMarksView({ running, tokens: 1 }).box, null)
  }
})

test('unmeasured token values cannot acquire a burn hue while a valid swarm stays neutral', () => {
  for (const tokens of [undefined, null, false, true, -1, NaN, Infinity, -Infinity, '0', [], {}, 1n, Symbol('tokens')]) {
    assert.equal(laneBurnStep(tokens), null)
    assert.deepEqual(readCloudLane({ running: true, tokens }), { running: true })
    assert.deepEqual(laneMarksView({ running: true, tokens }).box, { hue: null, word: 'cloud swarm running' })
  }
})

test('forwarding preserves measured zero, every exact threshold, and valid fractional readings', () => {
  for (const [tokens, hue] of [[0, 'blue'], [999_999.5, 'blue'], [1_000_000, 'green'],
    [4_999_999.5, 'green'], [5_000_000, 'gold'], [9_999_999.5, 'gold'], [10_000_000, 'red']]) {
    assert.equal(readCloudLane({ tokens }).tokens, tokens)
    assert.equal(laneMarksView({ running: true, tokens }).box.hue, hue)
  }
})

test('drift requires an exact supported string and never resolves inherited object keys', () => {
  for (const drift of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'Drifting', 'drifting ',
    ['drifting'], new String('drifting'), { toString: () => 'off-course' }, Symbol('drifting')]) {
    assert.equal(readCloudLane({ drift }), null)
    assert.equal(laneMarksView({ running: true, drift }).light, null)
  }
  assert.deepEqual(readCloudLane({ drift: 'drifting' }), { drift: 'drifting' })
  assert.deepEqual(readCloudLane({ drift: 'off-course' }), { drift: 'off-course' })
})

test('inherited metadata never creates a mark or contributes a burn measurement', () => {
  const inherited = Object.create({ running: true, tokens: 10_000_000, drift: 'off-course' })
  assert.equal(readCloudLane(inherited), null)
  assert.deepEqual(laneMarksView(inherited), { box: null, light: null })
  inherited.running = true
  assert.deepEqual(readCloudLane(inherited), { running: true })
  assert.deepEqual(laneMarksView(inherited), { box: { hue: null, word: 'cloud swarm running' }, light: null })
})

test('normalizing an own-field record does not execute accessors', () => {
  let reads = 0
  const input = { running: true, get tokens() { reads++; throw new Error('not a measurement') },
    get drift() { reads++; return 'off-course' } }
  assert.deepEqual(readCloudLane(input), { running: true })
  assert.deepEqual(laneMarksView(input), { box: { hue: null, word: 'cloud swarm running' }, light: null })
  assert.equal(reads, 0)
})

test('a stopped swarm hides its box while its explicitly reported drift remains visible', () => {
  const record = Object.assign(Object.create(null), { running: false, tokens: 10_000_000, drift: 'off-course' })
  assert.deepEqual(readCloudLane(record), { running: false, tokens: 10_000_000, drift: 'off-course' })
  assert.deepEqual(laneMarksView(record), { box: null, light: { stage: 'red', word: 'off course' } })
})

/* THE "SWARM BOX ON EVERY NODE" REGRESSION — reported by the owner 2026-09-16:
 * every agent box on the Computers tree showed the swarm box, permanently. The
 * swarm box is a CLOUD LANE mark: it must ride only a node that is actually
 * running a cloud swarm, and clear the moment that swarm stops. tree-graph.js's
 * _renderLaneMarks decides one node's marks as laneMarksView(readCloudLane(
 * agent.cloudLane)) and draws the box iff `.box` is non-null, so this walks the
 * gate at that exact composition — an ordinary node (no cloud lane) draws none,
 * a node with a swarm in flight draws one, and the SAME node draws none once
 * `running` goes false. (The DOM placement/removal half is proven against the
 * packaged window in tools/test/fixtures/run-tree-indicators.mjs.) */
test('the swarm box rides only a node with a cloud swarm in flight, never every node', () => {
  // Exactly what tree-graph.js _renderLaneMarks reduces one node's box to.
  const boxFor = agent => laneMarksView(readCloudLane(agent.cloudLane)).box

  // An ordinary local/agent node carries no cloud lane at all -> no box.
  assert.equal(boxFor({ id: 'terra-02', role: 'worker', provider: 'local' }), null,
    'an ordinary local node never draws the swarm box')

  // A whole ordinary fleet draws ZERO boxes: the "on every node, always" report
  // cannot come from the render path with cloud-lane-free agents. An agent that
  // merely carries an EMPTY lane object is still ordinary and draws nothing —
  // presence of a cloud-lane object is not a running swarm.
  const ordinaryFleet = [
    { id: 'codex', provider: 'codex' }, { id: 'claude', provider: 'claude' },
    { id: 'gem-1', provider: 'gemini' }, { id: 'local-1', provider: 'local' },
    { id: 'empty-lane', provider: 'codex', cloudLane: {} },
    { id: 'lane-no-running', provider: 'codex', cloudLane: { tokens: 9_000_000 } },
  ]
  assert.equal(ordinaryFleet.filter(agent => boxFor(agent) !== null).length, 0,
    'no node without a running swarm draws a box, empty/absent-running lanes included')

  // A node actually running a cloud swarm DOES draw the box (feature intact).
  const cloudNode = { id: 'cloud-lane', provider: 'codex', cloudLane: { running: true, tokens: 2_000_000 } }
  const runningBox = boxFor(cloudNode)
  assert.notEqual(runningBox, null, 'a node running a cloud swarm draws the swarm box')
  assert.equal(runningBox.hue, 'green', 'and carries its measured token-burn hue')

  // The SAME node draws no box once its swarm finishes (running -> false).
  assert.equal(boxFor({ ...cloudNode, cloudLane: { running: false, tokens: 2_000_000 } }), null,
    'the swarm box clears the moment the swarm stops running')
})
