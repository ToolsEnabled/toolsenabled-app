import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetFetch, installWorld, mountView, seedTreeNode, settle, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
import { createFleetTreeStore, safeTreeStorage } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const NODE_ID = 'request-refresh-node'
const WORDS = 'Keep this QA tree inside its selected folder.'
const rowKey = ({ scope, key }) => `${scope}:${key || ''}`

function deferred(t) {
  let resolve
  const promise = new Promise(done => { resolve = done })
  t.after(() => resolve({ ok: true, entries: [] }))
  return { promise, resolve }
}

async function fixture(t, { read, write, child = false } = {}) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const ledger = new Map(), filings = [], readings = [], providerCalls = []
  world.bridge.requests = async query => {
    readings.push(query)
    const answer = { ok: true, entries: (ledger.get(rowKey(query)) || []).map(row => ({ ...row })) }
    return read ? read(query, answer, readings.length) : answer
  }
  world.bridge.request = async query => {
    filings.push(query)
    const file = () => {
      const rows = ledger.get(rowKey(query)) || []
      const id = `R${filings.length}`
      rows.push({ id, words: query.words })
      ledger.set(rowKey(query), rows)
      return { ok: true, id }
    }
    return write ? write(query, file) : file()
  }
  for (const verb of ['start', 'send']) world.bridge[verb] = async () => { providerCalls.push(verb); throw new Error('A local filing must not contact a provider') }
  seedTreeNode(world.storage, { nodeId: NODE_ID, sessionId: 'request-refresh-session', status: 'finished' })
  const childNode = child ? createFleetTreeStore({ computerId: COMPUTER_ID, storage: safeTreeStorage(world.storage) })
    .addNode({ parentId: NODE_ID, role: 'worker', message: 'The QA child circle.' }).node : null
  let view
  let disposed = false
  const destroy = () => { if (!disposed) { disposed = true; view?.destroy() } }
  t.after(() => { try { assert.deepEqual(providerCalls, []) } finally { destroy(); world.restore() } })
  view = await mountView(world)
  const control = selector => { const found = view.el.querySelector(selector); assert.ok(found, `Missing mounted control: ${selector}`); return found }
  const select = async id => {
    const circle = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === id)
    assert.ok(circle, 'the seeded circle is on the actual tree canvas')
    circle.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true })
    await settle(4)
  }
  await select(NODE_ID)
  const file = async (text = `/RequestTree ${WORDS}`) => {
    const input = control('[data-rail-chat-host] .chat-input input')
    input.value = text
    input.dispatchEvent({ type: 'input' })
    control('[data-rail-chat-host] .chat-send').click()
    await settle(8)
  }
  return { world, view, control, file, select, destroy, childNode, ledger, filings, readings, providerCalls }
}

test('filing through the mounted Chat refreshes the same agent Details without navigation or a provider send', async t => {
  const f = await fixture(t)
  assert.match(f.control('[data-requests-body]').textContent, /No rules written/)
  await f.file()
  assert.equal(f.filings.length, 1)
  assert.equal(f.filings[0].scope, 'tree')
  assert.equal(f.filings[0].key, NODE_ID)
  assert.equal(f.filings[0].words, WORDS)
  assert.match(f.control('[data-rail-chat-host]').textContent, /Filed R1/)
  f.control('[data-rail-tab="details"]').click()
  assert.equal(f.control('[data-rail-body="details"]').hidden, false)
  assert.match(f.control('[data-requests-body]').textContent, /Keep this QA tree inside its selected folder\./)
  assert.doesNotMatch(f.control('[data-requests-body]').textContent, /No rules written/)
  assert.deepEqual(f.providerCalls, [])
})

test('an older initial rule read cannot erase a confirmed filing or the next Chat draft', async t => {
  const initial = deferred(t)
  let held = false
  const f = await fixture(t, { read: (query, answer) => {
    if (query.scope === 'tree' && !held) { held = true; return initial.promise }
    return answer
  } })
  await f.file()
  assert.match(f.control('[data-requests-body]').textContent, /Keep this QA tree/)
  const input = f.control('[data-rail-chat-host] .chat-input input')
  input.value = 'Keep this next draft and its caret.'
  input.selectionStart = 5; input.selectionEnd = 9; input.focus()
  initial.resolve({ ok: true, entries: [] })
  await settle(6)
  assert.match(f.control('[data-requests-body]').textContent, /Keep this QA tree/)
  assert.equal(f.control('[data-rail-chat-host] .chat-input input'), input)
  assert.equal(input.value, 'Keep this next draft and its caret.')
  assert.deepEqual([input.selectionStart, input.selectionEnd], [5, 9])
  assert.equal(document.activeElement, input)
})

test('a filing completed after selecting a child re-reads its scopes and preserves its own rules', async t => {
  const pending = deferred(t)
  const f = await fixture(t, { child: true, write: async (_query, file) => { await pending.promise; return file() } })
  f.ledger.set(rowKey({ scope: 'tree', key: f.childNode.id }), [{ id: 'R90', words: 'A QA rule specific to the child.' }])
  await f.file()
  await f.select(f.childNode.id)
  assert.match(f.control('[data-requests-body]').textContent, /A QA rule specific to the child/)
  pending.resolve()
  await settle(8)
  const rules = f.control('[data-requests-body]').textContent
  assert.match(rules, /A QA rule specific to the child/)
  assert.match(rules, /Keep this QA tree/)
  assert.equal(f.filings[0].key, NODE_ID, 'the write retains its original scope')
})

for (const [command, scope, key] of [
  ['/Request', 'global', undefined],
  ['/RequestThread', 'thread', NODE_ID],
  ['/RequestSession', 'session', 'request-refresh-session'],
]) {
  test(`${command} refreshes the same rule panel through its canonical scope`, async t => {
    const f = await fixture(t)
    await f.file(`${command} ${WORDS}`)
    assert.equal(f.filings[0].scope, scope)
    assert.equal(f.filings[0].key, key)
    assert.match(f.control('[data-requests-body]').textContent, /Keep this QA tree/)
  })
}

test('a refused filing leaves the current rules in place and does not claim a refresh succeeded', async t => {
  const f = await fixture(t, { write: async () => ({ ok: false }) })
  const before = f.control('[data-requests-body]').textContent
  const count = f.readings.length
  await f.file()
  assert.match(f.control('[data-rail-chat-host]').textContent, /That rule was not filed/)
  assert.equal(f.control('[data-requests-body]').textContent, before)
  assert.equal(f.readings.length, count)
})

test('a confirmed filing whose re-read refuses shows the read refusal beside its filing receipt', async t => {
  let refuse = false
  const f = await fixture(t, { read: (_query, answer) => refuse ? { ok: false, entries: [] } : answer })
  refuse = true
  await f.file()
  assert.match(f.control('[data-rail-chat-host]').textContent, /Filed R1/)
  assert.match(f.control('[data-requests-body]').textContent, /could not read your standing requests/)
})

for (const phase of ['filing', 'reading']) {
  test(`a replaced bridge cannot receive or paint an older ${phase} refresh`, async t => {
    const pending = deferred(t)
    const f = await fixture(t, phase === 'filing'
      ? { write: async (_query, file) => { await pending.promise; return file() } }
      : { read: (query, answer) => query.scope === 'tree' ? pending.promise : answer })
    if (phase === 'filing') await f.file()
    const before = f.control('[data-requests-body]').textContent
    const count = f.readings.length
    let replacementReads = 0
    window.mcAgent = { requests: async () => { replacementReads++; return { ok: true, entries: [] } } }
    pending.resolve({ ok: true, entries: [{ id: 'R88', words: 'A retired source answer.' }] })
    await settle(6)
    assert.equal(f.control('[data-requests-body]').textContent, before)
    assert.equal(f.readings.length, count)
    assert.equal(replacementReads, 0)
  })

  test(`disposal during ${phase} prevents further rule reads and paints`, async t => {
    const pending = deferred(t)
    const f = await fixture(t, phase === 'filing'
      ? { write: async (_query, file) => { await pending.promise; return file() } }
      : { read: (query, answer) => query.scope === 'tree' ? pending.promise : answer })
    if (phase === 'filing') await f.file()
    const body = f.control('[data-requests-body]')
    const before = body.textContent
    const count = f.readings.length
    f.destroy()
    pending.resolve({ ok: true, entries: [{ id: 'R88', words: 'A retired page answer.' }] })
    await settle(6)
    assert.equal(body.textContent, before)
    assert.equal(f.readings.length, count)
  })
}
