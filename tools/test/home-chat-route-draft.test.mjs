import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fleetFetch, installWorld, seedTreeNode, settle, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const { homeView } = await import('../../src/views/home.js')
const NODE_ID = 'route-draft-worker'
const ACCOUNT_A = 'a'.repeat(32)

async function fixture(t, { accountRead = null } = {}) {
  const world = await installWorld(fleetFetch())
  // Frames are layout-only in this fixture; no real desktop or transport.
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  let account = ACCOUNT_A
  const accountBridge = { current: async () => accountRead ? accountRead() : ({ signedIn: true, account: { id: account }, session: { issuedAtMs: 100 } }) }
  const heldAccount = Object.getOwnPropertyDescriptor(globalThis, 'mcAccount')
  globalThis.mcAccount = window.mcAccount = accountBridge
  seedTreeNode(world.storage, { nodeId: NODE_ID, sessionId: 'route-draft-session', status: 'finished' })
  const proto = Object.getPrototypeOf(document.createElement('input'))
  const heldSelection = Object.getOwnPropertyDescriptor(proto, 'setSelectionRange')
  proto.setSelectionRange = function(start, end) { this.selectionStart = start; this.selectionEnd = end }
  const views = new Set()
  const close = async view => {
    view.destroy(); view.el.remove(); views.delete(view)
    await settle(4)
  }
  t.after(async () => {
    for (const view of views) { view.destroy(); view.el.remove() }
    await settle(8)
    if (heldSelection) Object.defineProperty(proto, 'setSelectionRange', heldSelection)
    else delete proto.setSelectionRange
    if (heldAccount) Object.defineProperty(globalThis, 'mcAccount', heldAccount)
    else delete globalThis.mcAccount
    world.restore()
  })
  async function mount() {
    const view = homeView()
    views.add(view); document.body.appendChild(view.el)
    await settle(12)
    return view
  }
  async function open() {
    const view = await mount()
    view.el.querySelector('[data-chat-expand]').dispatch('click')
    await settle(12)
    const picker = view.el.querySelector('[data-chat-subject]')
    picker.value = `agent:${COMPUTER_ID}:${NODE_ID}`
    picker.dispatch('change')
    let input
    for (let i = 0; i < 500 && !input; i++) {
      await settle(1)
      input = view.el.querySelector('[data-chat-panel] .chat-input input')
    }
    assert.ok(input, `actual Home → layout → workspace → buildChat must mount the selected conversation: ${view.el.querySelector('.home-chat-layout')?.textContent}`)
    return { view, input, chat: input.closest('[data-chat-panel]') }
  }
  return { world, open, mount, close, account: value => { account = value } }
}

test('actual Home destruction/remount restores the same conversation text, attachment and selection', async t => {
  const f = await fixture(t)
  const first = await f.open()
  first.chat.importDraft({ text: '  Keep this unsent route draft  ', attachments: [{ id: 'route-image', name: 'diagram.png' }], start: 3, end: 9 })
  await f.close(first.view)
  const next = await f.open()
  assert.equal(next.input.value, '  Keep this unsent route draft  ')
  assert.deepEqual(next.chat.exportDraft().attachments, [{ id: 'route-image', name: 'diagram.png' }])
  assert.equal(next.input.selectionStart, 3)
  assert.equal(next.input.selectionEnd, 9)
  // Intentional clearing consumes the held draft across another route cycle.
  next.chat.importDraft({ text: '', attachments: [], start: 0, end: 0 })
  await f.close(next.view)
  assert.equal((await f.open()).input.value, '')
})

test('actual Home remount never restores another signed-in account\'s draft', async t => {
  const f = await fixture(t)
  const first = await f.open()
  first.input.value = 'Only account A'
  await f.close(first.view)
  f.account('b'.repeat(32))
  assert.equal((await f.open()).input.value, '')
})

test('native signed-out Home retains the same conversation text, attachments and selection across routes', async t => {
  const f = await fixture(t, { accountRead: () => ({ signedIn: false, principal: 'unauthenticated', account: null }) })
  const first = await f.open()
  first.chat.importDraft({ text: 'Local profile draft', attachments: [{ id: 'local-image', name: 'local.png' }], start: 2, end: 7 })
  await f.close(first.view)
  const next = await f.open()
  assert.equal(next.input.value, 'Local profile draft')
  assert.deepEqual(next.chat.exportDraft().attachments, [{ id: 'local-image', name: 'local.png' }])
  assert.equal(next.input.selectionStart, 2)
  assert.equal(next.input.selectionEnd, 7)
})

test('an unresolved account request does not indefinitely prevent opening real Home chat', async t => {
  const f = await fixture(t, { accountRead: () => new Promise(() => {}) })
  const view = await f.mount()
  view.el.querySelector('[data-chat-expand]').dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, false)
  const picker = view.el.querySelector('[data-chat-subject]')
  picker.value = `agent:${COMPUTER_ID}:${NODE_ID}`
  picker.dispatch('change')
  await settle(16)
  assert.ok(view.el.querySelector('[data-chat-panel] .chat-input input'))
})


test('leaving Home while its account read is pending cannot mount a late chat workspace', async t => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const f = await fixture(t, { accountRead: () => pending })
  const view = await f.mount()
  view.el.querySelector('[data-chat-expand]').dispatch('click')
  await f.close(view)
  resolve({ signedIn: true, account: { id: ACCOUNT_A }, session: { issuedAtMs: 100 } })
  await settle(12)
  assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, true)
  assert.equal(document.body.querySelectorAll('.home-agent-runtime-owner').length, 0)
})
