const common = new Set(['cloud', 'goal', 'loop', 'queue', 'model', 'copy-reply', 'retry-start', 'retry-account-recovery', 'switch-continue', 'child', 'helper-copy', 'move', 'resume', 'interrupt', 'stop', 'clear', 'remove'])
const chatRouted = new Set(['cloud', 'goal', 'queue', 'attach', 'mention'])
let activeMenu = null
let nextId = 0

export function nodeMenuRows(rows, navigation = []) {
  return [...navigation.filter(row => !['all-actions', 'close-tab'].includes(row.id)),
    ...rows.filter(row => common.has(row.id)), ...navigation.filter(row => ['all-actions', 'close-tab'].includes(row.id))]
}

// One menu across every graph. Re-read action state at activation, including
// confirmation steps, so a stale enabled row never authorizes an operation.
export function openNodeActionMenu({ anchor, fallback = anchor, title, rows, subscribe, openInChat, point, keyboard = false, valid = () => true }) {
  activeMenu?.close(false)
  const doc = anchor.ownerDocument, win = doc.defaultView
  const root = doc.createElement('section')
  root.className = 'node-menu'
  root.tabIndex = -1
  root.setAttribute('role', 'menu')
  root.setAttribute('aria-label', `Actions for ${title}`)
  root.setAttribute('popover', 'manual')
  const status = doc.createElement('p')
  status.className = 'node-menu-status'
  status.setAttribute('role', 'status')
  const list = doc.createElement('div')
  root.append(list, status)
  const opener = keyboard ? doc.activeElement : anchor
  const stack = [{ rows, title }], listeners = new Set()
  let closed = false, unsub, signature = '', buttons = [], running = false
  const say = text => { if (!closed) status.textContent = String(text || '') }
  const close = (restore = true) => {
    if (closed) return
    closed = true
    unsub?.()
    observer.disconnect()
    doc.removeEventListener('pointerdown', outside, true)
    doc.removeEventListener('keydown', escape, true)
    doc.removeEventListener('focusin', focusLeft)
    win.removeEventListener('resize', dismiss)
    win.removeEventListener('blur', dismiss)
    root.remove()
    if (activeMenu === api) activeMenu = null
    for (const listener of listeners) listener()
    if (restore) (opener?.isConnected ? opener : fallback)?.focus({ preventScroll: true })
  }
  const dismiss = () => close()
  const outside = event => { if (!root.contains(event.target)) close(false) }
  const escape = event => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation(); close()
  }
  const focusLeft = () => queueMicrotask(() => {
    if (!closed && !root.contains(doc.activeElement)) close(false)
  })
  const observer = new win.MutationObserver(() => {
    if (!anchor.isConnected || !valid() || doc.querySelector('dialog[open], .drawer.is-open')) close(false)
  })
  function readRows() {
    const step = stack.at(-1)
    const value = typeof step.rows === 'function' ? step.rows() : step.rows
    if (!Array.isArray(value)) throw new Error('Actions are unavailable. Close this menu and try again.')
    for (const row of value) if (row.enabled === false && !row.disabledHint) throw new Error('An action is unavailable without an explanation. Close this menu and try again.')
    return stack.length > 1 ? [{ id: 'menu-back', label: 'Back', enabled: true, run: () => { stack.pop(); refresh(true) } }, ...value] : value
  }
  function position() {
    const rect = anchor.getBoundingClientRect()
    const zoom = Number.parseFloat(win.getComputedStyle(doc.body).zoom) || 1
    const x = (point?.x ?? rect.left) / zoom, y = (point?.y ?? rect.bottom) / zoom
    const width = win.innerWidth / zoom, height = win.innerHeight / zoom
    root.style.left = `${Math.max(4, Math.min(x, width - root.offsetWidth - 4))}px`
    root.style.top = `${Math.max(4, Math.min(y, height - root.offsetHeight - 4))}px`
  }
  function refresh(focusFirst = false) {
    if (closed) return
    if (!valid()) { close(false); return }
    let current
    try { current = readRows() } catch (error) {
      say(error.message)
      current = [{ id: 'actions-unavailable', label: 'Actions could not be read. Close this menu and try again.', enabled: false, disabledHint: error.message }]
    }
    const state = JSON.stringify([stack.at(-1).title, current.map(({ id, label, hint, enabled, disabledHint, current, minutes, group }) => [id, label, hint, enabled, disabledHint, current, minutes, group])])
    if (state === signature && !focusFirst) return
    signature = state
    const focusedId = doc.activeElement?.dataset.menuAction
    const wasInside = root.contains(doc.activeElement)
    list.replaceChildren()
    const heading = doc.createElement('div')
    heading.className = 'node-menu-title'; heading.textContent = stack.at(-1).title
    heading.setAttribute('aria-hidden', 'true'); list.append(heading)
    buttons = []
    let lastGroup, group = list
    for (const row of current) {
      if (row.group !== lastGroup) {
        lastGroup = row.group; group = list
        if (lastGroup) {
          group = doc.createElement('div'); group.setAttribute('role', 'group')
          const caption = doc.createElement('div'); caption.id = `node-menu-group-${++nextId}`
          caption.className = 'node-menu-group'; caption.textContent = lastGroup
          caption.setAttribute('aria-hidden', 'true'); group.setAttribute('aria-labelledby', caption.id)
          group.append(caption); list.append(group)
        }
      }
      const button = doc.createElement('button')
      button.type = 'button'; button.tabIndex = -1; button.dataset.menuAction = row.id
      button.setAttribute('role', typeof row.current === 'boolean' ? 'menuitemradio' : 'menuitem')
      if (typeof row.current === 'boolean') button.setAttribute('aria-checked', String(row.current))
      button.setAttribute('aria-disabled', String(row.enabled === false))
      const label = doc.createElement('span'); label.id = `node-menu-label-${++nextId}`
      label.textContent = row.minutes ? `${row.label} · ${row.minutes} min.` : row.label
      button.setAttribute('aria-labelledby', label.id); button.append(label)
      const hint = row.enabled === false ? row.disabledHint : row.hint
      if (hint) {
        const detail = doc.createElement('small'); detail.id = `node-menu-hint-${++nextId}`; detail.textContent = hint
        button.setAttribute('aria-describedby', detail.id); button.append(detail)
      }
      button.addEventListener('pointermove', () => button.focus({ preventScroll: true }))
      button.addEventListener('click', () => { void activate(row.id) })
      group.append(button); buttons.push(button)
    }
    position()
    if (focusFirst || wasInside) (buttons.find(button => button.dataset.menuAction === focusedId)
      || buttons.find(button => button.getAttribute('aria-disabled') !== 'true') || root).focus({ preventScroll: true })
  }
  async function activate(id) {
    if (closed || running || !valid()) return
    let row
    try { row = readRows().find(candidate => candidate.id === id) } catch (error) { say(error.message); return }
    if (!row) { refresh(); return }
    if (row.enabled === false) { say(row.disabledHint); refresh(); return }
    const route = () => { close(false); openInChat?.(id) }
    if (chatRouted.has(id)) { route(); return }
    running = true
    try {
      await row.run?.({ say, close, onClose: listener => listeners.add(listener), refresh,
        show: (next, options = {}) => { stack.push({ rows: next, title: options.title || title }); refresh(true) },
        compose: route, composer: { focus: route, attach: route, mention: route },
      })
    } catch (error) { say(error.message || 'The action could not finish. Try again.') }
    finally { running = false; refresh() }
  }
  root.addEventListener('contextmenu', event => event.preventDefault())
  root.addEventListener('keydown', event => {
    event.stopPropagation()
    if (event.key === 'Tab') { event.preventDefault(); close(); return }
    if (event.key === 'ArrowLeft' && stack.length > 1) { event.preventDefault(); stack.pop(); refresh(true); return }
    const index = buttons.indexOf(doc.activeElement)
    let next
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length
    else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = buttons.length - 1
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      const matches = buttons.map((button, n) => ({ button, n })).filter(({ button }) => button.firstElementChild.textContent.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))
      next = matches.find(({ n }) => n > index)?.n ?? matches[0]?.n
    }
    if (next !== undefined && buttons[next]) { event.preventDefault(); buttons[next].focus({ preventScroll: true }) }
  })
  const api = { root, close, refresh }
  activeMenu = api
  doc.body.append(root)
  root.showPopover?.()
  refresh()
  if (keyboard) (buttons.find(button => button.getAttribute('aria-disabled') !== 'true') || root).focus({ preventScroll: true })
  else root.focus({ preventScroll: true })
  doc.addEventListener('pointerdown', outside, true)
  doc.addEventListener('keydown', escape, true)
  doc.addEventListener('focusin', focusLeft)
  win.addEventListener('resize', dismiss)
  win.addEventListener('blur', dismiss)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'open'] })
  unsub = subscribe?.(() => refresh())
  return api
}

// Touch uses the same door as a context-menu key. Moving, releasing, adding a
// second finger or leaving the surface cancels before the long press fires.
export function bindNodeMenuGestures(host, open, { allowTouch = () => true, matches = target => target.closest?.('.static-tree-node, .static-tree-chip, .tree-chat-tab') } = {}) {
  let pending = null, suppressed = null
  const cancel = () => { if (pending) clearTimeout(pending.timer); pending = null }
  const context = event => { cancel(); open(event, false) }
  const key = event => {
    cancel()
    if (!event.repeat && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) open(event, true)
  }
  const down = event => {
    cancel(); suppressed = null
    if (event.pointerType !== 'touch' || event.isPrimary === false || !allowTouch() || !matches(event.target)
      || event.target.closest?.('input, textarea, select, [contenteditable], .chat, .tree-conversation, .chip.as-chat')) return
    const press = { id: event.pointerId, x: event.clientX, y: event.clientY, target: event.target }
    press.timer = setTimeout(() => {
      if (pending !== press || !allowTouch() || !press.target.isConnected) return
      pending = null; suppressed = press.target
      open({ target: press.target, clientX: press.x + 12, clientY: press.y + 12,
        preventDefault() {}, stopPropagation() {} }, false)
    }, 550)
    pending = press
  }
  const move = event => {
    if (pending && (event.pointerId !== pending.id || Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10)) cancel()
  }
  const click = event => {
    if (suppressed && (event.target === suppressed || suppressed.closest?.('.static-tree-node, .static-tree-chip, .tree-chat-tab')?.contains(event.target))) {
      event.preventDefault(); event.stopImmediatePropagation()
    }
    suppressed = null
  }
  const events = [['contextmenu', context], ['keydown', key], ['pointerdown', down], ['pointermove', move],
    ['pointerup', cancel], ['pointercancel', cancel], ['lostpointercapture', cancel], ['scroll', cancel], ['click', click]]
  for (const [name, listener] of events) host.addEventListener(name, listener, true)
  return () => { cancel(); for (const [name, listener] of events) host.removeEventListener(name, listener, true) }
}
