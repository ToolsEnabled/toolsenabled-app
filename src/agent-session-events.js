import { thinkingSummary, thinkingTranscriptId } from '../shell/thinking-transcript.mjs'

/* Event-shape readers for a live agent session.
 *
 * Deliberately dependency-free. These decide what is allowed to reach the
 * screen, so they are the part worth testing directly, and a test should not
 * have to drag in the simulation (which schedules timers on import) to reach
 * them.
 *
 * The rule both functions enforce: read only the exact shape this surface
 * understands, from the exact session it belongs to. Anything else returns
 * null and is ignored rather than rendered -- one event stream carries every
 * open session, so a missing session check would let one session's output
 * appear in another's transcript.
 */

/* WHAT ONE AGENT SAID TO ANOTHER IS NOT WHAT THIS AGENT SAID TO THE PERSON.
 *
 * The person's own words, filed as tree rule R1203: "in chat windows, agents
 * comms are seen in chat windows for the user. Messages inbetween agents are
 * supposeed to go to messages page so the user can track the agent comms from
 * there. Those messages should not appear in the chat window where users chat
 * with the agents."
 *
 * A durable arrival off another circle is put on this stream by
 * shell/agent-host.cjs (showIncoming) shaped as assistant text, because that
 * is the shape every surface downstream reads. Unmarked, it was
 * indistinguishable from the agent's own answer, so it was painted in the
 * person's conversation and saved into the durable record with it -- it came
 * back on every restart. The shell now says which it is (`treeDelivery`), and
 * this door -- the one place this product decides what the chat may paint --
 * declines to hand those words to a transcript.
 *
 * DECLINED HERE, NOT DROPPED THERE. The event still crosses the stream whole:
 * the delivery still reaches the model as its next turn, still lands in the
 * engine's own record, and is still read by the Messages page through its own
 * door (window.mcAgent.localMessages -> 'mc-agent:local-messages' ->
 * ownerJournal), which this file cannot and must not affect. Only the painting
 * changes.
 *
 * AN EVENT WITHOUT THE MARK IS THE AGENT'S OWN SPEECH, exactly as before: an
 * engine that never heard of this field, and every other assistant delta on
 * the wire, read the way they always have. */
export function sessionEventText(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object') return null
  if (event.treeDelivery === true) return null
  if (event.type === 'assistant_text_delta' && typeof event.text === 'string') return event.text
  return null
}

/**
 * One reader per consumer. Whole messages refine their own streamed prefix;
 * identical words with different message identities remain distinct messages.
 * State lasts for the current turn of each admitted session. Owners clear a
 * session on retirement and clear the reader on disposal; no global cache or
 * arbitrary message-count eviction can turn a late echo into new speech.
 */
export function createSessionTextReader() {
  const sessions = new Map()
  const identity = value => typeof value === 'string' && value.length > 0 ? value : null
  function read(packet, sessionId) {
    if (!sessionId || !packet || packet.sessionId !== sessionId) return null
    const event = packet.event
    if (!event || typeof event !== 'object' || event.treeDelivery === true) return null
    if (sessionEndedEvent(packet, sessionId)) { sessions.delete(sessionId); return null }
    const whole = event.type === 'assistant_text'
    const delta = event.type === 'assistant_text_delta'
    let state = sessions.get(sessionId)
    if (!whole && !delta) {
      if (state) {
        if (sessionMessageBoundary(packet, sessionId)) state.breakPending = true
        if (sessionTurnStatus(packet, sessionId)) state.completed = true
      }
      return null
    }
    if (typeof event.text !== 'string') return null
    const turnId = sessionEventTurnId(packet, sessionId)
    if (!state || (turnId && state.turnId !== turnId) || (state.completed && !turnId)) {
      state = { turnId, messages: new Map(), active: null, hasText: false, breakPending: false, completed: false }
      sessions.set(sessionId, state)
    }
    const itemId = identity(event.itemId)
    let message = itemId ? state.messages.get(itemId) : null
    // An unkeyed final can reconcile only the still-open adjacent message.
    // After a tool/whole boundary, equal unkeyed words may be a new message.
    if (!message && state.active && !state.active.closed && !state.breakPending
      && (!itemId || !state.active.itemId)) {
      message = state.active
      if (itemId) { message.itemId = itemId; state.messages.set(itemId, message) }
    }
    // A provider can retain one item across a tool call (ACP does). Keep its
    // raw text contiguous for the aggregate final, but paint the resumed open
    // message after the pending boundary. A closed whole echo adds no seam.
    let breakBefore = Boolean(message && !message.closed && state.hasText && state.breakPending)
    if (!message) {
      message = { itemId, text: '', closed: false }
      if (itemId) state.messages.set(itemId, message)
      breakBefore = state.hasText
    }
    let text
    if (whole) {
      if (event.text.startsWith(message.text)) text = event.text.slice(message.text.length)
      else {
        // An inconsistent final is still observable speech. Preserve it and
        // the already-painted prefix as separate paragraphs, never erase one.
        text = event.text
        breakBefore = state.hasText
      }
      message.text = event.text
      message.closed = true
    } else {
      // A completed identified message is authoritative; late deltas cannot
      // append another copy after its full text has already been admitted.
      if (message.closed) return { text: '', breakBefore: false }
      text = event.text
      message.text += text
    }
    if (text) {
      state.active = message
      state.hasText = true
      state.breakPending = false
    }
    if (whole && state.active === message) state.breakPending = true
    return { text, breakBefore: Boolean(text && breakBefore) }
  }
  return {
    read,
    clear(sessionId) {
      if (sessionId === undefined) sessions.clear()
      else sessions.delete(sessionId)
    },
  }
}

/* THE MODEL'S OWN WORKING, READ AS ITS OWN THING -- NEVER AS sessionEventText.
 *
 * The owner wants thinking shown, and as of 2026-09-03 there is finally
 * something to show it FROM: the engine contract grew an eighth event type
 * for exactly this (engine/src/lib/agent-engine/engine-contract.js's
 * EVENT_TYPES, owner: "more event types are fine we should be showing the
 * user when the model is thinking anyway"). It carries the whole block on
 * `text`, not a delta -- claude-cli-adapter.js emits one `thinking` event per
 * complete block (`{ type: 'thinking', text: part.thinking, ... }`, read off
 * `content[].type === 'thinking'` on the assistant message, never off the
 * token-level stream_event the way assistant_text_delta is), and the type
 * still carries no assistant speech: forwarding it as assistant_text would
 * still put the model's private working into the transcript as though the
 * agent had said it, which is why it keeps this reader rather than joining
 * sessionEventText's. VERIFIED against engine/src/lib/agent-engine/
 * claude-cli-adapter.js and engine-contract.js on release/engine-1.0.41-next;
 * the capability/ copy this app vendors is byte-identical to both.
 *
 * NEVER FOLDED INTO sessionEventText. That function's whole job is "this is
 * what the agent said"; a caller that cannot tell thinking from the answer
 * cannot keep the one promise this file exists to keep. Two readers, one
 * exact-shape check apiece, is the same contract sessionEventText already
 * keeps with sessionActivityEvent -- a type belongs to exactly one reader.
 *
 * NOT THE SAME DOOR sessionActivityEvent USES FOR IT. A sibling lane reads
 * this same `thinking` type into sessionActivityEvent, for the surfaces built
 * on that pipeline's action rows (the tree chat, the Session Transcript
 * panel) -- see sessionActivityEvent's own kind:'thinking' branch. This
 * reader is for the one surface that pipeline never reaches:
 * src/views/agent.js's own composer, which reads sessionEventText/
 * sessionMessageBoundary/sessionTurnStatus directly rather than through
 * sessionActivityEvent, and needs its own thinking reader for the same
 * reason it could not simply call addAction. Both readers may see the same
 * packet; neither call has a side effect until its OWN caller paints
 * something, so a caller that never calls sessionActivityEvent (this one)
 * cannot double-paint one that does. */
const THINKING_EVENT_TYPE = 'thinking'

export function sessionThinkingText(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object') return null
  if (event.type === THINKING_EVENT_TYPE && typeof event.text === 'string') return event.text
  return null
}

/* WHICH TURN A PACKET BELONGS TO, when the engine says so.
 *
 * THE DEFECT THIS EXISTS FOR (owner, 2026-08-18): "the messages in history
 * disappear or combine into each other." The view sums every delta into one
 * string per session and repaints one open bubble with it, and both are
 * released in exactly one place -- a `turn_completed` packet. A turn that ends
 * any other way therefore left the string and the bubble standing, and the NEXT
 * turn's first delta appended to the previous turn's words and repainted the
 * SAME bubble. Two answers became one, silently, and the first one's ending was
 * never recorded.
 *
 * The engine already names the turn on its events -- shell/agent-host.cjs reads
 * exactly this field to announce a turn and to close one -- so the boundary is
 * a fact on the wire rather than something a surface has to infer. Same
 * contract as its siblings: exact shape, exact session, null for everything
 * else, and null for an engine that does not name its turns (which then behaves
 * exactly as it did before this existed).
 */
export function sessionEventTurnId(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object') return null
  if (typeof event.turnId !== 'string' || event.turnId.length === 0 || event.turnId.length > 512) return null
  return event.turnId
}

/* WHERE ONE MESSAGE ENDS INSIDE A TURN, which is a smaller thing than a turn
 * ending and was not marked anywhere.
 *
 * THE DEFECT (owner, 2026-08-22, from the home card): "Said back: ...now.I
 * couldn't". Words reach a screen only as assistant_text_delta, and every
 * accumulator joins deltas bare -- right for the tokens of one message, wrong
 * when an engine says two whole messages in one turn: answer, run a tool,
 * answer again. The second message's first token lands against the first
 * message's full stop with nothing between them.
 *
 * THE WIRE ALREADY MARKS THE SEAM. codex emits assistant_text once per item
 * when that item completes (engine codex-adapter.js), and the Claude CLI
 * emits assistant_text and then tool_call after each message's deltas (engine
 * claude-cli-adapter.js); shell/agent-host.cjs forwards the event whole. So a
 * boundary is a fact on the stream, and this reader names it rather than any
 * surface guessing from punctuation.
 *
 * WHAT IS DELIBERATELY NOT A BOUNDARY. `usage` -- codex emits it mid-message,
 * and a break there would split one sentence in two. The deltas themselves.
 * And turn_completed, which sessionTurnStatus already owns: a turn ending is
 * the bigger seam and every accumulator already settles on it. Same contract
 * as its siblings: exact shape, exact session, false for everything else. */
const MESSAGE_BOUNDARY_EVENTS = new Set(['assistant_text', 'tool_call', 'tool_result', 'approval_request'])

export function sessionMessageBoundary(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return false
  const event = packet.event
  if (!event || typeof event !== 'object') return false
  return typeof event.type === 'string' && MESSAGE_BOUNDARY_EVENTS.has(event.type)
}

/* A PERSON'S MESSAGE THE COMPUTER ACCEPTED INTO A SESSION, from either side.
 *
 * `via` names where it was typed: 'desktop' at the computer's own window, or
 * 'remote' in a signed-in browser driving that computer. `text` is the
 * person's words only; the notes the product adds to a prompt are not part of
 * the event, and scheduler prompts never produce one. The event is not agent
 * speech, so sessionEventText never reads it. Same contract as the readers
 * above: exact shape, exact session, null for everything else. */
const PERSON_TURN_VIA = new Set(['remote', 'desktop'])

export function sessionPersonTurn(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.type !== 'person_turn') return null
  if (!PERSON_TURN_VIA.has(event.via)) return null
  if (typeof event.text !== 'string' || event.text.trim() === '') return null
  const turnId = typeof event.turnId === 'string' && event.turnId.length > 0 && event.turnId.length <= 512 ? event.turnId : null
  const at = Number.isSafeInteger(event.at) && event.at >= 0 ? event.at : null
  return Object.freeze({ via: event.via, text: event.text, turnId, at })
}

export function sessionTurnStatus(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object' || event.type !== 'turn_completed') return null
  return typeof event.status === 'string' ? event.status : 'completed'
}

/* A child process ending is a session end, even with exit code zero. Validate
 * the complete public shape here so a renderer never guesses from a provider
 * event or treats a clean process exit as a successful live session. */
const EXIT_SIGNAL = /^[A-Z][A-Z0-9_]{0,31}$/

export function sessionEndedEvent(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || event.type !== 'session_ended' || !['exited', 'cap-reached', 'parent-stopped'].includes(event.reason)) return null
  if (Object.keys(event).sort().join(',') !== 'exit,reason,type') return null
  const exit = event.exit
  if (!exit || typeof exit !== 'object' || Array.isArray(exit)) return null
  if (Object.keys(exit).sort().join(',') !== 'code,signal') return null
  const code = exit.code
  const signal = exit.signal
  if (code !== null && (!Number.isInteger(code) || code < -2147483648 || code > 2147483647)) return null
  if (signal !== null && (typeof signal !== 'string' || !EXIT_SIGNAL.test(signal))) return null
  return Object.freeze({ reason: event.reason, exit: Object.freeze({ code, signal }) })
}

/* WHOSE WORDS THIS COMPLETION IS ALLOWED TO TAKE.
 *
 * THE DEFECT (owner, 2026-08-18, the other half of "combine into each other").
 * The turn-completion branch read sessionTurnStatus, which carries the STATUS
 * and not the turn id, and then filed whatever was in the session's
 * accumulator as this completion's answer. Order two turns like this --
 *
 *     delta(turn-a)  ->  delta(turn-b)  ->  turn_completed(turn-a)
 *
 * -- and turn B's partial words are recorded as turn A's answer, on the node,
 * in the durable record and in every waiting surface, and B's accumulator is
 * emptied under it. settleTurnBoundary guards the opposite ordering only.
 *
 * So the completion is asked which turn it belongs to before it is allowed to
 * take anything. Answering false does not mean the turn did not end; it means
 * this completion may not touch the LIVE accumulator, because the words in it
 * belong to a turn that is still speaking.
 *
 * IT FALLS BACK TO THE OLD BEHAVIOUR WHENEVER IT CANNOT TELL, and that
 * direction is deliberate. Claude's CLI result packets carry no turn id at
 * all; a rule that refused to file a nameless completion would stop recording
 * completions entirely on that engine, which is a worse defect than the one
 * this fixes. Unknown means "behave exactly as before".
 */
export function completionSettlesOpenTurn(packet, sessionId, openTurnId) {
  if (!sessionTurnStatus(packet, sessionId)) return false
  const completed = sessionEventTurnId(packet, sessionId)
  if (!completed) return true
  if (typeof openTurnId !== 'string' || openTurnId.length === 0) return true
  return completed === openTurnId
}

/* DID THAT TURN SUCCEED -- asked once, here, because the engines do not use the
 * same word for it and three separate surfaces were comparing against one.
 *
 * MEASURED 2026-08-17, the status each engine really put on `turn_completed`
 * for the same successful question:
 *
 *   codex  luna           "completed"   (the codex turn status)
 *   claude claude-sonnet  "success"     (the CLI's result subtype)
 *
 * Each is its own provider's word for the same outcome, and the reader above
 * carries it through unaltered on purpose -- a surface that wants to SHOW what
 * the engine said must still be able to. What was wrong was every caller then
 * testing `status === 'completed'`, which reads a successful Claude turn as a
 * failure: the tree would have painted the node red beside a correct answer.
 *
 * IT IS AN ALLOWLIST AND IT FAILS CLOSED. Success is the claim that needs
 * evidence; error, interrupted, cancelled and anything an engine adds later are
 * all NOT-success until somebody measures them and adds the word here. Calling
 * an unknown outcome a success is the direction that lies to a person. */
// Gemini/Grok ACP reports a normally completed prompt as end_turn.
const TURN_SUCCESS_STATUSES = Object.freeze(['completed', 'success', 'end_turn'])

export function sessionTurnSucceeded(status) {
  return typeof status === 'string' && TURN_SUCCESS_STATUSES.includes(status)
}

export function sessionTurnCancelled(status) {
  return status === 'cancelled' || status === 'canceled'
}

export function nodeStatusForTurn(status, { userStopped = false } = {}) {
  if (sessionTurnSucceeded(status)) return 'finished'
  if (userStopped) return 'interrupted'
  if (sessionTurnCancelled(status)) return 'cancelled'
  return 'turn-failed'
}

export function recoveredNodeTurnStatus(node, status, turnId) {
  const sameTurn = typeof turnId === 'string' && turnId.length > 0 && node?.lastTurnId === turnId
  return nodeStatusForTurn(status, { userStopped: sameTurn && node?.status === 'interrupted' })
}

/* THE SENTENCE A FAILED TURN ENDED WITH, when the engine carried one.
 *
 * MEASURED (fresh-install walkthrough 2026-08-18, re-measured 2026-08-19 on
 * claude 2.1.186): a refused turn ends is_error:true with the provider's one
 * human sentence in the result -- "You're out of usage credits · resets
 * Aug 25, 12am" -- and no assistant text before it. The engine now puts that
 * sentence on the completion event's `text` field; this is the one reader of
 * it, same contract as its siblings: exact shape, exact session, null for
 * everything else. Null for a SUCCESSFUL completion by design -- on success
 * the result text duplicates the assistant text already delivered, so a
 * surface that rendered it would print the answer twice. */
export function sessionTurnFailureText(packet, sessionId) {
  const status = sessionTurnStatus(packet, sessionId)
  if (!status || sessionTurnSucceeded(status)) return null
  const text = packet.event.text
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

/* WHAT THE ACTIONS COST, AND WHY EACH BOUND EXISTS.
 *
 * maxDetailChars   one line in a chat log. A command longer than this is
 *                  truncated on the row and shown whole when it is opened.
 * maxOutputChars   a single `Read` result can be a whole file. What is kept is
 *                  an excerpt to open, never the file.
 * maxPerTurn       a turn can emit thousands of tool events. Beyond this the
 *                  rows FOLD into a count -- see createActionBuffer -- because
 *                  a cap a person cannot see is a cap that lies.
 * maxPerSession    the buffer is otherwise unbounded, and an unbounded buffer
 *                  reaches the durable record, where an oversized save would
 *                  cost the node's conversation. */
export const ACTION_LIMITS = Object.freeze({
  maxDetailChars: 240,
  maxOutputChars: 4_000,
  maxPerTurn: 200,
  maxPerSession: 400,
})

/* WHAT THE AGENT IS DOING, AS ONE LINE OF DETAIL. The engines disagree about
 * where the interesting argument lives: codex puts a shell line on
 * `payload.command`, and the Claude CLI passes the tool's own input through --
 * `file_path` for a Read, `command` for a Bash, `pattern` for a search. Each
 * spelling is looked up by name, and a payload with none of them says nothing
 * rather than having its shape guessed at. */
/* `query` and `description` are the Claude CLI's spellings for a tool search,
 * a web search and a delegated task (MEASURED T384: ToolSearch arrives as
 * `{ query: 'select:...', max_results }` and read as a bare "Step" without
 * them). They sit after the file and command keys so a Bash call still leads
 * with its command rather than its description. */
const DETAIL_KEYS = Object.freeze(['command', 'file_path', 'path', 'pattern', 'url', 'notebook_path', 'query', 'description', 'tool', 'title', 'server'])

/* AND THE THIRD SPELLING: an MCP call, whose subject is the TOOL plus what it
 * was asked for. Measured live on 2026-08-19 by tapping the renderer's own
 * event stream during a real turn: the engine sends
 * `{ server: 'toolsenabled', tool: 'task.submit', arguments: {...} }`, and this
 * function used to answer 'toolsenabled' — because 'server' sat ahead of 'tool'
 * in the list above — so every product tool call in the chat read as the same
 * anonymous line. 'tool' now leads 'server' (a server name is the last resort,
 * not the answer), and the arguments join it here, because a tool name without
 * them cannot tell two calls apart. Still named keys only: a payload with none
 * of them says nothing rather than having its shape guessed at. */
function argumentSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const parts = []
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue
    const rendered = typeof entry === 'string' ? entry
      : typeof entry === 'number' || typeof entry === 'boolean' ? String(entry)
        : Array.isArray(entry) ? `[${entry.length}]`
          : typeof entry === 'object' ? '{…}' : ''
    if (rendered === '') continue
    parts.push(`${key}: ${rendered}`)
    if (parts.join(' · ').length >= ACTION_LIMITS.maxDetailChars) break
  }
  return parts.join(' · ')
}

function detailFrom(payload) {
  for (const key of DETAIL_KEYS) {
    const value = payload[key]
    if (typeof value !== 'string' || value.length === 0) continue
    /* The tool's own name is worth little alone; what it was asked for is the
       half a person acts on. Only the tool key earns the arguments — a bare
       server name stays bare. */
    const withArguments = key === 'tool'
      ? [value, argumentSummary(payload.arguments)].filter(Boolean).join(' · ')
      : value
    return withArguments.slice(0, ACTION_LIMITS.maxDetailChars)
  }
  return ''
}

const CLAUDE_MCP_TOOL = /^mcp__([^_].*?)__(.+)$/
const PRODUCT_TOOL_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/

function toolDetailFrom(event, payload) {
  /* The Claude CLI names an MCP tool on the event (`mcp__<server>__<tool>`)
     and hands its input as the payload itself, with no `tool` or `server`
     key for detailFrom to find -- so a product tool call read as the bare
     tool name with its arguments dropped, where the same call through codex
     reads `tool · key: value`. The arguments are summarised the same way. */
  const mcp = event.type === 'tool_call' && typeof event.tool === 'string' ? CLAUDE_MCP_TOOL.exec(event.tool) : null
  if (mcp) return [mcp[2], argumentSummary(payload)].filter(Boolean).join(' · ').slice(0, ACTION_LIMITS.maxDetailChars)
  /* The local model reaches the product's own tools by their dotted ids
     (`memory.set`, `agent_comms.send_local`; engine local-node-adapter.js
     emits `tool: call.name, payload: call.arguments`), so the same rule
     applies: the tool it named, then what it was asked for. */
  if (event.type === 'tool_call' && typeof event.tool === 'string' && PRODUCT_TOOL_ID.test(event.tool)) {
    return [event.tool, argumentSummary(payload)].filter(Boolean).join(' · ').slice(0, ACTION_LIMITS.maxDetailChars)
  }
  if (event.tool !== 'call_mcp_tool') return detailFrom(payload)
  // The official Antigravity stream uses capitalized MCP parameters on a
  // call, then wraps them in `parameters` on its result. Read those exact
  // fields so the tree names the actual tool and arguments instead of Step.
  // Output strings are never parsed into tool identity or command metadata.
  const parameters = event.type === 'tool_result' ? payload.parameters : payload
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
      || typeof parameters.ToolName !== 'string' || !parameters.ToolName) return ''
  return [parameters.ToolName, argumentSummary(parameters.Arguments)].filter(Boolean)
    .join(' · ').slice(0, ACTION_LIMITS.maxDetailChars)
}

/* THE OUTPUT KEYS, same rule: codex aggregates a command's output, the Claude
 * CLI hands the tool's result back as text. Only a STRING is ever admitted --
 * an object rendered into a chat row is a JSON blob in front of a person. */
const OUTPUT_KEYS = Object.freeze(['aggregatedOutput', 'output', 'result', 'error'])

/* THE TEXT OF A TOOL RESULT THAT DID NOT ARRIVE AS ONE STRING.
 *
 * MEASURED (T384, 2026-09-18, claude 2.1.259, `claude -p --output-format
 * stream-json` against a stdio MCP server): an MCP tool's result reaches the
 * adapter as `content: [{ type: 'text', text }, { type: 'text', text }]`, an
 * ARRAY of blocks, and the adapter carries it whole on `payload` with no
 * `text`. sessionActivityEvent then refused the array (an array is not the
 * record shape it admits) and the row's output was '' -- so every product tool
 * call an agent makes on this computer (they are all MCP calls) opened onto
 * nothing. A ToolSearch result arrived the same way, as `tool_reference`
 * blocks. Codex names the same thing differently: an mcpToolCall item's
 * `result` is `{ content: [...], structuredContent }` (engine codex-adapter.js
 * `_toolResult`), which OUTPUT_KEYS also skipped because it is not a string.
 *
 * WHAT IS READ, and only this: strings; `text` blocks, joined one per line;
 * a `tool_reference` block as the tool it names; and a record's `content`,
 * `result` or `text` member, the same three spellings parseFiledRule already
 * follows for the same results. A record with none of them still says
 * nothing: the JSON-blob rule above stands. Depth and count are bounded so a
 * hostile result cannot recurse or grow past the row's own ceiling. */
function resultText(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const lines = []
    for (const entry of value.slice(0, 64)) {
      const text = resultText(entry, depth + 1)
      if (text) lines.push(text)
      if (lines.join('\n').length >= ACTION_LIMITS.maxOutputChars) break
    }
    return lines.join('\n')
  }
  if (typeof value !== 'object') return ''
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  if (value.type === 'tool_reference' && typeof value.tool_name === 'string') return value.tool_name
  for (const key of ['content', 'result', 'text']) {
    if (key in value) {
      const text = resultText(value[key], depth + 1)
      if (text) return text
    }
  }
  return ''
}

function outputFrom(event, payload) {
  if (typeof event.text === 'string' && event.text.length > 0) return event.text.slice(0, ACTION_LIMITS.maxOutputChars)
  for (const key of OUTPUT_KEYS) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value.slice(0, ACTION_LIMITS.maxOutputChars)
  }
  /* The block forms: a Claude MCP result rides the event's payload as an
     array (so `payload` here is the empty record), a Codex MCP result sits
     under `result` as a record. */
  const blocks = resultText(Array.isArray(event.payload) ? event.payload : payload.result)
  return blocks ? blocks.slice(0, ACTION_LIMITS.maxOutputChars) : ''
}

import { nativeFileChange, unmeasuredFileChange, unmeasuredEditText, boundedChangePatches } from './session-change-patches.js'

/* STRUCTURED FILE CHANGES, AND NOTHING THAT ONLY LOOKS LIKE ONE.
 *
 * A fileChange call already carries the measured records on
 * `payload.changes`. Command text, tool output and assistant prose can all
 * contain paths and diff-looking numbers, but none of those is the protocol.
 * Keeping the admission rule here, beside the event reader, means the ordinary
 * activity row and the compact metadata card are born from the same packet
 * without either surface re-parsing words later.
 *
 * OWN KEYS ARE PART OF THE CONTRACT. Reflect.ownKeys catches non-enumerable
 * and symbol additions too: a public member with any fifth field is not the
 * exact four-field record this surface understands. Every admitted record is
 * rebuilt as a plain object, so a caller cannot mutate the packet after this
 * reader has returned and change what a transcript says happened. */
const FILE_CHANGE_KEYS = Object.freeze(['path', 'status', 'added', 'removed'])
const FILE_CHANGE_STATUSES = Object.freeze({
  a: 'A', add: 'A', added: 'A', create: 'A', created: 'A',
  m: 'M', modify: 'M', modified: 'M', update: 'M', updated: 'M',
  d: 'D', delete: 'D', deleted: 'D', remove: 'D', removed: 'D',
  r: 'R', rename: 'R', renamed: 'R', move: 'R', moved: 'R',
})

function normalizedFileChange(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  let keys = null
  let path
  let status
  let added
  let removed
  try {
    keys = Reflect.ownKeys(candidate)
    if (keys.length !== FILE_CHANGE_KEYS.length
        || !FILE_CHANGE_KEYS.every(key => keys.includes(key))) return null
    path = candidate.path
    status = candidate.status
    added = candidate.added
    removed = candidate.removed
  } catch {
    return null
  }
  if (typeof path !== 'string' || path.length > 4096 || path.trim() === '') return null
  if (typeof status !== 'string') return null
  const statusKey = status.trim().toLowerCase()
  const canonicalStatus = Object.hasOwn(FILE_CHANGE_STATUSES, statusKey) ? FILE_CHANGE_STATUSES[statusKey] : ''
  if (!canonicalStatus) return null
  if (!Number.isFinite(added) || !Number.isInteger(added) || added < 0) return null
  if (!Number.isFinite(removed) || !Number.isInteger(removed) || removed < 0) return null
  return { path, status: canonicalStatus, added, removed }
}

function normalizedFileChanges(candidates) {
  if (!Array.isArray(candidates)) return []
  const files = []
  for (const candidate of candidates) {
    const file = normalizedFileChange(candidate)
    if (file) files.push(file)
  }
  return files
}

/* ONE FILE'S IDENTITY FOR LIVE CHAT COUNTERS, NEVER ITS DISPLAY PATH.
 *
 * The file-change protocol keeps the engine's exact path for the diff card and
 * callback. Counters need a different thing: a stable key which can recognise
 * lexical aliases without rewriting what the person sees. Root pieces are held
 * outside the ordinary segment stack, so `..` can never silently invent a
 * parent above `/`, a drive root, a UNC share, or the start of a relative path.
 * `platform` describes the executing filesystem, never the viewing browser or
 * native host of a possibly remote worker. Without that contract only exact
 * reported spelling proves identity; guessing separators or case can erase
 * distinct Linux files and their line deltas. */
export function normalizeChatPathIdentity(path, platform) {
  if (typeof path !== 'string' || path.trim() === '') return null
  if (platform !== 'win32' && platform !== 'linux') return path
  const windows = platform === 'win32'
  const prepared = windows ? path.trim().replace(/\\/g, '/') : path

  let root = ''
  let candidates = []
  if (windows && /^\/\/[^/]/.test(prepared)) {
    /* Exactly two leading separators followed by a name is UNC syntax. Empty
       pieces and `.` are lexical aliases here too, but the server and share
       themselves must both be ordinary segments. */
    const pieces = prepared.slice(2).split('/').filter(piece => piece !== '' && piece !== '.')
    if (pieces.length < 2 || pieces[0] === '..' || pieces[1] === '..') return null
    root = `//${pieces[0]}/${pieces[1]}`
    candidates = pieces.slice(2)
  } else {
    const drive = windows ? prepared.match(/^([A-Za-z]:)\/+/) : null
    if (drive) {
      root = `${drive[1]}/`
      candidates = prepared.slice(drive[0].length).split('/')
    } else if (prepared.startsWith('/')) {
      root = '/'
      candidates = prepared.replace(/^\/+/, '').split('/')
    } else {
      candidates = prepared.split('/')
    }
  }

  const segments = []
  for (const candidate of candidates) {
    if (candidate === '' || candidate === '.') continue
    if (candidate === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(candidate)
  }

  let identity = ''
  if (root === '/') identity = segments.length ? `/${segments.join('/')}` : '/'
  else if (root.endsWith('/')) identity = segments.length ? `${root}${segments.join('/')}` : root
  else if (root) identity = segments.length ? `${root}/${segments.join('/')}` : root
  else if (segments.length) identity = segments.join('/')
  else return null
  return platform === 'win32' ? identity.toLowerCase() : identity
}

function chatMetricFileChange(candidate, platform) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  let keys
  let path
  let status
  let added
  let removed
  try {
    keys = Reflect.ownKeys(candidate)
    if (keys.length !== FILE_CHANGE_KEYS.length
        || !FILE_CHANGE_KEYS.every(key => keys.includes(key))) return null
    path = candidate.path
    status = candidate.status
    added = candidate.added
    removed = candidate.removed
  } catch {
    return null
  }
  if (typeof path !== 'string' || path.length > 4096) return null
  if (status !== 'A' && status !== 'M' && status !== 'D' && status !== 'R') return null
  const identity = normalizeChatPathIdentity(path, platform)
  if (identity === null) return null
  if (!Number.isFinite(added) || !Number.isInteger(added) || added < 0) return null
  if (!Number.isFinite(removed) || !Number.isInteger(removed) || removed < 0) return null
  return { identity, added, removed }
}

/* THE CHOICES A PERSON CAN ACTUALLY PRESS, read off the shapes the two engines
 * really emit.
 *
 * MEASURED 2026-09-03 by reading both emitters against this reader. This
 * function's predecessor was one line -- `filter(d => typeof d === 'string')` --
 * and NEITHER adapter has ever emitted a string:
 *
 *   codex   src/lib/agent-engine/codex-adapter.js approvalChoices()
 *           commandExecution/fileChange -> [{value:'accept'}, {value:'decline'}, …]
 *           permissions                 -> [{responseFields:[…], scopes:[…]}]
 *   claude  src/lib/agent-engine/claude-adapter.js _handleAgentRequest()
 *           tool_permission             -> [{optionId:'allow', name:'Allow', …}]
 *
 * So every real request normalised to `[]`, the card in src/views/computers.js
 * mapped that empty list into an empty row of buttons, and the agent waited on
 * a question with nothing to press and nothing said about why. The reply path
 * was landed first precisely so that could not happen; the filter silently
 * undid it. The app's own fixtures invented `['accept','decline']`, a shape no
 * engine produces, which is why every suite stayed green over it.
 *
 * WHAT IS DROPPED IS DROPPED ON PURPOSE, NOT FOR LACK OF A BRANCH. codex's
 * `permissions` choice carries no identifier at all -- it is a response SCHEMA
 * (`responseFields`/`scopes`), and its adapter answers it with a
 * permissions+scope record, not with one word. The host's reply path sends
 * `{decision:'<word>'}`, so no button could answer it. It stays out, and the
 * card says so rather than standing empty (APPROVAL_PANEL.unanswerable).
 *
 * Bounded to 512 characters, with a dedupe and a ceiling of
 * 32, the same ceiling the Claude adapter enforces on the wire. */
const MAX_AVAILABLE_DECISIONS = 32

export function approvalDecisionIds(availableDecisions) {
  if (!Array.isArray(availableDecisions)) return []
  const ids = []
  const seen = new Set()
  for (const decision of availableDecisions) {
    /* Three known spellings of "one pressable choice", and nothing else. An
       unrecognised entry is not turned into a button that cannot be answered. */
    const id = typeof decision === 'string'
      ? decision
      : (decision && typeof decision === 'object' && !Array.isArray(decision)
        ? (typeof decision.value === 'string'
          ? decision.value
          : (typeof decision.optionId === 'string' ? decision.optionId : ''))
        : '')
    if (!id || id.length > 512 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length === MAX_AVAILABLE_DECISIONS) break
  }
  return ids
}

export function approvalDecisionKinds(availableDecisions) {
  const kinds = Object.create(null)
  const ids = new Set(approvalDecisionIds(availableDecisions))
  for (const option of Array.isArray(availableDecisions) ? availableDecisions.slice(0, 32) : []) {
    if (!option || typeof option !== 'object' || !ids.has(option.optionId)) continue
    if (['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind)) {
      kinds[option.optionId] = option.kind
    }
  }
  return kinds
}

/* WHAT THE AGENT IS DOING, as data. The engine already narrates a turn --
 * tool_call, tool_result, approval_request all reach the renderer -- and until
 * 2026-08-13 every one was dropped by the two readers above, which is half of
 * why a working agent looked like a hung one. This reader stays in the same
 * contract as its siblings: exact shape, exact session, null for everything
 * else. It returns FIELDS, never a sentence -- this module is deliberately
 * dependency-free, and the words belong to the copy modules (activityLine in
 * src/fleet-tree-copy.js), where the plain-language gate can hold them. */
export function sessionActivityEvent(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object') return null
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}
  /* THE NAME A RESULT IS JOINED TO ITS CALL BY. Both adapters already put it on
     the event -- codex as the item id, the Claude CLI as the tool_use_id -- and
     without it a result can only be appended as a SECOND row, which is how a
     list of five commands reads as ten. */
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : ''
  if (event.type === 'tool_call') {
    const activity = {
      kind: 'call',
      toolCallId,
      tool: typeof event.tool === 'string' ? event.tool : '',
      command: typeof payload.command === 'string' ? payload.command : '',
      detail: toolDetailFrom(event, payload),
      exitCode: null,
      status: '',
      output: '',
    }
    /* Only this exact real tool and this exact structured field may add the
       delta protocol. An empty/all-invalid array leaves the ordinary activity
       row untouched and carries no optimistic placeholder. */
    if (event.tool === 'fileChange') {
      let candidates = null
      try { candidates = payload.changes } catch { candidates = null }
      const fileChanges = [], filePatches = []
      for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 100) : []) {
        try {
          const measured = normalizedFileChange(candidate)
          const file = measured || nativeFileChange(candidate)
          if (!file) continue
          fileChanges.push(file)
          if (!measured) filePatches.push({ path: file.path, diff: candidate.diff })
        } catch { /* one unreadable member cannot discard the other changes */ }
      }
      if (fileChanges.length > 0) activity.fileChanges = fileChanges
      if (Array.isArray(candidates) && candidates.length > 100) activity.fileChangesLimited = true
      const patches = boundedChangePatches(filePatches, fileChanges)
      if (patches.length) activity.filePatches = patches
    } else {
      const file = unmeasuredFileChange(event.tool, payload)
      if (file) {
        activity.fileChanges = [file]
        /* Read from the same payload, so a path the binder already rewrote is
           the path this record carries. */
        const edit = unmeasuredEditText(event.tool, payload, file.path)
        if (edit) activity.fileEdits = [edit]
      }
    }
    return activity
  }
  if (event.type === 'tool_result') {
    return {
      kind: 'result',
      toolCallId,
      tool: typeof event.tool === 'string' ? event.tool : '',
      command: typeof payload.command === 'string' ? payload.command : '',
      detail: toolDetailFrom(event, payload),
      exitCode: Number.isFinite(payload.exitCode) ? payload.exitCode : null,
      /* THE CLAUDE CLI PUTS THIS ON THE EVENT, NOT IN THE PAYLOAD (its adapter
         emits `status: part.is_error === true ? 'error' : 'ok'` alongside the
         payload). Reading only payload.status read every failed Claude tool
         call as an unremarkable one. */
      status: typeof payload.status === 'string' && payload.status
        ? payload.status
        : (typeof event.status === 'string' ? event.status : ''),
      output: outputFrom(event, payload),
    }
  }
  if (event.type === 'thinking') {
    /* THE MODEL'S OWN REASONING, SHOWN AS ITS OWN ROW -- NEVER AS SOMETHING
       THE AGENT SAID. Owner, 2026-09-03: "more event types are fine we
       should be showing the user when the model is thinking anyway." Both
       engines forward it as this one contract type (claude-cli-adapter.js's
       assistant content[].type==='thinking', codex-adapter.js's
       item type==='reasoning'), and this reader is the one place that type
       becomes a row -- reusing the action-row pipeline rather than a second
       one, so it inherits the bounds, the durable record and the per-turn
       fold that pipeline already proved. `output`, not `detail`: the words
       belong in the opened body, the same place a tool's own output goes,
       not the one-line summary read without pressing anything. */
    const summary = thinkingSummary(event.text, event.payload?.truncated)
    return {
      kind: 'thinking',
      itemId: typeof event.itemId === 'string' ? event.itemId : '',
      transcriptId: thinkingTranscriptId(sessionId, event.turnId, event.itemId),
      toolCallId: '',
      tool: '',
      command: '',
      detail: '',
      exitCode: null,
      status: event.status === 'inProgress' ? 'inProgress' : '',
      output: summary.body,
      truncated: summary.truncated,
    }
  }
  if (event.type === 'approval_request') {
    /* The whole request rides as FIELDS: the id the reply must name, the kind,
       the engine's stated decision vocabulary, and the details a person needs
       to actually decide (the command, the file). Until 2026-08-14 this
       returned {kind:'approval'} alone — enough to print the waiting line and
       structurally impossible to answer. */
    const approval = event.approval && typeof event.approval === 'object' ? event.approval : {}
    return {
      kind: 'approval',
      /* An approval has no tool call to join to, so it is its own row and its
         own id -- and answering it is what closes it. */
      toolCallId: '',
      tool: typeof approval.kind === 'string' ? approval.kind : '',
      command: '',
      detail: detailFrom(approval.details && typeof approval.details === 'object' ? approval.details : {})
        || detailFrom(approval.details?.toolCall && typeof approval.details.toolCall === 'object' ? approval.details.toolCall : {}),
      exitCode: null,
      status: '',
      output: '',
      approvalId: typeof approval.approvalId === 'string' ? approval.approvalId : '',
      approvalKind: typeof approval.kind === 'string' ? approval.kind : '',
      availableDecisions: approvalDecisionIds(approval.availableDecisions),
      decisionKinds: approvalDecisionKinds(approval.availableDecisions),
      details: approval.details && typeof approval.details === 'object' ? approval.details : {},
    }
  }
  return null
}

/* A RULE THE AGENT FILED, READ OFF THE ENGINE'S OWN TOOL EVENTS.
 *
 * With "Turning something you said into a standing rule" on, an agent calls
 * r_ledger.file and the engine answers `{ filed: true, id, scope, key,
 * filedBy, appliesTo, note }` (engine r-ledger-agent-gate.js). The chat has
 * to show the person what was filed and where, and the ONLY honest source is
 * that result: the agent's prose about what it did is a claim, and a claim
 * can be wrong in both directions.
 *
 * THE TWO ENGINES, MEASURED SHAPES. Codex names the MCP tool on the CALL
 * (`payload.tool`, 'r_ledger.file', with `payload.arguments`) and carries the
 * reply on the RESULT as `payload.result` -- the MCP reply, whose
 * structuredContent is the object above and whose content is the same thing
 * as JSON text. The Claude CLI names the tool on the call as
 * `mcp__<server>__r_ledger_file` with the input as `payload`, and carries the
 * result back as text blocks (`payload` an array, or `text` a string). Both
 * readers below accept both, by name and by shape, and the contract is the
 * siblings': exact shape, exact session, null for everything else.
 *
 * THE WORDS COME FROM THE CALL, NOT THE RESULT. The result carries no words
 * (the ledger module answers ids and reach, deliberately), so the excerpt a
 * person sees is taken from the arguments the agent passed -- which are the
 * words the module filed, verbatim. The two are paired by toolCallId, the
 * same join the action rows use. */
const RULE_FILING_TOOL = /(?:^|[._:/])r_ledger[._]file$/
/* The one canonical ledger's id grammar (engine src/lib/request-id.js, family
   R): R1..R9999 and dotted refinements (R5.1). The per-scope RS/RT/RTH
   prefixes are retired with the four markdown ledgers. */
const RULE_ID = /^R(?:0\d|[1-9]\d{0,3})(?:\.[1-9]\d*)*$/
const RULE_WORDS_MAX = 16_384

function toolNameOf(event) {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}
  if (typeof payload.tool === 'string' && payload.tool.length > 0 && payload.tool.length <= 256) return payload.tool
  if (typeof event.tool === 'string' && event.tool.length > 0 && event.tool.length <= 256) return event.tool
  return ''
}

function parseFiledRule(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text.startsWith('{')) return null
    try { return parseFiledRule(JSON.parse(text), depth + 1) } catch { return null }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = parseFiledRule(entry, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  if (value.filed === true && typeof value.id === 'string' && RULE_ID.test(value.id)) return value
  for (const key of ['structuredContent', 'structured_content', 'result', 'content', 'text']) {
    if (key in value) {
      const found = parseFiledRule(value[key], depth + 1)
      if (found) return found
    }
  }
  return null
}

const boundedText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

/**
 * A `tool_call` that is the agent filing a rule: `{ toolCallId, words }`, or
 * null. The words are bounded to the ledger module's own per-entry cap and
 * are the ONLY thing kept from the arguments -- the actor and key are the
 * engine's business and never reach a screen from here.
 */
export function sessionRuleFilingCall(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object' || event.type !== 'tool_call') return null
  if (!RULE_FILING_TOOL.test(toolNameOf(event))) return null
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}
  /* Codex nests the input under `arguments`; the Claude CLI hands the input
     itself as the payload. */
  const input = payload.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)
    ? payload.arguments
    : payload
  return {
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId.slice(0, 512) : '',
    words: boundedText(input.words, RULE_WORDS_MAX),
  }
}

/**
 * A `tool_result` that says a rule WAS filed: the result's own fields, or
 * null. `filed: true` with a ledger-shaped id is required; a result naming a
 * tool that is not r_ledger.file is refused by name even if its shape fits.
 * Codex results name the call 'mcpToolCall' on the event, so that name is
 * not a refusal -- the shape decides there, as it does for a nameless result.
 */
export function sessionFiledRule(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object' || event.type !== 'tool_result') return null
  const name = toolNameOf(event)
  if (name && name !== 'mcpToolCall' && !RULE_FILING_TOOL.test(name)) return null
  const filed = parseFiledRule(event.payload) || parseFiledRule(event.text)
  if (!filed) return null
  return {
    toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId.slice(0, 512) : '',
    id: filed.id,
    scope: boundedText(filed.scope, 16),
    key: boundedText(filed.key, 128),
    appliesTo: boundedText(filed.appliesTo, 120),
    filedBy: boundedText(filed.filedBy, 80),
  }
}

/* WHAT THE TURN HAS COST, as data. The engine reports token usage on every
 * thread/tokenUsage/updated and the adapter re-emits it as a `usage` event —
 * which crossed mc-agent:event from the first day and was dropped by every
 * reader here. Same contract as the siblings: exact shape, exact session,
 * null otherwise. Only FINITE NUMBERS survive from the usage record: the
 * shape is the engine's own and unversioned here, and a filter that admits
 * only numeric fields cannot smuggle prose or paths onto a screen. */
export function sessionUsageEvent(packet, sessionId) {
  if (!packet || typeof packet !== 'object' || packet.sessionId !== sessionId) return null
  const event = packet.event
  if (!event || typeof event !== 'object' || event.type !== 'usage') return null
  const record = event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage) ? event.usage : {}
  /* MEASURED SHAPE (codex 0.146 app-server, captured live 2026-08-14):
     { total: {totalTokens, inputTokens, cachedInputTokens, outputTokens, ...},
       last: {...same...}, modelContextWindow }. `total` is the session's
     lifetime reading — the one "What it has used" means. Older or flat shapes
     fall back to the record itself, and the numbers-only filter holds either
     way: prose or a path in a usage record can never reach a screen. */
  const source = record.total && typeof record.total === 'object' && !Array.isArray(record.total)
    ? record.total
    : record
  const usage = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && Number.isFinite(value)) {
      usage[key] = value
    }
  }
  if (Number.isFinite(record.modelContextWindow)) usage.modelContextWindow = record.modelContextWindow
  return {
    turnId: typeof event.turnId === 'string' ? event.turnId : null,
    usage,
  }
}

/* WHAT THE AGENT DID, KEPT IN ORDER AND BOUNDED IN PUBLIC.
 *
 * WHY A BUFFER AT ALL. The rows have to survive two things the live event
 * stream does not: a chat opened halfway through a turn (which must already
 * show the work taken so far) and a chat that is not open at all (a person
 * watching the tree, who opens the circle afterwards). So the actions are held
 * per session beside the transcript, exactly the way the words are.
 *
 * WHY IT IS CAPPED, and why the caps are the visible kind. A turn can emit
 * thousands of tool events, and this buffer feeds the DURABLE record. An
 * unbounded buffer therefore reaches a save, and an oversized save is the
 * defect that used to cost a node its whole conversation. Two caps, and
 * neither is silent:
 *
 *   per turn     beyond it the rows FOLD into a count -- `folded(turnId)` --
 *                so a screen can say "and 412 more steps" instead of quietly
 *                showing the first two hundred as if they were all of them.
 *   per session  the OLDEST rows leave, the newest stay (the newest are where
 *                the work is), and `dropped` says how many went.
 *
 * A RESULT UPDATES ITS CALL'S ROW; it never appends a second one. Both engines
 * name the call -- codex with the item id, the Claude CLI with the tool_use_id
 * -- so the join is a fact on the wire. An engine that names NOTHING keeps
 * every row separate, because folding every unnamed action onto one row would
 * be worse than an extra row.
 */
export function createActionBuffer({
  maxPerTurn = ACTION_LIMITS.maxPerTurn,
  maxPerSession = ACTION_LIMITS.maxPerSession,
  platform,
} = {}) {
  let rows = []
  const byCallId = new Map()
  const byThinkingId = new Map()
  const foldedPerTurn = new Map()
  /* Live-turn truth is deliberately not derived from these bounded rows. A
     fold, eviction, repaint, or restored transcript can change what is held for
     display without changing what this turn has actually done. Each turn owns
     all of its counts and all of the identities which prove them. */
  const metricsPerTurn = new Map()
  let dropped = 0

  const metricStateFor = (turnId) => {
    let state = metricsPerTurn.get(turnId)
    if (!state) {
      state = {
        toolCallIds: new Set(),
        filePaths: new Set(),
        fileEvents: new Map(),
        added: 0,
        removed: 0,
      }
      metricsPerTurn.set(turnId, state)
    }
    return state
  }

  const admitMetrics = (activity, turnId) => {
    if (activity.kind !== 'call'
        || typeof turnId !== 'string' || turnId.length === 0
        || typeof activity.toolCallId !== 'string' || activity.toolCallId.length === 0) return

    const state = metricStateFor(turnId)
    state.toolCallIds.add(activity.toolCallId)

    let candidates = null
    try { candidates = activity.fileChanges } catch { candidates = null }
    if (!Array.isArray(candidates)) return
    let length = 0
    try { length = candidates.length } catch { return }
    let eventPaths = state.fileEvents.get(activity.toolCallId)
    if (!eventPaths) {
      eventPaths = new Set()
      state.fileEvents.set(activity.toolCallId, eventPaths)
    }
    for (let index = 0; index < length; index += 1) {
      let candidate = null
      try { candidate = candidates[index] } catch { continue }
      const file = chatMetricFileChange(candidate, platform)
      if (!file || eventPaths.has(file.identity)) continue
      /* Mark the event/path before changing any total. A replay carrying
         different numbers is still the same proved event and contributes
         nothing a second time. */
      eventPaths.add(file.identity)
      state.filePaths.add(file.identity)
      state.added += file.added
      state.removed += file.removed
    }
  }

  const stateOf = (activity) => {
    if (activity.kind === 'approval') return 'waiting'
    if (activity.kind === 'call') return 'working'
    if (activity.kind === 'thinking' && activity.status === 'inProgress') return 'working'
    /* A COMMAND THAT WAS NEVER ALLOWED TO RUN IS NOT A COMMAND THAT FAILED, and
     * this line has to come BEFORE the exit code or it can never fire.
     *
     * MEASURED on the wire, 2026-08-20, real Codex/luna in a staged packaged
     * build, through a read-only tap on the preload channel the view already
     * subscribes to. The two shapes are structurally different:
     *
     *   refused   status "declined", exitCode -1
     *   failed    status "failed",   exitCode 1
     *
     * -1 is a finite number, so the rule below read every refusal as a failed
     * command: four rows saying "did not finish" about `node --version`, which
     * succeeds anywhere this product runs. A person reading that goes hunting a
     * fault in their own commands when what actually happened is that this
     * computer would not let the agent run anything.
     *
     * ON THE STATUS, NEVER ON THE SENTENCE. The output does say "rejected:
     * blocked by policy", and matching that would be guessing at prose -- the
     * engine's own wording, rephrasable without notice, and it would misread a
     * genuinely broken command that happened to print those words. `status` is
     * the contract; the sentence is not.
     *
     * ONLY THE SPELLING THAT WAS MEASURED. Codex's approval vocabulary also
     * holds "cancel", and a cancelled command presumably lands somewhere near
     * here, but nobody has watched one arrive. It falls through to the rules
     * below until somebody does. The Claude CLI has no refusal status at all
     * today (its adapter emits only 'ok' or 'error'), so this cannot fire for
     * it -- which is correct, not a gap: inventing one would be the same guess
     * in a different place. */
    if (activity.status === 'declined') return 'refused'
    if (Number.isFinite(activity.exitCode)) return activity.exitCode === 0 ? 'done' : 'undone'
    if (activity.status === 'error' || activity.status === 'failed') return 'undone'
    return 'done'
  }

  return {
    /** File one activity. Answers what it did, so the caller can append a row,
     *  repaint one, or repaint only the fold count. */
    add(activity, options = {}) {
      if (!activity || typeof activity !== 'object') return { row: null, change: 'ignored' }
      // A textless reasoning start updates live activity, not completed history or tool counts.
      if (activity.kind === 'thinking' && !activity.output?.trim() && !activity.itemId) return { row: null, change: 'ignored' }
      const supplied = options && typeof options === 'object' ? options : {}
      const { turnId = null, at = Date.now() } = supplied
      /* Metrics are admitted before every row-only early return. Their truth
         therefore survives a result join, a per-turn fold, and session-row
         eviction without ever being reconstructed from those rows. */
      admitMetrics(activity, turnId)
      /* A row still needs an ordering moment when no receipt was supplied, but
         only an OWN finite `at` is evidence that can measure elapsed time. */
      const hasReceipt = Object.hasOwn(supplied, 'at') && Number.isFinite(supplied.at)
      const receiptAt = hasReceipt ? supplied.at : null
      /* A structural pair, not a delimiter-joined string: turn `a` / call
         `b:c` must never alias turn `a:b` / call `c`. */
      const key = activity.toolCallId ? JSON.stringify([turnId, activity.toolCallId]) : ''
      const thinkingKey = activity.kind === 'thinking' && activity.itemId ? JSON.stringify([turnId, activity.itemId]) : ''
      const held = thinkingKey ? byThinkingId.get(thinkingKey) : (activity.kind === 'result' && key ? byCallId.get(key) : null)
      if (held) {
        /* The row keeps the moment it OPENED. Re-stamping it on the result
           would move a finished command to the end of a conversation it
           started five minutes earlier. */
        held.state = stateOf(activity)
        if (activity.tool) held.tool = activity.tool
        if (activity.detail) held.detail = activity.detail
        if (Number.isFinite(activity.exitCode)) held.exitCode = activity.exitCode
        if (activity.output || activity.kind === 'thinking') held.output = activity.output
        if (activity.kind === 'thinking') {
          held.truncated = activity.truncated === true
          return { row: held, change: 'updated' }
        }
        /* A missing or backwards result receipt is not an interval. Clear any
           stale optional evidence before admitting the result now in hand. */
        delete held.endedAt
        delete held.durationMs
        if (hasReceipt && Object.hasOwn(held, 'startedAt') && Number.isFinite(held.startedAt) && receiptAt >= held.startedAt) {
          held.endedAt = receiptAt
          held.durationMs = receiptAt - held.startedAt
        }
        return { row: held, change: 'updated' }
      }
      if (activity.kind === 'thinking' && !activity.output?.trim()) return { row: null, change: 'ignored' }
      if (turnId) {
        const already = rows.filter(row => row.turnId === turnId).length
        if (already >= maxPerTurn) {
          foldedPerTurn.set(turnId, (foldedPerTurn.get(turnId) || 0) + 1)
          return { row: null, change: 'folded', folded: foldedPerTurn.get(turnId) }
        }
      }
      const row = {
        id: thinkingKey ? `thinking:${thinkingKey}` : activity.kind === 'approval' && activity.approvalId
          ? JSON.stringify(['approval', turnId || null, activity.approvalId])
          : activity.toolCallId || `${turnId || 'turn'}-${at}-${rows.length}`,
        turnId: turnId || null,
        at,
        kind: activity.kind,
        tool: activity.tool || '',
        detail: activity.detail || '',
        exitCode: Number.isFinite(activity.exitCode) ? activity.exitCode : null,
        output: activity.output || '',
        state: stateOf(activity),
        ...(activity.kind === 'approval' && activity.approvalId ? { approvalId: activity.approvalId } : {}),
        ...(activity.kind === 'thinking' ? { itemId: activity.itemId || '', transcriptId: activity.transcriptId || undefined, truncated: activity.truncated === true } : {}),
      }
      if (activity.kind === 'call' && hasReceipt) row.startedAt = receiptAt
      rows.push(row)
      if (activity.kind === 'call' && key) byCallId.set(key, row)
      if (thinkingKey) byThinkingId.set(thinkingKey, row)
      if (rows.length > maxPerSession) {
        const leaving = rows.slice(0, rows.length - maxPerSession)
        rows = rows.slice(rows.length - maxPerSession)
        dropped += leaving.length
        for (const gone of leaving) {
          for (const [heldKey, heldRow] of byCallId) if (heldRow === gone) byCallId.delete(heldKey)
          for (const [heldKey, heldRow] of byThinkingId) if (heldRow === gone) byThinkingId.delete(heldKey)
        }
      }
      return { row, change: 'added' }
    },
    /**
     * Close the books on every row still in flight, and answer which moved.
     *
     * THE DEFECT THIS ENDS. A call is filed `working` and only a RESULT moves
     * it. Nothing guaranteed a result: the engine can drop one, the process can
     * die mid-command, a sandbox can refuse after the fact. So a turn could end
     * with rows frozen mid-sentence, and because the caller files `row.state`
     * into the durable record verbatim, the saved conversation kept the word
     * "running" for ever -- a transcript telling a person something untrue
     * about a machine that stopped minutes ago. Seen in a driven after-picture
     * on 2026-08-20: `Get-Content -Raw -Litera… running`, green edge, on a turn
     * long over.
     *
     * `unknown` IS ITS OWN OUTCOME AND MUST STAY ONE. The cheap fix is to call
     * these rows finished, and that would be the worse lie of the two: nothing
     * measured the command succeeding. Nor did anything measure it failing, so
     * `undone` is equally unearned -- a red row sends a person hunting a fault
     * that may not exist. The row says what is actually known, which is that no
     * result came back.
     *
     * IT IS NOT A TOMBSTONE. The join key is untouched, so a result that merely
     * arrived late still finds its row through the ordinary update path above
     * and corrects it.
     */
    answerApproval(approvalId, state, { turnId = null } = {}) {
      if (!approvalId || (state !== 'refused' && state !== 'done')) return null
      const row = rows.find(entry => entry.kind === 'approval' && entry.approvalId === approvalId
        && (!turnId || entry.turnId === turnId))
      if (!row || (row.state !== 'waiting' && row.state !== 'closed')) return row || null
      row.state = state
      return row
    },
    settleUnfinished({ keepWaitingIds = null } = {}) {
      const moved = []
      const keep = keepWaitingIds instanceof Set ? keepWaitingIds : null
      for (const row of rows) {
        if (row.state === 'working') {
          row.state = 'unknown'
          moved.push(row)
          continue
        }
        if (row.state === 'waiting' && row.kind === 'approval' && !(keep && keep.has(row.approvalId))) {
          row.state = 'closed'
          moved.push(row)
        }
      }
      return moved
    },
    metrics(turnId) {
      const state = metricsPerTurn.get(turnId)
      if (!state) return {}
      const snapshot = {}
      const values = {
        tools: state.toolCallIds.size,
        files: state.filePaths.size,
        added: state.added,
        removed: state.removed,
      }
      for (const key of ['tools', 'files', 'added', 'removed']) {
        const value = values[key]
        if (Number.isFinite(value) && Number.isInteger(value) && value > 0) snapshot[key] = value
      }
      return snapshot
    },
    clearMetrics(turnId) { metricsPerTurn.delete(turnId) },
    resetMetrics() { metricsPerTurn.clear() },
    list() { return rows.slice() },
    folded(turnId) { return foldedPerTurn.get(turnId) || 0 },
    get dropped() { return dropped },
  }
}
