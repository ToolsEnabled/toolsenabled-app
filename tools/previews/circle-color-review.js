// DEV review helper only. Nothing in the product imports this module.
// The exported function is self-contained so a review driver can install it
// through page.evaluate() without changing the app's data or Home state.
export function installCircleColorReview({ intervalMs = 3600 } = {}) {
  window.__circleColorReview?.dispose?.()
  const finish = document.querySelector('.home .home-circle-finish')
  const ring = finish?.closest('.home-circle')
  if (!finish || !ring?.parentNode) return null

  const states = [
    ['idle', 'Normal'], ['busy', 'Needs attention'],
    ['peak', 'Service down'], ['unknown', 'No reading'],
  ]
  const labels = Object.fromEntries([...states, ['actual', 'Actual state']])
  const delay = Number.isFinite(intervalMs) ? Math.max(1200, Math.min(10000, intervalMs)) : 3600
  const element = (tag, className, text = '') => {
    const node = document.createElement(tag)
    node.className = className
    node.textContent = text
    return node
  }
  const panel = element('section', 'circle-color-review')
  panel.dataset.circleColorReview = ''
  panel.setAttribute('aria-labelledby', 'circle-color-review-title')
  const style = element('style', '')
  style.textContent = `
    .circle-color-review { box-sizing: border-box; width: min(100%, 440px); margin: 12px 0 4px; padding: 12px; display: grid; gap: 10px; background: var(--sheet); color: var(--ink-2); border: 1px solid var(--line-2); border-radius: var(--r-md); font: 12px/1.4 var(--font-ui); }
    .circle-color-review-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; }
    .circle-color-review-title { margin: 0; font: 550 12px/1.4 var(--font-ui); color: var(--ink-2); }
    .circle-color-review-current { color: var(--ink-3); font: 11.5px/1.4 var(--font-ui); }
    .circle-color-review-states, .circle-color-review-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .circle-color-review .circle-color-review-button { min-height: 34px; padding: 5px 9px; font: 500 12px/1.4 var(--font-ui); border-radius: var(--r-sm); color: var(--ink-2); border: 1px solid var(--control-border, var(--line-2)); background: var(--control-bg, var(--sheet)); }
    .circle-color-review .circle-color-review-button:hover { background: var(--control-hover, var(--bg)); color: var(--ink); }
    .circle-color-review .circle-color-review-button[aria-pressed="true"] { border-color: var(--ui-accent, var(--c-coordinator)); color: var(--ink); background: color-mix(in srgb, var(--ui-accent, var(--c-coordinator)) 9%, var(--sheet)); }
    .circle-color-review .circle-color-review-button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    @media (max-width: 500px) { .circle-color-review .circle-color-review-button { min-height: 44px; } }
  `
  const head = element('div', 'circle-color-review-head')
  const title = element('h3', 'circle-color-review-title', 'Color preview — not live status')
  title.id = 'circle-color-review-title'
  const current = element('span', 'circle-color-review-current', 'Actual state')
  current.dataset.reviewSelection = ''
  current.setAttribute('role', 'status')
  current.setAttribute('aria-live', 'polite')
  head.append(title, current)
  const group = element('div', 'circle-color-review-states')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Preview a state color')
  const buttons = new Map()
  const button = (state, label) => {
    const node = element('button', 'ctl-btn circle-color-review-button', label)
    node.type = 'button'
    node.dataset.reviewState = state
    node.setAttribute('aria-pressed', String(state === 'actual'))
    buttons.set(state, node)
    return node
  }
  for (const [state, label] of states) group.append(button(state, label))
  const actions = element('div', 'circle-color-review-actions')
  const actualButton = button('actual', 'Actual state')
  const playButton = element('button', 'ctl-btn circle-color-review-button', 'Play colors')
  playButton.type = 'button'
  playButton.dataset.reviewPlay = ''
  playButton.setAttribute('aria-pressed', 'false')
  actions.append(actualButton, playButton)
  panel.append(style, head, group, actions)
  ring.parentNode.insertBefore(panel, ring.nextSibling)

  let selected = 'actual'
  let timer = null
  let disposed = false
  let controller
  const observer = new MutationObserver(records => {
    if (!ring.isConnected || !finish.isConnected || !panel.isConnected) { dispose(); return }
    if (records.some(record => record.type === 'attributes' && record.attributeName === 'data-theme')) refreshColor()
  })

  function stateColor(state) {
    // Read the circle's shared semantic state colors, including the neutral
    // token for unknown. A zero-sized hidden probe never acquires app behavior.
    const probe = document.createElement('div')
    probe.className = 'uring crescent home-circle'
    probe.dataset.load = state
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:fixed;inset:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;color:var(--core-status-color,var(--ink-3));'
    ring.parentNode.append(probe)
    try { return getComputedStyle(probe).color } finally { probe.remove() }
  }

  function refreshColor() {
    if (disposed) return
    if (selected === 'actual') finish.style.removeProperty('--core-status-color')
    else finish.style.setProperty('--core-status-color', stateColor(selected))
  }

  function paint() {
    panel.dataset.previewState = selected
    current.textContent = selected === 'actual' ? 'Actual state' : `${labels[selected]} · preview`
    for (const [state, node] of buttons) node.setAttribute('aria-pressed', String(state === selected))
    playButton.textContent = timer === null ? 'Play colors' : 'Pause colors'
    playButton.setAttribute('aria-pressed', String(timer !== null))
  }

  function pause() {
    if (timer !== null) clearInterval(timer)
    timer = null
    if (!disposed) paint()
  }

  function select(state) {
    if (disposed || !Object.hasOwn(labels, state)) return
    pause()
    selected = state
    refreshColor()
    paint()
  }

  function play() {
    if (disposed || timer !== null) return
    if (selected === 'actual') selected = states[0][0]
    refreshColor()
    timer = setInterval(() => {
      if (!ring.isConnected || !finish.isConnected || !panel.isConnected) { dispose(); return }
      selected = states[(states.findIndex(([state]) => state === selected) + 1) % states.length][0]
      refreshColor()
      paint()
    }, delay)
    paint()
  }

  function onClick(event) {
    const target = event.target.closest?.('button')
    if (!target || !panel.contains(target)) return
    if (target.hasAttribute('data-review-play')) {
      if (timer === null) play()
      else pause()
    } else if (target.hasAttribute('data-review-state')) select(target.dataset.reviewState)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    pause()
    observer.disconnect()
    panel.removeEventListener('click', onClick)
    finish.style.removeProperty('--core-status-color')
    panel.remove()
    if (window.__circleColorReview === controller) delete window.__circleColorReview
  }

  panel.addEventListener('click', onClick)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  observer.observe(document.body, { childList: true, subtree: true })
  controller = { el: panel, select, actual: () => select('actual'), play, pause, dispose,
    getState: () => ({ selected, playing: timer !== null, disposed }) }
  window.__circleColorReview = controller
  paint()
  return controller
}
