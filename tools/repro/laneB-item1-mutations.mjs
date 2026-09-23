#!/usr/bin/env node
/* LANE B ITEM 1 -- every mutation gate, with its edit PROVEN to have applied.
 *
 * WHY THE MATCH COUNT IS THE POINT. A mutation whose search string matches
 * nothing runs the suite against UNMUTATED source and reports "still green",
 * which reads exactly like a gate that held. Lane C measured that happening
 * (a CRLF pattern against an LF file). So every mutation here counts its own
 * matches, REFUSES to run at zero, and the count is printed beside the result.
 *
 * WHY THE SUITES ARE RUN UNPIPED INTO A FILE. Piping `node --test` into
 * tail/head/grep discards the exit code; a six-failure run has been measured
 * reporting exit 0. Each run redirects to a file and the verdict is taken from
 * the TAP `# fail` line AND the exit code, which must agree.
 *
 *   node tools/repro/laneB-item1-mutations.mjs --engine <engine-worktree>
 *
 * Restores every file it touches, and verifies the restore byte-for-byte
 * before exiting.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const ENGINE = argv.includes('--engine')
  ? path.resolve(argv[argv.indexOf('--engine') + 1])
  : path.resolve(APP, '..', 'engine')

const results = []
const say = text => process.stdout.write(text + '\n')

/* One suite run. Never piped: the file is the record and the exit code is
   kept. `node --test` exits non-zero on any failure, and the TAP totals are
   read back from the same file, so a disagreement between them is itself a
   fault worth seeing. */
function runSuite(cwd, suite, label) {
  const log = path.join(os.tmpdir(), `laneB-item1-${label}.tap`)
  const out = fs.openSync(log, 'w')
  const child = spawnSync(process.execPath, [
    '--test', '--import=./tools/test/lib/isolate-native-state-root.mjs',
    '--test-reporter=tap', '--test-concurrency=1', suite,
  ], { cwd, stdio: ['ignore', out, out] })
  fs.closeSync(out)
  const text = fs.readFileSync(log, 'utf8')
  const pass = Number((text.match(/^# pass (\d+)/m) || [])[1] ?? -1)
  const fail = Number((text.match(/^# fail (\d+)/m) || [])[1] ?? -1)
  return { pass, fail, exit: child.status, log }
}

function runEngineSuite(suite, label) {
  const log = path.join(os.tmpdir(), `laneB-item1-${label}.tap`)
  const out = fs.openSync(log, 'w')
  const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite],
    { cwd: ENGINE, stdio: ['ignore', out, out] })
  fs.closeSync(out)
  const text = fs.readFileSync(log, 'utf8')
  return {
    pass: Number((text.match(/^# pass (\d+)/m) || [])[1] ?? -1),
    fail: Number((text.match(/^# fail (\d+)/m) || [])[1] ?? -1),
    exit: child.status, log,
  }
}

/* Apply one literal replacement and REFUSE at zero matches. */
function mutate(file, find, replace) {
  const before = fs.readFileSync(file, 'utf8')
  const count = before.split(find).length - 1
  if (count === 0) {
    throw new Error(`MUTATION DID NOT APPLY: 0 matches for ${JSON.stringify(find.slice(0, 70))} in ${file}`)
  }
  fs.writeFileSync(file, before.split(find).join(replace))
  return { count, before }
}

function gate({ name, file, find, replace, run, expectRedAtLeast = 1 }) {
  say(`\n== ${name} ==`)
  let saved = null
  try {
    const applied = mutate(file, find, replace)
    saved = applied.before
    say(`  match count = ${applied.count}  (a gate that matched 0 is refused, not reported green)`)
    const red = run()
    say(`  RED   pass=${red.pass} fail=${red.fail} exit=${red.exit}  ${red.log}`)
    fs.writeFileSync(file, saved)
    saved = null
    const green = run()
    say(`  GREEN pass=${green.pass} fail=${green.fail} exit=${green.exit}  ${green.log}`)
    const ok = applied.count > 0 && red.fail >= expectRedAtLeast && red.exit !== 0
      && green.fail === 0 && green.exit === 0
    results.push({ name, matches: applied.count, red, green, ok })
    say(`  ${ok ? 'GATE HOLDS' : 'GATE DID NOT HOLD'}`)
  } finally {
    if (saved !== null) fs.writeFileSync(file, saved)
  }
}

const registry = path.join(ENGINE, 'src', 'lib', 'tool-registry.js')
const computers = path.join(APP, 'src', 'views', 'computers.js')
const createNode = path.join(APP, 'src', 'create-and-start-node.js')
const mainJs = path.join(APP, 'src', 'main.js')

const treeSurface = () => runEngineSuite('tests/agent-spawn-tree-surface.test.js', 'tree-surface')
const refusals = () => runEngineSuite('tests/refusals-reach-the-agent.test.js', 'refusals')
const boundedChild = () => runSuite(APP, 'tools/test/bounded-child-thinking-depth.test.mjs', 'bounded-child')
const cleanGate = () => runSuite(APP, 'tools/test/tree-node-command-clean-gate.test.mjs', 'clean-gate')
const cans = () => runSuite(APP, 'tools/test/create-and-start-node.test.mjs', 'cans')

say(`engine ${ENGINE}`)
say(`app    ${APP}`)

gate({
  name: 'M1 engine: stop forwarding the applied choice to the application',
  file: registry, find: '      tier: args.tier,\n      ...applied,\n', replace: '      tier: args.tier,\n',
  run: treeSurface,
})

gate({
  name: "M2 engine: widen Claude's vocabulary to all eight values",
  file: registry,
  find: "    accepts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),",
  replace: '    accepts: AGENT_SPAWN_EFFORT_VALUES,',
  run: treeSurface,
})

gate({
  name: 'M3 engine: drop the ultra -> max mapping Claude actually applies',
  file: registry,
  find: "    applies: Object.freeze({ ultra: 'max' })", replace: '    applies: Object.freeze({})',
  run: treeSurface,
})

gate({
  name: 'M4 app: key the bounded-child depth check on the tier default column again',
  file: createNode,
  find: '  if (command.effort && !PROVIDERS_WITH_A_THINKING_DEPTH.has(tierRow.provider)) {',
  replace: '  if (command.effort && !tierRow.effort) {',
  run: cans,
})

gate({
  name: "M5 app: take the three choices back out of the renderer's transport gate",
  file: mainJs,
  find: "    'role', 'tier', 'brief', 'effort', 'provider', 'model', 'delegationToken', 'reservedNodeId',",
  replace: "    'role', 'tier', 'brief', 'delegationToken', 'reservedNodeId',",
  run: cleanGate,
})

gate({
  name: 'M6 app: reinstate the codex-only read in startBoundedChild',
  file: computers,
  find: 'PROVIDERS_WITH_A_THINKING_DEPTH.has(launchTier(request.tier)?.provider)',
  replace: "launchTier(request.tier)?.provider === 'codex'",
  run: boundedChild,
})

/* The restore is not taken on trust: git is asked whether either worktree
   still differs from its own HEAD in the files this script rewrites. */
say('\n== restore verification ==')
for (const [label, cwd] of [['engine', ENGINE], ['app', APP]]) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd, encoding: 'utf8' }).trim()
  say(`  ${label}: ${dirty === '' ? 'clean (every mutated file restored)' : 'STILL DIRTY:\n' + dirty}`)
  if (dirty !== '') results.push({ name: `${label} restore`, ok: false })
}

say('\n== summary ==')
for (const r of results) say(`  ${r.ok ? 'HOLDS ' : 'FAILED'} ${r.name}${r.matches ? ` (matches=${r.matches})` : ''}`)
const bad = results.filter(r => !r.ok)
/* Count the GATES, not every row: the restore rows are only pushed when a
   restore fails, so subtracting a fixed two under-reported the gate count. */
const gates = results.filter(r => r.matches !== undefined)
say(bad.length === 0
  ? `\nALL ${gates.length} GATES HOLD, every edit proven applied`
  : `\n${bad.length} PROBLEM(S)`)
process.exit(bad.length === 0 ? 0 : 1)
