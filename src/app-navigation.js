const COLLAPSED_KEY = 'mc.navigation.collapsed'
/* ONE ICON SET, drawn on one 24-unit grid at a 1.75 stroke with round caps
   and joins, optically centred in a 20px box: the pages, then Guide, Quick
   settings and the two history arrows, so every row of the rail carries the
   same weight of line (owner, 2026-09-19 late: "the left sidebar needs a real
   upgrade"). */
const ICONS = {
  home: '<path d="M3.5 10.6 12 3.6l8.5 7"/><path d="M5.6 9.4V20h12.8V9.4"/><path d="M10 20v-5.4h4V20"/>',
  computers: '<rect x="3" y="4.5" width="18" height="12" rx="2.5"/><path d="M8.5 20h7M12 16.5V20"/>',
  metrics: '<path d="M4 19.5h16"/><path d="M6.5 15.5v-4M11 15.5v-9M15.5 15.5v-3M20 15.5V9"/>',
  research: '<circle cx="10.5" cy="10.5" r="6.2"/><path d="m15.2 15.2 4.8 4.8"/>',
  comms: '<path d="M4 5.5h16v10.5H9.6L5.6 19.6v-3.6H4Z"/>',
  ledger: '<rect x="5" y="3.5" width="14" height="17" rx="2.2"/><path d="M8.5 8.2h7M8.5 12h7M8.5 15.8h4"/>',
  vault: '<rect x="5.5" y="10" width="13" height="10.5" rx="2.2"/><path d="M8.5 10V7a3.5 3.5 0 0 1 7 0v3M12 14v2.5"/>',
  settings: '<path d="M4 7.2h16M4 16.8h16"/><circle cx="9.5" cy="7.2" r="2.4"/><circle cx="14.5" cy="16.8" r="2.4"/>',
  guide: '<circle cx="12" cy="12" r="8.6"/><path d="M9.7 9.5a2.4 2.4 0 1 1 3.4 2.2c-.7.35-1.1.9-1.1 1.7"/><path d="M12 16.9h.01"/>',
  quick: '<circle cx="12" cy="12" r="3"/><path d="M12 3.2v2.4M12 18.4v2.4M3.2 12h2.4M18.4 12h2.4M5.8 5.8l1.7 1.7M16.5 16.5l1.7 1.7M5.8 18.2l1.7-1.7M16.5 7.5l1.7-1.7"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
}
const svgOf = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.home}</svg>`

// Move the existing controls so routing, keyboard shortcuts and their current
// accessible names remain owned by the shell. Phone canvas keeps its own bar.
export function mountAppNavigation({ documentRef = globalThis.document, layout = 'side' } = {}) {
  const bar = documentRef?.querySelector('header.topbar')
  const nav = bar?.querySelector('#tb-nav')
  if (!nav) return { setLayout() {}, setBadge() {}, destroy() {} }
  if (bar.appNavigation) return bar.appNavigation
  const body = documentRef.body
  const left = bar.querySelector('.tb-left')
  const right = bar.querySelector('.tb-right')
  const back = bar.querySelector('#nav-back')
  const next = bar.querySelector('#nav-next')
  const settings = bar.querySelector('#open-settings')
  const guide = bar.querySelector('#page-guide')
  const collapse = bar.querySelector('[data-navigation-collapse]')
  const footer = documentRef.createElement('div')
  footer.className = 'app-nav-footer'
  const history = documentRef.createElement('div')
  history.className = 'app-nav-history'
  history.setAttribute('role', 'group')
  history.setAttribute('aria-label', 'Navigate pages')
  let collapsed = false
  try { collapsed = globalThis.localStorage?.getItem(COLLAPSED_KEY) === 'true' } catch {}
  let requestedLayout = layout
  let activeLayout = ''
  const iconSpan = name => {
    const icon = documentRef.createElement('span')
    icon.className = 'app-nav-icon'
    icon.innerHTML = svgOf(name)
    return icon
  }
  const badges = new Map()
  for (const link of nav.querySelectorAll('[data-route]')) {
    const name = link.textContent.trim()
    link.setAttribute('aria-label', name)
    link.title = name
    const label = documentRef.createElement('span')
    label.className = 'app-nav-label'
    while (link.firstChild) label.appendChild(link.firstChild)
    link.append(iconSpan(link.dataset.route), label)
    /* A COUNT SLOT on Messages and Ledger: drawn only when something sets a
       count through setBadge (nothing does yet), so the hook costs nothing. */
    if (link.dataset.route === 'comms' || link.dataset.route === 'ledger') {
      const badge = documentRef.createElement('span')
      badge.className = 'app-nav-badge'
      badge.hidden = true
      badge.setAttribute('aria-hidden', 'true')
      link.appendChild(badge)
      badges.set(link.dataset.route, badge)
    }
  }
  /* Guide, Quick settings, Back and Next carry the same icon box as the
     pages; their own drawings (if any) are left in place and hidden by the
     rail's stylesheet, so the strip layout still has them. */
  const decorate = (control, name) => {
    if (!control || control.querySelector(':scope > .app-nav-icon')) return
    control.prepend(iconSpan(name))
  }
  decorate(guide, 'guide')
  decorate(settings, 'quick')
  decorate(back, 'back')
  decorate(next, 'next')
  const paintCollapsed = () => {
    body.dataset.navigationCollapsed = String(collapsed)
    collapse?.setAttribute('aria-expanded', String(!collapsed))
    collapse?.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation')
    if (collapse) collapse.title = collapsed ? 'Expand navigation' : 'Collapse navigation'
  }
  const toggle = () => {
    collapsed = !collapsed
    try { globalThis.localStorage?.setItem(COLLAPSED_KEY, String(collapsed)) } catch {}
    paintCollapsed()
  }
  const setLayout = (value = requestedLayout) => {
    requestedLayout = value === 'top' ? 'top' : 'side'
    const effective = documentRef.documentElement.getAttribute('data-phone-canvas') === 'on' ? 'top' : requestedLayout
    body.dataset.navigation = effective
    if (activeLayout === effective) return
    activeLayout = effective
    if (effective === 'side') {
      if (guide) { decorate(guide, 'guide'); footer.appendChild(guide) }
      if (settings) footer.appendChild(settings)
      if (back) history.appendChild(back)
      if (next) history.appendChild(next)
      footer.appendChild(history)
      left?.remove()
      right?.remove()
      bar.appendChild(footer)
    } else {
      if (back && left) left.appendChild(back)
      if (guide && left) left.appendChild(guide)
      if (settings && right) right.appendChild(settings)
      if (next && right) right.appendChild(next)
      footer.remove()
      if (left) bar.insertBefore(left, bar.querySelector('.phone-home-link') || nav)
      if (right) bar.appendChild(right)
    }
  }
  const setBadge = (route, count) => {
    const badge = badges.get(route)
    if (!badge) return
    const n = Number(count) || 0
    badge.hidden = n <= 0
    badge.textContent = n > 99 ? '99+' : String(n)
  }
  const Observer = globalThis.MutationObserver
  const observer = Observer ? new Observer(() => setLayout()) : null
  observer?.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-phone-canvas'] })
  collapse?.addEventListener('click', toggle)
  paintCollapsed()
  setLayout(layout)
  const controller = { setLayout, setBadge, destroy() {
    observer?.disconnect()
    collapse?.removeEventListener('click', toggle)
    delete bar.appNavigation
  } }
  bar.appNavigation = controller
  return controller
}
