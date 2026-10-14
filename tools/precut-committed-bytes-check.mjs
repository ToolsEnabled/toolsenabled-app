#!/usr/bin/env node
/* WHAT A CUT ACTUALLY BUILDS FROM, CHECKED BEFORE THE CUT.
 *
 * MEASURED 2026-08-20. Commit `ed7a10a` landed a variable's USES without its
 * DECLARATION -- a surgical index-only commit split them while two lanes
 * interleaved hunks in one file. The result:
 *
 *   - `npm run build` PASSED. Rollup treats an undeclared name as a global and
 *     says nothing, so no build catches it.
 *   - Every unit suite PASSED. They import modules; they do not resolve the
 *     runtime graph.
 *   - Every driven run in the shared checkout PASSED, because the WORKING TREE
 *     held the declaration.
 *   - And page 2 was dead at HEAD: "the fleet record could not be fetched:
 *     roleLibraryToRestore is not defined", zero nodes, no way to start an
 *     agent at all.
 *
 * A cut builds from committed bytes. Nothing in the release chain looked at
 * committed bytes until somebody happened to build HEAD in a clean worktree for
 * an unrelated reason. This makes that check mechanical instead of lucky.
 *
 * It is deliberately NOT part of `npm test`: it costs a worktree and a build,
 * and its subject is the commit rather than the source. Run it before a cut.
 *
 *   node tools/precut-committed-bytes-check.mjs
 *
 * Exits 0 only when every check passes. Every failure names what to do.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { scanRendererSource } from './check-unbound-identifiers.mjs'
import { assessBuild } from './build-receipt.mjs'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..')
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts })
const git = (...args) => run('git', ['-C', APP, ...args]).trim()

const failures = []
const notes = []
function check(name, fn) {
  try { const detail = fn(); console.log(`  ok    ${name}${detail ? ` -- ${detail}` : ''}`) }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name}\n        ${error.message}`) }
}

console.log('pre-cut check: what the committed bytes actually do\n')

const head = git('rev-parse', 'HEAD')
console.log(`HEAD ${head.slice(0, 12)} on ${git('rev-parse', '--abbrev-ref', 'HEAD')}\n`)

/* 1. A STAGED REVERSION IS A COMMIT WAITING TO UNDO SOMEBODY'S WORK.
 *    An index entry built against an older HEAD is not merely stale: the next
 *    bare `git commit` ships it as a deletion. Two lanes hit this in one night;
 *    one measured 61 reverting lines sitting against a single stylesheet. */
check('no staged reversion in the index', () => {
  const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
  const reverting = staged.filter(file => {
    const diff = git('diff', '--cached', 'HEAD', '--', file)
    return diff.split('\n').some(line => line.startsWith('-') && !line.startsWith('---'))
  })
  assert.deepEqual(reverting, [],
    `these index entries would DELETE lines from HEAD if committed: ${reverting.join(', ')}.`
    + ' Refresh each with: git update-index --cacheinfo 100644,$(git rev-parse HEAD:<path>),<path>')
  return staged.length ? `${staged.length} staged, none reverting` : 'index clean'
})

/* 2. THE BUILD, FROM COMMITTED BYTES, IN A TREE NOBODY HAS EDITED. */
const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'precut-'))
const scratch = path.join(worktree, 'tree')
let junctioned = false

function unlinkNodeModulesJunction() {
  /* THE JUNCTION TRAP. The shared node_modules was emptied TWICE in one night
     by a worktree carrying a junction being removed with a recursive delete --
     the delete follows the link and destroys the TARGET, blocking every lane
     instantly. Delete the reparse point ONLY, then verify the target is
     unchanged, and only then remove the worktree. */
  const link = path.join(scratch, 'node_modules')
  if (!junctioned || !fs.existsSync(link)) return
  const before = fs.readdirSync(path.join(APP, 'node_modules')).length
  fs.rmSync(link, { recursive: false, force: true })
  const after = fs.readdirSync(path.join(APP, 'node_modules')).length
  if (before !== after) {
    throw new Error(`THE SHARED node_modules CHANGED while unlinking (${before} -> ${after}). Restore with: npm ci`)
  }
  junctioned = false
}

try {
  git('worktree', 'add', '--detach', scratch, head)
  fs.symlinkSync(path.join(APP, 'node_modules'), path.join(scratch, 'node_modules'), 'junction')
  junctioned = true

  /* EXIT 0 IS HALF AN ANSWER. Measured on the 1.0.45 Windows cut: two build
     runs reported exit 0 with nothing built. This step used to assert the exit
     code alone, which is the same half-measurement; tools/build-receipt.mjs
     owns both halves and names which one it caught. */
  check('the committed tree builds', () => {
    const built = spawnSync('npm', ['run', 'build'], { cwd: scratch, encoding: 'utf8', shell: true, windowsHide: true })
    const verdict = assessBuild({ exit: { ...built, observedThrough: 'shell' }, repoRoot: scratch })
    assert.ok(verdict.ok, `${verdict.message ?? ''}\n${((built.stdout || '') + (built.stderr || '')).slice(0, 2000)}`)
    return `exit 0, ${verdict.artifact.assets} renderer asset(s) present`
  })

  /* 3. THE ONE THAT WOULD HAVE CAUGHT ed7a10a. A build cannot see an
   *    undeclared identifier; only running the page can. page2-qa serves the
   *    built dist and asserts the fleet board draws its nodes. */
  check('the committed tree RUNS -- page 2 draws its board', () => {
    const driven = spawnSync(
      path.join(scratch, 'node_modules', 'electron', 'dist', 'electron.exe'),
      ['tools/page2-qa.cjs'],
      {
        cwd: scratch, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, MC_SMOKE_HEADLESS: '1', TOOLSENABLED_STATE_ROOT: path.join(worktree, 'state') },
      },
    )
    const out = (driven.stdout || '') + (driven.stderr || '')
    assert.ok(!/is not defined/.test(out), `the page threw a ReferenceError -- a symbol is used but not declared IN THE COMMIT:\n${out.slice(0, 1200)}`)
    assert.equal(driven.status, 0, `page2-qa exited ${driven.status}:\n${out.slice(-1500)}`)
    return 'exit 0, board drawn'
  })

  /* 3b. THE HALF OF THAT DEFECT A DRIVE CANNOT REACH.
   *     Loading the page finds a symbol missing at module scope. It says
   *     nothing about one missing inside a click handler, which throws only
   *     when a person presses the control -- and `ed7a10a` carried BOTH:
   *
   *       ed7a10a: unbound = restoreRoleLibrary, roleLibraryToRestore
   *       e3833d7: unbound = (none)
   *
   *     Only `roleLibraryToRestore` killed the load and got found. Every lane
   *     that looked at that commit reported one name. `restoreRoleLibrary`
   *     waits in a handler, and check 3 above would have passed over it.
   *
   *     The guard for it was written on 2026-08-17, for this exact class, and
   *     was wired into nothing -- not `npm test`, not the dist chain, not here
   *     -- through the whole night the defect it describes was live at HEAD.
   *     It runs against the COMMITTED sources in the scratch worktree; the
   *     parser is imported from this checkout so the result never depends on
   *     the junction. */
  check('no identifier used and never bound, in the committed sources', () => {
    const { scanned, findings } = scanRendererSource(scratch)
    assert.ok(scanned > 0, 'scanned 0 renderer modules, so this proved nothing')
    assert.deepEqual(findings.map(f => `${f.file}: ${f.name}`), [],
      'these throw the moment their line runs -- at load if at module scope, on a press if in a handler.'
      + ' Import it, declare it, or add it to KNOWN_GLOBALS in tools/check-unbound-identifiers.mjs')
    return `${scanned} renderer modules, none unbound`
  })
} finally {
  try { unlinkNodeModulesJunction() } catch (error) { failures.push('junction unlink'); console.error(`  FAIL  junction unlink\n        ${error.message}`) }
  try { git('worktree', 'remove', '--force', scratch) } catch { notes.push('the scratch worktree could not be removed; remove it by hand AFTER checking its node_modules junction is gone') }
  try { fs.rmSync(worktree, { recursive: true, force: true }) } catch { /* best effort */ }
}

/* 4. THE PAYLOAD COUPLING. The Claude tool surface needs all three modules
 *    repacked TOGETHER: prepareClaudeToolSurface reaches for a symbol the
 *    adapter exports, and an older adapter in the payload makes servers.map()
 *    throw and the plan come back as an opaque ok:false -- a silent no-tools
 *    session, which is the exact defect the tool surface exists to fix. */
check('the coupled Claude payload modules match the engine', () => {
  const coupled = [
    'src/lib/agent-session-confinement.js',
    'src/lib/agent-engine/claude-cli-adapter.js',
    'src/lib/agent-engine/claude-cli-process.js',
  ]
  const engineRoot = JSON.parse(fs.readFileSync(path.join(APP, 'private', 'capability-source.owner.json'), 'utf8')).path
  const mismatched = coupled.filter(rel => {
    const staged = path.join(APP, 'capability', rel)
    const source = path.join(engineRoot, rel)
    if (!fs.existsSync(staged) || !fs.existsSync(source)) return true
    return fs.statSync(staged).size !== fs.statSync(source).size
  })
  assert.deepEqual(mismatched, [], `repack these together -- a partial repack yields a silent no-tools session: ${mismatched.join(', ')}`)
  return '3 modules, sizes match'
})

console.log('')
for (const note of notes) console.log(`note: ${note}`)
if (failures.length) {
  console.error(`\npre-cut check FAILED: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('pre-cut check: the committed bytes build and run. Safe to cut.')
}
