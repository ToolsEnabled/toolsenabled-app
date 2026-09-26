/* 1.0.48 PROVIDER-THEN-MODEL PICKER: THE TABLE AND THE LOGIC UNDER IT.
 *
 * Owner decision for 1.0.48: every model a provider offers is selectable,
 * chosen as provider first, then model (for example Opus 5 and Sonnet 5 on
 * Claude).
 *
 * The wire stays one row id (decision D1). What this suite pins is what that
 * row now carries and what every start computes from it:
 *
 *   D4  a row whose effort is null offers "Model default" first and sends NO
 *       effort when it is chosen -- so Sonnet 5 and Opus 5 are no longer
 *       started at `medium`, one level below their served default, and the
 *       Gemini/Grok Automatic rows are no longer sent a depth their CLI
 *       refuses. The depth menu is scoped per model.
 *   D9  an unknown saved row id gets a plain sentence, not the generic one.
 *   The Claude pinned row reaches the Claude CLI as `--model <cliModel>` and,
 *   at "Model default", with no `--effort` at all.
 *
 * Driven by values through the real modules and the real shell start seam;
 * the Claude argv comes from the packed engine's own builder.
 *
 *   MC_CANONICAL_ROOT=<engine> node --test tools/test/picker-48-model-rows.test.mjs
 *
 * It makes its own scratch state root when none is set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findingsInText } from '../check-plain-language.mjs'
import { DISPATCH_TIERS, LAUNCH_TIERS, launchTier, scopedEffort, tierDefaultEffort, tierEffortIds } from '../../src/orchestration-controls.js'
import {
  EFFORT_CHOICES,
  MODEL_DEFAULT_EFFORT,
  PROVIDER_CHOICES,
  START_REFUSAL,
  effortChoicesFor,
  providerDefaultTier,
  restartRefusalSentence,
  startRefusalSentence,
  tierChoicesFor,
} from '../../src/fleet-tree-copy.js'
import { draftStartEffort } from '../../src/fleet-trees.js'
import { defaultStandaloneStart, standaloneStartFrom } from '../../src/tree-standalone-agent.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)

const ids = choices => choices.map(choice => choice.id)
const defaultOf = choices => choices.filter(choice => choice.isDefault).map(choice => choice.id)

/* ---------------------------------------------------------------
   D4 · the depth menu, one row at a time
   --------------------------------------------------------------- */

test('a row with no depth of its own offers "Model default" first, and that is its default', () => {
  for (const id of ['claude-opus', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable', 'gemini', 'gemini-3-1-flash-lite', 'grok', 'local']) {
    const choices = effortChoicesFor(id)
    assert.equal(choices[0].id, '', `${id}: "Model default" must come first`)
    assert.equal(choices[0].label, MODEL_DEFAULT_EFFORT.label)
    assert.deepEqual(defaultOf(choices), [''], `${id}: an untouched menu must send no effort`)
  }
  /* The five depths Claude's launcher takes, after the default. */
  assert.deepEqual(ids(effortChoicesFor('claude-opus-5')), ['', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('a Codex row keeps its own depth as the default and offers only what its model takes', () => {
  assert.deepEqual(ids(effortChoicesFor('astra')), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.deepEqual(defaultOf(effortChoicesFor('astra')), ['medium'])
  assert.deepEqual(defaultOf(effortChoicesFor('sol')), ['xhigh'])
  assert.deepEqual(ids(effortChoicesFor('luna')), ['low', 'medium', 'high', 'xhigh', 'max'], 'GPT-5.6-Luna has no ultra')
  assert.deepEqual(ids(effortChoicesFor('gpt-6-luna')), ['low', 'medium', 'high', 'xhigh', 'max'], 'GPT-6-Luna has no ultra')
  for (const tier of LAUNCH_TIERS.filter(row => row.provider === 'codex')) {
    assert.ok(!ids(effortChoicesFor(tier.id)).includes(''), `${tier.id}: a Codex row states its depth, so it offers no "Model default"`)
  }
})

test('a model that offers less than its provider is offered less', () => {
  assert.deepEqual(ids(effortChoicesFor('claude-haiku-4-5')), [''], 'Haiku 4.5 takes no depth at all')
  assert.deepEqual(ids(effortChoicesFor('claude-opus-4-6')), ['', 'low', 'medium', 'high', 'max'], 'Opus 4.6 has no xhigh')
  assert.deepEqual(ids(effortChoicesFor('claude-sonnet-4-6')), ['', 'low', 'medium', 'high', 'max'], 'Sonnet 4.6 has no xhigh')
  assert.deepEqual(ids(effortChoicesFor('agy-gemini-3-8-flash-low')), ['low'], 'an Antigravity row keeps its fixed depth')
  assert.deepEqual(ids(effortChoicesFor('gemini-3-1-pro')), [''], 'Gemini CLI rows advertise no depth')
  assert.deepEqual(ids(effortChoicesFor('grok-4-6')), ['low', 'medium', 'high', 'xhigh'])
  assert.deepEqual(defaultOf(effortChoicesFor('grok-4-6')), ['xhigh'])
  assert.deepEqual(ids(effortChoicesFor('grok-4-5')), ['', 'low', 'medium', 'high'])
  assert.deepEqual(ids(effortChoicesFor('not-a-row')), [''], 'an unknown row is offered nothing but "send no effort"')
})

test('every offered depth is one the copy module can name, with the provider sentence', () => {
  const named = new Set(EFFORT_CHOICES.map(choice => choice.id))
  for (const tier of LAUNCH_TIERS) {
    for (const choice of effortChoicesFor(tier.id)) {
      if (choice.id === '') continue
      assert.ok(named.has(choice.id), `${tier.id} offers ${choice.id}, which has no words`)
      assert.ok(choice.description.length > 0)
    }
  }
})

test('the Claude rows: aliases first, then one row per served model, each pinned and dispatchable', () => {
  const claude = LAUNCH_TIERS.filter(row => row.provider === 'claude').map(row => row.id)
  assert.deepEqual(claude, ['claude-fable', 'claude-sonnet', 'claude-opus',
    'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-haiku-4-5',
    'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'])
  for (const id of claude.slice(3)) {
    const row = launchTier(id)
    assert.equal(row.pinned, true, `${id} names one exact model`)
    assert.equal(row.model, `claude/${id}`)
    assert.equal(row.cliModel, id)
    assert.equal(row.effort, null)
    assert.ok(DISPATCH_TIERS.includes(row), `${id} must be dispatchable (D3)`)
  }
  for (const id of claude.slice(0, 3)) assert.notEqual(launchTier(id).pinned, true, `${id} is an alias, not a pinned model`)
  assert.equal(launchTier('claude-opus').label, 'Opus (latest)')
  assert.equal(launchTier('luna').label, 'GPT-5.6-Luna')
})

test('the provider chooser has the five provider words, and each provider lands on its default row', () => {
  assert.deepEqual(PROVIDER_CHOICES.map(choice => choice.label), ['Codex', 'Claude', 'Gemini', 'Grok', 'Local'])
  const everything = tierChoicesFor(LAUNCH_TIERS.map(row => row.id))
  assert.equal(providerDefaultTier('codex', everything), 'astra')
  assert.equal(providerDefaultTier('claude', everything), 'claude-opus', 'Claude keeps the moving alias as its default, not a pinned version')
  assert.equal(providerDefaultTier('local', everything), 'local')
  const noAlias = tierChoicesFor(LAUNCH_TIERS.map(row => row.id).filter(id => id !== 'claude-opus'))
  assert.equal(providerDefaultTier('claude', noAlias), 'claude-fable', 'an unstartable default yields to that provider\'s first startable row')
})

/* ---------------------------------------------------------------
   D4 · what a start computes when nobody touched the depth
   --------------------------------------------------------------- */

test('a tree start on a Claude row at "Model default" carries no effort', () => {
  /* The view calls draftStartEffort(node, { override, tierDefault: tierEffortOf(node.tier) })
     with tierEffortOf = row.effort || null. */
  const tierEffortOf = id => launchTier(id)?.effort || null
  const node = { tier: 'claude-sonnet-5', effort: '' }
  assert.equal(draftStartEffort(node, { override: '', tierDefault: tierEffortOf(node.tier) }), null)
  assert.equal(draftStartEffort(node, { override: 'high', tierDefault: tierEffortOf(node.tier) }), 'high', 'a chosen depth still wins')
  /* A saved depth the new model does not take is not sent. */
  assert.equal(draftStartEffort({ tier: 'claude-haiku-4-5', effort: 'xhigh' }, { tierDefault: null }), null)
  assert.equal(draftStartEffort({ tier: 'claude-opus-4-6', effort: 'xhigh' }, { tierDefault: null }), null)
  assert.equal(draftStartEffort({ tier: 'gpt-6-luna', effort: 'ultra' }, { tierDefault: 'medium' }), 'medium')
  /* Claude's launcher runs ultra as max, so "hardest" survives the move. */
  assert.equal(draftStartEffort({ tier: 'claude-opus-5', effort: 'ultra' }, { tierDefault: null }), 'max')
  /* A Codex row is unchanged: its own depth when nothing was chosen. */
  assert.equal(draftStartEffort({ tier: 'sol', effort: '' }, { tierDefault: tierEffortOf('sol') }), 'xhigh')
  assert.equal(draftStartEffort({ tier: 'sol', effort: 'max' }, { tierDefault: tierEffortOf('sol') }), 'max')
})

test('the + agent start answers "Model default" for a Claude row, and scopes a picked depth to the model', () => {
  assert.deepEqual(standaloneStartFrom({ tier: 'claude-opus-5' }), { tier: 'claude-opus-5', effort: null })
  assert.deepEqual(standaloneStartFrom({ tier: 'claude-opus-5', effort: 'high' }), { tier: 'claude-opus-5', effort: 'high' })
  assert.deepEqual(standaloneStartFrom({ tier: 'claude-haiku-4-5', effort: 'high' }), { tier: 'claude-haiku-4-5', effort: null })
  assert.deepEqual(standaloneStartFrom({ tier: 'luna', effort: 'ultra' }), { tier: 'luna', effort: 'medium' })
  assert.deepEqual(defaultStandaloneStart(), { tier: 'astra', effort: 'medium' }, 'the Codex default is unchanged')
})

test('scopedEffort keeps an offered depth and otherwise falls to the row default', () => {
  assert.equal(scopedEffort('claude-sonnet-5', 'xhigh'), 'xhigh')
  assert.equal(scopedEffort('claude-sonnet-4-6', 'xhigh'), '')
  assert.equal(scopedEffort('terra', 'bogus'), 'high')
  assert.equal(tierDefaultEffort('claude-opus-5'), '')
  assert.equal(tierDefaultEffort('astra'), 'medium')
})

/* ---------------------------------------------------------------
   D9 · an unknown saved model id
   --------------------------------------------------------------- */

test('a start refused for an unknown saved model reads a plain sentence with something to do', () => {
  const said = startRefusalSentence({ code: 'AGENT_TIER_UNKNOWN' })
  assert.equal(said, START_REFUSAL.tierUnknown)
  assert.match(said, /Choose a model/)
  assert.doesNotMatch(said, /\btier\b|AGENT_/, 'no internal word reaches the person')
  assert.deepEqual(findingsInText(said), [], 'the sentence passes the plain-language rules')
  assert.equal(restartRefusalSentence({ code: 'AGENT_TIER_UNKNOWN' }), said, 'a restart says the same')
})

/* ---------------------------------------------------------------
   The Claude pinned row, through the shell, to the CLI argv
   --------------------------------------------------------------- */

const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const CLAUDE_ADAPTER = path.join(ROOT, 'capability/src/lib/agent-engine/claude-cli-adapter.js')
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

test('a Claude pinned row at "Model default" starts with --model <its CLI name> and no --effort', {
  skip: existsSync(CLAUDE_ADAPTER) ? false : 'no packed engine in this checkout: the Claude argv builder is not here to read',
}, async () => {
  const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
  const { claudeArgs } = require_(CLAUDE_ADAPTER)
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'picker-48-claude-pinned-'))
  const previousPlan = process.env.MC_TEST_CONFINEMENT_PLAN
  /* ITS OWN SCRATCH STATE ROOT (review P18). claudeArgs reads the product
     identity from settings under TOOLSENABLED_STATE_ROOT, so run bare this
     test failed "TOOLSENABLED_STATE_ROOT is not set" -- or, with the owner's
     real one set, would read the owner's own settings. A root the caller set
     (the isolate-native-state-root import) is kept. */
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  if (!previousStateRoot) {
    const stateRoot = path.join(workdir, 'state-root')
    mkdirSync(stateRoot, { recursive: true })
    process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  }
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({
    ok: true, tier: 'unrestricted', isolated: true,
    threadOptions: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
  })
  let host = null
  try {
    const engine = require_(CONFINED_ENGINE)
    host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir,
      providerCommandResolver: () => 'claude-fixture', rLedgerLoader: () => null, ownerRequestStoreLoader: () => null })
    for (const tier of ['claude-opus-5', 'claude-sonnet-5']) {
      const row = launchTier(tier)
      /* What the compose panel and the + chooser hand the start when nobody
         touched the depth: the effort the start computes is "no effort", so
         the request carries no effort key (computers.js startAgentForNode). */
      const effort = draftStartEffort({ tier, effort: tierDefaultEffort(tier) }, { tierDefault: row.effort || null })
      assert.equal(effort, null, `${tier}: an untouched start computed a depth nobody chose`)
      const before = engine.calls.length
      const started = await host.startSession({ sessionId: `picker-48-${tier}`, tier, ...(effort ? { effort } : {}) })
      const call = engine.calls[before]
      assert.equal(call.threadOptions.model, row.model, `${tier}: the shell started another model`)
      assert.equal('effort' in call.threadOptions, false, `${tier}: an effort reached the engine at "Model default"`)
      assert.equal(started.effort ?? null, null)

      const argv = claudeArgs({ threadId: '11111111-2222-3333-4444-555555555555', threadOptions: call.threadOptions })
      const model = argv.indexOf('--model')
      assert.ok(model >= 0, `${tier}: no --model in the Claude argv`)
      assert.equal(argv[model + 1], row.cliModel, `${tier}: the CLI was handed ${argv[model + 1]}, not the pinned model`)
      assert.equal(argv.includes('--effort'), false, `${tier}: --effort was passed at "Model default"`)
    }

    /* And a depth the person picks still reaches the CLI. */
    const before = engine.calls.length
    await host.startSession({ sessionId: 'picker-48-opus-5-high', tier: 'claude-opus-5', effort: 'high' })
    const argv = claudeArgs({ threadId: '11111111-2222-3333-4444-555555555556', threadOptions: engine.calls[before].threadOptions })
    assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'high'])
  } finally {
    if (host) await host.closeAll()
    if (previousPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previousPlan
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot
    rmSync(workdir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------
   Review P3 · a spawn depth the engine accepts is one the app starts
   --------------------------------------------------------------- */

/* The engine's agent.spawn answered `applied.effort` for GPT-5.6-Luna at
   ultra and every Codex row at none or minimal, and the app then started the
   circle at medium (draftStartEffort scopes to the row). Both halves now read
   one answer: for every dispatch row, the depths the packed engine applies
   as named are exactly the depths this table offers. Claude's `ultra` is the
   one mapped word (it runs as max) and is checked as such. */
const PACKED_REGISTRY = path.join(ROOT, 'capability/src/lib/tool-registry.js')
test('the packed engine accepts, for every dispatch row, exactly the depths the app offers', {
  skip: existsSync(PACKED_REGISTRY) ? false : 'no packed engine in this checkout: agent.spawn is not here to ask',
}, () => {
  const { resolveTreeModelChoice } = require_(PACKED_REGISTRY)
  const words = ['none', 'minimal', ...EFFORT_CHOICES.map(choice => choice.id)]
  for (const row of DISPATCH_TIERS) {
    const asNamed = []
    const mapped = {}
    for (const effort of words) {
      let applied = null
      try { applied = resolveTreeModelChoice({ tier: row.id, effort }).effort } catch (error) {
        assert.equal(error.code, 'AGENT_SPAWN_EFFORT_REFUSED', `${row.id}/${effort}: ${error.message}`)
      }
      if (applied === effort) asNamed.push(effort)
      else if (applied) mapped[effort] = applied
    }
    assert.deepEqual(asNamed, [...tierEffortIds(row)], `${row.id}: the engine accepts ${asNamed.join(', ') || 'nothing'}, the app offers ${tierEffortIds(row).join(', ') || 'nothing'}`)
    for (const [effort, applied] of Object.entries(mapped)) {
      assert.equal(scopedEffort(row, effort), applied, `${row.id}: the engine runs ${effort} as ${applied}, the app would start ${scopedEffort(row, effort)}`)
    }
  }
})
