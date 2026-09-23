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
const { LAUNCH_TIERS } = await import('../../src/orchestration-controls.js')
const { sessionModelChoices, tierProviderWord, TREE_DEFAULT_STARTABLE_TIERS } = await import('../../src/fleet-tree-copy.js')
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
      fresh: () => node, node, LAUNCH_TIERS, sessionNodeIds: new Map(), destroyed: false,
      treeStore: { getNode: () => node, setNodeLaunchPreferences() { saves++; return { ok: true } } },
      nodeCleanupPending: () => blocked && change === 'cleanup', startCleanupSentence: () => 'Cleanup pending',
      startingNodeIds: { has: () => blocked && change === 'starting' },
      startDraftFlight: { busy: () => blocked && change === 'draft-start' },
      nodeReplacementFlight: { busy: () => blocked && change === 'replacement' },
      recoveryCoordinator: () => ({ isRecovering: () => blocked && change === 'recovery' }),
      notifyNodeStatusListeners() {},
      startableTierAnswered: false, startableTierIdList: TREE_DEFAULT_STARTABLE_TIERS, tierProviderWord, noProgramProviders: [],
    }
    const rows = productionFunction('const modelRows = () => {', '\n    const rewindRows', bindings, 'modelRows')()
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
    fresh: () => node, node, LAUNCH_TIERS, tierProviderWord, sessionNodeIds: new Map(), destroyed: false,
    treeStore: { getNode: () => node, setNodeLaunchPreferences: () => ({ ok: true }) },
    nodeCleanupPending: () => false, startCleanupSentence: () => 'Cleanup pending',
    startingNodeIds: { has: () => false }, startDraftFlight: { busy: () => false },
    nodeReplacementFlight: { busy: () => false }, recoveryCoordinator: () => ({ isRecovering: () => false }),
    notifyNodeStatusListeners() {}, startableTierAnswered: false, startableTierIdList: TREE_DEFAULT_STARTABLE_TIERS,
    noProgramProviders: [],
    ...extra,
  }
  return productionFunction('const modelRows = () => {', '\n    const rewindRows', bindings,
    '({ rows: modelRows, setCapabilities(answered, tiers) { startableTierAnswered = answered; startableTierIdList = tiers } })')
}

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
  assert.deepEqual(saves, [['node', { tier: 'gemini' }]])
  assert.ok(said.at(-1).includes(gemini.label))
  assert.equal(node.sessionId, null)
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
  const calls = [], failures = []; let accepted = 0, statusWrites = 0
  window.mcAgent = { send: async request => { calls.push(request); throw new Error('AGENT_MODE_UNAVAILABLE') } }
  const send = productionFunction('function treeCardSend(node, text,', '\n  /* TAKE BACK THE LINE', {
    notePersonSpokeTo() {}, parseSlashCommand: () => null, nodeBusy: () => false, withResearchTreeBinding,
    pendingModelChoice: () => null,
    treeStore: { setNodeStatus() { statusWrites++ } }, awaitTurnReply() {}, transcriptAppend() {},
    sessionModelOverride: overrides, sessionPendingImages: new Map(), dropTurnReply() {},
    refusalCode: error => error.message, queuedSendRefusalSentence: code => code,
    sendFailureIsUnconfirmed: () => false, destroyed: false,
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
