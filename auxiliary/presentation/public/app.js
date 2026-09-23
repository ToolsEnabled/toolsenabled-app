'use strict';
/* Watch dashboard — renders the live model, flashes edits, drives pause/resume. */

const $ = (id) => document.getElementById(id);
let model = { title: 'Untitled Presentation', slides: [], rev: 0, theme: { accent: '#2563eb' } };
let paused = false;
let pausedBy = null;
let es = null;
let backoff = 1000;
let reconnectTimer = null;
let slideW = 13.333, slideH = 7.5, slideHpt = 540, overlay = false;
let thumbsVer = 0;   // >0 once true PowerPoint-rendered thumbnails are available
let lockItems = [];  // advisory per-slide claims: [{slideId, by, ts, note}]
let undoCount = 0, redoCount = 0, historyPosting = false;
let agentsList = [];  // the live lead/worker roster, for diffing spawn/exit into the feed
let profileInfo = null; // server-owned profile plus the independent Fast next-spawn state
let fastModePosting = false;
let pdfRev = null;    // model.rev the last successful PDF export was taken from (server already tracks this; nothing here ever read it back)

function updateUndoRedoButtons() {
  const u = $('undoBtn'), r = $('redoBtn');
  u.disabled = historyPosting || undoCount === 0; u.title = undoCount ? `undo the last edit (${undoCount} available)` : 'nothing to undo';
  r.disabled = historyPosting || redoCount === 0; r.title = redoCount ? `redo the last undone edit (${redoCount} available)` : 'nothing to redo';
}

// PDF export deliberately doesn't run on every edit (README: "unlike
// thumbnails, this does NOT run automatically"), so the downloaded file
// silently drifts behind the live deck the moment anyone edits after the
// last export. pdfRev (how far behind it is) was already computed server-
// side and sent on every /api/state and 'pdf' SSE event; nothing on this
// page ever compared it to the current rev. Same class of gap as
// updateUndoRedoButtons above, just for a different button.
function updatePdfButton() {
  const btn = $('exportPdfBtn'); if (!btn) return;
  if (pdfRev == null) { btn.title = 'export the current deck to PDF, then download'; return; }
  const behind = model.rev - pdfRev;
  btn.title = behind > 0
    ? `PDF is ${behind} edit${behind === 1 ? '' : 's'} behind the live deck (exported at rev ${pdfRev}, now rev ${model.rev}), click to re-export`
    : `PDF matches the current deck (rev ${pdfRev})`;
}

// ---------------------------------------------------------------- rendering
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fetchJson(path) {
  return fetch(path).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// ---- safe binary downloads -------------------------------------------------
// File endpoints can legitimately answer with JSON while a render is stale or
// an export is unavailable. Never hand those endpoints to browser navigation:
// inspect the response first and create a download only for a real file.
const DOWNLOAD_PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOWNLOAD_PDF_MIME = 'application/pdf';

function downloadMime(response) {
  return String(response && response.headers && response.headers.get('content-type') || '')
    .split(';')[0].trim().toLowerCase();
}

async function downloadResponseError(response, mime) {
  let message = `Download failed (HTTP ${response.status})`;
  let jsonReply = false;
  if (mime === 'application/json') {
    jsonReply = true;
    try {
      const body = await response.json();
      if (body && body.error) message = String(body.error);
    } catch (_) {}
  } else if (response.ok) {
    message = `Download failed: unexpected response type ${mime || 'unknown'}`;
  }
  const error = new Error(message);
  error.status = response.status;
  error.mime = mime;
  error.jsonReply = jsonReply;
  return error;
}

async function validateDownloadBlob(blob, expectedMime) {
  if (!blob || !blob.size) throw new Error('Download failed: the server returned an empty file');
  const prefix = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  if (expectedMime === DOWNLOAD_PPTX_MIME) {
    const zip = prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b
      && ((prefix[2] === 0x03 && prefix[3] === 0x04)
        || (prefix[2] === 0x05 && prefix[3] === 0x06)
        || (prefix[2] === 0x07 && prefix[3] === 0x08));
    if (!zip) throw new Error('Download failed: the server did not return a valid PowerPoint file');
  } else if (expectedMime === DOWNLOAD_PDF_MIME) {
    const pdf = prefix.length >= 5 && prefix[0] === 0x25 && prefix[1] === 0x50
      && prefix[2] === 0x44 && prefix[3] === 0x46 && prefix[4] === 0x2d;
    if (!pdf) throw new Error('Download failed: the server did not return a valid PDF file');
  }
  return blob;
}

async function fetchBinaryDownload(path, expectedMime, fetchImpl) {
  const fetcher = fetchImpl || fetch;
  const response = await fetcher(path, {
    method: 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: { Accept: expectedMime },
  });
  const mime = downloadMime(response);
  if (!response.ok || mime !== expectedMime) throw await downloadResponseError(response, mime);
  return validateDownloadBlob(await response.blob(), expectedMime);
}

async function waitForCurrentPresentation(options) {
  const settings = options || {};
  const fetcher = settings.fetch || fetch;
  const timeoutMs = Number.isFinite(settings.timeoutMs) ? Math.max(0, settings.timeoutMs) : 30000;
  const pollMs = Number.isFinite(settings.pollMs) ? Math.max(1, settings.pollMs) : 400;
  const sleep = settings.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const Controller = settings.AbortController || AbortController;
  const controller = new Controller();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollMs) + 1);
  let lastError = null;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetcher('/api/health', {
          method: 'GET', cache: 'no-store', credentials: 'same-origin',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
        const mime = downloadMime(response);
        if (!response.ok || mime !== 'application/json') {
          throw await downloadResponseError(response, mime);
        }
        const health = await response.json();
        if (health && health.presentation && health.presentation.current === true) return health;
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) break;
      }
      if (attempt + 1 < maxAttempts) await sleep(pollMs);
    }
  } finally {
    clearTimeout(timeout);
  }
  const suffix = lastError && lastError.message ? ` (${lastError.message})` : '';
  throw new Error(`Presentation is still rendering. Try again in a moment${suffix}`);
}

async function requestPptxBlob(options) {
  const settings = options || {};
  const fetcher = settings.fetch || fetch;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const timeoutMs = Number.isFinite(settings.timeoutMs) ? Math.max(0, settings.timeoutMs) : 30000;
  const deadline = now() + timeoutMs;
  let staleError = null;
  for (;;) {
    try {
      return await fetchBinaryDownload('/api/pptx', DOWNLOAD_PPTX_MIME, fetcher);
    } catch (error) {
      if (!(error && error.status === 409 && error.jsonReply)) throw error;
      staleError = error;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      const suffix = staleError && staleError.message ? ` (${staleError.message})` : '';
      throw new Error(`Presentation is still rendering. Try again in a moment${suffix}`);
    }
    await waitForCurrentPresentation(Object.assign({}, settings, {
      fetch: fetcher, timeoutMs: remainingMs,
    }));
  }
}

function saveDownloadBlob(blob, filename, options) {
  const settings = options || {};
  const doc = settings.document || document;
  const urlApi = settings.URL || URL;
  const defer = settings.defer || ((fn) => setTimeout(fn, 0));
  const href = urlApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = href;
  link.download = filename;
  link.hidden = true;
  try {
    doc.body.appendChild(link);
    link.click();
  } finally {
    if (link.remove) link.remove();
    defer(() => urlApi.revokeObjectURL(href));
  }
}
// ---- end safe binary downloads ---------------------------------------------

function elHtml(e) {
  const cls = 'el el-' + esc(e.type);
  if (e.items) {
    if (!e.items.length) return `<ul class="${cls} empty" data-el="${esc(e.id)}" data-placeholder="(empty list)"></ul>`;
    return `<ul class="${cls}" data-el="${esc(e.id)}">` + e.items.map((i) => `<li>${esc(i)}</li>`).join('') + `</ul>`;
  }
  const empty = !e.text ? ' empty' : '';
  const ph = { title: 'Click title', subtitle: 'Subtitle', heading: 'Heading', body: 'Body text' }[e.type] || 'Text';
  return `<div class="${cls}${empty}" data-el="${esc(e.id)}" data-placeholder="${esc(ph)}">${esc(e.text)}</div>`;
}

// ---- positioned (thumbnail) rendering for imported/overlay decks
function decorHtml(d) {
  const b = d.box; if (!b) return '';
  const bg = d.kind === 'pic' ? 'repeating-linear-gradient(45deg,#e9edf3,#e9edf3 6px,#dfe4ec 6px,#dfe4ec 12px)' : (d.fill || 'transparent');
  return `<div class="decor" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%;background:${bg}"></div>`;
}

function elPosHtml(e) {
  const b = e.box || { x: 0.06, y: 0.06, w: 0.88, h: 0.12 };
  const st = e.style || {};
  const sizePt = st.size || (e.type === 'title' ? 30 : e.type === 'table' ? 14 : 13);
  const fs = (sizePt / slideHpt * 100).toFixed(2);
  const css = [
    `left:${b.x * 100}%`, `top:${b.y * 100}%`, `width:${b.w * 100}%`, `height:${b.h * 100}%`,
    `font-size:${fs}cqh`,
    st.align ? `text-align:${st.align}` : '',
    st.align === 'center' ? 'align-items:center' : (st.align === 'right' ? 'align-items:flex-end' : ''),
    st.bold ? 'font-weight:700' : '',
    st.color ? `color:${st.color}` : '',
    st.fill ? `background:${st.fill}` : '',
    st.outline ? `outline:1px solid ${st.outline}` : '',
    st.font ? `font-family:'${st.font}'` : ''
  ].filter(Boolean).join(';');
  const inner = e.items ? e.items.map((i) => `<div>${esc(i)}</div>`).join('') : esc(e.text || '');
  const empty = (!e.items && !e.text) ? ' empty' : '';
  const ro = e.readonly ? ' ro' : '';
  return `<div class="pel${empty}${ro}" data-el="${esc(e.id)}" data-placeholder="empty" style="${css}">${inner}</div>`;
}

function hotspotHtml(e) {
  const b = e.box; if (!b) return '';
  return `<div class="hotspot" data-el="${esc(e.id)}" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"></div>`;
}

function lockBadgeHtml(s) {
  const l = lockItems.find((x) => x.slideId === s.id);
  if (!l) return '';
  const mins = Math.round((Date.now() - (l.ts || 0)) / 60000);
  return `<span class="slide-lock" title="${esc(l.by)} claimed this slide ${mins}m ago${l.note ? ': ' + esc(l.note) : ''}">🔒 ${esc(l.by)}</span>`;
}

function slideHtml(s, i) {
  const notes = s.notes ? `<div class="slide-notes"><b>Notes:</b> ${esc(s.notes)}</div>` : '';
  let canvas;
  if (overlay && thumbsVer > 0) {
    // true PowerPoint-rendered slide image + invisible hotspots for edit flashes
    const spots = (s.elements || []).map(hotspotHtml).join('');
    canvas = `<div class="canvas thumb" style="aspect-ratio:${slideW}/${slideH}">
      <img src="/thumbs/slide-${i + 1}.png?v=${thumbsVer}" alt="slide ${i + 1}"
           onerror="this.style.display='none'">${spots}</div>`;
  } else if (overlay) {
    const decor = (s.decor || []).map(decorHtml).join('');
    const els = (s.elements || []).map(elPosHtml).join('');
    canvas = `<div class="canvas pos" style="aspect-ratio:${slideW}/${slideH}">${decor}${els}</div>`;
  } else {
    canvas = `<div class="canvas">${(s.elements || []).map(elHtml).join('')}</div>`;
  }
  return `<div class="slide" data-slide="${esc(s.id)}">
    <div class="slide-head">
      <span class="slide-num">${i + 1}</span>
      <span class="slide-layout">${esc(s.layout)}</span>
      <span class="slide-id">${esc(s.id)}</span>
      ${lockBadgeHtml(s)}
    </div>
    ${canvas}
    ${notes}
  </div>`;
}

function render() {
  overlay = (model.mode === 'overlay');
  slideW = model.slideW || 13.333;
  slideH = model.slideH || 7.5;
  slideHpt = slideH * 72;
  document.documentElement.style.setProperty('--accent', (model.theme && model.theme.accent) || '#2563eb');
  $('deckTitle').textContent = model.title || 'Untitled Presentation';
  $('revLabel').textContent = 'rev ' + (model.rev || 0);
  $('slideCount').textContent = model.slides.length + (model.slides.length === 1 ? ' slide' : ' slides');
  $('deck').innerHTML = model.slides.map(slideHtml).join('');
}

function flash(affected) {
  if (!affected) return;
  const sid = affected.slideId;
  if (sid) {
    const slide = document.querySelector(`.slide[data-slide="${cssEsc(sid)}"]`);
    if (slide) { slide.classList.remove('flash'); void slide.offsetWidth; slide.classList.add('flash');
      slide.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }
  if (affected.elementId) {
    const el = document.querySelector(`[data-el="${cssEsc(affected.elementId)}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
}
function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

// ------------------------------------------------------------------- status
function setPaused(on, by) {
  paused = on; pausedBy = by || null;
  const pill = $('statusPill');
  const btn = $('pauseBtn');
  const overlay = $('pausedOverlay');
  if (on) {
    pill.innerHTML = '<span class="status-paused">⏸ PAUSED</span>';
    btn.textContent = '▶ Resume'; btn.classList.add('resumed');
    overlay.classList.remove('hidden');
    $('pausedSub').textContent = by ? `Locked by ${by}. All editors blocked.` : 'All editors are locked out.';
  } else {
    pill.innerHTML = '<span class="status-live">● LIVE</span>';
    btn.textContent = '⏸ Pause'; btn.classList.remove('resumed');
    overlay.classList.add('hidden');
  }
}

function renderEditors(list) {
  // editorList() (server) attaches an agent color+ink to any editor whose
  // name is a known lead/worker (a pure function of the name, so this stays
  // in sync automatically). Studio already shows this; the main dashboard
  // never did, even though the data was already flowing here unused.
  $('editors').innerHTML = (list || []).map((e) => {
    const cls = 'chip' + (e.status === 'busy' ? ' busy' : e.status === 'free' ? ' free' : '') + (e.color ? ' agent' : '');
    const title = e.task ? `${e.name}: ${e.task}` : (e.status ? `${e.name} (${e.status})` : e.name);
    const style = e.color ? ` style="--agent:${esc(e.color)};--agent-ink:${esc(e.ink)}"` : '';
    return `<span class="${cls}"${style} title="${esc(title)}">${esc(e.name)}</span>`;
  }).join('');
}

// -------------------------------------------------------------------- feed
function feedItem(ev) {
  const t = new Date(ev.ts || Date.now()).toLocaleTimeString();
  let cls = 'feed-item', ic = '✎', who = '', what = '';
  if (ev.type === 'edit') { who = ev.editor; what = ev.detail || ev.opType; }
  else if (ev.type === 'pause') { cls += ' pause'; ic = '⏸'; who = 'PAUSED'; what = 'by ' + ev.by; }
  else if (ev.type === 'resume') { cls += ' resume'; ic = '▶'; who = 'RESUMED'; what = 'by ' + ev.by; }
  else if (ev.type === 'render') { ic = ev.ok ? '⤓' : '⚠'; who = ev.ok ? 'pptx' : 'render'; what = ev.ok ? 'updated' : (ev.error || 'failed'); }
  else if (ev.type === 'tasks') {
    const tk = ev.task || {};
    ic = ev.action === 'done' ? '✓' : ev.action === 'claim' ? '◐' : ev.action === 'delete' ? '×' : '＋';
    who = 'task'; what = (ev.action || 'update') + (tk.text ? ': ' + tk.text : '');
  }
  else if (ev.type === 'loops') {
    const lp = ev.loop || {};
    ic = ev.action === 'delete' ? '×' : ev.action === 'ran' ? '✓' : ev.action === 'toggle' ? (lp.enabled ? '🔁' : '⏸') : '＋';
    who = 'loop'; what = (ev.action || 'update') + (lp.text ? ': ' + lp.text : '');
  }
  else if (ev.type === 'pdf') { ic = ev.ok ? '⤓' : '⚠'; who = 'pdf'; what = ev.ok ? 'exported' : (ev.error || 'export failed'); }
  else if (ev.type === 'agent-spawn') { ic = '✦'; who = ev.name; what = `${ev.role === 'lead' ? 'lead' : 'worker'} joined`; }
  else if (ev.type === 'agent-exit') { ic = '✧'; who = ev.name; what = `${ev.role === 'lead' ? 'lead' : 'worker'} left`; }
  // undo/redo were the one pair of logged kinds with no branch, so seedFeed's
  // log.slice(-40) silently dropped them on every reload (a LIVE undo broadcasts
  // type:'edit' and does render, which is what hid this). Glyphs match the buttons.
  else if (ev.type === 'undo' || ev.type === 'redo') { ic = ev.type === 'undo' ? '↶' : '↷'; who = ev.editor; what = ev.detail || ev.type; }
  else return;
  const whoStyle = ev.ink ? ` style="color:${esc(ev.ink)}"` : '';
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `<span class="ic">${ic}</span><span><span class="who"${whoStyle}>${esc(who)}</span> <span class="what">${esc(what)}</span></span><span class="t">${t}</span>`;
  const list = $('feed');
  const empty = list.querySelector('.feed-empty');
  if (empty) empty.remove();
  list.prepend(div);
  while (list.children.length > 120) list.removeChild(list.lastChild);
}

// The 'agents' SSE event broadcasts the FULL roster on every status/depth
// change (turn-start, turn-end, enqueued), not just spawn/exit, so a naive
// feedItem(ev) per event would flood the feed with a line every time an agent
// so much as starts thinking. Diff by NAME PRESENCE instead: only surface an
// entry when an agent genuinely joins or leaves the team.
function diffAgents(newList) {
  const oldNames = new Set(agentsList.map((a) => a.name));
  const newNames = new Set((newList || []).map((a) => a.name));
  (newList || []).forEach((a) => {
    if (!oldNames.has(a.name)) feedItem({ type: 'agent-spawn', name: a.name, role: a.role, ink: a.ink, ts: Date.now() });
  });
  agentsList.forEach((a) => {
    if (!newNames.has(a.name)) feedItem({ type: 'agent-exit', name: a.name, role: a.role, ink: a.ink, ts: Date.now() });
  });
  agentsList = newList || [];
}

function seedFeed(log) {
  const list = $('feed');
  list.innerHTML = (log || []).length ? '' : `<div class="feed-empty">No activity yet.</div>`;
  (log || []).slice(-40).forEach((e) => feedItem(Object.assign({ type: e.kind === 'edit' ? 'edit' : e.kind, editor: e.editor, detail: e.detail, by: e.by }, e)));
}

// ------------------------------------------------------------- message board
let boardNotes = [];

const NOTES_COLLAPSED_COUNT = 8;
let notesExpanded = false;

function renderBoard(notes) {
  if (Array.isArray(notes)) boardNotes = notes;
  const pins = boardNotes.filter((n) => n.pinned);
  const msgs = boardNotes.filter((n) => !n.pinned);   // already newest-first from the API
  $('rulesCount').textContent = pins.length ? `${pins.length} rule${pins.length > 1 ? 's' : ''}` : '';
  $('rules').innerHTML = pins.length
    ? pins.map(ruleHtml).join('')
    : `<div class="board-empty">No house rules yet. Tick “Pin as house rule” to add one every session must follow.</div>`;
  const shown = notesExpanded ? msgs : msgs.slice(0, NOTES_COLLAPSED_COUNT);
  const toggle = msgs.length > NOTES_COLLAPSED_COUNT
    ? `<button class="board-toggle" id="notesToggle">${notesExpanded ? '▲ show recent only' : `▼ show all ${msgs.length} messages`}</button>`
    : '';
  $('notes').innerHTML = (msgs.length
    ? shown.map(noteHtml).join('')
    : `<div class="board-empty">No messages yet.</div>`) + toggle;
}

$('notes').addEventListener('click', (e) => {
  if (e.target && e.target.id === 'notesToggle') { notesExpanded = !notesExpanded; renderBoard(); }
});

function ruleHtml(n) {
  return `<div class="rule" data-id="${esc(n.id)}">
    <span class="rule-pin">📌</span>
    <div class="rule-main"><div class="rule-text">${esc(n.text)}</div><div class="rule-meta">${esc(n.author)}</div></div>
    <button class="mini-x" data-unpin="${esc(n.id)}" aria-label="Unpin this house rule" title="unpin (keep as a message)">×</button>
  </div>`;
}

function noteHtml(n) {
  const t = new Date(n.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<div class="note" data-id="${esc(n.id)}">
    <div class="note-head"><span class="note-author">${esc(n.author)}</span><span class="note-t">${t}</span>
    <button class="mini-x" data-del="${esc(n.id)}" aria-label="Delete this message" title="delete">×</button></div>
    <div class="note-text">${esc(n.text)}</div>
  </div>`;
}

// --------------------------------------------------------------- task list
let taskItems = [];

function renderTasks(tasks) {
  if (Array.isArray(tasks)) taskItems = tasks;
  const active = taskItems.filter((t) => t.status !== 'done');
  const done = taskItems.filter((t) => t.status === 'done');
  $('tasksCount').textContent = active.length ? `${active.length} open` : '';
  const parts = [];
  if (!active.length && !done.length) {
    parts.push(`<div class="board-empty">No tasks yet. Assign one to a session (leave “for” blank for anyone).</div>`);
  }
  active.forEach((t) => parts.push(taskHtml(t)));
  if (done.length) {
    parts.push(`<div class="notes-label">Done</div>`);
    done.slice(0, 12).forEach((t) => parts.push(taskHtml(t)));
  }
  $('tasklist').innerHTML = parts.join('');
}

function taskHtml(t) {
  const cls = 'task ' + esc(t.status);
  const who = t.assignee ? esc(t.assignee) : 'anyone';
  const claimed = (t.status === 'claimed' && t.claimedBy) ? ` · ${esc(t.claimedBy)}` : '';
  const doneBtn = t.status === 'done' ? '' : `<button class="mini-btn" data-done="${esc(t.id)}" aria-label="Mark task done" title="mark done">✓</button>`;
  return `<div class="${cls}" data-id="${esc(t.id)}">
    <div class="task-main">
      <div class="task-text">${esc(t.text)}</div>
      <div class="task-meta">→ ${who}${claimed}</div>
    </div>
    <div class="task-actions">${doneBtn}<button class="mini-x" data-taskdel="${esc(t.id)}" aria-label="Delete this task" title="delete">×</button></div>
  </div>`;
}

// ------------------------------------------------------------- standing loops
let loopItems = [];

function renderLoops(loops) {
  if (Array.isArray(loops)) loopItems = loops;
  const on = loopItems.filter((l) => l.enabled).length;
  $('loopsCount').textContent = loopItems.length ? `${on} on / ${loopItems.length}` : '';
  $('looplist').innerHTML = loopItems.length
    ? loopItems.map(loopHtml).join('')
    : `<div class="board-empty">No loops yet. Add a recurring check the sessions keep running on a /loop worker.</div>`;
}

function loopHtml(l) {
  const cls = 'loop' + (l.enabled ? ' on' : ' off');
  const every = l.cadence ? ` · every ${esc(l.cadence)}` : '';
  const last = l.lastRun
    ? `last run ${new Date(l.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${l.lastBy ? ' by ' + esc(l.lastBy) : ''}`
    : 'never run';
  return `<div class="${cls}" data-id="${esc(l.id)}">
    <button class="loop-toggle" data-toggle="${esc(l.id)}" aria-label="${l.enabled ? 'Disable' : 'Enable'} this loop" title="${l.enabled ? 'disable' : 'enable'}">${l.enabled ? '🔁' : '⏸'}</button>
    <div class="loop-main">
      <div class="loop-text">${esc(l.text)}</div>
      <div class="loop-meta">${l.enabled ? 'on' : 'off'}${every} · ${last}</div>
    </div>
    <button class="mini-x" data-loopdel="${esc(l.id)}" aria-label="Delete this loop" title="delete">×</button>
  </div>`;
}

// ------------------------------------------------------------- house-rule lint
const LINT_LABEL = { 'dash': 'em/en dash', 'min-size': 'under 20pt', 'header-align': 'header align', 'speaker-notes': 'speaker notes', 'font-family': 'font family' };

function renderLint(data) {
  if (!data) return;
  const countEl = $('lintCount');
  if (data.ok) {
    countEl.textContent = 'clean'; countEl.className = 'rules-count lint-count clean';
    $('lintlist').innerHTML = `<div class="lint-clean">✓ no violations found</div>`;
  } else {
    countEl.textContent = String(data.count); countEl.className = 'rules-count lint-count dirty';
    $('lintlist').innerHTML = (data.issues || []).map(lintIssueHtml).join('');
  }
}

function lintIssueHtml(i) {
  const where = i.elementId ? `${esc(i.slideId)} ${esc(i.elementId)}` : esc(i.slideId);
  return `<div class="lint-issue">
    <div class="lint-issue-main">
      <div class="lint-issue-type">${esc(LINT_LABEL[i.type] || i.type)}</div>
      <div class="lint-issue-where">${where}</div>
      <div class="lint-issue-detail">${esc(i.detail)}${i.text ? `: "${esc(i.text)}"` : ''}</div>
    </div>
  </div>`;
}

// -------------------------------------------------------------- timing estimate
// The 12-minute hard cap is a pinned house rule, but /api/timing (like
// /api/lint) was CLI-only, ppt time, nothing on the dashboard, the one page
// CLAUDE.md says the human actually watches. A compact always-visible badge
// next to rev/slide-count mirrors rulesCount's own density rather than a
// whole new detailed panel: this is a glance-at-a-number signal, not
// something that needs its own scrollable section.
function fmtMMSS(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function renderTiming(data) {
  if (!data) return;
  const el = $('timingLabel'); if (!el) return;
  el.textContent = '~' + fmtMMSS(data.totalSeconds);
  el.className = data.overCap ? 'timing-over' : (data.overTarget ? 'timing-warn' : 'timing-ok');
  el.title = `estimated speaking time from visible slide text, not a real rehearsal (target ${fmtMMSS(data.targetSeconds)}, hard cap ${fmtMMSS(data.capSeconds)})`;
}
function fetchTiming() {
  return fetchJson('/api/timing').then(renderTiming).catch(() => {});
}

function fetchLint() {
  return fetchJson('/api/lint').then(renderLint).catch(() => {});
}

// ------------------------------------------------------------------- toast
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('toast'); el.textContent = msg; el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

// -------------------------------------------------------------------- SSE
function connect() {
  disconnectEventStream();
  if (document.hidden) return;
  // ?viewer= marks this stream as a real browser viewer (see the idle reaper in
  // server.js). `ppt watch` opens the same endpoint without it on purpose.
  const stream = new EventSource('/api/events?viewer=dashboard');
  es = stream;
  // the dot conveyed its state by color alone, with one static title in every
  // state, so a stale deck was indistinguishable from a live one
  stream.onopen = () => {
    if (es !== stream) return;
    $('connDot').className = 'dot ok'; $('connDot').title = 'connected to the live server'; backoff = 1000;
  };
  stream.onerror = () => {
    if (es !== stream) return;
    $('connDot').className = 'dot bad';
    $('connDot').title = 'disconnected, retrying';
    stream.close();
    es = null;
    const delay = backoff;
    backoff = Math.min(backoff * 1.6, 8000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!es) connect();
    }, delay);
  };
  stream.onmessage = (m) => {
    if (es !== stream) return;
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    switch (ev.type) {
      case 'snapshot':
        model = ev.model; thumbsVer = ev.thumbs || thumbsVer; lockItems = ev.locks || [];
        undoCount = ev.undoCount || 0; redoCount = ev.redoCount || 0; updateUndoRedoButtons();
        agentsList = ev.agents || []; // seed, don't diff: a reconnect must not look like every live agent just spawned
        profileInfo = ev.profile || profileInfo; renderFastMode();
        pdfRev = ev.pdfRev != null ? ev.pdfRev : pdfRev; updatePdfButton();
        render();
        setPaused(ev.paused, ev.pausedBy); renderEditors(ev.editors); renderBoard(ev.board); renderTasks(ev.tasks); renderLoops(ev.loops);
        fetchLint(); fetchTiming();
        break;
      case 'locks':
        lockItems = ev.locks || []; render();
        break;
      case 'board':
        renderBoard(ev.notes);
        break;
      case 'tasks':
        renderTasks(ev.tasks); feedItem(ev);
        break;
      case 'loops':
        renderLoops(ev.loops); feedItem(ev);
        break;
      case 'thumbs':
        thumbsVer = ev.ver || (thumbsVer + 1);
        document.querySelectorAll('.canvas.thumb img').forEach((img, i) => {
          img.style.display = ''; img.src = `/thumbs/slide-${i + 1}.png?v=${thumbsVer}`;
        });
        if (!document.querySelector('.canvas.thumb')) render();  // first-time switch to thumb view
        break;
      case 'edit':
        model = ev.model; render(); flash(ev.affected); feedItem(ev);
        if (ev.undoCount != null) { undoCount = ev.undoCount; redoCount = ev.redoCount || 0; updateUndoRedoButtons(); }
        fetchLint(); fetchTiming(); updatePdfButton();
        break;
      case 'pause': setPaused(true, ev.by); feedItem(ev); break;
      case 'resume': setPaused(false); feedItem(ev); break;
      case 'editors': renderEditors(ev.editors); break;
      case 'render': feedItem(ev); if (!ev.ok) toast('Render failed', true); break;
      // A disk write for model.json genuinely failed (AV lock, full disk,
      // permissions): the server keeps serving its in-memory model, so
      // nothing else would ever tell a human their edit did not actually
      // save. This event has existed since before the dashboard ever
      // listened for it; neither page did until now.
      case 'persist': toast(`Save failed (${ev.file || 'disk'}): ${ev.error || 'unknown error'}`, true); break;
      case 'pdf': if (ev.ok) { pdfRev = ev.rev; updatePdfButton(); } feedItem(ev); break;
      case 'agents':
        diffAgents(ev.agents);
        profileInfo = ev.profile || profileInfo; renderFastMode();
        break;
      case 'ping': default: break;
    }
  };
}

function disconnectEventStream() {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (es) { es.close(); es = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnectEventStream();
  else if (!es) connect();
});

// ------------------------------------------------------------------ actions
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  // fetch does not reject on 4xx, so without this every server rejection (404 on a
  // stale id, 423 while paused) was reported as success: the composers cleared the
  // input and toasted "Pinned a house rule" over a write that never landed.
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

// ----------------------------------------------------- human Fast mode switch
function fastModeHtml(info, busy) {
  const fast = info && info.fastMode;
  if (!fast || typeof fast.enabled !== 'boolean') return '';
  const enabled = fast.enabled === true;
  const unavailable = fast.available === false;
  const pending = fast.pending === true;
  const state = enabled ? 'ON' : 'OFF';
  const scope = busy
    ? 'saving...'
    : unavailable
      ? 'not applied on Claude · next Codex spawn'
      : pending ? 'pending · next spawn' : 'next spawn';
  const title = fast.reason || `Fast ${state}. Applies to the next spawn; running agents are unchanged.`;
  return `<span class="fast-mode-ctl${pending ? ' pending' : ''}${unavailable ? ' unavailable' : ''}">`
    + `<button class="btn ghost fast-mode-button${enabled && !unavailable ? ' active' : ''}" type="button"`
    + ` data-fast-mode="${enabled ? 'false' : 'true'}" aria-pressed="${enabled}"`
    + `${busy ? ' disabled aria-busy="true"' : ''} title="${esc(title)}">Fast ${state}`
    + `${pending ? '<span class="fast-mode-next">·next</span>' : ''}</button>`
    + `<span class="fast-mode-scope">${esc(scope)}</span></span>`;
}

function mergeFastModeResult(result) {
  if (!profileInfo) profileInfo = {};
  profileInfo.fastMode = Object.assign({}, result);
  const next = profileInfo.nextExecution;
  if (next) {
    next.fastMode = result.appliedToNextSpawn === true;
    const definition = ((profileInfo.profiles || {})[profileInfo.profile]) || {};
    next.serviceTier = next.fastMode ? 'fast' : (definition.serviceTier || 'standard');
  }
}

function renderFastMode(info) {
  if (info) profileInfo = info;
  const mount = $('fastModeControl');
  if (mount) mount.innerHTML = fastModeHtml(profileInfo, fastModePosting);
}

async function setFastMode(enabled) {
  if (fastModePosting || typeof enabled !== 'boolean') return;
  fastModePosting = true;
  renderFastMode();
  try {
    const result = await post('/api/agents/fast-mode', { enabled, by: 'dashboard' });
    mergeFastModeResult(result);
    toast(result.available === false && result.enabled
      ? 'Fast saved ON, but not applied on Claude'
      : `Fast ${result.enabled ? 'ON' : 'OFF'} for the next spawn`);
  } catch (error) {
    toast((error && error.message) || 'Could not change Fast mode', true);
  } finally {
    fastModePosting = false;
    renderFastMode();
  }
}

if ($('fastModeControl')) $('fastModeControl').addEventListener('click', (event) => {
  const button = event.target && event.target.closest && event.target.closest('[data-fast-mode]');
  if (button) setFastMode(button.dataset.fastMode === 'true');
});

$('pauseBtn').addEventListener('click', async () => {
  const btn = $('pauseBtn'); btn.disabled = true;
  try {
    if (paused) { await post('/api/resume', { by: 'dashboard' }); toast('Resumed: editors unlocked'); }
    else { await post('/api/pause', { by: 'dashboard' }); toast('Paused: all editors locked'); }
  } catch (_) { toast('Action failed', true); }
  btn.disabled = false;
});

let pptxDownloadInFlight = null;
function downloadPptx(event) {
  if (event) event.preventDefault();
  if (pptxDownloadInFlight) return pptxDownloadInFlight;
  const btn = $('downloadBtn');
  const original = { text: btn.textContent, disabled: !!btn.disabled };
  btn.disabled = true;
  btn.textContent = 'Preparing...';
  btn.setAttribute('aria-busy', 'true');
  pptxDownloadInFlight = (async () => {
    try {
      const blob = await requestPptxBlob();
      saveDownloadBlob(blob, 'presentation.pptx');
      toast('PowerPoint downloaded');
    } catch (error) {
      toast((error && error.message) || 'PowerPoint download failed', true);
    } finally {
      btn.textContent = original.text;
      btn.disabled = original.disabled;
      btn.removeAttribute('aria-busy');
      pptxDownloadInFlight = null;
    }
  })();
  return pptxDownloadInFlight;
}
$('downloadBtn').addEventListener('click', downloadPptx);

let pdfExportInFlight = null;
function exportPdf(event) {
  if (event) event.preventDefault();
  if (pdfExportInFlight) return pdfExportInFlight;
  const btn = $('exportPdfBtn');
  const original = { text: btn.textContent, disabled: !!btn.disabled };
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  btn.setAttribute('aria-busy', 'true');
  pdfExportInFlight = (async () => {
    try {
      const r = await post('/api/pdf/export', {});
      if (!r || r.ok !== true) throw new Error((r && r.error) || 'PDF export failed');
      const blob = await fetchBinaryDownload('/api/pdf', DOWNLOAD_PDF_MIME);
      saveDownloadBlob(blob, 'presentation.pdf');
      toast('PDF downloaded');
    } catch (error) {
      toast((error && error.message) || 'PDF export failed', true);
    } finally {
      btn.textContent = original.text;
      btn.disabled = original.disabled;
      btn.removeAttribute('aria-busy');
      pdfExportInFlight = null;
      updatePdfButton();
    }
  })();
  return pdfExportInFlight;
}
$('exportPdfBtn').addEventListener('click', exportPdf);

async function doUndo() {
  if (historyPosting || !undoCount) return;
  historyPosting = true; updateUndoRedoButtons();
  try {
    const r = await post('/api/undo', { editor: 'dashboard' });
    if (r.ok) toast(`Undid ${r.undone.editor}: ${r.undone.detail}`);
    else toast(r.error || 'Nothing to undo', true);
  } catch (e) { toast(e.message || 'Undo failed', true); }
  finally { historyPosting = false; updateUndoRedoButtons(); }
}
async function doRedo() {
  if (historyPosting || !redoCount) return;
  historyPosting = true; updateUndoRedoButtons();
  try {
    const r = await post('/api/redo', { editor: 'dashboard' });
    if (r.ok) toast(`Redid ${r.redone.editor}: ${r.redone.detail}`);
    else toast(r.error || 'Nothing to redo', true);
  } catch (e) { toast(e.message || 'Redo failed', true); }
  finally { historyPosting = false; updateUndoRedoButtons(); }
}
$('undoBtn').addEventListener('click', doUndo);
$('redoBtn').addEventListener('click', doRedo);

// keyboard: spacebar toggles pause (only when not typing in the composer)
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('pauseBtn').click(); }
  if (e.key === '/' && e.target === document.body) { e.preventDefault(); $('deckSearch').focus(); }
});

// -------------------------------------------------------------- find a slide
// ppt search (the CLI, added earlier) had no dashboard equivalent: finding
// "which slide mentions X" on the page the human actually watches meant
// switching to a terminal. Jumps-and-flashes (reusing flash(), already used
// for edit highlighting) rather than a persistent filter overlay, which
// would need re-applying after every render()'s full innerHTML rebuild.
// Matching fields mirror ppt search's own (titles/bullets/body/notes).
function searchMatchIds(term) {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  return model.slides.filter((s) => {
    const texts = [];
    (s.elements || []).forEach((e) => {
      if (e.text) texts.push(e.text);
      if (Array.isArray(e.items)) texts.push(...e.items);
    });
    if (s.notes) texts.push(s.notes);
    return texts.some((t) => String(t == null ? '' : t).toLowerCase().includes(needle));
  }).map((s) => s.id);
}
let searchCycleIds = [], searchCycleIdx = -1, searchCycleTerm = null;
function jumpSearch(dir) {
  const input = $('deckSearch'); const countEl = $('searchCount');
  const term = input.value;
  if (!term.trim()) { countEl.textContent = ''; return; }
  if (term !== searchCycleTerm) { searchCycleIds = searchMatchIds(term); searchCycleIdx = -1; searchCycleTerm = term; }
  if (!searchCycleIds.length) { countEl.textContent = 'no matches'; return; }
  searchCycleIdx = ((searchCycleIdx + dir) % searchCycleIds.length + searchCycleIds.length) % searchCycleIds.length;
  countEl.textContent = `${searchCycleIdx + 1}/${searchCycleIds.length}`;
  flash({ slideId: searchCycleIds[searchCycleIdx] });
}
if ($('deckSearch')) {
  $('deckSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jumpSearch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.target.value = ''; searchCycleTerm = null; $('searchCount').textContent = ''; e.target.blur(); }
  });
  $('deckSearch').addEventListener('input', () => { searchCycleTerm = null; $('searchCount').textContent = ''; });
}

// ---- message board composer
$('asName').value = localStorage.getItem('suite_author') || 'human';

// A button can be double-clicked and Ctrl/Cmd+Enter calls these functions
// directly, so one latch per durable composer is the actual duplicate guard.
let notePosting = false, taskPosting = false, loopPosting = false;

async function submitNote() {
  if (notePosting) return;
  const text = $('noteText').value.trim();
  if (!text) return;
  const author = ($('asName').value.trim() || 'human');
  localStorage.setItem('suite_author', author);
  const pinned = $('pinCheck').checked;
  const send = $('sendNote');
  notePosting = true; send.disabled = true;
  try {
    await post('/api/board', { text, author, pinned });
    $('noteText').value = ''; $('pinCheck').checked = false;
    toast(pinned ? 'Pinned a house rule' : 'Message posted');
  } catch (_) { toast('Post failed', true); }
  finally { notePosting = false; send.disabled = false; }
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); submitNote(); });
$('noteText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitNote(); }
});

// unpin a rule / delete a message (event-delegated onto the live lists)
$('rules').addEventListener('click', (e) => {
  const id = e.target && e.target.getAttribute && e.target.getAttribute('data-unpin');
  if (id) post('/api/board/pin', { id, pinned: false }).catch(() => toast('Failed', true));
});
$('notes').addEventListener('click', (e) => {
  const id = e.target && e.target.getAttribute && e.target.getAttribute('data-del');
  if (id) post('/api/board/delete', { id }).catch(() => toast('Failed', true));
});

// ---- task composer (human assigns tasks to sessions from the dashboard)
async function submitTask() {
  if (taskPosting) return;
  const text = $('taskText').value.trim();
  if (!text) return;
  const by = ($('asName').value.trim() || 'human');
  const assignee = $('taskFor').value.trim();
  const send = $('sendTask');
  taskPosting = true; send.disabled = true;
  try {
    const r = await post('/api/tasks', { text, by, assignee, wakeWorker: !!assignee });
    $('taskText').value = ''; $('taskFor').value = '';
    const routed = r.task && r.task.assignee || assignee;
    toast(assignee
      ? (r.dispatch && r.dispatch.ok === false
          ? `Task saved for ${routed}; wake queued`
          : `Task sent to ${routed}`)
      : 'Passive task added');
  } catch (_) { toast('Add failed', true); }
  finally { taskPosting = false; send.disabled = false; }
}
$('taskComposer').addEventListener('submit', (e) => { e.preventDefault(); submitTask(); });
$('taskText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitTask(); }
});
$('tasklist').addEventListener('click', (e) => {
  const el = e.target;
  if (!el || !el.getAttribute) return;
  const doneId = el.getAttribute('data-done');
  const delId = el.getAttribute('data-taskdel');
  if (doneId) post('/api/tasks/done', { id: doneId, by: 'dashboard' }).catch(() => toast('Failed', true));
  else if (delId) post('/api/tasks/delete', { id: delId }).catch(() => toast('Failed', true));
});

// ---- loop composer (human sets standing recurring checks the sessions run)
async function submitLoop() {
  if (loopPosting) return;
  const text = $('loopText').value.trim();
  if (!text) return;
  const author = ($('asName').value.trim() || 'human');
  const cadence = $('loopEvery').value.trim();
  const send = $('sendLoop');
  loopPosting = true; send.disabled = true;
  try {
    await post('/api/loops', { text, author, cadence });
    $('loopText').value = ''; $('loopEvery').value = '';
    toast('Loop added');
  } catch (_) { toast('Add failed', true); }
  finally { loopPosting = false; send.disabled = false; }
}
$('loopComposer').addEventListener('submit', (e) => { e.preventDefault(); submitLoop(); });
$('loopText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitLoop(); }
});
$('looplist').addEventListener('click', (e) => {
  const el = e.target;
  if (!el || !el.getAttribute) return;
  const toggleId = el.getAttribute('data-toggle');
  const delId = el.getAttribute('data-loopdel');
  const loop = toggleId && loopItems.find((item) => item.id === toggleId);
  if (loop) post('/api/loops/toggle', { id: toggleId, enabled: !loop.enabled }).catch(() => toast('Failed', true));
  else if (delId) post('/api/loops/delete', { id: delId }).catch(() => toast('Failed', true));
});

// The sticky .rail sits below the sticky .topbar, so its top offset and its
// height cap are both a function of how tall the bar actually is. The bar wraps
// to a second row when the row runs out of width, and .editors grows as sessions
// connect, so that height is not a constant. Publish the measured value; the CSS
// falls back to a one-row 64px if this never fires.
const topbarEl = document.querySelector('.topbar');
if (topbarEl && window.ResizeObserver) {
  // offsetHeight, not entry.contentRect.height: contentRect is the content box,
  // which drops the bar's 12px padding and 1px border and would under-report by
  // 25px, sliding the rail right back under the bar.
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--topbar-h', topbarEl.offsetHeight + 'px');
  }).observe(topbarEl);
}

// bootstrap: pull full state once (in case SSE snapshot is delayed) then stream
fetch('/api/state').then((r) => r.json()).then((s) => {
  model = s.model; thumbsVer = s.thumbs || 0; lockItems = s.locks || []; render();
  undoCount = s.undoCount || 0; redoCount = s.redoCount || 0; updateUndoRedoButtons();
  agentsList = s.agents || []; // seed, don't diff: see the 'snapshot' case for why
  profileInfo = s.profile || profileInfo; renderFastMode();
  pdfRev = s.pdfRev != null ? s.pdfRev : pdfRev; updatePdfButton();
  setPaused(s.paused, s.pausedBy); renderEditors(s.editors); seedFeed(s.log); renderBoard(s.board); renderTasks(s.tasks); renderLoops(s.loops);
  fetchLint(); fetchTiming();
}).catch(() => {}).finally(connect);

// slow fallback poll, in case an edit lands via a client that predates the
// 'edit'-triggered refresh above (or the SSE stream briefly drops a message)
setInterval(fetchLint, 30000);
setInterval(fetchTiming, 30000);
