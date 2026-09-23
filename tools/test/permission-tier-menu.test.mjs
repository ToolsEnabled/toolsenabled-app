import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { UNRESTRICTED_RISK_TEXT } from '../../src/unrestricted-consent.js'
const { createPermissionTierMenu } = await import(process.env.PERMISSION_MENU_MODULE
  ? pathToFileURL(resolve(process.env.PERMISSION_MENU_MODULE)).href : '../../src/permission-tier-menu.js')
const state = tier => ({ ok: true, available: true, configured: tier !== null, tier, tiers: ['guided', 'standard', 'unrestricted'] })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(extra = {}, options = {}) {
  let saved = 'standard', reads = 0
  const choices = [], messages = [], recorded = []
  const bridge = { bootstrap: state('unrestricted'),
    tierState: async () => { reads++; return state(saved) },
    chooseTier: async (tier, consent) => { choices.push({ tier, consent }); saved = tier; return { ok: true, tier } },
    ...extra }
  const menu = createPermissionTierMenu({ bridge, onRecorded: tier => recorded.push(tier), ...options })
  let close
  const ctx = { say: text => messages.push(text), show: () => {}, refresh: () => {}, onClose: fn => { close = fn } }
  return { bridge, menu, ctx, choices, messages, recorded, set: value => { saved = value }, reads: () => reads,
    close: () => close?.(), row: id => menu.rows().find(row => row.id === id) }
}
test('fresh read and matching readback determine saved tier, independently of bootstrap or provider mode', async () => {
  const f = fixture()
  await f.menu.open(f.ctx)
  assert.equal(f.row('permission-standard').current, true)
  assert.equal(f.row('permission-unrestricted').current, false)
  await f.row('permission-guided').run(f.ctx)
  assert.deepEqual(f.choices, [{ tier: 'guided', consent: null }])
  assert.equal(f.reads(), 3)
  assert.equal(f.row('permission-guided').current, true)
  assert.match(f.messages.at(-1), /future starts and resumes.*Running sessions keep/)
})
test('full access shows existing terms; decline writes nothing; confirm carries exact shown consent', async () => {
  const f = fixture()
  await f.menu.open(f.ctx)
  await f.row('permission-unrestricted').run(f.ctx)
  const words = f.menu.rows().filter(row => row.id.startsWith('permission-risk')).map(row => row.label).join(' ')
  assert.equal(words, UNRESTRICTED_RISK_TEXT)
  assert.equal(f.choices.length, 0)
  await f.row('permission-decline').run(f.ctx)
  assert.equal(f.choices.length, 0)
  await f.row('permission-unrestricted').run(f.ctx)
  await f.row('permission-confirm').run(f.ctx)
  assert.equal(f.choices[0].tier, 'unrestricted')
  assert.equal(f.choices[0].consent.confirmed, true)
  assert.equal(f.choices[0].consent.riskShown, true)
  assert.equal(f.choices[0].consent.riskText, UNRESTRICTED_RISK_TEXT)
  assert.equal(f.choices[0].consent.via, 'settings')
  await f.row('permission-guided').run(f.ctx)
  await f.row('permission-unrestricted').run(f.ctx)
  assert.ok(f.row('permission-confirm'), 're-enabling full access must ask again')
  assert.equal(f.choices.length, 2)
})
test('host refusal survives readback and another popup paint', async () => {
  const f = fixture({ chooseTier: async () => ({ ok: false, code: 'AUDIT_UNAVAILABLE', reason: 'The audit recorder refused this change.' }) })
  await f.menu.open(f.ctx); await f.row('permission-guided').run(f.ctx)
  assert.equal(f.row('permission-standard').current, true)
  assert.match(f.row('permission-state').label, /audit recorder refused/)
  assert.match(f.messages.at(-1), /Saved level: Standard/)
})
test('a saved downgrade with a refused audit record says both facts', async () => {
  let tier = 'unrestricted'
  const f = fixture({ tierState: async () => state(tier), chooseTier: async value => {
    tier = value
    return { ok: true, tier, recorded: { ok: false, code: 'AUDIT_UNAVAILABLE' } }
  } })
  await f.menu.open(f.ctx); await f.row('permission-guided').run(f.ctx)
  assert.equal(f.row('permission-guided').current, true)
  assert.match(f.messages.at(-1), /Saved permission level: Guided.*activity record was not saved/)
})
test('successful ACK cannot select a tier the fresh readback contradicts', async () => {
  const f = fixture({ chooseTier: async tier => ({ ok: true, tier }) })
  await f.menu.open(f.ctx); await f.row('permission-guided').run(f.ctx)
  assert.equal(f.row('permission-standard').current, true)
  assert.equal(f.row('permission-guided').current, false)
  assert.match(f.messages.at(-1), /differs from the requested/)
})
test('readback failure blocks another write and names uncertainty', async () => {
  let reads = 0, writes = 0
  const f = fixture({ tierState: async () => { if (++reads > 2) throw new Error('read failed'); return state('standard') },
    chooseTier: async tier => { writes++; return { ok: true, tier } } })
  await f.menu.open(f.ctx); await f.row('permission-guided').run(f.ctx)
  assert.equal(f.row('permission-guided').enabled, false)
  await f.row('permission-unrestricted').run(f.ctx)
  assert.equal(writes, 1)
  assert.match(f.messages.at(-1), /could not be read back/)
  assert.equal(f.row('permission-standard').current, false, 'an old observation is not the current saved level')
  assert.match(f.row('permission-saved').label, /Last verified level/)
})
for (const raw of [null, {}, state('invented'), { ...state('standard'), unreadable: true }, { ...state('standard'), available: false }]) {
  test('unverified state offers no writes: ' + JSON.stringify(raw), async () => {
    const f = fixture({ tierState: async () => raw })
    await f.menu.open(f.ctx)
    assert.equal(f.menu.rows().some(row => row.id === 'permission-unrestricted' && row.enabled), false)
    assert.equal(f.choices.length, 0)
    assert.match(f.messages.at(-1), /could not be read/)
  })
}
test('missing fresh reader refuses without falling back to bootstrap', async () => {
  const f = fixture({ tierState: undefined })
  await f.menu.open(f.ctx)
  assert.match(f.messages.at(-1), /unavailable/)
  assert.equal(f.choices.length, 0)
})
for (const method of ['tierState', 'chooseTier']) test('refresh disables choices when an accepted bridge loses ' + method, async () => {
  const f = fixture()
  await f.menu.open(f.ctx)
  const staleChoice = f.row('permission-guided')
  assert.equal(staleChoice.enabled, true)
  assert.equal(f.row('permission-standard').current, true)
  const original = f.bridge[method]
  f.bridge[method] = undefined
  await f.row('permission-refresh').run(f.ctx)
  assert.match(f.messages.at(-1), /unavailable/)
  assert.match(f.row('permission-saved').label, /Last verified level/)
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    assert.equal(f.row('permission-' + tier).enabled, false)
    assert.equal(f.row('permission-' + tier).current, false)
  }
  await staleChoice.run(f.ctx)
  await f.row('permission-unrestricted').run(f.ctx)
  assert.equal(f.choices.length, 0, 'neither current nor previously captured rows may write')
  assert.equal(f.row('permission-confirm'), undefined, 'an unverified host cannot open consent')
  f.bridge[method] = original
  await f.row('permission-refresh').run(f.ctx)
  assert.equal(f.row('permission-guided').enabled, true)
  assert.equal(f.row('permission-standard').current, true)
  assert.equal(f.choices.length, 0, 'restoring a bridge must not replay a choice')
})
test('external tier drift requires a renewed choice, including consent', async () => {
  const f = fixture()
  await f.menu.open(f.ctx); await f.row('permission-unrestricted').run(f.ctx)
  f.set('guided')
  await f.row('permission-confirm').run(f.ctx)
  assert.equal(f.choices.length, 0)
  assert.equal(f.row('permission-guided').current, true)
  assert.match(f.messages.at(-1), /changed.*choose again/)
})
test('scope is rechecked on a stale row and after a read before dispatch', async () => {
  let reason = ''
  const wait = deferred()
  let reads = 0
  const f = fixture({ tierState: async () => ++reads === 1 ? state('standard') : wait.promise }, { blockingReason: () => reason })
  await f.menu.open(f.ctx)
  const row = f.row('permission-guided')
  reason = 'This example is read-only.'
  await row.run(f.ctx)
  assert.equal(f.choices.length, 0)
  reason = ''
  const pending = row.run(f.ctx)
  reason = 'The selected computer changed.'
  wait.resolve(state('standard')); await pending
  assert.equal(f.choices.length, 0)
  assert.equal(f.messages.at(-1), reason)
})
test('closing and reopening cannot repeat an unresolved machine write', async () => {
  const wait = deferred()
  let writes = 0
  const f = fixture({ chooseTier: () => { writes++; return wait.promise } }, { deadlineMs: 5 })
  await f.menu.open(f.ctx)
  await f.row('permission-guided').run(f.ctx)
  f.close()
  const messages = []
  const next = createPermissionTierMenu({ bridge: f.bridge, onRecorded() {} })
  await next.open({ say: text => messages.push(text), show() {}, refresh() {} })
  assert.equal(writes, 1)
  assert.match(messages.at(-1), /still awaiting/)
  wait.resolve({ ok: true, tier: 'guided' })
  await Promise.resolve(); await Promise.resolve()
  next.dispose()
})
for (const first of ['closed-read', 'reopened-read']) test('closing during save read permits only reopened popup to dispatch: ' + first, { timeout: 2000 }, async () => {
  const oldRead = deferred(), newRead = deferred(), oldEntered = deferred(), newEntered = deferred()
  const setter = deferred(), setterEntered = deferred()
  let reads = 0, saved = 'standard'
  const writes = []
  const f = fixture({
    tierState: () => {
      reads++
      if (reads === 2) { oldEntered.resolve(); return oldRead.promise }
      if (reads === 4) { newEntered.resolve(); return newRead.promise }
      return Promise.resolve(state(saved))
    },
    chooseTier: async tier => {
      writes.push(tier)
      setterEntered.resolve()
      await setter.promise
      saved = tier
      return { ok: true, tier }
    },
  })
  let next
  try {
    await f.menu.open(f.ctx)
    const abandoned = f.row('permission-guided').run(f.ctx)
    await oldEntered.promise
    f.close() // invoke the real menu's registered popup-close callback
    const closedMessages = f.messages.slice()
    const messages = []
    next = createPermissionTierMenu({ bridge: f.bridge, onRecorded() {} })
    const ctx = { say: text => messages.push(text), show() {}, refresh() {} }
    await next.open(ctx)
    const selected = next.rows().find(row => row.id === 'permission-guided').run(ctx)
    await newEntered.promise
    if (first === 'closed-read') {
      oldRead.resolve(state('standard'))
      await abandoned
      assert.deepEqual(writes, [], 'the disposed popup must stop before dispatch')
      newRead.resolve(state('standard'))
      await setterEntered.promise
    } else {
      newRead.resolve(state('standard'))
      await setterEntered.promise
      oldRead.resolve(state('standard'))
      await abandoned
    }
    assert.deepEqual(writes, ['guided'])
    assert.deepEqual(f.messages, closedMessages, 'the old popup must not publish late status')
    assert.match(messages.at(-1), /Saving permission settings/)
    assert.equal(next.rows().some(row => ['permission-guided', 'permission-standard', 'permission-unrestricted'].includes(row.id) && row.enabled), false)
    setter.resolve()
    await selected
    assert.deepEqual(writes, ['guided'])
    assert.equal(next.rows().find(row => row.id === 'permission-guided').current, true)
    assert.match(messages.at(-1), /Saved permission level: Guided/)
  } finally {
    oldRead.resolve(state('standard'))
    newRead.resolve(state('standard'))
    setter.resolve()
    f.close()
    next?.dispose()
  }
})
test('late reads and saved confirmation callbacks cannot update a closed popup', async () => {
  const wait = deferred()
  const f = fixture({ tierState: () => wait.promise })
  const pending = f.menu.open(f.ctx)
  f.close()
  const messages = f.messages.slice()
  wait.resolve(state('unrestricted')); await pending
  assert.deepEqual(f.messages, messages)
  assert.deepEqual(f.recorded, [])
})

const dom = installDomStandIn()
const { buildChat, controlState } = await import('../../src/components.js')
test.after(() => dom.restore())
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
test('every row handed to the Actions palette says why it cannot be pressed, in each menu state', async () => {
  // components.js renderPopStage refuses a disabled row without a reason, and a refused stage shows no rows.
  const offered = (menu, when) => {
    for (const row of menu.rows()) {
      assert.doesNotThrow(() => controlState({ enabled: row.enabled !== false, why: row.disabledHint ?? null }), when + ': ' + row.id)
    }
  }
  const setter = deferred(), setterEntered = deferred()
  let tier = 'standard', fail = false, reason = ''
  const bridge = {
    tierState: async () => { if (fail) throw new Error('fixture read failure'); return state(tier) },
    chooseTier: async value => { setterEntered.resolve(); await setter.promise; tier = value; return { ok: true, tier } },
  }
  const ctx = { say() {}, show() {}, refresh() {}, onClose() {} }
  const menu = createPermissionTierMenu({ bridge, blockingReason: () => reason, onRecorded() {} })
  const other = createPermissionTierMenu({ bridge, onRecorded() {} })
  try {
    offered(menu, 'before the first read')
    await menu.open(ctx)
    offered(menu, 'saved level read')
    await menu.rows().find(row => row.id === 'permission-unrestricted').run(ctx)
    assert.ok(menu.rows().some(row => row.id === 'permission-decline'))
    offered(menu, 'full-access warning')
    await other.open(ctx)
    const saving = other.rows().find(row => row.id === 'permission-guided').run(ctx)
    await setterEntered.promise
    offered(other, 'saving')
    offered(menu, 'full-access warning while another change awaits the host')
    setter.resolve(); await saving
    reason = 'This example is read-only.'
    offered(menu, 'blocked')
    reason = ''
    await menu.rows().find(row => row.id === 'permission-decline').run(ctx)
    fail = true
    await menu.rows().find(row => row.id === 'permission-refresh').run(ctx)
    assert.match(menu.rows()[0].label, /could not be read/)
    offered(menu, 'unreadable')
  } finally { setter.resolve(); menu.dispose(); other.dispose() }
})
const sourceRoot = process.env.PERMISSION_SOURCE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const source = readFileSync(resolve(sourceRoot, 'src/views/computers.js'), 'utf8')
const functions = new Map()
function visit(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') visit(value)
  }
}
visit(parseAst(source))
const functionSource = name => { const node = functions.get(name); assert.ok(node); return source.slice(node.start, node.end) }
function mount({ dataSource = 'local' } = {}) {
  const node = { id: 'saved-node', role: 'worker', status: 'stopped', sessionId: null }
  const f = fixture()
  const navigations = []
  const context = vm.createContext({
    window: { mcSetup: f.bridge }, destroyed: false, node,
    treeStore: { getNode: () => node }, mockSource: () => false, currentDataSource: () => dataSource,
    treeChatHeaderMetaFor: () => null, transcriptStore: null, nodeReplies: new Map(),
    treeNodeName: () => 'Fixture agent', restoreDiffHistory: (_id, rows) => rows,
    nodeStartReason: () => '', CHAT_NOT_RUNNING: { subtitle: 'Stopped', neverStarted: 'Not started.', refused: value => value },
    PALETTE_PANEL: { footer: '' }, commonChatActionsFor: () => [],
    registerNodeStatusListener: () => () => {}, accountRetryChipState: () => ({ value: 'off', disabled: true }),
    LAUNCH_TIERS: [], sessionModelOverride: new Map(), pendingModelChoice: () => null,
    createPermissionTierMenu, navigate: route => navigations.push(route), conversation: 'Conversation', controlState,
  })
  // Execute the actual action initializer/row, not a test replacement for its wiring.
  const action = functions.get('chatActionRowsFor')
  const declarations = action.body.body.filter(row => row.type === 'VariableDeclaration')
  const declared = name => declarations.find(row => row.declarations.some(d => d.id.name === name))
  const open = declared('openPermissionSettings')
  const returned = action.body.body.find(row => row.type === 'ReturnStatement')
  // The palette answers `[...rows].map(paletteRow)`: read its literal rows and keep its real row mapper.
  const call = returned?.argument?.type === 'CallExpression' ? returned.argument : null
  const list = call ? call.callee?.object : returned?.argument
  assert.equal(list?.type, 'ArrayExpression', 'chatActionRowsFor must answer its literal palette rows')
  const mapper = call ? declared(call.arguments[0]?.name) : null
  assert.ok(!call || mapper, 'the palette row mapper must be declared in chatActionRowsFor')
  const permission = list.elements.find(row => row?.type === 'ObjectExpression'
    && row.properties.some(p => p.key?.name === 'id' && p.value.value === 'permission-settings'))
  context.chatActionRowsFor = () => []
  if (open && permission) {
    context.chatActionRowsFor = vm.runInContext('() => { '
      + (mapper ? source.slice(mapper.start, mapper.end) + '; ' : '')
      + source.slice(open.start, open.end) + '; return [' + source.slice(permission.start, permission.end) + ']'
      + (call ? '.map(' + source.slice(call.arguments[0].start, call.arguments[0].end) + ')' : '') + ' }', context)
  }
  vm.runInContext(functionSource('treeChatConfigFor'), context)
  const config = context.treeChatConfigFor(node)
  // No provider work: keep the actual chips/onReady/actions, supply only a local composer fixture.
  const root = buildChat({ ...config, composerReason: null, status: null, onSend() {}, seed: 0 })
  dom.document.body.appendChild(root)
  root.importDraft({ text: 'Keep my draft', attachments: [{ path: 'fixture-image.png', size: 12 }] })
  return { root, navigations, f }
}
for (const dataSource of ['local', 'relay']) test('real stopped-chat chip opens inline and preserves draft/image: ' + dataSource, async () => {
  const m = mount({ dataSource })
  try {
    const input = m.root.querySelector('.chat-input input')
    const attachment = m.root.querySelector('.chat-attachment-chip')
    const before = m.root.exportDraft()
    m.root.querySelector('[data-chat-chip="tier"]').click()
    await tick(); await tick()
    assert.deepEqual(m.navigations, [])
    assert.ok(m.root.querySelector('.chat-actions-pop'), 'the permission menu opens on the same chat')
    assert.equal(m.root.querySelector('.chat-input input'), input)
    assert.equal(m.root.querySelector('.chat-attachment-chip'), attachment)
    assert.deepEqual(m.root.exportDraft(), before)
    const said = m.root.querySelector('.chat-actions-out').textContent
    assert.match(said, dataSource === 'local' ? /future starts and resumes/ : /local view/)
    assert.equal(m.f.choices.length, 0)
    if (dataSource === 'local') {
      const guided = [...m.root.querySelectorAll('.chat-actions-row')].find(row => row.children[0]?.textContent === 'Guided')
      assert.ok(guided && !guided.disabled)
      guided.click(); await tick(); await tick()
      assert.deepEqual(m.f.choices, [{ tier: 'guided', consent: null }])
      assert.match(m.root.querySelector('.chat-actions-out').textContent, /Saved permission level: Guided/)
      assert.equal(m.root.querySelector('.chat-input input'), input)
      assert.equal(m.root.querySelector('.chat-attachment-chip'), attachment)
      assert.deepEqual(m.root.exportDraft(), before)
      assert.deepEqual(m.navigations, [])
    }
  } finally { m.root.dispose(); m.root.remove() }
})
