/* THE FENCE BETWEEN THE MADE-UP NUMBERS AND THE MEASURED ONES.
 *
 * WHY THIS SUITE EXISTS AT ALL. The metrics page has two faces: a demonstration
 * whose series come from src/sim.js, and a face that reads this computer's own
 * signed records. For months the second face had no charts, and the reason was a
 * rule a person had to remember -- "never initialise the chart engine in live
 * mode" -- written to stop a SIMULATED series being drawn on a panel a reader
 * takes for a measurement. In a research product that would be data fraud by
 * accident: a shape nobody measured, on a page whose whole promise is that it
 * only shows what happened here.
 *
 * The charts are back on both faces, so the rule is replaced by two structural
 * facts that a person cannot forget to apply, and this file is what makes them
 * facts rather than intentions:
 *
 *   1. src/metrics-live-charts.js cannot SEE the simulation. The first test
 *      walks its whole import graph and fails if any path reaches src/sim.js,
 *      src/vocab.js, src/fleet-profile.js or src/metrics-charts.js.
 *   2. A measured host cannot be handed anything else. Every option the measured
 *      feeders build carries a mark from a Symbol private to that module, and
 *      draw() refuses an option without it -- so a simulated option reaching a
 *      measured panel is an exception, not a picture.
 *
 * BOTH GUARDS WERE PROVED RED BEFORE THEY WERE TRUSTED, in a detached worktree
 * that was thrown away: adding `import { sim } from './sim.js'` to the live
 * module failed test 1 naming the path, and drawing an option built anywhere
 * else failed test 2. A guard nobody has seen fail is a guard nobody has tested.
 *
 * The rest of the file is about the other half of the same promise: the numbers
 * a measured chart draws must be traceable to the record, a cumulative reading
 * must never be summed, and the Range control must genuinely re-project.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  activityMatrix,
  activityOption,
  burnOption,
  createLiveCharts,
  isMeasuredOption,
  liveWindow,
  outcomeOption,
  refusalOption,
  routingFlows,
  routingOption,
  tokenBandOption,
  tokenBands,
  turnCounts,
  turnStripOption,
  turnsInWindow,
} from '../../src/metrics-live-charts.js'
import { LOCAL_USAGE_COPY, usageByAccount, usageByAgent, usageByProvider } from '../../src/local-metrics.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE_ROOT = path.join(REPO_ROOT, 'src')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/* ================= 1. the import fence ================= */

/* The four modules a measured chart must not be able to reach. sim.js builds the
   demonstration's series; vocab.js and fleet-profile.js are the declared fleet it
   builds them out of; metrics-charts.js is the demonstration's own option
   builders. A path to any of them is a path a series could travel. */
const FORBIDDEN = ['vocab.js','sim.js',  'fleet-profile.js', 'metrics-charts.js']

/* Relative imports only -- a bare specifier is a package, and no package in this
   tree is one of the four. The regular expression covers `import x from`,
   `import {a} from`, bare `import` and `export ... from`. */
function relativeImports(file) {
  const source = readFileSync(file, 'utf8')
  const found = new Set()
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?['"](\.[^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) found.add(match[1])
  /* Dynamic import is a path too, and a fence that only reads static imports is
     a fence with a gate in it. */
  for (const match of source.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) found.add(match[1])
  return [...found]
}

function walkImports(entry) {
  const seen = new Set()
  const paths = new Map()
  const queue = [[entry, [path.relative(REPO_ROOT, entry)]]]
  while (queue.length > 0) {
    const [file, trail] = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    paths.set(file, trail)
    for (const specifier of relativeImports(file)) {
      const next = path.resolve(path.dirname(file), specifier)
      if (!next.startsWith(SOURCE_ROOT)) continue
      queue.push([next, [...trail, path.relative(REPO_ROOT, next)]])
    }
  }
  return paths
}

test('the measured chart module cannot reach the simulation, at any depth', () => {
  const reached = walkImports(path.join(SOURCE_ROOT, 'metrics-live-charts.js'))
  /* The walk must have actually walked. A fence that resolves nothing passes
     every time, which is the same defect tools/check-suites-discovered.mjs
     exists to stop one level up. */
  assert.ok(reached.size > 1, 'the import walk found no imports at all, so it proved nothing')
  for (const [file, trail] of reached) {
    const name = path.basename(file)
    assert.ok(
      !FORBIDDEN.includes(name),
      `a measured chart can reach the simulation through ${trail.join(' -> ')}`,
    )
  }
})

test('the fence would catch a path to the simulation if one appeared', () => {
  /* THE RED PROOF, RUN EVERY TIME rather than remembered from the day it was
     written. This used to start the walk from metrics-charts.js -- the
     demonstration's own chart module -- whose import of vocab.js proved the
     walker could see a forbidden edge. That module was DELETED with the second
     render, and a positive control that dies of ENOENT proves nothing: the
     fence above would then be green whether or not the walk still detects
     anything. So the offending module is synthesised on the spot -- a temp file
     importing vocab.js by the same relative shape a real regression would use
     -- and the walk MUST find the forbidden edge through it. If this assertion
     ever fails, the walk has stopped detecting anything and the test above is
     green for the wrong reason. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-positive-control-'))
  const offender = path.join(dir, 'offender.js')
  try {
    /* The walker follows only relative specifiers and only ones that resolve
       into SOURCE_ROOT (walkImports above) -- exactly the shape a real
       regression inside src/ would take. So the offender imports vocab.js by
       the relative chain from the temp dir: a `../..` path is a relative
       specifier to the extractor, and it resolves inside SOURCE_ROOT for the
       boundary check. An absolute path would be invisible to both. */
    const vocab = path.relative(dir, path.join(SOURCE_ROOT, 'vocab.js')).split(path.sep).join('/')
    fs.writeFileSync(offender, `import { ROLES } from '${vocab}'\nexport const leak = ROLES\n`)
    const reached = walkImports(offender)
    const names = [...reached.keys()].map(file => path.basename(file))
    assert.ok(
      names.some(name => FORBIDDEN.includes(name)),
      'the walk found no forbidden module from a file that imports one directly, so it cannot be detecting them',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ================= 2. the mint ================= */

/* A host resolver that answers nothing: draw() checks the mark BEFORE it looks
   for an element, so the refusal is measurable with no browser at all. */
const noHosts = () => createLiveCharts({ resolve: () => null })

test('a chart this module did not build is refused rather than drawn', () => {
  const charts = noHosts()
  /* Shaped exactly like a demonstration option: a real series, real numbers, a
     real id. Nothing about it looks wrong. That is the point -- the mark is what
     tells them apart, not the shape. */
  const simulatedLooking = {
    series: [{ id: 'routing', type: 'line', data: [12.4, 18.1, 22.9] }],
    xAxis: { type: 'category', data: ['0', '1', '2'] },
  }
  assert.equal(isMeasuredOption(simulatedLooking), false)
  assert.throws(() => charts.draw('hero', simulatedLooking), /measured panel/)
  charts.dispose()
})

test('the mark cannot be forged by copying the fields of a measured option', () => {
  const window = liveWindow('7d', Date.UTC(2026, 7, 18, 12))
  const option = tokenBandOption({ bands: tokenBands(sampleTurns(), window), window, theme: THEME })
  assert.equal(isMeasuredOption(option), true)
  /* A spread copies enumerable own properties. The mark is not one, so the copy
     is refused -- which is what stops "I rebuilt the option over there" from
     becoming a way past the fence. */
  assert.equal(isMeasuredOption({ ...option }), false)
  const charts = noHosts()
  assert.throws(() => charts.draw('hero', { ...option }), /measured panel/)
  /* And the real one is accepted: with no host it simply draws nothing, which
     is a different outcome from being refused. */
  assert.equal(charts.draw('hero', option), null)
  charts.dispose()
})

/* ================= 3. nothing measured, nothing drawn ================= */

const THEME = {
  ink: '#0e1726', ink2: '#4f5f70', ink25: '#5a6876', ink3: '#64727f',
  grid: '#eeeeee', cross: '#cccccc', track: '#f0f0f0',
  good: '#0a6d3c', warn: '#8f5902', serious: '#b23811',
  bg: '#ffffff', sheet: '#ffffff', poolAccent: '#5c6b7a', signal: '#34495e',
  heat: ['#f4f4f4', '#d0e2ff', '#a6c8ff', '#78a9ff', '#4589ff', '#0f62fe'],
  prov: { codex: '#0f62fe', claude: '#8a3ffc', gemini: '#007d79', local: '#6f6f6f' },
  font: 'sans-serif', mono: 'monospace', dark: false,
  sankeyRest: 0.24, sankeyMid: 0.31, sankeyHover: 0.58,
}

test('an empty record draws no chart at all', () => {
  const window = liveWindow('7d', Date.UTC(2026, 7, 18, 12))
  const bands = tokenBands([], window)
  const counts = turnCounts([], window)
  const activity = activityMatrix([], window)
  const flows = routingFlows([])
  assert.equal(bands.ok, false)
  assert.equal(counts.ok, false)
  assert.equal(activity.ok, false)
  assert.equal(flows.ok, false)
  /* Every feeder answers null rather than an option with a zero in it. A pretty
     empty chart is a shape a person reads as a measurement of nothing. */
  assert.equal(tokenBandOption({ bands, window, theme: THEME }), null)
  assert.equal(turnStripOption({ counts, window, theme: THEME }), null)
  assert.equal(activityOption({ activity, theme: THEME, hourTicks: [0, 6, 12, 18] }), null)
  assert.equal(routingOption({ flows, theme: THEME }), null)
  assert.equal(burnOption({ bands, window, theme: THEME }), null)
  assert.equal(outcomeOption({ outcomes: { ok: true, total: 0, segments: [] }, theme: THEME }), null)
  assert.equal(refusalOption({ refusals: { ok: true, rows: [] }, theme: THEME }), null)
})

test('an unreadable reading draws no chart either', () => {
  assert.equal(outcomeOption({ outcomes: { ok: false, absence: 'not readable' }, theme: THEME }), null)
  assert.equal(refusalOption({ refusals: { ok: false, absence: 'not readable' }, theme: THEME }), null)
  assert.equal(activityOption({ activity: { ok: false }, theme: THEME, hourTicks: [] }), null)
})

/* ================= 4. every number is traceable ================= */

const NOW = Date.UTC(2026, 7, 18, 12, 30)

function sampleTurns() {
  return [
    { sequence: 5, atMs: NOW - 2 * HOUR, sessionId: 's1', tier: 'luna', account: 'work@example.com', basis: 'turn', totalTokens: 900, derivedTotal: false },
    { sequence: 4, atMs: NOW - 3 * HOUR, sessionId: 's1', tier: 'luna', account: 'work@example.com', basis: 'turn', totalTokens: 600, derivedTotal: false },
    { sequence: 3, atMs: NOW - 2 * DAY, sessionId: 's2', tier: 'claude-sonnet', account: 'home@example.com', basis: 'turn', totalTokens: 400, derivedTotal: true },
    { sequence: 2, atMs: NOW - 20 * DAY, sessionId: 's3', tier: 'claude-opus', account: 'home@example.com', basis: 'turn', totalTokens: 250, derivedTotal: false },
  ]
}

test('every value a token band draws is the sum of recorded turns in that bucket', () => {
  const window = liveWindow('7d', NOW)
  const turns = sampleTurns()
  const bands = tokenBands(turns, window)
  const option = tokenBandOption({ bands, window, theme: THEME })
  const drawn = option.series.flatMap(series => series.data)
  const plotted = drawn.reduce((sum, value) => sum + value, 0)
  const scoped = turnsInWindow(turns, window)
  const recorded = scoped.reduce((sum, turn) => sum + turn.totalTokens, 0)
  assert.equal(plotted, recorded)
  assert.equal(bands.total, recorded)
  /* And it is genuinely a subset of the record: the 20-day-old turn is outside
     a seven-day window and is not on the chart. */
  assert.equal(recorded, 900 + 600 + 400)
  /* Each band is one assistant, named from the same table the start control
     uses -- never a hue with no name behind it. */
  assert.deepEqual(option.series.map(series => series.name).sort(), ['Claude', 'Codex'])
})

test('a running total is never added to a bucket', () => {
  /* shell/usage-record.cjs marks a cumulative reading `session-total`. Summing
     one per turn multiplies a session's usage by its number of turns, and
     placing it on a day spikes that day with tokens spent across many. */
  const window = liveWindow('24h', NOW)
  const cumulative = [
    { sequence: 3, atMs: NOW - HOUR, sessionId: 's9', tier: 'luna', account: 'a', basis: 'session-total', totalTokens: 5000 },
    { sequence: 2, atMs: NOW - 2 * HOUR, sessionId: 's9', tier: 'luna', account: 'a', basis: 'session-total', totalTokens: 3000 },
    { sequence: 1, atMs: NOW - 3 * HOUR, sessionId: 's9', tier: 'luna', account: 'a', basis: 'turn', totalTokens: 120 },
  ]
  const bands = tokenBands(cumulative, window)
  assert.equal(bands.total, 120)
  /* The routing diagram may use it -- a session whose only figure is cumulative
     still used something -- but it takes the LARGEST, never the sum. */
  const flows = routingFlows(cumulative.filter(turn => turn.basis === 'session-total'))
  assert.equal(flows.total, 5000)
})

test('activity heatmap omits unmeasured hours but retains recorded zero hours', () => {
  const at = hour => new Date(2026, 8, 6, hour).getTime()
  const window = { startMs: at(8) + 1000, endMs: at(11) }
  const activity = activityMatrix([{ atMs: at(9), result: 'started' }], window)
  const option = activityOption({ activity, theme: THEME, hourTicks: [0, 6, 12, 18] })
  assert.deepEqual(option.series[0].data, [[8, 0, 0], [9, 0, 1], [10, 0, 0]])
})

test('runs are counted into the hour they happened, and nothing else is', () => {
  const window = liveWindow('7d', NOW)
  const runs = [
    { atMs: NOW - HOUR, result: 'started' },
    { atMs: NOW - HOUR - 60_000, result: 'started' },
    { atMs: NOW - 3 * DAY, result: 'refused' },
    { atMs: NOW - 40 * DAY, result: 'started' },
    { atMs: null, result: 'started' },
  ]
  const activity = activityMatrix(runs, window)
  assert.equal(activity.total, 3)
  assert.equal(activity.max, 2)
  const option = activityOption({ activity, theme: THEME, hourTicks: [0, 6, 12, 18] })
  const cells = option.series[0].data
  const drawnRuns = cells.reduce((sum, [, , runsHere]) => sum + runsHere, 0)
  assert.equal(drawnRuns, activity.total)
  /* Shaded against the busiest REAL hour: a quiet week must not be normalised
     into a full-looking one. */
  assert.equal(option.visualMap.max, 2)
})

/* ================= 4b. a day is not always 24 hours =================
 *
 * Both dates below are read from this machine's own clock, the same clock
 * every function under test reads from -- there is no fake timer here, only
 * real Date arithmetic on real transition dates. 2026-03-08 is when clocks
 * in this zone spring forward (a 23-hour day) and 2026-11-01 is when they
 * fall back (a 25-hour day). The calendar bucket assertions also apply in a
 * zone without daylight saving. The missing-hour controls below explicitly
 * exercise UTC and Los Angeles in fresh Node processes so each module's
 * cached date formatter and Date arithmetic use the same measured zone.
 */

test('a 7-day window keeps exactly one bucket per calendar day across a spring-forward change, and a late reading lands in its own day', () => {
  const nowMs = new Date(2026, 2, 12, 9, 0, 0, 0).getTime() // Thu Mar 12, five days after the change
  const window = liveWindow('7d', nowMs)
  assert.deepEqual(window.buckets.map(b => b.dateLabel),
    ['Mar 6', 'Mar 7', 'Mar 8', 'Mar 9', 'Mar 10', 'Mar 11', 'Mar 12'])
  /* Today's own bucket is the window's last -- the day this crossing used to
     push clean off the end. */
  assert.equal(window.buckets.at(-1).dateLabel, 'Mar 12')

  const lastNightOfMar8 = { atMs: new Date(2026, 2, 8, 23, 0, 0, 0).getTime(), tier: 'claude', totalTokens: 111, basis: 'turn', derivedTotal: false }
  const earlyMar9 = { atMs: new Date(2026, 2, 9, 0, 30, 0, 0).getTime(), tier: 'claude', totalTokens: 222, basis: 'turn', derivedTotal: false }
  const bands = tokenBands([lastNightOfMar8, earlyMar9], window)
  assert.equal(bands.total, 333)
  const [band] = bands.bands
  assert.deepEqual(band.values.map((value, index) => [window.buckets[index].dateLabel, value]).filter(([, value]) => value > 0),
    [['Mar 8', 111], ['Mar 9', 222]])

  const counts = turnCounts([lastNightOfMar8, earlyMar9], window)
  assert.equal(counts.total, 2)
  assert.deepEqual(counts.values, [0, 0, 1, 1, 0, 0, 0])
})

for (const [zone, offsets, missingHour] of [
  ['Etc/UTC', [0, 0], false],
  ['America/Los_Angeles', [480, 420], true],
]) test(`activity heatmap keeps every calendar day and its real hours in ${zone}`, () => {
  const module = new URL('../../src/metrics-live-charts.js', import.meta.url).href
  const measured = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { liveWindow, activityMatrix, activityOption } from ${JSON.stringify(module)};
    const window = liveWindow('7d', new Date(2026, 2, 12, 9).getTime());
    const runs = [{ atMs: new Date(2026, 2, 8, 23).getTime(), result: 'started' }];
    const activity = activityMatrix(runs, window);
    const cells = activityOption({ activity, theme: ${JSON.stringify(THEME)}, hourTicks: [] }).series[0].data;
    const offsets = [new Date(2026, 2, 8).getTimezoneOffset(), new Date(2026, 2, 9).getTimezoneOffset()];
    console.log(JSON.stringify({ activity, cells, offsets }));
  `], { env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true })
  assert.ifError(measured.error)
  assert.equal(measured.status, 0, measured.stderr)
  assert.equal(measured.signal, null)
  const { activity, cells, offsets: actualOffsets } = JSON.parse(measured.stdout)
  assert.deepEqual(actualOffsets, offsets, 'the selected Node must actually observe the requested clock transition')
  assert.equal(activity.rows.length, 7)
  assert.equal(new Set(activity.rows.map(row => row.dateLabel)).size, 7, 'no calendar day is named twice')
  assert.deepEqual(activity.rows.map(row => row.dateLabel),
    ['Mar 6', 'Mar 7', 'Mar 8', 'Mar 9', 'Mar 10', 'Mar 11', 'Mar 12'])
  assert.equal(activity.total, 1)
  assert.equal(activity.counts[2][2], missingHour ? null : 0, 'only a nonexistent spring hour is absent from measured coverage')
  assert.equal(cells.some(([hour, day]) => day === 2 && hour === 2), !missingHour)
  assert.deepEqual(cells.filter(([, , count]) => count > 0), [[23, 2, 1]], 'the actual late reading stays in its calendar day')
})

test('a fall-back change does not print one calendar day twice, on the bands or the heatmap', () => {
  const nowMs = new Date(2026, 10, 6, 9, 0, 0, 0).getTime() // Fri Nov 6, five days after the change
  const window = liveWindow('7d', nowMs)
  assert.deepEqual(window.buckets.map(b => b.dateLabel),
    ['Oct 31', 'Nov 1', 'Nov 2', 'Nov 3', 'Nov 4', 'Nov 5', 'Nov 6'])

  const lastNightOfNov1 = { atMs: new Date(2026, 10, 1, 23, 0, 0, 0).getTime(), tier: 'claude', totalTokens: 111, basis: 'turn', derivedTotal: false }
  const earlyNov2 = { atMs: new Date(2026, 10, 2, 0, 30, 0, 0).getTime(), tier: 'claude', totalTokens: 222, basis: 'turn', derivedTotal: false }
  const bands = tokenBands([lastNightOfNov1, earlyNov2], window)
  assert.equal(bands.total, 333)
  const [band] = bands.bands
  assert.deepEqual(band.values.map((value, index) => [window.buckets[index].dateLabel, value]).filter(([, value]) => value > 0),
    [['Nov 1', 111], ['Nov 2', 222]])

  const activity = activityMatrix(
    [{ atMs: lastNightOfNov1.atMs, result: 'started' }, { atMs: earlyNov2.atMs, result: 'started' }],
    window,
  )
  assert.equal(activity.rows.length, 7)
  assert.equal(new Set(activity.rows.map(row => row.dateLabel)).size, 7, 'no calendar day is named twice')
  assert.equal(activity.total, 2)
})

/* ================= 5. the Range control genuinely re-projects ================= */

test('a different range is a different projection, not the same picture', () => {
  const turns = sampleTurns()
  const day = tokenBands(turns, liveWindow('24h', NOW))
  const week = tokenBands(turns, liveWindow('7d', NOW))
  const month = tokenBands(turns, liveWindow('30d', NOW))
  assert.equal(day.total, 1500)
  assert.equal(week.total, 1900)
  assert.equal(month.total, 2150)
  assert.equal(day.stacked.length, 25, 'the rolling day has two partial hours at its edges')
  assert.equal(week.stacked.length, 7)
  assert.equal(month.stacked.length, 30)
})

/* ================= 6. the routing agrees with the panels beside it ================= */

/* The same reply shape mc-agent:usage returns, so the two readers under test are
   given identical input rather than two hand-written versions of it. */
function usageRecord(turns) {
  return {
    supported: true, tooOld: false, readable: true, verified: true,
    total: turns.length, turns,
  }
}

test('the routing columns add up to exactly what the readings say', () => {
  /* THE DIVERGENCE THIS PREVENTS. The routing diagram needs a joint key -- which
     sign-in, through which assistant, to which agent -- that no export in
     src/local-metrics.js answers, so the session collapse is repeated in the
     chart module. Two implementations of one rule is how a chart comes to
     disagree with the panel beside it, so they are compared here on a record
     that includes the case they could disagree about: a cumulative row. */
  const turns = [
    ...sampleTurns(),
    { sequence: 6, atMs: NOW - HOUR, sessionId: 's4', tier: 'luna', account: 'work@example.com', basis: 'session-total', totalTokens: 7000 },
  ]
  const record = usageRecord(turns)
  const conversations = new Map([['s1', { role: 'Reader' }], ['s2', { role: 'Writer' }]])
  const flows = routingFlows(turns, { conversations })

  const columnTotal = (kind) => flows.nodes
    .filter(node => node.kind === kind)
    .reduce((sum, node) => sum + node.routed, 0)

  assert.equal(columnTotal('sign-in'), usageByAccount(record).total)
  assert.equal(columnTotal('assistant'), usageByProvider(record).total)
  assert.equal(columnTotal('agent'), usageByAgent(record, { conversations }).total)
  assert.equal(flows.total, usageByAccount(record).total)

  /* And a run this page holds no conversation for gets a row saying so, never a
     made-up name and never a dropped flow. */
  const agents = flows.nodes.filter(node => node.kind === 'agent').map(node => node.label)
  assert.ok(agents.includes('Not named on this computer'))
})

test('a flow with no sign-in is labelled the way the sign-in panel labels one', () => {
  /* THE DIAGRAM AND THE PANEL BESIDE IT ARE ONE PICTURE. This module keeps its
     labels typed out under the fence rule its PROVIDER_LABELS comment states, so
     nothing but a value check holds its wording to ../../src/local-metrics.js's.
     BOTH are read here and neither spelling is written down in this file, so a
     better sentence in either place passes as long as the two still say the same
     thing to a reader.

     And the sign-in absence must not be the MODEL absence: an unattributed
     sign-in and an unnamed model row are different answers, and while they
     shared three words a real attribution defect read as an ordinary gap. */
  const turns = [{ sequence: 1, atMs: NOW - HOUR, sessionId: 's1', tier: 'luna', account: null, basis: 'turn', totalTokens: 500 }]
  const flows = routingFlows(turns, { conversations: new Map() })
  const signIns = flows.nodes.filter(node => node.kind === 'sign-in').map(node => node.label)
  assert.deepEqual(signIns, [LOCAL_USAGE_COPY.accountUnrecorded])
  assert.notEqual(LOCAL_USAGE_COPY.accountUnrecorded, LOCAL_USAGE_COPY.providerUnrecorded)
})

test('the routing option draws only flows the record holds', () => {
  const turns = sampleTurns()
  const flows = routingFlows(turns, { conversations: new Map([['s1', { role: 'Reader' }]]) })
  const option = routingOption({ flows, theme: THEME })
  const drawn = option.series[0].links.reduce((sum, link) => sum + link.value, 0)
  /* Two hops per session (sign-in to assistant, assistant to agent), so the
     drawn edge total is twice the tokens -- and exactly twice, which is what
     says no third flow was invented anywhere. */
  assert.equal(drawn, flows.total * 2)
  const node = option.series[0].data[0]
  const tooltip = option.tooltip.formatter({ dataType: 'node', data: node })
  assert.ok(tooltip.includes(node.label2), 'node tooltip preserves the full recorded name')
  assert.ok(!tooltip.includes('undefined'))
})

/* ================= 7. the outcome split keeps the third segment ================= */

test('an outcome nobody recorded stays its own segment', () => {
  const outcomes = {
    ok: true,
    total: 10,
    segments: [
      { key: 'started', label: 'Started', count: 6, share: 0.6 },
      { key: 'refused', label: 'Did not start', count: 3, share: 0.3 },
      { key: 'unrecorded', label: 'Not recorded', count: 1, share: 0.1 },
    ],
  }
  const option = outcomeOption({ outcomes, theme: THEME })
  assert.deepEqual(option.series.map(series => series.id), ['started', 'refused', 'unrecorded'])
  assert.deepEqual(option.series.map(series => series.data[0]), [6, 3, 1])
  /* Silence read as success is the defect the run reading exists to prevent, so
     the unrecorded segment wears a neutral rather than a shade of either of the
     other two. */
  const unrecorded = option.series.find(series => series.id === 'unrecorded')
  assert.equal(unrecorded.itemStyle.color, THEME.ink3)
})

test('a refusal is drawn as its sentence and its count, never as a code', () => {
  const refusals = {
    ok: true,
    rows: [
      { sentence: 'No agent host is set up on this computer.', count: 4, share: 0.8 },
      { sentence: 'The record does not say why', count: 1, share: 0.2 },
    ],
  }
  const option = refusalOption({ refusals, theme: THEME })
  assert.deepEqual(option.yAxis.data, refusals.rows.map(row => row.sentence))
  assert.deepEqual(option.series[0].data, [4, 1])
  /* Counts, not rates: the axis steps in whole runs. */
  assert.equal(option.xAxis.minInterval, 1)
})

/* T1591: the charts gave a screen reader only their axis ticks: Token flow
   read '0 / 3,000 / ... / 06:00' and Run activity its day and hour labels,
   with none of the amounts. Every drawn chart's host is one image whose text
   alternative is built from the same option the chart was drawn from. */
test('each chart says in words what its data shows, from the option it was drawn from', async () => {
  const { chartSummary, labelChart } = await import('../../src/metrics-chart-summary.js').catch(() => ({}))
  assert.ok(chartSummary && labelChart, 'the charts still give a screen reader nothing but tick marks')
  const window = liveWindow('7d', NOW)
  const bands = tokenBands(sampleTurns(), window)
  const tokenOption = tokenBandOption({ bands, window, theme: THEME })
  const tokens = chartSummary('Token flow', tokenOption)
  assert.match(tokens, /^Token flow\. /)
  assert.equal(tokenOption.series.length, 2)
  for (const series of tokenOption.series) {
    const total = series.data.reduce((sum, value) => sum + value, 0).toLocaleString('en-US')
    assert.ok(tokens.includes(`${series.name}: ${total} in all`), `the amount for ${series.name} (${total}) is missing: ${tokens}`)
  }
  assert.match(tokens, /highest [\d,]+ at \S/, 'the summary does not say when the peak was')

  const at = hour => new Date(2026, 8, 6, hour).getTime()
  const activity = activityMatrix([{ atMs: at(9), result: 'started' }, { atMs: at(9) + 60_000, result: 'started' }, { atMs: at(10), result: 'started' }], { startMs: at(8) + 1000, endMs: at(11) })
  const runs = chartSummary('Run activity', activityOption({ activity, theme: THEME, hourTicks: [0, 6, 12, 18] }))
  assert.match(runs, /3 in all, busiest 2 \([^)]*hour 9\)/, `the heatmap gives no counts: ${runs}`)

  const flows = routingFlows(sampleTurns())
  const routing = chartSummary('Token routing', routingOption({ flows, theme: THEME }))
  assert.match(routing, /flows?, largest .+ to .+ [\d,]+/, `the routing diagram gives no amounts: ${routing}`)

  assert.equal(chartSummary('Run results', null), 'Run results. Nothing is drawn yet.')

  const attributes = new Map()
  const host = { setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name) ?? null, closest: () => ({ querySelector: () => ({ textContent: '  Token flow ' }) }) }
  labelChart(host, tokenOption)
  assert.equal(attributes.get('role'), 'img')
  assert.equal(attributes.get('aria-label'), tokens)
})

test('the measured charts label their host every time they draw', () => {
  const source = readFileSync(new URL('../../src/metrics-live-charts.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ labelChart \} from '\.\/metrics-chart-summary\.js'/)
  assert.match(source, /instance\.setOption\(option, \{ notMerge: true \}\)\n\s*\/\/[^\n]*\n\s*labelChart\(host, option\)/, 'a chart can be drawn without its text alternative')
})
