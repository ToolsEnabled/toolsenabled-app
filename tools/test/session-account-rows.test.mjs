/* WHICH ACCOUNT EACH RUNNING SESSION IS ON.
 *
 * The host chose an account for every session it started and then dropped the
 * answer: `selectedAccount`, `plan` and `sessionEnv` are locals of the start,
 * and only `plan.threadOptions` was copied onto the record. So a minute after
 * starting a session the host could not say whose sign-in it was running on,
 * which makes "these agents are on an account that has reached its limit" a
 * question with no answer, and any handover impossible even to describe.
 *
 * sessionAccountRows() is the reader, separated from the host so it can be
 * asserted without an engine, a payload or a child process -- the same reason
 * engineCandidates is exported beside it and says so.
 *
 * The rows it answers are exactly the shape the engine's handoverPlan() reads,
 * and that join is pinned on the engine side by
 * tests/account-handover.test.js ("the session shape the app host actually
 * produces is the one this reads"). It was written the other way round first,
 * with the host answering sessionId and the planner reading id, which silently
 * skipped every real session -- a plan that skips everything looks exactly
 * like a fleet with nothing to move.
 *
 *   node --test tools/test/session-account-rows.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = resolve(import.meta.dirname, '..', '..')
const { sessionAccountRows } = require_(join(ROOT, 'shell', 'agent-host.cjs'))
const HOST_SOURCE = readFileSync(join(ROOT, 'shell', 'agent-host.cjs'), 'utf8')

test('a session that pinned an account answers one row carrying the name and the directory', () => {
  const rows = sessionAccountRows([
    {
      sessionId: 's1',
      agentId: 'coordinator-1',
      account: { name: 'work', provider: 'claude' },
      pinnedHome: 'C:/homes/claude/work',
    },
  ])
  assert.deepEqual([...rows], [{
    sessionId: 's1', agentId: 'coordinator-1', account: 'work', provider: 'claude', pinnedHome: 'C:/homes/claude/work',
  }])
  assert.ok(Object.isFrozen(rows), 'a caller must not be able to edit the host\'s answer')
  assert.ok(Object.isFrozen(rows[0]))
})

test('the row names the declared agent, because a session id joins to no card on screen', () => {
  /* THE FIELD THAT MAKES THIS READABLE BY A PERSON. Session ids are opaque and
     the agent page's projection deliberately refuses to derive an agent from
     one, so a row carrying only a session id can be joined to a handover plan
     and never to the card with somebody's agent name on it. The host already
     knows: the start binds `agentId` from the resolved role binding before the
     session record is built. */
  const rows = sessionAccountRows([
    { sessionId: 's1', agentId: 'helper-9', account: { name: 'work', provider: 'codex' } },
    /* A start that bound no declared agent says so rather than being guessed
       at from whatever session happens to be running. */
    { sessionId: 's2', account: { name: 'work', provider: 'codex' } },
    { sessionId: 's3', agentId: '', account: { name: 'work', provider: 'codex' } },
    { sessionId: 's4', agentId: 42, account: { name: 'work', provider: 'codex' } },
  ])
  assert.deepEqual(rows.map(row => [row.sessionId, row.agentId]), [
    ['s1', 'helper-9'], ['s2', null], ['s3', null], ['s4', null],
  ])
})

test('a session that pinned no account is left out, not listed as unknown', () => {
  /* A computer with one sign-in has no account question to answer. A row
     saying "unknown" would invite a caller to read "there was nothing to
     choose" as "nobody knows what it chose", which is the confusion between an
     absence and a failure this codebase refuses everywhere else. */
  const rows = sessionAccountRows([
    { sessionId: 's1', account: null, pinnedHome: null },
    { sessionId: 's2' },
    { sessionId: 's3', account: { name: '', provider: 'claude' } },
    { sessionId: 's4', account: { name: 'work', provider: 'claude' }, pinnedHome: null },
  ])
  assert.deepEqual(rows.map(row => row.sessionId), ['s4'])
  assert.equal(rows[0].pinnedHome, null, 'a start that pinned no directory says so rather than inventing one')
})

test('rubbish in the session table is skipped rather than throwing', () => {
  /* This reads a live map of running sessions. A malformed entry must not be
     able to take the answer down with it. */
  const rows = sessionAccountRows([null, undefined, 'nope', 42, {}, { account: { name: 'x' } }])
  assert.deepEqual([...rows], [], 'nothing well-formed, so nothing reported')
  assert.deepEqual([...sessionAccountRows(null)], [])
  assert.deepEqual([...sessionAccountRows(undefined)], [])
})

test('the start path records the account and the directory before the engine is started', () => {
  /* Written before the engine start rather than after it, because a start that
     throws still leaves a session record behind for the failure path to read,
     and a record that cannot say whose sign-in it tried is the one this
     exists to prevent. */
  const account = HOST_SOURCE.indexOf('session.account = selectedAccount')
  const home = HOST_SOURCE.indexOf('session.pinnedHome =')
  const start = HOST_SOURCE.indexOf('const startedValue = await engineStart({')
  assert.ok(account > 0, 'the chosen account is no longer kept on the session record')
  assert.ok(home > 0, 'the pinned directory is no longer kept on the session record')
  assert.ok(start > 0, 'the engine start moved; this test needs re-anchoring, not deleting')
  assert.ok(account < start && home < start,
    'the record must be written before the engine start, so a failed start still says what it tried')
})

test('the host offers the reader on its surface', () => {
  assert.match(HOST_SOURCE, /^\s+sessionAccounts,$/m, 'sessionAccounts is no longer returned by createAgentHost')
  assert.match(HOST_SOURCE, /function sessionAccounts\(\)\s*\{\s*return sessionAccountRows\(sessions\.values\(\)\)/,
    'the host method must go through the same reader this file asserts, or the two can drift apart')
})
