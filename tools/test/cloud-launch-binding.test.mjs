/* Person-entered Cloud launch behavior: explicit account, ID validation,
 * confirmation, immutable receipts, real refusals and bounded status watches.
 * Bridge replies are injected; no provider is contacted.
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

const { createCloudTaskController, readRemembered, TERMINAL_CLOUD_STATES } = await import('../../src/cloud-tasks-controller.js')

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

test('a valid person-entered ID can arm without a discovered environment list', () => {
  const io = recorder()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch: 'topic', prompt: 'read the readme', account: 'first' })
  assert.equal(controller.isArmed(), true)
  assert.match(controller.getState().launchMessage, /provider has not confirmed its repository binding/i)
  assert.match(controller.getState().launchMessage, /ToolsEnabled cannot confirm that this environment points at Owner\/repo/)
  assert.deepEqual(io.calls, [], 'arming never posts a launch')
})

test('unavailable and stale catalog readings do not turn a typed ID into provider confirmation', async () => {
  for (const reading of [
    accountsReply({ environments: [], complete: false }),
    accountsReply({ complete: true }),
    accountsReply({ environments: [bound({ repository: null, launchable: false })] }),
  ]) {
    const io = recorder({ 'cloud-accounts': reading })
    const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
    await controller.loadAccounts()
    controller.arm({ repository: 'Owner/repo', environment: OTHER_ENVIRONMENT, branch: 'topic', prompt: 'read the readme', account: 'first' })
    assert.equal(controller.isArmed(), true)
    assert.match(controller.getState().launchMessage, /provider has not confirmed/i)
    assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
  }
})

test('a missing account refuses before confirmation or posting, even if an account default exists', async () => {
  const io = recorder({ 'cloud-accounts': accountsReply() })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  for (const account of [undefined, null, '', '   ']) {
    controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch: 'topic', prompt: 'read the readme', account })
    await controller.confirm()
    assert.equal(controller.isArmed(), false)
    assert.match(controller.getState().launchMessage, /Choose a Codex account/)
  }
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
})

test('invalid IDs refuse and valid 32-character lowercase hex IDs keep their value', () => {
  const io = recorder()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  for (const environment of ['', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 'A'.repeat(32)]) {
    controller.arm({ repository: 'Owner/repo', environment, branch: 'topic', prompt: 'read the readme', account: 'first' })
    assert.equal(controller.isArmed(), false)
    assert.match(controller.getState().launchMessage, /exactly 32 characters/)
  }
  controller.arm({ repository: 'Owner/repo', environment: ' 0123456789abcdef0123456789abcdef ', branch: 'topic', prompt: 'read the readme', account: 'first' })
  assert.equal(controller.isArmed(), true)
  assert.match(controller.getState().launchMessage, /0123456789abcdef0123456789abcdef/)
  assert.deepEqual(io.calls, [])
})

test('a blank branch refuses instead of defaulting to one nobody chose', async () => {
  const io = recorder({ 'cloud-accounts': accountsReply() })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.loadAccounts()
  for (const branch of ['', '   ', undefined]) {
    controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch, prompt: 'read the readme', account: 'first' })
    assert.equal(controller.isArmed(), false, `branch ${JSON.stringify(branch)} must not arm`)
    assert.equal(controller.getState().launchTone, 'refused')
    assert.match(controller.getState().launchMessage, /branch is required/)
  }
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
})

test('a confirmed launch forwards the typed ID, provenance and chosen account and freezes the receipt', async () => {
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
        repositoryBinding: {
          source: 'person-entered',
          confirmation: 'unconfirmed',
          providerConfirmed: false,
          message: 'The environment ID was entered by the person. The provider has not confirmed its repository binding.',
        },
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

  controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme', account: 'first' })
  assert.equal(controller.isArmed(), true)
  assert.match(controller.getState().launchMessage, /on branch main/)
  assert.match(controller.getState().launchMessage, /provider has not confirmed/)
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0, 'arming may not send')

  await controller.confirm()
  const sent = io.calls.find(call => call.action === 'cloud-launch')
  assert.ok(sent, 'the confirming call sends the launch')
  assert.equal(sent.body.environmentSource, 'person-entered')
  assert.equal(sent.body.account, 'first')
  assert.equal(sent.body.repository, 'Owner/repo')
  assert.match(controller.getState().launchMessage, /provider has not confirmed/)
  assert.equal(sent.body.confirmed, true)
  assert.equal(sent.body.environment, ENVIRONMENT)

  const receipt = controller.getState().receipt
  assert.ok(Object.isFrozen(receipt), 'the receipt is immutable')
  assert.ok(Object.isFrozen(receipt.repositoryBinding))
  assert.equal(receipt.repositoryBinding.providerConfirmed, false)
  assert.match(controller.getState().launchMessage, /provider has not confirmed/)
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
  assert.equal(io.calls.find(call => call.action === 'cloud-tasks').body.account, 'first')
  controller.destroy()
})

test('a launch the provider did not confirm leaves no receipt and starts no watch', async () => {
  const io = recorder({
    'cloud-accounts': accountsReply(),
    'cloud-launch': { ok: true, receipt: { action: 'cloud-launch', launched: false, state: 'UNKNOWN', taskId: null, message: 'the CLI confirmed nothing', repositoryBinding: { message: 'Provider binding remains unconfirmed for this entered ID.' } } },
  })
  const clock = manualTimers()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY, timers: clock.timers })
  await controller.loadAccounts()
  controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme', account: 'first' })
  await controller.confirm()
  assert.equal(controller.getState().receipt, null)
  assert.equal(clock.pending(), 0)
  assert.match(controller.getState().launchMessage, /may or may not have been created/)
  assert.match(controller.getState().launchMessage, /Provider binding remains unconfirmed for this entered ID/)
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
  controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch: 'main', prompt: 'read the readme' })
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

test('the first click captures the account, ID and branch that confirmation sends', async () => {
  const io = recorder({ 'cloud-launch': { ok: false, code: 'BRIDGE_GUARD_REFUSED', reason: 'Approval was refused.' } })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  await controller.click({ repository: 'Person/declared', environment: ENVIRONMENT, branch: 'topic', prompt: 'original task', account: 'first' })
  await controller.click({ repository: 'Other/different', environment: OTHER_ENVIRONMENT, branch: 'other', prompt: 'changed task', account: 'second' })
  assert.deepEqual(io.calls, [{ action: 'cloud-launch', body: {
    environment: ENVIRONMENT, environmentSource: 'person-entered', repository: 'Person/declared', branch: 'topic',
    prompt: 'original task', account: 'first', confirmed: true,
  } }])
})

test('provider and bridge refusals stay visible in plain words without a second launch', async () => {
  for (const [code, reason] of [
    ['BRIDGE_CLOUD_REPOSITORY_MISMATCH', 'The environment belongs to a different repository.'],
    ['BRIDGE_CLOUD_ENVIRONMENT_NOT_AUTHORIZED', 'This account cannot use that environment.'],
    ['CLOUD_MIRROR_STALE', 'The mirror needs a fresh publication.'],
    ['CLOUD_ACCOUNT_UNAVAILABLE', 'The chosen account is unavailable.'],
    ['BRIDGE_GUARD_REFUSED', 'Approval was refused.'],
  ]) {
    const io = recorder({ 'cloud-launch': { ok: false, code, reason } })
    const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
    controller.arm({ repository: 'Owner/repo', environment: ENVIRONMENT, branch: 'topic', prompt: 'read the readme', account: 'first' })
    await controller.confirm()
    assert.equal(controller.getState().launchTone, 'refused')
    assert.equal(controller.getState().launchCode, code)
    assert.ok(controller.getState().launchMessage.includes(reason), 'the actual refusal remains visible')
    assert.match(controller.getState().launchMessage, /Refresh the task list/)
    assert.doesNotMatch(controller.getState().launchMessage, new RegExp(code))
    assert.equal(io.calls.length, 1)
  }
})

test('a missing or malformed repository refuses before confirmation or posting', async () => {
  const io = recorder()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  for (const repository of [undefined, null, '', 'owner', 'owner/repo/extra', 'owner/re po', 'owner/\nrepo', 'https://github.com/owner/repo', 'x'.repeat(101) + '/repo']) {
    controller.arm({ environment: ENVIRONMENT, repository, branch: 'topic', prompt: 'read the readme', account: 'first' })
    await controller.confirm()
    assert.equal(controller.isArmed(), false)
    assert.match(controller.getState().launchMessage, /repository as owner\/name/)
    assert.equal(controller.getState().launchTone, 'refused')
  }
  assert.deepEqual(io.calls, [], 'invalid declarations never post')
})

test('the declared repository, environment and branch are remembered together', () => {
  const io = recorder()
  const controller = createCloudTaskController({ postAction: io.postAction, availability: READY })
  controller.arm({ environment: ENVIRONMENT, repository: ' Person/chosen-repository ', branch: 'topic', prompt: 'read the readme', account: 'first' })
  assert.equal(controller.isArmed(), true)
  assert.deepEqual(readRemembered(), { environment: ENVIRONMENT, repository: 'Person/chosen-repository', branch: 'topic' })
  controller.arm({ environment: OTHER_ENVIRONMENT, repository: '', branch: 'other', prompt: 'read the readme', account: 'first' })
  assert.deepEqual(readRemembered(), { environment: ENVIRONMENT, repository: 'Person/chosen-repository', branch: 'topic' }, 'a refused request does not overwrite the valid declaration')
})

test('legacy saved values leave the repository blank and malformed saved repositories are not offered', () => {
  for (const repository of [undefined, 'owner/repo/extra', 'owner/\nrepo']) {
    localStorage.setItem('mc.cloud.last', JSON.stringify({ environment: ENVIRONMENT, repository, branch: 'saved-topic' }))
    assert.deepEqual(readRemembered(), { environment: ENVIRONMENT, repository: '', branch: 'saved-topic' })
  }
})
