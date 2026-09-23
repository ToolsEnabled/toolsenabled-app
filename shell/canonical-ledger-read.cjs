'use strict'

/* READING THE ONE LEDGER BACK, FOR THE LEDGER PAGE.
 *
 * WHAT THIS IS. The /ledger page used to paint a build-time file the app never
 * carries on an installed copy, so on the owner's own computer it read
 * "unreadable" while every /Request he typed landed in a file nobody could
 * open from the app. The owner's ruling (2026-09-02): ONE canonical ledger
 * with scope tiers, filed by the /Request family, managed on the Ledger page.
 * The engine's src/lib/owner-request-store.js is that ledger's single store;
 * this file is the shell's READ of it -- the whole ledger, every tier, with
 * the history chain checked -- answered over the agent command surface as
 * `agent:ledger` (ipc mc-agent:ledger, preload mcAgent.ledger, facade GET
 * /v1/agent/ledger).
 *
 * THIS IS A READER AND NOTHING ELSE, and it never creates a file. The store
 * offers ensureLedger(); it is deliberately NOT called here. `agent:ledger`
 * is declared write:false and is reachable by a read-only relay principal,
 * and a read that wrote a ledger, a lock and a backup under the state root
 * would be a write wearing a read's badge. An absent ledger is answered
 * exists:false with an empty list -- "there is nothing on file" is a true
 * answer and the page says so.
 *
 * WHY THE MODULE IS LOADED HERE RATHER THAN REACHED THROUGH THE AGENT HOST.
 * The same reasoning as shell/standing-requests-read.cjs: a read needs no
 * session, no engine process and no host lifecycle, and routing it through
 * the host would make "what is on my ledger" depend on an agent runtime being
 * constructible. The loader is the host's own shape -- same root resolution,
 * same existence check, same shape check, same swallow.
 *
 * NO PATH CROSSES THE BRIDGE. The store's readAll answers the file it read
 * and verifyHistory names the history file; both stay in this process. The
 * reply carries ids, words, statuses, counts and hashes-as-booleans, never a
 * path, and every failure is {ok:false, code, reason, records:[]} so the
 * page has a sentence to show rather than a rejection to catch. */

const path = require('node:path')
const fs = require('node:fs')
const { resolveCapabilityRoot } = require('./capability-layer.cjs')

/* The store's payload path, pinned as its own constant so a payload rename
   breaks this loader loudly (tools/test/shell-payload-modules-declared.test.mjs
   demands the manifest name every PAYLOAD_*_MODULE constant). */
const PAYLOAD_OWNER_REQUEST_STORE_MODULE = 'src/lib/owner-request-store.js'
const PAYLOAD_RUNTIME_POLICY_MODULE = 'src/lib/runtime-policy.js'
function readRuntimePolicy(engineRoot) {
  const root = engineRoot || resolveCapabilityRoot()
  if (!root) throw new Error('Runtime settings unavailable')
  return require(path.join(root, PAYLOAD_RUNTIME_POLICY_MODULE)).runtimePolicy()
}

/* The filters the page may ask for. 'all' is every tier. */
const SCOPES = Object.freeze(['all', 'global', 'tree', 'session', 'thread'])
/* The store's own key rule, mirrored so a refusal never needs the store to
   exist: an id that is not an id is refused before anything is loaded. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const CODES = Object.freeze({
  UNAVAILABLE: 'AGENT_LEDGER_UNAVAILABLE',
  UNREADABLE: 'AGENT_LEDGER_UNREADABLE',
  /* The ledger file is on disk and is not a ledger any more (cut short, not
     JSON): a different repair from a read that did not answer, so it is
     named apart (T1382). */
  DAMAGED: 'AGENT_LEDGER_DAMAGED',
  SCOPE_INVALID: 'AGENT_LEDGER_SCOPE_INVALID',
  KEY_INVALID: 'AGENT_LEDGER_KEY_INVALID',
})

/* Said to a person. One sentence of what happened and one of what to do. */
const REASONS = Object.freeze({
  [CODES.UNAVAILABLE]: 'This copy cannot read the ledger yet. Update the app, then open the Ledger page again.',
  [CODES.UNREADABLE]: 'The ledger file could not be read. Check the file on this computer, then open the Ledger page again.',
  [CODES.DAMAGED]: 'The ledger file on this computer is damaged. Restore it from its backup copy, then open the Ledger page again.',
  [CODES.SCOPE_INVALID]: 'That filter is not one the ledger knows. Choose all, global, tree, session or thread.',
  [CODES.KEY_INVALID]: 'That key is not an id the ledger accepts. Pick the tree, session or circle from the list.',
})

function loadStore(engineRoot) {
  const root = engineRoot || resolveCapabilityRoot()
  if (!root) return null
  const modulePath = path.join(root, PAYLOAD_OWNER_REQUEST_STORE_MODULE)
  try {
    if (!fs.existsSync(modulePath)) return null
    const loaded = require(modulePath)
    if (!loaded || typeof loaded.readAll !== 'function' || typeof loaded.verifyHistory !== 'function') return null
    return loaded
  } catch {
    return null
  }
}

function refusal(code, extra = {}) {
  return Object.freeze({ ok: false, code, reason: REASONS[code], records: Object.freeze([]), ...extra })
}

function count(value) {
  return Array.isArray(value) ? value.length : 0
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null
}

/* T's recurrence, A's answer and P's purchase are the engine's own small
   plain objects (never an array, never null-prototype), not raw strings --
   see src/lib/owner-request-store.js. Frozen and passed through shallow
   rather than picked apart field by field: this reader already trusts the
   store for `words`, `status` and everything else on the record, and this
   is the same trust, not a wider one. */
function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.freeze({ ...value }) : null
}

/* THE LATEST DECISION, AND ONLY ITS OWN WORDS. A task's blocker or progress
   reason, a rule's resolve or decline reason and an ask's decline reason are
   the sentence a person needs to act on or check later (T1281, T1353, T1490),
   and the page used to receive only how many decisions there were. The last
   one comes through, bounded to what the store keeps; earlier ones stay
   behind, counted. */
function latestDecisionOf(decisions) {
  const list = Array.isArray(decisions) ? decisions : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index]
    if (!entry || typeof entry !== 'object' || typeof entry.decision !== 'string') continue
    return Object.freeze({
      decision: text(entry.decision, 16),
      status: text(entry.status, 32),
      reason: text(entry.reason, 2048),
      at: text(entry.at, 40),
      actor: text(entry.actor, 80),
    })
  }
  return null
}

/* One record, as the page may see it: ids, words, statuses and counts. The
   gates themselves, the provenance block and the capture log stay behind;
   of the decisions, the page gets how many and the latest one's words. */
function publicRecord(record) {
  const gates = Array.isArray(record.gates) ? record.gates : []
  const history = Array.isArray(record.history) ? record.history : []
  return Object.freeze({
    id: String(record.id),
    /* THE OWNER'S FOUR SUBSETS (2026-09-07): R rules, T tasks, A asks, P
       purchases. The store does not carry `kind` yet -- L1 (engine lane) is
       adding it to src/lib/owner-request-store.js -- so this is null on
       every record today. It is passed through now, ahead of that landing,
       so this reader does not need a second change the day it appears: the
       app-side reader (src/ledger-live.js kindOf) already falls back to the
       id's own letter when this is null. */
    kind: text(record.kind, 4),
    difficulty: ['easy', 'medium', 'hard'].includes(record.difficulty) ? record.difficulty : null,
    failedReviewCount: Number.isSafeInteger(record.failedReviewCount) && record.failedReviewCount >= 0 ? record.failedReviewCount : null,
    /* T only: a null recurrence is one-shot; an object is `{interval,
       completions}`. completedAt/completedBy are T's own close-out pair. */
    recurrence: plainObject(record.recurrence),
    completedAt: text(record.completedAt, 40),
    completedBy: text(record.completedBy, 80),
    /* T's terminal superseded pair: which task this one replaces, and which
       replaced it. */
    supersedes: text(record.supersedes, 64),
    supersededBy: text(record.supersededBy, 64),
    /* A only: null until the owner answers, then `{words, at}`. */
    answer: plainObject(record.answer),
    /* P only: the purchase detail block (lines, decision, recordedCharge). */
    purchase: plainObject(record.purchase),
    parentId: text(record.parentId, 64),
    scope: text(record.scope, 16),
    scopeKey: text(record.scopeKey, 128),
    scopeLabel: text(record.scopeLabel, 120),
    status: text(record.status, 32),
    words: typeof record.verbatim === 'string' ? record.verbatim : (typeof record.words === 'string' ? record.words : ''),
    filedBy: text(record.filedBy, 80),
    filedAt: text(record.filedAt, 40),
    gateCount: gates.length,
    unmetGateCount: gates.filter(gate => !(gate && gate.met === true)).length,
    decisions: count(record.decisions),
    latestDecision: latestDecisionOf(record.decisions),
    history: Object.freeze(history
      .filter(entry => entry && typeof entry === 'object')
      .map(entry => Object.freeze({
        seq: Number.isInteger(entry.seq) ? entry.seq : null,
        kind: text(entry.kind, 16),
        at: text(entry.at, 40),
        actor: text(entry.actor, 80),
      }))),
    removedAt: text(record.removedAt, 40),
  })
}

function inFilter(record, scope, key) {
  if (scope !== 'all' && record.scope !== scope) return false
  if (key !== null && record.scopeKey !== key) return false
  return true
}

/* R_LEDGER_CHAIN_* -> AGENT_LEDGER_CHAIN_*; anything else is no code. */
function chainCode(code) {
  if (code === 'R_LEDGER_CHAIN_BROKEN') return 'AGENT_LEDGER_CHAIN_BROKEN'
  if (code === 'R_LEDGER_CHAIN_DRIFT') return 'AGENT_LEDGER_CHAIN_DRIFT'
  if (code === 'R_LEDGER_CHAIN_MISSING') return 'AGENT_LEDGER_CHAIN_MISSING'
  return null
}

/* Reading order for the page (see the call site): roots in file order, each
   followed by its refinements depth first. Pure over the ids and parentIds. */
function nestByParent(list) {
  const byId = new Set(list.map(record => record.id))
  const children = new Map()
  const roots = []
  for (const record of list) {
    const parentId = typeof record.parentId === 'string' ? record.parentId : null
    if (parentId && byId.has(parentId)) {
      if (!children.has(parentId)) children.set(parentId, [])
      children.get(parentId).push(record)
    } else {
      roots.push(record)
    }
  }
  const out = []
  const walk = record => {
    out.push(record)
    for (const child of children.get(record.id) || []) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

/**
 * Read the canonical ledger for the page.
 *
 * @param scope       'all' | 'global' | 'tree' | 'session' | 'thread'
 * @param key         the id the caller already holds for a tier; null for
 *                    everything in the scope. Never a path.
 * @param removed     true to include tombstoned (removed, declined) records
 * @param root        where the ledger lives. Omitted, the store's own root is
 *                    used -- the one the write path writes to. Supplied only
 *                    by tests.
 * @param loadModule  seam for the payload loader.
 *
 * Returns {ok:true, revision, updatedAt, exists, records, chain, filter} or
 * {ok:false, code, reason, records:[]}. Never throws, never writes.
 */
function readCanonicalLedger({ scope = 'all', key = null, removed = false, root = null, engineRoot = null, loadModule = loadStore, readPolicy = readRuntimePolicy } = {}) {
  const chosenScope = scope === undefined || scope === null || scope === '' ? 'all' : scope
  if (typeof chosenScope !== 'string' || !SCOPES.includes(chosenScope)) return refusal(CODES.SCOPE_INVALID)
  const chosenKey = key === undefined || key === null || key === '' ? null : key
  if (chosenKey !== null && (typeof chosenKey !== 'string' || !SAFE_KEY.test(chosenKey))) return refusal(CODES.KEY_INVALID)
  const includeRemoved = removed === true

  let store
  try {
    store = loadModule(engineRoot || undefined)
  } catch {
    return refusal(CODES.UNAVAILABLE)
  }
  if (!store || typeof store.readAll !== 'function' || typeof store.verifyHistory !== 'function') return refusal(CODES.UNAVAILABLE)

  /* The store resolves its files through `options.rootPath`, defaulting to
     its own; a test root is expressed in that seam so this file never joins
     a ledger path itself. */
  const options = root ? { rootPath: (...parts) => path.join(root, ...parts) } : {}

  let all
  try {
    /* THE OWNER'S FOUR SUBSETS (2026-09-07): the store's own readAll defaults
       to `kinds: ['R']` so every caller that predates this feature keeps
       seeing exactly what it always saw. This is the one caller that must
       ask for all four -- naming them here, not trusting the default, is
       what makes a T, A or P record exist on this page at all; leaving this
       out reads as "no such records" forever, not as a bug that shows itself. */
    all = store.readAll({ includeRemoved, includeProposed: true, kinds: ['R', 'T', 'A', 'P'], ...options }, options)
  } catch (error) {
    /* The store's own verdict on a file that is not a ledger any more, and
       whether a usable .bak sits beside it -- a boolean, never a path. */
    if (error && error.code === 'R_LEDGER_UNREADABLE') {
      return refusal(CODES.DAMAGED, { backup: /\.bak beside it/.test(String(error.message || '')) })
    }
    return refusal(CODES.UNREADABLE)
  }
  if (!all || typeof all !== 'object' || !Array.isArray(all.records)) return refusal(CODES.UNREADABLE)

  let policy
  try { policy = readPolicy(engineRoot || undefined) } catch { return refusal(CODES.UNAVAILABLE) }
  if (!policy || policy.configurationAvailable === false) return refusal(CODES.UNAVAILABLE)
  const checked = policy.verifyHistory === true
  let verified
  if (checked) {
    try { verified = store.verifyHistory(options) } catch { verified = null }
  }
  const chain = Object.freeze({
    checked,
    ok: checked ? Boolean(verified) && verified.ok === true : null,
    events: verified && Number.isInteger(verified.events) ? verified.events : 0,
    drift: Object.freeze(verified && Array.isArray(verified.drift) ? verified.drift.map(String) : []),
    missing: Object.freeze(verified && Array.isArray(verified.missing) ? verified.missing.map(String) : []),
    unchained: Object.freeze(verified && Array.isArray(verified.unchained) ? verified.unchained.map(String) : []),
    /* The store's own code, re-prefixed the way every other refusal on this
       surface is, so the window never sees the engine's namespace. */
    code: checked ? (verified ? chainCode(verified.code) : CODES.UNREADABLE) : null,
  })

  /* READING ORDER: each root followed by its refinements, depth first, file
     order kept among siblings -- the order the Computers rail and the engine's
     nestEntries already use, so R1.1 sits under R1 whatever order the two were
     filed in. A refinement whose parent is filtered out or missing lists at
     the top with its parentId still set, so nothing standing is ever hidden. */
  const kept = all.records
    .filter(record => record && typeof record === 'object' && typeof record.id === 'string')
    .filter(record => inFilter(record, chosenScope, chosenKey))
  const records = Object.freeze(nestByParent(kept).map(publicRecord))

  return Object.freeze({
    ok: true,
    revision: Number.isInteger(all.revision) ? all.revision : 0,
    /* A ledger that is not on disk has no date: the store answers today's
       date for the empty document it would write, which is not a reading. */
    updatedAt: all.exists === true ? text(all.updatedAt, 40) : null,
    exists: all.exists === true,
    records,
    chain,
    filter: Object.freeze({ scope: chosenScope, key: chosenKey, removed: includeRemoved }),
  })
}

module.exports = { readCanonicalLedger, PAYLOAD_OWNER_REQUEST_STORE_MODULE, PAYLOAD_RUNTIME_POLICY_MODULE, SCOPES, CODES }
