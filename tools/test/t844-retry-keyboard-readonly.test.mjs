import test from 'node:test'
import assert from 'node:assert/strict'
import { retryWorld, settle } from './helpers/t844-retry-world.mjs'

// DOM focus/change evidence only: real browser Tab/arrow behavior needs the rig.
test('T844 mounted retry selector focuses and commits each policy through the real chat callback', async t => {
  const f = await retryWorld(t)
  const chat = await f.openChat()
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  assert.equal(select.tagName, 'SELECT')
  assert.equal(select.getAttribute('aria-label'), 'Account retry policy')
  select.focus()
  assert.equal(document.activeElement, select)
  for (const [value, enabled, waitForReset] of [['keep', true, false], ['wait', true, true], ['off', false, true]]) {
    await f.choose(chat, value)
    const policy = (await f.record())?.retryPolicy
    assert.equal(policy?.enabled, enabled, value + ' reaches the recovery store')
    assert.equal(policy?.waitForReset, waitForReset)
    assert.equal(select.value, value, 'mounted repaint reflects the persisted policy')
  }
  assert.deepEqual(f.calls.starts, [], 'changing the stopped fixture policy starts no provider')
})

test('T844 a retained retry control cannot write after its chat has been disposed', async t => {
  const f = await retryWorld(t)
  const chat = await f.openChat()
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  await f.mount()
  const count = f.calls.saves.length
  select.value = 'wait'
  select.dispatchEvent({ type: 'change' })
  await settle(15)
  assert.equal(f.calls.saves.length, count, 'detached controls do not persist changes')
})

test('T844 mounted example chat exposes no actionable retry policy or Try accounts now', async t => {
  const f = await retryWorld(t)
  await f.mount({ example: true })
  // The shared DOM stand-in accepts a class or attribute selector, not a
  // compound class+attribute selector. Read the mounted dataset explicitly.
  const card = [...f.view.el.querySelectorAll('.static-tree-node')].find(node => node.dataset.agentId)
  assert.ok(card, 'example tree has a mounted node')
  const chat = await f.openChat(card.dataset.agentId)
  assert.match(chat.textContent, /example/i, 'the example composer identifies its read-only context')
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  const action = chat.querySelector('[data-chat-chip="account-retry-now"]')
  assert.ok(!select || select.disabled, 'example retry policy is read-only')
  assert.ok(!action || action.hidden || action.disabled, 'example has no actionable retry')
  const count = f.calls.saves.length
  if (select) { select.value = 'wait'; select.dispatchEvent({ type: 'change' }) }
  if (action) action.dispatchEvent({ type: 'click' })
  await settle(15)
  assert.equal(f.calls.saves.length, count)
  assert.deepEqual(f.calls.starts, [])
  assert.deepEqual(f.calls.closes, [])
})
