import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { transcriptStorageKey } from '../../src/session-transcript-store.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)

const { retryWorld, settle } = await import('./helpers/t844-retry-world.mjs')

function installFixtureAccounts(t, { autoRecoverOnLimit = true } = {}) {
  // The world's own teardown removes globalThis.window first, so restore the
  // bridge on the window object this fixture changed.
  const fixtureWindow = globalThis.window
  const previousGlobal = globalThis.mcProviders
  const previousWindow = fixtureWindow?.mcProviders
  let reads = 0
  let available = true
  let currentPolicy = autoRecoverOnLimit
  let nextReadGate = null
  const bridge = {
    accounts: async () => {
      reads += 1
      const gate = nextReadGate
      nextReadGate = null
      if (gate) {
        gate.started = true
        return gate.promise
      }
      if (!available) return { ok: false }
      return {
        ok: true,
        accounts: [{ name: 'fixture-codex', provider: 'codex', signedIn: 'yes' }],
        policy: { autoRecoverOnLimit: currentPolicy },
      }
    },
    accountPolicy: async request => {
      if (typeof request?.autoRecoverOnLimit === 'boolean') currentPolicy = request.autoRecoverOnLimit
      return { ok: true }
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
  const accountReads = () => reads
  accountReads.setAvailable = value => { available = value === true }
  accountReads.deferNext = () => {
    let resolve
    const gate = { started: false, promise: new Promise(done => { resolve = done }), resolve: value => resolve(value) }
    nextReadGate = gate
    return gate
  }
  return accountReads
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

function seedTranscript(f) {
  f.world.storage.setItem(transcriptStorageKey(f.computerId), JSON.stringify({ v: 1, nodes: {
    [f.nodeId]: { savedAt: Date.now(), threadId: 'fixture-thread', effort: 'medium', provider: 'codex', account: 'fixture-codex',
      lines: [{ who: 'you', text: 'Retained refusal fixture', at: Date.now() }] },
  } }))
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

async function seedEnabledSessionPolicy(f) {
  await globalThis.window.mcRecovery.save({
    computerId: f.computerId,
    nodeId: f.nodeId,
    record: {
      v: 1,
      sessionId: f.sessionId,
      handoff: 'Original task: Deferred Resume refusal fixture',
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
          roleBinding: { agentId: f.nodeId, id: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 },
        },
        sessionId: f.sessionId,
        state: 'paused',
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

test('the mounted retry chip names the inherited Accounts policy and Off persists a per-agent stop', async t => {
  const f = await retryWorld(t)
  installFixtureAccounts(t, { autoRecoverOnLimit: true })
  const chat = await f.openChat()
  await settle(60)
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  assert.ok(select)
  assert.equal(select.value, 'keep', 'the default follows the Accounts menu instead of claiming Off')
  assert.equal(Array.from(select.options || select.querySelectorAll?.('option') || []).find(option => option.value === 'keep')?.textContent,
    'Follows Accounts menu: continue after a limit')
  assert.match(chat.querySelector('[data-chat-chip="account-retry-status"]')?.textContent || '',
    /Accounts menu continues after a limit/)

  select.value = 'off'
  select.dispatchEvent({ type: 'change' })
  await settle(60)
  const saved = await f.record()
  assert.equal(saved.retryPolicy?.enabled, false, 'Off creates a durable per-agent override')
  assert.equal(select.value, 'off')
  assert.equal(Array.from(select.options || select.querySelectorAll?.('option') || []).find(option => option.value === 'keep')?.textContent,
    'Keep trying accounts', 'an explicit Off override clears the inherited label')
  assert.equal(f.calls.starts.length, 0, 'changing the policy does not start a provider')

  seedTranscript(f)
  assert.ok(JSON.parse(f.world.storage.getItem(transcriptStorageKey(f.computerId))).nodes[f.nodeId])
  await f.mount({ fresh: true })
  await settle(60)
  const reopenedChat = await f.openChat()
  await settle(60)
  const reopenedSelect = reopenedChat.querySelector('[data-chat-chip="account-retry"]')
  assert.equal(reopenedSelect.value, 'off', 'the explicit Off override survives a view and coordinator re-register')
  const reopenedRecord = await f.record()
  assert.equal(reopenedRecord.retryPolicy?.enabled, false, 'the reopened record retains the explicit Off override')
  assert.equal(reopenedRecord.retryPolicy?.startOptions?.roleBinding?.agentId, f.nodeId,
    'hydration custody keeps the exact role binding needed for this policy')

  f.world.bridge.start = async request => {
    f.calls.starts.push(request)
    return { ok: false, code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy: 'provider', reason: 'fixture limit',
      startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
  }
  reopenedChat.openActions()
  const resume = [...reopenedChat.querySelectorAll('.chat-actions-row')].find(row => /Resume/.test(row.textContent || ''))
  assert.ok(resume, 'the actual mounted Actions menu exposes Resume for the saved session')
  assert.match(resume.textContent || '', /Resume/)
  assert.equal(resume.disabled, false, 'the actual mounted Resume action is enabled for the saved session')
  await settle(100)
  resume.dispatch('click')
  await settle(80)
  assert.equal(f.calls.starts.length, 1, 'the real Resume refusal was attempted once')
  assert.equal(f.calls.starts.some(request => request.continueFromAccount), false,
    'an explicit Off policy refuses the alternate-account handoff on Resume')
})

test('a Resume refusal rechecks an Off choice made while global consent is being read', async t => {
  const f = await retryWorld(t)
  const accountReads = installFixtureAccounts(t, { autoRecoverOnLimit: true })
  seedTranscript(f)
  await seedEnabledSessionPolicy(f)
  await f.mount({ fresh: true })
  await settle(100)
  const reopenedChat = await f.openChat()
  await settle(100)
  const select = reopenedChat.querySelector('[data-chat-chip="account-retry"]')
  assert.equal(select?.value, 'keep')
  f.world.bridge.start = async request => {
    f.calls.starts.push(request)
    return { ok: false, code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy: 'provider', reason: 'fixture limit',
      startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
  }
  reopenedChat.openActions()
  const resume = [...reopenedChat.querySelectorAll('.chat-actions-row')].find(row => /Resume/.test(row.textContent || ''))
  assert.ok(resume && !resume.disabled)
  const before = accountReads()
  const gate = accountReads.deferNext()
  resume.dispatch('click')
  for (let attempt = 0; attempt < 400 && !gate.started; attempt += 1) await settle(1)
  assert.equal(gate.started, true, 'the real refusal route reached its deferred Accounts consent read')
  assert.ok(accountReads() > before)
  const liveChat = f.view.el.querySelector('[data-rail-chat-host] .chat')
  const liveSelect = liveChat?.querySelector('[data-chat-chip="account-retry"]')
  assert.ok(liveSelect, 'the mounted chip remains present while the refusal read is deferred')
  liveSelect.value = 'off'
  liveSelect.dispatchEvent({ type: 'change' })
  await settle(80)
  assert.equal((await f.record()).retryPolicy?.enabled, false)
  gate.resolve({ ok: true, accounts: [{ name: 'fixture-codex', provider: 'codex', signedIn: 'yes' }], policy: { autoRecoverOnLimit: true } })
  await settle(120)
  assert.equal(f.calls.starts.length, 1, 'the in-flight consent cannot launch an alternate account after Off')
  assert.equal(f.calls.starts.some(request => request.continueFromAccount), false)
})

test('the mounted chip tracks Accounts policy invalidation and holds on read refusal', async t => {
  const f = await retryWorld(t)
  const accountReads = installFixtureAccounts(t, { autoRecoverOnLimit: true })
  const chat = await f.openChat()
  await settle(60)
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  assert.equal(select.value, 'keep')

  const globalToggle = f.view.el.querySelector('[data-acct="auto-recover"]')
  assert.ok(globalToggle, 'the mounted Accounts menu exposes the global continuation policy')
  globalToggle.checked = false
  globalToggle.dispatchEvent({ type: 'change' })
  await settle(100)
  assert.equal(select.value, 'off', 'a completed Accounts policy change invalidates the inherited chip')
  assert.match(chat.querySelector('[data-chat-chip="account-retry-status"]')?.textContent || '', /Accounts menu stops/)

  globalToggle.checked = true
  globalToggle.dispatchEvent({ type: 'change' })
  await settle(100)
  assert.equal(select.value, 'keep', 'the same invalidation boundary refreshes a policy turned back on')
  assert.ok(accountReads() > 0)

  accountReads.setAvailable(false)
  globalToggle.checked = false
  globalToggle.dispatchEvent({ type: 'change' })
  await settle(100)
  assert.equal(select.value, 'off', 'an unreadable Accounts policy cannot leave a stale inherited Keep state')
  assert.match(chat.querySelector('[data-chat-chip="account-retry-status"]')?.textContent || '', /could not be read/)
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
