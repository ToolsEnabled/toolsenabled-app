import { readSessionRoles, roleForSessionTarget } from './session-roles.js'

const pointer = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 3 14 9-7 1-3 7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>'

// Both surfaces read the same live host. Editing a selection never grants access.
export function createScreenAccessControls({ sample = false, getComputerId = () => null, onChange = () => {} } = {}) {
  const el = document.createElement('section')
  el.className = 'screen-access-controls'
  el.setAttribute('aria-label', 'Computer control')
  el.innerHTML = `<header class="screen-access-heading"><span class="screen-access-icon">${pointer}</span><div><h3>Computer control</h3><p>One agent at a time. You stay in control.</p></div><span data-control-badge class="screen-access-badge">Off</span></header>
    <fieldset class="screen-access-modes"><legend>Who can take control?</legend>
      <label><input type="radio" name="screen-access-mode" value="any-running"><span><strong>All running agents</strong><small>Allow any eligible agent running in this window now.</small></span></label>
      <label><input type="radio" name="screen-access-mode" value="selected" checked><span><strong>Only selected agents</strong><small>Choose who may use the mouse, keyboard and screen.</small></span></label>
    </fieldset>
    <div data-control-selection><label class="screen-access-search">Find an agent<input type="search" data-control-search placeholder="Search agents" autocomplete="off"></label><div data-control-agents class="agent-control-agents"></div></div>
    <p data-control-roster class="agent-control-hint"></p><div data-control-holder class="screen-access-holder" hidden></div>
    <div class="agent-control-buttons"><button type="button" data-control-grant class="screen-access-enable">Enable computer control</button><button type="button" data-control-revoke>Stop selected</button><button type="button" data-control-stop>Stop all</button></div>
    <p data-control-status role="status" aria-live="polite"></p>
    <p class="agent-control-hint">Access is temporary and takes effect here immediately. Agents release control when finished; an idle turn ends after one minute. <span data-control-stopchord>The <strong>Stop all</strong> button stops all access.</span></p>`
  const get = name => el.querySelector('[data-control-' + name + ']')
  const radios = [...el.querySelectorAll('input[type="radio"]')]
  const groupName = 'screen-access-' + globalThis.crypto.randomUUID()
  radios.forEach(radio => { radio.name = groupName })
  const api = !sample && window.mcScreenControl
  /* WHAT THE ORG RECORD CALLS EACH DECLARED AGENT, which is the only place a
     SOLO agent's name exists. roleForSessionTarget() resolves a row's name
     through session-roles.js, and that reads one source: the fleet-trees
     store. A standalone agent is deliberately absent from it -- the pop-up
     promises exactly that, "This agent won't appear on the tree" -- so the
     lookup can never hit and the label fell through to the agent id. Measured
     on a built candidate: the row read
     standalone-3f9f14df-89d3-4144-8136-f23fc616367f, while the org record held
     "Agent 1" the whole time. This list is a list of DECLARED agents, and the
     org record is the authority on what a declared agent is called. */
  let seatNames = new Map()
  let state = null, targets = [], rows = [], mode = 'selected', dirty = false, busy = false,
    destroyed = false, timer = null, refreshing = null, rowKey = '', notice = '', requestVersion = 0, stateVersion = 0
  const selected = new Set()
  const visibleRows = () => rows.filter(row => !getComputerId() || row.computerId === getComputerId())
  // The chord shown here is the one the host actually ARMED, carried in the
  // status payload as key caps already mapped by the shell. This paragraph used
  // to hard-code "Ctrl + Alt + Esc" on every platform while Windows arms
  // Control+Alt+Shift+Escape, so the grant screen taught a chord this build
  // never armed and Windows reserves -- the documented way to stop an agent
  // holding the mouse, keyboard and screen did nothing. It read correctly on
  // Linux, which is why it survived review.
  //
  // No per-platform conditional here on purpose: a second copy of the rule is
  // how that defect was born. When nothing is armed we name the Stop all
  // button rather than a chord, because naming a chord that does nothing is the
  // failure being fixed.
  function renderStopChord(keys) {
    const slot = get('stopchord')
    if (!slot) return
    const cap = text => Object.assign(document.createElement('kbd'), { textContent: String(text) })
    if (!Array.isArray(keys) || !keys.length) {
      slot.replaceChildren('The ', Object.assign(document.createElement('strong'), { textContent: 'Stop all' }), ' button stops all access.')
      return
    }
    const parts = []
    keys.forEach((key, index) => {
      if (index) parts.push(' + ')
      parts.push(cap(key))
    })
    parts.push(' stops all access.')
    slot.replaceChildren(...parts)
  }
  function accept(current) {
    state = current; stateVersion += 1
    renderStopChord(state?.stopShortcutKeys)
    const roles = readSessionRoles(), bySession = new Map(targets.map(row => [row.sessionId, row]))
    const candidates = state?.agents ? [...state.agents, ...targets.filter(row => !state.agents.some(agent => agent.sessionId === row.sessionId))
      .map(row => ({ ...row, eligible: false, reason: 'Screen control requires a running agent in this local window.' }))]
      : targets.map(row => ({ ...row, eligible: true }))
    rows = candidates.map(candidate => {
      const target = { ...bySession.get(candidate.sessionId), ...candidate }, role = roleForSessionTarget(target, roles)
      return { ...target, nodeId: role?.nodeId || target.agentId, computerId: role?.computerId || null,
        /* A tree agent's own name still wins, so no existing row changes. The
           declared seat only fills the gap the tree store cannot. */
        label: role?.displayName || seatNames.get(target.agentId) || target.agentId || target.sessionId }
    })
    for (const id of selected) if (!visibleRows().some(row => row.sessionId === id && row.eligible)) selected.delete(id)
    if (!dirty) {
      mode = state?.mode || 'selected'; selected.clear()
      for (const grant of state?.grants || []) selected.add(grant.sessionId)
    }
    paint()
  }
  function buttons() {
    const eligible = visibleRows().filter(row => row.eligible), chosen = eligible.filter(row => selected.has(row.sessionId))
    get('grant').disabled = !api || !state?.supported || state.permissionLevel !== 'unrestricted'
      || busy || Boolean(state.activeAgentId) || !(mode === 'any-running' ? eligible.length : chosen.length)
    get('grant').textContent = state?.grants?.length ? 'Update allowed agents' : 'Enable computer control'
    get('revoke').hidden = mode !== 'selected'; get('revoke').disabled = !api || busy || !chosen.length
    get('stop').disabled = !api // Stop stays available while a grant is pending.
    for (const input of el.querySelectorAll('input[type="checkbox"], input[type="radio"]')) input.disabled = busy || (input.type === 'checkbox' && input.dataset.eligible !== 'true')
  }
  function paint() {
    if (destroyed) return
    const grants = new Map((state?.grants || []).map(grant => [grant.sessionId, grant]))
    const currentRows = visibleRows(), filter = get('search').value.trim().toLowerCase()
    const key = JSON.stringify(currentRows.map(row => [row.sessionId, row.label, row.eligible, row.reason]))
    if (key !== rowKey) {
      rowKey = key; get('agents').replaceChildren()
      for (const row of currentRows) {
        const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small')
        checkbox.type = 'checkbox'; checkbox.value = row.sessionId; checkbox.dataset.eligible = String(Boolean(row.eligible))
        checkbox.addEventListener('change', () => { dirty = true; notice = ''; if (checkbox.checked) selected.add(row.sessionId); else selected.delete(row.sessionId); paint() })
        name.textContent = row.label; text.append(name, detail)
        label.dataset.agentSession = row.sessionId; label.append(checkbox, text); get('agents').append(label)
      }
    }
    for (const label of get('agents').querySelectorAll('[data-agent-session]')) {
      const row = currentRows.find(row => row.sessionId === label.dataset.agentSession)
      label.hidden = Boolean(filter && !row.label.toLowerCase().includes(filter)); label.dataset.allowed = String(grants.has(row.sessionId))
      label.querySelector('input').checked = selected.has(row.sessionId)
      label.querySelector('small').textContent = row.reason || (state?.holderSessionId === row.sessionId ? 'Controlling now' : grants.has(row.sessionId) ? 'Allowed · waiting for a turn' : 'Access off')
    }
    get('selection').hidden = mode !== 'selected'
    for (const radio of radios) radio.checked = radio.value === mode
    const count = currentRows.filter(row => row.eligible).length
    get('roster').textContent = !currentRows.length ? 'Start a local agent to enable computer control.'
      : mode === 'any-running' ? `${count} eligible running agent${count === 1 ? '' : 's'}. Enable again to include agents you start later.`
        : filter && !currentRows.some(row => row.label.toLowerCase().includes(filter)) ? 'No agents match this search.' : 'Only checked agents receive access when you enable or update it.'
    get('badge').textContent = state?.holderSessionId ? 'In use' : grants.size ? 'Ready' : 'Off'
    el.dataset.state = state?.holderSessionId ? 'controlling' : grants.size ? 'ready' : 'off'
    get('holder').hidden = !state?.holderSessionId
    get('holder').textContent = state?.holderSessionId ? `${state.holderLabel || currentRows.find(row => row.sessionId === state.holderSessionId)?.label || 'An agent'} has control${state.activeAction ? ' · ' + state.activeAction : ''}` : ''
    get('status').textContent = notice || (!api ? 'Open the local desktop app to enable computer control.'
      : !state?.supported ? state?.unavailableReason || 'Computer control requires Windows or a Linux X11 desktop.'
        : state.permissionLevel !== 'unrestricted' ? 'Choose Unrestricted permissions in Setup before enabling computer control.'
          : dirty ? 'Your selection is ready. Enable or update access to apply it.'
            : grants.size ? 'Access is on. One agent holds control until it releases its turn or becomes idle.' : 'Computer control is off.')
    buttons(); onChange({ state, rows })
  }
  /* Read with the roster, in the same Promise.all, so the names are in hand
     before accept() composes a row and no second repaint is needed.
     ENABLED SEATS ONLY. screen-control-host refuses SCREEN_ROLE_UNAVAILABLE
     for a seat that is not enabled, so lending one its name here would dress a
     row that cannot be granted anything as one that can.
     A failed read keeps the names already held rather than blanking every row:
     "could not ask" is not "has no name". */
  async function declaredSeatNames() {
    if (sample || typeof window.mcOrg?.read !== 'function') return seatNames
    try {
      const record = await window.mcOrg.read()
      const agents = record?.org?.agents || record?.agents
      if (!Array.isArray(agents)) return seatNames
      const names = new Map()
      for (const agent of agents) {
        const name = typeof agent?.displayName === 'string' ? agent.displayName.trim() : ''
        if (agent?.id && agent.enabled === true && name) names.set(String(agent.id), name)
      }
      return names
    } catch { return seatNames }
  }
  async function refreshNow() {
    clearTimeout(timer)
    const version = stateVersion
    try {
      const [nextTargets, current, names] = await Promise.all([
        sample ? [] : window.mcVoice?.targets?.() || [], api ? api.status() : null, declaredSeatNames()])
      // A slow roster read must not overwrite a newer Stop/grant event.
      if (!destroyed) { targets = nextTargets; seatNames = names; accept(version === stateVersion ? current : state) }
    } catch (error) { if (!destroyed) { notice = String(error?.message || error); paint() } }
    if (!destroyed) armPoll()
  }
  /* T369: HOW OFTEN THE MAIN THREAD IS ASKED. Every status call reads the org
     record and the confinement config on the main thread, and this control
     polled every 10 s on every open agent page whether or not anyone had
     turned computer control on: 69 rows of mc-screen-control:status at
     240-306 ms in one afternoon of the owner's log with control OFF. The
     host pushes every grant, release and stop as an event (onEvent below),
     so polling only has to catch what no event announces -- a session that
     started or ended. While control is off that can wait a minute; while an
     agent actually holds the mouse it is polled as before; a hidden page is
     not polled at all and refreshes the moment it is shown again. */
  const controlOn = () => Boolean(state?.holderSessionId || (Array.isArray(state?.grants) && state.grants.length))
  function armPoll() {
    clearTimeout(timer)
    if (destroyed || document.hidden) return
    timer = setTimeout(refresh, controlOn() ? 10000 : 60000)
  }
  function onVisibility() {
    if (destroyed) return
    if (document.hidden) clearTimeout(timer)
    else void refresh()
  }
  document.addEventListener('visibilitychange', onVisibility)
  function refresh() {
    if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null })
    return refreshing
  }
  async function run(action) {
    const version = ++requestVersion
    busy = true; notice = ''; buttons()
    try { const current = await action(); if (!destroyed && version === requestVersion) { dirty = false; accept(current) } }
    catch (error) { if (!destroyed && version === requestVersion) { notice = String(error?.message || error); paint() } }
    finally { if (!destroyed && version === requestVersion) { busy = false; buttons() } }
  }
  for (const radio of radios) radio.addEventListener('change', () => { if (radio.checked) { mode = radio.value; dirty = true; notice = ''; paint() } })
  get('search').addEventListener('input', paint)
  const selection = () => visibleRows().filter(row => row.eligible && selected.has(row.sessionId)).map(row => row.sessionId)
  get('grant').addEventListener('click', () => void run(() => api.grant({ mode, sessionIds: selection(), labels: Object.fromEntries(rows.map(row => [row.sessionId, row.label])) })))
  get('revoke').addEventListener('click', () => void run(() => api.revoke({ sessionIds: selection() })))
  get('stop').addEventListener('click', () => void run(() => api.revoke()))
  const detach = api?.onEvent(current => { if (!destroyed) accept(current) })
  void refresh()
  return { el, refresh, getRows: () => rows, getState: () => state,
    async selectAgent(agent, { isCurrent = () => true } = {}) {
      await refresh()
      if (destroyed || !isCurrent()) return null
      const row = visibleRows().find(row => row.nodeId === agent.id || row.agentId === agent.id)
      if (!row) { notice = 'Start this local agent before selecting it for voice or computer control.'; paint(); return null }
      notice = ''; mode = 'selected'; dirty = true
      if (row.eligible) selected.add(row.sessionId)
      paint(); return row
    },
    destroy() { destroyed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); detach?.(); el.remove() },
  }
}
