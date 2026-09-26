/* THE WORDS THE CHAT USES WHEN AN AGENT FILES ONE OF THE PERSON'S RULES.
 *
 * With "Turning something you said into a standing rule" on, an agent may
 * call r_ledger.file with the person's exact words, and the ledger module
 * appends them under the agent's name. The person has to SEE that happen --
 * the registry row promises "the chat shows you a line saying what was filed
 * and where" -- and the line is built from the engine's own tool result
 * (src/agent-session-events.js sessionFiledRule), never from the agent's
 * prose about what it did. An agent that SAYS it filed a rule and did not
 * produces no row; an agent that filed one and said nothing still does.
 *
 * WHY A COPY MODULE, like src/ledger-copy.js and src/fleet-tree-copy.js: the
 * view that draws the row imports a stylesheet and cannot load under node,
 * and a sentence nobody can build in a test is a sentence the plain-language
 * gate holds only by luck. Everything here is data in, words out.
 *
 * WHAT THE ROW CARRIES AND WHAT IT DOES NOT. The rule id (the one identifier
 * a person needs, because it is how they find the entry in the file they are
 * told to edit), the reach the ledger module stated, the agent's name, and
 * the first stretch of the person's own words so they recognise which remark
 * became a rule. No scope key, no path, no session id. */

/* The rows are drawn by the chat's action-row painter, and the TOOL slot is
   a label a person reads at a glance -- one short noun, like "Command". */
export const FILED_RULE_TOOL_LABEL = 'Standing rule'

/* How much of the person's words ride on the row. Enough to recognise the
   remark, not the whole rule: the rule itself is in the rules panel and in
   the file, and a long remark on one chat line is a line nobody reads. */
export const FILED_RULE_WORDS_MAX = 80

/* Every scope word the ledger module can answer, as a fallback phrase when a
   result arrives with no `appliesTo` (an older payload's shape). */
const REACH_BY_SCOPE = Object.freeze({
  global: 'every agent',
  session: 'this session and everything it starts',
  tree: 'this agent and every agent below it',
  thread: 'this agent, this conversation only',
})

function excerpt(words) {
  const flat = String(words ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  if (flat.length <= FILED_RULE_WORDS_MAX) return `“${flat}”`
  return `“${flat.slice(0, FILED_RULE_WORDS_MAX).trimEnd()}…”`
}

function reachOf({ appliesTo, scope }) {
  if (typeof appliesTo === 'string' && appliesTo.trim()) return appliesTo.trim()
  return REACH_BY_SCOPE[scope] || 'your agents'
}

/**
 * The one line the chat shows when a rule was filed by an agent.
 *
 * @param {{ id: string, appliesTo?: string, scope?: string, filedBy?: string, words?: string }} filed
 *        the fields the tool result carried (and the words from the call
 *        that produced it, when the view could pair the two).
 */
export function filedRuleSentence(filed = {}) {
  const id = String(filed.id || '').trim()
  const who = String(filed.filedBy || '').trim()
  const quoted = excerpt(filed.words)
  const head = `Your agent filed ${id} as a standing rule for ${reachOf(filed)}`
  const withWords = quoted ? `${head}: ${quoted}` : head
  const attributed = who ? `${withWords} — filed by ${who}.` : `${withWords}.`
  return `${attributed} It is in your rules; edit or delete it by hand.`
}

/* The short form, for the slot beside the row. */
export function filedRuleState(filed = {}) {
  const who = String(filed.filedBy || '').trim()
  return who ? `filed by ${who}` : 'filed'
}

/**
 * The row itself, in the shape src/components.js addAction() paints:
 * `{ id, tool, detail, state, stateKey, body, at }`. The detail is the
 * sentence (one line, ellipsised by the row's own style) and the body is the
 * same sentence whole, so opening the row shows all of it.
 */
export function filedRuleChatRow(filed = {}, { at = Date.now() } = {}) {
  const sentence = filedRuleSentence(filed)
  return Object.freeze({
    id: `rule:${String(filed.id || '').trim() || 'unknown'}:${String(filed.toolCallId || '')}`,
    tool: FILED_RULE_TOOL_LABEL,
    detail: sentence,
    state: filedRuleState(filed),
    stateKey: 'done',
    body: sentence,
    at,
  })
}
