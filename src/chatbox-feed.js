/* WHAT THE CHAT BOX ON THE FIRST PAGE IS ALLOWED TO CONTAIN.
 *
 * The owner asked for two controls, and they are two because they answer two
 * different questions:
 *
 *   1. WHICH AGENTS' CONTEXT APPEARS. A selection over agents, not one choice
 *      out of a list -- "select which agents context shows up in the chatbox".
 *   2. WHETHER AGENT RUNS APPEAR. Three states, not a switch -- "if agent runs
 *      shows up too or not or only". Runs alongside the conversation, runs
 *      hidden, or runs and nothing else.
 *
 * The box's contents are the product of those two. This module owns both
 * settings and the pure decision they drive; src/local-activity.js turns that
 * decision into sentences and src/views/home.js renders it.
 *
 * WHY THIS IS A SETTING FAMILY AND NOT A ROW IN src/views/settings.js.
 *
 * src/setup-profile.js states the measured fact this design is built around:
 * the ninety rows in the settings view write `mc.set.<id>` and NOTHING READS
 * THAT KEY. A row there is a presentation surface. The settings that do
 * something are the ones with a module like this one behind them -- the live
 * flags (`mc.live.*`) and the write flags (`mc.write.*`) -- and both are read
 * by the code whose behaviour they change, announce their changes on an event
 * so the affected screen updates, and store only a NON-DEFAULT choice so the
 * default can move later without stale keys pinning anyone to the past. These
 * two follow that same shape exactly, for the same reasons.
 *
 * THE AGENT LIST IS DISCOVERED, NEVER WRITTEN DOWN HERE. Agents are added,
 * renamed and retired, so a literal list is one rename away from offering a
 * choice between agents nobody has. `discoverAgents` below derives the list
 * from what the product already knows -- the agent register it reads, the
 * senders in the conversation the box is showing, and the cast of the labelled
 * demonstration when that is what is on screen -- and it is the same function
 * on the settings screen and on the home screen, so the list you choose from
 * and the list being filtered can never disagree.
 *
 * NO DOM AND NO STYLESHEET, so `node --test` can walk every combination of
 * these two settings without a browser. Storage and the change event are the
 * only browser surfaces touched and both are guarded.
 */

export const CHATBOX_FEED_EVENT = 'mc:chatbox-feed-changed'

/* THE THREE STATES, in the owner's own order: "too or not or only". */
export const RUNS_MODES = Object.freeze([
  Object.freeze({
    id: 'with',
    label: 'Show them too',
    detail: 'The box shows what your agents are saying and, under it, the record of every agent run on the computer you are driving.',
  }),
  Object.freeze({
    id: 'hidden',
    label: 'Hide them',
    detail: 'The box shows what your agents are saying and nothing else. If the computer you are driving has no conversation yet, the box will be empty, and it will say so rather than filling itself.',
  }),
  Object.freeze({
    id: 'only',
    label: 'Show only runs',
    detail: 'The box shows the record of agent runs on the computer you are driving and no conversation at all.',
  }),
])

/* WHY `with` IS THE SHIPPED DEFAULT.
 *
 * `hidden` empties the box on every computer that has no conversation to show,
 * which is every fresh installation -- and an empty first screen is the exact
 * defect the home screen was rewritten to remove. `only` throws away the most
 * valuable thing on a computer that does have a coordinator talking. `with` is
 * the only value that is never empty when there is anything at all to show, and
 * on a computer with nothing connected it is byte for byte what the screen
 * showed before this setting existed. Every other value is a NARROWING that the
 * person chose, which is the property a default should have. */
export const DEFAULT_RUNS_MODE = 'with'

export const AGENT_MODES = Object.freeze([
  Object.freeze({
    id: 'all',
    label: 'Every agent',
    detail: 'Everything every agent says appears here, including agents you add later.',
  }),
  Object.freeze({
    id: 'chosen',
    label: 'Only the ones I pick',
    detail: 'Only the agents ticked below appear here. An agent that turns up later stays out of the box until you tick it.',
  }),
])

/* `all` for the same reason: it is what the screen already did, it cannot be
 * empty, and on a computer with one agent or none there is nothing to be
 * drowned by. Narrowing is available the moment a person has enough agents to
 * want it, and the narrowed state says how many agents it is holding back. */
export const DEFAULT_AGENT_MODE = 'all'

const RUNS_KEY = 'mc.chat.runs'
const AGENTS_KEY = 'mc.chat.agents'

const RUNS_MODE_IDS = new Set(RUNS_MODES.map(mode => mode.id))

/* Not every voice in a conversation is an agent. The person is not one, and
 * neither is the quiet tool line that marks what actually ran -- filtering
 * either of them out would be filtering the person's own words out of their own
 * chat box. Both are reserved rather than guessed at by name shape. */
export const NOT_AGENTS = Object.freeze(['owner', 'me', 'act'])
const NOT_AGENT_CLASSES = Object.freeze(['is-owner', 'is-act'])

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const clean = value => (typeof value === 'string' ? value.trim() : '')

function announce(detail) {
  try {
    globalThis.window?.dispatchEvent?.(new CustomEvent(CHATBOX_FEED_EVENT, { detail: Object.freeze(detail) }))
  } catch { /* a page without an event target still has the stored value */ }
}

/* ---------------------------------------------------------------
   Whether agent runs appear.
   --------------------------------------------------------------- */

export function readRunsMode() {
  try {
    const stored = localStorage.getItem(RUNS_KEY)
    if (RUNS_MODE_IDS.has(stored)) return stored
  } catch { /* storage refused; the default is the honest answer */ }
  return DEFAULT_RUNS_MODE
}

export function setRunsMode(mode) {
  const next = RUNS_MODE_IDS.has(mode) ? mode : DEFAULT_RUNS_MODE
  if (next === DEFAULT_RUNS_MODE) localStorage.removeItem(RUNS_KEY)
  else localStorage.setItem(RUNS_KEY, next)
  announce({ runsMode: next })
  return next
}

export function runsMode(id) {
  return RUNS_MODES.find(mode => mode.id === id) || RUNS_MODES[0]
}

/* ---------------------------------------------------------------
   Which agents' context appears.
   --------------------------------------------------------------- */

/**
 * @returns {{mode: 'all'|'chosen', ids: readonly string[]}}
 *
 * Malformed choices resolve to `all`. An explicitly empty array means the
 * person selected no agents and must stay empty after a reload.
 */
export function readAgentSelection() {
  let raw = null
  try { raw = localStorage.getItem(AGENTS_KEY) } catch { return everyAgent() }
  if (raw === null) return everyAgent()
  let parsed
  try { parsed = JSON.parse(raw) } catch { return everyAgent() }
  if (!Array.isArray(parsed)) return everyAgent()
  const ids = normalizeIds(parsed)
  if (parsed.length && !ids.length) return everyAgent()
  return Object.freeze({ mode: 'chosen', ids: Object.freeze(ids) })
}

export function setAgentSelection(selection) {
  const next = normalizeSelection(selection)
  if (next.mode === 'all') localStorage.removeItem(AGENTS_KEY)
  else localStorage.setItem(AGENTS_KEY, JSON.stringify(next.ids))
  announce({ selection: next })
  return next
}

/** Tick or untick one agent, starting from the list currently on screen. */
export function toggleAgent(selection, id, present = []) {
  const current = normalizeSelection(selection)
  const agentId = clean(id)
  if (!agentId) return current
  /* Unticking one agent while the setting says "every agent" has to become an
     explicit list, and the list it becomes is everything ELSE that is here --
     otherwise the first untick would silently mean "only this one". */
  const base = current.mode === 'all' ? normalizeIds(present) : [...current.ids]
  const at = base.indexOf(agentId)
  if (at === -1) base.push(agentId)
  else base.splice(at, 1)
  return normalizeSelection({ mode: 'chosen', ids: base })
}

export function isAgentShown(selection, id) {
  const current = normalizeSelection(selection)
  if (current.mode === 'all') return true
  return current.ids.includes(clean(id))
}

function everyAgent() {
  return Object.freeze({ mode: 'all', ids: Object.freeze([]) })
}

function normalizeIds(list) {
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    const id = clean(entry)
    if (!id || id.length > 80 || out.includes(id)) continue
    if (NOT_AGENTS.includes(id)) continue
    out.push(id)
  }
  return out
}

export function normalizeSelection(selection) {
  if (!isRecord(selection)) return everyAgent()
  if (selection.mode !== 'chosen') return everyAgent()
  const ids = normalizeIds(selection.ids)
  return Object.freeze({ mode: 'chosen', ids: Object.freeze(ids) })
}

/* ---------------------------------------------------------------
   Finding out which agents there are.
   --------------------------------------------------------------- */

/**
 * Every agent this computer can currently name, from the sources the product
 * already has. Nothing here is a literal roster.
 *
 * @param sources.register  the agent register this build reads, if it answered
 * @param sources.turns     the conversation the box is showing, if any
 * @param sources.speakers  the cast of the labelled demonstration, when that is
 *                          what is on screen
 * @returns {{id: string, name: string, present: boolean}[]} sorted by name
 */
export function discoverAgents({ register = null, turns = [], speakers = null } = {}) {
  const found = new Map()
  const add = (id, name) => {
    const agentId = clean(id)
    if (!agentId || agentId.length > 80 || NOT_AGENTS.includes(agentId)) return
    const label = clean(name) || agentId
    if (!found.has(agentId)) found.set(agentId, { id: agentId, name: label, present: true })
    else if (found.get(agentId).name === agentId && label !== agentId) found.get(agentId).name = label
  }

  if (isRecord(register) && Array.isArray(register.agents)) {
    for (const agent of register.agents) {
      if (isRecord(agent)) add(agent.id, agent.displayName)
    }
  }
  if (isRecord(speakers)) {
    for (const [id, speaker] of Object.entries(speakers)) {
      if (!isRecord(speaker)) continue
      if (NOT_AGENT_CLASSES.includes(clean(speaker.cls))) continue
      if (!clean(speaker.label)) continue
      add(id, speaker.label)
    }
  }
  for (const id of agentIdsFromTurns(turns)) add(id, null)

  return Object.freeze([...found.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(Object.freeze))
}

/** The agents actually speaking in a set of turns. `who` or `sender`, either shape. */
export function agentIdsFromTurns(turns) {
  const out = []
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (!isRecord(turn)) continue
    const id = clean(turn.who) || clean(turn.sender)
    if (!id || id.length > 80 || NOT_AGENTS.includes(id) || out.includes(id)) continue
    out.push(id)
  }
  return Object.freeze(out)
}

/**
 * A selected agent that is no longer anywhere is still shown in the settings
 * list, ticked, and marked as not here now. Dropping it silently would change
 * what the person chose without telling them, and would make a temporarily
 * quiet agent permanently deselected.
 */
export function agentChoices(discovered, selection) {
  const current = normalizeSelection(selection)
  const rows = discovered.map(agent => Object.freeze({
    ...agent,
    chosen: current.mode === 'all' || current.ids.includes(agent.id),
  }))
  const known = new Set(discovered.map(agent => agent.id))
  const missing = current.mode === 'chosen'
    ? current.ids.filter(id => !known.has(id)).map(id => Object.freeze({ id, name: id, present: false, chosen: true }))
    : []
  return Object.freeze([...rows, ...missing])
}

/* ---------------------------------------------------------------
   The decision the two settings make together.
   --------------------------------------------------------------- */

/**
 * @param input.contextAvailable  is there a conversation on this screen at all
 * @param input.runsAvailable     is there a record of runs on this screen at all
 * @param input.runsMode          the three-state setting
 * @param input.selection         the agent selection
 * @param input.agentsInSource    the agents actually speaking, before filtering
 *
 * Returns only what is DECIDED, never what is rendered. `showContext` and
 * `showRuns` are the two halves of the box, and both can be false: a person who
 * hides the runs on a computer with no conversation has asked for an empty box,
 * and the screen says that rather than quietly putting something back.
 */
export function planChatbox({
  contextAvailable = false,
  runsAvailable = false,
  runsMode: mode = DEFAULT_RUNS_MODE,
  selection = null,
  agentsInSource = [],
} = {}) {
  const chosenMode = RUNS_MODE_IDS.has(mode) ? mode : DEFAULT_RUNS_MODE
  const current = normalizeSelection(selection)
  const speaking = normalizeIds(agentsInSource)
  const shown = speaking.filter(id => isAgentShown(current, id))
  /* Bound before the object rather than written into it twice: the gated pair
     below is derived from this, and a property of an object literal is not in
     scope inside that same literal. */
  const showContext = Boolean(contextAvailable) && chosenMode !== 'only'

  return Object.freeze({
    runsMode: chosenMode,
    selection: current,
    showContext,
    showRuns: Boolean(runsAvailable) && chosenMode !== 'hidden',
    agentsSpeaking: Object.freeze(speaking),
    agentsShown: Object.freeze(shown),

    /* ---- TWO PAIRS, AND THE PAIR IS THE POINT ----
     *
     * Each of these facts comes in a raw form and a gated form, because there
     * are genuinely two questions and one name was answering both badly.
     *
     * THE RAW ONES ARE ABOUT THE SELECTION, and they hold whether or not the
     * conversation is on screen. That is not an oversight to be tidied away: a
     * person sitting in "show only runs" who is about to turn the conversation
     * back on has a real interest in whether it would show them anything, and
     * only the ungated value can answer it. Gating them would delete the
     * primitive rather than fix anything.
     *
     * THE GATED ONES ARE ABOUT THIS BOX, RIGHT NOW, and they are what a
     * renderer almost always wants: say nothing about a filter over a half you
     * are not showing.
     *
     * THIS EXISTS BECAUSE THE OLD NAME UNDER-SPECIFIED AND BOTH CONSUMERS
     * TRIPPED ON IT, three times between them, always the same way: a fact
     * about the selection printed as a fact about the box. "None of the agents
     * talking are ones you picked" on a box deliberately showing no
     * conversation; "N agents are being kept out of this box" beside a list of
     * runs and nothing else. The values were never wrong. Reading them as
     * something they do not claim to be was, so the fix is a name that says
     * which of the two it is, not a value that quietly becomes the other one.
     * Proposed by the page 2 lane, whose argument for keeping the primitive was
     * better than my argument for gating it. */
    hiddenAgents: speaking.length - shown.length,
    /* Every agent in the conversation was filtered out. Distinct from "there is
       no conversation", and the screen must not report one as the other. */
    filteredToNothing: speaking.length > 0 && shown.length === 0,

    /* The same two facts, but only while this box is actually showing the
       conversation they are about. Reach for these when you are writing a
       sentence a person will read. */
    contextHiddenAgents: showContext ? speaking.length - shown.length : 0,
    contextFilteredToNothing: showContext && speaking.length > 0 && shown.length === 0,
  })
}

/** Keep only the turns a person asked to see. The person's own lines always stay. */
export function filterTurns(turns, selection) {
  const current = normalizeSelection(selection)
  return (Array.isArray(turns) ? turns : []).filter(turn => {
    if (!isRecord(turn)) return false
    const id = clean(turn.who) || clean(turn.sender)
    if (!id || NOT_AGENTS.includes(id)) return true
    return isAgentShown(current, id)
  })
}
