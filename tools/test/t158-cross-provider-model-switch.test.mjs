/* T158 -- A CROSS-PROVIDER MODEL SWITCH, PRESSED, NOT DESCRIBED.
 *
 * WHY THIS FILE EXISTS, AND WHY THE EXISTING GREEN DID NOT CATCH ANY OF IT.
 *
 * tools/test/session-model-switch.test.mjs is 8/8 and names
 * `continueNodeOnAnotherModel` zero times: every case calls
 * `sessionModelChoices(...)` and asserts which rows the menu OFFERS. None
 * presses one. tools/test/account-recovery-coordinator.test.mjs is 88/88 and
 * does drive `continueOnAnotherModel`, but against a stand-in bridge, so the
 * check that actually refused -- `agentAuthority.provider === sessionProvider`
 * inside shell/agent-host.cjs's start -- never ran. Two real numbers measuring
 * the wrong half of the chain.
 *
 * MEASURED on the promoted build, 2026-09-16, twice on two Codex tiers
 * (REPORT-OWNERVERIFY-T18-T137-20260916.md, 52 screenshots): pressing the
 * enabled row offering to continue a running Claude circle on a Codex model
 * retired the Claude session FIRST, and the replacement start was THEN refused
 * AGENT_ROLE_BINDING_INVALID. The conversation gained no line and the person
 * was shown only the generic last-turn-failed word.
 *
 * THE GUARANTEE THESE CASES GATE, in one sentence: a cross-provider
 * continuation either produces a live replacement carrying the handoff, or
 * leaves the original session alive. NEVER BOTH DEAD.
 *
 * Nothing below asserts a spelling. The row is found by the words a person
 * reads, pressed the way a person presses it, and the far end is read back
 * through the REAL organisation record and the REAL agent host.
 *
 * The harness (isolated org record, shared bridge singleton, the running
 * circle setup) lives in tools/test/lib/t158-switch-model-harness.mjs, shared
 * with tools/test/t158-model-switch-transcript-carry.test.mjs so the two files
 * cannot drift into pressing the row two different ways.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import {
  payloadSkip, FROM_TIER, TO_TIER, CROSS_ROW, SAME_ROW,
  runningCircle, waitFor, pressContinueRow, startedRequests,
} from './lib/t158-switch-model-harness.mjs'

const require = createRequire(import.meta.url)

/* ------------------------------------------------------------------ *
 * HALF ONE -- the seat describes the session that is about to run.
 * ------------------------------------------------------------------ */

test('pressing a cross-provider continuation row starts on the target tier with an authority the host will accept',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, newSession) => ({ ok: true, sessionId: newSession }) })
  await pressContinueRow(ctx, CROSS_ROW)
  await waitFor(() => startedRequests(ctx).length === 1, 'the pressed row to start a replacement')

  const starts = startedRequests(ctx)
  assert.equal(starts.length, 1, 'the press starts exactly one replacement')
  const request = starts[0].request
  assert.equal(request.tier, TO_TIER, 'the replacement is started on the tier the person pressed')
  assert.equal(request.replacesSessionId, ctx.OLD_SESSION, 'the replacement names the session it continues')
  assert.ok(request.roleBinding?.agentId, 'the start carries a declared identity')

  /* THE FAR END, NOT THE TABLE. Resolve the binding that actually left the
     renderer through the REAL organisation record -- the same call a start
     makes -- and read the provider the host compares. Asserting the seat row
     directly would still pass against a binding the host refuses. */
  const resolved = ctx.org.resolveRoleBinding(request.roleBinding)
  assert.equal(resolved.ok, true, `the binding must resolve: ${resolved.reason || ''}`)
  assert.equal(resolved.authority.provider, 'codex',
    'the authority the host compares against the session provider must be the TARGET tier provider')
  assert.equal(resolved.authority.agentId, request.roleBinding.agentId)
})

test('the same switch inside one provider still starts and still agrees with its seat',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, newSession) => ({ ok: true, sessionId: newSession }) })
  await pressContinueRow(ctx, SAME_ROW)
  await waitFor(() => startedRequests(ctx).length === 1, 'the pressed row to start a replacement')

  const starts = startedRequests(ctx)
  assert.equal(starts.length, 1, 'the same-provider continuation is not broken by the cross-provider fix')
  assert.equal(starts[0].request.tier, 'claude-opus')
  const resolved = ctx.org.resolveRoleBinding(starts[0].request.roleBinding)
  assert.equal(resolved.ok, true, `the binding must resolve: ${resolved.reason || ''}`)
  assert.equal(resolved.authority.provider, 'claude', 'a switch that crosses no provider must not move the seat')
})

/* ------------------------------------------------------------------ *
 * HALF TWO -- nothing is torn down before the replacement is startable.
 * This half stands on its own: with the provider corrected, closing first
 * still loses a conversation on ANY future refusal, so the refusal used
 * below is deliberately one the provider fix does not prevent.
 * ------------------------------------------------------------------ */

test('a refused replacement leaves the running session ALIVE and the circle usable -- never both dead',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, {
    replacementStart: async () => ({ ok: false, code: 'AGENT_RESOURCE_PRESSURE',
      reason: 'New starts pause at 97% CPU. This agent is queued.' }),
  })
  const before = ctx.readNode()
  await pressContinueRow(ctx, CROSS_ROW)
  await waitFor(() => startedRequests(ctx).length === 1, 'the refused replacement start to be attempted')
  await waitFor(() => ctx.readNode().statusNote !== before.statusNote, 'the circle to be told what happened')

  const closes = ctx.calls.filter(entry => entry.call === 'close' && entry.sessionId === ctx.OLD_SESSION)
  assert.deepEqual(closes, [],
    'the session the person is talking to must not be closed for a replacement that was refused')

  const after = ctx.readNode()
  assert.equal(after.sessionId, ctx.OLD_SESSION, 'the circle still holds the session it was running on')
  assert.equal(after.tier, FROM_TIER, 'a refused switch does not record the model that never started')
  assert.notEqual(after.status, 'turn-failed',
    'a session that is still running must not be reported as a failed turn')
  assert.equal(after.status, before.status, 'the circle is handed back in the state it was in')
  assert.match(after.statusNote, /still running/,
    'the person is told the session survived, not just that something failed')
})

test('a replacement that starts takes the session over without the renderer closing the old one first',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, newSession) => ({ ok: true, sessionId: newSession }) })
  await pressContinueRow(ctx, CROSS_ROW)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'the circle to take over the replacement session')
  await waitFor(() => ctx.calls.some(entry => entry.call === 'send' && entry.sessionId === ctx.NEW_SESSION),
    'the handoff to be sent to the replacement')

  const order = ctx.calls.map(entry => `${entry.call}:${entry.sessionId}`)
  const startAt = order.findIndex(row => row.startsWith('start:'))
  const closeOldAt = order.indexOf(`close:${ctx.OLD_SESSION}`)
  assert.ok(startAt >= 0, `the replacement start is in ${JSON.stringify(order)}`)
  assert.ok(closeOldAt === -1 || closeOldAt > startAt,
    `the old session must never be closed before the replacement start: ${JSON.stringify(order)}`)

  const after = ctx.readNode()
  assert.equal(after.sessionId, ctx.NEW_SESSION, 'the circle is now on the replacement session')
  assert.equal(after.tier, TO_TIER, 'the card, the chip and the next Resume read the model that is actually running')
  const handoff = ctx.calls.find(entry => entry.call === 'send' && entry.sessionId === ctx.NEW_SESSION)
  assert.ok(handoff, 'the replacement is sent the handoff')
  assert.match(handoff.request.text, /Previous model: Sonnet \(claude\)\. New model: GPT-6-Astra \(codex\)\./,
    'the handoff names both models, so the context arrives with the switch')
})

/* ------------------------------------------------------------------ *
 * THE REAL CHECK -- the one a stand-in bridge never runs.
 * ------------------------------------------------------------------ */

const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

test('the real agent host refuses a mismatched authority provider and keeps the predecessor open', async t => {
  const cwd = fs.mkdtempSync(path.join(ownedFixtureTempRoot(), 't158-host-'))
  const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
  const engine = require(enginePath)
  t.mock.method(engine, 'startCodexSession', async () => ({
    threadId: 'thread-1', close() {}, adapter: { interrupt() {}, sendTurn: async () => ({ text: 'ok' }) },
  }))
  const { createAgentHost } = require('../../shell/agent-host.cjs')
  const host = createAgentHost({
    enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
    confinementPlanner: ({ account } = {}) => ({ account: account?.name || null, ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    accountResolver: async () => ({ rotated: true, account: { name: 'primary', provider: 'codex' } }),
  })
  t.after(async () => {
    await host.closeAll()
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') console.log('RETAINED_T158_HOST_FIXTURE ' + cwd)
    else fs.rmSync(cwd, { recursive: true, force: true })
  })

  const identity = {
    requestKeys: { treeAnchors: ['root-node', 'node-42'], threadId: 'node-42' },
    treeIdentity: { selfName: 'Builder', managerName: 'Controller' },
  }
  const role = { id: 'builder', revision: 1, name: 'Builder', directions: 'Do the work.' }
  const authority = provider => ({ agentId: 'node-42', provider, roleId: 'builder', expectedOrgRevision: 1, expectedRoleRevision: 1 })
  const open = () => host.sessionAccounts().map(row => row.sessionId)

  await host.startSession({ sessionId: 'predecessor', ...identity })
  assert.deepEqual(open(), ['predecessor'], 'the predecessor is running')

  /* A seat still recorded on the old provider is exactly what T137 sent. This
     is the refusal the person actually hit, raised by the real host. */
  const attempt = async request => { try { await host.startSession(request); return null } catch (error) { return error } }
  const mismatch = await attempt({ sessionId: 'replacement-mismatch', ...identity,
    replacesSessionId: 'predecessor', agentId: 'node-42', agentAuthority: authority('claude'), role })
  assert.equal(mismatch?.code, 'AGENT_ROLE_BINDING_INVALID',
    'a start whose authority provider differs from its session provider is refused')
  assert.deepEqual(open(), ['predecessor'],
    'THE POINT: the host refuses before it closes, so the conversation is still there')

  /* The matching binding gets PAST the authority check -- it stops later, at
     the session-identity transport, because this fixture engine has none.
     Named rather than passed over quietly: minting a session credential to
     carry the fixture further is credential work, which this task is not. The
     discrimination that matters is already made -- provider agreement is no
     longer what refuses -- and the predecessor survives either way. */
  const matched = await attempt({ sessionId: 'replacement-matched', ...identity,
    replacesSessionId: 'predecessor', agentId: 'node-42', agentAuthority: authority('codex'), role })
  assert.notEqual(matched?.code, 'AGENT_ROLE_BINDING_INVALID',
    'an authority carrying the session own provider passes the binding check')
  assert.equal(matched?.code, 'AGENT_SESSION_IDENTITY_TRANSPORT_UNAVAILABLE',
    'it stops at the fixture engine missing identity transport, not at the binding')
  assert.deepEqual(open(), ['predecessor'],
    'no refusal on the way to a replacement costs the person their running session')
})
