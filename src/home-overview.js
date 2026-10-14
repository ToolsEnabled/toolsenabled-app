// The strip uses the existing recorded-run and observed-work figures.
export function homeOverviewMarkup() {
  return `<header class="home-overview-head">
    <div class="home-overview-title"><h1>Home</h1><p>What your agents are doing, and what needs you.</p></div>
    <div class="home-overview-actions"><a class="home-workspace-link" href="#/computers">Open computers</a><button type="button" class="home-new-agent" data-home-new-agent>New agent</button></div>
  </header>`
}

export function homeGlanceMarkup() {
  return `<section class="home-glance" data-home-glance aria-label="Recorded activity at a glance" hidden>
    <p class="home-glance-scope">Recorded runs and observed work. Saved tree agents are listed below.</p>
    <div class="home-glance-strip">
      <button type="button" class="home-stat" data-glance-tile="working" data-glance-filter="working"><span class="tl">Working now</span><span class="tv"><span class="tvn" data-glance="working">0</span></span></button>
      <button type="button" class="home-stat" data-glance-tile="attention" data-glance-filter="attention"><span class="tl">Need you</span><span class="tv"><span class="tvn" data-glance="attention">0</span></span></button>
      <div class="home-stat home-ledger-tile" data-glance-tile="ledger"><span class="tl">Ledger</span><span data-glance-ledger></span></div>
      <div class="home-stat" data-glance-tile="runs"><span class="tl">Runs recorded</span><span class="tv"><span class="tvn" data-glance="runs">0</span></span></div>
    </div>
  </section>`
}

// Runs recorded remains historical. Agent state uses the newest known run per
// canonical computer/agent; anonymous rows cannot invent an agent needing help.
/* A tree can know that a member is starting/running before the first
   session record is written. Those members are current agents, not runs:
   keeping them as a second input lets the strip count them without inflating
   "Runs recorded" or manufacturing a history row. */
export function glanceLiveTreeRows(records = []) {
  const rows = []
  for (const record of Array.isArray(records) ? records : []) {
    const computerId = typeof record?.computerId === 'string' && record.computerId ? record.computerId : null
    for (const agentKey of Array.isArray(record?.liveKeys) ? record.liveKeys : []) {
      if (typeof agentKey !== 'string' || !agentKey) continue
      rows.push({ agentKey, computerId, status: 'working' })
    }
  }
  return rows
}

export function glanceFigures(rows = [], liveRows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  const live = Array.isArray(liveRows) ? liveRows.filter(Boolean) : []
  const agents = new Map()
  for (const row of list) {
    if (typeof row.agentKey !== 'string' || !row.agentKey) continue
    const key = JSON.stringify([typeof row.computerId === 'string' ? row.computerId : null, row.agentKey])
    const held = agents.get(key)
    if (!held) { agents.set(key, { latest: row, working: row.status === 'working' }); continue }
    // The caller supplies newest-first rows. Explicit times also keep unordered
    // inputs honest; ties and unknown times retain that authoritative order.
    if (Number.isFinite(row.atMs) && Number.isFinite(held.latest.atMs) && row.atMs > held.latest.atMs) held.latest = row
    held.working ||= row.status === 'working'
  }
  for (const row of live) {
    if (typeof row.agentKey !== 'string' || !row.agentKey) continue
    const key = JSON.stringify([typeof row.computerId === 'string' ? row.computerId : null, row.agentKey])
    const held = agents.get(key)
    if (!held) { agents.set(key, { latest: row, working: true }); continue }
    // A current tree member supersedes a historical row, including a
    // refusal or attention result; the board uses the same precedence.
    held.working = true
  }
  const current = [...agents.values()]
  const working = current.filter(agent => agent.working).length
  const attention = current.filter(agent => !agent.working && agent.latest.status === 'attention').length
  return {
    figures: { agents: agents.size, runs: list.length, working, attention },
    states: { working: working > 0, attention: attention > 0 },
    shown: list.length > 0 || live.length > 0,
  }
}
