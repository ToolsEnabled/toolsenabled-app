import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { mountComputers, settle, COMPUTER_ID } from './helpers/t1308-computers-fixture.mjs'
import { renameAccount, refreshAccountNames, sessionAccountDisplayRecord } from '../../src/account-switcher-state.js'
import { agentAccountCopy } from '../../src/chat-copy.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)


const { installWorld, fleetFetch, seedTreeNode, mountView } = await import('./lib/tree-command-real-mount.mjs')

async function liveCircle(t, { account, fresh = false, wording }) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  const nodeId = 'receipt-circle', sessionId = 'actual-circle-session'
  const starts = []
  let view
  world.storage.setItem('mc.write.agent-session', 'enabled')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  Object.assign(world.bridge, {
    profiles: async () => ({ ok: true, profiles: [] }),
    confinement: async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true }),
    start: async request => { starts.push(request); return { ok: true, sessionId, threadId: 'actual-circle-thread', provider: 'claude',
      ...(account === undefined ? {} : { account }) } },
    send: async () => ({ ok: true, turnId: 'circle-turn' }),
    onEvent: () => () => {},
  })
  seedTreeNode(world.storage, { nodeId, status: fresh ? 'finished' : 'draft' })
  const key = 'mc.fleet.trees.v1:' + COMPUTER_ID
  const seeded = JSON.parse(world.storage.getItem(key))
  seeded.nodes[0].tier = 'claude-sonnet'; seeded.nodes[0].message = 'Account display task'
  world.storage.setItem(key, JSON.stringify(seeded))
  // A replacement's explicit default receipt must win over an older name.
  let savedEntry = fresh
  window.mcTranscripts = {
    list: async () => ({ ok: true, records: fresh ? [{ nodeId }] : [] }),
    read: async () => ({ ok: true, metadata: { nativeSessionId: 'older-session', provider: 'codex', account: 'Older account' },
      entries: savedEntry ? [{ id: 'old', who: 'agent', text: 'Earlier answer', at: 1 }] : [], before: null }),
    bind: async () => ({ ok: true }), append: async () => ({ ok: true }),
    rollback: async () => { savedEntry = false; return { ok: true } }, onError: () => () => {},
  }
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true,
    org: { revision: 1, source: 'overlay', agents: [{ id: nodeId, role: 'builder', provider: 'claude', enabled: true }], edges: [] },
    roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  t.after(async () => {
    if (view) await view.nativeStop.run({ version: 1, nodeId, treeId: 'tree-1', sessionId },
      async () => ({ closed: true, sessionId }))
    view?.destroy()
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg
    world.restore()
  })
  view = await mountView(world)
  if (fresh) {
    const outcome = await view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId: COMPUTER_ID, nodeId })
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
  } else {
    const start = view.el.querySelectorAll('button').find(button => button.textContent === 'Start tree')
    assert.ok(start, 'The person can start the mounted draft tree')
    start.click(); await settle(24)
  }
  assert.equal(starts.length, 1, 'The synthetic host accepted exactly one start: ' + view.el.textContent)
  const circle = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId)
  assert.ok(circle, 'The actual mounted graph draws the circle')
  circle.dispatch('keydown', { key: 'Enter', shiftKey: true }); await settle(8)
  accountAt(header(view.el), wording)
  view.el.querySelector('[data-rail-tab="details"]').click()
  accountAt(detail(view.el), wording)
  const stopped = await view.nativeStop.run({ version: 1, nodeId, treeId: 'tree-1', sessionId },
    async () => ({ closed: true, sessionId }))
  assert.equal(stopped.closed, true, JSON.stringify(stopped))
  await settle(8)
  accountAt(detail(view.el), wording)
  view.el.querySelector('[data-rail-tab="chat"]').click()
  accountAt(header(view.el), wording)
  assert.equal(starts.length, 1, 'Reading the account must not start or choose another account')
}

for (const account of ['Receipt work', null]) {
  test(`mounted live circle reads its ${account === null ? 'default' : 'named'} account from the host start receipt before any reply`, async t => {
    await liveCircle(t, { account, fresh: true,
      wording: account === null ? 'Account: your default Claude sign-in' : 'Account: Receipt work (Claude)' })
  })
}

for (const [account, wording] of [
  ['Host work', 'Account: Host work (Claude)'],
  [null, 'Account: your default Claude sign-in'],
  [undefined, 'Account: not recorded'],
  ['', 'Account: not recorded'],
]) {
  test(`mounted first-launch circle keeps the host's ${account === undefined ? 'missing' : account === '' ? 'empty' : account === null ? 'default' : 'named'} account evidence`, async t => {
    await liveCircle(t, { account, wording })
  })
}

const { STANDALONE_TABS_PREFIX } = await import('../../src/standalone-tab-ledger.js')
for (const account of ['Earlier work', null, undefined]) {
  test(`mounted Computers page restores a tab with its ${account === undefined ? 'unrecorded' : account === null ? 'default' : 'named'} account`, async t => {
    const tabId = 'standalone-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const f = await mountComputers(t, { nodes: [{ id: 'tab-anchor' }], tiers: ['claude-sonnet'],
      presence: { ok: true, providers: [{ id: 'claude', installed: 'yes' }] },
      seed(storage) {
        storage.setItem(STANDALONE_TABS_PREFIX + COMPUTER_ID, JSON.stringify({ v: 1, tabs: [{
          id: tabId, name: 'Saved account tab', tier: 'claude-sonnet', effort: null, openedAt: 1, sessionId: null,
        }] }))
        window.mcTranscripts = {
          list: async () => ({ ok: true, records: [{ nodeId: tabId }] }),
          read: async () => ({ ok: true, metadata: { nativeSessionId: 'tab-old-session', threadId: 'tab-old-thread', provider: 'claude',
            ...(account === undefined ? {} : { account }) },
            entries: [{ id: 'tab-saved', who: 'agent', text: 'Saved tab answer', at: 1 }], before: null }),
          onError: () => () => {},
        }
      } })
    await settle(12)
    const tab = f.graph.workspace.standalone.get(tabId)
    assert.ok(tab, 'The shipping workspace restored the saved tab')
    const tabButton = f.graph.chatTabs.querySelectorAll('[role="tab"]').find(button => button.dataset.agentId === tabId)
    assert.ok(tabButton, 'The person can open the saved tab')
    tabButton.click(); await settle(5)
    const wording = account === undefined ? 'Account: not recorded'
      : account === null ? 'Account: your default Claude sign-in' : 'Account: Earlier work (Claude)'
    accountAt(header(tab.chatPanel), wording)
    assert.equal(f.operations.length, 0, 'Restoring a tab must not choose or start an account')
    f.graph.workspace.close(tab, { focus: false })
  })
}

function header(host) { return host.querySelector('.chat-head [data-chat-header-account]') }
function detail(host) { return host.querySelector('[data-tree-account]') }
function accountAt(element, wording) {
  assert.ok(element, 'The agent must show its account as a visible fact')
  assert.equal(element.textContent, wording)
  assert.equal(element.getAttribute('aria-label'), wording, 'The accessible name must name the same account')
  for (let node = element; node; node = node.parentElement) {
    assert.notEqual(node.hidden, true, 'The account must be visible in the panel the person opened')
  }
  assert.equal(element.querySelector('button'), null, 'The account is a fact, without a new control')
}

async function tree(t, { account, provider = 'claude', saved = true, draft = false, registry = null } = {}) {
  const nodeId = 'account-circle', sessionId = 'saved-account-session'
  const f = await mountComputers(t, {
    nodes: [{ id: nodeId, tier: provider === 'claude' ? 'claude-sonnet' : 'astra',
      status: draft ? 'draft' : 'finished', sessionId: draft ? null : sessionId,
      accountChoice: { provider, name: 'Next account' } }],
    tiers: ['claude-sonnet', 'astra'],
    presence: { ok: true, providers: [{ id: 'claude', installed: 'yes' }, { id: 'codex', installed: 'yes' }] },
    seed() {
      if (registry) Object.assign(window.mcProviders, {
        accounts: () => registry.listAsync(), accountRename: request => registry.rename(request),
      })
      window.mcTranscripts = {
        list: async () => ({ ok: true, records: saved ? [{ nodeId }] : [] }),
        read: async () => ({ ok: true, metadata: saved ? { nativeSessionId: sessionId, threadId: 'saved-thread', provider,
          ...(account === undefined ? {} : { account }) } : null,
          entries: saved ? [{ id: 'saved-answer', who: 'agent', text: 'Saved answer', at: 1 }] : [], before: null }),
        onError: () => () => {},
      }
      window.mcAgent.sessionPresence = async () => ({ ok: true, sessionIds: [] })
    },
  })
  await f.openNode(nodeId)
  return Object.assign(f, { nodeId })
}

for (const [provider, word] of [['claude', 'Claude'], ['codex', 'Codex']]) {
  for (const account of ['Work & <team>', null]) {
    test(`mounted stopped circle shows its saved ${word} ${account === null ? 'default' : 'named'} account in Details and chat, including reopen`, async t => {
      const f = await tree(t, { provider, account })
      const wording = account === null ? `Account: your default ${word} sign-in` : `Account: ${account} (${word})`
      accountAt(detail(f.view.el), wording)
      f.view.el.querySelector('[data-rail-tab="chat"]').click()
      accountAt(header(f.view.el), wording)
      assert.equal(f.operations.length, 0, 'Reading the account must not start or select an account')
      await f.remount()
      await f.openNode(f.nodeId)
      accountAt(detail(f.view.el), wording)
      f.view.el.querySelector('[data-rail-tab="chat"]').click()
      accountAt(header(f.view.el), wording)
      assert.equal(f.operations.length, 0)
    })
  }
}

test('mounted circle without a session says not started yet despite its account choice', async t => {
  const f = await tree(t, { draft: true, saved: false })
  accountAt(detail(f.view.el), 'Account: not started yet')
  f.view.el.querySelector('[data-rail-tab="chat"]').click()
  accountAt(header(f.view.el), 'Account: not started yet')
})

test('mounted older circle with no account receipt says not recorded, never the selected account or default sign-in', async t => {
  const f = await tree(t, { account: undefined })
  accountAt(detail(f.view.el), 'Account: not recorded')
  f.view.el.querySelector('[data-rail-tab="chat"]').click()
  accountAt(header(f.view.el), 'Account: not recorded')
})

async function solo(t, { account = null, restored = null, provider = 'claude', startWait = null, registry = null } = {}) {
  const dom = installDomStandIn(globalThis)
  if (registry) window.mcProviders = {
    accounts: () => registry.listAsync(), accountRename: request => registry.rename(request),
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const listeners = new Set(), calls = []
  const bridge = {
    availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
    ownerContext: async () => ({ version: 1, ownerId: 'account-test-owner', currentEpoch: 'test-epoch', kind: 'local' }),
    onOwnerContextChanged: () => () => {},
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start: async request => { calls.push(['start', request]); await startWait;
      return { ok: true, sessionId: request.sessionId, threadId: 'actual-thread', provider, account } },
    send: async request => { calls.push(['send', request]); return { turnId: 'actual-turn' } },
    close: async request => { calls.push(['close', request]); return { closed: true } },
    interrupt: async () => ({ ok: true }),
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const adapter = mountStandaloneAgent(host, { id: 'account-tab', name: 'Account test agent', live: true, bridge,
    start: { tier: 'astra' }, restored,
    transcript: { bind: async () => ({ ok: true }), release: async () => ({ ok: true }) } })
  t.after(async () => { adapter.dispose(); await settle(5);
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage
    dom.restore() })
  await settle(5)
  return { host, adapter, calls, async send() {
    const input = host.querySelector('.chat-input textarea')
    input.value = 'Read this task'; input.dispatch('input'); host.querySelector('.chat-send').click(); await settle(12)
  } }
}

for (const account of ['Personal & <home>', null]) {
  test(`mounted standalone tab shows the host's ${account === null ? 'default' : 'named'} account after Send and Stop`, async t => {
    const f = await solo(t, { account })
    accountAt(header(f.host), 'Account: not started yet')
    await f.send()
    assert.ok(f.adapter.snapshot().sessionId, 'The synthetic host really accepted a session: ' + f.host.textContent)
    const wording = account === null ? 'Account: your default Claude sign-in' : `Account: ${account} (Claude)`
    accountAt(header(f.host), wording)
    f.host.querySelector('[data-session-stop]').click()
    await settle(5)
    assert.equal(f.adapter.snapshot().sessionId, null, 'Stop closed the accepted session')
    accountAt(header(f.host), wording)
  })
}

for (const account of ['Saved work', null]) {
  test(`mounted reopened standalone tab shows its saved ${account === null ? 'default' : 'named'} account before starting anything`, async t => {
    const f = await solo(t, { account: 'Later account', provider: 'codex', restored: {
      nativeSessionId: 'saved-native', threadId: 'saved-thread', provider: 'claude', account,
      lines: [{ id: 'saved', who: 'agent', text: 'Earlier answer', at: 1 }],
    } })
    accountAt(header(f.host), account === null ? 'Account: your default Claude sign-in' : 'Account: Saved work (Claude)')
    assert.equal(f.calls.length, 0, 'Reopen reads saved provenance and does not start an agent')
  })
}

test('mounted standalone start keeps not started yet until the host receipt arrives', async t => {
  let complete
  const wait = new Promise(resolve => { complete = resolve })
  const f = await solo(t, { account: 'Host choice', startWait: wait })
  await f.send()
  accountAt(header(f.host), 'Account: not started yet')
  complete(); await settle(12)
  accountAt(header(f.host), 'Account: Host choice (Claude)')
})

function renamedRegistry(t, { rename = true } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'account-display-rename-'))
  const file = path.join(directory, 'accounts.json')
  writeFileSync(file, JSON.stringify({ accounts: [
    { provider: 'claude', name: 'Earlier work', configDir: path.join(directory, 'claude-home') },
    { provider: 'codex', name: 'Earlier work', profileDir: path.join(directory, 'codex-home') },
  ] }))
  const registry = createRequire(import.meta.url)('../../shell/account-registry.cjs')
    .createAccountRegistryStore({ file, homedir: () => directory })
  if (rename) registry.rename({ provider: 'claude', name: 'Earlier work', newName: 'Current work' })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return registry
}

test('C7-W2 rename: stopped tree header and Details use the registry current name without changing its saved identity', async t => {
  const registry = renamedRegistry(t)
  const f = await tree(t, { account: 'Earlier work', registry })
  accountAt(detail(f.view.el), 'Account: Current work (Claude)')
  f.view.el.querySelector('[data-rail-tab="chat"]').click()
  accountAt(header(f.view.el), 'Account: Current work (Claude)')
  assert.equal(f.operations.length, 0)
  await f.remount(); await f.openNode(f.nodeId)
  accountAt(detail(f.view.el), 'Account: Current work (Claude)')
  assert.equal(f.operations.length, 0)
})

test('C7-W2 rename: reopened standalone header uses the registry current name while retaining its native account label', async t => {
  const registry = renamedRegistry(t)
  const f = await solo(t, { registry, restored: { nativeSessionId: 'saved-native', threadId: 'saved-thread',
    provider: 'claude', account: 'Earlier work', lines: [{ id: 'saved', who: 'agent', text: 'Earlier answer', at: 1 }] } })
  accountAt(header(f.host), 'Account: Current work (Claude)')
  assert.equal(f.adapter.snapshot().account, 'Earlier work')
  assert.equal(f.calls.length, 0)
})

test('C7-W2 rename: a mounted tree repaints header and Details after Accounts records a rename', async t => {
  const registry = renamedRegistry(t, { rename: false })
  const f = await tree(t, { account: 'Earlier work', registry })
  accountAt(detail(f.view.el), 'Account: Earlier work (Claude)')
  f.view.el.querySelector('[data-rail-tab="chat"]').click()
  accountAt(header(f.view.el), 'Account: Earlier work (Claude)')
  const answer = await renameAccount({ provider: 'claude', name: 'Earlier work', newName: 'Current work' }, window)
  assert.equal(answer.ok, true)
  await settle(8)
  accountAt(header(f.view.el), 'Account: Current work (Claude)')
  f.view.el.querySelector('[data-rail-tab="details"]').click()
  accountAt(detail(f.view.el), 'Account: Current work (Claude)')
  assert.equal(f.operations.length, 0)
})

test('C7-W2 rename: the same recorded label on another provider retains that provider account name', async t => {
  const registry = renamedRegistry(t)
  const f = await tree(t, { account: 'Earlier work', provider: 'codex', registry })
  accountAt(detail(f.view.el), 'Account: Earlier work (Codex)')
  f.view.el.querySelector('[data-rail-tab="chat"]').click()
  accountAt(header(f.view.el), 'Account: Earlier work (Codex)')
  assert.equal(f.operations.length, 0)
})

test('C7-W2 rename: live standalone rename repaints the header and survives Stop without choosing or starting again', async t => {
  const registry = renamedRegistry(t, { rename: false })
  const f = await solo(t, { account: 'Earlier work', registry })
  await f.send()
  accountAt(header(f.host), 'Account: Earlier work (Claude)')
  const before = f.calls.length
  assert.equal((await renameAccount({ provider: 'claude', name: 'Earlier work', newName: 'Current work' }, window)).ok, true)
  await settle(8)
  accountAt(header(f.host), 'Account: Current work (Claude)')
  assert.equal(f.adapter.snapshot().account, 'Earlier work')
  assert.equal(f.calls.length, before)
  f.host.querySelector('[data-session-stop]').click(); await settle(5)
  accountAt(header(f.host), 'Account: Current work (Claude)')
  assert.equal(f.adapter.snapshot().account, 'Earlier work')
})

for (const previousNames of [Array.from({ length: 65 }, (_, i) => i === 0 ? 'Earlier work' : `old-${i}`),
  ['Earlier work', 'x'.repeat(121)], ['Earlier work', null]]) {
  test('C7-W2 rename: invalid registry rename history cannot relabel a saved account (' + previousNames.length + ' entries)', async () => {
    const scope = { mcProviders: { accounts: async () => ({ ok: true,
      accounts: [{ name: 'Current work', provider: 'claude', previousNames }] }) } }
    await refreshAccountNames(scope)
    const record = { started: true, provider: 'claude', account: 'Earlier work' }
    assert.equal(agentAccountCopy(sessionAccountDisplayRecord(record, scope)).text, 'Account: Earlier work (Claude)')
    assert.equal(record.account, 'Earlier work')
  })
}

test('C7-W2 rename: ambiguous or damaged registry evidence keeps the recorded account label', async () => {
  for (const listing of [
    { ok: true, accounts: [
      { name: 'First current', provider: 'claude', previousNames: ['Earlier work'] },
      { name: 'Second current', provider: 'claude', previousNames: ['Earlier work'] },
    ] },
    { ok: true, damaged: true, accounts: [{ name: 'Current work', provider: 'claude', previousNames: ['Earlier work'] }] },
    { ok: false },
  ]) {
    const scope = { mcProviders: { accounts: async () => listing } }
    await refreshAccountNames(scope)
    const record = { started: true, provider: 'claude', account: 'Earlier work' }
    assert.equal(agentAccountCopy(sessionAccountDisplayRecord(record, scope)).text, 'Account: Earlier work (Claude)')
  }
})

test('C7-W2 rename: an older registry read cannot replace the current name after a newer rename read', async () => {
  let resolveOlder, reads = 0
  const scope = { mcProviders: { accounts: () => ++reads === 1
    ? new Promise(resolve => { resolveOlder = resolve })
    : Promise.resolve({ ok: true, accounts: [{ name: 'Current work', provider: 'claude', previousNames: ['Earlier work'] }] }) } }
  const older = refreshAccountNames(scope)
  await refreshAccountNames(scope)
  resolveOlder({ ok: true, accounts: [{ name: 'Obsolete name', provider: 'claude', previousNames: ['Earlier work'] }] })
  await older
  assert.equal(agentAccountCopy(sessionAccountDisplayRecord({ started: true, provider: 'claude', account: 'Earlier work' }, scope)).text,
    'Account: Current work (Claude)')
})
