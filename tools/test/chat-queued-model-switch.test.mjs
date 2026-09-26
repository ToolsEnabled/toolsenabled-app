import assert from 'node:assert/strict'
import test from 'node:test'
import { withResearchTreeBinding } from '../../src/research-tree-session.js'

class Classes {
  constructor(node) { this.node = node }
  values() { return String(this.node.className || '').split(/\s+/).filter(Boolean) }
  contains(v) { return this.values().includes(v) }
  add(...vs) { this.node.className = [...new Set([...this.values(), ...vs])].join(' ') }
  remove(...vs) { this.node.className = this.values().filter(v => !vs.includes(v)).join(' ') }
  toggle(v, force) { const on = force === undefined ? !this.contains(v) : force; on ? this.add(v) : this.remove(v); return on }
}
class NodeDouble {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.hidden = false; this.value = ''; this.textContent = ''; this.style = {}; this.dataset = {}; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100; this.classList = new Classes(this) }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n }
  append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? Object.assign(new NodeDouble('span'), { textContent: n }) : n) }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  prepend(n) { n.parentNode = this; this.children.unshift(n) }
  insertBefore(n, at) { const i = this.children.indexOf(at); n.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null }
  replaceWith(n) { if (!this.parentNode) return; const i = this.parentNode.children.indexOf(this); this.parentNode.children[i] = n; n.parentNode = this.parentNode; this.parentNode = null }
  get childElementCount() { return this.children.length }
  get lastElementChild() { return this.children.at(-1) || null }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'class') this.className = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v) }
  getAttribute(k) { return k === 'class' ? this.className : this.attributes.get(k) ?? null }
  removeAttribute(k) { this.attributes.delete(k) }
  addEventListener(k, fn) { const a = this.listeners.get(k) || []; a.push(fn); this.listeners.set(k, a) }
  removeEventListener() {}
  dispatch(type, init = {}) { const e = { target: this, key: '', preventDefault() { this.defaultPrevented = true }, stopPropagation() {}, ...init }; for (const fn of this.listeners.get(type) || []) fn(e); return e }
  focus() { document.activeElement = this }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false }
  matches(sel) { if (sel.startsWith('.')) return this.classList.contains(sel.slice(1)); if (sel.startsWith('[')) { const match = sel.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return Boolean(match && (match[2] === undefined ? this.attributes.has(match[1]) : this.getAttribute(match[1]) === match[2])) } const [tag, cls] = sel.split('.'); return (!tag || this.tagName === tag.toUpperCase()) && (!cls || this.classList.contains(cls)) }
  querySelectorAll(selector) { const parts = selector.trim().split(/\s+/); const out = []; const walk = n => { for (const c of n.children) { if (c.matches(parts.at(-1)) && (parts.length === 1 || c.parentNode?.matches(parts[0]))) out.push(c); walk(c) } }; walk(this); return out }
  querySelector(s) { return this.querySelectorAll(s)[0] || null }
  scrollIntoView() {}
  set innerHTML(html) { this.children = []; parse(html, this) }
}
function parse(html, host) {
  const stack = [host]
  for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!token.startsWith('<')) { const t = token.trim(); if (t) stack.at(-1).textContent += t; continue }
    if (/^<!/.test(token)) continue
    const m = token.match(/^<([\w-]+)/); if (!m) continue
    const n = new NodeDouble(m[1]);
    for (const a of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) { if (a[1] !== m[1]) n.setAttribute(a[1], a[2] ?? '') }
    if (/\shidden(?:\s|>|\/)/.test(token)) n.hidden = true
    stack.at(-1).appendChild(n)
    if (!/\/>$/.test(token) && !/^(input|img|path|rect)$/i.test(m[1])) stack.push(n)
  }
}
const docRoot = new NodeDouble('html')
globalThis.document = { documentElement: docRoot, body: new NodeDouble('body'), activeElement: null, fonts: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} }, createElement(tag) { if (tag !== 'template') return new NodeDouble(tag); const content = { firstElementChild: null }; return { content, set innerHTML(v) { const h = new NodeDouble('host'); parse(v, h); content.firstElementChild = h.children[0] } } }, addEventListener() {}, removeEventListener() {} }
globalThis.window = { matchMedia: () => ({ matches: true }) }
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = fn => { fn(); return 1 }
globalThis.cancelAnimationFrame = () => {}

const { buildChat } = await import('../../src/components.js')

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/*
 * This is deliberately a value-level component contract. buildChat does not
 * know what a model is: its caller owns the pending value and the turn-boundary
 * commit. The component owns the two observable promises tested here — it runs
 * that value through its real actions door and gives the caller a live status
 * line on which to announce the deferred change.
 */
test('queuing a model switch announces the choice without changing the running turn', async () => {
  let activeModel = 'sol'
  let queuedModel = null
  const chat = buildChat({
    title: 'Agent lane',
    onSend() {},
    actions: () => [{
      id: 'model-opus',
      label: 'Use Opus next turn',
      enabled: true,
      run(ctx) {
        queuedModel = 'opus'
        ctx.say('Opus is queued for the next turn.')
      },
    }],
  })
  docRoot.appendChild(chat)

  chat.openActions()
  const popup = chat.querySelector('.chat-actions-pop')
  popup.querySelector('.chat-actions-list button').dispatch('click')
  await settle()

  assert.equal(queuedModel, 'opus', 'the selected model is retained for the next boundary')
  assert.equal(activeModel, 'sol', 'selection must not replace the model in the running turn')
  assert.equal(
    popup.querySelector('.chat-actions-out').textContent,
    'Opus is queued for the next turn.',
    'the queued switch must be announced on buildChat’s live status surface',
  )

  /* No next-turn-boundary assertion here, on purpose: the commit of the
     pending value is the caller's (see the header note), so "asserting" it in
     this file could only re-assign these local variables and then observe the
     assignment -- a tautology, removed. */

  chat.dispose()
})


// Exercise the production configuration and component together, without a host start.
const { readFileSync } = await import('node:fs')
const { LAUNCH_TIERS, scopedEffort } = await import('../../src/orchestration-controls.js')
const { sessionModelChoices, tierProviderWord, TREE_DEFAULT_STARTABLE_TIERS, PROVIDER_CHOICES, MODEL_PANEL } = await import('../../src/fleet-tree-copy.js')
/* PROVIDER, THEN MODEL (1.0.48). The Switch model menu's first stage lists the
   providers and each opens its own models through ctx.show. These cases pin
   the model rows, so they walk every provider stage in order and read what the
   person would see there; the stage itself is pinned by its own case below. */
function modelStageOf(row) {
  let shown = null
  row.run({ show: (rows, options) => { shown = { rows, options } }, say() {} })
  assert.ok(shown, `${row.id} opens a stage of its own`)
  return { rows: typeof shown.rows === 'function' ? shown.rows() : shown.rows, title: shown.options?.title }
}
function expandProviderStage(rows) {
  const providerRows = rows.filter(row => String(row.id).startsWith('model-provider-'))
  assert.equal(providerRows.length, PROVIDER_CHOICES.length, 'every provider has a row on the first stage')
  return providerRows.flatMap(row => modelStageOf(row).rows)
}
const computersSource = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
function productionFunction(start, end, bindings, expression) {
  const begin = computersSource.indexOf(start)
  const finish = computersSource.indexOf(end, begin)
  assert.ok(begin >= 0 && finish > begin, 'production function boundaries available')
  return Function(...Object.keys(bindings), computersSource.slice(begin, finish) + '\nreturn ' + expression)(...Object.values(bindings))
}
function stoppedConfig(node, overrides = new Map(), extra = {}) {
  const bindings = {
    mockSource: () => false, treeChatHeaderMetaFor: () => null,
    // These fixtures have no queued provider choice; mounted pending cases live in T542.
    pendingModelChoice: () => null,
    treeStore: { getNode: () => node }, currentConfinementLevel: 'unrestricted',
    LAUNCH_TIERS, sessionModelChoices, sessionModelOverride: overrides,
    transcriptStore: { get: () => ({ lines: [] }) }, nodeReplies: new Map(),
    treeNodeName: () => 'Test agent', CHAT_NOT_RUNNING: { subtitle: 'Stopped', neverStarted: 'Start required' },
    restoreDiffHistory: (_, lines) => lines, nodeStartReason: () => 'Start required',
    PALETTE_PANEL: { footer: '' }, registerNodeStatusListener: () => () => {},
    chatActionRowsFor: () => [], commonChatActionsFor: () => [], ...extra,
  }
  return productionFunction('function treeChatConfigFor(node)', '\n  function scheduleRailStream', bindings, 'treeChatConfigFor')(node)
}
for (const tier of ['claude-sonnet', 'local', 'unresolved-tier']) {
  test('stopped model chip is visible and opens model actions without dispatch: ' + tier, async () => {
    const node = { id: 'stopped-node', tier, sessionId: null }
    const config = stoppedConfig(node)
    assert.equal(config.onSend, undefined, 'no session must never acquire a sender')
    let opened = null
    config.actions = () => [{ id: 'model', label: 'Models', enabled: true, run() { opened = 'model' } }]
    const chat = buildChat(config)
    const chip = chat.querySelector('.chat-chip-model')
    assert.ok(chip)
    assert.equal(chip.hidden, false)
    assert.ok(chip.textContent.length > 0)
    chip.dispatch('click')
    await settle()
    assert.equal(opened, 'model')
    assert.equal(node.sessionId, null)
    chat.dispose()
  })
}
test('model chip reads current session facts after a stopped chat config was created', () => {
  const node = { id: 'node', tier: 'claude-sonnet', sessionId: null }
  const config = stoppedConfig(node)
  assert.match(config.chips.model().label, /^Next: /)
  node.sessionId = 'current-session'
  assert.doesNotMatch(config.chips.model().label, /^Next: /)
  node.tier = 'unresolved-tier'
  assert.equal(config.chips.model().label, 'Choose model')
})
for (const change of ['session', 'cleanup', 'starting', 'draft-start', 'replacement', 'recovery']) {
  test('saved-next model menu rechecks ' + change + ' before saving', () => {
    const node = { id: 'node', tier: 'claude-sonnet', sessionId: null }
    let blocked = false
    let saves = 0
    const messages = []
    const bindings = {
      fresh: () => node, node, LAUNCH_TIERS, scopedEffort, sessionNodeIds: new Map(), destroyed: false,
      treeStore: { getNode: () => node, setNodeLaunchPreferences() { saves++; return { ok: true } } },
      nodeCleanupPending: () => blocked && change === 'cleanup', startCleanupSentence: () => 'Cleanup pending',
      startingNodeIds: { has: () => blocked && change === 'starting' },
      startDraftFlight: { busy: () => blocked && change === 'draft-start' },
      nodeReplacementFlight: { busy: () => blocked && change === 'replacement' },
      recoveryCoordinator: () => ({ isRecovering: () => blocked && change === 'recovery' }),
      notifyNodeStatusListeners() {},
      startableTierAnswered: false, startableTierIdList: TREE_DEFAULT_STARTABLE_TIERS, tierProviderWord, noProgramProviders: [],
      PROVIDER_CHOICES, MODEL_PANEL,
    }
    const rows = expandProviderStage(productionFunction('const modelRows = () => {', '\n    const rewindRows', bindings, 'modelRows')())
    const row = rows.find(row => row.id === 'next-model-claude-opus')
    assert.equal(row.enabled, true)
    row.run({ say: message => messages.push(message) })
    assert.equal(saves, 1, 'ordinary preference selection saves once')
    assert.equal(node.sessionId, null, 'preference selection never starts a session')
    blocked = true
    if (change === 'session') node.sessionId = 'new-session'
    row.run({ say: message => messages.push(message) })
    assert.equal(saves, 1, 'stale menu cannot write a preference')
    assert.ok(messages.at(-1).length > 0, 'refusal remains visible')
  })
}



function savedNextModelMenu(node, extra = {}) {
  const bindings = {
    fresh: () => node, node, LAUNCH_TIERS, scopedEffort, tierProviderWord, sessionNodeIds: new Map(), destroyed: false,
    treeStore: { getNode: () => node, setNodeLaunchPreferences: () => ({ ok: true }) },
    nodeCleanupPending: () => false, startCleanupSentence: () => 'Cleanup pending',
    startingNodeIds: { has: () => false }, startDraftFlight: { busy: () => false },
    nodeReplacementFlight: { busy: () => false }, recoveryCoordinator: () => ({ isRecovering: () => false }),
    notifyNodeStatusListeners() {}, startableTierAnswered: false, startableTierIdList: TREE_DEFAULT_STARTABLE_TIERS,
    noProgramProviders: [], PROVIDER_CHOICES, MODEL_PANEL, expandProviderStage,
    ...extra,
  }
  return productionFunction('const modelRows = () => {', '\n    const rewindRows', bindings,
    '({ stage: modelRows, rows: () => expandProviderStage(modelRows()), setCapabilities(answered, tiers) { startableTierAnswered = answered; startableTierIdList = tiers } })')
}

test('the saved-next model menu asks for the provider first, then lists only that provider\'s models', () => {
  const node = { id: 'node', tier: 'claude-sonnet', sessionId: null }
  const menu = savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: LAUNCH_TIERS.map(tier => tier.id) })
  const stage = menu.stage()
  assert.deepEqual(stage.map(row => row.id), PROVIDER_CHOICES.map(provider => 'model-provider-' + provider.id),
    'the first stage is the providers, in the product order, and nothing else')
  assert.deepEqual(stage.map(row => row.label), PROVIDER_CHOICES.map(provider => provider.label))
  assert.deepEqual(stage.filter(row => row.current).map(row => row.id), ['model-provider-claude'], 'the provider it runs on is marked')
  assert.match(stage.find(row => row.current).hint, /Sonnet \(latest\) · Claude/, 'and says which model')
  for (const provider of PROVIDER_CHOICES) {
    const opened = modelStageOf(stage.find(row => row.id === 'model-provider-' + provider.id))
    const expected = LAUNCH_TIERS.filter(tier => tier.provider === provider.id)
    assert.deepEqual(opened.rows.map(row => row.id), expected.map(tier => 'next-model-' + tier.id),
      `${provider.id}: that provider's models, in table order, and no other provider's`)
    for (const row of opened.rows) assert.ok(row.label.endsWith(' · ' + tierProviderWord(row.id.slice('next-model-'.length))),
      `${row.id}: a row still names its provider, because a stage title is not announced: ${row.label}`)
    assert.ok(opened.title.includes(provider.label), `${provider.id}: the stage is titled with the provider`)
  }
})

test('Opus 5 and Sonnet 5 are reachable as the next model through the Claude stage', () => {
  const saves = []
  const node = { id: 'node', tier: 'astra', sessionId: null }
  const menu = savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: LAUNCH_TIERS.map(tier => tier.id),
    treeStore: { getNode: () => node, setNodeLaunchPreferences: (...args) => { saves.push(args); return { ok: true } } } })
  const claude = modelStageOf(menu.stage().find(row => row.id === 'model-provider-claude')).rows
  for (const [id, label] of [['claude-opus-5', 'Opus 5 · Claude'], ['claude-sonnet-5', 'Sonnet 5 · Claude']]) {
    const row = claude.find(candidate => candidate.id === 'next-model-' + id)
    assert.ok(row, `${label} is on the Claude stage`)
    assert.equal(row.label, label)
    assert.equal(row.enabled, true, `${label} can be chosen`)
    row.run({ say() {} })
    assert.equal(saves.at(-1)[1].tier, id, `${label} is what gets saved`)
  }
})

test('saved-next model menu keeps all five providers visible after reopen', () => {
  for (const tier of ['claude-sonnet', 'astra', 'local']) {
    const rows = savedNextModelMenu({ id: 'node', tier, sessionId: null }).rows()
    assert.equal(rows.length, LAUNCH_TIERS.length)
    assert.deepEqual(rows.map(row => row.id), LAUNCH_TIERS.map(choice => 'next-model-' + choice.id))
  }
})

test('saved-next model labels distinguish Automatic choices from different providers', () => {
  const rows = savedNextModelMenu({ id: 'node', tier: 'astra', sessionId: null }).rows()
  assert.equal(rows.length, LAUNCH_TIERS.length)
  assert.equal(new Set(rows.map(row => row.label)).size, rows.length)
  for (const tier of LAUNCH_TIERS) assert.ok(rows.find(row => row.id === 'next-model-' + tier.id).label.includes(tierProviderWord(tier.id)))
})

test('unanswered launch capabilities keep Local visible with a refusal and keep current preferences', () => {
  const rows = savedNextModelMenu({ id: 'node', tier: 'astra', sessionId: null }).rows()
  const local = rows.find(row => row.id === 'next-model-local')
  assert.ok(local)
  assert.equal(local.enabled, false)
  assert.ok(local.disabledHint)
  const treeOnly = LAUNCH_TIERS.find(tier => tier.treeOnly)
  assert.equal(rows.find(row => row.id === 'next-model-' + treeOnly.id).enabled, true)
  const own = savedNextModelMenu({ id: 'node', tier: 'local', sessionId: null }).rows().find(row => row.id === 'next-model-local')
  assert.equal(own.current, true)
  assert.equal(own.enabled, true)
})

test('answered launch capabilities refuse unavailable saved-next choices without hiding them', () => {
  const rows = savedNextModelMenu({ id: 'node', tier: 'local', sessionId: null },
    { startableTierAnswered: true, startableTierIdList: ['astra'] }).rows()
  assert.equal(rows.length, LAUNCH_TIERS.length)
  assert.equal(rows.find(row => row.id === 'next-model-astra').enabled, true)
  assert.equal(rows.find(row => row.id === 'next-model-claude-opus').enabled, false)
  assert.equal(rows.find(row => row.id === 'next-model-local').enabled, true)
})

/* T1530: the saved-next model rows now apply the start panel's own rule, so a
   program this computer reports as not installed is not saved silently as a
   draft's next model. */
test('a program this computer does not have is refused as the next model, with the reason', () => {
  let saves = 0
  const node = { id: 'node', tier: 'local', sessionId: null }, said = []
  const rows = savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: ['claude-sonnet', 'local'],
    noProgramProviders: ['claude'],
    treeStore: { getNode: () => node, setNodeLaunchPreferences: () => { saves++; return { ok: true } } },
  }).rows()
  const sonnet = rows.find(row => row.id === 'next-model-claude-sonnet')
  assert.equal(sonnet.enabled, false)
  assert.match(sonnet.disabledHint, /^Claude is not installed on this computer/)
  sonnet.run({ say: value => said.push(value) })
  assert.equal(saves, 0, 'nothing is saved for a program that is not installed')
  assert.match(said.at(-1), /not installed/)
  assert.equal(rows.find(row => row.id === 'next-model-local').enabled, true, 'its own current model stays')
})

test('unavailable saved-next model press refuses before preference persistence', () => {
  let saves = 0
  const node = { id: 'node', tier: 'astra', sessionId: null }, said = []
  const row = savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: ['astra'],
    treeStore: { getNode: () => node, setNodeLaunchPreferences: () => { saves++; return { ok: true } } },
  }).rows().find(row => row.id === 'next-model-claude-opus')
  assert.ok(row)
  row.run({ say: value => said.push(value) })
  assert.equal(saves, 0)
  assert.ok(said.at(-1).includes(row.label))
})

test('saved-next model receipts identify the selected provider and persist only its preference', () => {
  const node = { id: 'node', tier: 'astra', sessionId: null }, saves = [], said = []
  const rows = savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: ['astra', 'gemini'],
    treeStore: { getNode: () => node, setNodeLaunchPreferences: (...args) => { saves.push(args); return { ok: true } } },
  }).rows()
  const gemini = rows.find(row => row.id === 'next-model-gemini'), grok = rows.find(row => row.id === 'next-model-grok')
  assert.ok(gemini && grok)
  assert.ok(grok.disabledHint.includes(grok.label))
  gemini.run({ say: value => said.push(value) })
  /* The saved depth is re-scoped with the model (D5): Gemini's CLI rows take
     none, so '' -- "Model default" -- is what is saved beside it. */
  assert.deepEqual(saves, [['node', { tier: 'gemini', effort: '' }]])
  assert.ok(said.at(-1).includes(gemini.label))
  assert.equal(node.sessionId, null)
})

/* D5 (1.0.48): moving a stopped agent to ANOTHER PROVIDER takes neither its
   saved account nor a depth the new model does not offer. Account names are
   provider-local, so the old account was refused at the next start
   (TREE_ACCOUNT_CHOICE_UNAVAILABLE); the managed set-node-provider path already
   cleared it. Within one provider the account stays, and so does a depth the
   new model offers. */
test('a next model on another provider clears the saved account and re-scopes the depth', () => {
  const saves = []
  const said = []
  const store = node => ({ getNode: () => node, setNodeLaunchPreferences: (...args) => { saves.push(args); return { ok: true } } })
  const everything = LAUNCH_TIERS.map(tier => tier.id)

  const codexNode = { id: 'node', tier: 'astra', effort: 'ultra', sessionId: null, accountChoice: { provider: 'codex', name: 'work-codex' } }
  savedNextModelMenu(codexNode, { startableTierAnswered: true, startableTierIdList: everything, treeStore: store(codexNode) })
    .rows().find(row => row.id === 'next-model-claude-opus-5').run({ say: value => said.push(value) })
  /* Review P2: a saved depth travels only within a provider, the rule both
     continuation paths follow. The node cannot say whether its Codex depth
     was chosen or was Codex's default, so Claude starts at its own. */
  assert.deepEqual(saves.at(-1), ['node', { tier: 'claude-opus-5', effort: '', accountChoice: null }],
    'a Codex account must not follow the agent to Claude, and neither does a Codex depth')
  /* Review P15: the cleared account is said, not dropped in silence. */
  assert.equal(said.at(-1), `The next session will use Opus 5 · Claude. ${MODEL_PANEL.accountCleared('claude')}`)
  assert.match(said.at(-1), /signed-in Claude account/)
  savedNextModelMenu(codexNode, { startableTierAnswered: true, startableTierIdList: everything, treeStore: store(codexNode) })
    .rows().find(row => row.id === 'next-model-claude-haiku-4-5').run({ say: value => said.push(value) })
  assert.deepEqual(saves.at(-1), ['node', { tier: 'claude-haiku-4-5', effort: '', accountChoice: null }],
    'a model with no depth setting is saved at "Model default"')

  savedNextModelMenu(codexNode, { startableTierAnswered: true, startableTierIdList: everything, treeStore: store(codexNode) })
    .rows().find(row => row.id === 'next-model-gpt-6-luna').run({ say: value => said.push(value) })
  assert.deepEqual(saves.at(-1), ['node', { tier: 'gpt-6-luna', effort: 'medium' }],
    'the same provider keeps its account; a depth that model lacks falls to its own default')
  assert.equal(said.at(-1), 'The next session will use GPT-6-Luna · Codex.', 'a kept account needs no extra sentence')

  const claudeNode = { id: 'node', tier: 'claude-opus', effort: 'xhigh', sessionId: null, accountChoice: { provider: 'claude', name: 'approved' } }
  savedNextModelMenu(claudeNode, { startableTierAnswered: true, startableTierIdList: everything, treeStore: store(claudeNode) })
    .rows().find(row => row.id === 'next-model-claude-sonnet-5').run({ say: value => said.push(value) })
  assert.deepEqual(saves.at(-1), ['node', { tier: 'claude-sonnet-5', effort: 'xhigh' }],
    'Claude to Claude keeps the approved account and a depth Sonnet 5 offers')
  assert.equal(saves.length, 4)
})

/* FOLLOW-UP V5. The cleared-account sentence was handed the model row's
   provider words, and Local's are "the computer you are driving": a Sol agent
   moved to Local was told it "will start on a signed-in the computer you are
   driving account", which is broken and false -- a local model uses no
   account. Local has its own sentence; the others say their provider's name. */
test('a stopped agent moved to Local is told a local model needs no account', () => {
  const said = []
  const saves = []
  const everything = LAUNCH_TIERS.map(tier => tier.id)
  const pick = id => {
    const node = { id: 'node', tier: 'sol', effort: 'xhigh', sessionId: null, accountChoice: { provider: 'codex', name: 'work' } }
    savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: everything,
      treeStore: { getNode: () => node, setNodeLaunchPreferences: (...args) => { saves.push(args); return { ok: true } } } })
      .rows().find(row => row.id === `next-model-${id}`).run({ say: value => said.push(value) })
    return said.at(-1)
  }
  const local = pick('local')
  assert.equal(saves.at(-1)[1].accountChoice, null)
  assert.doesNotMatch(local, /signed-in the computer you are driving|signed-in Local account/, local)
  assert.match(local, /A local model needs no account\.$/, local)
  for (const [id, word] of [['gemini', 'Gemini'], ['grok', 'Grok'], ['claude-opus-5', 'Claude']]) {
    assert.match(pick(id), new RegExp(`so it uses any signed-in ${word} account\\.$`), id)
  }
  for (const sentence of [local, ...['gemini', 'grok'].map(pick)].flatMap(text => text.split(/(?<=[.!?])\s+/))) {
    assert.ok(sentence.split(/\s+/).length <= 25, sentence)
  }
})

/* REVIEW P2. An untouched GPT-6-Astra agent saves `medium`, Codex's default
   in the compose panel, and the next-model menu carried it onto Opus 5, whose
   next start then sent --effort medium nobody chose. Switch and continue and
   continueNodeOnAnotherModel only carry a saved depth within one provider;
   this menu now follows the same rule, in both directions. */
test('a next model on another provider starts at its own default depth, not the old provider\'s', () => {
  const saves = []
  const store = node => ({ getNode: () => node, setNodeLaunchPreferences: (...args) => { saves.push(args); return { ok: true } } })
  const everything = LAUNCH_TIERS.map(tier => tier.id)
  const pick = (node, id) => savedNextModelMenu(node, { startableTierAnswered: true, startableTierIdList: everything, treeStore: store(node) })
    .rows().find(row => row.id === 'next-model-' + id).run({ say() {} })

  pick({ id: 'node', tier: 'astra', effort: 'medium', sessionId: null }, 'claude-opus-5')
  assert.deepEqual(saves.at(-1), ['node', { tier: 'claude-opus-5', effort: '' }], 'Codex\'s default medium was carried onto Opus 5')
  pick({ id: 'node', tier: 'astra', effort: 'medium', sessionId: null }, 'claude-sonnet-5')
  assert.deepEqual(saves.at(-1), ['node', { tier: 'claude-sonnet-5', effort: '' }])
  pick({ id: 'node', tier: 'claude-sonnet-5', effort: 'high', sessionId: null }, 'sol')
  assert.deepEqual(saves.at(-1), ['node', { tier: 'sol', effort: 'xhigh' }], 'a Claude depth was carried onto GPT-5.6-Sol instead of its own xhigh')
  pick({ id: 'node', tier: 'claude-opus', effort: 'max', sessionId: null }, 'gemini')
  assert.deepEqual(saves.at(-1), ['node', { tier: 'gemini', effort: '' }])
  // Within a provider a depth the new model offers is still kept.
  pick({ id: 'node', tier: 'claude-sonnet-5', effort: 'high', sessionId: null }, 'claude-opus-5')
  assert.deepEqual(saves.at(-1), ['node', { tier: 'claude-opus-5', effort: 'high' }])
  pick({ id: 'node', tier: 'astra', effort: 'low', sessionId: null }, 'terra')
  assert.deepEqual(saves.at(-1), ['node', { tier: 'terra', effort: 'low' }])
})

/* REVIEW P14. A Codex conversation switched in place was told "Messages run on
   gpt-6-luna ...", the raw model id, while the row it pressed read
   "GPT-6-Luna · Codex". */
test('an in-place Codex model switch is confirmed in the row\'s own words, never the model id', () => {
  const node = { id: 'node', tier: 'astra', sessionId: 'live-session' }
  const overrides = new Map()
  const said = []
  const bindings = {
    fresh: () => node, node, LAUNCH_TIERS, scopedEffort, tierProviderWord, sessionNodeIds: new Map([['live-session', 'node']]),
    destroyed: false, treeStore: { getNode: () => node }, PROVIDER_CHOICES, MODEL_PANEL, sessionModelChoices,
    sessionModelOverride: overrides, currentDataSource: () => 'local', MANUAL_ACCOUNT_CONTINUATION_LOCAL_ONLY: 'local only',
    nodeCleanupPending: () => false, startCleanupSentence: () => 'Cleanup pending', START_NEEDS_APP_TEXT: () => 'needs app',
    isWriteEnabled: () => true, START_CONTROL_FLAG: 'agent-session', startControlOffReason: () => 'off',
    nodeReplacementFlight: { busy: () => false }, recoveryCoordinator: () => ({ isRecovering: () => false }),
    pendingModelChoice: () => null, cancelPendingModelChoice: () => {}, nodeBusy: () => false,
    queueModelChoice: () => { throw new Error('an idle session is switched at once') },
    continueNodeOnAnotherModel: async () => false, statusSink: () => ({ textContent: '' }),
    notifyNodeStatusListeners() {}, startableTierAnswered: true, startableTierIdList: LAUNCH_TIERS.map(tier => tier.id),
  }
  const stage = productionFunction('const modelRows = () => {', '\n    const rewindRows', bindings, 'modelRows')()
  const codex = modelStageOf(stage.find(row => row.id === 'model-provider-codex')).rows
  const luna = codex.find(row => row.id === 'model-gpt-6-luna')
  assert.ok(luna, 'GPT-6-Luna is offered in place on a running Codex conversation')
  assert.equal(luna.enabled, true)
  luna.run({ say: value => said.push(value), close() {} })
  assert.equal(overrides.get('live-session'), 'gpt-6-luna', 'the switch still sends the model id on the wire')
  assert.equal(said.at(-1), MODEL_PANEL.next(luna.label))
  assert.match(said.at(-1), /GPT-6-Luna/)
  assert.doesNotMatch(said.at(-1), /gpt-6-luna/, 'the raw model id reached the person')
})

for (const answeredInitially of [false, true]) {
  test('saved-next press rechecks capabilities after ' + (answeredInitially ? 'a changed answer' : 'the first answer'), () => {
    const node = { id: 'node', tier: 'claude-sonnet', sessionId: null }, said = []
    let saves = 0
    const menu = savedNextModelMenu(node, {
      startableTierAnswered: answeredInitially, startableTierIdList: ['claude-sonnet', 'claude-opus'],
      treeStore: { getNode: () => node, setNodeLaunchPreferences: () => { saves++; return { ok: true } } },
    })
    const row = menu.rows().find(row => row.id === 'next-model-claude-opus')
    assert.ok(row)
    assert.equal(row.enabled, true)
    menu.setCapabilities(true, ['claude-sonnet'])
    row.run({ say: value => said.push(value) })
    assert.equal(saves, 0, 'the capability answer changed while this row was open')
    assert.ok(said.at(-1).includes(row.label))
  })
}

test('provider mode chip is separate from permission tier and preserves draft plus ordered images', async () => {
  const { createProviderModeMenu } = await import('../../src/provider-mode-menu.js')
  const result = { sessionId: 'mode-session', provider: 'runtime-provider', supported: true, currentModeId: 'read-only', availableModes: [{ id: 'read-only', name: 'Read only' }, { id: 'write', name: 'Make changes' }], pending: false }
  const calls = []
  const menu = createProviderModeMenu({ sessionId: 'mode-session', bridge: {
    modes: async () => result,
    setMode: async request => { calls.push(request); return { ...result, currentModeId: request.modeId, applied: true } },
  } })
  const chat = buildChat({ seed: 0, onSend() { throw new Error('mode selection must not send draft') },
    chips: { tier: () => ({ label: 'Unrestricted' }), onOpenMode: root => root.openActions('provider-mode') },
    actions: () => [{ id: 'provider-mode', label: 'Provider mode', enabled: true, run: menu.open }],
  })
  const draft = { text: '  original\nmessage  ', attachments: [{ path: '/ordered-one.png', name: 'one' }, { path: '/ordered-two.png', name: 'two' }] }
  chat.importDraft(draft)
  const before = chat.exportDraft()
  assert.equal(chat.querySelector('.chat-chip-tier').textContent, 'Unrestricted')
  const chip = chat.querySelector('.chat-chip-mode')
  assert.equal(chip.hidden, false)
  chip.dispatch('click'); await settle(); await settle()
  const row = chat.querySelectorAll('.chat-actions-row').find(row => row.textContent.includes('Make changes'))
  // The minimal DOM double stores nested labels on their div.
  const target = row || chat.querySelectorAll('.chat-actions-row').find(row => row.querySelector('div')?.textContent.includes('Make changes'))
  assert.ok(target, 'provider-advertised choice is reachable through the chip: ' + JSON.stringify({ rows: chat.querySelectorAll('.chat-actions-row').map(r => r.children.map(c => c.textContent)), state: menu.rows().map(r => r.label) }))
  target.dispatch('click'); await settle(); await settle()
  assert.deepEqual(calls, [{ sessionId: 'mode-session', modeId: 'write' }])
  assert.equal(menu.rows().find(row => row.id === 'provider-mode-write').current, true)
  assert.deepEqual(chat.exportDraft(), before)
  assert.equal(chat.querySelector('.chat-chip-tier').textContent, 'Unrestricted')
  chat.dispose()
})


test('an active next-turn model preference is labelled requested until cleared', () => {
  const node = { id: 'requested-node', tier: 'luna', sessionId: null }
  const overrides = new Map()
  const config = stoppedConfig(node, overrides)
  node.sessionId = 'active-session'
  const actualStartLabel = config.chips.model().label
  overrides.set(node.sessionId, 'gpt-5.6-sol')
  assert.match(config.chips.model().label, /^Next: /)
  assert.notEqual(config.chips.model().label, actualStartLabel)
  overrides.delete(node.sessionId)
  assert.equal(config.chips.model().label, actualStartLabel)
})

test('permission chip opens Permission settings on the same chat without navigation, permission mutation or draft loss', async () => {
  const { createTreeChatDraftStore } = await import('../../src/tree-chat-drafts.js')
  const drafts = createTreeChatDraftStore()
  const node = { id: 'permission-node', tier: 'luna', sessionId: null }
  const routes = [], mutations = [], opened = []
  window.mcAgent = { send: () => mutations.push('send'), start: () => mutations.push('start') }
  window.mcSetup = { chooseTier: () => mutations.push('chooseTier'), save: () => mutations.push('save') }
  const config = stoppedConfig(node, new Map(), {
    destroyed: false,
    navigate: route => routes.push(route),
    // T1026: the chip opens the chat's own Permission settings action instead of leaving for Settings.
    chatActionRowsFor: () => [{ id: 'permission-settings', label: 'Permission settings', enabled: true, run: ctx => { opened.push(typeof ctx.show) } }],
  })
  const chat = buildChat(config)
  const release = drafts.mount('computer', node.id, chat)
  chat.importDraft({ text: '  original\n  retained  ', attachments: [{ path: '/first.png' }, { path: '/second.png' }] })
  const before = chat.exportDraft()
  node.sessionId = 'running-session'
  assert.equal(config.chips.tier().label, 'Permission settings')
  chat.querySelector('.chat-chip-tier').dispatch('click')
  await settle(); await settle()
  assert.deepEqual(routes, [])
  assert.deepEqual(opened, ['function'])
  assert.deepEqual(mutations, [])
  assert.deepEqual(chat.exportDraft(), before)
  release(); chat.dispose()
  node.sessionId = null
  const returned = buildChat(stoppedConfig(node))
  const unmount = drafts.mount('computer', node.id, returned)
  assert.deepEqual(returned.exportDraft(), before)
  unmount(); returned.dispose()
  window.mcAgent = undefined; window.mcSetup = undefined
})

test('actual refused send callback retains Next preference and exact draft with ordered images', async () => {
  const node = { id: 'send-node', tier: 'luna', sessionId: null }
  const overrides = new Map()
  const config = stoppedConfig(node, overrides)
  node.sessionId = 'session-send'
  overrides.set(node.sessionId, 'gpt-5.6-sol')
  const calls = [], failures = [], stripped = []; let accepted = 0, statusWrites = 0
  window.mcAgent = { send: async request => { calls.push(request); throw new Error('AGENT_MODE_UNAVAILABLE') } }
  const send = productionFunction('function treeCardSend(node, text,', '\n  /* TAKE BACK THE LINE', {
    notePersonSpokeTo() {}, parseSlashCommand: () => null, nodeBusy: () => false, withResearchTreeBinding,
    pendingModelChoice: () => null,
    treeStore: { setNodeStatus() { statusWrites++ } }, awaitTurnReply() {}, transcriptAppend() {},
    sessionModelOverride: overrides, sessionPendingImages: new Map(), dropTurnReply() {},
    refusalCode: error => error.message, queuedSendRefusalSentence: code => code,
    sendFailureIsUnconfirmed: () => false, destroyed: false,
    // c4 P3: a refusal that proves nothing was sent takes back its "you" line.
    stripPhantomYouLine: (...args) => { stripped.push(args) },
  }, 'treeCardSend')
  const chat = buildChat({ seed: 0, chips: config.chips, onSend(text, callbacks) {
    send(node, text, { ...callbacks, accepted: () => { accepted++ }, fail: (...args) => { failures.push(args); callbacks.fail(...args) } })
  } })
  chat.importDraft({ text: '  refused\noriginal  ', attachments: [{ path: '/one.png' }, { path: '/two.png' }] })
  const before = chat.exportDraft()
  chat.querySelector('.chat-send').dispatch('click')
  await settle(); await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'gpt-5.6-sol')
  assert.equal(calls[0].text, before.text)
  assert.deepEqual(calls[0].images, [{ path: '/one.png' }, { path: '/two.png' }])
  assert.equal(failures.length, 1); assert.equal(failures[0][1].restoreDraft, true)
  assert.equal(stripped.length, 1, 'the not-sent refusal took back the line it appended')
  assert.equal(accepted, 0); assert.equal(statusWrites, 0)
  assert.equal(overrides.get(node.sessionId), 'gpt-5.6-sol')
  assert.match(config.chips.model().label, /^Next: /)
  assert.deepEqual(chat.exportDraft(), before)
  chat.dispose(); window.mcAgent = undefined
})

test('closing actual provider popup disposes event subscription and fences late refresh', async () => {
  const { createProviderModeMenu } = await import('../../src/provider-mode-menu.js')
  let listener, off = 0, reads = 0, resolveRead
  const result = { sessionId: 'popup', provider: 'provider', supported: true, currentModeId: null, availableModes: [{ id: 'plan', name: 'Plan' }], pending: false }
  const menu = createProviderModeMenu({ sessionId: 'popup', bridge: { modes: () => { reads++; return new Promise(resolve => { resolveRead = resolve }) } },
    subscribe: callback => { listener = callback; return () => { off++ } },
  })
  const chat = buildChat({ seed: 0, actions: () => [{ id: 'provider-mode', label: 'Mode', run: menu.open }] })
  chat.openActions('provider-mode'); await settle()
  chat.dispose()
  assert.equal(off, 1)
  resolveRead(result); await settle()
  listener({ sessionId: 'popup', event: { type: 'session_mode_changed' } })
  assert.equal(reads, 1); assert.equal(chat.querySelector('.chat-actions-pop'), null)
})
