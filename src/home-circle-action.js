/* WHAT THE FOLLOWED AGENT IS DOING, in one word the Home circle can act out.
 *
 * The Home page's run rows already know each session's live state (src/views/home.js
 * keeps a `live` record per session: the engine's activity events name thinking,
 * a tool call or result with the tool's name, an approval wait; text deltas are
 * the agent writing its reply; a turn status ends the turn). This file turns
 * that into the circle's vocabulary -- thinking, reading, writing, running,
 * waiting, idle -- plus a count of tool events (each one is a kick the fluid
 * acts out once), and chooses WHICH run the circle follows: the agent the
 * person picked in the panel's dropdown, or, under "All agents", the most
 * recent visible one, matching the top of the panel. Pure functions,
 * DOM-free, so a test can call them with values.
 */

export const AGENT_ACTIONS = Object.freeze(['thinking', 'reading', 'writing', 'running', 'waiting', 'idle'])

/* Tool names are free text from whichever engine is running (Read, Grep,
   Bash, apply_patch, write_file, str_replace_editor...). A change to the
   workspace is writing; looking at it is reading; anything else is running. */
const WRITING = /(write|edit|patch|creat|save|replac|append|insert|renam|move|delet|remov|commit|mkdir|touch)/i
const READING = /(read|grep|glob|search|find|list|\bls\b|\bcat\b|view|open|look|inspect|fetch|browse|web|dir\b|head|tail)/i

export function actionForTool(tool) {
  const name = String(tool || '').trim()
  if (!name) return 'running'
  if (WRITING.test(name)) return 'writing'
  if (READING.test(name)) return 'reading'
  return 'running'
}

/**
 * The action a live session record describes, or null when the record says
 * nothing about the present (no live stream at all).
 *   live.kind: 'thinking' | 'approval' | 'call' | 'result' | 'text' | null
 *   live.tool: the tool named by a call or result
 */
export function actionForLive(live) {
  if (!live) return null
  if (live.waiting) return 'waiting'
  if (live.ended) return 'idle'
  if (!live.working) return live.status == null ? null : 'idle'
  if (live.kind === 'thinking') return 'thinking'
  if (live.kind === 'call' || live.kind === 'result') return actionForTool(live.tool)
  if (live.kind === 'text') return 'writing'
  return 'running'
}

/* THE EXAMPLE'S TURN. The example fleet has no engine behind it, so its
   working run acts a scripted turn as its slot ages: it thinks, reads a few
   files (a tool call each), thinks again, edits, runs the checks, then writes
   its reply. Each phase is a real shape a turn has, and every tool call is
   numbered so the fluid can kick once per call the way it does for a real
   session. Only ever used under the example (the caller decides), and only
   for a run that is working; a finished example run is idle like any other. */
const SAMPLE_TURN = Object.freeze([
  { until: 0.16, action: 'thinking' },
  { until: 0.38, action: 'reading', tools: ['Read', 'Grep', 'Read', 'Glob'] },
  { until: 0.46, action: 'thinking' },
  { until: 0.66, action: 'writing', tools: ['Edit', 'Edit', 'Write'] },
  { until: 0.84, action: 'running', tools: ['Bash', 'Bash', 'Bash'] },
  { until: 1, action: 'writing', tools: [] },
])
export function sampleAction(run, nowMs, slotMs) {
  const startedMs = Number.isFinite(run?.atMs) ? run.atMs : Date.parse(run?.at || '')
  if (!Number.isFinite(startedMs) || !(slotMs > 0)) return { action: 'running', event: 0, tool: '' }
  const phase = ((nowMs - startedMs) % slotMs + slotMs) % slotMs / slotMs
  let from = 0, event = 0
  for (const step of SAMPLE_TURN) {
    const calls = step.tools ? step.tools.length : 0
    if (phase < step.until) {
      const within = (phase - from) / (step.until - from)
      const call = calls ? Math.min(calls - 1, Math.floor(within * calls)) : -1
      return { action: step.action, event: event + call + 1, tool: call >= 0 ? step.tools[call] : (step.action === 'writing' ? 'reply' : '') }
    }
    event += calls
    from = step.until
  }
  return { action: 'idle', event, tool: '' }
}

/** The words under the agent's name in the circle: what it is doing, and with what. */
export function actionLabel(action, tool = '') {
  const name = String(tool || '').trim()
  if (action === 'thinking') return 'thinking'
  if (action === 'reading') return name ? `reading with ${name}` : 'reading'
  if (action === 'writing') return name === 'reply' ? 'writing its reply' : name ? `writing with ${name}` : 'writing'
  if (action === 'running') return name ? `running ${name}` : 'running a tool'
  if (action === 'waiting') return 'waiting for you'
  return ''
}

/**
 * Which run the circle follows, from the rows the panel is showing.
 * `rows` are { key, agentKey, agentName, working, status, updatedAt } in the
 * panel's order (newest first). Follow the first visible record rather than
 * jumping to an older run just because it has a working flag.
 */
export function followedRow(rows, agentKey = '') {
  return rows.find(row => !agentKey || row.agentKey === agentKey) || null
}

/* ============================================================================
   WATCHING BY TREE (T401)

   Owner: "we should be able to see by tree right so we have all agents, we have
   each tree as a single option, then we have ALL TREES but this shows just the
   tip of the tree when its active so like controller or whatevers at the top.
   so then people can monitor just their top level agents more easily."

   Three kinds of entry, in his order: every agent, then one option per tree,
   then ALL TREES -- which is not "every tree's agents" but the TIP of each
   active tree, so the list is the few agents that lead each tree rather than a
   filtered version of everything. Individual agents keep their entries after
   those; picking one lane is a different question from watching a tree, and
   nothing here takes that away.

   THIS FILE STAYS DOM-FREE AND STORE-FREE. It is handed plain tree records and
   hands back a plain predicate; the view resolves the records out of the fleet
   tree store and the panel applies the predicate to its rows. Every function
   here can be called with values by a test, which is how they are checked.

   WHERE THE TREE FACTS COME FROM -- none of them are invented here:
     membership   node.treeId, from createFleetTreeStore(...).snapshot().nodes,
                  the same store src/tree-graph.js reads and views/home.js
                  already calls.
     the tip      store.rootOf(treeId): the node whose parentId is null.
     active       treeStatus(tree) === 'running', which is fleet-trees.js's own
                  word, built on the ['starting','running'] pair that
                  src/tree-session-liveness.js calls busy.
   ========================================================================= */

export const ALL_AGENTS_CHOICE = ''
export const TREE_TIPS_CHOICE = 'tips'
export const TREE_CHOICE_PREFIX = 'tree:'
export const treeChoiceId = treeId => `${TREE_CHOICE_PREFIX}${treeId}`

/* A run whose agent does not resolve to a tree node belongs to no tree -- runs
   started outside the fleet trees, and every run in the example fleet, which
   carries no trees at all. They are not hidden: they are simply not in any
   tree's membership, so only "All agents" shows them. Losing a run because
   nobody filed it under a tree would be the worse failure. */
const memberKeysOf = tree => new Set(Array.isArray(tree?.memberKeys) ? tree.memberKeys.filter(Boolean) : [])

/** Trees worth offering: one that has a name to show and at least one member. */
export function treeEntries(trees = []) {
  return (Array.isArray(trees) ? trees : [])
    .filter(tree => tree && tree.id && memberKeysOf(tree).size > 0)
    .map(tree => ({
      id: tree.id,
      label: tree.name || tree.id,
      active: Boolean(tree.active),
      tipKey: tree.tipKey || null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The dropdown's entries. Each carries a `kind` so the view can group them
 * without parsing the id back apart.
 *   kind 'all'   every run
 *   kind 'tree'  one per tree
 *   kind 'tips'  the tip of each ACTIVE tree
 *   kind 'agent' one per agent, ordered by name
 */
export function agentChoices(rows, trees = []) {
  const seen = new Map()
  for (const row of rows) if (row.agentKey && !seen.has(row.agentKey)) seen.set(row.agentKey, row.agentName || row.agentKey)
  const agents = [...seen].map(([id, label]) => ({ id, label, kind: 'agent' })).sort((a, b) => a.label.localeCompare(b.label))
  const entries = treeEntries(trees)
  const treeChoices = entries.map(tree => ({ id: treeChoiceId(tree.id), label: tree.label, kind: 'tree' }))
  /* ALL TREES IS OFFERED ONLY WHEN A TREE IS ACTIVE, because the owner's own
     sentence bounds it that way -- "this shows just the tip of the tree WHEN
     ITS ACTIVE". With nothing active it would select nothing every time, and an
     option that can only ever come back empty is a trap rather than a view. */
  const anyActiveTip = entries.some(tree => tree.active && tree.tipKey)
  return [
    { id: ALL_AGENTS_CHOICE, label: 'All agents', kind: 'all' },
    ...treeChoices,
    ...(anyActiveTip ? [{ id: TREE_TIPS_CHOICE, label: 'All trees', kind: 'tips' }] : []),
    ...agents,
  ]
}

/**
 * THE SEAM. This returns a plain predicate over rows; the panel applies it to
 * whatever its row source is. Nothing here knows how a row is rendered and
 * nothing that renders a row needs to know how a tree is resolved.
 *
 * An id that names a tree which no longer exists falls back to showing
 * everything rather than showing nothing: a stale selection must not empty the
 * panel with no way back.
 */
export function agentFilterFor(choiceId, trees = []) {
  const id = typeof choiceId === 'string' ? choiceId : ''
  if (!id) return () => true
  const entries = treeEntries(trees)
  if (id === TREE_TIPS_CHOICE) {
    const tips = new Set(entries.filter(tree => tree.active && tree.tipKey).map(tree => tree.tipKey))
    if (tips.size === 0) return () => true
    return row => tips.has(row?.agentKey)
  }
  if (id.startsWith(TREE_CHOICE_PREFIX)) {
    const treeId = id.slice(TREE_CHOICE_PREFIX.length)
    const tree = (Array.isArray(trees) ? trees : []).find(entry => entry?.id === treeId)
    const members = memberKeysOf(tree)
    if (members.size === 0) return () => true
    return row => members.has(row?.agentKey)
  }
  return row => row?.agentKey === id
}

/** Which run the circle follows under a choice, tree ids included. */
export function followedRowFor(rows, choiceId, trees = []) {
  const keep = agentFilterFor(choiceId, trees)
  return (Array.isArray(rows) ? rows : []).find(row => keep(row)) || null
}
