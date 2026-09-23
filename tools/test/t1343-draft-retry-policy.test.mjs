import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const { retryWorld, settle } = await import('./helpers/t844-retry-world.mjs')

function installFixtureAccounts(t) {
  // The world's own teardown removes globalThis.window first, so restore the
  // bridge on the window object this fixture changed.
  const fixtureWindow = globalThis.window
  const previousGlobal = globalThis.mcProviders
  const previousWindow = fixtureWindow?.mcProviders
  let reads = 0
  const bridge = {
    accounts: async () => {
      reads += 1
      return {
        ok: true,
        accounts: [{ name: 'fixture-codex', provider: 'codex', signedIn: 'yes' }],
        policy: { autoRecoverOnLimit: true },
      }
    },
  }
  globalThis.mcProviders = bridge
  fixtureWindow.mcProviders = bridge
  t.after(() => {
    if (previousGlobal === undefined) delete globalThis.mcProviders
    else globalThis.mcProviders = previousGlobal
    if (previousWindow === undefined) delete fixtureWindow.mcProviders
    else fixtureWindow.mcProviders = previousWindow
  })
  return () => reads
}

function retainDraft(f) {
  const key = fleetTreesStorageKey(f.computerId)
  const saved = JSON.parse(f.world.storage.getItem(key))
  const node = saved.nodes.find(row => row.id === f.nodeId)
  assert.ok(node, 'the mounted fixture still has its registered tree node')
  Object.assign(node, {
    sessionId: null,
    status: 'draft',
    statusNote: '',
    message: 'Draft retry policy fixture',
  })
  f.world.storage.setItem(key, JSON.stringify(saved))
}

async function seedEnabledDraftPolicy(f) {
  // A saved recovery record is only read back when it carries its version and
  // a handoff (src/recovery-handoff-store.js), as every record the product
  // writes does.
  await globalThis.window.mcRecovery.save({
    computerId: f.computerId,
    nodeId: f.nodeId,
    record: {
      v: 1,
      handoff: 'Original task: Draft retry policy fixture',
      retryPolicy: {
        v: 1,
        nodeId: f.nodeId,
        nodeRole: 'worker',
        enabled: true,
        waitForReset: false,
        allowedProviders: ['codex'],
        preferredTier: 'luna',
        preferredEffort: 'medium',
        startOptions: {
          tier: 'luna',
          effort: 'medium',
          roleBinding: { agentId: 'fixture-agent' },
        },
        sessionId: null,
        state: 'working',
        exclusions: {},
        holds: {},
        recheckAttempt: 0,
        nextAttemptAt: null,
      },
    },
  })
}

async function remountDraft(f) {
  await f.mount({ fresh: true })
  // Coordinator policy hydration and the real rail mount are asynchronous.
  await settle(60)
  return f.openChat()
}

/* Real computersView/tree store/buildChat callback path. The only external
   seams are the DOM/bridge fixtures from t844-retry-world; no provider starts. */
test('a never-started draft disables Keep/Wait and refuses before account recovery', async t => {
  const f = await retryWorld(t)
  const accountReads = installFixtureAccounts(t)
  retainDraft(f)
  const chat = await remountDraft(f)
  const accountReadsBeforeChoices = accountReads()
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  const status = chat.querySelector('[data-chat-chip="account-retry-status"]')
  assert.ok(select)
  assert.ok(status)
  assert.equal(select.disabled, true, 'a draft cannot choose an account-retry policy')
  assert.match(status.textContent, /Start this agent first/, 'the disabled control gives the person a useful next step')

  for (const value of ['keep', 'wait']) {
    const starts = f.calls.starts.length
    const closes = f.calls.closes.length
    const saves = f.calls.saves.length
    select.value = value
    select.dispatchEvent({ type: 'change' })
    await settle(30)
    assert.equal(f.calls.starts.length, starts, `draft ${value} did not start a provider`)
    assert.equal(f.calls.closes.length, closes, `draft ${value} did not close a session`)
    assert.equal(f.calls.saves.length, saves, `draft ${value} did not write retry state`)
    assert.match(status.textContent, /Start this agent first/)
  }
  assert.equal(accountReads(), accountReadsBeforeChoices, 'a refused draft change never sweeps the registered account list')
})

test('a retained draft policy keeps Try accounts now visible but refuses its action', async t => {
  const f = await retryWorld(t)
  const accountReads = installFixtureAccounts(t)
  retainDraft(f)
  await seedEnabledDraftPolicy(f)
  const chat = await remountDraft(f)
  const accountReadsBeforeAction = accountReads()
  const savesBeforeAction = f.calls.saves.length
  const action = chat.querySelector('[data-chat-chip="account-retry-now"]')
  const status = chat.querySelector('[data-chat-chip="account-retry-status"]')
  assert.ok(action, 'the retained policy keeps the explicit action in the mounted chat')
  assert.ok(status)
  assert.equal(action.hidden, false)
  assert.equal(action.disabled, true, 'a draft retry action is disabled until Start')
  // The real listener correctly ignores a disabled button. Flip this stale
  // fixture control on to exercise the captured callback and its source guard.
  action.disabled = false
  action.dispatch('click')
  await settle(30)
  assert.equal(f.calls.starts.length, 0, 'Try accounts now cannot start a never-started draft')
  assert.equal(f.calls.closes.length, 0)
  assert.equal(f.calls.saves.length, savesBeforeAction, 'Try accounts now cannot write retry state for a draft')
  assert.equal(accountReads(), accountReadsBeforeAction, 'Try accounts now never reads accounts for a draft')
  assert.match(status.textContent, /Start this agent first/)
})

test('a session-bearing finished agent keeps the ordinary retry callback path', async t => {
  const f = await retryWorld(t)
  installFixtureAccounts(t)
  const chat = await f.openChat()
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  const status = chat.querySelector('[data-chat-chip="account-retry-status"]')
  assert.ok(select)
  assert.ok(status)
  assert.equal(select.disabled, false, 'a session-bearing node keeps its ordinary retry control')
  const saves = f.calls.saves.length
  select.value = 'keep'
  select.dispatchEvent({ type: 'change' })
  await settle(60)
  assert.ok(f.calls.saves.length > saves, 'the started-node callback still persists its retry choice')
  assert.equal((await f.record()).retryPolicy?.enabled, true)
  assert.doesNotMatch(status.textContent, /Start this agent first/)
  assert.equal(f.calls.starts.length, 0, 'finished fixture recovery does not launch a provider')
})


test('a formerly-started detached finished node keeps the existing retry path', async t => {
  const f = await retryWorld(t)
  installFixtureAccounts(t)
  const key = fleetTreesStorageKey(f.computerId)
  const saved = JSON.parse(f.world.storage.getItem(key))
  const node = saved.nodes.find(row => row.id === f.nodeId)
  assert.ok(node)
  Object.assign(node, { sessionId: null, status: 'finished', statusNote: 'Stopped by you.' })
  f.world.storage.setItem(key, JSON.stringify(saved))
  await f.mount({ fresh: true })
  await settle(60)
  const chat = await f.openChat()
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  const status = chat.querySelector('[data-chat-chip="account-retry-status"]')
  assert.ok(select)
  assert.ok(status)
  assert.equal(select.disabled, false, 'a detached finished node is not a never-started draft')
  assert.doesNotMatch(status.textContent, /Start this agent first/)
  const saves = f.calls.saves.length
  select.value = 'keep'
  select.dispatchEvent({ type: 'change' })
  await settle(60)
  assert.ok(f.calls.saves.length > saves, 'the formerly-started node still persists its retry choice')
  assert.equal(f.calls.starts.length, 0, 'the finished detached fixture remains provider-free')
})
