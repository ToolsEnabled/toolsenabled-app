import { FEATURE_GUIDES, createGuidePreferences } from './feature-guides.js'

const MODALS = 'dialog[open], [aria-modal="true"], [role="alertdialog"], [data-accessibility-pending]'
const visible = element => Boolean(element?.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none')

/* WHERE THE INTRO CARD GOES WHEN IT HAS NO CONTROL TO SIT BESIDE (ledger T143).
   Its home is the top-left corner, a little below the top; when a control the
   guide must leave reachable lies under it, the card moves through the other
   corners in this order and takes the first one clear of every such control,
   with a gap so a finger has room. All corners covered means the page is
   smaller than the card and its controls; the bottom-right is then the least
   harmful place. Pure, so the choice is tested without a browser; the caller
   measures the rectangles. */
export function introCardSpot({ minX, maxX, minY, maxY, homeY, w, h, gap = 12 }, avoid = []) {
  const homeTop = Math.max(minY, Math.min(maxY, homeY))
  const corners = [{ x: minX, y: homeTop }, { x: maxX, y: homeTop }, { x: minX, y: maxY }, { x: maxX, y: maxY }]
  const covers = (corner, box) => corner.x < box.right + gap && corner.x + w > box.left - gap && corner.y < box.bottom + gap && corner.y + h > box.top - gap
  return corners.find(corner => !avoid.some(box => covers(corner, box))) || corners[corners.length - 1]
}

export function mountFirstUseGuidance({ entryHost = document.querySelector('.tb-left'), storage } = {}) {
  if (!entryHost) return { visit() {}, destroy() {} }
  if (storage === undefined) { try { storage = window.localStorage } catch { storage = null } }
  const preferences = createGuidePreferences(storage)
  const launch = document.createElement('button')
  launch.type = 'button'
  launch.className = 'first-use-launch'
  launch.textContent = 'Guide'
  launch.id = 'page-guide'
  launch.hidden = true
  launch.setAttribute('aria-controls', 'first-use-card')
  launch.setAttribute('aria-expanded', 'false')
  entryHost.append(launch)
  const host = document.createElement('div')
  host.className = 'first-use-layer'
  host.hidden = true
  host.innerHTML = `<div class="first-use-highlight" aria-hidden="true" hidden></div>
    <section class="first-use-card" id="first-use-card" role="region" aria-labelledby="first-use-title">
      <div class="first-use-top"><span class="first-use-eyebrow"></span><button type="button" class="first-use-close" aria-label="Close guide">×</button></div>
      <h2 id="first-use-title" tabindex="-1"></h2>
      <p class="first-use-copy"></p>
      <p class="first-use-availability" role="status" hidden></p>
      <div class="first-use-progress" aria-hidden="true"></div>
      <div class="first-use-actions"><button type="button" class="first-use-back">Not now</button><button type="button" class="first-use-next">Show me</button></div>
      <div class="first-use-footer"><span id="first-use-preference-feedback" role="status" aria-live="polite" aria-atomic="true">Go at your own pace.</span><button type="button" class="first-use-quiet" aria-describedby="first-use-preference-feedback">Turn off new-page tips</button></div>
    </section>`
  document.body.append(host)
  const find = className => host.querySelector('.first-use-' + className)
  const card = find('card'), highlight = find('highlight'), heading = host.querySelector('h2')
  let route = null, root = null, guide = null, step = -1, opened = false, blocked = false, destroyed = false
  let returnFocus = null, observer = null, navigationObserver = null, frame = null, pendingFocus = false, pendingScroll = false
  const listeners = new AbortController()
  const on = (target, event, fn, options = {}) => target?.addEventListener(event, fn, { ...options, signal: listeners.signal })

  function isBlocked() {
    return document.body.classList.contains('first-run') || root?.closest('[inert]') != null || [...document.querySelectorAll(MODALS)].some(visible)
  }
  function stopObserving() {
    observer?.disconnect(); observer = null
    navigationObserver?.disconnect(); navigationObserver = null
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }
  function close({ restore = true } = {}) {
    const ownedFocus = host.contains(document.activeElement)
    opened = false; pendingFocus = false; pendingScroll = false
    host.hidden = true; highlight.hidden = true; launch.setAttribute('aria-expanded', 'false')
    stopObserving()
    if (restore && ownedFocus && !isBlocked()) (visible(returnFocus) ? returnFocus : launch).focus({ preventScroll: true })
    returnFocus = null
  }
  function targetForStep() {
    if (step < 0) return null
    for (const selector of guide.steps[step].selectors) {
      const target = [...(root?.querySelectorAll(selector) || [])].find(visible)
      if (target) return target
    }
    return null
  }
  function layout() {
    frame = null
    if (!opened || destroyed) return
    blocked = isBlocked()
    host.hidden = blocked
    launch.setAttribute('aria-expanded', String(!blocked))
    if (blocked) return
    const target = targetForStep()
    if (pendingScroll && target) target.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' })
    pendingScroll = false
    const layer = host.getBoundingClientRect(), scale = layer.width / (host.clientWidth || layer.width) || 1
    const viewport = window.visualViewport
    const left = Math.max(0, ((viewport?.offsetLeft || 0) - layer.left) / scale)
    const top = Math.max(0, ((viewport?.offsetTop || 0) - layer.top) / scale)
    const width = Math.min(host.clientWidth, (viewport?.width || window.innerWidth) / scale)
    const height = Math.min(host.clientHeight, (viewport?.height || window.innerHeight) / scale)
    const gap = 12, margin = 12
    const navigation = document.querySelector('header.topbar')
    const navigationBox = visible(navigation) ? navigation.getBoundingClientRect() : null
    // The rail owns the full left edge, including Guide and the history
    // controls. Measure its actual width (collapsed, resized or zoomed), or
    // the top bar's bottom edge, in the same coordinates as the guide layer.
    const contentLeft = navigationBox && document.body.dataset.navigation === 'side'
      ? Math.max(left, (navigationBox.right - layer.left) / scale) : left
    const contentTop = navigationBox && document.body.dataset.navigation !== 'side'
      ? Math.max(top, (navigationBox.bottom - layer.top) / scale) : top
    card.style.maxWidth = `${Math.max(0, left + width - contentLeft - margin * 2)}px`
    card.style.maxHeight = `${Math.max(0, top + height - contentTop - margin * 2)}px`
    const r = target?.getBoundingClientRect()
    const box = r ? { left: (r.left - layer.left) / scale, top: (r.top - layer.top) / scale, right: (r.right - layer.left) / scale, bottom: (r.bottom - layer.top) / scale } : null
    const note = step >= 0 && !target ? (guide.steps[step].unavailable || 'This part of the page is not visible right now. You can continue the guide and return to it later.') : ''
    const availability = find('availability')
    if (availability.textContent !== note) availability.textContent = note
    availability.hidden = !note
    const w = card.offsetWidth, h = card.offsetHeight
    const minX = contentLeft + margin, maxX = Math.max(minX, left + width - w - margin)
    const minY = contentTop + margin, maxY = Math.max(minY, top + height - h - margin)
    let x = minX, y = Math.min(maxY, top + 76)
    if (!box) {
      /* THE INTRO CARD MUST NOT SIT ON THE PAGE'S OWN CONTROLS (ledger T143).
         Its home is the top-left, which is exactly where owner request T62 put
         the only way to create a tree; a fresh profile's first click landed on
         the card (judge run #310, 2026-09-16: .tree-chat-add at 325,174 inside
         the card at 12,76 352x326). The guide names what must stay reachable,
         and the card takes the first corner clear of all of it. */
      const avoid = (guide.keepClear || [])
        .flatMap(selector => [...(root?.querySelectorAll(selector) || [])].filter(visible))
        .map(el => { const q = el.getBoundingClientRect(); return { left: (q.left - layer.left) / scale, top: (q.top - layer.top) / scale, right: (q.right - layer.left) / scale, bottom: (q.bottom - layer.top) / scale } })
      const spot = introCardSpot({ minX, maxX, minY, maxY, homeY: y, w, h, gap }, avoid)
      x = spot.x; y = spot.y
    }
    if (box) {
      // Prefer a neighbouring space that keeps the highlighted control visible.
      if (box.right + gap + w <= left + width - margin) { x = box.right + gap; y = box.top }
      else if (box.left - gap - w >= minX) { x = box.left - gap - w; y = box.top }
      else if (box.bottom + gap + h <= top + height - margin) { x = box.left; y = box.bottom + gap }
      else if (box.top - gap - h >= minY) { x = box.left; y = box.top - gap - h }
      else { x = maxX; y = box.top < top + height / 2 ? maxY : minY }
    }
    card.style.left = `${Math.max(minX, Math.min(maxX, x))}px`
    card.style.top = `${Math.max(minY, Math.min(maxY, y))}px`
    const clipped = box && { left: Math.max(left + 3, box.left - 4), top: Math.max(top + 3, box.top - 4), right: Math.min(left + width - 3, box.right + 4), bottom: Math.min(top + height - 3, box.bottom + 4) }
    highlight.hidden = !clipped || clipped.right <= clipped.left || clipped.bottom <= clipped.top
    if (!highlight.hidden) {
      highlight.style.left = `${clipped.left}px`; highlight.style.top = `${clipped.top}px`
      highlight.style.width = `${clipped.right - clipped.left}px`; highlight.style.height = `${clipped.bottom - clipped.top}px`
    }
    if (pendingFocus) { pendingFocus = false; card.scrollTop = 0; heading.focus({ preventScroll: true }) }
  }
  function schedule() { if (opened && frame === null) frame = requestAnimationFrame(layout) }
  function paint({ focus = false, scroll = false } = {}) {
    const intro = step < 0, last = step === guide.steps.length - 1
    find('eyebrow').textContent = intro ? `A little help with ${guide.name}` : `${guide.name} · ${step + 1} of ${guide.steps.length}`
    heading.textContent = intro ? guide.title : guide.steps[step].title
    find('copy').textContent = intro ? guide.intro : guide.steps[step].text
    find('back').textContent = intro ? 'Not now' : 'Back'
    find('next').textContent = intro ? 'Show me' : last ? 'Done' : 'Next'
    find('quiet').hidden = !intro
    find('quiet').textContent = preferences.isQuiet() ? 'Turn on new-page tips' : 'Turn off new-page tips'
    find('footer').firstElementChild.textContent = intro ? 'Go at your own pace.' : 'You choose when to act.'
    find('progress').replaceChildren(...guide.steps.map((_, index) => {
      const dot = document.createElement('span'); dot.className = index === step ? 'is-current' : index < step ? 'is-read' : ''; return dot
    }))
    pendingFocus = focus; pendingScroll = scroll
    layout()
  }
  function open({ automatic = false } = {}) {
    if (!guide || destroyed || isBlocked()) return
    if (opened) { close(); return }
    /* An automatic open happens with focus on the page body, and the body is
       'visible', so closing the tip handed focus back to the body: the next
       Tab began again at Skip to main content (T1479). Only a real control is
       a place to return to; otherwise close() falls back to the Guide control,
       where the tip can be opened again. */
    const opener = document.activeElement
    returnFocus = opener && opener !== document.body && opener !== document.documentElement ? opener : null
    step = -1; opened = true
    preferences.seen(route)
    observer = new MutationObserver(records => {
      if (records.some(record => !host.contains(record.target))) schedule()
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-modal', 'open', 'class', 'style', 'data-navigation', 'data-navigation-collapsed'] })
    const navigation = document.querySelector('header.topbar')
    if (navigation && typeof ResizeObserver !== 'undefined') {
      navigationObserver = new ResizeObserver(schedule)
      navigationObserver.observe(navigation)
    }
    paint({ focus: !automatic })
    card.scrollTop = 0
  }
  on(launch, 'click', () => open())
  on(find('close'), 'click', () => close())
  on(find('back'), 'click', () => { if (step < 0) close(); else { step--; paint({ focus: true, scroll: true }) } })
  on(find('next'), 'click', () => {
    if (step === guide.steps.length - 1) close()
    else { step++; paint({ focus: true, scroll: true }) }
  })
  on(find('quiet'), 'click', () => {
    const quiet = !preferences.isQuiet(), saved = preferences.quiet(quiet)
    // Keep the focused control in place, and make the preference reversible.
    find('quiet').textContent = quiet ? 'Turn on new-page tips' : 'Turn off new-page tips'
    find('footer').firstElementChild.textContent = saved
      ? quiet ? 'Tips are off. Use Guide to revisit any page.' : 'New-page tips are on.'
      : `Tips are ${quiet ? 'off' : 'on'} for this visit. This choice could not be saved.`
  })
  on(host, 'keydown', event => { if (event.key === 'Escape' && !isBlocked()) { event.preventDefault(); event.stopPropagation(); close() } })
  on(window, 'resize', schedule)
  on(document, 'scroll', schedule, { capture: true, passive: true })
  on(window.visualViewport, 'resize', schedule)
  on(window.visualViewport, 'scroll', schedule)
  on(window, 'mc:account-storage-changing', () => { close({ restore: false }); preferences.resetSession() })
  return {
    visit(name, element) {
      if (destroyed) return
      if (route === name && root === element) return
      const samePage = route === name, wasOpen = opened, previousStep = step, previousScroll = card.scrollTop
      close({ restore: false }); route = name; root = element; guide = Object.hasOwn(FEATURE_GUIDES, name) ? FEATURE_GUIDES[name] : null
      launch.hidden = !guide
      launch.setAttribute('aria-label', guide ? `Guide to ${guide.name}` : 'Guide')
      launch.title = guide ? `Guide to ${guide.name}` : ''
      if (!guide) return
      // A live-data refresh is not a new visit. Keep the guide's place without
      // moving focus or scrolling when the page replaces its DOM underneath it.
      if (samePage && wasOpen) { open({ automatic: true }); if (opened) { step = previousStep; paint(); card.scrollTop = previousScroll } }
      else if (preferences.shouldOffer(name)) open({ automatic: true })
    },
    destroy() { destroyed = true; close({ restore: false }); listeners.abort(); host.remove(); launch.remove(); root = null; guide = null },
  }
}
