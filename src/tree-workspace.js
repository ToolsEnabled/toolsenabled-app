import { el } from './components.js'
import { paintRoleColor } from './role-colors.js'
import { mountStandaloneAgent, standaloneStartChoices, defaultStandaloneStart } from './tree-standalone-agent.js'
import { placeStandaloneAgent } from './tree-standalone-placement.js'
import { textZoom } from './text-size.js'

const STANDALONE_NOTICE_KEY = 'mc.tree.standalone-notice.v1'
const STANDALONE_DRAG_TYPE = 'application/x-toolsenabled-standalone-agent'
/* A CONFIRMATION FADES; A REFUSAL WAITS FOR THE NEXT ATTEMPT. The same seven
   seconds the canvas status line gives a non-sticky 'ok' (setOrgStatus in
   src/views/computers.js), so "Agent added to the tree." cannot outlive the
   agent it reports on (T1413). */
export const CONFIRMATION_FADE_MS = 7000
const standaloneByDocument = new WeakMap()

function retainedStandalone(graph) {
  const key = graph.standaloneAgent?.persistenceKey
  if (typeof key !== 'string' || !key) return null
  const document = graph.zoomHost.ownerDocument
  let scopes = standaloneByDocument.get(document)
  if (!scopes) { scopes = new Map(); standaloneByDocument.set(document, scopes) }
  const scope = JSON.stringify([key, graph.computer.id, !!graph.standaloneAgent.live])
  if (!scopes.has(scope)) scopes.set(scope, new Map())
  return scopes.get(scope)
}

function standalonePlaced(record, nodeId) {
  record.treeNodeId = nodeId
  const owner = record.workspace
  owner?._mountStandaloneDraft(record, nodeId)
  // Adoption can acknowledge after navigation. Transfer the draft and native
  // custody to the tree before releasing a surface bound to the departed view.
  if (!owner || record.placementOriginGone) {
    if (owner) owner.close(record, { focus: false, acknowledged: true })
    else {
      record.parkedDraftSink?.(nodeId, record.session)?.()
      record.retained?.delete(record.id)
      record.session.dispose()
      record.chatPanel.remove()
    }
    record.parkedDraftSink = null
  }
}

export const treeCamera = graph => Object.fromEntries([
  'zoom', 'panX', 'panY', '_fitFloor', '_viewSteered', '_autoFitted', '_scopeExitZoom',
].map(key => [key, graph[key]]).concat([['_scopeHistory', [...(graph._scopeHistory || [])]]]))

// Tree sets and conversations share one tab strip. Chats keep their mounted
// composers, attachments and subscriptions while the visible tree set changes.
export class TreeWorkspace {
  constructor(graph) {
    this.graph = graph
    this.mode = 'trees'
    this.standalone = new Map()
    this.retainedStandalone = retainedStandalone(graph)
    this.root = el(`<section class="tree-workspace" aria-label="Tree workspace">
      <div class="tree-workspace-tabs-bar">
        <div class="tree-chat-tabs" role="tablist" aria-label="Trees and agent chats">
          <button type="button" class="tree-chat-tab tree-home-tab" role="tab" aria-selected="true">Trees</button>
        </div>
        <button type="button" class="tree-chat-add" aria-label="New tree or agent" aria-expanded="false" title="New tree or agent">+</button>
      </div>
      <div class="tree-chat-chooser" hidden>
        <button type="button" class="tree-new-tree tree-new-workspace-action"><b>New tree</b><small>Add a tree to this computer</small></button>
        <button type="button" class="tree-new-agent tree-new-workspace-action"><b>New agent</b><small>A standalone agent chat</small></button>
        <div class="tree-agent-notice" hidden aria-label="Start a standalone agent">
          <strong>This agent won’t appear on the tree</strong>
          <p>It opens in its own chat tab and stays open while you use other pages. Add it to a tree to keep it across app restarts.</p>
          <label class="tree-agent-spawn-field"><span>Program and model</span>
            <select class="tree-agent-spawn-select" data-spawn-field="tier">
              <option value="astra">GPT-6-Astra</option>
              <option value="luna">Luna</option>
              <option value="terra">Terra</option>
              <option value="sol">Sol</option>
              <option value="claude-fable">Fable</option>
              <option value="claude-sonnet">Sonnet</option>
              <option value="claude-opus">Opus</option>
              <option value="local">Local</option>
            </select></label>
          <label class="tree-agent-spawn-field"><span>Effort</span>
            <select class="tree-agent-spawn-select" data-spawn-field="effort">
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
              <option value="ultra">ultra</option>
            </select></label>
          <div class="tree-agent-notice-actions">
            <button type="button" class="tree-agent-continue">Open agent tab</button>
            <button type="button" class="tree-agent-cancel">Cancel</button>
          </div>
        </div>
        <span class="tree-picker-label">Agent chat</span>
        <input type="search" class="tree-chat-picker" aria-label="Find an agent" placeholder="Find an agent…" autocomplete="off">
        <div class="tree-chat-options" aria-label="Choose an agent"></div>
      </div>
      <p class="tree-standalone-placement-status" role="status" hidden></p>
      <div class="tree-workspace-body">
        <section class="tree-workspace-chat" hidden>
          <header class="tree-workspace-chat-header">
            <div><span class="tree-preview-label">Agent conversation</span><strong class="tree-chat-heading"></strong></div>
            <span class="tree-chat-header-actions">
              <button type="button" class="tree-standalone-place" hidden>Add to tree</button>
              <button type="button" class="tree-preview-pin">+ Keep in tab</button>
              <button type="button" class="tree-preview-close" aria-label="Close conversation view">Back to trees <span aria-hidden="true">×</span></button>
            </span>
          </header>
          <div class="tree-conversation-track"></div>
        </section>
      </div>
    </section>`)
    graph.chatShelf = this.root
    graph.chatTabs = this.root.querySelector('.tree-chat-tabs')
    graph.chatPicker = this.root.querySelector('.tree-chat-picker')
    graph.chatChooser = this.root.querySelector('.tree-chat-chooser')
    graph.chatTrack = this.root.querySelector('.tree-conversation-track')
    this.home = this.root.querySelector('.tree-home-tab')
    this.body = this.root.querySelector('.tree-workspace-body')
    this.chatView = this.root.querySelector('.tree-workspace-chat')
    this.home.id = `tree-tab-${graph.computer.id}`
    graph.zoomHost.id = `tree-panel-${graph.computer.id}`
    this.home.setAttribute('aria-controls', graph.zoomHost.id)
    graph.zoomHost.setAttribute('role', 'tabpanel')
    graph.zoomHost.setAttribute('aria-labelledby', this.home.id)
    graph.zoomHost.before(this.root)
    this.body.prepend(graph.zoomHost)
    this.home.addEventListener('click', () => this.showTrees())
    const headerAdd = this.root.querySelector('.tree-chat-add')
    this.newTreeDropTarget = { id: 'empty:new-tree', kind: 'new-tree', parentId: null, el: headerAdd }
    const newTree = event => {
      this.showTrees({ focus: false })
      graph._pressEmptySlot(this.newTreeDropTarget, event.detail === 0 ? 'keyboard' : 'pointer')
    }
    this.root.querySelector('.tree-new-tree').addEventListener('click', newTree)
    /* ONE POP-UP, TWO DOORS. `+ / New agent` opens it to choose what to
       spawn; a mounted agent's chip opens the same panel to change what it
       runs on. Drawing a second chooser on the chat is the control the inline
       selects were removed for, and two menus answering one question is how
       they drift. `apply` is what the confirm button calls, so the two doors
       differ only in what happens after the person presses it. */
    this._spawnApply = null
    /* The role/aria-modal half of hiding the notice, alongside `hidden` at
       every close door -- see openSpawnChooser's own note on why the pair
       travels together rather than living in the template. */
    this.closeSpawnChooser = () => {
      const notice = this.root.querySelector('.tree-agent-notice')
      notice.removeAttribute('role')
      notice.removeAttribute('aria-modal')
      notice.hidden = true
    }
    this.openSpawnChooser = ({ start = null, apply = null } = {}) => {
      const notice = this.root.querySelector('.tree-agent-notice')
      const opening = start || defaultStandaloneStart()
      const tier = notice.querySelector('[data-spawn-field=tier]')
      const effort = notice.querySelector('[data-spawn-field=effort]')
      if (tier && opening) tier.value = opening.tier
      if (effort && opening?.effort) effort.value = opening.effort
      this._fillSpawnTiers(opening?.tier)
      const refresh = this.graph.standaloneAgent?.refreshTierChoices
      if (typeof refresh === 'function') {
        const touched = { value: false }
        tier?.addEventListener('change', () => { touched.value = true }, { once: true })
        Promise.resolve().then(() => refresh()).then(() => {
          if (!this._destroyed && !notice.hidden && !touched.value) this._fillSpawnTiers(opening?.tier)
        }, () => {})
      }
      this._spawnApply = typeof apply === 'function' ? apply : null
      /* role/aria-modal ride WITH hidden, not baked into the template: a
         role="dialog" with aria-modal left sitting on a hidden element is
         announced to a screen reader as though it were open (the exact
         mistake src/views/settings.js's openCloudMirrorSetup note and
         owner-popup.js both already carry). */
      notice.setAttribute('role', 'dialog')
      notice.setAttribute('aria-modal', 'true')
      notice.hidden = false
      tier?.focus()
    }
    this.root.querySelector('.tree-new-agent').addEventListener('click', () => {
      /* ALWAYS THE CHOOSER. It used to skip to a chat once the notice had
         been seen, which left a person with a conversation they never chose
         a program for -- the owner, 2026-09-17: "Give it a pop up menu to
         select what to spawn". The explanation below it is still shown once;
         the choice is asked every time, because it is a different answer
         every time. */
      this.openSpawnChooser()
    })
    const spawnTier = () => this.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
    const spawnEffort = () => this.root.querySelector('.tree-agent-notice [data-spawn-field=effort]')
    spawnTier()?.addEventListener('change', () => {
      const row = standaloneStartChoices().tiers.find(choice => choice.id === spawnTier().value)
      const select = spawnEffort()
      if (select) select.value = row?.effort || 'medium'
    })
    this.root.querySelector('.tree-agent-continue').addEventListener('click', () => {
      try { localStorage.setItem(STANDALONE_NOTICE_KEY, 'true') } catch { /* the tab can still open */ }
      this.closeSpawnChooser()
      const picked = { tier: spawnTier()?.value, effort: spawnEffort()?.value }
      const apply = this._spawnApply
      this._spawnApply = null
      if (apply) apply(picked); else this.openStandalone(picked)
    })
    this.root.querySelector('.tree-agent-cancel').addEventListener('click', () => {
      this.closeSpawnChooser()
      this._spawnApply = null
      this.root.querySelector('.tree-new-agent').focus()
    })
    headerAdd.addEventListener('click', event => {
      if (graph.editMode) newTree(event)
      else this.showPicker(graph.chatChooser.hidden)
    })
    graph._bindStandaloneDrop(headerAdd, this.newTreeDropTarget)
    this.root.querySelector('.tree-preview-close').addEventListener('click', () => this.showTrees())
    this.root.querySelector('.tree-standalone-place').addEventListener('click', () => this.showPlacementPicker(this.record(this.graph.activeChatId)))
    this.root.querySelector('.tree-preview-pin').addEventListener('click', () => {
      const record = graph.nodes.get(graph.activeChatId)
      if (record) { record.chatPinned = true; this.mode = 'chat'; this.sync(); this.focusTab(record.id) }
    })
    graph.chatPicker.addEventListener('input', () => graph._renderChatChoices())
    graph.chatPicker.addEventListener('keydown', event => {
      if (!['ArrowDown', 'Enter'].includes(event.key)) return
      event.preventDefault()
      const first = graph.chatChooser.querySelector('.tree-chat-options button')
      if (event.key === 'Enter') first?.click()
      else first?.focus()
    })
    graph.chatChooser.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target === graph.chatPicker) return
      const options = [...graph.chatChooser.querySelectorAll('button')].filter(button => !button.closest('[hidden]'))
      const index = options.indexOf(event.target.closest('button'))
      if (index < 0) return
      event.preventDefault()
      options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
    })
    this.onOutside = event => {
      if (!graph.chatChooser.hidden && !graph.chatChooser.contains(event.target)
        && !event.target.closest('.tree-chat-add')) this.showPicker(false)
    }
    this.root.ownerDocument.addEventListener('pointerdown', this.onOutside)
    this.root.addEventListener('keydown', event => this.keydown(event))
    for (const record of this.retainedStandalone?.values() || []) {
      record.workspace = this
      record.parkedDraftSink = null
      this.standalone.set(record.id, record)
      graph.chatTrack.appendChild(record.chatPanel)
    }
    if (this.standalone.size) this.sync()
  }

  prepare(record, { pinned = true } = {}) {
    if (this.previewId && this.previewId !== record.id) {
      const previous = this.graph.nodes.get(this.previewId)
      if (previous?.chatOpen && !previous.chatPinned) this.close(previous, { focus: false })
    }
    record.chatPinned ||= pinned
    this.previewId = pinned ? null : record.id
    this.mode = pinned ? 'chat' : 'preview'
    this.graph.activeChatId = record.id
  }

  preview(record) { this.graph.openChat(record, { pinned: false }) }

  records() { return [...this.graph.nodes.values(), ...this.standalone.values()] }

  record(id) { return this.standalone.get(id) || this.recordForNode(id) || this.graph.nodes.get(id) }

  recordForNode(id) { return [...this.standalone.values()].find(record => record.chatOpen && record.treeNodeId === id) || null }

  _mountStandaloneDraft(record, nodeId) {
    if (!record || !nodeId || record.draftNodeId === nodeId) return
    record.releaseDraft?.()
    record.draftNodeId = nodeId
    record.releaseDraft = this.graph.onMountChatDraft?.(nodeId, record.session) || (() => {
      const draft = record.session.exportDraft?.()
      if (draft) this.graph.chatDrafts.set(nodeId, draft)
      else this.graph.chatDrafts.delete(nodeId)
    })
    // A host ACK can arrive after the page went away. The acknowledged node
    // still owns the draft, so finish its handoff before the session releases.
    if (this._destroyed) { record.releaseDraft(); record.releaseDraft = null }
  }

  async placeStandalone(recordOrId, parentId = null) {
    const record = typeof recordOrId === 'string' ? this.record(recordOrId) : recordOrId
    if (record?.placementPending) return { ok: false, sentence: 'This agent is already being added to a tree.' }
    if (record) record.placementOriginGone = false
    const operation = placeStandaloneAgent(this.graph, record, parentId)
    if (record?.placementPending) this.placementStatus(`Adding ${record.agent.name} to the tree…`)
    this.sync()
    const result = await operation
    if (record?.workspace && record.workspace !== this) record.workspace.sync()
    if (this._destroyed || this.graph._destroyed || !record || this.standalone.get(record.id) !== record) return result
    this.placementStatus(result.sentence, !result.ok, 'placement', { fade: result.ok === true })
    if (result.ok && this.placementPopover?.record === record) this.hidePlacementPicker()
    else if (this.placementPopover?.record === record) {
      const error = this.placementPopover.querySelector('.tree-standalone-place-error')
      error.textContent = result.sentence; error.hidden = false
    }
    this.sync()
    return result
  }

  /* THE NEW AGENT CHOOSER READS THE SAME ANSWER AS THE START PANEL (T1370).
     The fixed template list offered every program with no install state and
     preselected GPT-6-Astra, so a fresh computer opened a tab that was
     "unavailable · Codex is not installed". With the host's rows, a program
     that is not installed (or cannot start here) is shown with its reason and
     cannot be picked, and the preselected row is one that can start. The
     template stays the answer where no host rows exist (browser preview). */
  _fillSpawnTiers(preferred = null) {
    const select = this.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
    let rows = null
    try { rows = this.graph.standaloneAgent?.tierChoices?.() } catch { rows = null }
    if (!select || !Array.isArray(rows)) return
    const solo = new Map(standaloneStartChoices().tiers.map(choice => [choice.id, choice]))
    const usable = rows.filter(row => row && solo.has(row.id))
    if (!usable.length) return
    const current = select.value
    select.replaceChildren(...usable.map(row => {
      const option = document.createElement('option')
      option.value = row.id
      option.textContent = row.label || solo.get(row.id).label
      option.disabled = row.enabled === false
      return option
    }))
    const can = id => usable.some(row => row.id === id && row.enabled !== false)
    const pick = [preferred, current].find(id => id && can(id)) || usable.find(row => row.enabled !== false)?.id || usable[0].id
    select.value = pick
    const effort = this.root.querySelector('.tree-agent-notice [data-spawn-field=effort]')
    if (effort && pick !== preferred) effort.value = solo.get(pick)?.effort || 'medium'
  }

  placementStatus(sentence, failed = false, kind = 'placement', { fade = false } = {}) {
    clearTimeout(this.placementStatusTimer)
    this.placementStatusTimer = 0
    const status = this.root.querySelector('.tree-standalone-placement-status')
    status.textContent = sentence || ''
    status.hidden = !sentence
    status.classList.toggle('is-error', failed)
    this.placementStatusKind = kind
    if (sentence && fade && !failed) {
      this.placementStatusTimer = setTimeout(() => {
        this.placementStatusTimer = 0
        if (!this._destroyed && status.textContent === sentence) this.placementStatus('')
      }, this.confirmationFadeMs ?? CONFIRMATION_FADE_MS)
    }
  }

  showPlacementPicker(record) {
    if (!record?.standalone || record.treeNodeId || record.placementPending || this.graph.editMode || this.graph._linkMode) return
    this.hidePlacementPicker()
    const picker = el(`<section class="tree-standalone-placement" popover="auto" role="dialog" aria-label="Add agent to tree" tabindex="-1">
      <header><strong>Add to tree</strong><button type="button" class="tree-standalone-place-dismiss" aria-label="Close placement options">×</button></header>
      <p class="tree-standalone-place-name"></p>
      <label>Destination<select class="tree-standalone-parent" aria-label="Destination for this agent"></select></label>
      <p class="tree-standalone-place-note">Your current chat stays open.</p>
      <p class="tree-standalone-place-error" role="alert" hidden></p>
      <footer><button type="button" class="tree-standalone-place-cancel">Cancel</button><button type="button" class="tree-standalone-place-confirm">Place agent</button></footer>
    </section>`)
    picker.record = record
    picker.querySelector('.tree-standalone-place-name').textContent = record.agent.name
    const select = picker.querySelector('select'), option = (value, label) => {
      const item = document.createElement('option'); item.value = value; item.textContent = label; select.appendChild(item)
    }
    option('', 'New tree — this agent is the head')
    const trees = this.graph.treeWindows?.getTrees() || []
    const model = this.graph._scopeModel()
    for (const agent of this.graph.computer?.agents || []) {
      if (!agent.treeNode || agent.treeScope?.group || this.graph._canExtend?.(agent) === false) continue
      const head = model.ancestry(agent.id)[0]
      const tree = trees.find(tree => tree.rootId === head?.id)
      option(agent.id, `${agent.name} — ${tree?.name || head?.name || 'Tree'}`)
    }
    const close = () => this.hidePlacementPicker({ focus: true })
    picker.querySelector('.tree-standalone-place-dismiss').addEventListener('click', close)
    picker.querySelector('.tree-standalone-place-cancel').addEventListener('click', close)
    picker.querySelector('.tree-standalone-place-confirm').addEventListener('click', () => { void this.placeStandalone(record, select.value || null) })
    picker.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    })
    picker.addEventListener('toggle', event => { if (event.newState === 'closed' && this.placementPopover === picker) this.hidePlacementPicker() })
    this.placementPopover = picker
    this.root.appendChild(picker)
    const rect = this.root.querySelector('.tree-standalone-place').getBoundingClientRect(), zoom = textZoom(this.root.ownerDocument)
    picker.style.setProperty('--placement-x', `${rect.right / zoom - 360}px`)
    picker.style.setProperty('--placement-y', `${rect.bottom / zoom + 8}px`)
    picker.showPopover()
    select.focus({ preventScroll: true })
  }

  hidePlacementPicker({ focus = false } = {}) {
    this.placementPopover?.remove()
    this.placementPopover = null
    if (focus) this.root.querySelector('.tree-standalone-place').focus({ preventScroll: true })
  }

  startStandaloneDrag(event, record, tab) {
    if (!record.standalone || record.treeNodeId || record.placementPending || this.graph.editMode || this.graph._linkMode || !event.dataTransfer) {
      event.preventDefault(); return
    }
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(STANDALONE_DRAG_TYPE, JSON.stringify({ id: record.id, computerId: this.graph.computer.id }))
    this.draggedStandaloneId = record.id
    tab.classList.add('is-placing-agent')
    this.standaloneDragFrame = requestAnimationFrame(() => {
      this.standaloneDragFrame = 0
      if (this.graph._destroyed || this.draggedStandaloneId !== record.id) return
      this.showTrees({ focus: false })
      this.root.classList.add('is-standalone-dragging')
      this.root.querySelector('.tree-chat-add').classList.add('standalone-drop-target')
      for (const frame of this.graph.treeWindows?.windows || [{ graph: this.graph }]) {
        for (const slot of frame.graph.emptySlots.values()) if (!slot.hidden) slot.el.classList.add('standalone-drop-target')
        for (const node of frame.graph.nodes.values()) {
          const add = node.el.querySelector('.tree-box-add-agent')
          if (add && !add.hidden && !node.el.hidden && frame.graph._layoutVisibleIds.has(node.id)) add.classList.add('standalone-drop-target')
        }
      }
      this.placementStatus(`Drop ${record.agent.name} on a tree's + to add it there, or on the + next to Trees for a new tree.`, false, 'drag')
    })
  }

  clearStandaloneDrag() {
    if (this.standaloneDragFrame) cancelAnimationFrame(this.standaloneDragFrame)
    this.standaloneDragFrame = 0
    const wasDragging = !!this.draggedStandaloneId
    this.draggedStandaloneId = null
    this.root.classList.remove('is-standalone-dragging')
    for (const node of this.root.querySelectorAll('.is-placing-agent')) node.classList.remove('is-placing-agent')
    for (const node of this.root.querySelectorAll('.standalone-drop-target')) node.classList.remove('standalone-drop-target')
    if (wasDragging && this.placementStatusKind === 'drag') this.placementStatus('')
  }

  async openStandalone(start = null) {
    if (this._destroyed || this.graph._destroyed || this.graph.editMode) return
    this.showPicker(false)
    let number = 1
    while ([...this.standalone.values()].some(record => record.agent.name === `Agent ${number}`)) number++
    /* A HYPHEN, NOT A COLON, and it is not cosmetic. shell/agent-command-surface.cjs
       'org:ensure-seat' bounds a seat id the same way every declared agent id
       is bounded, and a colon is not in that set -- so `standalone:<uuid>` was
       refused MC_AGENT_SEAT_ID_INVALID every single time. Since a seat refusal
       is deliberately not fatal, the tab opened anyway and nothing said a word:
       every + agent ever opened was undeclared, which is exactly why the App
       permissions roster kept showing it as a raw session id with no way to
       grant it computer control. Found by calling this page's own declareSeat
       on a built candidate, not by reading. */
    const id = `standalone-${crypto.randomUUID()}`, name = `Agent ${number}`
    const panel = el('<section class="tree-conversation tree-standalone-conversation" tabindex="-1"></section>')
    this.graph.chatTrack.appendChild(panel)
    let record
    /* THE SEAT IS DECLARED BEFORE THE CHAT EXISTS, so the conversation that
       opens is already an agent with a name and an enabled role: the App
       permissions roster can list it, and computer control can be granted to
       it. A host that cannot declare one (no Role library on this page) still
       gets its chat -- the seat is what unlocks the roster, not what unlocks
       the conversation, and refusing to open a tab over it would take away
       more than it protects. */
    const declare = this.graph.standaloneAgent?.declareSeat
    const seat = typeof declare === 'function'
      ? await declare({ id, name, tier: start?.tier || null }).catch(() => null)
      : null
    // Registration can finish after navigation or after entering Edit mode.
    // No chat exists yet, so a stale request must not acquire retained custody.
    if (this._destroyed || this.graph._destroyed || this.graph.editMode) {
      panel.remove()
      return
    }
    const session = mountStandaloneAgent(panel, { id, name, ...this.graph.standaloneAgent, start,
      seat: seat && seat.ok !== false ? seat : null,
      /* The chip's door. The agent says what it is on; this panel owns the
         menu that changes it, and the agent decides what the answer means. */
      onChangeStart: (current, apply) => this.openSpawnChooser({ start: current, apply }),
      onPlaced: nodeId => standalonePlaced(record, nodeId) })
    record = { id, agent: { id, name, role: 'default' }, standalone: true,
      chatPanel: panel, chatRoot: panel, chatOpen: true, chatPinned: true, session,
      workspace: this, retained: this.retainedStandalone }
    this.standalone.set(id, record)
    this.retainedStandalone?.set(id, record)
    this.mode = 'chat'
    this.graph.activeChatId = id
    this.sync()
    session.focus()
  }

  showTrees({ focus = true } = {}) {
    this.hidePlacementPicker()
    this.mode = 'trees'
    this.showPicker(false)
    this.sync()
    if (focus) this.activeTreeTab().focus({ preventScroll: true })
  }

  activeTreeTab() {
    const id = this.graph.treeWindows?.activeId
    return [...this.graph.chatTabs.querySelectorAll('[data-workspace-id]')].find(tab => tab.dataset.workspaceId === id) || this.home
  }

  syncTreeTabs(board = this.graph.treeWindows) {
    if (!board) return
    const first = board.workspaces[0]
    this.home.dataset.workspaceId = first.id
    this.home.setAttribute('aria-controls', board.grid.id || (board.grid.id = `tree-windows-${this.graph.computer.id}`))
    this.graph.zoomHost.removeAttribute('role')
    this.graph.zoomHost.removeAttribute('aria-labelledby')
    this.home.onclick = () => board.activate(first.id)
    for (const wrapper of this.graph.chatTabs.querySelectorAll('.tree-set-tab-wrap')) wrapper.remove()
    for (const tab of this.graph.chatTabs.querySelectorAll('[data-workspace-id]')) {
      const selected = this.mode === 'trees' && tab.dataset.workspaceId === board.activeId
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      tab.parentElement.classList.toggle('is-active', selected && tab !== this.home)
    }
    board.grid.setAttribute('role', 'tabpanel')
    board.grid.setAttribute('aria-labelledby', this.activeTreeTab().id)
  }

  showPicker(show = true) {
    const graph = this.graph
    if (show && graph.editMode) return
    graph.chatChooser.hidden = !show
    this.closeSpawnChooser()
    this.root.querySelector('.tree-chat-add').setAttribute('aria-expanded', String(show))
    if (show) {
      graph.chatPicker.value = ''
      graph._renderChatChoices()
      this.root.querySelector('.tree-new-tree').focus({ preventScroll: true })
    }
  }

  syncEditing() {
    const editing = !!this.graph.editMode
    // Keep the header + reachable for branch drops and keyboard creation in
    // Edit. Switching trees or chats still waits until editing ends.
    const tabs = this.graph.chatTabs
    tabs.inert = editing
    tabs.setAttribute('aria-hidden', String(editing))
    const add = this.newTreeDropTarget.el
    const label = editing ? 'New tree' : 'New tree or agent'
    add.setAttribute('aria-label', label)
    add.title = label
    if (editing) this.showPicker(false)
    if (editing) { this.hidePlacementPicker(); this.clearStandaloneDrag() }
  }

  sync() {
    const graph = this.graph
    for (const record of this.standalone.values()) {
      const placed = record.treeNodeId && graph._agentFor?.(record.treeNodeId)
      if (placed?.name && placed.name !== record.agent.name) {
        record.agent.name = placed.name
        record.session.setTitle?.(placed.name)
      }
    }
    const opened = this.records().filter(record => record.chatOpen)
    const pinned = opened.filter(record => record.chatPinned)
    const active = opened.find(record => record.id === graph.activeChatId)
    if (!active && this.mode !== 'trees') this.mode = 'trees'
    const showing = this.mode !== 'trees'
    if (showing !== !!this.wasShowing) {
      this.wasShowing = showing
      if (showing) {
        this.wideBefore = !!graph._treeWide
        this.treeSetBefore = graph.treeWindows?.activeId
        this.cameras = (graph.treeWindows?.windows || [{ graph }]).map(({ graph: view }) => ({ graph: view, rootId: view.rootId, camera: treeCamera(view) }))
        graph.setWide(true)
      } else {
        graph.setWide(!!this.wideBefore)
        if (this.cameras) {
          const cameras = this.cameras, treeSet = this.treeSetBefore
          requestAnimationFrame(() => {
            if (graph._destroyed || this.mode !== 'trees' || treeSet !== graph.treeWindows?.activeId) return
            for (const { graph: view, rootId, camera } of cameras) {
              if (view._destroyed || view.rootId !== rootId) continue
              view.resize()
              Object.assign(view, camera)
              view._applyZoom()
            }
          })
        }
      }
    }
    this.root.hidden = false
    this.root.classList.toggle('is-chat-view', showing)
    // Keep the canvas at its real dimensions while a conversation covers it.
    graph.zoomHost.inert = showing
    graph.zoomHost.setAttribute('aria-hidden', String(showing))
    if (graph.treeWindows) graph.treeWindows.grid.inert = showing
    this.chatView.hidden = !showing
    graph._chatFull = showing
    this.home.setAttribute('aria-selected', String(this.mode !== 'chat'))
    this.home.tabIndex = this.mode !== 'chat' ? 0 : -1
    this.syncTreeTabs()
    const ids = new Set(pinned.map(record => record.id))
    for (const tab of graph.chatTabs.querySelectorAll('.tree-chat-tab-wrap')) if (!ids.has(tab.dataset.agentId)) tab.remove()
    for (const record of pinned) {
      let wrapper = [...graph.chatTabs.children].find(child => child.dataset.agentId === record.id)
      if (!wrapper) {
        wrapper = el('<span class="tree-chat-tab-wrap" role="presentation"><button type="button" class="tree-chat-tab" role="tab"></button><button type="button" class="tree-chat-tab-close" tabindex="-1">×</button></span>')
        wrapper.dataset.agentId = record.id
        paintRoleColor(wrapper, record.agent.declaredRole || record.agent.role, record.agent.id)
        const tab = wrapper.querySelector('[role="tab"]')
        tab.dataset.agentId = record.id
        tab.id = `chat-tab-${graph.computer.id}-${record.id}`
        record.chatPanel.id = `chat-panel-${graph.computer.id}-${record.id}`
        tab.setAttribute('aria-controls', record.chatPanel.id)
        tab.addEventListener('click', () => {
          if (graph.editMode) return
          this.mode = 'chat'
          if (record.standalone) { graph.activeChatId = record.id; this.sync(); record.session.focus() }
          else graph._focusChat(record)
        })
        tab.addEventListener('dragstart', event => this.startStandaloneDrag(event, record, tab))
        tab.addEventListener('dragend', () => this.clearStandaloneDrag())
        wrapper.querySelector('.tree-chat-tab-close').addEventListener('click', () => { if (!graph.editMode) this.close(record) })
        graph.chatTabs.appendChild(wrapper)
      }
      const selected = this.mode === 'chat' && record.id === graph.activeChatId
      const tab = wrapper.querySelector('[role="tab"]')
      tab.textContent = record.agent.name
      tab.title = record.agent.name
      tab.draggable = !!record.standalone && !record.treeNodeId && !record.placementPending && !graph.editMode && !graph._linkMode
      tab.tabIndex = selected ? 0 : -1
      tab.setAttribute('aria-selected', String(selected))
      wrapper.classList.toggle('is-active', selected)
      wrapper.querySelector('.tree-chat-tab-close').setAttribute('aria-label', `Close ${record.agent.name} tab`)
      wrapper.querySelector('.tree-chat-tab-close').disabled = !!record.placementPending
    }
    for (const record of opened) {
      const selected = showing && record.id === graph.activeChatId
      record.chatPanel.hidden = !selected
      record.chatFull = selected
      record.chatPanel.classList.add('as-chat-full')
      record.chatPanel.setAttribute('role', 'tabpanel')
      if (record.chatPinned) record.chatPanel.setAttribute('aria-labelledby', `chat-tab-${graph.computer.id}-${record.id}`)
    }
    this.root.querySelector('.tree-chat-heading').textContent = active?.agent.name || ''
    this.root.querySelector('.tree-preview-label').textContent = active?.standalone && !active.treeNodeId ? 'Standalone agent · outside the tree' : this.mode === 'preview' ? 'Conversation preview' : 'Agent conversation'
    this.root.querySelector('.tree-preview-pin').hidden = this.mode !== 'preview' || !!active?.chatPinned
    const place = this.root.querySelector('.tree-standalone-place')
    place.hidden = !active?.standalone || !!active.treeNodeId
    place.disabled = !!active?.placementPending || !!graph.editMode || !!graph._linkMode
    place.textContent = active?.placementPending ? 'Adding to tree…' : 'Add to tree'
    if (this.placementPopover) {
      const pending = !!this.placementPopover.record.placementPending
      this.placementPopover.querySelector('.tree-standalone-place-confirm').disabled = pending
      this.placementPopover.querySelector('select').disabled = pending
    }
  }

  focusTab(id) {
    const tab = [...this.graph.chatTabs.querySelectorAll('[role="tab"]')].find(tab => tab.dataset.agentId === id)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    tab?.focus({ preventScroll: true })
  }

  close(record, { focus = true, acknowledged = false } = {}) {
    const graph = this.graph
    if (!record?.chatOpen) return
    if (record.placementPending && !acknowledged) return
    const pinned = [...graph.chatTabs.querySelectorAll('[role="tab"][data-agent-id]')]
      .map(tab => this.record(tab.dataset.agentId)).filter(other => other?.chatOpen && other.chatPinned)
    const index = pinned.indexOf(record)
    const wasActive = record.id === graph.activeChatId
    if (record.standalone && record.treeNodeId) this._mountStandaloneDraft(record, record.treeNodeId)
    record.releaseDraft?.()
    record.releaseDraft = null
    if (!graph.onMountChatDraft && !record.draftNodeId) {
      const draft = record.standalone ? record.session.exportDraft?.() : record.chatRoot?.exportDraft?.()
      if (draft) graph.chatDrafts.set(record.treeNodeId || record.id, draft)
      else graph.chatDrafts.delete(record.treeNodeId || record.id)
    }
    if (record.standalone) {
      /* Read before dispose: a tab that never sent and was never placed has
         nothing its seat still holds, so closing it releases the seat
         (T1365). A sent or placed agent keeps its seat and conversation. */
      const state = record.treeNodeId ? null : record.session.snapshot?.()
      const neverSent = Boolean(state) && !state.sessionId && state.phase === 'draft'
      this.retainedStandalone?.delete(record.id)
      record.workspace = null
      record.session.dispose()
      record.chatPanel.remove()
      this.standalone.delete(record.id)
      record.chatOpen = false
      const release = graph.standaloneAgent?.releaseSeat
      if (neverSent && typeof release === 'function') {
        try { void Promise.resolve(release({ id: record.id })).catch(() => {}) } catch { /* the tab is closed either way */ }
      }
    } else graph._disposeChat(record)
    record.chatPinned = false
    if (this.previewId === record.id) this.previewId = null
    if (wasActive) {
      graph.activeChatId = (pinned[index + 1] || pinned[index - 1])?.id || null
      this.mode = this.mode === 'chat' && graph.activeChatId ? 'chat' : 'trees'
    }
    this.sync()
    if (!record.standalone && !graph._layoutVisibleIds.has(record.id)) graph._removeRecord(record, false)
    if (wasActive && focus) this.mode === 'trees' ? this.activeTreeTab().focus({ preventScroll: true }) : this.focusTab(graph.activeChatId)
  }

  keydown(event) {
    const graph = this.graph
    if (graph.editMode) return
    if (event.defaultPrevented) return
    if (event.key === 'Escape' && graph._linkMode) {
      event.preventDefault()
      graph.setLinkMode(false)
      return
    }
    const tab = event.target.closest('[role="tab"]')
    const cycle = event.ctrlKey && ['PageUp', 'PageDown'].includes(event.key)
    if (cycle || (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))) {
      event.preventDefault()
      const tabs = [...graph.chatTabs.querySelectorAll('[role="tab"]')]
      const current = tabs.findIndex(item => item.getAttribute('aria-selected') === 'true')
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (current + (['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length
      tabs[index]?.click()
      tabs[index]?.focus({ preventScroll: true })
    } else if (tab && event.key === 'Delete' && (tab.dataset.agentId || tab.dataset.workspaceId)) {
      event.preventDefault()
      if (tab.dataset.agentId) this.close(this.record(tab.dataset.agentId))
      else graph.treeWindows?.closeWorkspace(tab.dataset.workspaceId)
    } else if (event.key === 'Escape' && !document.querySelector('.chat-actions-pop, .drawer.open, dialog[open]')) {
      event.preventDefault()
      if (!graph.chatChooser.hidden) { this.showPicker(false); this.root.querySelector('.tree-chat-add').focus() }
      else this.showTrees()
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    clearTimeout(this.placementStatusTimer)
    this.hidePlacementPicker()
    this.clearStandaloneDrag()
    for (const record of this.standalone.values()) {
      if (this.retainedStandalone && !record.treeNodeId) {
        record.workspace = null
        record.placementOriginGone ||= !!record.placementPending
        record.parkedDraftSink = record.placementPending ? this.graph.onMountChatDraft : null
        record.chatPanel.remove()
        continue
      }
      this.retainedStandalone?.delete(record.id)
      if (record.treeNodeId) this._mountStandaloneDraft(record, record.treeNodeId)
      record.releaseDraft?.()
      record.releaseDraft = null
      record.session.dispose()
    }
    this.standalone.clear()
    this.root.ownerDocument.removeEventListener('pointerdown', this.onOutside)
    this.root.before(this.graph.zoomHost)
    this.graph.zoomHost.inert = false
    this.graph.zoomHost.removeAttribute('aria-hidden')
    this.root.remove()
  }
}
