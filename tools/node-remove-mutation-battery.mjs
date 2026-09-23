#!/usr/bin/env node

/* CAN EACH OF THE NODE-REMOVAL CONTROLS ACTUALLY GO RED?
 *
 * Same charter as tools/subscription-mutation-battery.mjs: a green suite
 * proves nothing about a rule nobody can break, so every promise the removal
 * leg makes gets one surgical defect planted under it, and the suite that
 * claims to hold the promise has to notice. A mutation that survives is a
 * rule with no test.
 *
 * RUN IT FROM A DETACHED WORKTREE, never the shared checkout: it edits source
 * files in place while suites run, and although every mutation is restored
 * byte-identically, a crash mid-battery would leave a planted defect sitting
 * in a tree other lanes share. (The 2026-08-16 near-miss: another lane almost
 * committed a sabotaged file from exactly this kind of negative control.)
 *
 *   git worktree add --detach ..\research-app-mutation <commit>
 *   cd ..\research-app-mutation && node tools/node-remove-mutation-battery.mjs
 *
 * Exit 0 only when every mutation was killed and every restore was exact.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const STORE = 'src/fleet-trees.js'
const COPY = 'src/fleet-tree-copy.js'
const VIEW = 'src/views/computers.js'
const TRANSCRIPTS = 'src/session-transcript-store.js'

const SUITE_STORE = 'tools/test/fleet-trees.test.mjs'
const SUITE_ROWS = 'tools/test/palette-rows.test.mjs'
const SUITE_REMOVE = 'tools/test/node-remove.test.mjs'

/** [id, file, find, replace, suite] */
const MUTATIONS = [
  ['M1 the store stops refusing a live agent', STORE,
    'if (LIVE_STATUSES.has(node.status) && node.sessionId != null) return refuse(NODE_REMOVE_REFUSALS.running)',
    'if (false) return refuse(NODE_REMOVE_REFUSALS.running)', SUITE_STORE],

  ['M2 the store stops refusing a parent', STORE,
    'if (children.length > 0) return refuse(NODE_REMOVE_REFUSALS.children(children.length))',
    'if (false) return refuse(NODE_REMOVE_REFUSALS.children(children.length))', SUITE_STORE],

  ['M3 an emptied tree stays behind as an invisible husk', STORE,
    'if (nodesOfTree(node.treeId).length === 0) {\n        trees.delete(node.treeId)\n        removedTreeId = node.treeId\n      }',
    'if (false) {\n        trees.delete(node.treeId)\n        removedTreeId = node.treeId\n      }', SUITE_STORE],

  ['M4 the children reason stops counting', STORE,
    "children: count => `Move or remove its ${numberWord(count)} ${count === 1 ? 'agent' : 'agents'} first.`",
    "children: count => 'Move its agents first.'", SUITE_REMOVE],

  ['M5 the palette reason drifts from the store refusal', COPY,
    'whyChildren: NODE_REMOVE_REFUSALS.children',
    "whyChildren: count => `Move or remove its ${count} agents first.`", SUITE_REMOVE],

  ['M6 the confirm stage stops saying the signed records are kept', COPY,
    'confirm: name => `This removes ${name} and its saved conversation here. The signed run records are kept.`',
    'confirm: name => `This removes ${name}.`', SUITE_REMOVE],

  ['M7 the remove row leaves the destructive group', VIEW,
    "{ id: 'remove', group: danger,",
    "{ id: 'remove', group: agent,", SUITE_ROWS],

  ['M8 a switched-off remove row goes silent about why', VIEW,
    "disabledHint: removeBlockedByRun ? REMOVE_PANEL.whyRunning : (childCount > 0 ? REMOVE_PANEL.whyChildren(childCount) : '')",
    "disabledHint: ''", SUITE_ROWS],

  ['M9 the durable conversation stops being removed', VIEW,
    "    /* The durable conversation leaves through the store's own door. */\n    transcriptStore?.remove(live.id)",
    '', SUITE_REMOVE],

  ['M10 the session-keyed caches stop being cleaned', VIEW,
    '      sessionNodeIds.delete(sessionId)\n      sessionEfforts.delete(sessionId)',
    '      sessionEfforts.delete(sessionId)', SUITE_REMOVE],

  ['M11 the rail stops returning to the overview', VIEW,
    "    if (currentRailTreeNode && currentRailTreeNode.id === live.id && controlsPage.classList.contains('is-active')) {\n      showStats()\n    }\n    setOrgStatus(REMOVE_PANEL.done(name), 'ok')",
    "    setOrgStatus(REMOVE_PANEL.done(name), 'ok')", SUITE_REMOVE],

  ['M12 the transcript store remove() stops deleting', TRANSCRIPTS,
    '      if (!(nodeId in nodes)) return true\n      delete nodes[nodeId]',
    '      if (!(nodeId in nodes)) return true', SUITE_REMOVE],

  ['M13 the confirmed press stops reaching the removal', VIEW,
    '        goCtx.close()\n        void performNodeRemoval(fresh())',
    '        goCtx.close()', SUITE_REMOVE],
]

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')

function runSuite(suite) {
  const result = spawnSync(process.execPath, ['--test', suite], {
    cwd: REPO_ROOT, windowsHide: true, timeout: 240_000, encoding: 'utf8',
  })
  return result.status
}

let failed = 0
for (const [id, relative, find, replace, suite] of MUTATIONS) {
  const file = path.join(REPO_ROOT, relative)
  const original = readFileSync(file, 'utf8')
  const before = sha(file)
  if (!original.includes(find)) {
    console.log(`  FAIL  ${id}: the plant site is gone from ${relative}; re-aim the mutation`)
    failed += 1
    continue
  }
  writeFileSync(file, original.replace(find, replace))
  if (sha(file) === before) {
    console.log(`  FAIL  ${id}: the plant did not land (sha unchanged)`)
    failed += 1
    continue
  }
  const status = runSuite(suite)
  writeFileSync(file, original)
  if (sha(file) !== before) {
    console.log(`  FAIL  ${id}: the restore is not byte-identical -- fix ${relative} before anything else`)
    failed += 1
    continue
  }
  if (status === 0) {
    console.log(`  FAIL  ${id}: SURVIVED -- ${suite} stayed green over the planted defect`)
    failed += 1
  } else {
    console.log(`  ok    ${id}: killed by ${suite} (exit ${status})`)
  }
}

console.log(`\n${MUTATIONS.length - failed}/${MUTATIONS.length} mutations killed`)
if (failed > 0) process.exitCode = 1
