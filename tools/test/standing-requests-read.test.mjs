/* The main-process reader for standing requests.  This suite loads the
 * CommonJS module directly: it does not load shell/main.cjs, import Electron,
 * or launch a window.  The payload reader is supplied through the module's
 * existing seam, keeping every read deterministic and off the real ledger. */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { readStandingRequests } = require_(path.join(REPO, 'shell', 'standing-requests-read.cjs'))

function ledgerModule(result, calls = []) {
  return () => ({
    readLedger(scope, key, options) {
      calls.push({ scope, key, options })
      return result
    },
  })
}

test('real caller scope and key reach the payload reader, while only usable public entry fields return', () => {
  const calls = []
  const answer = readStandingRequests({
    scope: 'tree',
    key: 'node-7',
    root: '/temporary-ledgers',
    loadModule: ledgerModule({
      exists: true,
      path: '/private/ledger.md',
      entries: [
        { id: 'RT1', words: 'Keep the release reversible.', filedBy: '  codex  ', line: 12 },
        { id: 'RT2', words: '   ', filedBy: 'agent' },
        { id: 'RT3', words: 'Ask before installing.', filedBy: '   ' },
      ],
    }, calls),
  })

  assert.equal(calls.length, 1, 'the payload reader must be called exactly once')
  assert.equal(calls[0].scope, 'tree', 'the caller scope must reach the payload reader')
  assert.equal(calls[0].key, 'node-7', 'the caller key must reach the payload reader')
  assert.equal(calls[0].options.rootPath('state', 'r-ledger'), path.join('/temporary-ledgers', 'state', 'r-ledger'))
  assert.deepEqual(answer.entries, [
    { id: 'RT1', words: 'Keep the release reversible.', filedBy: 'codex' },
    { id: 'RT3', words: 'Ask before installing.' },
  ], 'the reply must compute its usable, public entries rather than expose parser metadata')
  assert.equal(JSON.stringify(answer).includes('/private/ledger.md'), false, 'a ledger path must not cross the main-process boundary')
})

/* THE ONE LEDGER'S PROPOSALS (owner, 2026-09-02). With the approval setting
   on, an agent's filing lands as a record with status 'proposed' that counts
   only once the person approves it on the Ledger page. The adapter's read
   includes those rows so the rail can show them; this reader marks each one
   awaitingApproval:true and says who filed it. Every other row keeps exactly
   the keys it had -- a person-filed row is {id, words}, nothing more. */
test('a proposed entry is marked as waiting for the person, and every other entry keeps its exact keys', () => {
  const answer = readStandingRequests({
    scope: 'thread',
    key: 'node-7',
    loadModule: ledgerModule({
      exists: true,
      path: '/private/OWNER-REQUEST-LEDGER.json',
      entries: [
        { id: 'R1', words: 'Typed by the person.', status: 'open', number: 1, stamp: 's', line: null, depth: 0 },
        { id: 'R2', words: 'Filed by an agent, counting.', status: 'open', filedBy: 'codex', number: 2, stamp: 's', line: null, depth: 0 },
        { id: 'R3', words: 'Filed by an agent, waiting.', status: 'proposed', filedBy: 'claude', number: 3, stamp: 's', line: null, depth: 0 },
        { id: 'R3.1', words: 'A refinement, waiting.', status: 'proposed', filedBy: 'claude', number: 3, stamp: 's', line: null, depth: 1 },
      ],
    }),
  })
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.entries, [
    { id: 'R1', words: 'Typed by the person.' },
    { id: 'R2', words: 'Filed by an agent, counting.', filedBy: 'codex' },
    { id: 'R3', words: 'Filed by an agent, waiting.', filedBy: 'claude', awaitingApproval: true },
    { id: 'R3.1', words: 'A refinement, waiting.', filedBy: 'claude', awaitingApproval: true },
  ], 'only a proposed row carries awaitingApproval, and it carries true, never false')
  assert.equal(JSON.stringify(answer).includes('OWNER-REQUEST-LEDGER'), false, 'the ledger path must not cross')
  assert.equal(JSON.stringify(answer).includes('status'), false, 'the raw status stays behind; the rail reads one flag')
})

/* THE LEDGER KINDS SPLIT (2026-09-07): tasks ('T') and asks ('A') file into
   the SAME canonical ledger as standing rules ('R'). This reader must keep
   serving only 'R' to whatever reads it back as a standing rule -- a record
   with no kind field at all predates the split and still counts as 'R'. */
test('only kind R reaches the rail; a task or an ask filed in the same ledger is held back', () => {
  const answer = readStandingRequests({
    scope: 'thread',
    key: 'node-7',
    loadModule: ledgerModule({
      exists: true,
      entries: [
        { id: 'R1', words: 'A standing rule, no kind field at all (pre-split record).' },
        { id: 'R2', words: 'A standing rule, kind stated.', kind: 'R' },
        { id: 'T1', words: 'A task, must not read as a rule.', kind: 'T' },
        { id: 'A1', words: 'A question for the owner, must not read as a rule.', kind: 'A' },
      ],
    }),
  })
  assert.deepEqual(answer.entries, [
    { id: 'R1', words: 'A standing rule, no kind field at all (pre-split record).' },
    { id: 'R2', words: 'A standing rule, kind stated.' },
  ], 'a task or an ask record leaked through the standing-requests reader')
})

test('ledger existence reports both available outcomes instead of a constant readiness answer', () => {
  const present = readStandingRequests({ scope: 'global', key: null, loadModule: ledgerModule({ exists: true, entries: [] }) })
  const absent = readStandingRequests({ scope: 'thread', key: 'node-7', loadModule: ledgerModule({ exists: false, entries: [] }) })

  assert.deepEqual({ ok: present.ok, exists: present.exists }, { ok: true, exists: true }, 'an existing ledger must report that it is available')
  assert.deepEqual({ ok: absent.ok, exists: absent.exists }, { ok: true, exists: false }, 'an absent ledger is a successful empty read, not a made-up existing ledger')
})

test('a payload that cannot be obtained never collapses into a definite empty-ledger answer', () => {
  for (const loadModule of [() => null, () => { throw new Error('unreadable payload') }]) {
    const answer = readStandingRequests({ scope: 'tree', key: 'node-7', loadModule })
    assert.deepEqual(answer, {
      ok: false,
      code: 'AGENT_REQUEST_UNAVAILABLE',
      exists: false,
      entries: [],
    }, 'a payload load failure must carry its unavailable reason')
  }
})

test('payload read refusals stay refusals and carry the specific reason when one is safe', () => {
  const refusing = code => () => ({
    readLedger() {
      const error = new Error('reader refused')
      if (code !== undefined) error.code = code
      throw error
    },
  })

  const invalidKey = readStandingRequests({ scope: 'tree', key: '../outside', loadModule: refusing('R_LEDGER_KEY_INVALID') })
  assert.deepEqual(invalidKey, {
    ok: false,
    code: 'AGENT_REQUEST_KEY_INVALID',
    exists: false,
    entries: [],
  }, 'an invalid identifier must be refused with its reason')

  const unknown = readStandingRequests({ scope: 'tree', key: 'node-7', loadModule: refusing(undefined) })
  assert.deepEqual(unknown, {
    ok: false,
    code: 'AGENT_REQUEST_REFUSED',
    exists: false,
    entries: [],
  }, 'an unknown read failure must remain a refusal rather than claim the ledger is empty')
})
