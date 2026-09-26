/* GETTING A CLOUD TASK'S WORK BACK, PROVEN WITHOUT SPENDING ANYTHING.
 *
 * A person launches a cloud task, pays a provider for it, and gets a task id.
 * The product could say the task FINISHED and could not say what it did. This
 * suite holds the rules of the control that closes that gap, and every one of
 * them is about a reply being read as the wrong thing:
 *
 *   - an empty diff read as "the reading failed", when it means the task
 *     changed no files;
 *   - a MISSING diff field read as "the task changed no files", which is the
 *     same absence-as-answer defect wearing the opposite hat;
 *   - a truncated diff read as a whole one, which is the expensive one: a half
 *     diff applies cleanly and silently drops the rest of the work;
 *   - a task another account created read as a task that no longer exists,
 *     which is how somebody relaunches work that has already run and pays for
 *     it twice.
 *
 * NOTHING HERE CONTACTS A PROVIDER. Every reply is injected. A suite that made
 * one real call would spend real money to assert a sentence.
 *
 * WHAT IT CANNOT SEE, said plainly: it does not mount the panel, so it cannot
 * prove the button is on the glass. src/cloud-tasks.js imports a stylesheet and
 * a plain `node --test` run cannot load one -- the same split the launch suite
 * lives with. The two source assertions at the end are the narrow, honest
 * substitute: they prove the surface calls the rules this file exercises.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { findingsInText } from '../check-plain-language.mjs'
import { visibleTextFrom } from '../lib/user-visible-strings.mjs'

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

const {
  createCloudTaskController,
  diffAnswer,
  diffRefusalMessage,
  diffSize,
  offersDiff,
} = await import('../../src/cloud-tasks-controller.js')

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const READY = Object.freeze({ ok: true, code: null, note: 'Codex Cloud ready.' })
const SWITCHED_OFF = Object.freeze({ ok: false, code: 'CLOUD_LAUNCH_SWITCHED_OFF', note: 'Launching is switched off.' })
const TASK = 'task_e_0123456789'
const DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n'

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

function finished(overrides = {}) {
  return { taskId: TASK, title: 'read the readme', state: 'SUCCEEDED', providerStatus: 'ready', ...overrides }
}

function ready(io) {
  return createCloudTaskController({ postAction: io.postAction, availability: READY })
}

/* Every reply below is the shape capability/src/lib/cloud-agent/codex-cloud-launch.js
   returns from cloudTaskDiff: a diff, its TRUE byte count, and the two flags
   that make an empty or a clipped answer legible. */
function diffReply(overrides = {}) {
  return {
    ok: true,
    receipt: {
      action: 'cloud-task-diff',
      taskId: TASK,
      diff: DIFF,
      bytes: DIFF.length,
      truncated: false,
      changedNothing: false,
      taskUrl: `https://example.invalid/${TASK}`,
      account: { name: 'first', role: 'work', usedPercent: 4 },
      ...overrides,
    },
  }
}

test('only a finished task offers its work, because only a finished task has any', () => {
  assert.equal(offersDiff(finished()), true)
  for (const state of ['SUBMITTED', 'RUNNING', 'FAILED', 'CANCELLED', 'UNKNOWN']) {
    assert.equal(offersDiff(finished({ state })), false, `${state} has nothing to fetch`)
  }
  assert.equal(offersDiff(finished({ taskId: '' })), false, 'a task with no id cannot be asked for')
  assert.equal(offersDiff(null), false)
  assert.equal(offersDiff('SUCCEEDED'), false)
})

test('a diff that comes back is called a diff, and is stated to be a copy', async () => {
  const io = recorder({ 'cloud-task-diff': diffReply() })
  const controller = ready(io)
  await controller.readDiff(TASK, { account: 'first' })
  const state = controller.getState()

  assert.deepEqual(io.calls, [{ action: 'cloud-task-diff', body: { taskId: TASK, account: 'first' } }])
  assert.equal(state.diffPhase, 'answered')
  assert.equal(state.diffTone, 'confirmed')
  assert.equal(state.diffText, DIFF)
  assert.equal(state.diffTaskId, TASK)
  assert.equal(state.diffCode, null)
  assert.match(state.diffMessage, /as a diff/)
  assert.match(state.diffMessage, /Nothing has been applied to your computer/)
  assert.match(state.diffMessage, /Read as first\./)
  /* The four words the provider cannot back up. */
  assert.doesNotMatch(state.diffMessage, /\b(results|output|logs|artifacts)\b/i)
})

test('retrieval posts one read and never a write', async () => {
  const io = recorder({ 'cloud-task-diff': diffReply() })
  const controller = ready(io)
  await controller.readDiff(TASK)
  await controller.readDiff(TASK)
  assert.equal(io.calls.length, 2)
  assert.ok(io.calls.every(call => call.action === 'cloud-task-diff'), 'nothing else may be posted')
  assert.equal(io.calls.filter(call => call.action === 'cloud-launch').length, 0)
  /* No account was known, so none is claimed. */
  assert.deepEqual(io.calls[0].body, { taskId: TASK })
})

test('a task that changed no files is an answer, not a fault', async () => {
  const io = recorder({ 'cloud-task-diff': diffReply({ diff: '', bytes: 0, changedNothing: true }) })
  const controller = ready(io)
  await controller.readDiff(TASK, { account: 'first' })
  const state = controller.getState()

  assert.equal(state.diffPhase, 'answered')
  assert.equal(state.diffChangedNothing, true)
  assert.equal(state.diffText, '')
  assert.notEqual(state.diffTone, 'refused', 'an empty diff must not be painted as a refusal')
  assert.match(state.diffMessage, /changed no files/)
  assert.match(state.diffMessage, /normal answer/)
  assert.match(state.diffMessage, /Open the task on Codex Cloud/)
  assert.doesNotMatch(state.diffMessage, /\b(error|failed|failure|invalid|refused)\b/i)
})

test('a truncated diff reports the TRUE size and says what is on screen is a part', async () => {
  const clipped = 'x'.repeat(2048)
  const io = recorder({ 'cloud-task-diff': diffReply({ diff: clipped, bytes: 7_400_000, truncated: true }) })
  const controller = ready(io)
  await controller.readDiff(TASK)
  const state = controller.getState()

  assert.equal(state.diffTruncated, true)
  assert.equal(state.diffBytes, 7_400_000)
  assert.equal(state.diffText, clipped)
  assert.equal(state.diffTone, 'partial', 'a part is neither a clean answer nor a refusal')
  assert.match(state.diffMessage, /too big to show whole/)
  assert.match(state.diffMessage, /first 2 KB of 7\.1 MB/)
  assert.match(state.diffMessage, /Treat this as a part, not the whole change/)
})

test('a clipped diff is still called clipped when its true size did not arrive', () => {
  const answer = diffAnswer({ diff: 'x'.repeat(64), bytes: null, truncated: true })
  assert.equal(answer.truncated, true)
  assert.equal(answer.tone, 'partial')
  assert.match(answer.message, /too big to show whole/)
  assert.match(answer.message, /and there is more/)
  assert.match(answer.message, /not the whole change/)
  assert.deepEqual(findingsInText(answer.message), [])
  const nothingMeasured = diffAnswer({ diff: '', bytes: null, truncated: true })
  assert.match(nothingMeasured.message, /You are seeing part of it\./)
  assert.deepEqual(findingsInText(nothingMeasured.message), [])
})

test('a task another account made is explained as an account rule, not as a task that is gone', async () => {
  const io = recorder({
    'cloud-task-diff': { ok: false, code: 'CLOUD_DIFF_FAILED', reason: 'The audited dependency refused the action.' },
  })
  const controller = ready(io)
  await controller.readDiff(TASK, { account: 'first' })
  const state = controller.getState()

  assert.equal(state.diffPhase, 'refused')
  assert.equal(state.diffTone, 'refused')
  assert.equal(state.diffText, '')
  assert.equal(state.diffCode, 'CLOUD_DIFF_FAILED', 'the identifier is carried for support, not shown')
  assert.doesNotMatch(state.diffMessage, /CLOUD_DIFF_FAILED/)
  assert.match(state.diffMessage, /only be read by the account that started it/)
  assert.match(state.diffMessage, /This read used first\./)
  assert.match(state.diffMessage, /ask them for its diff/)
  /* The sentence must not invite a second launch of work that already ran. */
  assert.doesNotMatch(state.diffMessage, /launch/i)
})

test('the account rule is stated even when this copy cannot name the account', () => {
  const message = diffRefusalMessage({ ok: false, code: 'CLOUD_DIFF_FAILED', reason: 'The audited dependency refused the action.' })
  assert.match(message, /only be read by the account that started it/)
  assert.doesNotMatch(message, /This read used/)
})

test('a refusal that is not the cloud keeps the product-wide remedy', () => {
  const message = diffRefusalMessage({ ok: false, code: 'BRIDGE_TIMEOUT', reason: 'action bridge timed out' })
  assert.match(message, /Nothing came back in time/)
  assert.doesNotMatch(message, /only be read by the account/)
})

test('a build whose connection has no route for this says so instead of asking for a restart', () => {
  const message = diffRefusalMessage({ ok: false, code: 'BRIDGE_ACTION_UNKNOWN', reason: 'unknown bridge action' })
  assert.match(message, /cannot fetch a cloud task's changes yet/)
  assert.match(message, /Install the newest version/)
  /* The router's own words describe plumbing, not the person's task. */
  assert.doesNotMatch(message, /bridge/i)
})

test('a reply with no diff in it is a refusal, never an empty diff', async () => {
  for (const receipt of [{ action: 'cloud-task-diff', taskId: TASK }, { diff: null }, { diff: 42 }]) {
    const io = recorder({ 'cloud-task-diff': { ok: true, receipt } })
    const controller = ready(io)
    await controller.readDiff(TASK)
    const state = controller.getState()
    assert.equal(state.diffPhase, 'refused', 'a missing diff is an absence, not a task that changed nothing')
    assert.equal(state.diffChangedNothing, false)
    assert.match(state.diffMessage, /The changes did not come back/)
  }
})

test('nothing is asked for while cloud launching is switched off', async () => {
  const io = recorder({ 'cloud-task-diff': diffReply() })
  const controller = createCloudTaskController({ postAction: io.postAction, availability: SWITCHED_OFF })
  await controller.readDiff(TASK)
  assert.deepEqual(io.calls, [], 'a switched-off panel contacts nothing')
  assert.equal(controller.getState().diffTaskId, null)
})

test('an answer for a task the person has moved on from never overwrites the one they are reading', async () => {
  const held = new Map()
  const io = recorder({
    'cloud-task-diff': body => new Promise(resolve => { held.set(body.taskId, resolve) }),
  })
  const controller = ready(io)
  const first = controller.readDiff('task_e_first')
  const second = controller.readDiff('task_e_second')

  held.get('task_e_second')(diffReply({ taskId: 'task_e_second', diff: 'second\n', bytes: 7 }))
  await second
  held.get('task_e_first')(diffReply({ taskId: 'task_e_first', diff: 'first\n', bytes: 6 }))
  await first

  const state = controller.getState()
  assert.equal(state.diffTaskId, 'task_e_second')
  assert.equal(state.diffText, 'second\n')
})

test('a destroyed panel neither paints nor asks', async () => {
  const io = recorder({ 'cloud-task-diff': diffReply() })
  const controller = ready(io)
  controller.destroy()
  await controller.readDiff(TASK)
  assert.deepEqual(io.calls, [])
})

test('a size is a size a person reads, and an unmeasured one is not guessed', () => {
  assert.equal(diffSize(0), '0 bytes')
  assert.equal(diffSize(940), '940 bytes')
  assert.equal(diffSize(12_288), '12 KB')
  assert.equal(diffSize(7_400_000), '7.1 MB')
  for (const value of [null, undefined, -1, Number.NaN, 'big']) {
    assert.equal(diffSize(value), '', 'an unmeasured size is left out rather than invented')
  }
})

/* THE GATE, APPLIED TO THIS CONTROL'S OWN SENTENCES.
 *
 * tools/check-plain-language.mjs holds the whole renderer to a baseline, which
 * means a new finding blocks -- but it blocks at the end of a chain, long after
 * the sentence was written. This asserts the same rules against the four
 * answers this control actually produces, so the wording is proven where it is
 * written rather than where it is shipped. */
test('every sentence this control produces is plain', () => {
  const sentences = [
    diffAnswer({ diff: DIFF, bytes: DIFF.length, truncated: false, changedNothing: false, account: { name: 'first' } }).message,
    diffAnswer({ diff: '', bytes: 0, changedNothing: true, account: { name: 'first' } }).message,
    diffAnswer({ diff: 'x'.repeat(2048), bytes: 7_400_000, truncated: true, account: { name: 'first' } }).message,
    diffRefusalMessage({ ok: false, code: 'CLOUD_DIFF_FAILED', reason: 'The audited dependency refused the action.' }, { account: 'first' }),
    diffRefusalMessage({ ok: false, code: 'CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE', reason: 'The audited dependency refused the action.' }),
    diffRefusalMessage({ ok: false, code: 'BRIDGE_ACTION_UNKNOWN', reason: 'unknown bridge action' }),
  ]
  for (const sentence of sentences) {
    const findings = findingsInText(sentence)
    assert.deepEqual(findings, [], `${JSON.stringify(sentence.slice(0, 90))} -> ${findings.map(finding => finding.rule).join(', ')}`)
  }
})

test('every refusal this control produces still says what to do next', () => {
  for (const code of ['CLOUD_DIFF_FAILED', 'CLOUD_DIFF_ATTEMPT_INVALID', 'CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE', 'BRIDGE_ACTION_UNKNOWN', 'BRIDGE_TIMEOUT', 'BRIDGE_GUARD_REFUSED']) {
    const message = diffRefusalMessage({ ok: false, code, reason: 'The audited dependency refused the action.' }, { account: 'first' })
    /* The verb list is the one tools/check-plain-language.mjs already enforces,
       narrowed to the verbs this control can honestly offer. */
    assert.match(message, /\b(try|open|sign|ask|install|look|check|change|refresh|close)\b/i, `${code} must end with something to do`)
    assert.doesNotMatch(message, /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/, `${code} must not be shown to a person`)
  }
  /* A refusal with nothing in it at all is the case with least to go on. */
  const empty = diffRefusalMessage(undefined)
  assert.match(empty, /The changes did not come back/)
  assert.ok(empty.length > 40, 'an empty refusal still gets a whole sentence')
})

/* ---------------------------------------------------------------- *
 * THE TWO THINGS ONLY THE SOURCE CAN SHOW.
 * ---------------------------------------------------------------- */

test('no control on this surface offers to apply, stage or commit a diff', () => {
  for (const file of ['cloud-tasks.js', 'cloud-tasks-controller.js']) {
    const extracted = visibleTextFrom(readFileSync(path.join(SOURCE_ROOT, file), 'utf8'))
    for (const entry of extracted.visible) {
      assert.doesNotMatch(
        entry.text,
        /\b(apply|applies|applying|stage|staged|staging|commit|commits|committing|merge|merges)\b/i,
        `${file}: retrieval is a read; "${entry.text.slice(0, 80)}" reads as an offer to change a tree`,
      )
    }
  }
})

test('the surface wires the retrieval rules this suite holds', () => {
  const source = readFileSync(path.join(SOURCE_ROOT, 'cloud-tasks.js'), 'utf8')
  assert.match(source, /offersDiff\(task\)/, 'the control is offered by the rule, not by a copy of it')
  assert.match(source, /controller\.readDiff\(/, 'the control asks the controller for the diff')
  /* Both mounts, or the fleet board keeps the old dead end. */
  assert.equal((source.match(/controller\.readDiff\(/g) || []).length, 2, 'the agent page and the fleet board both offer it')
  assert.equal((source.match(/cloud-diff-note/g) || []).length, 3, 'both mounts carry the region the answer is written into')
  assert.equal((source.match(/data-cloud-get/g) || []).length, 1)
  /* The sentence is the spoken half; the diff is not. */
  assert.match(source, /<p class="cloud-diff-note" role="status">/)
  assert.doesNotMatch(source, /<pre class="cloud-diff-text"[^>]*role="status"/)
})
