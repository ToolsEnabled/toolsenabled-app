/* WHICH AGENT A SESSION WAS, AND WHAT IT SAID, from the page's own saved
 * conversations.
 *
 * The signed record on this computer is deliberately about the MACHINE: it
 * carries a session id, a model row and a sign-in name, and nothing about the
 * role a person typed into a tree node. That is the right split -- a role is a
 * thing the page invented and the page keeps -- but it means any screen that
 * wants to say "the planner used 12,000 tokens" has to JOIN the two, on the
 * session id both sides already hold.
 *
 * This is that join's left-hand side, and it is its own module for one reason:
 * src/local-metrics.js is a pure function of records and a clock, on purpose,
 * and reaching into localStorage from inside it would break the property that
 * makes it testable without a browser. So the reading lives here, the view calls
 * it, and the decisions stay in the module that has no storage.
 *
 * THERE WAS A SECOND COPY OF THIS FUNCTION AND THAT IS WHY IT NOW CARRIES MORE.
 *
 * This module was extracted from a private savedConversations() inside
 * src/views/home.js, for the metrics page, nine hours after home shipped its
 * own. The two were byte-identical and home was never switched over, so from
 * that hour on there were two readers of one record and a widening of either
 * one silently missed the other. Home now calls THIS, and the fields below are
 * the widening the owner asked for: he wanted the activity list to show what
 * each agent SAID, and `reply` was sitting on the node the whole time while
 * both readers took `role` and `message` and dropped the rest on the floor.
 *
 * `role` and `asked` keep their names and their meaning, so the metrics join
 * that already reads them is unchanged by this.
 *
 * IT NEVER THROWS AND IT NEVER PARTIALLY ANSWERS. Missing storage yields null.
 * A storage whose inventory cannot be read yields SESSION_ROLES_READ_FAILED:
 * that answer says the machine could not tell and is NOT claiming the saved
 * conversations are absent. The failure is made afresh on every call; it is
 * never cached or latched, so a temporarily busy storage can recover.
 */

import { fleetTreesStorageKey, parseFleetTrees, safeTreeStorage, nodeDisplayName } from './fleet-trees.js'
/* READ THROUGH, NEVER WRITTEN TO. The conversations a session actually had are
   kept per NODE by src/session-transcript-store.js, under its own key per
   computer, and its parser is the only thing allowed to say what a sound record
   is. This module holds no second opinion about that file's shape -- it asks
   that module, exactly as it asks fleet-trees.js about the forest. */
import { parseTranscriptRow, transcriptStorageKey } from './session-transcript-store.js'

import { ROLE_COLOR_NAMES } from './role-colors.js'

export const SESSION_ROLES_READ_FAILED = 'SESSION_ROLES_READ_FAILED'

function readFailed(cause) {
  return Object.freeze({
    code: SESSION_ROLES_READ_FAILED,
    message: 'Could not read saved session roles; this is not claiming they are absent.',
    cause,
  })
}

/* The last thing the agent itself said in a saved conversation, or ''. Its own
   turn, never the person's: the whole point of the field is "what it said
   back". */
function lastAgentLine(record) {
  if (!record || !Array.isArray(record.lines)) return ''
  for (let index = record.lines.length - 1; index >= 0; index -= 1) {
    const line = record.lines[index]
    if (line && line.who === 'agent' && typeof line.text === 'string' && line.text) return line.text
  }
  return ''
}

/**
 * A Map of sessionId to what this computer saved about that session; null when
 * there is no storage to read; or SESSION_ROLES_READ_FAILED when storage could
 * not answer whether any saved roles exist.
 *
 * `{ role, asked }` are the pair src/local-metrics.js already documents for
 * runRows(), so one reader serves the run table and the token panels. The rest
 * is what the node was already holding:
 *
 *   reply       the agent's own answer, kept on the node so a screen can show
 *               it. '' when the node has none.
 *   said        the last thing the agent said in the SAVED CONVERSATION for
 *               this node, which outlives the node's single `reply` field.
 *               Only read when `transcripts` is asked for, because it costs one
 *               more key per computer and no other caller wants it.
 *   status      the node's own word for where it got to (draft, starting,
 *               running, finished, failed). NOT the run's outcome: the signed
 *               record owns that, and these two answer different questions.
 *   statusNote  whatever was written beside that status.
 *   tier        the model row the node was started on, as an id. A screen turns
 *               it into a name; nothing renders it raw.
 *   nodeId, computerId   which circle on which computer this was.
 *
 * @param {Storage} storage
 * @param {{transcripts?: boolean}} options  read the saved conversations too.
 */
export function readSessionRoles(storage = (typeof window === 'undefined' ? null : window.localStorage), { transcripts = false } = {}) {
  if (!storage || typeof storage.key !== 'function' || typeof storage.getItem !== 'function') return null
  const found = new Map()
  const prefix = fleetTreesStorageKey('')
  const seam = transcripts ? safeTreeStorage(storage) : null
  let count = 0
  try { count = Number(storage.length) || 0 } catch (error) { return readFailed(error) }
  for (let index = 0; index < count; index += 1) {
    let key = null
    try { key = storage.key(index) } catch { continue }
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue
    let raw = null
    try { raw = storage.getItem(key) } catch { continue }
    const record = parseFleetTrees(raw)
    /* The key is `<base>:<computerId>`, and the module that owns the key wrote
       the prefix, so the rest of it is the computer this forest belongs to.
       That is the only way to reach the transcripts, which are filed under the
       same computer with their own base. */
    const computerId = key.slice(prefix.length)
    let saved = null
    if (transcripts && computerId) {
      /* One read per computer, not per node. A damaged or absent record reads
         as no conversations at all, which costs a row its last line and
         nothing else. */
      saved = parseTranscriptRow(seam.read(transcriptStorageKey(computerId))).nodes
    }
    for (const node of record.nodes) {
      if (!node.sessionId) continue
      found.set(node.sessionId, {
        role: node.role,
        displayName: nodeDisplayName(node, record.nodes, { roleLabel: role => ROLE_COLOR_NAMES[role] || role }),
        asked: node.message,
        reply: typeof node.reply === 'string' ? node.reply : '',
        said: saved ? lastAgentLine(saved[node.id]) : '',
        /* THE LINES BETWEEN, for the one card that draws them. The home
           activity card now folds each run open to show what was said in it,
           not only the first ask and the last answer; the owner asked for "the
           informative aspect" of the transcript inside the live list. An
           absent or damaged transcript reads as no lines, which costs a row
           its fold and nothing else. `[]` when transcripts were not asked for,
           so every existing reader of role/asked/reply/said is unchanged. */
        turns: saved && saved[node.id] && Array.isArray(saved[node.id].lines)
          ? saved[node.id].lines.map((line) => ({ who: line.who, text: line.text, at: line.at }))
          : [],
        status: node.status,
        statusNote: typeof node.statusNote === 'string' ? node.statusNote : '',
        tier: typeof node.tier === 'string' ? node.tier : '',
        nodeId: node.id,
        treeId: node.treeId,
        computerId,
      })
    }
  }
  return found
}

// A provider replacement can be live before its new session id is persisted in
// the tree. The stable node id still identifies the same voice contact.
export function roleForSessionTarget(target, roles) {
  const exact = roles?.get?.(target?.sessionId)
  if (exact) return exact
  const nodeId = target?.nodeId || target?.agentId
  if (!nodeId || typeof roles?.values !== 'function') return null
  let match = null
  for (const row of roles.values()) {
    if (row.nodeId !== nodeId) continue
    if (match && match.computerId !== row.computerId) return null
    match = row
  }
  return match
}
