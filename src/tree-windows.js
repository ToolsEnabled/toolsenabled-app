import { el } from './components.js'
import { textZoom } from './text-size.js'
import { treeCamera } from './tree-workspace.js'
import { TreeToolbar } from './tree-toolbar.js'

// One Trees workspace owns its canvas selection and optional inspected branch.
// Both renderers share the mounted conversations in the same tab strip.
export class TreeWindows {
  constructor(main, { getTrees, createGraph }) {
    this.main = main
    this.getTrees = getTrees
    this.createGraph = createGraph || ((host, rootId, onRootChange) => new main.constructor(host, {
      computer: main.computer, rootId, nodeStyle: main.nodeStyle, circleCards: main.circleCards, cardSize: main.cardSize, compactControls: true, chatOwner: main,
      screenChips: true, contextFeed: main.contextFeed, edges: main.declaredEdges,
      communicationLinks: main.communicationLinks, onRootChange,
      onOpenControls: main.onOpenControls, onContact: main.onContact, onEmptyPress: main.onEmptyPress,
      canExtend: main.canExtend, extensionPoints: main.extensionPoints, canDrag: main.canDrag,
      onReparent: main.onReparent, canReparent: main.canReparent, onDetachToNewTree: main.onDetachToNewTree,
      onDropRefused: main.onDropRefused,
    }))
    this.windows = []
    this.key = `mc.tree.windows.v1:${main.computer.id}`
    this.tabsKey = `mc.tree.canvas.v2:${main.computer.id}`
    this.workspaces = []
    this.grid = el('<div class="tree-window-grid" aria-label="Tree windows"></div>')
    this.main.zoomHost.before(this.grid)
    this.addButton = el('<button type="button" class="tree-window-add">Split view</button>')
    main.workspace.root.querySelector('.tree-workspace-tabs-bar').appendChild(this.addButton)
    this.addButton.addEventListener('click', () => this.toggleSplit())
    this.onOutside = event => {
      for (const frame of this.windows) if (!frame.choices.contains(event.target) && !frame.select.contains(event.target)) {
        this.closePicker(frame, { focus: false })
      }
    }
    this.grid.ownerDocument.addEventListener('pointerdown', this.onOutside)
    const first = this.makeFrame(main.zoomHost)
    first.graph = main
    this.windows.push(first)
    first.tools.appendChild(main.zoomerEl)
    main.windowBoard = this
    this.bindFrame(first)
    let saved = [], savedTabs = null, legacyTabs = null
    try { saved = JSON.parse(localStorage.getItem(this.key) || '[]') } catch { /* use the first saved tree */ }
    try { savedTabs = JSON.parse(localStorage.getItem(this.tabsKey) || 'null') } catch { /* restore the older window selection */ }
    try { legacyTabs = JSON.parse(localStorage.getItem(`mc.tree.workspaces.v1:${main.computer.id}`) || 'null') } catch { /* older tabs are optional */ }
    const roots = this.getTrees()
    const validRoots = ids => [...new Set(Array.isArray(ids) ? ids : [])].filter(id => roots.some(tree => tree.rootId === id))
    let views
    if (Array.isArray(savedTabs?.views)) views = savedTabs.views.slice(0, 2).map(view => ({
      rootIds: validRoots(view?.rootIds), focusId: view?.focusId, dropId: view?.dropId, empty: !!view?.empty,
    }))
    else {
      // Old tree pages become one selection. Preserve the old preference key
      // so adopting this simpler workspace never destroys the saved pages.
      const oldIds = Array.isArray(legacyTabs?.workspaces) ? legacyTabs.workspaces.flatMap(tab =>
        Array.isArray(tab?.views) ? tab.views.flatMap(view => Array.isArray(view?.rootIds) ? view.rootIds : []) : Array.isArray(tab?.roots) ? tab.roots : []) : []
      const wanted = validRoots(oldIds.length ? oldIds : saved)
      views = [{ rootIds: wanted.length ? wanted : roots.map(tree => tree.rootId) }]
    }
    this.workspaces.push({ id: 'trees', name: 'Trees', views })
    this.activate('trees', { remember: false, show: false })
    this.linkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.linkSvg.setAttribute('class', 'tree-window-links')
    this.grid.appendChild(this.linkSvg)
    this.observer = new ResizeObserver(() => this.scheduleLinks())
    this.observer.observe(this.grid)
    this.refreshHeaders()
    main.workspace.syncTreeTabs(this)
    this.toolbar = new TreeToolbar(this)
  }

  capture() {
    if (this.main.editMode) return
    const active = this.workspaces.find(tab => tab.id === this.activeId)
    if (active) active.views = this.windows.map(({ graph, empty, dropId }) => ({ rootIds: [...(graph.windowRootIds || [])], focusId: graph.rootId, empty: !!empty, dropId, focus: new Map(graph.boxFocus), scope: graph._treeScope,
      camera: this.main.workspace.mode !== 'trees' && this.main.workspace.treeSetBefore === this.activeId
        ? this.main.workspace.cameras?.find(entry => entry.graph === graph)?.camera || treeCamera(graph) : treeCamera(graph) }))
  }

  activate(id, { remember = true, show = true } = {}) {
    if (this.main.editMode) return
    const tab = this.workspaces.find(entry => entry.id === id)
    if (!tab) return
    const restores = []
    if (id !== this.activeId) {
      this.capture()
      this.activeId = id
      const available = this.getTrees()
      const views = tab.views.map(view => ({ ...view, rootIds: view.rootIds.filter(id => available.some(tree => tree.rootId === id)) }))
      // Example roots can be regenerated between launches. Keep each saved
      // pane in its original position: an empty split is valid only on the
      // right, and must never replace a primary whose old roots disappeared.
      if (!views.length) views.push({ rootIds: [] })
      if (!views[0].rootIds.length) views[0].rootIds = available.map(tree => tree.rootId)
      if (this.windows[1]) this.removeFrame(this.windows[1])
      for (let index = 0; index < views.length; index++) {
        const view = views[index]
        if (index) this.add(view.rootIds, { remember: false })
        const frame = this.windows[index]
        this.choose(frame, view.rootIds, { remember: false })
        frame.dropId = view.dropId
        if (view.scope) {
          view.scope.update(frame.graph.computer.agents, frame.graph.declaredEdges || [])
          frame.graph._treeScope = view.scope
          frame.graph._projectionMemory = null
        }
        frame.graph.boxFocus = new Map([...(view.focus || [])].filter(([, focus]) => frame.graph._agentFor(focus)))
        if (view.focusId && frame.graph._agentFor(view.focusId)) frame.graph.rootId = view.focusId
        frame.graph._reconcile()
        if (view.camera) restores.push({ graph: frame.graph, camera: view.camera })
      }
    }
    this.refreshHeaders()
    this.main.workspace.syncTreeTabs(this)
    if (show) this.main.workspace.showTrees()
    if (restores.length) requestAnimationFrame(() => {
      if (this.destroyed || this.activeId !== id) return
      for (const { graph, camera } of restores) {
        if (graph._destroyed) continue
        graph.resize()
        Object.assign(graph, camera)
        graph._applyZoom()
      }
    })
    if (remember) this.remember()
  }

  addWorkspace() {
    // Kept as a harmless compatibility entry point for old callers.
    if (!this.main.editMode) this.main.workspace.showTrees()
  }

  closeWorkspace(id) {
    if (this.main.editMode) return
    const index = this.workspaces.findIndex(tab => tab.id === id)
    if (index < 1) return
    if (id === this.activeId) this.activate(this.workspaces[index - 1].id, { remember: false })
    this.workspaces.splice(index, 1)
    this.main.workspace.syncTreeTabs(this)
    this.remember()
  }

  makeFrame(host) {
    const pane = el(`<section class="graph-wrap tree-window">
      <header class="tree-window-header graph-bar"><div class="tree-window-title"><span class="tree-window-label">TREES</span><button type="button" class="tree-window-select" aria-label="Choose trees on this canvas" aria-expanded="false"></button><strong class="tree-window-branch-title" hidden></strong></div>
        <div class="graph-tools"></div><button type="button" class="tree-window-close" aria-label="Close tree window">×</button></header>
      <div class="tree-window-navigation"><button type="button" class="tree-window-back">‹ Back</button><span></span></div>
      <div class="tree-window-tree-picker" hidden><strong>Trees on this canvas</strong><p>Choose the trees you want to see together.</p><div class="tree-window-tree-choices"></div><div class="tree-window-picker-actions"><button type="button" class="tree-window-picker-cancel">Cancel</button><button type="button" class="tree-window-picker-apply">Show selected trees</button></div></div>
      <div class="tree-window-dropzone" hidden><strong>Drag an agent here</strong><span>Its branch will open in this view.</span></div>
    </section>`)
    const frame = { pane, select: pane.querySelector('.tree-window-select'), choices: pane.querySelector('.tree-window-tree-picker'), tools: pane.querySelector('.graph-tools'), back: pane.querySelector('.tree-window-back'), graph: null }
    this.grid.appendChild(pane)
    pane.appendChild(host)
    return frame
  }

  bindFrame(frame) {
    frame.pane.addEventListener('pointerdown', () => this.toolbar?.activate(frame))
    frame.pane.addEventListener('focusin', () => this.toolbar?.activate(frame))
    frame.pane.addEventListener('wheel', () => this.toolbar?.activate(frame), { capture: true, passive: true })
    frame.select.addEventListener('click', () => {
      if (this.main.editMode || frame.graph !== this.main) return
      if (!frame.choices.hidden) { this.closePicker(frame); return }
      frame.choices.hidden = false
      frame.select.setAttribute('aria-expanded', 'true')
      {
        const options = this.getTrees().map(tree => {
          const label = el('<label><input type="checkbox"><span class="tree-window-choice-text"><strong></strong><span></span></span><small></small></label>')
          const input = label.querySelector('input')
          input.value = tree.rootId
          input.checked = frame.graph.windowRootIds.includes(tree.rootId)
          label.querySelector('strong').textContent = tree.name || tree.rootName || 'Untitled tree'
          const detail = label.querySelector('.tree-window-choice-text > span')
          detail.textContent = [tree.rootName && tree.rootName !== tree.name ? tree.rootName : '', tree.description].filter(Boolean).join(' · ')
          detail.hidden = !detail.textContent
          label.querySelector('small').textContent = `${tree.count} ${tree.count === 1 ? 'agent' : 'agents'}`
          input.addEventListener('change', () => {
            frame.choices.querySelector('.tree-window-picker-apply').disabled = !frame.choices.querySelector('input:checked')
          })
          return label
        })
        frame.choices.querySelector('.tree-window-tree-choices').replaceChildren(...options)
        frame.choices.querySelector('.tree-window-picker-apply').disabled = !frame.choices.querySelector('input:checked')
        frame.choices.querySelector('input')?.focus()
      }
    })
    frame.choices.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closePicker(frame) }
    })
    frame.choices.querySelector('.tree-window-picker-cancel').addEventListener('click', () => this.closePicker(frame))
    frame.choices.querySelector('.tree-window-picker-apply').addEventListener('click', () => {
      const selected = [...frame.choices.querySelectorAll('input:checked')].map(input => input.value)
      if (!selected.length || this.main.editMode) return
      this.closePicker(frame)
      const current = frame.graph.windowRootIds
      if (selected.length !== current.length || selected.some(id => !current.includes(id))) this.choose(frame, selected)
    })
    if (frame.graph !== this.main) {
      const canDrop = event => !this.main.editMode && [...(event.dataTransfer?.types || [])].includes('application/x-toolsenabled-tree-agent')
      frame.pane.addEventListener('dragover', event => {
        if (!canDrop(event)) return
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; frame.pane.classList.add('is-drop-target')
      })
      frame.pane.addEventListener('dragleave', event => { if (!frame.pane.contains(event.relatedTarget)) frame.pane.classList.remove('is-drop-target') })
      frame.pane.addEventListener('drop', event => {
        frame.pane.classList.remove('is-drop-target')
        if (!canDrop(event)) return
        event.preventDefault()
        let data
        try { data = JSON.parse(event.dataTransfer.getData('application/x-toolsenabled-tree-agent')) } catch { return }
        const scope = this.main._scopeModel()
        if (data?.computerId !== this.main.computer.id || typeof data.id !== 'string' || !scope.byId.has(data.id)) return
        const head = scope.ancestry(data.id)[0]?.id
        if (!head) return
        frame.dropId = data.id
        this.choose(frame, head, { remember: false })
        frame.graph.setRoot(data.id)
        this.toolbar?.activate(frame)
        this.refreshHeaders()
        this.remember()
      })
    }
    frame.back.addEventListener('click', () => {
      const graph = frame.graph
      if (graph.windowRootIds.length > 1) { graph.clearRoot(); return }
      const parent = graph.ancestryOf(graph.rootId).at(-2)?.id || graph.windowRootId
      if (parent) graph.setRoot(parent)
      this.refreshHeaders()
    })
    frame.pane.querySelector('.tree-window-close').addEventListener('click', () => this.close(frame))
  }

  choose(frame, rootId, { remember = true } = {}) {
    const available = this.getTrees()
    frame.graph.windowRootIds = [...new Set(Array.isArray(rootId) ? rootId : rootId ? [rootId] : [])].filter(id => available.some(tree => tree.rootId === id))
    frame.graph.windowRootId = frame.graph.windowRootIds.length === 1 ? frame.graph.windowRootIds[0] : null
    frame.empty = frame.graph !== this.main && !frame.graph.windowRootIds.length
    frame.graph.clearRoot()
    this.refreshHeaders()
    if (remember) this.remember()
  }

  add(rootId, { remember = true } = {}) {
    if (this.windows.length >= 2) { this.choose(this.windows[1], rootId, { remember }); return }
    const host = el('<div class="graph-canvas-slot"><div class="computer-tree-canvas"></div></div>')
    const frame = this.makeFrame(host)
    frame.graph = this.createGraph(host.firstElementChild, Array.isArray(rootId) ? rootId[0] : rootId, () => this.refreshHeaders())
    frame.graph.windowBoard = this
    frame.graph.setContactMarks(this.main.contactMarks)
    frame.graph._linkMode = !!this.main._linkMode
    frame.graph.inputMode = this.main.inputMode
    frame.graph.zoomHost.classList.toggle('is-linking', !!this.main._linkMode)
    this.windows.push(frame)
    this.choose(frame, rootId, { remember: false })
    this.bindFrame(frame)
    this.refreshHeaders()
    this.main.resize()
    frame.graph.resize()
    if (remember) this.remember()
  }

  close(frame) {
    if (this.windows.length < 2) return
    let remainingCamera = null
    if (frame.graph === this.main) {
      const other = this.windows[1]
      other.graph._cancelZoomMotion()
      remainingCamera = treeCamera(other.graph)
      this.choose(frame, other.graph.windowRootIds, { remember: false })
      this.main.boxFocus = new Map(other.graph.boxFocus)
      this.main._treeScope = other.graph._treeScope
      this.main._projectionMemory = null
      this.main.rootId = other.graph.rootId
      this.main._reconcile()
      frame = other
    }
    this.removeFrame(frame)
    this.main.resize()
    if (remainingCamera) {
      Object.assign(this.main, remainingCamera)
      this.main._applyZoom()
    }
    this.refreshHeaders()
    this.remember()
  }

  removeFrame(frame) {
    this.windows = this.windows.filter(item => item !== frame)
    frame.graph.destroy()
    frame.pane.remove()
  }

  toggleSplit() {
    if (this.main.editMode) return
    this.main.workspace.showTrees({ focus: false })
    if (this.windows.length > 1) this.close(this.windows[1])
    else this.add([])
    this.addButton.focus({ preventScroll: true })
  }

  // Fleet overview uses the canvas selector. New trees are created through
  // the top + menu or the gray canvas slot, never through this selection UI.
  showPicker() {
    if (this.main.editMode) return
    this.main.workspace.showTrees({ focus: false })
    const frame = this.windows[0]
    if (frame.choices.hidden) frame.select.click()
    else frame.choices.querySelector('input')?.focus()
  }

  closePicker(frame, { focus = true } = {}) {
    const open = !frame.choices.hidden
    frame.choices.hidden = true
    frame.select.setAttribute('aria-expanded', 'false')
    if (open && focus) frame.select.focus({ preventScroll: true })
  }

  noteNewTreeRequested() {
    this.pendingNewRoots = new Set(this.getTrees().map(tree => tree.rootId))
  }

  refresh() {
    const roots = this.getTrees()
    if (this.pendingNewRoots) {
      const added = roots.filter(tree => !this.pendingNewRoots.has(tree.rootId)).map(tree => tree.rootId)
      if (added.length) {
        this.pendingNewRoots = null
        this.choose(this.windows[0], [...this.main.windowRootIds, ...added])
      }
    }
    for (const frame of this.windows) {
      if (frame.graph !== this.main) {
        frame.graph.computer = this.main.computer
        frame.graph.declaredEdges = this.main.declaredEdges
        frame.graph.communicationLinks = this.main.communicationLinks
        frame.graph.refresh()
      }
      const selected = frame.graph.windowRootIds.filter(id => roots.some(tree => tree.rootId === id))
      if (frame.graph !== this.main) {
        if (frame.dropId && !this.main._scopeModel().byId.has(frame.dropId)) { frame.dropId = null; this.choose(frame, [], { remember: false }) }
        else if (frame.dropId) {
          const head = this.main._scopeModel().ancestry(frame.dropId)[0]?.id
          if (head && (selected.length !== 1 || selected[0] !== head)) {
            this.choose(frame, head, { remember: false })
            frame.graph.setRoot(frame.dropId)
          }
        }
        else if (selected.length !== frame.graph.windowRootIds.length) this.choose(frame, selected, { remember: false })
      } else if (selected.length !== frame.graph.windowRootIds.length || (!selected.length && roots.length)) this.choose(frame, selected.length ? selected : roots[0]?.rootId, { remember: false })
    }
    this.refreshHeaders()
  }

  refreshHeaders() {
    const trees = this.getTrees()
    for (const frame of this.windows) {
      const editing = frame.graph.editMode
      const selected = (editing ? frame.graph._editRootIds : frame.graph.windowRootIds) || []
      const names = trees.filter(tree => selected.includes(tree.rootId)).map(tree => tree.name)
      frame.select.textContent = `Trees on this canvas · ${names.length}  ▾`
      frame.select.title = names.join(' · ')
      frame.select.disabled = !trees.length
      frame.back.hidden = editing || !frame.graph.boxFocus?.size
      frame.back.textContent = selected.length > 1 ? '‹ Whole trees' : '‹ Back'
      const branch = frame.graph._agentFor(frame.graph.rootId)
      const secondary = frame.graph !== this.main
      frame.select.hidden = secondary
      frame.pane.querySelector('.tree-window-branch-title').hidden = !secondary
      frame.pane.querySelector('.tree-window-branch-title').textContent = branch?.name || (frame.empty ? 'Split view' : names[0] || 'Agent branch')
      frame.pane.classList.toggle('is-empty', !!frame.empty)
      frame.pane.querySelector('.tree-window-dropzone').hidden = !frame.empty
      // Use the same scope as the graph footer, including a focused branch.
      const total = frame.graph._scopeAgentCount()
      frame.pane.querySelector('.tree-window-navigation span').textContent = editing
        ? `Editing ${selected.length} ${selected.length === 1 ? 'tree' : 'trees'} · ${total} ${total === 1 ? 'agent' : 'agents'}`
        : frame.empty ? 'Drop any agent to inspect its branch' : secondary ? `${names[0] || 'Tree'} · ${frame.graph._scopeAgentCount()} agents · Drop another agent to replace`
          : `${frame.back.hidden ? names.length > 1 ? 'Trees together' : 'Whole tree' : branch?.name || 'Branch'} · ${total} ${total === 1 ? 'agent' : 'agents'}`
      frame.pane.querySelector('.tree-window-close').hidden = this.windows.length < 2
    }
    this.grid.dataset.windows = String(this.windows.length)
    this.addButton.textContent = this.windows.length < 2 ? 'Split view' : 'Single view'
    this.addButton.title = this.windows.length < 2 ? 'Open an empty view, then drag an agent into it' : 'Close the right pane and keep one view'
    this.main.workspace.syncEditing?.()
    this.toolbar?.sync()
    this.scheduleLinks()
  }

  remember() {
    this.capture()
    try {
      localStorage.setItem(this.tabsKey, JSON.stringify({ views: this.workspaces[0].views.map(view => ({ rootIds: view.rootIds, focusId: view.focusId, dropId: view.dropId, empty: view.empty })) }))
    } catch { /* retain this view */ }
  }

  scheduleLinks() {
    if (this.linkFrame || this.destroyed) return
    this.linkFrame = requestAnimationFrame(() => { this.linkFrame = 0; this.paintLinks() })
  }

  paintLinks() {
    if (!this.linkSvg || this.destroyed) return
    this.linkSvg.replaceChildren()
    const ns = 'http://www.w3.org/2000/svg', bounds = this.grid.getBoundingClientRect(), zoom = textZoom(this.grid.ownerDocument)
    const find = id => {
      for (const frame of this.windows) {
        const record = frame.graph.nodes.get(id)
        if (record && !record.el.hidden && frame.graph._layoutVisibleIds.has(id)) return { frame, record, rect: record.el.getBoundingClientRect() }
      }
      return null
    }
    for (const link of this.main.communicationLinks) {
      const from = find(link.from), to = find(link.to)
      if (!from || !to || from.frame === to.frame) continue
      const leftToRight = from.rect.x < to.rect.x
      const x1 = ((leftToRight ? from.rect.right : from.rect.left) - bounds.left) / zoom
      const x2 = ((leftToRight ? to.rect.left : to.rect.right) - bounds.left) / zoom
      const y1 = (from.rect.y + from.rect.height / 2 - bounds.top) / zoom, y2 = (to.rect.y + to.rect.height / 2 - bounds.top) / zoom
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`)
      path.setAttribute('class', 'tree-cross-link')
      const marker = document.createElementNS(ns, 'g')
      marker.setAttribute('transform', `translate(${(x1 + x2) / 2} ${(y1 + y2) / 2})`)
      marker.setAttribute('role', 'button'); marker.setAttribute('tabindex', '0')
      marker.setAttribute('aria-label', `Direct link: ${from.record.agent.name} and ${to.record.agent.name}`)
      marker.innerHTML = '<circle r="12"/><text text-anchor="middle" dy="6">›</text>'
      marker.addEventListener('click', () => this.main._showLinkDetails(link))
      marker.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.main._showLinkDetails(link) } })
      this.linkSvg.append(path, marker)
    }
  }

  destroy() {
    this.destroyed = true
    this.toolbar?.destroy()
    if (this.linkFrame) cancelAnimationFrame(this.linkFrame)
    this.observer?.disconnect()
    this.grid.ownerDocument.removeEventListener('pointerdown', this.onOutside)
    for (const frame of this.windows) if (frame.graph !== this.main) frame.graph.destroy()
    this.grid.before(this.main.zoomHost)
    this.grid.remove()
    this.addButton.remove()
  }
}
