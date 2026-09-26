import { el } from './components.js'
import { TREE_CONTEXT_SIZES } from './tree-box-layout.js'

// One action row follows the selected canvas. Move the mounted controls so
// zoom, links and fleet controls retain their existing owners and listeners.
export class TreeToolbar {
  constructor(board) {
    this.board = board
    this.main = board.main
    this.owner = this.main.workspace.root.closest('.graph-wrap')
    this.root = this.owner?.querySelector(':scope > .graph-bar > .graph-tools')
    if (!this.root) return
    this.owner.classList.add('tree-toolbar-owner')
    this.root.classList.add('tree-action-bar')
    this.settings = el(`<div class="tree-display-controls">
      <select class="tree-shape-select" aria-label="Agent shape" title="Agent shape"><option value="circles">Circles</option><option value="boxes">Boxes</option></select>
      <select class="tree-card-size-select" aria-label="Agent card size" title="Agent card size">${Object.entries(TREE_CONTEXT_SIZES).map(([value, size]) => `<option value="${value}">${size.label}</option>`).join('')}</select>
    </div>`)
    this.zoomSlot = el('<div class="tree-active-zoom"></div>')
    this.parking = el('<div class="tree-toolbar-parking" hidden></div>')
    this.owner.appendChild(this.parking)
    this.root.prepend(this.settings, this.zoomSlot)
    this.editActions = this.owner.querySelector('.graph-tool-set')
    // Edit belongs to the page. Its temporary More menu is destroyed with
    // the renderer, so return it to the permanent action row on teardown.
    this.editHome = this.root
    if (this.editActions) this.root.appendChild(this.editActions)
    const overview = this.owner.querySelector(':scope > .graph-bar .graph-open-btn')
    if (this.main.workspaceControls) this.root.appendChild(this.main.workspaceControls)
    if (overview) this.root.appendChild(overview)
    this.root.appendChild(board.addButton)
    this.shape = this.settings.querySelector('.tree-shape-select')
    this.size = this.settings.querySelector('.tree-card-size-select')
    this.shape.addEventListener('change', () => { this.main.setNodeStyle?.(this.shape.value); this.sync() })
    this.size.addEventListener('change', () => { this.main.setCardSize?.(this.size.value); this.sync() })
    this.sync()
  }

  activate(frame) {
    if (!this.root || !this.board.windows.includes(frame)) return
    this.active = frame
    this.sync()
  }

  sync() {
    if (!this.root) return
    if (this.main.editMode || !this.board.windows.includes(this.active)) this.active = this.board.windows[0]
    this.shape.value = this.main.nodeStyle
    this.size.value = this.main.cardSize || 'medium'
    for (const [index, frame] of this.board.windows.entries()) {
      const active = frame === this.active
      frame.pane.classList.toggle('is-toolbar-active', active && this.board.windows.length > 1)
      frame.pane.setAttribute('aria-label', `${index ? 'Right' : 'Left'} tree window${active ? '; zoom controls active' : ''}`)
      frame.tools.hidden = true
      const cluster = frame.graph.zoomerEl
      cluster.hidden = !active
      const target = active ? this.zoomSlot : this.parking
      if (cluster.parentElement !== target) target.appendChild(cluster)
      frame.graph.fitEl.textContent = 'Fit'
      cluster.setAttribute('aria-label', this.board.windows.length > 1 ? `Zoom ${index ? 'right' : 'left'} tree window` : 'Zoom tree window')
      if (frame.graph.cardsToggle) frame.graph.cardsToggle.hidden = this.main.nodeStyle !== 'circles'
    }
    if (this.main.linkToggle) this.main.linkToggle.textContent = 'Link'
    this.root.dataset.shape = this.main.nodeStyle
  }

  destroy() {
    if (!this.root) return
    for (const frame of this.board.windows) {
      frame.graph.zoomerEl.hidden = false
      frame.tools.hidden = false
      frame.tools.appendChild(frame.graph.zoomerEl)
    }
    this.settings.remove()
    if (this.editActions && this.editHome) this.editHome.appendChild(this.editActions)
    this.zoomSlot.remove()
    this.parking.remove()
    this.owner.classList.remove('tree-toolbar-owner')
    this.root.classList.remove('tree-action-bar')
  }
}
