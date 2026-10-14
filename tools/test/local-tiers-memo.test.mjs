/* THE READ THAT ASKED TWICE A VISIT FOR AN ANSWER THAT NEVER CHANGES.
 *
 * MEASURED 2026-09-03 against the owner's own audit ledger
 * (ToolsEnabled-Live/capability/logs/actions.jsonl and its legacy archive,
 * 2026-08-29T21:38Z -> 2026-09-03T04:17Z): twenty-one calls to
 * research.local_tiers_status, TWENTY-ONE FAILURES, NOT ONE SUCCESS, every one
 * of them MODEL_NO_GPU_PEER_CONFIGURED. src/views/research.js asks from
 * renderLiveWorld(), which runs on mount and again on the data-source event, so
 * a single visit to the page spends two loopback round trips and lands four
 * durable audit records learning a fact that is written in a configuration
 * file.
 *
 * MEASURED the same day on a real loopback server answering the same 409 after
 * the ledger's own median server time (19 ms), Node's fetch making the request:
 *
 *   before   20 requests, 67.2 ms per visit
 *   after     1 request,   3.3 ms per visit over ten visits
 *              (35.7 ms on the first visit, ~0 for the rest of the window)
 *
 * WHAT THIS SUITE PINS is the shape that produced those numbers -- a COUNT of
 * asks, not a duration, because a duration measured here would be measuring
 * this machine's mood. The count is the mechanism: it goes back up the moment
 * the memo stops being consulted, which is exactly the regression to catch.
 *
 * AND IT PINS THE THREE THINGS THAT MUST STILL ASK. A back-off that latched
 * would be a different defect: a person who configures a peer machine would
 * never be told, and a page that could not reach the bridge for one second
 * would give up for five minutes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  RECHECK_MS,
  SETTLED_ABSENCE_REASONS,
  SETTLED_REFUSAL_CODES,
  answerIsSettled,
  createSettledAnswerMemo,
} from '../../src/local-tiers-memo.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')

/* The refusal exactly as src/mission-bridge.js request() hands it back: the
   engine's code from errors.js typedError(), the engine's sentence. */
const noPeer = () => ({
  ok: false,
  code: 'MODEL_NO_GPU_PEER_CONFIGURED',
  reason: 'No GPU peer machine is configured, so no local model backend is reachable'
    + ' (no machine profile is configured, so this installation describes one computer).'
    + ' Add one in config/machines.profile.json to enable local model inference.',
})

/* One visit to the research page = renderLiveWorld() twice: once on mount, once
   on the data-source event. That is the call pattern being counted. */
const ASKS_PER_VISIT = 2

function countingAsker(answer = noPeer()) {
  const calls = { n: 0 }
  return {
    calls,
    async ask() { calls.n += 1; return typeof answer === 'function' ? answer(calls.n) : answer },
  }
}

async function visitsThroughMemo(memo, asker, visits, { key = 'local' } = {}) {
  for (let visit = 0; visit < visits; visit += 1) {
    for (let ask = 0; ask < ASKS_PER_VISIT; ask += 1) {
      if (memo.read(key)) continue
      memo.remember(await asker.ask(), key)
    }
  }
}

test('ten visits cost one bridge ask instead of twenty', async () => {
  const asker = countingAsker()
  const memo = createSettledAnswerMemo({ clock: () => 1_000 })
  await visitsThroughMemo(memo, asker, 10)
  assert.equal(asker.calls.n, 1, 'the settled refusal must be asked for exactly once')
})

test('without the memo the same ten visits cost twenty asks', async () => {
  /* The BEFORE arm, so the number above is a comparison and not an assertion
     about nothing. This is what the code did before this module existed. */
  const asker = countingAsker()
  for (let visit = 0; visit < 10; visit += 1) {
    for (let ask = 0; ask < ASKS_PER_VISIT; ask += 1) await asker.ask()
  }
  assert.equal(asker.calls.n, 20)
})

test('a real reading is never remembered, because tier readiness moves', async () => {
  const asker = countingAsker({ ok: true, tiers: [{ id: 'hermes', ready: true }] })
  const memo = createSettledAnswerMemo({ clock: () => 1_000 })
  await visitsThroughMemo(memo, asker, 5)
  assert.equal(asker.calls.n, 10, 'a machine that CAN answer must be re-read every time')
  assert.equal(memo.heldCount(), 0)
})

test('a transport failure is asked again immediately, not backed off', async () => {
  for (const transient of [
    { ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'action bridge unreachable' },
    { ok: false, code: 'BRIDGE_TIMEOUT', reason: 'action bridge timed out' },
    { ok: false, code: 'BRIDGE_BOOTSTRAP_PROOF_UNAVAILABLE', reason: 'no proof' },
    { ok: false, code: 'HERMES_MACHINE_PROFILE_CHECK_FAILED', reason: 'could not be checked' },
  ]) {
    const asker = countingAsker(transient)
    const memo = createSettledAnswerMemo({ clock: () => 1_000 })
    await visitsThroughMemo(memo, asker, 3)
    assert.equal(asker.calls.n, 6, `${transient.code} must not be remembered`)
  }
})

test('both engine codes for "no peer machine" settle', () => {
  assert.deepEqual([...SETTLED_REFUSAL_CODES], ['MODEL_NO_GPU_PEER_CONFIGURED', 'HERMES_NO_GPU_PEER_CONFIGURED'])
  for (const code of SETTLED_REFUSAL_CODES) assert.equal(answerIsSettled({ ok: false, code }), true)
})

/* THE ENGINE STOPPED THROWING FOR THIS, SO THE MEMO HAD TO STOP KEYING ON A
   THROW. research.local_tiers_status was filed as a tool FAILURE 22 times out
   of 22 calls in the owner's ledger for a fact written in a configuration file;
   engine research-strong.js status() now answers it. If this suite only
   understood the refusal shape, the fix would silently put the page back to two
   loopback asks a visit. */
const noPeerAnswered = (reason = 'no_gpu_peer_configured') => ({
  ok: true,
  receipt: {
    action: 'local-tiers-status',
    localOnly: true,
    available: false,
    reason,
    freeRamMiB: null,
    freeVramMiB: null,
    gpuTemperatureC: null,
    residentModels: null,
    fast: { model: 'hermes3:8b', enabled: true, ready: false, reason },
    strong: { model: 'gpt-oss:20b', enabled: true, ready: false, reason },
  },
})

test('the answered absence costs one ask across ten visits, exactly like the thrown one', async () => {
  for (const reason of SETTLED_ABSENCE_REASONS) {
    const asker = countingAsker(noPeerAnswered(reason))
    const memo = createSettledAnswerMemo({ clock: () => 1_000 })
    await visitsThroughMemo(memo, asker, 10)
    assert.equal(asker.calls.n, 1, `${reason} must be asked for exactly once, not twenty times`)
  }
})

test('every engine reason for "no local backend" settles, and an unfamiliar one does not', () => {
  assert.deepEqual([...SETTLED_ABSENCE_REASONS],
    ['no_gpu_peer_configured', 'gpu_peer_missing_address', 'gpu_peer_ambiguous'])
  for (const reason of SETTLED_ABSENCE_REASONS) {
    assert.equal(answerIsSettled(noPeerAnswered(reason)), true, reason)
  }
  assert.equal(answerIsSettled(noPeerAnswered('something_this_build_never_heard_of')), false,
    'an absence this build cannot name is a reason to ask again, not to remember')
})

test('a reading is still never remembered now that available:true carries it', async () => {
  const measured = {
    ok: true,
    receipt: {
      action: 'local-tiers-status', localOnly: true, available: true, reason: null,
      freeRamMiB: 32_768, freeVramMiB: 7_168, gpuTemperatureC: 55, residentModels: [],
      fast: { model: 'hermes3:8b', enabled: true, ready: true, reason: null },
      strong: { model: 'gpt-oss:20b', enabled: true, ready: true, reason: null },
    },
  }
  assert.equal(answerIsSettled(measured), false)
  const asker = countingAsker(measured)
  const memo = createSettledAnswerMemo({ clock: () => 1_000 })
  await visitsThroughMemo(memo, asker, 5)
  assert.equal(asker.calls.n, 10, 'free RAM, VRAM and temperature move; they must be re-read every time')
})

test('a failure the engine still raises is asked again, even wearing the new shape', () => {
  /* COULD-NOT-LOOK never settles. The engine deliberately keeps throwing when
     the machine profile cannot be checked or a declared peer does not answer,
     and none of those may be mistaken for "there is no backend". */
  for (const answer of [
    { ok: false, code: 'MODEL_MACHINE_PROFILE_CHECK_FAILED', reason: 'profile could not be checked' },
    { ok: false, code: 'MODEL_UNAVAILABLE', reason: 'the declared peer did not answer' },
    { ok: true, receipt: { action: 'local-tiers-status', available: false, reason: null } },
    { ok: true, receipt: { action: 'local-tiers-status', available: false } },
    { ok: true, receipt: null },
    { ok: true, receipt: [] },
    { ok: true },
  ]) {
    assert.equal(answerIsSettled(answer), false, JSON.stringify(answer))
  }
})

test('the research page renders the answered absence as words, not as two empty tier rows', () => {
  /* renderTiers() reads result.receipt. Before the engine answered, an
     installation with no peer reached the refusal arm and got a sentence; the
     regression to catch is that arm going unreachable and the page instead
     printing "not ready · no gpu peer configured" twice under a blank fact
     line. */
  const source = read('src/views/research.js')
  const body = source.slice(source.indexOf('function renderTiers'),
    source.indexOf('---------- the project layer'))
  assert.ok(body.length > 0, 'renderTiers() is gone or was renamed')
  assert.match(body, /receipt\.available === false/,
    'an answered absence must be recognised before the measurement row is built')
  assert.ok(body.indexOf('receipt.available === false') < body.indexOf('const facts ='),
    'recognising it after the facts row would print nulls as measurements')
})

test('nothing malformed is ever treated as settled', () => {
  for (const value of [null, undefined, 0, '', 'MODEL_NO_GPU_PEER_CONFIGURED', [], { ok: false },
    { ok: false, code: 42 }, { code: 'MODEL_NO_GPU_PEER_CONFIGURED' }, { ok: true, code: 'MODEL_NO_GPU_PEER_CONFIGURED' }]) {
    assert.equal(answerIsSettled(value), false, `${JSON.stringify(value)} must not settle`)
  }
})

test('the answer is asked again once the recheck window is past', async () => {
  let now = 1_000
  const asker = countingAsker()
  const memo = createSettledAnswerMemo({ clock: () => now })
  await visitsThroughMemo(memo, asker, 4)
  assert.equal(asker.calls.n, 1)
  now += RECHECK_MS + 1
  await visitsThroughMemo(memo, asker, 4)
  assert.equal(asker.calls.n, 2, 'configuring a peer machine must be noticed without a relaunch')
})

test('a different machine on the other end is a miss, never a borrowed answer', async () => {
  const relay = () => {}
  const asker = countingAsker()
  const memo = createSettledAnswerMemo({ clock: () => 1_000 })
  await visitsThroughMemo(memo, asker, 3, { key: 'local' })
  assert.equal(asker.calls.n, 1)
  await visitsThroughMemo(memo, asker, 3, { key: relay })
  assert.equal(asker.calls.n, 2, 'the relayed machine must answer for itself')
  /* And back again: the slot holds one answer, so returning to the local
     machine asks it rather than replaying the relay's. */
  await visitsThroughMemo(memo, asker, 1, { key: 'local' })
  assert.equal(asker.calls.n, 3)
})

test('forget() drops the slot', async () => {
  const asker = countingAsker()
  const memo = createSettledAnswerMemo({ clock: () => 1_000 })
  await visitsThroughMemo(memo, asker, 2)
  assert.equal(memo.heldCount(), 1)
  memo.forget()
  assert.equal(memo.heldCount(), 0)
  await visitsThroughMemo(memo, asker, 1)
  assert.equal(asker.calls.n, 2)
})

test('a recheck window must be a positive number of milliseconds', () => {
  for (const recheckMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5000', null]) {
    assert.throws(() => createSettledAnswerMemo({ recheckMs }), TypeError)
  }
})

/* ---- the wiring, which is where the saved requests actually come from ---- */

test('localTiersStatus consults the memo before it asks the bridge', () => {
  const source = read('src/mission-bridge.js')
  const body = source.slice(source.indexOf('export function localTiersStatus'),
    source.indexOf('export function forgetLocalTiersStatus'))
  assert.ok(body.length > 0, 'localTiersStatus() is gone or was renamed')
  assert.match(body, /localTiersMemo\.read\(/, 'the memo must be read BEFORE the request goes out')
  assert.match(body, /localTiersMemo\.remember\(/, 'the answer must be filed')
  assert.ok(body.indexOf('localTiersMemo.read(') < body.indexOf("request('/v1/research/local-tiers-status'"),
    'reading the memo after the request would save nothing')
})

test('changing the machine on the other end forgets what the last one said', () => {
  const source = read('src/mission-bridge.js')
  const seam = source.slice(source.indexOf('export function setBridgeTransport'),
    source.indexOf('export function bridgeTransportInstalled'))
  assert.match(seam, /localTiersMemo\.forget\(\)/,
    'installing or removing a transport must not leave another computer\'s answer standing')
})

test('no other read on the bridge was memoised by accident', () => {
  /* The memo is correct for THIS read because the refusal is configuration.
     Every other route on that module returns a reading that moves, so a second
     call site here would be a defect rather than a saving. */
  const source = read('src/mission-bridge.js')
  const uses = source.match(/localTiersMemo\.(read|remember)\(/g) || []
  assert.equal(uses.length, 2, 'exactly one read and one write of the memo')
})
