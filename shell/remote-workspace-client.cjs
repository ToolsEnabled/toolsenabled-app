'use strict'

const crypto = require('node:crypto')
const { ROUTES, MAX_BODY_BYTES, MAX_RESPONSE_BYTES } = require('./agent-facade.cjs')
const OPERATIONS = new Set(Object.values(ROUTES).map(route => route.command).filter(Boolean))
OPERATIONS.add('agent:remote-status')
OPERATIONS.add('agent:events')
for (const name of ['status', 'contract', 'runtime', 'settings', 'owner-prompts', 'research-local-tiers-status']) {
  OPERATIONS.add(`bridge:${name}`)
}
const ID = /^[a-f0-9]{32}$/
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const unavailable = () => ({ state: 'unavailable', peer: null })
const refuse = (code, outcome = 'not-sent') => ({ ok: false, code, outcome })

function validRequest(operation, params) {
  if (typeof operation !== 'string' || !OPERATIONS.has(operation) || !plain(params)) return false
  try { return Buffer.byteLength(JSON.stringify(params)) <= MAX_BODY_BYTES } catch { return false }
}

// One client per supervisor. No queue or retry survives a child, account or
// authenticated session change. Device credentials and leases never cross IPC.
function createRemoteWorkspaceClient({ timeoutMs = 35000, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  let child = null
  let state = unavailable()
  const pending = new Map()
  const listeners = new Set()
  function emit() { for (const listener of listeners) { try { listener(snapshot()) } catch {} } }
  function snapshot() { return state.peer && state.expiresAtMs > Date.now()
    ? { state: state.state, expiresAtMs: state.expiresAtMs, peer: { ...state.peer } } : unavailable() }
  function setState(value) {
    const next = plain(value) && ['ready', 'waiting'].includes(value.state) && plain(value.peer)
      && typeof value.peer.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value.peer.id)
      && Number.isFinite(value.expiresAtMs) && value.expiresAtMs > Date.now()
      && ID.test(value.peer.selection || '')
      ? { state: value.state, expiresAtMs: value.expiresAtMs, peer: { id: value.peer.id, selection: value.peer.selection } } : unavailable()
    const changed = JSON.stringify(next) !== JSON.stringify(state)
    state = next
    if (changed) emit()
  }
  function detach() {
    child = null
    setState(null)
    for (const item of pending.values()) {
      cancel(item.timer)
      item.resolve(refuse('REMOTE_OUTCOME_UNKNOWN', item.write ? 'unknown' : 'unavailable'))
    }
    pending.clear()
  }
  function attach(next) {
    detach()
    child = next
    next.on?.('message', packet => {
      if (child !== next || !plain(packet)) return
      if (packet.type === 'fra:state') { setState(packet.value); return }
      if (packet.type !== 'fra:reply' || !ID.test(packet.id || '')) return
      const item = pending.get(packet.id)
      if (!item) return
      pending.delete(packet.id)
      cancel(item.timer)
      const value = packet.value
      if (item.status) { setState(value); item.resolve(snapshot()); return }
      if (snapshot().peer?.selection !== item.selection || snapshot().peer?.id !== item.peerId) {
        item.resolve(refuse('REMOTE_OUTCOME_UNKNOWN', item.write ? 'unknown' : 'unavailable')); return
      }
      if (!plain(value)) { item.resolve(refuse('REMOTE_OUTCOME_UNKNOWN', 'unknown')); return }
      if (value.ok !== true) {
        const code = ['REMOTE_REQUEST_REFUSED', 'REMOTE_REQUEST_BUSY', 'REMOTE_CONNECTION_CHANGED',
          'REMOTE_NOT_READY', 'REMOTE_OUTCOME_UNKNOWN'].includes(value.code) ? value.code : 'REMOTE_OUTCOME_UNKNOWN'
        if (code === 'REMOTE_CONNECTION_CHANGED') setState(null)
        item.resolve(refuse(code, ['not-sent', 'unavailable', 'unknown'].includes(value.outcome) ? value.outcome : 'unknown'))
        return
      }
      if (value.selection !== item.selection || !Number.isInteger(value.status) || value.status < 100
        || value.status > 599 || !plain(value.value) || Buffer.byteLength(JSON.stringify(value.value)) > MAX_RESPONSE_BYTES) {
        item.resolve(refuse('REMOTE_OUTCOME_UNKNOWN', 'unknown')); return
      }
      item.resolve({ ok: true, status: value.status, value: value.value })
    })
    next.once?.('disconnect', () => { if (child === next) detach() })
  }
  function send(type, fields = {}) {
    if (!child || typeof child.send !== 'function' || child.connected === false) return Promise.resolve(refuse('REMOTE_NOT_READY'))
    if (pending.size >= 16) return Promise.resolve(refuse('REMOTE_REQUEST_BUSY'))
    const selected = child
    const id = crypto.randomBytes(16).toString('hex')
    const write = fields.operation && !fields.operation.startsWith('bridge:')
      && Object.values(ROUTES).some(route => route.command === fields.operation && route.method === 'POST')
    return new Promise(resolve => {
      const timer = schedule(() => {
        if (!pending.delete(id)) return
        resolve(refuse('REMOTE_OUTCOME_UNKNOWN', write ? 'unknown' : 'unavailable'))
      }, timeoutMs)
      pending.set(id, { resolve, timer, write, status: type === 'fra:status', selection: fields.selection, peerId: state.peer?.id })
      try {
        selected.send({ type, id, ...fields }, error => {
          const item = pending.get(id)
          if (!error || !item) return
          pending.delete(id); cancel(item.timer)
          // A channel callback error does not establish whether the child acted.
          resolve(refuse('REMOTE_OUTCOME_UNKNOWN', write ? 'unknown' : 'unavailable'))
        })
      } catch {
        pending.delete(id); cancel(timer)
        resolve(refuse('REMOTE_OUTCOME_UNKNOWN', write ? 'unknown' : 'unavailable'))
      }
    })
  }
  return {
    attach, detach, snapshot,
    async status() {
      const answer = await send('fra:status')
      if (answer?.state) return answer
      setState(null)
      return snapshot()
    },
    request(selection, operation, params = {}) {
      if (!ID.test(selection || '') || !validRequest(operation, params)) return Promise.resolve(refuse('REMOTE_REQUEST_REFUSED'))
      if (snapshot().peer?.selection !== selection) return Promise.resolve(refuse('REMOTE_CONNECTION_CHANGED'))
      return send('fra:request', { selection, operation, params })
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

module.exports = { createRemoteWorkspaceClient, validRequest }
