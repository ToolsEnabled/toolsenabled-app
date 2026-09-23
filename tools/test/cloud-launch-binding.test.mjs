/* The rules that stop a Codex Cloud launch, and the ones that follow it.
 *
 * Every test here is an ABSENCE test, because absence is what this feature gets
 * wrong when it gets it wrong: an environment list that was never read, an
 * environment missing from a list that could not be completed, an environment
 * with no readable repository, a branch nobody supplied. Each of those must
 * refuse and must post NOTHING -- a launch is real, billable and uncancellable,
 * so "we could not check" may never resolve to "go ahead".
 *
 * The watch half is here for the mirror of the same rule: UNKNOWN must not end
 * the watch (the capability layer says UNKNOWN for a task its bounded search
 * did not reach), and the watch must end on its own budget rather than run
 * forever.
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

class MemoryStorage {
  #values = new Map()
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
  globalThis.window = { dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail } }
})

const { createCloudTaskController, TERMINAL_CLOUD_STATES } = await import('../../src/cloud-tasks-controller.js')

const READY = Object.freeze({ ok: true, code: null, note: 'Codex Cloud ready.' })
const ENVIRONMENT = 'a'.repeat(32)
const OTHER_ENVIRONMENT = 'b'.repeat(32)

function bound(overrides = {}) {
  return {
    environmentId: ENVIRONMENT,
    label: 'Owner/repo',
    repository: 'Owner/repo',
    repositories: ['Owner/repo'],
    defaultBranch: 'main',
    visibility: 'private',
    launchable: true,
    reason: null,
    accounts: ['first'],
    ...overrides,
  }
}

function accountsReply({ environments = [bound()], complete = true } = {}) {
  return {
    ok: true,
    receipt: {
      action: 'cloud-accounts',
      accounts: [{ name: 'first', role: 'work', canServe: true, usedPercent: 4 }],
      defaultAccount: 'first',
      environments,
      environmentsComplete: complete,
      environmentsReadAt: '2026-08-11T00:00:00.000Z',
    },
  }
}

/* A recorder that FAILS the test if the launch action is ever reached, so a
   refusal that still posted would be caught rather than passing on its message
   alone. */
function recorder(replies = {}) {
  const calls = []
  return {
    calls,
    async postAction(action, body) {
      calls.push({ action, body })
      const reply = replies[action]
      if (typeof reply === 'function') return reply(body, calls.length)
      return reply || { ok: false, code: 'NO_REPLY', reason: `no stub for ${action}` }
    },
  }
}

function manualTimers() {
  let next = 1
  const queue = new Map()
  return {
    timers: {
      setTimeout(callback, ms) { const id = next++; queue.set(id, { callback, ms }); return id },
      clearTimeout(id) { queue.delete(id) },
    },
    pending: () => queue.size,
    async fire() {
      const [id, entry] = [...queue.entries()][0] || []
      if (id === undefined) throw new Error('no timer scheduled')
      queue.delete(id)
      await entry.callback()
    },
  }
}

test('a launch is refused when the authorized environments have never been read', async () => {
  const io = recorder()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  controller.arm({ environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  assert.equal(controller.isArmed(), false)
  assert.equal(controller.getState().launchTone, 'refused')
  assert.match(controller.getState().launchMessage, /have not been read yet/)
  assert.deepEqual(io.calls, [], 'nothing may be posted when the binding is unknown')
})

test('an environment missing from an INCOMPLETE reading is unproven, not unauthorized', async () => {
  const io = recorder({ 'cloud-accounts': accountsReply({ environments: [bound()], complete: false }) })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  controller.arm({ environment: OTHER_ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  assert.equal(controller.isArmed(), false)
  assert.match(controller.getState().launchMessage, /reading was incomplete/)
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
})

test('an environment missing from a COMPLETE reading is refused as unauthorized', async () => {
  const io = recorder({ 'cloud-accounts': accountsReply({ complete: true }) })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  controller.arm({ environment: OTHER_ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  assert.match(controller.getState().launchMessage, /not one the configured accounts are authorized for/)
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
})

test('an environment with no single source repository cannot be launched into', async () => {
  const io = recorder({
    'cloud-accounts': accountsReply({
      environments: [bound({ repository: null, launchable: false, reason: 'This environment is bound to 2 repositories, so which one a task would land in cannot be established here.' })],
    }),
  })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  controller.arm({ environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  assert.match(controller.getState().launchMessage, /bound to 2 repositories/)
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
})

test('a blank branch refuses instead of defaulting to one nobody chose', async () => {
  const io = recorder({ 'cloud-accounts': accountsReply() })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  for (const branch of ['', '   ', undefined]) {
    controller.arm({ environment: ENVIRONMENT, branch, prompt: 'read the readme' })
    assert.equal(controller.isArmed(), false, `branch ${JSON.stringify(branch)} must not arm`)
    assert.equal(controller.getState().launchTone, 'refused')
    assert.match(controller.getState().launchMessage, /branch is required/)
  }
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
})

test('an armed launch declares the repository the discovered environment is bound to', async () => {
  const io = recorder({
    'cloud-accounts': accountsReply(),
    'cloud-tasks': { ok: true, receipt: { action: 'cloud-tasks', tasks: [], account: { name: 'first' } } },
    'cloud-launch': {
      ok: true,
      receipt: {
        action: 'cloud-launch',
        launched: true,
        state: 'SUBMITTED',
        taskId: 'task_e_0123456789',
        taskUrl: 'https://example.invalid/task_e_0123456789',
        environment: ENVIRONMENT,
        environmentLabel: 'Owner/repo',
        repository: 'Owner/repo',
        declaredRepository: 'Owner/repo',
        branch: 'main',
        account: { name: 'first', role: 'work', usedPercent: 4 },
        accountsConsidered: ['first'],
        submittedAt: '2026-08-11T00:00:01.000Z',
        bindingReadAt: '2026-08-11T00:00:00.000Z',
        approvalRequired: true,
      },
    },
  })
  const clock = manualTimers()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY, timers: clock.timers })
  await controller.loadAccounts()

  controller.arm({ environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  assert.equal(controller.isArmed(), true)
  assert.match(controller.getState().launchMessage, /in Owner\/repo on branch main/)
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0, 'arming may not send')

  await controller.confirm()
  const sent = io.calls.find(call => call.action === 'cloud-launch')
  assert.ok(sent, 'the confirming call sends the launch')
  assert.equal(sent.body.repository, 'Owner/repo')
  assert.equal(sent.body.confirmed, true)
  assert.equal(sent.body.environment, ENVIRONMENT)

  const receipt = controller.getState().receipt
  assert.ok(Object.isFrozen(receipt), 'the receipt is immutable')
  assert.deepEqual(
    {
      taskId: receipt.taskId,
      environment: receipt.environment,
      repository: receipt.repository,
      branch: receipt.branch,
      state: receipt.state,
    },
    {
      taskId: 'task_e_0123456789',
      environment: ENVIRONMENT,
      repository: 'Owner/repo',
      branch: 'main',
      state: 'SUBMITTED',
    },
  )
  assert.equal(clock.pending(), 1, 'a successful launch starts watching the task')
})

test('a launch the provider did not confirm leaves no receipt and starts no watch', async () => {
  const io = recorder({
    'cloud-accounts': accountsReply(),
    'cloud-launch': { ok: true, receipt: { action: 'cloud-launch', launched: false, state: 'UNKNOWN', taskId: null, message: 'the CLI confirmed nothing' } },
  })
  const clock = manualTimers()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY, timers: clock.timers })
  await controller.loadAccounts()
  controller.arm({ environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  await controller.confirm()
  assert.equal(controller.getState().receipt, null)
  assert.equal(clock.pending(), 0)
  assert.match(controller.getState().launchMessage, /may or may not have been created/)
})

test('the watch keeps checking through UNKNOWN and stops on a terminal state', async () => {
  const answers = [
    { ok: true, receipt: { action: 'cloud-task-status', taskId: 'task_e_1', found: false, state: 'UNKNOWN', providerStatus: null } },
    { ok: true, receipt: { action: 'cloud-task-status', taskId: 'task_e_1', found: true, state: 'RUNNING', providerStatus: 'in_progress' } },
    { ok: true, receipt: { action: 'cloud-task-status', taskId: 'task_e_1', found: true, state: 'SUCCEEDED', providerStatus: 'ready' } },
  ]
  let at = 0
  const io = recorder({ 'cloud-task-status': () => answers[Math.min(at++, answers.length - 1)] })
  const clock = manualTimers()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY, timers: clock.timers })

  controller.watch('task_e_1', { environment: ENVIRONMENT })
  assert.equal(clock.pending(), 1)

  await clock.fire()
  assert.match(controller.getState().watchMessage, /not in the searched window/)
  assert.equal(clock.pending(), 1, 'UNKNOWN must not end the watch')

  await clock.fire()
  assert.match(controller.getState().watchMessage, /running/)
  assert.equal(clock.pending(), 1)

  await clock.fire()
  assert.match(controller.getState().watchMessage, /finished/)
  assert.equal(clock.pending(), 0, 'a terminal state ends the watch')
  assert.equal(io.calls.length, 3)
})

test('the watch is bounded and says the task may still be running when it stops', async () => {
  const io = recorder({ 'cloud-task-status': { ok: true, receipt: { action: 'cloud-task-status', taskId: 'task_e_2', found: true, state: 'RUNNING', providerStatus: 'in_progress' } } })
  const clock = manualTimers()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY, timers: clock.timers, watchMaxChecks: 3 })
  controller.watch('task_e_2')
  for (let check = 0; check < 3; check += 1) await clock.fire()
  assert.equal(clock.pending(), 0)
  assert.equal(io.calls.length, 3)
  assert.match(controller.getState().watchMessage, /stopped watching after 3 checks; the task may still be running/)
})

test('a failed status READING is not reported as a failed task, and the watch continues', async () => {
  const io = recorder({ 'cloud-task-status': { ok: false, code: 'BRIDGE_TIMEOUT', reason: 'action bridge timed out' } })
  const clock = manualTimers()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY, timers: clock.timers })
  controller.watch('task_e_3')
  await clock.fire()
  assert.match(controller.getState().watchMessage, /Could not read the status/)
  assert.match(controller.getState().watchMessage, /The task itself is unaffected/)
  assert.equal(clock.pending(), 1)
})

test('a refused account read leaves the environment list unloaded rather than empty', async () => {
  const io = recorder({ 'cloud-accounts': { ok: false, code: 'BRIDGE_GUARD_REFUSED', reason: 'the local policy refused the action' } })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  const state = controller.getState()
  assert.equal(state.environmentsLoaded, false)
  assert.deepEqual([...state.environments], [])
  assert.match(state.environmentsMessage, /Your Codex accounts could not be read/)
  assert.equal(state.accountsPhase, 'refused')
  /* ONE CONDITION, ONE PARAGRAPH. This refusal used to be published into the
     task-list line AS WELL, in near-identical words, and the panel drew both --
     the two 47-word paragraphs the owner could make no meaning of. The task
     list line is now SILENT, because the line above has already said it. */
  assert.equal(state.listMessage, '')
  assert.equal(state.listCode, null)
  controller.arm({ environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
  assert.equal(controller.isArmed(), false)
})

test('nobody signed in is an empty state with one next action, not a refusal', async () => {
  const io = recorder({
    'cloud-accounts': { ok: true, receipt: { accounts: [], defaultAccount: null, signedIn: false, environments: [], environmentsComplete: true, environmentsReadAt: '2026-08-18T00:00:00.000Z' } },
    'cloud-tasks': { ok: true, receipt: { tasks: [], account: null } },
  })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.refresh()
  const state = controller.getState()
  assert.equal(state.signedIn, false)
  assert.equal(state.accountsPhase, 'none')
  assert.equal(state.environmentsTone, 'note', 'a first run is not a failure and must not be painted as one')
  assert.match(state.environmentsMessage, /No Codex account is set up on this computer yet/)
  /* THE NEXT ACTION IS ONE THE PERSON CAN ACTUALLY TAKE, and that is what
     changed. This used to read "Sign in to Codex Cloud on this computer, then
     press Refresh", which was a dead end wearing an instruction: signing Codex
     in the ordinary way does NOT put an account on this list -- the list is a
     registry the cloud lane reads, and nothing in the product wrote it. Somebody
     who did exactly what it said came back, pressed Refresh, and read the same
     sentence. The panel has an add-an-account control now, and the sentence
     names it. */
  assert.match(state.environmentsMessage, /Add one below/)
  assert.ok(!/Sign in to Codex Cloud on this computer, then press Refresh/.test(state.environmentsMessage),
    `the empty state still sends a person to a sign-in that cannot end it: ${state.environmentsMessage}`)
  /* Said once. Every other slot on the panel is silent about it. */
  assert.equal(state.listMessage, '')
  assert.equal(state.launchMessage, '')
  assert.equal(state.watchMessage, '')
  /* And the task read is never even sent: there is no account to read as, and
     asking anyway is how the second paragraph got there. */
  assert.equal(io.calls.filter(call => call.action === 'cloud-tasks').length, 0)
})

test('the terminal set is exactly the three states that end a task', () => {
  assert.deepEqual([...TERMINAL_CLOUD_STATES], ['SUCCEEDED', 'FAILED', 'CANCELLED'])
})
