import { CHAT_FOLD_COPY, renderChatMarkdown, renderChatPlain } from './chat-markdown.js'
import { createReadableTextBuffer } from './chat-readable-stream.js'

const bodies = new WeakMap()
const documents = new WeakSet()
const feedback = new WeakMap()

export const chatMessageSource = host => bodies.get(host)?.source || ''

/* A caller that painted the host by other means (a live thinking window,
   src/chat-live-work.js) says so, so the next setChatMessageBody renders
   whole instead of patching against, or skipping for, a stale source. */
export const forgetChatMessageBody = host => { if (host) bodies.delete(host) }

// Keep settled paragraphs, selection, focused controls, and code scrollports
// in place while the last part of an answer grows. Only changed nodes update.
function patchChildren(host, incoming) {
  const next = [...incoming.childNodes]
  for (let index = 0; index < next.length; index++) {
    const fresh = next[index], current = host.childNodes[index]
    if (!current) { host.appendChild(fresh); continue }
    if (current.nodeType !== fresh.nodeType || current.nodeName !== fresh.nodeName) {
      current.replaceWith(fresh)
      continue
    }
    // Preserve local wrap and expand state on the detached comparison node.
    // Resetting and restoring the live class emits mutations even for settled
    // code, and a streaming reply must never fold a block a person opened.
    if (current.nodeType === 1 && current.classList.contains('md-code-block')) {
      for (const state of ['is-wrapped', 'is-expanded']) if (current.classList.contains(state)) fresh.classList.add(state)
    }
    if (current.isEqualNode(fresh)) continue
    if (current.nodeType === 3) {
      if (fresh.data.startsWith(current.data)) current.appendData(fresh.data.slice(current.data.length))
      else current.data = fresh.data
      continue
    }
    if (current.nodeType !== 1) continue
    // These controls contain local UI state; streaming never resets a user's
    // wrap preference, copy feedback, or keyboard focus.
    // One simple selector per test: the renderer's DOM stand-ins match no selector lists.
    if (current.matches('.md-code-tools') || current.matches('.md-code-foot')) continue
    for (const name of current.getAttributeNames()) if (!fresh.hasAttribute(name)) current.removeAttribute(name)
    for (const name of fresh.getAttributeNames()) if (current.getAttribute(name) !== fresh.getAttribute(name)) current.setAttribute(name, fresh.getAttribute(name))
    patchChildren(current, fresh)
  }
  while (host.childNodes.length > next.length) host.lastChild.remove()
}

export function setChatMessageBody(host, text, { plain = false } = {}) {
  if (!host) return
  const source = String(text ?? ''), previous = bodies.get(host)
  // Same-value attribute writes still notify MutationObservers in Chromium.
  // Formatting is stable across deltas; only the message content needs work.
  if (!host.classList.contains('chat-message-body')) host.classList.add('chat-message-body')
  const format = plain ? 'plain' : 'markdown'
  if (host.dataset.chatFormat !== format) host.dataset.chatFormat = format
  const doc = host.ownerDocument || document
  installChatTextActions(doc)
  if (previous?.source === source && previous.plain === plain) return
  const html = plain ? renderChatPlain(source) : renderChatMarkdown(source)
  if (plain && !html.includes('<a ')) host.textContent = source.replace(/\u0000/g, '')
  else if (!previous || !host.childNodes) host.innerHTML = html
  else {
    const template = doc.createElement('template')
    template.innerHTML = html
    patchChildren(host, template.content)
  }
  bodies.set(host, { source, plain })
}

// The Controls rail receives deltas too. Batch them to one render per frame
// and use the same patching path as a live chat bubble.
export function createChatMarkdownStream({ node, scheduleFrame, cancelFrame }) {
  let source = '', pending = [], frame = 0, disposed = false
  const readable = createReadableTextBuffer()
  const flush = (complete = false) => {
    frame = 0
    if (disposed) return
    source += pending.join('')
    pending = []
    const visible = complete ? readable.finish(source) : readable.push(source)
    setChatMessageBody(node, visible)
    node.hidden = !visible
  }
  return {
    push(text) {
      if (disposed || typeof text !== 'string' || !text) return
      pending.push(text)
      if (!frame) frame = scheduleFrame(() => flush())
    },
    flushNow() { if (frame) cancelFrame(frame); frame = 0; flush(true) },
    reset() {
      if (frame) cancelFrame(frame)
      frame = 0; source = ''; pending = []
      readable.reset()
      setChatMessageBody(node, '')
      node.hidden = true
    },
    dispose() { disposed = true; if (frame) cancelFrame(frame); frame = 0; source = ''; pending = []; readable.reset() },
    get pendingCount() { return pending.length },
    get frameScheduled() { return frame !== 0 },
  }
}

export function addChatMessageCopy(row, body, footer = null) {
  const doc = body.ownerDocument || document
  row.setAttribute('data-chat-message', '')
  const actions = footer || doc.createElement('div')
  if (!footer) actions.className = 'chat-msg-footer'
  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'chat-message-copy'
  button.setAttribute('data-chat-message-copy', '')
  button.setAttribute('aria-label', 'Copy message')
  button.title = 'Copy the original message text'
  button.textContent = 'Copy'
  actions.appendChild(button)
  if (!footer) row.appendChild(actions)
  return actions
}

export function installChatTextActions(doc = document) {
  // Elements created in a template belong to an inert document until adopted.
  // Their controls must listen on the browsing document they will live in.
  if (!doc.defaultView && globalThis.document) doc = globalThis.document
  if (documents.has(doc)) return
  documents.add(doc)
  doc.addEventListener('click', async event => {
    const button = event.target?.closest?.('[data-chat-code-copy], [data-chat-code-wrap], [data-chat-code-expand], [data-chat-message-copy]')
    if (!button) return
    const block = button.closest('.md-code-block')
    const body = block?.closest('.chat-message-body') || button.closest('[data-chat-message]')?.querySelector('.chat-message-body')
    if (!body || !bodies.has(body)) return
    event.preventDefault()
    event.stopPropagation()
    if (button.hasAttribute('data-chat-code-expand')) {
      const expanded = block.classList.toggle('is-expanded')
      button.setAttribute('aria-expanded', String(expanded))
      const lines = Number(button.dataset.lines)
      button.textContent = expanded ? CHAT_FOLD_COPY.showFewer
        : (Number.isFinite(lines) && lines > 0 ? CHAT_FOLD_COPY.showAllLines(lines) : CHAT_FOLD_COPY.showAllOutput)
      // Folding a block the reader has scrolled through brings its head back
      // into view instead of leaving them below a block that just shrank.
      const scroller = block.closest('.chat-log, .session-log, .saved-messages')
      if (!expanded && scroller && block.getBoundingClientRect().top < scroller.getBoundingClientRect().top) block.scrollIntoView?.({ block: 'nearest' })
      return
    }
    if (button.hasAttribute('data-chat-code-wrap')) {
      const wrapped = block.classList.toggle('is-wrapped')
      button.setAttribute('aria-pressed', String(wrapped))
      button.setAttribute('aria-label', wrapped ? 'Stop wrapping code lines' : 'Wrap code lines')
      return
    }
    const text = block ? block.querySelector('code')?.textContent : bodies.get(body).source
    if (typeof text !== 'string') return
    clearTimeout(feedback.get(button))
    button.disabled = true
    try {
      await (doc.defaultView?.navigator || globalThis.navigator).clipboard.writeText(text)
      button.textContent = 'Copied'
      button.title = 'Copied to clipboard'
    } catch {
      button.textContent = 'Copy manually'
      button.title = 'Select the text and copy it manually.'
    } finally {
      button.disabled = false
      let status = button.parentElement.querySelector('.chat-copy-status')
      if (!status) {
        status = doc.createElement('span')
        status.className = 'chat-copy-status'
        status.setAttribute('role', 'status')
        button.parentElement.appendChild(status)
      }
      status.textContent = button.title
      feedback.set(button, setTimeout(() => {
        button.textContent = 'Copy'
        status.textContent = ''
        button.title = block ? 'Copy code' : 'Copy the original message text'
        feedback.delete(button)
      }, 1800))
    }
  }, true)
}
