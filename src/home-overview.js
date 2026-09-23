/* THE HEAD IS THE HEAD AGAIN. It used to carry the clock in its middle track
   and the glance strip on the row underneath, because the owner asked on
   2026-09-15 for the timer "above actually in the header". On 2026-09-18 the
   owner asked for the timer BACK ABOVE THE CIRCLE and for the agents-working
   figures as a compact strip beside or under the circle. Both of those belong
   to the ring column, so both markup fragments moved out of here and are
   exported separately; views/home.js places them inside .home-ring-wrap, one
   above the ring and one below it.

   They are still fragments of THIS file rather than string literals in the
   view, because the figures and the strip's aria name are this module's
   contract with glanceFigures() below, and a caption the view owns would drift
   from the counts this module computes. */
export function homeOverviewMarkup() {
  return `<header class="home-overview-head">
    <div class="home-overview-title"><h1>Home</h1><p>Agents, conversations and voice.</p></div>
    <a class="home-workspace-link" href="#/computers">Open computers <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></a>
  </header>`
}

/* The uptime readout's own slot, directly above the circle. views/home.js moves
   uptimeRing's caption and digit nodes into it, so the clock keeps counting
   through the move — nothing about the count changes, only where it is. */
export function homeClockMarkup() {
  return `<div class="home-overview-clock" data-home-clock hidden></div>`
}

/* Counts use the panel's run records and status classification.
   Hide the strip until there is a record to count. */
export function homeGlanceMarkup() {
  return `<section class="home-glance" data-home-glance aria-label="At a glance" hidden>
    <div class="home-glance-strip">
      <div class="home-stat" data-glance-tile="agents"><div class="tl">Agents</div><div class="tv"><span class="tvn" data-glance="agents">0</span></div></div>
      <div class="home-stat" data-glance-tile="runs"><div class="tl">Runs recorded</div><div class="tv"><span class="tvn" data-glance="runs">0</span></div></div>
      <div class="home-stat" data-glance-tile="working"><div class="tl">Working</div><div class="tv"><span class="tvn" data-glance="working">0</span></div></div>
      <div class="home-stat" data-glance-tile="attention"><div class="tl">Need attention</div><div class="tv"><span class="tvn" data-glance="attention">0</span></div></div>
    </div>
  </section>`
}

// Runs recorded remains historical. Agent state uses the newest known run per
// canonical computer/agent; anonymous rows cannot invent an agent needing help.
export function glanceFigures(rows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
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
  const current = [...agents.values()]
  const working = current.filter(agent => agent.working).length
  const attention = current.filter(agent => !agent.working && agent.latest.status === 'attention').length
  return {
    figures: { agents: agents.size, runs: list.length, working, attention },
    states: { working: working > 0, attention: attention > 0 },
    shown: list.length > 0,
  }
}
