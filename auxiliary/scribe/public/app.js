'use strict';
/**
 * Scribe front end.
 *
 * Two rules run this file.
 *
 * 1. Build once, patch forever. The document is built into the DOM one time and
 *    thereafter only the paragraphs that actually changed are touched, keyed by
 *    paraId. Rebuilding on every edit would kill in-flight animations, which is
 *    fatal here because the animation IS the feature: it is how you see what
 *    just changed.
 *
 * 2. Nothing renders straight from an event. Events land in a queue and are
 *    applied on the next animation frame, so a burst of edits costs one layout
 *    pass rather than one per event.
 */

const $ = (id) => document.getElementById(id);
const paperEl = $('paper');
const trailEl = $('trail');
const conversationEl = $('conversation-turns');
const emptyDocumentTemplate = paperEl.querySelector('.empty-state')?.cloneNode(true);

const app = {
  model: null,
  nodes: new Map(),      // pid -> <p> element
  order: [],             // pid order currently in the DOM
  paused: false,
  rev: 0,
  pendingHighlight: new Map(), // pid -> {start, end}
  queue: [],
  frame: null,
  flushing: false,
  hasDocument: false,
  editStatus: null,
  editStatusTimer: null,
  pendingAssist: null,
  pendingAssistAnnounce: false,
  pendingContinuation: null,
  pendingContinuationAnnounce: false,
  paragraphMergeSupported: false,
  serverBootedAt: null,
  documentGeneration: 0,
  documentPath: null,
  documentToken: null,
  // If a structural refresh removes the exact paragraph being typed into,
  // keep the draft in memory instead of silently throwing it away. Surviving
  // paragraphs are restored into the rebuilt DOM below.
  recoveryDrafts: new Map(),
};

// A paragraph is the smallest deliberately editable unit. The browser keeps a
// local snapshot while the caret is in it; the server still owns the document
// and accepts the final text only if the paragraph hash has not moved.
const directEdits = new Map(); // pid -> { text, hash, documentToken, dirty, saveTimer }
let paragraphMerge = null; // one atomic boundary merge at a time
let boundaryDeleteKeydown = null;
let recoveryDraftSeq = 0;
const DIRECT_SAVE_MS = 650;
const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const DEFAULT_EVENT_QUEUE_LIMIT = 1000;
let pendingMessageAcknowledgement = null;
let pendingUndoAcknowledgement = null;
const responseAbortControllers = new WeakMap();

function configuredPositiveNumber(name, fallback, minimum = 1) {
  const value = Number(window[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function httpTimeoutMs() {
  return configuredPositiveNumber('__SCRIBE_HTTP_TIMEOUT_MS', DEFAULT_HTTP_TIMEOUT_MS);
}

/**
 * Bound every browser request even when a test double, proxy, or browser
 * implementation ignores AbortSignal. The race is the actual deadline;
 * AbortController additionally releases native network resources.
 */
async function fetchWithDeadline(input, init = {}, label = 'Request') {
  const Controller = window.AbortController;
  const controller = Controller ? new Controller() : null;
  const timeoutMs = httpTimeoutMs();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error(`${label} timed out after ${timeoutMs} ms.`);
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  const requestInit = controller ? { ...init, signal: controller.signal } : init;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fetch(input, requestInit)),
      timeout,
    ]);
    if (controller && response && typeof response === 'object') {
      responseAbortControllers.set(response, controller);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function responseJsonWithDeadline(response, label) {
  if (!response || typeof response.json !== 'function') {
    throw new Error(`${label} returned an invalid response.`);
  }
  const timeoutMs = httpTimeoutMs();
  const controller = responseAbortControllers.get(response);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} response timed out after ${timeoutMs} ms.`);
      error.name = 'TimeoutError';
      reject(error);
      // Settle our explicit timeout first so a synchronous AbortError from the
      // body stream cannot obscure the useful deadline message.
      try { if (controller) controller.abort(); } catch (_) {}
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => response.json()),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    responseAbortControllers.delete(response);
  }
}

const queryWatchMs = Number(new URLSearchParams(location.search).get('watchMs'));
const WATCH_QUIET_MS = queryWatchMs >= 100 ? queryWatchMs : 25000;
const WATCH_RECENT_MS = 30000;
let openAssist = null;
const queryPredictMs = Number(new URLSearchParams(location.search).get('predictMs'));
const PREDICT_QUIET_MS = queryPredictMs >= 100 ? queryPredictMs : 60000;
let openContinuation = null;
const prediction = {
  timer: null,
  seq: 0,
  capture: null,
  activeId: null,
  pending: null,
  requesting: false,
  lastInputAt: 0,
};
const sidecarStatusTimers = new Map();
let modelFetchSeq = 0;
let modelAppliedSeq = 0;
// A document/open/edit event creates an authoritative read barrier. An older
// request may still complete after that required read fails; it must neither
// repaint stale bytes nor cancel the reconnect that will satisfy the barrier.
let requiredModelFetchSeq = 0;
const modelFetchVersions = new WeakMap();
let uploadRequestSeq = 0;
// When the browser supports the File System Access API we open documents
// through it and keep the handle, so Save can write the latest version back
// over the exact file the human picked. Without it (Firefox/Safari, or after a
// full reload) the handle is null and Save falls back to a download.
const FS_ACCESS = typeof window !== 'undefined' &&
  typeof window.showOpenFilePicker === 'function';
let originalFileHandle = null;
let originalFileHandlePath = null; // server path the handle is bound to
let assistSnapshotRequestSeq = 0;
let continuationSnapshotRequestSeq = 0;
const watch = {
  enabled: false,
  preference: null,         // null until this browser has chosen or adopted consent
  changes: new Map(),       // pid -> {pid, before, after}
  recentChanges: [],        // saved human edits from the rolling local window
  activeReviews: new Map(), // review id -> Set(pid)
  timer: null,
  finishing: false,
  finishingOwner: null,
  consent: Promise.resolve(),
  targetEnabled: null,
};
const formatting = {
  enabled: false,
  supported: null,
  status: 'off',
  pendingWords: 0,
  pendingParagraphs: 0,
  thresholdWords: 600,
  quietMs: 90000,
  cooldownMs: 1800000,
  active: null,
  runner: null,
  model: null,
  provider: null,
  lastCount: 0,
  lastError: '',
  documentToken: null,
  mutationSeq: 0,
};
let formattingSnapshotRequestSeq = 0;
let formattingAppliedTimer = null;
let formattingToggleOwner = null;
try {
  const storedWatch = localStorage.getItem('scribe-watch');
  if (storedWatch === 'on') {
    watch.preference = true;
    const restored = JSON.parse(sessionStorage.getItem('scribe-watch-recent') || '[]');
    if (Array.isArray(restored)) {
      watch.recentChanges = restored.filter((change) =>
        change && typeof change.pid === 'string' &&
        typeof change.before === 'string' && typeof change.after === 'string' &&
        Number.isFinite(change.at));
    }
  } else {
    if (storedWatch === 'off') watch.preference = false;
    sessionStorage.removeItem('scribe-watch-recent');
  }
} catch (_) {}

// A tiny local Web Audio cue for Watch: no file download, speech service, or
// model call.
// Browsers require audio to be unlocked by a human gesture, which is naturally
// satisfied by typing a message, editing the paper, or arming Watch.
const responseSound = {
  context: null,
  plays: 0,
  last: null,
};

function armResponseSound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    if (!responseSound.context) responseSound.context = new AudioContext();
    if (responseSound.context.state === 'suspended') {
      responseSound.context.resume().catch(() => {});
    }
    return true;
  } catch (_) {
    return false;
  }
}

function playResponseChime(kind) {
  responseSound.plays++;
  responseSound.last = kind;
  if (!armResponseSound()) return false;
  const ctx = responseSound.context;
  if (!ctx || ctx.state !== 'running') return false;

  const now = ctx.currentTime + 0.01;
  const tone = (frequency, delay, volume) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now + delay);
    gain.gain.setValueAtTime(0.0001, now + delay);
    gain.gain.exponentialRampToValueAtTime(volume, now + delay + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.34);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(now + delay);
    oscillator.stop(now + delay + 0.36);
  };
  tone(659.25, 0, 0.022);
  tone(880, 0.085, 0.014);
  return true;
}

// Direct conversation answers are different: they are read aloud. The browser
// owns synthesis and its installed voices, so this remains free and local.
const responseSpeech = {
  speaks: 0,
  last: null,
  lastText: '',
  voice: null,
  speaking: false,
  token: 0,
};

function speechVoice() {
  if (!window.speechSynthesis) return null;
  const voices = speechSynthesis.getVoices() || [];
  const score = (voice) => {
    const name = String(voice.name || '').toLowerCase();
    const lang = String(voice.lang || '').toLowerCase();
    let n = lang.startsWith('en') ? 100 : 0;
    if (lang === 'en-us') n += 20;
    if (/natural|neural/.test(name)) n += 90;
    if (/aria|jenny|samantha|google us english/.test(name)) n += 50;
    if (/microsoft|google/.test(name)) n += 20;
    if (voice.default) n += 5;
    return n;
  };
  return voices.sort((a, b) => score(b) - score(a))[0] || null;
}

function cleanSpeechText(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/```[\w-]*\s*([\s\S]*?)```/g, '$1')
    .replace(/(^|\s)[#>*_`~-]+(?=\s|$)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function speechChunks(text, limit = 280) {
  const sentences = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map((x) => x.segment.trim())
    : text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  for (const sentence of sentences.filter(Boolean)) {
    if (sentence.length <= limit) {
      const last = chunks[chunks.length - 1];
      if (last && last.length + sentence.length + 1 <= limit) chunks[chunks.length - 1] += ' ' + sentence;
      else chunks.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.55) cut = limit;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
  }
  return chunks;
}

function updateSpeechButtons() {
  document.querySelectorAll('[data-speech-source]').forEach((button) => {
    const active = responseSpeech.speaking && responseSpeech.last === button.dataset.speechSource;
    button.classList.toggle('speaking', active);
    button.setAttribute('aria-label', active
      ? (button.dataset.stopLabel || 'Stop reading')
      : (button.dataset.readLabel || 'Read aloud'));
    button.title = active ? 'Stop reading' : 'Read aloud';
  });
}

function stopResponseSpeech() {
  responseSpeech.token++;
  responseSpeech.speaking = false;
  try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (_) {}
  updateSpeechButtons();
}

function speakResponse(value, source) {
  const text = cleanSpeechText(value);
  if (!text) return false;
  responseSpeech.speaks++;
  responseSpeech.last = source;
  responseSpeech.lastText = text;
  responseSpeech.voice = null;
  const chunks = speechChunks(text);
  if (!chunks.length || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;

  stopResponseSpeech();
  responseSpeech.last = source;
  responseSpeech.speaking = true;
  const token = ++responseSpeech.token;
  const voice = speechVoice();
  responseSpeech.voice = voice ? voice.name : 'browser default';
  updateSpeechButtons();

  const next = (index) => {
    if (token !== responseSpeech.token || index >= chunks.length) {
      if (token === responseSpeech.token) {
        responseSpeech.speaking = false;
        updateSpeechButtons();
      }
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    if (voice) utterance.voice = voice;
    utterance.lang = (voice && voice.lang) || 'en-US';
    utterance.rate = 0.98;
    utterance.pitch = 1;
    utterance.volume = 1;
    utterance.onend = () => next(index + 1);
    utterance.onerror = () => {
      if (token === responseSpeech.token) {
        responseSpeech.speaking = false;
        updateSpeechButtons();
      }
    };
    speechSynthesis.speak(utterance);
  };
  setTimeout(() => next(0), 0);
  return true;
}

document.addEventListener('pointerdown', armResponseSound, { capture: true });
document.addEventListener('keydown', armResponseSound, { capture: true });
if (window.speechSynthesis) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener('voiceschanged', speechVoice);
}

// --------------------------------------------------------------------------
// rendering
// --------------------------------------------------------------------------

const STYLE_CLASS = {
  'Title': 's-title',
  'Heading 1': 's-h1', 'Heading 2': 's-h2', 'Heading 3': 's-h3',
  'List Bullet': 's-bullet', 'List Paragraph': 's-bullet',
  'Quote': 's-quote', 'Intense Quote': 's-quote',
};

function runStyle(r) {
  const s = [];
  if (r.b) s.push('font-weight:700');
  if (r.i) s.push('font-style:italic');
  if (r.u) s.push('text-decoration:underline');
  if (r.color) s.push(`color:#${r.color}`);
  if (r.highlight) s.push(`background:${highlightColor(r.highlight)}`);
  if (r.size) s.push(`font-size:${r.size}pt`);
  return s.join(';');
}

function paragraphMergeOwns(pid) {
  return !!(paragraphMerge && (
    pid === paragraphMerge.firstPid || pid === paragraphMerge.secondPid
  ));
}

function setParagraphEditability(el) {
  if (!el) return;
  el.setAttribute(
    'contenteditable',
    app.paused || paragraphMergeOwns(el.dataset.pid)
      ? 'false'
      : 'plaintext-only',
  );
}

function setParagraphMergeControlsLocked(locked) {
  $('undo').disabled = !!locked || !!pendingUndoAcknowledgement;
  $('doc-name').disabled = !!locked;
  $('doc-file').disabled = !!locked;
}

/** Word's named highlight palette. Anything unknown falls back to a soft yellow. */
const HIGHLIGHTS = {
  yellow: '#fff3a3', green: '#a8e6a3', cyan: '#a3e8e8', magenta: '#f5a8e0',
  blue: '#a8c4f5', red: '#f5a8a8', darkYellow: '#d4c14a', darkGreen: '#6aa86a',
  darkCyan: '#6aa8a8', darkBlue: '#6a86c4', darkRed: '#c46a6a', darkMagenta: '#c46ab0',
  lightGray: '#dcdcdc', darkGray: '#a8a8a8', black: '#333', white: 'transparent',
};
const highlightColor = (n) => HIGHLIGHTS[n] || '#fff3a3';

/**
 * Fill a paragraph element from its model, applying a highlight range if one is
 * pending. Runs are emitted as spans; when a highlight range cuts through a run
 * the run is split so the mark lands on exactly the changed characters and not
 * a character more.
 */
function fillPara(el, p, hl) {
  el.className = 'para ' + (STYLE_CLASS[p.style] || 's-normal') + (p.text ? '' : ' empty');
  el.dataset.pid = p.pid;
  el.dataset.hash = p.hash;
  // Text hashes remain the optimistic-edit guard. Formatting has its own
  // optional fingerprint so a style-only model refresh can repaint the runs
  // without pretending the paragraph's words changed.
  el.dataset.formatHash = p.format_hash || p.hash;
  delete el.dataset.editConflict;
  setParagraphEditability(el);
  el.setAttribute('spellcheck', 'true');
  el.setAttribute('aria-label', 'Editable document paragraph');
  el.textContent = '';
  applyParaDecorations(el, p.pid);

  if (!p.runs.length) return;

  let pos = 0;
  p.runs.forEach((r, i) => {
    const text = r.text || '';
    const start = pos, end = pos + text.length;
    pos = end;
    if (!text) return;
    const style = runStyle(r);

    const pieces = hl ? splitRange(text, start, end, hl) : [{ text, marked: false }];
    for (const piece of pieces) {
      const span = document.createElement(piece.marked ? 'mark' : 'span');
      if (piece.marked) {
        span.className = 'changed' +
          (hl && hl.neon ? ' watch-change' : '') +
          (hl && hl.assist ? ' assist-change' : '');
      }
      else span.dataset.run = i;
      if (style) span.setAttribute('style', style);
      span.textContent = piece.text;
      el.appendChild(span);
    }
  });
}

/** Cut a run's text into marked and unmarked pieces against an absolute range. */
function splitRange(text, start, end, hl) {
  const a = Math.max(start, hl.start), b = Math.min(end, hl.end);
  if (a >= b) return [{ text, marked: false }];
  const out = [];
  if (a > start) out.push({ text: text.slice(0, a - start), marked: false });
  out.push({ text: text.slice(a - start, b - start), marked: true });
  if (b < end) out.push({ text: text.slice(b - start), marked: false });
  return out;
}

/**
 * Document-host offsets count Unicode code points (Python string indexes),
 * while DOM ranges and JavaScript strings count UTF-16 code units. Translate
 * at the event boundary so an astral character can never be split between
 * highlighted spans.
 */
function codePointOffsetToUtf16(text, offset) {
  if (typeof text !== 'string' || !Number.isFinite(offset)) return offset;
  const target = Math.max(0, Math.trunc(offset));
  let codePoints = 0;
  let utf16 = 0;
  for (const character of text) {
    if (codePoints >= target) break;
    utf16 += character.length;
    codePoints++;
  }
  return utf16;
}

function resultHighlightRange(result) {
  if (!result || !Number.isFinite(result.start) ||
      !Number.isFinite(result.end)) return null;
  const text = typeof result.after === 'string' ? result.after : null;
  return {
    start: codePointOffsetToUtf16(text, result.start),
    end: codePointOffsetToUtf16(text, result.end),
  };
}

function makePara(p, hl) {
  const el = document.createElement('p');
  fillPara(el, p, hl);
  return el;
}

/**
 * Build the document. Table paragraphs are grouped back into a real grid using
 * the tbl/row/cell coordinates the model carries; without that the sibling
 * drafts' 213 cell paragraphs would draw as stray lines.
 */
function buildAll(model) {
  clearSidecarStatus();
  const frag = document.createDocumentFragment();
  app.nodes.clear();
  app.order = [];

  let i = 0;
  const ps = model.paragraphs;
  while (i < ps.length) {
    const p = ps[i];
    if (!p.table) {
      const el = makePara(p, app.pendingHighlight.get(p.pid));
      frag.appendChild(el);
      app.nodes.set(p.pid, el);
      app.order.push(p.pid);
      i++;
      continue;
    }
    // Collect the whole table, then lay it out.
    const t = p.table.tbl;
    const cells = [];
    while (i < ps.length && ps[i].table && ps[i].table.tbl === t) { cells.push(ps[i]); i++; }
    frag.appendChild(buildTable(cells));
  }

  paperEl.classList.remove('is-empty');
  paperEl.textContent = '';
  paperEl.appendChild(frag);
}

function buildTable(cells) {
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  const table = document.createElement('table');
  table.className = 'doc-table';
  const rows = new Map();
  for (const c of cells) {
    if (!rows.has(c.table.row)) rows.set(c.table.row, new Map());
    const row = rows.get(c.table.row);
    if (!row.has(c.table.cell)) row.set(c.table.cell, []);
    row.get(c.table.cell).push(c);
  }
  for (const rIdx of [...rows.keys()].sort((a, b) => a - b)) {
    const tr = document.createElement('tr');
    const row = rows.get(rIdx);
    for (const cIdx of [...row.keys()].sort((a, b) => a - b)) {
      const td = document.createElement('td');
      for (const p of row.get(cIdx)) {
        const el = makePara(p, app.pendingHighlight.get(p.pid));
        td.appendChild(el);
        app.nodes.set(p.pid, el);
        app.order.push(p.pid);
      }
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function validDocumentModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model) ||
      !Array.isArray(model.paragraphs)) return false;
  if (Object.prototype.hasOwnProperty.call(model, 'document_token') &&
      (typeof model.document_token !== 'string' ||
       !model.document_token.trim())) return false;
  const seen = new Set();
  return model.paragraphs.every((p) => {
    if (!p || typeof p !== 'object' || Array.isArray(p) ||
        typeof p.pid !== 'string' || !p.pid ||
        typeof p.text !== 'string' || typeof p.hash !== 'string' ||
        (Object.prototype.hasOwnProperty.call(p, 'format_hash') &&
         typeof p.format_hash !== 'string') ||
        !Array.isArray(p.runs) || seen.has(p.pid)) return false;
    seen.add(p.pid);
    return p.runs.every((run) =>
      run && typeof run === 'object' && !Array.isArray(run) &&
      typeof run.text === 'string');
  });
}

function capturedDocumentToken(model = app.model) {
  const token = model && model.document_token;
  if (typeof token === 'string' && token.trim()) return token;
  // During an authoritative Open, the ownership event can arrive before the
  // model fetch. Keep its token separately so actions in that narrow window
  // cannot fall back to an unbound legacy request.
  if (model === app.model &&
      typeof app.documentToken === 'string' && app.documentToken.trim()) {
    return app.documentToken;
  }
  return null;
}

function capturedDocumentPath(model = app.model) {
  return model && typeof model.path === 'string' && model.path ||
    app.documentPath ||
    null;
}

function documentOwnershipMismatch(pathValue, tokenValue, model) {
  const nextPath = model && typeof model.path === 'string' ? model.path : null;
  const nextToken = capturedDocumentToken(model);
  const pathMismatch = pathValue && nextPath &&
    String(pathValue) !== String(nextPath);
  const tokenMismatch = tokenValue && nextToken && tokenValue !== nextToken;
  return !!(pathMismatch || tokenMismatch);
}

function documentOwnershipMatches(model) {
  if (!model || typeof model !== 'object') return false;
  const currentPath = capturedDocumentPath(app.model);
  const currentToken = capturedDocumentToken(app.model);
  const nextPath = typeof model.path === 'string' ? model.path : null;
  const nextToken = typeof model.document_token === 'string' &&
    model.document_token.trim()
    ? model.document_token
    : null;
  // A token is the generation identity; requiring it prevents a delayed Open
  // for the same filename from being mistaken for the current ownership.
  return !!(currentPath && currentToken && nextPath && nextToken &&
    String(currentPath) === String(nextPath) && currentToken === nextToken);
}

function stageDirectEditsForRebuild() {
  const staged = [];
  for (const [pid, edit] of directEdits) {
    clearTimeout(edit.saveTimer);
    const el = app.nodes.get(pid);
    if (!el) continue;
    staged.push({
      pid,
      text: edit.text,
      hash: edit.hash,
      documentToken: edit.documentToken,
      documentPath: edit.documentPath,
      dirty: edit.dirty,
      localText: directText(el),
      active: document.activeElement === el,
      caret: document.activeElement === el ? caretOffset(el) : null,
    });
  }
  return staged;
}

function trimRecoveryDrafts() {
  while (app.recoveryDrafts.size > 20) {
    app.recoveryDrafts.delete(app.recoveryDrafts.keys().next().value);
  }
}

function activeDocumentSource() {
  return app.model && typeof app.model.path === 'string' && app.model.path ||
    app.documentPath ||
    'the previous document';
}

function archiveDetachedDraft(draft, sourcePath, reason = 'document opened') {
  if (!draft || typeof draft.pid !== 'string' ||
      typeof draft.localText !== 'string') return null;
  const dirty = !!draft.dirty || draft.localText !== draft.text;
  if (!dirty) return null;
  const key = `detached:${Date.now()}:${++recoveryDraftSeq}:${draft.pid}`;
  app.recoveryDrafts.set(key, {
    pid: draft.pid,
    text: draft.localText,
    hash: draft.hash,
    at: Date.now(),
    detached: true,
    sourcePath: String(sourcePath || 'the previous document'),
    reason,
  });
  trimRecoveryDrafts();
  return key;
}

function archivePendingMessageForDocumentOpen(
  message,
  reason = 'document changed before the message was confirmed',
) {
  if (!message || message.acknowledged || message.recoveryArchived ||
      typeof message.text !== 'string' || !message.text.trim()) return null;
  message.recoveryArchived = true;
  const key = `message:${Date.now()}:${++recoveryDraftSeq}`;
  app.recoveryDrafts.set(key, {
    pid: 'message',
    kind: 'message',
    text: message.text,
    at: Date.now(),
    detached: true,
    sourcePath: String(message.documentPath || 'the previous document'),
    reason,
  });
  trimRecoveryDrafts();
  renderRecoveryDrafts();
  return key;
}

function archiveDirectEditsForDocumentOpen() {
  const sourcePath = activeDocumentSource();
  let archived = 0;
  for (const [pid, edit] of directEdits) {
    const el = app.nodes.get(pid);
    const localText = el ? directText(el) : edit.text;
    if (archiveDetachedDraft({
      pid,
      text: edit.text,
      hash: edit.hash,
      dirty: edit.dirty,
      localText,
    }, sourcePath, 'document opened while typing')) {
      archived++;
    }
  }
  if (archived) renderRecoveryDrafts();
  return archived;
}

function archiveMergeDrafts(merge, reason) {
  if (!merge || merge.recoveryArchived) return 0;
  merge.recoveryArchived = true;
  let archived = 0;
  for (const draft of merge.drafts || []) {
    if (archiveDetachedDraft(
      draft,
      merge.documentPath || activeDocumentSource(),
      reason,
    )) {
      archived++;
    }
  }
  if (archived) renderRecoveryDrafts();
  return archived;
}

function clearDocumentBoundClientState() {
  app.pendingHighlight.clear();
  app.pendingAssist = null;
  app.pendingAssistAnnounce = false;
  openAssist = null;
  clearAssistVisual();
  app.pendingContinuation = null;
  app.pendingContinuationAnnounce = false;
  openContinuation = null;
  clearContinuationVisual();
  renderPredictionPending(null);
  clearSidecarStatus();
  proposalAcceptanceRefresh = null;
  continuationAcceptanceRefresh = null;
  proposalPosting = false;
  proposalPostingOwner = null;
  proposalSnapshotRequestSeq++;
  assistSnapshotRequestSeq++;
  continuationSnapshotRequestSeq++;
  agentSnapshotRequestSeq++;
  agentStopOwner = null;
  renderProposal(null);

  const pendingMessage = messagePostingOwner;
  if (pendingMessage) {
    archivePendingMessageForDocumentOpen(
      pendingMessage,
      'document opened before Scribe confirmed this message',
    );
  }
  if (pendingMessageAcknowledgement === pendingMessage) {
    pendingMessageAcknowledgement = null;
  }
  messagePostingOwner = null;
  messagePosting = false;
  const messageBar = $('bar');
  if (messageBar.dataset.delivery === 'sending') {
    delete messageBar.dataset.delivery;
  }
  messageBar.removeAttribute('aria-busy');
  $('send').disabled = false;

  trailEl.textContent = '';
  conversationEl.textContent = '';
  $('conversation').hidden = true;
  conversationItems.clear();
  trailSeen.clear();

  watch.changes.clear();
  watch.recentChanges = [];
  watch.activeReviews.clear();
  clearTimeout(watch.timer);
  watch.timer = null;
  watch.finishing = false;
  watch.finishingOwner = null;
  formattingSnapshotRequestSeq++;
  formatting.mutationSeq++;
  formattingToggleOwner = null;
  clearTimeout(formattingAppliedTimer);
  formattingAppliedTimer = null;
  formatting.pendingWords = 0;
  formatting.pendingParagraphs = 0;
  formatting.active = null;
  formatting.runner = null;
  formatting.lastCount = 0;
  formatting.lastError = '';
  formatting.documentToken = null;
  formatting.status = formatting.enabled ? 'collecting' : 'off';
  const formatButton = $('format-toggle');
  if (formatButton) formatButton.disabled = false;
  refreshFormattingState();
  clearTimeout(prediction.timer);
  prediction.timer = null;
  prediction.capture = null;
  prediction.activeId = null;
  prediction.requesting = false;
  prediction.lastEvent = null;
  lane.liveEvents++;
  lane.ready = false;
  lane.responseText = '';
  stopResponseSpeech();
  setAgentState('off', '');
  clearLane();
  if (window.micStop && window.mic) {
    // A transcript is document-bound input. Cancelling the mic generation also
    // makes every in-flight transcription ignore a delayed response.
    if (voiceCaptureOwner) retiredVoiceCaptureOwner = voiceCaptureOwner;
    voiceCaptureOwner = null;
    window.micStop();
  }
  try { sessionStorage.removeItem('scribe-watch-recent'); } catch (_) {}
}

function retireClientDocumentOwnership(reason) {
  const merge = paragraphMerge;
  if (merge) {
    archiveMergeDrafts(merge, reason);
    releaseParagraphMerge(merge);
    reportRetiredParagraphMerge(reason);
  }
  archiveDirectEditsForDocumentOpen();
  for (const edit of directEdits.values()) clearTimeout(edit.saveTimer);
  directEdits.clear();
  app.documentGeneration++;
  app.model = null;
  app.documentPath = null;
  app.documentToken = null;
  app.hasDocument = false;
  app.rev = 0;
  clearDocumentBoundClientState();
  setWritingFocus(false);
  renderDocumentLoading();
  renderRecoveryDrafts();
}

function renderDocumentLoading() {
  app.nodes.clear();
  app.order = [];
  paperEl.textContent = '';
  paperEl.classList.add('is-empty');
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  const title = document.createElement('h2');
  title.textContent = 'Loading document\u2026';
  const detail = document.createElement('p');
  detail.textContent = 'Waiting for the authoritative document content.';
  loading.append(title, detail);
  paperEl.appendChild(loading);
  updateRevision();
}

function renderNoActiveDocument() {
  app.model = null;
  app.nodes.clear();
  app.order = [];
  app.hasDocument = false;
  app.documentPath = null;
  app.documentToken = null;
  app.rev = 0;
  originalFileHandle = null;
  originalFileHandlePath = null;
  paperEl.textContent = '';
  paperEl.classList.add('is-empty');
  if (emptyDocumentTemplate) {
    const empty = emptyDocumentTemplate.cloneNode(true);
    paperEl.appendChild(empty);
    const open = empty.querySelector('#empty-open');
    if (open) {
      open.onclick = () => { openDocumentDialog(); };
    }
  }
  $('doc-name').textContent = 'open document';
  $('doc-name').title = 'Open a Word document';
  updateRevision();
}

function renderRecoveryDrafts() {
  const panel = $('draft-recovery');
  const items = $('draft-recovery-items');
  if (!panel || !items) return;
  items.textContent = '';
  for (const [key, draft] of app.recoveryDrafts) {
    const pid = draft.pid || key;
    const item = document.createElement('div');
    item.className = 'draft-recovery-item';
    item.dataset.detached = String(!!draft.detached);

    const label = document.createElement('span');
    label.className = 'draft-recovery-label';
    label.textContent = draft.kind === 'message'
      ? `Unconfirmed message from ${draft.sourcePath}.`
      : (draft.detached
        ? `Unsaved typing from ${draft.sourcePath} (paragraph ${pid}).`
        : `Paragraph ${pid} was removed while you were typing.`);
    if (draft.detached) {
      label.title = draft.kind === 'message'
        ? `Copy-only recovery from ${draft.sourcePath}; it will not be sent automatically.`
        : `Copy-only recovery from ${draft.sourcePath}; it will not be inserted or saved automatically.`;
    }
    item.appendChild(label);

    const text = document.createElement('textarea');
    text.className = 'draft-recovery-text';
    text.readOnly = true;
    text.value = draft.text;
    text.setAttribute('aria-label', `Recovered typing from paragraph ${pid}`);
    item.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'draft-recovery-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ghost tiny';
    copy.textContent = 'copy';
    copy.onclick = async () => {
      let copied = false;
      try {
        await navigator.clipboard.writeText(draft.text);
        copied = true;
      } catch (_) {
        text.focus();
        text.select();
        try { copied = document.execCommand('copy'); } catch (_) {}
      }
      copy.textContent = copied ? 'copied' : 'select text';
    };
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost tiny';
    dismiss.textContent = 'dismiss';
    dismiss.onclick = () => {
      app.recoveryDrafts.delete(key);
      renderRecoveryDrafts();
    };
    actions.append(copy, dismiss);
    item.appendChild(actions);
    items.appendChild(item);
  }
  const hasRecovery = app.recoveryDrafts.size > 0;
  panel.hidden = !hasRecovery;
  const railToggle = $('rail-toggle');
  if (railToggle) {
    railToggle.dataset.recovery = String(hasRecovery);
    railToggle.setAttribute(
      'aria-label',
      hasRecovery
        ? 'Show recovered typing, conversation, and agent activity'
        : 'Show conversation and agent activity',
    );
  }
  // On compact layouts the recovery panel lives inside an off-canvas, inert
  // rail. Open it when a draft first becomes recoverable so the only surviving
  // copy of the human's text is never hidden behind an unrelated "chat" button.
  if (hasRecovery && window.matchMedia('(max-width: 900px)').matches) {
    setRailOpen(true);
  }
}

function restoreDirectEditsAfterRebuild(
  staged,
  model,
  {
    replace = true,
    autoSave = true,
    forceConflict = false,
    conflictReason = '',
  } = {},
) {
  if (replace) directEdits.clear();
  if (!staged.length) {
    if (replace) setWritingFocus(false);
    return { restored: 0, conflicts: 0, orphaned: 0 };
  }

  const paragraphs = new Map(model.paragraphs.map((p) => [p.pid, p]));
  let restored = 0;
  let conflicts = 0;
  let orphaned = 0;
  let focused = null;

  for (const draft of staged) {
    const paragraph = paragraphs.get(draft.pid);
    const el = app.nodes.get(draft.pid);
    if (!paragraph || !el) {
      app.recoveryDrafts.set(draft.pid, {
        pid: draft.pid,
        text: draft.localText,
        hash: draft.hash,
        at: Date.now(),
      });
      trimRecoveryDrafts();
      orphaned++;
      continue;
    }

    app.recoveryDrafts.delete(draft.pid);
    const dirty = draft.dirty || draft.localText !== draft.text;
    if (!dirty && !draft.active) {
      const prior = directEdits.get(draft.pid);
      if (prior) {
        clearTimeout(prior.saveTimer);
        directEdits.delete(draft.pid);
      }
      continue;
    }
    const draftDocumentToken =
      typeof draft.documentToken === 'string' && draft.documentToken.trim()
        ? draft.documentToken
        : null;
    const modelDocumentToken = capturedDocumentToken(model);
    const documentConflict = dirty && draftDocumentToken &&
      modelDocumentToken && draftDocumentToken !== modelDocumentToken;
    const conflict = forceConflict ||
      (dirty && paragraph.hash !== draft.hash) ||
      documentConflict;
    const localText = dirty ? draft.localText : paragraph.text;
    const edit = {
      text: dirty ? draft.text : paragraph.text,
      hash: dirty ? draft.hash : paragraph.hash,
      documentToken: dirty
        ? draft.documentToken
        : capturedDocumentToken(model),
      documentPath: dirty
        ? draft.documentPath
        : capturedDocumentPath(model),
      dirty,
      stagedConflict: conflict,
      conflictReason: conflict
        ? (documentConflict
          ? 'The document changed ownership while you were typing. Your text is preserved and will not be saved automatically.'
          : (conflictReason ||
          'This paragraph changed elsewhere. Your typing is preserved; resolve the conflict before saving.')
        )
        : '',
      suppressAutoSave: !autoSave,
    };
    const prior = directEdits.get(draft.pid);
    if (prior) clearTimeout(prior.saveTimer);
    directEdits.set(draft.pid, edit);
    // Editing is intentionally plain text. Restoring the local string after
    // buildAll prevents a rebuild from replacing it with authoritative runs.
    el.textContent = localText;
    el.classList.add('editing');
    el.classList.toggle('dirty', dirty);
    el.classList.toggle('save-error', conflict);
    el.dataset.hash = paragraph.hash;
    el.dataset.formatHash = paragraph.format_hash || paragraph.hash;
    setParagraphEditability(el);
    if (conflict) {
      el.dataset.editConflict = 'true';
      conflicts++;
    } else {
      delete el.dataset.editConflict;
      if (dirty && autoSave) scheduleDirectSave(el, edit);
    }
    if (draft.active) focused = { el, caret: draft.caret };
    restored++;
  }

  renderRecoveryDrafts();
  setWritingFocus(restored > 0 || directEdits.size > 0);
  if (focused && !app.paused) {
    focused.el.focus({ preventScroll: true });
    restoreCaret(focused.el, focused.caret);
  }
  if (conflicts || orphaned) {
    const detail = conflicts
      ? (conflictReason ||
        'The paragraph changed while you were typing. Your text is preserved, but it was not auto-saved; press Escape to discard it after copying or reviewing it.')
      : 'A paragraph was removed while you were typing. Its draft remains preserved in this page.';
    setEditStatus('typing preserved \u00b7 not saved', {
      error: true,
      title: detail,
    });
  }
  return { restored, conflicts, orphaned };
}

/**
 * Reconcile a new model against what is on screen.
 *
 * Same paragraph ids in the same order is the overwhelmingly common case (an
 * edit changes text, not structure), and it patches only the paragraphs whose
 * content hash moved. Structural change falls back to a rebuild, which is rare
 * and cheap enough at this document size.
 */
function applyModel(model) {
  if (!validDocumentModel(model)) {
    return { rebuilt: false, patched: 0, invalid: true };
  }
  const fetchVersion = model && modelFetchVersions.get(model);
  // Request order alone is insufficient here. A read that began before an
  // edit event can still be serviced after the commit and contain that event's
  // exact revision. Let that response satisfy the barrier only when ownership
  // is unchanged and its revision is at least the revision announced by the
  // event. A genuinely held stale response has an older revision and remains
  // unable to repaint content or cancel recovery.
  const knownOwnership = !!(app.model || app.documentPath || app.documentToken);
  const sameOwnershipAtRequiredRevision = !!fetchVersion &&
    knownOwnership &&
    !documentOwnershipMismatch(
      capturedDocumentPath(app.model),
      capturedDocumentToken(app.model),
      model,
    ) &&
    Number.isSafeInteger(model.rev) &&
    Number.isSafeInteger(app.rev) &&
    model.rev >= app.rev;
  const satisfiesRequiredRefresh = requiredModelFetchSeq === 0 ||
    !!(fetchVersion &&
       (fetchVersion >= requiredModelFetchSeq ||
        sameOwnershipAtRequiredRevision));
  if (fetchVersion &&
      (fetchVersion < modelAppliedSeq ||
       (!satisfiesRequiredRefresh &&
        fetchVersion < requiredModelFetchSeq))) {
    return { rebuilt: false, patched: 0, stale: true };
  }
  if (fetchVersion) modelAppliedSeq = Math.max(modelAppliedSeq, fetchVersion);
  let ownershipChanged = false;
  if ((app.model || app.documentPath || app.documentToken) &&
      documentOwnershipMismatch(
    capturedDocumentPath(app.model),
    capturedDocumentToken(app.model),
    model,
  )) {
    retireClientDocumentOwnership(
      'document ownership changed while local typing was pending',
    );
    ownershipChanged = true;
  }
  const ids = model.paragraphs.map((p) => p.pid);
  const same = ids.length === app.order.length && ids.every((id, i) => id === app.order[i]);

  if (!app.model || !same) {
    const staged = stageDirectEditsForRebuild();
    buildAll(model);
    app.model = model;
    app.documentToken = capturedDocumentToken(model);
    if (model.path) setDocName(model.path);
    const recovery = restoreDirectEditsAfterRebuild(staged, model);
    if (openAssist) placeAssist(openAssist);
    if (openContinuation) placeContinuation(openContinuation);
    if (openProp) {
      markAnchor(openProp.anchor_pid);
      if (!proposalPosting) setProposalBusy(false);
    }
    if (satisfiesRequiredRefresh) {
      requiredModelFetchSeq = 0;
      markAuthoritativeRefreshSucceeded();
    }
    if (ownershipChanged) scheduleAuthoritativeReconnect();
    return { rebuilt: true, patched: ids.length, ...recovery };
  }

  let patched = 0;
  for (const p of model.paragraphs) {
    const el = app.nodes.get(p.pid);
    if (!el) continue;
    // An event can arrive while a human is midway through a sentence. Leave
    // those unsaved keystrokes alone; the hash guard will resolve the race at
    // save time and reload the authoritative paragraph if it has gone stale.
    if (directEdits.has(p.pid)) continue;
    const hl = app.pendingHighlight.get(p.pid);
    const formatHash = p.format_hash || p.hash;
    if (el.dataset.hash === p.hash &&
        el.dataset.formatHash === formatHash && !hl) continue;
    fillPara(el, p, hl);
    patched++;
  }
  app.model = model;
  app.documentToken = capturedDocumentToken(model);
  if (model.path) setDocName(model.path);
  if (openAssist) placeAssist(openAssist);
  if (openContinuation) placeContinuation(openContinuation);
  if (openProp) {
    markAnchor(openProp.anchor_pid);
    if (!proposalPosting) setProposalBusy(false);
  }
  if (satisfiesRequiredRefresh) {
    requiredModelFetchSeq = 0;
    markAuthoritativeRefreshSucceeded();
  }
  if (ownershipChanged) scheduleAuthoritativeReconnect();
  return { rebuilt: false, patched };
}

// --------------------------------------------------------------------------
// the glow
// --------------------------------------------------------------------------

function markChanged(pid, range) {
  if (range && typeof range.start === 'number') app.pendingHighlight.set(pid, range);
  const el = app.nodes.get(pid);
  if (!el) return;
  // Re-arm the animation by forcing a reflow, otherwise a second edit to the
  // same paragraph does not replay it.
  el.classList.remove('touched');
  void el.offsetWidth;
  el.classList.add('touched');
  scrollIntoViewIfNeeded(el);
  // Let the pulse finish, then settle into the quiet persistent tint.
  setTimeout(() => {
    el.querySelectorAll('mark.changed').forEach((m) => m.classList.add('settled'));
  }, 1500);
}

function scrollIntoViewIfNeeded(el) {
  const wrap = $('paper-wrap');
  const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  if (r.top < w.top + 60 || r.bottom > w.bottom - 160) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// --------------------------------------------------------------------------
// event queue, flushed on a frame
// --------------------------------------------------------------------------

function trailIsNewEnough(entry, pending) {
  const at = Date.parse(entry && entry.at || '');
  return !Number.isFinite(at) || at >= pending.startedAt - 1000;
}

function observeLiveAcknowledgement(type, data) {
  if (type !== 'trail' || !data || typeof data !== 'object') return;
  if (pendingMessageAcknowledgement &&
      data.op === 'said' && data.who === 'human' &&
      String(data.summary || '').trim() === pendingMessageAcknowledgement.text &&
      trailIsNewEnough(data, pendingMessageAcknowledgement)) {
    pendingMessageAcknowledgement.acknowledged = true;
  }
  if (pendingUndoAcknowledgement && data.op === 'undo' &&
      trailIsNewEnough(data, pendingUndoAcknowledgement)) {
    pendingUndoAcknowledgement.acknowledged = true;
  }
}

function observeProposalVersion(type, data) {
  if (type === 'proposal' && validProposal(data)) {
    proposalLiveVersion++;
  } else if (type === 'hello' && data &&
             (validProposalSnapshot(data.proposals) ||
              (Object.prototype.hasOwnProperty.call(data, 'proposal') &&
               (data.proposal === null || validProposal(data.proposal))))) {
    proposalLiveVersion++;
  }
}

function invalidateSidecarSnapshotsFromLiveEvent(type, data) {
  if (type === 'assist' ||
      (type === 'hello' &&
       Object.prototype.hasOwnProperty.call(data || {}, 'assist'))) {
    assistSnapshotRequestSeq++;
  }
  if (type === 'predict' ||
      (type === 'hello' &&
       Object.prototype.hasOwnProperty.call(data || {}, 'continuation'))) {
    continuationSnapshotRequestSeq++;
  }
  if (type === 'format' ||
      (type === 'hello' &&
       Object.prototype.hasOwnProperty.call(data || {}, 'formatting'))) {
    formattingSnapshotRequestSeq++;
  }
}

function eventQueueLimit() {
  return Math.max(2, Math.floor(configuredPositiveNumber(
    '__SCRIBE_MAX_EVENT_QUEUE', DEFAULT_EVENT_QUEUE_LIMIT, 2)));
}

function enqueue(type, data) {
  observeLiveAcknowledgement(type, data);
  observeProposalVersion(type, data);
  invalidateSidecarSnapshotsFromLiveEvent(type, data);
  if (type === 'opened' && !documentOwnershipMatches(data)) {
    invalidateParagraphMergeForDocumentOpen();
  }
  const limit = eventQueueLimit();
  if (app.queue.length >= limit) {
    // A fresh document model is the only safe recovery after dropping an
    // arbitrary prefix of live events. Keep at most one latest event beside
    // that resync marker; never allow a stalled fetch to grow memory forever.
    app.queue.length = 0;
    app.pendingHighlight.clear();
    app.queue.push({
      type: 'document',
      data: { rev: app.rev, reason: 'client-queue-overflow' },
    });
    if (type !== 'document') app.queue.push({ type, data });
  } else {
    app.queue.push({ type, data });
  }
  if (app.frame || app.flushing) return;
  app.frame = requestAnimationFrame(flush);
}

async function flush() {
  app.frame = null;
  if (app.flushing) return;
  app.flushing = true;
  try {
    while (app.queue.length) await flushBatch();
  } catch (error) {
    // Do not repeatedly replay a poison batch or retain events accumulated
    // behind it. The next valid live document event will resynchronize state.
    app.queue.length = 0;
    app.pendingHighlight.clear();
    console.error('Could not apply live Scribe events:', error);
    setEditStatus('live update failed', {
      error: true,
      title: error && error.message || String(error),
      clearAfter: 6000,
    });
  } finally {
    app.flushing = false;
    if (app.queue.length && !app.frame) app.frame = requestAnimationFrame(flush);
  }
}

async function flushBatch() {
  const batch = app.queue;
  app.queue = [];
  let needsModel = false;
  let refreshedModel = null;
  let helloDocumentOwnership = null;
  let helloModelMismatch = false;

  for (const { type, data } of batch) {
    if (type === 'edit') {
      needsModel = true;
      const pid = data.pid || (data.result && data.result.pid);
      const range = resultHighlightRange(data.result);
      if (pid && range) {
        app.pendingHighlight.set(pid, {
          ...range,
          neon: data.who === 'human' && watch.enabled,
        });
      }
      app.rev = data.rev;
      // No addTrail here. The server emits a `trail` event for the same edit,
      // and rendering both produced two identical cards per edit.
    } else if (type === 'document' || type === 'opened') {
      needsModel = true;
      app.pendingHighlight.clear();
      const repeatedOpen = type === 'opened' &&
        documentOwnershipMatches(data);
      if (!repeatedOpen) {
        openAssist = null;
        clearAssistVisual();
        openContinuation = null;
        clearContinuationVisual();
        renderPredictionPending(null);
      }
      if (type === 'opened' && !repeatedOpen) {
        // A deliberate document switch is a different ownership boundary, not
        // an in-document structural refresh. Never carry a draft into another
        // file merely because a copied document happens to reuse paragraph ids.
        retireClientDocumentOwnership(
          'the server opened a different document',
        );
      }
      if (type === 'opened' &&
          typeof data.document_token === 'string' &&
          data.document_token.trim()) {
        app.documentToken = data.document_token;
      }
      if (data.rev != null) app.rev = data.rev;
      if (data.path) setDocName(data.path);
    } else if (type === 'voice') {
      window.__voiceEvents = window.__voiceEvents || [];
      window.__voiceEvents.push(data);
      if (data.kind === 'heard') window.__heard = data.text;
    } else if (type === 'proposal') {
      if (validProposal(data)) renderProposal(data);
    } else if (type === 'assist') {
      renderAssist(data, true);
    } else if (type === 'predict') {
      onPredictionEvent(data);
    } else if (type === 'watch') {
      onWatchEvent(data);
    } else if (type === 'format') {
      onFormattingEvent(data);
      if (data.kind === 'applied' ||
          (data.kind === 'complete' && Number(data.count || 0) > 0)) {
        needsModel = true;
        if (Number.isFinite(data.rev)) app.rev = data.rev;
      }
    } else if (type === 'models') {
      lane.liveEvents++;
      applyModelPool(data);
    } else if (type === 'agent') {
      onAgent(data);
    } else if (type === 'trail') {
      addTrail(data);
    } else if (type === 'paused') {
      setPaused(data.paused);
    } else if (type === 'health') {
      setHealth(data);
    } else if (type === 'hello') {
      // A same-path server restart rotates document ownership even though the
      // filename and paragraph ids can remain identical. Retire the old
      // browser state before applying this hello's authoritative trail/cards;
      // otherwise applyModel() would discover the token change later and clear
      // the brand-new snapshot we just received.
      const helloOwnership = data.health && {
        path: data.health.docPath,
        document_token: data.health.document_token,
      };
      if (helloOwnership && helloOwnership.path) {
        helloDocumentOwnership = helloOwnership;
      }
      const authoritativeNoDocument = data.health &&
        Object.prototype.hasOwnProperty.call(data.health, 'docPath') &&
        data.health.docPath === null;
      if (authoritativeNoDocument && (app.model || app.hasDocument)) {
        retireClientDocumentOwnership(
          'reconnect found no active document on the server',
        );
        renderNoActiveDocument();
      }
      if (app.model && helloOwnership && documentOwnershipMismatch(
        capturedDocumentPath(app.model),
        capturedDocumentToken(app.model),
        helloOwnership,
      )) {
        retireClientDocumentOwnership(
          'reconnect found a different document ownership generation',
        );
      }
      if (helloOwnership &&
          typeof helloOwnership.document_token === 'string' &&
          helloOwnership.document_token.trim()) {
        app.documentToken = helloOwnership.document_token;
      }
      if (Object.prototype.hasOwnProperty.call(data, 'formatting')) {
        if (data.formatting) applyFormattingSnapshot(data.formatting);
      } else if (formatting.supported === null) {
        // Older hello frames did not carry this optional snapshot. Probe once;
        // a 404 quietly hides the new control and leaves all existing behavior
        // untouched.
        hydrateFormattingState().catch((error) => {
          if (formatting.supported !== false) {
            formatting.lastError = error && error.message || String(error);
            refreshFormattingState();
          }
        });
      }
      setHealth(data.health);
      if (data.health && data.health.docPath) {
        const currentPath = capturedDocumentPath(app.model);
        if (app.model && currentPath &&
            String(currentPath) !== String(data.health.docPath)) {
          retireClientDocumentOwnership(
            'reconnect found a different active document',
          );
        }
        setDocName(data.health.docPath);
      }
      // A live trail event can race the hello snapshot. Always merge the
      // snapshot; timestamped keys make this deterministic and duplicate-free.
      (data.trail || []).forEach(addTrail);
      if (Object.prototype.hasOwnProperty.call(data, 'assist')) {
        if (data.assist === null) {
          renderAssist(null);
        } else {
          app.pendingAssist = data.assist;
        }
      }
      if (Object.prototype.hasOwnProperty.call(data, 'continuation')) {
        const pendingAcceptance = continuationAcceptanceRefresh;
        if (pendingAcceptance && !pendingAcceptance.reconciled &&
            (pendingAcceptance.phase === 'checking' ||
             pendingAcceptance.phase === 'unknown')) {
          // The accept may have committed while both its HTTP reply and terminal
          // SSE were lost. Keep the exact card visible until the document read
          // below paints authoritative prose.
          pendingAcceptance.snapshotObserved = true;
          pendingAcceptance.snapshot = data.continuation;
          pendingAcceptance.phase = 'checking';
          reflectContinuationAcceptance(
            document.querySelector('.continuation-note'),
            'checking',
          );
        } else if (pendingAcceptance && !pendingAcceptance.reconciled) {
          // An ordinary reconnect can happen while the request is still in
          // flight. Its point-in-time snapshot must not overrule the later HTTP
          // result or make the suggestion flash away.
        } else if (data.continuation === null) {
          renderContinuation(null);
        } else {
          app.pendingContinuation = data.continuation;
        }
      }
      if (data.models) applyModelPool(data.models);
      syncAgentSnapshot().catch(() => {});
      if (validProposalSnapshot(data.proposals)) {
        const pendingProposal = proposalAcceptanceRefresh;
        if (pendingProposal && pendingProposal.pending &&
            !pendingProposal.reconciled) {
          pendingProposal.snapshotObserved = true;
          pendingProposal.snapshot = data.proposals;
          pendingProposal.snapshotLiveVersion = proposalLiveVersion;
          showProposalAcceptanceRefreshing(
            pendingProposal.proposal,
            pendingProposal.option,
            'checking whether the choice was accepted\u2026',
          );
        } else {
          renderProposalSnapshot(data.proposals);
        }
      } else if (Object.prototype.hasOwnProperty.call(data, 'proposal') &&
                 (data.proposal === null || validProposal(data.proposal))) {
        renderProposal(data.proposal);
      }
      if (data.health && data.health.docPath) needsModel = true;
    }
  }

  updateRevision();

  if (needsModel) {
    const model = await fetchModel({ required: true });
    if (model) {
      if (helloDocumentOwnership && documentOwnershipMismatch(
        helloDocumentOwnership.path,
        helloDocumentOwnership.document_token,
        model,
      )) {
        // The hello described ownership B, but the model response belongs to a
        // later ownership C. Clear every B snapshot before painting C, then
        // reconnect once to obtain C's trail and sidecars.
        retireClientDocumentOwnership(
          'the active document changed during reconnect refresh',
        );
        helloModelMismatch = true;
      }
      const t0 = performance.now();
      const res = applyModel(model);
      if (!res.invalid && !res.stale) refreshedModel = model;
      if (!res.invalid && !res.stale && model.path) setDocName(model.path);
      window.__lastRender = { ...res, ms: performance.now() - t0 };
      for (const pid of app.pendingHighlight.keys()) markChanged(pid, null);
      // Highlights are consumed by the render they were queued for.
      app.pendingHighlight.clear();
    } else {
      scheduleAuthoritativeReconnect({ backoff: true });
    }
  }
  const pendingAcceptance = continuationAcceptanceRefresh;
  if (pendingAcceptance && pendingAcceptance.snapshotObserved &&
      !pendingAcceptance.reconciled) {
    const settled = settleContinuationAcceptanceSnapshot(
      pendingAcceptance,
      pendingAcceptance.snapshot,
      refreshedModel,
      'The connection closed before Scribe confirmed the insert.',
    );
    if (!settled && continuationAcceptanceRefresh === pendingAcceptance) {
      pendingAcceptance.phase = 'unknown';
      reflectContinuationAcceptance(
        document.querySelector(
          `.continuation-note[data-continuation="${CSS.escape(pendingAcceptance.id)}"]`,
        ),
        'unknown',
      );
    }
  }
  const pendingProposal = proposalAcceptanceRefresh;
  if (pendingProposal && pendingProposal.pending &&
      pendingProposal.snapshotObserved && !pendingProposal.reconciled) {
    const settled = settleProposalAcceptanceSnapshot(
      pendingProposal,
      pendingProposal.snapshot,
      refreshedModel,
      'The connection closed before Scribe confirmed the choice.',
    );
    if (!settled && proposalAcceptanceRefresh === pendingProposal) {
      showProposalAcceptanceRefreshing(
        pendingProposal.proposal,
        pendingProposal.option,
        'choice status unknown \u00b7 waiting to reconnect',
      );
    }
  }
  if (app.pendingAssist && app.model) {
    const note = app.pendingAssist;
    const announce = app.pendingAssistAnnounce;
    app.pendingAssist = null;
    app.pendingAssistAnnounce = false;
    renderAssist(note, announce);
  }
  if (app.pendingContinuation && app.model) {
    const continuation = app.pendingContinuation;
    const announce = app.pendingContinuationAnnounce;
    app.pendingContinuation = null;
    app.pendingContinuationAnnounce = false;
    renderContinuation(continuation, announce);
  }
  if (prediction.pending && app.model) {
    renderPredictionPending(prediction.pending);
  }
  if (openProp && app.model) {
    markAnchor(openProp.anchor_pid);
    if (!proposalPosting) setProposalBusy(false);
  }
  if (helloModelMismatch) scheduleAuthoritativeReconnect();
}

async function fetchModel({ required = false } = {}) {
  const requestSeq = ++modelFetchSeq;
  if (required) {
    requiredModelFetchSeq = Math.max(requiredModelFetchSeq, requestSeq);
  }
  try {
    const r = await fetchWithDeadline('/api/doc', {}, 'Document refresh');
    if (!r.ok) return null;
    const model = await responseJsonWithDeadline(r, 'Document refresh');
    if (!validDocumentModel(model)) return null;
    modelFetchVersions.set(model, requestSeq);
    return model;
  } catch (_) { return null; }
}

async function fetchPredictionSnapshot() {
  try {
    const response = await fetchWithDeadline(
      '/api/predict',
      {},
      'Continuation snapshot',
    );
    if (!response.ok) return null;
    const snapshot = await responseJsonWithDeadline(
      response,
      'Continuation snapshot',
    );
    if (!Object.prototype.hasOwnProperty.call(snapshot, 'continuation') ||
        (snapshot.continuation !== null &&
         !validSidecarPayload(snapshot.continuation))) {
      return null;
    }
    return snapshot;
  } catch (_) {
    return null;
  }
}

async function syncContinuationSnapshot() {
  const requestSeq = ++continuationSnapshotRequestSeq;
  const documentGeneration = app.documentGeneration;
  const documentToken = capturedDocumentToken(app.model);
  const snapshot = await fetchPredictionSnapshot();
  const currentDocumentToken = capturedDocumentToken(app.model);
  if (!snapshot ||
      requestSeq !== continuationSnapshotRequestSeq ||
      documentGeneration !== app.documentGeneration ||
      (documentToken && snapshot.document_token &&
       documentToken !== snapshot.document_token) ||
      (!currentDocumentToken && snapshot.document_token) ||
      (currentDocumentToken && snapshot.document_token &&
       currentDocumentToken !== snapshot.document_token)) {
    return false;
  }
  renderContinuation(snapshot.continuation);
  if (snapshot.active) {
    prediction.activeId = snapshot.active.id;
    renderPredictionPending(snapshot.active);
  }
  return true;
}

/**
 * Apply one fetched model without allowing an older response to masquerade as
 * the current document. When applyModel rejects it as stale, the already
 * applied app.model is the only authoritative candidate.
 */
function reconcileFetchedModel(model) {
  if (!model) return { model: null, render: null };
  const render = applyModel(model);
  if (render.invalid) return { model: null, render };
  const current = render.stale ? app.model : model;
  if (current && Number.isSafeInteger(current.rev) && current.rev >= 0) {
    app.rev = current.rev;
  }
  return { model: current || null, render };
}

// --------------------------------------------------------------------------
// the agent lane: what it is about to do, doing, and just did
// --------------------------------------------------------------------------

const laneEl = $('lane');

const lane = {
  calls: new Map(),   // tool_use_id -> {el, name, parent, state}
  order: [],
  state: 'off',
  model: 'sonnet',
  cost: 0,
  ttft: null,
  ready: false,
  responseText: '',
  liveEvents: 0,
};
let agentSnapshotRequestSeq = 0;
let agentStopOwner = null;

const MODEL_META = {
  sonnet: { provider: 'claude', title: 'Sonnet · Claude CLI · everyday' },
  opus: { provider: 'claude', title: 'Opus · Claude CLI · deeper' },
  terra: { provider: 'codex', title: 'Terra · Codex CLI · everyday' },
  sol: { provider: 'codex', title: 'Sol · Codex CLI · deeper' },
};
const modelPool = {
  enabled: new Set(Object.keys(MODEL_META)),
  selected: 'sonnet',
  automatic: { watch: 'sonnet', continue: 'sonnet', format: null },
  mutationSeq: 0,
  pending: new Map(),
};

/**
 * Pull whatever is readable out of a half-written JSON argument blob.
 *
 * The tool arguments stream in as `input_json_delta`, so for most of the call's
 * life the JSON is truncated and unparseable. Parsing what exists anyway is what
 * lets the UI show the edit forming before it happens, which is the entire
 * point of announcing calls early.
 */
function partialFields(partial) {
  if (!partial) return {};
  try { return JSON.parse(partial); } catch (_) { /* expected, keep scanning */ }
  const out = {};
  const re = /"(\w+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"?|(\d+|true|false))/g;
  let m;
  while ((m = re.exec(partial))) {
    const v = m[2] !== undefined ? m[2] : m[3];
    try { out[m[1]] = m[2] !== undefined ? JSON.parse(`"${m[2]}"`) : v; }
    catch (_) { out[m[1]] = v; }
  }
  return out;
}

const clip = (s, n) => {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** Render a tool's arguments as something a human can read at a glance. */
function describeArgs(name, a) {
  const q = (s, n = 46) => `<em>${esc(clip(s, n))}</em>`;
  const short = (name || '').replace(/^mcp__\w+__/, '');
  if (short === 'doc_replace') {
    if (a.find === undefined) return '';
    return `${q(a.find)}<span class="arrow">→</span>${a.replace !== undefined ? q(a.replace) : '…'}`;
  }
  if (short === 'doc_find') return a.query !== undefined ? `<span class="k">find</span> ${q(a.query)}` : '';
  if (short === 'doc_insert') return a.text !== undefined ? `<span class="k">new ¶</span> ${q(a.text)}` : '';
  if (short === 'doc_delete') return a.pid ? `<span class="k">delete</span> ${esc(a.pid)}` : '';
  if (short === 'doc_format') return a.find !== undefined ? `<span class="k">style</span> ${q(a.find)}` : '';
  if (short === 'doc_read') {
    if (a.from === undefined && a.to === undefined) return '<span class="k">whole document</span>';
    return `<span class="k">¶</span> ${a.from ?? 0}–${a.to ?? 'end'}`;
  }
  if (short === 'Agent' || short === 'Task') {
    return `<span class="k">${esc(a.subagent_type || 'subagent')}</span> ${a.description ? q(a.description) : ''}`;
  }
  if (short === 'ToolSearch') return `<span class="k">loading tools</span>`;
  const keys = Object.keys(a);
  if (!keys.length) return '';
  return keys.slice(0, 2).map((k) => `<span class="k">${esc(k)}</span> ${q(a[k], 28)}`).join(' ');
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const shortName = (n) => String(n || '').replace(/^mcp__\w+__/, '');

function callEl(id) {
  const rec = lane.calls.get(id);
  return rec ? rec.el : null;
}

/** Where does this call belong: the main lane, or nested under its parent? */
function containerFor(parent) {
  if (!parent) return laneEl;
  const p = lane.calls.get(parent);
  if (!p) return laneEl;
  let sub = p.el.querySelector('.sub');
  if (!sub) {
    sub = document.createElement('div');
    sub.className = 'sub';
    const head = document.createElement('div');
    head.className = 'subhead';
    head.textContent = 'subagent';
    sub.appendChild(head);
    p.el.appendChild(sub);
  }
  return sub;
}

function upsertCall(id, { name, parent, state, args, out, isError }) {
  let rec = lane.calls.get(id);
  if (!rec) {
    const el = document.createElement('div');
    el.className = 'call' + (/^(Agent|Task)$/.test(shortName(name)) ? ' agent-call' : '');
    el.dataset.id = id;
    el.innerHTML = `<div class="name"><span class="t"></span><span class="tick"></span></div><div class="args"></div>`;
    rec = { el, name, parent, state: 'pending', args: {}, startedAt: Date.now() };
    lane.calls.set(id, rec);
    lane.order.push(id);
    containerFor(parent).appendChild(el);
    // Follow the newest activity, but only in the main lane so a subagent
    // cannot yank the view around while you are reading something else.
    if (!parent) laneEl.scrollTop = laneEl.scrollHeight;
  }
  if (name) { rec.name = name; rec.el.querySelector('.t').textContent = shortName(name); }
  if (args) rec.args = { ...rec.args, ...args };
  if (state) { rec.state = state; rec.el.dataset.state = state; }
  else if (!rec.el.dataset.state) rec.el.dataset.state = 'pending';

  const a = rec.el.querySelector('.args');
  const desc = describeArgs(rec.name, rec.args);
  if (desc !== rec.lastDesc) { a.innerHTML = desc; rec.lastDesc = desc; }

  if (state === 'done' || state === 'error') {
    rec.el.querySelector('.tick').textContent = `${((Date.now() - rec.startedAt) / 1000).toFixed(1)}s`;
    if (out !== undefined) {
      let o = rec.el.querySelector('.out');
      if (!o) { o = document.createElement('div'); o.className = 'out'; rec.el.appendChild(o); }
      o.textContent = clip(String(out).replace(/\s+/g, ' ').trim(), isError ? 200 : 110);
    }
  }
  // Work is deliberately a small live viewport. Keep it pinned to the newest
  // call as arguments, nested calls, and results populate. When earlier work
  // clips above it, fade that edge instead of leaving severed glyphs behind.
  requestAnimationFrame(() => {
    laneEl.scrollTop = laneEl.scrollHeight;
    laneEl.dataset.overflow = String(laneEl.scrollHeight > laneEl.clientHeight + 1);
  });
  return rec;
}

function setAgentState(s, hint) {
  lane.state = s;
  const el = $('agent-state');
  el.dataset.state = s;
  el.textContent = s;
  $('rail-toggle').dataset.live = String(['starting', 'thinking', 'working'].includes(s));
  const stop = $('agent-btn');
  const stoppable = !['off', 'error'].includes(s);
  stop.hidden = !stoppable;
  stop.disabled = !stoppable;
  stop.textContent = 'stop';
  $('lane-hint').textContent = hint || '';
}

function setModel(m, busy) {
  const b = $('model-btn');
  if (m) {
    b.value = m;
    b.dataset.model = m;
    b.dataset.provider = (MODEL_META[m] || {}).provider || '';
    b.title = (MODEL_META[m] || {}).title || m;
    lane.model = m;
    modelPool.selected = m;
  }
  b.disabled = !!busy;
  b.dataset.busy = busy ? 'true' : 'false';
  renderModelPool();
}

function modelLabel(model) {
  return model ? model[0].toUpperCase() + model.slice(1) : '';
}

function renderModelPool() {
  const enabled = modelPool.enabled;
  $('model-pool-btn').textContent = `auto ${enabled.size}`;
  $('model-pool-btn').setAttribute(
    'aria-label', `${enabled.size} models available to automatic work`);
  for (const option of $('model-btn').querySelectorAll('option')) {
    option.disabled = !enabled.has(option.value) && option.value !== modelPool.selected;
  }
  for (const button of document.querySelectorAll('.model-pool-toggle')) {
    const selected = button.dataset.model === modelPool.selected;
    const on = enabled.has(button.dataset.model);
    const pending = modelPool.pending.has(button.dataset.model);
    button.setAttribute('aria-pressed', String(on));
    button.dataset.selected = String(selected);
    button.disabled = selected || pending;
    button.title = selected
      ? 'Selected for editing. Choose another model before excluding it.'
      : `${on ? 'Exclude' : 'Include'} ${modelLabel(button.dataset.model)} from future automatic work`;
  }
  const routes = [
    `next Watch: ${modelLabel(modelPool.automatic.watch)}`,
    `next Continue: ${modelLabel(modelPool.automatic.continue)}`,
  ];
  if (modelPool.automatic.format) {
    routes.push(`next Format: ${modelLabel(modelPool.automatic.format)}`);
  }
  $('model-pool-route').textContent = routes.join('  ·  ');
}

function applyModelPool(pool) {
  if (!pool) return;
  const enabled = pool.enabled || pool.enabledModels;
  if (Array.isArray(enabled)) {
    modelPool.enabled = new Set(enabled.filter((model) => MODEL_META[model]));
  }
  if (pool.selected && MODEL_META[pool.selected]) modelPool.selected = pool.selected;
  const automatic = pool.automatic || pool.automaticModels;
  if (automatic) modelPool.automatic = { ...modelPool.automatic, ...automatic };
  renderModelPool();
}

function setModelPoolOpen(open) {
  const pool = $('model-pool');
  if (open) {
    const trigger = $('model-pool-btn').getBoundingClientRect();
    const width = 244;
    const edge = 8;
    pool.style.left = `${Math.max(edge, Math.min(
      trigger.right - width, window.innerWidth - width - edge))}px`;
    pool.style.top = `${trigger.bottom + 7}px`;
  }
  pool.hidden = !open;
  $('model-pool-btn').setAttribute('aria-expanded', String(!!open));
}

function setAgentMeta() {
  const bits = [];
  if (lane.ttft != null) bits.push(`${(lane.ttft / 1000).toFixed(1)}s to first word`);
  if (lane.cost) bits.push(`$${lane.cost.toFixed(4)}`);
  $('agent-meta').textContent = bits.join('  ·  ');
}

/** Retire the finished turn's calls so the lane shows the CURRENT turn. */
function clearLane() {
  laneEl.textContent = '';
  laneEl.dataset.overflow = 'false';
  lane.calls.clear();
  lane.order = [];
}

function onAgent(e) {
  // Bootstrap state is fetched once below. Any event received after that
  // request began is newer and must win over its eventual response.
  lane.liveEvents++;
  switch (e.kind) {
    case 'model':
      setModel(e.model, false);
      break;
    case 'agent-start':
      lane.ready = false;
      if (e.model) setModel(e.model, false);
      // Deliberately not "ready". The session does not exist until the first
      // message is sent, and claiming otherwise would be a lie the UI tells.
      setAgentState('starting', 'waiting for your first message');
      break;
    case 'agent-exit':
      lane.ready = false;
      stopResponseSpeech();
      setAgentState('off', '');
      clearLane();
      break;
    case 'agent-error':
      stopResponseSpeech();
      setAgentState('error', e.error || '');
      break;
    case 'session':
      lane.ready = true;
      setAgentState('ready', '');
      break;
    case 'status':
      if (e.status === 'requesting') setAgentState('thinking', '');
      break;
    case 'turn-start':
      stopResponseSpeech();
      // A live turn is stronger evidence than any delayed bootstrap snapshot:
      // the reusable process necessarily has an active session at this point.
      lane.ready = true;
      lane.responseText = '';
      clearLane();
      if (e.ttftMs != null) { lane.ttft = e.ttftMs; setAgentMeta(); }
      setAgentState('working', '');
      break;
    case 'thinking':
      $('think').hidden = false;
      $('think-n').textContent = 'thinking';
      break;
    case 'thinking-start':
      $('think').hidden = false;
      $('think-n').textContent = 'thinking';
      break;
    case 'tool-pending':
      $('think').hidden = true;
      upsertCall(e.id, { name: e.name, parent: e.parent, state: 'pending' });
      break;
    case 'tool-args':
      upsertCall(e.id, { args: partialFields(e.partial) });
      break;
    case 'tool-call':
      upsertCall(e.id, { name: e.name, parent: e.parent, state: 'running', args: e.input || {} });
      break;
    case 'tool-result':
      upsertCall(e.id, { parent: e.parent, state: e.isError ? 'error' : 'done',
                         out: e.text, isError: e.isError });
      break;
    case 'message':
      if (e.text && !e.parent) lane.responseText = e.text;
      break;
    case 'turn-error':
      // A turn can fail while its reusable CLI process remains healthy.
      // Keep the live Stop control and show the reason until turn-end.
      $('lane-hint').textContent = e.error || 'turn failed';
      break;
    case 'turn-end':
      $('think').hidden = true;
      if (typeof e.totalCostUsd === 'number') lane.cost = e.totalCostUsd;
      setAgentMeta();
      setAgentState(lane.ready ? 'ready' : 'starting',
        e.error || (e.interrupted ? 'interrupted' : ''));
      if (e.interrupted || e.error) stopResponseSpeech();
      else speakResponse(e.text || lane.responseText, 'editing-agent');
      break;
    case 'said':
      if (e.queued) $('lane-hint').textContent = 'queued, it will pick this up next';
      break;
    case 'delivered':
      $('lane-hint').textContent = '';
      break;
    case 'interrupt-sent':
      setAgentState('working', 'stopping…');
      break;
  }
}

// --------------------------------------------------------------------------
// proposals: choices on screen, none of which have touched the document
// --------------------------------------------------------------------------

let openProp = null;
let proposalPosting = false;
let proposalPostingOwner = null;
let proposalAcceptanceRefresh = null;
let proposalLiveVersion = 0;
let proposalSnapshotRequestSeq = 0;

function validProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) ||
      typeof proposal.id !== 'string' || !proposal.id ||
      typeof proposal.status !== 'string') return false;
  if (proposal.status !== 'open') return true;
  return typeof proposal.anchor_pid === 'string' &&
    Array.isArray(proposal.options) && proposal.options.length >= 2 &&
    proposal.options.every((option) =>
      option && typeof option === 'object' && !Array.isArray(option) &&
      typeof option.id === 'string' && typeof option.text === 'string');
}

function validProposalSnapshot(proposals) {
  return Array.isArray(proposals) && proposals.every(validProposal);
}

function latestOpenProposal(proposals) {
  const open = proposals.filter((proposal) => proposal.status === 'open');
  return open.sort((a, b) => {
    const aa = Date.parse(a.at || '');
    const bb = Date.parse(b.at || '');
    if (Number.isFinite(aa) && Number.isFinite(bb)) return aa - bb;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  }).pop() || null;
}

function renderProposalSnapshot(proposals) {
  if (!validProposalSnapshot(proposals)) return false;
  renderProposal(latestOpenProposal(proposals));
  return true;
}

async function syncProposalSnapshot({ render = true } = {}) {
  const requestSeq = ++proposalSnapshotRequestSeq;
  const liveVersion = proposalLiveVersion;
  const documentGeneration = app.documentGeneration;
  const documentToken = capturedDocumentToken(app.model);
  const response = await fetchWithDeadline('/api/proposals', {}, 'Proposal snapshot');
  const data = await readJsonResponse(response, 'Proposal snapshot');
  if (!validProposalSnapshot(data.proposals)) {
    throw new Error('Proposal snapshot returned an invalid proposal list.');
  }
  const currentDocumentToken = capturedDocumentToken(app.model);
  // Both a later reconnect fetch and any live proposal/hello frame are newer
  // evidence. Never let this delayed snapshot paint over either one.
  if (requestSeq !== proposalSnapshotRequestSeq ||
      documentGeneration !== app.documentGeneration ||
      liveVersion !== proposalLiveVersion ||
      (documentToken && data.document_token &&
       documentToken !== data.document_token) ||
      (!currentDocumentToken && data.document_token) ||
      (currentDocumentToken && data.document_token &&
       currentDocumentToken !== data.document_token)) {
    return { stale: true, proposals: null };
  }
  if (render) renderProposalSnapshot(data.proposals);
  return { stale: false, proposals: data.proposals, liveVersion };
}

function setProposalBusy(busy) {
  for (const button of $('opts').querySelectorAll('.opt')) button.disabled = !!busy;
  $('prop-dismiss').disabled = !!busy;
}

function showProposalAcceptanceRefreshing(
  proposal,
  option,
  text = 'accepted \u00b7 refreshing\u2026',
) {
  if (!proposal || !openProp || openProp.id !== proposal.id) return false;
  const panel = $('proposal');
  delete panel.dataset.actionError;
  const accepted = $('opts').querySelector(
    `[data-opt="${CSS.escape(String(option || ''))}"]`,
  );
  if (accepted) accepted.dataset.taken = 'true';
  const intent = $('prop-intent');
  intent.textContent = text;
  intent.setAttribute('role', 'status');
  intent.setAttribute('aria-live', 'polite');
  setProposalBusy(true);
  return true;
}

function proposalChoiceAppearsInModel(model, acceptance) {
  if (!validDocumentModel(model) || !acceptance || !acceptance.proposal) {
    return false;
  }
  const proposal = acceptance.proposal;
  const selected = proposal.options &&
    proposal.options.find((candidate) => candidate.id === acceptance.option);
  if (!selected) return false;
  const anchorIndex = model.paragraphs.findIndex(
    (paragraph) => paragraph.pid === proposal.anchor_pid,
  );
  if (anchorIndex < 0) return false;
  if (proposal.mode === 'insert') {
    const next = model.paragraphs[anchorIndex + 1];
    return !!next && next.text === selected.text &&
      (!acceptance.nextPid || next.pid !== acceptance.nextPid);
  }
  if (proposal.mode === 'replace' &&
      typeof acceptance.expectedAnchorText === 'string') {
    const anchor = model.paragraphs[anchorIndex];
    return anchor.text === acceptance.expectedAnchorText &&
      acceptance.expectedAnchorText !== acceptance.anchorText;
  }
  return false;
}

function settleProposalAcceptanceSnapshot(
  acceptance,
  proposals,
  refreshedModel,
  uncertainty,
) {
  if (!acceptance || proposalAcceptanceRefresh !== acceptance ||
      acceptance.reconciled || !validProposalSnapshot(proposals)) return false;
  const latest = latestOpenProposal(proposals);
  const applied = proposalChoiceAppearsInModel(refreshedModel, acceptance);
  if (!applied && refreshedModel && latest && latest.id === acceptance.id) {
    acceptance.reconciled = true;
    acceptance.pending = false;
    acceptance.outcome = 'open';
    proposalAcceptanceRefresh = null;
    renderProposalSnapshot(proposals);
    const panel = $('proposal');
    panel.dataset.actionError = 'true';
    $('prop-intent').textContent =
      `not accepted \u00b7 ${uncertainty || 'Scribe still shows this choice as open.'}`;
    setProposalBusy(false);
    return true;
  }
  if (!refreshedModel) return false;

  acceptance.reconciled = true;
  acceptance.pending = false;
  acceptance.outcome = 'resolved';
  proposalAcceptanceRefresh = null;
  // Do not overwrite a newer live proposal that arrived while /api/doc was
  // pending. Its event has already rendered the stronger evidence.
  if (acceptance.snapshotLiveVersion === proposalLiveVersion) {
    renderProposalSnapshot(applied
      ? proposals.filter((proposal) => proposal.id !== acceptance.id)
      : proposals);
  }
  renderSidecarStatus({
    lane: 'proposal',
    pid: acceptance.proposal.anchor_pid,
    text: applied
      ? 'choice accepted \u00b7 document refreshed'
      : 'choice resolved \u00b7 document refreshed',
    duration: 10000,
  });
  return true;
}

async function acceptProposal(option) {
  const proposal = openProp;
  if (!proposal || proposalPosting) return;
  if (!validDocumentModel(app.model) ||
      !paragraphModel(proposal.anchor_pid)) {
    $('prop-intent').textContent = 'loading the document before this choice can be applied\u2026';
    setProposalBusy(true);
    return;
  }
  const submittedDocumentGeneration = app.documentGeneration;
  const postingOwner = {
    kind: 'accept',
    id: proposal.id,
    documentGeneration: submittedDocumentGeneration,
  };
  proposalPosting = true;
  proposalPostingOwner = postingOwner;
  const acceptance = {
      id: proposal.id,
      option,
      terminal: null,
      reconciled: false,
      pending: false,
      proposal: { ...proposal },
      anchorText: paragraphModel(proposal.anchor_pid)?.text,
      nextPid: (() => {
        const paragraphs = app.model && Array.isArray(app.model.paragraphs)
          ? app.model.paragraphs
          : [];
        const anchorIndex = paragraphs.findIndex(
          (paragraph) => paragraph.pid === proposal.anchor_pid,
        );
        return anchorIndex >= 0 && anchorIndex + 1 < paragraphs.length
          ? paragraphs[anchorIndex + 1].pid
          : null;
      })(),
    };
  const selectedOption = proposal.options.find(
    (candidate) => candidate.id === option,
  );
  acceptance.expectedAnchorText = proposal.mode === 'replace' &&
    typeof proposal.find === 'string' &&
    typeof acceptance.anchorText === 'string' &&
    selectedOption
    ? acceptance.anchorText.replace(proposal.find, selectedOption.text)
    : null;
  proposalAcceptanceRefresh = acceptance;
  const panel = $('proposal');
  delete panel.dataset.actionError;
  $('prop-intent').textContent = proposal.intent || 'Pick one:';
  setProposalBusy(true);
  let accepted = false;
  let acceptedOption = option;
  try {
    let result = null;
    let requestError = null;
    let responseReceived = false;
    try {
      const documentToken = capturedDocumentToken(app.model);
      result = await post('/api/accept', {
        id: proposal.id,
        option,
        ...(documentToken ? { expect_document_token: documentToken } : {}),
      });
      responseReceived = true;
      if (result.error) throw new Error(result.error);
      if (!result.accepted) {
        throw new Error('Scribe did not confirm the proposal choice.');
      }
    } catch (error) {
      requestError = error;
    }
    if (app.documentGeneration !== submittedDocumentGeneration) return;
    if (acceptance.terminal) {
      acceptedOption = acceptance.terminal.accepted || option;
    } else if (requestError) {
      if (!responseReceived) {
        let snapshot = null;
        try {
          snapshot = await syncProposalSnapshot({ render: false });
        } catch (_) {}
        if (app.documentGeneration !== submittedDocumentGeneration) return;
        if (acceptance.terminal) {
          acceptedOption = acceptance.terminal.accepted || option;
        } else if (snapshot && !snapshot.stale) {
          acceptance.pending = true;
          acceptance.snapshotObserved = true;
          acceptance.snapshot = snapshot.proposals;
          acceptance.snapshotLiveVersion = snapshot.liveVersion;
          showProposalAcceptanceRefreshing(
            proposal,
            option,
            'checking whether the choice was accepted\u2026',
          );
          const model = await fetchModel();
          if (app.documentGeneration !== submittedDocumentGeneration) return;
          let refreshedModel = null;
          if (model) refreshedModel = reconcileFetchedModel(model).model;
          if (app.documentGeneration !== submittedDocumentGeneration) return;
          if (settleProposalAcceptanceSnapshot(
            acceptance,
            snapshot.proposals,
            refreshedModel,
            requestError.message || String(requestError),
          )) {
            accepted = acceptance.outcome === 'resolved';
            return;
          }
          accepted = true;
          showProposalAcceptanceRefreshing(
            proposal,
            option,
            'choice status unknown \u00b7 waiting to reconnect',
          );
          return;
        } else {
          acceptance.pending = true;
          accepted = true;
          showProposalAcceptanceRefreshing(
            proposal,
            option,
            'choice status unknown \u00b7 waiting to reconnect',
          );
          return;
        }
      }
      // A stale proposal can be retired by the server before its terminal SSE
      // reaches this browser. The version guard inside syncProposalSnapshot
      // prevents this recovery read from erasing a newer live proposal.
      try {
        await syncProposalSnapshot();
      } catch (_) {}
      if (acceptance.terminal) {
        acceptedOption = acceptance.terminal.accepted || option;
      } else {
        if (openProp && openProp.id === proposal.id &&
            openProp.status === 'open') {
          panel.dataset.actionError = 'true';
          $('prop-intent').textContent =
            `not accepted \u00b7 ${requestError.message || String(requestError)}`;
        }
        return;
      }
    } else {
      acceptedOption = result.accepted;
    }
    accepted = true;
    showProposalAcceptanceRefreshing(proposal, acceptedOption);
    const model = await fetchModel();
    if (model) applyModel(model);
    if (app.documentGeneration !== submittedDocumentGeneration) return;
    acceptance.reconciled = true;
    if (openProp && openProp.id === proposal.id &&
        openProp.status === 'open') {
      renderProposal({
        ...openProp,
        status: 'accepted',
        accepted: acceptedOption,
      });
    }
    if (!model) {
      renderSidecarStatus({
        lane: 'proposal',
        pid: proposal.anchor_pid,
        text: 'choice accepted \u00b7 document refresh pending',
        duration: 15000,
      });
    }
  } finally {
    if (proposalAcceptanceRefresh === acceptance && !acceptance.pending) {
      proposalAcceptanceRefresh = null;
    }
    if (proposalPostingOwner === postingOwner) {
      proposalPostingOwner = null;
      proposalPosting = false;
      if (!accepted && openProp && openProp.id === proposal.id &&
          openProp.status === 'open') {
        setProposalBusy(false);
      }
    }
  }
}

async function dismissProposal() {
  const proposal = openProp;
  if (!proposal || proposalPosting) return;
  const postingOwner = {
    kind: 'dismiss',
    id: proposal.id,
    documentGeneration: app.documentGeneration,
  };
  proposalPosting = true;
  proposalPostingOwner = postingOwner;
  const panel = $('proposal');
  delete panel.dataset.actionError;
  $('prop-intent').textContent = proposal.intent || 'Pick one:';
  setProposalBusy(true);
  let dismissed = false;
  try {
    const documentToken = capturedDocumentToken(app.model);
    const result = await post('/api/dismiss', {
      id: proposal.id,
      ...(documentToken ? { expect_document_token: documentToken } : {}),
    });
    if (result.error) throw new Error(result.error);
    if (result.dismissed !== proposal.id) {
      throw new Error('Scribe did not confirm the proposal dismissal.');
    }
    dismissed = true;
    if (openProp && openProp.id === proposal.id &&
        openProp.status === 'open') {
      renderProposal({ ...openProp, status: 'dismissed' });
    }
  } catch (e) {
    if (openProp && openProp.id === proposal.id &&
        openProp.status === 'open') {
      panel.dataset.actionError = 'true';
      $('prop-intent').textContent =
        `not dismissed \u00b7 ${e.message || String(e)}`;
    }
  } finally {
    if (proposalPostingOwner === postingOwner) {
      proposalPostingOwner = null;
      proposalPosting = false;
      if (!dismissed && openProp && openProp.id === proposal.id &&
          openProp.status === 'open') {
        setProposalBusy(false);
      }
    }
  }
}

function renderProposal(p) {
  const panel = $('proposal');

  if (!p || p.status !== 'open') {
    const pendingAcceptance = p && p.status === 'accepted' &&
      proposalAcceptanceRefresh &&
      p.id === proposalAcceptanceRefresh.id &&
      !proposalAcceptanceRefresh.reconciled
      ? proposalAcceptanceRefresh
      : null;
    if (pendingAcceptance) {
      pendingAcceptance.terminal = p;
      pendingAcceptance.option = p.accepted || pendingAcceptance.option;
      showProposalAcceptanceRefreshing(openProp, pendingAcceptance.option);
      return;
    }
    // A delayed terminal event for an older proposal must not hide a newer
    // card that arrived while the older acceptance request was in flight.
    if (p && openProp && p.id !== openProp.id) return;
    // Show the accepted card briefly so the choice registers, then clear.
    if (p && p.status === 'accepted' && openProp && p.id === openProp.id) {
      const el = $('opts').querySelector(`[data-opt="${p.accepted}"]`);
      if (el) el.dataset.taken = 'true';
      openProp = { ...openProp, ...p };
      setProposalBusy(true);
      setTimeout(() => {
        if (!openProp || openProp.id === p.id) {
          panel.hidden = true;
          openProp = null;
          clearAnchor();
        }
      }, 1100);
      return;
    }
    panel.hidden = true;
    openProp = null;
    clearAnchor();
    return;
  }

  openProp = p;
  panel.hidden = false;
  delete panel.dataset.actionError;
  $('prop-intent').textContent = p.intent || 'Pick one:';

  const opts = $('opts');
  opts.textContent = '';
  for (const o of p.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.dataset.opt = o.id;
    b.innerHTML = `<span class="key"></span><span class="body"><span class="text"></span></span>`;
    b.querySelector('.key').textContent = o.id;
    b.querySelector('.text').textContent = o.text;
    if (o.note) {
      const n = document.createElement('span');
      n.className = 'note';
      n.textContent = o.note;
      b.querySelector('.body').appendChild(n);
    }
    b.onclick = () => acceptProposal(o.id);
    opts.appendChild(b);
  }
  setProposalBusy(
    !validDocumentModel(app.model) || !paragraphModel(p.anchor_pid),
  );

  // Grounding is the safety mechanism, not decoration: an ungrounded option is
  // one that may have invented its facts, and it says so out loud.
  const g = $('grounding');
  const list = $('ground-list');
  list.textContent = '';
  g.classList.toggle('empty', !p.grounding || !p.grounding.length);
  $('ground-n').textContent = p.grounding && p.grounding.length
    ? `${p.grounding.length} source${p.grounding.length > 1 ? 's' : ''}`
    : 'no sources cited, treat with suspicion';
  for (const gr of (p.grounding || [])) {
    const li = document.createElement('li');
    li.textContent = gr.claim + ' ';
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = gr.source;
    li.appendChild(src);
    if (gr.quote) {
      const q = document.createElement('span');
      q.className = 'quote';
      q.textContent = '“' + gr.quote + '”';
      li.appendChild(q);
    }
    list.appendChild(li);
  }

  markAnchor(p.anchor_pid);
}

function markAnchor(pid) {
  clearAnchor();
  const el = app.nodes.get(pid);
  if (!el) return;
  el.classList.add('anchored');
  scrollIntoViewIfNeeded(el);
}
function clearAnchor() {
  document.querySelectorAll('.para.anchored').forEach((e) => e.classList.remove('anchored'));
}

// --------------------------------------------------------------------------
// watch: a separate read-only reviewer and its anchored notes
// --------------------------------------------------------------------------

function reviewContainsPid(pid) {
  for (const pids of watch.activeReviews.values()) if (pids.has(pid)) return true;
  return false;
}

function applyParaDecorations(el, pid) {
  el.classList.toggle('watch-captured', watch.changes.has(pid));
  el.classList.toggle('watch-reviewing', reviewContainsPid(pid));
  el.classList.toggle('assisted', !!(openAssist && openAssist.status === 'open' &&
                                     openAssist.anchor_pid === pid));
}

function clearAssistVisual() {
  document.querySelectorAll('.assist-note').forEach((el) => el.remove());
  document.querySelectorAll('.para.assisted').forEach((el) => el.classList.remove('assisted'));
}

function sidecarIsOlder(candidate, current) {
  if (!candidate || !current || candidate.id === current.id) return false;
  const candidateAt = Date.parse(candidate.at || '');
  const currentAt = Date.parse(current.at || '');
  return Number.isFinite(candidateAt) && Number.isFinite(currentAt) &&
    candidateAt < currentAt;
}

function placeAssist(note, reveal = false, announce = false) {
  clearAssistVisual();
  if (!note || note.status !== 'open' || !app.model) return;
  const p = paragraphModel(note.anchor_pid);
  const anchor = app.nodes.get(note.anchor_pid);
  if (!p || !anchor || (note.anchor_hash && p.hash !== note.anchor_hash)) return;
  if (directEdits.has(note.anchor_pid)) {
    app.pendingAssist = note;
    app.pendingAssistAnnounce = app.pendingAssistAnnounce || announce;
    return;
  }

  if (Number.isInteger(note.change_start) && Number.isInteger(note.change_end) &&
      note.change_end > note.change_start && !anchor.querySelector('mark.assist-change')) {
    fillPara(anchor, p, {
      start: note.change_start,
      end: note.change_end,
      neon: true,
      assist: true,
    });
  }

  anchor.classList.add('assisted');
  const card = document.createElement('aside');
  card.className = 'assist-note';
  card.dataset.assist = note.id;
  card.setAttribute('role', 'note');
  card.setAttribute('aria-label', `Watch ${note.kind || 'insight'}: ${note.title}`);
  card.setAttribute('contenteditable', 'false');

  const head = document.createElement('div');
  head.className = 'assist-head';
  const heading = document.createElement('div');
  const label = document.createElement('span');
  label.className = 'assist-label';
  label.textContent = `watch \u00b7 ${note.kind || 'insight'}`;
  const title = document.createElement('strong');
  title.className = 'assist-title';
  title.textContent = note.title || 'A thought';
  heading.append(label, title);

  const actions = document.createElement('span');
  actions.className = 'assist-actions';
  const speak = document.createElement('button');
  speak.type = 'button';
  speak.className = 'assist-speak';
  speak.dataset.speechSource = `watch:${note.id}`;
  speak.dataset.readLabel = 'Read this watch note aloud';
  speak.dataset.stopLabel = 'Stop reading this watch note';
  speak.setAttribute('aria-label', 'Read this watch note aloud');
  speak.title = 'Read aloud';
  const speaker = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  speaker.setAttribute('viewBox', '0 0 24 24');
  speaker.setAttribute('aria-hidden', 'true');
  const speakerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  speakerPath.setAttribute('d', 'M5 10v4h3l4 3V7L8 10H5zm10-1.5a5 5 0 0 1 0 7M17.5 6a8 8 0 0 1 0 12');
  speaker.appendChild(speakerPath);
  speak.appendChild(speaker);
  speak.onclick = () => {
    const source = `watch:${note.id}`;
    if (responseSpeech.speaking && responseSpeech.last === source) {
      stopResponseSpeech();
    } else {
      speakResponse(`${note.title || 'A thought'}. ${note.text}`, source);
    }
  };

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'assist-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss watch note');
  dismiss.title = 'Dismiss';
  dismiss.textContent = '\u00d7';
  dismiss.onclick = async () => {
    if (responseSpeech.last === `watch:${note.id}`) stopResponseSpeech();
    dismiss.disabled = true;
    card.removeAttribute('data-error');
    card.removeAttribute('title');
    card.querySelector('.assist-action-status')?.remove();
    const out = await post('/api/assist/dismiss', { id: note.id })
      .catch(() => ({ error: 'Scribe is unavailable.' }));
    const error = out && out.error
      ? out.error
      : (!out || out.status !== 'dismissed'
        ? 'Scribe did not confirm the dismissal.'
        : '');
    if (error) {
      if (!card.isConnected) return;
      dismiss.disabled = false;
      card.dataset.error = 'true';
      card.title = error;
      const status = document.createElement('p');
      status.className = 'assist-action-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = `not dismissed \u00b7 ${error}`;
      head.insertAdjacentElement('afterend', status);
      return;
    }
    if (card.isConnected && openAssist && openAssist.id === note.id) {
      openAssist = null;
      clearAssistVisual();
    }
  };
  actions.append(speak, dismiss);
  head.append(heading, actions);
  card.appendChild(head);

  const text = document.createElement('p');
  text.className = 'assist-text';
  text.textContent = note.text;
  card.appendChild(text);

  if (note.grounding && note.grounding.length) {
    const details = document.createElement('details');
    details.className = 'assist-sources';
    const summary = document.createElement('summary');
    summary.textContent = `${note.grounding.length} source${note.grounding.length === 1 ? '' : 's'}`;
    details.appendChild(summary);
    const list = document.createElement('ul');
    for (const source of note.grounding) {
      const li = document.createElement('li');
      if (source.claim) li.appendChild(document.createTextNode(source.claim + ' '));
      const src = document.createElement('span');
      src.className = 'assist-source';
      src.textContent = source.source || '';
      li.appendChild(src);
      list.appendChild(li);
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  anchor.insertAdjacentElement('beforebegin', card);
  if (announce) playResponseChime('watch');
  if (reveal) {
    requestAnimationFrame(() => card.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
}

function hydrateAgent(a, requestedAt = lane.liveEvents) {
  if (!a || requestedAt !== lane.liveEvents) return false;
  applyModelPool({
    enabledModels: a.enabledModels,
    selected: a.model,
    automaticModels: a.automaticModels,
  });
  setModel(a.model || 'sonnet', false);
  lane.ready = !!(a.running && a.sessionId);
  lane.cost = a.running ? (a.costUsd || 0) : 0;
  if (!a.running) {
    setAgentState('off', '');
  } else {
    setAgentState(lane.ready ? 'ready' : 'starting',
      lane.ready ? '' : 'waiting for your first message');
  }
  setAgentMeta();
  return true;
}

async function syncAgentSnapshot() {
  const requestSeq = ++agentSnapshotRequestSeq;
  const requestedAt = lane.liveEvents;
  const documentGeneration = app.documentGeneration;
  const documentToken = capturedDocumentToken(app.model);
  const response = await fetchWithDeadline('/api/agent', {}, 'Agent snapshot');
  const snapshot = await readJsonResponse(response, 'Agent snapshot');
  const currentDocumentToken = capturedDocumentToken(app.model);
  if (requestSeq !== agentSnapshotRequestSeq ||
      documentGeneration !== app.documentGeneration ||
      (documentToken && snapshot.document_token &&
       documentToken !== snapshot.document_token) ||
      (!currentDocumentToken && snapshot.document_token) ||
      (currentDocumentToken && snapshot.document_token &&
       currentDocumentToken !== snapshot.document_token)) return false;
  return hydrateAgent(snapshot, requestedAt);
}

function renderAssist(note, announce = false) {
  if (!note || note.status !== 'open') {
    const clearAll = !note;
    const pendingMatches = clearAll ||
      (app.pendingAssist && note.id === app.pendingAssist.id);
    const openMatches = clearAll || (openAssist && note.id === openAssist.id);
    const visible = document.querySelector('.assist-note');
    const visibleMatches = clearAll ||
      (visible && note.id === visible.dataset.assist);
    if (pendingMatches) {
      app.pendingAssist = null;
      app.pendingAssistAnnounce = false;
    }
    if (openMatches) openAssist = null;
    if (visibleMatches) clearAssistVisual();
    return;
  }
  if (sidecarIsOlder(note, openAssist)) return;
  openAssist = note;
  if (!app.model) {
    app.pendingAssist = note;
    app.pendingAssistAnnounce = app.pendingAssistAnnounce || announce;
    return;
  }
  placeAssist(note, true, announce);
}

async function syncAssistSnapshot() {
  const requestSeq = ++assistSnapshotRequestSeq;
  const documentGeneration = app.documentGeneration;
  const documentToken = capturedDocumentToken(app.model);
  const response = await fetchWithDeadline('/api/assists', {}, 'Watch snapshot');
  const snapshot = await readJsonResponse(response, 'Watch snapshot');
  if (!Array.isArray(snapshot.assists) ||
      !snapshot.assists.every(validSidecarPayload)) {
    throw new Error('Watch snapshot returned an invalid assist list.');
  }
  const currentDocumentToken = capturedDocumentToken(app.model);
  if (requestSeq !== assistSnapshotRequestSeq ||
      documentGeneration !== app.documentGeneration ||
      (documentToken && snapshot.document_token &&
       documentToken !== snapshot.document_token) ||
      (!currentDocumentToken && snapshot.document_token) ||
      (currentDocumentToken && snapshot.document_token &&
       currentDocumentToken !== snapshot.document_token)) {
    return false;
  }
  renderAssist(snapshot.assists[snapshot.assists.length - 1] || null);
  return true;
}

function clearSidecarStatus(lane = null) {
  const selector = lane
    ? `.sidecar-status[data-lane="${CSS.escape(lane)}"]`
    : '.sidecar-status';
  document.querySelectorAll(selector).forEach((el) => el.remove());
  if (lane) {
    clearTimeout(sidecarStatusTimers.get(lane));
    sidecarStatusTimers.delete(lane);
    return;
  }
  for (const timer of sidecarStatusTimers.values()) clearTimeout(timer);
  sidecarStatusTimers.clear();
}

function renderSidecarStatus({
  lane,
  pid,
  model = '',
  text,
  error = false,
  duration = 10000,
}) {
  clearSidecarStatus(lane);
  const anchor = app.nodes.get(pid);
  if (!anchor || !text) return false;

  const status = document.createElement('aside');
  status.className = 'sidecar-status';
  status.dataset.lane = lane;
  status.dataset.error = String(!!error);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('contenteditable', 'false');

  const label = document.createElement('span');
  label.className = 'sidecar-status-label';
  const prettyModel = String(model).replace(/^./, (c) => c.toUpperCase());
  label.textContent = `${lane}${prettyModel ? ` \u00b7 ${prettyModel}` : ''}`;

  const message = document.createElement('span');
  message.className = 'sidecar-status-text';
  message.textContent = String(text).replace(/\s+/g, ' ').trim().slice(0, 220);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'sidecar-status-dismiss';
  dismiss.textContent = '\u00d7';
  dismiss.setAttribute('aria-label', `Dismiss ${lane} status`);
  dismiss.onclick = () => clearSidecarStatus(lane);

  status.append(label, message, dismiss);
  anchor.insertAdjacentElement(lane === 'watch' ? 'beforebegin' : 'afterend', status);
  const timer = setTimeout(() => clearSidecarStatus(lane), duration);
  sidecarStatusTimers.set(lane, timer);
  return true;
}

// --------------------------------------------------------------------------
// predictive continuation: ghost prose after the paragraph, never auto-inserted
// --------------------------------------------------------------------------

let continuationAcceptanceRefresh = null;

function clearPredictionPendingVisual() {
  document.querySelectorAll('.continuation-pending').forEach((el) => el.remove());
  document.querySelectorAll('.para.continuation-drafting')
    .forEach((el) => el.classList.remove('continuation-drafting'));
}

function renderPredictionPending(job) {
  const existing = job && document.querySelector(
    `.continuation-pending[data-prediction="${CSS.escape(String(job.id || ''))}"]`);
  if (existing && prediction.pending && prediction.pending.id === job.id) {
    prediction.pending = { ...prediction.pending, ...job };
    return;
  }
  clearPredictionPendingVisual();
  prediction.pending = job || null;
  if (!job || !app.model) return;
  if (job.capture_id && prediction.capture &&
      job.capture_id !== prediction.capture.id) return;

  const paragraph = paragraphModel(job.anchor_pid);
  const anchor = app.nodes.get(job.anchor_pid);
  if (!paragraph || !anchor || paragraph.table) return;

  anchor.classList.add('continuation-drafting');
  const cue = document.createElement('aside');
  cue.className = 'continuation-pending';
  cue.dataset.prediction = job.id;
  cue.setAttribute('role', 'status');
  cue.setAttribute('aria-live', 'polite');
  cue.setAttribute('contenteditable', 'false');

  const label = document.createElement('span');
  label.className = 'continuation-label';
  const model = String(job.model || '').replace(/^./, (c) => c.toUpperCase());
  label.textContent = `continue${model ? ` \u00b7 ${model}` : ''}`;

  const status = document.createElement('span');
  status.className = 'continuation-pending-text';
  status.textContent = 'drafting the next paragraph';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'continuation-pending-cancel';
  cancel.textContent = '\u00d7';
  cancel.title = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel next-paragraph drafting');
  cancel.onclick = () => {
    const id = job.id;
    if (prediction.activeId === id) prediction.activeId = null;
    renderPredictionPending(null);
    post('/api/predict/cancel', { id, reason: 'cancelled by human' }).catch(() => {});
  };

  cue.append(label, status, cancel);
  anchor.insertAdjacentElement('afterend', cue);
}

function clearContinuationVisual() {
  document.querySelectorAll('.continuation-note').forEach((el) => el.remove());
  document.querySelectorAll('.para.continuation-anchor')
    .forEach((el) => el.classList.remove('continuation-anchor'));
}

function clearContinuationActionStatus(card) {
  if (!card) return;
  card.removeAttribute('data-error');
  card.removeAttribute('title');
  card.querySelector('.continuation-action-status')?.remove();
}

function showContinuationActionStatus(card, text, {
  error = false,
  title = '',
} = {}) {
  if (!card || !card.isConnected) return;
  clearContinuationActionStatus(card);
  if (error) card.dataset.error = 'true';
  if (title) card.title = title;
  const status = document.createElement('p');
  status.className = 'continuation-action-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = text;
  card.querySelector('.continuation-head')
    ?.insertAdjacentElement('afterend', status);
}

function reflectContinuationAcceptance(card, phase) {
  if (!card || !card.isConnected) return;
  card.dataset.acceptanceRefresh = phase;
  card.querySelectorAll('.continuation-insert, .continuation-dismiss')
    .forEach((button) => { button.disabled = true; });
  if (phase === 'refreshing') {
    showContinuationActionStatus(card, 'inserted \u00b7 refreshing\u2026');
  } else if (phase === 'checking') {
    showContinuationActionStatus(card, 'checking whether it was inserted\u2026');
  } else if (phase === 'unknown') {
    showContinuationActionStatus(
      card,
      'insert status unknown \u00b7 waiting to reconnect',
      {
        title: 'The suggestion is locked to prevent a duplicate insert until Scribe can reconcile the document.',
      },
    );
  }
}

function continuationAppearsAfterAnchor(model, acceptance) {
  const continuation = acceptance && acceptance.continuation;
  if (!validDocumentModel(model) || !continuation) return false;
  const index = model.paragraphs.findIndex(
    (paragraph) => paragraph.pid === continuation.anchor_pid,
  );
  if (index < 0 || index + 1 >= model.paragraphs.length) return false;
  const next = model.paragraphs[index + 1];
  // Text alone is insufficient: the suggestion may already equal the old next
  // paragraph. A durable insert creates a new paragraph identity at this exact
  // boundary, while preserving the old successor after it.
  return next.text === continuation.text &&
    (!acceptance.nextPid || next.pid !== acceptance.nextPid);
}

function settleContinuationAcceptanceSnapshot(
  acceptance,
  snapshotContinuation,
  refreshedModel,
  uncertainty,
) {
  if (!acceptance || continuationAcceptanceRefresh !== acceptance ||
      acceptance.reconciled) return false;

  const original = acceptance.continuation;
  const sameStillOpen = snapshotContinuation &&
    snapshotContinuation.status === 'open' &&
    snapshotContinuation.id === acceptance.id;
  const inserted = continuationAppearsAfterAnchor(refreshedModel, acceptance);

  // The model read is queued behind the document mutation, whereas the cheap
  // continuation snapshot can race ahead and still say "open". A newly inserted
  // paragraph is therefore stronger evidence and must win over that stale card.
  if (inserted) {
    acceptance.reconciled = true;
    continuationAcceptanceRefresh = null;
    renderContinuation(
      snapshotContinuation && snapshotContinuation.status === 'open' &&
      snapshotContinuation.id !== acceptance.id
        ? snapshotContinuation
        : null,
    );
    renderSidecarStatus({
      lane: 'continue',
      pid: original && original.anchor_pid,
      model: original && original.model,
      text: 'inserted \u00b7 document refreshed',
      duration: 10000,
    });
    return true;
  }

  if (sameStillOpen && refreshedModel) {
    acceptance.reconciled = true;
    continuationAcceptanceRefresh = null;
    renderContinuation(snapshotContinuation);
    const visible = document.querySelector(
      `.continuation-note[data-continuation="${CSS.escape(acceptance.id)}"]`,
    );
    const detail = uncertainty || 'Scribe still shows this suggestion as open.';
    showContinuationActionStatus(visible, `not inserted \u00b7 ${detail}`, {
      error: true,
      title: detail,
    });
    visible?.querySelectorAll('.continuation-insert, .continuation-dismiss')
      .forEach((button) => { button.disabled = false; });
    return true;
  }

  // A null/different snapshot proves that this card is no longer actionable,
  // but do not make it disappear until a fresh document model has also arrived.
  // That keeps a durable insert visible through the exact lost-ack window.
  const snapshotResolved = snapshotContinuation === null ||
    (snapshotContinuation && snapshotContinuation.id !== acceptance.id);
  if (!snapshotResolved || !refreshedModel) return false;

  acceptance.reconciled = true;
  continuationAcceptanceRefresh = null;
  renderContinuation(
    snapshotContinuation && snapshotContinuation.status === 'open'
      ? snapshotContinuation
      : null,
  );
  renderSidecarStatus({
    lane: 'continue',
    pid: original && original.anchor_pid,
    model: original && original.model,
    text: 'suggestion resolved \u00b7 document refreshed',
    duration: 10000,
  });
  return true;
}

function placeContinuation(continuation, reveal = false, announce = false) {
  clearContinuationVisual();
  if (!continuation || continuation.status !== 'open' || !app.model) return;
  const p = paragraphModel(continuation.anchor_pid);
  const anchor = app.nodes.get(continuation.anchor_pid);
  if (!p || !anchor ||
      (continuation.anchor_hash && p.hash !== continuation.anchor_hash)) return;
  const directEdit = directEdits.get(continuation.anchor_pid);
  if (directEdit && directEdit.dirty) {
    app.pendingContinuation = continuation;
    app.pendingContinuationAnnounce =
      app.pendingContinuationAnnounce || announce;
    return;
  }

  anchor.classList.add('continuation-anchor');
  const card = document.createElement('aside');
  card.className = 'continuation-note';
  card.dataset.continuation = continuation.id;
  card.setAttribute('role', 'note');
  card.setAttribute('aria-label', `Suggested next paragraph from ${continuation.model || 'the cheaper model'}`);
  card.setAttribute('contenteditable', 'false');

  const head = document.createElement('div');
  head.className = 'continuation-head';
  const label = document.createElement('span');
  label.className = 'continuation-label';
  const model = String(continuation.model || '').replace(/^./, (c) => c.toUpperCase());
  label.textContent = `continue${model ? ` \u00b7 ${model}` : ''}`;

  const clearActionStatus = () => clearContinuationActionStatus(card);
  const showActionError = (action, error) => {
    showContinuationActionStatus(card, `${action} \u00b7 ${error}`, {
      error: true,
      title: error,
    });
  };
  let actionPosting = false;
  const setActionBusy = (busy) => {
    actionPosting = !!busy;
    insert.disabled = !!busy;
    dismiss.disabled = !!busy;
  };

  const actions = document.createElement('span');
  actions.className = 'continuation-actions';
  const insert = document.createElement('button');
  insert.type = 'button';
  insert.className = 'continuation-insert';
  insert.textContent = 'insert';
  insert.setAttribute('aria-label', 'Insert this suggested paragraph');
  insert.onclick = async () => {
    if (actionPosting) return;
    const submittedDocumentGeneration = app.documentGeneration;
    setActionBusy(true);
    clearActionStatus();
    const acceptance = {
      id: continuation.id,
      phase: 'posting',
      reconciled: false,
      terminal: null,
      continuation: { ...continuation },
      documentToken: capturedDocumentToken(app.model),
      nextPid: (() => {
        const anchorIndex = app.model.paragraphs.findIndex(
          (paragraph) => paragraph.pid === continuation.anchor_pid,
        );
        return anchorIndex >= 0 && anchorIndex + 1 < app.model.paragraphs.length
          ? app.model.paragraphs[anchorIndex + 1].pid
          : null;
      })(),
    };
    continuationAcceptanceRefresh = acceptance;
    reflectContinuationAcceptance(card, acceptance.phase);
    let out = null;
    let requestError = null;
    try {
      out = await post('/api/predict/accept', {
        id: continuation.id,
        ...(acceptance.documentToken
          ? { expect_document_token: acceptance.documentToken }
          : {}),
      });
    } catch (error) {
      requestError = error;
    }
    if (app.documentGeneration !== submittedDocumentGeneration) return;
    const explicitError = !acceptance.terminal && out && out.error
      ? out.error
      : '';
    if (explicitError) {
      if (continuationAcceptanceRefresh === acceptance) {
        continuationAcceptanceRefresh = null;
      }
      delete card.dataset.acceptanceRefresh;
      showActionError('not inserted', explicitError);
      setActionBusy(false);
      return;
    }
    if (!acceptance.terminal && (!out || !out.continuation)) {
      acceptance.phase = 'checking';
      reflectContinuationAcceptance(card, acceptance.phase);
      const [model, snapshot] = await Promise.all([
        fetchModel(),
        fetchPredictionSnapshot(),
      ]);
      if (app.documentGeneration !== submittedDocumentGeneration) return;
      let refreshedModel = null;
      if (model) {
        const reconciled = reconcileFetchedModel(model);
        refreshedModel = reconciled.model;
      }
      if (app.documentGeneration !== submittedDocumentGeneration) return;
      const snapshotMatchesDocument = !snapshot ||
        !acceptance.documentToken ||
        !snapshot.document_token ||
        snapshot.document_token === acceptance.documentToken;
      if (snapshotMatchesDocument && settleContinuationAcceptanceSnapshot(
        acceptance,
        snapshot ? snapshot.continuation : undefined,
        refreshedModel,
        requestError && (requestError.message || String(requestError)) ||
          'Scribe did not confirm the insert.',
      )) {
        return;
      }
      acceptance.phase = 'unknown';
      reflectContinuationAcceptance(
        document.querySelector(
          `.continuation-note[data-continuation="${CSS.escape(acceptance.id)}"]`,
        ),
        acceptance.phase,
      );
      return;
    }
    const acceptedContinuation = acceptance.terminal || out.continuation;
    acceptance.terminal = acceptedContinuation;
    acceptance.phase = 'refreshing';
    const visible = document.querySelector(
      `.continuation-note[data-continuation="${CSS.escape(continuation.id)}"]`,
    );
    reflectContinuationAcceptance(visible, acceptance.phase);
    if (out.rev != null) {
      app.rev = out.rev;
      updateRevision();
    }
    const model = await fetchModel();
    if (model) applyModel(model);
    if (app.documentGeneration !== submittedDocumentGeneration) return;
    acceptance.reconciled = true;
    // Keep the accepted prose visible until a document read has had the chance
    // to paint the inserted paragraph. The terminal SSE can arrive before this
    // HTTP handler, so renderContinuation also defers this exact retirement.
    renderContinuation(acceptedContinuation);
    if (!model) {
      renderSidecarStatus({
        lane: 'continue',
        pid: continuation.anchor_pid,
        model: continuation.model,
        text: 'inserted \u00b7 document refresh pending',
        duration: 15000,
      });
    }
    if (continuationAcceptanceRefresh === acceptance) {
      continuationAcceptanceRefresh = null;
    }
    if (card.isConnected) setActionBusy(false);
  };

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'continuation-dismiss';
  dismiss.textContent = '\u00d7';
  dismiss.setAttribute('aria-label', 'Dismiss suggested paragraph');
  dismiss.title = 'Dismiss';
  dismiss.onclick = async () => {
    if (actionPosting) return;
    setActionBusy(true);
    clearActionStatus();
    const documentToken = capturedDocumentToken(app.model);
    const out = await post('/api/predict/dismiss', {
      id: continuation.id,
      ...(documentToken ? { expect_document_token: documentToken } : {}),
    })
      .catch(() => ({ error: 'Scribe is unavailable.' }));
    const error = out && out.error
      ? out.error
      : (!out || out.status !== 'dismissed'
        ? 'Scribe did not confirm the dismissal.'
        : '');
    if (error) {
      showActionError('not dismissed', error);
      setActionBusy(false);
      return;
    }
    // The response is enough to retire this exact card if its SSE event was
    // lost. Never clear a newer continuation that may have replaced it.
    if (card.isConnected && openContinuation &&
        openContinuation.id === continuation.id) {
      openContinuation = null;
      clearContinuationVisual();
    }
    if (card.isConnected) setActionBusy(false);
  };
  actions.append(insert, dismiss);
  head.append(label, actions);

  const text = document.createElement('p');
  text.className = 'continuation-text';
  text.textContent = continuation.text;
  card.append(head, text);
  anchor.insertAdjacentElement('afterend', card);
  const pendingAcceptance = continuationAcceptanceRefresh;
  if (pendingAcceptance && pendingAcceptance.id === continuation.id &&
      !pendingAcceptance.reconciled) {
    reflectContinuationAcceptance(card, pendingAcceptance.phase);
  }

  if (announce) playResponseChime('continue');
  if (reveal) {
    requestAnimationFrame(() => card.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
}

function renderContinuation(continuation, announce = false) {
  if (!continuation || continuation.status !== 'open') {
    const pendingAcceptance = continuation && continuation.status === 'accepted' &&
      continuationAcceptanceRefresh &&
      continuation.id === continuationAcceptanceRefresh.id &&
      !continuationAcceptanceRefresh.reconciled
      ? continuationAcceptanceRefresh
      : null;
    if (pendingAcceptance) {
      pendingAcceptance.terminal = continuation;
      pendingAcceptance.phase = 'refreshing';
      const acceptingCard = document.querySelector(
        `.continuation-note[data-continuation="${CSS.escape(continuation.id)}"]`,
      );
      reflectContinuationAcceptance(acceptingCard, pendingAcceptance.phase);
      if (app.pendingContinuation &&
          app.pendingContinuation.id === continuation.id) {
        app.pendingContinuation = null;
        app.pendingContinuationAnnounce = false;
      }
      return;
    }
    const clearAll = !continuation;
    const pendingMatches = clearAll ||
      (app.pendingContinuation &&
       continuation.id === app.pendingContinuation.id);
    const openMatches = clearAll ||
      (openContinuation && continuation.id === openContinuation.id);
    const visible = document.querySelector('.continuation-note');
    const visibleMatches = clearAll ||
      (visible && continuation.id === visible.dataset.continuation);
    if (pendingMatches) {
      app.pendingContinuation = null;
      app.pendingContinuationAnnounce = false;
    }
    if (openMatches) openContinuation = null;
    if (visibleMatches) clearContinuationVisual();
    return;
  }
  if (sidecarIsOlder(continuation, openContinuation)) return;
  openContinuation = continuation;
  if (!app.model) {
    app.pendingContinuation = continuation;
    app.pendingContinuationAnnounce =
      app.pendingContinuationAnnounce || announce;
    return;
  }
  placeContinuation(continuation, true, announce);
}

function onPredictionEvent(event) {
  if (!event) return;
  prediction.lastEvent = event;
  if (event.kind === 'queued' || event.kind === 'thinking') {
    clearSidecarStatus('continue');
    prediction.activeId = event.id || prediction.activeId;
    renderPredictionPending(event);
    return;
  }
  if (event.kind === 'ready' && event.continuation) {
    const continuation = event.continuation;
    const eventId = event.id || continuation.id;
    const belongsToOlderCapture = !!(
      continuation.capture_id && prediction.capture &&
      continuation.capture_id !== prediction.capture.id
    );
    const newerJobExists = !!(eventId && (
      (prediction.activeId && prediction.activeId !== eventId) ||
      (prediction.pending && prediction.pending.id !== eventId)
    ));
    if (belongsToOlderCapture || newerJobExists) {
      post('/api/predict/dismiss', { id: continuation.id }).catch(() => {});
      return;
    }
    clearSidecarStatus('continue');
    prediction.activeId = null;
    renderPredictionPending(null);
    renderContinuation(continuation, true);
    return;
  }
  if (event.kind === 'accepted' || event.kind === 'dismissed' ||
      event.kind === 'stale' || event.kind === 'superseded') {
    clearSidecarStatus('continue');
    if (prediction.pending &&
        (!event.id || prediction.pending.id === event.id)) {
      renderPredictionPending(null);
    }
    if (event.continuation) renderContinuation(event.continuation);
    return;
  }
  if (event.kind === 'failed' || event.kind === 'cancelled' ||
      event.kind === 'complete') {
    const pending = prediction.pending;
    const newerJobExists = !!(event.id && (
      (prediction.activeId && prediction.activeId !== event.id) ||
      (pending && pending.id !== event.id)
    ));
    if (newerJobExists) return;
    if (!event.id || prediction.activeId === event.id) {
      prediction.activeId = null;
      renderPredictionPending(null);
    }
    if (event.kind === 'failed') {
      renderSidecarStatus({
        lane: 'continue',
        pid: event.anchor_pid || (pending && pending.anchor_pid),
        model: pending && pending.model,
        text: event.error || 'The next paragraph could not be drafted.',
        error: true,
        duration: 12000,
      });
    } else if (event.kind === 'complete' && event.suggested === false) {
      renderSidecarStatus({
        lane: 'continue',
        pid: event.anchor_pid || (pending && pending.anchor_pid),
        model: pending && pending.model,
        text: 'No useful next paragraph was found. Nothing was added.',
        duration: 7000,
      });
    } else {
      clearSidecarStatus('continue');
    }
  }
}

// --------------------------------------------------------------------------
// agentic formatting: a sparse formatting-only pass over substantial additions
// --------------------------------------------------------------------------

const FORMATTING_EVENT_KINDS = new Set([
  'armed', 'disabled', 'collecting', 'queued', 'reviewing', 'applied',
  'complete', 'failed', 'cancelled',
]);

function formattingPayloadToken(payload) {
  const token = payload && payload.document_token;
  return typeof token === 'string' && token.trim() ? token : null;
}

function formattingPayloadOwnsCurrentDocument(
  payload,
  { requireCurrentToken = false } = {},
) {
  const payloadToken = formattingPayloadToken(payload);
  const currentToken = capturedDocumentToken(app.model);
  if (requireCurrentToken && payloadToken && !currentToken) return false;
  return !(payloadToken && currentToken && payloadToken !== currentToken);
}

function normalizeFormattingState(state, enabled = formatting.enabled) {
  const value = String(state || '').toLowerCase();
  // A failed attempt to turn the feature on must remain visible even though
  // aria-pressed correctly stays false.
  if (value === 'failed') return 'failed';
  if (!enabled || value === 'off' || value === 'disabled') return 'off';
  if (value === 'armed' || value === 'idle' || value === 'ready') {
    return 'collecting';
  }
  if (value === 'running' || value === 'thinking') return 'reviewing';
  if (['collecting', 'queued', 'reviewing', 'applied', 'failed'].includes(value)) {
    return value;
  }
  return 'collecting';
}

function formattingThresholdDescription() {
  const words = Number.isFinite(formatting.thresholdWords)
    ? Math.max(1, Math.round(formatting.thresholdWords))
    : 600;
  const quietSeconds = Number.isFinite(formatting.quietMs)
    ? Math.max(1, Math.round(formatting.quietMs / 1000))
    : 90;
  return { words, quietSeconds };
}

function refreshFormattingState(detail) {
  const button = $('format-toggle');
  if (!button) return;
  const state = normalizeFormattingState(formatting.status, formatting.enabled);
  formatting.status = state;
  button.hidden = formatting.supported === false;
  button.dataset.state = state;
  button.setAttribute('aria-pressed', String(formatting.enabled));

  const { words, quietSeconds } = formattingThresholdDescription();
  const pending = Math.max(0, Math.round(formatting.pendingWords || 0));
  const paragraphs = Math.max(0, Math.round(formatting.pendingParagraphs || 0));
  const stateLabels = {
    off: 'off',
    collecting: pending
      ? `collecting (${pending} of about ${words} added words)`
      : 'on and waiting for substantial additions',
    queued: 'queued until the document is quiet',
    reviewing: 'reviewing formatting',
    applied: formatting.lastCount
      ? `applied to ${formatting.lastCount} paragraph${formatting.lastCount === 1 ? '' : 's'}`
      : 'applied',
    failed: 'failed',
  };
  button.setAttribute(
    'aria-label',
    `AI formatting is ${stateLabels[state] || state}.`,
  );
  const status = $('format-status');
  if (status) {
    const announcement =
      `AI formatting is ${stateLabels[state] || state}. ` +
      'Formatting changes only, never your words.';
    if (status.textContent !== announcement) status.textContent = announcement;
  }

  if (detail) {
    button.title = detail;
    return;
  }
  const invariant =
    'Formatting changes only—never your words.';
  if (state === 'off') {
    button.title =
      `AI formatting is off. When on, formatting changes only—never your words. ` +
      `It waits for about ` +
      `${words} added words and ${quietSeconds} seconds of quiet.`;
  } else if (state === 'collecting') {
    const progress = pending
      ? `${pending} of about ${words} added words collected` +
        `${paragraphs ? ` across ${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}` : ''}. `
      : '';
    button.title =
      `${progress}${invariant} The formatting pass waits for about ${words} ` +
      `added words and ${quietSeconds} seconds of quiet, so it runs infrequently.`;
  } else if (state === 'queued') {
    button.title =
      `Enough new writing is collected. Formatting starts after about ` +
      `${quietSeconds} seconds of quiet. ${invariant}`;
  } else if (state === 'reviewing') {
    button.title =
      `A separate AI is reviewing formatting now. ${invariant}`;
  } else if (state === 'applied') {
    button.title =
      `Formatting was applied${formatting.lastCount
        ? ` to ${formatting.lastCount} paragraph${formatting.lastCount === 1 ? '' : 's'}`
        : ''}. ${invariant}`;
  } else {
    button.title =
      `The last formatting pass failed. Your words were not changed. ` +
      (formatting.lastError || 'Scribe will try again after another substantial addition.');
  }
}

function updateFormattingNumbers(payload) {
  if (Number.isFinite(payload.pending_words)) {
    formatting.pendingWords = Math.max(0, payload.pending_words);
  }
  if (Number.isFinite(payload.pending_paragraphs)) {
    formatting.pendingParagraphs = Math.max(0, payload.pending_paragraphs);
  }
  if (Number.isFinite(payload.threshold_words) && payload.threshold_words > 0) {
    formatting.thresholdWords = payload.threshold_words;
  }
  if (Number.isFinite(payload.quiet_ms) && payload.quiet_ms > 0) {
    formatting.quietMs = payload.quiet_ms;
  }
  if (Number.isFinite(payload.cooldown_ms) && payload.cooldown_ms >= 0) {
    formatting.cooldownMs = payload.cooldown_ms;
  }
}

function observeFormattingToggleAcknowledgement(payload) {
  const owner = formattingToggleOwner;
  if (!owner || !payload) return;
  let enabled = typeof payload.enabled === 'boolean' ? payload.enabled : null;
  const kind = String(payload.kind || payload.status || '').toLowerCase();
  if (enabled === null && (kind === 'disabled' || kind === 'off')) enabled = false;
  if (enabled === null &&
      ['armed', 'collecting', 'queued', 'reviewing', 'applied'].includes(kind)) {
    enabled = true;
  }
  if (enabled === owner.desired) owner.acknowledged = true;
}

function applyFormattingSnapshot(snapshot) {
  if (!snapshot || !formattingPayloadOwnsCurrentDocument(snapshot)) return false;
  observeFormattingToggleAcknowledgement(snapshot);
  updateFormattingNumbers(snapshot);
  if (typeof snapshot.enabled === 'boolean') formatting.enabled = snapshot.enabled;
  if (snapshot.active === null ||
      (snapshot.active && typeof snapshot.active === 'object')) {
    formatting.active = snapshot.active;
  }
  if (snapshot.runner === null ||
      (snapshot.runner && typeof snapshot.runner === 'object')) {
    formatting.runner = snapshot.runner;
  }
  formatting.documentToken = formattingPayloadToken(snapshot);
  formatting.model =
    snapshot.active && snapshot.active.model ||
    snapshot.runner && snapshot.runner.model ||
    formatting.model;
  formatting.provider =
    snapshot.active && snapshot.active.provider ||
    snapshot.runner && snapshot.runner.provider ||
    formatting.provider;

  // A startup GET can finish before the first document ownership frame. Adopt
  // the user's enabled preference and thresholds, but never display another
  // document's active job while no current ownership token exists.
  const currentToken = capturedDocumentToken(app.model);
  if (formatting.documentToken && !currentToken) {
    formatting.active = null;
    formatting.runner = null;
    formatting.pendingWords = 0;
    formatting.pendingParagraphs = 0;
    formatting.status = formatting.enabled ? 'collecting' : 'off';
  } else {
    formatting.status = normalizeFormattingState(
      formatting.active ? 'reviewing' : snapshot.status,
      formatting.enabled,
    );
  }
  formatting.supported = true;
  formatting.lastError = '';
  refreshFormattingState();
  return true;
}

function onFormattingEvent(event) {
  if (!event || !formattingPayloadOwnsCurrentDocument(
    event, { requireCurrentToken: true })) return false;
  observeFormattingToggleAcknowledgement(event);
  const kind = String(event.kind || event.status || '').toLowerCase();
  if (!FORMATTING_EVENT_KINDS.has(kind) &&
      !['off', 'idle', 'ready', 'running', 'thinking'].includes(kind)) {
    return false;
  }
  const terminal = ['applied', 'complete', 'failed', 'cancelled'].includes(kind);
  if (terminal && event.id && formatting.active && formatting.active.id &&
      event.id !== formatting.active.id) {
    return false;
  }

  clearTimeout(formattingAppliedTimer);
  formattingAppliedTimer = null;
  updateFormattingNumbers(event);
  formatting.supported = true;
  formatting.documentToken =
    formattingPayloadToken(event) || formatting.documentToken;
  if (event.model) formatting.model = event.model;
  if (event.provider) formatting.provider = event.provider;

  if (kind === 'disabled' || kind === 'off') {
    formatting.enabled = false;
    formatting.active = null;
    formatting.status = 'off';
  } else {
    formatting.enabled = event.enabled !== false;
    if (kind === 'queued' || kind === 'reviewing' ||
        kind === 'running' || kind === 'thinking') {
      formatting.active = {
        ...(formatting.active || {}),
        ...(event.id ? { id: event.id } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.provider ? { provider: event.provider } : {}),
      };
    }
    if (terminal) formatting.active = null;
    if (kind === 'applied' ||
        (kind === 'complete' && Number(event.count || 0) > 0)) {
      formatting.lastCount = Math.max(0, Math.round(event.count || 0));
      formatting.lastError = '';
      formatting.status = 'applied';
      const ownershipGeneration = app.documentGeneration;
      formattingAppliedTimer = setTimeout(() => {
        if (ownershipGeneration !== app.documentGeneration ||
            formatting.status !== 'applied') return;
        formatting.status = formatting.enabled ? 'collecting' : 'off';
        refreshFormattingState();
      }, 6000);
    } else if (kind === 'failed') {
      formatting.lastError = String(event.error || 'The formatting pass failed.');
      formatting.status = 'failed';
    } else if (kind === 'cancelled' || kind === 'complete') {
      formatting.status = formatting.enabled ? 'collecting' : 'off';
    } else {
      formatting.status = normalizeFormattingState(kind, formatting.enabled);
    }
  }
  refreshFormattingState();
  return true;
}

async function hydrateFormattingState() {
  if (formatting.supported === false) return null;
  const requestSeq = ++formattingSnapshotRequestSeq;
  const owner = {
    documentGeneration: app.documentGeneration,
    documentPath: capturedDocumentPath(app.model),
    documentToken: capturedDocumentToken(app.model),
  };
  const response = await fetchWithDeadline(
    '/api/format', {}, 'Formatting state request');
  if (requestSeq !== formattingSnapshotRequestSeq ||
      owner.documentGeneration !== app.documentGeneration) return null;
  if (response.status === 404 || response.status === 405) {
    formatting.supported = false;
    refreshFormattingState();
    return null;
  }
  const result = await readJsonResponse(
    response, 'Formatting state request', { allowHttpErrorBody: true });
  if (result.error) throw new Error(result.error);
  if (!validFormattingPayload(result, { snapshot: true })) {
    throw new Error('Formatting state request returned an invalid response.');
  }
  if (requestSeq !== formattingSnapshotRequestSeq ||
      owner.documentGeneration !== app.documentGeneration ||
      documentOwnershipMismatch(
        owner.documentPath,
        owner.documentToken,
        app.model || {
          path: app.documentPath,
          document_token: app.documentToken,
        },
      )) return null;
  applyFormattingSnapshot(result);
  return result;
}

async function setFormattingEnabled(enabled) {
  const desired = !!enabled;
  const button = $('format-toggle');
  const mutationSeq = ++formatting.mutationSeq;
  // Any read begun before this choice is now stale, even if the server happens
  // to deliver it after the POST acknowledgement.
  formattingSnapshotRequestSeq++;
  const previous = {
    enabled: formatting.enabled,
    status: formatting.status,
    lastError: formatting.lastError,
  };
  const owner = {
    desired,
    acknowledged: false,
    mutationSeq,
    documentGeneration: app.documentGeneration,
    documentPath: capturedDocumentPath(app.model),
    documentToken: capturedDocumentToken(app.model),
  };
  formattingToggleOwner = owner;
  button.disabled = true;
  formatting.enabled = desired;
  formatting.status = desired ? 'collecting' : 'off';
  refreshFormattingState(
    desired ? 'Turning AI formatting on…' : 'Turning AI formatting off…');
  try {
    const result = await post('/api/format', {
      enabled: desired,
      ...(owner.documentToken
        ? { expect_document_token: owner.documentToken }
        : {}),
    });
    if (mutationSeq !== formatting.mutationSeq ||
        owner.documentGeneration !== app.documentGeneration ||
        documentOwnershipMismatch(
          owner.documentPath,
          owner.documentToken,
          app.model || {
            path: app.documentPath,
            document_token: app.documentToken,
          },
        )) return;
    if (result.error) throw new Error(result.error);
    if (!validFormattingPayload(result, { snapshot: true }) ||
        result.enabled !== desired) {
      throw new Error('Scribe did not confirm the formatting setting.');
    }
    applyFormattingSnapshot(result);
  } catch (error) {
    if (mutationSeq !== formatting.mutationSeq ||
        owner.documentGeneration !== app.documentGeneration) return;
    // The server broadcasts the new state before replying. If only the HTTP
    // acknowledgement was lost, that matching live event is stronger evidence
    // than the transport failure and must not be overwritten by a false error.
    if (owner.acknowledged) {
      refreshFormattingState();
      return;
    }
    formatting.enabled = previous.enabled;
    formatting.status = 'failed';
    formatting.lastError = error && error.message || String(error);
    if (/\b404\b|not found|unknown route/i.test(formatting.lastError)) {
      formatting.supported = false;
    }
    refreshFormattingState();
  } finally {
    if (mutationSeq === formatting.mutationSeq) button.disabled = false;
    if (formattingToggleOwner === owner) formattingToggleOwner = null;
  }
}

function setWatchButtonState(state, detail) {
  const button = $('watch-toggle');
  if (!button) return;
  button.dataset.state = state;
  button.setAttribute('aria-pressed', String(watch.enabled));
  button.setAttribute('aria-label', watch.enabled
    ? 'Continuous watch is on'
    : 'Continuous watch is off');
  button.title = detail || (watch.enabled
    ? 'Armed. Review starts after 25 seconds of quiet. Alt+Shift+W reviews now.'
    : 'Off. No typing is captured and no screening model is running.');
}

function refreshWatchState() {
  if (watch.activeReviews.size) {
    return setWatchButtonState('reviewing', 'The separate read-only reviewer is checking your changes.');
  }
  if (!watch.enabled) return setWatchButtonState('off');
  if (watch.changes.size) return setWatchButtonState('capturing', 'Watching this change set. Review starts after 25 seconds of quiet.');
  setWatchButtonState('armed');
}

function storeWatchPreference() {
  watch.preference = watch.enabled;
  try { localStorage.setItem('scribe-watch', watch.enabled ? 'on' : 'off'); } catch (_) {}
}

async function hydrateWatchConsent() {
  const response = await fetchWithDeadline('/api/watch', {}, 'Watch state request');
  const result = await readJsonResponse(
    response, 'Watch state request', { allowHttpErrorBody: true });
  if (result.error) throw new Error(result.error);
  watch.enabled = result.enabled === true;
  storeWatchPreference();
  refreshWatchState();
  return result;
}

async function syncWatchConsent(desired = watch.enabled) {
  watch.consent = watch.consent
    .catch(() => {})
    .then(() => post('/api/watch/enabled', { enabled: !!desired }));
  const result = await watch.consent;
  if (result.error) throw new Error(result.error);
  return result;
}

async function setWatchEnabled(enabled) {
  const desired = !!enabled;
  const previous = watch.enabled;
  const button = $('watch-toggle');
  watch.targetEnabled = desired;
  button.disabled = true;
  setWatchButtonState(
    desired ? 'starting' : 'stopping',
    desired ? 'Turning continuous Watch on\u2026' : 'Turning continuous Watch off\u2026');
  try {
    await syncWatchConsent(desired);
    watch.enabled = desired;
    if (!watch.enabled) {
      clearTimeout(watch.timer);
      watch.timer = null;
      clearSidecarStatus('watch');
      watch.changes.clear();
      watch.recentChanges = [];
      watch.activeReviews.clear();
      try { sessionStorage.removeItem('scribe-watch-recent'); } catch (_) {}
      for (const el of app.nodes.values()) {
        el.classList.remove('watch-captured');
        el.classList.remove('watch-reviewing');
      }
    }
    storeWatchPreference();
    refreshWatchState();
  } catch (e) {
    watch.enabled = previous;
    storeWatchPreference();
    refreshWatchState();
    setWatchButtonState(
      button.dataset.state,
      `Could not turn Watch ${desired ? 'on' : 'off'}. ` +
      `Watch remains ${previous ? 'on' : 'off'}. ${e.message || String(e)}`);
  } finally {
    if (watch.targetEnabled === desired) watch.targetEnabled = null;
    button.disabled = false;
  }
}

function restartWatchTimer() {
  clearTimeout(watch.timer);
  const button = $('watch-toggle');
  if (button) {
    button.style.setProperty('--watch-quiet', `${WATCH_QUIET_MS}ms`);
    button.dataset.state = 'armed';
    void button.offsetWidth;
  }
  refreshWatchState();
  watch.timer = setTimeout(finishWatchCapture, WATCH_QUIET_MS);
}

function syncWatchChange(pid, after) {
  const change = watch.changes.get(pid);
  if (!change) return;
  change.after = after;
  if (change.before === change.after) watch.changes.delete(pid);
  const el = app.nodes.get(pid);
  if (el) applyParaDecorations(el, pid);
  if (!watch.changes.size) {
    clearTimeout(watch.timer);
    watch.timer = null;
  }
  refreshWatchState();
}

function pruneRecentWatchChanges(now = Date.now()) {
  const cutoff = now - WATCH_RECENT_MS;
  watch.recentChanges = watch.recentChanges
    .filter((change) => change.at >= cutoff)
    .slice(-60);
  try {
    if (watch.recentChanges.length) {
      sessionStorage.setItem('scribe-watch-recent', JSON.stringify(watch.recentChanges));
    } else {
      sessionStorage.removeItem('scribe-watch-recent');
    }
  } catch (_) {}
}

function recordRecentWatchChange(pid, before, after) {
  if (!watch.enabled || !pid || before === after) return;
  const at = Date.now();
  pruneRecentWatchChanges(at);
  watch.recentChanges.push({ pid, before, after, at });
  try {
    sessionStorage.setItem('scribe-watch-recent', JSON.stringify(watch.recentChanges));
  } catch (_) {}
}

function recentWatchBatch() {
  pruneRecentWatchChanges();
  const byPid = new Map();
  for (const change of watch.recentChanges) {
    const current = byPid.get(change.pid);
    if (!current) {
      byPid.set(change.pid, {
        pid: change.pid,
        before: change.before,
        after: change.after,
      });
    } else {
      current.after = change.after;
    }
  }
  return [...byPid.values()].filter((change) => change.before !== change.after);
}

function recordWatchInput(el, edit) {
  if (!watch.enabled || !el || !edit) return;
  clearSidecarStatus('watch');
  const pid = el.dataset.pid;
  let change = watch.changes.get(pid);
  if (!change) {
    change = { pid, before: edit.text, after: directText(el) };
    watch.changes.set(pid, change);
  } else {
    change.after = directText(el);
  }
  if (change.before === change.after) watch.changes.delete(pid);
  applyParaDecorations(el, pid);
  if (watch.changes.size) restartWatchTimer();
  else refreshWatchState();
}

async function finishWatchCapture(options = {}) {
  const manual = options && options.manual === true;
  const submittedDocumentGeneration = app.documentGeneration;
  const submittedDocumentToken = capturedDocumentToken(app.model);
  watch.timer = null;
  if (!watch.enabled || watch.finishing) return;
  if (!manual && !watch.changes.size) return;
  const owner = {
    documentGeneration: submittedDocumentGeneration,
    documentToken: submittedDocumentToken,
  };
  watch.finishing = true;
  watch.finishingOwner = owner;

  let batch = [];
  let pids = new Set();

  try {
    if (manual) {
      // The shortcut can land before the 650 ms autosave. Commit through the
      // guarded direct-edit path first so the reviewer sees only saved text.
      for (const pid of [...directEdits.keys()]) {
        const el = app.nodes.get(pid);
        if (el) await saveDirectEdit(el);
      }
    }
    if (watch.finishingOwner !== owner ||
        app.documentGeneration !== submittedDocumentGeneration) return;

    batch = watch.changes.size
      ? [...watch.changes.values()].map((c) => ({ ...c }))
      : recentWatchBatch();
    if (!batch.length) {
      setWatchButtonState('armed', 'Nothing new was typed since Watch was turned on.');
      return;
    }

    watch.changes.clear();
    pids = new Set(batch.map((c) => c.pid));
  for (const pid of pids) {
    const el = app.nodes.get(pid);
    if (el) {
      el.classList.remove('watch-captured');
      el.classList.add('watch-reviewing');
    }
  }

    // A quiet window also finalizes the paragraph currently under the caret.
    // This is the only automatic write, and it goes through the exact same
    // guarded direct-edit path as Enter or click-away.
    if (!manual) {
      for (const pid of pids) {
        if (directEdits.has(pid)) await saveDirectEdit(app.nodes.get(pid));
      }
    }
    if (watch.finishingOwner !== owner ||
        app.documentGeneration !== submittedDocumentGeneration) return;
    const reviewRequest = {
      quietMs: WATCH_QUIET_MS,
      changes: batch,
      manual,
    };
    if (submittedDocumentToken) {
      reviewRequest.expect_document_token = submittedDocumentToken;
    }
    const out = await post('/api/watch/review', reviewRequest);
    if (watch.finishingOwner !== owner ||
        app.documentGeneration !== submittedDocumentGeneration) return;
    if (out.error || !out.id) throw new Error(out.error || 'The watch reviewer did not accept the change set.');
    watch.activeReviews.set(out.id, new Set(out.pids || [...pids]));
    // A submitted batch starts a fresh rolling window. This prevents a second
    // shortcut press from paying to review the exact same saved change again.
    watch.recentChanges = [];
    try { sessionStorage.removeItem('scribe-watch-recent'); } catch (_) {}
  } catch (e) {
    if (watch.finishingOwner !== owner ||
        app.documentGeneration !== submittedDocumentGeneration) return;
    for (const pid of pids) {
      const el = app.nodes.get(pid);
      if (el) el.classList.remove('watch-reviewing');
    }
    setWatchButtonState('armed', e.message || String(e));
    renderSidecarStatus({
      lane: 'watch',
      pid: [...pids][0] || (batch[0] && batch[0].pid),
      text: e.message || String(e),
      error: true,
      duration: 12000,
    });
  } finally {
    if (watch.finishingOwner === owner) {
      watch.finishingOwner = null;
      watch.finishing = false;
      refreshWatchState();
    }
  }
}

function reviewRecentTypingNow() {
  if (!watch.enabled) {
    setWatchButtonState('off', 'Turn Watch on before requesting a screening review.');
    return Promise.resolve(false);
  }
  clearTimeout(watch.timer);
  watch.timer = null;
  return finishWatchCapture({ manual: true });
}

function onWatchEvent(event) {
  if (!event || !event.id) return;
  if (event.kind === 'queued' || event.kind === 'reviewing') {
    clearSidecarStatus('watch');
    const pids = new Set(event.pids || []);
    watch.activeReviews.set(event.id, pids);
    for (const pid of pids) {
      const el = app.nodes.get(pid);
      if (el) el.classList.add('watch-reviewing');
    }
  }
  if (event.kind === 'complete' || event.kind === 'failed' || event.kind === 'cancelled') {
    const pids = watch.activeReviews.get(event.id) || new Set(event.pids || []);
    watch.activeReviews.delete(event.id);
    for (const pid of pids) {
      const el = app.nodes.get(pid);
      if (el && !reviewContainsPid(pid)) el.classList.remove('watch-reviewing');
    }
    const coveredByNewerReview = [...pids].some((pid) => reviewContainsPid(pid));
    if (event.kind === 'failed' && watch.enabled && !coveredByNewerReview) {
      setWatchButtonState('armed', event.error || 'The watch review could not finish.');
      renderSidecarStatus({
        lane: 'watch',
        pid: [...pids][0],
        text: event.error || 'The review could not finish. Nothing was changed.',
        error: true,
        duration: 12000,
      });
    } else if (event.kind === 'complete' && event.timedOut && watch.enabled &&
               !coveredByNewerReview) {
      renderSidecarStatus({
        lane: 'watch',
        pid: [...pids][0],
        text: 'The review timed out. Nothing was changed.',
        error: true,
        duration: 12000,
      });
    } else if (event.kind === 'cancelled') {
      clearSidecarStatus('watch');
    }
  }
  refreshWatchState();
}

function cancelPredictionCapture(reason = 'cancelled by new typing') {
  const id = prediction.activeId;
  const grant = prediction.capture && prediction.capture.grant;
  clearTimeout(prediction.timer);
  prediction.timer = null;
  prediction.capture = null;
  prediction.seq++;
  renderPredictionPending(null);
  prediction.activeId = null;
  if (id || grant) {
    post('/api/predict/cancel', { id, grant, reason }).catch(() => {});
  }
}

function recordPredictionInput(el, edit) {
  if (!el || !edit || app.paused) return;
  clearSidecarStatus('continue');
  const p = paragraphModel(el.dataset.pid);
  if (!p || p.table) {
    cancelPredictionCapture('prediction is not offered inside a table');
    return;
  }

  if (openContinuation && openContinuation.status === 'open') {
    const old = openContinuation;
    renderContinuation({ ...old, status: 'dismissed' });
    post('/api/predict/dismiss', { id: old.id }).catch(() => {});
  }
  const priorGrant = prediction.capture && prediction.capture.grant;
  if (prediction.activeId || priorGrant) {
    const id = prediction.activeId;
    prediction.activeId = null;
    post('/api/predict/cancel', {
      id,
      grant: priorGrant,
      reason: 'cancelled by new typing',
    }).catch(() => {});
  }
  renderPredictionPending(null);

  clearTimeout(prediction.timer);
  const seq = ++prediction.seq;
  const now = Date.now();
  const capture = {
    id: `c${now.toString(36)}-${seq}`,
    pid: el.dataset.pid,
    before: edit.text,
    after: directText(el),
    documentToken: edit.documentToken || capturedDocumentToken(app.model),
    documentGeneration: app.documentGeneration,
  };
  prediction.capture = capture;
  prediction.lastInputAt = now;
  prediction.timer = setTimeout(() => requestPrediction(capture, seq), PREDICT_QUIET_MS);
}

async function requestPrediction(capture, seq) {
  prediction.timer = null;
  if (!capture || prediction.capture !== capture || prediction.seq !== seq ||
      app.paused || !app.hasDocument) return;
  // A sleeping laptop can wake with a very old browser timer. That is no longer
  // "recent use", so it must not launch a CLI process hours later.
  if (Date.now() - prediction.lastInputAt > PREDICT_QUIET_MS + 45000) return;

  const editing = directEdits.get(capture.pid);
  if (editing && editing.dirty) {
    await saveDirectEdit(app.nodes.get(capture.pid), { resume: true });
  }
  if (prediction.capture !== capture || prediction.seq !== seq) return;

  let current = paragraphModel(capture.pid);
  if (!current || current.text !== capture.after) {
    const model = await fetchModel();
    if (model) applyModel(model);
    current = paragraphModel(capture.pid);
  }
  if (!current || current.table || current.text !== capture.after) return;
  if (!capture.grant) return;

  prediction.requesting = true;
  let out;
  try {
    const predictionRequest = {
      capture_id: capture.id,
      pid: capture.pid,
      before: capture.before,
      after: capture.after,
      quietMs: PREDICT_QUIET_MS,
      grant: capture.grant,
    };
    if (capture.documentToken) {
      predictionRequest.expect_document_token = capture.documentToken;
    }
    out = await post('/api/predict', predictionRequest);
  } catch (_) {
    out = { error: 'Scribe is unavailable.' };
  } finally {
    prediction.requesting = false;
  }
  if (app.documentGeneration !== capture.documentGeneration) return;
  if (!out || out.error || !out.id) {
    // A lost response can race an accepted job's SSE event. In that case the
    // live event owns the UI; otherwise this exact typing capture must not fail
    // silently or leave an apparently armed grant behind.
    const acceptedByEvent = prediction.activeId ||
      (prediction.pending && prediction.pending.capture_id === capture.id);
    if (prediction.capture !== capture || prediction.seq !== seq || acceptedByEvent) return;
    prediction.capture = null;
    prediction.seq++;
    renderPredictionPending(null);
    renderSidecarStatus({
      lane: 'continue',
      pid: capture.pid,
      model: modelPool.automatic.continue,
      text: out && out.error
        ? out.error
        : 'The next-paragraph request could not start. Keep typing to try again.',
      error: true,
      duration: 12000,
    });
    if (capture.grant) {
      post('/api/predict/cancel', {
        grant: capture.grant,
        reason: 'the predictive request could not start',
      }).catch(() => {});
    }
    return;
  }
  if (prediction.capture !== capture || prediction.seq !== seq) {
    post('/api/predict/cancel', {
      id: out.id,
      reason: 'cancelled by newer typing',
    }).catch(() => {});
    return;
  }
  prediction.activeId = out.id;
}

// --------------------------------------------------------------------------
// chrome
// --------------------------------------------------------------------------

function setDocName(p) {
  const documentPath = String(p);
  $('doc-name').textContent = documentPath.split(/[\\/]/).pop();
  $('doc-name').title = documentPath;
  app.documentPath = documentPath;
  app.hasDocument = true;
  // A write-back handle only applies to the document it was opened for. If the
  // active document is now a different one, drop it so Save cannot overwrite the
  // wrong file; the next picker-open re-establishes it.
  if (originalFileHandle && documentPath !== originalFileHandlePath) {
    originalFileHandle = null;
    originalFileHandlePath = null;
  }
  updateRevision();
}

function updateRevision() {
  const el = $('rev');
  const detail = $('edit-detail');
  updateSaveButton();
  el.hidden = !app.hasDocument;
  el.classList.toggle('edit-error', !!(app.editStatus && app.editStatus.error));
  if (app.editStatus) {
    el.textContent = app.editStatus.text;
    el.title = app.editStatus.title || app.editStatus.text;
    if (detail) {
      const explanation = String(app.editStatus.title || '').trim();
      detail.textContent = explanation;
      detail.title = explanation;
      detail.hidden = !explanation || explanation === app.editStatus.text;
    }
    return;
  }
  el.textContent = `revision ${app.rev}`;
  el.title = app.rev === 0
    ? 'Document revision 0. No Scribe edits have been applied yet.'
    : `Document revision ${app.rev}. It advances after each accepted edit or undo.`;
  if (detail) {
    detail.textContent = '';
    detail.title = '';
    detail.hidden = true;
  }
}

function setEditStatus(text, { error = false, title = '', clearAfter = 0 } = {}) {
  clearTimeout(app.editStatusTimer);
  app.editStatus = text ? { text, error, title } : null;
  updateRevision();
  if (text && clearAfter) {
    app.editStatusTimer = setTimeout(() => {
      app.editStatus = null;
      updateRevision();
    }, clearAfter);
  }
}

function paragraphModel(pid) {
  return app.model && app.model.paragraphs.find((p) => p.pid === pid);
}

function directText(el) {
  // contenteditable can represent a pasted line break as a div or br even in
  // plaintext mode. A Word paragraph cannot contain a paragraph break, so keep
  // this intentionally basic and fold any such breaks into spaces.
  return String(el.innerText == null ? el.textContent : el.innerText)
    .replace(/\r/g, '').replace(/\n+/g, ' ');
}

function caretOffset(el) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !el.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

function restoreCaret(el, offset) {
  const selection = window.getSelection();
  if (!selection || offset == null) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let node = walker.nextNode();
  while (node && remaining > node.nodeValue.length) {
    remaining -= node.nodeValue.length;
    node = walker.nextNode();
  }
  const range = document.createRange();
  if (node) range.setStart(node, Math.min(remaining, node.nodeValue.length));
  else range.selectNodeContents(el), range.collapse(false);
  if (node) range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function collapsedCaretOffset(el) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed ||
      !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) {
    return null;
  }
  return caretOffset(el);
}

function paragraphBoundaryMerge(el, key) {
  if (!el || paragraphMerge || (key !== 'Backspace' && key !== 'Delete')) return null;
  const offset = collapsedCaretOffset(el);
  if (offset == null) return null;
  const textLength = String(el.textContent || '').length;
  if ((key === 'Backspace' && offset !== 0) ||
      (key === 'Delete' && offset !== textLength)) return null;

  const currentIndex = app.order.indexOf(el.dataset.pid);
  const otherIndex = key === 'Backspace' ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || otherIndex < 0 || otherIndex >= app.order.length) return null;

  const firstPid = key === 'Backspace' ? app.order[otherIndex] : app.order[currentIndex];
  const secondPid = key === 'Backspace' ? app.order[currentIndex] : app.order[otherIndex];
  const firstEl = app.nodes.get(firstPid);
  const secondEl = app.nodes.get(secondPid);
  if (!firstEl || !secondEl) return null;
  if (!app.paragraphMergeSupported) {
    return {
      blocked: true,
      status: 'restart Scribe to merge paragraphs',
      reason: 'Paragraph merging will be available after Scribe is restarted. Your current session was left untouched.',
    };
  }
  if (firstEl.parentElement !== secondEl.parentElement) {
    return {
      blocked: true,
      reason: 'Paragraphs in different table cells or document regions cannot be merged here.',
    };
  }
  return { firstPid, secondPid, firstEl, secondEl };
}

function releaseParagraphMerge(merge) {
  if (paragraphMerge !== merge) return false;
  paragraphMerge = null;
  setParagraphMergeControlsLocked(false);
  for (const pid of [merge.firstPid, merge.secondPid]) {
    const el = app.nodes.get(pid);
    if (!el) continue;
    el.classList.remove('saving');
    setParagraphEditability(el);
  }
  return true;
}

function reportRetiredParagraphMerge(reason) {
  const cause = String(
    reason || 'the active document changed during the merge',
  ).replace(/[.\s]+$/, '');
  setEditStatus('paragraphs not merged \u00b7 typing preserved', {
    error: true,
    title:
      `The paragraphs were not merged because ${cause}. ` +
      'Your exact typing is preserved in copy-only recovery and was not inserted into the active document.',
  });
}

function invalidateParagraphMergeForDocumentOpen() {
  app.documentGeneration++;
  const merge = paragraphMerge;
  if (!merge) return;
  archiveMergeDrafts(
    merge,
    'document opened while paragraphs were merging',
  );
  releaseParagraphMerge(merge);
  reportRetiredParagraphMerge(
    'the document changed while the merge was waiting for confirmation',
  );
  // An opened event owns the next model and clears all page-local drafts in
  // flushBatch. Do not let the abandoned request's eventual response restore
  // text from the previous file into that new ownership boundary.
  setWritingFocus(false);
}

function paragraphMergeOwnsDocument(merge, model = null) {
  if (paragraphMerge !== merge ||
      merge.documentGeneration !== app.documentGeneration) return false;
  const modelPath = model && typeof model.path === 'string'
    ? model.path
    : null;
  const modelToken = capturedDocumentToken(model);
  const pathMatches = !merge.documentPath || !modelPath ||
    String(merge.documentPath) === String(modelPath);
  const tokenMatches = !merge.documentToken || !modelToken ||
    merge.documentToken === modelToken;
  return pathMatches && tokenMatches;
}

function captureMergeDraft(pid, activePid, caret) {
  const paragraph = paragraphModel(pid);
  const el = app.nodes.get(pid);
  const edit = directEdits.get(pid);
  if (!paragraph || !el) return null;
  const dirty = !!(edit && edit.dirty);
  const localText = dirty ? directText(el) : paragraph.text;
  return {
    pid,
    text: dirty ? edit.text : paragraph.text,
    hash: dirty ? edit.hash : paragraph.hash,
    documentToken: dirty
      ? edit.documentToken
      : capturedDocumentToken(app.model),
    dirty,
    localText,
    active: pid === activePid,
    caret: pid === activePid ? caret : null,
    stagedConflict: !!(edit && edit.stagedConflict),
  };
}

function finishParagraphMerge(merge, model) {
  // The caller must first reconcile the confirmation model. Silently applying
  // and then ignoring a {stale:true} result here could announce a merge after a
  // newer remote undo had already restored the second paragraph.
  if (!paragraphMergeOwnsDocument(merge, model) ||
      !model || app.model !== model) return false;
  directEdits.delete(merge.firstPid);
  directEdits.delete(merge.secondPid);
  app.recoveryDrafts.delete(merge.secondPid);
  renderRecoveryDrafts();

  // A merge is one human structural change. If Watch is armed, anchor the
  // resulting text to the surviving paragraph and discard the removed pid.
  watch.changes.delete(merge.firstPid);
  watch.changes.delete(merge.secondPid);
  if (watch.enabled && merge.first.text !== merge.mergedText) {
    watch.changes.set(merge.firstPid, {
      pid: merge.firstPid,
      before: merge.first.text,
      after: merge.mergedText,
    });
    recordRecentWatchChange(merge.firstPid, merge.first.text, merge.mergedText);
    restartWatchTimer();
  } else {
    refreshWatchState();
  }

  releaseParagraphMerge(merge);
  const survivor = app.nodes.get(merge.firstPid);
  if (survivor) {
    survivor.classList.remove('saving');
    applyParaDecorations(survivor, merge.firstPid);
    if (!app.paused) {
      setParagraphEditability(survivor);
      survivor.focus({ preventScroll: true });
      beginDirectEdit(survivor);
      restoreCaret(survivor, merge.joinOffset);
    }
  }
  setWritingFocus(!!survivor && !app.paused);
  setEditStatus('paragraphs merged', { clearAfter: 1800 });
  return true;
}

async function mergeParagraphsAtBoundary(request, activeEl) {
  if (!request || request.blocked || paragraphMerge) return;
  const first = captureMergeDraft(
    request.firstPid,
    activeEl.dataset.pid,
    collapsedCaretOffset(activeEl),
  );
  const second = captureMergeDraft(
    request.secondPid,
    activeEl.dataset.pid,
    collapsedCaretOffset(activeEl),
  );
  if (!first || !second) return;
  if (first.stagedConflict || second.stagedConflict) {
    setEditStatus('paragraphs not merged', {
      error: true,
      title: 'One paragraph changed elsewhere. Your typing is preserved; resolve that conflict before merging.',
      clearAfter: 5000,
    });
    return;
  }
  const currentDocumentToken = capturedDocumentToken(app.model);
  const dirtyDrafts = [first, second].filter((draft) => draft.dirty);
  const dirtyDocumentTokens = dirtyDrafts.map((draft) =>
    typeof draft.documentToken === 'string' && draft.documentToken.trim()
      ? draft.documentToken
      : null);
  const uniqueDirtyDocumentTokens = new Set(
    dirtyDocumentTokens.filter(Boolean),
  );
  const documentConflict = uniqueDirtyDocumentTokens.size > 1 ||
    (currentDocumentToken && uniqueDirtyDocumentTokens.size === 1 &&
     !uniqueDirtyDocumentTokens.has(currentDocumentToken));
  if (documentConflict) {
    const reason =
      'The document changed ownership while you were typing. Your exact text is preserved and was not merged.';
    for (const draft of dirtyDrafts) {
      const edit = directEdits.get(draft.pid);
      const el = app.nodes.get(draft.pid);
      if (edit) {
        edit.stagedConflict = true;
        edit.conflictReason = reason;
      }
      if (el) el.classList.add('editing', 'dirty', 'save-error');
    }
    setEditStatus('paragraphs not merged \u00b7 typing preserved', {
      error: true,
      title: reason,
      clearAfter: 6000,
    });
    return;
  }
  if (request.firstEl.classList.contains('saving') ||
      request.secondEl.classList.contains('saving')) {
    setEditStatus('finish saving, then merge', {
      error: true,
      title: 'An adjacent paragraph is still saving. Try the boundary key again in a moment.',
      clearAfter: 3000,
    });
    return;
  }
  if (pendingUndoAcknowledgement ||
      $('doc-name').getAttribute('aria-busy') === 'true') {
    setEditStatus('finish the current document action first', {
      error: true,
      clearAfter: 3000,
    });
    return;
  }

  const drafts = [first, second];
  const mergeDocumentToken = dirtyDrafts.length
    ? (dirtyDocumentTokens.length &&
       dirtyDocumentTokens.every((token) =>
         token && token === dirtyDocumentTokens[0])
      ? dirtyDocumentTokens[0]
      : null)
    : currentDocumentToken;
  const merge = {
    ...request,
    first,
    second,
    drafts,
    mergedText: first.localText + second.localText,
    joinOffset: first.localText.length,
    documentGeneration: app.documentGeneration,
    documentPath: app.model && typeof app.model.path === 'string'
      ? app.model.path
      : app.documentPath,
    documentToken: mergeDocumentToken,
    startedRev: app.model && Number.isSafeInteger(app.model.rev)
      ? app.model.rev
      : app.rev,
  };
  paragraphMerge = merge;
  setParagraphMergeControlsLocked(true);
  for (const draft of drafts) {
    const edit = directEdits.get(draft.pid);
    if (edit) clearTimeout(edit.saveTimer);
    directEdits.delete(draft.pid);
    const el = app.nodes.get(draft.pid);
    if (el) {
      el.classList.remove('editing', 'dirty', 'save-error');
      el.classList.add('saving');
      el.setAttribute('contenteditable', 'false');
    }
  }
  if (prediction.capture &&
      (prediction.capture.pid === merge.firstPid ||
       prediction.capture.pid === merge.secondPid)) {
    cancelPredictionCapture('paragraphs were merged');
  }
  setWritingFocus(true);
  setEditStatus('merging\u2026');

  let out = null;
  let failure = null;
  try {
    const op = {
      type: 'merge',
      pid: merge.firstPid,
      first_pid: merge.firstPid,
      second_pid: merge.secondPid,
      first_text: first.localText,
      second_text: second.localText,
      expect_hash: first.hash,
      expect_first_hash: first.hash,
      expect_second_hash: second.hash,
      why: 'merged paragraphs directly',
    };
    if (merge.documentToken) {
      op.expect_document_token = merge.documentToken;
    }
    out = await post('/api/edit', {
      who: 'human',
      op,
    });
    const result = out && out.result;
    if (out.error) throw new Error(out.error);
    if (out.ok !== true || !result ||
        result.pid !== merge.firstPid ||
        result.removed_pid !== merge.secondPid ||
        result.after !== merge.mergedText ||
        typeof result.hash !== 'string' ||
        typeof result.start !== 'number' ||
        typeof result.end !== 'number') {
      throw new Error('Scribe did not confirm that the paragraphs were merged.');
    }
  } catch (error) {
    failure = error;
  }

  if (!paragraphMergeOwnsDocument(merge)) {
    if (paragraphMerge === merge) {
      archiveMergeDrafts(
        merge,
        'document ownership changed before the merge could be confirmed',
      );
      releaseParagraphMerge(merge);
      reportRetiredParagraphMerge(
        'document ownership changed before the merge could be confirmed',
      );
      setWritingFocus(false);
    }
    return;
  }

  // Reconcile from the document even after a nominal failure. The server may
  // have committed atomically and then lost only the HTTP acknowledgement.
  const fetchedModel = await fetchModel();
  if (!paragraphMergeOwnsDocument(merge, fetchedModel)) {
    // A path change can become visible through /api/doc before its opened SSE
    // frame is delivered. Retire the old merge first so applying that model
    // cannot make its copied paragraph ids editable under the old draft.
    if (paragraphMerge === merge) {
      archiveMergeDrafts(
        merge,
        'document ownership changed before the merge could be confirmed',
      );
      releaseParagraphMerge(merge);
      reportRetiredParagraphMerge(
        'document ownership changed before the merge could be confirmed',
      );
      setWritingFocus(false);
      if (fetchedModel) reconcileFetchedModel(fetchedModel);
    }
    return;
  }
  let currentModel = reconcileFetchedModel(fetchedModel).model;
  // A matching SSE refresh can finish while this request's own refresh fails.
  // Accept that already-applied model only if its revision advanced beyond the
  // model from which the boundary operation was captured.
  if (!currentModel && app.model &&
      Number.isSafeInteger(app.model.rev) &&
      app.model.rev > merge.startedRev) {
    currentModel = app.model;
  }
  if (!paragraphMergeOwnsDocument(merge, currentModel)) {
    archiveMergeDrafts(
      merge,
      'document ownership changed before the merge could be confirmed',
    );
    releaseParagraphMerge(merge);
    reportRetiredParagraphMerge(
      'document ownership changed before the merge could be confirmed',
    );
    setWritingFocus(false);
    return;
  }
  const authoritativeFirst = currentModel &&
    currentModel.paragraphs.find((p) => p.pid === merge.firstPid);
  const authoritativeSecond = currentModel &&
    currentModel.paragraphs.find((p) => p.pid === merge.secondPid);
  const committed = !!(
    authoritativeFirst && !authoritativeSecond &&
    authoritativeFirst.text === merge.mergedText
  );
  if (committed && finishParagraphMerge(merge, currentModel)) {
    return;
  }

  releaseParagraphMerge(merge);
  restoreDirectEditsAfterRebuild(
    drafts,
    currentModel || app.model,
    {
      replace: false,
      autoSave: false,
      forceConflict: !currentModel,
      conflictReason: !currentModel
        ? 'Scribe could not confirm the document after the merge request. Your typing is preserved and will not be saved until the document is reconciled.'
        : '',
    },
  );
  for (const pid of [merge.firstPid, merge.secondPid]) {
    const el = app.nodes.get(pid);
    if (el) {
      el.classList.remove('saving');
      setParagraphEditability(el);
    }
  }
  setEditStatus('paragraphs not merged \u00b7 typing preserved', {
    error: true,
    title: failure && (failure.message || String(failure)) ||
      'The document could not be refreshed after the merge request.',
    clearAfter: 6000,
  });
}

function requestParagraphBoundaryMerge(el, key) {
  if (paragraphMerge && el &&
      (el.dataset.pid === paragraphMerge.firstPid ||
       el.dataset.pid === paragraphMerge.secondPid) &&
      (key === 'Backspace' || key === 'Delete')) {
    return true;
  }
  const request = paragraphBoundaryMerge(el, key);
  if (!request) return false;
  if (request.blocked) {
    setEditStatus(request.status || 'paragraphs not merged', {
      error: true,
      title: request.reason,
      clearAfter: 4000,
    });
    return true;
  }
  mergeParagraphsAtBoundary(request, el);
  return true;
}

function setWritingFocus(active) {
  // More than one paragraph can own editing state briefly while a save from
  // the previous paragraph is in flight. Never let that older save reveal the
  // floating chrome over the paragraph the human is editing now.
  document.body.dataset.writing = active || directEdits.size ? 'true' : 'false';
}

function beginDirectEdit(el) {
  if (app.paused || paragraphMergeOwns(el.dataset.pid) ||
      directEdits.has(el.dataset.pid)) return;
  const p = paragraphModel(el.dataset.pid);
  if (!p) return;
  directEdits.set(p.pid, {
    text: p.text,
    hash: p.hash,
    documentToken: capturedDocumentToken(app.model),
    documentPath: capturedDocumentPath(app.model),
    dirty: false,
  });
  el.classList.add('editing');
  setWritingFocus(true);
}

function cancelDirectEdit(el) {
  const edit = directEdits.get(el.dataset.pid);
  if (!edit) return;
  if (prediction.capture && prediction.capture.pid === el.dataset.pid) {
    cancelPredictionCapture('typing was cancelled');
  }
  clearTimeout(edit.saveTimer);
  directEdits.delete(el.dataset.pid);
  setWritingFocus(false);
  const p = paragraphModel(el.dataset.pid);
  if (p) {
    fillPara(el, p, app.pendingHighlight.get(p.pid));
    syncWatchChange(p.pid, p.text);
  }
  setEditStatus(null);
  el.blur();
  if (app.pendingAssist && app.pendingAssist.anchor_pid === el.dataset.pid) {
    const note = app.pendingAssist;
    const announce = app.pendingAssistAnnounce;
    app.pendingAssist = null;
    app.pendingAssistAnnounce = false;
    renderAssist(note, announce);
  }
  if (app.pendingContinuation &&
      app.pendingContinuation.anchor_pid === el.dataset.pid) {
    const continuation = app.pendingContinuation;
    const announce = app.pendingContinuationAnnounce;
    app.pendingContinuation = null;
    app.pendingContinuationAnnounce = false;
    renderContinuation(continuation, announce);
  }
}

function drainPendingSidecars(pid) {
  if (app.pendingAssist && app.pendingAssist.anchor_pid === pid) {
    const note = app.pendingAssist;
    const announce = app.pendingAssistAnnounce;
    app.pendingAssist = null;
    app.pendingAssistAnnounce = false;
    renderAssist(note, announce);
  }
  if (app.pendingContinuation &&
      app.pendingContinuation.anchor_pid === pid) {
    const continuation = app.pendingContinuation;
    const announce = app.pendingContinuationAnnounce;
    app.pendingContinuation = null;
    app.pendingContinuationAnnounce = false;
    renderContinuation(continuation, announce);
  }
}

function scheduleDirectSave(el, edit) {
  clearTimeout(edit.saveTimer);
  edit.saveTimer = setTimeout(() => {
    if (directEdits.get(el.dataset.pid) === edit && edit.dirty) {
      saveDirectEdit(el, { resume: true });
    }
  }, DIRECT_SAVE_MS);
}

async function saveDirectEdit(el, { resume = false } = {}) {
  const pid = el.dataset.pid;
  const edit = directEdits.get(pid);
  if (!edit) return { saved: false, unchanged: true };
  const text = directText(el);
  const resumeAt = resume && document.activeElement === el ? caretOffset(el) : null;
  clearTimeout(edit.saveTimer);
  if (edit.stagedConflict) {
    // The rebuilt model proved that the original expect_hash is stale. Keep
    // the local draft editable, but never silently rebase it onto newer server
    // text: that would turn the hash guard into a last-writer-wins overwrite.
    edit.dirty = true;
    el.classList.add('editing', 'dirty', 'save-error');
    el.classList.remove('saving');
    setParagraphEditability(el);
    setWritingFocus(true);
    setEditStatus('typing preserved \u00b7 not saved', {
      error: true,
      title: edit.conflictReason ||
        'This paragraph changed elsewhere. Your typing is preserved; press Escape to discard it after copying or reviewing it.',
    });
    return { saved: false, conflict: true };
  }
  directEdits.delete(pid);
  setWritingFocus(resumeAt != null);
  let savedOk = false;
  const attemptedDraft = {
    pid,
    text: edit.text,
    hash: edit.hash,
    documentToken: edit.documentToken,
    documentPath: edit.documentPath,
    dirty: true,
    localText: text,
    active: resumeAt != null,
    caret: resumeAt,
  };
  const predictionCapture = prediction.capture &&
    prediction.capture.pid === pid ? prediction.capture : null;

  if (!edit.dirty || text === edit.text) {
    const p = paragraphModel(pid);
    if (p) fillPara(el, p, app.pendingHighlight.get(pid));
    setEditStatus(null);
    if (resumeAt != null && !app.paused) {
      el.focus({ preventScroll: true });
      restoreCaret(el, resumeAt);
      beginDirectEdit(el);
    } else {
      setWritingFocus(false);
    }
    drainPendingSidecars(pid);
    return { saved: false, unchanged: true };
  }

  el.classList.remove('editing', 'dirty');
  el.classList.add('saving');
  el.setAttribute('contenteditable', 'false');
  setEditStatus('saving\u2026');

  try {
    const op = {
      type: 'set_text',
      pid,
      text,
      expect_hash: edit.hash,
      why: 'typed directly',
      utterance: `direct-${Date.now()}`,
    };
    if (edit.documentToken) {
      op.expect_document_token = edit.documentToken;
    }
    const out = await post('/api/edit', {
      who: 'human',
      op,
    });
    if (out.error) throw new Error(out.error);
    if (out.ok !== true || !out.result) {
      throw new Error('Scribe did not confirm that the paragraph was saved.');
    }
    if (out.rev != null) app.rev = out.rev;
    if (predictionCapture && prediction.capture === predictionCapture &&
        out.result && typeof out.result.after === 'string') {
      predictionCapture.after = out.result.after;
      predictionCapture.grant = out.prediction_grant && out.prediction_grant.token || null;
    } else if (out.prediction_grant && out.prediction_grant.token) {
      post('/api/predict/cancel', {
        grant: out.prediction_grant.token,
        reason: 'typing capture was superseded before save completed',
      }).catch(() => {});
    }
    recordRecentWatchChange(pid, edit.text, text);
    syncWatchChange(pid, text);
    savedOk = true;
    if (resumeAt != null) {
      const model = await fetchModel();
      if (model) applyModel(model);
    }
    setEditStatus(null);
    return { saved: true, out };
  } catch (e) {
    if (prediction.capture && prediction.capture.pid === pid) {
      cancelPredictionCapture('the paragraph was not saved');
    }
    const fetchedModel = await fetchModel();
    if (fetchedModel && documentOwnershipMismatch(
      edit.documentPath,
      edit.documentToken,
      fetchedModel,
    )) {
      archiveDetachedDraft(
        attemptedDraft,
        edit.documentPath || activeDocumentSource(),
        'document ownership changed while the paragraph was saving',
      );
      renderRecoveryDrafts();
      reconcileFetchedModel(fetchedModel);
      setEditStatus('typing preserved \u00b7 not saved', {
        error: true,
        title: 'The active document changed while this paragraph was saving. Your exact typing is available as a copy-only recovery draft.',
        clearAfter: 6000,
      });
      return { saved: false, ownershipChanged: true };
    }
    const currentModel = reconcileFetchedModel(fetchedModel).model;
    const restoreModel = currentModel || app.model;
    if (!restoreModel || documentOwnershipMismatch(
      edit.documentPath,
      edit.documentToken,
      restoreModel,
    )) {
      archiveDetachedDraft(
        attemptedDraft,
        edit.documentPath || activeDocumentSource(),
        !restoreModel
          ? 'document ownership could not be confirmed after the save failed'
          : 'document ownership changed while the paragraph was saving',
      );
      renderRecoveryDrafts();
      setEditStatus('typing preserved \u00b7 not saved', {
        error: true,
        title: !restoreModel
          ? 'Scribe could not confirm which document is active. Your exact typing is available as a copy-only recovery draft.'
          : 'The active document changed while this paragraph was saving. Your exact typing is available as a copy-only recovery draft.',
        clearAfter: 6000,
      });
      return {
        saved: false,
        detached: true,
        ownershipChanged: !!restoreModel,
        noAuthoritativeModel: !restoreModel,
      };
    }
    const authoritative = currentModel &&
      currentModel.paragraphs.find((p) => p.pid === pid);
    // A transport failure can arrive after the save committed. Exact
    // authoritative content is stronger evidence than the missing response.
    if (authoritative && authoritative.text === text) {
      recordRecentWatchChange(pid, edit.text, text);
      syncWatchChange(pid, text);
      savedOk = true;
      setEditStatus(null);
      return { saved: true, reconciled: true };
    }
    restoreDirectEditsAfterRebuild(
      [attemptedDraft],
      restoreModel,
      {
        replace: false,
        autoSave: false,
        forceConflict: !currentModel,
        conflictReason: !currentModel
          ? 'Scribe could not refresh the document after the save request. Your exact typing is preserved and will not be saved until the document is reconciled.'
          : '',
      },
    );
    if (authoritative) syncWatchChange(pid, authoritative.text);
    const current = app.nodes.get(pid);
    if (current) current.classList.add('save-error');
    setTimeout(() => current && current.classList.remove('save-error'), 1800);
    setEditStatus('typing preserved \u00b7 not saved', {
      error: true,
      title: e.message || String(e),
      clearAfter: 6000,
    });
    return { saved: false, error: e.message || String(e) };
  } finally {
    const current = app.nodes.get(pid);
    if (current) {
      current.classList.remove('saving');
      setParagraphEditability(current);
      if (savedOk && resumeAt != null && !app.paused) {
        current.focus({ preventScroll: true });
        restoreCaret(current, resumeAt);
        beginDirectEdit(current);
      }
    }
    if (!(savedOk && resumeAt != null && !app.paused)) setWritingFocus(false);
    drainPendingSidecars(pid);
  }
}

// The document-open entry point. Prefer the File System Access API so we can
// later write back over the very file the human chose; fall back to the plain
// file input where it is unavailable or the picker throws.
async function openDocumentDialog() {
  if (paragraphMerge) {
    setEditStatus('finish merging before opening another document', {
      error: true,
      clearAfter: 3000,
    });
    return;
  }
  if ($('doc-name').getAttribute('aria-busy') === 'true') return;
  if (!FS_ACCESS) { $('doc-file').click(); return; }
  let handle;
  try {
    [handle] = await window.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [{
        description: 'Word document',
        accept: {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            ['.docx'],
        },
      }],
    });
  } catch (e) {
    // The user dismissing the picker is not an error; anything else falls back.
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
    $('doc-file').click();
    return;
  }
  let file;
  try {
    file = await handle.getFile();
  } catch (_) {
    setEditStatus('could not read that file', { error: true, clearAfter: 3000 });
    return;
  }
  await uploadDocument(file, handle);
}

function updateSaveButton() {
  const btn = $('save-original');
  if (!btn) return;
  btn.hidden = !app.hasDocument;
  if (btn.hidden) return;
  // Reflect whether Save can overwrite the real file or only download a copy.
  if (originalFileHandle) {
    btn.title = 'Save the current version over the original file you opened';
  } else {
    btn.title =
      'Download the current version (this browser cannot write back to the original file)';
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'document.docx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function confirmSaveDialog(name, canWriteBack) {
  const dialog = $('save-dialog');
  const body = $('save-dialog-body');
  const confirm = $('save-dialog-confirm');
  if (!dialog || typeof dialog.showModal !== 'function') {
    // No <dialog> support: fall back to a native confirm so Save still works.
    const message = canWriteBack
      ? `This overwrites the original file "${name}" on your computer with the current version. Continue?`
      : `Download the current version as "${name}" so you can save over the original yourself?`;
    return Promise.resolve(window.confirm(message));
  }
  body.innerHTML = '';
  if (canWriteBack) {
    body.append(
      'This overwrites the original file ',
      Object.assign(document.createElement('strong'), { textContent: name }),
      ' on your computer with the current version. This cannot be undone.',
    );
    confirm.textContent = 'save over original';
  } else {
    body.append(
      'This browser cannot write back to the file you opened. Scribe will download the current version as ',
      Object.assign(document.createElement('strong'), { textContent: name }),
      ' so you can save over the original yourself.',
    );
    confirm.textContent = 'download';
  }
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

async function fetchCurrentDocumentBlob() {
  const r = await fetchWithDeadline('/api/document', { cache: 'no-store' },
    'Document save');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error || ''; } catch (_) {}
    throw new Error(detail || `Could not read the current document (HTTP ${r.status}).`);
  }
  return r.blob();
}

async function saveOverOriginal() {
  if (!app.hasDocument || !app.documentPath) return;
  const btn = $('save-original');
  if (btn && btn.dataset.state === 'saving') return;
  const name = String(app.documentPath).split(/[\\/]/).pop();
  const canWriteBack = !!originalFileHandle;
  const confirmed = await confirmSaveDialog(name, canWriteBack);
  if (!confirmed) return;

  if (btn) { btn.dataset.state = 'saving'; btn.textContent = 'saving…'; }
  setEditStatus(canWriteBack ? 'saving over original…' : 'downloading…');
  try {
    if (canWriteBack) {
      // Ask for write permission first, while the click gesture is still live,
      // then fetch the bytes and stream them into the file.
      if (typeof originalFileHandle.requestPermission === 'function') {
        let perm = 'granted';
        if (typeof originalFileHandle.queryPermission === 'function') {
          perm = await originalFileHandle.queryPermission({ mode: 'readwrite' });
        }
        if (perm !== 'granted') {
          perm = await originalFileHandle.requestPermission({ mode: 'readwrite' });
        }
        if (perm !== 'granted') throw new Error('permission-denied');
      }
      const blob = await fetchCurrentDocumentBlob();
      const writable = await originalFileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      if (btn) { btn.dataset.state = 'saved'; btn.textContent = 'saved'; }
      setEditStatus('saved over original', { clearAfter: 2600 });
    } else {
      const blob = await fetchCurrentDocumentBlob();
      downloadBlob(blob, name);
      if (btn) { btn.dataset.state = 'saved'; btn.textContent = 'saved'; }
      setEditStatus('downloaded latest version', { clearAfter: 2600 });
    }
  } catch (e) {
    if (e && e.message === 'permission-denied') {
      setEditStatus('save cancelled · permission not granted',
        { error: true, clearAfter: 3500 });
    } else if (canWriteBack) {
      // Writing back failed (file moved, permission revoked). Offer the copy.
      try {
        const blob = await fetchCurrentDocumentBlob();
        downloadBlob(blob, name);
        setEditStatus('could not write to original · downloaded a copy instead',
          { error: true, clearAfter: 4500 });
      } catch (_) {
        setEditStatus('save failed', { error: true, clearAfter: 3500 });
      }
    } else {
      setEditStatus('save failed', { error: true, clearAfter: 3500 });
    }
  } finally {
    if (btn) {
      setTimeout(() => {
        delete btn.dataset.state;
        btn.textContent = 'save';
      }, 1600);
    }
  }
}

async function uploadDocument(file, handle = null) {
  if (paragraphMerge) {
    setEditStatus('finish merging before opening another document', {
      error: true,
      clearAfter: 3000,
    });
    return;
  }
  const button = $('doc-name');
  const requestSeq = ++uploadRequestSeq;
  const submittedGeneration = app.documentGeneration;
  const previous = { text: button.textContent, title: button.title };
  let opened = false;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'opening\u2026';
  button.title = file.name;
  try {
    const r = await fetchWithDeadline('/api/upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x-scribe-filename': encodeURIComponent(file.name),
      },
      body: file,
    }, 'Document upload');
    const out = await readJsonResponse(r, 'Document upload', { allowHttpErrorBody: true });
    if (out.error) throw new Error(out.error || `Could not open ${file.name}.`);
    if (requestSeq !== uploadRequestSeq) return;
    if (!out || typeof out.path !== 'string' || !out.path ||
        !Number.isFinite(out.rev) ||
        typeof out.document_token !== 'string' ||
        !out.document_token.trim()) {
      throw new Error('Document upload returned invalid ownership information.');
    }

    // A later Open event is stronger than this earlier upload response. The
    // matching Open for this upload, however, may have beaten the HTTP response
    // and is intentionally idempotent.
    const generationMoved = app.documentGeneration !== submittedGeneration;
    const hasCurrentOwnership = !!(
      capturedDocumentPath(app.model) && capturedDocumentToken(app.model)
    );
    if (generationMoved && hasCurrentOwnership &&
        !documentOwnershipMatches(out)) {
      return;
    }
    if (!documentOwnershipMatches(out)) {
      retireClientDocumentOwnership(
        'a document upload opened a different active document',
      );
    }
    app.documentToken = out.document_token;
    app.rev = out.rev;
    setDocName(out.path);
    opened = true;
    // Adopt (or clear) the write-back handle for the document that just opened.
    // setDocName already dropped any stale handle from a prior document.
    originalFileHandle = handle || null;
    originalFileHandlePath = handle ? out.path : null;
    updateSaveButton();

    // Retire every /api/doc read that began under the previous ownership.
    // Otherwise a delayed old response can repaint document A after B opened.
    modelAppliedSeq = Math.max(modelAppliedSeq, ++modelFetchSeq);
    const adoptedGeneration = app.documentGeneration;
    const model = await fetchModel();
    if (requestSeq !== uploadRequestSeq) return;
    if (app.documentGeneration !== adoptedGeneration &&
        !documentOwnershipMatches(out)) {
      return;
    }
    if (!model) {
      setEditStatus('document opened \u00b7 waiting to refresh', {
        error: true,
        title: 'The document opened, but its content could not be refreshed yet. Scribe will reconcile it when the connection resumes.',
        clearAfter: 6000,
      });
      scheduleAuthoritativeReconnect();
      return;
    }
    const uploadModelMismatch = documentOwnershipMismatch(
      out.path,
      out.document_token,
      model,
    );
    if (uploadModelMismatch) {
      // The upload committed B, then the server advanced to C before this
      // model read. C is authoritative; clear B and reconnect for C's sidecars.
      retireClientDocumentOwnership(
        'the active document changed while the upload was refreshing',
      );
      app.documentToken = capturedDocumentToken(model);
      if (model.path) setDocName(model.path);
    }
    const rendered = applyModel(model);
    if (uploadModelMismatch) scheduleAuthoritativeReconnect();
    if (!rendered.invalid && !rendered.stale) {
      if (Number.isSafeInteger(model.rev) && model.rev >= 0) app.rev = model.rev;
      if (model.path) setDocName(model.path);
      setEditStatus(null);
    }
  } catch (e) {
    if (requestSeq !== uploadRequestSeq) return;
    if (opened) {
      setEditStatus('document opened \u00b7 refresh failed', {
        error: true,
        title: e.message || String(e),
        clearAfter: 6000,
      });
      scheduleAuthoritativeReconnect();
      return;
    }
    button.textContent = 'could not open';
    button.title = e.message || String(e);
    setTimeout(() => {
      if (button.textContent === 'could not open') {
        button.textContent = previous.text;
        button.title = previous.title;
      }
    }, 3500);
  } finally {
    if (requestSeq === uploadRequestSeq) {
      button.removeAttribute('aria-busy');
      $('doc-file').value = '';
    }
  }
}

function setHealth(h) {
  if (!h) return;
  const dot = $('health-dot');
  dot.className = 'dot ' + (h.ok ? 'ok' : 'bad');
  dot.title = h.ok ? `connected, booted ${h.bootedAt}` : (h.error || 'not healthy');
  if (h.paused != null) setPaused(h.paused);
  if (h.rev != null) app.rev = h.rev;
  if (typeof h.bootedAt === 'string' && h.bootedAt !== app.serverBootedAt) {
    app.serverBootedAt = h.bootedAt;
    app.paragraphMergeSupported = false;
  }
  if (Object.prototype.hasOwnProperty.call(h, 'capabilities')) {
    app.paragraphMergeSupported = !!(
      h.capabilities && h.capabilities.paragraphMerge === true
    );
  }
  updateRevision();
}

const compactRail = window.matchMedia('(max-width: 900px)');

function setRailOpen(open) {
  const rail = $('rail');
  const button = $('rail-toggle');
  const expanded = compactRail.matches && !!open;
  rail.dataset.open = String(expanded);
  button.setAttribute('aria-expanded', String(expanded));
  if (compactRail.matches) {
    rail.setAttribute('aria-hidden', String(!expanded));
    rail.inert = !expanded;
  } else {
    rail.removeAttribute('aria-hidden');
    rail.inert = false;
  }
}

function setPaused(p) {
  app.paused = p;
  if (p) {
    cancelPredictionCapture('paused by the human');
    for (const pid of [...directEdits.keys()]) {
      const el = app.nodes.get(pid);
      if (el) cancelDirectEdit(el);
    }
  }
  for (const el of app.nodes.values()) {
    setParagraphEditability(el);
  }
  $('scrim').hidden = !p;
  const b = $('pause');
  b.textContent = p ? 'resume' : 'pause';
  b.setAttribute('aria-pressed', String(p));
}

const conversationItems = new Map();
const trailSeen = new Set();
let conversationSeq = 0;

function appendConversationInline(parent, value) {
  const text = String(value || '');
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      parent.appendChild(strong);
    } else if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      parent.appendChild(code);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function makeAgentAnswer(text) {
  const body = document.createElement('div');
  body.className = 'conversation-body';
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split('\n');
    const bullets = lines.every((line) => /^\s*[-*]\s+/.test(line));
    const numbers = lines.every((line) => /^\s*\d+[.)]\s+/.test(line));

    if (bullets || numbers) {
      const list = document.createElement(numbers ? 'ol' : 'ul');
      for (const line of lines) {
        const item = document.createElement('li');
        appendConversationInline(item,
          line.replace(numbers ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ''));
        list.appendChild(item);
      }
      body.appendChild(list);
      continue;
    }

    const heading = block.match(/^\s*#{1,3}\s+(.+)$/);
    if (heading && lines.length === 1) {
      const h = document.createElement('h4');
      appendConversationInline(h, heading[1]);
      body.appendChild(h);
      continue;
    }

    const p = document.createElement('p');
    lines.forEach((line, index) => {
      if (index) p.appendChild(document.createElement('br'));
      appendConversationInline(p, line);
    });
    body.appendChild(p);
  }
  return body;
}

function makeConversationTurn(item) {
  const { who, text, key, at, legacyTruncated } = item;
  const turn = document.createElement('article');
  turn.className = 'conversation-turn';
  turn.dataset.who = who;
  turn.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'conversation-turn-head';
  const label = document.createElement('span');
  label.textContent = who === 'agent' ? 'scribe' : 'you';
  head.appendChild(label);

  if (at) {
    const time = document.createElement('time');
    time.dateTime = at;
    const date = new Date(at);
    if (!Number.isNaN(date.getTime())) {
      time.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      head.appendChild(time);
    }
  }

  if (who === 'agent') {
    const source = `conversation:${key}`;
    const speak = document.createElement('button');
    speak.type = 'button';
    speak.className = 'conversation-speak';
    speak.dataset.speechSource = source;
    speak.dataset.readLabel = 'Read this answer aloud';
    speak.dataset.stopLabel = 'Stop reading this answer';
    speak.setAttribute('aria-label', 'Read this answer aloud');
    speak.title = 'Read aloud';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M5 10v4h3l4 3V7L8 10H5zm10-1.5a5 5 0 0 1 0 7M17.5 6a8 8 0 0 1 0 12');
    svg.appendChild(path);
    speak.appendChild(svg);
    speak.onclick = () => {
      if (responseSpeech.speaking && responseSpeech.last === source) stopResponseSpeech();
      else speakResponse(text, source);
    };
    head.appendChild(speak);
  }

  let body;
  if (who === 'agent') {
    body = makeAgentAnswer(text);
  } else {
    body = document.createElement('p');
    body.className = 'conversation-body';
    body.textContent = text;
  }
  turn.append(head, body);
  if (legacyTruncated) {
    const legacy = document.createElement('small');
    legacy.className = 'conversation-legacy';
    legacy.textContent = 'older response was only partially saved';
    turn.appendChild(legacy);
  }
  return turn;
}

function renderConversation() {
  const ordered = [...conversationItems.values()].sort((a, b) =>
    a.when - b.when || a.seq - b.seq);
  const exchanges = [];
  const awaiting = [];

  for (const item of ordered) {
    if (item.who === 'human') {
      const exchange = { human: item, agent: null };
      exchanges.push(exchange);
      awaiting.push(exchange);
      continue;
    }
    // Messages sent while a turn is running are queued. Pair responses with
    // the oldest unanswered prompt, not merely the closest preceding card.
    const exchange = awaiting.shift();
    if (exchange) exchange.agent = item;
    else exchanges.push({ human: null, agent: item });
  }

  conversationEl.textContent = '';
  for (const exchange of exchanges.slice(-6)) {
    const group = document.createElement('section');
    group.className = 'conversation-exchange';
    group.dataset.complete = String(!!(exchange.human && exchange.agent));
    if (exchange.human) group.appendChild(makeConversationTurn(exchange.human));
    if (exchange.agent) group.appendChild(makeConversationTurn(exchange.agent));
    conversationEl.appendChild(group);
  }
  $('conversation').hidden = conversationEl.children.length === 0;
  conversationEl.scrollTop = conversationEl.scrollHeight;
}

function appendConversation(who, value, meta = {}) {
  const text = String(value || '').trim();
  if (!text) return;
  const seq = ++conversationSeq;
  const key = meta.at
    ? `${meta.at}|${who}|${text}`
    : `local-${seq}`;
  if (conversationItems.has(key)) return;
  const parsed = meta.at ? new Date(meta.at).getTime() : NaN;
  const when = Number.isFinite(parsed) ? parsed : Date.now();
  // The same SSE trail entry can occasionally be replayed with a newly
  // stamped envelope during reconnect. Collapse only near-simultaneous exact
  // copies so a genuinely repeated question later still remains visible.
  const replay = [...conversationItems.values()].some((item) =>
    item.who === who && item.text === text && Math.abs(item.when - when) < 5000);
  if (replay) return;
  conversationItems.set(key, {
    who, text, key, at: meta.at || null, seq,
    when,
    // Builds before the full-response fix persisted exactly 300 characters.
    // Be explicit about those historical records instead of making the
    // present renderer look broken.
    legacyTruncated: who === 'agent' && text.length === 300 &&
      !/[.!?…]["')\]]?$/.test(text),
  });
  while (conversationItems.size > 40) {
    const oldest = [...conversationItems.values()].sort((a, b) =>
      a.when - b.when || a.seq - b.seq)[0];
    conversationItems.delete(oldest.key);
  }
  renderConversation();
}

function addTrail(e) {
  if (!e || (!e.summary && !e.op)) return;
  if (e.op === 'said' && e.who === 'human') {
    appendConversation('human', e.summary, e);
    return;
  }
  if (e.op === 'turn' && e.who === 'agent') {
    if (!/^turn (complete|interrupted)$/i.test(String(e.summary || '').trim())) {
      appendConversation('agent', e.summary, e);
    }
    return;
  }
  const key = e.at ? `${e.at}|${e.op || ''}|${e.summary || ''}` : null;
  if (key && trailSeen.has(key)) return;
  if (key) trailSeen.add(key);
  const li = document.createElement('li');
  if (e.op === 'undo') li.className = 'undo';
  const op = document.createElement('span');
  op.className = 'op';
  op.textContent = e.op || 'edit';
  li.appendChild(op);
  li.appendChild(document.createTextNode(e.summary || ''));
  if (e.why) {
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = e.why;
    li.appendChild(why);
  }
  trailEl.insertBefore(li, trailEl.firstChild);
  while (trailEl.children.length > 100) trailEl.removeChild(trailEl.lastChild);
}


// --------------------------------------------------------------------------
// voice
// --------------------------------------------------------------------------

let voiceCaptureOwner = null;
let retiredVoiceCaptureOwner = null;

function wireMic() {
  const btn = $('mic-btn');
  if (!btn) return;
  const setState = (s) => {
    if (s === 'listening' && !voiceCaptureOwner) {
      voiceCaptureOwner = {
        documentGeneration: app.documentGeneration,
        documentPath: capturedDocumentPath(app.model),
        documentToken: capturedDocumentToken(app.model),
      };
      retiredVoiceCaptureOwner = null;
    } else if (s === 'off') {
      voiceCaptureOwner = null;
    }
    btn.dataset.state = s;
    $('bar').classList.toggle('hot', s === 'speaking');
    if (s === 'off') btn.title = 'Talk (m)';
  };
  setState('off');

  if (!window.micSupported || !micSupported()) {
    btn.disabled = true;
    btn.title = 'This browser cannot capture audio.';
    return;
  }
  if (!micOriginOk()) {
    btn.disabled = true;
    btn.title = `Voice needs http://127.0.0.1, not ${location.host}. getUserMedia refuses a LAN origin without TLS.`;
    return;
  }

  mic.onState = setState;
  mic.onLevel = (rms, threshold) => {
    // Scale the dot with your voice above the noise floor.
    const over = Math.max(0, Math.min(1, (rms - threshold) * 14));
    btn.querySelector('.mic-dot').style.transform = `scale(${1 + over * 0.9})`;
  };
  mic.onText = (text) => {
    const owner = voiceCaptureOwner;
    if (!owner ||
        owner.documentGeneration !== app.documentGeneration ||
        documentOwnershipMismatch(
          owner.documentPath,
          owner.documentToken,
          app.model || {
            path: app.documentPath,
            document_token: app.documentToken,
          },
        )) {
      const recoveryOwner = owner || retiredVoiceCaptureOwner;
      archivePendingMessageForDocumentOpen({
        text,
        acknowledged: false,
        documentPath: recoveryOwner && recoveryOwner.documentPath,
      }, 'document changed before speech transcription completed');
      retiredVoiceCaptureOwner = null;
      return;
    }
    // Dictation lands in the bar and sends itself. It goes through exactly the
    // same path as typing, so the resolver, the proposals, and the agent all
    // behave identically whether you spoke or typed.
    const inp = $('say');
    const draft = inp.value;
    if (draft.trim()) {
      // A delayed transcript must never replace words typed while Whisper was
      // thinking. Preserve both, leave the combined draft unsent for review,
      // and make the reason visible without treating it as a delivery error.
      inp.value = `${draft}${/\s$/.test(draft) ? '' : ' '}${text}`;
      $('lane-hint').textContent = 'voice transcript added to your draft';
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
      return;
    }
    inp.value = text;
    $('bar').dispatchEvent(new Event('submit', { cancelable: true }));
  };
  mic.onError = (err) => {
    setState('error');
    addTrail({ op: 'voice', summary: err });
    setTimeout(() => setState(mic.listening ? 'listening' : 'off'), 2500);
  };

  btn.onclick = async () => {
    if (mic.listening) return micStop();
    stopResponseSpeech();
    btn.disabled = true;
    const r = await micStart()
      .catch((e) => ({ ok: false, error: e && e.message || String(e) }));
    btn.disabled = false;
    if (!r.ok) {
      setState('error');
      addTrail({ op: 'voice', summary: r.error });
      setTimeout(() => setState('off'), 3000);
      return;
    }
    // Load the model now rather than at the end of the first sentence, where
    // the wait would land right when you are expecting an answer.
    post('/api/stt/warm').catch(() => {});
  };
}

// --------------------------------------------------------------------------
// wiring
// --------------------------------------------------------------------------

let eventStream = null;
let eventHealthTimer = null;
let lastEventSignal = Date.now();
let authoritativeReconnectTimer = null;
let authoritativeReconnectAttempt = 0;

function recordEventSignal() {
  lastEventSignal = Date.now();
}

function validTrailEvent(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) &&
    (typeof data.op === 'string' || typeof data.summary === 'string') &&
    (data.at === undefined || typeof data.at === 'string');
}

function validHealthPayload(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) &&
    typeof data.ok === 'boolean' &&
    (data.rev === undefined || Number.isFinite(data.rev)) &&
    (data.docPath === undefined || data.docPath === null ||
      typeof data.docPath === 'string') &&
    (data.document_token === undefined || data.document_token === null ||
      (typeof data.document_token === 'string' && !!data.document_token.trim()));
}

function validModelPoolPayload(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) &&
    Array.isArray(data.models) && data.models.every((model) => typeof model === 'string') &&
    Array.isArray(data.enabled) && data.enabled.every((model) => typeof model === 'string') &&
    typeof data.selected === 'string' &&
    !!data.automatic && typeof data.automatic === 'object' &&
    typeof data.automatic.watch === 'string' &&
    typeof data.automatic.continue === 'string' &&
    (data.automatic.format === undefined ||
     typeof data.automatic.format === 'string');
}

function validSidecarPayload(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data) &&
    typeof data.id === 'string' && typeof data.status === 'string';
}

function validFormattingPayload(data, { snapshot = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (snapshot &&
      (typeof data.enabled !== 'boolean' ||
       typeof data.status !== 'string' ||
       !Number.isFinite(data.pending_words) ||
       !Number.isFinite(data.pending_paragraphs))) return false;
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') return false;
  if (data.status !== undefined && typeof data.status !== 'string') return false;
  if (data.kind !== undefined &&
      (typeof data.kind !== 'string' ||
       !FORMATTING_EVENT_KINDS.has(data.kind))) return false;
  if (!snapshot && data.kind === undefined && data.status === undefined) return false;
  for (const field of [
    'pending_words', 'pending_paragraphs', 'threshold_words', 'quiet_ms',
    'cooldown_ms', 'count', 'rev',
  ]) {
    if (data[field] !== undefined && !Number.isFinite(data[field])) return false;
  }
  if (data.id !== undefined && typeof data.id !== 'string') return false;
  if (data.model !== undefined && typeof data.model !== 'string') return false;
  if (data.provider !== undefined && typeof data.provider !== 'string') return false;
  if (data.error !== undefined && typeof data.error !== 'string') return false;
  if (data.document_token !== undefined && data.document_token !== null &&
      (typeof data.document_token !== 'string' ||
       !data.document_token.trim())) return false;
  if (data.active !== undefined && data.active !== null &&
      (typeof data.active !== 'object' || Array.isArray(data.active))) return false;
  if (data.runner !== undefined && data.runner !== null &&
      (typeof data.runner !== 'object' || Array.isArray(data.runner))) return false;
  return true;
}

function validSsePayload(type, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  switch (type) {
    case 'hello':
      return validHealthPayload(data.health) &&
        Array.isArray(data.trail) && data.trail.every(validTrailEvent) &&
        (data.assist === undefined || data.assist === null ||
          validSidecarPayload(data.assist)) &&
        (data.continuation === undefined || data.continuation === null ||
          validSidecarPayload(data.continuation)) &&
        (data.formatting === undefined || data.formatting === null ||
          validFormattingPayload(data.formatting, { snapshot: true })) &&
        (data.models === undefined || validModelPoolPayload(data.models)) &&
        (data.proposals === undefined || validProposalSnapshot(data.proposals)) &&
        (data.proposal === undefined || data.proposal === null ||
          validProposal(data.proposal));
    case 'edit':
      return Number.isFinite(data.rev) && typeof data.op === 'string';
    case 'trail':
      return validTrailEvent(data);
    case 'paused':
      return typeof data.paused === 'boolean';
    case 'health':
      return validHealthPayload(data);
    case 'opened':
      return typeof data.path === 'string' && Number.isFinite(data.rev) &&
        (data.document_token === undefined ||
         (typeof data.document_token === 'string' &&
          !!data.document_token.trim()));
    case 'document':
      return Number.isFinite(data.rev);
    case 'proposal':
      return validProposal(data);
    case 'assist':
      return validSidecarPayload(data);
    case 'models':
      return validModelPoolPayload(data);
    case 'format':
      return validFormattingPayload(data);
    case 'agent':
    case 'predict':
    case 'watch':
    case 'voice':
      return typeof data.kind === 'string';
    default:
      return false;
  }
}

function parseSsePayload(type, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  return validSsePayload(type, data) ? data : null;
}

function ensureEventHealthTimer() {
  if (eventHealthTimer !== null) return;
  eventHealthTimer = setInterval(() => {
    const age = Date.now() - lastEventSignal;
    const dot = $('health-dot');
    if (age > 30000) {
      dot.className = 'dot bad';
      dot.title = `no signal from Scribe for ${Math.round(age / 1000)}s. It may have stopped.`;
      document.body.dataset.stale = 'true';
    } else if (document.body.dataset.stale === 'true') {
      document.body.dataset.stale = 'false';
      dot.className = 'dot ok';
      dot.title = 'reconnected';
    }
  }, 5000);
}

function markAuthoritativeRefreshSucceeded() {
  authoritativeReconnectAttempt = 0;
  if (authoritativeReconnectTimer !== null) {
    clearTimeout(authoritativeReconnectTimer);
    authoritativeReconnectTimer = null;
  }
}

function scheduleAuthoritativeReconnect({ backoff = false } = {}) {
  if (authoritativeReconnectTimer !== null) return;
  const delay = backoff
    ? Math.min(8000, 250 * (2 ** Math.min(authoritativeReconnectAttempt++, 5)))
    : 0;
  authoritativeReconnectTimer = setTimeout(() => {
    authoritativeReconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (eventStream) eventStream.close();
  const es = new EventSource('/api/events');
  eventStream = es;
  recordEventSignal();
  ensureEventHealthTimer();
  es.onopen = () => {
    if (eventStream !== es) return;
    recordEventSignal();
    // A reconnect may have missed an open, accepted, or dismissed proposal.
    // Agent state is fetched once from the immediately following authoritative
    // hello, after that frame has established document identity. Fetching it
    // here as well races an unbound snapshot against hello and duplicates every
    // startup/reconnect request.
    syncProposalSnapshot().catch(() => {});
    // The server deliberately does not persist screening consent. Reassert the
    // saved state after a reconnect. A new browser has no choice to reassert,
    // so it first adopts the server's current consent instead of silently
    // disarming an existing session. Neither path starts a model or prompt.
    const consent = watch.preference === null
      ? hydrateWatchConsent()
      // A human toggle already owns the serialized consent write. Queueing a
      // reconnect write with the old committed value behind it can turn the
      // server back off immediately after the UI reports a successful "on".
      : (watch.targetEnabled !== null
        ? watch.consent
        : syncWatchConsent(watch.enabled));
    consent.catch((e) => {
      setWatchButtonState(watch.enabled ? 'armed' : 'off', e.message || String(e));
    });
  };
  for (const t of ['hello', 'edit', 'trail', 'paused', 'health', 'opened', 'document',
                   'agent', 'models', 'proposal', 'assist', 'predict', 'watch',
                   'format', 'voice']) {
    es.addEventListener(t, (ev) => {
      if (eventStream !== es) return;
      const data = parseSsePayload(t, ev.data);
      if (!data) return;
      recordEventSignal();
      enqueue(t, data);
    });
  }
  es.onerror = () => {
    if (eventStream !== es) return;
    // Anything not yet rendered may belong to the broken connection. Drop it;
    // the reconnect hello plus authoritative snapshots rebuild current state.
    app.queue.length = 0;
    app.pendingHighlight.clear();
    $('health-dot').className = 'dot bad';
    $('health-dot').title = 'reconnecting';
  };

  // A page attached to a dead server looks perfectly healthy: the document is
  // still on screen and nothing errors. The server beats every 10 s, so silence
  // past 30 s means it is gone, and the page says so rather than pretending.
  es.addEventListener('beat', () => {
    if (eventStream === es) recordEventSignal();
  });
  return es;
}

async function readJsonResponse(response, label, { allowHttpErrorBody = false } = {}) {
  let value = null;
  let parseError = null;
  try {
    value = await responseJsonWithDeadline(response, label);
  } catch (error) {
    parseError = error;
  }
  const status = Number(response.status);
  const ok = typeof response.ok === 'boolean'
    ? response.ok
    // Small browser-test doubles historically supplied only json(). Treat
    // those as successful unless they explicitly carry an error status.
    : !(Number.isFinite(status) && status >= 400);
  if (!ok) {
    if (allowHttpErrorBody && value && typeof value === 'object' && value.error) {
      return value;
    }
    throw new Error(
      value && value.error ||
      `${label} failed${Number.isFinite(status) ? ` (${status})` : ''}.`);
  }
  if (parseError && parseError.name === 'TimeoutError') throw parseError;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
  return value;
}

const post = async (p, body) => {
  const response = await fetchWithDeadline(p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, p);
  return readJsonResponse(response, p, { allowHttpErrorBody: true });
};

async function togglePaused() {
  const button = $('pause');
  if (button.disabled) return;
  const desired = !app.paused;
  const action = desired ? 'pause' : 'resume';
  button.disabled = true;
  try {
    const result = await post(desired ? '/api/pause' : '/api/resume');
    if (result.error) throw new Error(result.error);
    if (typeof result.paused !== 'boolean') {
      throw new Error(`Scribe did not confirm the ${action} request.`);
    }
    setPaused(result.paused);
  } catch (e) {
    // The HTTP response can be lost after the matching live event arrived.
    // In that case the acknowledged editor state is stronger evidence than
    // the transport failure, so do not paint a false error over it.
    if (app.paused !== desired) {
      setEditStatus(`${action} failed`, {
        error: true,
        title: e.message || String(e),
        clearAfter: 6000,
      });
    }
  } finally {
    button.disabled = false;
  }
}

$('pause').onclick = togglePaused;
$('prop-dismiss').onclick = dismissProposal;
$('model-btn').onchange = async () => {
  // Switching restarts the agent, so refuse mid-turn rather than killing a
  // turn in flight. The server enforces this too; this is just the fast path.
  const previous = lane.model;
  const next = $('model-btn').value;
  if (!next || next === previous) return;
  setModel(null, true);
  let r;
  try {
    r = await post('/api/model', { model: next });
  } catch (_) {
    setModel(previous, false);
    $('lane-hint').textContent =
      'Scribe is unavailable. The editing model was not changed.';
    return;
  }
  if (r.error) { setModel(previous, false); $('lane-hint').textContent = r.error; }
  else setModel(r.model, false);
};
$('model-pool-btn').onclick = () => {
  setModelPoolOpen($('model-pool-btn').getAttribute('aria-expanded') !== 'true');
};
document.body.appendChild($('model-pool'));
for (const button of document.querySelectorAll('.model-pool-toggle')) {
  button.onclick = async () => {
    const model = button.dataset.model;
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    const mutationSeq = ++modelPool.mutationSeq;
    modelPool.pending.set(model, mutationSeq);
    renderModelPool();
    try {
      const result = await post('/api/models', { model, enabled });
      // Responses carry full pool snapshots. A response to an earlier click
      // must not overwrite a later click's state when network delivery inverts.
      if (mutationSeq !== modelPool.mutationSeq) return;
      if (result.error) {
        $('lane-hint').textContent = result.error;
        return;
      }
      applyModelPool(result);
    } catch (_) {
      if (mutationSeq === modelPool.mutationSeq) {
        $('lane-hint').textContent =
          'Scribe is unavailable. The automatic model pool was not changed.';
      }
    } finally {
      if (modelPool.pending.get(model) === mutationSeq) {
        modelPool.pending.delete(model);
      }
      renderModelPool();
    }
  };
}

async function requestUndo() {
  const button = $('undo');
  if (button.disabled || paragraphMerge) return;
  const acknowledgement = {
    startedAt: Date.now(),
    acknowledged: false,
  };
  pendingUndoAcknowledgement = acknowledgement;
  button.disabled = true;
  try {
    const documentToken = capturedDocumentToken(app.model);
    const result = await post('/api/undo', documentToken
      ? { expect_document_token: documentToken }
      : {});
    if (result.error) throw new Error(result.error);
  } catch (e) {
    // undoNow records and broadcasts its trail entry before sending HTTP.
    // That matching live record is authoritative if the response was lost.
    if (!acknowledgement.acknowledged) {
      setEditStatus('undo failed', {
        error: true,
        title: e.message || String(e),
        clearAfter: 6000,
      });
    }
  } finally {
    if (pendingUndoAcknowledgement === acknowledgement) {
      pendingUndoAcknowledgement = null;
    }
    button.disabled = !!paragraphMerge;
  }
}

async function stopAgent() {
  const button = $('agent-btn');
  if (button.disabled || lane.state === 'off') return;
  const owner = {
    documentGeneration: app.documentGeneration,
    documentPath: capturedDocumentPath(app.model),
    documentToken: capturedDocumentToken(app.model),
  };
  agentStopOwner = owner;
  button.disabled = true;
  $('lane-hint').textContent = 'stopping\u2026';
  try {
    const result = await post('/api/agent/stop', owner.documentToken
      ? { expect_document_token: owner.documentToken }
      : {});
    if (agentStopOwner !== owner ||
        owner.documentGeneration !== app.documentGeneration ||
        documentOwnershipMismatch(
          owner.documentPath,
          owner.documentToken,
          app.model || {
            path: app.documentPath,
            document_token: app.documentToken,
          },
        )) return;
    if (result.error) throw new Error(result.error);
    if (result.stopped !== true) {
      throw new Error('Scribe did not confirm that the agent stopped.');
    }
    if (lane.state !== 'off') {
      lane.ready = false;
      stopResponseSpeech();
      setAgentState('off', '');
      clearLane();
    }
  } catch (e) {
    if (agentStopOwner !== owner ||
        owner.documentGeneration !== app.documentGeneration) return;
    // The exit event can arrive even when its HTTP acknowledgement is lost.
    // If it did, the lane is already authoritative and needs no false error.
    if (lane.state !== 'off') {
      setAgentState(
        lane.state,
        `stop failed \u00b7 ${e.message || String(e)}`);
    }
  } finally {
    if (agentStopOwner === owner) {
      agentStopOwner = null;
      if (lane.state !== 'off') button.disabled = false;
    }
  }
}

$('agent-btn').onclick = stopAgent;
$('undo').onclick = requestUndo;
$('format-toggle').onclick = () => setFormattingEnabled(!formatting.enabled);
$('watch-toggle').onclick = () => setWatchEnabled(!watch.enabled);
$('rail-toggle').onclick = () => {
  setRailOpen($('rail-toggle').getAttribute('aria-expanded') !== 'true');
};
$('empty-open').onclick = () => { openDocumentDialog(); };
$('doc-name').onclick = () => { openDocumentDialog(); };
$('doc-file').onchange = () => {
  const file = $('doc-file').files && $('doc-file').files[0];
  // The file-input path is the fallback: no write-back handle, Save downloads.
  if (file) uploadDocument(file, null);
};
$('save-original').onclick = () => { saveOverOriginal(); };

let messagePosting = false;
let messagePostingOwner = null;
let messageDeliveryHint = '';

function clearMessageDeliveryError() {
  const bar = $('bar');
  if (bar.dataset.delivery !== 'error') return;
  delete bar.dataset.delivery;
  bar.removeAttribute('title');
  if ($('lane-hint').textContent === messageDeliveryHint) $('lane-hint').textContent = '';
  messageDeliveryHint = '';
}

function restoreUndeliveredMessage(text, reason) {
  const input = $('say');
  const newerText = input.value;
  input.value = newerText.trim() ? `${text} ${newerText}` : text;
  messageDeliveryHint = reason;
  $('lane-hint').textContent = reason;
  $('bar').dataset.delivery = 'error';
  $('bar').title = reason;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

$('say').addEventListener('input', () => {
  if (!messagePosting) clearMessageDeliveryError();
});

$('bar').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (messagePosting) return;
  const input = $('say');
  const bar = $('bar');
  const send = $('send');
  const v = input.value.trim();
  if (!v) return;
  clearMessageDeliveryError();
  messagePosting = true;
  bar.dataset.delivery = 'sending';
  bar.setAttribute('aria-busy', 'true');
  send.disabled = true;
  stopResponseSpeech();
  input.value = '';
  const acknowledgement = {
    text: v,
    startedAt: Date.now(),
    acknowledged: false,
    documentGeneration: app.documentGeneration,
    documentPath: capturedDocumentPath(app.model),
    documentToken: capturedDocumentToken(app.model),
  };
  messagePostingOwner = acknowledgement;
  pendingMessageAcknowledgement = acknowledgement;
  try {
    const result = await post('/api/say', {
      text: v,
      ...(acknowledgement.documentToken
        ? { expect_document_token: acknowledgement.documentToken }
        : {}),
    });
    if (messagePostingOwner !== acknowledgement ||
        acknowledgement.documentGeneration !== app.documentGeneration) {
      return;
    }
    const reason = result.error ||
      (result.recorded !== true && 'Scribe did not confirm that the message was recorded.') ||
      (result.delivered === false && (result.note || 'The message was not delivered.'));
    if (reason) restoreUndeliveredMessage(v, reason);
  } catch (_) {
    if (messagePostingOwner !== acknowledgement ||
        acknowledgement.documentGeneration !== app.documentGeneration) {
      return;
    }
    // /api/say emits this exact human trail record before any model work and
    // before the HTTP response. If it arrived, restoring the text would invite
    // an accidental duplicate submission.
    if (!acknowledgement.acknowledged) {
      restoreUndeliveredMessage(v, 'Scribe is unavailable. Your message is still here.');
    }
  } finally {
    if (messagePostingOwner === acknowledgement) {
      messagePostingOwner = null;
      if (pendingMessageAcknowledgement === acknowledgement) {
        pendingMessageAcknowledgement = null;
      }
      messagePosting = false;
      if (bar.dataset.delivery === 'sending') delete bar.dataset.delivery;
      bar.removeAttribute('aria-busy');
      send.disabled = false;
    }
  }
});

paperEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest && e.target.closest('.para');
  if (el) beginDirectEdit(el);
});
paperEl.addEventListener('focusin', (e) => {
  const el = e.target.closest && e.target.closest('.para');
  if (el) beginDirectEdit(el);
});
paperEl.addEventListener('beforeinput', (e) => {
  if (!e.inputType) return;
  const key = e.inputType === 'deleteContentBackward' ? 'Backspace'
    : e.inputType === 'deleteContentForward' ? 'Delete'
      : null;
  if (!key) return;
  const el = e.target.closest && e.target.closest('.para[contenteditable="plaintext-only"]');
  const preceding = boundaryDeleteKeydown;
  boundaryDeleteKeydown = null;
  if (e.isComposing || (
    preceding && preceding.key === key && el &&
    preceding.pid === el.dataset.pid && preceding.blocked &&
    Date.now() - preceding.at < 1500
  )) return;
  if (el && requestParagraphBoundaryMerge(el, key)) {
    e.preventDefault();
    e.stopPropagation();
  }
});
paperEl.addEventListener('input', (e) => {
  const el = e.target.closest && e.target.closest('.para');
  // Chromium can retain focus on a paragraph while it is reconciled, which
  // means the replacement node receives input without a fresh focusin event.
  // Capture the server snapshot here as a safe fallback.
  if (el && !directEdits.has(el.dataset.pid)) beginDirectEdit(el);
  const edit = el && directEdits.get(el.dataset.pid);
  if (!edit) return;
  edit.dirty = true;
  edit.suppressAutoSave = false;
  el.classList.add('dirty');
  setEditStatus('editing');
  recordWatchInput(el, edit);
  recordPredictionInput(el, edit);
  scheduleDirectSave(el, edit);
});
paperEl.addEventListener('focusout', (e) => {
  const el = e.target.closest && e.target.closest('.para');
  if (el) saveDirectEdit(el);
});

// Save on a genuine click-away even if Chromium retained the contenteditable
// node without emitting a matching focus transition during reconciliation.
document.addEventListener('pointerdown', (e) => {
  if (!$('model-pool-wrap').contains(e.target) && !$('model-pool').contains(e.target)) {
    setModelPoolOpen(false);
  }
  for (const pid of [...directEdits.keys()]) {
    const el = app.nodes.get(pid);
    if (!el || el.contains(e.target)) continue;
    el.blur();
    if (directEdits.has(pid)) saveDirectEdit(el);
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const targetParagraph = e.target.closest && e.target.closest('.para');
    boundaryDeleteKeydown = {
      key: e.key,
      pid: targetParagraph && targetParagraph.dataset.pid,
      blocked: e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
      at: Date.now(),
    };
  } else {
    boundaryDeleteKeydown = null;
  }
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW') {
    e.preventDefault();
    e.stopPropagation();
    reviewRecentTypingNow();
    return;
  }
  const paragraph = e.target.closest && e.target.closest('.para');
  if (paragraph && paragraphMerge &&
      (e.key === 'Backspace' || e.key === 'Delete') &&
      requestParagraphBoundaryMerge(paragraph, e.key)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const editable = e.target.closest && e.target.closest('.para[contenteditable="plaintext-only"]');
  if (editable && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
      (e.key === 'Backspace' || e.key === 'Delete') &&
      requestParagraphBoundaryMerge(editable, e.key)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (editable && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelDirectEdit(editable);
    return;
  }
  if (editable && e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    editable.blur();
    // blur normally emits focusout synchronously. Keep an explicit fallback
    // for a retained browser focus node that never emitted focusin/focusout.
    if (directEdits.has(editable.dataset.pid)) saveDirectEdit(editable);
    return;
  }
  const typing = e.target.tagName === 'INPUT' || e.target.isContentEditable;
  if (e.key === 'Escape' &&
      $('model-pool-btn').getAttribute('aria-expanded') === 'true') {
    e.preventDefault();
    e.stopPropagation();
    const trigger = $('model-pool-btn');
    // Move focus out of the panel before hiding its focused toggle. Doing this
    // in the opposite order lets Chromium reconcile focus back to body.
    trigger.focus({ preventScroll: true });
    setModelPoolOpen(false);
    return;
  }
  if (e.key === 'Escape' && responseSpeech.speaking && !typing) {
    stopResponseSpeech();
    return;
  }
  if (e.key === 'Escape' && $('rail-toggle').getAttribute('aria-expanded') === 'true') {
    setRailOpen(false);
    $('rail-toggle').focus();
    return;
  }
  if (e.key === ' ' && !typing) { e.preventDefault(); $('pause').click(); }
  if ((e.key === 'm' || e.key === 'M') && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); $('mic-btn').click(); return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); $('say').focus(); }
  // While options are up, a bare letter or number picks one. Only outside the
  // input, so typing "b" in a sentence never selects anything.
  if (openProp && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const k = e.key.toUpperCase();
    const byLetter = openProp.options.find((o) => o.id === k);
    const byNum = /^[1-9]$/.test(e.key) ? openProp.options[Number(e.key) - 1] : null;
    const pick = byLetter || byNum;
    if (pick) { e.preventDefault(); acceptProposal(pick.id); }
  }
});
document.addEventListener('keyup', (e) => {
  if (boundaryDeleteKeydown &&
      (e.key === 'Backspace' || e.key === 'Delete') &&
      boundaryDeleteKeydown.key === e.key) {
    boundaryDeleteKeydown = null;
  }
});

setRailOpen(false);
compactRail.addEventListener('change', () => setRailOpen(false));
window.addEventListener('resize', () => setModelPoolOpen(false));
refreshFormattingState();
hydrateFormattingState().catch((error) => {
  if (formatting.supported !== false) {
    formatting.lastError = error && error.message || String(error);
    refreshFormattingState(
      `Could not read AI formatting state. ${formatting.lastError}`);
  }
});
watch.enabled = false;
// The server itself defaults to off, so do not race a redundant "off" request
// against a quick human click. Restore persisted consent before opening the
// event stream so its reconnect reassertion cannot queue a stale "off" behind
// the initial "on".
if (watch.preference === true) setWatchEnabled(true).finally(connect);
else if (watch.preference === false) {
  refreshWatchState();
  connect();
} else {
  // A fresh profile has made no choice. Read the global session state before
  // connecting so merely opening another browser cannot change consent.
  hydrateWatchConsent()
    .catch((e) => {
      refreshWatchState();
      setWatchButtonState('off', `Could not read Watch state. ${e.message || String(e)}`);
    })
    .finally(connect);
}
wireMic();
const initialHealthGeneration = app.documentGeneration;
fetchWithDeadline('/api/health', {}, 'Health check')
  .then((r) => readJsonResponse(r, 'Health check')).then((h) => {
  if (initialHealthGeneration !== app.documentGeneration) return;
  const currentToken = capturedDocumentToken(app.model);
  if (currentToken && h.document_token &&
      currentToken !== h.document_token) return;
  setHealth(h);
  if (h.docPath) {
    if (typeof h.document_token === 'string' && h.document_token.trim()) {
      app.documentToken = h.document_token;
    }
    setDocName(h.docPath);
    enqueue('document', { rev: h.rev });
    syncProposalSnapshot().catch(() => {});
    syncAssistSnapshot().catch(() => {});
    syncContinuationSnapshot().catch(() => {});
  }
}).catch((e) => {
  if (!$('health-dot').classList.contains('ok')) {
    setHealth({ ok: false, error: e.message || String(e) });
  }
});
syncProposalSnapshot().catch(() => {});
syncAssistSnapshot().catch(() => {});
syncContinuationSnapshot().catch(() => {});
// Exposed for the render tests, which assert against real DOM rather than
// against a mock of it.
window.__scribe = app;
// Exposed so the lane tests can drive the real rendering code with synthetic
// events. The live agent test proves the event SHAPES; this proves the DRAWING.
window.__feed = (type, data) => enqueue(type, data);
window.__lane = lane;
window.__hydrateAgent = hydrateAgent;
window.__prop = () => openProp;
window.__watch = watch;
window.__formatting = formatting;
window.__prediction = prediction;
window.__modelPool = modelPool;
window.__sound = responseSound;
window.__speech = responseSpeech;
