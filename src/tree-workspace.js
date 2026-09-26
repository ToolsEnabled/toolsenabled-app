import { el } from './components.js'
import { paintRoleColor } from './role-colors.js'
import { mountStandaloneAgent, standaloneStartChoices, defaultStandaloneStart, standaloneStartFrom, standaloneStartChangedSentence, STANDALONE_RESTORE_COPY } from './tree-standalone-agent.js'
import { PROVIDER_CHOICES, START_PANEL, effortChoicesFor, providerDefaultTier, tierChoicesFor, tierProvider } from './fleet-tree-copy.js'
import { offeredEffort } from './orchestration-controls.js'
import { placeStandaloneAgent } from './tree-standalone-placement.js'
import { textZoom } from './text-size.js'

const STANDALONE_NOTICE_KEY = 'mc.tree.standalone-notice.v1'
const STANDALONE_DRAG_TYPE = 'application/x-toolsenabled-standalone-agent'
/* A CONFIRMATION FADES; A REFUSAL WAITS FOR THE NEXT ATTEMPT. The same seven
   seconds the canvas status line gives a non-sticky 'ok' (setOrgStatus in
   src/views/computers.js), so "Agent added to the tree." cannot outlive the
   agent it reports on (T1413). */
export const CONFIRMATION_FADE_MS = 7000
/* WHAT THE NEW AGENT POP-UP PROMISES ABOUT A RESTART, and only when it is true
   (B4 review). A tab comes back only where this page keeps a list of open tabs
   (its own computer's trees) and "Delete agent nodes when the app exits" is
   off; the example and a relay computer keep none. Until the setting is read,
   nothing is promised either way. */
export const STANDALONE_NOTICE_COPY = Object.freeze({
  unknown: 'It opens in its own chat tab.',
  comesBack: 'It opens in its own chat tab. The tab and its conversation come back after ToolsEnabled restarts.',
  deletedOnExit: 'It opens in its own chat tab and closes when ToolsEnabled closes, because agents are deleted when the app exits.',
  notKept: 'It opens in its own chat tab and closes when ToolsEnabled closes. Add it to a tree to keep it.',
})
/* WHAT THE SAME POP-UP SAYS WHEN A TAB OPENED IT (B25, 1.0.48). The chip and
   Actions > Switch model change the tab's model; nothing new opens, so the
   words for a new agent would be wrong. A running session keeps its model.
   B30: `running` is the sentence the conversation's note says, with the model
   named there, so the chooser and the note cannot disagree. */
export const STANDALONE_TAB_CHOOSER_COPY = Object.freeze({
  heading: 'Change this agent’s model',
  idle: 'This agent starts on the model you choose.',
  running: standaloneStartChangedSentence(),
  confirm: 'Use this model',
})
const standaloneByDocument = new WeakMap()
/* Every + agent seat this document still holds: open or parked tabs in any
   retained scope, plus the workspace's tabs whose seat declaration is still in
   flight (pendingStandaloneIds). The Computers seat sweep releases a standalone
   seat only when it is absent here (T1365). A declaration left in flight by a
   workspace that has since been destroyed never becomes a tab, so its seat is
   rightly an orphan. */
export function heldStandaloneSeatIds(document, workspace = null) {
  const held = new Set(workspace?.pendingStandaloneIds || [])
  for (const scope of standaloneByDocument.get(document)?.values() || []) for (const id of scope.keys()) held.add(id)
  for (const id of workspace?.standalone?.keys() || []) held.add(id)
  return held
}

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
  // The tree owns it now: it must not also come back as a tab after a restart (B4). A refused
  // list write is said, as a refused close is (B4 review D12).
  if (record.tabs && record.tabs.forget(record.id) === false) {
    record.placedNotSaved = true
    record.workspace?.placementStatus?.(STANDALONE_RESTORE_COPY.placedNotSaved(record.agent?.name || 'This agent'), true)
  }
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

/* A TAB'S MODEL POP-UP IS THE ONE ON THE PAGE THAT SHOWS THE TAB NOW (B25).
   A tab outlives its page (retainedStandalone): after a setting change or a
   return to Computers it is shown by a new workspace, while the page that
   opened it is gone. Asking that page opened a pop-up nobody could see, and
   the visible one stayed empty. A tab no page shows opens nothing. */
function openTabChooser(record, start, apply) {
  record?.workspace?.openSpawnChooser({ start, apply, tab: record })
}

/* One menu row: the id rides on the value, the words are the only part read. */
function spawnOption(value, label) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  return option
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
    this.pendingStandaloneIds = new Set()
    // Names of tabs still coming back after a restart, so a new tab does not take one (B4).
    this._reservedNames = new Set()
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
          <p>It opens in its own chat tab.</p>
          <div class="tree-agent-spawn-pair">
            <label class="tree-agent-spawn-field"><span>${START_PANEL.providerLabel}</span>
              <select class="tree-agent-spawn-select" data-spawn-field="provider"></select></label>
            <label class="tree-agent-spawn-field"><span>${START_PANEL.tierLabel}</span>
              <select class="tree-agent-spawn-select" data-spawn-field="tier"></select></label>
          </div>
          <label class="tree-agent-spawn-field"><span>Effort</span>
            <select class="tree-agent-spawn-select" data-spawn-field="effort"></select></label>
          <p class="tree-agent-spawn-why" role="status" hidden></p>
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
    this._spawnRows = []
    /* THE TAB'S DOOR (B25). The notice lives inside the + menu, which is
       hidden unless + was pressed, so a tab's chip or Switch model unhid a
       notice nobody could see. A tab now borrows the + menu as it is: the
       menu is shown with only the notice in it, worded for this tab, and
       everything is put back exactly as it was when the pop-up closes. */
    this._spawnDoor = null
    const openTabDoor = ({ running = false, tab = null } = {}) => {
      const chooser = graph.chatChooser
      const notice = this.root.querySelector('.tree-agent-notice')
      const heading = notice.querySelector('strong')
      const words = notice.querySelector('p')
      const confirm = notice.querySelector('.tree-agent-continue')
      const opener = this.root.ownerDocument.activeElement
      const rows = [...chooser.children].filter(child => child !== notice)
      this._spawnDoor = { tab, opener,
        chooserHidden: chooser.hidden, rows: rows.map(row => [row, row.hidden]),
        heading: heading?.textContent, words: words?.textContent, confirm: confirm?.textContent,
        label: notice.getAttribute('aria-label') }
      // An answer to the + door's question about a restart must not land on these words.
      this._spawnNoticeAsked = (this._spawnNoticeAsked || 0) + 1
      for (const row of rows) row.hidden = true
      if (heading) heading.textContent = STANDALONE_TAB_CHOOSER_COPY.heading
      if (words) words.textContent = running ? STANDALONE_TAB_CHOOSER_COPY.running : STANDALONE_TAB_CHOOSER_COPY.idle
      if (confirm) confirm.textContent = STANDALONE_TAB_CHOOSER_COPY.confirm
      notice.setAttribute('aria-label', STANDALONE_TAB_CHOOSER_COPY.heading)
      chooser.hidden = false
    }
    const closeTabDoor = () => {
      const door = this._spawnDoor
      if (!door) return null
      this._spawnDoor = null
      const notice = this.root.querySelector('.tree-agent-notice')
      for (const [row, hidden] of door.rows) row.hidden = hidden
      const heading = notice.querySelector('strong'), words = notice.querySelector('p')
      const confirm = notice.querySelector('.tree-agent-continue')
      if (heading && door.heading !== undefined) heading.textContent = door.heading
      if (words && door.words !== undefined) words.textContent = door.words
      if (confirm && door.confirm !== undefined) confirm.textContent = door.confirm
      if (door.label !== null) notice.setAttribute('aria-label', door.label)
      graph.chatChooser.hidden = door.chooserHidden
      return door
    }
    /* Focus goes back to what opened the tab's pop-up (the chip, or the chat
       it lives in), or to the + menu when that menu is showing again. */
    this._returnFromTabDoor = door => {
      if (!door) return
      const target = !graph.chatChooser.hidden ? this.root.querySelector('.tree-new-agent')
        : door.opener?.isConnected ? door.opener : door.tab?.chatOpen ? door.tab.session : null
      target?.focus?.({ preventScroll: true })
    }
    /* The role/aria-modal half of hiding the notice, alongside `hidden` at
       every close door -- see openSpawnChooser's own note on why the pair
       travels together rather than living in the template. Answers the tab's
       door that was open, if one was, after putting the + menu back. */
    this.closeSpawnChooser = () => {
      const notice = this.root.querySelector('.tree-agent-notice')
      notice.removeAttribute('role')
      notice.removeAttribute('aria-modal')
      notice.hidden = true
      this._spawnApply = null
      return closeTabDoor()
    }
    /* WHETHER THE PERSON HAS MOVED THE PROVIDER OR MODEL since the pop-up
       opened. The host's rows can arrive after it opens; they may re-mark and
       re-pick the model only while nobody has chosen one. A provider change
       counts too: it moves the model in code, which raises no change event on
       the Model menu, so watching that menu alone would let a late answer
       undo the person's provider. */
    this._spawnTouched = false
    this.openSpawnChooser = ({ start = null, apply = null, tab = null } = {}) => {
      const notice = this.root.querySelector('.tree-agent-notice')
      const fromTab = typeof apply === 'function'
      /* A tab's pop-up already open gives the + menu back before it is borrowed again. */
      if (this._spawnDoor) this.closeSpawnChooser()
      const opening = start || defaultStandaloneStart()
      this._spawnTouched = false
      const opened = this._spawnOpened = (this._spawnOpened || 0) + 1
      /* The opening depth rides with the opening model. A start with no depth
         is "Model default" (''), which is that menu's own first row. */
      this._fillSpawnTiers(opening?.tier, opening ? (opening.effort ?? '') : undefined)
      const refresh = this.graph.standaloneAgent?.refreshTierChoices
      if (typeof refresh === 'function') {
        Promise.resolve().then(() => refresh()).then(() => {
          // Only the pop-up that asked: a late answer must not re-pick another door's model.
          if (!this._destroyed && !notice.hidden && !this._spawnTouched && opened === this._spawnOpened) this._fillSpawnTiers(opening?.tier)
        }, () => {})
      }
      this._spawnApply = fromTab ? apply : null
      if (fromTab) openTabDoor({ running: start?.running === true, tab })
      else this._fillSpawnNotice()
      /* role/aria-modal ride WITH hidden, not baked into the template: a
         role="dialog" with aria-modal left sitting on a hidden element is
         announced to a screen reader as though it were open (the exact
         mistake src/views/settings.js's openCloudMirrorSetup note and
         owner-popup.js both already carry). */
      notice.setAttribute('role', 'dialog')
      notice.setAttribute('aria-modal', 'true')
      notice.hidden = false
      /* The first question is whose model, so focus starts there. */
      notice.querySelector('[data-spawn-field=provider]')?.focus()
    }
    this.root.querySelector('.tree-new-agent').addEventListener('click', () => {
      /* ALWAYS THE CHOOSER. It used to skip to a chat once the notice had
         been seen, which left a person with a conversation they never chose
         a program for -- + opens a pop-up menu that chooses what to spawn.
         The explanation below it is still shown once;
         the choice is asked every time, because it is a different answer
         every time. */
      this.openSpawnChooser()
    })
    const spawnProvider = () => this.root.querySelector('.tree-agent-notice [data-spawn-field=provider]')
    const spawnTier = () => this.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
    const spawnEffort = () => this.root.querySelector('.tree-agent-notice [data-spawn-field=effort]')
    /* A NEW PROVIDER: its models, its default model (Codex GPT-6-Astra, Claude
       the moving "Opus (latest)", anyone else their first row this computer
       can start -- providerDefaultTier, the rule the start panel uses), that
       model's depth menu, and whether the confirm button may be pressed. All
       done here by name, because none of those value changes raises an event. */
    spawnProvider()?.addEventListener('change', () => {
      this._spawnTouched = true
      const provider = spawnProvider().value
      this._showSpawnProvider(provider, providerDefaultTier(provider, this._spawnRows))
    })
    /* A NEW MODEL re-defaults the depth from the depths THAT model takes, so a
       depth picked for the previous model is never carried to one without it. */
    spawnTier()?.addEventListener('change', () => {
      this._spawnTouched = true
      this._showSpawnEfforts(spawnTier().value)
      this._paintSpawnContinue()
    })
    this.root.querySelector('.tree-agent-continue').addEventListener('click', () => {
      try { localStorage.setItem(STANDALONE_NOTICE_KEY, 'true') } catch { /* the tab can still open */ }
      const picked = { tier: spawnTier()?.value, effort: spawnEffort()?.value }
      const apply = this._spawnApply
      const door = this.closeSpawnChooser()
      /* A tab's door changes that tab (B25); only the + door opens one. */
      if (apply) { apply(picked); this._returnFromTabDoor(door) } else this.openStandalone(picked)
    })
    this.root.querySelector('.tree-agent-cancel').addEventListener('click', () => {
      const door = this.closeSpawnChooser()
      if (door) this._returnFromTabDoor(door)
      else this.root.querySelector('.tree-new-agent').focus()
    })
    headerAdd.addEventListener('click', event => {
      if (graph.editMode) { newTree(event); return }
      /* + while a tab's pop-up is showing opens the + menu, rather than
         closing a menu the person never opened. */
      if (this._spawnDoor) this.closeSpawnChooser()
      this.showPicker(graph.chatChooser.hidden)
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
    let resume = null
    for (const record of this.retainedStandalone?.values() || []) {
      record.workspace = this
      record.parkedDraftSink = null
      this.standalone.set(record.id, record)
      graph.chatTrack.appendChild(record.chatPanel)
      if (record.resumeChat) resume = record
      delete record.resumeChat
    }
    /* THE TABS THAT WERE OPEN AT THE LAST QUIT COME BACK (B4, 1.0.48; the
       owner decided to reopen them). A restart or a reload gives this page a new
       document, so the retained tabs above are gone and only the list of open
       tabs remembers them. Their ids are held HERE, synchronously, before the
       Computers view's seat sweep can run, so a tab that never sent (and so
       has no conversation to keep its seat) is not released on its way back.
       Tabs this document still retains are already open and are skipped. */
    const tabs = graph.standaloneAgent?.tabs || null
    const listed = typeof tabs?.read === 'function' ? tabs.read() : null
    if (listed && listed.ok === false) this.placementStatus(STANDALONE_RESTORE_COPY.listUnreadable, true)
    const returning = listed?.ok ? listed.tabs.filter(entry => !this.standalone.has(entry.id)) : []
    for (const entry of returning) {
      this.pendingStandaloneIds.add(entry.id)
      this._reservedNames.add(entry.name)
    }
    if (returning.length) void this.restoreStandaloneTabs(returning)
    /* THE CHAT TAB THE PERSON WAS USING IS STILL THE ONE SHOWING after a
       rebuild of the page they are on. src/main.js re-renders the whole route
       when a setting flips, so "Turn on running agents" pressed inside a
       standalone agent's tab rebuilt Computers on the Trees tab: the Start
       control agent-session.js had just revealed "where the switch was" sat in
       a tab nobody was looking at, and focus fell to the page. destroy() marks
       the tab only when the rebuild happened under the person's hand (focus in
       this workspace, or already lost); leaving Computers through the
       navigation still comes back to Trees, as before. */
    if (resume) {
      this.mode = 'chat'
      graph.activeChatId = resume.id
    }
    if (this.standalone.size) this.sync()
    if (resume) resume.session.focus?.()
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
    // A placement whose saved-tabs write was refused keeps saying so after the success sentence.
    if (result.ok && record.placedNotSaved) this.placementStatus(`${result.sentence} ${STANDALONE_RESTORE_COPY.placedNotSaved(record.agent.name)}`, true, 'placement')
    else this.placementStatus(result.sentence, !result.ok, 'placement', { fade: result.ok === true })
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
     cannot be picked, and the preselected row is one that can start.
     WITHOUT HOST ROWS (browser preview) the answer is every row of the + agent's
     list, composed by the same tierChoicesFor() the host's answer comes from,
     so both read "<Model> · <Provider>" and nothing is marked that nobody
     measured. The template holds no rows of its own any more: a hand-kept copy
     of the table is how the pop-up came to offer eight models of forty. */
  _spawnChoiceRows() {
    const solo = new Set(standaloneStartChoices().tiers.map(choice => choice.id))
    let rows = null
    try { rows = this.graph.standaloneAgent?.tierChoices?.() } catch { rows = null }
    const usable = Array.isArray(rows) ? rows.filter(row => row && solo.has(row.id)) : []
    return usable.length ? usable : tierChoicesFor([...solo]).filter(row => solo.has(row.id))
  }

  /* PROVIDER, THEN MODEL, THEN DEPTH (1.0.48, owner decision: provider
     first, then model). The Provider menu is a filter over the rows, never a
     field of the start: what the pop-up hands on is still { tier, effort }, and
     the Model menu keeps data-spawn-field="tier" with row ids as its values.

     The preselected model is `preferred` when this computer can start it,
     else the one already shown, else the first row that can start. The depth
     survives only while the model does: `preferredEffort` when opening on
     `preferred`, the one on screen when the model did not move, and that
     model's own default otherwise. */
  _fillSpawnTiers(preferred = null, preferredEffort = undefined) {
    const provider = this.root.querySelector('.tree-agent-notice [data-spawn-field=provider]')
    const tier = this.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
    const effort = this.root.querySelector('.tree-agent-notice [data-spawn-field=effort]')
    if (!provider || !tier || !effort) return
    const rows = this._spawnChoiceRows()
    if (!rows.length) return
    const current = tier.value
    const can = id => rows.some(row => row.id === id && row.enabled !== false)
    /* With neither startable, the DEFAULT of the first provider that can start
       one (review P8): the first startable row was Fable (latest) on a computer
       without Codex, while a provider change to Claude lands on Opus (latest). */
    const firstStartable = rows.find(row => row.enabled !== false)
    const fallback = firstStartable ? providerDefaultTier(tierProvider(firstStartable.id), rows) || firstStartable.id : rows[0].id
    const pick = [preferred, current].find(id => id && can(id)) || fallback
    const keep = pick === preferred && preferredEffort !== undefined ? preferredEffort
      : pick === preferred || pick === current ? effort.value : undefined
    this._spawnRows = rows
    provider.replaceChildren(...PROVIDER_CHOICES
      .filter(choice => rows.some(row => tierProvider(row.id) === choice.id))
      .map(choice => spawnOption(choice.id, choice.label)))
    this._showSpawnProvider(tierProvider(pick), pick, keep)
  }

  /* One provider's rows in the Model menu, `tierId` chosen, and its depths.
     A row this computer cannot start stays drawn with its reason and cannot be
     picked, as in the start panel. */
  _showSpawnProvider(providerId, tierId, keepEffort = undefined) {
    const provider = this.root.querySelector('.tree-agent-notice [data-spawn-field=provider]')
    const tier = this.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
    if (!provider || !tier) return
    const rows = (this._spawnRows || []).filter(row => tierProvider(row.id) === providerId)
    provider.value = providerId
    tier.replaceChildren(...rows.map(row => {
      const option = spawnOption(row.id, row.label)
      option.disabled = row.enabled === false
      return option
    }))
    tier.value = rows.some(row => row.id === tierId) ? tierId : rows[0]?.id || ''
    this._showSpawnEfforts(tier.value, keepEffort)
    this._paintSpawnContinue()
  }

  /* THE DEPTHS THIS MODEL TAKES, AND ONLY THOSE (effortChoicesFor, the list
     every surface reads): no ultra on GPT-6-Luna, no xhigh on Opus 4.6, only
     "Model default" on Haiku 4.5. "Model default" is '' and sends no depth.
     A kept depth the model runs differently (Claude runs ultra as max) is
     shown as it will run; one it does not take gives way to the default. */
  _showSpawnEfforts(tierId, keep = undefined) {
    const effort = this.root.querySelector('.tree-agent-notice [data-spawn-field=effort]')
    if (!effort) return
    const choices = effortChoicesFor(tierId)
    effort.replaceChildren(...choices.map(choice => spawnOption(choice.id, choice.label)))
    const wanted = keep === '' ? '' : offeredEffort(tierId, keep) || null
    effort.value = choices.some(choice => choice.id === wanted) ? wanted
      : (choices.find(choice => choice.isDefault) || choices[0])?.id ?? ''
  }

  /* The confirm button follows the model on screen. A provider whose every
     model this computer cannot start leaves one drawn with its reason, and
     opening a tab on it would only fail at the first message. */
  _paintSpawnContinue() {
    const tier = this.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
    const confirm = this.root.querySelector('.tree-agent-continue')
    if (!tier || !confirm) return
    const row = (this._spawnRows || []).find(entry => entry.id === tier.value)
    confirm.disabled = !row || row.enabled === false
    /* AND WHY, BESIDE IT (review P9). The reason used to live only at the end
       of an option label the narrow Model menu cuts off, so "Open agent tab"
       went grey with nothing on screen saying why. */
    const why = this.root.querySelector('.tree-agent-notice .tree-agent-spawn-why')
    if (why) {
      const sentence = row && row.enabled === false ? row.label || '' : ''
      why.textContent = sentence
      why.hidden = !sentence
    }
  }

  /* The pop-up's sentence about a restart (STANDALONE_NOTICE_COPY). Asked each
     time it opens, because the setting can change while this page is open. */
  _fillSpawnNotice() {
    const words = this.root.querySelector('.tree-agent-notice p')
    if (!words) return
    const agent = this.graph.standaloneAgent
    if (!agent?.tabs) { words.textContent = STANDALONE_NOTICE_COPY.notKept; return }
    words.textContent = STANDALONE_NOTICE_COPY.unknown
    if (typeof agent.tabsComeBack !== 'function') return
    const asked = this._spawnNoticeAsked = (this._spawnNoticeAsked || 0) + 1
    Promise.resolve().then(() => agent.tabsComeBack()).then(back => {
      if (this._destroyed || asked !== this._spawnNoticeAsked) return
      words.textContent = back === true ? STANDALONE_NOTICE_COPY.comesBack
        : back === false ? STANDALONE_NOTICE_COPY.deletedOnExit : STANDALONE_NOTICE_COPY.unknown
    }, () => {})
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
    while ([...this.standalone.values()].some(record => record.agent.name === `Agent ${number}`)
      || this._reservedNames?.has(`Agent ${number}`)) number++
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
    // Held from before the seat exists until the tab owns it. An exception in
    // between leaves the id held, so the sweep can only err toward keeping it.
    this.pendingStandaloneIds?.add(id)
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
      this.pendingStandaloneIds?.delete(id)
      panel.remove()
      return
    }
    const session = mountStandaloneAgent(panel, { id, name, ...this.graph.standaloneAgent, start,
      seat: seat && seat.ok !== false ? seat : null,
      /* The chip's door. The agent says what it is on; this panel owns the
         menu that changes it, and the agent decides what the answer means. */
      onChangeStart: (current, apply) => openTabChooser(record, current, apply),
      onStartChosen: chosen => record?.tabs?.update(id, chosen),
      onSessionOpened: opened => record?.tabs?.update(id, opened),
      onPlaced: nodeId => standalonePlaced(record, nodeId) })
    record = { id, agent: { id, name, role: 'default' }, standalone: true,
      chatPanel: panel, chatRoot: panel, chatOpen: true, chatPinned: true, session,
      workspace: this, retained: this.retainedStandalone }
    this.standalone.set(id, record)
    this.retainedStandalone?.set(id, record)
    this.pendingStandaloneIds?.delete(id)
    this._rememberStandalone?.(record)
    this.mode = 'chat'
    this.graph.activeChatId = id
    this.sync()
    session.focus()
  }

  /* WRITTEN DOWN THE MOMENT THE TAB EXISTS (B4), never at quit, so a crash
     still brings it back. A list that refuses the write costs this tab its
     return, and the person is told so while it is still open. */
  _rememberStandalone(record) {
    record.tabs = this.graph.standaloneAgent?.tabs || null
    if (!record.tabs) return
    const remembered = record.tabs.remember({ id: record.id, name: record.agent.name,
      ...(record.session.chosenStart?.() || {}), openedAt: Date.now(), sessionId: null })
    if (!remembered) this.placementStatus(STANDALONE_RESTORE_COPY.notSaved, true)
  }

  /* ONE TAB AT A TIME, IN THE ORDER THEY WERE OPEN, so the organisation writes
     of their seats never collide. Nothing starts: the tab shows its saved
     conversation and waits for the person to send. Neither the mode nor the
     focus changes, because nothing should open under the person's hand. */
  async restoreStandaloneTabs(entries) {
    const agent = this.graph.standaloneAgent || {}
    const tabs = agent.tabs || null
    const gone = () => this._destroyed || this.graph._destroyed
    const letGo = entry => { this.pendingStandaloneIds.delete(entry.id); this._reservedNames.delete(entry.name) }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      // A view that went away leaves the list as it is; the next load restores.
      if (gone()) { for (const rest of entries.slice(index)) letGo(rest); return }
      if (this.standalone.has(entry.id)) { letGo(entry); continue }
      const notes = []
      const start = standaloneStartFrom(entry)
      if (entry.tier && start.tier !== entry.tier) {
        const label = standaloneStartChoices().tiers.find(row => row.id === start.tier)?.label || start.tier
        notes.push(STANDALONE_RESTORE_COPY.programRetired(label))
        tabs?.update(entry.id, { tier: start.tier, effort: start.effort })
      }
      /* Why the tab is back, for its first line: a restart, a reload, or a
         reload that stopped the session the old page left running. */
      let cause = 'restart'
      try { if (agent.pageReloaded?.() === true) cause = 'reload' } catch { /* said as a restart */ }
      /* A PAGE RELOAD LEAVES THE HOST'S SESSIONS RUNNING. One this tab left
         behind is closed first, so two sessions never write to one saved
         conversation; one that will not close keeps the tab away this time. */
      if (entry.sessionId && typeof agent.closeStaleSession === 'function') {
        let stale
        try { stale = await agent.closeStaleSession(entry.sessionId) } catch { stale = { ok: false } }
        if (stale?.ok === false) {
          /* Its name stays reserved: the tab is still in the list and comes
             back next time, so a new tab must not take its name meanwhile. */
          this.pendingStandaloneIds.delete(entry.id)
          if (!gone()) this.placementStatus(STANDALONE_RESTORE_COPY.stillRunning(entry.name), true)
          continue
        }
        if (stale?.closed) cause = 'stopped'
        if (gone()) { for (const rest of entries.slice(index)) letGo(rest); return }
      }
      let saved = null, unreadable = false
      try {
        const read = agent.transcript?.readLatest
        if (typeof read !== 'function') throw new Error('No conversation reader')
        saved = (await read(entry.id)) ?? null
      } catch {
        saved = null
        unreadable = true
        notes.push(STANDALONE_RESTORE_COPY.conversationUnreadable)
      }
      let seat = null
      if (typeof agent.declareSeat === 'function') {
        try { seat = await agent.declareSeat({ id: entry.id, name: entry.name, tier: start.tier }) } catch { seat = null }
        if (!seat || seat.ok === false) { seat = null; notes.push(STANDALONE_RESTORE_COPY.seatRefused) }
      }
      if (gone()) { for (const rest of entries.slice(index)) letGo(rest); return }
      const id = entry.id, name = entry.name
      const panel = el('<section class="tree-conversation tree-standalone-conversation" tabindex="-1"></section>')
      this.graph.chatTrack.appendChild(panel)
      let record
      const session = mountStandaloneAgent(panel, { id, name, ...agent, start, seat,
        restored: { lines: Array.isArray(saved?.lines) ? saved.lines : [], before: saved?.before || null,
          recoveryDirectory: saved?.recoveryDirectory || null, unreadable, notes, cause,
          // The session it had at quit, whose waiting messages the next session takes (B4 step 11).
          sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : null },
        onChangeStart: (current, apply) => openTabChooser(record, current, apply),
        onStartChosen: chosen => record?.tabs?.update(id, chosen),
        onSessionOpened: opened => record?.tabs?.update(id, opened),
        onPlaced: nodeId => standalonePlaced(record, nodeId) })
      record = { id, agent: { id, name, role: 'default' }, standalone: true,
        chatPanel: panel, chatRoot: panel, chatOpen: true, chatPinned: true, session,
        workspace: this, retained: this.retainedStandalone, tabs, restored: true,
        // Closing it keeps its seat while a conversation is (or may be) saved under it.
        savedConversation: saved !== null || unreadable }
      this.standalone.set(id, record)
      this.retainedStandalone?.set(id, record)
      letGo(entry)
      this.sync()
    }
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
    // Closed first: a tab's pop-up puts the + menu back as it was, and this then decides it.
    this.closeSpawnChooser()
    graph.chatChooser.hidden = !show
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
    /* A tab's pop-up belongs to that tab while it shows. Closed, or left for
       another tab or the trees, the pop-up closes with it (B25). */
    const doorTab = this._spawnDoor?.tab
    if (doorTab && (!doorTab.chatOpen || this.standalone.get(doorTab.id) !== doorTab
      || this.mode !== 'chat' || active !== doorTab)) this.closeSpawnChooser()
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
      const neverSent = Boolean(state) && !state.sessionId && state.phase === 'draft' && record.savedConversation !== true
      /* A closed tab does not come back after a restart (B4). A list that
         refused the write still names it, so the person is told it may come
         back; a damaged list names nothing and reopens nothing. */
      const forgotten = record.tabs ? record.tabs.forget(record.id) : true
      if (forgotten === false && record.tabs.read?.()?.ok !== false) {
        this.placementStatus(STANDALONE_RESTORE_COPY.closeNotSaved(record.agent.name), true)
      }
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
      /* A tab's pop-up closes alone, leaving the + menu as it was (B25). */
      if (this._spawnDoor) this._returnFromTabDoor(this.closeSpawnChooser())
      else if (!graph.chatChooser.hidden) { this.showPicker(false); this.root.querySelector('.tree-chat-add').focus() }
      else this.showTrees()
    }
  }

  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    clearTimeout(this.placementStatusTimer)
    this.hidePlacementPicker()
    this.clearStandaloneDrag()
    const doc = this.root.ownerDocument
    const focused = doc?.activeElement
    const lost = !focused || focused === doc.body || focused === doc.documentElement || doc.body?.contains?.(focused) === false
    const underHand = lost || this.root.contains?.(focused)
    const showing = this.mode === 'chat' ? this.standalone.get(this.graph.activeChatId) : null
    for (const record of this.standalone.values()) {
      if (this.retainedStandalone && !record.treeNodeId) {
        if (record === showing && underHand) record.resumeChat = true
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
