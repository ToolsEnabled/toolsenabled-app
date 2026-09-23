import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { buildChat } from '../../src/components.js'
import { createHomeComposerDraftStore } from '../../src/home-chat-composer-draft.js'

const subject = { id: 'pane-label', computerId: 'computer-a', agentId: 'node-a' }

function fixture(t) {
  const dom = installDomStandIn()
  const roots = []
  let current = { signedIn: true, account: { id: 'a'.repeat(32) }, session: { issuedAtMs: 100 } }
  const account = { current: async () => current }
  t.after(() => { for (const root of roots) { root.dispose(); root.remove() }; dom.restore() })
  async function route(options = {}) {
    const drafts = createHomeComposerDraftStore({ account, ...options })
    await drafts.ready
    return {
      mount(target = subject, options = {}) {
        const adapter = drafts.forConversation(target)
        const chat = buildChat({ title: 'Home handoff', onSend() {}, ...options })
        dom.document.body.appendChild(chat); roots.push(chat)
        chat.importDraft(adapter.readDraft(target.id))
        return { chat, input: chat.querySelector('.chat-input input'),
          close() { adapter.writeDraft(target.id, chat.exportDraft()); chat.dispose(); chat.remove() } }
      },
    }
  }
  // A conversation as Home's panel gets it: asked for before the account lookup answered.
  async function early(target = subject) {
    const drafts = createHomeComposerDraftStore({ account })
    const adapter = drafts.forConversation(target)
    await drafts.ready
    const chat = buildChat({ title: 'Home panel', onSend() {} })
    dom.document.body.appendChild(chat); roots.push(chat)
    chat.importDraft(adapter.readDraft(target.id))
    return { chat, input: chat.querySelector('.chat-input input'),
      close() { adapter.writeDraft(target.id, chat.exportDraft()); chat.dispose(); chat.remove() } }
  }
  return { route, early, account: value => { current = value } }
}

test('real draft handoffs use computer/node identity, not reused pane labels or ambiguous concatenation', async t => {
  const f = fixture(t)
  const first = (await f.route()).mount()
  first.input.value = 'Only this computer and node'
  first.close()
  const other = await f.route()
  for (const target of [
    { ...subject, computerId: 'computer-b' },
    { ...subject, agentId: 'node-b' },
    { ...subject, computerId: null },
    { ...subject, agentId: null },
  ]) { const pane = other.mount(target); assert.equal(pane.input.value, ''); pane.close() }
  const renamed = other.mount({ ...subject, id: 'different-pane-label' })
  assert.equal(renamed.input.value, 'Only this computer and node')
  renamed.close()
  const colonOne = other.mount({ id: 'same', computerId: 'c:d', agentId: 'e' })
  colonOne.input.value = 'Tuple one'; colonOne.close()
  assert.equal(other.mount({ id: 'same', computerId: 'c', agentId: 'd:e' }).input.value, '')
})

test('a queued edit never returns as a new unsent draft or resurrects an earlier saved draft', async t => {
  const f = fixture(t)
  const prior = (await f.route()).mount()
  prior.input.value = 'Old ordinary draft'; prior.close()
  const waiting = [{ id: 'queued-1', text: 'Already waiting' }]
  const pane = (await f.route()).mount(subject, {
    queue: { list: () => waiting, replace: () => ({ ok: true }) },
  })
  assert.equal(pane.input.value, 'Old ordinary draft')
  pane.input.value = ''
  pane.input.dispatch('keydown', { key: 'ArrowUp' })
  assert.equal(pane.input.value, 'Already waiting')
  assert.equal(pane.chat.exportDraft(), null)
  pane.close()
  assert.equal((await f.route()).mount().input.value, '')
  assert.deepEqual(waiting, [{ id: 'queued-1', text: 'Already waiting' }])
})

test('a cleared or successfully sent draft remains discarded after the next route mount', async t => {
  const f = fixture(t)
  const first = (await f.route()).mount()
  first.input.value = 'Previously saved'; first.close()
  const next = (await f.route()).mount()
  next.input.dispatch('keydown', { key: 'Enter' })
  await Promise.resolve()
  assert.equal(next.input.value, '')
  next.close()
  assert.equal((await f.route()).mount().input.value, '')
})

test('late teardown cannot overwrite the successor pane draft', async t => {
  const f = fixture(t)
  const old = (await f.route()).mount()
  old.input.value = 'Stale old view'
  const next = (await f.route()).mount()
  next.input.value = 'Newer typing'
  next.close()
  old.close()
  assert.equal((await f.route()).mount().input.value, 'Newer typing')
})

test('signed out, refused account reads and a new sign-in cannot reuse a previous account handoff', async t => {
  const f = fixture(t)
  const first = (await f.route()).mount()
  first.input.value = 'Private draft'; first.close()
  for (const current of [
    { signedIn: false },
    { ok: false, signedIn: true, account: { id: 'a'.repeat(32) } },
    { signedIn: true, account: { id: 'b'.repeat(32) }, session: { issuedAtMs: 100 } },
    { signedIn: true, account: { id: 'a'.repeat(32) }, session: { issuedAtMs: 101 } },
  ]) { f.account(current); assert.equal((await f.route()).mount().input.value, '') }
})

test('an unknown account retains drafts only within its Home instance; sample does not read the account', async t => {
  const f = fixture(t)
  f.account({ signedIn: false })
  const route = await f.route()
  const first = route.mount(); first.input.value = 'Local to this Home'; first.close()
  const next = route.mount()
  assert.equal(next.input.value, 'Local to this Home')
  next.close()
  assert.equal((await f.route()).mount().input.value, '')
  const sample = createHomeComposerDraftStore({ sample: true, account: { current() { assert.fail('sample must not read a real account') } } })
  await sample.ready
})

const signedOut = { signedIn: false, principal: 'unauthenticated', account: null }
const signedIn = { signedIn: true, account: { id: 'a'.repeat(32) }, session: { issuedAtMs: 100 } }

test('identity round trips never resurrect drafts from a retired generation', async t => {
  const f = fixture(t)
  for (const [start, middle] of [
    [signedIn, { ...signedIn, account: { id: 'b'.repeat(32) } }],
    [signedIn, { signedIn: false }],
    [signedOut, signedIn],
    [signedOut, { ok: false }],
  ]) {
    f.account(start)
    const old = (await f.route()).mount(); old.input.value = 'Retired private draft'; old.close()
    f.account(middle)
    const interim = (await f.route()).mount(); assert.equal(interim.input.value, ''); interim.close()
    f.account(start)
    const returned = (await f.route()).mount(); assert.equal(returned.input.value, ''); returned.close()
  }
})

test('retired account writers cannot restore typing after identity changes back', async t => {
  const f = fixture(t)
  const old = (await f.route()).mount(); old.input.value = 'Stale account A'
  f.account(signedOut)
  const local = (await f.route()).mount(); local.close()
  old.close()
  f.account(signedIn)
  assert.equal((await f.route()).mount().input.value, '')
})

// T1571: only opening Account or Setup is not a sign-out. The unsent words
// come back, as after Settings; a sign-in change made there still retires them.
test('opening Account or Setup keeps the drafts while the signed-in identity is unchanged', async t => {
  const f = fixture(t)
  for (const start of [signedIn, signedOut]) {
    f.account(start)
    for (const hash of ['#/account', '#/setup', '#/setup?step=account']) {
      const words = `Before visiting ${hash}`
      const old = (await f.route()).mount(); old.input.value = words; old.close()
      window.location = { hash }; window.dispatch('hashchange', {})
      window.location = { hash: '#/home' }; window.dispatch('hashchange', {})
      const back = (await f.route()).mount()
      assert.equal(back.input.value, words, `${hash} kept the draft`)
      back.close()
    }
  }
})

test('a sign-out, sign-in or account change made during an Account or Setup visit still retires the drafts', async t => {
  const f = fixture(t)
  for (const [hash, start, changed] of [
    ['#/account', signedIn, { ...signedIn, account: { id: 'b'.repeat(32) } }],
    ['#/account', signedIn, { ...signedIn, session: { issuedAtMs: 101 } }],
    ['#/account', signedIn, signedOut],
    ['#/setup?step=account', signedOut, signedIn],
    ['#/setup', signedIn, { signedIn: false }],
  ]) {
    f.account(start)
    const old = (await f.route()).mount(); old.input.value = 'Draft of the earlier identity'; old.close()
    window.location = { hash }; window.dispatch('hashchange', {})
    f.account(changed)
    window.location = { hash: '#/home' }; window.dispatch('hashchange', {})
    const interim = (await f.route()).mount(); assert.equal(interim.input.value, '', `${hash}: the changed identity sees no draft`); interim.close()
    f.account(start)
    const returned = (await f.route()).mount(); assert.equal(returned.input.value, '', `${hash}: the retired draft never returns`); returned.close()
  }
})

test('ordinary Settings navigation and separate native bridges preserve their own local drafts', async t => {
  const f = fixture(t)
  f.account(signedOut)
  const first = (await f.route()).mount(); first.input.value = 'This native profile'; first.close()
  window.location = { hash: '#/settings' }; window.dispatch('hashchange', {})
  const other = (await f.route({ account: { current: async () => signedOut } })).mount()
  assert.equal(other.input.value, ''); other.close()
  assert.equal((await f.route()).mount().input.value, 'This native profile')
})

test('late identity reads cannot reclaim a newer generation or revive an expired lookup', async t => {
  fixture(t)
  const resolvers = []
  const account = { current: () => new Promise(resolve => resolvers.push(resolve)) }
  const first = createHomeComposerDraftStore({ account })
  await Promise.resolve()
  const next = createHomeComposerDraftStore({ account })
  await Promise.resolve()
  resolvers[1](signedOut); await next.ready
  const writer = next.forConversation(subject); writer.readDraft(); writer.writeDraft(null, { text: 'Current local draft' })
  resolvers[0](signedIn); await first.ready
  assert.equal(first.forConversation(subject).readDraft(), null)
  const current = createHomeComposerDraftStore({ account }); await Promise.resolve()
  resolvers[2](signedOut); await current.ready
  assert.equal(current.forConversation(subject).readDraft().text, 'Current local draft')

  const expired = createHomeComposerDraftStore({ account })
  let timer
  await Promise.race([expired.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('account read blocked chat')), 1300) })]).finally(() => clearTimeout(timer))
  resolvers[3](signedIn); await Promise.resolve()
  const later = createHomeComposerDraftStore({ account }); await Promise.resolve()
  resolvers[4](signedOut); await later.ready
  assert.equal(later.forConversation(subject).readDraft(), null)
})

// T1497: Home's panel asks for its first conversation while Home is still
// being built, before the account lookup has answered. That conversation must
// still read and keep the renderer-wide draft, like every later one.
test('a conversation asked for before the account lookup answers still uses the kept drafts', async t => {
  const f = fixture(t)
  const left = (await f.route()).mount()
  left.input.value = 'Words left before leaving Home'; left.close()
  for (const round of [1, 2, 3]) {
    const panel = await f.early()
    assert.equal(panel.input.value, round === 1 ? 'Words left before leaving Home' : `first words round ${round - 1}`,
      `round ${round}: the unsent draft is in the box on arrival`)
    panel.input.value = `first words round ${round}`
    panel.close()
    const back = (await f.route()).mount()
    assert.equal(back.input.value, `first words round ${round}`, `round ${round}: switching away and back keeps what was typed`)
    back.close()
  }
})
