'use strict'

/* THE SAME THREE-STATE MODEL AS src/agent-tool-states.js, ON THIS SIDE OF THE
 * MODULE BOUNDARY.
 *
 * MIRRORED RATHER THAN IMPORTED, for the same mechanical reason
 * src/session-transcript-store.js mirrors shell/renderer-prefs.cjs: the shell
 * is CommonJS and loads synchronously, the renderer half is an ES module that
 * the bundler owns, and `require()` cannot reach one from the other. Making the
 * enforcement hook asynchronous so it could `import()` would put an await in
 * front of every session start to save one file.
 *
 * DRIFT IS A RED TEST RATHER THAN A DISAGREEMENT NOBODY SEES.
 * tools/test/agent-tool-states.test.mjs loads BOTH modules and drives them over
 * one fixture table, so a change made here and not there fails before a session
 * is composed from one rule while a page is drawn from the other.
 *
 * The reasoning behind each rule is written once, in the renderer half. This
 * file carries the rule and points there.
 */

const TOOL_STATES = Object.freeze(['enabled', 'ask', 'disabled'])
const TOOL_STATES_KEY = 'agent_tool_states'
const TOOLS_DISABLED_KEY = 'agent_tools_disabled'

const STATE_SET = new Set(TOOL_STATES)
const UNREADABLE = 'AGENT_TOOL_LIMITS_UNREADABLE'

function failure(code) {
  return Object.freeze({ ok: false, code })
}

function readableName(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function parseToolStates(stored, legacy) {
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
  const states = {}
  for (const name of names) states[name] = 'disabled'
  return Object.freeze({ ok: true, states: Object.freeze(states), migrated: true })
}

function toolState(states, name) {
  const state = states && Object.prototype.hasOwnProperty.call(states, name) ? states[name] : 'enabled'
  return STATE_SET.has(state) ? state : 'enabled'
}

function composeToolSurface(tools, states) {
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

module.exports = {
  TOOL_STATES,
  TOOL_STATES_KEY,
  TOOLS_DISABLED_KEY,
  composeToolSurface,
  parseToolStates,
  toolState,
}
