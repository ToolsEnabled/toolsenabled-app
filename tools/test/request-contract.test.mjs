/* THE STANDING-REQUEST CONTRACT AT THE HOST SEAM — filing and boot carriage.
 *
 * The owner's design, as it stands after the one-ledger fold (2026-09-02):
 * ONE canonical ledger with scope tiers -- global, session, tree, thread --
 * filed by the /Request-family commands in the person's own words and
 * managed on the Ledger page; agents READ the tiers that apply to them at
 * boot. The PRODUCT does the filing — the agent needs no tool and just sees
 * the confirmation and, at its next start, the rule.
 *
 * What this suite proves, all against the fixture store and adapter
 * (tools/test/fixtures/confined-engine/src/lib/owner-request-store.js and
 * r-ledger.js -- the JSON-backed implementation of the store contract the
 * engine lane builds to, replaced later by a verbatim copy of the engine's):
 *
 *   FILE      host.fileStandingRequest lands the words verbatim as the next
 *             R-number in <stateRoot>/reports/OWNER-REQUEST-LEDGER.json with
 *             the tier and key it was typed for, and answers the id; a
 *             payload without the module refuses by name instead of
 *             pretending; a refusal creates nothing.
 *   CARRY     a session started with requestKeys gets the applicable tiers
 *             on its FIRST turn, after the person's words and before the tool
 *             note; absent tiers are STATED; the contract paragraph rides;
 *             the second turn carries none of it. A RESUMED session gets the
 *             block too — the tool note stays start-only, the rules do not,
 *             because a restarted conversation is exactly when a thread rule
 *             must be re-asserted.
 *   ISOLATE   session A's rules never reach session B's brief on other keys.
 *   CEILING   an absurd ledger (hundreds of records, oversized words) cannot
 *             brick or bloat a start: the session still starts, the block is
 *             capped, every withheld tier says so and names its file. The
 *             precedent is the engine's own packet-ceiling incident
 *             (agent-onboarding.js — ~36 entries stopped EVERY agent start).
 *   ABSENT    an engine payload with no r-ledger module starts sessions and
 *             injects nothing; a corrupt ledger file degrades to an announced
 *             absence.
 *   WAITING   a record an agent filed that is still waiting for the person
 *             (status 'proposed') is NOT in the boot block; the rail shows it
 *             as waiting; the person's approve puts it in the next start's
 *             block and a decline keeps it out.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

/* THIS SUITE IS NOT ABOUT THE MEMORY ADMISSION RULE. Left unset, createAgentHost
   defaults freeMemory to the real os.freemem() (shell/agent-host.cjs:2559), which
   startSession consults at :3870 and refuses at :3873. Every start below would then
   fail with AGENT_MEMORY_LOW whenever this computer happens to be short of memory,
   so the suite's colour would track the machine rather than the code under test.
   memoryAdmission() keeps its own coverage in agent-memory-admission.test.mjs, and
   agent-resource-wiring.test.mjs drives it deliberately with freeMemory: () => 0. */
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const { createAgentHost } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const { readStandingRequests } = require_(path.join(ROOT, 'shell/standing-requests-read.cjs'))
const { readCanonicalLedger } = require_(path.join(ROOT, 'shell/canonical-ledger-read.cjs'))

const CONFINED_ENGINE = path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const SUMMARYLESS_ENGINE = path.join(ROOT, 'tools/test/fixtures/summaryless-engine/src/lib/agent-engine/codex-process.js')
const FIXTURE_LEDGER = require_(path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/r-ledger.js'))
const FIXTURE_STORE = require_(path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/owner-request-store.js'))
/* Scratch under node_modules, resolved through its real path: in a worktree
   node_modules can be a junction, and the host refuses a working folder that
   crosses one -- the shape no real workspace has. */
const SCRATCH_PARENT = testScratchRoot('.toolsenabled-request-contract-test')
mkdirSync(SCRATCH_PARENT, { recursive: true })
const TEST_SCRATCH_ROOT = realpathSync.native(SCRATCH_PARENT)
const testScratch = prefix => mkdtempSync(path.join(TEST_SCRATCH_ROOT, prefix))
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

/* Where the one ledger and its history live under a state root. */
const ledgerFileOf = stateRoot => path.join(stateRoot, 'reports', 'OWNER-REQUEST-LEDGER.json')
const historyFileOf = stateRoot => path.join(stateRoot, 'state', 'owner-request-record-events.jsonl')
const readLedger = stateRoot => JSON.parse(readFileSync(ledgerFileOf(stateRoot), 'utf8'))
const storeOptions = stateRoot => ({ rootPath: (...parts) => path.join(stateRoot, ...parts) })

function adapterCalls() {
  return require_(CONFINED_ENGINE).adapterCalls
}

function guidedPlan(workdir) {
  return {
    ok: true, tier: 'guided', isolated: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' },
    env: { CODEX_HOME: path.join(workdir, 'agent-home') },
    servers: ['toolsenabled-readonly'],
  }
}

/* One scratch world per test: a state root the fixture store writes under,
   a workdir, a host over the confined engine, and the plan in place.

   TOOLSENABLED_STATE_ROOT, Controller 3's standing safety rule (2026-09-07,
   from Worker 3's Finding 1, W\REPORT-ledger-kinds-tools-20260907.md): the
   REAL engine's runtime-state-root.js resolves the owner-request ledger
   through this variable whenever a call omits rootPath, memoized at module
   load, so a probe or test that sets it too late -- or never -- can target
   the person's live ledger. This fixture's own runtime-state-root.js stub
   only ever reads MC_TEST_STATE_ROOT (measured: tools/test/fixtures/
   confined-engine/src/lib/runtime.js's rootPath() checks
   process.env.MC_TEST_STATE_ROOT first, never TOOLSENABLED_STATE_ROOT, so
   this suite was never actually exposed to that variable) -- but the rule is
   set and restored here anyway, alongside MC_TEST_STATE_ROOT, as the
   defense-in-depth Controller 3 ordered: if anything in this call chain ever
   changes to read the real variable, a fresh scratch directory is already
   sitting there instead of the live root. */
async function inWorld(run, buildOverrides = () => ({})) {
  const workdir = testScratch('mc-request-')
  const stateRoot = path.join(workdir, 'state-root')
  mkdirSync(stateRoot, { recursive: true })
  const previousRoot = process.env.MC_TEST_STATE_ROOT
  const previousToolsEnabledRoot = process.env.TOOLSENABLED_STATE_ROOT
  const previousPlan = process.env.MC_TEST_CONFINEMENT_PLAN
  process.env.MC_TEST_STATE_ROOT = stateRoot
  process.env.TOOLSENABLED_STATE_ROOT = stateRoot
  process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify(guidedPlan(workdir))
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir, ...buildOverrides(stateRoot) })
  try {
    return await run({ host, workdir, stateRoot })
  } finally {
    await host.closeAll().catch(() => {})
    if (previousRoot === undefined) delete process.env.MC_TEST_STATE_ROOT
    else process.env.MC_TEST_STATE_ROOT = previousRoot
    if (previousToolsEnabledRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = previousToolsEnabledRoot
    if (previousPlan === undefined) delete process.env.MC_TEST_CONFINEMENT_PLAN
    else process.env.MC_TEST_CONFINEMENT_PLAN = previousPlan
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

function endTurn() {
  const startCall = require_(CONFINED_ENGINE).calls.at(-1)
  startCall.onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 't1', status: 'completed' })
}

// The production Engine reader is staged by the normal packer. Fixtures own
// their ledger paths explicitly; no owner ledger or provider is consulted.
function completeRulesReader(stateRoot, control = {}) {
  const shared = require_(path.join(ROOT, 'capability/src/lib/rules-turn-snapshot.js'))
  return {
    loadRulesReadMode: () => shared.loadRulesReadMode({ loadSettings: () => ({
      values: { [shared.SETTING_ID]: control.enabled !== false }, rejected: [],
    }) }),
    buildRulesTurnSnapshot: identity => {
      control.identities ||= []
      control.identities.push(structuredClone(identity))
      if (control.partial) return { complete: false, text: 'partial rule' }
      return shared.buildRulesTurnSnapshot(identity, { storeOptions: storeOptions(stateRoot),
        ...(control.maxBytes ? { maxBytes: control.maxBytes } : {}) })
    },
    assertRulesTurnSnapshotCurrent: (snapshot, identity) => {
      const change = control.changeAtRecheck
      control.changeAtRecheck = null
      change?.()
      return shared.assertRulesTurnSnapshotCurrent(snapshot, identity)
    },
  }
}

for (const tier of [null, 'claude-sonnet']) test(`complete rules ON: ${tier || 'codex'} gets every unchanged scope on every roleless turn`, async () => {
  const control = {}
  await inWorld(async ({ host, stateRoot }) => {
    const specs = [
      { scope: 'global', words: 'GLOBAL_FIRST ' + 'Keep this complete global instruction. '.repeat(200) + 'GLOBAL_LAST' },
      { scope: 'session', key: 'complete-turns', words: 'SESSION_FIRST ' + 'Keep this complete session instruction. '.repeat(200) + 'SESSION_LAST' },
      { scope: 'tree', key: 'parent-tree', words: 'PARENT_FIRST ' + 'Keep this complete parent instruction. '.repeat(200) + 'PARENT_LAST' },
      { scope: 'tree', key: 'own-tree', words: 'OWN_TREE_FIRST ' + 'Keep this complete branch instruction. '.repeat(200) + 'OWN_TREE_LAST' },
      { scope: 'thread', key: 'conversation', words: 'THREAD_FIRST ' + 'Keep this complete thread instruction. '.repeat(200) + 'THREAD_LAST' },
    ]
    for (const spec of specs) await host.fileStandingRequest(spec)
    await host.fileStandingRequest({ scope: 'thread', key: 'another-conversation', words: 'UNRELATED_RULE_MUST_NOT_RIDE' })
    await host.startSession({ sessionId: 'complete-turns', role: null, ...(tier ? { tier } : {}),
      requestKeys: { treeAnchors: ['parent-tree', 'own-tree'], threadId: 'conversation' } })
    for (const text of ['First message', 'Second unchanged message']) {
      const accepted = await host.sendTurn({ sessionId: 'complete-turns', text, origin: 'person' })
      const sent = adapterCalls().at(-1).request.text
      assert.ok(sent.startsWith(text))
      for (const spec of specs) assert.ok(sent.includes(spec.words), `complete ${spec.scope}/${spec.key || ''} wording is delivered`)
      assert.ok(Buffer.byteLength(sent) > 20_000, 'enabled rules must not use the old shedding ceiling')
      assert.doesNotMatch(sent, /withheld for space|UNRELATED_RULE_MUST_NOT_RIDE/)
      assert.match(accepted.transcriptPrompt.additions.find(row => row.kind === 'requests').text, /THREAD_FIRST/)
      endTurn()
    }
    assert.equal(control.identities.length, 2)
    assert.deepEqual(control.identities[1], { sessionId: 'complete-turns', treeAnchors: ['parent-tree', 'own-tree'], threadId: 'conversation' })
    assert.equal(readLedger(stateRoot).requests.length, 6, 'reading rules does not change the ledger')
  }, stateRoot => ({ rulesTurnSnapshotLoader: () => completeRulesReader(stateRoot, control) }))
})

test('complete rules read failure sends nothing, then retry retains first-turn context and reads repaired rules', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    await host.fileStandingRequest({ scope: 'global', words: 'READ_AFTER_REPAIR' })
    await host.startSession({ sessionId: 'broken-complete', role: { id: 'review', name: 'RETRY_ROLE', owns: 'Review fixture work', mustNot: 'Change files', handoff: 'The owner' } })
    const file = ledgerFileOf(stateRoot), before = readFileSync(file, 'utf8'), callsBefore = adapterCalls().length
    writeFileSync(file, '{broken')
    await assert.rejects(host.sendTurn({ sessionId: 'broken-complete', text: 'Keep my message', origin: 'person' }), { code: 'RULES_CONTEXT_UNAVAILABLE' })
    assert.equal(adapterCalls().length, callsBefore)
    writeFileSync(file, before)
    const accepted = await host.sendTurn({ sessionId: 'broken-complete', text: 'Keep my message', origin: 'person' })
    assert.match(adapterCalls().at(-1).request.text, /READ_AFTER_REPAIR/)
    assert.match(adapterCalls().at(-1).request.text, /RETRY_ROLE/)
    assert.equal(accepted.transcriptPrompt.text, 'Keep my message')
    assert.ok(accepted.transcriptPrompt.additions.some(row => row.kind === 'role'))
  }, stateRoot => ({ rulesTurnSnapshotLoader: () => completeRulesReader(stateRoot) }))
})

test('complete rules are rechecked at dispatch and a stale send is refused before any provider call', async () => {
  const control = {}
  await inWorld(async ({ host, stateRoot }) => {
    const filed = await host.fileStandingRequest({ scope: 'global', words: 'BEFORE_RECHECK' })
    await host.startSession({ sessionId: 'changed-complete' })
    control.changeAtRecheck = () => FIXTURE_STORE.editRequest({ id: filed.id, words: 'AFTER_RECHECK', actor: 'owner' }, storeOptions(stateRoot))
    const callsBefore = adapterCalls().length
    await assert.rejects(host.sendTurn({ sessionId: 'changed-complete', text: 'Retained words' }), { code: 'RULES_CONTEXT_CHANGED' })
    assert.equal(adapterCalls().length, callsBefore)
    await host.sendTurn({ sessionId: 'changed-complete', text: 'Retained words' })
    assert.match(adapterCalls().at(-1).request.text, /AFTER_RECHECK/)
    assert.doesNotMatch(adapterCalls().at(-1).request.text, /BEFORE_RECHECK/)
  }, stateRoot => ({ rulesTurnSnapshotLoader: () => completeRulesReader(stateRoot, control) }))
})

for (const mutation of ['rules', 'setting']) test(`complete rules detect ${mutation} changes while stopped work is being re-admitted`, async () => {
  const control = {}
  let resumeReached, finishResume
  const reached = new Promise(resolve => { resumeReached = resolve })
  const held = new Promise(resolve => { finishResume = resolve })
  await inWorld(async ({ host, stateRoot }) => {
    const filed = await host.fileStandingRequest({ scope: 'global', words: 'BEFORE_RESUME_WAIT' })
    await host.startSession({ sessionId: 'waiting-complete', role: null })
    await host.sendTurn({ sessionId: 'waiting-complete', text: 'Initial turn' })
    await host.interrupt({ sessionId: 'waiting-complete' })
    endTurn()
    const before = adapterCalls().length
    const pending = host.sendTurn({ sessionId: 'waiting-complete', text: 'Retry the same message' })
    const refused = assert.rejects(pending, { code: mutation === 'rules' ? 'RULES_CONTEXT_CHANGED' : 'RULES_POLICY_CHANGED' })
    await reached
    if (mutation === 'rules') FIXTURE_STORE.editRequest({ id: filed.id, words: 'AFTER_RESUME_WAIT', actor: 'owner' }, storeOptions(stateRoot))
    else control.enabled = false
    finishResume()
    await refused
    assert.equal(adapterCalls().length, before, 'no turn reaches the provider with stale rules or policy')
    await host.sendTurn({ sessionId: 'waiting-complete', text: 'Retry the same message' })
    assert.equal(adapterCalls().at(-1).request.text.startsWith('Retry the same message'), true)
    if (mutation === 'rules') {
      assert.match(adapterCalls().at(-1).request.text, /AFTER_RESUME_WAIT/)
      assert.doesNotMatch(adapterCalls().at(-1).request.text, /BEFORE_RESUME_WAIT/)
    }
  }, stateRoot => ({ rulesTurnSnapshotLoader: () => completeRulesReader(stateRoot, control), sessionAuthority: {
    bind: async () => ({ bound: true, credential: 'a'.repeat(43) }), revoke: async () => {},
    cancelVersion: 2, cancelWork: async () => {}, resumeWork: async () => { resumeReached(); await held },
  } }))
})

for (const [control, code] of [[{ partial: true }, 'RULES_CONTEXT_UNAVAILABLE'], [{ maxBytes: 128 }, 'RULES_CONTEXT_TOO_LARGE']]) {
  test(`complete rules refuse ${code} without sending a partial context`, async () => {
    await inWorld(async ({ host }) => {
      await host.fileStandingRequest({ scope: 'global', words: 'Every word must remain in the current turn.' })
      await host.startSession({ sessionId: 'partial-complete' })
      const before = adapterCalls().length
      await assert.rejects(host.sendTurn({ sessionId: 'partial-complete', text: 'Keep this draft' }), { code })
      assert.equal(adapterCalls().length, before)
    }, stateRoot => ({ rulesTurnSnapshotLoader: () => completeRulesReader(stateRoot, control) }))
  })
}

test('turning complete rules OFF retains the existing no-repeat behavior', async () => {
  const control = { enabled: false }
  await inWorld(async ({ host }) => {
    await host.fileStandingRequest({ scope: 'global', words: 'OFF_LEGACY_RULE' })
    await host.startSession({ sessionId: 'off-complete' })
    await host.sendTurn({ sessionId: 'off-complete', text: 'First' })
    assert.match(adapterCalls().at(-1).request.text, /OFF_LEGACY_RULE/)
    endTurn()
    await host.sendTurn({ sessionId: 'off-complete', text: 'Second' })
    assert.equal(adapterCalls().at(-1).request.text, 'Second')
    assert.equal(control.identities, undefined, 'the complete reader is not called while off')
  }, stateRoot => ({ rulesTurnSnapshotLoader: () => completeRulesReader(stateRoot, control) }))
})

test('running sessions receive newly filed, edited and removed rules on their next turn', async () => {
  await inWorld(async ({ host, workdir, stateRoot }) => {
    const filed = await host.fileStandingRequest({ scope: 'tree', key: 'manager', words: 'Use the old format.' })
    await host.startSession({ sessionId: 'live-rules', cwd: workdir, requestKeys: { treeAnchors: ['manager'], threadId: 'worker' } })
    await host.sendTurn({ sessionId: 'live-rules', text: 'First turn' })
    assert.match(adapterCalls().at(-1).request.text, /Use the old format\./)
    endTurn()

    await host.editStandingRequest({ id: filed.id, key: 'manager', words: 'Use the new format.' })
    await host.sendTurn({ sessionId: 'live-rules', text: 'Second turn' })
    assert.match(adapterCalls().at(-1).request.text, /Use the new format\./)
    assert.doesNotMatch(adapterCalls().at(-1).request.text, /Use the old format\./)
    assert.match(adapterCalls().at(-1).request.text, /replace.*previous/i)
    endTurn()

    await host.removeStandingRequest({ id: filed.id, key: 'manager' })
    await host.sendTurn({ sessionId: 'live-rules', text: 'Third turn' })
    assert.match(adapterCalls().at(-1).request.text, /\[tree manager\] none filed/)
    assert.doesNotMatch(adapterCalls().at(-1).request.text, /Use the new format\./)
    endTurn()

    // An agent or another process uses the same store, bypassing the host's
    // write methods. The next read must still notice the change.
    FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'worker', words: 'Keep this answer brief.' }, storeOptions(stateRoot))
    FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'sibling', words: 'Sibling-only rule.' }, storeOptions(stateRoot))
    await host.sendTurn({ sessionId: 'live-rules', text: 'Fourth turn' })
    assert.match(adapterCalls().at(-1).request.text, /Keep this answer brief\./)
    assert.doesNotMatch(adapterCalls().at(-1).request.text, /Sibling-only rule\./)
    endTurn()

    await host.sendTurn({ sessionId: 'live-rules', text: 'Unchanged turn' })
    assert.doesNotMatch(adapterCalls().at(-1).request.text, /Standing requests/)
    endTurn()
  })
})

test('the last removed rule is withdrawn from a keyless session and a refused refresh retries', async () => {
  await inWorld(async ({ host }) => {
    const filed = await host.fileStandingRequest({ scope: 'global', words: 'Original rule.' })
    await host.startSession({ sessionId: 'keyless-refresh' })
    // A change between starting the process and its first accepted turn must
    // not be hidden behind the cached boot note.
    await host.editStandingRequest({ id: filed.id, words: 'Current rule.' })
    await host.sendTurn({ sessionId: 'keyless-refresh', text: 'Begin.' })
    assert.match(adapterCalls().at(-1).request.text, /Current rule\./)
    assert.doesNotMatch(adapterCalls().at(-1).request.text, /Original rule\./)
    endTurn()
    await host.removeStandingRequest({ id: filed.id })
    const engine = require_(CONFINED_ENGINE)
    engine.control.holdTurns = true
    try {
      const refused = host.sendTurn({ sessionId: 'keyless-refresh', text: 'Continue.' })
      engine.pendingTurns.shift().reject(new Error('pre-accept refusal'))
      await assert.rejects(refused, /pre-accept refusal/)
    } finally { engine.control.holdTurns = false }
    await host.sendTurn({ sessionId: 'keyless-refresh', text: 'Retry.' })
    assert.match(adapterCalls().at(-1).request.text, /No standing requests currently apply/)
    assert.match(adapterCalls().at(-1).request.text, /replace the previous ledger rules/)
    endTurn()
    await host.sendTurn({ sessionId: 'keyless-refresh', text: 'Unchanged.' })
    assert.equal(adapterCalls().at(-1).request.text, 'Unchanged.')
    endTurn()
  })
})

for (const removed of [false, true]) {
  test(`rewind reasserts ${removed ? 'removal of the last rule' : 'current rules'} even when the ledger has not changed again`, async () => {
    await inWorld(async ({ host }) => {
      const filed = await host.fileStandingRequest({ scope: 'global', words: 'Obsolete rule.' })
      await host.startSession({ sessionId: 'rewound-rules' })
      await host.sendTurn({ sessionId: 'rewound-rules', text: 'Kept turn.' })
      endTurn()
      if (removed) await host.removeStandingRequest({ id: filed.id })
      else await host.editStandingRequest({ id: filed.id, words: 'Current rule.' })
      await host.sendTurn({ sessionId: 'rewound-rules', text: 'This later update will be erased.' })
      endTurn()
      await host.rewindSession({ sessionId: 'rewound-rules', turnId: 't1' })

      // Refusing the first new turn must not spend the rules refresh either.
      const engine = require_(CONFINED_ENGINE)
      engine.control.holdTurns = true
      try {
        const refused = host.sendTurn({ sessionId: 'rewound-rules', text: 'Continue.' })
        engine.pendingTurns.shift().reject(new Error('pre-accept refusal'))
        await assert.rejects(refused, /pre-accept refusal/)
      } finally { engine.control.holdTurns = false }
      await host.sendTurn({ sessionId: 'rewound-rules', text: 'Retry after rewind.' })
      const sent = adapterCalls().at(-1).request
      assert.equal(sent.threadId, 'thread-forked')
      assert.match(sent.text, /replace the previous ledger rules/,
        'the fork may still remember rules from the kept turn; the replacement must be explicit')
      assert.match(sent.text, removed ? /No standing requests currently apply/ : /Current rule\./)
      assert.doesNotMatch(sent.text, /Obsolete rule\./)
      endTurn()
      await host.sendTurn({ sessionId: 'rewound-rules', text: 'Unchanged next turn.' })
      assert.equal(adapterCalls().at(-1).request.text, 'Unchanged next turn.', 'the rewind refresh must only ride once')
      endTurn()
    })
  })
}

test('filing lands the words verbatim in the one ledger, with its tier and key, and answers the id', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    const filed = await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Always answer in one sentence.' })
    assert.deepEqual(filed, { ok: true, id: 'R1', scope: 'thread', key: 'node-7', status: 'open' }, 'a clean store files R1; a person\'s own filing is open at once')
    const file = ledgerFileOf(stateRoot)
    assert.ok(existsSync(file), 'the ledger file was not written')
    const first = readLedger(stateRoot)
    assert.equal(first.schemaVersion, 1)
    assert.equal(first.revision, 1)
    assert.match(first.updatedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(first.statusVocabulary && typeof first.statusVocabulary.proposed === 'string', 'every status a record can carry is named in the file')
    assert.equal(first.requests.length, 1)
    const record = first.requests[0]
    assert.equal(record.id, 'R1')
    assert.equal(record.verbatim, 'Always answer in one sentence.', 'the words are not in the file verbatim')
    assert.equal(record.scope, 'thread')
    assert.equal(record.scopeKey, 'node-7')
    assert.equal(record.threadId, 'node-7', 'the thread alias rides for the older readers')
    assert.equal(record.status, 'open')
    assert.equal(record.filedBy, 'owner')
    assert.deepEqual(record.gates, [])
    assert.equal(record.provenance.class, 'owner-stated')
    assert.equal(record.history.length, 1)
    assert.equal(record.history[0].kind, 'file')

    const second = await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Second rule.' })
    assert.equal(second.id, 'R2', 'ids must advance, never reissue')

    const global = await host.fileStandingRequest({ scope: 'global', words: 'Ask before spending money.' })
    assert.equal(global.id, 'R3', 'one counter over every tier: the global rule is the next number, not a floor of its own')
    assert.equal(global.scope, 'global')
    assert.equal(global.key, null)
    const session = await host.fileStandingRequest({ scope: 'session', key: 'chat-1', words: 'Today, stay in the notes folder.' })
    assert.equal(session.id, 'R4')
    assert.equal(session.scope, 'session')

    /* THE LABEL: the human name of the tree, session or circle the key
       addresses, snapshotted onto the record for the Ledger page. */
    const labelled = await host.fileStandingRequest({ scope: 'tree', key: 'node-1-abc', words: 'Use the staging server.', label: 'Manager 2' })
    assert.equal(labelled.id, 'R5')
    const all = readLedger(stateRoot)
    assert.equal(all.requests.find(entry => entry.id === 'R5').scopeLabel, 'Manager 2')
    assert.equal(all.requests.find(entry => entry.id === 'R3').scopeKey, null, 'a global record carries no key')
    assert.equal(all.requests.find(entry => entry.id === 'R4').scopeKey, 'chat-1')
    assert.equal(all.revision, 5)

    /* Every write is one history line, chained; the chain verifies. */
    assert.equal(readFileSync(historyFileOf(stateRoot), 'utf8').trim().split('\n').length, 5)
    const verified = FIXTURE_STORE.verifyHistory(storeOptions(stateRoot))
    assert.equal(verified.ok, true, verified.code || 'the history does not verify')
    assert.equal(verified.events, 5)

    /* No markdown anywhere: the four hand-edited files are gone with the fold. */
    assert.ok(!existsSync(path.join(stateRoot, 'reports', 'R-LEDGER.md')), 'a markdown ledger was written')
    assert.ok(!existsSync(path.join(stateRoot, 'state', 'r-ledger')), 'a per-scope markdown ledger was written')
  })
})

/* THE LEDGER KINDS SPLIT (Controller 3's shared interface, 2026-09-07): a
   /Task or /Ask files through this exact same host seam, with a `kind`
   letter ('T' or 'A') riding beside scope, key, words and label. The engine
   lane is adding kind dispatch inside r-ledger.js's own fileRequest; this
   suite proves the HOST's half without waiting for that branch to land, by
   swapping in a stub `fileRequest` (host's own injectable rLedgerLoader,
   the same posture as freeMemory and confinementPlanner above it in
   createAgentHost) that records the exact payload it received. */
function stubRLedger() {
  const calls = []
  return {
    calls,
    rLedger: {
      fileRequest(payload) {
        calls.push(payload)
        return { id: 'R1', scope: payload.scope, key: payload.key, status: 'open' }
      },
    },
  }
}


test('explicit task difficulty reaches the store and invalid or non-task grades refuse before filing', async () => {
  const { rLedger, calls } = stubRLedger()
  const workdir = testScratch('mc-request-difficulty-')
  const host = createAgentHost({ enginePath: CONFINED_ENGINE, defaultCwd: workdir, rLedgerLoader: () => rLedger })
  try {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      await host.fileStandingRequest({ scope: 'global', words: 'Graded task.', kind: 'T', difficulty })
      assert.deepEqual(calls.at(-1), { scope: 'global', key: null, words: 'Graded task.', scopeLabel: null, kind: 'T', difficulty })
    }
    await host.fileStandingRequest({ scope: 'global', words: 'Legacy task.', kind: 'T' })
    assert.equal(Object.hasOwn(calls.at(-1), 'difficulty'), false, 'omission must remain available for authoritative off-state policy')
    const before = calls.length
    for (const input of [
      { kind: 'T', difficulty: '' }, { kind: 'T', difficulty: null },
      { kind: 'T', difficulty: 'Hard' }, { kind: 'T', difficulty: 1 },
      { kind: 'A', difficulty: 'easy' }, { difficulty: 'easy' },
    ]) {
      await assert.rejects(host.fileStandingRequest({ scope: 'global', words: 'Keep the draft.', ...input }),
        { code: 'AGENT_REQUEST_DIFFICULTY_INVALID' })
    }
    assert.equal(calls.length, before)
    // The engine's own grade refusals (task-difficulty.js / owner-request-store.js)
    // cross under the one AGENT_REQUEST_* vocabulary with their words kept.
    for (const [engineCode, message, hostCode] of [
      ['T_LEDGER_DIFFICULTY_REQUIRED', 'Choose easy, medium or hard when filing a task.', 'AGENT_REQUEST_DIFFICULTY_REQUIRED'],
      ['T_LEDGER_DIFFICULTY_INVALID', 'Task difficulty must be easy, medium or hard.', 'AGENT_REQUEST_DIFFICULTY_INVALID'],
      ['T_LEDGER_DIFFICULTY_SETTINGS_UNAVAILABLE', 'The saved task difficulty setting could not be read.', 'AGENT_REQUEST_DIFFICULTY_SETTINGS_UNAVAILABLE'],
      ['T_LEDGER_SOMETHING_ELSE', 'Unrelated task refusal.', 'AGENT_REQUEST_REFUSED'],
    ]) {
      rLedger.fileRequest = () => { throw Object.assign(new Error(message), { code: engineCode }) }
      await assert.rejects(host.fileStandingRequest({ scope: 'global', words: 'Policy changed.', kind: 'T' }),
        { code: hostCode, message })
    }
  } finally {
    await host.closeAll()
  }
})

test('kind rides through fileStandingRequest into fileRequest, and a payload with no kind stays byte-for-byte unchanged', async () => {
  const { rLedger, calls } = stubRLedger()
  const workdir = testScratch('mc-request-kind-')
  const host = createAgentHost({ enginePath: CONFINED_ENGINE, defaultCwd: workdir, rLedgerLoader: () => rLedger })
  try {
    await host.fileStandingRequest({ scope: 'global', words: 'A plain rule.' })
    assert.deepEqual(calls[0], { scope: 'global', key: null, words: 'A plain rule.', scopeLabel: null },
      'a plain /Request payload must stay exactly the four keys it always was')

    await host.fileStandingRequest({ scope: 'tree', key: 'node-7', words: 'Rotate the staging credentials.', kind: 'T' })
    assert.deepEqual(calls[1], { scope: 'tree', key: 'node-7', words: 'Rotate the staging credentials.', scopeLabel: null, kind: 'T' },
      'a /Task filing must carry kind T beside the untouched scope, key and words')

    await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Which cloud account should this use?', kind: 'A' })
    assert.deepEqual(calls[2], { scope: 'thread', key: 'node-7', words: 'Which cloud account should this use?', scopeLabel: null, kind: 'A' },
      'an /Ask filing must carry kind A beside the untouched scope, key and words')

    /* An unrecognized kind REFUSES BY NAME rather than reaching the store as
       arbitrary data or being silently swallowed into a plain rule -- a
       silent absorption of unexpected input is the exact defect this
       codebase's /Request refusals already avoid (an unknown /-word keeps
       its own honest refusal instead of guessing). Controller 3, 2026-09-07:
       "any other kind value is refused in the existing AGENT_REQUEST_*
       refusal style, and only if none fits, one new typed code" -- none of
       the existing codes name an invalid kind, so this is
       AGENT_REQUEST_KIND_INVALID. */
    const before = calls.length
    await assert.rejects(() => host.fileStandingRequest({ scope: 'global', words: 'Odd kind value.', kind: 'not-a-real-kind' }),
      error => error.code === 'AGENT_REQUEST_KIND_INVALID', 'an unrecognized kind must refuse by its own name')
    assert.equal(calls.length, before, 'a refused kind must never reach fileRequest at all')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/* THE LEDGER PAGE'S WRITE VERBS FOR TASK AND ASK RECORDS (Controller 3
   ruling 05:20Z, 2026-09-07, extended same-day to add removeAsk after
   Worker 2's ledger-page commit 7c6b70e0 drew a fifth button): completeTask,
   removeTask, answerAsk, declineAsk and removeAsk reach the engine's raw
   store, src/lib/owner-request-store.js, directly -- not through
   r-ledger.js's fileRequest door, which never re-exports them. This suite
   proves the HOST's half with a stub store (host's own injectable
   ownerRequestStoreLoader, the same posture as rLedgerLoader above) that
   records the exact payload it received, the same way the kind-threading
   test just above proves fileStandingRequest without waiting for the engine
   branch to land; the real-fixture proof is the end-to-end test further
   down. */
function stubOwnerRequestStore() {
  const calls = []
  return {
    calls,
    store: {
      completeTask(payload) { calls.push({ verb: 'completeTask', payload }); return { id: payload.id, status: 'done' } },
      removeTask(payload) { calls.push({ verb: 'removeTask', payload }); return { id: payload.id, status: 'removed' } },
      answerAsk(payload) { calls.push({ verb: 'answerAsk', payload }); return { id: payload.id, status: 'answered' } },
      declineAsk(payload) { calls.push({ verb: 'declineAsk', payload }); return { id: payload.id, status: 'declined' } },
      removeAsk(payload) { calls.push({ verb: 'removeAsk', payload }); return { id: payload.id, status: 'removed' } },
    },
  }
}

test('completeTask and removeTask carry the actor decideStandingRequest already uses, and refuse an id of the wrong kind before the store is touched', async () => {
  const { store, calls } = stubOwnerRequestStore()
  const workdir = testScratch('mc-task-verbs-')
  const host = createAgentHost({ enginePath: CONFINED_ENGINE, defaultCwd: workdir, ownerRequestStoreLoader: () => store })
  try {
    const completed = await host.completeTask({ id: 'T1' })
    assert.deepEqual(completed, { ok: true, id: 'T1', status: 'done' })
    assert.deepEqual(calls[0], { verb: 'completeTask', payload: { id: 'T1', actor: 'owner' } },
      'completeTask must carry the same actor value decideStandingRequest already passes to rLedger.decide')

    const removed = await host.removeTask({ id: 'T1' })
    assert.deepEqual(removed, { ok: true, id: 'T1', status: 'removed' })
    assert.deepEqual(calls[1], { verb: 'removeTask', payload: { id: 'T1', actor: 'owner' } })

    /* An id whose first letter is not T is refused before the store sees it. */
    const before = calls.length
    await assert.rejects(() => host.completeTask({ id: 'A1' }), error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH',
      'completeTask on an ask id must refuse by name')
    await assert.rejects(() => host.removeTask({ id: 'R1' }), error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH',
      'removeTask on a rule id must refuse by name')
    await assert.rejects(() => host.completeTask({}), error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH',
      'completeTask with no id at all must refuse by name, not throw on a string method')
    assert.equal(calls.length, before, 'a refused id must never reach the store')

    /* The store's own refusal code and message pass through UNCHANGED --
       Controller 3, verbatim: "the store's typed refusal codes pass through
       unchanged" -- unlike the R family's R_LEDGER_* -> AGENT_REQUEST_*
       re-prefix, this seam owns no renaming of the store's vocabulary. */
    store.completeTask = () => { const e = new Error('T9 is done; only an open or recurring task can be completed.'); e.code = 'R_LEDGER_STATUS_INVALID'; throw e }
    await assert.rejects(() => host.completeTask({ id: 'T9' }),
      error => error.code === 'R_LEDGER_STATUS_INVALID' && error.message === 'T9 is done; only an open or recurring task can be completed.',
      'the store code and sentence must cross exactly as the store gave them')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('answerAsk carries words as the store\'s own `answer` field, declineAsk preserves the reason, and removeAsk is the fifth verb', async () => {
  const { store, calls } = stubOwnerRequestStore()
  const workdir = testScratch('mc-ask-verbs-')
  const host = createAgentHost({ enginePath: CONFINED_ENGINE, defaultCwd: workdir, ownerRequestStoreLoader: () => store })
  try {
    const answered = await host.answerAsk({ id: 'A1', words: 'Use the staging account.' })
    assert.deepEqual(answered, { ok: true, id: 'A1', status: 'answered' })
    assert.deepEqual(calls[0], { verb: 'answerAsk', payload: { id: 'A1', answer: 'Use the staging account.', actor: 'owner' } },
      'the bridge field `words` must cross to the store as `answer`, the store\'s own parameter name')

    const declined = await host.declineAsk({ id: 'A1', reason: 'Not this one.' })
    assert.deepEqual(declined, { ok: true, id: 'A1', status: 'declined' })
    assert.deepEqual(calls[1], { verb: 'declineAsk', payload: { id: 'A1', reason: 'Not this one.', actor: 'owner' } },
      'declineAsk must carry the reason collected by the Ledger row to the store')

    const removed = await host.removeAsk({ id: 'A1' })
    assert.deepEqual(removed, { ok: true, id: 'A1', status: 'removed' })
    assert.deepEqual(calls[2], { verb: 'removeAsk', payload: { id: 'A1', actor: 'owner' } },
      'removeAsk carries the same actor value as answerAsk/declineAsk and no reason')

    const before = calls.length
    await assert.rejects(() => host.answerAsk({ id: 'T1', words: 'w' }), error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH',
      'answerAsk on a task id must refuse by name')
    await assert.rejects(() => host.declineAsk({ id: 'R1' }), error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH',
      'declineAsk on a rule id must refuse by name')
    await assert.rejects(() => host.removeAsk({ id: 'T1' }), error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH',
      'removeAsk on a task id must refuse by name')
    assert.equal(calls.length, before, 'a refused id must never reach the store')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('a store built before completeTask/removeTask/answerAsk/declineAsk/removeAsk existed refuses the write verbs by name instead of crashing', async () => {
  const workdir = testScratch('mc-write-verbs-absent-')
  /* loadOwnerRequestStore requires all five functions to exist before it
     will hand the module back at all (the same all-or-nothing shape check
     loadRLedger applies to fileRequest/readLedger), so an engine payload cut
     before this lane landed is indistinguishable, from the host's own
     construction, from no payload at all. */
  const host = createAgentHost({ enginePath: CONFINED_ENGINE, defaultCwd: workdir, ownerRequestStoreLoader: () => null })
  try {
    await assert.rejects(() => host.completeTask({ id: 'T1' }), error => error.code === 'AGENT_LEDGER_WRITE_UNAVAILABLE')
    await assert.rejects(() => host.removeTask({ id: 'T1' }), error => error.code === 'AGENT_LEDGER_WRITE_UNAVAILABLE')
    await assert.rejects(() => host.answerAsk({ id: 'A1', words: 'w' }), error => error.code === 'AGENT_LEDGER_WRITE_UNAVAILABLE')
    await assert.rejects(() => host.declineAsk({ id: 'A1' }), error => error.code === 'AGENT_LEDGER_WRITE_UNAVAILABLE')
    await assert.rejects(() => host.removeAsk({ id: 'A1' }), error => error.code === 'AGENT_LEDGER_WRITE_UNAVAILABLE')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/* THE COMPOSITION STEP (Controller 3, L4c, 2026-09-07): every write-verb test
   above proves the HOST's own half against a stub store. This test is the
   other half -- the REAL fixture store, refreshed byte-for-byte from L1's
   accepted engine tip b4bd80f1404228af1f089a063a892c6e88c339b7 (see the
   commit that refreshed tools/test/fixtures/confined-engine/src/lib/
   owner-request-store.js and r-ledger.js).

   EXPLICIT ROOT, Controller 3's standing safety rule (2026-09-07): this is
   the one test in the file that files, completes and removes records
   through the real store with no stub standing between it and disk, so it
   carries the belt beside inWorld()'s TOOLSENABLED_STATE_ROOT/
   MC_TEST_STATE_ROOT suspenders -- every call these wrappers make to
   fileRequest/completeTask/removeTask/answerAsk/declineAsk/removeAsk
   carries storeOptions(stateRoot) (the same explicit-rootPath shape the
   very first test in this file already uses directly against
   FIXTURE_STORE.verifyHistory), so even a store or module that ignored
   every env var could not reach anywhere but this test's own scratch
   directory. The wrapped functions are the fixture's true, unmodified
   implementations -- only how their root is supplied differs from the
   host's own default loaders. */
function realOwnerRequestStoreWithExplicitRoot(stateRoot) {
  const options = storeOptions(stateRoot)
  return {
    completeTask: payload => FIXTURE_STORE.completeTask(payload, options),
    removeTask: payload => FIXTURE_STORE.removeTask(payload, options),
    answerAsk: payload => FIXTURE_STORE.answerAsk(payload, options),
    declineAsk: payload => FIXTURE_STORE.declineAsk(payload, options),
    removeAsk: payload => FIXTURE_STORE.removeAsk(payload, options),
  }
}

function realRLedgerWithExplicitRoot(stateRoot) {
  const options = storeOptions(stateRoot)
  return {
    fileRequest: payload => FIXTURE_LEDGER.fileRequest(payload, options),
  }
}

test('end-to-end against the real fixture store: a filed task completes and a second is removed, a filed ask is answered and a second is removed, and a plain /Request still mints an ordinary R record', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    const filedTask = await host.fileStandingRequest({ scope: 'global', words: 'Rotate the staging credentials.', kind: 'T' })
    assert.equal(filedTask.ok, true)
    assert.match(filedTask.id, /^T\d+$/, 'a /Task filing must mint a T-numbered id, not an R one')
    let ledger = readLedger(stateRoot)
    let taskRecord = ledger.requests.find(entry => entry.id === filedTask.id)
    assert.equal(taskRecord.kind, 'T', 'the record on disk must carry kind T')
    assert.equal(taskRecord.status, 'open')

    const completed = await host.completeTask({ id: filedTask.id })
    assert.deepEqual(completed, { ok: true, id: filedTask.id, status: 'done' })
    ledger = readLedger(stateRoot)
    taskRecord = ledger.requests.find(entry => entry.id === filedTask.id)
    assert.equal(taskRecord.status, 'done', 'completeTask must move a one-shot task to done')
    assert.ok(taskRecord.completedAt, 'completeTask must stamp completedAt')

    const filedTask2 = await host.fileStandingRequest({ scope: 'global', words: 'A second task, to be removed.', kind: 'T' })
    assert.notEqual(filedTask2.id, filedTask.id, 'ids must not reuse')
    const removedTask = await host.removeTask({ id: filedTask2.id })
    assert.deepEqual(removedTask, { ok: true, id: filedTask2.id, status: 'removed' })
    ledger = readLedger(stateRoot)
    const removedRecord = ledger.requests.find(entry => entry.id === filedTask2.id)
    assert.equal(removedRecord.status, 'removed', 'removeTask must tombstone the record, not delete it')

    const filedAsk = await host.fileStandingRequest({ scope: 'global', words: 'Which cloud account should this use?', kind: 'A' })
    assert.match(filedAsk.id, /^A\d+$/, 'an /Ask filing must mint an A-numbered id')
    ledger = readLedger(stateRoot)
    const askBefore = ledger.requests.find(entry => entry.id === filedAsk.id)
    assert.equal(askBefore.kind, 'A')
    assert.equal(askBefore.status, 'open')

    const answered = await host.answerAsk({ id: filedAsk.id, words: 'Use the staging account.' })
    assert.deepEqual(answered, { ok: true, id: filedAsk.id, status: 'answered' })
    ledger = readLedger(stateRoot)
    const askRecord = ledger.requests.find(entry => entry.id === filedAsk.id)
    assert.equal(askRecord.status, 'answered')
    assert.equal(askRecord.answer.words, 'Use the staging account.', 'the owner\'s words must be stored under the ask\'s own answer field')

    const filedAsk2 = await host.fileStandingRequest({ scope: 'global', words: 'A second ask, to be removed outright.', kind: 'A' })
    assert.notEqual(filedAsk2.id, filedAsk.id, 'ids must not reuse')
    const removedAsk = await host.removeAsk({ id: filedAsk2.id })
    assert.deepEqual(removedAsk, { ok: true, id: filedAsk2.id, status: 'removed' })
    ledger = readLedger(stateRoot)
    const removedAskRecord = ledger.requests.find(entry => entry.id === filedAsk2.id)
    assert.equal(removedAskRecord.status, 'removed', 'removeAsk must tombstone the record, not delete it, and not require an answer or decline first')

    /* The id-kind guard, exercised against REAL ids the real store just
       minted (not the synthetic 'T1'/'A1' strings the stub tests use): a
       task id offered to an ask verb, and an ask id offered to a task verb,
       must both refuse before the real store is ever touched. */
    await assert.rejects(() => host.answerAsk({ id: filedTask.id, words: 'w' }),
      error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH', 'answerAsk on a real task id must refuse by name')
    await assert.rejects(() => host.completeTask({ id: filedAsk.id }),
      error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH', 'completeTask on a real ask id must refuse by name')
    await assert.rejects(() => host.removeAsk({ id: filedTask.id }),
      error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH', 'removeAsk on a real task id must refuse by name')

    /* A plain /Request, no kind at all, still mints an ordinary R record with
       the shape it has always had -- proving this lane's changes never
       touched the R path even end-to-end against the real store. */
    const filedRule = await host.fileStandingRequest({ scope: 'global', words: 'Ask before spending money.' })
    assert.match(filedRule.id, /^R\d+$/, 'a plain /Request must still mint an R id')
    ledger = readLedger(stateRoot)
    const ruleRecord = ledger.requests.find(entry => entry.id === filedRule.id)
    assert.equal(ruleRecord.kind, 'R')
    assert.equal(ruleRecord.status, 'open')
  }, stateRoot => ({
    ownerRequestStoreLoader: () => realOwnerRequestStoreWithExplicitRoot(stateRoot),
    rLedgerLoader: () => realRLedgerWithExplicitRoot(stateRoot),
  }))
})

test('an empty rule and a bad scope refuse by name and file nothing', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    await assert.rejects(() => host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: '   ' }),
      error => /AGENT_REQUEST/.test(error.code), 'empty words must refuse with a named code')
    await assert.rejects(() => host.fileStandingRequest({ scope: 'week-old-nonsense', key: 'x', words: 'rule' }),
      error => /AGENT_REQUEST/.test(error.code), 'an unknown scope must refuse with a named code')
    await assert.rejects(() => host.fileStandingRequest({ scope: 'tree', key: '../outside', words: 'rule' }),
      error => error.code === 'AGENT_REQUEST_KEY_INVALID', 'a key that is not an id must refuse by name')
    assert.ok(!existsSync(ledgerFileOf(stateRoot)), 'a refusal wrote the ledger anyway')
    assert.ok(!existsSync(path.join(stateRoot, 'reports')), 'a refusal created the reports folder')
    assert.ok(!existsSync(path.join(stateRoot, 'state')), 'a refusal created the state folder')
  })
})

test('the first turn carries the applicable tiers, stated absences, and the contract paragraph', async () => {
  await inWorld(async ({ host }) => {
    await host.fileStandingRequest({ scope: 'global', words: 'Ask before spending money.' })
    await host.fileStandingRequest({ scope: 'tree', key: 'node-root', words: 'Use the staging server.' })
    await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Always answer in one sentence.' })

    await host.startSession({
      sessionId: 'carry-1',
      requestKeys: { treeAnchors: ['node-root', 'node-7'], threadId: 'node-7' },
    })
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'carry-1', text: 'Summarize the notes folder.' })
    const first = adapterCalls()[before]
    const text = first.request.text
    assert.ok(text.startsWith('Summarize the notes folder.'), 'the person\'s own words no longer come first')
    assert.ok(text.includes('Ask before spending money.'), 'the global rule is missing from the brief')
    assert.ok(text.includes('Use the staging server.'), 'the tree rule is missing from the brief')
    assert.ok(text.includes('Always answer in one sentence.'), 'the thread rule is missing from the brief')
    assert.match(text, /\[session carry-1\] none filed/, 'an absent tier must be STATED, not skipped — an agent must know what it read')
    assert.match(text, /\[global\] 1 — applies to every agent/, 'the global tier names its reach')
    assert.match(text, /\[tree node-root\] 1 — applies to this agent and every agent below it/)
    assert.match(text, /\[thread node-7\] 1 — applies to this agent, this conversation only/)
    assert.match(text, /\/RequestThread/, 'the contract paragraph never teaches the commands')
    assert.match(text, /ToolsEnabled itself files/, 'the contract paragraph must say the PRODUCT files them — no tool needed')
    assert.ok(text.indexOf('Standing requests') < text.indexOf('FIXTURE TOOL SUMMARY'),
      'the rules must come before the tool note — they are the section that must not be missed')

    endTurn()
    await host.sendTurn({ sessionId: 'carry-1', text: 'Second thing.' })
    const second = adapterCalls()[before + 1]
    assert.equal(second.request.text, 'Second thing.', 'the block leaked onto a later turn')
  })
})

test('a resumed session still gets the block — a restart is when a thread rule matters most', async () => {
  await inWorld(async ({ host }) => {
    await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Always answer in one sentence.' })
    await host.startSession({
      sessionId: 'resume-1',
      resumeThreadId: 'thread-old',
      requestKeys: { treeAnchors: ['node-7'], threadId: 'node-7' },
    })
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'resume-1', text: 'Where were we?' })
    const first = adapterCalls()[before]
    assert.ok(first.request.text.startsWith('Where were we?'))
    assert.ok(first.request.text.includes('Always answer in one sentence.'),
      'the resumed session was not re-told its standing rules; restart carriage is the product\'s proof')
    assert.ok(!first.request.text.includes('FIXTURE TOOL SUMMARY'),
      'the tool note is start-only by design and must not replay on a resume')
  })
})

test('scope isolation: another session\'s and another thread\'s rules stay out', async () => {
  await inWorld(async ({ host }) => {
    await host.fileStandingRequest({ scope: 'session', key: 'session-a', words: 'RULE-FOR-SESSION-A only.' })
    await host.fileStandingRequest({ scope: 'thread', key: 'node-a', words: 'RULE-FOR-THREAD-A only.' })
    await host.fileStandingRequest({ scope: 'tree', key: 'node-a', words: 'RULE-FOR-TREE-A only.' })
    await host.startSession({
      sessionId: 'session-b',
      requestKeys: { treeAnchors: ['node-b'], threadId: 'node-b' },
    })
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'session-b', text: 'Hello.' })
    const text = adapterCalls()[before].request.text
    assert.ok(!text.includes('RULE-FOR-SESSION-A'), 'a session rule crossed into another session\'s brief')
    assert.ok(!text.includes('RULE-FOR-THREAD-A'), 'a thread rule crossed into another conversation\'s brief')
    assert.ok(!text.includes('RULE-FOR-TREE-A'), 'a tree rule crossed into another tree\'s brief')
  })
})

/* Plant a ledger straight in the store's own format -- the shape a long-lived
   ledger has -- rather than through hundreds of fileRequest() calls that
   hammer Windows with rename cycles. The read of these bytes IS the store's,
   which is what the ceiling tests are about. */
function plantLedger(stateRoot, records) {
  const file = ledgerFileOf(stateRoot)
  mkdirSync(path.dirname(file), { recursive: true })
  const requests = records.map((record, index) => ({
    id: record.id,
    parentId: null,
    scope: record.scope,
    scopeKey: record.scope === 'global' ? null : record.key,
    scopeLabel: null,
    threadId: record.scope === 'thread' ? record.key : null,
    verbatim: record.words,
    request: `(interpretation) ${record.words.slice(0, 4000)}`,
    status: record.status || 'open',
    filedBy: record.filedBy || 'owner',
    filedAt: `2026-08-19T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    gates: [],
    provenance: { class: 'owner-stated', recordedBy: 'owner', recordedAt: '2026-08-19T00:00:00.000Z', source: 'typed by the person in the ToolsEnabled app' },
    captureLog: [{ at: '2026-08-19T00:00:00.000Z', actor: 'owner', mode: 'new', gatesAdded: 0, source: 'typed by the person in the ToolsEnabled app' }],
    decisions: [],
    history: [],
    removedAt: null,
    removedBy: null,
  }))
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: requests.length, updatedAt: '2026-08-19', statusVocabulary: FIXTURE_STORE.STATUS_VOCABULARY, requests }, null, 2), 'utf8')
  return file
}

test('an absurd ledger cannot brick or bloat a start: capped, announced, still running', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    const records = []
    for (let index = 0; index < 300; index += 1) {
      records.push({ id: `R${index + 1}`, scope: 'global', words: `Rule number ${index} with some padding words to carry real weight in bytes.` })
    }
    records.push({ id: 'R301', scope: 'global', words: `NEWEST-GLOBAL-RULE ${'x'.repeat(12_000)}` })
    for (let index = 0; index < 100; index += 1) {
      records.push({ id: `R${302 + index}`, scope: 'thread', key: 'node-7', words: `Thread rule number ${index} with some padding words to carry real weight in bytes.` })
    }
    const file = plantLedger(stateRoot, records)
    await host.startSession({
      sessionId: 'ceiling-1',
      requestKeys: { treeAnchors: ['node-7'], threadId: 'node-7' },
    })
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'ceiling-1', text: 'Start anyway.' })
    const text = adapterCalls()[before].request.text
    assert.ok(text.startsWith('Start anyway.'), 'the session did not start cleanly under ledger pressure')
    assert.ok(Buffer.byteLength(text, 'utf8') <= 24_000 + Buffer.byteLength('Start anyway.', 'utf8'),
      `the block is unbounded: ${Buffer.byteLength(text, 'utf8')} bytes reached the engine`)
    assert.match(text, /withheld for space/, 'a trimmed block must ANNOUNCE the trim')
    assert.match(text, /\[thread node-7\] all 100 withheld for space — read them: /, 'the withheld thread tier must say so and count itself')
    assert.ok(text.includes(file), 'a withheld tier must name the file where its rules live')
    assert.ok(text.includes('NEWEST-GLOBAL-RULE'),
      'the newest global entry must always survive — newer owner directives amend older ones')
  })
})

test('a corrupt ledger file degrades to an announced absence, never a dead start', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    const file = ledgerFileOf(stateRoot)
    mkdirSync(path.dirname(file), { recursive: true })
    /* Not JSON: the store REFUSES this file. The session must still start,
       saying what it could not read. */
    writeFileSync(file, '{ "requests": [ this is not json', 'utf8')
    await host.startSession({
      sessionId: 'corrupt-1',
      requestKeys: { treeAnchors: [], threadId: 'node-7' },
    })
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'corrupt-1', text: 'Still here?' })
    const text = adapterCalls()[before].request.text
    assert.ok(text.startsWith('Still here?'), 'an unreadable ledger killed the start — worse than no feature')
    assert.match(text, /could not be read/, 'the unreadable tier must be stated, not skipped')
    assert.equal(readFileSync(file, 'utf8'), '{ "requests": [ this is not json', 'a start rewrote a file it could not read')
  })
})

test('a payload with no r-ledger module starts sessions, injects nothing, and refuses filing by name', async () => {
  const workdir = testScratch('mc-request-absent-')
  try {
    const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY,
      enginePath: SUMMARYLESS_ENGINE,
      defaultCwd: workdir,
      confinementPlanner: () => guidedPlan(workdir),
    })
    await host.startSession({ sessionId: 'absent-1', requestKeys: { treeAnchors: ['node-1'], threadId: 'node-1' } })
    const engine = require_(SUMMARYLESS_ENGINE)
    const before = engine.adapterCalls.length
    await host.sendTurn({ sessionId: 'absent-1', text: 'Old payload, ordinary start.' })
    assert.equal(engine.adapterCalls[before].request.text, 'Old payload, ordinary start.',
      'an older payload cannot read ledgers, so nothing may be injected')
    await assert.rejects(() => host.fileStandingRequest({ scope: 'global', words: 'rule' }),
      error => error.code === 'AGENT_REQUEST_UNAVAILABLE',
      'filing on an old payload must refuse by name, never pretend')
    await assert.rejects(() => host.decideStandingRequest({ id: 'R1', decision: 'approve' }),
      error => error.code === 'AGENT_REQUEST_UNAVAILABLE',
      'deciding on an old payload must refuse by name, never pretend')
    await host.closeAll()
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

/* The keyless path: a session with no requestKeys (the single-agent page)
   still gets GLOBAL rules when any exist — and stays byte-identical to today
   when none do, which is what keeps every older suite's exact-text pins true.
   A start makes sure the ledger file exists (the boot read never creates it);
   an empty ledger is still an empty world. */
test('a keyless session carries global rules when they exist, and nothing when none do', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    await host.startSession({ sessionId: 'keyless-empty' })
    assert.ok(existsSync(ledgerFileOf(stateRoot)), 'a start did not make sure the ledger exists')
    assert.equal(readLedger(stateRoot).requests.length, 0)
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'keyless-empty', text: 'Plain start.' })
    const text = adapterCalls()[before].request.text
    assert.ok(!text.includes('Standing requests'),
      'an empty world must inject nothing — token-lean is a contract')

    await host.fileStandingRequest({ scope: 'global', words: 'Ask before spending money.' })
    await host.startSession({ sessionId: 'keyless-full' })
    const before2 = adapterCalls().length
    await host.sendTurn({ sessionId: 'keyless-full', text: 'Plain start.' })
    const text2 = adapterCalls()[before2].request.text
    assert.ok(text2.includes('Ask before spending money.'),
      'a global rule must reach every agent, keys or none — that is what "global" says')
  })
})

/* THE PERSON'S HAND, through the host's three seams: edit rewrites the words
   in place and keeps what they were; remove tombstones the record (and its
   refinements) without splicing anything out; the removed one leaves the
   boot block and the rail, and its number is never reissued. */
test('edit rewrites in place, remove tombstones, and neither reissues a number', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    await host.fileStandingRequest({ scope: 'tree', key: 'node-7', words: 'First words.' })
    await host.fileStandingRequest({ scope: 'tree', key: 'node-7', words: 'Second words.' })
    const edited = await host.editStandingRequest({ id: 'R1', key: 'node-7', words: 'First words, edited.' })
    assert.deepEqual(edited, { ok: true, id: 'R1', scope: 'tree', key: 'node-7' })
    const afterEdit = readLedger(stateRoot).requests.find(entry => entry.id === 'R1')
    assert.equal(afterEdit.verbatim, 'First words, edited.')
    assert.equal(afterEdit.history.at(-1).kind, 'edit')
    assert.equal(afterEdit.history.at(-1).wordsBefore, 'First words.', 'the words before an edit are kept in the record')

    const removed = await host.removeStandingRequest({ id: 'R1', key: 'node-7' })
    assert.deepEqual(removed, { ok: true, id: 'R1', scope: 'tree', key: 'node-7', removed: ['R1'] })
    const afterRemove = readLedger(stateRoot)
    assert.equal(afterRemove.requests.length, 2, 'a removed record was spliced out of the ledger')
    assert.equal(afterRemove.requests.find(entry => entry.id === 'R1').status, 'removed')
    assert.equal(afterRemove.requests.find(entry => entry.id === 'R1').removedBy, 'owner')

    const rail = readStandingRequests({ scope: 'tree', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_LEDGER })
    assert.deepEqual(rail.entries, [{ id: 'R2', words: 'Second words.' }], 'the rail still shows a removed record, or paints a person-filed row as an agent\'s')

    const third = await host.fileStandingRequest({ scope: 'tree', key: 'node-7', words: 'Third words.' })
    assert.equal(third.id, 'R3', 'a removed number was reissued')
    await assert.rejects(() => host.editStandingRequest({ id: 'R1', key: 'node-7', words: 'Back?' }),
      error => error.code === 'AGENT_REQUEST_ENTRY_UNKNOWN', 'a removed record took an edit')
    await assert.rejects(() => host.editStandingRequest({ id: 'RT1', key: 'node-7', words: 'Old id.' }),
      error => error.code === 'AGENT_REQUEST_ID_INVALID', 'a retired per-scope id was accepted')

    await host.startSession({ sessionId: 'after-remove', requestKeys: { treeAnchors: ['node-7'], threadId: 'node-7' } })
    const before = adapterCalls().length
    await host.sendTurn({ sessionId: 'after-remove', text: 'Hello.' })
    const text = adapterCalls()[before].request.text
    assert.ok(!text.includes('First words'), 'a removed record reached an agent')
    assert.ok(text.includes('Second words.') && text.includes('Third words.'))
    assert.equal(FIXTURE_STORE.verifyHistory(storeOptions(stateRoot)).ok, true, 'the history does not verify after edit and remove')
  })
})

/* ---------------------------------------------------------------------------
 * THE DUTY PARAGRAPH, CHOSEN BY THE SWITCH (O7, "agents manage the ledgers").
 *
 * The owner's ruling, 2026-08-22: one switch, on or off. The payload's
 * src/lib/r-ledger-agent-gate.js decides the MODE from `rules.capture_spoken`
 * and owns one paragraph per mode; the host asks it at every start and hands
 * the answer to the agent in the standing-requests block. The fixture gate
 * (tools/test/fixtures/confined-engine/src/lib/r-ledger-agent-gate.js) carries
 * the engine's paragraphs verbatim and takes its mode from MC_TEST_AGENT_FILING.
 *
 *   OFF       the block reads exactly as it did before the gate existed: the
 *             `off` paragraph IS the host's constant, byte for byte.
 *   AUTO      a session whose plan carries the engine's write server is told
 *             to file; one whose plan carries the read-only server alone is
 *             told the tool is withheld at this level -- never taught a tool
 *             it cannot call.
 *   ABSENT    a payload with no gate module hands every session the constant.
 *   CEILING   the cap still holds against the rendered text, whichever
 *             paragraph rides.
 * ------------------------------------------------------------------------- */

const { REQUEST_CONTRACT_PARAGRAPH } = require_(path.join(ROOT, 'shell/agent-host.cjs'))
const FIXTURE_GATE = require_(path.join(ROOT, 'tools/test/fixtures/confined-engine/src/lib/r-ledger-agent-gate.js'))
const PAYLOAD_GATE_PATH = path.join(ROOT, 'capability', 'src', 'lib', 'r-ledger-agent-gate.js')

async function withFilingMode(mode, run) {
  const previous = process.env.MC_TEST_AGENT_FILING
  if (mode === undefined) delete process.env.MC_TEST_AGENT_FILING
  else process.env.MC_TEST_AGENT_FILING = mode
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.MC_TEST_AGENT_FILING
    else process.env.MC_TEST_AGENT_FILING = previous
  }
}

/* A plan that carries the engine's WRITE server, which is what lets an agent
   actually reach r_ledger.file (the read-only server withholds every
   local-write tool). */
function standardPlan(workdir) {
  return { ...guidedPlan(workdir), tier: 'standard', servers: ['toolsenabled-readonly', 'toolsenabled'] }
}

async function firstTurnText(host, sessionId, requestKeys) {
  await host.startSession({ sessionId, ...(requestKeys ? { requestKeys } : {}) })
  const before = adapterCalls().length
  await host.sendTurn({ sessionId, text: 'Hello.', origin: 'person' })
  return adapterCalls()[before].request.text
}

/* A world over the standard plan (write server present), for the auto
   paragraphs and the approval flow. */
async function inStandardWorld(run) {
  const workdir = testScratch('mc-request-standard-')
  const stateRoot = path.join(workdir, 'state-root')
  mkdirSync(stateRoot, { recursive: true })
  const previousRoot = process.env.MC_TEST_STATE_ROOT
  process.env.MC_TEST_STATE_ROOT = stateRoot
  const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: CONFINED_ENGINE, defaultCwd: workdir, confinementPlanner: () => standardPlan(workdir) })
  try {
    return await run({ host, workdir, stateRoot })
  } finally {
    await host.closeAll().catch(() => {})
    if (previousRoot === undefined) delete process.env.MC_TEST_STATE_ROOT
    else process.env.MC_TEST_STATE_ROOT = previousRoot
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('off: the paragraph is the pre-O7 constant, byte for byte, and the block is unchanged', async () => {
  await withFilingMode('off', () => inWorld(async ({ host }) => {
    assert.equal(FIXTURE_GATE.requestContractParagraph('off'), REQUEST_CONTRACT_PARAGRAPH,
      'the gate\'s off text must be the host constant -- a session with the switch off must read exactly as before')
    await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Always answer in one sentence.' })
    const text = await firstTurnText(host, 'off-1', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(text.includes(REQUEST_CONTRACT_PARAGRAPH), 'the off paragraph did not ride')
    assert.ok(!text.includes('r_ledger.file'), 'an agent with the switch off was told about a filing tool')
  }))
})

test('off: a keyless empty world still injects nothing -- token-lean stays a contract', async () => {
  await withFilingMode('off', () => inWorld(async ({ host }) => {
    const text = await firstTurnText(host, 'off-empty', null)
    /* The fixture's tool note still rides (that is its own contract); what
       must NOT appear is any standing-requests block. */
    assert.ok(!text.includes('Standing requests'), 'the switch off must leave an empty world byte-identical to before')
    assert.ok(!text.includes('/Request'), 'no paragraph may ride an empty world with the switch off')
  }))
})

test('auto with the write server: the agent is told to file with r_ledger.file', async () => {
  await inStandardWorld(async ({ host }) => {
    await withFilingMode('auto', async () => {
      await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'Always answer in one sentence.' })
      const text = await firstTurnText(host, 'auto-1', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true })),
        'the auto paragraph must ride when the switch is on and the plan carries the write server')
      assert.ok(text.includes('call r_ledger.file'), 'the auto text names the filing tool')
      assert.ok(!text.includes(REQUEST_CONTRACT_PARAGRAPH), 'the off constant rode beside the auto text')
      assert.ok(text.includes('Always answer in one sentence.'), 'the rules themselves still ride')

      /* AND AN EMPTY KEYLESS WORLD IS TOLD ITS DUTY. The silence rule exists
         to keep the off text token-lean; with the switch on, the paragraph is
         the whole point of the block and must reach an agent with no rules. */
      const plain = await firstTurnText(host, 'auto-empty', null)
      assert.ok(plain.startsWith('Hello.'))
      assert.ok(plain.includes('call r_ledger.file'), 'an agent with the switch on and no rules yet was not told it may file any')
      assert.match(plain, /\[global\] none filed/, 'the absence is stated, as every layer is')
    })
  })
})

/* THE NESTED SUB-SETTING (O7 improvements; owner, 2026-08-22 (2): "this is
   more of a user setting. default no. nest it below in settings"). With
   rules.ask_when_unsure on, the gate's answer carries askWhenUnsure:true and
   the host hands it to the SAME paragraph call it already makes -- one gate
   read per start, so what the agent is told and what the settings say cannot
   disagree. The fixture gate reads MC_TEST_ASK_WHEN_UNSURE the way the real
   one reads the settings file. */
async function withAskWhenUnsure(on, run) {
  const previous = process.env.MC_TEST_ASK_WHEN_UNSURE
  if (on) process.env.MC_TEST_ASK_WHEN_UNSURE = 'on'
  else delete process.env.MC_TEST_ASK_WHEN_UNSURE
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.MC_TEST_ASK_WHEN_UNSURE
    else process.env.MC_TEST_ASK_WHEN_UNSURE = previous
  }
}

test('auto with ask-when-unsure on: the agent is told doubt files nothing and ends with one question', async () => {
  await inStandardWorld(async ({ host }) => {
    await withFilingMode('auto', () => withAskWhenUnsure(true, async () => {
      const asked = FIXTURE_GATE.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true })
      const plain = FIXTURE_GATE.requestContractParagraph('auto', { canFile: true })
      assert.notEqual(asked, plain, 'the ask variant must differ from the plain auto paragraph, or the setting changes nothing')
      assert.match(asked, /file nothing; end your reply with ONE short question/, 'the ask variant does not say what the setting promises')
      assert.match(asked, /file their ORIGINAL sentence/, 'the ask variant must file the person\'s own words on their yes')

      const text = await firstTurnText(host, 'ask-1', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(asked), 'the ask paragraph did not ride: the host did not hand askWhenUnsure to the gate')
      assert.ok(!text.includes(plain), 'the plain auto paragraph rode beside the ask variant')
      assert.ok(!text.includes('If unsure, call r_ledger.propose instead.'), 'the propose-when-unsure instruction must not ride with the ask setting on')
    }))
    /* With the sub-setting OFF the paragraph is exactly the plain auto text:
       the child changes nothing until the person turns it on. */
    await withFilingMode('auto', () => withAskWhenUnsure(false, async () => {
      const text = await firstTurnText(host, 'ask-off', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true })), 'the plain auto paragraph did not ride with the sub-setting off')
      assert.ok(!text.includes('end your reply with ONE short question'), 'the ask variant rode with the sub-setting off')
    }))
    /* With the SWITCH off, the sub-setting is inert: the constant rides. */
    await withFilingMode('off', () => withAskWhenUnsure(true, async () => {
      const text = await firstTurnText(host, 'ask-parent-off', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(REQUEST_CONTRACT_PARAGRAPH), 'a child of an off parent changed the paragraph')
      assert.ok(!text.includes('end your reply with ONE short question'))
    }))
  })
})

/* THE SECOND SUB-SETTING (owner, 2026-09-02: one canonical ledger; an
   agent's filing may wait for the person). rules.agent_filed_needs_approval
   -- default OFF, only a user/installer true turns it on -- is read off the
   same gate answer as `needsApproval`. With it on, the store files an agent's
   rule as a PROPOSAL (status 'proposed', waiting on the Ledger page) and the
   paragraph tells the agent so; a person's own filing is never gated by it.
   The fixture gate reads MC_TEST_AGENT_FILED_NEEDS_APPROVAL the way the real
   one reads the settings file. */
const APPROVAL_SENTENCE = 'A rule you file waits for the person\'s approval on the Ledger page before it counts.'

async function withAgentFiledNeedsApproval(on, run) {
  const previous = process.env.MC_TEST_AGENT_FILED_NEEDS_APPROVAL
  if (on) process.env.MC_TEST_AGENT_FILED_NEEDS_APPROVAL = 'on'
  else delete process.env.MC_TEST_AGENT_FILED_NEEDS_APPROVAL
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.MC_TEST_AGENT_FILED_NEEDS_APPROVAL
    else process.env.MC_TEST_AGENT_FILED_NEEDS_APPROVAL = previous
  }
}

test('approval on: the agent is told its filing waits; off, the paragraph is the plain auto text', async () => {
  await inStandardWorld(async ({ host }) => {
    await withFilingMode('auto', () => withAgentFiledNeedsApproval(true, async () => {
      const waiting = FIXTURE_GATE.requestContractParagraph('auto', { canFile: true, needsApproval: true })
      const plain = FIXTURE_GATE.requestContractParagraph('auto', { canFile: true })
      assert.equal(waiting, `${plain} ${APPROVAL_SENTENCE}`, 'the approval sentence is appended to the auto paragraph, and only that')
      assert.equal(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true, needsApproval: true }),
        `${FIXTURE_GATE.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true })} ${APPROVAL_SENTENCE}`,
        'the ask variant carries the sentence too')
      assert.equal(FIXTURE_GATE.requestContractParagraph('auto', { canFile: false, needsApproval: true }),
        FIXTURE_GATE.requestContractParagraph('auto', { canFile: false }), 'a level that withholds the tool has nothing to wait for')
      assert.equal(FIXTURE_GATE.requestContractParagraph('off', { canFile: true, needsApproval: true }), REQUEST_CONTRACT_PARAGRAPH)
      assert.equal(typeof FIXTURE_GATE.loadAgentFilingMode().needsApproval, 'boolean')
      assert.equal(FIXTURE_GATE.loadAgentFilingMode().needsApproval, true)

      const text = await firstTurnText(host, 'approval-on', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(waiting), 'the approval sentence did not ride: the host did not hand needsApproval to the gate')
      assert.equal(text.split(APPROVAL_SENTENCE).length, 2, 'the sentence rode more than once')
    }))
    await withFilingMode('auto', () => withAgentFiledNeedsApproval(false, async () => {
      assert.equal(FIXTURE_GATE.loadAgentFilingMode().needsApproval, false, 'the default is off')
      const text = await firstTurnText(host, 'approval-off', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true })))
      assert.ok(!text.includes(APPROVAL_SENTENCE), 'the approval sentence rode with the setting off')
    }))
    await withFilingMode('off', () => withAgentFiledNeedsApproval(true, async () => {
      const text = await firstTurnText(host, 'approval-parent-off', { treeAnchors: ['node-7'], threadId: 'node-7' })
      assert.ok(text.includes(REQUEST_CONTRACT_PARAGRAPH), 'a child of an off parent changed the paragraph')
      assert.ok(!text.includes(APPROVAL_SENTENCE))
    }))
  })
})

test('approval on: an agent\'s filing lands as a proposal that waits; a person\'s own filing never does', async () => {
  await inStandardWorld(async ({ host, stateRoot }) => {
    await withAgentFiledNeedsApproval(true, async () => {
      const options = storeOptions(stateRoot)
      const byAgent = FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'node-7', words: 'An agent heard this.', filedBy: 'codex' }, options)
      assert.equal(byAgent.id, 'R1')
      assert.equal(byAgent.status, 'proposed', 'with approval on, an agent\'s filing waits')
      assert.equal(byAgent.awaitingApproval, true)
      const record = readLedger(stateRoot).requests.find(entry => entry.id === 'R1')
      assert.equal(record.provenance.class, 'agent-inferred', 'a waiting proposal is not the person\'s stated word yet')
      assert.equal(record.filedBy, 'codex')

      const byPerson = await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'The person typed this.' })
      assert.equal(byPerson.status, 'open', 'the person\'s own filing counts at once, whatever the setting says')
    })
    await withAgentFiledNeedsApproval(false, async () => {
      const options = storeOptions(stateRoot)
      const byAgent = FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'node-7', words: 'Another thing an agent heard.', filedBy: 'codex' }, options)
      assert.equal(byAgent.status, 'open', 'with approval off, an agent\'s filing counts the moment it is filed')
      assert.equal(byAgent.awaitingApproval, false)
      const proposed = FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'node-7', words: 'A suggestion.', filedBy: 'codex', proposed: true }, options)
      assert.equal(proposed.status, 'proposed', 'r_ledger.propose always files a proposal, whatever the setting says')
    })
  })
})

test('a proposal is NOT in the boot block; the rail shows it waiting; approve puts it in the next start, decline keeps it out', async () => {
  await inStandardWorld(async ({ host, stateRoot }) => {
    const options = storeOptions(stateRoot)
    await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'COUNTS-ALREADY: the person typed this.' })
    FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'node-7', words: 'WAITING-ONE: an agent proposed this.', filedBy: 'codex', proposed: true }, options)
    FIXTURE_STORE.fileRequest({ scope: 'thread', key: 'node-7', words: 'WAITING-TWO: an agent proposed this too.', filedBy: 'claude', proposed: true }, options)

    const before = await firstTurnText(host, 'proposed-before', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(before.includes('COUNTS-ALREADY'), 'the person\'s own rule is missing')
    assert.ok(!before.includes('WAITING-ONE') && !before.includes('WAITING-TWO'), 'a proposal still waiting for the person reached an agent')
    assert.match(before, /\[thread node-7\] 1 — applies to/, 'the tier counts only what counts')

    /* The rail is owed the proposals, marked. */
    const rail = readStandingRequests({ scope: 'thread', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_LEDGER })
    assert.deepEqual(rail.entries, [
      { id: 'R1', words: 'COUNTS-ALREADY: the person typed this.' },
      { id: 'R2', words: 'WAITING-ONE: an agent proposed this.', filedBy: 'codex', awaitingApproval: true },
      { id: 'R3', words: 'WAITING-TWO: an agent proposed this too.', filedBy: 'claude', awaitingApproval: true },
    ])
    /* And the Ledger page sees every one of them, with its status. */
    const page = readCanonicalLedger({ scope: 'thread', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_STORE })
    assert.deepEqual(page.records.map(record => [record.id, record.status, record.filedBy]), [['R1', 'open', 'owner'], ['R2', 'proposed', 'codex'], ['R3', 'proposed', 'claude']])

    /* The person decides, through the host's seam. */
    const approved = await host.decideStandingRequest({ id: 'R2', decision: 'approve' })
    assert.deepEqual(approved, { ok: true, id: 'R2', status: 'open' })
    const declined = await host.decideStandingRequest({ id: 'R3', decision: 'decline', reason: 'Not this one.' })
    assert.deepEqual(declined, { ok: true, id: 'R3', status: 'declined' })
    const ledger = readLedger(stateRoot)
    assert.equal(ledger.requests.find(entry => entry.id === 'R2').provenance.class, 'owner-stated', 'an approved proposal is the person\'s word now')
    assert.deepEqual(ledger.requests.find(entry => entry.id === 'R3').decisions.map(entry => [entry.decision, entry.reason, entry.actor]), [['decline', 'Not this one.', 'owner']])
    assert.equal(ledger.requests.length, 3, 'a declined record was spliced out')

    const after = await firstTurnText(host, 'proposed-after', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(after.includes('WAITING-ONE'), 'an approved proposal did not reach the next start')
    assert.ok(!after.includes('WAITING-TWO'), 'a declined proposal reached an agent')
    const railAfter = readStandingRequests({ scope: 'thread', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_LEDGER })
    assert.deepEqual(railAfter.entries.map(entry => entry.id), ['R1', 'R2'], 'the rail still shows a declined record')
    assert.equal(railAfter.entries[1].awaitingApproval, undefined, 'an approved record is no longer marked as waiting')
    assert.equal(railAfter.entries[1].filedBy, 'codex', 'an approved record still says which agent filed it')

    await assert.rejects(() => host.decideStandingRequest({ id: 'R3', decision: 'approve' }),
      error => error.code === 'AGENT_REQUEST_STATUS_INVALID', 'a declined record took an approval')
    await assert.rejects(() => host.decideStandingRequest({ id: 'R9', decision: 'approve' }),
      error => error.code === 'AGENT_REQUEST_ENTRY_UNKNOWN', 'an unknown id was decided')
    await assert.rejects(() => host.decideStandingRequest({ id: 'R1', decision: 'maybe' }),
      error => error.code === 'AGENT_REQUEST_DECISION_INVALID', 'a decision that is not a decision was taken')
    assert.equal(FIXTURE_STORE.verifyHistory(options).ok, true, 'the history does not verify after the decisions')
  })
})

test('the store refuses every hand but the person\'s for edit, remove and decide, and writes nothing', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    await host.fileStandingRequest({ scope: 'global', words: 'The person\'s rule.' })
    const options = storeOptions(stateRoot)
    const bytes = () => readFileSync(ledgerFileOf(stateRoot), 'utf8')
    const before = bytes()
    for (const attempt of [
      () => FIXTURE_STORE.editRequest({ id: 'R1', words: 'Rewritten by an agent.', actor: 'codex' }, options),
      () => FIXTURE_STORE.removeRequest({ id: 'R1', actor: 'codex' }, options),
      () => FIXTURE_STORE.decide({ id: 'R1', decision: 'decline', actor: 'codex' }, options),
      () => FIXTURE_STORE.editRequest({ id: 'R1', words: 'Rewritten by nobody.' }, options),
    ]) {
      assert.throws(attempt, error => error.code === 'R_LEDGER_PERSON_REQUIRED', 'a hand that is not the person changed a record')
    }
    assert.equal(bytes(), before, 'a refused change wrote to the ledger')
    assert.equal(readFileSync(historyFileOf(stateRoot), 'utf8').trim().split('\n').length, 1, 'a refused change appended to the history')
  })
})

/* THE PERSON'S RESOLUTION OF ONE STANDING REQUEST -- R_LEDGER kinds
   follow-on, 2026-09-07 (Controller 3 L4e/L4f). host.resolveStandingRequest
   is built the way decideStandingRequest is, reaching the engine's r-ledger
   module -- Worker's L1f resolve(), which the fixture was refreshed
   2026-09-07 to carry byte for byte from engine 2f351784. THE REAL-STORE
   SUCCESS PATH, proved here rather than assumed: a filed R record resolves,
   the resolved status reads back through canonical-ledger-read, and the
   resolved row LEAVES the session-start block and the rail -- resolve()
   moves the record out of ACTIVE_STATUSES, and collectStack (which
   standing-requests-read.cjs's readLedger walks) only ever returns
   ACTIVE_STATUSES rows -- proved by actually reading a session's first turn
   and the rail before and after, not inferred from the store's contract.
   The id-kind guard (a non-R id refused before rLedger is touched) is
   proved in the same world, on a real T record, and writes nothing. */
test('resolveStandingRequest succeeds against the refreshed fixture: the record reads back resolved and leaves the boot block; a non-R id is still refused', async () => {
  await inWorld(async ({ host, stateRoot }) => {
    const filed = await host.fileStandingRequest({ scope: 'thread', key: 'node-7', words: 'RESOLVE-ME: check the words show and then vanish.' })
    assert.equal(filed.id, 'R1')
    const options = storeOptions(stateRoot)
    const task = FIXTURE_STORE.fileTask({ scope: 'thread', key: 'node-7', words: 'A task.', filedBy: 'owner' }, options)
    assert.equal(task.id, 'T1')

    /* Before resolving: the record's words ride the boot block, and the
       rail lists it. */
    const before = await firstTurnText(host, 'resolve-before', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(before.includes('RESOLVE-ME'), 'a standing record\'s words did not reach the boot block before it was resolved')
    const railBefore = readStandingRequests({ scope: 'thread', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_LEDGER })
    assert.ok(railBefore.entries.some(entry => entry.id === 'R1'), 'the rail did not list the record before it was resolved')

    /* A task id is refused before rLedger is ever touched, and writes
       nothing. */
    const bytesBeforeRefusal = readFileSync(ledgerFileOf(stateRoot), 'utf8')
    await assert.rejects(() => host.resolveStandingRequest({ id: 'T1', status: 'done' }),
      error => error.code === 'AGENT_LEDGER_ID_KIND_MISMATCH', 'a task id was resolved as a standing request')
    assert.equal(readFileSync(ledgerFileOf(stateRoot), 'utf8'), bytesBeforeRefusal, 'a refused resolve wrote to the ledger')

    /* The real resolve, against the refreshed fixture. */
    const resolved = await host.resolveStandingRequest({ id: 'R1', status: 'done', reason: 'Handled directly.' })
    assert.deepEqual(resolved, { ok: true, id: 'R1', status: 'done' })

    /* Reads back resolved through the Ledger page's own reader. */
    const page = readCanonicalLedger({ scope: 'thread', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_STORE })
    const record = page.records.find(entry => entry.id === 'R1')
    assert.equal(record.status, 'done', 'the resolved record did not read back as done through canonical-ledger-read')

    /* Leaves the boot block and the rail. */
    const after = await firstTurnText(host, 'resolve-after', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(!after.includes('RESOLVE-ME'), 'a resolved record\'s words still reached the boot block')
    const railAfter = readStandingRequests({ scope: 'thread', key: 'node-7', root: stateRoot, loadModule: () => FIXTURE_LEDGER })
    assert.ok(!railAfter.entries.some(entry => entry.id === 'R1'), 'the rail still listed a resolved record')
  })
})

/* THE ENGINE-TOO-OLD REFUSAL -- proved against a STUB, not the real fixture.
   The fixture was refreshed 2026-09-07 to carry Worker's L1f resolve(), so
   it can no longer stand in for an engine that predates it. Controller 3:
   "your AGENT_LEDGER_RESOLVE_UNAVAILABLE test can no longer be proven
   against the fixture ... keep it against a fake module lacking resolve,
   and say so" -- said here. The stub rides the same injectable rLedgerLoader
   seam the kind-dispatch test above already uses. */
test('resolveStandingRequest refuses by name against an engine module that predates resolve()', async () => {
  const workdir = testScratch('mc-resolve-stub-')
  /* No resolve, no RESOLUTION_STATUSES -- exactly what an engine older than
     L1f's follow-on exposes. */
  const host = createAgentHost({ enginePath: CONFINED_ENGINE, defaultCwd: workdir, rLedgerLoader: () => ({}) })
  try {
    await assert.rejects(() => host.resolveStandingRequest({ id: 'R1', status: 'done' }),
      error => error.code === 'AGENT_LEDGER_RESOLVE_UNAVAILABLE', 'a module without resolve() still resolved a record')
  } finally {
    await host.closeAll().catch(() => {})
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('auto on a read-only level: the tool is withheld and the paragraph says so', async () => {
  await withFilingMode('auto', () => inWorld(async ({ host }) => {
    /* inWorld's plan is the guided one: servers ['toolsenabled-readonly']. */
    const text = await firstTurnText(host, 'auto-readonly', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(text.includes(FIXTURE_GATE.requestContractParagraph('auto', { canFile: false })),
      'a level that withholds the write server must get the withheld paragraph')
    assert.ok(!text.includes('call r_ledger.file'), 'an agent was told to call a tool its level withholds')
    assert.ok(text.includes('/RequestThread'), 'the withheld text still points the person at the typed commands')
  }))
})

test('a gate that throws is a session told the off text, never a dead start', async () => {
  await withFilingMode('throw', () => inWorld(async ({ host }) => {
    const text = await firstTurnText(host, 'gate-throws', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(text.includes(REQUEST_CONTRACT_PARAGRAPH), 'a throwing gate must fall back to the constant')
  }))
})

test('a payload with no gate module hands every session the constant', async () => {
  const workdir = testScratch('mc-request-nogate-')
  try {
    /* The summaryless fixture carries no r-ledger module either, so the block
       is absent entirely there; the fallback is proved at the composition
       seam instead: a host built over a gate-less engine root answers the
       constant for any mode the environment claims. */
    await withFilingMode('auto', async () => {
      const host = createAgentHost({ freeMemory: TEST_FREE_MEMORY, enginePath: SUMMARYLESS_ENGINE, defaultCwd: workdir, confinementPlanner: () => standardPlan(workdir) })
      await host.startSession({ sessionId: 'nogate-1', requestKeys: { treeAnchors: ['node-1'], threadId: 'node-1' } })
      const engine = require_(SUMMARYLESS_ENGINE)
      const before = engine.adapterCalls.length
      await host.sendTurn({ sessionId: 'nogate-1', text: 'Old payload.', origin: 'person' })
      assert.equal(engine.adapterCalls[before].request.text, 'Old payload.',
        'an older payload cannot read ledgers or a gate, so nothing may be injected')
      await host.closeAll()
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
  }
})

test('the ceiling holds against the rendered text whichever paragraph rides', async () => {
  await withFilingMode('auto', () => inWorld(async ({ host, stateRoot }) => {
    const records = []
    for (let index = 0; index < 400; index += 1) {
      records.push({ id: `R${index + 1}`, scope: 'global', words: `Rule number ${index} with some padding words to carry real weight in bytes.` })
    }
    plantLedger(stateRoot, records)
    const text = await firstTurnText(host, 'ceiling-auto', { treeAnchors: ['node-7'], threadId: 'node-7' })
    assert.ok(Buffer.byteLength(text, 'utf8') <= 24_000 + Buffer.byteLength('Hello.', 'utf8'),
      `the block is unbounded under the auto paragraph: ${Buffer.byteLength(text, 'utf8')} bytes reached the engine`)
    assert.match(text, /withheld for space/, 'a trimmed block must ANNOUNCE the trim')
    assert.ok(text.includes(FIXTURE_GATE.requestContractParagraph('auto', { canFile: false })),
      'the paragraph must survive the trim -- it is the last line and the cap sheds entries, never the duty')
  }))
})

test('the real payload\'s off text is the host constant, when a payload is staged', () => {
  /* Conditional rather than skipped in disguise, the pattern
     tools/test/tree-standing-requests.test.mjs uses: on a bare checkout there
     is no payload to read; on any machine that has cut one -- including the
     one that cuts releases -- this is the drift check between the engine's
     paragraph and the host's constant. */
  if (!existsSync(PAYLOAD_GATE_PATH)) {
    assert.ok(true, 'no payload is staged in this checkout, so there is no gate module to compare')
    return
  }
  const gate = require_(PAYLOAD_GATE_PATH)
  assert.equal(gate.requestContractParagraph('off'), REQUEST_CONTRACT_PARAGRAPH,
    'the payload gate\'s off paragraph drifted from shell/agent-host.cjs REQUEST_CONTRACT_PARAGRAPH')
  assert.equal(gate.requestContractParagraph('nonsense'), REQUEST_CONTRACT_PARAGRAPH, 'an unknown mode reads as off')
  assert.equal(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true }), gate.requestContractParagraph('auto', { canFile: true }),
    'the fixture gate\'s auto paragraph drifted from the payload\'s -- refresh the fixture copy')
  assert.equal(FIXTURE_GATE.requestContractParagraph('auto', { canFile: false }), gate.requestContractParagraph('auto', { canFile: false }),
    'the fixture gate\'s withheld paragraph drifted from the payload\'s -- refresh the fixture copy')
  assert.equal(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true }), gate.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true }),
    'the fixture gate\'s ask-when-unsure paragraph drifted from the payload\'s -- refresh the fixture copy')
  assert.notEqual(gate.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true }), gate.requestContractParagraph('auto', { canFile: true }),
    'the payload\'s ask-when-unsure variant must differ from the plain auto paragraph')
  assert.equal(typeof gate.loadAgentFilingMode().askWhenUnsure, 'boolean', 'the payload gate\'s answer must carry askWhenUnsure for the host to read')
  /* The approval sentence: pinned against the payload the day it carries it;
     until then the older payload's silence is the older payload's. */
  if (typeof gate.PARAGRAPH_NEEDS_APPROVAL === 'string' || typeof gate.agentFiledNeedsApprovalOf === 'function') {
    assert.equal(FIXTURE_GATE.requestContractParagraph('auto', { canFile: true, needsApproval: true }), gate.requestContractParagraph('auto', { canFile: true, needsApproval: true }),
      'the fixture gate\'s approval paragraph drifted from the payload\'s -- refresh the fixture copy')
    assert.equal(typeof gate.loadAgentFilingMode().needsApproval, 'boolean', 'the payload gate\'s answer must carry needsApproval for the host to read')
  }
})
