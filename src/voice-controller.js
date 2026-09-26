// Speech onset cancels the selected agent turn. Recognition and endpointing
// hold the next instruction until the person has finished speaking.
import { createSpeechText } from './voice-speech-text.js'

export function createVoiceController({ voice, agent, queue, record = () => {}, notify = () => {}, id = () => crypto.randomUUID(), settleMs = 900, schedule = setTimeout, unschedule = clearTimeout }) {
  let binding = null, epoch = 0, sending = false, order = Promise.resolve()
  let drainRequested = false, speechPaused = false, queuedCharacters = 0
  let mediaReady = true
  const messageEpochs = new Map()
  const turns = new Map(), transcripts = new Set(), canceledTurns = new Set()
  let suppressed = false
  let speaking = false, latestSpeechEpoch = -1, settleTimer = null, settling = false
  let cancellation = null, cancellationFailed = false, inputRevision = 0
  const recognizing = new Set(), fragments = new Map()
  let releaseDrain = null
  function holdDrain() { if (!releaseDrain && binding) releaseDrain = queue.holdDrain?.(binding.targetAgentId) || null }
  function allowDrain() { releaseDrain?.(); releaseDrain = null }
  function clearSettle() {
    if (settleTimer !== null) unschedule(settleTimer)
    settleTimer = null
  }
  function resetInput() {
    clearSettle(); allowDrain(); speaking = false; settling = false; latestSpeechEpoch = -1
    recognizing.clear(); fragments.clear(); cancellation = null; cancellationFailed = false; inputRevision++
  }
  function blockPlayback() {
    suppressed = true
    for (const turn of turns.values()) { turn.buffer = ''; turn.blocked = true }
  }
  function cancelAgent() {
    if (!binding || cancellation) return cancellation
    const current = binding
    const task = Promise.resolve().then(() => agent.interrupt({ sessionId: current.targetAgentId }))
      .then(result => {
        if (result?.ok === false) throw new Error(result.code || 'AGENT_INTERRUPT_FAILED')
        if (binding === current && result?.turnId) {
          canceledTurns.add(result.turnId)
          if (canceledTurns.size > 256) canceledTurns.delete(canceledTurns.values().next().value)
          const turn = turns.get(result.turnId)
          if (turn) { turn.blocked = true; turn.buffer = '' }
        }
      })
      .catch(error => {
        if (binding !== current) return
        if (!/AGENT_TURN_NONE/.test(String(error?.code) + ' ' + String(error?.message))) {
          cancellationFailed = true
          notify('Could not stop the agent. Your speech is held; end voice and stop the agent before retrying.')
        }
      }).finally(() => {
        if (binding === current && cancellation === task) { cancellation = null; scheduleInput() }
      })
    cancellation = task
    return task
  }
  function scheduleInput() {
    clearSettle()
    if (!binding || speaking || recognizing.size || cancellation || cancellationFailed || !fragments.size) return
    settling = true
    const current = binding, revision = inputRevision
    const submit = () => {
      settleTimer = null
      if (binding !== current || revision !== inputRevision || speaking || recognizing.size || cancellation || cancellationFailed) return
      const text = [...fragments.values()].sort((a, b) => a.epoch - b.epoch).map(part => part.text).filter(Boolean).join(' ')
      if (text.length > 4000) {
        notify('That spoken instruction is too long for one agent message. Nothing was sent. Your full transcript is shown below; shorten it or send it through typed chat.')
        return
      }
      if (!text) { fragments.clear(); settling = false; notify('No words recognized. The agent remains stopped; please repeat.'); return }
      const entry = queue.enqueue(current.targetAgentId, text)
      if (!entry?.ok) { notify(entry?.sentence || 'The message queue is full. Please use typed chat.'); return }
      if (entry.entry?.id !== undefined) {
        messageEpochs.set(entry.entry.id, { binding: current, epoch })
        if (messageEpochs.size > 256) messageEpochs.delete(messageEpochs.keys().next().value)
      }
      fragments.clear(); settling = false; allowDrain()
      void drain()
    }
    if (settleMs === 0) submit()
    else settleTimer = schedule(submit, settleMs)
  }
  function pauseSpeech() {
    if (speechPaused || !binding) return
    speechPaused = true
    for (const turn of turns.values()) { turn.blocked = true; turn.buffer = '' }
    const current = binding
    void voice.interrupt(current).then(answer => {
      if (binding === current && Number.isSafeInteger(answer?.speechEpoch)) epoch = Math.max(epoch, answer.speechEpoch)
    }).catch(() => {})
    notify('Speech paused because playback could not keep up or failed. The full reply remains in text; speak again when ready.')
  }
  function matches(packet) {
    return binding && packet?.sessionId === binding.sessionId && packet.targetAgentId === binding.targetAgentId && packet.generation === binding.generation
  }
  function speak(turn, text, final = false) {
    if (!binding || !mediaReady || turn.epoch !== epoch || suppressed || turn.blocked || speechPaused) return
    text = turn.speech.write(text, final)
    if (!text.trim() && !final) return
    if (queuedCharacters + text.length > 16384) { pauseSpeech(); return }
    queuedCharacters += text.length
    const request = { ...binding, speechEpoch: turn.epoch, utteranceId: turn.utteranceId, text, final }
    order = order.then(async () => {
      try {
        if (!matches(request) || request.speechEpoch !== epoch || turn.blocked || suppressed || speechPaused) return
        await voice.reply(request)
      } finally { queuedCharacters -= text.length }
    }).catch(() => { if (matches(request) && request.speechEpoch === epoch && !turn.blocked) pauseSpeech() })
  }
  function flush(turn, final = false) {
    if (!mediaReady || suppressed || turn.blocked || turn.epoch !== epoch) return
    if (!turn.buffer) { if (final) speak(turn, '', true); return }
    // Sentence-sized chunks avoid token-by-token TTS requests. A bounded clause
    // also starts speech when an agent writes a long sentence or list.
    const match = turn.buffer.match(/^([\s\S]*?[.!?](?:\s|$))/)
    let count = final ? Math.min(turn.buffer.length, 4096) : match ? Math.min(match[0].length, 4096) : turn.buffer.length >= 220 ? turn.buffer.lastIndexOf(' ', 220) : 0
    if (count < 1 && turn.buffer.length >= 220) count = 220
    if (count > 0) {
      const text = turn.buffer.slice(0, count); turn.buffer = turn.buffer.slice(count)
      speak(turn, text, final && !turn.buffer)
      if (turn.buffer.length) flush(turn, final)
    }
  }
  async function drain() {
    if (!binding || speaking || settling || recognizing.size || cancellation || cancellationFailed) return
    if (sending) { drainRequested = true; return }
    const current = binding
    let completedBeforeAdmission = false
    const entry = queue.takeNext(current.targetAgentId)
    if (!entry) return
    const captured = messageEpochs.get(entry.id)
    const sentRevision = inputRevision
    const sentEpoch = captured ? (captured.binding === current ? captured.epoch : -1) : epoch
    sending = true
    try {
      const result = await agent.send({ sessionId: current.targetAgentId, text: entry.text })
      if (result?.ok === false) throw new Error(result.code || 'AGENT_SEND_FAILED')
      queue.confirmDelivered(current.targetAgentId, entry)
      messageEpochs.delete(entry.id)
      record(current.targetAgentId, 'you', entry.text)
      const admittedTurn = binding === current ? turns.get(result?.turnId) : null
      if (admittedTurn) { admittedTurn.epoch = sentEpoch; completedBeforeAdmission = admittedTurn.completed }
      if (binding === current && sentRevision !== inputRevision) {
        blockPlayback(); void cancelAgent()
      }
      if (binding === current && sentEpoch === epoch && sentRevision === inputRevision && !speaking && !settling) {
        suppressed = false; speechPaused = false
        const turn = turns.get(result?.turnId)
        if (turn && !canceledTurns.has(result?.turnId)) { turn.blocked = false; completedBeforeAdmission = turn.completed; flush(turn, turn.completed) }
        notify('Listening. Your agent is working.')
      }
    } catch (error) {
      queue.requeueFront(current.targetAgentId, entry)
      if (binding === current) notify(String(error?.message).includes('AGENT_TURN_ACTIVE')
        ? 'Listening. Your next instruction is queued for this agent.'
        : 'Could not send. Your words remain in this agent’s message queue.')
    } finally {
      sending = false
      const wake = drainRequested || completedBeforeAdmission
      drainRequested = false
      if (wake) void drain()
    }
  }
  return Object.freeze({
    bind(value, { ready = true } = {}) {
      resetInput(); binding = value; mediaReady = ready; epoch = value.speechEpoch || 0; suppressed = false; speechPaused = false; turns.clear(); transcripts.clear(); canceledTurns.clear()
    },
    ready() { mediaReady = true; for (const turn of turns.values()) flush(turn, turn.completed) },
    unbind() { resetInput(); binding = null; turns.clear(); transcripts.clear(); canceledTurns.clear(); suppressed = true },
    async interrupt() {
      if (!binding) return
      const current = binding
      clearSettle(); fragments.clear(); settling = false; holdDrain(); inputRevision++
      blockPlayback()
      const stopping = cancelAgent()
      const answer = await voice.interrupt(current)
      await stopping
      if (binding === current && Number.isSafeInteger(answer?.speechEpoch)) epoch = Math.max(epoch, answer.speechEpoch)
    },
    onVoice(packet) {
      if (!matches(packet)) return
      if (Number.isSafeInteger(packet.speechEpoch) && packet.speechEpoch > epoch) {
        epoch = packet.speechEpoch; suppressed = true
        for (const turn of turns.values()) { turn.buffer = ''; turn.blocked = true }
      }
      if (packet.accessibilityHandled === true) {
        recognizing.delete(packet.speechEpoch)
        if (packet.speechEpoch === latestSpeechEpoch) speaking = false
        if (fragments.size) scheduleInput()
        else { settling = false; allowDrain() }
        return
      }
      const packetEpoch = Number.isSafeInteger(packet.speechEpoch) ? packet.speechEpoch : epoch
      if (packet.type === 'speech.started') {
        if (packetEpoch <= latestSpeechEpoch) return
        latestSpeechEpoch = packetEpoch; inputRevision++
        speaking = true; settling = true; holdDrain(); recognizing.add(packetEpoch); clearSettle(); blockPlayback()
        void cancelAgent()
        notify('Listening. Stopping your agent while you speak…')
      }
      if (packet.type === 'speech.stopped') {
        if (packetEpoch === latestSpeechEpoch) speaking = false
        scheduleInput()
      }
      if (packet.type === 'transcript.final' && typeof packet.text === 'string') {
        const key = packet.utteranceId || packet.sequence
        if (transcripts.has(key)) return
        transcripts.add(key)
        if (transcripts.size > 256) transcripts.delete(transcripts.values().next().value)
        recognizing.delete(packetEpoch)
        // A final also closes its own segment, never a newer VAD segment.
        if (packetEpoch === latestSpeechEpoch) speaking = false
        fragments.set(key, { text: packet.text.trim(), epoch: packetEpoch })
        settling = true; holdDrain()
        notify('Listening for anything else before your agent continues…')
        scheduleInput()
      }
    },
    onAgent(packet) {
      if (!binding || packet?.sessionId !== binding.targetAgentId) return
      const event = packet.event
      if (!event) return
      if (event.type === 'session_ended') { notify('This agent has ended. Select another voice contact.'); return }
      // Refuse unbound output rather than guessing which in-flight turn it was.
      if (typeof event.turnId !== 'string' || !event.turnId) return
      let turn = turns.get(event.turnId)
      if (!turn) {
        turn = { epoch, utteranceId: id(), buffer: '', full: '', speech: createSpeechText(), deltas: false, blocked: suppressed || canceledTurns.has(event.turnId), completed: false }
        turns.set(event.turnId, turn)
        if (turns.size > 64) turns.delete(turns.keys().next().value)
      }
      if (event.type === 'assistant_text_delta' && typeof event.text === 'string') {
        if (turn.completed) return
        turn.deltas = true; turn.buffer = (turn.buffer + event.text).slice(-24000); turn.full = (turn.full + event.text).slice(-24000); flush(turn)
      } else if (event.type === 'assistant_text') {
        if (!turn.deltas && typeof event.text === 'string') { turn.buffer += event.text; turn.full = (turn.full + event.text).slice(-24000) }
        flush(turn); turn.deltas = false
      } else if (event.type === 'turn_completed') {
        if (turn.completed) return
        turn.completed = true
        flush(turn, true)
        if (turn.full) record(binding.targetAgentId, 'agent', turn.full)
        void drain()
      }
    },
    drain,
  })
}
