/* WHICH ACCOUNT EACH RUNNING AGENT IS ON, JOINED TO WHICH ACCOUNTS HAVE RUN OUT.
 *
 * THE DEFECT THIS CLOSES. Nothing on this computer told a person which of their
 * own sign-ins an agent was spending. The host has remembered it since
 * 2026-09-03 -- shell/agent-host.cjs sessionAccountRows(), host.sessionAccounts()
 * -- and nothing consumed the answer, so six agents on one account that had
 * reached the person's own limit drew exactly like six agents spread across six.
 *
 * WHAT THIS FILE PROVES, and it is deliberately the app's HALF of the join:
 *
 *   1. THE ROWS THE HOST HOLDS REACH THE ENGINE'S READER UNCHANGED, minus the
 *      one field that must not travel.
 *   2. NO PATH CROSSES. The host's rows carry `pinnedHome`, the confined
 *      directory a session's credential is linked into. It is dropped before
 *      the answer leaves the surface.
 *   3. IT MOVES NOTHING. The command is a read, and the only engine function it
 *      calls is the report.
 *   4. IT STARTS NOTHING. No host is built, and the allowance figures come from
 *      the last check the person ran rather than from a fresh probe.
 *   5. "COULD NOT LOOK" IS NOT "NOTHING TO DO". A build that cannot load the
 *      reader still answers which account each agent is on, with the reason the
 *      report is missing.
 *
 * The OTHER half -- that those rows produce the right moves, holds and unknowns
 * -- is pinned in the engine, beside the decision, by
 * tests/account-handover.test.js.
 *
 *   node --test tools/test/session-account-report.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAgentCommandSurface } = require('../../shell/agent-command-surface.cjs')

const window = Object.freeze({ kind: 'window', owner: { id: 'webContents-1' }, mayWrite: true, label: 'the application window' })
const readOnly = Object.freeze({ kind: 'window', owner: { id: 'webContents-1' }, mayWrite: false, label: 'a read-only caller' })

/* The rows the real host answers, exactly as sessionAccountRows() builds them:
   a session id, the declared agent bound at start, the account, the program,
   and the confined home directory. */
const HOST_ROWS = Object.freeze([
  Object.freeze({ sessionId: 's1', agentId: 'coordinator-1', account: 'work', provider: 'claude', pinnedHome: 'C:\\homes\\claude\\work' }),
  Object.freeze({ sessionId: 's2', agentId: null, account: 'spare', provider: 'codex', pinnedHome: 'C:\\homes\\codex\\spare' }),
])

/* Only what agent:session-accounts touches is real; every other dependency is
   the right kind and nothing else, because construction checks kinds and this
   file runs exactly one command. */
function deps({ rows = HOST_ROWS, host = undefined, engine = undefined, usageCache = null, capabilityRoot = 'C:\\fake\\capability' } = {}) {
  const calls = []
  const note = (name, ...args) => { calls.push({ name, args }) }
  const nothing = () => ({})
  const record = {
    agentSessions: new Map(),
    currentAgentHost: () => (host === undefined
      ? { sessionAccounts: () => { note('sessionAccounts'); return rows } }
      : host),
    getAgentHost: () => { note('getAgentHost'); return {} },
    agentIpcError: (code, message) => { const error = new Error(message); error.code = code; throw error },
    agentPayload: value => value || {},
    boundedAgentString: value => String(value ?? ''),
    parseAgentStart: nothing,
    parseAgentSend: nothing,
    parseAgentSessionCommand: nothing,
    rendererSafeAgentError: error => error,
    spawnRecordAvailability: nothing,
    spawnRecordHistory: nothing,
    usageRecordHistory: nothing,
    engineAvailability: nothing,
    ensureWorkspaceRoot: nothing,
    chosenWorkspaceCwd: nothing,
    readAgentConfinement: nothing,
    listAgentTools: nothing,
    resolveCapabilityRoot: () => { note('resolveCapabilityRoot'); return capabilityRoot },
    requireModule: (file) => {
      note('requireModule', file)
      if (engine === undefined) {
        return {
          handoverReport: (request) => { note('handoverReport', request); return { ok: true, code: null, moves: [], held: [], unknown: [], providers: [] } },
        }
      }
      if (typeof engine === 'function') return engine()
      return engine
    },
    readStandingRequests: nothing,
    readCanonicalLedger: nothing,
    sessionProfiles: { list: nothing, create: nothing, remove: nothing, resolveCwd: nothing },
    recordSpawnIntent: nothing,
    recordSpawnOutcome: nothing,
    recordSessionEnd: nothing,
    bindAgentOwner: nothing,
    agentOrgRecord: { read: nothing },
    dialog: { showOpenDialog: nothing },
    /* ASYNC, BECAUSE THE REAL ONE IS. MEASURED 2026-09-03: shell/main.cjs's
       readAccountUsageCache is `accountUsageCacheOrder(async () => ...)` --
       a queued file read -- so it answers a promise. A double that answered
       the value straight passed a shape this command is never handed, and
       the pass it bought hid the surface forgetting to await it. */
    readAccountUsageCache: async () => { note('readAccountUsageCache'); return usageCache },
    MAX_SESSION_ID_LENGTH: 64,
    AGENT_EFFORT_VALUES: ['low', 'medium', 'high'],
    WORKSPACE_ROOT: 'C:\\fake\\workspace',
  }
  return Object.assign(record, { calls, names: () => calls.map(entry => entry.name) })
}

const USAGE = Object.freeze({
  ok: true,
  readAt: '2026-09-03T10:00:00.000Z',
  policy: { exhaustedAtPercent: 90 },
  accounts: [{ name: 'work', provider: 'claude', canServe: true, windows: null }],
  orders: [{ provider: 'claude', names: ['work'] }],
})

test('the account each running agent is on crosses, and the directory behind it does not', () => {
  /* THE FIELD THAT MUST NOT TRAVEL. `pinnedHome` is the confined directory a
     session's credential is linked into. Every other agent channel states this
     rule for itself -- mc-providers:presence carries no path either -- and a
     row is the easiest place to leak one by copying it whole. */
  const fake = deps()
  const surface = createAgentCommandSurface(fake)
  return surface.run('agent:session-accounts', undefined, window).then((answer) => {
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.sessions, [
      { sessionId: 's1', agentId: 'coordinator-1', account: 'work', provider: 'claude' },
      { sessionId: 's2', agentId: null, account: 'spare', provider: 'codex' },
    ])
    for (const session of answer.sessions) {
      assert.equal(Object.hasOwn(session, 'pinnedHome'), false, 'the confined home directory reached the renderer')
    }
    assert.doesNotMatch(JSON.stringify(answer), /homes/, 'a directory travelled somewhere in the answer')
  })
})

test('the rows the host holds are the rows the engine reader is handed', async () => {
  /* THE JOIN, on the app's side of it. A reader handed a different shape from
     the one the host produces skips every real session in silence, and a plan
     that skips everything looks exactly like a fleet with nothing to move --
     which is how this was got wrong once already, on the engine side. */
  const fake = deps({ usageCache: USAGE })
  const surface = createAgentCommandSurface(fake)
  await surface.run('agent:session-accounts', undefined, window)

  const asked = fake.calls.find(entry => entry.name === 'requireModule')
  assert.ok(asked, 'the engine reader was never asked for')
  assert.match(asked.args[0], /src[\\/]lib[\\/]multi-account[\\/]handover\.js$/,
    'the surface asked for a module the payload boundary does not declare')

  const handed = fake.calls.find(entry => entry.name === 'handoverReport')
  assert.ok(handed, 'the report was never built')
  assert.deepEqual(handed.args[0].sessions, [
    { sessionId: 's1', agentId: 'coordinator-1', account: 'work', provider: 'claude' },
    { sessionId: 's2', agentId: null, account: 'spare', provider: 'codex' },
  ])
  assert.equal(handed.args[0].usage, USAGE, 'the report was built from a different reading than the menu shows')
})

test('a computer that HAS checked its allowances is not told nobody looked', async () => {
  /* THE DEFECT. MEASURED 2026-09-03: shell/main.cjs's readAccountUsageCache is
     a queued file read -- `accountUsageCacheOrder(async () => ...)` -- so it
     answers a promise, and the surface handed that promise to the reader
     unawaited. `ok` on a promise is undefined, so the reader took its "nothing
     was ever read" branch EVERY time and named every running agent unmeasured,
     on a computer whose person had just run the check.
     "Nobody looked" and "looked, and this agent is on a spent account" are the
     two answers this whole report exists to keep apart, and it could only ever
     give the first.
     The reader here decides the same way the engine's does -- on `usage.ok` --
     so the assertion is on what a person is told, not on how the surface spells
     the read. */
  const seen = []
  const reader = {
    handoverReport: ({ usage, sessions }) => {
      seen.push(usage)
      const named = sessions.map(session => ({ sessionId: session.sessionId, agentId: session.agentId, from: session.account }))
      return usage && usage.ok === true
        ? { ok: true, code: null, readAt: usage.readAt, providers: [], held: [], unknown: [], moves: named.map(row => ({ ...row, to: 'spare', why: 'HANDOVER_MOVED' })) }
        : { ok: false, code: 'HANDOVER_UNKNOWN_NOTHING_READ', readAt: null, providers: [], moves: [], held: [], unknown: named.map(row => ({ ...row, why: 'HANDOVER_UNKNOWN_NOTHING_READ' })) }
    },
  }
  const answer = await createAgentCommandSurface(deps({ usageCache: USAGE, engine: reader }))
    .run('agent:session-accounts', undefined, window)

  assert.equal(answer.report.ok, true,
    'a computer that had checked its allowances was told the check had never run')
  assert.equal(answer.report.code, null)
  assert.equal(answer.report.readAt, USAGE.readAt, 'the report is dated by a reading it never saw')
  assert.deepEqual(answer.report.moves.map(move => move.agentId), ['coordinator-1', null])
  assert.deepEqual(answer.report.unknown, [], 'a measured session was reported as one nobody had looked at')

  /* And the reading itself crosses, not a wrapper around it: a reader handed a
     promise reads every field as undefined and cannot say that it did. */
  assert.deepEqual(seen, [USAGE])
})

test('the allowance figures are the last check the person ran, never a fresh one', () => {
  /* A read that started one program per account every time a page painted
     would be a background poll nobody asked for. It reads the same cache
     mc-accounts:list hands the menu, so a card and the menu cannot disagree
     about how much is left. */
  const fake = deps({ usageCache: USAGE })
  const surface = createAgentCommandSurface(fake)
  return surface.run('agent:session-accounts', undefined, window).then(() => {
    assert.ok(fake.names().includes('readAccountUsageCache'))
    assert.equal(fake.names().includes('getAgentHost'), false,
      'a read of what is running must not be the thing that builds the machinery for running it')
  })
})

test('the report rides along and moves nothing', async () => {
  /* IT REPORTS. The engine's handoverReport() is a pure function of the rows
     and a usage answer, and the surface calls THAT and nothing else: there is
     no second engine function here that could close, restart or re-point a
     session. Pinned by naming every engine call this command makes. */
  const touched = []
  /* Every name the surface reads off the engine module is recorded, so "it
     calls the report and nothing else" is asserted rather than asserted about. */
  const engine = new Proxy({
    handoverReport: () => ({ ok: true, code: null, readAt: USAGE.readAt, providers: [], moves: [{ sessionId: 's1', from: 'work', to: 'spare', why: 'HANDOVER_MOVED' }], held: [], unknown: [] }),
    handoverPlan: () => { throw new Error('the report is the only reader this command may use') },
    closeSession: () => { throw new Error('a report must not be able to act') },
  }, {
    get(target, name) { touched.push(String(name)); return target[name] },
  })
  const fake = deps({ usageCache: USAGE, engine })
  const surface = createAgentCommandSurface(fake)
  const answer = await surface.run('agent:session-accounts', undefined, window)
  assert.deepEqual(answer.report.moves, [{ sessionId: 's1', from: 'work', to: 'spare', why: 'HANDOVER_MOVED' }])
  assert.equal(answer.reportReason, null)
  assert.deepEqual([...new Set(touched)], ['handoverReport'],
    'the command reached for something on the engine besides the report')

  /* And it is a read, so a caller that may look but not change still gets it.
     A person watching a fleet from a surface that may not touch it is exactly
     who needs to know which of their accounts is paying for it. */
  const readOnlyAnswer = await createAgentCommandSurface(deps({ usageCache: USAGE, engine }))
    .run('agent:session-accounts', undefined, readOnly)
  assert.equal(readOnlyAnswer.ok, true)
  assert.equal(readOnlyAnswer.report.moves.length, 1)
})

test('a build that cannot read the plan still says which account each agent is on', async () => {
  /* "COULD NOT LOOK" AND "NOTHING TO DO" ARE DIFFERENT ANSWERS. A null report
     with no reason beside it is indistinguishable from a fleet with nothing to
     move, and the session list does not depend on the plan: which account an
     agent is on is known whether or not the allowance check has ever run. */
  for (const engine of [{}, () => { throw new Error('older payload') }, { handoverReport: 'not a function' }]) {
    const fake = deps({ usageCache: USAGE, engine })
    const answer = await createAgentCommandSurface(fake).run('agent:session-accounts', undefined, window)
    assert.equal(answer.ok, true)
    assert.equal(answer.sessions.length, 2, 'the session list was lost with the report')
    assert.equal(answer.report, null)
    assert.equal(typeof answer.reportReason, 'string')
    assert.ok(answer.reportReason.length > 0, 'the report went missing without a reason')
  }

  /* No payload at all resolves to no root, and the module is never asked for. */
  const rootless = deps({ usageCache: USAGE, capabilityRoot: null })
  const answer = await createAgentCommandSurface(rootless).run('agent:session-accounts', undefined, window)
  assert.equal(answer.sessions.length, 2)
  assert.equal(answer.report, null)
  assert.equal(rootless.names().includes('requireModule'), false)
})

test('a window that has started nothing answers an empty list rather than a failure', async () => {
  /* The host is built by the first start, so no host means no session, which
     is the whole of the answer -- not a fault to report and not a reason to
     build one here. */
  for (const host of [null, {}, { sessionAccounts: 'not a function' }]) {
    const fake = deps({ host, usageCache: USAGE })
    const answer = await createAgentCommandSurface(fake).run('agent:session-accounts', undefined, window)
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.sessions, [])
    assert.equal(fake.names().includes('getAgentHost'), false, 'a read built the agent host')
  }
})

test('a computer that has never checked its allowances hands the reader nothing, and says nothing was read', async () => {
  /* Absence must not read as health. The engine answers this shape with every
     running session named and the reason attached (its own suite pins that);
     what this end owes is to pass the absence on honestly instead of
     substituting an empty reading that would draw as "all fine". */
  const fake = deps({ usageCache: null })
  await createAgentCommandSurface(fake).run('agent:session-accounts', undefined, window)
  const handed = fake.calls.find(entry => entry.name === 'handoverReport')
  assert.equal(handed.args[0].usage, null)
})
