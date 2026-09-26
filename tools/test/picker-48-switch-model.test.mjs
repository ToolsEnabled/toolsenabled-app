/* 1.0.48 PROVIDER-THEN-MODEL PICKER, UI STAGE 3: SWITCHING A MODEL.
 *
 * Owner decision for 1.0.48: every model a provider offers is selectable,
 * chosen as provider first, then model (for example Opus 5 and Sonnet 5 on
 * Claude), and a person can switch a running or stopped agent to any of
 * them.
 *
 * The three places a running or stopped agent changes model, and the one place
 * it changes depth while running:
 *
 *   - Actions > Switch model (and the model chip, which opens the same stage):
 *     a stage of providers, then that provider's models through ctx.show. A
 *     model row keeps "<Model> · <Provider>", because the popup is one listbox
 *     named "Actions" and a stage title is not announced.
 *   - Switch and continue: a Provider group before Account, Model and Depth
 *     that narrows all three, with one [data-switch-model] per row kept in
 *     table order.
 *   - How hard it thinks, on a running session: without an engine catalog the
 *     depths are the running model's own (effortChoicesFor), never the six
 *     Codex names -- no ultra on Claude, nothing but "Model default" on
 *     Haiku 4.5.
 *   - A depth carried onto another model is kept only where that model takes
 *     it (D4): Sonnet's high does not reach Haiku 4.5, whose CLI refuses one.
 *
 *   MC_CANONICAL_ROOT=<engine> node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/picker-48-switch-model.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import {
  EFFORT_CHOICES, EFFORT_SWITCH, MODEL_PANEL, PROVIDER_CHOICES, SWITCH_PANEL,
  effortChoicesFor, tierProviderWord,
} from '../../src/fleet-tree-copy.js'
import { switchChoices, mountSwitchAndContinueDialog } from '../../src/switch-and-continue.js'
import {
  payloadSkip, runningCircle, waitFor, pressContinueRow, startedRequests, providerRowIn, openProviderStage, sharedBridge,
} from './lib/t158-switch-model-harness.mjs'

const CLAUDE_DEPTHS = ['low', 'medium', 'high', 'xhigh', 'max']
const idsOf = rows => rows.map(row => row.id)
const labelOf = row => row.children?.[0]?.textContent || ''
const actionRows = chat => chat.querySelectorAll('.chat-actions-row').filter(row => !row.classList.contains('chat-actions-back'))

/* ---------------------------------------------------------------
   Actions > Switch model, on a real mounted running circle
   --------------------------------------------------------------- */

test('Switch model opens on the providers, and each provider stage lists only that provider\'s models',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  const chat = ctx.liveChat()
  chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => Boolean(providerRowIn(ctx.liveChat(), 'Codex')), 'the provider stage')

  const first = actionRows(ctx.liveChat())
  assert.deepEqual(first.map(labelOf), [MODEL_PANEL.keep, ...PROVIDER_CHOICES.map(provider => provider.label)],
    'the first stage is Keep, then the five providers -- no model rows yet')
  const marked = first.filter(row => row.classList.contains('is-current')).map(labelOf).filter(label => label !== MODEL_PANEL.keep)
  assert.deepEqual(marked, ['Claude'], 'the provider the conversation runs on is marked')
  assert.match(providerRowIn(ctx.liveChat(), 'Claude').textContent, /Sonnet \(latest\) · Claude/, 'and it says which model')

  for (const provider of PROVIDER_CHOICES) {
    await openProviderStage(ctx.liveChat(), provider.label)
    await waitFor(() => Boolean(ctx.liveChat().querySelector('.chat-actions-back')), `the ${provider.label} stage`)
    const rows = actionRows(ctx.liveChat())
    const expected = LAUNCH_TIERS.filter(tier => tier.provider === provider.id)
    assert.equal(rows.length, expected.length, `${provider.label}: one row per ${provider.label} model and nothing else`)
    expected.forEach((tier, index) => {
      assert.ok(labelOf(rows[index]).endsWith(`${tier.label} · ${tierProviderWord(tier.id)}`),
        `${provider.label}: row ${index} is ${tier.id}, in table order, and names its provider: ${labelOf(rows[index])}`)
    })
    ctx.liveChat().querySelector('.chat-actions-back').dispatch('click')
    await waitFor(() => Boolean(providerRowIn(ctx.liveChat(), 'Codex')), 'back on the provider stage')
  }
})

for (const [label, tier, from] of [['Opus 5 · Claude', 'claude-opus-5', { fromTier: 'claude-sonnet', provider: 'claude' }],
  ['Sonnet 5 · Claude', 'claude-sonnet-5', { fromTier: 'astra', provider: 'codex' }]]) {
  test(`${label} is reachable from a running ${from.provider} conversation, and it starts on ${tier}`,
    { skip: payloadSkip }, async t => {
    const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, from)
    await pressContinueRow(ctx, `Continue on ${label}`)
    await waitFor(() => startedRequests(ctx).length === 1, 'the pressed row to start its replacement')
    const request = startedRequests(ctx)[0].request
    assert.equal(request.tier, tier, 'the replacement runs the pinned model the person pressed')
    assert.equal(request.effort, undefined, 'a Claude model with no depth set starts at "Model default": no depth is sent')
    await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'the replacement to take the circle over')
    assert.equal(ctx.readNode().tier, tier)
  })
}

/* Sonnet at high: Opus 5 takes high, Haiku 4.5 takes no depth at all and its
   CLI refuses one. Measured before this change: --effort high reached Haiku. */
test('a depth carried onto a model that takes none is dropped: Sonnet at high continued on Haiku 4.5', { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, { effort: 'high' })
  assert.equal(ctx.readNode().effort, 'high', 'the fixture circle was set to high')
  await pressContinueRow(ctx, 'Continue on Haiku 4.5 · Claude')
  await waitFor(() => startedRequests(ctx).length === 1, 'the Haiku replacement')
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-haiku-4-5')
  assert.equal(startedRequests(ctx)[0].request.effort, undefined, 'Haiku 4.5 is sent no depth')
})

test('a depth the new model takes still travels with it: Sonnet at high continued on Opus 5', { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, { effort: 'high' })
  await pressContinueRow(ctx, 'Continue on Opus 5 · Claude')
  await waitFor(() => startedRequests(ctx).length === 1, 'the Opus 5 replacement')
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus-5')
  assert.equal(startedRequests(ctx)[0].request.effort, 'high')
})

/* The same rule on the other route: Switch and continue on the SAME account
   resumes the saved thread on the new model, and the depth it resumes at is
   the circle's own unless that model does not take it. */
for (const [tier, effort] of [['claude-haiku-4-5', undefined], ['claude-opus-5', 'high']]) {
  test(`Switch and continue from Sonnet at high onto ${tier} resumes at ${effort === undefined ? 'no depth' : effort}`,
    { skip: payloadSkip }, async t => {
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: LAUNCH_TIERS.map(row => row.id) })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, { effort: 'high' })
    const chat = ctx.liveChat(); chat.openActions()
    chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
    await waitFor(() => document.body.querySelector('.switch-continue'), 'the Switch and continue dialog')
    const dialog = document.body.querySelector('.switch-continue')
    assert.equal(dialog.querySelectorAll('[data-switch-provider]').find(input => input.checked)?.value, 'claude')
    const model = dialog.querySelectorAll('[data-switch-model]').find(input => input.value === tier)
    assert.ok(model && !model.disabled && !model.closest('[hidden]'), `${tier} is shown and can be picked`)
    model.checked = true; model.dispatch('change')
    assert.equal(dialog.querySelector('[data-switch-cost]').textContent, SWITCH_PANEL.costResume, 'the same account resumes')
    dialog.querySelector('[data-switch-continue]').dispatch('click')
    await waitFor(() => startedRequests(ctx).length === 1, 'the resume onto the new model')
    const request = startedRequests(ctx)[0].request
    assert.equal(request.tier, tier)
    assert.equal(request.effort, effort)
  })
}

/* ---------------------------------------------------------------
   How hard it thinks, on a running session: the production rows, sliced
   --------------------------------------------------------------- */

const computersSource = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
function effortStage(tier, { catalog = [], effort = null, override = null } = {}) {
  const node = { id: 'effort-node', tier, sessionId: 'effort-session' }
  const start = computersSource.indexOf('const effortRows = () => {')
  const end = computersSource.indexOf('\n    const openPermissionSettings', start)
  assert.ok(start >= 0 && end > start, 'the running-session depth rows are where this case reads them')
  const bindings = {
    fresh: () => node, node, engineEffortsFor: () => catalog, LAUNCH_TIERS, EFFORT_CHOICES, effortChoicesFor, EFFORT_SWITCH,
    sessionModelOverride: new Map(override ? [[node.sessionId, override]] : []), currentEffort: () => effort,
    nodeReplacementFlight: { busy: () => false }, recoveryCoordinator: () => null, sessionNodeIds: new Map([[node.sessionId, node.id]]),
    saveStoppedSessionEffort: () => true, transcriptStore: null, treeStore: null, notifyNodeStatusListeners() {},
    nodeBusy: () => false, sessionEfforts: new Map(), resumeNodeSession: async () => true, statusSink: () => ({}),
  }
  return Function(...Object.keys(bindings), computersSource.slice(start, end) + '\nreturn effortRows')(...Object.values(bindings))()
}

test('a running Claude session is offered only the depths its model takes -- never ultra, never none', () => {
  for (const tier of LAUNCH_TIERS.filter(row => row.provider === 'claude')) {
    const ids = idsOf(effortStage(tier.id))
    assert.ok(!ids.includes('effort-ultra') && !ids.includes('effort-none'), `${tier.id}: ${ids.join(', ')}`)
    assert.equal(ids[0], 'effort-model-default', `${tier.id}: "Model default" leads, because the row states no depth`)
  }
  assert.deepEqual(idsOf(effortStage('claude-sonnet-5')), ['effort-model-default', ...CLAUDE_DEPTHS.map(id => 'effort-' + id)])
  assert.deepEqual(idsOf(effortStage('claude-opus-4-6')), ['effort-model-default', 'effort-low', 'effort-medium', 'effort-high', 'effort-max'],
    'Opus 4.6 has no xhigh')
})

test('Haiku 4.5 is offered no depth at all', () => {
  const rows = effortStage('claude-haiku-4-5')
  assert.deepEqual(idsOf(rows), ['effort-model-default'], 'nothing but the fact that the model chooses')
  assert.equal(rows[0].current, true, 'and it runs that way now')
  assert.equal(rows[0].enabled, true)
})

test('"Model default" is the running depth when none is set, and a refused fact once one is', () => {
  const unset = effortStage('claude-opus-5')
  assert.equal(unset.find(row => row.id === 'effort-model-default').current, true)
  const set = effortStage('claude-opus-5', { effort: 'high' })
  const modelDefault = set.find(row => row.id === 'effort-model-default')
  assert.equal(modelDefault.enabled, false, 'a restart carries the set depth, so it cannot send none')
  assert.equal(modelDefault.disabledHint, EFFORT_SWITCH.modelDefaultKept)
  assert.equal(set.find(row => row.id === 'effort-high').current, true)
})

test('without a catalog a Codex session reads its own model\'s depths; with one, the engine\'s answer wins', () => {
  assert.ok(!idsOf(effortStage('luna')).includes('effort-ultra'), 'GPT-5.6-Luna has no ultra')
  assert.ok(idsOf(effortStage('astra')).includes('effort-ultra'), 'GPT-6-Astra does')
  assert.ok(!idsOf(effortStage('astra', { override: 'gpt-5.6-luna' })).includes('effort-ultra'),
    'an in-place switch to GPT-5.6-Luna reads Luna\'s depths, not Astra\'s')
  assert.deepEqual(idsOf(effortStage('astra', { catalog: [{ id: 'high', description: 'from the engine' }] })), ['effort-high'])
})

/* ---------------------------------------------------------------
   Switch and continue: the Provider group
   --------------------------------------------------------------- */

const ACCOUNTS = [
  { name: 'approved', provider: 'claude', signedIn: true },
  { name: 'work-codex', provider: 'codex', signedIn: true },
]
function mountDialog(dom, { currentTier = 'claude-sonnet', effort = null, onChoose = () => {} } = {}) {
  const choices = switchChoices({ accounts: ACCOUNTS, tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier,
    currentEffort: effort, startable: LAUNCH_TIERS.map(tier => tier.id), answered: true })
  const host = dom.document.createElement('div')
  const dialog = mountSwitchAndContinueDialog({ document: dom.document, host, choices, tiers: LAUNCH_TIERS,
    current: { account: 'current-claude', provider: LAUNCH_TIERS.find(tier => tier.id === currentTier).provider, tier: currentTier, effort }, onChoose })
  assert.ok(dialog, 'the dialog mounts')
  return { host, dialog, choices }
}
const shown = input => !input.closest('[hidden]')
const visibleValues = (host, selector) => host.querySelectorAll(selector).filter(shown).map(input => input.value)
const checkedValue = (host, selector) => host.querySelectorAll(selector).find(input => input.checked && !input.disabled)?.value ?? null
const choose = (host, selector, value) => {
  const input = host.querySelectorAll(selector).find(row => row.value === value)
  assert.ok(input, `${selector}=${value} is drawn`)
  assert.equal(input.disabled, false, `${selector}=${value} can be picked`)
  input.checked = true
  input.dispatch('change')
}

test('Switch and continue asks for the provider first, and keeps one model input per row in table order', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const { host } = mountDialog(dom)
    const legends = host.querySelectorAll('legend').map(legend => legend.textContent)
    assert.deepEqual(legends, [SWITCH_PANEL.provider, SWITCH_PANEL.account, SWITCH_PANEL.model, SWITCH_PANEL.effort],
      'Provider stands before Account, Model and Depth')
    assert.deepEqual(host.querySelectorAll('[data-switch-provider]').map(input => input.value), PROVIDER_CHOICES.map(provider => provider.id))
    assert.equal(checkedValue(host, '[data-switch-provider]'), 'claude', 'it opens on the provider the circle runs on')
    assert.deepEqual(host.querySelectorAll('[data-switch-model]').map(input => input.value), LAUNCH_TIERS.map(tier => tier.id),
      'every row keeps its own input, in table order')
    assert.deepEqual(visibleValues(host, '[data-switch-model]'), LAUNCH_TIERS.filter(tier => tier.provider === 'claude').map(tier => tier.id),
      'only that provider\'s models are shown')
    assert.ok(visibleValues(host, '[data-switch-account]').includes('approved'))
    assert.ok(!visibleValues(host, '[data-switch-account]').includes('work-codex'), 'another provider\'s account is not offered')
  } finally { dom.restore() }
})

/* REVIEW P10. The keyboard landed on "Keep this account", after the new
   Provider group: Tab then ran Account, Model, Depth, Continue, and Provider
   was reachable only backwards. The first question has the focus now. */
test('Switch and continue opens with the keyboard on the checked provider', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const { host } = mountDialog(dom)
    const focused = host.querySelectorAll('[autofocus]')
    assert.equal(focused.length, 1, 'exactly one control takes the opening focus')
    assert.ok(focused[0].hasAttribute('data-switch-provider'), 'the opening focus is not on the Provider group')
    assert.equal(focused[0].value, 'claude')
    assert.equal(focused[0].checked, true, 'the focus is on the provider it runs on')
    assert.equal(host.querySelector('[data-switch-keep-account] input').hasAttribute('autofocus'), false)
  } finally { dom.restore() }
})

/* REVIEW P11. On a provider with no registered account the Account group read
   "Any signed-in account" (checked) directly above "No other signed-in account
   is registered. Add one on the Accounts page, or pick another model or
   depth." The note is about the provider whose account can be kept. */
test('another provider with no registered account does not contradict "Any signed-in account"', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    const { host } = mountDialog(dom)
    const note = host.querySelector('[data-switch-no-accounts]')
    choose(host, '[data-switch-provider]', 'gemini')
    const any = host.querySelector('[data-switch-any-account]')
    assert.equal(shown(any.querySelector('input')), true)
    assert.equal(any.querySelector('input').checked, true)
    assert.equal(shown(note), false, 'the "no other account" note sat under a checked "Any signed-in account"')

    /* Where the account CAN be kept and no other is registered, it still says so. */
    const choices = switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: 'claude-sonnet',
      currentEffort: null, startable: LAUNCH_TIERS.map(tier => tier.id), answered: true })
    const lone = dom.document.createElement('div')
    mountSwitchAndContinueDialog({ document: dom.document, host: lone, choices, tiers: LAUNCH_TIERS,
      current: { account: 'current-claude', provider: 'claude', tier: 'claude-sonnet', effort: null }, onChoose: () => {} })
    assert.equal(shown(lone.querySelector('[data-switch-no-accounts]')), true, 'the note is gone where it is true')
  } finally { dom.restore() }
})

test('a provider change narrows the accounts, the models and the depths together', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    let chosen = null
    const { host } = mountDialog(dom, { onChoose: value => { chosen = value } })
    choose(host, '[data-switch-provider]', 'codex')
    assert.deepEqual(visibleValues(host, '[data-switch-model]'), LAUNCH_TIERS.filter(tier => tier.provider === 'codex').map(tier => tier.id))
    assert.equal(checkedValue(host, '[data-switch-model]'), 'astra', 'Codex lands on its default model')
    const accounts = host.querySelectorAll('[data-switch-account]').filter(shown)
    assert.deepEqual(accounts.map(input => input.value), ['work-codex', ''], 'Codex accounts, then "any signed-in account"')
    assert.ok(accounts[1].hasAttribute('data-switch-any') && accounts[1].checked, 'a Claude account cannot be kept on Codex')
    assert.deepEqual(visibleValues(host, '[data-switch-effort]'), effortChoicesFor('astra').map(choice => choice.id))
    assert.equal(checkedValue(host, '[data-switch-effort]'), 'medium', 'GPT-6-Astra\'s own default')
    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.deepEqual(chosen, { account: null, provider: 'codex', tier: 'astra', effort: 'medium', route: 'handoff' })
  } finally { dom.restore() }
})

test('Opus 5 and Sonnet 5 are reachable in the dialog, with Claude\'s depths and never ultra', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    for (const tier of ['claude-opus-5', 'claude-sonnet-5']) {
      let chosen = null
      const { host } = mountDialog(dom, { currentTier: 'astra', onChoose: value => { chosen = value } })
      choose(host, '[data-switch-provider]', 'claude')
      choose(host, '[data-switch-model]', tier)
      assert.deepEqual(visibleValues(host, '[data-switch-effort]'), ['', ...CLAUDE_DEPTHS], `${tier}: "Model default", then low to max`)
      assert.equal(checkedValue(host, '[data-switch-effort]'), '', `${tier}: a Codex depth does not follow the agent to Claude`)
      choose(host, '[data-switch-effort]', 'high')
      host.querySelector('[data-switch-continue]').dispatch('click')
      assert.deepEqual(chosen, { account: null, provider: 'claude', tier, effort: 'high', route: 'handoff' })
    }
  } finally { dom.restore() }
})

test('Haiku 4.5 offers only "Model default", and "Model default" is refused where a depth would be carried', async () => {
  const { installDomStandIn } = await import('./lib/dom-stand-in.mjs')
  const dom = installDomStandIn(globalThis)
  try {
    let chosen = null
    const { host } = mountDialog(dom, { effort: 'high', onChoose: value => { chosen = value } })
    const modelDefault = () => host.querySelectorAll('[data-switch-effort]').find(input => input.value === '')
    assert.equal(checkedValue(host, '[data-switch-effort]'), 'high', 'the circle\'s own depth is the first pick')
    assert.equal(modelDefault().disabled, true, 'the same model would carry high, so it cannot also send none')
    assert.match(modelDefault().parentNode.textContent, /set depth/, 'and it says why')
    choose(host, '[data-switch-model]', 'claude-haiku-4-5')
    assert.deepEqual(visibleValues(host, '[data-switch-effort]'), [''], 'Haiku 4.5 takes no depth')
    assert.equal(modelDefault().disabled, false)
    assert.equal(checkedValue(host, '[data-switch-effort]'), '')
    host.querySelector('[data-switch-continue]').dispatch('click')
    assert.equal(chosen.tier, 'claude-haiku-4-5')
    assert.equal(chosen.effort, null, '"Model default" hands back no depth')
  } finally { dom.restore() }
})

test('every model row the dialog draws carries only the depths that model takes', () => {
  const { models } = switchChoices({ accounts: [], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: 'claude-sonnet' })
  for (const row of models) {
    assert.deepEqual(idsOf(row.efforts), idsOf(effortChoicesFor(row.id)), `${row.id}: its own depths`)
    if (row.provider === 'claude') assert.ok(!idsOf(row.efforts).includes('ultra'), `${row.id} offers no ultra`)
  }
  assert.deepEqual(idsOf(models.find(row => row.id === 'claude-haiku-4-5').efforts), [''])
})
