import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import '../../src/styles.css'
import '../../src/theme-refinements.css'
import '../../src/chat-content.css'
import '../../src/chatbox-settings.css'
import '../../src/chat-session-changes.css'
import '../../src/diff-editor.css'
import './chat-changes-preview.css'
import { buildChat } from '../../src/components.js'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
import { setNavigationPreview } from '../../src/navigation-preview.js'
import { previewFiles } from './chat-changes-fixture.mjs'

const source = new DOMParser().parseFromString(await (await fetch('/')).text(), 'text/html')
document.querySelector('#preview-nav').replaceWith(source.querySelector('.topbar'))
for (const link of document.querySelectorAll('.tb-nav a')) link.href = `/?nav-preview=side${link.hash}`
document.querySelector('[data-route="home"]').classList.add('active')
setNavigationPreview('side')
for (const button of document.querySelectorAll('[data-layout]')) button.addEventListener('click', () => {
  setNavigationPreview(button.dataset.layout)
  for (const item of document.querySelectorAll('[data-layout]')) item.setAttribute('aria-pressed', String(item === button))
})
document.querySelector('.preview-theme').addEventListener('click', () => {
  document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'black' ? 'white' : 'black'
})
document.querySelector('#nav-back').addEventListener('click', () => document.querySelector('[data-layout="top"]').click())
document.querySelector('#nav-next').addEventListener('click', () => document.querySelector('[data-layout="side"]').click())
document.querySelector('#open-settings').addEventListener('click', () => document.querySelector('.preview-theme').click())
const request = async (method, payload) => (await fetch(`/__change-preview/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
})).json()
globalThis.mcDiff = {
  readChange: path => request('read', { path }),
  stamp: path => request('stamp', { path }),
  save: (path, text) => request('save', { path, text }),
  pick: async () => ({ ok: true, canceled: true }),
}
const now = Date.now()
const chat = buildChat({
  title: 'Workspace assistant', subtitle: 'Chat changes & navigation', roleKey: 'coordinator', seed: 0,
  onSend: async () => ({ ok: false, reason: 'This is a layout preview. Open your workspace to send a message.' }),
  history: [
    { who: 'you', at: now - 240000, text: 'Put session changes in a little pull-up tab at the bottom of the chat. I want to pick a file and edit its diff.' },
    { who: 'agent', at: now - 200000, text: 'I’ll keep the file list tucked below the conversation. The up arrow will open it, with added and removed line counts beside each file.' },
    { who: 'agent', at: now - 45000, text: '**The changes are ready to review.**\n\nOpen **Session changes** below, then select `src/chat-session-changes.js`. The compare window loads the original and current file, and lets you edit and save either version.\n\nYou can keep chatting with the file list folded away.' },
  ],
})
document.querySelector('#preview-chat').appendChild(chat)
const activity = sessionActivityEvent({ sessionId: 'preview', event: { type: 'tool_call', tool: 'fileChange', toolCallId: 'preview-edit', payload: { changes: previewFiles.map(({ path, kind, diff }) => ({ path, kind, diff })) } } }, 'preview')
chat.addDiff({ source: 'session-file-change', id: 'preview-edit', files: activity.fileChanges, patches: activity.filePatches })
document.querySelector('[data-preview-open]').addEventListener('click', () => {
  if (chat.querySelector('[data-changes-toggle]').getAttribute('aria-expanded') !== 'true') chat.querySelector('[data-changes-toggle]').click()
})
globalThis.previewChat = chat
