// The metrics page's customization layer — "build your own instrument panel".
//
// The standard arrangement stays the default: an untouched user sees the
// committed page, DOM-for-DOM (full-size components stay direct children of
// .metrics; only rows that genuinely share — 2-up/3-up slot rows — gain a
// .m-srow wrapper, which carries the exact grid the old .m-row3 did).
//
// MODEL — an ordered list of rows; a row is one `full` component or 1–3
// `slot` components. Serialized to localStorage under mc.metrics.layout
// (guarded try/catch, the mc.theme / mc.graph.layout idiom) as
// { v: 1, rows: [[id...]] }. Components absent from rows live in the tray.
// Absent/corrupt/over-cap key → the standard arrangement. The standard
// arrangement itself is stored as ABSENCE (the key is removed), so an
// untouched user can never be pinned to a stale copy of the default.
//
// EDIT MODE — the graph page's Edit is the precedent: a quiet button arms
// it, dashes mean "structure is movable" (graph.css doctrine), Done exits.
// Drag mirrors the comms watch-board machinery pattern-for-pattern (7px
// threshold before a drag starts, body-level ghost chasing the pointer,
// pointerup/pointercancel/Escape all funnel through one teardown) — but the
// indicators are this page's own: a between-row insert line for new-row
// drops, a left/right half overlay for joining a slot row. A `full`
// component dragged over a slot row shows the between-row line, never a
// half-highlight — it cannot join, and the indicator must not suggest it.
//
// CHARTS SURVIVE MOVES — components are MOVED (appendChild), never rebuilt:
// every echarts instance, ResizeObserver subscription and echarts.connect
// group rides its element across the reparent; the view resizes the engine
// once per arrangement change (onArrange). Removed components park in an
// off-screen stash (laid out at 1100px, visibility:hidden) so their engine
// instances keep real dimensions and re-adding is a move + resize, not a
// rebuild.

import { el } from './components.js'
import './metrics-layout.css'

const GRIP = `<svg viewBox="0 0 10 14" aria-hidden="true"><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11.5" r="1.2"/><circle cx="7" cy="11.5" r="1.2"/></svg>`

export function createMetricsLayout({
  container,          // the .metrics element
  filterRow,          // the .m-filter element — the tray pins under it
  editBtn,            // the "Edit layout" button in the filter row
  components,         // [{ id, title, el, size:'full'|'slot', headSelector?, weight?, maxShare?, slimClass?, optional? }]
  standard,           // [['stats'],...] — the committed arrangement
  storageKey = 'mc.metrics.layout',
  reduced = () => false,
  onEditChange = () => {},
  onArrange = () => {},
}) {
  const byId = Object.fromEntries(components.map(c => [c.id, c]))
  const deep = (r) => r.map(x => x.slice())

  /* ---------------- persistence ---------------- */

  function validRows(parsed) {
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rows)) return null
    const seen = new Set()
    const rows = []
    for (const r of parsed.rows) {
      if (!Array.isArray(r) || !r.length || r.length > 3) return null
      for (const id of r) {
        if (typeof id !== 'string' || !byId[id] || seen.has(id)) return null
        seen.add(id)
      }
      if (r.length > 1) {
        if (r.some(id => byId[id].size !== 'slot')) return null
        if (r.length > Math.min(3, ...r.map(id => byId[id].maxShare ?? 3))) return null
      }
      rows.push(r.slice())
    }
    return rows
  }

  function load() {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return deep(standard)
      return validRows(JSON.parse(raw)) || deep(standard)
    } catch { return deep(standard) }
  }

  const isStandard = () => JSON.stringify(rows) === JSON.stringify(standard)

  function save() {
    try {
      if (isStandard()) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, JSON.stringify({ v: 1, rows }))
    } catch {}
  }

  /* ---------------- state ---------------- */

  let rows = load()
  // Reading an explanation changes this visit's display, never saved rows.
  const temporary = new Set()
  let editing = false
  let destroyed = false
  let drag = null          // in-flight pointer drag
  let carry = null         // in-flight keyboard move
  let teardown = null      // one exit path for pointerup/cancel/Escape/destroy
  let rowEls = []          // rendered row elements, in rows order

  const removedIds = () => {
    const placed = new Set(rows.flat())
    return components.filter(c => !placed.has(c.id)).map(c => c.id)
  }

  /* ---------------- fixed chrome (tray · stash · overlays) ---------------- */

  const tray = el(`
    <div class="m-tray" id="m-tray">
      <span class="m-tray-label">components</span>
      <span class="m-tray-chips"></span>
      <span class="spacer"></span>
      <span class="m-tray-live" aria-live="polite"></span>
      <button type="button" class="m-reset">Reset</button>
    </div>`)
  filterRow.after(tray)
  const chipsEl = tray.querySelector('.m-tray-chips')
  const liveEl = tray.querySelector('.m-tray-live')
  tray.querySelector('.m-reset').addEventListener('click', () => {
    rows = deep(standard)
    commit()
  })

  const stash = el(`<div class="m-stash" aria-hidden="true"></div>`)
  container.appendChild(stash)

  // body-level, position:fixed, pointer-events:none — indicator geometry is
  // set from rects each frame, so no component ever needs position:relative
  // (a positioned band would steal the pool tooltips' containing block)
  const insline = el(`<div class="m-insline" hidden></div>`)
  const joinbox = el(`<div class="m-joinbox" hidden><i></i></div>`)
  document.body.append(insline, joinbox)

  /* ---------------- render: the model IS the DOM order ---------------- */

  function render() {
    // 1. anything not placed parks in the stash, alive
    const displayRows = [...rows, ...[...temporary].filter(id => !rows.some(row => row.includes(id))).map(id => [id])]
    const placed = new Set(displayRows.flat())
    for (const c of components) if (!placed.has(c.id)) stash.appendChild(c.el)
    // 2. rows re-append in order (appendChild MOVES — charts ride along)
    const oldWraps = [...container.querySelectorAll(':scope > .m-srow')]
    rowEls = displayRows.map(row => {
      if (row.length === 1) {
        const e = byId[row[0]].el
        container.appendChild(e)
        return e
      }
      const w = document.createElement('div')
      w.className = 'm-srow'
      /* `minmax(0, Nfr)`, NOT a bare `Nfr`. A bare fr track floors at its
         content's min-content width, so one instrument whose contents cannot
         shrink (an echarts host carrying zrender's inline pixel width, a long
         unbroken sentence) widens the whole row past its container and the page
         scrolls sideways. `.m-srow > * { min-width: 0 }` in metrics-layout.css
         handles the ITEM; this handles the TRACK, and both are needed. */
      w.style.setProperty('--srow-cols', row.map(id => `minmax(0, ${byId[id].weight ?? 1}fr)`).join(' '))
      for (const id of row) w.appendChild(byId[id].el)
      container.appendChild(w)
      return w
    })
    for (const w of oldWraps) if (!w.childElementCount) w.remove()
    // 3. components that share a row may declare a slim skin (pools drops
    //    its internal 3-up so its cards stay legible at slot width)
    for (const c of components) {
      if (!c.slimClass) continue
      const row = rows.find(r => r.includes(c.id))
      c.el.classList.toggle(c.slimClass, !!row && row.length > 1)
    }
  }

  function commit() {
    render()
    save()
    syncTray()
    onArrange()
  }

  /* ---------------- edit mode ---------------- */

  function syncEditBtn() {
    editBtn.textContent = editing ? 'Done' : 'Edit layout'
    editBtn.classList.toggle('on', editing)
    editBtn.setAttribute('aria-pressed', String(editing))
  }

  function setEdit(on, { persist = true } = {}) {
    if (destroyed || editing === !!on) return
    if (!on) { teardown?.(); if (carry) cancelCarry() }
    if (on && temporary.size) { temporary.clear(); render(); onArrange() }
    editing = !!on
    container.classList.toggle('m-editing', editing)
    if (editing) injectChrome()
    else removeChrome()
    syncEditBtn()
    syncTray()
    if (!editing && persist) save()               // Done persists (usually a no-op — every mutation already saved)
    onEditChange(editing)
  }
  const onEditClick = () => setEdit(!editing)
  editBtn.addEventListener('click', onEditClick)

  function injectChrome() {
    for (const c of components) {
      let head = c.el.querySelector(c.headSelector || ':scope > .m-head')
      if (head && c.headSelector) {
        head.classList.add('m-layout-head')
        c._hostHead = head
      }
      if (!head) {
        /* stats and pools have no title row; edit mode gives them one so the
           grip/× land in a title row like everywhere else — and the label
           names an OTHERWISE UNLABELLED component while it is movable.
           "Otherwise unlabelled" is the whole of it: a component that already
           carries its own accessible name renders that name itself, so adding
           the caption printed the title twice. The research page's nine
           sections are `aria-labelledby` their own <h2>, and edit mode stacked
           an identical caption above each one. Keep the row — the grip/× still
           need somewhere to land — and drop only the duplicate caption. The
           title is NOT lost: it still names the grip and the × below, which is
           where a screen reader needs it while the component is being moved. */
        const namesItself = c.el.hasAttribute('aria-labelledby') || c.el.hasAttribute('aria-label')
        const caption = namesItself ? '' : `<span class="mt">${c.title}</span>`
        /* MARK THE ROW WHEN IT CARRIES NO CAPTION. Without the caption this row
           holds only the spacer and the grip/x pair, so left in flow it prints a
           blank band above a section that already shows its own heading. The row
           cannot be dropped -- the controls live in it -- so the stylesheet lifts
           the marked row out of flow instead. The marker is needed because `:empty`
           cannot express this: the row still contains the spacer and the control
           group, so it is empty of CAPTION, not empty of DOM, and a `:empty` rule
           would never match while looking applied. */
        const bare = namesItself ? ' m-edit-head-bare' : ''
        head = el(`<div class="m-head m-edit-head${bare}">${caption}<span class="spacer"></span></div>`)
        c.el.prepend(head)
        c._editHead = head
      }
      // heads without a right-side group (sankey, verdicts) get an edit-only
      // spacer so every grip/× pair right-aligns like the rest
      if (!c.headSelector && !head.querySelector(':scope > .spacer')) {
        c._editSpacer = el(`<span class="spacer"></span>`)
        head.appendChild(c._editSpacer)
      }
      const ctl = el(`
        <span class="m-editctl">
          <button type="button" class="m-grip" aria-label="Move ${c.title}: Enter picks up, arrow keys move, Enter drops, Escape cancels">${GRIP}</button>
          <button type="button" class="m-x" aria-label="Remove ${c.title}">×</button>
        </span>`)
      head.appendChild(ctl)
      c._ctl = ctl
      c._grip = ctl.querySelector('.m-grip')
      ctl.querySelector('.m-x').addEventListener('click', () => removeToTray(c))
      c._grip.addEventListener('pointerdown', (e) => onGripPointerDown(e, c, null))
      c._grip.addEventListener('keydown', (e) => onGripKey(e, c))
    }
  }

  function removeChrome() {
    for (const c of components) {
      c._ctl?.remove(); c._ctl = null; c._grip = null
      c._editSpacer?.remove(); c._editSpacer = null
      c._editHead?.remove(); c._editHead = null
      c._hostHead?.classList.remove('m-layout-head'); c._hostHead = null
      c.el.classList.remove('m-carry', 'm-dragsrc')
    }
  }

  /* ---------------- tray ---------------- */

  function syncTray() {
    if (!editing) { chipsEl.innerHTML = '' ; return }
    const ids = removedIds()
    chipsEl.innerHTML = ''
    if (!ids.length) {
      chipsEl.appendChild(el(`<span class="m-tray-empty">all components placed</span>`))
      return
    }
    /* Optional instruments deliberately begin outside `standard`. When every
       standard component is placed, name that state without pretending the
       tray is empty: the remaining chips are discoveries, not damage to the
       committed layout. The dual class keeps the older layout probe's
       "standard restored" sentinel meaningful while its component roster is
       still six rows long. */
    const placed = new Set(rows.flat())
    if (standard.flat().every(id => placed.has(id)) && ids.some(id => byId[id].optional)) {
      chipsEl.appendChild(el(`<span class="m-tray-empty m-tray-standard">standard placed · optional</span>`))
    }
    for (const id of ids) {
      const c = byId[id]
      const chip = el(`<button type="button" class="m-chip" data-chip="${id}" aria-label="${c.title} — removed. Drag back onto the page, or press Enter to re-add">${c.title}</button>`)
      chip.addEventListener('pointerdown', (e) => onGripPointerDown(e, c, chip))
      chip.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        rows.push([c.id])
        commit()
        requestAnimationFrame(() => c._grip?.focus())
      })
      chipsEl.appendChild(chip)
    }
  }

  function removeToTray(c) {
    if (destroyed || !editing) return
    if (carry?.comp === c) cancelCarry()
    detach(c.id)
    commit()
    const chip = chipsEl.querySelector(`[data-chip="${c.id}"]`)
    chip?.focus()
  }

  function detach(id) {
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i].indexOf(id)
      if (k >= 0) {
        rows[i].splice(k, 1)
        if (!rows[i].length) rows.splice(i, 1)
        return
      }
    }
  }

  /* ---------------- pointer drag (comms wb-* lifecycle) ---------------- */

  function onGripPointerDown(e, comp, chip) {
    if (e.button !== 0 || drag || carry) return
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY
    let started = false
    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 7) return
        beginDrag(comp, chip, ev)
        started = true
      }
      dragMove(ev)
    }
    const up = () => { if (started) endDrag(); cleanup() }
    const cancel = () => { if (started) abortDrag(); cleanup() }
    function cleanup() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      teardown = null
    }
    teardown = () => { if (started) abortDrag(); cleanup() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  function beginDrag(comp, chip, ev) {
    const ghost = el(`<div class="m-ghost">${comp.title}</div>`)
    document.body.appendChild(ghost)
    const src = chip || comp.el
    src.classList.add('m-dragsrc')
    document.body.classList.add('m-dragging')
    drag = { comp, src, ghost, pending: null, fromTray: !!chip }
    dragMove(ev)
  }

  function clearIndicators() {
    insline.hidden = true
    joinbox.hidden = true
    tray.classList.remove('m-tray-drop')
  }

  function dragMove(ev) {
    ev.preventDefault()
    const d = drag
    d.ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 12}px)`
    clearIndicators()
    d.pending = null

    // A placed component can be dragged straight back to the tray. Chips
    // already originating there ignore this target (dropping a chip onto its
    // own tray would be an identity operation, not a removal).
    if (!d.fromTray) {
      const tr = tray.getBoundingClientRect()
      if (ev.clientX >= tr.left && ev.clientX <= tr.right && ev.clientY >= tr.top && ev.clientY <= tr.bottom) {
        tray.classList.add('m-tray-drop')
        d.pending = { type: 'tray' }
        return
      }
    }

    // join a slot row? (slot components only — a full component physically
    // cannot share, so it only ever sees the between-row line)
    if (d.comp.size === 'slot') {
      const tEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-mc]')
      if (tEl && container.contains(tEl) && !stash.contains(tEl)) {
        const tid = tEl.dataset.mc
        const trow = rows.find(r => r.includes(tid))
        if (trow && tid !== d.comp.id && byId[tid].size === 'slot') {
          const members = trow.filter(id => id !== d.comp.id)
          const cap = Math.min(3, ...members.map(id => byId[id].maxShare ?? 3), d.comp.maxShare ?? 3)
          if (members.length && members.length < cap) {
            const r = tEl.getBoundingClientRect()
            const side = ev.clientX < r.left + r.width / 2 ? 'left' : 'right'
            joinbox.hidden = false
            joinbox.dataset.side = side
            joinbox.style.left = `${r.left}px`
            joinbox.style.top = `${r.top}px`
            joinbox.style.width = `${r.width}px`
            joinbox.style.height = `${r.height}px`
            d.pending = { type: 'join', targetId: tid, side }
            return
          }
        }
      }
    }

    // between-row insert line at the nearest valid gap
    const g = nearestGap(ev.clientX, ev.clientY)
    if (g) {
      insline.hidden = false
      insline.style.left = `${g.x}px`
      insline.style.width = `${g.w}px`
      insline.style.top = `${g.y}px`
      d.pending = { type: 'row', anchorId: g.anchorId }
    }
  }

  function nearestGap(px, py) {
    if (!rowEls.length) return null
    const cr = container.getBoundingClientRect()
    if (px < cr.left - 60 || px > cr.right + 60) return null
    const rects = rowEls.map(e => e.getBoundingClientRect())
    // the dragged component alone in a row: the two gaps hugging that row
    // are identity drops — no indicator for a move that moves nothing
    const solo = rows.findIndex(r => r.length === 1 && r[0] === drag.comp.id)
    let best = null
    for (let i = 0; i <= rects.length; i++) {
      if (solo >= 0 && (i === solo || i === solo + 1)) continue
      const y = i === 0 ? rects[0].top - 8
        : i === rects.length ? rects[rects.length - 1].bottom + 8
        : (rects[i - 1].bottom + rects[i].top) / 2
      const dist = Math.abs(y - py)
      if (!best || dist < best.dist) best = { i, y, dist }
    }
    if (!best) return null
    const anchorRow = best.i < rows.length ? rows[best.i] : null
    return {
      y: best.y,
      x: cr.left + 2,
      w: cr.width - 4,
      anchorId: anchorRow ? anchorRow.find(id => id !== drag.comp.id) ?? null : null,
    }
  }

  function endDrag() {
    const p = drag.pending
    const comp = drag.comp
    settleGhost()
    if (p) {
      detach(comp.id)
      if (p.type === 'tray') {
        // detached above; the shared commit below parks it and emits its chip
      } else if (p.type === 'join') {
        const row = rows.find(r => r.includes(p.targetId))
        if (row) row.splice(row.indexOf(p.targetId) + (p.side === 'right' ? 1 : 0), 0, comp.id)
        else rows.push([comp.id])
      } else {
        const at = p.anchorId == null ? rows.length : rows.findIndex(r => r.includes(p.anchorId))
        rows.splice(at < 0 ? rows.length : at, 0, [comp.id])
      }
      commit()
    }
    drag = null
  }

  function abortDrag() { settleGhost(); drag = null }

  function settleGhost() {
    const { ghost, src } = drag
    clearIndicators()
    src.classList.remove('m-dragsrc')
    document.body.classList.remove('m-dragging')
    if (reduced()) { ghost.remove(); return }
    ghost.animate([{ opacity: 0.92 }, { opacity: 0 }], { duration: 150, easing: 'ease-out' })
      .finished.then(() => ghost.remove()).catch(() => ghost.remove())
  }

  /* ---------------- keyboard move (grip = a real button) ---------------- */

  function onGripKey(e, comp) {
    if (carry && carry.comp === comp) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commitCarry() }
      else if (e.key === 'Escape') { e.preventDefault(); cancelCarry() }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); stepCarry(-1) }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); stepCarry(1) }
      return
    }
    if ((e.key === 'Enter' || e.key === ' ') && !drag && !carry) {
      e.preventDefault()
      startCarry(comp)
    }
  }

  function carryPositions(comp, base) {
    const positions = []
    for (let i = 0; i <= base.length; i++) {
      positions.push({ type: 'gap', i })
      if (i >= base.length) continue
      const row = base[i]
      if (comp.size !== 'slot' || row.some(id => byId[id].size !== 'slot')) continue
      const cap = Math.min(3, ...row.map(id => byId[id].maxShare ?? 3), comp.maxShare ?? 3)
      if (row.length >= cap) continue
      for (let k = 0; k <= row.length; k++) positions.push({ type: 'join', i, at: k })
    }
    return positions
  }

  function startCarry(comp) {
    const origin = deep(rows)
    const base = rows.map(r => r.filter(id => id !== comp.id)).filter(r => r.length)
    const positions = carryPositions(comp, base)
    // the component's current placement, expressed against `base`
    let idx = 0
    const ri = rows.findIndex(r => r.includes(comp.id))
    if (ri >= 0) {
      // rows before ri never contain comp, so they all survive into `base`:
      // the comp's placement re-expressed against base keeps index ri
      const want = rows[ri].length === 1
        ? { type: 'gap', i: ri }
        : { type: 'join', i: ri, at: rows[ri].indexOf(comp.id) }
      idx = positions.findIndex(p => p.type === want.type && p.i === want.i && (p.type === 'gap' || p.at === want.at))
      if (idx < 0) idx = 0
    }
    carry = { comp, origin, base, positions, idx }
    comp.el.classList.add('m-carry')
    announce()
  }

  function applyCarry() {
    const { comp, base, positions, idx } = carry
    const p = positions[idx]
    rows = base.map(r => r.slice())
    if (p.type === 'gap') rows.splice(p.i, 0, [comp.id])
    else rows[p.i].splice(p.at, 0, comp.id)
    render()
    comp._grip?.focus()             // the move unseats focus; put it back on the grip
  }

  function stepCarry(d) {
    const n = carry.positions.length
    carry.idx = Math.max(0, Math.min(n - 1, carry.idx + d))
    applyCarry()
    announce()
  }

  function announce() {
    const { comp, positions, idx } = carry
    liveEl.textContent = `${comp.title}: position ${idx + 1} of ${positions.length}`
  }

  function commitCarry() {
    const comp = carry.comp
    comp.el.classList.remove('m-carry')
    liveEl.textContent = `${comp.title} placed`
    carry = null
    commit()
    comp._grip?.focus()
  }

  function cancelCarry() {
    const { comp, origin } = carry
    rows = origin
    comp.el.classList.remove('m-carry')
    liveEl.textContent = ''
    carry = null
    render()
    comp._grip?.focus()
  }

  /* ---------------- global escape (comms audit #27 pattern) ---------------- */

  const onKey = (ev) => {
    if (ev.key !== 'Escape') return
    if (drag) { teardown?.(); return }
    if (carry) cancelCarry()
  }
  window.addEventListener('keydown', onKey)

  /* ---------------- boot ---------------- */

  render()
  syncEditBtn()

  return {
    get editing() { return editing },
    rows: () => deep(rows),
    reveal(id, { persist = true } = {}) {
      if (destroyed || !byId[id] || rows.some(row => row.includes(id))) return
      if (!persist) {
        if (editing) setEdit(false, { persist: false })
        temporary.add(id)
        render()
        onArrange()
        return
      }
      temporary.delete(id)
      rows.push([id])
      commit()
    },
    reload() {
      setEdit(false)
      temporary.clear()
      rows = load()
      render()
      onArrange()
    },
    setEdit,
    destroy() {
      if (destroyed) return
      destroyed = true
      teardown?.()
      if (carry) cancelCarry()
      editing = false
      container.classList.remove('m-editing')
      removeChrome()
      syncEditBtn()
      editBtn.removeEventListener('click', onEditClick)
      window.removeEventListener('keydown', onKey)
      tray.remove()
      insline.remove()
      joinbox.remove()
      document.body.classList.remove('m-dragging')
    },
  }
}
