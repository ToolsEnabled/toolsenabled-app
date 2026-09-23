'use strict'

// One microphone conversation per shell. Speech has no agent tools or authority;
// target ownership is checked by the existing agent session map on every call.
const { spawn } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const path = require('node:path')
const { resolveVoiceRuntime } = require('./voice-runtime-paths.cjs')

function voiceError(code) { return Object.assign(new Error(code), { code }) }
function createVoiceHost({ appRoot, resourcesPath, profileRoot, runtimeDataRoot, sessions, emit, onEnd = () => {}, spawnProcess = spawn, fetchHttp = fetch, findRuntime = null }) {
  let child = null, origin = null, token = null, starting = null, active = null
  let idleTimer = null
  let cancelStarting = null
  let generation = 0
  function runtimePaths() {
    return resolveVoiceRuntime({ appRoot, resourcesPath, profileRoot, runtimeDataRoot })
  }
  function owned(owner, targetAgentId) {
    const session = sessions.get(targetAgentId)
    if (!session || session.owner !== owner || session.ended || session.state === 'ended') throw voiceError('VOICE_TARGET_UNAVAILABLE')
    return session
  }
  function bound(owner, value) {
    if (!active || active.owner !== owner || value?.sessionId !== active.sessionId || value?.generation !== active.generation || value?.targetAgentId !== active.targetAgentId) throw voiceError('VOICE_STALE_SESSION')
    owned(owner, active.targetAgentId)
    return active
  }
  async function request(route, method = 'GET', body, waitMs = 30000) {
    if (!origin) throw voiceError('VOICE_RUNTIME_UNAVAILABLE')
    const response = await fetchHttp(origin + route, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(waitMs),
    })
    if (!response.ok) {
      const failure = await response.json().catch(() => null)
      if (response.status === 409 && route.endsWith('/reply') && ['stale_speech', 'stale_utterance', 'stale_binding'].includes(failure?.error?.code)) return { ok: false, dropped: true }
      const publicCodes = new Set(['cloud_quota_exhausted', 'cloud_rate_limited', 'cloud_key_missing', 'cloud_key_rejected', 'gpu_unavailable', 'gpu_initialization_failed', 'gpu_dependencies_unavailable', 'models_missing', 'speech_backpressure', 'transcription_backpressure'])
      if (publicCodes.has(failure?.error?.code)) throw voiceError(failure.error.code)
      // Do not propagate raw provider errors: they can carry credentials or text.
      throw voiceError(response.status === 429 ? 'VOICE_RATE_LIMITED' : 'VOICE_RUNTIME_REQUEST_FAILED')
    }
    return response.status === 204 ? {} : response.json()
  }
  function push(session, event) {
    if (active !== session) return
    emit(session.owner, { ...event, sessionId: session.sessionId, targetAgentId: session.targetAgentId, generation: session.generation })
  }
  async function ensureRuntime() {
    clearTimeout(idleTimer)
    if (origin) return
    if (starting) return starting
    const paths = findRuntime ? findRuntime() : runtimePaths()
    token = randomBytes(32).toString('hex')
    starting = new Promise((resolve, reject) => {
      const proc = spawnProcess(paths.python, ['-E', '-s', '-B', '-u', paths.worker], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(paths.worker) })
      child = proc
      let output = '', ready = false
      const fail = () => { clearTimeout(timer); reject(voiceError('VOICE_RUNTIME_START_FAILED')) }
      const timer = setTimeout(() => { proc.kill(); fail() }, 30000)
      cancelStarting = fail
      proc.once('error', fail)
      proc.once('exit', () => {
        clearTimeout(timer)
        if (child === proc) {
          child = null; origin = null; token = null
          if (active) push(active, { type: 'error', code: 'VOICE_RUNTIME_STOPPED' })
          const ended = active
          active = null
          if (ended) onEnd(ended.owner, ended.targetAgentId)
        }
        if (!ready) reject(voiceError('VOICE_RUNTIME_START_FAILED'))
      })
      proc.stdout.on('data', bytes => {
        if (ready || child !== proc) return
        output += bytes.toString()
        if (output.length > 65536) { proc.kill(); fail(); return }
        const lines = output.split('\n'); output = lines.pop()
        for (const line of lines) {
          let value
          try { value = JSON.parse(line) } catch { continue }
          if (value.type !== 'ready' || value.protocolVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) continue
          origin = `http://127.0.0.1:${value.port}`; ready = true; clearTimeout(timer); resolve(); break
        }
      })
      // Drain diagnostic output without copying transcripts/provider errors into shell logs.
      proc.stderr.on('data', () => {})
      proc.stdin.on('error', () => {})
      // Keep disposable audio alongside this runtime's caches. The profile
      // fence is an ownership boundary, not a platform-specific temp location.
      proc.stdin.write(JSON.stringify({ token, profileRoot, dataRoot: paths.dataRoot, assetRoot: paths.assetRoot, modelRoot: paths.modelRoot, tempRoot: path.join(paths.dataRoot, 'temp') }) + '\n')
    }).finally(() => { starting = null; cancelStarting = null })
    return starting
  }
  async function poll(session) {
    let after = 0
    try {
      while (active === session) {
        const answer = await request(`/sessions/${session.sessionId}/events?after=${after}&waitMs=25000`)
        if (active !== session) break
        for (const event of answer.events || []) {
          if (event.sessionId !== session.sessionId || event.targetAgentId !== session.targetAgentId || event.generation !== session.generation || !Number.isSafeInteger(event.sequence) || event.sequence <= after) continue
          after = event.sequence
          push(session, event)
        }
      }
    } catch {
      if (active === session) { push(session, { type: 'error', code: 'VOICE_CONNECTION_LOST' }); await stop(session.owner) }
    }
  }
  async function stop(owner) {
    const session = active
    if (!session) return { ok: true }
    if (session.owner !== owner) throw voiceError('VOICE_OWNED_BY_ANOTHER_WINDOW')
    active = null
    onEnd(session.owner, session.targetAgentId)
    try { await request(`/sessions/${session.sessionId}`, 'DELETE', undefined, 5000) } catch { /* inactive locally, no further transcripts accepted */ }
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { if (!active) { child?.stdin.end(); child?.kill(); child = null; origin = null; token = null } }, 60000)
    idleTimer.unref?.()
    return { ok: true }
  }
  return Object.freeze({
    targets(owner) {
      return [...sessions].filter(([, s]) => s.owner === owner && !s.ended && s.state !== 'ended').map(([sessionId, s]) => ({ sessionId, agentId: s.agentId, tier: s.tier, state: s.state }))
    },
    async start(owner, value) {
      if (active) throw voiceError('VOICE_ALREADY_ACTIVE')
      const targetAgentId = value?.targetAgentId
      owned(owner, targetAgentId)
      if (!['local', 'openai'].includes(value?.provider)) throw voiceError('VOICE_PROVIDER_INVALID')
      const cloud = value.provider === 'openai'
      if (cloud && (typeof value.apiKey !== 'string' || value.apiKey.length < 10 || value.apiKey.length > 2048)) throw voiceError('VOICE_API_KEY_REQUIRED')
      // Reserve before awaiting startup: a second window cannot take the microphone.
      const session = { owner, sessionId: randomUUID(), targetAgentId, generation: ++generation }
      active = session
      try {
        await ensureRuntime()
        if (active !== session) throw voiceError('VOICE_STALE_SESSION')
        owned(owner, targetAgentId)
        const result = await request('/sessions', 'POST', {
          sessionId: session.sessionId, targetAgentId, generation: session.generation,
          provider: { stt: value.provider, tts: value.provider, ...(cloud ? { apiKey: value.apiKey } : {}) },
        }, 360000)
        if (active !== session) { await request(`/sessions/${session.sessionId}`, 'DELETE'); throw voiceError('VOICE_STALE_SESSION') }
        if (result.ok === false) throw voiceError('VOICE_SESSION_START_FAILED')
        void poll(session)
        return { sessionId: session.sessionId, targetAgentId, generation: session.generation, speechEpoch: result.speechEpoch || 0 }
      } catch (error) {
        if (active === session) await stop(owner)
        throw error
      }
    },
    async offer(owner, value) {
      const session = bound(owner, value)
      if (value.type !== 'offer' || typeof value.sdp !== 'string' || value.sdp.length > 65536) throw voiceError('VOICE_OFFER_INVALID')
      return request(`/sessions/${session.sessionId}/offer`, 'POST', { sdp: value.sdp, type: value.type })
    },
    async reply(owner, value) {
      const session = bound(owner, value)
      if (typeof value.text !== 'string' || value.text.length > 4096 || typeof value.utteranceId !== 'string' || value.utteranceId.length > 128) throw voiceError('VOICE_REPLY_INVALID')
      if (!Number.isSafeInteger(value.speechEpoch) || value.speechEpoch < 0) throw voiceError('VOICE_REPLY_INVALID')
      return request(`/sessions/${session.sessionId}/reply`, 'POST', { targetAgentId: session.targetAgentId, generation: session.generation, speechEpoch: value.speechEpoch, utteranceId: value.utteranceId, text: value.text, final: value.final === true })
    },
    async interrupt(owner, value) {
      const session = bound(owner, value)
      return request(`/sessions/${session.sessionId}/interrupt`, 'POST', { targetAgentId: session.targetAgentId, generation: session.generation })
    },
    // Local safety prompts use the same selected speech connection but never
    // travel through the model. No renderer or agent API exposes this method.
    async announce(owner, targetAgentId, text) {
      const session = active
      if (!session || session.owner !== owner || session.targetAgentId !== targetAgentId) return
      if (typeof text !== 'string' || text.length > 4096) throw voiceError('VOICE_REPLY_INVALID')
      owned(owner, targetAgentId)
      const answer = await request(`/sessions/${session.sessionId}/interrupt`, 'POST', { targetAgentId, generation: session.generation })
      if (active !== session || !Number.isSafeInteger(answer.speechEpoch)) return
      push(session, { type: 'accessibility.prompt', speechEpoch: answer.speechEpoch })
      return request(`/sessions/${session.sessionId}/reply`, 'POST', { targetAgentId, generation: session.generation,
        speechEpoch: answer.speechEpoch, utteranceId: randomUUID(), text, final: true })
    },
    stop,
    allowsMicrophone(owner) { return active?.owner === owner },
    close(owner) { if (!owner || active?.owner === owner) { clearTimeout(idleTimer); const ended = active; active = null; if (ended) onEnd(ended.owner, ended.targetAgentId); const closing = child; child = null; origin = null; token = null; cancelStarting?.(); closing?.stdin.end(); closing?.kill() } },
  })
}
module.exports = { createVoiceHost }
