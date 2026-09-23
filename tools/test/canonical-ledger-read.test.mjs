/* THE LEDGER PAGE'S READ OF THE ONE CANONICAL LEDGER (owner, 2026-09-02).
 *
 * shell/canonical-ledger-read.cjs loads the payload's store
 * (src/lib/owner-request-store.js) and answers `agent:ledger` for the Ledger
 * page. This suite loads that CommonJS module directly -- no shell/main.cjs,
 * no Electron, no window -- and drives it against the fixture store
 * (tools/test/fixtures/confined-engine/src/lib/owner-request-store.js), the
 * same JSON-backed implementation of the store contract the host suites use,
 * under a scratch root each test owns.
 *
 * WHAT IT PROVES:
 *   SHAPE     the reply keys are exactly {ok, revision, updatedAt, exists,
 *             records, chain, filter}; a record's keys are exactly the
 *             documented fifteen (2026-09-07: `kind` joined the fourteen,
 *             passed through ahead of L1 landing it on the store -- see
 *             src/ledger-live.js kindOf for what a null one reads as);
 *             nothing in the reply is a path.
 *   ABSENT    an absent ledger answers ok:true, exists:false, records:[] --
 *             and the read CREATES NOTHING: no ledger, no lock, no backup,
 *             no history. A read that wrote would be a write wearing a
 *             read's badge, reachable by a read-only caller.
 *   FILTER    scope narrows to one tier, key to one id, removed includes
 *             the tombstones (declined and removed) and nothing else does.
 *   CHAIN     the history is verified and reported; a line edited in place
 *             is named as broken.
 *   REFUSAL   a scope the ledger does not know, a key that is not an id, a
 *             payload with no store, and an unreadable file each answer
 *             {ok:false, code, reason, records:[]} with their own code and a
 *             sentence that says what to do next.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { readCanonicalLedger: readCanonicalLedgerCore, PAYLOAD_OWNER_REQUEST_STORE_MODULE, CODES } = require_(path.join(ROOT, 'shell', 'canonical-ledger-read.cjs'))
// Existing history fixtures explicitly exercise verification enabled.
const readCanonicalLedger = options => readCanonicalLedgerCore({ readPolicy: () => ({ verifyHistory: true }), ...options })
const STORE = require_(path.join(ROOT, 'tools', 'test', 'fixtures', 'confined-engine', 'src', 'lib', 'owner-request-store.js'))

/* Scratch under node_modules, resolved through its real path: in a worktree
   node_modules can be a junction, and a scratch root that crosses one is not
   the shape any real state root has. */
const SCRATCH_PARENT = testScratchRoot('.toolsenabled-canonical-ledger-read-test')
mkdirSync(SCRATCH_PARENT, { recursive: true })
const TEST_SCRATCH_ROOT = realpathSync.native(SCRATCH_PARENT)
test.after(() => rmSync(TEST_SCRATCH_ROOT, { recursive: true, force: true }))

function world() {
  const root = mkdtempSync(path.join(TEST_SCRATCH_ROOT, 'ledger-'))
  const rootPath = (...parts) => path.join(root, ...parts)
  return { root, rootPath, file: rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), history: rootPath('state', 'owner-request-record-events.jsonl') }
}

const loadFixtureStore = () => STORE

const REPLY_KEYS = ['ok', 'revision', 'updatedAt', 'exists', 'records', 'chain', 'filter']
const RECORD_KEYS = ['id', 'kind', 'difficulty', 'failedReviewCount', 'recurrence', 'completedAt', 'completedBy', 'supersedes', 'supersededBy', 'answer', 'purchase', 'parentId', 'scope', 'scopeKey', 'scopeLabel', 'status', 'words', 'filedBy', 'filedAt', 'gateCount', 'unmetGateCount', 'decisions', 'latestDecision', 'history', 'removedAt']

test('task grade and failed review count are bounded optional facts in the canonical reply', () => {
  const cases = [
    ['easy', 0, 'easy', 0], ['medium', 1, 'medium', 1], ['hard', 2, 'hard', 2],
    [undefined, undefined, null, null], ['Hard', -1, null, null],
    ['unknown', 1.5, null, null], [null, '2', null, null],
    ['<img src=x>', Number.MAX_SAFE_INTEGER + 1, null, null],
  ]
  for (const [difficulty, failedReviewCount, expectedGrade, expectedCount] of cases) {
    const reply = readCanonicalLedger({
      readPolicy: () => ({ verifyHistory: false }),
      loadModule: () => ({
        readAll: () => ({
          exists: true, revision: 1, records: [{ id: 'T1', kind: 'T', scope: 'global', difficulty, failedReviewCount }],
        }),
        verifyHistory: () => assert.fail('history verification is off for this projection case'),
      }),
    })
    assert.equal(reply.ok, true)
    assert.equal(reply.records[0].difficulty, expectedGrade)
    assert.equal(reply.records[0].failedReviewCount, expectedCount)
    assert.ok(Object.isFrozen(reply.records[0]))
  }
})

const PATH_SHAPED = /[A-Za-z]:\\|\/reports\/|\/state\/|\\reports\\|\\state\\/

test('the module names the payload store by its path, for the manifest gate', () => {
  assert.equal(PAYLOAD_OWNER_REQUEST_STORE_MODULE, 'src/lib/owner-request-store.js')
})

test('an absent ledger is an honest empty read, and the read creates nothing', () => {
  const { root, rootPath } = world()
  try {
    const answer = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.deepEqual(Object.keys(answer), REPLY_KEYS, 'the reply keys are exactly the documented seven')
    assert.equal(answer.ok, true)
    assert.equal(answer.exists, false, 'nothing on file is exists:false, never a made-up ledger')
    assert.deepEqual(answer.records, [])
    assert.equal(answer.revision, 0)
    assert.equal(answer.updatedAt, null)
    assert.deepEqual(answer.filter, { scope: 'all', key: null, removed: false })
    assert.equal(answer.chain.ok, true, 'an empty history verifies')
    assert.equal(answer.chain.events, 0)
    assert.ok(!existsSync(rootPath('reports')), 'the read created the reports folder')
    assert.ok(!existsSync(rootPath('state')), 'the read created the state folder')
    assert.deepEqual(readdirSync(root), [], 'the read left something under the root')
    assert.doesNotMatch(JSON.stringify(answer), PATH_SHAPED, 'a path crossed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('records come back with exactly the documented keys, in id order, and never a path', () => {
  const { root, rootPath } = world()
  try {
    const options = { rootPath }
    STORE.fileRequest({ scope: 'global', key: null, words: 'Ask before spending money.' }, options)
    STORE.fileRequest({ scope: 'tree', key: 'node-1-abc', words: 'Use the staging server.', scopeLabel: 'Manager 2' }, options)
    STORE.fileRequest({ scope: 'global', key: null, words: 'A refinement of the first.', parentId: 'R1' }, options)
    STORE.fileRequest({ scope: 'thread', key: 'node-7', words: 'One sentence answers.', filedBy: 'codex', proposed: true }, options)

    const answer = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.equal(answer.ok, true)
    assert.equal(answer.exists, true)
    assert.equal(answer.revision, 4, 'one revision per write')
    assert.match(answer.updatedAt, /^\d{4}-\d{2}-\d{2}$/)
    assert.deepEqual(answer.records.map(record => record.id), ['R1', 'R1.1', 'R2', 'R3'], 'id order, refinements under their parent')
    for (const record of answer.records) {
      assert.deepEqual(Object.keys(record), RECORD_KEYS, `${record.id} carries keys the page did not ask for`)
    }
    const tree = answer.records.find(record => record.id === 'R2')
    assert.deepEqual(tree, {
      id: 'R2', kind: 'R', difficulty: null, failedReviewCount: null, recurrence: null, completedAt: null, completedBy: null, supersedes: null, supersededBy: null, answer: null, purchase: null,
      parentId: null, scope: 'tree', scopeKey: 'node-1-abc', scopeLabel: 'Manager 2', status: 'open',
      words: 'Use the staging server.', filedBy: 'owner', filedAt: tree.filedAt, gateCount: 0, unmetGateCount: 0,
      decisions: 0, latestDecision: null, history: [{ seq: 2, kind: 'file', at: tree.filedAt, actor: 'owner' }], removedAt: null,
    })
    assert.match(tree.filedAt, /^\d{4}-\d{2}-\d{2}T/)
    const child = answer.records.find(record => record.id === 'R1.1')
    assert.equal(child.parentId, 'R1')
    const proposal = answer.records.find(record => record.id === 'R3')
    assert.equal(proposal.status, 'proposed', 'a proposal is on the page, waiting')
    assert.equal(proposal.filedBy, 'codex')
    assert.equal(proposal.scope, 'thread')
    assert.doesNotMatch(JSON.stringify(answer), PATH_SHAPED, 'a path crossed')
    assert.ok(!JSON.stringify(answer).includes(root), 'the scratch root crossed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scope and key narrow the list; removed brings the tombstones back and nothing else does', () => {
  const { root, rootPath } = world()
  try {
    const options = { rootPath }
    STORE.fileRequest({ scope: 'global', key: null, words: 'Global one.' }, options)
    STORE.fileRequest({ scope: 'tree', key: 'node-1', words: 'Tree one.' }, options)
    STORE.fileRequest({ scope: 'tree', key: 'node-2', words: 'Tree two.' }, options)
    STORE.fileRequest({ scope: 'session', key: 'chat-1', words: 'Session one.' }, options)
    STORE.fileRequest({ scope: 'thread', key: 'node-1', words: 'Thread one.', filedBy: 'codex', proposed: true }, options)
    STORE.removeRequest({ id: 'R3', actor: 'owner' }, options)
    STORE.decide({ id: 'R5', decision: 'decline', reason: 'not this', actor: 'owner' }, options)

    const ids = answer => answer.records.map(record => record.id)
    assert.deepEqual(ids(readCanonicalLedger({ root, loadModule: loadFixtureStore })), ['R1', 'R2', 'R4'], 'removed and declined stay hidden by default')
    assert.deepEqual(ids(readCanonicalLedger({ root, removed: true, loadModule: loadFixtureStore })), ['R1', 'R2', 'R3', 'R4', 'R5'])
    const withRemoved = readCanonicalLedger({ root, removed: true, loadModule: loadFixtureStore })
    assert.equal(withRemoved.records.find(record => record.id === 'R3').status, 'removed')
    assert.match(withRemoved.records.find(record => record.id === 'R3').removedAt, /^\d{4}-/)
    assert.equal(withRemoved.records.find(record => record.id === 'R5').status, 'declined')
    assert.equal(withRemoved.records.find(record => record.id === 'R5').decisions, 1)
    assert.deepEqual(withRemoved.filter, { scope: 'all', key: null, removed: true })

    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'tree', loadModule: loadFixtureStore })), ['R2'])
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'tree', removed: true, loadModule: loadFixtureStore })), ['R2', 'R3'])
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'tree', key: 'node-1', loadModule: loadFixtureStore })), ['R2'])
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'all', key: 'node-1', removed: true, loadModule: loadFixtureStore })), ['R2', 'R5'], 'a key alone matches every tier that key names')
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'global', loadModule: loadFixtureStore })), ['R1'])
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'session', key: 'chat-1', loadModule: loadFixtureStore })), ['R4'])
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: 'session', key: 'chat-9', loadModule: loadFixtureStore })), [])
    const filtered = readCanonicalLedger({ root, scope: 'tree', key: 'node-1', loadModule: loadFixtureStore })
    assert.deepEqual(filtered.filter, { scope: 'tree', key: 'node-1', removed: false })
    /* An absent scope reads as 'all'; a blank key as none. */
    assert.deepEqual(ids(readCanonicalLedger({ root, scope: undefined, key: '', loadModule: loadFixtureStore })), ['R1', 'R2', 'R4'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing ledger records remain named across the shell read boundary', () => {
  const { root, rootPath, file } = world()
  try {
    STORE.fileRequest({ scope: 'global', words: 'A stored rule.' }, { rootPath })
    const ledger = JSON.parse(readFileSync(file, 'utf8'))
    ledger.requests = []
    writeFileSync(file, JSON.stringify(ledger))
    const reply = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.equal(reply.ok, true)
    assert.equal(reply.chain.ok, false)
    assert.equal(reply.chain.code, 'AGENT_LEDGER_CHAIN_MISSING')
    assert.deepEqual(reply.chain.missing, ['R1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the history chain is verified and reported; a line edited in place is named', () => {
  const { root, rootPath, history, file } = world()
  try {
    const options = { rootPath }
    STORE.fileRequest({ scope: 'global', key: null, words: 'First.' }, options)
    STORE.fileRequest({ scope: 'global', key: null, words: 'Second.' }, options)
    STORE.editRequest({ id: 'R1', words: 'First, edited.', actor: 'owner' }, options)
    const clean = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    /* `checked` joined the chain answer with the history-verification setting
       (the read reports whether it verified at all); this fixture verifies. */
    assert.deepEqual(clean.chain, { checked: true, ok: true, events: 3, drift: [], missing: [], unchained: [], code: null })
    assert.deepEqual(clean.records.find(record => record.id === 'R1').history.map(entry => entry.kind), ['file', 'edit'])

    /* Words changed by hand in the JSON: the record drifts from its last
       chained core, and the page is told which one. */
    const ledger = JSON.parse(readFileSync(file, 'utf8'))
    ledger.requests[1].verbatim = 'Second, retyped by hand.'
    writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf8')
    const drifted = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.equal(drifted.ok, true, 'drift is reported, not a refusal -- the words are still the person\'s to see')
    assert.deepEqual(drifted.chain, { checked: true, ok: false, events: 3, drift: ['R2'], missing: [], unchained: [], code: 'AGENT_LEDGER_CHAIN_DRIFT' })

    /* A history line edited in place: the chain breaks at that line. */
    const lines = readFileSync(history, 'utf8').split('\n').filter(Boolean)
    const second = JSON.parse(lines[1])
    second.actor = 'somebody-else'
    lines[1] = JSON.stringify(second)
    writeFileSync(history, `${lines.join('\n')}\n`, 'utf8')
    const broken = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.equal(broken.ok, true)
    assert.equal(broken.chain.ok, false)
    assert.equal(broken.chain.code, 'AGENT_LEDGER_CHAIN_BROKEN')
    assert.equal(broken.chain.events, 1, 'the events before the break still count')
    assert.doesNotMatch(JSON.stringify(broken), PATH_SHAPED)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a scope the ledger does not know and a key that is not an id refuse by name, before any store is loaded', () => {
  let loaded = 0
  const counting = () => { loaded += 1; return STORE }
  const scope = readCanonicalLedger({ scope: 'nope', loadModule: counting })
  assert.deepEqual(scope, { ok: false, code: CODES.SCOPE_INVALID, reason: scope.reason, records: [] })
  assert.equal(scope.code, 'AGENT_LEDGER_SCOPE_INVALID')
  const key = readCanonicalLedger({ scope: 'tree', key: 'a b', loadModule: counting })
  assert.equal(key.code, 'AGENT_LEDGER_KEY_INVALID')
  assert.deepEqual(key.records, [])
  assert.equal(readCanonicalLedger({ key: '../outside', loadModule: counting }).code, 'AGENT_LEDGER_KEY_INVALID')
  assert.equal(readCanonicalLedger({ scope: 7, loadModule: counting }).code, 'AGENT_LEDGER_SCOPE_INVALID')
  assert.equal(loaded, 0, 'a refused ask loaded the store')
  for (const refusal of [scope, key]) {
    assert.match(refusal.reason, /\. /, 'the reason says what happened and what to do next')
    assert.ok(refusal.reason.split(/\s+/).length <= 40)
  }
})

test('no payload, a payload without the store, and a loader that throws all answer unavailable', () => {
  for (const loadModule of [() => null, () => ({}), () => ({ readAll: 1 }), () => { throw new Error('C:\\secret\\payload') }]) {
    const answer = readCanonicalLedger({ loadModule })
    assert.deepEqual(answer, { ok: false, code: 'AGENT_LEDGER_UNAVAILABLE', reason: answer.reason, records: [] })
    assert.match(answer.reason, /Update the app/)
    assert.ok(!answer.reason.includes('\\'), 'a path crossed in the reason')
  }
  /* And the real loader on a checkout whose staged payload predates the
     store answers the same, never a throw. */
  const real = readCanonicalLedger({ engineRoot: path.join(ROOT, 'tools', 'test', 'fixtures', 'summaryless-engine') })
  assert.equal(real.ok, false)
  assert.equal(real.code, 'AGENT_LEDGER_UNAVAILABLE')
})

test('a ledger file that is not a ledger answers unreadable, with a sentence and no path', () => {
  const { root, rootPath, file } = world()
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '{ this is not json', 'utf8')
    const answer = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.deepEqual(answer, { ok: false, code: 'AGENT_LEDGER_DAMAGED', reason: answer.reason, records: [], backup: false })
    assert.match(answer.reason, /ledger file on this computer is damaged/)
    assert.doesNotMatch(JSON.stringify(answer), PATH_SHAPED)
    assert.ok(!existsSync(rootPath('state')), 'an unreadable ledger made the reader write something')
    assert.ok(!existsSync(`${file}.write-lock`), 'the read took the write lock')
    assert.ok(!existsSync(`${file}.bak`), 'the read wrote a backup')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('kind is passed through when the store carries one, including a legacy filing that reads as R', () => {
  const { root } = world()
  try {
    const options = { rootPath: (...parts) => path.join(root, ...parts) }
    STORE.fileRequest({ scope: 'global', key: null, words: 'No kind named at filing.' }, options)
    const untouched = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.equal(untouched.records[0].kind, 'R', 'the store stamps kind R on a plain fileRequest; kind is never null off the real store, a legacy record reads as R')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  /* L1's landing shape, taken on trust from the interface rather than
     invented: the store carries `kind` as one of 'R','T','A','P' on every
     record. tools/test/fixtures/confined-engine's store was refreshed
     byte-for-byte from L1's accepted engine tip (see the app lane's fixture
     refresh commit), so the case just above already exercises it against the
     real store; T, A and P kinds still have no filing path through this
     fixture's fileRequest, so those three are tested here in isolation
     against a minimal stand-in store, the same way the "no payload" cases
     above stand in for a store shape this file does not own. */
  const stubStore = {
    readAll: () => ({ exists: true, revision: 1, updatedAt: '2026-09-07', records: [{ id: 'T1', kind: 'T', scope: 'global', history: [] }] }),
    verifyHistory: () => ({ ok: true, events: 0, drift: [], unchained: [], code: null }),
  }
  const withKind = readCanonicalLedger({ loadModule: () => stubStore })
  assert.equal(withKind.records[0].kind, 'T', 'a kind the store hands back must reach the page unrenamed')

  const oversized = readCanonicalLedger({ loadModule: () => ({ ...stubStore, readAll: () => ({ exists: true, revision: 1, updatedAt: '2026-09-07', records: [{ id: 'T1', kind: 'TOOLONG', scope: 'global', history: [] }] }) }) })
  assert.equal(oversized.records[0].kind, 'TOOL', 'the same 4-character clip every other text field on this record gets')

  /* T's recurrence, A's answer and P's purchase are the store's own plain
     objects; they must reach the page shallow-frozen, and a record that
     never carried one must answer null rather than leaking an empty {} or
     dropping the key. */
  const withMinorFields = readCanonicalLedger({
    loadModule: () => ({
      readAll: () => ({
        exists: true, revision: 1, updatedAt: '2026-09-07',
        records: [
          { id: 'T1', kind: 'T', scope: 'global', history: [], recurrence: { interval: 'weekly', completions: [] }, completedAt: '2026-09-06T00:00:00.000Z', completedBy: 'owner', supersedes: 'T0', supersededBy: 'T2' },
          { id: 'A1', kind: 'A', scope: 'global', history: [], answer: { words: 'Yes, go ahead.', at: '2026-09-06T00:00:00.000Z' } },
          { id: 'P1', kind: 'P', scope: 'global', history: [], purchase: { lines: [{ label: 'Widget', amountCents: 500 }] } },
          { id: 'R1', kind: 'R', scope: 'global', history: [] },
        ],
      }),
      verifyHistory: () => ({ ok: true, events: 0, drift: [], unchained: [], code: null }),
    }),
  })
  const [taskRow, askRow, purchaseRow, ruleRow] = withMinorFields.records
  assert.deepEqual(taskRow.recurrence, { interval: 'weekly', completions: [] })
  assert.equal(taskRow.completedAt, '2026-09-06T00:00:00.000Z')
  assert.equal(taskRow.completedBy, 'owner')
  assert.equal(taskRow.supersedes, 'T0')
  assert.equal(taskRow.supersededBy, 'T2')
  assert.deepEqual(askRow.answer, { words: 'Yes, go ahead.', at: '2026-09-06T00:00:00.000Z' })
  assert.deepEqual(purchaseRow.purchase, { lines: [{ label: 'Widget', amountCents: 500 }] })
  for (const row of [taskRow, askRow, purchaseRow]) assert.ok(Object.isFrozen(row.purchase ?? row.answer ?? row.recurrence))
  assert.equal(ruleRow.recurrence, null)
  assert.equal(ruleRow.answer, null)
  assert.equal(ruleRow.purchase, null)
  assert.equal(ruleRow.supersedes, null)
  assert.equal(ruleRow.supersededBy, null)
})

/* THE OWNER'S FOUR SUBSETS, THE READ SIDE OF THE GATE: the store's own
   readAll defaults `kinds` to ['R'] so every caller that predates this
   feature is unaffected -- see src/lib/owner-request-store.js. This is the
   one caller for the whole ledger page, and it must ask for all four or a
   T, A or P record is invisible forever, not merely untested. */
test('the read asks the store for all four kinds, not the store\'s own R-only default', () => {
  let seenOptions = null
  const spyStore = {
    readAll: (options) => { seenOptions = options; return { exists: true, revision: 1, updatedAt: '2026-09-07', records: [] } },
    verifyHistory: () => ({ ok: true, events: 0, drift: [], unchained: [], code: null }),
  }
  readCanonicalLedger({ loadModule: () => spyStore })
  assert.ok(seenOptions, 'readAll must be called')
  assert.deepEqual([...seenOptions.kinds].sort(), ['A', 'P', 'R', 'T'], 'every kind the owner named must be asked for')
})

test('gate counts come from the record, and the reply is frozen', () => {
  const { root, rootPath, file } = world()
  try {
    const options = { rootPath }
    STORE.fileRequest({ scope: 'global', key: null, words: 'With gates.' }, options)
    const ledger = JSON.parse(readFileSync(file, 'utf8'))
    ledger.requests[0].gates = [
      { instruction: 'one', hedged: false, met: true, evidence: 'done' },
      { instruction: 'two', hedged: false, met: false, evidence: '' },
      { instruction: 'three', hedged: true, met: false, evidence: '' },
    ]
    writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf8')
    const answer = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    const record = answer.records[0]
    assert.equal(record.gateCount, 3)
    assert.equal(record.unmetGateCount, 2)
    assert.equal(answer.chain.ok, true, 'gates are not part of the chained core, so adding them is not drift')
    assert.ok(Object.isFrozen(answer) && Object.isFrozen(answer.records) && Object.isFrozen(record) && Object.isFrozen(answer.chain))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* THE LATEST DECISION'S OWN WORDS REACH THE PAGE (T1281, T1353, T1490): the
   reason a rule was resolved or declined, and who declined an ask, used to be
   reduced to a count on the way to the page, so no row could say them. */
test('each record carries its latest decision\'s words, status, time and actor, and nothing earlier', () => {
  const { root, rootPath } = world()
  try {
    const options = { rootPath }
    STORE.fileRequest({ scope: 'global', key: null, words: 'Keep the release notes short.' }, options)
    STORE.fileRequest({ scope: 'global', key: null, words: 'Use the old server.', filedBy: 'codex', proposed: true }, options)
    STORE.resolve({ id: 'R1', status: 'in-progress', reason: 'Started on it.', actor: 'owner' }, options)
    STORE.resolve({ id: 'R1', status: 'done', reason: 'Shipped and checked.', actor: 'owner' }, options)
    STORE.decide({ id: 'R2', decision: 'decline', reason: 'Not this one.', actor: 'owner' }, options)
    STORE.fileAsk({ scope: 'global', key: null, words: 'May I cancel the cloud subscription?', filedBy: 'codex' }, options)
    STORE.declineAsk({ id: 'A1', reason: 'Not worth it.', actor: 'owner' }, options)
    STORE.fileRequest({ scope: 'global', key: null, words: 'Nothing decided yet.' }, options)

    const records = readCanonicalLedger({ root, removed: true, loadModule: loadFixtureStore }).records
    const of = id => records.find(record => record.id === id)
    assert.equal(of('R1').decisions, 2)
    assert.deepEqual({ ...of('R1').latestDecision, at: typeof of('R1').latestDecision.at },
      { decision: 'resolve', status: 'done', reason: 'Shipped and checked.', at: 'string', actor: 'owner' }, 'the latest resolve reason did not reach the page')
    assert.match(of('R1').latestDecision.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(of('R2').latestDecision.decision, 'decline')
    assert.equal(of('R2').latestDecision.reason, 'Not this one.')
    assert.equal(of('A1').latestDecision.decision, 'decline')
    assert.equal(of('A1').latestDecision.reason, 'Not worth it.')
    assert.equal(of('A1').latestDecision.actor, 'owner', 'who declined the ask did not reach the page')
    assert.equal(of('R3').latestDecision, null, 'a record with no decision carries none')
    assert.ok(Object.isFrozen(of('R1').latestDecision))
    assert.doesNotMatch(JSON.stringify(records), PATH_SHAPED, 'a path crossed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* A LEDGER FILE CUT IN HALF IS DAMAGED, NOT MERELY UNREAD (T1382): its own code,
   whether a usable backup sits beside it, and still never a path. */
test('a damaged ledger file answers its own code, says whether a backup is there, and carries no path', () => {
  const { root, rootPath, file } = world()
  try {
    const options = { rootPath }
    STORE.fileRequest({ scope: 'global', key: null, words: 'First.' }, options)
    STORE.fileRequest({ scope: 'global', key: null, words: 'Second.' }, options)
    const whole = readFileSync(file, 'utf8')
    writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)), 'utf8')
    const answer = readCanonicalLedger({ root, loadModule: loadFixtureStore })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'AGENT_LEDGER_DAMAGED', 'a torn file reads as the same fault as a read that never answered')
    assert.equal(typeof answer.backup, 'boolean')
    assert.equal(answer.backup, existsSync(`${file}.bak`), 'the backup flag does not match what is on disk')
    assert.match(answer.reason, /damaged/)
    assert.doesNotMatch(JSON.stringify(answer), PATH_SHAPED, 'a path crossed')
    assert.ok(!JSON.stringify(answer).includes(root), 'the scratch root crossed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
