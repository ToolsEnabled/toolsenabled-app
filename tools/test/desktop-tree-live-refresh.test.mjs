import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const { setBridgeTransport } = await import('../../src/mission-bridge.js')
const { DATA_SOURCE_EVENT } = await import('../../src/data-source.js')

function snapshot(ids = ['native-a']) {
  return { ok: true, mayWrite: true, desktopTree: {
    version: 1, computerId: 'this-computer',
    trees: ids.map(id => ({ id: `tree-${id}`, name: id })),
    nodes: ids.map(id => ({ id, treeId: `tree-${id}`, parentId: null, role: 'worker', name: id, status: 'finished', sessionId: `session-${id}` })),
  }, sessions: ids.map(id => ({ sessionId: `session-${id}`, nodeId: id, busy: false })), sessionsTruncated: false }
}

async function worldFor(t, read, { phone = true, sessions = [], legacyFetch, legacyOrg } = {}) {
  const world = await installWorld({ fetch: legacyFetch || (async () => ({ ok: false, status: 404, json: async () => ({}) })) }, { asyncFrames: true })
  delete window.mcShell.getBridgeProof
  setBridgeTransport(async () => ({ ok: false, reason: 'No fleet fixture.' }))
  world.storage.setItem('mc.set.tree_style', 'boxes')
  if (phone) {
    document.documentElement.setAttribute('data-phone-canvas', 'on')
    window.location.search = '?ledger=1'
  }
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  if (legacyOrg) globalThis.mcOrg = { read: legacyOrg }
  const priorAccount = Object.getOwnPropertyDescriptor(globalThis, 'mcAccount')
  globalThis.mcAccount = window.mcAccount = {
    signIn: async () => ({ ok: false }),
    availability: async () => ({ ok: true, accountCount: 1 }),
    current: async () => ({ ok: true, signedIn: true, account: { id: 'owner', username: 'owner', displayName: 'Owner', createdAt: '2026-09-14T00:00:00Z' } }),
  }
  const listeners = new Set()
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  window.mcDesktopTree = { read }
  const calls = []
  window.mcDesktopSessions = {
    list: async () => ({ ok: true, mayWrite: true, sessions, truncated: false }),
    transcript: async ({ sessionId }) => { calls.push(['transcript', sessionId]); return { ok: true, sessionId, bound: true, entries: [] } },
    send: async request => { calls.push(['send', request.sessionId, request.text]); return { ok: true, sessionId: request.sessionId, turnId: 'sent-turn' } },
  }
  const originalNow = Date.now
  const originalTimeout = globalThis.setTimeout
  const scheduledReads = []
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalTimeout(callback, delay, ...args)
    if (delay === 15000) scheduledReads.push({ callback, timer })
    return timer
  }
  let clock = originalNow()
  Date.now = () => clock
  const view = await mountView(world)
  t.after(() => {
    view.destroy()
    Date.now = originalNow
    globalThis.setTimeout = originalTimeout
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg
    if (priorAccount) Object.defineProperty(globalThis, 'mcAccount', priorAccount); else delete globalThis.mcAccount
    delete window.mcAccount
    delete window.mcDesktopTree
    delete window.mcDesktopSessions
    setBridgeTransport(null)
    world.restore()
  })
  return { view, world, calls,
    openFirst: () => view.el.querySelector('.phone-ledger-press').click(),
    ids: () => view.el.querySelectorAll(phone ? '.phone-ledger-press' : '.static-tree-node').map(node => phone ? node.querySelector('.phone-ledger-name').textContent : node.dataset.agentId),
    event: packet => { for (const listener of listeners) listener(packet) },
    later: () => { clock += 60000 },
    tick: () => {
      const timer = scheduledReads.shift()
      assert.ok(timer, 'the visible authority refresh is scheduled')
      clearTimeout(timer.timer)
      clock += 15000
      timer.callback()
    },
    focus: () => window.dispatchEvent(new CustomEvent('focus')),
    fence: why => window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why } })),
  }
}

test('a native event refreshes the actual forest without a full page reload', async t => {
  let next = snapshot()
  let reads = 0
  const f = await worldFor(t, async () => { reads += 1; return next })
  assert.deepEqual(f.ids(), ['native-a'])
  next = snapshot(['native-a', 'native-b'])
  f.later()
  f.event({ sessionId: 'session-native-b', event: { type: 'turn_completed' } })
  await settle()
  assert.deepEqual(f.ids(), ['native-a', 'native-b'])
  assert.equal(reads, 2)
  assert.equal(f.world.storage.getItem('mc.fleet.trees.v1:this-computer'), null, 'remote snapshot is never hydrated into browser storage')
})

test('focus refresh retains the last good forest while waiting, then installs exact replacement', async t => {
  let release
  let reads = 0
  const f = await worldFor(t, () => ++reads === 1 ? snapshot() : new Promise(resolve => { release = resolve }))
  f.later()
  f.focus()
  await settle(10)
  assert.equal(typeof release, 'function')
  f.focus()
  f.event({ sessionId: 'session-native-a', event: { type: 'turn_completed' } })
  await settle(5)
  assert.equal(reads, 2, 'concurrent triggers share the in-flight snapshot')
  assert.deepEqual(f.ids(), ['native-a'])
  assert.equal(f.view.el.dataset.nativeTreeState, 'refreshing')
  release(snapshot(['native-b']))
  await settle()
  assert.deepEqual(f.ids(), ['native-b'])
  assert.equal(f.view.el.dataset.nativeTreeState, 'available')
})

test('an account fence drops the old forest synchronously and rejects its late refresh', async t => {
  let releaseA
  let reads = 0
  const f = await worldFor(t, () => {
    reads += 1
    return reads === 1 ? snapshot() : reads === 2 ? new Promise(resolve => { releaseA = resolve }) : snapshot(['native-b'])
  })
  f.later()
  f.focus()
  await settle(10)
  assert.equal(typeof releaseA, 'function')
  f.fence('account-session-changed')
  assert.deepEqual(f.ids(), [], 'old-account nodes are gone before source resolution')
  await settle()
  releaseA(snapshot(['late-a']))
  await settle()
  assert.deepEqual(f.ids(), ['native-b'])
})

test('an invalid refresh retains labelled stale authority without session-graph fallback', async t => {
  let reads = 0
  const f = await worldFor(t, async () => ++reads === 1 ? snapshot() : { ok: false, code: 'MC_AGENT_DESKTOP_TREE_INVALID' })
  f.later()
  f.focus()
  await settle()
  assert.deepEqual(f.ids(), ['native-a'])
  assert.equal(f.view.el.dataset.nativeTreeState, 'stale')
  assert.match(f.view.el.textContent, /last verified|could not.*refresh/i)
})

test('hidden pages do not refresh, and late responses cannot change a disposed view', async t => {
  let release
  let reads = 0
  const f = await worldFor(t, () => ++reads === 1 ? snapshot() : new Promise(resolve => { release = resolve }))
  document.visibilityState = 'hidden'
  f.later()
  f.focus()
  await settle(10)
  assert.equal(reads, 1)
  document.visibilityState = 'visible'
  f.focus()
  await settle(10)
  assert.equal(reads, 2)
  f.view.destroy()
  release(snapshot(['late']))
  await settle()
  assert.equal(f.ids().includes('late'), false)
})

test('a draft created without an agent event reaches the next visible background read', async t => {
  let next = snapshot()
  const f = await worldFor(t, async () => next)
  next = snapshot(['native-a', 'native-draft'])
  next.desktopTree.nodes[1].status = 'draft'
  next.desktopTree.nodes[1].sessionId = null
  next.sessions.pop()
  f.tick()
  await settle()
  assert.deepEqual(f.ids(), ['native-a', 'native-draft'])
  f.tick()
  await settle()
  assert.deepEqual(f.ids(), ['native-a', 'native-draft'])
})

function sessionRow(nodeId = 'native-a') {
  return { sessionId: 'session-native-a', nodeId, agentId: null, name: 'Native worker', provider: 'local', tier: 'local', busy: false,
    turnsCompleted: 1, lastTurnStatus: 'success', transcript: true, openable: true, refusal: null }
}

test('a real phone row opens and sends only to its exact native node/session, preserving chat during refresh', async t => {
  let next = snapshot()
  const f = await worldFor(t, async () => next, { sessions: [sessionRow()] })
  const row = f.view.el.querySelector('.phone-ledger-press')
  assert.ok(row)
  row.click()
  await settle()
  const chat = f.view.el.querySelector('[data-desktop-chat]')
  assert.ok(chat, 'the shared desktop conversation is mounted')
  assert.equal(f.view.el.querySelector('.phone-sheet').hidden, false)
  assert.deepEqual(f.calls, [['transcript', 'session-native-a']])
  const composer = chat.querySelector('.chat-input input')
  composer.value = 'EXACT_NATIVE_NODE_MARKER'
  composer.dispatch('input')
  composer.dispatch('keydown', { key: 'Enter' })
  await settle()
  assert.ok(f.calls.some(call => call[0] === 'send' && call[1] === 'session-native-a' && call[2] === 'EXACT_NATIVE_NODE_MARKER'))
  composer.value = 'KEEP_UNSENT_DRAFT'
  next = snapshot(['native-a', 'native-b'])
  f.later()
  f.focus()
  await settle()
  assert.equal(f.view.el.querySelector('[data-desktop-chat]'), chat)
  assert.equal(composer.value, 'KEEP_UNSENT_DRAFT')
  assert.equal(f.world.storage.getItem('mc.fleet.trees.v1:this-computer'), null)
})

test('a saved node with no active session opens read-only facts without local launch controls', async t => {
  const saved = snapshot()
  saved.desktopTree.nodes[0].status = 'draft'
  saved.desktopTree.nodes[0].sessionId = null
  saved.desktopTree.nodes[0].message = 'Saved native prompt'
  saved.desktopTree.nodes[0].reply = 'Saved native answer'
  saved.sessions = []
  const f = await worldFor(t, async () => saved)
  assert.doesNotThrow(() => f.view.el.querySelector('.phone-ledger-press').click())
  const details = f.view.el.querySelector('[data-native-tree-details]')
  assert.ok(details)
  assert.match(details.textContent, /no active conversation/i)
  assert.match(details.textContent, /Saved native answer/)
  assert.equal(f.view.el.querySelector('[data-tree-profile]'), null)
  assert.equal(f.view.el.querySelector('[data-desktop-chat]'), null)
  assert.deepEqual(f.calls, [])
})

test('saved native details show the exact status note without inferring a stop from finished status', async t => {
  let next = snapshot()
  next.desktopTree.nodes[0].statusNote = 'Stopped by you.'
  const f = await worldFor(t, async () => next)
  f.openFirst()
  const note = () => f.view.el.querySelector('[data-native-status-note]')
  assert.equal(note()?.textContent, 'Stopped by you.')
  assert.match(f.view.el.querySelector('[data-native-tree-details]').textContent, /finished/)
  assert.deepEqual(f.calls, [], 'a saved status is not permission to reopen or restart a session')

  next = snapshot()
  next.desktopTree.nodes[0].statusNote = 'Native note: <img src=x> & unchanged'
  f.later(); f.focus(); await settle()
  assert.ok(note())
  // This stand-in retains HTML entities literally; a browser decodes them as text.
  assert.equal(note().textContent, 'Native note: &lt;img src=x&gt; &amp; unchanged')
  assert.equal(note().querySelector('img'), null, 'the native note remains escaped text')

  next = snapshot()
  f.later(); f.focus(); await settle()
  assert.equal(note(), null, 'an absent note must not inherit the earlier stop explanation')
  assert.doesNotMatch(f.view.el.querySelector('[data-native-tree-details]').textContent, /Stopped by you/)
  assert.equal(f.world.storage.getItem('mc.fleet.trees.v1:this-computer'), null)
})

test('saved prompt and partial reply retain exact text in the existing whitespace-preserving rail presentation', async t => {
  const saved = snapshot()
  const node = saved.desktopTree.nodes[0]
  node.message = 'First line\n\n  indented prompt\tend'
  node.reply = '1 test\n2 test\n\n  3 test partial'
  const f = await worldFor(t, async () => saved)
  f.openFirst()
  const details = f.view.el.querySelector('[data-native-tree-details]')
  for (const [field, text] of [['prompt', node.message], ['reply', node.reply]]) {
    const value = [...details.querySelectorAll('p')].find(element => element.textContent === text)
    assert.ok(value, `the complete saved ${field} is retained verbatim`)
    assert.ok(value.classList.contains('rail-said'), `the saved ${field} uses the existing pre-wrap text presentation`)
    assert.equal(value.children.length, 0, 'saved text is not interpreted as markup')
  }
  assert.equal(details.querySelector('textarea'), null)
  assert.deepEqual(f.calls, [])
})

test('same session id under another listed node cannot open the saved node conversation', async t => {
  const f = await worldFor(t, async () => snapshot(), { sessions: [sessionRow('different-native-node')] })
  f.view.el.querySelector('.phone-ledger-press').click()
  assert.match(f.view.el.querySelector('[data-native-tree-details]').textContent, /does not match this saved node/)
  assert.equal(f.view.el.querySelector('[data-desktop-chat]'), null)
  assert.deepEqual(f.calls, [])
})

test('the phone distinguishes a pending or refused first snapshot from an empty saved forest', async t => {
  let release
  const f = await worldFor(t, () => new Promise(resolve => { release = resolve }))
  assert.match(f.view.el.querySelector('.phone-ledger-summary').textContent, /Reading/)
  assert.equal(f.view.el.textContent.includes('No agents yet'), false)
  release({ ok: false, code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' })
  await settle()
  assert.equal(f.view.el.querySelector('.phone-ledger-summary').textContent, 'Reconnect to read saved trees')
  assert.equal(f.view.el.textContent.includes('No agents yet'), false)
})

test('a thrown background read retains the verified snapshot with a stale label', async t => {
  let reads = 0
  const f = await worldFor(t, async () => {
    if (++reads > 1) throw new Error('transport closed')
    return snapshot()
  })
  f.later()
  f.focus()
  await settle()
  assert.deepEqual(f.ids(), ['native-a'])
  assert.equal(f.view.el.dataset.nativeTreeState, 'stale')
})

test('a source fence removes saved private details before the next source answers', async t => {
  const saved = snapshot()
  saved.desktopTree.nodes[0].reply = 'ACCOUNT_A_PRIVATE_SAVED_REPLY'
  let reads = 0
  const f = await worldFor(t, async () => ++reads === 1 ? saved : new Promise(() => {}))
  f.view.el.querySelector('.phone-ledger-press').click()
  assert.match(f.view.el.textContent, /ACCOUNT_A_PRIVATE_SAVED_REPLY/)
  f.fence('machine-chosen')
  assert.equal(f.view.el.textContent.includes('ACCOUNT_A_PRIVATE_SAVED_REPLY'), false)
  assert.deepEqual(f.ids(), [])
})

test('an adopted snapshot that replaces the selected session removes the old chat and send target', async t => {
  let next = snapshot()
  const f = await worldFor(t, async () => next, { sessions: [sessionRow()] })
  f.view.el.querySelector('.phone-ledger-press').click()
  await settle()
  const chat = f.view.el.querySelector('[data-desktop-chat]')
  assert.ok(chat)
  next = snapshot()
  next.desktopTree.nodes[0].sessionId = 'replacement-session'
  next.sessions = []
  f.later()
  f.focus()
  await settle()
  assert.equal(f.view.el.querySelector('[data-desktop-chat]'), null)
  assert.match(f.view.el.textContent, /no longer matches an available conversation/)
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 0)
})

test('a source change during page assembly discards the complete old-source result', async t => {
  const old = snapshot(['late-a1', 'late-a2', 'late-a3', 'late-a4', 'late-a5', 'late-a6'])
  for (const node of old.desktopTree.nodes) node.message = 'x'.repeat(12000)
  const bytes = Buffer.from(JSON.stringify(old))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const envelope = page => ({ desktopTreeSnapshot: { version: 1, page, pages: Math.ceil(bytes.length / 65536), bytes: bytes.length, sha256,
    data: bytes.subarray(page * 65536, (page + 1) * 65536).toString('base64') } })
  let reads = 0
  let release
  const f = await worldFor(t, request => {
    if (request?.page === 1) return new Promise(resolve => { release = () => resolve(envelope(1)) })
    reads += 1
    return reads === 1 ? snapshot() : reads === 2 ? envelope(0) : snapshot(['native-b'])
  })
  f.later()
  f.focus()
  await settle(10)
  assert.equal(typeof release, 'function', 'the refresh reached its second native page')
  assert.deepEqual(f.ids(), ['native-a'], 'no partial forest is adopted')
  f.fence('account-session-changed')
  await settle()
  release()
  await settle()
  assert.deepEqual(f.ids(), ['native-b'])
})

test('a snapshot hash mismatch never replaces the last verified forest', async t => {
  const bytes = Buffer.from(JSON.stringify(snapshot(['unverified-node'])))
  let reads = 0
  const f = await worldFor(t, async () => ++reads === 1 ? snapshot() : {
    desktopTreeSnapshot: { version: 1, page: 0, pages: 1, bytes: bytes.length, sha256: '0'.repeat(64), data: bytes.toString('base64') },
  })
  f.later()
  f.focus()
  await settle()
  assert.deepEqual(f.ids(), ['native-a'])
  assert.equal(f.view.el.dataset.nativeTreeState, 'stale')
})

function forest() {
  const saved = snapshot(['alpha-root', 'alpha-child', 'beta-root'])
  saved.desktopTree.trees = [{ id: 'tree-alpha', name: 'Actual Alpha' }, { id: 'tree-beta', name: 'Actual Beta' }, { id: 'tree-empty', name: 'Saved empty tree' }]
  for (const node of saved.desktopTree.nodes) node.treeId = node.id.startsWith('alpha') ? 'tree-alpha' : 'tree-beta'
  saved.desktopTree.nodes[1].parentId = 'alpha-root'
  return saved
}

test('phone groups every actual saved tree by exact membership, including named empty trees', async t => {
  const f = await worldFor(t, async () => forest())
  const trees = f.view.el.querySelectorAll('.phone-ledger-tree')
  assert.deepEqual(trees.map(tree => tree.dataset.nativeTreeId), ['tree-alpha', 'tree-beta', 'tree-empty'])
  assert.deepEqual(trees.map(tree => tree.querySelector('.phone-ledger-tree-name').textContent), ['Actual Alpha', 'Actual Beta', 'Saved empty tree'])
  assert.deepEqual(trees.map(tree => tree.querySelectorAll('.phone-ledger-row').map(row => row.dataset.nativeNodeId)), [['alpha-root', 'alpha-child'], ['beta-root'], []])
  assert.match(trees[2].textContent, /No agents are saved in this tree/)
  assert.match(f.view.el.querySelector('.phone-ledger-summary').textContent, /3 saved trees/)
  assert.equal(f.view.el.querySelector('.phone-ledger-add'), null, 'read-only trees expose no local add controls')
})

test('search reveals matching native branches in their saved tree and clearing restores tree folds', async t => {
  const f = await worldFor(t, async () => forest())
  const firstTree = f.view.el.querySelector('.phone-ledger-tree')
  assert.ok(firstTree)
  firstTree.querySelector('.phone-ledger-tree-toggle').click()
  assert.deepEqual(f.ids(), ['beta-root'])
  const search = f.view.el.querySelector('.phone-ledger-search')
  search.value = 'alpha-child'
  search.dispatch('input')
  assert.deepEqual(f.ids(), ['alpha-root', 'alpha-child'], 'search keeps native ancestry even under a folded tree')
  assert.deepEqual(f.view.el.querySelectorAll('.phone-ledger-tree').map(tree => tree.dataset.nativeTreeId), ['tree-alpha'])
  search.value = ''
  search.dispatch('input')
  assert.deepEqual(f.ids(), ['beta-root'], 'clearing search restores the previous tree fold')
  assert.equal(f.view.el.querySelectorAll('.phone-ledger-tree').length, 3, 'the empty saved tree returns')
})

test('native node folds and saved-tree headers survive a background refresh', async t => {
  let next = forest()
  const f = await worldFor(t, async () => next)
  f.view.el.querySelector('.phone-ledger-fold').click()
  assert.deepEqual(f.ids(), ['alpha-root', 'beta-root'])
  next = forest()
  next.desktopTree.trees[0].name = 'Native rename'
  f.later()
  f.focus()
  await settle()
  assert.deepEqual(f.ids(), ['alpha-root', 'beta-root'])
  assert.equal(f.view.el.querySelector('.phone-ledger-tree-name').textContent, 'Native rename')
})

test('account change discards native tree folds and private search along with the snapshot', async t => {
  const f = await worldFor(t, async () => forest())
  const tree = f.view.el.querySelector('.phone-ledger-tree')
  assert.ok(tree)
  tree.querySelector('.phone-ledger-tree-toggle').click()
  const search = f.view.el.querySelector('.phone-ledger-search')
  search.value = 'ACCOUNT_A_PRIVATE_SEARCH'
  search.dispatch('input')
  f.fence('account-session-changed')
  assert.equal(search.value, '')
  await settle()
  assert.deepEqual(f.ids(), ['alpha-root', 'alpha-child', 'beta-root'])
})

test('native row activity uses reported busy facts and labels omitted activity as unknown', async t => {
  const saved = snapshot(['native-running', 'native-idle', 'native-unknown'])
  saved.desktopTree.nodes[0].status = 'finished'
  saved.desktopTree.nodes[1].status = 'running'
  saved.desktopTree.nodes[2].status = 'running'
  saved.sessions[0].busy = true
  saved.sessions[1].busy = false
  saved.sessions.pop()
  saved.sessionsTruncated = true
  const f = await worldFor(t, async () => saved)
  assert.deepEqual(f.view.el.querySelectorAll('.phone-ledger-status').map(status => status.textContent), ['running', 'idle', 'Activity not reported'])
  assert.match(f.view.el.querySelector('.phone-ledger-summary').textContent, /1 known running/)
  assert.match(f.view.el.querySelector('.phone-ledger-summary').textContent, /1 without activity readings/)
  const idle = f.view.el.querySelectorAll('.phone-ledger-press')[1]
  idle.click()
  assert.equal(f.view.el.querySelector('.phone-sheet-state').textContent, 'idle')
  assert.equal(f.view.el.querySelector('.phone-sheet-run').textContent, 'Time not reported')
  f.fence('account-session-changed')
  assert.equal(f.view.el.querySelector('.phone-sheet-name').textContent, '')
  assert.equal(f.view.el.querySelector('.phone-sheet-state').textContent, '')
  assert.equal(f.view.el.querySelector('.phone-sheet-subject').hidden, true)
})

test('background native refresh keeps a closed saved-details sheet closed', async t => {
  let next = snapshot()
  next.desktopTree.nodes[0].message = 'First saved prompt'
  const f = await worldFor(t, async () => next)
  f.openFirst()
  const isOpen = () => f.view.el.querySelector('.phone-sheet-open').getAttribute('aria-expanded') === 'true'
  assert.equal(isOpen(), true)
  f.view.el.querySelector('.phone-sheet-close').click()
  await settle()
  assert.equal(isOpen(), false)
  next = snapshot()
  next.desktopTree.nodes[0].message = 'Updated saved prompt'
  f.later(); f.focus(); await settle()
  assert.equal(isOpen(), false, 'a background read is not a request to reopen details')
  assert.match(f.view.el.querySelector('[data-native-tree-details]').textContent, /Updated saved prompt/)
  assert.deepEqual(f.calls, [], 'background facts do not open a conversation')
})

test('native tree creation explains its read-only boundary before accepting a draft', async t => {
  const saved = snapshot()
  const original = JSON.stringify(saved)
  const f = await worldFor(t, async () => saved)
  f.view.el.querySelector('.tree-chat-add').click()
  f.view.el.querySelector('.tree-new-tree').click()
  const panel = f.view.el.querySelector('.agent-compose')
  assert.ok(panel)
  assert.match(panel.querySelector('.agent-compose-notice').textContent, /saved trees.*read-only/i)
  assert.equal(panel.querySelector('.agent-compose-text').disabled, true)
  assert.equal(panel.querySelector('.agent-compose-set').disabled, true)
  assert.equal(panel.querySelector('.agent-compose-start').disabled, true)
  assert.equal(panel.querySelector('.agent-compose-enable').hidden, true, 'enabling local starts cannot grant native tree write authority')
  assert.deepEqual(f.calls, [])
  assert.equal(JSON.stringify(saved), original)
  assert.equal(f.world.storage.getItem('mc.fleet.trees.v1:this-computer'), null)
})

// A hosted saved workspace is already a complete authority. Legacy fleet/org
// responses are deliberately never released in these schedules.
const heldLegacyReads = () => ({
  legacyFetch: () => new Promise(() => {}),
  legacyOrg: () => new Promise(() => {}),
})

test('ready actual authority mounts while unrelated fleet and org reads remain pending', async t => {
  const f = await worldFor(t, async () => snapshot(['actual-native']), heldLegacyReads())
  assert.deepEqual(f.ids(), ['actual-native'])
  assert.equal(f.view.el.dataset.nativeTreeState, 'available')
  assert.equal(f.world.storage.getItem('mc.fleet.trees.v1:this-computer'), null)
})

test('an actual authority refusal is visible without waiting for legacy reads or inventing rows', async t => {
  const f = await worldFor(t, async () => ({ ok: false, code: 'MC_AGENT_DESKTOP_TREE_INVALID' }), heldLegacyReads())
  assert.deepEqual(f.ids(), [])
  assert.match(f.view.el.textContent, /Reconnect to read saved trees/)
  assert.doesNotMatch(f.view.el.textContent, /Reading saved trees/)
})

test('a delayed old initial authority cannot mount after a newer account fence with legacy reads held', async t => {
  let releaseA, reads = 0
  const f = await worldFor(t, () => ++reads === 1 ? new Promise(resolve => { releaseA = resolve }) : snapshot(['current-b']), heldLegacyReads())
  assert.equal(typeof releaseA, 'function')
  f.fence('account-session-changed')
  await settle()
  assert.deepEqual(f.ids(), ['current-b'])
  releaseA(snapshot(['obsolete-a']))
  await settle()
  assert.deepEqual(f.ids(), ['current-b'])
})
