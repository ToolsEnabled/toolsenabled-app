import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import test from 'node:test'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const { setBridgeTransport } = await import('../../src/mission-bridge.js')
const { DATA_SOURCE_EVENT, resolveDataSource } = await import('../../src/data-source.js')
const machineTabs = await import('../../src/machine-tabs.js')
// The event is a bridge contract; retaining its literal lets this unchanged
// mounted regression also run on the pre-repair App source.
const MACHINE_CHOICE_INTENT_EVENT = machineTabs.MACHINE_CHOICE_INTENT_EVENT || 'mc:machine-choice-intent'

const MAIN = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const sourceListener = MAIN.slice(MAIN.indexOf('window.addEventListener(DATA_SOURCE_EVENT, event => {'),
  MAIN.indexOf('window.addEventListener(WRITE_FLAGS_EVENT,'))
assert.ok(sourceListener.startsWith('window.addEventListener(DATA_SOURCE_EVENT, event => {'))
assert.match(sourceListener, /queueMicrotask\(render\)/)
const refusal = 'The connection could not reach that computer. Try again in a moment.'

async function fixture(t, { remount }) {
  const world = await installWorld({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) }, { asyncFrames: true })
  delete window.mcShell.getBridgeProof
  setBridgeTransport(async () => ({ ok: false, reason: 'No fleet fixture.' }))
  const previousGlobalAccount = Object.getOwnPropertyDescriptor(globalThis, 'mcAccount')
  let selected = 'a'
  let releaseCheck
  const calls = []
  const events = []
  const announced = (why, input) => window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why, ...input } }))
  globalThis.mcAccount = window.mcAccount = {
    machineChoiceIntentVersion: 1,
    signIn: async () => ({ ok: false }),
    availability: async () => ({ ok: true, accountCount: 1 }),
    current: async () => ({ ok: true, signedIn: true, account: { id: 'owner', username: 'owner', displayName: 'Owner', createdAt: '2026-09-14T00:00:00Z' } }),
    machines: async () => ({ ok: true, machines: ['a', 'b'].map(id => ({
      relayPairId: `pair-${id}`, solo: true, connected: true,
      machines: [{ pairId: `device-${id}`, name: `Computer ${id.toUpperCase()}`, collection: 'collected' }],
    })) }),
    machineInUse: async () => ({ ok: true, relayPairId: `pair-${selected}`, devicePairId: `device-${selected}` }),
    chooseMachine: async choice => {
      window.dispatchEvent(new CustomEvent(MACHINE_CHOICE_INTENT_EVENT, { detail: { ...choice, machineChoiceIntent: choice.machineChoiceIntent || null } }))
      calls.push(['choose', choice.relayPairId, choice.devicePairId])
      selected = choice.devicePairId.slice(-1)
      announced('machine-chosen', choice)
      return { ok: true, ...choice }
    },
    checkMachine: async (pair, device) => {
      calls.push(['check', pair, device])
      return new Promise(resolve => { releaseCheck = resolve })
    },
  }
  window.mcDesktopTree = { read: async () => ({ ok: true, mayWrite: true,
    desktopTree: { version: 1, computerId: 'this-computer', trees: [], nodes: [] }, sessions: [], sessionsTruncated: false }) }
  window.mcDesktopSessions = { list: async () => ({ ok: true, mayWrite: true, sessions: [], truncated: false }) }
  world.bridge.onEvent = () => () => {}
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  await resolveDataSource({ reask: true })
  let view = await mountView(world)
  const mounted = [view]
  const pending = []
  const recordEvent = event => events.push(event.detail.why)
  window.addEventListener(DATA_SOURCE_EVENT, recordEvent)
  if (remount) {
    // Execute the unchanged shell listener. Only its unrelated shell services
    // and renderer container are stand-ins; the mounted view is real source.
    const render = () => {
      const old = view
      old.destroy()
      old.el.remove()
      pending.push(mountView(world).then(next => { mounted.push(next); view = next }))
    }
    Function('window', 'DATA_SOURCE_EVENT', 'syncPhoneExampleNotice', 'isExampleMode', 'currentDataSource',
      'resetPersistentVoice', 'accessibilityControls', 'resetCartChanges', 'current', 'render', sourceListener)(
      window, DATA_SOURCE_EVENT, () => {}, () => false, () => 'relay', () => {}, {}, () => {},
      { route: { name: 'computers' } }, render)
  }
  t.after(async () => {
    await Promise.all(pending)
    for (const mountedView of mounted) { mountedView.destroy(); mountedView.el.remove() }
    if (previousGlobalAccount) Object.defineProperty(globalThis, 'mcAccount', previousGlobalAccount)
    else delete globalThis.mcAccount
    delete window.mcAccount
    delete window.mcDesktopTree
    delete window.mcDesktopSessions
    setBridgeTransport(null)
    world.restore()
  })
  return { calls, events, mounted,
    selected: () => selected,
    view: () => view,
    fence: why => announced(why),
    externalIntent: input => window.dispatchEvent(new CustomEvent(MACHINE_CHOICE_INTENT_EVENT, { detail: { machineChoiceIntent: null, ...input } })),
    waiting: async () => { await settle(); await Promise.all(pending) },
    press: () => {
      const button = view.el.querySelectorAll('[data-machine-tab]').find(node => node.textContent === 'Computer B')
      assert.ok(button, 'the actual account machine button is mounted')
      button.click()
    },
    finish: async () => {
      await settle()
      await Promise.all(pending)
      assert.equal(typeof releaseCheck, 'function', 'the real switch is waiting on the native reachability answer')
      releaseCheck({ ok: false, code: 'MC_RELAY_UNREACHABLE', reason: refusal })
      await settle()
      await Promise.all(pending)
    },
  }
}

for (const remount of [false, true]) test(`a refused machine switch keeps its explanation ${remount ? 'through actual source-event remounts' : 'without shell remount (control)'}`, async t => {
  const f = await fixture(t, { remount })
  f.press()
  await f.finish()
  assert.equal(f.selected(), 'a', 'the account bridge restored the original computer')
  assert.deepEqual(f.calls, [['choose', 'pair-b', 'device-b'], ['check', 'pair-b', 'device-b'], ['choose', 'pair-a', 'device-a']])
  assert.deepEqual(f.events, ['machine-chosen', 'machine-chosen'])
  if (remount) assert.equal(f.mounted.length, 3, 'both real machine-source events replaced the view')
  const note = f.view().el.querySelector('.machine-note')
  assert.equal(note.textContent, `${refusal} You are still driving Computer A.`)
  assert.equal(note.hidden, false)
})

test('a new mounted view retains progress and cannot start a competing switch', async t => {
  const f = await fixture(t, { remount: true })
  f.press()
  await f.waiting()
  const active = f.view()
  assert.equal(active.el.querySelector('.machine-note').textContent, 'Opening Computer B…')
  const tabs = active.el.querySelectorAll('[data-machine-tab]')
  assert.equal(tabs.length, 2)
  assert.ok(tabs.every(tab => tab.disabled))
  tabs.find(tab => tab.textContent === 'Computer A').click()
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 1)
  await f.finish()
  assert.ok(f.view().el.querySelectorAll('[data-machine-tab]').every(tab => !tab.disabled))
})

for (const why of ['sign-out-started', 'account-session-changed']) test(`mounted ${why} suppresses the old pending outcome and rollback`, async t => {
  const f = await fixture(t, { remount: true })
  f.press()
  await f.waiting()
  f.fence(why)
  await f.waiting()
  assert.equal(f.view().el.querySelector('.machine-note').textContent, '')
  await f.finish()
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 1)
  assert.equal(f.view().el.querySelector('.machine-note').textContent, '')
  assert.equal(f.view().el.querySelector('.machine-note').hidden, true)
})

test('same-pair newer intent cancels the mounted old switch without an authority remount', async t => {
  const f = await fixture(t, { remount: true })
  f.press()
  await f.waiting()
  const current = f.view()
  f.externalIntent({ relayPairId: 'pair-b', devicePairId: 'device-b' })
  assert.equal(f.view(), current, 'intent alone does not publish a source change')
  assert.equal(current.el.querySelector('.machine-note').textContent, '')
  await f.finish()
  assert.equal(f.calls.filter(([kind]) => kind === 'choose').length, 1)
  assert.equal(f.view().el.querySelector('.machine-note').textContent, '')
})
