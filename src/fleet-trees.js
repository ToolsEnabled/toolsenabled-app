import { registerSavedTreeMaintenance, planSavedTreeMaintenance } from './saved-tree-maintenance-refresh.js'
import { DEFAULT_TREE_SLOT_BOUNDS, normalizeTreeSlotBounds, readCurrentTreeSlotBounds, effectiveTreeSlotBounds, planTreeSlot, treeSlotFullReason, TREE_SLOT_UNAVAILABLE } from '../shell/tree-slot-policy.mjs'
import { normalizePendingEditorFork } from './editor-attachment-drafts.js'
import { normalizeSlotAccountChoice } from './slot-account-choice.js'
import { sessionEndedWithApp } from './tree-session-liveness.js'

/* THE TREES A PERSON BUILDS BY HAND. The state, not the drawing.
 *
 * The owner described this surface in four sentences, and every rule in this
 * file exists to keep one of them literally true rather than approximately
 * true:
 *
 *   1. "the node tree is EMPTY unless the user has started a session" — nothing
 *      is pre-populated. A fresh computer holds no trees and no agents, and
 *      this module has no seed data of any kind. That is a deliberate reversal
 *      of src/fleet-profile.js, which ships a labelled sample fleet on purpose
 *      so the demonstration screens have something to draw. A demonstration
 *      roster is honest when the screen says it is a demonstration; a
 *      demonstration entry in a structure the person is told THEY built is not,
 *      because there is no wording that makes "you added this" true about
 *      something the program added.
 *
 *   2. "the user sees empty placeholder nodes and presses one to EXTEND their
 *      existing structure" — the placeholders are the view's pixels, but WHERE
 *      a placeholder may legally appear is state, and it is answered here by
 *      extensionPoints(). Left to the view, that question gets answered twice,
 *      by two files, and the second answer offers a slot the store then
 *      refuses.
 *
 *   3. "pressing one opens a right-side panel where they assign a role and a
 *      message" — so an agent EXISTS, on screen, with an id, before any session
 *      does. That is what `draft` is. Without a draft state the panel would
 *      have to hold the half-filled agent in a variable of its own and the tree
 *      would only learn about it at the moment of launch, which loses the
 *      person's typing on any reload and makes "extend the structure" mean
 *      "start an agent right now", which is not what was asked for.
 *
 *   4. "a computer may hold MORE THAN ONE tree" — so a tree is a first-class
 *      record with its own id and name, and a node names the tree it belongs
 *      to. It also decides the shape question underneath: one tree has ONE top
 *      agent. A tree that tolerated several unrelated tops would be a forest
 *      wearing a single name, and then "more than one tree" would have no
 *      meaning a person could see or act on.
 *
 * NO DOM, NO WINDOW, NO CONNECTION TO THE PROGRAM. Everything here is data and
 * arithmetic, so tools/test/fleet-trees.test.mjs exercises the rules in plain
 * node rather than through a screenshot of a panel.
 *
 * THE PERSISTENCE SEAM IS THE ONE IN src/checkout-selection.js, deliberately
 * copied rather than re-invented: a `{ read(key), write(key, value) }` face
 * that cannot throw, handed in by the caller. safeTreeStorage() below wraps a
 * getItem/setItem backing into it, and its shape is identical to safeStorage()
 * in that file, so a caller that already built one may pass the same object
 * here. Saving on the browser side throws in private mode and on quota, and a
 * store that lets that reach the panel loses the structure the person is in the
 * middle of building; a store that swallows it silently tells them their work
 * is kept when it is not. So a save that does not land is REPORTED, on every
 * snapshot, as persistenceFailed.
 *
 * BROKEN SAVED STATE MEANS NO PARTIAL TREE. parseFleetTrees()
 * returns everything or nothing. A half-read tree is the worst of the three
 * outcomes available: an agent whose parent was dropped becomes a second top
 * agent nobody placed, and the person is looking at a structure they did not
 * build while being told it is theirs. The store refuses to open that record;
 * it must never turn a parse refusal into a writable fresh-install default.
 *
 * ONE EXCEPTION, AND IT DROPS NOTHING: A STATUS WORD THIS BUILD DOES NOT KNOW.
 * A status is not structure. A node whose status word was written by another
 * build (newer, older, or a build with a state this one never had) is still
 * exactly where the person put it, under the parent they gave it, with the
 * message they typed. MEASURED 2026-09-19 (T162): three trees, one node of one
 * of them carrying 'paused', and all three trees and all three nodes were
 * gone -- the owner's whole canvas emptied by one word in one row. That node
 * now reads as NODE_STATUS_UNREADABLE, keeps the word it was saved with (see
 * SAVED_STATUS), holds no seat, and is written back with the ORIGINAL word so
 * a build that knows the word reads it again. Every structural refusal above
 * and below this sentence is unchanged.
 */

export const FLEET_TREES_RECORD_VERSION = 1

/* One saved record per computer, and the computer's id is IN the key as well as
   inside the record. Both, not either: the key keeps two computers' structures
   from overwriting each other in the same storage area, and the field inside
   catches a record that was copied, restored or synced under the wrong key —
   which parseFleetTrees treats as somebody else's data and refuses. */
const STORAGE_KEY_BASE = 'mc.fleet.trees.v1'
export const fleetTreesStorageKey = computerId => `${STORAGE_KEY_BASE}:${computerId}`

/* An immediate compose Start may carry an in-panel override. A later tree
   Start has no panel, so it takes the choice Set persisted on the node before
   falling back to the tier default. Pure so the precedence is executable in a
   storage test rather than inferred from view source text. */
export function draftStartEffort(node, { override = null, tierDefault = null } = {}) {
  return override || node?.effort || tierDefault
}

/* WHO HOLDS A LIVE STORE, so nobody else writes beside it.
 *
 * A store instance persists the WHOLE record on every mutation. Two live
 * instances over one computer id would clobber each other's writes blob for
 * blob without the freshness guard below. That guard now refuses the stale
 * writer; this registry prevents routine listeners from creating that conflict.
 * Views never overlap (one route is mounted at a time), but
 * the research dispatcher's module-level results listener outlives every view
 * and files worker outcomes whenever a turn completes. This registry is how
 * it knows whether a view's instance is live: if one is, the listener leaves
 * the tree to that view's own event wiring; if none is, the listener may open
 * a transient instance, write, and drop it. */
const liveStores = new Map()

export function markTreeStoreLive(computerId) {
  const id = typeof computerId === 'string' ? computerId : ''
  if (!id) return () => {}
  liveStores.set(id, (liveStores.get(id) || 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = liveStores.get(id) || 0
    if (count <= 1) liveStores.delete(id)
    else liveStores.set(id, count - 1)
  }
}

export function isTreeStoreLive(computerId) {
  return liveStores.has(typeof computerId === 'string' ? computerId : '')
}

/* THE FIVE STATES, AND WHY THERE ARE FIVE.
 *
 *   draft      created by pressing a placeholder, and given a role and a
 *              message in the panel. No session exists. This is the state the
 *              owner's flow spends most of its time in and the only one in
 *              which the brief may still be edited.
 *   starting   a launch has been asked for and no id has come back yet. It is
 *              a real state and not an animation: the id arrives on a separate
 *              beat, and a node that jumped straight to running would spend
 *              that gap claiming a session nothing can point at.
 *   running    a live session, whose id this node holds.
 *   finished   the session ended.
 *   failed     the session ended badly. Kept apart from finished because the
 *              two ask different things of the person looking at the tree.
 *
 * The transitions are NOT enumerated as a table here. What is enforced instead
 * is the pair of facts a table would only be a proxy for: running means there
 * is a session id, and draft means there is not. Those two are what any screen
 * reading this state will act on, and they are checked on every write and on
 * every read of saved state. */
/* 'failed' is a START that never produced a session; 'turn-failed' is a TURN
   that ended badly on a session that genuinely ran. They are separate statuses
   because their chip words are separate facts -- "did not start" over a
   session the signed spawn record shows was the measured 2026-08-18 defect.
   The words live in src/fleet-tree-copy.js NODE_STATUS_WORDS, one entry per
   status here. */
export const NODE_STATUSES = Object.freeze(['draft', 'starting', 'running', 'finished', 'failed', 'turn-failed', 'interrupted', 'cancelled'])
const LIVE_STATUSES = Object.freeze(new Set(['starting', 'running']))

/* THE UNKNOWN-STATUS MARKER (T162).
 *
 * NOT A NINTH MEMBER OF NODE_STATUSES, on purpose. NODE_STATUSES is the set a
 * WRITER may set -- setNodeStatus refuses anything else -- and nothing in this
 * build may decide an agent's state is "unreadable"; only the reader may find
 * it so. A node carries this marker exactly when its saved status word is one
 * this build does not know, and the word it was saved with rides beside it
 * under SAVED_STATUS so the record goes back to disk byte for byte as it came.
 *
 * WHAT THE MARKER SATISFIES, from the audit of every status site (2026-09-19):
 *   - it is not in LIVE_STATUSES, so it holds no seat: liveChildrenOf,
 *     advanceRunClock, nodeIsBusy and sessionEndedWithApp all read it as not
 *     live, and removeNode does not refuse it as running;
 *   - it is not 'draft', so nothing offers to start it, edit its brief, or
 *     attach a session as if it were new (a draft is DEFINED as having no
 *     session; this node may hold one);
 *   - it is not terminal, so treeNodeClock folds its clock shut at the last
 *     write rather than inventing an end the record never claimed;
 *   - NODE_STATUS_WORDS (src/fleet-tree-copy.js) carries its own chip word,
 *     so no surface falls through to "not started yet" for it.
 *
 * SAVED_STATUS is a SYMBOL key, and that is what makes the round trip exact:
 * object spread copies an own enumerable symbol (so putNode and every
 * `{ ...node }` in this file carry it forward), and JSON.stringify ignores
 * symbols (so it can never leak into the record). The one place the marker
 * meets the disk, nodeSavedForm below, puts the original word back in
 * `status`. A later write that sets a KNOWN status drops the saved word,
 * because at that moment the build does know the state. */
export const NODE_STATUS_UNREADABLE = 'unreadable'
export const SAVED_STATUS = Symbol('fleet-trees.savedStatus')

/** The status word this node was saved with: the original for a marker node,
 *  the status itself for every other. */
export function savedNodeStatus(node) {
  if (!node) return undefined
  return node.status === NODE_STATUS_UNREADABLE && Object.prototype.hasOwnProperty.call(node, SAVED_STATUS)
    ? node[SAVED_STATUS]
    : node.status
}

/** The shape a node takes on disk. Identity is kept for an ordinary node --
 *  the serialiser memoises on it -- and a marker node becomes a copy with its
 *  original status word in place. Anything else about the node is untouched. */
export function nodeSavedForm(node) {
  if (!node || node.status !== NODE_STATUS_UNREADABLE) return node
  const { [SAVED_STATUS]: saved, ...rest } = node
  return Object.freeze({ ...rest, status: saved })
}

/* ===================================================================
   THE RUN CLOCK — what the circle on page 2 is allowed to count
   ===================================================================
 *
 * THE DEFECT, in the owner's words: "their timeers not always accurate to
 * their time ran - sometimes it logs time they werent running."
 *
 * The canvas clock counted `now - createdAt`, and `createdAt` is the moment
 * the CIRCLE was drawn, not the moment the agent started. A placeholder is
 * pressed, the panel asks for a role and a message, and the person answers
 * when they answer. Every minute of that — and every minute afterwards that
 * the node sat as a draft — was billed to the agent the instant it started.
 * A node that starts, stops and starts again was worse: `createdAt` never
 * moves, so the second run's figure spanned the first run AND the whole idle
 * gap between them. Nothing in the record could tell the difference.
 *
 * TWO FIELDS FIX IT, AND THEY ARE THE ONLY TWO THAT CAN. `runMs` is the sum
 * of the intervals this node has ACTUALLY been running, and `runStartedAt` is
 * the instant the interval now open began — null when none is. Between them
 * they answer "how long has this agent run" without ever consulting a clock
 * over a period nobody measured.
 *
 * RUNNING IS THE STORE'S OWN WORD FOR IT: a LIVE_STATUSES status over a
 * session id. That is the same pair src/tree-session-liveness.js calls busy,
 * and it is deliberately the same beat the canvas already freezes its digits
 * on, so the number and the frozen/ticking state can never describe different
 * periods.
 *
 * THE RULE IS APPLIED IN putNode, NOT AT THE CALL SITES. Twelve places across
 * five files move a node between draft, starting, running and the four
 * terminal states; a rule written at the call sites is a rule the thirteenth
 * caller does not know about. This is the same reasoning the header of
 * src/tree-session-liveness.js gives for existing at all — six near-copies of
 * one question is how that defect was assembled.
 */
function advanceRunClock(before, after, at) {
  const openedAt = Date.parse(before?.runStartedAt)
  const open = Number.isFinite(openedAt)
  const shouldRun = LIVE_STATUSES.has(after?.status) && after?.sessionId != null
  /* null, NOT 0, for a record written before this field existed. "This node
     has run for no measured time" and "nobody was measuring" are different
     answers, and treeNodeClock gives them different renderings: the second
     keeps the old createdAt reading, because inventing 0s over an agent that
     demonstrably ran would be a worse lie than the one being fixed. */
  const measured = Number.isFinite(before?.runMs) && before.runMs >= 0 ? Math.floor(before.runMs) : null
  if (shouldRun) {
    /* Already open: leave the interval alone. Re-attaching the same session,
       or a turn moving starting -> running, is not a new run, and restarting
       the interval here would silently drop everything before it. */
    if (open) return { runMs: measured, runStartedAt: before.runStartedAt }
    /* A run BEGINS, so from here it is measurable. A legacy node crossing this
       line takes 0 for the runs nobody measured: the floor, never an
       invented figure. */
    return { runMs: measured ?? 0, runStartedAt: at }
  }
  if (!open) return { runMs: measured, runStartedAt: null }
  const closedAt = Date.parse(at)
  const ran = Number.isFinite(closedAt) ? Math.max(0, closedAt - openedAt) : 0
  return { runMs: (measured ?? 0) + ran, runStartedAt: null }
}

/** The run clock as it comes off disk: the open interval folded shut at the
 *  last write, because the app was closed over the rest of it. */
function loadedRunClock(entry) {
  const measured = Number.isFinite(entry?.runMs) && entry.runMs >= 0 ? Math.floor(entry.runMs) : null
  const openedAt = Date.parse(entry?.runStartedAt)
  if (!Number.isFinite(openedAt)) return { runMs: measured, runStartedAt: null }
  const lastWrite = Date.parse(entry?.updatedAt)
  const ran = Number.isFinite(lastWrite) ? Math.max(0, lastWrite - openedAt) : 0
  return { runMs: (measured ?? 0) + ran, runStartedAt: null }
}

/* WHY A NODE CANNOT BE REMOVED, in the words a person reads.
 *
 * EXPORTED BECAUSE TWO SURFACES SAY THEM. removeNode() below refuses with
 * these, and the palette's "Remove this agent" row shows the same sentence on
 * the row while it cannot be pressed (src/fleet-tree-copy.js REMOVE_PANEL
 * re-exports them). One table, so the reason a row gives and the reason the
 * store would give can never drift apart.
 *
 * The children sentence counts DIRECT reports, because those are the agents a
 * person has to act on: the reports-to picker and the drag are the sanctioned
 * ways to move each one out, and every one moved is one fewer in this count. */
/* Said on the window once a person's removal of an agent has really happened,
   so a page that shows the same computer from its own reads (Home's panel and
   Full view) can drop the agent at once and say it was removed (T1554,
   T1562). detail: { computerId, nodeId, sentence }. */
export const TREE_NODE_REMOVED_EVENT = 'mc-tree-node-removed'

export const NODE_REMOVE_REFUSALS = Object.freeze({
  running: 'Stop this agent first.',
  children: count => `Move or remove its ${numberWord(count)} ${count === 1 ? 'agent' : 'agents'} first.`,
})

/* Bounds, so that a saved record cannot grow without limit and a damaged one
   cannot ask this module to walk a million entries before refusing it. They are
   generous on purpose: they exist to bound the failure, not to ration the
   person's structure. */
export const FLEET_TREE_LIMITS = Object.freeze({
  maxTrees: 64,
  // A defensive saved-document envelope, not a live-process admission rule.
  // The 1,000-node round-trip/queue test exercises the supported scale below it.
  maxNodes: 4096,
  maxNameChars: 80,
  maxRoleChars: 60,
  /* 12,000, NOT 4,000 -- MEASURED 2026-09-03: engine/src/lib/tool-registry.js's
     MAX_TREE_BRIEF_CHARS (the create-and-start-node contract ceiling an
     assistant's expanded brief is validated against BEFORE anything is drawn)
     was raised to 12,000 for exactly this field, and this store-side number is
     the other half of that same rule -- it refuses AGAIN when the node is
     written. Left at 4,000 here, a brief the engine had already accepted
     (measured real range: 4,229-5,035 characters) reached this store and was
     refused a second time. The two numbers must move together; see also
     src/main.js's cleanTreeNodeCommand, which now reads this constant instead
     of restating the number a third time. */
  maxMessageChars: 12000,
  maxNoteChars: 240,
  /* The agent's own answer, kept on the node so "What it said" survives a
     restart. Bounded like the message that asked for it; the WRITER trims
     rather than refuses, because this is machine output — refusing an
     oversized answer would throw the whole answer away to punish its length. */
  maxReplyChars: 4000,
  /* THE LOOP GUARD, NOT THE PRODUCT RULE. How many steps a walk up the parents
     may take before it gives up on the data. The rule a person meets is
     TREE_BOUNDS.maxDepth at the foot of this file, which is the ENGINE's own
     cap and is far smaller; this number only has to be large enough that no
     honest structure hits it and small enough that a looping file cannot spin. */
  maxChainSteps: 64,
})

/* What "no trees" IS. One frozen value, returned by every refusing path in the
   reader, so that a caller comparing against it cannot be fooled by a second
   empty-looking object with a subtly different shape. */
export const EMPTY_FLEET_TREES = Object.freeze({
  version: FLEET_TREES_RECORD_VERSION,
  computerId: null,
  trees: Object.freeze([]),
  nodes: Object.freeze([]),
})

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/* The same identifier rule src/fleet-profile.js applies to machine, pool and
   channel ids, kept in the same shape so an id minted here is acceptable
   anywhere in the app that already validates one. */
const safeIdentifier = value => typeof value === 'string'
  && value.length > 0 && value.length <= 128
  && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)

const safeStamp = value => typeof value === 'string' && value.length > 0 && value.length <= 64

/* A CIRCLE'S ORDINAL IS PART OF ITS NAME, NOT A COUNT OF WHAT HAPPENS TO BE
   BESIDE IT TODAY. The first circle for a role keeps 1 (drawn without a
   suffix), the next keeps 2, and so on. Persisting the number is what prevents
   adding a second Manager from silently renaming the already-running
   "Manager" to "Manager 1" while its tree-directory registration -- and every
   child brief that names it -- still says "Manager". */
// A peer can reserve both a role ordinal and a different rendered address
// (for example an old role label ending in a number). Keep that derived
// numbering envelope separate from how many nodes the saved forest holds.
const safeNameOrdinal = value => Number.isInteger(value)
  && value >= 1 && value <= FLEET_TREE_LIMITS.maxNodes * 2

const ordinalName = (base, ordinal) => ordinal === 1 ? base : `${base} ${ordinal}`
const addressNameKey = value => String(value || '').trim().toLowerCase()
/* THE SHORT FORM OF A CIRCLE'S ID, FOR TELLING TWO IDENTICAL LABELS APART.
   Naming is scoped to (treeId, role) -- see nodeDisplayName -- so two trees each
   number their circles from one and both legitimately hold a "Builder 2". That is
   deliberate and stays. What it costs is a surface showing circles from more than
   one tree, where the label alone stops answering "which one". This returns the
   first eight-hex block of the id, which is the same fragment the roster and
   app context already print (node-24-3839c9e0...), so the suffix a person reads
   here matches the id they see elsewhere. Deterministic, derived only from the
   id, and never stored: nothing about naming or identity changes. */
const shortNodeId = id => {
  const text = String(id || '')
  const hex = /[0-9a-f]{8}/i.exec(text)
  if (hex) return hex[0]
  const segments = text.split('-').filter(Boolean)
  return (segments[segments.length - 1] || text).slice(0, 8)
}

/* A NAME AND A ROLE ARE ONE LINE; A MESSAGE IS NOT.
 *
 * Line breaks and tabs are allowed in the message and nowhere else, because the
 * message is the brief a person types for an agent and briefs have paragraphs.
 * Every other control character is refused in all of them: they are invisible
 * in a panel, so a person cannot see, remove, or even suspect one, and a name
 * that draws differently from the characters it holds is a name that can
 * impersonate another entry in the same list.
 *
 * Angle brackets are NOT refused in the message. A person writing a brief types
 * "->" and "<see the note>" without meaning markup, and refusing their typing
 * to compensate for a screen that might paste it into markup would put the cost
 * of that screen's bug on them.
 *
 * SO THIS IS A REQUIREMENT ON EVERY VIEW THAT DRAWS A MESSAGE, not an
 * observation about the one that draws it today: a role or a message goes to
 * the screen as TEXT — textContent, or escaped the way src/tree-graph.js
 * escapes it — and never as markup a browser is asked to parse. Escaping at
 * rest is not the alternative: it would hand back a person's own words with
 * &amp; in them the next time the panel opened.
 *
 * Deliberately not enforced by a test that reads another lane's file. A guard
 * that greps a view for an escape call fails on the day somebody renames a
 * helper, which red-lights this suite for an edit that changed nothing about
 * the rule — and a gate that cries wolf is one somebody deletes. The rule is
 * stated where the decision that depends on it is made. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const CONTROL_CHARS_EXCEPT_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

const oneLineText = (value, max) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return CONTROL_CHARS.test(trimmed) ? null : trimmed
}

const briefText = (value, max) => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > max) return null
  return CONTROL_CHARS_EXCEPT_BREAKS.test(trimmed) ? null : trimmed
}

/* A role and a message may be EMPTY on a draft, and that is the whole point of
   a draft: the placeholder is pressed first and the panel is filled in second,
   so between those two beats an agent legitimately exists with neither. An
   empty role is stored as '' rather than null so that every node has the same
   shape and no reader has to handle two spellings of "not said yet". */
const optionalOneLine = (value, max) => {
  if (value == null) return ''
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length > max) return null
  return CONTROL_CHARS.test(trimmed) ? null : trimmed
}

const frozenList = list => Object.freeze(list.map(entry => Object.freeze(entry)))
const refuse = (...problems) => Object.freeze({ ok: false, problems: Object.freeze(problems) })

/** A storage face that cannot throw, matching safeStorage in src/checkout-selection.js. */
export function safeTreeStorage(backing) {
  let writeProblem = ''
  return Object.freeze({
    lastWriteProblem: () => writeProblem,
    read(key) {
      try {
        const raw = backing?.getItem(key)
        return typeof raw === 'string' ? JSON.parse(raw) : null
      } catch { return null }
    },
    /* Unlike read(), this preserves the difference between absence, invalid
       JSON and a failed read. The raw cell is also a cheap revision token:
       checking freshness must not re-parse every agent's brief on each beat. */
    readResult(key) {
      try {
        if (typeof backing?.getItem !== 'function') return { ok: false }
        const text = backing.getItem(key)
        return text == null || typeof text === 'string' ? { ok: true, text: text ?? null } : { ok: false }
      } catch { return { ok: false } }
    },
    write(key, value) {
      try {
        if (typeof backing?.setItem !== 'function') { writeProblem = 'Tree storage is unavailable. Close and reopen ToolsEnabled before changing this tree.'; return false }
        backing.setItem(key, JSON.stringify(value)); writeProblem = ''; return true
      }
      catch (error) { writeProblem = error?.message || 'The saved tree change was refused.'; return false }
    },
    /* THE SAME WRITE, FOR A CALLER THAT HAS ALREADY SERIALISED.
     *
     * write() walks the object it is handed, and for the forest that object is
     * every tree and every agent including their 4000-character messages and
     * replies. Re-walking all of it to record one status word was MEASURED
     * 2026-09-03 at 0.4437 ms of the 0.5093 ms a status change cost, on an
     * 11-tree / 66-agent / 155 KiB record — 87% of the change, none of it
     * about what changed. createFleetTreeStore serialises each record once and
     * keeps the text, so it arrives here with the bytes write() would have
     * produced and this door only skips the walk that produced them.
     *
     * Same key, same bytes, same backing, same true/false. It is a second door
     * into one room, not a second room: a seam that offers only { read, write }
     * still works and still costs what it always did. */
    writeText(key, text) {
      try {
        if (typeof backing?.setItem !== 'function') { writeProblem = 'Tree storage is unavailable. Close and reopen ToolsEnabled before changing this tree.'; return false }
        backing.setItem(key, typeof text === 'string' ? text : JSON.stringify(text)); writeProblem = ''; return true
      }
      catch (error) { writeProblem = error?.message || 'The saved tree change was refused.'; return false }
    },
  })
}

/* Walking up from a node to its top, with a hard step limit.
 *
 * The limit is not defensive decoration. This walk runs over data that may have
 * come off disk, and a loop in that data is exactly the damage the walk is
 * being used to detect, so a walk that trusted the data to end would hang the
 * window on the very file it was checking. A chain longer than the step limit is
 * refused rather than followed. */
function ancestorChainIsSound(node, byId) {
  const seen = new Set([node.id])
  let current = node
  for (let step = 0; step < FLEET_TREE_LIMITS.maxChainSteps; step += 1) {
    if (current.parentId == null) return true
    const parent = byId.get(current.parentId)
    if (!parent) return false
    if (parent.treeId !== node.treeId) return false
    if (seen.has(parent.id)) return false
    seen.add(parent.id)
    current = parent
  }
  return false
}

/**
 * Read saved state, whole or not at all.
 *
 * Accepts either the object a storage seam already read or the raw text, so the
 * same rules apply whether the record came from browser storage, a file, or a
 * test fixture. `computerId` is optional: when given, a record belonging to a
 * different computer is refused rather than adopted, which is what makes the
 * key-plus-field pair above worth having.
 *
 * EVERY REFUSAL RETURNS EMPTY_FLEET_TREES. There is no partial success and no
 * repair pass, for the reason stated at the top of this file.
 */
export function parseFleetTrees(value, { computerId = null } = {}) {
  let raw = value
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return EMPTY_FLEET_TREES }
  }
  if (!isPlainObject(raw)) return EMPTY_FLEET_TREES
  if (raw.version !== FLEET_TREES_RECORD_VERSION) return EMPTY_FLEET_TREES
  if (!safeIdentifier(raw.computerId)) return EMPTY_FLEET_TREES
  if (computerId != null && raw.computerId !== computerId) return EMPTY_FLEET_TREES
  if (!Array.isArray(raw.trees) || !Array.isArray(raw.nodes)) return EMPTY_FLEET_TREES
  if (raw.trees.length > FLEET_TREE_LIMITS.maxTrees) return EMPTY_FLEET_TREES
  if (raw.nodes.length > FLEET_TREE_LIMITS.maxNodes) return EMPTY_FLEET_TREES

  /* ONE ID SPACE FOR TREES AND AGENTS TOGETHER. The owner's rule is that ids are
     unique per computer, and the cheapest way for that to stay true under every
     future reader is for it to be true of the ids themselves rather than of
     each list separately. A caller holding a bare id is then never one lookup
     away from the wrong kind of record. */
  const ids = new Set()
  const trees = []
  for (const entry of raw.trees) {
    if (!isPlainObject(entry)) return EMPTY_FLEET_TREES
    if (!safeIdentifier(entry.id) || ids.has(entry.id)) return EMPTY_FLEET_TREES
    /* A TREE MAY HAVE NO NAME OF ITS OWN, and usually does. Its label comes from
       the first message the person typed into it (see treeLabel below), so the
       stored name is only what they typed over that. Null is therefore an
       ordinary value here and not a broken record. */
    const name = entry.name == null ? null : oneLineText(entry.name, FLEET_TREE_LIMITS.maxNameChars)
    if (entry.name != null && name === null) return EMPTY_FLEET_TREES
    if (!safeStamp(entry.createdAt) || !safeStamp(entry.updatedAt)) return EMPTY_FLEET_TREES
    ids.add(entry.id)
    /* profileId is additive and forgiving on purpose: it is a POINTER to a
       main-process profile store, so a dangling id costs nothing here -- the
       start path refuses it loudly there. Anything not a plausible id reads
       as null rather than poisoning the whole record. */
    const profileId = typeof entry.profileId === 'string' && entry.profileId.length <= 128 ? entry.profileId : null
    /* `kind` is additive and forgiving in the same way: the one kind this
       build knows is kept, and anything else reads as an ordinary agent tree
       -- the narrower rule -- rather than poisoning the whole record. An
       ordinary tree carries no `kind` key at all, so its saved bytes are
       exactly what they were before the field existed. */
    const kind = entry.kind === EXPERIMENT_TREE_KIND ? EXPERIMENT_TREE_KIND : null
    if (entry.researchProjectId != null && entry.researchProjectId !== ''
        && (typeof entry.researchProjectId !== 'string' || !/^rp-[0-9a-f]{4,36}$/.test(entry.researchProjectId))) return EMPTY_FLEET_TREES
    const researchProjectId = entry.researchProjectId || null
    const researchProjectName = researchProjectId ? oneLineText(entry.researchProjectName, 120) : null
    trees.push({ id: entry.id, name, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
      profileId: researchProjectId ? null : profileId, ...(kind ? { kind } : {}),
      ...(researchProjectId ? { researchProjectId, researchProjectName } : {}) })
  }

  const treeIds = new Set(trees.map(tree => tree.id))
  const roots = new Set()
  const sessions = new Set()
  const nodes = []
  const byId = new Map()
  for (const entry of raw.nodes) {
    if (!isPlainObject(entry)) return EMPTY_FLEET_TREES
    if (!safeIdentifier(entry.id) || ids.has(entry.id)) return EMPTY_FLEET_TREES
    if (!treeIds.has(entry.treeId)) return EMPTY_FLEET_TREES
    /* A STATUS WORD THIS BUILD DOES NOT KNOW IS QUARANTINED, NOT REFUSED.
       See NODE_STATUS_UNREADABLE. The word is kept verbatim -- whatever JSON
       value it was, so the record goes back exactly as it came -- and the
       node reads as the marker. The structural checks around this line are
       not relaxed by it: an unknown-status node still needs a real id, a real
       tree, sound stamps and a sound parent. */
    const statusReadable = NODE_STATUSES.includes(entry.status)
    if (!safeStamp(entry.createdAt) || !safeStamp(entry.updatedAt)) return EMPTY_FLEET_TREES

    const role = optionalOneLine(entry.role, FLEET_TREE_LIMITS.maxRoleChars)
    if (role === null) return EMPTY_FLEET_TREES
    const message = briefText(entry.message ?? '', FLEET_TREE_LIMITS.maxMessageChars)
    if (message === null) return EMPTY_FLEET_TREES
    const statusNote = briefText(entry.statusNote ?? '', FLEET_TREE_LIMITS.maxNoteChars)
    if (statusNote === null) return EMPTY_FLEET_TREES
    const restriction = entry.researchRestriction
    const researchRestriction = restriction == null ? null : (
      isPlainObject(restriction)
        && restriction.version === 1
        && (restriction.mode === 'folder' || restriction.mode === 'clean-room')
        && (restriction.access === 'read-only' || restriction.access === 'read-write')
        && typeof restriction.root === 'string'
        && (/^[A-Za-z]:[\\/]/.test(restriction.root) || restriction.root.startsWith('/'))
        ? Object.freeze({ version: 1, mode: restriction.mode, access: restriction.access, root: restriction.root })
        : null)
    if (restriction != null && researchRestriction === null) return EMPTY_FLEET_TREES

    const sessionId = entry.sessionId == null ? null : entry.sessionId
    if (sessionId !== null && !safeIdentifier(sessionId)) return EMPTY_FLEET_TREES
    if (sessionId !== null && sessions.has(sessionId)) return EMPTY_FLEET_TREES
    if (entry.status === 'draft' && sessionId !== null) return EMPTY_FLEET_TREES
    if (entry.status === 'running' && sessionId === null) return EMPTY_FLEET_TREES

    /* NOTHING COMES BACK OFF DISK RUNNING.
     *
     * A session cannot outlive the window that owns it, so `running` in a saved
     * file is a claim about a process that stopped when the app closed. Drawing
     * it would put a live-looking agent on the tree with a stop button that
     * reaches nothing, which is the failure src/agent-session-registry.js
     * describes in its own header and deliberately persists nothing to avoid.
     *
     * It comes back as `starting` rather than as a draft, and that is the point
     * of having `starting` at all: it means "a session was asked for, and this
     * window has not been told whether it is live". The id is kept, because it
     * is the only handle anything has for asking. The program answers on mount
     * and the state follows the answer. */
    const status = !statusReadable ? NODE_STATUS_UNREADABLE : entry.status === 'running' ? 'starting' : entry.status

    const parentId = entry.parentId == null ? null : entry.parentId
    if (parentId !== null && !safeIdentifier(parentId)) return EMPTY_FLEET_TREES
    if (parentId === null) {
      if (roots.has(entry.treeId)) return EMPTY_FLEET_TREES
      roots.add(entry.treeId)
    }

    ids.add(entry.id)
    if (sessionId !== null) sessions.add(sessionId)
    const nameOrdinal = entry.nameOrdinal == null ? null : entry.nameOrdinal
    if (nameOrdinal !== null && !safeNameOrdinal(nameOrdinal)) return EMPTY_FLEET_TREES
    /* A BLANK ROLE STILL NEEDS A STABLE NUMBER WHEN IT IS NOT ALONE.
     *
     * MEASURED: this line used to refuse a blank-role node that carried an
     * ordinal, on the theory that a role-less circle has no name worth
     * numbering. It has one anyway -- nodeDisplayName draws it from the
     * generic word plus a count of same-tree, same-role peers -- and a role
     * of '' is a role like any other for that purpose. Refusing the ordinal
     * here left every blank-role circle on the UNSTABLE fallback path
     * nameOrdinal exists to retire (see "A CIRCLE'S ORDINAL IS PART OF ITS
     * NAME" below): its drawn name, and the name a live session registers
     * under, moved every time a same-tree blank-role sibling was created or
     * removed anywhere in the tree -- not even a sibling under the same
     * parent, since nodeDisplayName's peer pool is (treeId, role) alone.
     * A child briefed with the manager's name at one moment could find that
     * name answers TREE_MANAGER_UNREGISTERED the next, for a manager that
     * never stopped running. See tools/test/tree-edges-name-stability.test.mjs
     * for the named-role fix this restores parity with. */

    const node = {
      id: entry.id,
      treeId: entry.treeId,
      parentId,
      role,
      /* Records written before stable circle names have no ordinal. They are
         assigned one below in their saved order, which is the order the old
         display calculation used. */
      nameOrdinal,
      /* The human role label is part of the address, just like its ordinal.
         A missing Role library after restart must not rename a custom role to
         "Agent". Older records get this field from the live library below. */
      ...(oneLineText(entry.nameBase, FLEET_TREE_LIMITS.maxNameChars)
        ? { nameBase: oneLineText(entry.nameBase, FLEET_TREE_LIMITS.maxNameChars) }
        : {}),
      message,
      status,
      ...(statusReadable ? {} : { [SAVED_STATUS]: entry.status }),
      statusNote,
      ...(typeof entry.lastTurnId === 'string' && entry.lastTurnId.length > 0 && entry.lastTurnId.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(entry.lastTurnId) ? { lastTurnId: entry.lastTurnId } : {}),
      /* Forgiving on purpose, unlike the structural fields around it: a reply
         is display text, not shape. An absent one is the empty answer (records
         written before the field existed), and an oversized one is trimmed
         rather than costing the person their whole saved forest. */
      reply: typeof entry.reply === 'string' ? entry.reply.slice(0, FLEET_TREE_LIMITS.maxReplyChars) : '',
      /* Same forgiveness as reply: the tier a node started on is display and
         restart guidance, not shape. Absent means the record predates the
         field, and a restart falls back to the default tier and says so. */
      tier: typeof entry.tier === 'string' ? entry.tier.slice(0, 64) : '',
      /* Effort was added after tier. Old records therefore read as empty and
         keep the tier-derived fallback they had before this field existed. */
      effort: typeof entry.effort === 'string' ? entry.effort.slice(0, 64) : '',
      ...(entry.accountChoice !== undefined ? { accountChoice: normalizeSlotAccountChoice(entry.accountChoice) } : {}),
      ...(entry.roleBindingPending && safeIdentifier(entry.roleBindingPending.sessionId)
        && typeof entry.roleBindingPending.role === 'string' && optionalOneLine(entry.roleBindingPending.role, FLEET_TREE_LIMITS.maxRoleChars) !== null
        ? { roleBindingPending: { sessionId: entry.roleBindingPending.sessionId, role: entry.roleBindingPending.role } } : {}),
      ...(researchRestriction ? { researchRestriction } : {}),
      ...(entry.pendingEditorFork != null ? { pendingEditorFork: normalizePendingEditorFork(entry.pendingEditorFork) } : {}),
      /* THE RUN CLOCK COMES BACK CLOSED, for the same reason the status above
         comes back as `starting` rather than `running`: a session cannot
         outlive the window that owns it, so an interval that was open when
         this file was last written ended when the app closed. The last thing
         anyone measured about it is `updatedAt`. Counting from `runStartedAt`
         to Date.now() instead would bill the agent for every hour the
         application was SHUT, which is the largest and most literal form of
         the owner's "logs time they werent running".
         `runMs: null` is the pre-field record — see advanceRunClock. */
      ...loadedRunClock(entry),
      sessionId,
      /* Both survive a reload, because the rule they serve outlives a window.
         An older record carries neither, and absent reads as false: a circle
         from before this existed was not proven agent-made, so it is not
         removable by an assistant. Absent is the cautious answer. */
      createdByAgent: entry.createdByAgent === true,
      promptedByPerson: entry.promptedByPerson === true,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
    nodes.push(node)
    byId.set(node.id, node)
  }

  /* MIGRATE OLD RECORDS IN MEMORY, DETERMINISTICALLY. Existing explicit
     ordinals win; absent ones take the first unused positive integer in saved
     order. A duplicate explicit ordinal would give two circles one address,
     so the whole broken record is refused under this reader's existing
     all-or-nothing rule. */
  const ordinalsByRole = new Map()
  const ordinalGroup = node => `${node.treeId}\u0000${node.role}`
  for (const node of nodes) {
    /* A blank role pools with itself, same as any named role -- ordinalGroup
       already keys on the literal role string, '' included, so nothing here
       needs to special-case it. See the nameOrdinal reader above for why a
       blank role stopped being excluded from carrying one. */
    if (node.nameOrdinal === null) continue
    const key = ordinalGroup(node)
    const used = ordinalsByRole.get(key) || new Set()
    if (used.has(node.nameOrdinal)) return EMPTY_FLEET_TREES
    used.add(node.nameOrdinal)
    ordinalsByRole.set(key, used)
  }
  for (const node of nodes) {
    if (node.nameOrdinal !== null) continue
    const key = ordinalGroup(node)
    const used = ordinalsByRole.get(key) || new Set()
    let ordinal = 1
    while (used.has(ordinal)) ordinal += 1
    node.nameOrdinal = ordinal
    used.add(ordinal)
    ordinalsByRole.set(key, used)
  }

  /* The parent checks run in a second pass because a record is a list, not a
     drawing: a child may be written before its parent and that is not a
     mistake. What IS one is a parent that is missing, that sits in another
     tree, or that leads back to the child, and none of those can be judged
     until every node has been read. */
  for (const node of nodes) {
    if (!ancestorChainIsSound(node, byId)) return EMPTY_FLEET_TREES
  }

  return Object.freeze({
    version: FLEET_TREES_RECORD_VERSION,
    computerId: raw.computerId,
    trees: frozenList(trees),
    nodes: frozenList(nodes),
  })
}

/* Ids are minted here rather than by the caller so that the uniqueness rule has
   one owner. The store still checks the result: an injected generator is a seam
   a test drives, and a seam a test can drive is a seam that can hand back the
   same id twice. */
function defaultIdFactory() {
  let counter = 0
  return kind => {
    counter += 1
    const unique = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    return `${kind}-${counter}-${unique}`
  }
}

/**
 * The store for one computer's trees.
 *
 * ONE STORE IS ONE COMPUTER. That is why every read here is already scoped and
 * `listTrees()` takes no argument: "the trees on this computer" is the question
 * the owner asked, and a store that also answered it for other computers would
 * invite a screen to draw one computer's structure under another's name.
 *
 * MUTATIONS ARE REPORTED, NOT THROWN. Every write returns a frozen
 * `{ ok, problems, ... }`, because each refusal below corresponds to something
 * a person did in a panel and the panel has to be able to say which one. An
 * exception would leave that sentence to be invented at the call site.
 *
 * OPENING FAILS CLOSED. Bad wiring and an unreadable saved record both throw,
 * so the view can show its unavailable-store state. Neither may masquerade as
 * an empty tree that looks like a fresh install and accepts replacement edits.
 */
export function createFleetTreeStore({
  computerId,
  storage,
  now = () => new Date().toISOString(),
  makeId = defaultIdFactory(),
  onChange = () => {},
  roleLabel = null,
  ownedSessions = null,
  readBounds = readCurrentTreeSlotBounds,
} = {}) {
  if (!safeIdentifier(computerId)) {
    throw new TypeError('createFleetTreeStore needs the id of the computer these trees belong to')
  }
  if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function') {
    throw new TypeError('createFleetTreeStore needs a storage seam with read and write')
  }

  /* An unavailable or refused record is not an empty installation. Opening
     fails before any migration or editing can replace the original bytes.
     The view already has an unavailable-store state with a stated refusal. */
  const key = fleetTreesStorageKey(computerId)
  const readSaved = () => {
    try {
      if (typeof storage.readResult === 'function') {
        const result = storage.readResult(key)
        if (result?.ok !== true || (result.text !== null && typeof result.text !== 'string')) return { ok: false }
        return result
      }
      const value = storage.read(key)
      return { ok: true, text: value == null ? null : typeof value === 'string' ? value : JSON.stringify(value) }
    } catch { return { ok: false } }
  }
  const initial = readSaved()
  if (!initial.ok) throw Object.assign(new Error('The saved trees could not be read. Nothing was replaced.'), { code: 'MC_TREE_STORAGE_UNAVAILABLE' })
  const loaded = parseFleetTrees(initial.text, { computerId })
  if (initial.text !== null && loaded === EMPTY_FLEET_TREES) {
    throw Object.assign(new Error('The saved trees could not be understood. Nothing was replaced.'), { code: 'MC_TREE_STORAGE_INVALID' })
  }
  let expectedText = initial.text
  const trees = new Map(loaded.trees.map(tree => [tree.id, tree]))
  const nodes = new Map(loaded.nodes.map(node => [node.id, node]))
  const listeners = new Set()
  let persistenceFailed = false
  let persistenceProblem = ''

  /* Whole-record saves need a freshness check even when both edits concern
     different nodes. Otherwise removing A's last known node erases B's newer
     tree. This is a conservative guard, not a semantic merge or a cross-process
     lock: callers must provide a current backing cell. Never refresh the token
     after a conflict, because that would authorize this same stale snapshot. */
  const currentStorageProblem = () => {
    const current = readSaved()
    if (!current.ok) return 'The saved trees could not be checked. No tree change was saved. Keep this page open and try again.'
    if (current.text !== expectedText) return 'The saved trees changed after this page read them. This change was not applied. Keep any unsaved words, then reopen the Trees page to read the newer history.'
    return ''
  }

  const record = () => ({
    version: FLEET_TREES_RECORD_VERSION,
    computerId,
    trees: [...trees.values()],
    nodes: [...nodes.values()].map(nodeSavedForm),
  })

  /* WHAT A SAVE COSTS, AND WHY IT IS NO LONGER THE WHOLE FOREST EVERY TIME.
   *
   * PROFILED 2026-09-03 over 11 trees / 66 agents / a 155 KiB record, running
   * 200 status changes: a change cost 0.5093 ms and JSON.stringify of the
   * whole record was 0.4437 ms of it — 87%. None of that work was about the
   * field that changed. Every agent's 4000-character message and reply was
   * re-escaped character by character so that one status word could go from
   * "running" to "finished", and with a burst of status changes across eleven
   * live circles that is the shape of the whole cost.
   *
   * So each record is serialised ONCE and the text is memoised ON THE RECORD
   * ITSELF. Every tree and every node in this store is frozen the moment it
   * enters the map and REPLACED, never edited — putNode, createTree,
   * renameTree, setTreeProfile and parseFleetTrees all hand back a new frozen
   * object — so object identity says exactly "the text I made for this is
   * still true". That is why the memo cannot go stale: a changed record is a
   * different object and misses the memo. It is a WeakMap rather than an id
   * map for the same reason from the other side — a record dropped from the
   * forest takes its text with it, so a removed tree cannot leave 155 KiB of
   * its agents behind, and no removal path has to remember to say so.
   *
   * The document is JOINED from those pieces, and is byte-identical to
   * JSON.stringify(record()): same key order, same elements, same escaping,
   * because JSON.stringify carries no context that could make a nested value
   * serialise differently inside its parent than on its own. Byte-identical
   * is CHECKED rather than reasoned about, in both places the two paths meet:
   * tools/fleet-tree-save-cost-bench.mjs refuses to print a number unless the
   * two seams' stored cells match, and the suite for this drives them
   * through the same burst of quotes, backslashes, renames and removals and
   * compares the files character for character.
   *
   * MEASURED 2026-09-03 by tools/fleet-tree-save-cost-bench.mjs, which runs
   * the same burst through both seams, interleaved, on a machine carrying
   * twenty other lanes. 11 trees / 66 agents / 155 KiB: 0.5325–0.5838 ms a
   * change through the whole-object seam against 0.1445–0.1660 through this
   * one, 3.3–3.7x over three runs. 24 trees / 192 agents / 451 KiB: 1.6734
   * against 0.3851, 4.35x — the win GROWS with the forest, because what is
   * left scaling is a join of ready strings rather than a walk of every field
   * of every agent. Both seams are live code, so the before column cannot rot
   * into a claim about a revision nobody can run.
   *
   * SAME BEAT, SAME BYTES, SAME REPORT. Nothing here defers a write. A change
   * that is on screen is in storage before the call returns, exactly as
   * before, and persistenceFailed still answers for the change that just
   * happened rather than for one a frame ago — which is the whole reason this
   * is a cheaper serialise and not a coalescing timer.
   */
  const savedText = new WeakMap()
  const textOf = entry => {
    const known = savedText.get(entry)
    if (known !== undefined) return known
    /* nodeSavedForm is identity for everything but a marker node, so the memo
       still keys on the record itself; a marker node's copy is made once per
       node object, which is the cost of one small object on a path a marker
       rarely takes. */
    const made = JSON.stringify(nodeSavedForm(entry))
    savedText.set(entry, made)
    return made
  }
  const recordHead = `{"version":${JSON.stringify(FLEET_TREES_RECORD_VERSION)},"computerId":${JSON.stringify(computerId)},"trees":[`
  const recordText = () => {
    const treeTexts = []
    for (const tree of trees.values()) treeTexts.push(textOf(tree))
    const nodeTexts = []
    for (const node of nodes.values()) nodeTexts.push(textOf(node))
    return `${recordHead}${treeTexts.join(',')}],"nodes":[${nodeTexts.join(',')}]}`
  }

  /* A caller handing in only { read, write } keeps the whole-object write
     path, with a serialized revision token for the same freshness guard.
     safeTreeStorage offers raw reads and writeText, so the app keeps the cheap
     door; both write the same bytes to the same key,
     which tools/test/fleet-trees-save-cost.test.mjs asserts by driving the
     two seams through the same burst and comparing the stored cells. */
  const writeSaved = () => {
    persistenceProblem = currentStorageProblem()
    if (persistenceProblem) return false
    try {
      const text = recordText()
      const saved = typeof storage.writeText === 'function'
        ? storage.writeText(key, text) === true
        : storage.write(key, record()) === true
      if (saved) { expectedText = text; return true }
    } catch { /* Report below; retain the last successfully read/written token. */ }
    persistenceProblem = storage.lastWriteProblem?.() || 'The latest tree changes could not be saved. Keep this page open; the changes are still here, but will not survive a reload.'
    return false
  }

  /* THE SAVED WIDTH AND DEPTH ARE READ WHERE THEY DECIDE SOMETHING, NOT WHERE
     THEY ARE MERELY IN THE WAY. readBounds() is a SYNCHRONOUS call into the main
     process, so whoever makes it holds this window still until the main process
     answers -- for as long as a stalled main process takes. snapshot() used to
     make it for every caller, and the Computers view takes a snapshot to look up
     one node's name, once per node, on every render and every streamed event.
     MEASURED 2026-09-21: the LIVE generation (app d46c18f49, 76 saved nodes) read
     232 to 357 times per five seconds, and the real mount of a 76-node forest
     read 1035 times to mount, 171 per twenty streamed deltas and 258 per finished
     turn, none of them wanting a width or a depth (T837).

     So a snapshot asks for them only when its `slotBounds` is read, and once per
     snapshot: an operation that reads the pair twice still sees one pair. Nothing
     is remembered BETWEEN snapshots -- nothing tells this window the saved width
     changed, and a remembered pair would keep offering slots the setting no
     longer allows -- so each snapshot that asks is as fresh as it was before. */
  const currentBounds = () => {
    try { return normalizeTreeSlotBounds(readBounds()) } catch { return null }
  }
  // A caller that already holds this operation's bounds passes them, so a menu
  // over many candidates reads the settings once and not once per candidate.
  const boundsOfTree = (treeId, bounds = currentBounds()) => {
    try { return effectiveTreeSlotBounds(trees.get(treeId), bounds) } catch { return null }
  }
  const snapshot = () => {
    let bounds = null, asked = false
    return Object.freeze({
      get slotBounds() {
        if (!asked) { bounds = currentBounds(); asked = true }
        return bounds
      },
      computerId,
      trees: frozenList([...trees.values()]),
      nodes: frozenList([...nodes.values()]),
      persistenceFailed,
      persistenceProblem,
    })
  }

  const publish = () => {
    const current = snapshot()
    onChange(current)
    for (const listener of listeners) listener(current)
    return current
  }

  const beforeMutation = () => {
    const problem = currentStorageProblem()
    if (!problem) return null
    const changed = !persistenceFailed || persistenceProblem !== problem
    persistenceFailed = true
    persistenceProblem = problem
    const current = changed ? publish() : snapshot()
    return Object.freeze({ ok: false, problems: Object.freeze([problem]), snapshot: current })
  }

  /* Save on the same beat as the change, the way createSelectionStore does:
     there is no save button on a tree the person is building by pressing
     placeholders, so a structure that is on screen and not in storage is a lie
     the next launch tells. */
  function commit() {
    persistenceFailed = !writeSaved()
    return publish()
  }

  // Slot allocation/moves must not publish an in-memory success after native
  // capacity or stale-record admission refused the authoritative save.
  const structuralCheckpoint = () => ({ trees: new Map(trees), nodes: new Map(nodes) })
  const acceptStructure = (payload, before) => {
    persistenceFailed = !writeSaved()
    if (persistenceFailed) {
      if (!storage.lastWriteProblem?.()) persistenceProblem = 'The tree change could not be saved, so it was not applied. Existing slots were preserved.'
      trees.clear(); nodes.clear()
      for (const [id, tree] of before.trees) trees.set(id, tree)
      for (const [id, node] of before.nodes) nodes.set(id, node)
      return Object.freeze({ ok: false, problems: Object.freeze([persistenceProblem]), snapshot: publish() })
    }
    return Object.freeze({ ok: true, problems: Object.freeze([]), ...payload, snapshot: publish() })
  }

  const accept = payload => Object.freeze({ ok: true, problems: Object.freeze([]), ...payload, snapshot: commit() })

  /* ACCEPTED, WITH NOTHING TO SAVE.
   *
   * For a call that asks for a fact the forest already holds. The caller gets
   * the same shape it gets from accept() — same ok, same empty problems, same
   * live snapshot — because from where it stands nothing is different; what is
   * different is that the record is byte for byte what it already was, so
   * writing it again would hand storage 155 KiB (measured 2026-09-03) to store
   * what is already stored and tell every listener to redraw an identical
   * tree. A save is for a change. This is the sentence the existing test for
   * markPromptedByPerson has always spelled out — "saying it twice is the same
   * fact, not an error and not a second write" — now true of the write too. */
  const unchanged = payload => Object.freeze({ ok: true, problems: Object.freeze([]), ...payload, snapshot: snapshot() })

  /* A fresh id, checked against everything this computer already holds. The
     retry is for a generator that collides by accident; the refusal is for one
     that collides every time, which is a defect that must not be answered by an
     endless loop. */
  function mintId(kind) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = makeId(kind)
      if (safeIdentifier(candidate) && !trees.has(candidate) && !nodes.has(candidate)) return candidate
    }
    return null
  }

  const childrenOf = nodeId => frozenList([...nodes.values()].filter(node => node.parentId === nodeId))
  // A child record owns its slot until explicit removal or a move. Runtime death
  // releases provider resources, never its place or saved conversation.
  const slotChildrenOf = childrenOf
  const seatWidthOf = (treeId, bounds) => boundsOfTree(treeId, bounds)?.maxChildren ?? 0
  const nodesOfTree = treeId => [...nodes.values()].filter(node => node.treeId === treeId)
  const rootOf = treeId => nodesOfTree(treeId).find(node => node.parentId === null) || null

  function descendantsOf(nodeId) {
    const collected = []
    const queue = [nodeId]
    while (queue.length > 0) {
      const current = queue.shift()
      for (const node of nodes.values()) {
        if (node.parentId !== current) continue
        collected.push(node.id)
        queue.push(node.id)
      }
    }
    return collected
  }

  function depthOf(node) {
    let depth = 0
    let current = node
    while (current && current.parentId != null && depth < FLEET_TREE_LIMITS.maxChainSteps) {
      current = nodes.get(current.parentId)
      depth += 1
    }
    return depth
  }

  /* How far the structure UNDER this node reaches — 0 for a leaf. A move
     carries the whole branch, so the depth a move must answer for is the
     BRANCH's, not the one node's: dropping a two-level branch under a depth-2
     parent puts its deepest agent past the cap even though the moved node
     itself would fit. */
  function branchHeight(nodeId) {
    let height = 0
    const queue = [[nodeId, 0]]
    while (queue.length > 0) {
      const [current, depth] = queue.shift()
      for (const node of nodes.values()) {
        if (node.parentId !== current) continue
        if (depth + 1 > height) height = depth + 1
        if (depth + 1 < FLEET_TREE_LIMITS.maxChainSteps) queue.push([node.id, depth + 1])
      }
    }
    return height
  }

  /* ONE STAMP for the write and for the run clock: an interval that opened a
     millisecond before or after the write it belongs to would make the two
     fields describe slightly different moments, and the difference shows up
     as a digit that disagrees with the state word beside it. */
  const putNode = (node, fields) => {
    const at = now()
    const merged = { ...node, ...fields }
    /* The saved word rides only with the marker. A write that sets a KNOWN
       status is this build deciding the state, and the word it could not read
       is then history, not something to put back over the new one. */
    if (merged.status !== NODE_STATUS_UNREADABLE) delete merged[SAVED_STATUS]
    const next = Object.freeze({ ...merged, ...advanceRunClock(node, merged, at), updatedAt: at })
    nodes.set(next.id, next)
    return next
  }

  const resolvedRoleName = role => {
    if (typeof roleLabel !== 'function') return null
    try { return oneLineText(roleLabel(role), FLEET_TREE_LIMITS.maxNameChars) } catch { return null }
  }
  const nameBaseOf = node => oneLineText(node?.nameBase, FLEET_TREE_LIMITS.maxNameChars) || resolvedRoleName(node?.role)
  const addressOf = node => {
    const base = nameBaseOf(node)
    return base && safeNameOrdinal(node.nameOrdinal) ? addressNameKey(ordinalName(base, node.nameOrdinal)) : null
  }

  const nextNameOrdinal = (treeId, role, exceptNodeId = null, base = resolvedRoleName(role)) => {
    const used = new Set()
    const addresses = new Set()
    for (const node of nodes.values()) {
      if (node.id === exceptNodeId || node.treeId !== treeId) continue
      if (node.role === role && safeNameOrdinal(node.nameOrdinal)) used.add(node.nameOrdinal)
      const address = addressOf(node)
      if (address) addresses.add(address)
    }
    let ordinal = 1
    while (used.has(ordinal) || (base && addresses.has(addressNameKey(ordinalName(base, ordinal))))) ordinal += 1
    return ordinal
  }

  /* Labels are not unique role IDs: manager_5 and the fifth manager both
     spell "Manager 5". Reserve every retained address before assigning any
     replacement, so repairing one collision cannot rename an unrelated node.
     Metadata migration preserves timestamps and the stopped run clock. */
  const refreshNameRecords = () => {
    const addresses = new Map()
    const ordinals = new Map()
    const candidates = [...nodes.values()].map(node => ({ node, base: nameBaseOf(node) }))
      .filter(entry => entry.base)
      .sort((a, b) => Number(Boolean(b.node.nameBase)) - Number(Boolean(a.node.nameBase)))
    for (const node of nodes.values()) {
      const group = `${node.treeId}\u0000${node.role}`
      const used = ordinals.get(group) || new Set()
      used.add(node.nameOrdinal)
      ordinals.set(group, used)
    }
    for (const candidate of candidates) {
      const { node, base } = candidate
      const used = addresses.get(node.treeId) || new Set()
      const preferred = addressNameKey(ordinalName(base, node.nameOrdinal))
      candidate.collision = used.has(preferred)
      if (!candidate.collision) used.add(preferred)
      addresses.set(node.treeId, used)
    }
    let changed = 0
    for (const { node, base, collision } of candidates) {
      let ordinal = node.nameOrdinal
      if (collision) {
        const used = ordinals.get(`${node.treeId}\u0000${node.role}`)
        const names = addresses.get(node.treeId)
        ordinal = 1
        while (used.has(ordinal) || names.has(addressNameKey(ordinalName(base, ordinal)))) ordinal += 1
        used.add(ordinal)
        names.add(addressNameKey(ordinalName(base, ordinal)))
      }
      if (node.nameBase === base && node.nameOrdinal === ordinal) continue
      nodes.set(node.id, Object.freeze({ ...node, nameBase: base, nameOrdinal: ordinal }))
      changed += 1
    }
    return changed
  }
  if (refreshNameRecords() > 0) persistenceFailed = !writeSaved()

  function refreshAfterMaintenance({ before, after } = {}) {
    const refused = () => ({ ok: false, code: 'MC_SAVED_TREE_REFRESH_REFUSED' })
    if (persistenceFailed || expectedText !== before || readSaved().text !== after) return refused()
    const changed = planSavedTreeMaintenance(before, after, nodes)
    if (!changed || parseFleetTrees(after, { computerId }) === EMPTY_FLEET_TREES) return refused()
    for (const [id, node] of changed) nodes.set(id, node)
    expectedText = after
    if (changed.length) publish()
    return { ok: true, changed: changed.length }
  }
  registerSavedTreeMaintenance(key, refreshAfterMaintenance)

  return Object.freeze({
    snapshot,
    refreshAfterMaintenance,
    refreshNodeNames() {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const changed = refreshNameRecords()
      return changed > 0 ? accept({ changed }) : unchanged({ changed: 0 })
    },
    listTrees: () => frozenList([...trees.values()]),
    getTree: treeId => trees.get(treeId) || null,
    listNodes: treeId => frozenList(nodesOfTree(treeId)),
    getNode: nodeId => nodes.get(nodeId) || null,
    childrenOf,
    rootOf,

    /**
     * WHAT A TREE IS CALLED, DECIDED IN ONE PLACE.
     *
     * The tab, the graph and the panel all ask this function, because three
     * files each deriving a name is three names for one tree the first time one
     * of them is changed.
     *
     * The order is the owner's: the words the person typed over it, then the
     * FIRST MESSAGE they sent an agent in it, then a counted fallback. The
     * middle step is the one that does the work — telling two trees apart is the
     * whole reason a computer may hold more than one, and "Ship the installer"
     * beside "Fix the login bug" does that where "Tree 1" beside "Tree 2" is
     * only a way of saying there are two.
     *
     * The count is last and is never the answer while any message exists.
     */
    treeLabel(treeId) {
      const tree = trees.get(treeId)
      if (!tree) return null
      if (tree.name) return tree.name
      const derived = displayName(treeRecord(snapshot(), treeId))
      if (derived !== 'New tree') return derived
      return `Tree ${[...trees.keys()].indexOf(treeId) + 1}`
    },

    /* A second way to hear about a change, next to the onChange handed in at
       build time. Two listeners is not a luxury here: the graph and the panel
       are separate pieces of the same screen and either can be built or thrown
       away without the other. Returns the way to stop listening, because a
       listener that outlives its panel keeps a dead view alive in memory and
       paints into a container nobody can see. */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    /**
     * Where a placeholder may be pressed, which is the owner's flow expressed
     * as data.
     *
     * Three kinds, and they are separate because they read differently on
     * screen and cost differently to press: `child` extends an existing
     * structure below an agent that is already there, `root` fills the empty
     * top of a tree that has no agents yet, and `tree` starts a second
     * structure on this computer. The last one disappears at the tree limit
     * rather than being offered and then refused.
     */
    /* One agent's direct child slots, with the same admission the store
       applies to an add (treeSlotUsage/planNodeAdd). Every door that offers
       "start an agent under this one" asks this, so a door cannot stay open
       where the ↳+ button is already hidden (T1377). */
    childSlot(nodeId) {
      return treeSlotUsage(snapshot(), nodeId)
    },

    extensionPoints() {
      // One offer operation observes one bounds pair. Neither width/depth nor
      // siblings may read different settings, and streaming must not trigger
      // a synchronous settings read and a forest scan for each candidate.
      const bounds = currentBounds()
      const points = [], roots = new Set(), childCounts = new Map(), treeBounds = new Map()
      for (const node of nodes.values()) {
        if (node.parentId === null) roots.add(node.treeId)
        else childCounts.set(node.parentId, (childCounts.get(node.parentId) || 0) + 1)
      }
      for (const tree of trees.values()) {
        if (!roots.has(tree.id)) points.push({ kind: 'root', treeId: tree.id, parentId: null })
        treeBounds.set(tree.id, bounds ? effectiveTreeSlotBounds(tree, bounds) : null)
      }
      for (const node of nodes.values()) {
        /* A SLOT THE TREE WOULD REFUSE IS NOT DRAWN. The caps are four agents
           under one (the tree's own width, below the engine's backstop of
           eight) and four levels in all (the engine's own depth), and a
           placeholder past either of them can only be pressed, filled in, and
           turned down by something the person cannot see. Refusing to offer it
           is the only version of that refusal they can act on. */
        const limits = treeBounds.get(node.treeId)
        if (!limits || (childCounts.get(node.id) || 0) >= limits.maxChildren) continue
        if (depthOf(node) + 1 > limits.maxDepth) continue
        points.push({ kind: 'child', treeId: node.treeId, parentId: node.id })
      }
      if (trees.size < FLEET_TREE_LIMITS.maxTrees) points.push({ kind: 'tree', treeId: null, parentId: null })
      return frozenList(points)
    },

    /* A NAME IS OPTIONAL, because the name that matters is derived. A tree
       nobody has typed into yet has nothing to be called, and inventing
       something for it is how a tab ends up saying a word the person never
       wrote. treeLabel() below is where the words come from. */
    createTree({ name = null } = {}) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const clean = name == null || String(name).trim() === ''
        ? null
        : oneLineText(name, FLEET_TREE_LIMITS.maxNameChars)
      if (name != null && String(name).trim() !== '' && clean === null) {
        return refuse(`Keep the name to one line of ${FLEET_TREE_LIMITS.maxNameChars} characters or fewer.`)
      }
      if (trees.size >= FLEET_TREE_LIMITS.maxTrees) {
        return refuse(`The computer you are driving holds ${FLEET_TREE_LIMITS.maxTrees} trees already. Remove one to add another.`)
      }
      /* One empty tree at a time, and the reason is planTreeAdd's to give. What
         belongs here is that the rule is checked in the STORE and not only
         where the button is drawn, and that the sentence comes from that same
         function, so what a caller is told and what the tab shows cannot
         drift. */
      const plan = planTreeAdd([...trees.keys()].map(existing => treeRecord(snapshot(), existing)))
      if (!plan.allowed) return refuse(plan.reason)
      const id = mintId('tree')
      if (id === null) return refuse('Could not make a name for this tree. Try again.')
      const stamp = now()
      const tree = Object.freeze({ id, name: clean, createdAt: stamp, updatedAt: stamp, profileId: null })
      trees.set(id, tree)
      return accept({ tree })
    },

    /* WHICH PROFILE THIS TREE'S AGENTS START UNDER. A pointer, not a path:
       the main process owns the folders and refuses dangling ids at start.
       Null means the product's own workspace, which is what every tree meant
       before profiles existed. */
    setTreeProfile(treeId, profileId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const tree = trees.get(treeId)
      if (!tree) return refuse('That tree is not on the computer you are driving.')
      if (tree.researchProjectId) return refuse('This tree works on a research project. Start a new tree to choose a working folder.')
      const clean = typeof profileId === 'string' && profileId && profileId.length <= 128 ? profileId : null
      trees.set(treeId, Object.freeze({ ...tree, profileId: clean, updatedAt: now() }))
      /* accept() commits, which saves AND tells every listener -- see commit()
         above. This used to call `persist()` and `notify()` first: two names
         nothing in this file ever bound, so assigning a folder to a tree threw
         a ReferenceError before it could return, on every press. */
      return accept({ treeId, profileId: clean })
    },

    treeProfile(treeId) {
      return trees.get(treeId)?.profileId || null
    },

    setTreeResearchProject(treeId, projectId, name = '') {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const tree = trees.get(treeId)
      if (!tree) return refuse('That tree is not on the computer you are driving.')
      const clean = projectId == null || projectId === '' ? null : projectId
      if (clean !== null && (typeof clean !== 'string' || !/^rp-[0-9a-f]{4,36}$/.test(clean))) return refuse('Choose a saved research project.')
      const projectName = clean ? oneLineText(name, 120) : null
      if (clean === (tree.researchProjectId || null) && (!clean || projectName === tree.researchProjectName)) return unchanged({ tree })
      if (nodesOfTree(treeId).some(node => node.sessionId || LIVE_STATUSES.has(node.status))) return refuse('This tree has started. Start a new tree to choose a different research project.')
      const next = Object.freeze({ ...tree, profileId: clean ? null : tree.profileId,
        researchProjectId: clean, researchProjectName: projectName, updatedAt: now() })
      trees.set(treeId, next)
      return accept({ tree: next })
    },

    renameTree(treeId, name) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const tree = trees.get(treeId)
      if (!tree) return refuse('That tree is not on the computer you are driving.')
      /* Renaming to nothing is not a mistake to refuse: it is "go back to
         calling it what I said to my first agent", which is the name it had
         before anybody typed over it. */
      const blank = name == null || String(name).trim() === ''
      const clean = blank ? null : oneLineText(name, FLEET_TREE_LIMITS.maxNameChars)
      if (!blank && clean === null) {
        return refuse(`Keep the name to one line of ${FLEET_TREE_LIMITS.maxNameChars} characters or fewer.`)
      }
      const next = Object.freeze({ ...tree, name: clean, updatedAt: now() })
      trees.set(treeId, next)
      return accept({ tree: next })
    },

    /* Removing a tree removes its agents with it. The alternative — agents left
       behind naming a tree that is gone — is the exact shape the reader above
       refuses to load, so letting a store produce it would mean building a
       structure that cannot survive a restart. */
    removeTree(treeId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const tree = trees.get(treeId)
      if (!tree) return refuse('That tree is not on the computer you are driving.')
      /* THE AGENTS COME BACK, NOT JUST THEIR IDS. Once they are out of this
         store nothing can look their sessions up, so a caller holding only ids
         has no way to stop a run it just removed from the screen — work still
         going with nothing on the page naming it. Handing back the records
         themselves is what makes "remove this tree, and stop what was in it" a
         thing the caller can actually do. */
      const removedNodes = nodesOfTree(treeId)
      const removedNodeIds = removedNodes.map(node => node.id)
      for (const nodeId of removedNodeIds) nodes.delete(nodeId)
      trees.delete(treeId)
      return accept({
        removedTreeId: treeId,
        removedTree: tree,
        removedNodeIds: Object.freeze(removedNodeIds),
        removedNodes: frozenList(removedNodes),
      })
    },

    /**
     * Add an agent, as a draft, in one of three places.
     *
     *   under a parent       `parentId` names an agent that already exists; the
     *                        new one joins that agent's tree.
     *   at the top of a tree `treeId` names an existing tree that has no top
     *                        agent yet.
     *   in a new tree        neither is given, so a tree is made for it.
     *
     * IT IS ALWAYS A DRAFT, whatever was passed. The panel that fills in a role
     * and a message opens AFTER the placeholder is pressed, so a caller cannot
     * yet know either, and a caller that thinks it does is describing a launch
     * rather than a placeholder.
     */
    addNode({ treeId = null, parentId = null, role = '', message = '', tier = '', effort = '', madeByAgent = false, reservedNodeId = null, pendingEditorFork = null, treeKind = null } = {}) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const checkpoint = structuralCheckpoint()
      const slotBounds = currentBounds()
      if (!slotBounds) return refuse(TREE_SLOT_UNAVAILABLE)
      /* A KIND IS GIVEN ONCE, TO A NEW TREE, BY THE CODE THAT BUILDS IT. The
         only caller is the research-grid dispatcher (src/research-experiments.js),
         which marks the tree it makes so the agent-tree width does not apply to
         it. Never inferred from a name or a role, and never granted to a tree
         that already exists, so no person's tree can wander into the exemption. */
      if (treeKind !== null && treeKind !== EXPERIMENT_TREE_KIND) return refuse('That kind of tree is not one this computer keeps.')
      if (treeKind !== null && (treeId != null || parentId != null)) return refuse('Only a new tree can be given a kind.')
      const editorSource = normalizePendingEditorFork(pendingEditorFork)
      if (editorSource?.invalid) return refuse('The editor copy source is invalid. Choose the editor session again.')
      if (reservedNodeId !== null && (!safeIdentifier(reservedNodeId) || nodes.has(reservedNodeId))) {
        return refuse('The reserved name for this agent is invalid or already in use.')
      }
      const cleanTier = optionalOneLine(tier, 64)
      if (cleanTier === null) {
        return refuse('Keep the tier to one line of 64 characters or fewer.')
      }
      const cleanEffort = optionalOneLine(effort, 64)
      if (cleanEffort === null) {
        return refuse('Keep the effort to one line of 64 characters or fewer.')
      }
      const cleanRole = optionalOneLine(role, FLEET_TREE_LIMITS.maxRoleChars)
      if (cleanRole === null) {
        return refuse(`Keep the role to one line of ${FLEET_TREE_LIMITS.maxRoleChars} characters or fewer.`)
      }
      const cleanMessage = briefText(message ?? '', FLEET_TREE_LIMITS.maxMessageChars)
      if (cleanMessage === null) {
        return refuse(`Shorten the message to ${FLEET_TREE_LIMITS.maxMessageChars} characters or fewer.`)
      }
      if (nodes.size >= FLEET_TREE_LIMITS.maxNodes) {
        return refuse(`The computer you are driving holds ${FLEET_TREE_LIMITS.maxNodes} agents already. Remove one to add another.`)
      }

      let parent = null
      let targetTreeId = treeId
      if (parentId != null) {
        parent = nodes.get(parentId)
        if (!parent) return refuse('That agent is not on the computer you are driving.')
        if (treeId != null && treeId !== parent.treeId) {
          return refuse('That agent belongs to a different tree. Add the new agent under one in the same tree.')
        }
        targetTreeId = parent.treeId
        /* The same two engine caps extensionPoints draws by. They are checked
           again here because a caller may add without ever asking where a
           placeholder was: a rule kept only in the drawing is not a rule. */
        const refusal = planNodeAdd(treeRecord(snapshot(), parent.treeId), parent.id, { bounds: slotBounds })
        if (!refusal.allowed) return refuse(refusal.reason)
      } else if (treeId != null) {
        if (!trees.has(treeId)) return refuse('That tree is not on the computer you are driving.')
        if (rootOf(treeId) !== null) {
          return refuse('That tree already has a top agent. Add this one under an agent that is there.')
        }
      } else {
        if (trees.size >= FLEET_TREE_LIMITS.maxTrees) {
          return refuse(`The computer you are driving holds ${FLEET_TREE_LIMITS.maxTrees} trees already. Remove one to add another.`)
        }
        const treeIdForNew = mintId('tree')
        if (treeIdForNew === null) return refuse('Could not make a name for this tree. Try again.')
        const stamp = now()
        /* NO NAME IS PUT ON IT HERE. The role was briefly used for this and it
           was wrong twice over: a role is a job title, not a subject, and two
           trees whose top agent is a builder would then wear the same tab. The
           label comes from the first message instead — see treeLabel(). */
        trees.set(treeIdForNew, Object.freeze({
          id: treeIdForNew,
          name: null,
          createdAt: stamp,
          updatedAt: stamp,
          ...(treeKind ? { kind: treeKind } : {}),
        }))
        targetTreeId = treeIdForNew
      }

      const id = reservedNodeId ?? mintId('node')
      if (id === null) return refuse('Could not make a name for this agent. Try again.')
      const stamp = now()
      const nameBase = resolvedRoleName(cleanRole)
      const node = Object.freeze({
        id,
        treeId: targetTreeId,
        parentId: parent ? parent.id : null,
        role: cleanRole,
        nameOrdinal: nextNameOrdinal(targetTreeId, cleanRole, null, nameBase),
        ...(nameBase ? { nameBase } : {}),
        message: cleanMessage,
        status: 'draft',
        statusNote: '',
        reply: '',
        tier: cleanTier,
        effort: cleanEffort,
        ...(editorSource ? { pendingEditorFork: editorSource } : {}),
        /* 0, not null: this node is measured from birth, and it has run for
           none of it yet. null is reserved for records written before the run
           clock existed, whose past cannot be recovered. */
        runMs: 0,
        runStartedAt: null,
        sessionId: null,
        /* WHO MADE THIS CIRCLE, AND WHETHER THE PERSON HAS EVER SPOKEN TO IT.

           The owner's rule for removal, verbatim 2026-09-03: "agents that were
           spawned by agents AND who the user hasnt prompted - THEY can be
           removed by parent agents. AGENTS that a user prompts even if created
           by another agent can remain".

           Both halves are FACTS ABOUT WHAT HAPPENED, recorded where they
           happen, never claimed by the caller asking for a removal. A circle
           made by hand is false here and stays false; a circle an assistant
           made is marked at the moment it is made. `promptedByPerson` is set
           the first time a person's own turn reaches it and is never unset --
           the owner's rule is about whether they ever spoke to it, not about
           whether they spoke recently. */
        createdByAgent: madeByAgent === true,
        promptedByPerson: false,
        createdAt: stamp,
        updatedAt: stamp,
      })
      nodes.set(id, node)
      return acceptStructure({ node, tree: trees.get(targetTreeId) }, checkpoint)
    },

    /**
     * Write what the right-side panel collected.
     *
     * ONLY WHILE IT IS A DRAFT. Once a session has been asked for, the message
     * is what was SENT, and a panel that let it be edited afterwards would show
     * the person a brief their agent never received. Editing is refused with a
     * sentence saying so, rather than accepted and quietly dropped.
     */
    setNodeLaunchPreferences(nodeId, { tier, effort, accountChoice } = {}) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      const fields = {}
      for (const [key, value] of Object.entries({ tier, effort })) {
        if (value === undefined) continue
        const clean = optionalOneLine(value, 64)
        if (clean === null) return refuse('Keep the next session settings to one line of 64 characters or fewer.')
        fields[key] = clean
      }
      if (accountChoice !== undefined) {
        const normalized = normalizeSlotAccountChoice(accountChoice)
        if (normalized?.unavailable) return refuse('Choose an available account name and provider for this slot.')
        fields.accountChoice = normalized
      }
      const checkpoint = structuralCheckpoint()
      return acceptStructure({ node: putNode(node, fields) }, checkpoint)
    },

    setNodeRole(nodeId, role, { pendingSessionId = null, appliedRole = null } = {}) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      const cleanRole = optionalOneLine(role, FLEET_TREE_LIMITS.maxRoleChars)
      if (cleanRole === null) return refuse('Choose a role from the Role library.')
      if (pendingSessionId !== null && (!safeIdentifier(pendingSessionId) || typeof appliedRole !== 'string'
          || optionalOneLine(appliedRole, FLEET_TREE_LIMITS.maxRoleChars) === null)) return refuse('The current role binding could not be established.')
      const checkpoint = structuralCheckpoint()
      const nameBase = resolvedRoleName(cleanRole)
      const fields = { role: cleanRole, nameBase,
        roleBindingPending: pendingSessionId ? { sessionId: pendingSessionId, role: appliedRole } : null,
        nameOrdinal: cleanRole === node.role ? node.nameOrdinal : nextNameOrdinal(node.treeId, cleanRole, node.id, nameBase) }
      return acceptStructure({ node: putNode(node, fields) }, checkpoint)
    },

    updateNode(nodeId, { role, message } = {}) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      if (node.status !== 'draft') {
        return refuse('This agent has already started, so its role and message stay as they were sent.')
      }
      const fields = {}
      if (role !== undefined) {
        const cleanRole = optionalOneLine(role, FLEET_TREE_LIMITS.maxRoleChars)
        if (cleanRole === null) {
          return refuse(`Keep the role to one line of ${FLEET_TREE_LIMITS.maxRoleChars} characters or fewer.`)
        }
        fields.role = cleanRole
        if (cleanRole !== node.role) {
          fields.nameBase = resolvedRoleName(cleanRole)
          fields.nameOrdinal = nextNameOrdinal(node.treeId, cleanRole, node.id, fields.nameBase)
        }
      }
      if (message !== undefined) {
        const cleanMessage = briefText(message ?? '', FLEET_TREE_LIMITS.maxMessageChars)
        if (cleanMessage === null) {
          return refuse(`Shorten the message to ${FLEET_TREE_LIMITS.maxMessageChars} characters or fewer.`)
        }
        fields.message = cleanMessage
      }
      return accept({ node: putNode(node, fields) })
    },

    /**
     * Re-hang a branch — inside its tree, or under a parent in another one.
     *
     * This is where the no-loop rule earns its keep. Adding always appends below
     * something that already exists, so a loop cannot be built by adding alone;
     * it takes a move, or a saved file somebody edited. Both are guarded, by the
     * same walk.
     *
     * Moving between trees was refused until 2026-08-13 on the ground that it
     * would "silently rewrite the tree of every agent under it". The measured
     * first run showed why that had to change: every agent begins as its own
     * single-node tree, so connecting two agents — the owner's stated ask — IS
     * a cross-tree move. The rewrite is now the move's explicit meaning, done
     * here in the store where the caps and the cleanup live, never implied.
     */
    moveNode(nodeId, parentId = null) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const checkpoint = structuralCheckpoint()
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      if (parentId === node.parentId) return accept({ node })

      if (parentId == null) {
        const currentRoot = rootOf(node.treeId)
        if (currentRoot && currentRoot.id !== node.id) {
          return refuse('This tree already has a top agent. Move that one first, or pick a parent.')
        }
        return acceptStructure({ node: putNode(node, { parentId: null }) }, checkpoint)
      }

      const parent = nodes.get(parentId)
      if (!parent) return refuse('That agent is not on the computer you are driving.')
      if (parent.id === node.id || descendantsOf(node.id).includes(parent.id)) {
        return refuse('An agent cannot report to itself or to one of its own agents. Pick another.')
      }
      /* THE SAME CAPS THE "+" BUTTONS LIVE BY. Until 2026-08-13 a move checked
         neither, so it was the one write that could build a child past the cap
         or a four-level branch — shapes every other path refuses — after which
         extensionPoints() silently withdrew the person's own "+" slots. The
         branch's HEIGHT rides in the depth check because the move carries
         everything under the node. */
      const bounds = boundsOfTree(parent.treeId)
      if (!bounds) return refuse(TREE_SLOT_UNAVAILABLE)
      const parentSeats = slotChildrenOf(parent.id).length
      const parentWidth = bounds.maxChildren
      if (parentSeats >= parentWidth) {
        return refuse(`${seatsFullSentence(parentSeats, parentWidth)} Pick another parent.`)
      }
      if (depthOf(parent) + 1 + branchHeight(node.id) > bounds.maxDepth) {
        return refuse(`A tree goes ${numberWord(bounds.maxDepth + 1)} levels deep at most, and this agent's own branch comes with it. Pick a parent higher up.`)
      }
      /* ACROSS TREES IS A CONNECTION, NOT AN ACCIDENT. The old contract
         refused this outright because a DRAG that silently rewrote the tree
         of everything underneath would show a person a structure they did not
         draw. But the measured first-run reality (2026-08-13) is that every
         agent starts as its own single-node tree — the top-level "+" makes
         one each — so "connect these two" IS a cross-tree move, and the owner
         asked for exactly that in words. The rewrite is now the deliberate,
         stated meaning of the move: the node and everything under it join the
         parent's tree, and a tree left empty is removed rather than kept as
         an invisible husk that blocks the one-empty-tree rule. */
      /* THE ORDINAL MOVES WITH THE NODE, BUT ONLY WHEN IT ACTUALLY HAS TO.
       *
       * MEASURED 2026-09-03: a "Worker" ordinal 1 in the source tree, dragged
       * onto a parent in a tree that already has its OWN "Worker" ordinal 1,
       * landed as two nodes sharing one tree, one role, one ordinal. Every
       * caller that names a circle by role-plus-ordinal (nodeDisplayName
       * below, so both the Computers rail and the Ledger filing box) then
       * drew the SAME WORDS over two different agents — the one on screen
       * became unreachable by name, indistinguishable from its new sibling.
       * Worse: the next save round-trips the record through this file's own
       * parseFleetTrees(), whose ordinal-uniqueness check (above) treats that
       * as a broken record and returns EMPTY_FLEET_TREES — every tree on the
       * computer, not only the moved one, gone on the next launch.
       *
       * THE FIX LANDED THE SAME DAY CALLED nextNameOrdinal() UNCONDITIONALLY,
       * for every moved node on every cross-tree move — and MEASURED, also
       * 2026-09-03, that this traded the collision for the exact loss
       * nameOrdinal exists to prevent (see "A CIRCLE'S ORDINAL IS PART OF ITS
       * NAME" above): nextNameOrdinal() hands back the smallest free number,
       * not the number this node already held, so a "Worker 2" already
       * RUNNING — already registered with the tree directory and named in
       * any child's own brief under that exact name — dragged onto a parent
       * in a tree with no "Worker" in it at all, nothing to collide with,
       * still came back renamed to plain "Worker". A reproduction against
       * the unmodified store confirmed it: a running node's ordinal changed
       * 2 -> 1 on a move into a tree holding zero same-role peers. The move
       * is "connect these two agents", not "rename this one", and an
       * already-registered name is not the move's to spend just because a
       * smaller number happens to be free on the other side.
       *
       * So: a moved node KEEPS the ordinal it already carries unless the
       * destination (treeId, role) already holds another node — one not
       * moving alongside it — sitting on that exact number. Only then is
       * nextNameOrdinal() asked for a fresh one, which is the one case it
       * was always right for. `movedSet` is what makes that check honest: a
       * node elsewhere in the SAME branch can never count as a collision
       * (the two could not have shared a number in their shared source tree
       * to begin with), so this cannot reintroduce the 2026-09-03 bug by
       * quietly forgiving a real collision instead of a false one.
       *
       * A MOVED BRANCH CAN COLLIDE WITH ITSELF, AND THE SINGLE PASS BELOW
       * USED TO MISS IT.
       *
       * MEASURED 2026-09-03 (round 3), against the unmodified store: a
       * "Worker" ordinal 1 with its OWN CHILD also "Worker" ordinal 2 — an
       * ordinary report-to-your-senior-worker chain, dragged as one branch —
       * onto a parent in a tree that already held a "Worker" ordinal 1 of its
       * own. A single loop over `movedIds` reads the parent first: it
       * collides with the destination's existing "Worker 1" and is handed a
       * fresh number by nextNameOrdinal(), which returns 2 — the smallest
       * free number IT CAN SEE, because the child had not been written under
       * the destination treeId yet and so did not show up in its scan. The
       * loop then reads the child: nothing external sits on 2 (`movedSet`
       * rightly keeps its own parent from counting against it), so it keeps
       * the 2 it already had. Two members of ONE branch land in the
       * destination both called "Worker 2" — reproduced with both nodes
       * carrying a live session, exactly the "already registered" case the
       * fix above this one exists to protect — and the very next save
       * refuses the WHOLE record on reload for the reason described above:
       * every tree on the computer gone, not only the moved branch.
       *
       * FIX: nothing about what counts as an external collision changes —
       * `movedSet` still excludes the whole branch from counting against
       * itself, exactly as before — only the ORDER in which members are
       * written does. A first pass commits every member that does not
       * collide with something already standing in the destination; a second
       * pass asks nextNameOrdinal() for the few that do. By the second pass
       * every keeper already sits under the destination's treeId, so the
       * scan that used to miss a not-yet-moved sibling now sees it, because
       * it has already been written — the ordering nextNameOrdinal() needed
       * all along, not a new rule about who may collide with whom. */
      const sourceTreeId = node.treeId
      const movedIds = [node.id, ...descendantsOf(node.id)]
      if ((trees.get(sourceTreeId)?.researchProjectId || null) !== (trees.get(parent.treeId)?.researchProjectId || null)
          && movedIds.some(id => nodes.get(id)?.sessionId || LIVE_STATUSES.has(nodes.get(id)?.status))) {
        return refuse('This branch has started in a different research workspace. Start a new agent in the destination tree.')
      }
      const movedSet = new Set(movedIds)
      const collidesExternally = moved => safeNameOrdinal(moved.nameOrdinal) && [...nodes.values()].some(other => (
        !movedSet.has(other.id) && other.treeId === parent.treeId
        && ((other.role === moved.role && other.nameOrdinal === moved.nameOrdinal)
          || (addressOf(moved) && addressOf(other) === addressOf(moved)))
      ))
      const toReassign = []
      for (const movedId of movedIds) {
        const moved = nodes.get(movedId)
        if (!moved || moved.treeId === parent.treeId) continue
        if (collidesExternally(moved)) { toReassign.push(moved); continue }
        putNode(moved, { treeId: parent.treeId, nameOrdinal: moved.nameOrdinal })
      }
      /* Only the members that genuinely collided reach nextNameOrdinal(), and
         every keeper above is already written by the time any of them do —
         see the comment above for why that order is the whole fix. */
      for (const moved of toReassign) {
        putNode(moved, { treeId: parent.treeId, nameOrdinal: nextNameOrdinal(parent.treeId, moved.role, moved.id, nameBaseOf(moved)) })
      }
      const result = putNode(nodes.get(node.id), { parentId })
      if (sourceTreeId !== parent.treeId && nodesOfTree(sourceTreeId).length === 0) {
        trees.delete(sourceTreeId)
      }
      return acceptStructure({ node: result }, checkpoint)
    },

    /**
     * The drag OUT of a tree, as a verb: this node and everything under it
     * become their own tree. The owner's ask, verbatim: nodes should be
     * "dragged to its own seperate tree". The inverse of the cross-tree move
     * above, built from the same pieces — treeId restamped across the branch,
     * a source tree left empty removed rather than kept as an invisible husk
     * — and refused with createTree's own sentence at the same cap, so the
     * gesture and the button can never disagree about how many trees fit.
     */
    detachToNewTree(nodeId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const checkpoint = structuralCheckpoint()
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      /* Already a sole root: it IS its own tree, and inventing a fresh id for
         the same shape would churn every reference for nothing. Accepted, not
         refused — the gesture's meaning is satisfied. */
      if (node.parentId == null && nodesOfTree(node.treeId).length === 1 + descendantsOf(node.id).length) {
        return acceptStructure({ node, treeId: node.treeId, unchanged: true }, checkpoint)
      }
      if (trees.size >= FLEET_TREE_LIMITS.maxTrees) {
        return refuse(`The computer you are driving holds ${FLEET_TREE_LIMITS.maxTrees} trees already. Remove one to add another.`)
      }
      const id = mintId('tree')
      if (id === null) return refuse('Could not make a name for this tree. Try again.')
      const stamp = now()
      const source = trees.get(node.treeId)
      trees.set(id, Object.freeze({ id, name: null, createdAt: stamp, updatedAt: stamp, profileId: null,
        ...(source?.researchProjectId ? { researchProjectId: source.researchProjectId, researchProjectName: source.researchProjectName } : {}) }))
      const sourceTreeId = node.treeId
      for (const movedId of [node.id, ...descendantsOf(node.id)]) {
        const moved = nodes.get(movedId)
        if (moved) putNode(moved, { treeId: id })
      }
      const result = putNode(nodes.get(node.id), { parentId: null })
      if (nodesOfTree(sourceTreeId).length === 0) trees.delete(sourceTreeId)
      return acceptStructure({ node: result, treeId: id }, checkpoint)
    },

    /**
     * Every parent this agent could legally move under, as data — the same
     * construction extensionPoints() uses for "+" slots, and for the same
     * reason: a picker built from this list can only offer moves the store
     * will accept, so the menu and the refusal can never disagree.
     */
    movePoints(nodeId) {
      const node = nodes.get(nodeId)
      if (!node) return frozenList([])
      const blocked = new Set([node.id, ...descendantsOf(node.id)])
      const started = [...blocked].some(id => nodes.get(id)?.sessionId || LIVE_STATUSES.has(nodes.get(id)?.status))
      const projectId = trees.get(node.treeId)?.researchProjectId || null
      const height = branchHeight(node.id)
      const bounds = currentBounds()
      const points = []
      for (const candidate of nodes.values()) {
        if (blocked.has(candidate.id)) continue
        if (candidate.id === node.parentId) continue
        if (started && projectId !== (trees.get(candidate.treeId)?.researchProjectId || null)) continue
        if (slotChildrenOf(candidate.id).length >= seatWidthOf(candidate.treeId, bounds)) continue
        if (depthOf(candidate) + 1 + height > (boundsOfTree(candidate.treeId, bounds)?.maxDepth ?? -1)) continue
        points.push({ parentId: candidate.id, treeId: candidate.treeId })
      }
      return frozenList(points)
    },

    /**
     * Remove ONE agent — never a surprise branch.
     *
     * The contract this replaces took everything under the node with it, on
     * the ground that a child without a parent is the state the reader
     * refuses. True, but it answered the wrong way round: this page has two
     * sanctioned verbs for moving children out — the reports-to picker and
     * the drag — so a parent is REFUSED until the person has used them, and
     * agents they never named are never deleted on their behalf. A live agent
     * is refused too: removing the record would leave the run behind it with
     * nothing on any screen naming it. The sentences are NODE_REMOVE_REFUSALS
     * above, exported so the palette row shows the same words — one truth.
     *
     * A tree left empty goes with its last agent, exactly as the cross-tree
     * move and the drag-out already decide: an invisible husk would block the
     * one-empty-tree rule with nothing on screen to act on. The removed
     * RECORD comes back, not only its id — same reason removeTree gives —
     * and `removedTreeId` says when the tab went with it.
     */
    removeNode(nodeId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      /* THE PAIR, not the status alone — the same test advanceRunClock makes
         and src/tree-session-liveness.js calls busy. A live status OVER a
         session is a run, and removing its record would leave that run with
         nothing on any screen naming it, which is what this refusal is for. A
         live status with NO session is not a run: it is a contract that never
         started, and "Stop this agent first." asks the person to stop something
         that does not exist and that no button can reach, so the row is stuck
         for good. Reading the status alone made those two the same state. */
      if (LIVE_STATUSES.has(node.status) && node.sessionId != null) return refuse(NODE_REMOVE_REFUSALS.running)
      const children = childrenOf(nodeId)
      if (children.length > 0) return refuse(NODE_REMOVE_REFUSALS.children(children.length))
      nodes.delete(nodeId)
      let removedTreeId = null
      if (nodesOfTree(node.treeId).length === 0) {
        trees.delete(node.treeId)
        removedTreeId = node.treeId
      }
      return accept({ removedNode: node, removedNodeId: nodeId, removedTreeId })
    },

    /**
     * Move an agent between the five states, with the sentence that goes with
     * the move.
     *
     * `note` is one plain sentence for the screen — why it stopped, what it
     * finished. It is REPLACED on every call and defaults to empty, so the
     * sentence always belongs to the state now showing. Carrying an old note
     * forward is how a running agent ends up captioned with the reason its last
     * run stopped.
     */
    /* THE PERSON HAS SPOKEN TO THIS CIRCLE, recorded once and never unset.

       It is what the owner's removal rule turns on: "AGENTS that a user
       prompts even if created by another agent can remain". Called from the
       one place a person's own turn is sent, so an assistant cannot set it
       and cannot clear it. Idempotent: saying it twice is the same fact. */
    markPromptedByPerson(nodeId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return { ok: false, problems: ['No such agent.'] }
      if (node.promptedByPerson === true) return unchanged({ node })
      return accept({ node: putNode(node, { promptedByPerson: true }) })
    },

    setNodeStatus(nodeId, status, { note = '', turnId } = {}) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      if (!NODE_STATUSES.includes(status)) {
        return refuse(`Pick one of these for an agent: ${NODE_STATUSES.join(', ')}.`)
      }
      const statusNote = briefText(note ?? '', FLEET_TREE_LIMITS.maxNoteChars)
      if (statusNote === null) {
        return refuse(`Keep the note to ${FLEET_TREE_LIMITS.maxNoteChars} characters or fewer.`)
      }
      if (turnId !== undefined && turnId !== null && (typeof turnId !== 'string' || !turnId || turnId.length > 512
        || /[\u0000-\u001f\u007f]/.test(turnId))) return refuse('The completed turn needs a valid session turn identifier.')
      if (status === 'running' && node.sessionId === null) {
        return refuse('Attach the session before marking this agent as running.')
      }
      if (status === 'draft' && node.sessionId !== null) {
        return refuse('Detach the session before turning this agent back into a draft.')
      }
      // Resuming or restarting this identity does not allocate another child slot.
      return accept({ node: putNode(node, { status, statusNote, ...(turnId !== undefined ? { lastTurnId: turnId } : {}) }) })
    },

    /**
     * Keep what the agent said, on the node that said it.
     *
     * Written when a turn completes, so the rail's "What it said" is still
     * there after a reload — the reply used to live only in a view-closure Map
     * and evaporated on navigation, which read as the agent never having
     * answered. Only a node that has held a session can have said anything.
     */
    setNodeReply(nodeId, reply) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      if (node.sessionId === null) return refuse('This agent has never run, so there is nothing it said to keep.')
      const text = typeof reply === 'string' ? reply.slice(0, FLEET_TREE_LIMITS.maxReplyChars) : ''
      return accept({ node: putNode(node, { reply: text }) })
    },

    setNodeResearchRestriction(nodeId, restriction = null) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      if (restriction == null) return unchanged({ node })
      if (!isPlainObject(restriction) || restriction.version !== 1
          || !['folder', 'clean-room'].includes(restriction.mode)
          || !['read-only', 'read-write'].includes(restriction.access)
          || typeof restriction.root !== 'string'
          || (!/^[A-Za-z]:[\\/]/.test(restriction.root) && !restriction.root.startsWith('/'))) {
        return refuse('The agent research restriction is not a valid absolute scope.')
      }
      const next = Object.freeze({ version: 1, mode: restriction.mode, access: restriction.access, root: restriction.root })
      return accept({ node: putNode(node, { researchRestriction: next }) })
    },

    /**
     * Point this agent at the session that was started for it.
     *
     * A draft is promoted to `starting` on attach, because a draft is DEFINED as
     * having no session and leaving it a draft would break the rule the rest of
     * this file relies on. Any later state is left alone: attaching is not the
     * caller's chance to overwrite a state it did not watch.
     *
     * ONE SESSION BELONGS TO ONE AGENT. Two boxes on the tree pointing at the
     * same run would each offer to stop it, and stopping it from one would leave
     * the other showing a live agent that is not.
     */
    attachSession(nodeId, sessionId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      if (!safeIdentifier(sessionId)) return refuse('Give the session the id it was started with.')
      const holder = [...nodes.values()].find(other => other.sessionId === sessionId && other.id !== nodeId)
      if (holder) return refuse('Another agent already holds that session. Detach it there first.')
      const status = node.status === 'draft' ? 'starting' : node.status
      return accept({ node: putNode(node, { sessionId, status,
        ...(node.sessionId !== sessionId ? { lastTurnId: null } : {}),
        ...(node.pendingEditorFork ? { pendingEditorFork: null } : {}) }) })
    },

    /**
     * Let go of the session.
     *
     * An agent that was starting or running becomes a draft again, because both
     * of those states mean "there is a session, and it is this one". Keeping the
     * state while dropping the id would leave a box on the tree claiming to be
     * running with nothing to open, stop, or read. A finished or failed agent
     * keeps its state and its note: that is history, and history does not need a
     * live session to stay true.
     */
    detachSession(nodeId) {
      const blocked = beforeMutation()
      if (blocked) return blocked
      const node = nodes.get(nodeId)
      if (!node) return refuse('That agent is not on the computer you are driving.')
      const demoted = LIVE_STATUSES.has(node.status)
      return accept({
        node: putNode(node, {
          sessionId: null,
          status: demoted ? 'draft' : node.status,
          statusNote: demoted ? '' : node.statusNote,
        }),
      })
    },
  })
}

/* ===================================================================
   WHAT THE ENGINE WOULD REFUSE, AND WHAT THE TAB SAYS.
   ===================================================================
 *
 * ONE STORED RECORD, ONE RENDERED SHAPE, AND THEY ARE NOT THE SAME KIND OF
 * THING. Decided above this file; written here because the distinction is what
 * every function below depends on.
 *
 * WHAT IS STORED is the record above: a flat list of agents, each naming its
 * tree and its parent, each starting as a DRAFT. The draft is not an
 * implementation convenience that a tidier record could do without — it is the
 * interaction the owner asked for. He presses an empty node, and THEN the panel
 * asks him for a role and a message. A record with no draft cannot represent
 * the moment between the press and the start, which is the only moment the
 * panel exists to fill.
 *
 * WHAT IS DRAWN is docs/design/FLEET-TREES.md section 7's shape: nodes nested
 * inside their tree, an `agent` that is null on an empty node, and three states
 * (running, finished, unknown). That document specifies what the GRAPH RENDERS,
 * and specifying that is a legitimate and separate job from saying what is
 * kept. The seven functions below answer questions about the drawing — what the
 * tab says, where a placeholder may go, what removing would cost — so they take
 * the drawn shape, and tools/test/fleet-trees-multi.test.mjs holds them to it.
 *
 * THE PROJECTION RUNS ONE WAY. treeNodesOf() turns the stored record into the
 * drawn shape and nothing turns it back. A view that wanted to change something
 * calls the store; there is no path by which a rendered node becomes state.
 *
 * WHY THE ENGINE'S NUMBERS ARE COPIED RATHER THAN IMPORTED: this module is pure
 * and the engine is not on the renderer's side of the wall.
 * tools/test/fleet-trees-multi.test.mjs parses the engine's own source and fails
 * if these drift. Since 2026-09-11 only maxDepth is the engine's number
 * (MAX_DEPTH, held equal); maxChildren is the tree's OWN width, and the guard
 * holds it at or below the engine's MAX_FAN_OUT, which stays the backstop.
 */
/* FOUR UNDER ONE, by the owner's decision of 2026-09-11: "ok it sounds like
 * shipping with 4 width is best. we will defer the 8:1 implementation and
 * research for now". It was eight, the engine's MAX_FAN_OUT, which stays eight
 * as the backstop for every nested launch; this is the tree's own seat width,
 * and loops and research grids are not tied to it. Depth is unchanged.
 *
 * A TREE SAVED UNDER THE OLD CAP IS NOT A BROKEN TREE. The owner's own trees
 * have parents with eight to fourteen live children, and they load, draw, move
 * and resume as saved: nothing in the reader counts children, and a child that
 * is already live never claims a new seat (see setNodeStatus). What changes is
 * that a NEW seat under such a parent is refused until it drops below four.
 * tools/test/tree-width-four.test.mjs holds both halves. */
export const TREE_BOUNDS = Object.freeze({
  ...DEFAULT_TREE_SLOT_BOUNDS,
  maxEmptyTrees: 1,
})

/* THE ONE TREE THE AGENT-TREE WIDTH DOES NOT APPLY TO. A research grid run
 * locally (src/research-experiments.js) is a tree its dispatcher builds for
 * itself: the first cell is the root and every other cell its child, up to the
 * grid's own MAX_LOCAL_CELLS. The owner, 2026-09-11: "loops and grids dont even
 * need to be tied together or to any of this". So a tree the dispatcher marks
 * `kind: 'experiment'` -- an explicit field set at creation, never a name or a
 * role -- seats EXPERIMENT_TREE_MAX_CHILDREN under one parent, which mirrors
 * the engine's MAX_FAN_OUT (eight), the only backstop: exactly what such a
 * tree had before the agent-tree width fell to four. Depth is unchanged.
 * tools/test/fleet-trees-multi.test.mjs holds the mirror equal to the engine. */
export const EXPERIMENT_TREE_KIND = 'experiment'
export const EXPERIMENT_TREE_MAX_CHILDREN = 8

/* The live-child width of one parent in `tree` (a stored tree or a drawn one). */

const NUMBER_WORDS = Object.freeze([
  'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
])
const numberWord = count => NUMBER_WORDS[count] ?? String(count)

/* THE COUNT SAID IS THE COUNT THERE IS. At the cap the sentence is the one it
   always was. Over it -- a tree saved while the cap was eight -- saying "four"
   to a person looking at eight running circles would be false, so it names
   what is there and then the cap. Every seat refusal starts with this, so the
   store, the panel and the move picker cannot word one condition two ways. */
function seatsFullSentence(children, cap = TREE_BOUNDS.maxChildren) {
  return treeSlotFullReason(children, cap)
}

/* STORE RECORD -> VIEW SHAPE. One direction, one place, and nothing maps back.
 *
 * This is the only crossing between what is kept and what is drawn. A node from
 * the store has a role, a message and a state of its own; a drawn node carries
 * an `agent` that is null when nobody has filled the placeholder in. It also
 * accepts a node that is already in the drawn shape, so the seven functions
 * below can be called on a hand-built tree — a test fixture, or a tree a view
 * assembled itself — without every one of them repeating the check.
 *
 *   draft, nothing typed       -> agent is null. It is an empty node.
 *   draft, something typed     -> agent, state `unknown`.
 *   starting, running          -> state `running`
 *   finished, failed           -> state `finished`
 *
 * THE SECOND ROW LOOKS LOSSY AND IS NOT, so do not "repair" it by adding a
 * fourth state to the drawn shape. `draft` is never lost: it lives in the
 * stored record, which is the authoritative one, and flattens only on the way
 * to the pixels because the drawing has one question to answer about a node the
 * person has typed into but not started — is it live? — and the honest answer
 * is that it is not. Adding `draft` to the drawn vocabulary would put a second
 * copy of a state word in a shape that cannot be written back to, and the copy
 * that drifts is the one on the screen.
 *
 * Nothing here ever reports `running` for a state it did not read as running. */
function treeNodesOf(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : []
  return nodes.map(node => {
    if (node && Object.prototype.hasOwnProperty.call(node, 'agent')) {
      return { id: node.id, parentId: node.parentId ?? null, agent: node.agent || null }
    }
    const started = node?.status && node.status !== 'draft'
    const typed = Boolean(node?.role) || Boolean(node?.message)
    if (!started && !typed) return { id: node?.id, parentId: node?.parentId ?? null, agent: null }
    const state = LIVE_STATUSES.has(node?.status)
      ? 'running'
      : (node?.status === 'finished' || node?.status === 'failed' || node?.status === 'turn-failed' ? 'finished' : 'unknown')
    return {
      id: node?.id,
      parentId: node?.parentId ?? null,
      agent: { role: node?.role || '', message: node?.message || '', launchId: node?.sessionId ?? null, kind: null, state },
    }
  })
}

/**
 * One tree from this module's own record, in the shape section 7 describes.
 *
 * The bridge is a function rather than a second copy of the state, so there is
 * no moment where the two records can disagree about the same tree.
 */
export function treeRecord(snapshot, treeId) {
  const tree = (snapshot?.trees || []).find(entry => entry.id === treeId)
  if (!tree) return null
  const record = {
    id: tree.id,
    computerId: snapshot.computerId,
    name: tree.name || null,
    ...(tree.researchProjectId ? { researchProjectId: tree.researchProjectId, researchProjectName: tree.researchProjectName } : {}),
    ...(tree.kind === EXPERIMENT_TREE_KIND ? { kind: EXPERIMENT_TREE_KIND } : {}),
    /* THERE IS NO `folder` HERE, AND ITS ABSENCE IS THE POINT. No tree owns a
       working folder and the product has nowhere to put one: shell/main.cjs
       parseAgentStart() takes an optional cwd and not one caller in src/ passes
       it, so every agent started from this page runs in the same shared
       workspace root. Measured and recorded in docs/design/FLEET-TREES.md
       section 8. Do not add the field back as an empty one — a folder a person
       chose and nothing acted on is worse than the shared folder they have,
       because it reads as a promise of separation. */
    nodes: frozenList((snapshot.nodes || []).filter(node => node.treeId === treeId).map(node => ({ ...node }))),
  }
  /* The bounds ride along as the snapshot's own, read when a planner asks for
     them: naming a tree or listing its agents must not cost a settings read. */
  if (Object.hasOwn(snapshot, 'slotBounds')) {
    Object.defineProperty(record, 'slotBounds', { enumerable: true, get: () => snapshot.slotBounds })
  }
  return Object.freeze(record)
}

/**
 * The words a node is called by, wherever a person meets it.
 *
 * A NODE'S NAME IS AN IDENTITY, NOT ITS HOMEWORK. The name is the role's label
 * plus a per-tree ordinal when siblings share the role -- "Coordinator",
 * "Manager 2" -- mirroring the ordinal shape treeLabel() uses for trees. It
 * lives here, with no DOM in it, because two pages name nodes: the Computers
 * page's rail (src/views/computers.js treeNodeName) and the Ledger page's
 * filing box (src/ledger-file-box.js), and a rule they each derived would let
 * the same agent wear two names. `roleLabel` is src/fleet-tree-copy.js's, handed
 * in so this module keeps its one-way import order.
 */
function composedNodeName(node, nodes, roleLabel) {
  const role = oneLineText(node?.nameBase, FLEET_TREE_LIMITS.maxNameChars) || roleLabel(node?.role)
  if (safeNameOrdinal(node?.nameOrdinal)) {
    return ordinalName(role, node.nameOrdinal)
  }
  const peers = (Array.isArray(nodes) ? nodes : []).filter(peer => peer && peer.treeId === node?.treeId && peer.role === node?.role)
  if (peers.length <= 1) return role
  const index = peers.findIndex(peer => peer.id === node?.id)
  return index === -1 ? role : `${role} ${index + 1}`
}

export function nodeDisplayName(node, nodes = [], { roleLabel = role => String(role || '') } = {}) {
  const label = composedNodeName(node, nodes, roleLabel)
  /* ONLY A LABEL THAT IS ACTUALLY AMBIGUOUS IN THIS POOL GETS A SUFFIX.
     The pool is whatever the caller handed in, and callers differ on purpose:
     the tree view passes one tree's peers, while the Ledger and session-role
     surfaces pass every node in the record, across trees. So a name that is
     unique where it is shown reads exactly as before, and only a name competing
     with another circle ON THE SAME SURFACE is qualified. Composition is done by
     composedNodeName so peer labels are compared without recursing. */
  const id = typeof node?.id === 'string' ? node.id : ''
  if (!label || !id) return label
  const pool = Array.isArray(nodes) ? nodes : []
  for (const peer of pool) {
    if (!peer || typeof peer.id !== 'string' || peer.id === id) continue
    if (composedNodeName(peer, nodes, roleLabel) === label) return `${label} (${shortNodeId(id)})`
  }
  return label
}

/**
 * Circle names by every id a surface can be holding instead of a name.
 *
 * A SURFACE THAT WAS HANDED A KEY AND NO NAME STILL HAS TO SAY WHO IT MEANS.
 * The standing-request scopes are keyed by ids this product mints -- a tree or
 * circle rule under the node's id, a session rule under the running session's
 * id (src/views/computers.js treeAnchorsFor / nodeRequestKeys) -- and the
 * filing path sends a `label` beside the key so the Ledger page can print
 * "Coordinator". That label is OPTIONAL on the way in
 * (shell/agent-command-surface.cjs passes it through, shell/agent-host.cjs
 * fileStandingRequest defaults it to null), so every rule an agent files, and
 * every rule filed before labels existed, arrives with nothing but the key.
 * Reading `node-2-6c518599-05aa-4c77-a154-cefe49b278ed` is not an answer to
 * "who is this rule for".
 *
 * BOTH IDS MAP TO THE SAME WORDS, deliberately: a session belongs to exactly
 * one circle, and the circle is what a person recognises. The reach word beside
 * the name is what keeps a session rule and a circle rule apart, and that word
 * is the caller's to add -- this answers WHO, never HOW FAR.
 *
 * `records` are parsed fleet-tree records ({ trees, nodes }), one per computer,
 * exactly as parseFleetTrees answers them. `roleLabel` is handed in for the
 * reason nodeDisplayName above states: this module keeps its one-way import
 * order and never reaches into the copy.
 *
 * A KEY THIS CANNOT PLACE IS SIMPLY ABSENT FROM THE MAP. "Could not look" (no
 * saved record in this window -- a browser reading the register over the relay)
 * and "not there" (a circle that has since been removed) are the same answer to
 * a naming question and both mean the caller must say what it does know; they
 * are NOT the same as inventing a name.
 */
export function nodeNamesByKey(records = [], { roleLabel } = {}) {
  const names = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const nodes = Array.isArray(record?.nodes) ? record.nodes : []
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string' || node.id === '') continue
      const name = nodeDisplayName(node, nodes, { roleLabel })
      if (typeof name !== 'string' || name === '') continue
      /* FIRST RECORD WINS, so a second computer's record cannot rename a
         circle already named by the first. Two computers minting the same id
         is not a case this product produces (the id carries a UUID); a stable
         answer under one is still worth more than a last-write-wins one. */
      if (!names.has(node.id)) names.set(node.id, name)
      const sessionId = typeof node.sessionId === 'string' ? node.sessionId : ''
      if (sessionId !== '' && !names.has(sessionId)) names.set(sessionId, name)
    }
  }
  return names
}

/**
 * WHICH FOLDER THE "WORKS IN" MENU SHOULD SHOW, AND WHETHER THIS COMPUTER STILL
 * HAS IT.
 *
 * A tree's profileId is a POINTER, forgiving by design (see parseFleetTrees):
 * a dangling id costs the record nothing. But nothing clears it either --
 * removing a folder in Settings removes the profile and leaves every tree that
 * used it pointing at a folder this computer no longer offers.
 *
 * The menu marked an option selected only where `profile.id === current`, so a
 * dangling pointer matched nothing, nothing was marked, and the FIRST option
 * stood: "the product's own workspace". The menu then showed the default while
 * the saved record said otherwise, and a start did not use what the menu showed
 * either -- it passes the dangling id on and the main process refuses it by
 * name. Three different answers to one question.
 *
 * This is a function rather than a branch inside the view because the view is
 * an Electron-mounted closure and this suite has no DOM that models option
 * selectedness: made a value, the rule can be proven; left inline, it could
 * only be pinned as text.
 *
 * `missing` is deliberately not "invalid". The record is not damaged and the
 * person did nothing wrong; the folder is simply gone, and that is a fact to
 * report rather than a state to repair behind their back. Clearing the pointer
 * here would silently rewrite a choice they made.
 */
export function treeFolderMenuChoice({ current, folders } = {}) {
  const chosen = typeof current === 'string' && current.trim() ? current : null
  const offered = Array.isArray(folders) ? folders : []
  if (!chosen) return Object.freeze({ selectedId: null, missing: false })
  return Object.freeze({
    selectedId: chosen,
    missing: !offered.some(folder => folder && folder.id === chosen),
  })
}

/* THE HEAD SPEAKS FOR ITS TREE (T1496). Saved nodes are in creation order,
   so a circle made before this tree's head and later moved in used to become
   its "first" node, and its brief renamed the whole tree. Walking from the
   head, breadth first, keeps the label on the head's words; moves in or out of
   the tree change it only when the head itself changes. Nodes the walk cannot
   reach keep their saved order after it. */
function headFirst(nodes) {
  const ids = new Set(nodes.map(node => node.id))
  const children = new Map()
  const queue = []
  for (const node of nodes) {
    if (node.parentId == null || !ids.has(node.parentId)) queue.push(node)
    else children.set(node.parentId, [...(children.get(node.parentId) || []), node])
  }
  const ordered = [], seen = new Set()
  while (queue.length) {
    const node = queue.shift()
    if (seen.has(node)) continue
    seen.add(node)
    ordered.push(node)
    queue.push(...(children.get(node.id) || []))
  }
  return [...ordered, ...nodes.filter(node => !seen.has(node))]
}

/**
 * The words on a tree's tab.
 *
 * Never an id, in any branch. A tab is read by a person and a tree id means
 * nothing outside this program, so the fallbacks are the name they gave it, then
 * the first thing they asked an agent to do, then a plain default — and never
 * the machine field sitting right there.
 */
export function displayName(tree) {
  const named = typeof tree?.name === 'string' ? tree.name.trim() : ''
  if (named) return named
  for (const node of headFirst(treeNodesOf(tree))) {
    const message = typeof node.agent?.message === 'string' ? node.agent.message : ''
    const firstLine = message.split('\n')[0].replace(/\s+/g, ' ').trim()
    if (!firstLine) continue
    return firstLine.length <= 48 ? firstLine : `${firstLine.slice(0, 47).trimEnd()}…`
  }
  return 'New tree'
}

/**
 * Empty, running, or finished.
 *
 * A tree just read off disk can never answer `running` here, and that is not a
 * second guard — it is the demotion in parseFleetTrees() seen from downstream,
 * where the argument for it is written. This function is only ever as honest as
 * the states it is handed.
 */
export function treeStatus(tree) {
  const nodes = treeNodesOf(tree)
  const agents = nodes.filter(node => node.agent)
  if (agents.length === 0) return 'empty'
  return agents.some(node => node.agent.state === 'running') ? 'running' : 'finished'
}

/**
 * May another tree be started on this computer?
 *
 * ONE EMPTY TREE AT A TIME. A second tree with nothing in it is not a second
 * structure, it is the same blank page twice, and the person who pressed the
 * button is now looking at two identical tabs wondering which one they were
 * using. The refusal therefore points at the empty one they already have, by
 * name, and hands back its id in `switchTo` for the view to act on — the id
 * travels in a field, never in the sentence.
 */
export function planTreeAdd(trees) {
  const list = Array.isArray(trees) ? trees : []
  const empty = list.find(tree => treeStatus(tree) === 'empty')
  if (empty) {
    return Object.freeze({
      allowed: false,
      switchTo: empty.id ?? null,
      reason: `You already have an empty tree called “${displayName(empty)}”. Open it and press one of its empty nodes.`,
    })
  }
  return Object.freeze({
    allowed: true,
    switchTo: null,
    reason: list.length === 0
      ? 'The computer you are driving has no trees yet, so this one starts your first.'
      : 'Every tree here has work in it, so this one starts a new structure.',
  })
}

/**
 * May an empty node be offered in this position?
 *
 * A placeholder the tree would refuse is worse than no placeholder: the person
 * presses it, fills in a brief, and is told no by something they cannot see. The
 * width is the tree's own (four, below the engine's eight) and the depth is the
 * engine's own; the depth counts EMPTY nodes as well as started ones, because the
 * position is what is being claimed, and the width counts live seats.
 */
export function planNodeAdd(tree, parentNodeId = null, { bounds = Object.hasOwn(tree || {}, 'slotBounds') ? tree.slotBounds : DEFAULT_TREE_SLOT_BOUNDS } = {}) {
  const nodes = treeNodesOf(tree)
  if (parentNodeId == null && nodes.some(node => node.parentId == null)) {
    return Object.freeze({ allowed: false, reason: 'This tree already has a top agent. Add the next one under an agent that is there.' })
  }
  try { return Object.freeze(planTreeSlot(nodes, parentNodeId, effectiveTreeSlotBounds(tree, bounds))) }
  catch { return Object.freeze({ allowed: false, reason: TREE_SLOT_UNAVAILABLE }) }
}

/** Saved direct slots include every lifecycle state. Live/busy counts are a
 * view concern; this summary never treats an ended session as spare capacity. */
export function treeSlotUsage(snapshot, nodeId) {
  const node = snapshot?.nodes?.find(row => row.id === nodeId)
  if (!node) return null
  const tree = treeRecord(snapshot, node.treeId)
  const children = tree.nodes.filter(row => row.parentId === nodeId)
  let bounds = null
  try { bounds = effectiveTreeSlotBounds(tree, Object.hasOwn(snapshot, 'slotBounds') ? snapshot.slotBounds : DEFAULT_TREE_SLOT_BOUNDS) }
  catch { /* Keep the known count and show the named settings refusal below. */ }
  const admission = planNodeAdd(tree, nodeId)
  return Object.freeze({ total: children.length, limit: bounds?.maxChildren ?? null,
    maxDepth: bounds?.maxDepth ?? null, canAdd: admission.allowed, reason: admission.allowed ? '' : admission.reason || '',
    childIds: Object.freeze(children.map(child => child.id)) })
}

/**
 * What removing this tree would cost, said before it happens.
 *
 * The count is the point. "This will stop your agents" is a warning a person
 * skims; "this stops three agents that are still working" is a number they can
 * weigh, and it is the difference between an undo they wanted and one they did
 * not.
 */
export function planTreeRemove(tree) {
  const running = treeNodesOf(tree).filter(node => node.agent?.state === 'running').length
  const name = displayName(tree)
  if (running === 0) {
    return Object.freeze({
      stopsFirst: false,
      running: 0,
      sentence: `Nothing is running in “${name}”. Removing it takes its agents and their messages with it.`,
    })
  }
  return Object.freeze({
    stopsFirst: true,
    running,
    sentence: `Removing “${name}” stops ${numberWord(running)} ${running === 1 ? 'agent' : 'agents'} that ${running === 1 ? 'is' : 'are'} still working. Stop them and remove it?`,
  })
}

/**
 * Who is holding the agents, when there are none left to start.
 *
 * This is the second line under the shipped seat refusal, and the whole reason
 * more than one tree needs its own sentence: the first line says every agent is
 * busy, and a person with two trees open immediately asks which one has them.
 * Trees are NAMED here and never identified — an id in this sentence would be
 * the program talking to itself in front of somebody.
 *
 * When nothing can be attributed, it says that instead of guessing. A wrong name
 * here sends a person to stop the wrong work.
 */
const SEAT_SHORTAGE_MACHINE_SENTENCE = Object.freeze(new Map([
  ['This tree is already holding every agent this computer can run.',
    'This tree is already holding every agent the computer you are driving can run.'],
]))

export function seatShortageSentence({ trees = [], currentTreeId = null, subject = 'this computer' } = {}) {
  const holders = (Array.isArray(trees) ? trees : [])
    .map(tree => ({ tree, running: treeNodesOf(tree).filter(node => node.agent?.state === 'running').length }))
    .filter(entry => entry.running > 0)

  if (holders.length === 0) {
    return 'This app did not start them, so it cannot say what has them. Wait, or stop one from the list below.'
  }
  const others = holders.filter(entry => entry.tree.id !== currentTreeId)
  if (others.length === 0) {
    const sentence = 'This tree is already holding every agent this computer can run.'
    return subject === 'the computer you are driving'
      ? SEAT_SHORTAGE_MACHINE_SENTENCE.get(sentence)
      : sentence
  }
  const named = others.slice(0, 3)
  const parts = named.map(entry => `“${displayName(entry.tree)}” has ${numberWord(entry.running)}`)
  const rest = others.length - named.length
  const tail = rest > 0 ? `, and ${numberWord(rest)} more` : ''
  return `${numberWord(others.length)} other ${others.length === 1 ? 'tree is' : 'trees are'} holding them: ${parts.join(', ')}${tail}.`
}
