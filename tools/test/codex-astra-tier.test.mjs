/* Cut gate R1199: Codex launched astra6, and the model is supported before the
 * cut.
 *
 * The id, display name and efforts are MEASURED from `model/list` on the
 * installed codex-cli 0.153.4 and recorded in
 * a recorded Codex model catalog
 * (measuredAt 2026-09-07T13:33:58.032Z): `gpt-6-astra`, `GPT-6-Astra`, efforts
 * low/medium/high/xhigh/max/ultra, catalog default `medium`.
 *
 * WHAT THIS SUITE DOES NOT DO: it does not re-check that the renderer table
 * agrees with the engine table or with shell/agent-host.cjs. The existing
 * tools/test/orchestration-controls.test.mjs already parses the engine's own
 * source and both app copies and fails when any of the three drift, so
 * duplicating it here would be a second, weaker copy of a check that already
 * exists. This suite asserts what that one does not: that the DEFAULT a new
 * circle gets is astra, that the argv shown to the person carries the measured
 * model and the product's effort, and that a tree can actually start one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { LAUNCH_TIERS, launchTier, tierArgvFragment, tierEffortIds } from '../../src/orchestration-controls.js'
import { DEFAULT_TIER, TREE_DEFAULT_STARTABLE_TIERS, EFFORT_CHOICES } from '../../src/fleet-tree-copy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const { createAgentHost } = require_(path.join(ROOT, 'shell', 'agent-host.cjs'))
const APP_FIXTURE_ENGINE = path.join(ROOT, 'tools', 'test', 'fixtures', 'confined-engine', 'src', 'lib', 'agent-engine', 'codex-process.js')
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const ASTRA_ID = 'gpt-6-astra'
const ASTRA_EFFORT = 'medium'
/* Every effort the catalog lists for astra. luna offers five of these -- it has
   no `ultra` -- which is exactly why the picker cannot be one flat list. */
const ASTRA_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

test('astra is offered as a Codex tier carrying the measured model id', () => {
  const astra = launchTier('astra')
  assert.ok(astra, 'no astra tier is offered at all')
  assert.equal(astra.provider, 'codex')
  assert.equal(astra.model, ASTRA_ID)
  assert.equal(astra.effort, ASTRA_EFFORT)
  assert.equal(astra.label, 'GPT-6-Astra')
  assert.ok(Array.isArray(astra.seats) && astra.seats.length > 0,
    'a tier with no seats can be chosen but never allocated')
})

/* K3 reversal: astra is the DEFAULT for NEW circles at effort medium, which is
   what Codex does for its own model. Asserted through what a new circle actually GETS, not by pinning the
   string 'astra', so a rename that keeps the behaviour still passes. */
test('a new circle defaults to the astra model at the effort the person runs', () => {
  const chosen = launchTier(DEFAULT_TIER)
  assert.ok(chosen, `DEFAULT_TIER "${DEFAULT_TIER}" is not a tier that exists`)
  assert.equal(chosen.model, ASTRA_ID)
  assert.equal(chosen.effort, ASTRA_EFFORT)
})

test('the three existing Codex tiers are still selectable and unchanged', () => {
  const expected = { luna: 'gpt-5.6-luna', terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol' }
  const expectedEffort = { luna: 'medium', terra: 'high', sol: 'xhigh' }
  for (const [id, model] of Object.entries(expected)) {
    const tier = launchTier(id)
    assert.ok(tier, `the ${id} tier disappeared`)
    assert.equal(tier.model, model, `the ${id} tier no longer resolves to its own model`)
    assert.equal(tier.effort, expectedEffort[id], `the ${id} tier's explicit effort changed`)
  }
  // nothing was deprecated or removed: six codex tiers since 1.0.48 -- the
  // four above plus GPT-6-Sol and GPT-6-Luna (next test)
  assert.equal(LAUNCH_TIERS.filter(tier => tier.provider === 'codex').length, 6)
})

/* 1.0.48, owner decision: every model a provider offers is
   selectable. The two gpt-6 models the codex-cli 0.156.0 catalog listed on
   2026-09-25 (~/.codex/models_cache.json): ids, display names and default
   `medium` as measured, GPT-6-Luna without `ultra`. They are treeOnly -- a
   dispatch row needs its own seat, which a saved org overlay never gains --
   and every Codex row states an effort, or the engine would send
   model_reasoning_effort=undefined. */
test('GPT-6-Sol and GPT-6-Luna are offered as Codex rows with their measured ids and a stated effort', () => {
  const expected = { 'gpt-6-sol': ['GPT-6-Sol', 'gpt-6-sol'], 'gpt-6-luna': ['GPT-6-Luna', 'gpt-6-luna'] }
  for (const [id, [label, model]] of Object.entries(expected)) {
    const tier = launchTier(id)
    assert.ok(tier, `the ${id} row is missing`)
    assert.equal(tier.provider, 'codex')
    assert.equal(tier.label, label)
    assert.equal(tier.model, model)
    assert.equal(tier.effort, 'medium', `${id} must state the catalog default effort`)
    assert.equal(tier.treeOnly, true, `${id} has no dispatch seat, so it must stay out of dispatch`)
    assert.ok(Array.isArray(tier.seats) && tier.seats.length > 0)
  }
  for (const tier of LAUNCH_TIERS.filter(row => row.provider === 'codex')) {
    assert.ok(typeof tier.effort === 'string' && tier.effort, `Codex row ${tier.id} carries no effort`)
  }
  assert.deepEqual([...tierEffortIds('gpt-6-luna')], ['low', 'medium', 'high', 'xhigh', 'max'], 'GPT-6-Luna has no ultra')
  assert.deepEqual([...tierEffortIds('gpt-6-sol')], ASTRA_EFFORTS, 'GPT-6-Sol offers every Codex depth')
  assert.deepEqual([...tierEffortIds('luna')], ['low', 'medium', 'high', 'xhigh', 'max'], 'GPT-5.6-Luna has no ultra')
})

/* The panel prints this fragment under the tier selector as a claim about the
   child process. If it does not carry the model and effort, the person is being
   shown something that is not what runs. */
test('the argv fragment shown for astra names the model and the effort', () => {
  /* takes the tier ID, not the tier object -- it resolves the row itself */
  const fragment = tierArgvFragment('astra')
  const text = Array.isArray(fragment) ? fragment.join(' ') : String(fragment)
  assert.ok(text.includes(ASTRA_ID), `the argv fragment does not name the model: ${text}`)
  assert.ok(text.includes(`model_reasoning_effort=${ASTRA_EFFORT}`),
    `the argv fragment does not carry the effort: ${text}`)
})

/* This drives the app's real start seam rather than only parsing the tier row.
 * `resolveEffort()` is private to shell/agent-host.cjs, so the observable proof
 * that it keeps an explicit choice is a fixture engine receiving the exact
 * app-server argv. Both upper choices are important: a regression that treats
 * every Astra request as the new medium default would pass the default-only
 * checks while silently discarding a person's high/max selection. */
test('explicit Astra high and max choices survive shell resolveEffort into Codex argv', async () => {
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'codex-astra-app-dispatch-'))
  const previousPlan = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true,
    tier: 'guided',
    isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
  })
  let host = null
  try {
    const engine = require_(APP_FIXTURE_ENGINE)
    const before = engine.calls.length
    host = createAgentHost({
      freeMemory: TEST_FREE_MEMORY,
      enginePath: APP_FIXTURE_ENGINE,
      defaultCwd: workdir,
      /* The fixture's launch path is the subject here; avoid touching this
         checkout's request ledgers while constructing a host. */
      rLedgerLoader: () => null,
      ownerRequestStoreLoader: () => null,
    })
    for (const [offset, effort] of ['high', 'max'].entries()) {
      const started = await host.startSession({
        sessionId: `astra-explicit-${effort}`,
        tier: 'astra',
        effort,
      })
      const call = engine.calls[before + offset]
      assert.equal(started.effort, effort, `the shell start receipt lost explicit Astra ${effort}`)
      assert.equal(call.threadOptions.model, ASTRA_ID,
        `the shell selected a different model for explicit Astra ${effort}`)
      assert.deepEqual(call.args, ['app-server', '-c', `model_reasoning_effort=${effort}`],
        `explicit Astra ${effort} did not reach the Codex app-server argv`)
    }
  } finally {
    if (host) await host.closeAll()
    if (previousPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previousPlan
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('a tree can start a circle on astra by default', () => {
  assert.ok(TREE_DEFAULT_STARTABLE_TIERS.includes('astra'),
    'astra is offered in the menu but a tree cannot start one')
  for (const kept of ['luna', 'terra', 'sol']) {
    assert.ok(TREE_DEFAULT_STARTABLE_TIERS.includes(kept), `tree starting lost the ${kept} tier`)
  }
})

/* THE SHELL'S START PATH WAS NOT ACTUALLY GUARDED, MEASURED 2026-09-07.
 *
 * shell/agent-host.cjs says of its START_TIERS map that the orchestration
 * controls suite "already parses the ENGINE table and fails when the renderer
 * table drifts from it; the same test now covers this one, so three copies
 * cannot disagree silently". That is not true today: tools/test/
 * orchestration-controls.test.mjs contains no reference to agent-host.cjs or to
 * START_TIERS at all. Proven by mutation rather than by reading -- changing the
 * shell's astra model to `gpt-6-astra-preview` left BOTH suites green.
 *
 * That matters more than a stale comment. startCodexSession() is the only start
 * path on that channel, so a model id that drifts there is the id the session
 * actually runs under, while the menu and the engine promise something else --
 * the person choosing GPT-6-Astra would silently get whatever the shell says.
 * So the missing third leg is added here, in the same parse-the-source style
 * the engine leg already uses.
 */
test('the shell start path agrees with the tier table, model for model', () => {
  const source = readFileSync(path.join(ROOT, 'shell', 'agent-host.cjs'), 'utf8')
  const block = source.slice(source.indexOf('const START_TIERS = Object.freeze({'))
  assert.ok(block.startsWith('const START_TIERS'), 'START_TIERS not found -- this test is checking air')

  const shell = new Map()
  const row = /'?([a-z0-9-]+)'?:\s*\{([^}]*)\}/g
  let match
  while ((match = row.exec(block.slice(0, block.indexOf('\n  })')))) !== null) {
    shell.set(match[1], Object.fromEntries([...match[2].matchAll(/(\w+):\s*'([^']*)'/g)].map(f => [f[1], f[2]])))
  }

  assert.equal(shell.size, LAUNCH_TIERS.length,
    `the shell starts ${shell.size} tiers, the menu offers ${LAUNCH_TIERS.length}`)
  for (const tier of LAUNCH_TIERS) {
    const started = shell.get(tier.id)
    assert.ok(started, `the menu offers "${tier.id}" which the shell cannot start`)
    assert.equal(started.provider, tier.provider, `tier ${tier.id} provider drifted in the shell`)
    assert.equal(started.model, tier.model, `tier ${tier.id} model drifted in the shell`)
    if (tier.effort !== null && tier.effort !== undefined) {
      assert.equal(started.effort, tier.effort, `tier ${tier.id} effort drifted in the shell`)
    } else {
      /* "Model default" means NO effort: a shell row that stated one would
         send it on every untouched start of a row the menu says has none. */
      assert.equal(started.effort, undefined, `tier ${tier.id} has no effort in the menu but one in the shell`)
    }
  }
})

/* The picker reads the engine catalog when a session can answer; this fallback
   is what the person sees when it cannot. It must therefore be able to express
   every effort astra really offers, or the offline path silently hides `ultra`
   -- the one that switches on automatic task delegation. */
test('the offline effort fallback can express every effort astra offers', () => {
  const offered = EFFORT_CHOICES.map(choice => choice.id)
  for (const effort of ASTRA_EFFORTS) {
    assert.ok(offered.includes(effort), `the fallback effort list cannot offer "${effort}"`)
  }
})
