'use strict'

/* READING BACK THE STANDING REQUESTS A TREE ALREADY CARRIES.
 *
 * THE HALF THAT WAS MISSING. The /Request family is wired end to end — the
 * tree chat parses the command before anything is sent, `mc-agent:request`
 * files it through the payload's own r-ledger module, every start carries
 * `requestKeys`, and the engine's onboarding injects those scopes at boot
 * beside the global layer. So a person's per-tree instructions already reach
 * every agent in that tree. There was no way to READ THEM BACK: the channel
 * was write-only, so a person could file a rule and then never find out what
 * this tree carries, while every agent in it was being told.
 *
 * THIS IS A READER AND NOTHING ELSE, and that is a design decision with the
 * owner's own words behind it. The ledger file's header — written by the
 * engine module, not by this shell — says:
 *
 *     edit or delete any entry by hand — the words here are the owner's and
 *     no tool rewrites them. Ids are never reused: a deleted number stays
 *     retired.
 *
 * So this file offers no delete and no edit. A product button that rewrote
 * those files would contradict the design recorded inside the files
 * themselves. Removing a rule stays a hand edit, and the surface says so.
 *
 * WHY THE MODULE IS LOADED HERE RATHER THAN REACHED THROUGH THE AGENT HOST.
 * shell/agent-host.cjs owns the WRITE seam (fileStandingRequest) and loads the
 * same payload module the same way. A read needs no session, no engine
 * process and no host lifecycle — it is a file parse — and routing it through
 * the host would make "what rules does this tree have" depend on an agent
 * runtime being constructible. The loader below is deliberately the host's:
 * same module path, same existence check, same shape check, same swallow. If
 * the two are ever consolidated, they should be consolidated onto this shape.
 *
 * NO PATH CROSSES THE BRIDGE, IN EITHER DIRECTION. The caller names a scope
 * and an id it already holds; the module's own SAFE_KEY decides whether that
 * id can address a ledger, and a refusal comes back as nothing rather than as
 * a path this file constructed. readLedger() returns the file path it read;
 * it is dropped here and never leaves the main process — the same rule the
 * write handler states in its own header.
 */

const path = require('node:path')
const fs = require('node:fs')

/* The same module path shell/agent-host.cjs pins, kept as its own constant so
   a payload rename breaks both loaders at once rather than silently leaving
   this one reading nothing. */
const PAYLOAD_R_LEDGER_MODULE = 'src/lib/r-ledger.js'

/* WHERE THE PAYLOAD IS, asked of the one module that knows. The host is
   handed its engine root by the layer it starts; a read has no such caller,
   so it resolves the same root the layer would — installed (resources/
   capability) or checkout (./capability) — instead of guessing at either. */
const { resolveCapabilityRoot } = require('./capability-layer.cjs')

function loadRLedger(engineRoot) {
  const root = engineRoot || resolveCapabilityRoot()
  if (!root) return null
  const modulePath = path.join(root, PAYLOAD_R_LEDGER_MODULE)
  try {
    if (!fs.existsSync(modulePath)) return null
    const loaded = require(modulePath)
    if (!loaded || typeof loaded.readLedger !== 'function') return null
    return loaded
  } catch {
    return null
  }
}

/* A reading that could not be taken, said as itself. "There are no rules" and
   "this copy could not look" are different answers, and painting the second
   as the first is the exact lie this codebase keeps repairing. */
const unavailable = code => Object.freeze({ ok: false, code, exists: false, entries: [] })

/**
 * Read one scope's standing requests.
 *
 * @param scope       'global' | 'session' | 'tree' | 'thread'
 * @param key         the id the caller already holds for that scope; null for
 *                    global. Never a path — the module refuses anything that
 *                    is not a plain id.
 * @param root        where the ledgers live. Omitted, the payload module's own
 *                    root is used, which is the one the WRITE path writes to —
 *                    so a read and a file cannot disagree about which ledger a
 *                    scope means. Supplied only by tests and by a caller that
 *                    has genuinely resolved a different payload.
 * @param loadModule  seam for the payload loader, so a build with no payload
 *                    can be measured rather than only imagined.
 *
 * Returns `{ ok, code?, exists, entries: [{ id, words }] }`. Never throws:
 * every failure this can meet — no payload, a key that is not an id, a
 * hand-damaged file, a ledger too large — is a state a person can reach, and
 * a rail that threw would blank itself over a typo in a file the product
 * invited them to edit.
 */
function readStandingRequests({ scope, key = null, root = null, engineRoot = null, loadModule = loadRLedger } = {}) {
  let rLedger
  try {
    rLedger = loadModule(engineRoot || undefined)
  } catch {
    return unavailable('AGENT_REQUEST_UNAVAILABLE')
  }
  if (!rLedger) return unavailable('AGENT_REQUEST_UNAVAILABLE')

  /* The module resolves ledger paths through `options.rootPath`, defaulting to
     its own. A test root is expressed in exactly that seam rather than by this
     file joining path segments, so this file never builds a ledger path. */
  const options = root ? { rootPath: (...parts) => path.join(root, ...parts) } : {}

  let ledger
  try {
    /* WAITING ROWS ARE ASKED FOR BY NAME. The store's plain layer read carries
       active rows only, so a boot block can never pick up a proposal; the rail
       is the one reader that must show a person what waits for them. An older
       module ignores the option. */
    ledger = rLedger.readLedger(scope, key, { ...options, includeProposed: true })
  } catch (error) {
    /* R_LEDGER_KEY_INVALID and R_LEDGER_SCOPE_INVALID are refusals about what
       was ASKED, and they are the fence: an id that is not an id never
       reaches a file. R_LEDGER_TOO_LARGE is about the file. Either way the
       answer is no entries and a code, never a partial list. */
    const code = error && typeof error.code === 'string' && error.code.startsWith('R_LEDGER_')
      ? `AGENT_REQUEST_${error.code.slice('R_LEDGER_'.length)}`
      : 'AGENT_REQUEST_REFUSED'
    return unavailable(code)
  }

  /* WORDS AND IDS ONLY -- AND WHO FILED IT, WHEN IT WAS NOT THE PERSON.
     `path`, `line`, `stamp`, `number` and the parser's warnings all stay in
     this process: the id is what a person needs to find the entry by hand,
     and the words are the rule. `filedBy` is the one addition (O7): the
     module parses it off the head line for an entry an agent filed, it is an
     agent's name and never a path, and a person reading their rules is owed
     "your agent codex wrote this one". Absent from a person-filed entry
     rather than null, so an older reader's shape is untouched. */
  /* AND WHETHER IT IS STILL WAITING FOR THE PERSON. With the approval
     setting on, an agent's filing lands as a proposal that counts only once
     the person approves it on the Ledger page. The rail is owed that fact --
     an agent that says "Filed R5" while nothing tells the person where it
     went was the gap the fold closed -- so a proposed entry additionally
     carries awaitingApproval:true. Absent, not false, from every other entry:
     the exact-key pins of a person-filed row ({id, words}) stay true. */
  /* KIND R ONLY. This reader feeds the standing-rule rail an agent's boot
     block is built from; the ledger kinds design (2026-09-07) puts tasks
     ('T') and asks ('A') in the SAME canonical ledger as rules, so once
     either is filed this reader must not hand its words back as though they
     were a standing rule. A record with no `kind` field at all is an
     R-record from before the kinds split, per the shared interface note
     ("a record without kind is R"), so it still passes. */
  const entries = Object.freeze((ledger.entries || [])
    .filter(entry => entry && typeof entry.id === 'string' && typeof entry.words === 'string' && entry.words.trim() !== ''
      && (entry.kind === undefined || entry.kind === 'R'))
    .map(entry => Object.freeze({
      id: entry.id,
      words: entry.words,
      ...(typeof entry.filedBy === 'string' && entry.filedBy.trim() !== ''
        ? { filedBy: entry.filedBy.trim().slice(0, 80) }
        : {}),
      ...(entry.status === 'proposed' ? { awaitingApproval: true } : {}),
    })))

  return Object.freeze({ ok: true, exists: ledger.exists === true, entries })
}

module.exports = { readStandingRequests, PAYLOAD_R_LEDGER_MODULE }
