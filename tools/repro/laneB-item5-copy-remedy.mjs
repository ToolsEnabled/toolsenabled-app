#!/usr/bin/env node
/* LANE B ITEM 5 (finding B) -- the close-failed refusal must name a remedy
 * that does not cost the whole tree.
 *
 * MEASURED 2026-09-19 on the owner's tree: a close-failed circle
 * (node-24-d7961725) was cleared by "Remove this agent" alone -- ok true, the
 * application still running, every other agent untouched. The sentence the
 * product showed instead was "Close ToolsEnabled to end every session, then
 * open it again", so a person with ONE wedged agent was told to end every
 * running turn on the computer. The control that works was already on that
 * circle's own menu and already enabled for it.
 *
 * WHY THIS IS A NODE SCRIPT AND NOT A SHELL ONE. The first attempt at these
 * gates was shell, and `F=... mut "$F"` expands $F BEFORE the assignment takes
 * effect, so the mutation ran with an EMPTY search string: the reported match
 * count was 808, which is the file's line count, and the red it produced came
 * from a mangled file rather than from the intended edit. The gate looked like
 * it held and had proven nothing. Every replacement here is literal, its match
 * count is asserted, and zero matches REFUSES.
 *
 *   node tools/repro/laneB-item5-copy-remedy.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SUITE = 'tools/test/start-refusal-copy-honesty.test.mjs'
const NODE = process.env.NODE_BIN || process.execPath
const say = text => process.stdout.write(text + '\n')

/* Never piped: a pipe discards the exit code, and a failing run has been
   measured reporting exit 0. The file is the record; the TAP totals and the
   exit code must agree. */
function runSuite(label) {
  const log = path.join(os.tmpdir(), `laneB-item5-${label}.tap`)
  const out = fs.openSync(log, 'w')
  const child = spawnSync(NODE, ['--test', '--import=./tools/test/lib/isolate-native-state-root.mjs',
    '--test-reporter=tap', '--test-concurrency=1', SUITE], { cwd: APP, stdio: ['ignore', out, out], timeout: 600_000 })
  fs.closeSync(out)
  const text = fs.readFileSync(log, 'utf8')
  return {
    pass: Number((text.match(/^# pass (\d+)/m) || [])[1] ?? -1),
    fail: Number((text.match(/^# fail (\d+)/m) || [])[1] ?? -1),
    exit: child.status, log,
  }
}

function gate({ name, file, find, replace, expectFailAtLeast = 1 }) {
  const full = path.join(APP, file)
  const before = fs.readFileSync(full, 'utf8')
  const count = before.split(find).length - 1
  say(`\n== ${name} ==`)
  say(`  match count = ${count}`)
  if (count === 0) {
    say('  REFUSED: the search string matched nothing, so this gate proves nothing.')
    return { name, ok: false, count }
  }
  fs.writeFileSync(full, before.split(find).join(replace))
  let red
  try { red = runSuite(name.replace(/\W+/g, '-')) } finally { fs.writeFileSync(full, before) }
  const green = runSuite(`${name.replace(/\W+/g, '-')}-restored`)
  say(`  RED   pass=${red.pass} fail=${red.fail} exit=${red.exit}`)
  say(`  GREEN pass=${green.pass} fail=${green.fail} exit=${green.exit}`)
  const ok = red.fail >= expectFailAtLeast && red.exit !== 0 && green.fail === 0 && green.exit === 0
  say(`  ${ok ? 'GATE HOLDS' : 'GATE DID NOT HOLD'}`)
  return { name, ok, count }
}

say(`app  ${APP}`)
say(`node ${execFileSync(NODE, ['-v'], { encoding: 'utf8' }).trim()}`)
const baseline = runSuite('baseline')
say(`baseline pass=${baseline.pass} fail=${baseline.fail} exit=${baseline.exit}`)

const results = [
  gate({
    name: 'M1 put the close-the-whole-app remedy back',
    file: 'src/agent-availability-copy.js',
    find: 'Use "Remove this agent" on it — that clears the circle without closing ToolsEnabled, and every other agent keeps running',
    replace: 'Close ToolsEnabled to end every session, then open it again',
  }),
  gate({
    name: 'M2 leave the resume sentence with only Stop',
    file: 'src/fleet-tree-copy.js',
    find: 'Press Stop and try again; if Stop will not clear it either, "Remove this agent" will, and it leaves every other agent running.',
    replace: 'Press Stop, then try again.',
  }),
]

say('\n== restore verification ==')
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: APP, encoding: 'utf8' })
  .split('\n').filter(Boolean)
/* The two copy files are EXPECTED to differ from HEAD -- that is this lane's
   own uncommitted change. What must be true is that each still carries its
   fixed sentence, which is what a botched restore would have destroyed. */
const intact = [
  ['src/agent-availability-copy.js', 'Use "Remove this agent" on it'],
  ['src/fleet-tree-copy.js', 'if Stop will not clear it either'],
].every(([file, mark]) => fs.readFileSync(path.join(APP, file), 'utf8').includes(mark))
say(`  files still carrying their fixed sentence: ${intact ? 'YES' : 'NO -- RESTORE DAMAGED THE FILE'}`)
say(`  git sees ${dirty.length} modified path(s) under src/ (this lane's own change, uncommitted)`)

say('\n== summary ==')
for (const r of results) say(`  ${r.ok ? 'HOLDS ' : 'FAILED'} ${r.name} (matches=${r.count})`)
const bad = results.filter(r => !r.ok)
const fine = bad.length === 0 && intact && baseline.fail === 0
say(fine ? `\nALL ${results.length} GATES HOLD, every edit proven applied` : '\nPROBLEM')
process.exit(fine ? 0 : 1)
