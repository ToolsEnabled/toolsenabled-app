import { setChatMessageBody, addChatMessageCopy } from './chat-message-body.js'
import { THINKING_UNAVAILABLE_NOTICE, THINKING_TRUNCATED_NOTICE } from '../shell/thinking-transcript.mjs'

const WHO_LABEL = Object.freeze({ you: 'You', owner: 'You', me: 'You', action: 'Activity', act: 'Activity', agent: 'Agent' })
const speakerLabel = who => WHO_LABEL[who] || who || 'Agent'

// The archive browser is paged independently of the live chat viewport.
//
// WHERE IT SITS. One control, in a header, never below the chat. Given the chat it
// belongs to (`chat`), the browser opens at the top of that chat, under its header,
// and never below the composer:
//   toggle: 'head'   one "Saved conversation" button in the chat's own header, beside Search;
//   toggle: 'none'   no button in the chat at all; the surface that owns several chats
//                    (Home's Full view) keeps ONE button in its own header and calls
//                    section.toggleSavedConversation() on the focused chat's browser.
// Without `chat` it is the old self-contained block, appended to `host`.
export function mountTranscriptHistory({ host, store, nodeId, document: doc = document, chat = null, toggle: toggleMode = 'head' }) {
  if (!store?.readPage) return
  const section = doc.createElement('section')
  section.className = 'node-transcript-history saved-conversation'
  const toggle = doc.createElement('button')
  toggle.type = 'button'
  toggle.textContent = chat ? 'Saved conversation' : 'Browse saved conversation'
  toggle.setAttribute('aria-expanded', 'false')
  const body = doc.createElement('div')
  body.className = 'node-transcript-history-body saved-conversation-body'
  body.setAttribute('role', 'region')
  body.setAttribute('aria-label', 'Saved conversation')
  body.hidden = true
  const entries = doc.createElement('div')
  entries.className = 'node-transcript-history-entries saved-messages'
  entries.setAttribute('tabindex', '0')
  entries.setAttribute('aria-label', 'Saved messages')
  const older = doc.createElement('button')
  older.type = 'button'
  older.textContent = 'Earlier messages'
  const newer = doc.createElement('button')
  newer.type = 'button'
  newer.textContent = 'Newer messages'
  const nav = doc.createElement('nav')
  nav.className = 'node-transcript-history-nav saved-conversation-nav'
  nav.setAttribute('aria-label', 'Saved conversation pages')
  const status = doc.createElement('p')
  status.setAttribute('role', 'status')
  let before = null
  let cursors = [null]
  let position = 0
  let loading = false
  async function load(cursor) {
    if (loading) return
    loading = true
    older.disabled = newer.disabled = true
    status.textContent = 'Loading saved conversation…'
    try {
      const page = await store.readPage(nodeId, cursor, 60)
      if (!section.isConnected) return
      entries.replaceChildren()
      for (const entry of page.entries) {
        const row = doc.createElement('div')
        const thinking = entry.kind === 'thinking' && entry.who === 'action'
        const plain = !thinking && ['you', 'owner', 'me', 'action', 'act'].includes(entry.who)
        row.className = `saved-message ${['you', 'owner', 'me'].includes(entry.who) ? 'is-owner' : (plain || thinking) ? 'is-act' : 'is-agent'}`
        const label = doc.createElement('div')
        label.className = 'saved-message-who'
        label.textContent = thinking ? 'Thinking' : speakerLabel(entry.who)
        const textBody = doc.createElement('div')
        textBody.className = 'chat-msg-text chat-message-body'
        const text = thinking ? (entry.body || THINKING_UNAVAILABLE_NOTICE) + (entry.truncated ? `\n\n${THINKING_TRUNCATED_NOTICE}` : '') : entry.text
        setChatMessageBody(textBody, text, { plain })
        row.append(label, textBody)
        const footer = doc.createElement('div')
        footer.className = 'chat-msg-footer'
        if (typeof entry.at === 'number' && Number.isFinite(entry.at)) {
          const date = new Date(entry.at), time = doc.createElement('time')
          time.className = 'chat-message-time'
          time.dateTime = date.toISOString()
          time.textContent = date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          footer.appendChild(time)
        }
        addChatMessageCopy(row, textBody, footer)
        row.appendChild(footer)
        entries.appendChild(row)
      }
      before = page.before
      status.textContent = page.entries.length ? 'Saved conversation' : 'No saved messages yet.'
    } catch (error) { status.textContent = `Saved conversation could not be read: ${error.message}` }
    finally { loading = false; older.disabled = !before; newer.disabled = position === 0 }
  }
  const setOpen = open => {
    body.hidden = !open
    if (chat) section.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    section.dataset.open = open ? 'yes' : 'no'
    if (open) void load(cursors[position])
    return open
  }
  toggle.addEventListener('click', () => { setOpen(body.hidden) })
  older.addEventListener('click', () => { if (before && !loading) { cursors = cursors.slice(0, position + 1); cursors.push(before); position += 1; void load(before) } })
  newer.addEventListener('click', () => { if (position > 0 && !loading) { position -= 1; void load(cursors[position]) } })
  nav.append(older, newer)
  body.append(status, entries, nav)
  if (!chat) {
    section.append(toggle, body)
    host.appendChild(section)
    return section
  }
  // Inside a chat: the panel goes under the header (after the search lens), the
  // button into the header beside Search -- or nowhere, when the surface that holds
  // several chats keeps the one button (toggle: 'none').
  section.hidden = true
  section.dataset.savedConversation = ''
  section.append(body)
  section.toggleSavedConversation = () => setOpen(body.hidden)
  section.isSavedConversationOpen = () => !body.hidden
  const anchor = chat.querySelector('.chat-search') || chat.querySelector('.chat-head')
  if (anchor?.after) anchor.after(section)
  else chat.insertBefore(section, chat.querySelector('.chat-log'))
  if (toggleMode !== 'none') {
    toggle.className = 'saved-conversation-toggle'
    toggle.setAttribute('aria-label', 'Browse saved conversation')
    const head = chat.querySelector('.chat-head')
    const search = head?.querySelector('.chat-search-toggle')
    if (search) head.insertBefore(toggle, search)
    else head?.appendChild(toggle)
  }
  return section
}
