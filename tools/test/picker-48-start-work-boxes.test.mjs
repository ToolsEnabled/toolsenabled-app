/* 1.0.48 PICKER, UI 4: PROVIDER, THEN MODEL, IN THE RAIL'S START-WORK BOXES.
 *
 * Owner decision: every model a provider offers is selectable, chosen as
 * provider first, then model.
 *
 * The tree agent's own Launch, Team and Loop boxes (views/computers.js
 * nativeBoundedWorkBox) and the dispatch boxes a lane agent gets
 * (launchControlsBox, teamControlsBox, loopControlsBox) each had one menu
 * whose rows read "Luna · codex", a depth menu of Codex words whatever the
 * model with a first row called "Provider default", and control names that did
 * not match the words on screen ("Launch tier" beside "Agent"). The real
 * declarations are lifted out of the view by name and run against the
 * product's own tables, the same lift bounded-work-manual-stop.test.mjs uses.
 *
 *   node --test tools/test/picker-48-start-work-boxes.test.mjs
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { readFileSync } from 'node:fs'

import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import {
  LAUNCH_TIERS, DISPATCH_TIERS, launchTier, tierArgvFragment, UNSUPPORTED_CONTROLS,
  CAP_BOUNDS, clampCapMs, capMinutes, sandboxLevel,
} from '../../src/orchestration-controls.js'
import { PROVIDERS_WITH_A_THINKING_DEPTH } from '../../src/create-and-start-node.js'
import { createTreeWorkController } from '../../src/tree-bounded-work.js'
import { TIER_SEAT_POOL, TEAM_BOUNDS, planTeam, createTeamController } from '../../src/agent-teams.js'
import { LOOP_BOUNDS, LOOP_OVERRUN, LOOP_RUN_CAP, planLoop, createLoopController } from '../../src/agent-loops.js'
import { commonCommandIcon } from '../../src/common-command-icons.js'
import {
  PROVIDER_WORDS, effortChoicesFor, tierChoicesFor, TIER_NOBODY_SIGNED_IN, TIER_NOT_INSTALLED,
} from '../../src/fleet-tree-copy.js'
/* Read off the namespace so a copy row that is not there yet fails a test,
   not the whole file's import. */
import * as copy from '../../src/fleet-tree-copy.js'

const world = installDomStandIn()
after(() => world.restore())
const { el } = await import('../../src/components.js')
/* Loaded softly so this suite fails on BEHAVIOUR, not on a missing import,
   when it is run against the view as it stood before the menus existed. */
const menus = await import('../../src/start-work-menus.js').catch(() => ({}))
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve() }
const escapeMarkup = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])
const MENU_NAMES = ['modelWords', 'providerGroups', 'showProviderModels', 'showEffortChoices', 'startWorkEffort']
const menuScope = Object.fromEntries(MENU_NAMES.map(name => [name, menus[name]]))

const RAW_PROVIDER_KEY = / · (codex|claude|gemini|grok|local)\b/
const values = select => select.querySelectorAll('option').map(option => option.value)
const words = select => select.querySelectorAll('option').map(option => option.textContent.trim())
const change = (select, value) => { select.value = value; select.dispatch('change') }

/* ---------- the tree agent's own boxes ---------- */

function nativeBox(kind, { priorPlan = null, settingsTier = 'astra' } = {}) {
  const parent = { id: 'parent', treeId: 'tree', sessionId: 'parent-session', status: 'finished', name: 'Parent' }
  const nodes = new Map([[parent.id, parent]])
  const routes = new Map([[parent.sessionId, parent.id]])
  const statuses = new Map()
  const starts = []
  const controllers = new Map()
  if (priorPlan) {
    const state = Object.freeze({ kind, phase: 'idle', busy: false, stoppable: false, rows: [], attempts: 0, message: '' })
    controllers.set(`computer:${parent.id}:${kind}`, {
      getPlan: () => priorPlan, getState: () => state,
      subscribe(listener) { listener(state); return () => {} }, run: async () => state, stop: async () => state,
    })
  }
  const bridge = { onEvent: () => () => {}, workStatus: async ({ sessionId }) => statuses.get(sessionId), close: async () => ({ ok: true }) }
  const scope = {
    el, LAUNCH_TIERS, launchTier, clampCapMs, capMinutes, CAP_BOUNDS, PROVIDERS_WITH_A_THINKING_DEPTH, sandboxLevel,
    createTreeWorkController, ...menuScope,
    window: { mcAgent: bridge },
    treeStore: { snapshot: () => ({ computerId: 'computer' }), getNode: id => nodes.get(id) },
    sessionNodeIds: routes, RUN_NATIVE_WORK_CONTROLLERS: controllers, RUN_NATIVE_WORK_CLOSE_LISTENERS: new Set(),
    destroyed: false, unsubs: [], loopIntervals: new Map(), FLEET_TREE_LIMITS: { maxMessageChars: 4000 },
    mockSource: () => false, isWriteEnabled: () => true, START_CONTROL_FLAG: 'agent-session',
    readLaunchSettings: () => ({ tier: settingsTier, capMs: 60000 }), writeLaunchSettings: () => {},
    escapeMarkup, nodeBusy: () => false, refreshTree: () => {}, notifyNodeStatusListeners: () => {},
    settleStoppedSession: () => {}, subscribeBoundedSessionEnded: () => () => {},
    startBoundedChild: async request => {
      starts.push(request)
      const index = starts.length, id = `node-${index}`, sessionId = `session-${index}`
      nodes.set(id, { id, sessionId, treeId: 'tree', parentId: request.parentNodeId, status: 'finished' })
      routes.set(sessionId, id)
      const record = { sequence: index, eventHash: 'a'.repeat(64) }
      const boundedWork = { action: 'tree.dispatch', computerId: 'computer', treeId: 'tree', nodeId: id, agentId: id,
        sessionId, parentNodeId: request.parentNodeId, parentSessionId: request.parentSessionId,
        capMs: 60000, startedAt: 1000, deadlineAt: 61000 }
      statuses.set(sessionId, { ok: true, ...boundedWork, state: 'ready', record })
      return { ok: true, nodeId: id, sessionId, boundedWork, record }
    },
  }
  const panel = new Function(...Object.keys(scope), `${declaredFunctionSource(source, 'nativeBoundedWorkBox')}; return nativeBoundedWorkBox`)(...Object.values(scope))
  const box = panel(parent, kind)
  document.body.appendChild(box)
  const field = kind === 'launch' ? 'launch' : kind
  const model = box.querySelector(`[data-${field}="${kind === 'team' ? 'lead' : 'tier'}"]`)
  return {
    box, starts, model, controllers,
    provider: box.querySelector('[data-work-provider]'),
    depth: box.querySelector('[data-work-effort]'),
    go: box.querySelector(`[data-${field}="${kind === 'launch' ? 'dispatch' : 'go'}"]`),
    remove: () => box.remove(),
  }
}

test('the tree Launch box asks for the provider first, in provider words, then only that provider\'s models', t => {
  const f = nativeBox('launch')
  t.after(f.remove)
  assert.ok(f.provider, 'there is no Provider menu before the Model menu')
  assert.deepEqual(values(f.provider), ['codex', 'claude'], 'the tree boxes start Codex and Claude work, in the Provider menu order')
  assert.deepEqual(words(f.provider), ['Codex', 'Claude'], 'a provider is named in its word, never its key')
  assert.equal(f.provider.value, 'codex')
  assert.deepEqual(values(f.model), LAUNCH_TIERS.filter(tier => tier.provider === 'codex').map(tier => tier.id),
    'the Model menu holds the chosen provider\'s rows only, in table order')
  assert.equal(f.model.value, 'astra', 'the saved launch choice is still what the box opens on')
  for (const label of words(f.model)) {
    assert.doesNotMatch(label, RAW_PROVIDER_KEY, `a model row still prints a provider key: "${label}"`)
    assert.match(label, / · Codex$/, `a model row does not read "<Model> · <Provider>": "${label}"`)
  }
})

test('each control on the tree boxes is named with the words beside it', t => {
  for (const kind of ['launch', 'team', 'loop']) {
    const f = nativeBox(kind)
    t.after(f.remove)
    for (const label of f.box.querySelectorAll('label.ctl-field')) {
      const control = label.querySelector('select')
      if (!control) continue
      const visible = label.querySelector('.cl').textContent.trim()
      assert.equal(control.getAttribute('aria-label'), visible,
        `${kind}: the control shown as "${visible}" is announced as "${control.getAttribute('aria-label')}"`)
    }
    const shown = f.box.querySelectorAll('label.ctl-field .cl').map(node => node.textContent.trim())
    const [providerWord, modelWord] = kind === 'team' ? ['Lead provider', 'Lead model'] : ['Provider', 'Model']
    assert.ok(shown.indexOf(providerWord) >= 0 && shown.indexOf(providerWord) < shown.indexOf(modelWord),
      `${kind}: "${providerWord}" does not come before "${modelWord}" (${shown.join(', ')})`)
    assert.doesNotMatch(f.box.textContent, /Provider default|\btier\b/i, `${kind}: the box still reads "Provider default" or "tier"`)
  }
})

test('a new provider lands on its default model and that model\'s depths, with "Model default" for Claude', t => {
  const f = nativeBox('launch')
  t.after(f.remove)
  assert.deepEqual(values(f.depth), effortChoicesFor('astra').map(choice => choice.id), 'the depth menu is not GPT-6-Astra\'s own')
  assert.equal(f.depth.value, 'medium', 'an untouched Codex depth is the row\'s own default')
  change(f.provider, 'claude')
  assert.equal(f.model.value, 'claude-opus', 'Claude\'s default is the moving "Opus (latest)"')
  assert.deepEqual(values(f.model), LAUNCH_TIERS.filter(tier => tier.provider === 'claude').map(tier => tier.id))
  assert.ok(values(f.model).includes('claude-opus-5') && values(f.model).includes('claude-sonnet-5'), 'Opus 5 and Sonnet 5 are reachable')
  assert.deepEqual(values(f.depth), effortChoicesFor('claude-opus').map(choice => choice.id))
  assert.equal(words(f.depth)[0], 'Model default')
  assert.equal(f.depth.value, '', 'an untouched Codex medium was carried onto Claude as if somebody chose it')
  change(f.model, 'claude-haiku-4-5')
  assert.deepEqual(values(f.depth), [''], 'Haiku 4.5 takes no depth, so only "Model default" is offered')
  change(f.model, 'claude-opus-4-6')
  assert.ok(!values(f.depth).includes('xhigh'), 'Opus 4.6 has no xhigh')
})

test('a depth the person picked follows them to a model that takes it, and only there', t => {
  const f = nativeBox('launch')
  t.after(f.remove)
  change(f.depth, 'xhigh')
  change(f.provider, 'claude')
  assert.equal(f.depth.value, 'xhigh', 'a picked xhigh was dropped on "Opus (latest)", which takes it')
  change(f.model, 'claude-opus-4-6')
  assert.equal(f.depth.value, '', 'xhigh reached Opus 4.6, which has none, instead of its own default')
  change(f.depth, 'max')
  change(f.provider, 'codex')
  assert.equal(f.model.value, 'astra')
  assert.equal(f.depth.value, 'max')
})

test('a retained plan is put back provider first, then model, then depth', t => {
  const plan = { tier: 'claude-opus-5', effort: 'high', capMs: 120000, brief: 'Retained brief', members: [] }
  const f = nativeBox('launch', { priorPlan: plan })
  t.after(f.remove)
  assert.equal(f.provider.value, 'claude', 'the provider of the retained model was not restored')
  assert.ok(values(f.model).includes('claude-opus-5'), 'the retained model is not among the rows shown')
  assert.equal(f.model.value, 'claude-opus-5')
  assert.equal(f.depth.value, 'high')
  const unset = nativeBox('loop', { priorPlan: { ...plan, tier: 'claude-sonnet-5', effort: null, iterations: 2, intervalMs: 60000 } })
  t.after(unset.remove)
  assert.equal(unset.provider.value, 'claude')
  assert.equal(unset.model.value, 'claude-sonnet-5')
  assert.equal(unset.depth.value, '', 'a plan started at "Model default" came back with a depth nobody chose')
})

test('the Team box lists its members under their provider, named as shown', t => {
  const f = nativeBox('team')
  t.after(f.remove)
  const groups = f.box.querySelectorAll('.team-member-group')
  assert.deepEqual(groups.map(group => group.getAttribute('aria-label')), ['Codex', 'Claude'],
    'members are not grouped under provider words')
  for (const group of groups) {
    assert.equal(group.getAttribute('role'), 'group')
    const provider = Object.entries(PROVIDER_WORDS).find(([, word]) => word === group.getAttribute('aria-label'))[0]
    assert.equal(group.querySelector('.team-member-provider').textContent.trim(), group.getAttribute('aria-label'))
    assert.deepEqual(group.querySelectorAll('[data-team-member]').map(input => input.getAttribute('data-team-member')),
      LAUNCH_TIERS.filter(tier => tier.provider === provider).map(tier => tier.id))
  }
})

test('each Team member starts at the chosen depth only where its own model takes it', async t => {
  const f = nativeBox('team')
  t.after(f.remove)
  f.model.value = 'astra'
  // Picked, as a person picks it: the menu raises a change.
  change(f.depth, 'xhigh')
  for (const id of ['claude-haiku-4-5', 'claude-opus-4-6', 'claude-opus-5']) {
    const member = f.box.querySelector(`[data-team-member="${id}"]`)
    member.checked = true
    member.dispatch('change')
  }
  const brief = f.box.querySelector('[data-work-brief]')
  brief.value = 'Three members on three Claude models.'
  brief.dispatch('input')
  assert.equal(f.go.disabled, false, f.box.textContent)
  f.go.dispatch('click')
  await flush()
  // Members start in table order: Opus 5, then Haiku 4.5, then Opus 4.6.
  assert.deepEqual(f.starts.map(request => [request.tier, request.effort]), [
    ['astra', 'xhigh'],
    ['claude-opus-5', 'xhigh'],
    ['claude-haiku-4-5', null],
    ['claude-opus-4-6', null],
  ], 'a member was handed a depth its model refuses (Haiku takes none, Opus 4.6 has no xhigh)')
  const roster = f.box.querySelector('[data-work-roster]').textContent
  assert.match(roster, /Lead · GPT-6-Astra · Codex/)
  assert.match(roster, /Member 2 · Haiku 4\.5 · Claude/)
  assert.doesNotMatch(roster, /claude-haiku-4-5|· astra\b/, 'the roster printed a row id')
})

/* REVIEW P1. The Team box's depth menu has no empty first row under a Codex
   lead, so an untouched menu holds that lead's default (astra medium). The
   controller hands plan.effort to every member, so every member ran at the
   LEAD's default: GPT-5.6-Sol at medium instead of xhigh, Sonnet 5 at medium
   instead of its own served default. Only a depth the person picked is
   handed on; an untouched one leaves every start on its own row default. */
test('an untouched Team depth is not handed to the members as if somebody chose it', async t => {
  const f = nativeBox('team')
  t.after(f.remove)
  assert.equal(f.model.value, 'astra')
  /* Follow-up V2: what the untouched menu shows is what runs -- each model's
     own default, not the lead's. */
  assert.equal(f.depth.value, '', 'the untouched menu shows the lead\'s default, which no member is handed')
  for (const id of ['claude-sonnet-5', 'sol']) {
    const member = f.box.querySelector(`[data-team-member="${id}"]`)
    member.checked = true
    member.dispatch('change')
  }
  const brief = f.box.querySelector('[data-work-brief]')
  brief.value = 'Two members.'
  brief.dispatch('input')
  f.go.dispatch('click')
  await flush()
  assert.deepEqual(f.starts.map(request => [request.tier, request.effort]), [
    ['astra', null],
    ['sol', null],
    ['claude-sonnet-5', null],
  ], 'the lead\'s default depth was handed to every member')

  /* The knock-on: a box drawn again from the plan that run kept must not
     read the lead's default back as a picked depth and carry it onto another
     model. */
  const plan = f.controllers.get('computer:parent:team').getPlan()
  assert.ok(plan, 'the run kept no plan')
  assert.equal(plan.effort, null, 'the kept plan records the untouched default as chosen')
  const again = nativeBox('team', { priorPlan: plan })
  t.after(again.remove)
  assert.equal(again.depth.value, '')
  change(again.provider, 'claude')
  assert.equal(again.depth.value, '', 'a re-drawn box carried the lead\'s untouched default onto Claude')
})

/* FOLLOW-UP V2. Under a GPT-6-Astra lead the untouched Team menu showed
   `medium`, and the box said "A member whose model lacks this depth runs at
   its model's default". Neither was true: an untouched depth goes to nobody,
   so GPT-5.6-Sol started at xhigh and Sonnet 5 at its own default though
   both offer medium, and choosing the `medium` already shown raised no
   change, so it could not be handed on at all. The menu opens on "Each
   model's default" now, which is what runs, and the sentence says so. */
test('the Team depth menu opens on "Each model\'s default", and the box says what a depth does', async t => {
  const label = copy.EACH_MODEL_DEFAULT_EFFORT?.label
  assert.ok(label, 'there is no "Each model\'s default" row in the copy module')
  const f = nativeBox('team')
  t.after(f.remove)
  assert.deepEqual(values(f.depth), ['', ...effortChoicesFor('astra').map(choice => choice.id)])
  assert.equal(words(f.depth)[0], label)
  assert.equal(f.depth.value, '', 'the untouched menu does not show what runs')
  change(f.provider, 'claude')
  assert.deepEqual(values(f.depth), effortChoicesFor('claude-opus').map(choice => choice.id),
    'a Claude lead lists "Model default" beside "Each model\'s default"')
  assert.equal(words(f.depth)[0], label)
  assert.equal(f.depth.value, '')
  change(f.provider, 'codex')
  // The medium shown under Astra can now be picked, and then it is handed on.
  change(f.depth, 'medium')
  for (const id of ['sol', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    const member = f.box.querySelector(`[data-team-member="${id}"]`)
    member.checked = true
    member.dispatch('change')
  }
  const brief = f.box.querySelector('[data-work-brief]')
  brief.value = 'Three members.'
  brief.dispatch('input')
  f.go.dispatch('click')
  await flush()
  assert.deepEqual(f.starts.map(request => [request.tier, request.effort]), [
    ['astra', 'medium'], ['sol', 'medium'], ['claude-sonnet-5', 'medium'], ['claude-haiku-4-5', null],
  ], 'a picked medium was not handed to the members whose model offers it')
  const sentence = f.box.querySelectorAll('.rail-sub').find(line => /Worker identity/.test(line.textContent))?.textContent || ''
  assert.doesNotMatch(sentence, /lacks this depth/, 'the box still says an untouched depth reaches the members')
  assert.match(sentence, /picked depth/)
  for (const part of sentence.split(/(?<=[.!?])\s+/)) assert.ok(part.split(/\s+/).length <= 25, part)
  // The Launch and Loop boxes start one model; their menus still open on its default.
  const launch = nativeBox('launch')
  t.after(launch.remove)
  assert.equal(launch.depth.value, 'medium')
  assert.ok(!words(launch.depth).includes(label))
})

/* FOLLOW-UP V2b. A picked depth the next model does not offer falls back to
   that model's default, and the fallback was still counted as picked: it
   followed the person to the next model (a GPT-5.6-Luna `medium` carried onto
   Claude) and, on a Team, went to every member. */
test('a picked depth the new model lacks falls back, and the fallback is nobody\'s pick', async t => {
  const f = nativeBox('launch')
  t.after(f.remove)
  change(f.depth, 'ultra')
  change(f.model, 'luna')
  assert.equal(f.depth.value, 'medium', 'GPT-5.6-Luna has no ultra, so it shows its own default')
  change(f.provider, 'claude')
  assert.equal(f.depth.value, '', 'GPT-5.6-Luna\'s fallback medium was carried onto Claude as if picked')

  const team = nativeBox('team')
  t.after(team.remove)
  change(team.depth, 'ultra')
  change(team.model, 'luna')
  assert.equal(team.depth.value, '', 'the Team menu did not fall back to "Each model\'s default"')
  for (const id of ['sol', 'claude-sonnet-5']) {
    const member = team.box.querySelector(`[data-team-member="${id}"]`)
    member.checked = true
    member.dispatch('change')
  }
  const brief = team.box.querySelector('[data-work-brief]')
  brief.value = 'Two members.'
  brief.dispatch('input')
  team.go.dispatch('click')
  await flush()
  assert.deepEqual(team.starts.map(request => [request.tier, request.effort]), [
    ['luna', null], ['sol', null], ['claude-sonnet-5', null],
  ], 'a fallback depth was handed to every member')
})

/* ---------- the dispatch boxes a lane agent gets ---------- */

function legacyBox(name, { tier = 'astra' } = {}) {
  const saved = []
  const scope = {
    el, escapeMarkup, DISPATCH_TIERS, tierArgvFragment, UNSUPPORTED_CONTROLS, CAP_BOUNDS, clampCapMs, capMinutes, sandboxLevel,
    TIER_SEAT_POOL, TEAM_BOUNDS, planTeam, createTeamController,
    LOOP_BOUNDS, LOOP_OVERRUN, LOOP_RUN_CAP, planLoop, createLoopController, commonCommandIcon,
    ...menuScope,
    treeStore: { getNode: () => null }, nativeBoundedWorkBox: () => { throw new Error('a lane agent reached the tree box') },
    readLaunchSettings: () => ({ tier, capMs: 60000 }), writeLaunchSettings: next => saved.push(next),
    isWriteEnabled: () => false, drivenComputerCopy: desk => desk, window: {},
    prepareBridgeOnce: async () => ({ ok: false }), postBridgeAction: async () => ({ ok: false }),
    refusalCodeOf: () => null, refusalSentence: () => '', markRefusalCode: () => {},
    loopIntervals: new Map(), notifyNodeStatusListeners: () => {}, fetchAgents: async () => ({ ok: false }),
  }
  const build = new Function(...Object.keys(scope), `${declaredFunctionSource(source, name)}; return ${name}`)(...Object.values(scope))
  const box = build({ id: 'lane-agent', name: 'Lane agent' }, { live: true })
  document.body.appendChild(box)
  return { box, saved, remove: () => box.remove() }
}

test('the dispatch Launch box asks for the provider, then the model, over every dispatch row', t => {
  const f = legacyBox('launchControlsBox')
  t.after(f.remove)
  const provider = f.box.querySelector('[data-launch="provider"]')
  const model = f.box.querySelector('[data-launch="tier"]')
  assert.ok(provider, 'there is no Provider menu on the dispatch Launch box')
  assert.deepEqual(words(provider), ['Codex', 'Claude', 'Local'])
  assert.equal(provider.getAttribute('aria-label'), 'Provider')
  assert.equal(model.getAttribute('aria-label'), 'Model')
  assert.deepEqual(words(model)[0], 'GPT-6-Astra · Codex · medium')
  for (const label of words(model)) assert.doesNotMatch(label, RAW_PROVIDER_KEY, label)
  const every = []
  for (const id of values(provider)) { change(provider, id); every.push(...values(model)) }
  assert.deepEqual(every, DISPATCH_TIERS.map(tier => tier.id), 'a dispatch row cannot be reached through the Provider menu')
})

test('a provider change on the dispatch Launch box repaints the flags and saves the model it landed on', t => {
  const f = legacyBox('launchControlsBox')
  t.after(f.remove)
  const argv = f.box.querySelector('[data-launch="argv"]')
  assert.equal(argv.textContent, tierArgvFragment('astra').join(' '))
  change(f.box.querySelector('[data-launch="provider"]'), 'claude')
  assert.equal(f.box.querySelector('[data-launch="tier"]').value, 'claude-opus')
  assert.equal(argv.textContent, tierArgvFragment('claude-opus').join(' '), 'the argv line still shows the previous provider\'s flags')
  assert.equal(f.saved.at(-1)?.tier, 'claude-opus', 'the landed-on model was not saved as the launch choice')
})

test('the dispatch Team box: lead provider then lead model, members under their provider, plan in words', t => {
  const f = legacyBox('teamControlsBox')
  t.after(f.remove)
  const provider = f.box.querySelector('[data-team="provider"]')
  const lead = f.box.querySelector('[data-team="lead"]')
  assert.ok(provider, 'there is no lead Provider menu on the dispatch Team box')
  assert.equal(provider.getAttribute('aria-label'), 'Lead provider')
  assert.equal(lead.getAttribute('aria-label'), 'Lead model')
  assert.deepEqual(f.box.querySelectorAll('.team-member-group').map(group => group.getAttribute('aria-label')), ['Codex', 'Claude', 'Local'])
  assert.deepEqual(f.box.querySelectorAll('[data-team-member]').map(input => input.getAttribute('data-team-member')),
    DISPATCH_TIERS.map(tier => tier.id), 'the grouped members lost or reordered a dispatch row')
  const member = f.box.querySelector('[data-team-member="luna"]')
  member.checked = true
  member.dispatch('change')
  const plan = f.box.querySelector('[data-team="plan"]')
  assert.match(plan.textContent, /^Ready: GPT-6-Astra · Codex leads 1 member/, plan.textContent)
  change(provider, 'claude')
  assert.equal(lead.value, 'claude-opus')
  assert.match(plan.textContent, /^Ready: Opus \(latest\) · Claude leads 1 member/, 'the plan line was not redone for the new lead')
})

test('the dispatch Loop box: provider then model, and a plan line in words', t => {
  const f = legacyBox('loopControlsBox')
  t.after(f.remove)
  const provider = f.box.querySelector('[data-loop="provider"]')
  const model = f.box.querySelector('[data-loop="tier"]')
  assert.ok(provider, 'there is no Provider menu on the dispatch Loop box')
  assert.equal(provider.getAttribute('aria-label'), 'Provider')
  assert.equal(model.getAttribute('aria-label'), 'Model')
  assert.equal(f.box.querySelector('[data-loop="every"]').getAttribute('aria-label'), 'Every')
  const plan = f.box.querySelector('[data-loop="plan"]')
  assert.match(plan.textContent, /^Ready: GPT-6-Astra · Codex runs up to/, plan.textContent)
  change(provider, 'claude')
  assert.equal(model.value, 'claude-opus')
  assert.match(plan.textContent, /^Ready: Opus \(latest\) · Claude runs up to/, 'the plan line was not redone for the new model')
})

/* ---------- the start menu's sign-in words, desk and remote ---------- */

test('a start menu row names the computer being driven, at the desk and over the relay', () => {
  const lift = new Function('tierChoicesFor', 'drivenComputerCopy', 'startableTierIdList', 'signedOutProviders',
    'noProgramProviders', 'tierAnswerMissing', 'composePanel', 'refreshTreeEngineFace',
    `let startableTierChoices = null
     ${declaredFunctionSource(source, 'repaintTierRows')}
     return () => { repaintTierRows(); return startableTierChoices }`)
  const rows = (reading, signedOut, notInstalled) => lift(tierChoicesFor, (desk, remote) => (reading === 'relay' ? remote : desk),
    ['astra', 'claude-opus'], signedOut, notInstalled, false, null, () => {})()
  assert.equal(rows('desk', ['codex'], []).find(row => row.id === 'astra').why, 'nobody is signed in to Codex on this computer')
  assert.equal(rows('relay', ['codex'], []).find(row => row.id === 'astra').why, 'nobody is signed in to Codex on the computer you are driving')
  assert.equal(rows('relay', [], ['claude']).find(row => row.id === 'claude-opus').why, TIER_NOT_INSTALLED('Claude', 'the computer you are driving'))
  assert.equal(TIER_NOBODY_SIGNED_IN('Codex'), 'nobody is signed in to Codex on this computer')
  // B19: the Local row said "Local · the computer you are driving" at the desk too.
  assert.ok(rows('desk', [], []).find(row => row.id === 'local').label.startsWith('Local · this computer'),
    rows('desk', [], []).find(row => row.id === 'local').label)
  assert.ok(rows('relay', [], []).find(row => row.id === 'local').label.startsWith('Local · the computer you are driving'),
    rows('relay', [], []).find(row => row.id === 'local').label)
})

/* ---------- the helpers and the sheet ---------- */

test('the menu helpers read provider words and never hand a member a depth its model refuses', () => {
  assert.equal(typeof menus.modelWords, 'function', 'src/start-work-menus.js is missing')
  assert.equal(menus.modelWords('luna'), 'GPT-5.6-Luna · Codex')
  assert.equal(menus.modelWords('sol', { withEffort: true }), 'GPT-5.6-Sol · Codex · xhigh')
  assert.equal(menus.modelWords('claude-opus-5', { withEffort: true }), 'Opus 5 · Claude')
  assert.equal(menus.modelWords('a-row-from-a-newer-copy'), '')
  /* REVIEW P12: a model named like its provider is named once, the rule
     tree-standalone-agent.js fullLabel already uses. */
  assert.equal(menus.modelWords('local'), 'Local', 'the Local row read "Local · Local"')
  for (const row of DISPATCH_TIERS) {
    assert.doesNotMatch(menus.modelWords(row), /^(.+) · \1\b/, `${row.id} repeats its own word`)
  }
  assert.deepEqual(menus.providerGroups(DISPATCH_TIERS).flatMap(group => group.rows.map(row => row.id)), DISPATCH_TIERS.map(tier => tier.id))
  assert.equal(menus.startWorkEffort('claude-haiku-4-5', 'high'), null)
  assert.equal(menus.startWorkEffort('claude-opus-4-6', 'xhigh'), null)
  assert.equal(menus.startWorkEffort('claude-opus-5', 'ultra'), 'max', 'Claude runs ultra as max')
  assert.equal(menus.startWorkEffort('astra', null), null)
})

test('the provider groups are styled with tokens only', () => {
  const css = readFileSync(new URL('../../src/board.css', import.meta.url), 'utf8')
  for (const selector of ['.team-member-groups', '.team-member-provider', '.team-member-group > .team-member-grid']) {
    const at = css.indexOf(`.board-page ${selector} {`)
    assert.ok(at >= 0, `board.css has no rule for ${selector}`)
    const rule = css.slice(at, css.indexOf('}', at))
    assert.doesNotMatch(rule, /\d(px|rem|em)\b|#[0-9a-f]{3,8}\b/i, `${selector} uses a raw value: ${rule}`)
  }
})
