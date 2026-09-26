import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const { document, restore } = installDomStandIn(globalThis)
test.after(() => restore())

const { buildChat } = await import('../../src/components.js')
const { RESUME_PANEL } = await import('../../src/fleet-tree-copy.js')
const { NO_SENDER_WIRED } = await import('../../src/chat-copy.js')

function fixture() {
  const listeners = new Set()
  const state = { running: true, resumeRuns: 0 }
  const chat = buildChat({
    title: 'Actions refresh',
    seed: 0,
    history: [],
    composerReason: NO_SENDER_WIRED,
    status: {
      busy: () => state.running,
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    actions: () => [{
      id: 'resume',
      label: RESUME_PANEL.action,
      enabled: !state.running,
      disabledHint: state.running ? RESUME_PANEL.busy : null,
      run: () => { state.resumeRuns += 1 },
    }, {
      id: 'interrupt',
      label: 'Interrupt',
      enabled: state.running,
      disabledHint: state.running ? null : 'Nothing is running.',
      run: () => {},
    }],
  })
  document.body.appendChild(chat)
  return {
    chat, state,
    notify() { for (const listener of [...listeners]) listener() },
    resume() {
      return [...chat.querySelectorAll('.chat-actions-row')].find(row => row.textContent.includes(RESUME_PANEL.action))
    },
    dispose() { chat.dispose(); chat.remove() },
  }
}

test('an already-open Actions menu keeps stale Resume enabled state after the session finishes', () => {
  const f = fixture()
  try {
    f.chat.openActions()
    const before = f.resume()
    assert.ok(before, 'Resume row missing at open')
    assert.equal(before.disabled, true)
    assert.match(before.textContent, /still running/)
    f.state.running = false
    assert.equal(f.resume().disabled, true, 'without a status notification the open menu still shows the running refusal')
  } finally { f.dispose() }
})

test('status notification refreshes an already-open Actions menu without closing it or firing Resume', async () => {
  const f = fixture()
  try {
    f.chat.openActions()
    const filter = f.chat.querySelector('.chat-actions-filter')
    filter.value = 'resu'
    filter.focus()
    assert.equal(f.resume().disabled, true)
    f.state.running = false
    f.notify()
    assert.ok(f.chat.querySelector('.chat-actions-pop'), 'refresh closed the open menu')
    const after = f.resume()
    assert.ok(after, 'Resume row missing after refresh')
    assert.equal(after.disabled, false, 'Resume stayed disabled with still-running text after Stop/Interrupt finished')
    assert.equal(after.textContent.includes('still running'), false)
    assert.equal(f.state.resumeRuns, 0, 'refresh must not fire Resume')
    assert.equal(f.chat.querySelector('.chat-actions-filter').value, 'resu')
    assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-filter'), 'a newly disabled row must hand focus to the filter')
    after.click()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(f.state.resumeRuns, 1, 'a freshly enabled Resume must still be pressable')
  } finally { f.dispose() }
})

test('a focused action that becomes disabled returns focus to the retained filter', () => {
  const f = fixture()
  try {
    f.chat.openActions()
    const interrupt = [...f.chat.querySelectorAll('.chat-actions-row')].find(row => row.textContent.includes('Interrupt'))
    interrupt.focus()
    f.state.running = false
    f.notify()
    assert.ok(document.activeElement === f.chat.querySelector('.chat-actions-filter'), 'a newly disabled row must hand focus to the filter')
    assert.equal(f.state.resumeRuns, 0)
  } finally { f.dispose() }
})

test('an unchanged visible action retains its focused row and runs the latest callback', async () => {
  let notify, revision = 1, ran = null
  const chat = buildChat({ title: 'Stable action',
    status: { busy: () => false, subscribe: listener => { notify = listener; return () => {} } },
    actions: () => {
      const current = revision
      return [{ id: 'inspect', label: 'Inspect', run: () => { ran = current } }]
    },
  })
  document.body.appendChild(chat)
  try {
    chat.openActions()
    const row = chat.querySelector('.chat-actions-row')
    row.focus()
    revision = 2; notify()
    assert.ok(chat.querySelector('.chat-actions-row') === row, 'a status refresh must not replace an unchanged row')
    assert.ok(document.activeElement === row, 'refresh must retain focus on the unchanged action')
    row.click(); await Promise.resolve(); await Promise.resolve()
    assert.equal(ran, 2, 'a retained row must run the current action rather than its old closure')
  } finally { chat.dispose(); chat.remove() }
})

test('an update while focus is leaving Actions does not steal it back from another control', async () => {
  const f = fixture()
  const elsewhere = document.createElement('button')
  document.body.appendChild(elsewhere)
  try {
    f.chat.openActions()
    elsewhere.focus()
    f.chat.querySelector('.chat-actions-pop').dispatch('focusout')
    f.state.running = false
    f.notify()
    assert.ok(document.activeElement === elsewhere, 'refresh must retain the outside focus destination')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(f.chat.querySelector('.chat-actions-pop'), null)
    assert.ok(document.activeElement === elsewhere, 'closing Actions must retain the outside focus destination')
  } finally { f.dispose(); elsewhere.remove() }
})

test('an open model picker refreshes supplied choices without running an action or losing its list focus', async () => {
  let notify, running = true, selected = 0
  const chat = buildChat({ title: 'Model picker', status: { busy: () => running, subscribe: fn => { notify = fn; return () => {} } },
    actions: () => [{ id: 'model', label: 'Model', run: ctx => ctx.show(() => [{
      id: 'next-model', label: running ? 'Running model' : 'Next session model', enabled: !running,
      disabledHint: 'Wait for this turn to stop.', run: () => { selected += 1 },
    }], { title: 'Model' }) }],
  })
  document.body.appendChild(chat)
  try {
    chat.openActions('model')
    await Promise.resolve(); await Promise.resolve()
    const popup = chat.querySelector('.chat-actions-pop')
    assert.equal(chat.querySelectorAll('.chat-actions-row')[1].disabled, true)
    running = false; notify()
    assert.ok(chat.querySelector('.chat-actions-pop') === popup)
    assert.ok(document.activeElement === chat.querySelector('.chat-actions-list'))
    const choice = chat.querySelectorAll('.chat-actions-row')[1]
    assert.equal(choice.disabled, false)
    assert.match(choice.textContent, /Next session model/)
    assert.equal(selected, 0)
    choice.click(); await Promise.resolve(); await Promise.resolve()
    assert.equal(selected, 1)
  } finally { chat.dispose(); chat.remove() }
})

test('a refreshed picker whose choices cannot be read retains Back and reports the refusal', async () => {
  let notify, broken = false, runs = 0
  const chat = buildChat({ title: 'Model picker refusal', status: { busy: () => false, subscribe: fn => { notify = fn; return () => {} } },
    actions: () => [{ id: 'model', label: 'Model', run: ctx => ctx.show(() => {
      if (broken) throw Object.assign(new Error('fixture unavailable'), { code: 'MODEL_LIST_UNAVAILABLE' })
      return [{ id: 'choice', label: 'Choose model', run: () => { runs += 1 } }]
    }, { title: 'Model' }) }],
  })
  document.body.appendChild(chat)
  try {
    chat.openActions('model'); await Promise.resolve(); await Promise.resolve()
    broken = true
    assert.doesNotThrow(() => notify())
    assert.ok(chat.querySelector('.chat-actions-back'))
    assert.equal(chat.querySelectorAll('.chat-actions-row')[1].disabled, true)
    assert.ok(chat.querySelector('.chat-actions-out').textContent.length > 0)
    assert.equal(runs, 0)
  } finally { chat.dispose(); chat.remove() }
})

test('an initial status notification retains the subscription and its cleanup', () => {
  let subscribed = false, released = 0
  const chat = buildChat({ title: 'Immediate status',
    status: { busy: () => false, subscribe: listener => {
      listener()
      subscribed = true
      return () => { released += 1 }
    } },
    actions: () => [{ id: 'ready', label: 'Ready', run() {} }],
  })
  try {
    assert.equal(subscribed, true, 'initial status callback must finish before the menu is mounted')
  } finally { chat.dispose(); chat.remove() }
  assert.equal(released, 1, 'disposing the chat must release the initial status subscription')
})
