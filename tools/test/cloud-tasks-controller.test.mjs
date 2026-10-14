/* The controller is deliberately the DOM-free half of the cloud-task surface.
 * These tests exercise the answers the surface renders and the read-failure
 * distinction that prevents missing provider data from becoming a reassuring
 * answer. */
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
  globalThis.CustomEvent = class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail }
  }
})

const {
  cloudStateView,
  createCloudTaskController,
  diffAnswer,
  environmentsMessage,
} = await import('../../src/cloud-tasks-controller.js')

const READY = Object.freeze({ ok: true, code: null, note: 'Codex Cloud ready.' })

test('an unfamiliar provider state remains unknown rather than looking finished', () => {
  const view = cloudStateView('WAITING_FOR_CAPACITY')

  assert.ok(
    view.tone === 'unknown' && /unknown/i.test(view.label),
    'an unfamiliar state must look and read as unknown',
  )
})

test('environment discovery is unavailable, including an empty complete reading', () => {
  for (const complete of [true, false]) {
    const message = environmentsMessage({ loaded: true, environments: [], complete })
    assert.match(message.text, /discovery is unavailable/)
    assert.match(message.text, /Use the environment ID/)
    assert.doesNotMatch(message.text, /none exist|No Codex Cloud environment is authorized/)
  }
})

test('a successful diff reply with no diff is refused rather than reported as no changes', async () => {
  const calls = []
  const controller = createCloudTaskController({
    availability: READY,
    postAction: async (action, body) => {
      calls.push({ action, body })
      return { ok: true, receipt: { changedNothing: true, bytes: 0 } }
    },
  })

  const state = await controller.readDiff('task-real-caller', { account: 'work' })

  assert.ok(
    calls.length === 1
      && calls[0].action === 'cloud-task-diff'
      && calls[0].body.taskId === 'task-real-caller'
      && calls[0].body.account === 'work'
      && state.diffPhase === 'refused'
      && state.diffChangedNothing === false
      && /did not come back|nothing was read/i.test(state.diffMessage),
    'a caller-scoped reply without a diff must remain an explained refusal, never changed-nothing',
  )
})

test('a truncated diff is unmistakably partial and never claims to apply changes', () => {
  const answer = diffAnswer({ diff: 'partial patch', bytes: 50_000, truncated: true })

  assert.ok(
    answer.tone === 'partial'
      && /part|more|rest/i.test(answer.message)
      && /not the whole|too big to show whole/i.test(answer.message)
      && !/(?:has been|was|will be) applied/i.test(answer.message),
    'a truncated read must disclose that more exists, warn it is incomplete, and never claim application',
  )
})


function chosenAccountFixture(t, { nativeRoute = false, accounts = [{ name: 'chosen', canServe: true }, { name: 'other', canServe: true }], defaultAccount = 'other' } = {}) {
  const calls = []
  const environment = 'a'.repeat(32)
  const controller = createCloudTaskController({
    availability: READY,
    postAction: async (action, body) => {
      calls.push({ action, body })
      if (action === 'cloud-accounts') return { ok: true, receipt: { accounts, defaultAccount, nativeRoute,
        environments: [{ environmentId: environment, repository: 'owner/review', accounts: accounts.map(row => row.name) }],
        environmentsComplete: true, signedIn: true } }
      return { ok: false, code: 'AGENT_RESUME_ACCOUNT_LIMIT', reason: 'This account reached its limit.' }
    },
  })
  t.after(() => controller.destroy())
  return { controller, calls, request: { environment, repository: 'owner/review', branch: 'review', prompt: 'Review the requested change.' } }
}

test('Cloud launch requires the person to choose an account even when another is the saved default', async t => {
  const f = chosenAccountFixture(t)
  await f.controller.loadAccounts()
  f.controller.arm(f.request)
  await f.controller.confirm()
  assert.equal(f.controller.isArmed(), false)
  assert.match(f.controller.getState().launchMessage, /Choose .*account/)
  assert.equal(f.calls.filter(row => row.action === 'cloud-launch').length, 0)
})

test('Cloud confirmation sends the captured selected account once and never substitutes after a limit', async t => {
  const f = chosenAccountFixture(t)
  await f.controller.loadAccounts()
  const input = { ...f.request, account: 'chosen' }
  f.controller.arm(input)
  input.account = 'other'
  await f.controller.confirm()
  await f.controller.confirm()
  const launches = f.calls.filter(row => row.action === 'cloud-launch')
  assert.equal(launches.length, 1)
  assert.equal(launches[0].body.account, 'chosen')
  assert.equal(f.controller.getState().launchTone, 'refused')
})

test('Cloud native-route metadata never bypasses the explicit account choice', async t => {
  const f = chosenAccountFixture(t, { nativeRoute: true, accounts: [], defaultAccount: null })
  await f.controller.loadAccounts()
  f.controller.arm(f.request)
  assert.equal(f.controller.isArmed(), false)
  await f.controller.confirm()
  assert.equal(f.calls.filter(row => row.action === 'cloud-launch').length, 0)
  assert.match(f.controller.getState().launchMessage, /Choose .*account/)
  const named = chosenAccountFixture(t, { nativeRoute: true })
  await named.controller.loadAccounts()
  named.controller.arm(named.request)
  await named.controller.confirm()
  assert.equal(named.calls.filter(row => row.action === 'cloud-launch').length, 0)
})
