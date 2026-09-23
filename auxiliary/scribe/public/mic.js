'use strict';
/**
 * Voice input.
 *
 * You hold the mic open, speak, and stop speaking. Endpointing is done here on
 * the level signal rather than on the server, so no audio leaves the page until
 * an utterance is actually complete. That is one round trip per utterance
 * instead of a continuous stream, which is both simpler and, for a "speak then
 * watch it act" loop, indistinguishable in feel.
 *
 * Deliberately NOT streaming partial transcripts. Whisper-family models are
 * chunked pseudo-streaming with a structural latency floor near twice the chunk
 * size, so partials would arrive late enough to be a distraction rather than
 * feedback. The measured path here is 218 ms for a 5 second utterance.
 *
 * getUserMedia requires a secure context. http://127.0.0.1 qualifies without
 * TLS. A LAN IP does NOT, and the failure is a silent absence of audio, so the
 * origin is checked up front and the user is told rather than left guessing.
 */

const mic = {
  ctx: null,
  source: null,
  node: null,
  sink: null,
  stream: null,
  chunks: [],        // Float32Array pieces at 16 kHz
  samples: 0,
  listening: false,
  speaking: false,
  noiseFloor: 0.006,
  lastVoiceAt: 0,
  startedAt: 0,
  onText: null,
  onState: null,
  starting: null,
  generation: 0,
  utteranceSeq: 0,
  nextTranscriptSeq: 1,
  transcriptResults: new Map(),
  transcriptionRequests: new Map(),
};

const SILENCE_MS = 700;     // how long a pause must be to end an utterance
const MIN_SPEECH_MS = 250;  // ignore coughs and clicks
const MAX_UTTERANCE_MS = 30000;
const DEFAULT_STT_TIMEOUT_MS = 120000;

function sttTimeoutMs() {
  const configured = Number(window.__SCRIBE_STT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1
    ? configured
    : DEFAULT_STT_TIMEOUT_MS;
}

function cancelPendingTranscriptions() {
  for (const request of mic.transcriptionRequests.values()) {
    try { if (request.controller) request.controller.abort(); } catch (_) {}
  }
  mic.transcriptResults.clear();
  mic.nextTranscriptSeq = mic.utteranceSeq + 1;
}

function micSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorklet);
}

/** The exact rule, stated rather than assumed. */
function micOriginOk() {
  if (window.isSecureContext) return true;
  return location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '::1';
}

function releaseMicResources() {
  try { if (mic.node) mic.node.port.onmessage = null; } catch (_) {}
  try { if (mic.source) mic.source.disconnect(); } catch (_) {}
  try { if (mic.node) mic.node.disconnect(); } catch (_) {}
  try { if (mic.sink) mic.sink.disconnect(); } catch (_) {}
  try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try {
    if (mic.ctx) {
      const closing = mic.ctx.close();
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
    }
  } catch (_) {}
  mic.ctx = mic.source = mic.node = mic.sink = mic.stream = null;
}

async function startMicOnce(generation) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    return { ok: false, error:
      e && e.name === 'NotAllowedError'
        ? 'Microphone permission denied. Windows also has a system toggle: Settings, Privacy, Microphone.'
        : `Could not open the microphone: ${e && e.message || e}` };
  }
  if (generation !== mic.generation) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    return { ok: false, error: 'Microphone start was cancelled.' };
  }
  mic.stream = stream;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('This browser has no AudioContext.');
    mic.ctx = new AudioContext();
    if (!mic.ctx.audioWorklet) throw new Error('This browser has no AudioWorklet.');
    await mic.ctx.audioWorklet.addModule('/mic-worklet.js');
    if (generation !== mic.generation) {
      releaseMicResources();
      return { ok: false, error: 'Microphone start was cancelled.' };
    }
    mic.source = mic.ctx.createMediaStreamSource(mic.stream);
    mic.node = new AudioWorkletNode(mic.ctx, 'mic');
    mic.node.port.onmessage = (e) => onAudio(e.data);
    mic.source.connect(mic.node);
    // A worklet with no destination is allowed to be culled. Route it into a
    // muted gain node so the graph stays alive without making a sound.
    mic.sink = mic.ctx.createGain();
    mic.sink.gain.value = 0;
    mic.node.connect(mic.sink);
    mic.sink.connect(mic.ctx.destination);
  } catch (e) {
    releaseMicResources();
    return { ok: false, error: `Could not initialize the microphone: ${e && e.message || e}` };
  }

  mic.listening = true;
  mic.speaking = false;
  mic.chunks = [];
  mic.samples = 0;
  if (mic.onState) mic.onState('listening');
  return { ok: true, sampleRate: mic.ctx.sampleRate };
}

async function micStart() {
  if (mic.listening) return { ok: true };
  if (mic.starting) return mic.starting;
  if (!micSupported()) return { ok: false, error: 'This browser has no AudioWorklet or getUserMedia.' };
  if (!micOriginOk()) {
    return { ok: false, error:
      `The microphone needs a secure origin. Open Scribe at http://127.0.0.1, not ${location.host}.` };
  }
  cancelPendingTranscriptions();
  const generation = ++mic.generation;
  const starting = startMicOnce(generation);
  mic.starting = starting;
  try {
    return await starting;
  } finally {
    if (mic.starting === starting) mic.starting = null;
  }
}

function micStop() {
  mic.generation++;
  mic.listening = false;
  mic.speaking = false;
  cancelPendingTranscriptions();
  releaseMicResources();
  mic.chunks = [];
  mic.samples = 0;
  if (mic.onState) mic.onState('off');
}

function onAudio(msg) {
  if (!mic.listening) return;

  if (msg.type === 'pcm') {
    const f = new Float32Array(msg.pcm);
    if (mic.speaking) { mic.chunks.push(f); mic.samples += f.length; }
    else {
      // Keep pre-roll so the first word is not clipped. 0.4s proved too tight
      // when audio was already flowing as the worklet connected.
      mic.chunks.push(f);
      mic.samples += f.length;
      const keep = 16000 * 0.7;
      while (mic.samples > keep && mic.chunks.length > 1) { mic.samples -= mic.chunks.shift().length; }
    }
    return;
  }

  if (msg.type !== 'level') return;
  const now = performance.now();
  const rms = msg.rms;

  // Adaptive noise floor: track the quiet, react to the loud. Without this a
  // fixed threshold either misses soft speech or triggers on a fan.
  if (!mic.speaking) mic.noiseFloor = mic.noiseFloor * 0.995 + rms * 0.005;
  const threshold = Math.max(mic.noiseFloor * 3.2, 0.008);

  if (rms > threshold) {
    mic.lastVoiceAt = now;
    if (!mic.speaking) {
      mic.speaking = true;
      mic.startedAt = now;
      if (mic.onState) mic.onState('speaking');
    }
  } else if (mic.speaking) {
    const silentFor = now - mic.lastVoiceAt;
    const spokeFor = mic.lastVoiceAt - mic.startedAt;
    if (silentFor > SILENCE_MS) {
      mic.speaking = false;
      if (spokeFor >= MIN_SPEECH_MS) endUtterance();
      else { mic.chunks = []; mic.samples = 0; if (mic.onState) mic.onState('listening'); }
    }
  }
  if (mic.speaking && now - mic.startedAt > MAX_UTTERANCE_MS) {
    mic.speaking = false;
    endUtterance();
  }
  if (mic.onLevel) mic.onLevel(rms, threshold);
}

async function endUtterance() {
  if (!mic.listening) return;
  const generation = mic.generation;
  const chunks = mic.chunks;
  const n = mic.samples;
  mic.chunks = [];
  mic.samples = 0;
  if (!n) { if (mic.onState) mic.onState('listening'); return; }
  const sequence = ++mic.utteranceSeq;

  if (mic.onState) mic.onState('thinking');

  // Float32 to 16-bit PCM, which is what the model wants and is half the bytes.
  const pcm = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }

  const Controller = window.AbortController ||
    (typeof globalThis.AbortController === 'function' ? globalThis.AbortController : null);
  const controller = Controller ? new Controller() : null;
  const request = { controller, timer: null, timedOut: false };
  mic.transcriptionRequests.set(sequence, request);
  const timeoutMs = sttTimeoutMs();
  const timeout = new Promise((_, reject) => {
    request.timer = setTimeout(() => {
      request.timedOut = true;
      try { if (controller) controller.abort(); } catch (_) {}
      const error = new Error(`Speech transcription timed out after ${timeoutMs} ms.`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  const cancelled = controller
    ? new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        const error = new Error(request.timedOut
          ? `Speech transcription timed out after ${timeoutMs} ms.`
          : 'Speech transcription was cancelled.');
        error.name = request.timedOut ? 'TimeoutError' : 'AbortError';
        reject(error);
      }, { once: true });
    })
    : new Promise(() => {});

  let completion;
  try {
    // Keep response-body parsing inside the same deadline. fetch() can resolve
    // as soon as headers arrive while a broken peer leaves JSON bytes hanging.
    const network = (async () => {
      const res = await fetch('/api/stt', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-sample-rate': '16000' },
        body: pcm.buffer,
        ...(controller ? { signal: controller.signal } : {}),
      });
      return { res, out: await res.json() };
    })();
    const { res, out } = await Promise.race([network, timeout, cancelled]);
    const status = Number(res.status);
    const ok = typeof res.ok === 'boolean'
      ? res.ok
      : !(Number.isFinite(status) && status >= 400);
    if (!ok) {
      throw new Error(out && out.error ||
        `Speech transcription failed${Number.isFinite(status) ? ` (${status})` : ''}.`);
    }
    if (!out || typeof out !== 'object' || Array.isArray(out)) {
      throw new Error('Speech transcription returned an invalid response.');
    }
    completion = out.error
      ? { error: String(out.error) }
      : { text: typeof out.text === 'string' ? out.text : '', out };
  } catch (e) {
    completion = { error: String(e && e.message || e) };
  } finally {
    clearTimeout(request.timer);
    mic.transcriptionRequests.delete(sequence);
  }

  if (generation !== mic.generation || !mic.listening) return;
  mic.transcriptResults.set(sequence, completion);
  while (generation === mic.generation && mic.listening &&
         mic.transcriptResults.has(mic.nextTranscriptSeq)) {
    const ready = mic.transcriptResults.get(mic.nextTranscriptSeq);
    mic.transcriptResults.delete(mic.nextTranscriptSeq++);
    if (ready.error) {
      if (mic.onError) mic.onError(ready.error);
    } else if (ready.text && mic.onText) {
      mic.onText(ready.text, ready.out);
    }
  }
  if (generation === mic.generation && mic.onState && !mic.speaking) {
    mic.onState(mic.listening ? 'listening' : 'off');
  }
}

window.mic = mic;
window.micStart = micStart;
window.micStop = micStop;
window.micSupported = micSupported;
window.micOriginOk = micOriginOk;
