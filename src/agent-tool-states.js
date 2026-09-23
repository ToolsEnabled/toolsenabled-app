/* THREE STATES PER TOOL, AND THE ONE PLACE THAT DECIDES WHAT EACH ONE MEANS.
 *
 * The owner: "on the tool pop up every tool needs 3 states: enabled;
 * permissions required; disabled".
 *
 * WHY THE OLD SHAPE COULD NOT HOLD THREE. The row was `agent_tools_disabled`,
 * a JSON array of the names switched OFF, and ON was the ABSENCE of a name.
 * An array of off-names is a two-valued model by construction: there is no
 * third thing a name can be. So the row becomes a map from tool name to state,
 * and the array is migrated into it once, on the first read that finds one.
 *
 * ABSENCE STILL MEANS ENABLED, and that is a default rather than the old
 * limitation. A name the map does not mention is a tool nobody has decided
 * about -- including every tool a later build adds -- and the answer for those
 * has always been "on", which is what an installation that never opened this
 * page already has. The map can hold all three values for any name it does
 * mention, which is the part that was impossible before.
 *
 * NOTHING HERE TOUCHES A SCREEN OR A FILE. The renderer builds controls from
 * it, the shell composes a session's tool surface from it, and the suite drives
 * it with no browser. That split is why the migration can be proved: it is a
 * function over values, not a behaviour of a page.
 */

/* The owner's three words, in his order. The middle one is the whole point of
   the change: a tool that may be used, one approval at a time. */
export const TOOL_STATES = Object.freeze(['enabled', 'ask', 'disabled'])

export const TOOL_STATE_LABELS = Object.freeze({
  enabled: 'Enabled',
  ask: 'Permissions required',
  disabled: 'Disabled',
})

/* The account row this model is stored in, and the row it replaced. Both names
   are read: an installation that has been running for months has the old one
   and nothing else. */
export const TOOL_STATES_KEY = 'agent_tool_states'
export const TOOLS_DISABLED_KEY = 'agent_tools_disabled'

const STATE_SET = new Set(TOOL_STATES)

/* Fail closed, in the one direction that cannot cost anything: a row this
   process cannot make sense of means the person recorded limits that cannot be
   read, and a session must not start at a wider surface than they chose. The
   shell turns this into a refusal; the page turns it into a sentence. */
const UNREADABLE = 'AGENT_TOOL_LIMITS_UNREADABLE'

function failure(code) {
  return Object.freeze({ ok: false, code })
}

function readableName(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The states a stored pair of rows resolves to.
 *
 * @param stored  the `agent_tool_states` value, a JSON string or null.
 * @param legacy  the `agent_tools_disabled` value, a JSON string or null.
 *
 * Returns { ok: true, states, migrated } or { ok: false, code }. `states` is a
 * plain object naming only the tools that are NOT plainly enabled, because
 * that is the smallest row that says the same thing.
 *
 * THE ORDER IS DELIBERATE. The new row wins whenever it is present, so an
 * installation that has already been upgraded never re-reads the old array --
 * which would otherwise undo every choice made since the upgrade the first
 * time somebody set a tool back to enabled.
 */
export function parseToolStates(stored, legacy) {
  if (stored !== null && stored !== undefined) {
    if (typeof stored !== 'string') return failure(UNREADABLE)
    let parsed
    try { parsed = JSON.parse(stored) } catch { return failure(UNREADABLE) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failure(UNREADABLE)
    const map = parsed.states
    if (!map || typeof map !== 'object' || Array.isArray(map)) return failure(UNREADABLE)
    const states = {}
    for (const [name, state] of Object.entries(map)) {
      if (!readableName(name) || !STATE_SET.has(state)) return failure(UNREADABLE)
      if (state !== 'enabled') states[name] = state
    }
    return Object.freeze({ ok: true, states: Object.freeze(states), migrated: false })
  }
  if (legacy === null || legacy === undefined) {
    return Object.freeze({ ok: true, states: Object.freeze({}), migrated: false })
  }
  if (typeof legacy !== 'string') return failure(UNREADABLE)
  let names
  try { names = JSON.parse(legacy) } catch { return failure(UNREADABLE) }
  if (!Array.isArray(names) || names.some(name => !readableName(name))) return failure(UNREADABLE)
  /* THE MIGRATION, AND IT IS THE WHOLE OF IT. A name that was in the off-array
     is off; everything else is on. Nobody has ever been able to choose the
     middle state, so nothing can migrate into it. */
  const states = {}
  for (const name of names) states[name] = 'disabled'
  return Object.freeze({ ok: true, states: Object.freeze(states), migrated: true })
}

/** The state one tool is in. A name nobody has decided about is enabled. */
export function toolState(states, name) {
  const state = states && Object.prototype.hasOwnProperty.call(states, name) ? states[name] : 'enabled'
  return STATE_SET.has(state) ? state : 'enabled'
}

/** The same map with one name set, and names back at the default dropped. */
export function withToolState(states, name, state) {
  if (!readableName(name) || !STATE_SET.has(state)) return states
  const next = { ...states }
  if (state === 'enabled') delete next[name]
  else next[name] = state
  return Object.freeze(next)
}

/**
 * The row to store, or null when there is nothing left to say.
 *
 * Null removes the row, which is what an account with every tool at its default
 * should carry -- the same rule the off-array followed.
 */
export function serializeToolStates(states) {
  const entries = Object.entries(states || {}).filter(([name, state]) => readableName(name) && STATE_SET.has(state) && state !== 'enabled')
  if (entries.length === 0) return null
  entries.sort(([left], [right]) => left.localeCompare(right))
  const map = {}
  for (const [name, state] of entries) map[name] = state
  return JSON.stringify({ version: 1, states: map })
}

/**
 * What a session started now would actually be offered.
 *
 * @param tools   [{ name, allowed, gated }] as shell/agent-confinement-read.cjs
 *                reports it. `allowed` is the permission level's answer;
 *                `gated` is whether this program already asks before each use
 *                of that tool.
 * @param states  the map above.
 *
 * THE PERMISSION LEVEL IS THE CEILING AND THIS NEVER LIFTS IT. A tool the level
 * withholds is withheld here whatever the person chose, and it is reported by
 * name rather than dropped, because a surface that hides what it removed is the
 * defect this replaces.
 *
 * THE MIDDLE STATE SPLITS IN TWO, HONESTLY. This program can ask before a tool
 * runs only where its own approval step already covers that tool; where it
 * does not, "ask me first" cannot be delivered, and the safe reading of an
 * unanswerable question is no. So those are HELD BACK rather than handed over
 * ungated, and the page says which of the two each tool is.
 */
export function composeToolSurface(tools, states) {
  const allowed = []
  const asking = []
  const heldBack = []
  const off = []
  const withheld = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool && typeof tool.name === 'string' ? tool.name : null
    if (!name) continue
    if (tool.allowed !== true) { withheld.push(name); continue }
    const state = toolState(states, name)
    if (state === 'disabled') { off.push(name); continue }
    if (state === 'ask') {
      if (tool.gated === true) { asking.push(name); allowed.push(name) }
      else heldBack.push(name)
      continue
    }
    allowed.push(name)
  }
  return Object.freeze({
    allowed: Object.freeze(allowed),
    asking: Object.freeze(asking),
    heldBack: Object.freeze(heldBack),
    off: Object.freeze(off),
    withheld: Object.freeze(withheld),
  })
}
