'use strict'

// Browser signaling for the existing computer speech host. The authenticated
// agent facade supplies the relay owner; a fresh client nonce separates tabs.
// Microphone audio still uses the host's existing WebRTC media connection.
const CLIENT = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const KEYS = Object.freeze({
  targets: [], start: ['clientId', 'targetAgentId', 'provider'],
  poll: ['clientId', 'after'], stop: ['clientId'],
  offer: ['clientId', 'sessionId', 'targetAgentId', 'generation', 'speechEpoch', 'type', 'sdp'],
  reply: ['clientId', 'sessionId', 'targetAgentId', 'generation', 'speechEpoch', 'utteranceId', 'text', 'final'],
  interrupt: ['clientId', 'sessionId', 'targetAgentId', 'generation', 'speechEpoch'],
})
const error = code => Object.assign(new Error(code), { code })
function publicCode(cause) {
  const code = String(cause?.code || cause?.message || '')
  return /^(VOICE_[A-Z0-9_]+|gpu_unavailable|gpu_initialization_failed|gpu_dependencies_unavailable|models_missing)$/.test(code)
    ? code.toUpperCase() : 'VOICE_CONNECTION_LOST'
}
function createVoiceRelay({ host, owner, mayWrite, now = Date.now, leaseMs = 45000 }) {
  let contact = null
  function canWrite() { try { return mayWrite() === true } catch { return false } }
  const timer = setInterval(() => {
    if (contact && (now() - contact.touched > leaseMs || !canWrite())) void release(contact).catch(() => {})
  }, Math.min(leaseMs, 1000))
  timer.unref?.()
  async function release(current) {
    if (contact !== current) return
    // Retain the reservation until the existing host releases it. A newer
    // browser must not race an old pending stop against its own voice start.
    if (current.stopping) return current.stopping
    current.state = 'stopping'
    current.stopping = Promise.resolve().then(() => host.stop(owner)).catch(cause => {
      // A failed remote start can have found a desktop-owned contact. That
      // contact belongs to its window and must stay untouched.
      if (cause?.code !== 'VOICE_OWNED_BY_ANOTHER_WINDOW') throw cause
    }).finally(() => {
      if (contact === current) contact = null
    })
    return current.stopping
  }
  function bound(value) {
    if (!contact || contact.clientId !== value.clientId || contact.state === 'stopping') throw error('VOICE_STALE_SESSION')
    if (now() - contact.touched > leaseMs) { void release(contact).catch(() => {}); throw error('VOICE_STALE_SESSION') }
    contact.touched = now()
    return contact
  }
  function validate(command, value) {
    if (!Object.hasOwn(KEYS, command) || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !KEYS[command].includes(key))) throw error('VOICE_REQUEST_INVALID')
    if (command !== 'targets' && (typeof value.clientId !== 'string' || !CLIENT.test(value.clientId))) throw error('VOICE_REQUEST_INVALID')
  }
  function emit(packet) {
    const current = contact
    if (!current || packet.targetAgentId !== current.targetAgentId || current.state === 'stopping') return
    if (current.binding && (packet.sessionId !== current.binding.sessionId || packet.generation !== current.binding.generation)) return
    if (!Number.isSafeInteger(packet.sequence) && packet.type !== 'error') return
    // Project a bounded public packet. Raw worker/provider diagnostics and
    // paths never enter the relay response or its durable request cache.
    const out = {}
    for (const key of ['type', 'sessionId', 'targetAgentId', 'generation', 'speechEpoch', 'utteranceId', 'sequence', 'state', 'text']) {
      const value = packet[key]
      if (typeof value === 'string') out[key] = value.slice(0, key === 'text' ? 8192 : 256)
      else if (Number.isSafeInteger(value)) out[key] = value
    }
    if (packet.type === 'error') out.code = publicCode(packet)
    const size = Buffer.byteLength(JSON.stringify(out))
    current.events.push({ seq: ++current.seq, packet: out, size })
    current.bytes += size
    while (current.events.length > 256 || current.bytes > 256 * 1024) current.bytes -= current.events.shift().size
  }
  async function run(command, value = {}) {
    validate(command, value)
    if (command === 'targets') return host.targets(owner)
    if (command === 'stop') {
      if (!contact) return { ok: true }
      if (contact.clientId !== value.clientId) throw error('VOICE_STALE_SESSION')
      await release(contact)
      return { ok: true }
    }
    if (!canWrite()) {
      if (contact) await release(contact)
      throw error('MC_AGENT_PRINCIPAL_READ_ONLY')
    }
    if (command === 'start') {
      if (contact) throw error('VOICE_ALREADY_ACTIVE')
      if (value.provider !== 'local') throw error('VOICE_REMOTE_LOCAL_ONLY')
      if (typeof value.targetAgentId !== 'string' || !value.targetAgentId || value.targetAgentId.length > 256) throw error('VOICE_TARGET_UNAVAILABLE')
      const current = { clientId: value.clientId, targetAgentId: value.targetAgentId,
        touched: now(), state: 'preparing', binding: null, events: [], seq: 0, bytes: 0 }
      contact = current
      // GPU startup may take minutes. Reply promptly to the tunnel and poll a
      // lease while it prepares, using the same single-contact host as desktop.
      Promise.resolve().then(() => {
        if (contact !== current || current.state !== 'preparing' || !canWrite()) throw error('VOICE_STALE_SESSION')
        return host.start(owner, { targetAgentId: value.targetAgentId, provider: 'local' })
      }).then(binding => {
        if (contact !== current || current.state === 'stopping') return
        current.binding = binding; current.state = 'ready'
      }, cause => {
        if (contact !== current || current.state === 'stopping') return
        current.state = 'error'; current.code = publicCode(cause)
      })
      return { state: 'preparing' }
    }
    const current = bound(value)
    if (command === 'poll') {
      const after = value.after ?? 0
      if (!Number.isSafeInteger(after) || after < 0 || after > current.seq) throw error('VOICE_REQUEST_INVALID')
      const events = []; let bytes = 0
      for (const event of current.events) {
        if (event.seq <= after) continue
        if (bytes + event.size > 48 * 1024) break
        events.push({ seq: event.seq, packet: event.packet }); bytes += event.size
      }
      const last = events.at(-1)?.seq ?? after
      return { state: current.state, ...(current.binding ? { binding: current.binding } : {}),
        ...(current.code ? { code: current.code } : {}), events, next: last,
        dropped: Boolean(current.events.length && after < current.events[0].seq - 1) }
    }
    if (current.state !== 'ready') throw error('VOICE_NOT_READY')
    const { clientId, ...payload } = value
    return host[command](owner, payload)
  }
  async function disconnect() { if (contact) await release(contact) }
  return Object.freeze({ run, emit, disconnect, async close() { clearInterval(timer); await disconnect() } })
}
module.exports = { createVoiceRelay }
