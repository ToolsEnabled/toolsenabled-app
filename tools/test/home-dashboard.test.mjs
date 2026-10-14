import test from 'node:test'
import assert from 'node:assert/strict'
import { homeFixture, settle, until } from './helpers/home-additions-world.mjs'
import { setBridgeTransport } from '../../src/mission-bridge.js'
import { homeLedgerStatus, ledgerStatusHref } from '../../src/home-ledger-status.js'
const NOW = 39_780_027 * 45_000 + 10_000

function promptsFixture() {
  setBridgeTransport(async pathname => pathname === '/v1/owner-prompts'
    ? { ok: true, prompts: [] } : { ok: false, code: 'FIXTURE_BRIDGE_REFUSED' })
  return () => setBridgeTransport(null)
}

test('New agent opens the existing local creation flow without starting or sending', async t => {
  const f = await homeFixture(t)
  const view = await f.mount()
  const button = view.el.querySelector('[data-home-new-agent]')
  assert.equal(button.textContent, 'New agent')
  assert.equal(button.disabled, false)
  button.click()
  await until(() => view.el.querySelector('[data-compose-field="message"]'), 'New agent must open a real agent creation pane')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('the example keeps the creation refusal and real Following chat/Change controls', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = await homeFixture(t, { source: 'mock' }), view = await f.mount()
  assert.equal(view.el.querySelector('[data-home-new-agent]').disabled, true)
  assert.match(view.el.querySelector('[data-home-new-agent]').title, /live fleet/)
  const card = view.el.querySelector('[data-home-following]')
  assert.ok(card.dataset.agentKey)
  assert.equal(card.querySelector('[data-follow-name]').textContent, card.dataset.agentName)
  const chat = card.querySelector('[data-follow-chat]')
  assert.equal(chat.hidden, false); chat.click(); await settle(20)
  assert.equal(view.el.querySelector('[data-home-agent]').value, card.dataset.agentKey)
  assert.equal(view.el.querySelector('[data-home-chat]').hidden, false)
  card.querySelector('[data-follow-change]').click()
  assert.equal(document.activeElement, view.el.querySelector('[data-home-agent]'))
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('status tiles use the existing broad filters and retain historical agent metadata', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = await homeFixture(t, { source: 'mock' }), view = await f.mount()
  const attention = view.el.querySelector('[data-glance-filter="attention"]')
  assert.match(attention.textContent, /Need you/)
  attention.click()
  assert.equal(view.el.querySelector('[data-roster-status]').value, 'attention')
  const rows = [...view.el.querySelectorAll('.home-roster-row')].filter(row => !row.hidden)
  assert.ok(rows.length > 0)
  assert.ok(rows.every(row => row.dataset.state === 'attention'))
  assert.ok(Number(view.el.querySelector('[data-glance="agents"]').textContent) > 0)
  assert.equal(view.el.querySelectorAll('[data-glance-tile]').length, 4)
  view.el.querySelector('[data-glance-filter="working"]').click()
  assert.equal(view.el.querySelector('[data-roster-status]').value, 'working')
  const working = [...view.el.querySelectorAll('.home-roster-row')].filter(row => !row.hidden)
  assert.ok(working.length > 0)
  assert.ok(working.every(row => row.dataset.state === 'working'))
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

for (const previous of ['Following Open chat', 'tree scope']) for (const filter of ['working', 'attention']) {
  test(`${filter} glance tile restores unscoped visible Activity after ${previous}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW })
    const f = await homeFixture(t, { source: 'mock' }), view = await f.mount()
    const picker = view.el.querySelector('[data-home-agent]')
    // Obtain the expected set through the existing roster control, then its
    // real reset. The lightweight select fixture does not choose a default.
    const rosterStatus = view.el.querySelector('[data-roster-status]')
    rosterStatus.value = filter; rosterStatus.dispatch('change'); await settle(12)
    const expected = [...view.el.querySelectorAll('.home-roster-row')]
      .filter(row => row.dataset.state === filter).map(row => row.dataset.key).sort()
    view.el.querySelector('[data-roster-reset]').click(); await settle(12)
    const countValues = () => [...view.el.querySelectorAll('[data-glance]')].map(node => [node.dataset.glance, node.textContent])
    const counts = countValues()
    assert.ok(expected.length > 0, 'the genuine example contains this broad status before choosing a scope')
    if (previous === 'Following Open chat') {
      const following = view.el.querySelector('[data-home-following]')
      following.querySelector('[data-follow-chat]').click(); await settle(20)
      assert.equal(picker.value, following.dataset.agentKey)
      assert.equal(view.el.querySelector('[data-home-chat]').hidden, false)
      assert.equal(f.exposed(view.el.querySelector('.session-view')), false)
    } else {
      const treeId = filter === 'working' ? 'tree:example-control' : 'tree:example-delivery'
      const tree = [...picker.options].find(option => option.value === treeId)
      assert.ok(tree, 'the real tree scope excluding this status must be offered')
      picker.value = tree.value; picker.dispatch('change'); await settle(12)
      assert.equal(picker.value, tree.value)
      assert.equal(view.el.querySelector('[data-home-chat]').hidden, true)
      const scoped = [...view.el.querySelectorAll('.home-roster-row')]
        .filter(row => f.exposed(row) && row.dataset.state === filter).map(row => row.dataset.key).sort()
      assert.notDeepEqual(scoped, expected, 'this actual tree excludes at least one globally counted status agent')
    }
    view.el.querySelector(`[data-glance-filter="${filter}"]`).click(); await settle(12)
    assert.equal(picker.value, '', 'a global count tile must remove the actual agent/tree scope')
    assert.equal(f.world.storage.getItem('mc.home.agent-pick'), '')
    assert.equal(f.world.storage.getItem('mc.home.agent-mode'), 'summary')
    assert.equal(view.el.querySelector('[data-home-chat]').hidden, true)
    assert.equal(f.exposed(view.el.querySelector('.session-view')), true, 'the Activity panel must be exposed through its real ancestor state')
    assert.equal(f.exposed(view.el.querySelector('[data-home-agents]')), true)
    assert.equal(view.el.querySelector('[data-roster-status]').value, filter)
    const visible = [...view.el.querySelectorAll('.home-roster-row')].filter(row => f.exposed(row))
    assert.deepEqual(visible.map(row => row.dataset.key).sort(), expected, 'the existing broad filter must include every matching agent across trees')
    assert.ok(visible.every(row => row.dataset.state === filter))
    assert.deepEqual(countValues(), counts, 'changing presentation scope cannot redefine the real glance counts')
    assert.deepEqual(f.effects, { start: 0, send: 0 })
  })
}

test('the sample instruction stays with the Activity example notice through repaints', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const f = await homeFixture(t, { source: 'mock' }), view = await f.mount()
  const text = 'Turn this off in Settings to see your own computer'
  const note = view.el.querySelector('[data-home-example-note]')
  const badge = view.el.querySelector('[data-panel-badge]')
  for (let repaint = 0; repaint < 3; repaint++) {
    view.el.querySelector('[data-glance-filter="attention"]').click()
    await settle(12)
    assert.equal(note.hidden, false)
    assert.equal(note.parentNode, badge.parentNode.parentNode)
    const hints = [...view.el.querySelectorAll('.home-fact')].filter(node => node.textContent === text)
    assert.equal(hints.length, 1)
    assert.equal(hints[0].parentNode, note)
    assert.equal(hints[0].getAttribute('href'), null)
  }
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('real local data carries no sample instruction or example note', async t => {
  const f = await homeFixture(t), view = await f.mount()
  const note = view.el.querySelector('[data-home-example-note]')
  assert.equal(note.hidden, true)
  assert.equal(note.children.length, 0)
  assert.equal([...view.el.querySelectorAll('.home-fact')].some(node => node.textContent === 'Turn this off in Settings to see your own computer'), false)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

for (const [name, raw] of [
  ['clear', { ok: true, records: [], chain: { ok: true } }],
  ['asks', { ok: true, records: [{ id: 'A1', status: 'open' }], chain: { ok: true } }],
  ['blocked', { ok: true, records: [{ id: 'A1', status: 'open' }, { id: 'T1', status: 'blocked-external' }], chain: { ok: true } }],
  ['unreadable', { ok: false }],
  ['partial', { ok: true, records: [{ id: 'A1', status: 'open' }], chain: { ok: false } }],
]) test(`no agent data retains the real ${name} Ledger fact and route`, async t => {
  const f = await homeFixture(t)
  const restore = promptsFixture(); t.after(restore)
  f.world.bridge.ledger = async () => raw
  const view = await f.mount(), expected = homeLedgerStatus({ ledger: raw, prompts: { ok: true, prompts: [] } })
  const fact = await until(() => {
    const node = view.el.querySelector('[data-home-ledger-status]')
    return node?.querySelector('span').textContent === expected.label ? node : null
  }, `${name}: actual ledger reading did not land`)
  assert.equal(view.el.querySelector('[data-home-glance]').hidden, true)
  assert.equal(fact.parentNode, view.el.querySelector('.home-facts'))
  assert.equal(fact.hidden, false)
  assert.equal(fact.getAttribute('href'), ledgerStatusHref(expected.status))
  assert.equal(fact.title, expected.title)
  assert.equal(view.el.querySelector('[data-follow-empty]').hidden, false)
  assert.ok(view.el.querySelector('.voice-contact'))
  assert.equal(view.el.querySelector('.uring'), null)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('an unanswered Ledger read remains Checking ledger without agent data', async t => {
  const f = await homeFixture(t)
  const restore = promptsFixture(); t.after(restore)
  let release
  f.world.bridge.ledger = () => new Promise(resolve => { release = resolve })
  const view = await f.mount()
  const fact = view.el.querySelector('[data-home-ledger-status]')
  assert.match(fact.querySelector('span').textContent, /checking/i)
  assert.equal(fact.getAttribute('href'), '#/ledger')
  assert.equal(fact.parentNode, view.el.querySelector('.home-facts'))
  release({ ok: false }); await settle(20)
  assert.match(view.el.querySelector('[data-home-ledger-status]').querySelector('span').textContent, /Could not read/)
})


test('empty relay Home exposes the existing new-chat destination refusal', async t => {
  const f = await homeFixture(t, { source: 'relay' }), view = await f.mount()
  const create = view.el.querySelector('[data-home-new-agent]')
  assert.equal(create.disabled, true)
  assert.equal(create.title, 'No computer is available for a new chat.')
  create.click(); await settle(8)
  assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, true)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('empty Following chooses through the existing Computers route without writing data', async t => {
  const f = await homeFixture(t), view = await f.mount()
  assert.equal(view.el.querySelector('[data-follow-empty]').hidden, false)
  view.el.querySelector('[data-follow-choose]').click()
  assert.equal(location.hash, '#/computers')
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})
