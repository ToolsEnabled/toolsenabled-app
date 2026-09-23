// Sandboxed preloads cannot import sibling modules. These names mirror the
// ordinary website's facade binding; main and the child independently validate
// every request. No local-owner bridge or authenticated session is exposed.
const { contextBridge, ipcRenderer } = require('electron')
let message = 'Connecting to your paired computer…'
let ended = false
let banner = null
function tell(text) { message = text; if (banner) banner.textContent = text }
function failure(code) { return Object.assign(new Error(code), { code }) }
async function call(operation, params = {}) {
  if (ended) throw failure('BRIDGE_UNREACHABLE')
  let answer
  try { answer = await ipcRenderer.invoke('mc-remote:request', { operation, params }) } catch {
    tell('The response was lost. Check the remote computer before repeating an action.')
    throw failure('BRIDGE_TIMEOUT')
  }
  if (answer?.ok !== true) {
    const unknown = answer?.outcome === 'unknown'
    tell(unknown ? 'The result is unknown. Check the remote computer before repeating this action.'
      : 'The paired computer is not available. Return to this computer’s Connection settings to open it again.')
    throw failure(unknown ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNREACHABLE')
  }
  if (answer.status < 200 || answer.status >= 300) {
    const code = answer.value?.error?.code
    throw failure(typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,99}$/.test(code) ? code : 'BRIDGE_REQUEST_REFUSED')
  }
  return answer.value
}
const agent = {}
const methods = {
  availability: 'availability', confinement: 'confinement', tools: 'tools',
  startableTiers: 'startable-tiers', sessionAccounts: 'session-accounts',
  localMessages: 'local-messages', history: 'history', usage: 'usage',
  start: 'start', updateTreeAddress: 'tree-address', adoptTreeAddress: 'tree-adopt', request: 'request',
  requestEdit: 'request-edit', requestRemove: 'request-remove', requestDecide: 'request-decide',
  requests: 'requests', ledger: 'ledger', profiles: 'profiles', profileRemove: 'profile-remove',
  interrupt: 'interrupt', reserveSendNow: 'reserve-send-now', releaseSendNow: 'release-send-now', rewind: 'rewind', setEffort: 'effort', models: 'models',
  modes: 'modes', setMode: 'mode', switchSession: 'switch',
  answerApproval: 'approval-answer', close: 'close',
}
const noArgs = new Set(['availability', 'confinement', 'tools', 'startableTiers', 'sessionAccounts', 'profiles'])
for (const [name, operation] of Object.entries(methods)) {
  agent[name] = params => call(`agent:${operation}`, noArgs.has(name) ? {} : params || {})
}
agent.send = request => {
  const { sessionId, text, model } = request || {}
  return call('agent:send', { sessionId, text, ...(model === undefined ? {} : { model }) })
}
agent.pasteAttachment = () => Promise.reject(failure('MC_AGENT_PASTE_REQUIRES_WINDOW'))
const listeners = new Set()
let pumping = false
let cursor = null
async function pump() {
  pumping = true
  try {
    while (!ended && listeners.size) {
      try {
        const reply = await call('agent:events', { after: cursor ?? 0, waitMs: cursor === null ? 0 : 20000 })
        if (ended || !listeners.size) break
        if (reply?.ok !== true || !Number.isSafeInteger(reply.seq)) throw failure('BRIDGE_REQUEST_REFUSED')
        if (cursor !== null) {
          for (const item of Array.isArray(reply.events) ? reply.events : []) {
            for (const entry of [...listeners]) { try { entry.listener(item.packet) } catch {} }
          }
          if (reply.dropped === true) tell('Some live updates were missed. Reopen this remote workspace to reload its records.')
        }
        cursor = reply.truncated === true && Number.isSafeInteger(reply.next) ? reply.next : reply.seq
      } catch {
        // Retry only this read on the same bound session. Writes are never retried.
        if (!ended && listeners.size) await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
  } finally { pumping = false }
}
agent.onEvent = listener => {
  if (typeof listener !== 'function') throw new TypeError('An event listener is required')
  const entry = { listener }
  listeners.add(entry)
  if (!pumping && !ended) void pump()
  return () => { listeners.delete(entry); if (!listeners.size) cursor = null }
}
contextBridge.exposeInMainWorld('mcAgent', Object.freeze(agent))
const org = {}
for (const [name, operation] of Object.entries({ read: 'read', reparent: 'reparent', assignRole: 'assign-role',
  ensureSeat: 'ensure-seat', releaseSeat: 'release-seat', createRole: 'create-role', editRole: 'edit-role',
  resetRole: 'reset-role', reset: 'reset', exportOrg: 'export' })) {
  org[name] = params => call(`org:${operation}`, ['read', 'reset', 'export'].includes(operation) ? {} : params || {})
}
contextBridge.exposeInMainWorld('mcOrg', Object.freeze(org))
const bridgeReads = new Set(['status', 'contract', 'runtime', 'settings', 'owner-prompts', 'research/local-tiers-status'])
contextBridge.exposeInMainWorld('mcShell', Object.freeze({
  getBridgeEndpoint: async () => ({ ok: true, source: 'supervised', baseUrl: 'about:blank' }),
  checkoutSurface: async () => ({ available: false }),
  // Always offer this fixed remote transport, including when unavailable. A
  // failed remote request must never cause the renderer to scan local ports.
  getBridgeTransport: () => async (pathname, options = {}) => {
    const name = typeof pathname === 'string' && pathname.startsWith('/v1/') ? pathname.slice(4) : ''
    if (!bridgeReads.has(name) || (options.method || 'GET') !== 'GET' || options.body != null) {
      return { ok: false, code: 'BRIDGE_REQUEST_REFUSED', reason: 'This remote workspace does not offer that action.' }
    }
    try { return await call(`bridge:${name.replace('/', '-')}`, {}) } catch (error) {
      return { ok: false, code: error.code, reason: 'The paired computer did not provide a usable answer.' }
    }
  },
}))
ipcRenderer.on('mc-remote:state', (_event, state) => {
  if (state?.state === 'unavailable') { ended = true; listeners.clear(); tell('This remote connection has ended.') }
})
window.addEventListener('pagehide', () => { ended = true; listeners.clear() })
window.addEventListener('DOMContentLoaded', async () => {
  document.documentElement.classList.add('remote-workspace')
  const style = document.createElement('style')
  style.textContent = `
    .remote-workspace-banner { position:fixed; inset:0 0 auto; z-index:210; min-height:34px;
      display:flex; align-items:center; justify-content:center; padding:5px 16px;
      box-sizing:border-box; background:var(--surface-2, #f3f4f6); color:var(--ink, #111827);
      border-bottom:1px solid var(--line, #ddd); font:500 12px var(--font-sans, sans-serif); }
    html.remote-workspace #stage { height:calc(100vh - 34px); margin-top:34px; }
    html.remote-workspace .topbar, html.remote-workspace .drawer { top:48px; }
    html.remote-workspace .home-takeover { top:34px; }
  `
  document.head.appendChild(style)
  banner = document.createElement('div')
  banner.className = 'remote-workspace-banner'
  banner.setAttribute('role', 'status')
  banner.textContent = message
  document.body.prepend(banner)
  try {
    const context = await ipcRenderer.invoke('mc-remote:context')
    if (context?.ok !== true) throw failure('BRIDGE_UNREACHABLE')
    const status = await call('agent:remote-status')
    tell(`Paired computer ${context.peerId.slice(0, 8)} · ${status.mayWrite === true ? 'Remote controls enabled' : 'View only — enable Drive on that computer to make changes'}`)
  } catch { tell('This remote connection is unavailable. Open it again from Connection settings.') }
})
