import { mountChatTakeover, defaultSubjectId } from './home-chat-takeover.js'
import { fitChatWindow, initialChatWindow, chatPanelRects, moveChatWindow, resizeChatWindow } from './home-chat-window-geometry.js'

const PANEL_COUNTS = { single: 1, double: 2, four: 4 }

const ICONS = {
  minimize: '<path d="M4 14h12"/>',
  maximize: '<rect x="4" y="4" width="12" height="12" rx="1"/>',
  restore: '<path d="M7 7V3h10v10h-4"/><rect x="3" y="7" width="10" height="10" rx="1"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
}
const icon = name => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`

// Window operations retain each shared chat, draft and runtime subscription.
// Only opening a different conversation or closing its window changes a mount.
export function mountHomeChatLayout(host, {
  surface, choices = [], subjectId, live, renderTranscript, renderAgent, sampleChat,
  draftStore, state = {}, onSubjectChange, onFind, onLatest, readingWidth = surface?.dataset.readingWidth,
} = {}) {
  const restored = { ...state, windows: state.windows?.map(item => ({ ...item, rect: { ...item.rect } })) }
  const doc = host.ownerDocument || document
  const make = (tag, className, text) => {
    const node = doc.createElement(tag); node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const root = make('div', 'home-chat-layout'); host.appendChild(root)
  const tabs = surface.querySelector('.home-chat-pane-tabs')
  const commandsButton = surface.querySelector('[data-chat-commands]')
  const newButton = surface.querySelector('[data-chat-new]')
  const arrangeButton = surface.querySelector('[data-chat-arrange]')
  const layoutSelect = surface.querySelector('[data-chat-layout]')
  const panes = [], extras = new Map(), handlers = []
  let list = choices.slice(), active = null, nextId = 1, topZ = 0, destroyed = false
  let layout = PANEL_COUNTS[restored.layout] ? restored.layout : 'windows'
  let visible = Array.isArray(restored.visible) ? restored.visible.slice() : []
  let widthMode = readingWidth === 'wide' ? 'wide' : 'narrow'
  const on = (node, event, fn, bag = handlers) => {
    if (!node) return
    node.addEventListener(event, fn); bag.push(() => node.removeEventListener(event, fn))
  }
  const current = () => panes.find(pane => pane.id === active)
  const area = () => ({ width: Math.max(1, root.clientWidth), height: Math.max(1, root.clientHeight) })
  const compact = () => area().width < 640 || area().height < 330
  const roster = () => [...list, ...[...extras.values()].filter(choice => !list.some(item => item.id === choice.id))]
  const usesFeed = subject => subject && subject.kind !== 'agent' && (live || subject.kind !== 'coordinator')
  const computerForNew = () => current()?.subject?.computerId || roster().find(choice => choice.computerId)?.computerId
  function normalizePanels() {
    if (layout === 'windows') return
    const count = PANEL_COUNTS[layout]
    visible = visible.filter(id => panes.some(pane => pane.id === id && !pane.minimized)).slice(0, count)
    if (current() && !current().minimized && !visible.includes(active)) {
      if (visible.length === count) visible[visible.length - 1] = active
      else visible.push(active)
    }
    for (const pane of panes) if (!pane.minimized && visible.length < count && !visible.includes(pane.id)) visible.push(pane.id)
  }
  function panelCount() {
    if (compact() || area().width < 740) return 1
    return layout === 'four' && area().height < 612 ? 2 : PANEL_COUNTS[layout]
  }
  function shownPanels() {
    const ids = visible.slice(0, panelCount())
    if (current() && !current().minimized && !ids.includes(active)) ids[ids.length ? ids.length - 1 : 0] = active
    return ids
  }
  function panelRect(pane) {
    if (layout === 'windows') return null
    const index = shownPanels().indexOf(pane.id)
    return index < 0 ? null : chatPanelRects(area(), panelCount())[index]
  }
  const emptyNote = make('div', 'home-chat-workspace-empty')
  emptyNote.append(make('strong', '', 'Your conversation workspace'), make('p', '', ''))
  root.appendChild(emptyNote)
  const emptyPanels = Array.from({ length: 4 }, () => {
    const panel = make('div', 'home-chat-panel-empty'); panel.hidden = true
    const button = make('button', '', 'Open a conversation'); button.type = 'button'
    on(button, 'click', () => { openCommands(); query.value = 'Open '; paintCommands() })
    panel.append(make('span', '', 'Room for another chat'), button); root.appendChild(panel)
    return panel
  })
  function notify() {
    const subject = current()?.subject || null
    surface.dataset.subjectKind = subject?.kind || ''
    onSubjectChange?.(subject)
  }
  function persist() {
    state.active = active
    state.layout = layout; state.visible = visible.slice()
    state.windows = panes.map(pane => ({ id: pane.id, subjectId: pane.subject?.id, rect: { ...pane.rect },
      minimized: pane.minimized, maximized: pane.maximized, z: pane.z }))
    state.extras = [...extras.values()]
  }
  function paintBounds(pane) {
    const full = pane.maximized || compact()
    const rect = full ? { x: 0, y: 0, ...area() } : panelRect(pane) || fitChatWindow(pane.rect, area())
    Object.assign(pane.el.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: String(pane.z) })
    pane.el.dataset.maximized = String(full)
  }
  function paint() {
    if (destroyed) return
    normalizePanels()
    root.dataset.layout = layout
    if (layoutSelect) {
      layoutSelect.value = layout
      layoutSelect.title = layout !== 'windows' && panelCount() < PANEL_COUNTS[layout]
        ? 'More panels appear when the workspace has room. Other chats stay available in the window bar.'
        : 'Single, Double or Four panels. Windows keeps chats freely movable and resizable.'
    }
    surface.dataset.readingWidth = widthMode
    root.dataset.compact = String(compact()); root.dataset.activePane = String(active || '')
    emptyNote.hidden = panes.some(pane => !pane.minimized)
    emptyNote.querySelector('strong').textContent = panes.length ? 'Your windows are minimized' : 'Your conversation workspace'
    emptyNote.querySelector('p').textContent = panes.length ? 'Select a window in the bar above to restore it.'
      : 'Choose a conversation above to open a window. Drag its title to move it, or its edges to resize.'
    for (const pane of panes) {
      const label = pane.subject?.label || 'Conversation'
      pane.el.hidden = pane.minimized || (compact() && pane.id !== active)
        || (layout !== 'windows' && (!shownPanels().includes(pane.id) || (current()?.maximized && pane.id !== active)))
      pane.el.dataset.readingWidth = widthMode
      pane.el.dataset.active = String(pane.id === active); pane.el.setAttribute('aria-label', label)
      pane.title.textContent = label; pane.title.title = `${label} · Drag to move; double-click to maximize`
      pane.tab.textContent = `${pane.id} · ${label}`; pane.tab.title = `${pane.minimized ? 'Restore' : 'Focus'} ${label}`
      pane.tab.dataset.minimized = String(pane.minimized); pane.tab.setAttribute('aria-selected', String(pane.id === active))
      pane.tab.tabIndex = pane.id === active || (!active && pane === panes[0]) ? 0 : -1
      const name = pane.maximized ? 'Restore window' : 'Maximize window', glyph = pane.maximized ? 'restore' : 'maximize'
      pane.maximizeButton.title = name; pane.maximizeButton.setAttribute('aria-label', name)
      if (pane.maximizeButton.dataset.icon !== glyph) { pane.maximizeButton.dataset.icon = glyph; pane.maximizeButton.innerHTML = icon(glyph) }
      pane.maximizeButton.hidden = compact()
      paintBounds(pane)
    }
    const shown = layout === 'windows' ? [] : shownPanels()
    for (const [index, panel] of emptyPanels.entries()) {
      panel.hidden = layout === 'windows' || !shown.length || Boolean(current()?.maximized)
        || index < shown.length || index >= panelCount()
      if (panel.hidden) continue
      const rect = chatPanelRects(area(), panelCount())[index]
      Object.assign(panel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    }
    tabs.hidden = panes.length < 2 && !panes.some(pane => pane.minimized)
    newButton.disabled = !live || !computerForNew()
    newButton.title = !live ? 'Open your live fleet to start a new chat.' : computerForNew()
      ? 'Start a new chat in its own window.' : 'Connect a computer to start a new chat.'
    if (arrangeButton) arrangeButton.disabled = !panes.some(pane => !pane.minimized) || compact()
    for (const key of ['find', 'latest']) {
      const button = surface.querySelector(`[data-chat-${key}]`)
      if (button) button.disabled = !current()
    }
    persist()
  }
  function activate(pane, { focus = false } = {}) {
    if (!pane || destroyed) return
    if (layout !== 'windows') {
      const slot = visible.indexOf(active)
      if (!visible.includes(pane.id)) {
        if (visible.length < PANEL_COUNTS[layout]) visible.push(pane.id)
        else visible[slot < 0 ? visible.length - 1 : slot] = pane.id
      }
      for (const other of panes) if (other !== pane) other.maximized = false
    }
    pane.minimized = false; active = pane.id; pane.z = ++topZ
    paint(); notify()
    queueMicrotask(() => {
      if (!destroyed && active === pane.id && pane.tab.isConnected && !tabs.hidden) pane.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    if (focus) pane.title.focus({ preventScroll: true })
  }
  function chooseNext() {
    const available = panes.filter(pane => !pane.minimized).sort((a, b) => b.z - a.z)
    active = (layout !== 'windows' && available.find(pane => visible.includes(pane.id)) || available[0])?.id || null
    paint(); notify()
  }
  function toggleMaximize(pane) {
    if (compact()) return
    activate(pane); pane.maximized = !pane.maximized; paint()
  }
  function closePane(pane) {
    const index = panes.indexOf(pane); if (index < 0) return
    // Parking the Home feed can refresh choices synchronously. Detach the
    // owner first so a disposed mount can never be refreshed or resurrected.
    panes.splice(index, 1)
    const mount = pane.mount; pane.mount = null
    for (const off of pane.handlers) off()
    mount?.destroy()
    if (pane.subject?.newChat) extras.delete(pane.subject.id)
    pane.el.remove(); pane.tab.remove()
    if (active === pane.id) chooseNext(); else { paint(); notify() }
    if (!current()) surface.querySelector('[data-chat-subject]')?.focus()
  }
  function mountSubject(pane, subject) {
    const previous = pane.mount; pane.mount = null; pane.controller = null
    previous?.destroy()
    pane.subject = subject
    pane.mount = mountChatTakeover(pane.body, {
      choices: roster(), subjectId: subject.id, live, sampleChats: true, sampleChat,
      renderTranscript, renderAgent, draftStore,
      onSubjectChange: next => { pane.subject = next; paint(); if (pane.id === active) notify() },
    })
    paint(); notify()
  }
  function pointerGesture(event, pane, edge = '') {
    if (event.button !== 0 || compact() || (!edge && event.target.closest('button, input, select, a'))) return
    event.preventDefault(); activate(pane)
    const target = event.currentTarget, workspace = root.getBoundingClientRect()
    const scaleX = workspace.width / root.clientWidth, scaleY = workspace.height / root.clientHeight
    if (pane.maximized && edge) return
    const restoreRect = fitChatWindow(pane.rect, area())
    const fromFull = pane.maximized || (layout !== 'windows' && panelCount() === 1)
    let start = panelRect(pane) || restoreRect, started = false
    const x = event.clientX, y = event.clientY
    target.setPointerCapture(event.pointerId)
    const move = next => {
      const dx = (next.clientX - x) / scaleX, dy = (next.clientY - y) / scaleY
      if (!started && Math.abs(dx) + Math.abs(dy) < 4) return
      if (!started) {
        started = true
        detachPanels()
        if (fromFull) {
          const fraction = Math.max(0, Math.min(1, (x - workspace.left) / workspace.width))
          pane.maximized = false
          start = fitChatWindow({ ...restoreRect, x: (x - workspace.left) / scaleX - restoreRect.width * fraction,
            y: (y - workspace.top) / scaleY - 22 }, area())
        }
        pane.el.dataset.interacting = edge ? 'resize' : 'move'
      }
      pane.rect = edge ? resizeChatWindow(start, edge, dx, dy, area()) : moveChatWindow(start, dx, dy, area())
      paintBounds(pane)
    }
    const finish = () => {
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) target.removeEventListener(name, finish)
      target.removeEventListener('pointermove', move)
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
      delete pane.el.dataset.interacting; pane.cancelGesture = null; paint()
    }
    pane.cancelGesture = finish; target.addEventListener('pointermove', move)
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) target.addEventListener(name, finish)
    paint()
  }
  function createPane(saved = {}) {
    const id = Number(saved.id) || nextId++; nextId = Math.max(nextId, id + 1)
    const el = make('section', 'home-chat-pane'); el.dataset.paneId = String(id); el.id = `home-chat-window-${id}`
    const head = make('div', 'home-chat-pane-head'), title = make('span', 'home-chat-pane-title'); title.tabIndex = 0
    title.setAttribute('aria-description', 'Drag to move. Double-click or press Enter to maximize. Alt and arrow keys move; Alt Shift and arrow keys resize.')
    const actions = make('div', 'home-chat-pane-actions'), body = make('div', 'home-chat-pane-body')
    const tab = make('button', ''); tab.type = 'button'; tab.dataset.paneTab = String(id)
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', el.id)
    const pane = { id, el, body, title, tab, handlers: [], mount: null, controller: null, subject: null,
      rect: fitChatWindow(saved.rect || initialChatWindow(area(), panes.length), area()),
      minimized: Boolean(saved.minimized), maximized: Boolean(saved.maximized), z: saved.z || ++topZ }
    topZ = Math.max(topZ, pane.z)
    const listen = (node, type, fn) => on(node, type, fn, pane.handlers)
    for (const [name, words] of [['minimize', 'Minimize window'], ['maximize', 'Maximize window'], ['close', 'Close window']]) {
      const button = make('button', ''); button.type = 'button'; button.dataset.paneCommand = name
      button.setAttribute('aria-label', words); button.title = words; button.innerHTML = icon(name)
      listen(button, 'click', () => {
        if (name === 'close') closePane(pane)
        else if (name === 'maximize') toggleMaximize(pane)
        else { pane.minimized = true; if (active === pane.id) chooseNext(); else paint(); pane.tab.focus() }
      })
      pane[`${name}Button`] = button; actions.appendChild(button)
    }
    head.append(make('span', 'home-chat-pane-number', String(id)), title, actions); el.append(head, body)
    for (const edge of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = make('div', 'home-chat-window-resize'); handle.dataset.resize = edge; handle.setAttribute('aria-hidden', 'true')
      listen(handle, 'pointerdown', event => pointerGesture(event, pane, edge)); el.appendChild(handle)
    }
    root.appendChild(el); tabs.appendChild(tab); panes.push(pane)
    listen(head, 'pointerdown', event => pointerGesture(event, pane))
    listen(head, 'dblclick', event => { if (!event.target.closest('button')) toggleMaximize(pane) })
    listen(title, 'keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); toggleMaximize(pane); return }
      if (!event.altKey || !event.key.startsWith('Arrow') || compact()) return
      event.preventDefault(); activate(pane); detachPanels(); pane.maximized = false
      const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
      const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0
      pane.rect = event.shiftKey ? resizeChatWindow(pane.rect, 'se', dx, dy, area()) : moveChatWindow(pane.rect, dx, dy, area()); paint()
    })
    listen(el, 'pointerdown', () => { if (active !== id) activate(pane) })
    listen(el, 'focusin', () => { if (active !== id) activate(pane) })
    listen(tab, 'click', () => activate(pane, { focus: true }))
    listen(tab, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const at = panes.indexOf(pane), next = event.key === 'Home' ? panes[0] : event.key === 'End' ? panes.at(-1)
        : panes[(at + (event.key === 'ArrowRight' ? 1 : panes.length - 1)) % panes.length]
      activate(next); next.tab.focus()
    })
    const observer = new MutationObserver(() => { if (!destroyed) { paint(); if (active === id) notify() } })
    observer.observe(body, { childList: true, subtree: true })
    pane.handlers.push(() => observer.disconnect(), () => pane.cancelGesture?.())
    return pane
  }
  function show(id) {
    const subject = roster().find(choice => choice.id === id); if (!subject || destroyed) return
    const existing = panes.find(pane => pane.subject?.id === id)
    if (existing) { activate(existing); return }
    // One real activity feed, re-scoped in its own window. No cloned listeners.
    const feed = usesFeed(subject) && panes.find(pane => usesFeed(pane.subject))
    if (feed) { activate(feed); mountSubject(feed, subject); return }
    for (const pane of panes) pane.maximized = false
    const pane = createPane({ maximized: layout === 'windows' && panes.length === 0 }); activate(pane); mountSubject(pane, subject)
  }
  function startNew() {
    const computerId = computerForNew(); if (!live || !computerId) return
    const id = `new:${nextId}`
    extras.set(id, { id, kind: 'agent', newChat: true, treeNode: true, computerId, agentId: null, label: 'New chat' }); show(id)
  }
  function arrange() {
    layout = 'windows'
    panes.filter(pane => !pane.minimized).forEach((pane, index) => { pane.maximized = false; pane.rect = initialChatWindow(area(), index); pane.z = ++topZ })
    if (current()) current().z = ++topZ
    paint()
  }
  function detachPanels() {
    if (layout === 'windows') return
    for (const pane of panes) {
      const rect = panelRect(pane)
      if (rect) pane.rect = fitChatWindow(rect, area())
    }
    layout = 'windows'
  }
  function setLayout(value) {
    if (value !== 'windows' && !PANEL_COUNTS[value]) return
    layout = value
    for (const pane of panes) pane.maximized = false
    if (layout !== 'windows') {
      const ordered = [current(), ...visible.map(id => panes.find(pane => pane.id === id)), ...panes]
        .filter((pane, index, all) => pane && all.indexOf(pane) === index)
      visible = ordered.slice(0, PANEL_COUNTS[layout]).map(pane => { pane.minimized = false; return pane.id })
      active ||= visible[0] || null
      // Only open existing conversations; changing layout never starts agents.
      while (visible.length < PANEL_COUNTS[layout]) {
        const subject = roster().find(choice => choice.kind === 'agent' && !choice.newChat
          && (!live || (choice.computerId && (choice.treeNode || choice.savedConversation)))
          && !panes.some(pane => pane.subject?.id === choice.id))
        if (!subject) break
        const pane = createPane()
        visible.push(pane.id); active ||= pane.id; mountSubject(pane, subject)
      }
    }
    paint(); notify()
  }
  function setReadingWidth(value) {
    widthMode = value === 'wide' ? 'wide' : 'narrow'
    paint()
  }
  function command(name, pane = current()) {
    if (!pane) return
    if (name === 'changes') pane.body.querySelector('.session-changes-toggle')?.click()
    if (name === 'actions') {
      if (pane.controller?.openActions) pane.controller.openActions()
      else pane.body.querySelector('[data-chat-actions]')?.click()
    }
    if (name === 'details') pane.controller?.openDetails?.()
  }

  // The command picker changes workspace state or opens the active chat's
  // existing controls. It never interprets arbitrary text as a shell command.
  const palette = make('div', 'home-chat-command-overlay'); palette.hidden = true
  const dialog = make('div', 'home-chat-command-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Workspace commands')
  const query = make('input', 'home-chat-command-query'); query.type = 'search'; query.placeholder = 'Find a command or conversation…'; query.setAttribute('aria-label', 'Find a workspace command')
  const results = make('div', 'home-chat-command-results'), footer = make('p', 'home-chat-command-help', '↑ ↓ to choose · Enter to run · Esc to close')
  dialog.append(query, results, footer); palette.appendChild(dialog); surface.appendChild(palette)
  let commandIndex = 0, shownCommands = [], commandReturnFocus = null
  const closeCommands = () => {
    palette.hidden = true; commandsButton.setAttribute('aria-expanded','false')
    const target = commandReturnFocus?.isConnected && commandReturnFocus.checkVisibility?.() ? commandReturnFocus : commandsButton
    target.focus()
  }
  function entries() {
    const pane = current()
    return [
      ...(live && computerForNew() ? [{label:'New chat in a new window',run:startNew}] : []),
      ...(panes.length && !compact() ? [{label:'Arrange windows',run:arrange}] : []),
      ...[['single','Single panel'],['double','Double panels'],['four','Four panels'],['windows','Movable windows']]
        .map(([value,label]) => ({ label, run: () => setLayout(value) })),
      ...(pane ? [
        ...(!compact() ? [{label:pane.maximized?'Restore window size':'Maximize this window',run:()=>toggleMaximize(pane)}] : []),
        {label:'Minimize this window',run:()=>pane.minimizeButton.click()},
        {label:'Close this window',run:()=>closePane(pane)},
        {label:'Find in this window',run:()=>onFind?.()},
        {label:'Go to latest message or activity',run:()=>onLatest?.()},
        ...(pane.controller?.start ? [{label:'Start this agent',disabled:!pane.controller.canStart?.(),reason:pane.controller.startUnavailableReason?.(),run:()=>pane.controller.start()}] : []),
        ...(pane.body.querySelector('.session-changes-toggle') ? [{label:'Review changes',run:()=>command('changes')}] : []),
        ...(pane.controller?.openActions || pane.body.querySelector('[data-chat-actions]') ? [{label:'Chat actions',run:()=>command('actions')}] : []),
        ...(pane.controller?.openDetails ? [{label:'Chat details and controls',run:()=>command('details')}] : []),
      ] : []),
      ...roster().filter(choice=>!choice.newChat).map(choice=>({label:(panes.some(pane=>pane.subject?.id===choice.id)?'Focus ':'Open ')+choice.label,run:()=>show(choice.id)})),
    ]
  }
  function paintCommands() {
    const hadResultFocus = results.contains(doc.activeElement)
    const needle = query.value.trim().toLocaleLowerCase()
    shownCommands = entries().filter(entry => entry.label.toLocaleLowerCase().includes(needle)); commandIndex = Math.min(commandIndex, Math.max(0,shownCommands.length-1))
    if (!shownCommands[commandIndex] || shownCommands[commandIndex].disabled) commandIndex = shownCommands.findIndex(entry => !entry.disabled)
    results.replaceChildren()
    shownCommands.forEach((entry,index) => {
      const button = make('button','home-chat-command-row'); button.type='button'; button.dataset.selected=String(index===commandIndex)
      button.appendChild(make('span','home-chat-command-label',entry.label))
      if (entry.disabled && entry.reason) button.appendChild(make('small','home-chat-command-reason',entry.reason))
      if (index === commandIndex) button.setAttribute('aria-current','true')
      button.disabled = Boolean(entry.disabled); if (entry.reason) button.title = entry.reason
      button.addEventListener('focus',()=>{
        commandIndex=index
        for(const [rowIndex,row] of [...results.children].entries()){
          row.dataset.selected=String(rowIndex===index)
          if(rowIndex===index)row.setAttribute('aria-current','true');else row.removeAttribute('aria-current')
        }
      })
      button.addEventListener('click',()=>{if (!entry.disabled) { closeCommands();entry.run() }}); results.appendChild(button)
    })
    if (!shownCommands.length) results.appendChild(make('p','home-chat-command-note','No matching commands.'))
    if (hadResultFocus) (results.children[commandIndex] || query).focus()
  }
  function openCommands() { commandReturnFocus=doc.activeElement;commandIndex=0;query.value='';palette.hidden=false;commandsButton.setAttribute('aria-expanded','true');paintCommands();query.focus() }
  on(query,'input',()=>{commandIndex=0;paintCommands()})
  on(palette,'click',event=>{if(event.target===palette)closeCommands()})

  on(newButton, 'click', startNew); on(arrangeButton, 'click', arrange)
  on(layoutSelect, 'change', () => setLayout(layoutSelect.value))
  on(commandsButton, 'click', () => palette.hidden ? openCommands() : closeCommands())
  const observer = new ResizeObserver(() => paint())
  observer.observe(root); handlers.push(() => observer.disconnect())
  for (const choice of restored.extras || []) extras.set(choice.id, choice)
  if (Array.isArray(restored.windows)) {
    for (const saved of restored.windows) {
      const subject = roster().find(choice => choice.id === saved.subjectId)
      if (!subject || panes.some(pane => pane.subject?.id === subject.id || (usesFeed(subject) && usesFeed(pane.subject)))) continue
      mountSubject(createPane(saved), subject)
    }
    visible = Array.isArray(restored.visible) ? restored.visible.slice() : []
    active = panes.find(pane => pane.id === restored.active && !pane.minimized)?.id || null
    if (!active) chooseNext()
  } else show(subjectId || defaultSubjectId(roster()))
  paint(); notify()
  return {
    show, setLayout, setReadingWidth, openConversation(subject) {
      if (subject && typeof subject === 'object') {
        extras.set(subject.id, subject); show(subject.id)
      } else show(subject)
    }, newChat: startNew, openCommands,
    get subject() { return current()?.subject },
    /* The subjects opened beyond the picker's own list (New chat windows and
       adopted agents), so the page's picker offers only what can still open. */
    get extraSubjectIds() { return [...extras.keys()] },
    get activeHost() { return current()?.body || emptyNote },
    cancelNewChat(body) { const pane = panes.find(item => item.body === body); if (pane?.subject?.newChat) closePane(pane) },
    /* Close every window showing this agent: it was removed (T1562). */
    closeAgent(computerId, agentId) {
      for (const pane of panes.filter(item => item.subject?.kind === 'agent' && item.subject.agentId === agentId
        && (!computerId || !item.subject.computerId || item.subject.computerId === computerId))) closePane(pane)
      for (const [id, choice] of extras) if (choice.agentId === agentId) extras.delete(id)
    },
    attachController(body, controller) {
      const pane = panes.find(item => item.body === body)
      if (!pane || destroyed) return
      pane.controller = controller; paint()
      if (pane.id === active && pane.subject?.newChat) controller.focus?.()
    },
    adoptSubject(body, subject) {
      const pane = panes.find(item => item.body === body)
      if (!pane || destroyed) return
      if (pane.subject?.newChat) extras.delete(pane.subject.id)
      extras.set(subject.id, subject); mountSubject(pane, subject)
    },
    updateChoices(next) {
      if (destroyed) return
      list = Array.isArray(next) ? next : []
      for (const pane of panes) {
        const subject = roster().find(choice => choice.id === pane.subject?.id)
        if (subject) { pane.subject = subject; pane.mount?.updateChoices(roster()) }
      }
      paint(); notify()
    },

    keydown(event){
      if(!palette.hidden){
        if(event.key==='Escape'){event.preventDefault();closeCommands();return true}
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){
          event.preventDefault()
          const enabled = shownCommands.map((entry,index)=>entry.disabled?-1:index).filter(index=>index>=0)
          if(enabled.length){const at=enabled.indexOf(commandIndex);commandIndex=enabled[(at+(event.key==='ArrowDown'?1:enabled.length-1))%enabled.length]}
          paintCommands();results.children[commandIndex]?.scrollIntoView({block:'nearest'});return true
        }
        if(event.key==='Enter'&&event.target===query){event.preventDefault();const entry=shownCommands[commandIndex];if(entry&&!entry.disabled){closeCommands();entry.run()}return true}
        if(event.key==='Tab'){const stops=[query,...results.querySelectorAll('button:not(:disabled)')];const first=stops[0],last=stops.at(-1);if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first.focus()}return true}
        return true
      }
      if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='p'){event.preventDefault();openCommands();return true}
      if ((event.ctrlKey || event.metaKey) && ['PageDown','PageUp'].includes(event.key) && panes.length) {
        event.preventDefault()
        const at = panes.indexOf(current())
        activate(panes[(at+(event.key==='PageDown'?1:panes.length-1))%panes.length],{focus:true});return true
      }
      return false
    },

    destroy() {
      if (destroyed) return
      persist(); destroyed = true
      for (const off of handlers) off()
      for (const pane of panes) {
        for (const off of pane.handlers) off()
        const mount = pane.mount; pane.mount = null; mount?.destroy()
      }
      palette.remove(); tabs.replaceChildren(); root.remove()
    },
  }
}
