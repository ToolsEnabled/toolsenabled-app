// Messages — one channels workspace for live and example messages.
import { el, openMemory, ownDisclosure } from '../components.js'
import { onNextFrame } from '../page-frames.js'
import { resolveDataSource, currentDataSource, DATA_SOURCE_EVENT } from '../data-source.js'
import { sampleCommsJournal } from '../sample-comms.js'
import { commsQuietMarkup, hostAbsentMarkup } from '../first-run-needs.js'
import { COMMS_NAME, EXAMPLE_BADGE, LOADING_LINE, UNREADABLE_SUB,
  READER_REFUSALS, shouldFold, messagePreview, senderHues, rowModel, dayLabel, sameDay,
  NO_ANSWER_YET, toRecipient, emptyLine,
} from '../comms-copy.js'
import { createCommsFeed, channelGroups, labelSameNamedAgents, messageMatches } from '../comms-feed.js'
import { parseFleetTrees, safeTreeStorage, fleetTreesStorageKey, treeRecord, displayName as treeDisplayName } from '../fleet-trees.js'
import { FLEET } from '../fleet-profile.js'
import { setChatMessageBody, addChatMessageCopy } from '../chat-message-body.js'
import '../comms.css'

const pad2 = n => String(n).padStart(2, '0')
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmtTime = at => { const d = new Date(at); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }
let detailSequence = 0
const foldOpen = openMemory('mc.comms.fold:')
const noteEl = text => el(`<div class="projection-state" data-projection-state="true">${esc(text)}</div>`)
// Only the selected channel survives navigation. Message caches belong to a
// mounted source, so another computer can never inherit its predecessor's log.
let selectedChannel = null

/* The tree each saved circle on this computer's trees belongs to, by the
   circle's id, read only (T1513). Asked only when two agents share a name. */
function treeNamesByCircle() {
  const names = new Map()
  const storage = safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage)
  for (const machine of FLEET.machines || []) {
    if (!machine?.id) continue
    try {
      const saved = parseFleetTrees(storage.read(fleetTreesStorageKey(machine.id)), { computerId: machine.id })
      for (const tree of saved.trees || []) {
        const name = treeDisplayName(treeRecord(saved, tree.id))
        for (const node of saved.nodes || []) if (node.treeId === tree.id) names.set(node.id, name)
      }
    } catch { /* An unreadable tree record names no tree; the agents are numbered instead. */ }
  }
  return names
}

function foldEl(model) {
  const wrap = el(`
    <details class="context chat-context comms-message-fold">
      <summary class="chat-context-head">
        <span class="chat-context-say"></span>
        <span class="comms-fold-label"><span class="comms-fold-more">Read full message</span><span class="comms-fold-less">Show less</span><span aria-hidden="true"> ↕</span></span>
      </summary>
      <div class="chat-context-body cmsg-text"></div>
    </details>
  `)
  wrap.querySelector('.chat-context-say').textContent = messagePreview(model.text)
  setChatMessageBody(wrap.querySelector('.chat-context-body'), model.text)
  const saved = foldOpen.recall(model.id)
  wrap.open = saved === 'open'
  /* `within` the summary: a press on the closed row (which elementFromPoint
     answers as the details) or on the summary toggles; a press inside the open
     body, where a person selects and copies the text, is left alone. */
  ownDisclosure(wrap, { within: wrap.querySelector('summary'), onToggle: (open) => foldOpen.remember(model.id, open) })
  return wrap
}
function bodyEl(model) {
  if (shouldFold(model.text)) return foldEl(model)
  const body = el('<div class="cmsg-text"></div>')
  setChatMessageBody(body, model.text)
  return body
}

// Metadata names only recorded facts. The durable inbox confirmation is
// distinct from an agent reading the message or completing the requested work.
function rowEl(model, surface, hues, { route = null, expanded = false } = {}) {
  const hue = hues.get(model.sender) || ''
  const style = hue ? ` style="--rc:${hue}"` : ''
  const detailId = `comms-detail-${++detailSequence}`
  const row = el(`
    <div class="cmsg"${style} data-msg-id="${esc(model.id)}" data-kind="${esc(model.kind)}" data-delivery="${esc(model.deliveryState)}">
      <span class="cmsg-avatar" aria-hidden="true">${esc(model.sender.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase())}</span>
      <div class="cmsg-main">
        <div class="cmsg-top">
          <span class="cmsg-au"></span>
          ${model.recipient ? '<span class="cmsg-to"></span>' : ''}
          <time class="cmsg-time" ${model.at ? `datetime="${new Date(model.at).toISOString()}" title="${esc(new Date(model.at).toLocaleString())}"` : 'hidden'}>${model.at ? fmtTime(model.at) : ''}</time>
          <span class="cmsg-actions">
            <button type="button" class="cmsg-details-toggle" aria-expanded="false" aria-controls="${detailId}" aria-label="Message details from ${esc(model.sender)}">Details</button>
          </span>
        </div>
        ${model.replyTo ? `<button type="button" class="cmsg-reply" data-reply-to="${esc(model.parentId)}"><span class="cmsg-reply-label">${esc(model.replyTo)}</span><span class="cmsg-reply-preview">${esc(model.replyPreview)}</span></button>` : ''}
      </div>
    </div>
  `)
  row.querySelector('.cmsg-au').textContent = model.sender
  if (model.recipient) row.querySelector('.cmsg-to').textContent = toRecipient(model.recipient)
  row.querySelector('.cmsg-main').appendChild(bodyEl(model))
  if (route || model.deliveryState === 'unconfirmed') row.querySelector('.cmsg-main').appendChild(el(`<div class="cmsg-foot">
    ${model.deliveryState === 'unconfirmed' ? `<span class="cmsg-delivery" data-delivery="unconfirmed" title="${esc(model.deliveryDetail)}">${esc(model.deliveryLabel)}</span>` : ''}
    ${route ? `<button type="button" class="cmsg-channel" data-channel="${esc(route.id)}" title="Open ${esc(route.name)}">View conversation <span aria-hidden="true">→</span></button>` : ''}
  </div>`))
  const detail = el(`<dl class="cmsg-details" id="${detailId}" hidden>
    ${model.tag ? `<div><dt>Message</dt><dd class="cmsg-kind">${model.kind === 'ask' ? 'Request' : 'Reply'}</dd></div>` : ''}
    ${model.noAnswer ? `<div><dt>Reply</dt><dd>${esc(NO_ANSWER_YET)}</dd></div>` : ''}
    ${model.at ? `<div><dt>Sent</dt><dd>${esc(new Date(model.at).toLocaleString())}</dd></div>` : ''}
    ${model.machine ? `<div><dt>Computer</dt><dd class="cmsg-machine">${esc(model.machine)}</dd></div>` : ''}
    <div><dt>Delivery</dt><dd>${model.deliveryState ? `<span class="cmsg-delivery" data-delivery="${esc(model.deliveryState)}">${esc(model.deliveryLabel)}</span>. ${esc(model.deliveryDetail)}` : 'Delivery information is not available for this message.'}</dd></div>
  </dl>`)
  row.querySelector('.cmsg-main').appendChild(detail)
  const detailButton = row.querySelector('.cmsg-details-toggle')
  detailButton.addEventListener('click', () => {
    detail.hidden = !detail.hidden
    detailButton.setAttribute('aria-expanded', String(!detail.hidden))
  })
  if (expanded && row.querySelector('details')) row.querySelector('details').open = true
  addChatMessageCopy(row, row.querySelector('.chat-message-body'), row.querySelector('.cmsg-actions'))
  return row
}

/* Fill a surface with a channel's rows: the day dividers (log only), the rows,
   and the one empty line when there are none. `seen` is the set of ids the
   previous paint drew; a row absent from it plays .fresh once. */
const renderedRows = new WeakMap()
function fillRows(target, card, surface, { limit = Infinity, seen = null, now = Date.now(), quiet = false } = {}) {
  const previous = renderedRows.get(target) || new Map()
  const next = new Map(), nodes = []
  const keep = (key, signature, create) => {
    const cached = previous.get(key)
    const node = cached?.signature === signature ? cached.node : create()
    next.set(key, { signature, node })
    nodes.push(node)
  }
  const rows = limit === Infinity ? card.hist : card.hist.slice(-limit)
  if (!card.pending && !rows.length && !quiet) keep('empty', '', () => noteEl(emptyLine()))
  let lastAt = null
  if (!card.pending) for (const message of rows) {
    const model = rowModel(message, card.byId)
    if (model.at && (lastAt === null || !sameDay(lastAt, model.at))) {
      const label = dayLabel(model.at, now)
      keep(`day:${model.id}`, label, () => el(`<div class="day-div"><span>${esc(label)}</span></div>`))
    }
    lastAt = model.at
    const route = card.routes?.get(model.id)
    keep(`message:${model.id}`, JSON.stringify([model, card.hues.get(model.sender), route?.id, card.expanded]), () => {
      const row = rowEl(model, surface, card.hues, { route, expanded: card.expanded })
      if (seen && surface === 'cmsg' && !seen.has(model.id)) row.classList.add('fresh')
      return row
    })
  }
  // Moving an unchanged row through replaceChildren would still destroy text
  // selection and focus. Leave matching positions alone.
  nodes.forEach((node, index) => {
    if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null)
  })
  while (target.children.length > nodes.length) target.lastElementChild.remove()
  renderedRows.set(target, next)
}

export function commsView() {
  const root = el(`
    <div class="comms" data-mode="channels" data-live-mode="live" data-projection-state="loading">
      <header class="comms-head">
        <div class="comms-heading"><h1 class="head-title">${esc(COMMS_NAME)}</h1><p class="head-sub">Conversations between your agents</p></div>
        <span class="spacer"></span>
        <span class="comms-badge" data-example-badge="true" hidden>${esc(EXAMPLE_BADGE)}</span>
        <span class="head-live" role="status"><i></i><span>Connecting</span></span>
        <button type="button" class="icon-btn comms-refresh" aria-label="Refresh messages" title="Refresh messages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 19.8 12M4.2 12a8 8 0 0 0 13.7 5.9"/></svg></button>
      </header>
      <div class="comms-notice" data-comms-notice="true" role="status" hidden></div>
      <div class="comms-card">
        <section class="comms-sheet" aria-label="Agent conversations">
          <aside class="ch-rail" aria-label="Conversations">
            <div class="ch-rail-head"><strong>Conversations</strong><span class="ch-total"></span></div>
            <input type="search" class="ch-filter" aria-label="Find a conversation" placeholder="Find a conversation">
            <nav class="ch-list" aria-label="Agent conversations"></nav>
            <p class="ch-no-results" hidden>No matching conversations.</p>
          </aside>
          <section class="ch-main">
            <label class="comms-mobile-picker">Conversation<select class="comms-conversation-select" aria-label="Choose a conversation"></select></label>
            <header class="ch-topic">
              <div class="ch-topic-heading"><h2 class="ch-title">All messages</h2><p class="ch-description">${esc(LOADING_LINE)}</p></div>
            </header>
            <div class="comms-tools" aria-label="Filter messages">
              <input type="search" class="comms-search" aria-label="Search messages" placeholder="Search this conversation">
              <button type="button" class="comms-filter-toggle" aria-expanded="false" aria-controls="comms-filters">Filters<span class="comms-filter-count" hidden></span></button>
              <button type="button" class="comms-clear" hidden>Clear filters</button>
            </div>
            <div class="comms-filter-panel" id="comms-filters" hidden>
              <label class="comms-agent-label">Agent
              <select class="comms-agent" aria-label="Filter by agent"><option value="">All agents</option></select>
              </label>
              <button type="button" class="comms-issues" aria-pressed="false" title="Messages whose recipient inbox write is unconfirmed">Delivery issues <span class="comms-issue-count">0</span></button>
            </div>
            <button type="button" class="comms-earlier" hidden>Load earlier messages ↑</button>
            <div class="ch-log" tabindex="0" role="region" aria-label="Messages"></div>
            <button type="button" class="jump-chip hidden" tabindex="-1"><span class="jl">Jump to latest</span> ↓</button>
            <footer class="comms-foot"><span class="comms-count" role="status"></span><span class="comms-updated"></span></footer>
          </section>
        </section>
      </div>
    </div>
  `)
  let destroyed = false, channels = [], latest = null, active = selectedChannel
  let pinned = true, newCount = 0, seen = new Set(), displayedChannel = null
  let filter = '', query = '', agent = '', issuesOnly = false, filterKey = '', agentSignature = '', channelSignature = ''
  const rootFind = selector => root.querySelector(selector)
  const list = rootFind('.ch-list'), log = rootFind('.ch-log'), chip = rootFind('.jump-chip')
  const notice = rootFind('[data-comms-notice]'), refreshButton = rootFind('.comms-refresh')
  const earlierButton = rootFind('.comms-earlier'), agentSelect = rootFind('.comms-agent'), issuesButton = rootFind('.comms-issues')
  const conversationSelect = rootFind('.comms-conversation-select'), filterToggle = rootFind('.comms-filter-toggle')
  const railItems = new Map()
  const positions = new Map()
  let hues = new Map()
  let pendingScroll = null
  const atLatest = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48
  function cancelScrollSettle() {
    if (!pendingScroll) return
    // A person can move the log before its queued scroll event is delivered.
    if (log.scrollTop !== pendingScroll.top) pinned = atLatest()
    if (pendingScroll.frame) cancelAnimationFrame(pendingScroll.frame)
    pendingScroll = null
  }
  function updateChip() {
    const hidden = pinned || log.scrollHeight - log.scrollTop - log.clientHeight < 48 || !log.querySelector('.cmsg')
    chip.classList.toggle('hidden', hidden)
    chip.inert = hidden
    chip.tabIndex = hidden ? -1 : 0
    chip.querySelector('.jl').textContent = newCount ? `${newCount} new · Jump to latest` : 'Jump to latest'
  }
  function renderRail() {
    const visible = channels.filter(channel => channel.id === 'all' || channel.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    const next = new Set()
    visible.forEach((channel, index) => {
      next.add(channel.id)
      let row = railItems.get(channel.id)
      if (!row) {
        row = el(`<button type="button" class="ch"><span class="ch-top"><span class="ch-name"></span><time class="ch-time"></time></span><span class="ch-preview"></span><span class="ch-issue" hidden>Delivery issue</span></button>`)
        row.dataset.id = channel.id
        row.addEventListener('click', () => switchChannel(channel.id))
        railItems.set(channel.id, row)
      }
      const last = channel.messages.at(-1)
      row.querySelector('.ch-name').textContent = channel.name
      row.querySelector('.ch-preview').textContent = channel.id === 'all' ? 'Every conversation in one timeline' : last ? `${last.sender}: ${messagePreview(last.text, 160)}` : latest?.updatedAt === null ? 'Waiting for message history' : 'No messages yet'
      const issues = channel.messages.filter(message => message.deliveryState === 'unconfirmed').length
      row.classList.toggle('has-issues', issues > 0)
      row.querySelector('.ch-issue').hidden = !issues || channel.id === 'all'
      row.querySelector('.ch-issue').textContent = `${issues} delivery issue${issues === 1 ? '' : 's'}`
      const time = row.querySelector('time'), at = Date.parse(last?.at)
      time.textContent = channel.id !== 'all' && Number.isFinite(at) ? sameDay(at, Date.now()) ? fmtTime(at) : dayLabel(at) : ''
      if (Number.isFinite(at)) { time.dateTime = new Date(at).toISOString(); time.title = new Date(at).toLocaleString() }
      row.title = channel.name
      row.classList.toggle('active', channel.id === active)
      if (channel.id === active) row.setAttribute('aria-current', 'true')
      else row.removeAttribute('aria-current')
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null)
    })
    for (const [id, row] of railItems) if (!next.has(id)) { row.remove(); railItems.delete(id) }
    rootFind('.ch-total').textContent = latest?.updatedAt === null ? '—' : Math.max(0, channels.length - 1)
    rootFind('.ch-no-results').hidden = !filter || visible.some(channel => channel.id !== 'all')
    const nextSignature = JSON.stringify(channels.map(channel => [channel.id, channel.name]))
    if (channelSignature !== nextSignature) {
      channelSignature = nextSignature
      conversationSelect.replaceChildren()
      for (const channel of channels) { const option = el('<option></option>'); option.value = channel.id; option.textContent = channel.name; conversationSelect.appendChild(option) }
    }
    conversationSelect.value = active || 'all'
  }
  function renderLog() {
    cancelScrollSettle()
    const channel = channels.find(channel => channel.id === active) || channels[0]
    if (!channel) return
    const changed = displayedChannel !== channel.id
    if (changed) { displayedChannel = channel.id; seen = new Set(); log.replaceChildren(); renderedRows.delete(log) }
    const nextFilterKey = JSON.stringify([query, agent, issuesOnly])
    const filtered = Boolean(query || agent || issuesOnly), filtersChanged = filterKey !== nextFilterKey
    filterKey = nextFilterKey
    const messages = channel.messages.filter(message => messageMatches(message, query)
      && (!agent || message.sender === agent || message.recipient === agent)
      && (!issuesOnly || message.deliveryState === 'unconfirmed'))
    const people = new Set(channel.messages.flatMap(message => [message.sender, message.recipient]).filter(Boolean))
    const sortedPeople = [...people].sort((a, b) => a.localeCompare(b)), nextAgentSignature = JSON.stringify(sortedPeople)
    if (agentSignature !== nextAgentSignature) {
      agentSignature = nextAgentSignature
      agentSelect.replaceChildren(el('<option value="">All agents</option>'))
      for (const name of sortedPeople) { const option = el('<option></option>'); option.value = name; option.textContent = name; agentSelect.appendChild(option) }
      agentSelect.value = agent
    }
    rootFind('.comms-clear').hidden = !filtered
    const activeFilters = Number(Boolean(agent)) + Number(issuesOnly)
    rootFind('.comms-filter-count').hidden = !activeFilters
    rootFind('.comms-filter-count').textContent = activeFilters
    const issueCount = channel.messages.filter(message => message.deliveryState === 'unconfirmed').length
    rootFind('.comms-issue-count').textContent = latest?.updatedAt === null ? '—' : issueCount
    issuesButton.setAttribute('aria-pressed', String(issuesOnly))
    issuesButton.disabled = !issueCount && !issuesOnly
    earlierButton.hidden = !latest?.hasEarlier
    rootFind('.ch-title').textContent = channel.name
    rootFind('.ch-description').textContent = channel.id === 'all'
      ? 'Messages from all your agent conversations, in time order.'
      : 'Messages between these agents, in time order.'
    rootFind('.comms-search').placeholder = channel.id === 'all' ? 'Search all messages' : 'Search this conversation'
    log.setAttribute('aria-label', `${channel.name} messages`)
    const fresh = messages.filter(message => !seen.has(message.id)).length
    const oldTop = log.scrollTop, oldHeight = log.scrollHeight
    const routes = active === 'all' ? new Map(channels.slice(1).flatMap(item => item.messages.map(message => [message.id, { id: item.id, name: item.name }]))) : null
    fillRows(log, { hist: messages, byId: new Map((latest?.messages || []).map(message => [message.id, message])), hues, routes, expanded: Boolean(query) }, 'cmsg', { seen: !filtersChanged && !latest?.prepending && seen.size ? seen : null, quiet: true })
    if (!messages.length) {
      if (filtered) log.appendChild(noteEl('No messages match these filters. Try a different search or clear the filters.'))
      else if (latest?.phase === 'loading') log.appendChild(noteEl('Reading messages…'))
      else if (latest?.phase !== 'unavailable') {
        if (active === 'all' && !latest?.messages.length) log.appendChild(el(commsQuietMarkup({ viaRelay: currentDataSource() === 'relay' })))
        else log.appendChild(noteEl(emptyLine()))
      } else log.appendChild(noteEl('Messages will appear here when the connection is restored.'))
    }
    if (!changed && latest?.prepending) { pinned = false; log.scrollTop = oldTop + log.scrollHeight - oldHeight }
    else if (!changed && !pinned && !filtersChanged) { log.scrollTop = oldTop; if (seen.size) newCount += fresh }
    seen = new Set(messages.map(message => message.id))
    if (pinned && !filtered && !latest?.prepending) {
      newCount = 0
      // Replacing the old channel clamps scrollTop and queues a scroll event.
      // Settle the new layout now, before that event can change its intent.
      log.scrollTop = log.scrollHeight
      const settle = { channel: active, top: log.scrollTop, frame: 0 }
      pendingScroll = settle
      settle.frame = onNextFrame(() => {
        if (destroyed || pendingScroll !== settle) return
        pendingScroll = null
        if (log.scrollTop !== settle.top) pinned = atLatest()
        else if (active === settle.channel && pinned && !query && !agent && !issuesOnly) log.scrollTop = log.scrollHeight
        updateChip()
      })
    }
    rootFind('.comms-count').textContent = latest?.updatedAt === null ? 'Waiting for message history' : filtered
      ? `${messages.length} of ${channel.messages.length} messages match`
      : `${messages.length} message${messages.length === 1 ? '' : 's'} · ${people.size} agent${people.size === 1 ? '' : 's'}`
    updateChip()
  }
  function switchChannel(id) {
    if (id === active) return
    cancelScrollSettle()
    positions.set(active, { top: log.scrollTop, pinned })
    active = selectedChannel = id
    if (agent && !channels.find(channel => channel.id === id)?.messages.some(message => message.sender === agent || message.recipient === agent)) { agent = ''; agentSelect.value = '' }
    newCount = 0
    pinned = positions.get(id)?.pinned ?? true
    renderRail(); renderLog()
    if (!pinned) log.scrollTop = positions.get(id).top
  }
  function paint(snapshot) {
    if (destroyed) return
    /* Same-named agents from different trees are told apart before anything
       groups, filters or draws them, so every surface below says the same. */
    let circles = null
    snapshot = { ...snapshot, messages: labelSameNamedAgents(snapshot.messages, nodeKey => (circles ||= treeNamesByCircle()).get(nodeKey) || null) }
    if (snapshot.phase === 'loading') { cancelScrollSettle(); positions.clear(); seen.clear(); hues.clear(); clearFilters(); displayedChannel = null; pinned = true; newCount = 0 }
    latest = snapshot
    // Loading older history must not change the colors of familiar senders.
    hues = senderHues([...hues.keys()].map(sender => ({ sender })).concat(snapshot.messages))
    channels = channelGroups(snapshot.messages, snapshot.channels)
    if (snapshot.phase !== 'loading' && !channels.some(channel => channel.id === active)) active = channels.find(channel => channel.id !== 'all' && channel.messages.length)?.id || 'all'
    root.dataset.liveMode = snapshot.example ? 'simulated' : 'live'
    root.dataset.projectionState = snapshot.example ? 'simulated' : snapshot.phase === 'stale' ? 'partial-unavailable' : snapshot.phase
    const badge = rootFind('[data-example-badge]')
    badge.hidden = !snapshot.example
    refreshButton.hidden = snapshot.example
    rootFind('.head-live').hidden = snapshot.example
    rootFind('.head-live span').textContent = snapshot.example ? 'Example' : snapshot.catchingUp && snapshot.phase === 'ready' ? 'Catching up' : ({ loading: 'Connecting', ready: 'Live updates', stale: 'Reconnecting', unavailable: 'Disconnected' })[snapshot.phase]
    const reason = snapshot.reason
    notice.hidden = !reason && !snapshot.notice
    notice.replaceChildren()
    if (reason) {
      if (snapshot.updatedAt === null) notice.innerHTML = hostAbsentMarkup(reason, { compact: true })
      else notice.textContent = `Showing the last successful read. ${reason}`
    } else if (snapshot.notice) notice.textContent = snapshot.notice
    rootFind('.comms-updated').textContent = snapshot.updatedAt === null ? '' : snapshot.example ? 'Example conversation' : `Last read ${fmtTime(snapshot.updatedAt)}`
    rootFind('.head-sub').textContent = snapshot.phase === 'unavailable' ? UNREADABLE_SUB : 'Conversations between your agents'
    renderRail(); renderLog()
    latest = { ...snapshot, prepending: false }
  }
  const feed = createCommsFeed({
    resolveSource: resolveDataSource,
    sample: sampleCommsJournal,
    async readMessages(options) {
      const bridge = window.mcAgent
      if (typeof bridge?.localMessages !== 'function') return { ok: false, reason: READER_REFUSALS.NO_READER }
      try { return await bridge.localMessages(options) }
      catch (error) { return { ok: false, reason: READER_REFUSALS.READ_THREW(error) } }
    },
    paint,
  })
  const onSourceChanged = () => { void feed.start({ reask: true }) }
  window.addEventListener(DATA_SOURCE_EVENT, onSourceChanged)
  refreshButton.addEventListener('click', async () => { refreshButton.disabled = true; try { await feed.refresh() } finally { refreshButton.disabled = false } })
  earlierButton.addEventListener('click', async () => {
    earlierButton.disabled = true; earlierButton.textContent = 'Loading earlier messages…'
    try { await feed.loadEarlier() } finally { earlierButton.disabled = false; earlierButton.textContent = 'Load earlier messages ↑' }
  })
  rootFind('.ch-filter').addEventListener('input', event => { filter = event.target.value; renderRail() })
  conversationSelect.addEventListener('change', event => switchChannel(event.target.value))
  filterToggle.addEventListener('click', () => {
    const panel = rootFind('.comms-filter-panel')
    panel.hidden = !panel.hidden
    filterToggle.setAttribute('aria-expanded', String(!panel.hidden))
  })
  rootFind('.comms-search').addEventListener('input', event => { query = event.target.value; newCount = 0; renderLog(); if (query) log.scrollTop = 0 })
  agentSelect.addEventListener('change', event => { agent = event.target.value; newCount = 0; renderLog(); log.scrollTop = 0 })
  issuesButton.addEventListener('click', () => { issuesOnly = !issuesOnly; newCount = 0; renderLog(); log.scrollTop = 0 })
  function clearFilters() { query = ''; agent = ''; issuesOnly = false; rootFind('.comms-search').value = ''; agentSelect.value = ''; newCount = 0 }
  rootFind('.comms-clear').addEventListener('click', () => { clearFilters(); renderLog() })
  log.addEventListener('scroll', () => {
    // A queued event from our own layout change is not a reader scrolling up.
    if (pendingScroll && log.scrollTop === pendingScroll.top) return
    cancelScrollSettle()
    pinned = atLatest()
    if (pinned) newCount = 0
    updateChip()
  })
  chip.addEventListener('click', () => { pinned = true; newCount = 0; log.scrollTop = log.scrollHeight; updateChip() })
  log.addEventListener('click', event => {
    const channelButton = event.target.closest('[data-channel]')
    if (channelButton) { clearFilters(); switchChannel(channelButton.dataset.channel); return }
    const button = event.target.closest('[data-reply-to]')
    if (!button) return
    const parentId = button.dataset.replyTo
    clearFilters(); renderLog()
    let parent = [...log.querySelectorAll('[data-msg-id]')].find(row => row.dataset.msgId === parentId)
    if (!parent) { switchChannel('all'); parent = [...log.querySelectorAll('[data-msg-id]')].find(row => row.dataset.msgId === parentId) }
    pinned = false
    if (parent?.querySelector('details')) parent.querySelector('details').open = true
    parent?.scrollIntoView({ block: 'center' })
    parent?.classList.add('reply-target')
    setTimeout(() => parent?.classList.remove('reply-target'), 1800)
  })
  void feed.start()
  return { el: root, destroy() { destroyed = true; cancelScrollSettle(); feed.destroy(); window.removeEventListener(DATA_SOURCE_EVENT, onSourceChanged) } }
}
