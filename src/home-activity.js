import { sessionTurnSucceeded } from './agent-session-events.js'

const text = value => typeof value === 'string' ? value.trim() : ''
const sourceText = value => text(value) ? value : ''

/* ONE MARK PER KIND, AND FOUR KINDS. The glyph answers "does this want me?" and
   the word answers "what is it?". They used to answer the same question in six
   different alphabets -- ! ■ Ⅱ ↳ ◷ ○ across labels that mixed registers
   ("Finished", "No outcome yet", "Last seen running") -- so a column of rows
   could not be read down. A reader learns four shapes once. */
export const ACTIVITY_MARKS = Object.freeze({ working: '●', attention: '▲', finished: '✓', other: '○' })
const state = (kind, label) => ({ kind, label, mark: ACTIVITY_MARKS[kind] })

/* AND ONE WORD PER STATE, in one register: what the run is, never a sentence
   about it. "Turn complete" and "Finished" were the same state under two
   names; "No outcome yet" described the record rather than the run. */
export const ACTIVITY_LABELS = Object.freeze({
  approval: 'Needs approval', ended: 'Session ended', working: 'Working', finished: 'Finished',
  interrupted: 'Interrupted', refused: 'Did not start', failed: 'Failed', stopped: 'Turn ended',
  paused: 'Paused', attention: 'Needs attention', replied: 'Replied', running: 'Running',
  starting: 'Starting', started: 'Started', unrecorded: 'Not recorded',
})

// A saved start is history, not a heartbeat. Only the observed stream earns
// Working; a saved node can still tell us how its last work ended.
export function activityStatus(run, saved, live) {
  if (live?.waiting) return state('attention', ACTIVITY_LABELS.approval)
  if (live?.ended) return state('attention', ACTIVITY_LABELS.ended)
  if (live?.working) return state('working', ACTIVITY_LABELS.working)
  if (live?.status) return sessionTurnSucceeded(live.status)
    ? state('finished', ACTIVITY_LABELS.finished)
    : state('attention', ACTIVITY_LABELS.interrupted)
  if (run?.result === 'refused') return state('attention', ACTIVITY_LABELS.refused)
  if (saved?.status === 'failed') return state('attention', ACTIVITY_LABELS.failed)
  if (saved?.status === 'cancelled') return state('attention', ACTIVITY_LABELS.stopped)
  if (['waiting', 'blocked', 'paused'].includes(saved?.status)) {
    return state('attention', saved.status === 'paused' ? ACTIVITY_LABELS.paused : ACTIVITY_LABELS.attention)
  }
  if (saved?.status === 'finished') return state('finished', ACTIVITY_LABELS.finished)
  if (text(saved?.reply) || text(saved?.said)) return state('other', ACTIVITY_LABELS.replied)
  if (saved?.status === 'running') return state('other', ACTIVITY_LABELS.running)
  if (saved?.status === 'starting') return state('other', ACTIVITY_LABELS.starting)
  return state('other', run?.result === 'started' ? ACTIVITY_LABELS.started : ACTIVITY_LABELS.unrecorded)
}

export function activityContext(run, saved, live, described) {
  const status = activityStatus(run, saved, live)
  const answer = sourceText(live?.text) || sourceText(saved?.reply) || sourceText(saved?.said)
  const asked = sourceText(saved?.asked) || described.asked
  const detail = described.why || (status.kind === 'attention' ? text(live?.detail) || text(saved?.statusNote) : '')
  const preview = (detail || text(live?.activity) || answer || described.gap).replace(/\s+/g, ' ').trim()
  return {
    status, answer, asked, detail, preview, previewIsAnswer: Boolean(answer && !detail && !live?.activity),
    // The revision tracks content as well as status. Token deltas update a
    // closed row's badge without rebuilding its DOM or overriding its owner.
    revision: JSON.stringify([status.kind, status.label, live?.turnId, answer, detail, live?.activity, saved?.turns?.map(line => [line.who, line.text])]),
  }
}

export function activityPreview(context, renderedAnswer) {
  const value = (context.previewIsAnswer ? renderedAnswer : context.preview).replace(/\s+/g, ' ').trim()
  return value.length > 240 ? `${value.slice(0, 239).trimEnd()}…` : value
}

export function activityDisclosure({ previous = null, context, open, manual = false, auto = true, unread = false }) {
  const changed = previous !== null && previous !== context.revision
  const reveal = auto && !manual && (changed || context.status.kind === 'working')
  return {
    changed,
    open: open || reveal,
    unread: (unread || changed) && !(open || reveal),
    revision: context.revision,
  }
}

export const ACTIVITY_FILTERS = Object.freeze([
  { id: 'all', label: 'All runs' },
  { id: 'working', label: 'Working' },
  { id: 'attention', label: 'Attention' },
  { id: 'updated', label: 'Updated' },
  { id: 'finished', label: 'Finished' },
])

export function activityMatches(filter, kind, unread) {
  return filter === 'all' || (filter === 'updated' ? unread : filter === kind)
}

/* ============================================================================
   THE PICKER LISTS TREES, AND THE AGENTS UNDER EACH.

   Owner, 2026-09-19: "the top button instead of listing every agent or all
   agents, it should just list trees or all trees, then, from the drop down you
   can select the agent to chat right there from the list immediately. Much
   smoother process."

   So the menu is: the whole view ("All trees"), then one group per tree --
   headed by the tree's name with how many agents it has and how many are
   working, holding the tree itself as an entry that scopes the panel to its
   agents, and under it each agent, the tip first -- then, last, the agents
   that belong to no tree. The counts ride on the group's heading and not on
   the tree's own entry, because the entry's words are what the closed control
   shows, and a native select clips a label it cannot fit: "Control lane · 3
   agents, 1 working" pushed the panel's title onto two lines at 1440x900. "All agents"
   is gone; the whole view is "All trees" and every agent is reachable under
   the tree it sits in. Picking an agent is the view's business (it opens the
   chat); this file only decides what the list holds.

   DOM-free, called with values. Rows are what the panel holds ({ agentKey,
   agentName, working }); trees are the records the view resolves from the
   fleet tree store ({ id, name, tipKey, memberKeys, memberNames?, liveKeys? }).
   ========================================================================= */
import { TREE_CHOICE_PREFIX } from './home-circle-action.js'
import { NODE_STATUS_WORDS } from './fleet-tree-copy.js'

export const TREE_PICK = Object.freeze({
  allTrees: 'All trees',
  loose: 'Not in a tree',
  agents: 'Agents',
  label: 'Which tree or agent this panel shows',
  treeLabel: (name, agents, working) => `${name} · ${agents} ${agents === 1 ? 'agent' : 'agents'}${working ? `, ${working} working` : ''}`,
  agentLabel: (name, working) => working ? `${name} · working` : name,
})

const byName = (a, b) => String(a.name).localeCompare(String(b.name))

export function treePickGroups(rows, trees = []) {
  const seen = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.agentKey) continue
    const entry = seen.get(row.agentKey) || { name: row.agentName || row.agentKey, working: false }
    if (row.working) entry.working = true
    seen.set(row.agentKey, entry)
  }
  const placed = new Set()
  const groups = []
  const records = (Array.isArray(trees) ? trees : [])
    .filter(tree => tree && tree.id && Array.isArray(tree.memberKeys) && tree.memberKeys.some(Boolean))
    .map(tree => ({ tree, name: tree.name || tree.id }))
    .sort(byName)
  for (const { tree, name } of records) {
    const live = new Set(Array.isArray(tree.liveKeys) ? tree.liveKeys : [])
    const names = tree.memberNames && typeof tree.memberNames === 'object' ? tree.memberNames : {}
    const agents = [...new Set(tree.memberKeys.filter(Boolean))].map(key => {
      const known = seen.get(key)
      const saved = tree.memberSaved && typeof tree.memberSaved === 'object' ? tree.memberSaved[key] : null
      return { kind: 'agent', id: key, name: known?.name || names[key] || key, working: Boolean(known?.working) || live.has(key), tip: key === tree.tipKey,
        ...(saved && typeof saved === 'object' ? { saved } : {}) }
    }).sort((a, b) => Number(b.tip) - Number(a.tip) || byName(a, b))
    for (const agent of agents) { agent.label = TREE_PICK.agentLabel(agent.name, agent.working); placed.add(agent.id) }
    const working = agents.filter(agent => agent.working).length
    groups.push({ kind: 'tree', id: `${TREE_CHOICE_PREFIX}${tree.id}`, name, active: Boolean(tree.active), label: name, heading: TREE_PICK.treeLabel(name, agents.length, working), agents, working })
  }
  const loose = [...seen]
    .filter(([key]) => !placed.has(key))
    .map(([key, entry]) => ({ kind: 'agent', id: key, name: entry.name, working: entry.working, tip: false, label: TREE_PICK.agentLabel(entry.name, entry.working) }))
    .sort(byName)
  if (loose.length) {
    const label = records.length ? TREE_PICK.loose : TREE_PICK.agents
    groups.push({ kind: 'loose', id: null, name: label, label, heading: label, active: false, agents: loose, working: loose.filter(agent => agent.working).length })
  }
  return [{ kind: 'all', id: '', label: TREE_PICK.allTrees }, ...groups]
}

/** Every selectable entry, flat, in menu order -- what a remembered choice is checked against. */
export function treePickChoices(groups) {
  const flat = []
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group.kind === 'all' || group.kind === 'tree') flat.push({ id: group.id, label: group.label, kind: group.kind, heading: group.heading || '' })
    for (const agent of group.agents || []) flat.push({ id: agent.id, label: agent.label, kind: 'agent' })
  }
  return flat
}

/* ============================================================================
   AGENTS AT A GLANCE.

   Owner, 2026-09-19: "the contents inside need to have more useful, easy, on
   demand info." For the panel's scope, one line per agent: what it is doing
   right now and since when, or its last result and when; what is waiting on
   the owner, with the reason; and, on demand, what it was asked, what it said
   back, and how many runs it has here. Nothing here is fetched: the rows are
   read off the run rows the panel has already painted, so the board and the
   list can never disagree about an agent.

   DOM-free, called with values. `rows` are newest first ({ agentKey,
   agentName, working, status, statusLabel, doing, when, atMs, brief, asked,
   answer, why, gap }); `groups` are the picker's (treePickGroups), so the
   board reads in the same order as the menu above it; `keep` is the panel's
   own scope predicate over { agentKey }.
   ========================================================================= */
import { whenWords } from './local-activity.js'

/* THE ROSTER'S COLUMN HEADS AND DETAIL LABELS. Plain words. */
export const ROSTER = Object.freeze({
  agent: 'Agent', status: 'Status', doing: 'What it is doing', since: 'Since', actions: 'Actions', close: 'Close details',
  task: 'Task', asked: 'Asked', result: 'Last result', waiting: 'Waiting on you', now: 'Now', earlier: 'Earlier runs',
  open: 'Open details',
  /* THE FACTS LINE under what an agent is doing (owner, 2026-09-20: 'add
     back in the extra info'): the live tool and steps while it runs, else
     what it is waiting on you for, else how the last run ended; then what
     it asked. One line, the rest of it in the title. */
  facts: ({ detail, waiting, result, asked }) => [detail, waiting || result, asked ? `asked: ${asked}` : ''].filter(Boolean).join(' · '),
})

export const AGENT_BOARD = Object.freeze({
  label: 'Agents at a glance',
  heading: 'Agents',
  summary: (working, attention) => [
    working ? `${working} working` : '',
    attention ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention` : '',
  ].filter(Boolean).join(' · ') || 'nothing working',
  /* THE STRIP over the board: how many agents are in view and what they need. */
  strip: (agents, working, attention) => [
    `${agents} ${agents === 1 ? 'agent' : 'agents'}`,
    working ? `${working} working` : '',
    attention ? `${attention} ${attention === 1 ? 'needs' : 'need'} you` : '',
  ].filter(Boolean).join(' · '),
  runsButton: 'Runs',
  emptyTree: 'No agents in this tree yet.',
  chat: 'Chat',
  chatWith: name => `Open a chat with ${name} here`,
  showRuns: 'Show its runs',
  showRunsOf: name => `Show only the runs of ${name}`,
  runsCount: n => `${n} ${n === 1 ? 'run' : 'runs'} in this view`,
  working: doing => doing ? `Working · ${doing}` : 'Working',
  since: when => when || '', // the status pill already says Working; the column is just the time
  last: (label, brief) => brief ? `${label} · ${brief}` : label,
  waiting: (label, why, count) => `${label}${why ? ` — ${why}` : ''}${count > 1 ? ` · ${count} runs` : ''}`, // the row is labelled 'Waiting on you' by the panel
  noRuns: 'No runs yet',
  idle: 'Idle',
  foldAbove: 8, // a fleet this small is shown whole; the fold is for the long list
  /* The fold that holds the agents with nothing going on: "3 finished" when
     every one of them finished, "3 finished or idle" when some never
     recorded an outcome. */
  rest: (count, allFinished) => `${count} ${allFinished ? 'finished' : 'finished or idle'}`,
  restOf: names => names.join(', '),
  /* ON DEMAND, under the fold: what the live run is doing right now (tool,
     steps, since when), or how the last one ended; then its recent runs. */
  detail: (tool, events, clock) => [tool ? `using ${tool}` : '', events ? `${events} ${events === 1 ? 'step' : 'steps'}` : '', clock ? `since ${clock}` : ''].filter(Boolean).join(' · '),
  /* ONE WORD OF STATE on the row (owner, 2026-09-19 late: the rows were
     "messy, hard to follow" -- a state and a whole task sentence on one line).
     The sentence lives under the fold as Task. */
  stateWord: (state, label) => state === 'working' ? 'Working' : state === 'attention' ? 'Needs you' : state === 'finished' ? 'Finished' : (label || 'Idle'),
  historyHeading: 'Earlier runs',
  historyLine: (when, label, words) => [when, label, words].filter(Boolean).join(' · '),
})

/* WITH NO RUN RECORD, THE TREE'S OWN SAVED STATUS (T1375). With activity
   auditing off -- the default -- there are no run records, and every saved
   agent read "Idle" here while Computers drew the same circles as finished,
   stopped by you and not started yet. The tree's saved status is the same fact
   Computers shows, in the same words (NODE_STATUS_WORDS), sorted into the
   filter's buckets the way a run with that ending would be: a failed turn or
   a start that did not happen needs the person; a stop they made, an ended
   turn and a draft are idle. A saved "running" with no live session says
   nothing it cannot know and stays Idle. */
const SAVED_BOARD_STATE = Object.freeze({
  finished: 'finished', 'turn-failed': 'attention', failed: 'attention',
  interrupted: 'idle', cancelled: 'idle', draft: 'idle',
})
const sentenceCase = words => words ? words[0].toUpperCase() + words.slice(1) : ''
export function savedBoardState(saved) {
  if (!saved || typeof saved !== 'object' || !Object.hasOwn(SAVED_BOARD_STATE, saved.status)) return null
  return {
    state: SAVED_BOARD_STATE[saved.status],
    label: sentenceCase(NODE_STATUS_WORDS[saved.status] || ''),
    brief: clip(saved.message),
    result: clip(saved.status === 'turn-failed' || saved.status === 'failed' ? (saved.note || saved.reply) : (saved.reply || saved.note)),
  }
}

/* Under the fold nothing is said twice: the ask is dropped when it is the
   head line's own words (the brief), and a refusal's reason is dropped from
   the waiting row when it is already the last result. */
const askedOf = latest => {
  const text = (latest?.asked || '').replace(/^Asked:\s*/, '')
  return text && text !== (latest?.brief || '') ? text : ''
}
const resultOf = latest => latest ? clip(latest.answer) || latest.why || latest.gap || '' : ''

const clockOf = ms => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

const clip = (value, limit = 240) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

/* WHAT IS ALWAYS ON THE GLASS AND WHAT IS ONE PRESS AWAY. Measured on the
   example at 1440x900: nine agents in three groups made a 580px board in a
   670px panel and the run list started below the fold. So a group shows the
   agents that are WORKING or NEED ATTENTION as lines, and folds the rest --
   finished, idle -- into one line naming them (`rest`), because those are the
   ones a glance is not for. `showAll` puts every agent on the glass, for the
   scope where there is only one. */
/* The round monogram on an agent's line: the first letters of its name's
   first two words, letters and digits only. A name the store made unique,
   'Agent (f885ad47)', gives 'AF', never the '(' of its suffix (T1514). */
export function agentMonogram(name) {
  const words = String(name || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase()
  return words.length ? words[0].slice(0, 2).toUpperCase() : '?'
}

export function agentBoardLines(rows, groups, { nowMs = Date.now(), keep = () => true, showAll = false, foldAbove = AGENT_BOARD.foldAbove } = {}) {
  const byKey = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.agentKey) continue
    if (!byKey.has(row.agentKey)) byKey.set(row.agentKey, [])
    byKey.get(row.agentKey).push(row)
  }
  /* THE WHOLE TREE. Owner, 2026-09-19: "you're supposed to be able to select
     trees so the whole tree is what's shown under the overview, not just one
     agent." A chosen tree (showAll) puts every member on the glass, including
     one that has no run yet; so does a small fleet, where folding three
     finished agents under "3 finished" hid more than it saved. */
  const kept = new Set()
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group.kind === 'all') continue
    for (const agent of group.agents || []) if (keep({ agentKey: agent.id })) kept.add(agent.id)
  }
  const whole = showAll || kept.size <= foldAbove
  let working = 0, attention = 0
  const out = []
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group.kind === 'all') continue
    const lines = []
    for (const agent of group.agents || []) {
      if (!keep({ agentKey: agent.id })) continue
      const mine = byKey.get(agent.id) || []
      const live = mine.find(row => row.working) || null
      const wants = mine.filter(row => row.status === 'attention')
      const latest = mine[0] || null
      if (!latest && !agent.working && !whole) continue
      const saved = !latest && !live && !agent.working ? savedBoardState(agent.saved) : null
      const state = live || agent.working ? 'working' : latest ? latest.status : saved ? saved.state : 'idle'
      if (state === 'working') working += 1
      if (state === 'attention') attention += 1
      const asks = wants[0] || null
      lines.push({
        quiet: !whole && state !== 'working' && state !== 'attention',
        key: agent.id,
        name: agent.name,
        state,
        now: state === 'working' ? AGENT_BOARD.working(live?.doing || '') : latest ? AGENT_BOARD.last(latest.statusLabel, latest.brief)
          : saved ? AGENT_BOARD.last(saved.label, saved.brief) : AGENT_BOARD.noRuns,
        since: live ? AGENT_BOARD.since(whenWords(nowMs - live.atMs)) : latest ? latest.when || '' : '',
        /* Under the fold: the live run's tool, steps and start (only while it
           runs -- a finished run's time is already on the head line). */
        detail: live ? AGENT_BOARD.detail(live.tool, live.events, '') : '', // tool and steps; the start is already said by `since`
        asked: askedOf(latest), // the row carries its own label; empty when the head line already says it
        result: latest ? resultOf(latest) : saved ? saved.result : '',
        waiting: state === 'attention' && asks ? AGENT_BOARD.waiting(asks.statusLabel, asks.why === resultOf(latest) ? '' : clip(asks.why, 140), wants.length) : '', // only while the agent still needs you; a later finished run has answered it
        /* The runs BEFORE the latest one: the latest is the head line. */
        history: mine.slice(1, 5).map(row => AGENT_BOARD.historyLine(row.when, row.statusLabel, clip(row.doing || row.brief, 90))),
        runs: mine.length,
        word: AGENT_BOARD.stateWord(state, latest ? latest.statusLabel : saved?.label),
        task: clip(state === 'working' ? (live?.doing || latest?.brief || '') : (latest?.brief || latest?.doing || saved?.brief || ''), 160),
      })
    }
    if (!lines.length) continue
    const rest = lines.filter(line => line.quiet)
    out.push({
      kind: group.kind,
      key: group.id || group.label,
      heading: group.heading || group.label,
      name: group.name || group.label,
      count: lines.length,
      lines: lines.filter(line => !line.quiet),
      rest,
      restLabel: rest.length ? AGENT_BOARD.rest(rest.length, rest.every(line => line.state === 'finished')) : '',
      restNames: rest.length ? AGENT_BOARD.restOf(rest.map(line => line.name)) : '',
    })
  }
  return { groups: out, working, attention, agents: out.reduce((n, group) => n + group.lines.length + group.rest.length, 0) }
}
