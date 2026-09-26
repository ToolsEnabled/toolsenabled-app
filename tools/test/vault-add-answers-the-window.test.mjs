/* ASKING FOR A CREDENTIAL MUST COME BACK, AND MUST COME BACK TRUE.
 *
 * WHAT THIS SUITE IS FOR. `mcVault.add()` is one press on the Settings vault
 * page, and two separate things went wrong behind it. Both were measured by
 * hand against the installed product before they were written down here, and
 * both are about the SAME call: shell/vault-credential-page.cjs's
 * `requestCredentialAdd`, which runs inside an ipcMain handler on Electron's
 * main thread.
 *
 *   1  IT DID NOT COME BACK. owner-prompt-queue's `enqueue` proves the runner
 *      it spawned is alive by sleeping in 100ms steps for up to thirty seconds,
 *      on the calling thread. That thread paints the window and sends this
 *      call's IPC reply, so a runner that never came up froze the application
 *      and the add promise could not settle until it gave up. MEASURED against
 *      the real engine module, with a runner that exits immediately:
 *      enqueue returned after 30,012ms. Against the real runner, which takes
 *      the queue lock on the first poll: 108ms.
 *   2  IT CAME BACK SAYING SOMETHING THAT WAS NOT TRUE. `enqueue` reports
 *      `launcherRequested`, and a `launchFailure` code when the launch failed,
 *      so its caller can tell "the owner is being asked" from "the request is
 *      on file and nothing is on screen". The seam discarded both and answered
 *      `ok: true` either way, and the page then said "The entry form is queued"
 *      to somebody looking at a screen with no form on it.
 *
 * WHY THE QUEUE IS A STUB HERE. The real owner-prompt queue ships in the
 * capability payload, which is not in this repository, and driving it would
 * spawn a real runner and a real owner form. The stub below is a MODEL of the
 * two things this seam depends on: that `enqueue` spends the liveness ceiling
 * it is given on the calling thread (it sleeps for it, synchronously, exactly
 * as the real one does), and that it reports the launch outcome. The model's
 * default ceiling is the real module's own 30,000ms, so a seam that states no
 * ceiling is held for the same time here as it is in the product.
 *
 * NO CREDENTIAL VALUE APPEARS ANYWHERE ON THIS PATH; the add seam is never
 * given one and never asks for one. There is nothing in this file to redact.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const seam = require_(path.join(ROOT, 'shell', 'vault-credential-page.cjs'))

/* owner-prompt-queue.js's own default when no `livenessMs` override is given.
   Written here as the number it is, because the point of the first test is what
   happens to a caller that states nothing. */
const QUEUE_DEFAULT_LIVENESS_MS = 30_000

/* The real probe blocks with Atomics.wait on a SharedArrayBuffer; so does this,
   so "how long was the calling thread held" is measured rather than asserted. */
function blockFor(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/* A CATALOGUE THAT ANSWERS LIKE THE PAYLOAD'S. It turns a choice into a key and
   a label and is never given a value -- the same two fields the real
   resolveCredentialRequest returns to this seam. */
const catalogue = {
  resolveCredentialRequest: ({ customName }) => ({ key: `custom.${customName}`, label: 'Provider api key' }),
}

/* A QUEUE THAT REPORTS THE LAUNCH OUTCOME, like the real one, and -- when the
   test is about the wait -- SPENDS THE CEILING IT IS GIVEN, like the real one.
   `blocking` is off in the tests that are about the ANSWER rather than the
   wait, because a suite that sleeps five seconds four times is a suite people
   stop running. `launch` decides what the queue reports. */
function queueStub({ launch = { launcherRequested: true }, blocking = false, record = [] } = {}) {
  return {
    record,
    enqueue(request, overrides = {}) {
      const livenessMs = Number.isSafeInteger(overrides.livenessMs) ? overrides.livenessMs : QUEUE_DEFAULT_LIVENESS_MS
      record.push({ request, livenessMs })
      /* The real module only waits when it actually launched something; a
         replay returns without probing at all. */
      if (blocking && launch.replayed !== true) blockFor(livenessMs)
      return { requestId: 'owner-prompt-11111111-2222-4333-8444-555555555555', replayed: false, ...launch }
    },
  }
}

const add = (options) => seam.requestCredentialAdd({ credential: 'custom', customName: 'provider_api_key' },
  { credentialCatalogue: catalogue, ...options })

test('an add answers the window in seconds rather than holding it for the queue’s liveness ceiling', () => {
  /* A runner that never proves itself: the worst case, and the one that froze
     the product. What is measured is how long the CALLER was held, because that
     is how long the window had no reply and no paint. */
  const queue = queueStub({ blocking: true, launch: { launcherRequested: false, launchFailure: 'OWNER_PROMPT_RUNNER_UNAVAILABLE' } })
  const startedAtMs = Date.now()
  const answer = add({ ownerPromptQueue: queue })
  const heldMs = Date.now() - startedAtMs

  assert.equal(queue.record.length, 1, 'the add path did not reach the queue exactly once')
  assert.ok(Number.isSafeInteger(queue.record[0].livenessMs) && queue.record[0].livenessMs < QUEUE_DEFAULT_LIVENESS_MS,
    `the seam stated no ceiling of its own, so the queue used its own ${QUEUE_DEFAULT_LIVENESS_MS}ms one on Electron’s main thread`)
  assert.ok(heldMs < 10_000,
    `one press held the calling thread for ${heldMs}ms; the window cannot paint or answer while it is held`)
  assert.equal(seam.FORM_LAUNCH_WAIT_MS, queue.record[0].livenessMs,
    'the stated ceiling and the one the queue was given have drifted apart')
  /* And it settled. A call that came back with an answer at all is the first
     half of this bug; the second half is what the answer said. */
  assert.equal(typeof answer?.ok, 'boolean', 'the add did not settle with an answer')
})

test('a form that never opened is reported as a form that never opened', () => {
  const queue = queueStub({ launch: { launcherRequested: false, launchFailure: 'OWNER_PROMPT_RUNNER_UNAVAILABLE' } })
  const answer = add({ ownerPromptQueue: queue })

  assert.equal(answer.ok, false, 'a request whose form never opened was reported as a completed ask')
  assert.equal(answer.code, 'OWNER_PROMPT_RUNNER_UNAVAILABLE',
    'the queue’s own launch-failure code was dropped instead of carried')
  /* THE SENTENCE IS THE PRODUCT HERE: it is what the page shows. It must not
     say "nothing was asked for" either, because the request IS durable. */
  assert.match(answer.reason, /could not open the form/i)
  assert.match(answer.reason, /on file/i)
  assert.equal(answer.requestId, 'owner-prompt-11111111-2222-4333-8444-555555555555',
    'the id that names the request on file was not handed back, so nothing can act on it')
  /* No value is on this path and none may be invented onto it. */
  assert.ok(!('value' in answer) && !('secret' in answer), 'the refusal grew a value-shaped field')
})

test('a launched form is still a success, and so is a replay of one already asked', () => {
  const launched = add({ ownerPromptQueue: queueStub({ launch: { launcherRequested: true } }) })
  assert.equal(launched.ok, true, launched.reason)
  assert.equal(launched.code, 'CREDENTIAL_REQUEST_QUEUED')
  assert.equal(launched.vaultKey, 'custom.provider_api_key')

  /* THE OVER-CORRECTION THIS GUARDS AGAINST. The queue deliberately does not
     spawn a second runner for a request that is still active, so a replay
     reports `launcherRequested: false` while the person already has the question
     in front of them. Reading that as "the form never opened" would refuse a
     working ask. */
  const replayed = add({ ownerPromptQueue: queueStub({ launch: { launcherRequested: false, replayed: true } }) })
  assert.equal(replayed.ok, true, replayed.reason)
  assert.equal(replayed.replayed, true, 'a replay was not reported as one')
})

test('a queue that says nothing about a launcher is not accused of having failed', () => {
  /* An unstated outcome is not a measurement. The readers in this seam refuse to
     round an unknown answer up on a delete path; this refuses to round one down
     on an ask path, so a queue implementation that reports no launcher at all
     still gets the durable fact reported. */
  const queue = { enqueue: () => ({ requestId: 'owner-prompt-x', replayed: false }) }
  const answer = add({ ownerPromptQueue: queue })
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(answer.code, 'CREDENTIAL_REQUEST_QUEUED')
})
