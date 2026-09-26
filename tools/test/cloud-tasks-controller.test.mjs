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

test('an incomplete empty environment reading is not presented as proof that none exist', () => {
  const message = environmentsMessage({ loaded: true, environments: [], complete: false })

  assert.ok(
    message.tone === 'refused'
      && /could not be (?:asked|read)/i.test(message.text)
      && /not proof/i.test(message.text),
    'an incomplete empty reading must disclose the failure and deny that absence was proved',
  )
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
