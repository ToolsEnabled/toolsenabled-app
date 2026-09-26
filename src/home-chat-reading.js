// Reading controls operate on the mounted surface. They never rebuild a
// message, replace a composer, or change which messages the source provides.
const CONTENT = '.chat-msg-text, .turn-text, .run-agent, .run-brief, .run-asked, .run-said, .run-why, .run-gap, .home-roster-name, .home-roster-doing-text, .home-roster-facts'
const LIMIT = 500

export function findTextMatches(text, query, limit = LIMIT) {
  const needle = query.trim()
  if (!needle) return []
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const found = []
  for (const match of text.matchAll(expression)) {
    found.push({ offset: match.index, length: match[0].length })
    if (found.length >= limit) break
  }
  return found
}

export function mountChatReading(surface, container, { getStage = () => container } = {}) {
  const find = surface.querySelector('[data-chat-find]')
  const search = surface.querySelector('[data-chat-search]')
  const input = surface.querySelector('[data-chat-query]')
  const count = surface.querySelector('[data-chat-matches]')
  const previous = surface.querySelector('[data-chat-previous]')
  const next = surface.querySelector('[data-chat-next]')
  const clear = surface.querySelector('[data-chat-search-close]')
  const latest = surface.querySelector('[data-chat-latest]')
  input.value = ''
  search.hidden = true
  find.setAttribute('aria-expanded', 'false')
  let matches = [], selected = -1, timer = 0, destroyed = false
  const handlers = []
  const on = (node, type, listener) => {
    node.addEventListener(type, listener)
    handlers.push(() => node.removeEventListener(type, listener))
  }
  const highlights = globalThis.CSS?.highlights

  function paintMatches() {
    highlights?.delete('home-chat-matches')
    highlights?.delete('home-chat-current')
    if (highlights && globalThis.Highlight && matches.length) {
      highlights.set('home-chat-matches', new globalThis.Highlight(...matches.map(match => match.range)))
      if (matches[selected]) highlights.set('home-chat-current', new globalThis.Highlight(matches[selected].range))
    }
    const status = !input.value.trim() ? '' : matches.length
      ? `${selected + 1} of ${matches.length}${matches.length === LIMIT ? '+' : ''}` : 'No matches'
    if (count.textContent !== status) count.textContent = status
    previous.disabled = next.disabled = matches.length === 0
  }

  function reveal() {
    const stage = getStage()
    const match = matches[selected]
    if (!match) return
    for (let node = match.block.parentElement; node && node !== stage; node = node.parentElement) {
      if (node.tagName === 'DETAILS') node.open = true
    }
    // Long activity replies have their own reading area. Reveal the match
    // there first, then in the main transcript, keeping the toolbar fixed.
    for (const selector of ['.run-said', '.log-turns', '.chat-log, .session-log']) {
      const scroller = match.block.closest(selector)
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) continue
      const box = match.range.getBoundingClientRect()
      const port = scroller.getBoundingClientRect()
      scroller.scrollTop += box.top - port.top - scroller.clientHeight / 3
    }
  }

  function collect({ move = false } = {}) {
    const stage = getStage()
    if (destroyed) return
    const held = matches[selected]
    matches = []
    const query = input.value.trim()
    if (query) {
      for (const block of stage.querySelectorAll(CONTENT)) {
        if (block.closest('[hidden]') || block.parentElement?.closest(CONTENT)) continue
        const walker = document.createTreeWalker(block, 4)
        const nodes = []
        let node, all = ''
        while ((node = walker.nextNode())) {
          if (node.parentElement?.closest('.md-code-head, .md-task-status, .chat-copy-status')) continue
          nodes.push({ node, start: all.length })
          all += node.textContent
        }
        for (const { offset, length } of findTextMatches(all, query, LIMIT - matches.length)) {
          const start = nodes.findLast(part => part.start <= offset)
          const end = nodes.findLast(part => part.start < offset + length)
          if (!start || !end) continue
          const range = document.createRange()
          range.setStart(start.node, offset - start.start)
          range.setEnd(end.node, offset + length - end.start)
          matches.push({ block, range, offset })
        }
        if (matches.length === LIMIT) break
      }
    }
    const same = held && matches.findIndex(match => match.block === held.block && match.offset === held.offset)
    selected = matches.length ? (same >= 0 ? same : 0) : -1
    paintMatches()
    if (move) reveal()
  }

  function step(direction) {
    collect()
    if (!matches.length) return
    selected = (selected + direction + matches.length) % matches.length
    paintMatches()
    reveal()
  }
  function closeSearch({ focus = true } = {}) {
    search.hidden = true
    find.setAttribute('aria-expanded', 'false')
    input.value = ''
    collect()
    if (focus) find.focus()
  }
  function openSearch() {
    if (find.disabled) return
    const stage = getStage()
    stage.querySelector('[data-rail-tab="chat"]')?.click()
    search.hidden = false
    find.setAttribute('aria-expanded', 'true')
    input.focus()
    input.select?.()
  }
  on(find, 'click', () => search.hidden ? openSearch() : closeSearch())
  on(clear, 'click', () => closeSearch())
  on(input, 'input', () => collect({ move: true }))
  on(previous, 'click', () => step(-1))
  on(next, 'click', () => step(1))
  on(latest, 'click', () => {
    const stage = getStage()
    stage.querySelector('[data-rail-tab="chat"]')?.click()
    closeSearch({ focus: false })
    const chat = stage.querySelector('.chat-log')
    const log = chat || stage.querySelector('.session-log')
    if (!log) return
    // Run history is newest first; conversations are newest last.
    const hasConversation = chat || (surface.dataset.subjectKind === 'coordinator' && stage.querySelector('.log-turns')?.textContent?.trim())
    log.scrollTop = hasConversation ? log.scrollHeight : 0
    log.dispatchEvent(new Event('scroll'))
  })
  const keydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); openSearch(); return true
    }
    if (!search.hidden && event.key === 'Escape') {
      event.preventDefault(); closeSearch(); return true
    }
    if (!search.hidden && event.target === input && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); step(event.shiftKey ? -1 : 1); return true
    }
    return false
  }
  const observer = new MutationObserver(() => {
    paintDirection()
    if (!input.value.trim() || timer) return
    timer = setTimeout(() => { timer = 0; collect() }, 120)
  })
  observer.observe(container, { childList: true, subtree: true, characterData: true })
  function paintDirection() {
    const stage = getStage()
    const activity = surface.dataset.subjectKind && surface.dataset.subjectKind !== 'coordinator' && !stage.querySelector('.chat-log')
    const label = activity ? 'Newest ↑' : 'Latest ↓'
    if (latest.textContent !== label) latest.textContent = label
  }
  paintDirection()
  paintMatches()
  return {
    keydown,
    changed() { paintDirection(); collect() },
    destroy() {
      destroyed = true
      clearTimeout(timer)
      observer.disconnect()
      for (const remove of handlers) remove()
      highlights?.delete('home-chat-matches')
      highlights?.delete('home-chat-current')
    },
  }
}
