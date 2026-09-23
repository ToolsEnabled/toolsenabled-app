'use strict';
/* /studio — viewer + live glow + human controls. It consumes the same SSE
   stream / api/state as the main dashboard and never mutates model content;
   durable protections, like pause/history, go through explicit JSON APIs. */

const $ = (id) => document.getElementById(id);
const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
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

let model = { title: 'Untitled Presentation', slides: [], rev: 0 };
let paused = false;
let es = null, backoff = 1000, reconnectTimer = null;

// ---- agent presence + chat state
let boardNotes = [];       // the chat: board notes (non-pinned) render as bubbles
let editorsList = [];      // connected sessions, each carries color+ink (server-attached)
let lockItems = [];        // per-slide claims -> region indicators, colored by lock.by
let protectionItems = [];  // confirmed durable slide/object protections from the server
let protectionExceptionItems = []; // confirmed editable children beneath locked slides
let pendingProtection = null; // one optimistic toggle, overlaid without changing confirmed state
let selectedObject = null; // {kind:'object', slideId, objectId, objectKind}; selection is never a lock
// Per-object history is intentionally separate from the deck-wide undo stack.
// The server owns the durable snapshots; this state is only the currently
// focused object's ten-row view and the request guards that keep it honest.
let objectHistoryTarget = null;
let objectHistoryData = null;
let objectHistoryLoading = false;
let objectHistoryError = '';
let objectHistoryPosting = false;
let objectHistoryRefreshQueued = false;
let objectHistoryRequestSeq = 0;
let objectHistoryAbort = null;
let objectHistoryOpenTimer = null;
const OBJECT_HISTORY_LIMIT = 10;
let agentsList = [];       // live lead/worker roster (name, role, status, depth, color)
// The usage profile and the cost meter are BOTH server-owned (state.usageProfile
// / state.spend, see /api/agents/profile and /api/spend). Held here only as the
// last value seen, exactly like agentsList: this page never computes spend, it
// reports it. Both ride the snapshot and the agents/spend SSE events.
let profileInfo = null;    // profileView(): definitions, two pool caps, next execution, and running agents
let fastModePosting = false;
let spendInfo = null;      // spendView(): {totalUsd, turns, tokens, byModel, byRole, rateLimit}

// Client copy of the server's PURE name->color function (suite/agents.js), so
// the chips/rails/glow resolve the SAME color the server attaches. The server's
// editors[] is authoritative when present; this is the fallback (load-bearing:
// a lock owner's 15s editor heartbeat expires long before its 20min lock, so a
// rail must stay colored after the owner drops off the editors list).
const AGENT_COLORS = [
  { key: 'blue',    chip: '#2A78D6', ink: '#14417F' },
  { key: 'gold',    chip: '#F1B82D', ink: '#B8860B' },
  { key: 'emerald', chip: '#10B981', ink: '#047857' },
  { key: 'violet',  chip: '#8B5CF6', ink: '#6D28D9' },
];
// Map, not a plain object literal: a plain {} lookup keyed by an arbitrary
// name (e.g. a hand-set SUITE_EDITOR value) resolves inherited keys like
// 'constructor' through the prototype chain instead of returning undefined,
// which skips the idx===undefined fallback below and throws on c.chip.
// Mirrors the same fix applied to agents.js's PINNED table.
const AGENT_PINNED = new Map([['lead', 0], ['worker-1', 1], ['worker-2', 2], ['worker-3', 3]]);
const NON_AGENT = new Set(['josh', 'human', 'studio', 'dashboard', '']);
function agentColor(name) {
  if (name == null) return null;
  const k = String(name).toLowerCase();
  if (NON_AGENT.has(k)) return null;
  let idx = AGENT_PINNED.get(k);
  if (idx === undefined) {
    let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    idx = h % AGENT_COLORS.length;
  }
  const c = AGENT_COLORS[idx];
  return { color: c.chip, ink: c.ink, key: c.key };
}
// Prefer the server-attached color on the editors payload; fall back to the
// pure function for names not currently in editors (e.g. an idle lock owner).
function colorFor(name) {
  const ed = editorsList.find((e) => (e.name || e.id) === name);
  if (ed && ed.color) return { color: ed.color, ink: ed.ink, key: ed.key };
  return agentColor(name);
}

// ------------------------------------------------ durable protections
// Backend contract, centralized here so a route revision is a one-line change:
//   state.protections / SSE protections:
//     {kind:'slide'|'object', slideId, objectId?, objectKind?, by?, createdAt?}
//   POST body:
//     the same stable identity plus {protected:boolean, by:<human Studio name>}
// These records constrain future edits; they never rewrite model content.
const PROTECTION_TOGGLE_ENDPOINT = '/api/protections/toggle';

function findModelObject(slideId, objectId, preferredKind) {
  const slide = (model.slides || []).find((s) => s.id === slideId);
  if (!slide || objectId == null) return null;
  const find = (items) => (items || []).find((o) => o.id === objectId);
  if (preferredKind === 'element') {
    const object = find(slide.elements); return object ? { object, objectKind: 'element', slide } : null;
  }
  if (preferredKind === 'decor') {
    const object = find(slide.decor); return object ? { object, objectKind: 'decor', slide } : null;
  }
  const element = find(slide.elements);
  if (element) return { object: element, objectKind: 'element', slide };
  const decor = find(slide.decor);
  return decor ? { object: decor, objectKind: 'decor', slide } : null;
}

function normalizeProtection(row) {
  if (!row || row.slideId == null) return null;
  const kind = row.kind === 'object' ? 'object' : row.kind === 'slide' ? 'slide' : null;
  if (!kind) return null;
  const slideId = String(row.slideId);
  if (kind === 'slide') {
    return {
      kind, slideId,
      by: row.by == null ? null : String(row.by),
      createdAt: row.createdAt == null ? null : String(row.createdAt),
    };
  }
  if (row.objectId == null) return null;
  const objectId = String(row.objectId);
  let objectKind = row.objectKind === 'element' || row.objectKind === 'decor' ? row.objectKind : null;
  if (!objectKind) {
    const found = findModelObject(slideId, objectId);
    objectKind = found ? found.objectKind : null;
  }
  return {
    kind, slideId, objectId, objectKind,
    by: row.by == null ? null : String(row.by),
    createdAt: row.createdAt == null ? null : String(row.createdAt),
  };
}

// Toggle responses are a commit acknowledgement, so treat their protection
// list as a strict contract. The ordinary normalization path stays lenient for
// legacy SSE/state input, but a malformed successful POST must roll the
// optimistic UI back rather than manufacturing client-only protection state.
function validProtectionRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || !['slide', 'object'].includes(row.kind)
      || typeof row.slideId !== 'string' || !row.slideId.trim()) return false;
  const allowed = row.kind === 'slide'
    ? new Set(['kind', 'slideId', 'by', 'createdAt'])
    : new Set(['kind', 'slideId', 'objectId', 'objectKind', 'by', 'createdAt']);
  if (Object.keys(row).some((key) => !allowed.has(key))) return false;
  if (row.by !== undefined
      && (typeof row.by !== 'string' || !row.by.trim() || row.by.length > 60)) return false;
  if (row.createdAt !== undefined
      && (!Number.isSafeInteger(row.createdAt) || row.createdAt < 0)) return false;
  if (row.kind === 'slide') {
    return row.objectId === undefined && row.objectKind === undefined;
  }
  return typeof row.objectId === 'string' && !!row.objectId.trim()
    && ['element', 'decor'].includes(row.objectKind);
}

function canonicalProtectionRows(rows) {
  if (!Array.isArray(rows) || !rows.every(validProtectionRow)) return null;
  const normalized = normalizeProtections(rows);
  return normalized.length === rows.length ? normalized : null;
}

function normalizeProtectionExceptions(rows) {
  return normalizeProtections(rows).filter((row) => row.kind === 'object');
}

function canonicalProtectionExceptionRows(rows) {
  if (!Array.isArray(rows) || !rows.every((row) => row.kind === 'object' &&
      validProtectionRow(row) && typeof row.by === 'string' && !!row.by.trim() &&
      Number.isSafeInteger(row.createdAt))) {
    return null;
  }
  const normalized = normalizeProtectionExceptions(rows);
  return normalized.length === rows.length ? normalized : null;
}

function protectionActor() {
  const input = $('asName');
  const name = input && typeof input.value === 'string' ? input.value.trim() : '';
  return (name || 'josh').slice(0, 60);
}

function protectionKey(target) {
  if (!target) return '';
  return target.kind === 'slide'
    ? `slide:${target.slideId}`
    : `object:${target.slideId}:${target.objectKind || 'object'}:${target.objectId}`;
}

function sameProtectionTarget(a, b) {
  if (!a || !b || a.kind !== b.kind || a.slideId !== b.slideId) return false;
  if (a.kind === 'slide') return true;
  return a.objectId === b.objectId
    && (!a.objectKind || !b.objectKind || a.objectKind === b.objectKind);
}

function normalizeProtections(rows) {
  const result = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const item = normalizeProtection(row);
    if (!item) return;
    const at = result.findIndex((existing) => sameProtectionTarget(existing, item));
    if (at >= 0) result[at] = item;
    else result.push(item);
  });
  return result;
}

function replaceProtection(rows, target, protectedState, serverRow) {
  const next = rows.filter((row) => !sameProtectionTarget(row, target));
  if (protectedState) {
    next.push(normalizeProtection(serverRow) || {
      kind: target.kind,
      slideId: target.slideId,
      ...(target.kind === 'object' ? { objectId: target.objectId, objectKind: target.objectKind } : {}),
      by: 'studio',
      createdAt: new Date().toISOString(),
    });
  }
  return next;
}

// Confirmed rows stay separate from the optimistic row. An SSE update arriving
// while the POST is in flight can update the base safely; clearing the pending
// overlay on failure then reveals the latest server truth, not a stale snapshot.
function visibleProtections() {
  if (!pendingProtection) return protectionItems;
  const target = pendingProtection.target;
  if (target.kind === 'slide') {
    const withoutSlideTree = protectionItems.filter((item) => item.slideId !== target.slideId);
    return pendingProtection.protected
      ? replaceProtection(withoutSlideTree, target, true, pendingProtection.row)
      : withoutSlideTree;
  }
  const parentSlideLocked = target.kind === 'object' && protectionItems.some((item) =>
    item.kind === 'slide' && item.slideId === target.slideId
  );
  // Beneath a locked slide, object toggles change the inverse exception branch.
  if (parentSlideLocked) return protectionItems;
  return replaceProtection(
    protectionItems,
    pendingProtection.target,
    pendingProtection.protected,
    pendingProtection.row
  );
}

function visibleProtectionExceptions() {
  if (!pendingProtection) return protectionExceptionItems;
  const target = pendingProtection.target;
  if (target.kind === 'slide') {
    return protectionExceptionItems.filter((item) => item.slideId !== target.slideId);
  }
  const parentSlideLocked = protectionItems.some((item) =>
    item.kind === 'slide' && item.slideId === target.slideId
  );
  if (!parentSlideLocked) {
    return protectionExceptionItems.filter((item) => !sameProtectionTarget(item, target));
  }
  return replaceProtection(
    protectionExceptionItems,
    target,
    !pendingProtection.protected,
    pendingProtection.row
  );
}

function receiveProtections(rows, exceptions) {
  protectionItems = normalizeProtections(rows);
  protectionExceptionItems = normalizeProtectionExceptions(exceptions);
  paintProtectionState();
  renderProtections();
  renderObjectHistory();
}

function findProtection(target, rows) {
  return (rows || visibleProtections()).find((row) => sameProtectionTarget(row, target)) || null;
}

function findProtectionException(target, rows) {
  return (rows || visibleProtectionExceptions())
    .find((row) => sameProtectionTarget(row, target)) || null;
}

function protectionStateForTarget(target, rows, exceptions) {
  const locks = rows || visibleProtections();
  const editable = exceptions || visibleProtectionExceptions();
  if (!target) return { locked: false, source: 'none' };
  if (target.kind === 'slide') {
    const direct = findProtection(target, locks);
    return { locked: !!direct, source: direct ? 'slide' : 'none', protection: direct };
  }
  const slideLock = findProtection({ kind: 'slide', slideId: target.slideId }, locks);
  const exception = slideLock && findProtectionException(target, editable);
  if (exception) return { locked: false, source: 'exception', exception, protection: slideLock };
  const direct = findProtection(target, locks);
  if (direct) return { locked: true, source: 'object', protection: direct };
  if (slideLock) return { locked: true, source: 'slide', protection: slideLock };
  return { locked: false, source: 'none' };
}

function cleanObjectText(object) {
  const raw = object && (object.text != null
    ? object.text
    : Array.isArray(object.items) ? object.items.join(' ') : '');
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function boxLocation(box) {
  if (!box) return '';
  const cy = Number(box.y || 0) + Number(box.h || 0) / 2;
  const cx = Number(box.x || 0) + Number(box.w || 0) / 2;
  const vertical = cy > .67 ? 'bottom' : cy < .33 ? 'top' : 'middle';
  const horizontal = cx < .34 ? 'left' : cx > .66 ? 'right' : 'center';
  return `${vertical} ${horizontal}`;
}

function objectUiLabel(target) {
  if (!target || target.kind !== 'object') return '';
  const found = findModelObject(target.slideId, target.objectId, target.objectKind);
  if (!found) return `${target.objectKind || 'object'} ${target.objectId} (missing from current model)`;
  const text = cleanObjectText(found.object);
  if (found.objectKind === 'element' && text) {
    return `${text.length > 54 ? text.slice(0, 51) + '…' : text} · ${target.objectId}`;
  }
  const sourceName = found.object.source
    ? String(found.object.source).split(/[\\/]/).pop()
    : '';
  const detail = sourceName || found.object.kind || found.object.type || 'decoration';
  const where = boxLocation(found.object.box);
  return `${detail} decoration ${target.objectId}${where ? ` · ${where}` : ''}`;
}

function targetLabel(target) {
  if (!target) return '';
  const n = slideNumber(target.slideId);
  if (target.kind === 'slide') return `Slide ${n || target.slideId}`;
  return `${objectUiLabel(target)} on slide ${n || target.slideId}`;
}

function targetDataAttrs(target) {
  const attrs = [
    `data-kind="${esc(target.kind)}"`,
    `data-slide-id="${esc(target.slideId)}"`,
  ];
  if (target.kind === 'object') {
    attrs.push(`data-object-id="${esc(target.objectId)}"`);
    attrs.push(`data-object-kind="${esc(target.objectKind || '')}"`);
  }
  return attrs.join(' ');
}

function protectionActionButton(target, protectedState, compact) {
  const nextState = !protectedState;
  const verb = nextState ? 'Lock' : 'Unlock';
  const noun = target.kind === 'slide' ? 'slide' : 'object';
  const busy = !!pendingProtection;
  const icon = protectedState ? '&#128275;' : '&#128274;';
  const compactClass = protectedState ? 'protection-unlock' : 'protection-relock';
  return `<button type="button" class="${compact ? compactClass : 'protection-action'}${protectedState ? ' is-locked' : ''}"
    data-protection-toggle="1" ${targetDataAttrs(target)}
    data-protected="${nextState}"${busy ? ' disabled' : ''}
    aria-pressed="${protectedState}" title="${esc(`${verb} ${targetLabel(target)}`)}"
    aria-label="${esc(`${verb} ${targetLabel(target)}`)}"><span aria-hidden="true">${icon}</span>${compact ? verb : `${verb} ${noun}`}</button>`;
}

function protectionStateBadge(state) {
  const value = typeof state === 'boolean'
    ? { locked: state, source: state ? 'object' : 'none' }
    : (state || { locked: false, source: 'none' });
  const editable = value.source === 'exception';
  return `<span class="protection-state${value.locked ? ' is-locked' : ''}${editable ? ' is-editable' : ''}">
    <span aria-hidden="true">${value.locked ? '&#128274;' : '&#128275;'}</span>${editable ? 'Editable' : value.locked ? 'Locked' : 'Unlocked'}
  </span>`;
}

function renderProtections() {
  const rows = visibleProtections();
  const exceptions = visibleProtectionExceptions();
  const activeRows = rows.filter((item) => item.kind === 'slide' ||
    !exceptions.some((exception) => sameProtectionTarget(exception, item)));
  const count = activeRows.length;
  const exceptionCount = exceptions.length;
  const badge = $('protectionsCount');
  const panelCount = $('protectionsCountPanel');
  if (badge) badge.textContent = count ? String(count) : '';
  if (panelCount) panelCount.textContent = `${count} locked${exceptionCount ? ` · ${exceptionCount} editable` : ''}`;

  const selection = $('protectionSelection');
  const slide = (model.slides || [])[currentPos()];
  const slideTarget = slide ? { kind: 'slide', slideId: slide.id } : null;
  const slideState = protectionStateForTarget(slideTarget, rows, exceptions);
  const slideProtected = slideState.locked;
  const selected = slide && selectedObject && selectedObject.slideId === slide.id ? selectedObject : null;
  const selectedState = protectionStateForTarget(selected, rows, exceptions);
  const selectedProtected = selectedState.locked;
  if (selection) {
    if (!slide) {
      selection.innerHTML = '<div class="protection-selection-empty">Open a slide to lock the slide or one of its objects.</div>';
    } else {
      const claim = (lockItems || []).find((item) => item.slideId === slide.id);
      const objectLine = selected
        ? `<div class="protection-selection-row">
            <div class="protection-selection-copy"><span class="protection-kicker">Selected ${esc(selected.objectKind || 'object')}</span>
            <span class="protection-title-line"><strong>${esc(objectUiLabel(selected))}</strong>${protectionStateBadge(selectedState)}</span></div>
            ${protectionActionButton(selected, selectedProtected, false)}
          </div>`
        : `<div class="protection-selection-tip"><strong>Objects are one gesture.</strong>
            <span>Double-click any item on the slide to ${slideProtected ? 'make it editable' : 'lock it'}. Double-click again to reverse it.</span></div>`;
      selection.innerHTML = `
        <div class="protection-selection-row">
          <div class="protection-selection-copy"><span class="protection-kicker">Current slide</span>
          <span class="protection-title-line"><strong>Slide ${slideNumber(slide.id)} · ${esc(slide.id)}</strong>${protectionStateBadge(slideState)}</span></div>
          ${protectionActionButton(slideTarget, slideProtected, false)}
        </div>
        ${objectLine}
        ${selectedState.source === 'exception' ? '<div class="protection-scope-note">This item is editable; the rest of the slide stays locked.</div>' : ''}
        ${selectedState.source === 'slide' ? '<div class="protection-scope-note">This item inherits the slide lock. Double-click it to make just this item editable.</div>' : ''}
        ${claim ? `<div class="temporary-claim-note">Temporary collaborator claim: ${esc(claim.by || 'another editor')}</div>` : ''}
        ${pendingProtection ? '<div class="protection-saving" aria-live="polite">Saving lock change…</div>' : ''}`;
    }
  }

  const quickbar = $('lockQuickbar');
  if (quickbar) {
    const showQuickbar = mode === 'single' && !!slide;
    quickbar.hidden = !showQuickbar;
    if (!showQuickbar) {
      quickbar.innerHTML = '';
    } else {
      const slideExceptions = exceptions.filter((item) => item.slideId === slide.id).length;
      const slideObjectLocks = activeRows.filter((item) =>
        item.kind === 'object' && item.slideId === slide.id).length;
      const hint = slideProtected
        ? `Double-click an item to unlock it${slideExceptions ? ` · ${slideExceptions} editable` : ''}`
        : `Double-click an item to lock it${slideObjectLocks ? ` · ${slideObjectLocks} locked` : ''}`;
      quickbar.innerHTML = `
        <div class="lock-quick-target lock-quick-slide">
          <span class="lock-quick-copy"><small>Slide ${slideNumber(slide.id)}</small><strong>${hint}</strong></span>
          ${protectionActionButton(slideTarget, slideProtected, false)}
        </div>
        <button type="button" class="lock-manage-button" data-open-locks="1" aria-label="Open all locks">All locks</button>
        ${pendingProtection ? '<span class="sr-only" aria-live="polite">Saving lock change</span>' : ''}`;
    }
  }

  const list = $('protectionList');
  if (!list) return;
  if (!activeRows.length && !exceptions.length) {
    list.innerHTML = '<div class="panel-empty">No saved locks yet.</div>';
    return;
  }
  const sorted = activeRows.slice().sort((a, b) => {
    const ai = (model.slides || []).findIndex((slideItem) => slideItem.id === a.slideId);
    const bi = (model.slides || []).findIndex((slideItem) => slideItem.id === b.slideId);
    return (ai < 0 ? 99999 : ai) - (bi < 0 ? 99999 : bi)
      || (a.kind === b.kind ? 0 : a.kind === 'slide' ? -1 : 1)
      || protectionKey(a).localeCompare(protectionKey(b));
  });
  const lockedHtml = sorted.map((item) => {
    const objectMeta = item.kind === 'object'
      ? `<span>${esc(item.objectKind || 'object')} · ${esc(item.objectId)}</span>`
      : `<span>slide · ${esc(item.slideId)}</span>`;
    const owner = item.by ? `<span>locked by ${esc(item.by)}</span>` : '';
    const isPending = pendingProtection && sameProtectionTarget(pendingProtection.target, item);
    return `<div class="protection-row${isPending ? ' pending' : ''}" data-protection-key="${esc(protectionKey(item))}">
      <span class="protection-lock" aria-hidden="true">&#128274;</span>
      <div class="protection-row-copy">
        <strong>${esc(targetLabel(item))}</strong>
        <small>${objectMeta}${owner}</small>
      </div>
      ${protectionActionButton(item, true, true)}
    </div>`;
  }).join('');
  const editableHtml = exceptions.map((item) => {
    const owner = item.by ? `<span>made editable by ${esc(item.by)}</span>` : '';
    const isPending = pendingProtection && sameProtectionTarget(pendingProtection.target, item);
    return `<div class="protection-row exception${isPending ? ' pending' : ''}" data-protection-key="exception:${esc(protectionKey(item))}">
      <span class="protection-lock" aria-hidden="true">&#128275;</span>
      <div class="protection-row-copy">
        <strong>${esc(targetLabel(item))}</strong>
        <small><span>editable on locked slide</span>${owner}</small>
      </div>
      ${protectionActionButton(item, false, true)}
    </div>`;
  }).join('');
  list.innerHTML = lockedHtml + editableHtml;
}

function spotForTarget(target) {
  if (!target || target.kind !== 'object') return null;
  const card = document.querySelector(`.card[data-slide="${cssEsc(target.slideId)}"]`);
  return card && card.querySelector(
    `.spot[data-object-id="${cssEsc(target.objectId)}"][data-object-kind="${cssEsc(target.objectKind || '')}"]`
  );
}

function paintProtectionState() {
  const rows = visibleProtections();
  const exceptions = visibleProtectionExceptions();
  document.querySelectorAll('.card').forEach((card) => {
    card.classList.remove('protected-slide', 'has-protected-object', 'has-editable-object');
    card.removeAttribute('data-persistently-protected');
    const base = card.getAttribute('data-base-label') || card.getAttribute('aria-label') || 'Slide';
    card.setAttribute('aria-label', base);
    card.querySelectorAll('[data-protection-summary], [data-object-selection]').forEach((tag) => tag.remove());
  });
  document.querySelectorAll('.spot').forEach((spot) => {
    spot.classList.remove('protected-object', 'unlocked-object', 'selected-object', 'protection-pending');
    spot.removeAttribute('aria-current');
    spot.removeAttribute('data-protected');
    spot.removeAttribute('data-protection-exception');
    const base = spot.getAttribute('data-base-label') || 'Select slide object';
    spot.setAttribute('aria-label', base);
    spot.title = 'Double-click to lock or unlock this item';
  });

  const summaries = new Map();
  rows.forEach((item) => {
    const card = document.querySelector(`.card[data-slide="${cssEsc(item.slideId)}"]`);
    if (!card) return;
    const summary = summaries.get(item.slideId) || { slide: false, objects: 0, exceptions: 0 };
    if (item.kind === 'slide') {
      summary.slide = true;
      card.classList.add('protected-slide');
      card.setAttribute('data-persistently-protected', 'slide');
      card.setAttribute(
        'aria-label',
        `${card.getAttribute('data-base-label') || card.getAttribute('aria-label') || 'Slide'} — persistently protected`
      );
    } else {
      if (exceptions.some((exception) => sameProtectionTarget(exception, item))) {
        summaries.set(item.slideId, summary);
        return;
      }
      summary.objects++;
      card.classList.add('has-protected-object');
      const spot = spotForTarget(item);
      if (spot) {
        spot.classList.add('protected-object');
        spot.setAttribute('data-protected', 'true');
        spot.setAttribute('aria-label', `${spot.getAttribute('data-base-label')} — locked; double-click to unlock`);
      }
    }
    summaries.set(item.slideId, summary);
  });

  exceptions.forEach((item) => {
    const card = document.querySelector(`.card[data-slide="${cssEsc(item.slideId)}"]`);
    if (!card) return;
    const summary = summaries.get(item.slideId) || { slide: true, objects: 0, exceptions: 0 };
    summary.exceptions++;
    card.classList.add('has-editable-object');
    const spot = spotForTarget(item);
    if (spot) {
      spot.classList.remove('protected-object');
      spot.classList.add('unlocked-object');
      spot.setAttribute('data-protected', 'false');
      spot.setAttribute('data-protection-exception', 'true');
      spot.setAttribute('aria-label', `${spot.getAttribute('data-base-label')} — editable while slide is locked; double-click to lock`);
      spot.title = 'Editable while slide is locked — double-click to lock';
    }
    summaries.set(item.slideId, summary);
  });

  document.querySelectorAll('.card').forEach((card) => {
    const slideId = card.dataset && card.dataset.slide;
    const summary = summaries.get(slideId) || { slide: false, objects: 0, exceptions: 0 };
    const control = card.querySelector && card.querySelector('[data-card-lock-toggle]');
    if (control) {
      const n = slideNumber(slideId);
      const verb = summary.slide ? 'Unlock' : 'Lock';
      control.dataset.protected = String(!summary.slide);
      control.setAttribute('aria-pressed', String(summary.slide));
      control.setAttribute('aria-label', `${verb} slide ${n || slideId}`);
      control.title = `${verb} slide ${n || slideId}`;
      control.classList.toggle('is-locked', summary.slide);
      control.disabled = !!pendingProtection;
      control.innerHTML = `<span aria-hidden="true">${summary.slide ? '&#128274;' : '&#128275;'}</span><span>${verb} slide</span>`;
    }
    if (summary.slide) {
      card.querySelectorAll('.spot').forEach((spot) => {
        if (spot.classList.contains('unlocked-object')) return;
        const base = spot.getAttribute('data-base-label') || 'Select slide object';
        if (!spot.classList.contains('protected-object')) {
          spot.setAttribute('aria-label', `${base} — locked by slide; double-click to unlock`);
        }
        spot.title = 'Locked by slide — double-click to make editable';
      });
    }
  });

  summaries.forEach((summary, slideId) => {
    const card = document.querySelector(`.card[data-slide="${cssEsc(slideId)}"]`);
    const head = card && card.querySelector('.card-head');
    if (!head) return;
    const tag = document.createElement('span');
    tag.className = 'protection-tag';
    tag.setAttribute('data-protection-summary', '1');
    const objectPart = summary.objects
      ? `${summary.objects} object${summary.objects === 1 ? '' : 's'}`
      : '';
    const editablePart = summary.exceptions
      ? `🔓 ${summary.exceptions} editable`
      : '';
    tag.textContent = `${summary.slide ? '🔒 Slide' : ''}${summary.slide && objectPart ? ' + ' : ''}${objectPart}${(summary.slide || objectPart) && editablePart ? ' · ' : ''}${editablePart}`;
    tag.title = summary.exceptions
      ? 'Saved lock with editable object exceptions'
      : 'Saved human lock';
    head.appendChild(tag);
  });

  if (selectedObject) {
    const spot = spotForTarget(selectedObject);
    if (spot) {
      spot.classList.add('selected-object');
      spot.setAttribute('aria-current', 'true');
      spot.setAttribute('aria-label', `${spot.getAttribute('aria-label')} — selected`);
    }
    const card = document.querySelector(`.card[data-slide="${cssEsc(selectedObject.slideId)}"]`);
    const head = card && card.querySelector('.card-head');
    if (head) {
      const tag = document.createElement('span');
      tag.className = 'selection-tag';
      tag.setAttribute('data-object-selection', '1');
      tag.textContent = `Selected: ${selectedObject.objectKind || 'object'} ${selectedObject.objectId}`;
      head.appendChild(tag);
    }
  }
  if (pendingProtection) {
    const spot = spotForTarget(pendingProtection.target);
    if (spot) spot.classList.add('protection-pending');
  }
}

async function requestProtectionToggle(target, protectedState, by) {
  const body = {
    kind: target.kind,
    slideId: target.slideId,
    ...(target.kind === 'object'
      ? { objectId: target.objectId, objectKind: target.objectKind }
      : {}),
    protected: !!protectedState,
    by,
  };
  const response = await fetch(PROTECTION_TOGGLE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  const protections = data && canonicalProtectionRows(data.protections);
  const exceptions = data && canonicalProtectionExceptionRows(
    data.protectionExceptions === undefined ? [] : data.protectionExceptions
  );
  if (!response.ok || !data || data.ok !== true || !protections || !exceptions) {
    throw new Error((data && data.error)
      || (response.ok ? 'Invalid protection response' : `HTTP ${response.status}`));
  }
  return { ...data, protections, protectionExceptions: exceptions };
}

function focusProtectionControl(target) {
  const panel = $('panelProtections');
  const quickbar = $('lockQuickbar');
  const selector = `[data-protection-toggle][data-kind="${cssEsc(target.kind)}"]`
    + `[data-slide-id="${cssEsc(target.slideId)}"]`
    + (target.kind === 'object'
      ? `[data-object-id="${cssEsc(target.objectId)}"][data-object-kind="${cssEsc(target.objectKind || '')}"]`
      : '');
  const preferred = panel && !panel.hidden ? panel : quickbar && !quickbar.hidden ? quickbar : document;
  const next = preferred.querySelector(selector)
    || document.querySelector(selector)
    || (panel && panel.querySelector('[data-protection-toggle]:not([disabled])'))
    || (panel && panel.querySelector('[data-close]'));
  if (next && next.focus) next.focus();
}

async function toggleProtection(target, protectedState) {
  if (pendingProtection) return;
  const normalized = normalizeProtection(target);
  if (!normalized) { toast('That slide or object has no stable protection identity.', true); return; }
  const by = protectionActor();
  pendingProtection = {
    target: normalized,
    protected: !!protectedState,
    row: { ...normalized, by, createdAt: new Date().toISOString() },
  };
  paintProtectionState();
  renderProtections();
  renderObjectHistory();
  try {
    const result = await requestProtectionToggle(normalized, protectedState, by);
    protectionItems = result.protections;
    protectionExceptionItems = result.protectionExceptions;
    pendingProtection = null;
    paintProtectionState();
    renderProtections();
    renderObjectHistory();
    const editableException = normalized.kind === 'object' && !protectedState &&
      !!findProtectionException(normalized, protectionExceptionItems);
    toast(normalized.kind === 'slide'
      ? `${targetLabel(normalized)} ${protectedState
          ? 'locked; every item is locked.'
          : 'unlocked; every item is editable.'}`
      : (editableException
          ? `${targetLabel(normalized)} is editable; the slide stays locked.`
          : `${targetLabel(normalized)} ${protectedState ? 'locked' : 'unlocked'}.`));
  } catch (err) {
    // Confirmed rows were never overwritten. Removing the optimistic overlay is
    // the rollback, including when a newer authoritative SSE arrived meanwhile.
    pendingProtection = null;
    paintProtectionState();
    renderProtections();
    renderObjectHistory();
    toast(`Lock change was not saved: ${err.message || 'connection error'}`, true);
  } finally {
    focusProtectionControl(normalized);
  }
}

function targetFromProtectionControl(control) {
  return normalizeProtection({
    kind: control.dataset.kind,
    slideId: control.dataset.slideId,
    objectId: control.dataset.objectId,
    objectKind: control.dataset.objectKind,
  });
}

function handleProtectionControl(event) {
  const control = event.target.closest('[data-protection-toggle]');
  if (!control) return false;
  event.preventDefault();
  event.stopPropagation();
  if (control.disabled) return true;
  const target = targetFromProtectionControl(control);
  toggleProtection(target, control.dataset.protected === 'true');
  return true;
}

if ($('panelProtections')) {
  $('panelProtections').addEventListener('click', handleProtectionControl);
}
if ($('lockQuickbar')) {
  $('lockQuickbar').addEventListener('click', (event) => {
    if (handleProtectionControl(event)) return;
    if (!event.target.closest('[data-open-locks]')) return;
    lastToggle = $('togProtections');
    if (openPanel !== 'protections') setPanel('protections');
  });
}

// ----------------------------------------------------- per-object history
// A history identity is exactly the same stable object identity protections
// use. Keeping it ID-based (never DOM-index-based) is what lets a delayed GET
// survive an in-place slide repaint without attaching kaiju history to the
// object that happens to occupy the same coordinates afterward.
function sameObjectHistoryTarget(a, b) {
  return !!a && !!b && a.kind === 'object' && b.kind === 'object'
    && a.slideId === b.slideId && a.objectId === b.objectId
    && a.objectKind === b.objectKind;
}

function normalizeObjectHistoryResponse(value, expectedTarget) {
  if (!value || value.ok !== true || !Array.isArray(value.versions)) {
    throw new Error((value && value.error) || 'Invalid item history response');
  }
  const target = normalizeProtection(Object.assign({}, value.target || expectedTarget, { kind: 'object' }));
  if (!target || target.kind !== 'object' || !sameObjectHistoryTarget(target, expectedTarget)) {
    throw new Error('Item history response targeted a different object');
  }
  const ids = new Set();
  const versions = value.versions.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.id !== 'string' || !row.id || ids.has(row.id)
        || !row.state || typeof row.state !== 'object' || Array.isArray(row.state)
        || !row.state.object || typeof row.state.object !== 'object'
        || Array.isArray(row.state.object)) {
      throw new Error('Item history contains an invalid version');
    }
    ids.add(row.id);
    return {
      id: row.id,
      createdAt: row.createdAt == null ? null : row.createdAt,
      by: row.by == null ? '' : String(row.by),
      summary: row.summary == null ? '' : String(row.summary),
      state: row.state,
    };
  });
  const headId = value.headId == null ? null : String(value.headId);
  if ((headId && !ids.has(headId)) || (!headId && versions.length)) {
    throw new Error('Item history has an invalid current version');
  }
  const undoDepth = Number.isInteger(value.undoDepth) && value.undoDepth >= 0
    ? value.undoDepth : 0;
  const maxUndo = Number.isInteger(value.maxUndo) && value.maxUndo >= 0
    ? value.maxUndo : 3;
  const topCheckpointToken = typeof value.topCheckpointToken === 'string' && value.topCheckpointToken
    ? value.topCheckpointToken : null;
  return { ok: true, target, versions, headId, undoDepth, maxUndo, topCheckpointToken };
}

function abortObjectHistoryRequest() {
  objectHistoryRequestSeq++;
  if (objectHistoryAbort) objectHistoryAbort.abort();
  objectHistoryAbort = null;
  objectHistoryLoading = false;
}

function objectHistoryQuery(target) {
  const q = new URLSearchParams({
    slideId: target.slideId,
    objectKind: target.objectKind,
    objectId: target.objectId,
  });
  return `/api/object-history?${q.toString()}`;
}

async function loadObjectHistory(target) {
  const normalized = normalizeProtection(target);
  if (!normalized || normalized.kind !== 'object') return;
  abortObjectHistoryRequest();
  const seq = ++objectHistoryRequestSeq;
  const controller = new AbortController();
  objectHistoryAbort = controller;
  objectHistoryTarget = normalized;
  objectHistoryLoading = true;
  objectHistoryError = '';
  renderObjectHistory();
  try {
    const response = await fetch(objectHistoryQuery(normalized), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    let raw = null;
    try { raw = await response.json(); } catch (_) {}
    if (!response.ok || !raw || raw.ok !== true) {
      throw new Error((raw && raw.error) || `HTTP ${response.status}`);
    }
    const data = normalizeObjectHistoryResponse(raw, normalized);
    // Selection, slide, or a newer request may have changed while this read was
    // in flight. Such a response is valid, but no longer belongs on screen.
    if (seq !== objectHistoryRequestSeq
        || !sameObjectHistoryTarget(objectHistoryTarget, normalized)
        || !sameObjectHistoryTarget(selectedObject, normalized)) return;
    objectHistoryData = data;
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    if (seq !== objectHistoryRequestSeq
        || !sameObjectHistoryTarget(objectHistoryTarget, normalized)) return;
    objectHistoryError = error && error.message ? error.message : 'Could not load item history';
  } finally {
    if (seq === objectHistoryRequestSeq) {
      objectHistoryAbort = null;
      objectHistoryLoading = false;
      renderObjectHistory();
    }
  }
}

function objectHistoryBlocked(target) {
  if (paused) return { blocked: true, reason: 'Resume editing before restoring a version.' };
  if (pendingProtection) return { blocked: true, reason: 'Wait for the lock change to finish.' };
  const state = protectionStateForTarget(target);
  if (state.locked) {
    return {
      blocked: true,
      reason: state.source === 'slide'
        ? 'This item is covered by the slide lock. Double-click it to make just this item editable.'
        : 'This item is locked. Double-click it to unlock it before restoring.',
    };
  }
  return { blocked: false, reason: '' };
}

function historyObjectText(object) {
  if (!object) return '';
  if (object.text != null) return String(object.text);
  if (Array.isArray(object.items)) return object.items.map((item) => String(item)).join('\n');
  if (Array.isArray(object.rows)) {
    return object.rows.map((row) => Array.isArray(row) ? row.join(' | ') : String(row)).join('\n');
  }
  return '';
}

function historySourceName(object) {
  return object && object.source ? String(object.source).split(/[\\/]/).pop() : '';
}

function historyBoxDescription(box) {
  if (!box || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(box[key])))) return '';
  const pct = (value) => `${Math.round(Number(value) * 100)}%`;
  return `${pct(box.w)} x ${pct(box.h)} at ${pct(box.x)}, ${pct(box.y)}`;
}

function historyGeometryHtml(object) {
  const box = object && object.box;
  if (!box || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(box[key])))) return '';
  const x = Math.max(0, Math.min(100, Number(box.x) * 100));
  const y = Math.max(0, Math.min(100, Number(box.y) * 100));
  const w = Math.max(2, Math.min(100 - x, Number(box.w) * 100));
  const h = Math.max(2, Math.min(100 - y, Number(box.h) * 100));
  return `<div class="object-history-geometry" aria-label="Object position on slide">
    <span style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;width:${w.toFixed(2)}%;height:${h.toFixed(2)}%"></span>
  </div>`;
}

function historyPreviewAsset(target, object, versionId) {
  if (!['pic', 'media'].includes(object.kind)) return null;
  const params = new URLSearchParams({
    slideId: target.slideId,
    objectKind: target.objectKind,
    objectId: target.objectId,
    versionId,
  });
  // Unlike the live animation endpoint, this is bound to the immutable saved
  // version and can therefore show an archived source even after a later edit
  // replaced the current picture.
  return { kind: object.kind, url: `/api/object-history/asset?${params.toString()}` };
}

function historyPreviewHtml(version, target, isHead) {
  const object = version.state.object || {};
  const text = historyObjectText(object);
  const source = historySourceName(object);
  const objectType = object.kind || object.type || target.objectKind || 'object';
  const box = historyBoxDescription(object.box);
  const asset = historyPreviewAsset(target, object, version.id);
  if (text) {
    const style = object.style || {};
    const css = [];
    if (/^#[0-9a-f]{6}$/i.test(style.color || '')) css.push(`color:${style.color}`);
    if (/^#[0-9a-f]{6}$/i.test(style.fill || '')) css.push(`background:${style.fill}`);
    if (style.bold === true) css.push('font-weight:750');
    if (['left', 'center', 'right'].includes(style.align)) css.push(`text-align:${style.align}`);
    return `<div class="object-history-preview text-preview"${css.length ? ` style="${css.join(';')}"` : ''}>${esc(text)}</div>
      ${box ? `<div class="object-history-boxmeta">${esc(box)}</div>` : ''}`;
  }
  if (asset && asset.kind === 'pic') {
    return `<div class="object-history-preview media-preview"><img src="${esc(asset.url)}" alt="${esc(source || 'Saved picture')}" loading="lazy" /></div>
      ${historyGeometryHtml(object)}<div class="object-history-boxmeta">${esc([source, box].filter(Boolean).join(' - '))}</div>`;
  }
  if (asset && asset.kind === 'media' && isHead) {
    return `<div class="object-history-preview media-preview"><video src="${esc(asset.url)}" muted playsinline preload="metadata" controls aria-label="${esc(source || 'Saved video')}"></video></div>
      ${historyGeometryHtml(object)}<div class="object-history-boxmeta">${esc([source, box].filter(Boolean).join(' - '))}</div>`;
  }
  const fill = object.fill || (object.style && object.style.fill);
  const swatch = /^#[0-9a-f]{6}$/i.test(fill || '')
    ? `<i class="object-history-fill" style="background:${fill}" aria-label="Fill ${esc(fill)}"></i>` : '';
  return `<div class="object-history-preview object-preview">${swatch}<span aria-hidden="true">${objectType === 'media' ? '&#9654;' : objectType === 'pic' ? '&#9638;' : '&#9633;'}</span><strong>${esc(source || objectType)}</strong></div>
    ${historyGeometryHtml(object)}<div class="object-history-boxmeta">${esc([objectType, box].filter(Boolean).join(' - '))}</div>`;
}

function formatObjectHistoryTime(value) {
  const date = new Date(value == null ? Date.now() : value);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return date.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function renderObjectHistory() {
  const context = $('objectHistoryContext');
  const list = $('objectHistoryList');
  const count = $('objectHistoryCount');
  if (!context || !list || !count) return;
  const target = objectHistoryTarget;
  if (!target) {
    count.textContent = '';
    context.innerHTML = '<div class="panel-empty">Select an item on a slide to see its saved versions.</div>';
    list.innerHTML = '';
    return;
  }
  const data = objectHistoryData && sameObjectHistoryTarget(objectHistoryData.target, target)
    ? objectHistoryData : null;
  const versions = data ? data.versions.slice(-OBJECT_HISTORY_LIMIT) : [];
  const effective = protectionStateForTarget(target);
  const blocked = objectHistoryBlocked(target);
  const undoDepth = data ? Math.min(data.undoDepth, data.maxUndo || data.undoDepth) : 0;
  const canUndo = !!(data && undoDepth && data.topCheckpointToken);
  const mutating = objectHistoryPosting;
  count.textContent = objectHistoryLoading ? 'loading'
    : data ? `${versions.length} / ${OBJECT_HISTORY_LIMIT}` : '';
  context.innerHTML = `<div class="object-history-target">
      <span class="protection-kicker">Slide ${slideNumber(target.slideId) || esc(target.slideId)} - ${esc(target.objectKind)}</span>
      <span class="object-history-title-line"><strong>${esc(objectUiLabel(target))}</strong>${protectionStateBadge(effective)}</span>
    </div>
    ${undoDepth ? `<button type="button" class="object-history-undo" data-history-undo="1"
      ${(!canUndo || blocked.blocked || mutating) ? 'disabled' : ''}
      title="Undo the most recent version restore"><span aria-hidden="true">&#8630;</span>
      Undo restore <small>${undoDepth} of ${data.maxUndo}</small></button>` : ''}
    ${blocked.reason ? `<div class="object-history-blocked">${esc(blocked.reason)}</div>` : ''}
    ${mutating ? '<div class="object-history-saving" role="status">Restoring saved state...</div>' : ''}`;

  if (objectHistoryLoading && !data) {
    list.innerHTML = '<div class="object-history-loading" role="status"><span></span><span></span><span></span>Loading saved versions...</div>';
    return;
  }
  if (objectHistoryError) {
    list.innerHTML = `<div class="object-history-error"><strong>History could not load.</strong><span>${esc(objectHistoryError)}</span>
      <button type="button" data-history-retry="1">Try again</button></div>`;
    return;
  }
  if (!data || !versions.length) {
    list.innerHTML = '<div class="panel-empty">No saved versions exist for this item yet.</div>';
    return;
  }
  list.innerHTML = versions.slice().reverse().map((version, reverseIndex) => {
    const isHead = version.id === data.headId;
    const ordinal = versions.length - reverseIndex;
    const disabled = isHead || blocked.blocked || mutating;
    const meta = `${formatObjectHistoryTime(version.createdAt)} - ${version.by || 'unknown editor'}`;
    return `<article class="object-history-version${isHead ? ' current' : ''}" data-version-id="${esc(version.id)}"${isHead ? ' aria-current="true"' : ''}>
      <div class="object-history-version-head"><span class="object-history-version-number">${isHead ? 'Current' : `Version ${ordinal}`}</span><time>${esc(meta)}</time></div>
      <div class="object-history-summary">${esc(version.summary || 'Saved item state')}</div>
      ${historyPreviewHtml(version, target, isHead)}
      <button type="button" class="object-history-restore" data-history-restore="${esc(version.id)}"
        ${disabled ? 'disabled' : ''}>${isHead ? 'Current version' : 'Restore this version'}</button>
    </article>`;
  }).join('');
}

function openObjectHistoryFor(target) {
  const normalized = normalizeProtection(target);
  if (!normalized || normalized.kind !== 'object'
      || !sameObjectHistoryTarget(selectedObject, normalized)) return;
  clearTimeout(objectHistoryOpenTimer);
  objectHistoryOpenTimer = null;
  const changed = !sameObjectHistoryTarget(objectHistoryTarget, normalized);
  objectHistoryTarget = normalized;
  if (changed) {
    objectHistoryData = null;
    objectHistoryError = '';
  }
  if (openPanel !== 'object-history') {
    lastToggle = spotForTarget(normalized);
    setPanel('object-history');
  }
  loadObjectHistory(normalized);
}

function queueObjectHistoryOpen(target, deferForDoubleClick) {
  clearTimeout(objectHistoryOpenTimer);
  objectHistoryOpenTimer = null;
  const changed = !sameObjectHistoryTarget(objectHistoryTarget, target);
  objectHistoryTarget = target;
  if (changed) {
    abortObjectHistoryRequest();
    objectHistoryData = null;
    objectHistoryError = '';
  }
  renderObjectHistory();
  // Once the sheet already reserves width, changing the stacked item is safe
  // immediately. On the first click, wait through the browser's dblclick
  // window so resizing the slide cannot move the second click's hit target.
  if (openPanel === 'object-history' || !deferForDoubleClick) {
    openObjectHistoryFor(target);
    return;
  }
  objectHistoryOpenTimer = setTimeout(() => {
    objectHistoryOpenTimer = null;
    if (sameObjectHistoryTarget(selectedObject, target)) openObjectHistoryFor(target);
  }, 240);
}

function clearObjectHistoryFocus(closePanel) {
  clearTimeout(objectHistoryOpenTimer);
  objectHistoryOpenTimer = null;
  abortObjectHistoryRequest();
  objectHistoryTarget = null;
  objectHistoryData = null;
  objectHistoryError = '';
  objectHistoryRefreshQueued = false;
  if (closePanel && openPanel === 'object-history') setPanel(null);
  renderObjectHistory();
}

function refreshSelectedObjectHistory() {
  if (openPanel !== 'object-history' || !selectedObject) return;
  if (objectHistoryPosting) { objectHistoryRefreshQueued = true; return; }
  loadObjectHistory(selectedObject);
}

async function mutateObjectHistory(action, versionId) {
  const target = objectHistoryTarget;
  const data = objectHistoryData;
  if (objectHistoryPosting || !target || !data
      || !sameObjectHistoryTarget(selectedObject, target)) return;
  const blocked = objectHistoryBlocked(target);
  if (blocked.blocked) { toast(blocked.reason, true); return; }
  const undo = action === 'undo';
  if (undo && (!data.undoDepth || !data.topCheckpointToken)) return;
  if (!undo && (!versionId || versionId === data.headId)) return;
  abortObjectHistoryRequest();
  objectHistoryPosting = true;
  objectHistoryRefreshQueued = false;
  renderObjectHistory();
  const body = {
    slideId: target.slideId,
    objectKind: target.objectKind,
    objectId: target.objectId,
    expectedHeadId: data.headId,
    by: protectionActor(),
    ...(undo
      ? { checkpointToken: data.topCheckpointToken }
      : { versionId }),
  };
  try {
    const response = await fetch(undo
      ? '/api/object-history/undo-restore'
      : '/api/object-history/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let raw = null;
    try { raw = await response.json(); } catch (_) {}
    if (!response.ok || !raw || raw.ok !== true) {
      throw new Error((raw && raw.error) || `HTTP ${response.status}`);
    }
    toast(undo ? 'Restored the state from before the last history jump.' : 'Restored the selected item version.');
  } catch (error) {
    toast(`Item history was not changed: ${error && error.message ? error.message : 'connection error'}`, true);
  } finally {
    objectHistoryPosting = false;
    if (sameObjectHistoryTarget(selectedObject, target) && openPanel === 'object-history') {
      objectHistoryRefreshQueued = false;
      loadObjectHistory(target);
    } else {
      objectHistoryRefreshQueued = false;
      renderObjectHistory();
    }
  }
}

if ($('panelObjectHistory')) {
  $('panelObjectHistory').addEventListener('click', (event) => {
    const retry = event.target.closest('[data-history-retry]');
    const undo = event.target.closest('[data-history-undo]');
    const restore = event.target.closest('[data-history-restore]');
    if (retry && selectedObject) { loadObjectHistory(selectedObject); return; }
    if (undo && !undo.disabled) { mutateObjectHistory('undo'); return; }
    if (restore && !restore.disabled) mutateObjectHistory('restore', restore.dataset.historyRestore);
  });
}

function selectObject(target, options) {
  const normalized = normalizeProtection(target);
  if (!normalized || normalized.kind !== 'object') return;
  selectedObject = normalized;
  currentId = normalized.slideId;
  paintProtectionState();
  renderProtections();
  queueObjectHistoryOpen(normalized, !!(options && options.deferHistory));
}

let lastObjectPick = null;
function pickObjectAtPoint(slide, x, y, toleranceX, toleranceY, clientX, clientY) {
  const candidates = [];
  const push = (object, objectKind) => {
    const box = object && object.box;
    if (!box) return;
    const left = Number(box.x), top = Number(box.y);
    const width = Number(box.w), height = Number(box.h);
    if (![left, top, width, height].every(Number.isFinite)) return;
    if (x < left - toleranceX || x > left + width + toleranceX
        || y < top - toleranceY || y > top + height + toleranceY) return;
    candidates.push({
      kind: 'object', slideId: slide.id, objectId: object.id, objectKind,
      area: Math.max(width * height, 0),
      // The visible path along the bottom of every slide is baked into a
      // full-slide timeline PNG. In that band, treat that source-backed decor
      // as the direct hit instead of making the user cycle past every smaller
      // transparent/text box that happens to overlap its full-slide bounds.
      hitPriority: objectKind === 'decor' && y >= .78
        && /(^|[\\/])timeline([\\/])/.test(String(object.source || '')) ? -1 : 0,
    });
  };
  (slide.decor || []).forEach((object) => push(object, 'decor'));
  (slide.elements || []).forEach((object) => push(object, 'element'));
  candidates.sort((a, b) => a.hitPriority - b.hitPriority
    || a.area - b.area
    || (a.objectKind === b.objectKind ? 0 : a.objectKind === 'element' ? -1 : 1)
    || String(a.objectId).localeCompare(String(b.objectId)));
  if (!candidates.length) { lastObjectPick = null; return null; }

  const signature = candidates.map(protectionKey).join('|');
  const repeats = lastObjectPick
    && lastObjectPick.slideId === slide.id
    && lastObjectPick.signature === signature
    && Math.hypot(clientX - lastObjectPick.clientX, clientY - lastObjectPick.clientY) <= 8
    && Date.now() - lastObjectPick.at < 2200;
  const index = repeats ? (lastObjectPick.index + 1) % candidates.length : 0;
  lastObjectPick = { slideId: slide.id, signature, index, clientX, clientY, at: Date.now() };
  return candidates[index];
}

// ---- build-once-patch-forever: rebuild #deck only when the STRUCTURE (ids)
// changes, never on geometry. Rebuilding on every edit (like the main
// dashboard's innerHTML replace) tears any in-flight glow animation out of
// the DOM mid-flight, which is fatal once more than one editor is active.
let builtKey = '';
function structureKey(m) {
  return (m.slides || []).map((s) =>
    s.id + ':' + (s.elements || []).map((e) => e.id).join('.') + '#' + (s.decor || []).map((d) => d.id).join('.')
  ).join('|');
}

// ---- per-slide thumbnail versions, driven by the (Phase 1) thumbs event's
// `slides` field, so an edit to one slide never forces a refetch of all 16.
let thumbsVer = 0;         // bumps on every successful export, whole-deck or partial
const slideImgVer = {};    // slideId -> the version its <img> should show
let thumbAspect = 13.333 / 7.5;
let slideHpt = 540;        // slide height in points, for the fallback's cqh font sizing

function slideNumber(id) {
  const i = model.slides.findIndex((s) => s.id === id);
  return i < 0 ? null : i + 1;
}

// ---- model-derived fallback render, used ONLY when a thumbnail is missing.
// The PNG is the real view; this exists so a PowerPoint/COM failure degrades to
// a readable deck instead of a blank white box. Ported from the dashboard's
// positioned renderer (app.js decorHtml/elPosHtml), which is why the geometry
// math matches: both read the same fractional boxes off the same model.
function fbDecorHtml(d) {
  const b = d.box; if (!b) return '';
  const bg = d.kind === 'pic'
    ? 'repeating-linear-gradient(45deg,#e9edf3,#e9edf3 6px,#dfe4ec 6px,#dfe4ec 12px)'
    : (d.fill || 'transparent');
  return `<div class="fb-decor" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%;background:${bg}"></div>`;
}

function fbElHtml(e) {
  const b = e.box || { x: 0.06, y: 0.06, w: 0.88, h: 0.12 };
  const st = e.style || {};
  const sizePt = st.size || (e.type === 'title' ? 30 : e.type === 'table' ? 14 : 13);
  const css = [
    `left:${b.x * 100}%`, `top:${b.y * 100}%`, `width:${b.w * 100}%`, `height:${b.h * 100}%`,
    `font-size:${(sizePt / slideHpt * 100).toFixed(2)}cqh`,
    st.align ? `text-align:${st.align}` : '',
    st.align === 'center' ? 'align-items:center' : (st.align === 'right' ? 'align-items:flex-end' : ''),
    st.bold ? 'font-weight:700' : '',
    st.color ? `color:${st.color}` : '',
    st.fill ? `background:${st.fill}` : '',
    st.outline ? `outline:1px solid ${st.outline}` : '',
    st.font ? `font-family:'${st.font}'` : '',
  ].filter(Boolean).join(';');
  const inner = e.items ? e.items.map((i) => `<div>${esc(i)}</div>`).join('') : esc(e.text || '');
  return `<div class="fb-el" style="${css}">${inner}</div>`;
}

function fallbackInnerHtml(s) {
  return (s.decor || []).map(fbDecorHtml).join('')
    + (s.elements || []).map(fbElHtml).join('');
}

function fallbackHtml(s) {
  return `<div class="fallback" aria-hidden="true">${fallbackInnerHtml(s)}</div>`;
}

// A missing PNG exposes this model-derived layer. Keep it current without
// replacing the card or its hotspot nodes, since either replacement would tear
// an in-flight glow out of the DOM. Undo/redo carry no slide id, so those
// whole-model swaps refresh every fallback.
function refreshFallback(affected) {
  const slides = affected && affected.slideId
    ? model.slides.filter((s) => s.id === affected.slideId)
    : model.slides;
  slides.forEach((s) => {
    const card = document.querySelector(`.card[data-slide="${cssEsc(s.id)}"]`);
    const fallback = card && card.querySelector('.fallback');
    if (fallback) fallback.innerHTML = fallbackInnerHtml(s);
  });
}

function hotspotHtml(o, kind, slide, slideIndex) {
  const b = o.box; if (!b) return '';
  const attr = kind === 'decor' ? 'data-decor' : 'data-el';
  const target = { kind: 'object', slideId: slide.id, objectId: o.id, objectKind: kind === 'decor' ? 'decor' : 'element' };
  const label = `Select ${objectUiLabel(target)} on slide ${slideIndex + 1}`;
  return `<button type="button" class="spot" tabindex="-1" ${attr}="${esc(o.id)}"
    data-object-id="${esc(o.id)}" data-object-kind="${esc(target.objectKind)}"
    data-base-label="${esc(label)}" aria-label="${esc(label)}"
    title="Double-click to lock or unlock this item"
    style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"></button>`;
}

function cardHtml(s, i) {
  const n = i + 1;
  const ver = slideImgVer[s.id] || thumbsVer;
  // decor first, so element glows paint on top of (often full-width) decor bars
  const spots = [
    ...(s.decor || []).map((d) => hotspotHtml(d, 'decor', s, i)),
    ...(s.elements || []).map((e) => hotspotHtml(e, 'element', s, i)),
  ].join('');
  return `<div class="card" data-slide="${esc(s.id)}" tabindex="0" role="button" aria-label="Open slide ${n}">
    <div class="card-head"><span class="n">${n}</span><span>${esc(s.id)}</span>
      <button type="button" class="card-lock-toggle" data-card-lock-toggle="1" data-protection-toggle="1"
        data-kind="slide" data-slide-id="${esc(s.id)}" data-protected="true" aria-pressed="false"
        aria-label="Lock slide ${n}" title="Lock slide ${n}"><span aria-hidden="true">&#128275;</span><span>Lock slide</span></button>
    </div>
    <div class="frame">
      ${fallbackHtml(s)}
      <img src="/thumbs/slide-${n}.png?v=${ver}" alt="slide ${n}"
           onerror="this.closest('.frame').classList.add('noimg')"
           onload="this.closest('.frame').classList.remove('noimg')">
      ${spots}
    </div>
  </div>`;
}

function build() {
  // Derive both forms from the model rather than from thumbAspect, which is a
  // Number at declaration and a String ("13.333 / 7.5") after the bootstrap.
  // Both parse as aspect-ratio, so the inconsistency is invisible until
  // something does sizing math with it, which the fullscreen letterbox does.
  const sw = model.slideW || 13.333, sh = model.slideH || 7.5;
  slideHpt = sh * 72;
  document.documentElement.style.setProperty('--thumb-aspect', sw + ' / ' + sh);
  document.documentElement.style.setProperty('--deck-ar', String(sw / sh));
  $('deckTitle').textContent = model.title || 'Untitled Presentation';
  $('revLabel').textContent = 'rev ' + (model.rev || 0);
  $('slideCount').textContent = model.slides.length + (model.slides.length === 1 ? ' slide' : ' slides');
  $('deck').innerHTML = model.slides.map(cardHtml).join('');
  builtKey = structureKey(model);
  applyMode();
  renderClaims();   // a structural rebuild wipes the .card DOM; repaint the region indicators
  paintProtectionState();
  renderProtections();
}

function maybeRebuild() {
  const key = structureKey(model);
  if (key !== builtKey) { build(); return true; }
  else {
    $('deckTitle').textContent = model.title || 'Untitled Presentation';
    $('revLabel').textContent = 'rev ' + (model.rev || 0);
  }
  return false;
}

// ---- patch one hotspot's inline geometry after a set-box edit, so the glow
// (and any future claim indicator) tracks the shape's new position instead
// of glowing where it used to be.
function patchGeometry(affected) {
  if (!affected || !affected.box) return;
  const id = affected.elementId || affected.decorId;
  if (!id) return;
  const slide = model.slides.find((s) => s.id === affected.slideId);
  const o = slide && ((slide.elements || []).find((e) => e.id === id) || (slide.decor || []).find((d) => d.id === id));
  if (!o || !o.box) return;
  const el = document.querySelector(`.spot[data-el="${cssEsc(id)}"], .spot[data-decor="${cssEsc(id)}"]`);
  if (!el) return;
  const b = o.box;
  el.style.left = b.x * 100 + '%'; el.style.top = b.y * 100 + '%';
  el.style.width = b.w * 100 + '%'; el.style.height = b.h * 100 + '%';
}

// A fading text label naming the acting agent, attached to the glowing spot
// or card. Hue-only attribution fails for colorblind viewers (blue/gold reads
// fine, but a future emerald/violet pair does not), so the color is backed by
// text on every agent-caused glow. Skipped for human/unknown edits: a human
// editing their own deck has no attribution question to answer.
function tagOn(hostEl, name) {
  if (!hostEl || !name) return;
  let tag = null;
  for (const c of hostEl.children) { if (c.classList.contains('agent-tag')) { tag = c; break; } }
  if (!tag) { tag = document.createElement('span'); tag.className = 'agent-tag'; hostEl.appendChild(tag); }
  tag.textContent = name;
  tag.classList.remove('show'); void tag.offsetWidth; tag.classList.add('show');
}
// A human edit right after an agent's (same spot) should not leave the prior
// agent's tag visibly fading for its own remaining seconds: hide it now.
function tagOff(hostEl) {
  if (!hostEl) return;
  for (const c of hostEl.children) { if (c.classList.contains('agent-tag')) { c.classList.remove('show'); break; } }
}

function glow(affected, editor) {
  if (!affected) return;
  // Tint the glow in the acting agent's color (ink carries the outline/ring so
  // gold at 1.81:1 is not invisible; chip is the translucent wash). A human or
  // unknown editor falls through to the default --glow in CSS.
  const col = colorFor(editor);
  const setColor = (el) => {
    if (col) { el.style.setProperty('--agent', col.color); el.style.setProperty('--agent-ink', col.ink); }
    else { el.style.removeProperty('--agent'); el.style.removeProperty('--agent-ink'); }
  };
  const id = affected.elementId || affected.decorId;
  if (id) {
    const el = document.querySelector(`.spot[data-el="${cssEsc(id)}"], .spot[data-decor="${cssEsc(id)}"]`);
    if (el) {
      setColor(el); el.classList.remove('landed'); void el.offsetWidth; el.classList.add('landed');
      if (col) tagOn(el, editor); else tagOff(el);
      return;
    }
  }
  // no addressable element/decor (e.g. undo/redo, or a structural op): ring
  // the whole card instead of pretending we know exactly what changed.
  if (affected.slideId) {
    const card = document.querySelector(`.card[data-slide="${cssEsc(affected.slideId)}"]`);
    if (card) {
      setColor(card); card.classList.remove('landed'); void card.offsetWidth; card.classList.add('landed');
      const head = card.querySelector('.card-head');
      if (head) { if (col) tagOn(head, editor); else tagOff(head); }
    }
  }
}

// ---- chat (the board is the conversation), agent chips, and region indicators
function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }

// Client-only confirmations for slash commands. They are deliberately NOT board
// notes: a slash command is the human talking to this page, not to the team, and
// posting one would put a second copy of every action on the shared board. The
// tradeoff is that they live only in this tab and die on reload, which is right
// for a receipt.
const SYS_KEEP = 60;
let sysLines = [];         // {ts, text, err}
function sysEcho(text, isErr) {
  sysLines.push({ ts: Date.now(), text: String(text == null ? '' : text), err: !!isErr });
  if (sysLines.length > SYS_KEEP) sysLines.splice(0, sysLines.length - SYS_KEEP);
  renderChat();
  openChat(true);
  // Force the scroll rather than leaving it to renderChat's stick heuristic: the
  // human just acted, so the receipt for that action is the one line that must
  // never land off-screen.
  const log = $('chatlog'); if (log) log.scrollTop = log.scrollHeight;
}

function renderChat(notes) {
  if (Array.isArray(notes)) boardNotes = notes;
  const log = $('chatlog'); if (!log) return;
  const stick = nearBottom(log);
  // boardView() returns non-pinned notes NEWEST-first; reverse to oldest->newest
  const msgs = boardNotes.filter((n) => !n.pinned).slice().reverse();
  // Interleave the local system receipts by timestamp instead of appending them
  // to the DOM: renderChat rebuilds this log wholesale on every board event, so
  // anything appended outside it survives only until the next message arrives.
  const rows = msgs.map((n) => ({ ts: n.ts || 0, note: n }))
    .concat(sysLines.map((s) => ({ ts: s.ts, sys: s })))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // Every other list in this suite (tasks, locks, loops, the board itself on
  // the main dashboard) has an empty-state hint; the chatbox, the single most
  // prominent thing on this page, previously rendered a blank unexplained box.
  log.innerHTML = rows.length ? rows.map((row) => {
    const t = new Date(row.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (row.sys) {
      return `<div class="msg system${row.sys.err ? ' err' : ''}">`
        + `<div class="msg-text">${esc(row.sys.text)}</div>`
        + `<div class="msg-t">${t}</div></div>`;
    }
    const n = row.note;
    const human = NON_AGENT.has(String(n.author).toLowerCase());
    const col = colorFor(n.author);
    const style = col ? ` style="--agent:${esc(col.ink)}"` : '';
    return `<div class="msg ${human ? 'mine' : 'agent'}"${style}>
      <div class="msg-head">${esc(n.author)}<span class="msg-t">${t}</span></div>
      <div class="msg-text">${esc(n.text)}</div></div>`;
  }).join('') : `<div class="chat-empty">No messages yet. Type below to brief the lead, it will read the deck and dispatch the work. Type /help for the commands this page handles itself.</div>`;
  if (stick) log.scrollTop = log.scrollHeight;
}

function fmtMMSS(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
// Sub-cent turns are the normal case for the first minute of a session, so a
// flat 2-decimal round would show "$0.00" next to a real turn count and read as
// broken. Widen to 3 decimals only down there, never for the running total.
function fmtUsd(n) {
  const v = Math.max(0, Number(n) || 0);
  return '$' + v.toFixed(v > 0 && v < 0.1 ? 3 : 2);
}
function fmtTok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

// ---- the usage profile control: cheapest first, with BEAST as the deliberate
// full-access/high-throughput endpoint. Lives in the
// chips row next to dismiss because that cluster is already the spend controls
// (dismiss halts token spend; this lowers its rate). Rendered ALWAYS, unlike
// dismiss, which only appears with a live roster: the useful moment to drop to
// a cheaper profile is BEFORE anything spawns, when the roster is empty.
function modelsForProfile(info, name) {
  const d = ((info && info.profiles) || {})[name] || {};
  // The selected profile's nextModels is the server's authoritative answer.
  // Other choices are resolved through a forced provider when one exists, or
  // through the currently selected provider.
  if (info && name === info.profile && info.nextModels && info.nextModels.lead) {
    return { lead: info.nextModels.lead, worker: info.nextModels.worker };
  }
  const provider = d.forcedProvider || (info && info.provider);
  const map = (info && info.providerModels && info.providerModels[provider]) || {};
  return {
    lead: map[d.lead] || d.lead || '?',
    worker: map[d.worker] || d.worker || '?',
  };
}

function profileLabel(name) {
  return name === 'beast' ? 'BEAST' : name;
}

function profileHtml() {
  const info = profileInfo;
  if (!info || !Array.isArray(info.known) || !info.known.length) return '';
  const cur = info.profile;
  const defs = info.profiles || {};
  const want = modelsForProfile(info, cur);
  // Compare concrete model ids, never the profile's tier names ("workhorse"
  // and "heavy"). Comparing a live gpt-5.6-terra process to "workhorse" made
  // every Codex agent look stale even when the selected profile was live.
  const currentDef = defs[cur] || {};
  const expectedProvider = currentDef.forcedProvider || info.provider;
  const expectedEffort = currentDef.reasoningEffort || 'medium';
  const stale = (info.running || []).filter((r) =>
    r.model !== (r.role === 'lead' ? want.lead : want.worker)
    || (r.provider && r.provider !== expectedProvider)
    || (r.reasoningEffort != null && r.reasoningEffort !== expectedEffort)
  );
  const pending = stale.length > 0;
  // Without this note the control reads as though the click did nothing, or
  // worse, as though the new model took effect on the agents already running.
  const pendNote = pending
    ? `\nNOT live yet: ${stale.length || 'some'} running `
      + `${stale.length === 1 ? 'agent is' : 'agents are'} still on the model they spawned with`
      + (stale.length ? ` (${stale.map((r) => r.name + ' on ' + r.model).join(', ')})` : '')
      + `. Dismiss the team to apply it now.`
    : '';
  const btns = info.known.map((k) => {
    const d = defs[k] || {};
    const models = modelsForProfile(info, k);
    const generalCap = d.maxWorkers != null ? d.maxWorkers : '?';
    const mediaCap = d.maxMediaWorkers != null ? d.maxMediaWorkers : 0;
    const cost = d.pct === 100 ? 'baseline spend (100%)' : `about ${d.pct}% of baseline spend (estimate)`;
    const reasoning = d.reasoningEffort === 'ultra' ? 'Ultra' : (d.reasoningEffort || 'medium');
    const execution = ` ${reasoning} reasoning${d.fullAccess ? ', with full trusted tool/file/web access' : ''}. Fast speed is controlled separately.`;
    const providerNote = d.forcedProvider ? ` Forces the ${d.forcedProvider} provider.` : '';
    const tip = `${k === 'beast' ? 'Extra Extra High (BEAST)' : k}: ${models.lead} lead, ${models.worker} workers, `
      + `${generalCap} general-agent slot${generalCap === 1 ? '' : 's'} plus ${mediaCap} image/video slot${mediaCap === 1 ? '' : 's'}.`
      + execution + providerNote + ` ${cost}.`
      + `\nApplies to the NEXT spawn only: agents already running keep the model they started on.`
      + `\nDismiss the team to apply it right now.`
      + (k === cur ? pendNote : '');
    // ·next, not a colour change: the marker has to survive a colourblind
    // reading, and it sits ON the active state so it cannot be mistaken for
    // a property of the profile itself.
    const label = esc(k) + (k === cur && pending ? '<span class="profile-next">·next</span>' : '');
    const buttonLabel = k === 'beast' ? label.replace('beast', 'BEAST') : label;
    return `<button type="button" data-profile="${esc(k)}"${k === cur ? ' class="active"' : ''} title="${esc(tip)}">${buttonLabel}</button>`;
  }).join('');
  const labTip = `Agent usage profile (currently ${cur}). Changes take effect on the next spawn, `
    + `not on agents already running.` + pendNote;
  return `<span class="profile-ctl${pending ? ' pending' : ''}">`
    + `<span class="profile-lab" title="${esc(labTip)}">spend</span>`
    + `<span class="mode-toggle profile-toggle">${btns}</span></span>`;
}

function fastModeHtml() {
  const fast = profileInfo && profileInfo.fastMode;
  if (!fast || typeof fast.enabled !== 'boolean') return '';
  const enabled = fast.enabled === true;
  const unavailable = fast.available === false;
  const pending = fast.pending === true;
  const scope = fastModePosting
    ? 'saving...'
    : unavailable
      ? 'not applied on Claude · next Codex spawn'
      : pending ? 'pending · next spawn' : 'next spawn';
  const title = fast.reason || `Fast ${enabled ? 'ON' : 'OFF'}. Applies to the next spawn; running agents are unchanged.`;
  return `<span class="profile-ctl fast-ctl${pending ? ' pending' : ''}${unavailable ? ' unavailable' : ''}">`
    + `<span class="profile-lab" title="${esc(title)}">fast</span>`
    + `<span class="mode-toggle profile-toggle fast-toggle"><button type="button"`
    + ` data-fast-mode="${enabled ? 'false' : 'true'}" aria-pressed="${enabled}"`
    + `${enabled && !unavailable ? ' class="active"' : ''}`
    + `${fastModePosting ? ' disabled aria-busy="true"' : ''} title="${esc(title)}">${enabled ? 'ON' : 'OFF'}`
    + `${pending ? '<span class="profile-next">·next</span>' : ''}</button></span>`
    + `<span class="fast-scope">${esc(scope)}</span></span>`;
}

// Access is resolved from provider + profile. Codex is always trusted; Claude
// is guarded on lower profiles and fully enabled when the selected profile has
// fullAccess (BEAST). Keep this dynamic so the control describes the next spawn
// instead of a stale provider-wide assumption.
const FULL_PROVIDER_ACCESS = 'trusted full access: shell/filesystem, live web, browser/visual tools, image/video generation through tools/code, configured apps/plugins/connectors/MCP, and Task/Agent subagents; validated ppt tools remain preferred for deck edits';
const PROVIDER_CONTAINMENT = {
  claude: 'restricted to the ppt CLI by a tool hook: it can run node ppt.js and nothing else',
  codex: FULL_PROVIDER_ACCESS,
};
function providerContainment(provider, fullAccess) {
  return fullAccess ? FULL_PROVIDER_ACCESS : (PROVIDER_CONTAINMENT[provider] || 'containment unknown');
}

// Model ids whose dollar figure is not a measurement. The Claude CLI reports a
// per-turn cost; the Codex CLI reports token counts and no dollar figure at
// all, so its turns arrive as an unbreakable $0. Rendering that as "$0.00"
// beside a real Claude figure would say "free" about the CLI that is actually
// burning the human's ChatGPT quota.
function unmeasuredModelSet(info) {
  const out = new Set();
  const pm = (info && info.providerModels) || {};
  Object.keys(pm).forEach((name) => {
    // Authoritative for the provider in force; for the other one, claude is the
    // only transport that prices a turn at all.
    const measured = name === info.provider ? info.costMeasured !== false : name === 'claude';
    if (!measured) Object.keys(pm[name]).forEach((tier) => out.add(pm[name][tier]));
  });
  return out;
}

// ---- the provider control: which CLI backs the team. Deliberately the usage
// profile's twin (same segmented toggle, same next-spawn-only semantics, same
// pending ring), because it is the same shape of decision: a human-only setting
// that binds at the next spawn. What it adds is availability, since a provider
// that cannot start on this machine must not look clickable, and containment,
// which is the reason codex is safe to reach for when Claude limits run out.
function providerHtml() {
  const info = profileInfo;
  if (!info || !Array.isArray(info.providers) || !info.providers.length) return '';
  const cur = info.provider;
  const health = info.providerHealth || {};
  const next = info.nextModels || {};
  const prof = (info.profiles || {})[info.profile] || {};
  const forcedProvider = prof.forcedProvider || null;
  // Both halves count as divergence: a running agent keeps the provider AND the
  // model it spawned with, and the same tier on the other CLI is a different
  // process against a different quota.
  const stale = (info.running || []).filter((r) =>
    r.model !== (r.role === 'lead' ? next.lead : next.worker) || (r.provider || 'claude') !== cur);
  const pending = stale.length > 0;
  const pendNote = pending
    ? `\nNOT live yet: ${stale.length || 'some'} running `
      + `${stale.length === 1 ? 'agent is' : 'agents are'} still on what they spawned with`
      + (stale.length ? ` (${stale.map((r) => r.name + ' on ' + (r.provider || 'claude') + ' ' + r.model).join(', ')})` : '')
      + `. Dismiss the team to apply it now.`
    : '';
  const btns = info.providers.map((k) => {
    const h = health[k] || {};
    const models = (info.providerModels || {})[k] || {};
    // Resolved through THAT provider under today's profile, so the tooltip
    // answers "what would this button actually run" and not "what tier".
    const lead = models[prof.lead] || prof.lead || '?';
    const worker = models[prof.worker] || prof.worker || '?';
    const access = providerContainment(k, k === 'codex' || !!prof.fullAccess);
    const lockedByProfile = !!forcedProvider && k !== forcedProvider;
    const tip = lockedByProfile
      ? `${k} is unavailable while ${profileLabel(info.profile)} is selected. `
        + `${profileLabel(info.profile)} forces ${forcedProvider} so every agent gets the requested model and tool access.`
      : h.ok
      ? `${k}: ${access}.`
        + `\nOn profile "${info.profile}" it runs ${lead} lead, ${worker} worker.`
        + (k === 'codex' ? `\nReports tokens but no dollar figure, so spend shows tokens for it.` : '')
        + `\nApplies to the NEXT spawn only: agents already running keep what they started on.`
        + `\nDismiss the team to apply it right now.`
        + (k === cur ? pendNote : '')
      // health.detail is a full sentence and already ends in a period, so this
      // does not add a second one.
      : `${k} cannot start on this machine: ${h.detail || 'the executable could not be resolved.'}`
        + `\nThe server refuses this switch, so the button is off rather than failing later.`;
    // aria-disabled + a class, never the disabled attribute: a disabled button
    // stops receiving pointer events in Chrome, which would swallow the very
    // tooltip that explains why it cannot be used. setProvider() re-checks
    // health before posting, so this stays honest either way.
    const selectable = h.ok && !lockedByProfile;
    const off = selectable ? '' : ' off';
    const cls = (k === cur ? 'active' : '') + off;
    const label = esc(k) + (k === cur && pending ? '<span class="profile-next">·next</span>' : '');
    return `<button type="button" data-provider="${esc(k)}"${cls ? ` class="${cls.trim()}"` : ''}`
      + `${selectable ? '' : ' aria-disabled="true"'} title="${esc(tip)}">${label}</button>`;
  }).join('');
  // The profile alone no longer says what will run (it names a tier), so the
  // resolved worker model rides beside the toggle. Worker, not lead: it is the
  // one the "extra" profile actually changes and where turn volume lands.
  const exec = info.nextExecution || {};
  const nextReasoning = exec.reasoningEffort === 'ultra' ? 'Ultra' : (exec.reasoningEffort || 'medium');
  const speed = exec.fastMode
    ? ` ${nextReasoning} reasoning with Fast mode${exec.fullAccess ? ' and full trusted access' : ''}.`
    : ` ${nextReasoning} reasoning at standard speed${exec.fullAccess ? ' with full trusted access' : ''}.`;
  const nextTip = `The next worker spawns on ${next.worker || '?'} (lead on ${next.lead || '?'}), `
    + `profile "${info.profile}" resolved through ${cur}.` + speed + pendNote;
  const nextLab = next.worker
    ? `<span class="prov-model" title="${esc(nextTip)}">${esc(next.worker)}</span>` : '';
  const labTip = `Which CLI the agents run on (currently ${cur}). Both use a subscription login, never an API key.`
    + `\n${providerContainment(cur, cur === 'codex' || !!prof.fullAccess)}`
    + `\nChanges take effect on the next spawn, not on agents already running.` + pendNote;
  return `<span class="profile-ctl provider-ctl${pending ? ' pending' : ''}">`
    + `<span class="profile-lab" title="${esc(labTip)}">cli</span>`
    + `<span class="mode-toggle profile-toggle provider-toggle">${btns}</span>${nextLab}</span>`;
}

// ---- one line, never a panel: session total, turns, and the shared rate
// limit. Silent until there is something to report, so a fresh session's
// topbar stays exactly as clean as it was before this shipped.
function spendHtml() {
  const s = spendInfo;
  if (!s) return '';
  const rl = s.rateLimit || null;
  // The child reports utilization as a 0..1 fraction; tolerate a 0..100 one
  // rather than rendering "8400%" if that ever changes upstream.
  let util = (rl && typeof rl.utilization === 'number') ? rl.utilization : null;
  if (util != null && util > 1) util = util / 100;
  const turns = s.turns || 0, usd = s.totalUsd || 0;
  if (!turns && !usd && util == null) return '';
  const tk = s.tokens || {};
  // Turns whose dollars were never measured. The spend record stores only a
  // model id and a figure, so telling an unpriced $0 from a real one needs the
  // provider's model map.
  const noPrice = unmeasuredModelSet(profileInfo || {});
  const unpriced = Object.keys(s.byModel || {}).filter((m) => noPrice.has(m));
  const unpricedTurns = unpriced.reduce((n, m) => n + (s.byModel[m].turns || 0), 0);
  const byModel = Object.keys(s.byModel || {})
    .map((m) => `${m}: ${noPrice.has(m) ? 'no $ figure' : fmtUsd(s.byModel[m].usd)} over ${s.byModel[m].turns} turn${s.byModel[m].turns === 1 ? '' : 's'}`).join('\n');
  const since = s.sinceTs ? new Date(s.sinceTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  const tokenTotal = (tk.input || 0) + (tk.output || 0);
  const summary = unpricedTurns && !(usd > 0)
    ? `${fmtTok(tokenTotal)} tokens over ${turns} turn${turns === 1 ? '' : 's'}; no dollar figure.`
    : `${fmtUsd(usd)}${unpricedTurns ? ' priced total' : ''} over ${turns} turn${turns === 1 ? '' : 's'}.`;
  const tip = `Agent spend this session${since ? ` (since ${since})` : ''}: ${summary}`
    + (unpricedTurns ? `\n${unpricedTurns} of those turn${unpricedTurns === 1 ? '' : 's'} ran on a CLI that reports tokens and no dollar figure, so they are in the token counts and in no dollar here.` : '')
    + `\ntokens in ${fmtTok(tk.input)}, out ${fmtTok(tk.output)}, cache read ${fmtTok(tk.cacheRead)}, cache write ${fmtTok(tk.cacheWrite)}`
    + (byModel ? '\n' + byModel : '');
  let rlHtml = '';
  if (util != null) {
    const pct = Math.round(util * 100);
    // Escalates past 80%, harder past 95%, both in the same caution gold: this
    // pool is the human's own OAuth quota, so an agent burning it down
    // rate-limits the terminal they are sitting in, not just the team.
    const cls = 'rl' + (util >= 0.95 ? ' hot crit' : util >= 0.8 ? ' hot' : '');
    const win = rl.seven_day ? '7 day' : (rl.window || 'account');
    const rlTip = `Account rate limit (${win} window) at ${pct}% used.`
      + `\nAgents share your OAuth pool, so this throttles your own terminal too.`
      + (util >= 0.8 ? '\nConsider the low profile or dismissing the team.' : '');
    rlHtml = `<span class="${cls}" title="${esc(rlTip)}">${pct}% limit</span>`;
  }
  // Three cases, and the middle one is the trap: a session with unpriced turns
  // must never show a bare dollar figure as if it covered them. A pure Codex
  // session has no dollars to show at all, so it reads in tokens.
  let money = '';
  if (turns || usd) {
    const tokTotal = fmtTok(tokenTotal);
    if (unpricedTurns && !(usd > 0)) {
      money = `<b>${esc(tokTotal)} tok</b> · ${turns} turn${turns === 1 ? '' : 's'}`
        + `<span class="unpriced">no $ figure</span>`;
    } else if (unpricedTurns) {
      money = `<b>${esc(fmtUsd(usd))}</b> · ${turns} turn${turns === 1 ? '' : 's'}`
        + `<span class="unpriced">${unpricedTurns} unpriced</span>`;
    } else {
      money = `<b>${esc(fmtUsd(usd))}</b> · ${turns} turn${turns === 1 ? '' : 's'}`;
    }
  }
  return `<span class="spend" title="${esc(tip)}">${money}${rlHtml}</span>`;
}

// Spend is the human's call, never the team's: the server 403s any `by` it
// recognises as an agent, so this posts under the same author the chatbox uses.
async function setProfile(name) {
  if (!name || (profileInfo && profileInfo.profile === name)) return;
  try {
    const r = await post('/api/agents/profile', { profile: name, by: 'josh' });
    if (!r || r.ok === false) { toast((r && r.error) || 'Could not change the usage profile', true); return; }
    // Apply the POST's own profileView instead of waiting for the {type:'agents'}
    // echo, so the control is still correct if the stream is mid-reconnect.
    profileInfo = r;
    renderChips();
    toast(`Usage profile: ${name}` + (r.pending ? ', applies on the next spawn (dismiss to apply now)' : ''));
  } catch (_) { toast('Could not change the usage profile (connection error)', true); }
}

// Same rule and same author as setProfile: the server 403s any `by` it knows as
// an agent, because which CLI the team runs on is a spend and containment call
// the human makes. The health pre-check is not decoration: the server 409s an
// unavailable provider, and a toast naming the missing executable is a better
// answer than a generic failure.
async function setProvider(name) {
  if (!name || (profileInfo && profileInfo.provider === name)) return;
  const h = (profileInfo && profileInfo.providerHealth && profileInfo.providerHealth[name]) || null;
  if (h && h.ok === false) {
    toast(`${name} cannot start here: ${h.detail || 'executable not found'}`, true);
    return;
  }
  try {
    // post() resolves on 4xx rather than throwing, so a 409 arrives here as a
    // normal body with ok:false and has to be checked explicitly.
    const r = await post('/api/agents/provider', { provider: name, by: 'josh' });
    if (!r || r.ok === false) { toast((r && r.error) || 'Could not change the provider', true); return; }
    // Apply the POST's own profileView instead of waiting for the {type:'agents'}
    // echo, so the control is still correct if the stream is mid-reconnect.
    profileInfo = r;
    renderChips();
    const model = (r.nextModels && r.nextModels.worker) || '';
    toast(`Provider: ${name}${model ? ` (${model})` : ''}`
      + (r.pending ? ', applies on the next spawn (dismiss to apply now)' : ''));
  } catch (_) { toast('Could not change the provider (connection error)', true); }
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

async function setFastMode(enabled) {
  if (fastModePosting || typeof enabled !== 'boolean') return;
  fastModePosting = true;
  renderChips();
  try {
    const result = await post('/api/agents/fast-mode', { enabled, by: 'josh' });
    if (!result || result.ok === false) {
      toast((result && result.error) || 'Could not change Fast mode', true);
      return;
    }
    mergeFastModeResult(result);
    toast(result.available === false && result.enabled
      ? 'Fast saved ON, but not applied on Claude'
      : `Fast ${result.enabled ? 'ON' : 'OFF'} for the next spawn`);
  } catch (_) {
    toast('Could not change Fast mode (connection error)', true);
  } finally {
    fastModePosting = false;
    renderChips();
  }
}

function renderChips() {
  const box = $('agentChips'); if (!box) return;
  // Prefer the live agent roster (has role/status/depth); fall back to editors.
  const isAgentRoster = agentsList.length > 0;
  const list = isAgentRoster ? agentsList
    : editorsList.filter((e) => { const k = (e.name || e.id || '').toLowerCase(); return k && !NON_AGENT.has(k); });
  const chips = list.map((a) => {
    const name = a.name || a.id;
    const col = colorFor(name) || { color: 'var(--text-dim)', ink: 'var(--text-dim)' };
    const status = a.status || '';
    const depth = a.depth || 0;
    // ppt agents (pass 74) already shows idle (last turn M:SS[, errored]);
    // the chip's own title tooltip was the one place on this page that
    // still just said "idle" with no way to tell how long that turn took or
    // whether it even succeeded, same data (agents.js view()), just never
    // read here.
    const lastTurnTag = (status !== 'thinking' && a.lastTurnMs != null)
      ? ` (last turn ${fmtMMSS(a.lastTurnMs / 1000)}${a.lastTurnError ? ', errored' : ''})`
      : '';
    const label = (status === 'thinking' ? (depth > 1 ? `thinking (${depth - 1} queued)` : 'thinking') : (status || 'idle')) + lastTurnTag;
    // What it actually said, not just how long it took (pass 84's ppt agents
    // equivalent). Native title tooltips support \n, so this rides as a
    // second line rather than crowding the first; both prompts tell agents
    // to keep replies to one short sentence, so this is normally short.
    const summaryLine = (status !== 'thinking' && a.lastTurnSummary) ? `\n"${a.lastTurnSummary}"` : '';
    // Per-agent, only while genuinely mid-turn (editors[] carries no status,
    // so this is correctly absent there too): cancels just THIS agent's
    // current turn, process stays alive, unlike dismiss (whole team, kills
    // everything). dismiss already exists here; interrupt (ppt.js/pass 68)
    // had no dashboard equivalent on either page until now.
    const interruptBtn = (isAgentRoster && status === 'thinking')
      ? `<button class="chip-interrupt" data-interrupt="${esc(name)}" title="interrupt ${esc(name)}'s current turn (process stays alive, context preserved)">⏸</button>`
      : '';
    // currentTool was already being computed server-side (agents.js tracks each
    // tool_use block) and dropped on the floor here. It is the only thing on
    // this page that answers "thinking about WHAT", so it rides as a visible
    // subtitle, not just a tooltip line.
    const toolTag = a.currentTool ? `<span class="chip-tool">· ${esc(a.currentTool)}</span>` : '';
    // A mismatch means the --model spawn flag did not take, so every cost
    // number for this agent is attributed to the wrong model. Loud on purpose:
    // a tooltip alone would leave a wrong bill looking like a right one.
    const mismatchTag = a.modelMismatch
      ? `<span class="chip-warn" title="${esc(`Model mismatch: spawned as ${a.model || '?'} but the process reports ${a.reportedModel || 'something else'}. The --model flag did not take, so this agent's cost is being attributed to the wrong model.`)}">⚠ wrong model</span>`
      : '';
    const pool = a.pool || (a.role === 'lead' ? 'lead' : 'general');
    const poolTag = isAgentRoster
      ? `<span class="chip-pool ${esc(pool)}">${esc(pool)}</span>`
      : '';
    const modelLine = a.model ? `\nmodel: ${a.model}${a.modelMismatch ? ` (MISMATCH, actually running ${a.reportedModel || 'unknown'})` : ''}` : '';
    const runtimeLine = isAgentRoster
      ? `\npool: ${pool}`
        + (a.reasoningEffort ? `\nreasoning: ${a.reasoningEffort}` : '')
        + (a.fastMode ? `\nservice: Fast` : '')
        + (a.fullAccess ? `\naccess: full trusted tools/files/web` : '')
      : '';
    const toolLine = a.currentTool ? `\nnow: ${a.currentTool}` : '';
    // Per-agent cost belongs in the title, not the chip: the one-line readout
    // in this row already carries the session number the human acts on.
    const tokenCount = ((a.tokens && a.tokens.input) || 0) + ((a.tokens && a.tokens.output) || 0);
    const costLine = (a.costUsd || a.turns)
      ? (a.costUsdMeasured === false
        ? `\n${fmtTok(tokenCount)} tokens over ${a.turns || 0} turn${a.turns === 1 ? '' : 's'} (no dollar figure)`
        : `\n${fmtUsd(a.costUsd)} over ${a.turns || 0} turn${a.turns === 1 ? '' : 's'}`)
      : '';
    return `<span class="chip${a.modelMismatch ? ' mismatch' : ''}" style="--agent:${esc(col.color)};--agent-ink:${esc(col.ink)}" title="${esc(name)}: ${esc(label)}${esc(modelLine)}${esc(runtimeLine)}${esc(toolLine)}${esc(costLine)}${esc(summaryLine)}">
      <span class="chip-dot ${status === 'thinking' ? 'pulse' : ''}"></span>${esc(name)}${poolTag}${toolTag}${mismatchTag}${interruptBtn}</span>`;
  }).join('');
  // A dismiss control only when the live roster is non-empty (halts token spend).
  const dismiss = agentsList.length ? `<button class="dismiss" data-dismiss-agents="true" title="stop all agents">dismiss</button>` : '';
  // dismiss + profile are the cost cluster (stop spending / spend slower), with
  // the meter reading immediately before the two controls that act on it.
  box.innerHTML = chips + spendHtml() + dismiss + profileHtml() + providerHtml() + fastModeHtml();
  // Narrow screens surface the same controls in More. There are no duplicate
  // ids here: delegated clicks keep provider/profile changes on one code path.
  const compactRoster = $('compactRoster'), compactMeta = $('compactMeta');
  if (compactRoster) compactRoster.innerHTML = chips + dismiss;
  if (compactMeta) compactMeta.innerHTML = spendHtml() + profileHtml() + providerHtml() + fastModeHtml();
}

function renderClaims() {
  // Region indicators: each worker locks the slide it is about to edit
  // (SUITE_EDITOR = worker name), so lock.by is the acting agent. Paint a
  // dashed card rail in that agent's INK. Patched in place, never rebuilds.
  document.querySelectorAll('.card.claimed').forEach((c) => {
    c.classList.remove('claimed'); c.style.removeProperty('--agent-ink');
    const h = c.querySelector('.card-head [data-claim]'); if (h) h.remove();
  });
  (lockItems || []).forEach((l) => {
    const card = document.querySelector(`.card[data-slide="${cssEsc(l.slideId)}"]`);
    if (!card) return;
    const col = colorFor(l.by);
    card.classList.add('claimed');
    if (col) card.style.setProperty('--agent-ink', col.ink);
    const head = card.querySelector('.card-head');
    if (head && !head.querySelector('[data-claim]')) {
      const tag = document.createElement('span');
      tag.setAttribute('data-claim', '1'); tag.className = 'claim-tag';
      tag.textContent = l.by; if (col) tag.style.color = col.ink;
      head.appendChild(tag);
    }
  });
}

// ----------------------------------------------------------------- presence
// Agents cost tokens on every turn, so they are only allowed to live while a
// human is actually here. The server reaps them when this page closes or goes
// untouched (see reapIdleAgents in server.js). Two things keep them alive:
// the ?viewer= SSE connection below, and this interaction heartbeat.
//
// Throttled hard: a real interaction happens hundreds of times a minute and the
// server only needs to know "within the last 10 minutes", so one POST every 60s
// of activity is plenty. An idle tab sends nothing at all, which is the point.
const PRESENCE_EVERY_MS = 60000;
let lastPresencePost = 0;
function touchPresence(force) {
  const now = Date.now();
  if (!force && now - lastPresencePost < PRESENCE_EVERY_MS) return;
  lastPresencePost = now;
  post('/api/presence', {}).catch(() => {});
}
// pointerdown/keydown/wheel are real intent. Deliberately NOT mousemove: a
// mouse resting on a trackpad twitches, which would make an abandoned tab look
// permanently occupied.
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, () => touchPresence(false), { passive: true });
});
document.addEventListener('visibilitychange', () => {
  // Coming back to the tab counts as presence; leaving it does not, so a
  // backgrounded tab ages out on its own.
  if (document.visibilityState === 'visible') touchPresence(true);
});
// Tell the server immediately rather than waiting for the socket close to be
// noticed. sendBeacon survives unload, a normal fetch does not.
window.addEventListener('pagehide', () => {
  try {
    const body = new Blob([JSON.stringify({ leaving: true })], { type: 'application/json' });
    navigator.sendBeacon('/api/presence', body);
  } catch (_) { /* best effort: the idle sweep still catches it */ }
});

// ---------------------------------------------------------------- staleness
// Honest, minimal: green when pixels match the model's rev, amber once a
// render/thumbs pass is known to be behind, red on an actual failure.
// Phase 1 made this fast (~1.2s), so amber should be rare and brief.
let lastGoodThumbsRev = null;
function setStale(state) {
  const dot = $('staleDot');
  dot.className = 'stale-dot' + (state === 'red' ? ' red' : state === 'amber' ? ' amber' : '');
  dot.title = state === 'red' ? 'slide pixels failed to refresh'
    : state === 'amber' ? 'slide pixels may be behind the live deck'
    : 'slide pixels match the live deck';
}
function checkStale() {
  // Unknown is not the same as current. Until a successful thumbs event names
  // the revision those pixels came from, the honest state is amber.
  setStale(lastGoodThumbsRev == null || model.rev > lastGoodThumbsRev ? 'amber' : '');
}

// -------------------------------------------------------- rehearsal pacing
// Studio-only rehearsal guidance. Durations follow stable slide ids so a live
// reorder keeps the right allowance attached to the right content; cumulative
// targets are rebuilt in the model's current speaking order. The final Q&A is
// deliberately absent from the source-verified 11:25 speaking plan. The
// separate 12:00 hard cap leaves 35 seconds of rehearsal margin.
const REHEARSAL_PACE_SECONDS = Object.freeze({
  s1: 30,
  s15: 45,
  s2: 45,
  s3: 55,
  s4: 45,
  s5: 45,
  s6: 40,
  s7: 45,
  s8: 55,
  s9: 50,
  s10: 45,
  s12: 55,
  s13: 45,
  s11: 45,
  s14: 35,
  s16: 5,
});
const REHEARSAL_HARD_CAP_SECONDS = 12 * 60;
const REHEARSAL_QA_SLIDE_ID = 'sef432705';
const REHEARSAL_START_SLIDE_ID = 's1';
let rehearsalPaceStartedAtMs = null;
let rehearsalPaceTimer = null;

function rehearsalPacePlan(sourceModel = model) {
  const slides = new Map();
  let cumulative = 0;
  for (const slide of (sourceModel && sourceModel.slides) || []) {
    const seconds = REHEARSAL_PACE_SECONDS[slide.id];
    if (!Number.isFinite(seconds)) continue;
    const start = cumulative;
    cumulative += seconds;
    slides.set(slide.id, { id: slide.id, seconds, start, end: cumulative });
  }
  return {
    slides,
    totalSeconds: cumulative,
    hardCapSeconds: REHEARSAL_HARD_CAP_SECONDS,
    bufferSeconds: Math.max(0, REHEARSAL_HARD_CAP_SECONDS - cumulative),
    qaSlideId: REHEARSAL_QA_SLIDE_ID,
  };
}

function rehearsalTime(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function currentRehearsalSlideId() {
  if (!(model.slides || []).length) return null;
  return (model.slides || []).some((slide) => slide.id === currentId)
    ? currentId
    : model.slides[0].id;
}

function rehearsalPaceReadout() {
  let node = $('rehearsalPaceReadout');
  if (node) return node;
  const stage = $('stage');
  if (!stage) return null;
  node = document.createElement('div');
  node.id = 'rehearsalPaceReadout';
  node.className = 'rehearsal-pace-readout';
  node.hidden = true;
  node.setAttribute('aria-hidden', 'true');
  stage.appendChild(node);
  return node;
}

function paintRehearsalPace(nowMs = Date.now()) {
  const stage = $('stage');
  const readout = rehearsalPaceReadout();
  document.querySelectorAll('.card.pace-behind').forEach((card) => {
    card.classList.remove('pace-behind');
  });
  const active = mode === 'single' && rehearsalPaceStartedAtMs !== null;
  if (stage) stage.classList.toggle('pace-running', active);
  if (!readout) return;
  readout.hidden = !active;
  readout.classList.remove('behind', 'qa');
  readout.removeAttribute('data-pace-state');
  readout.removeAttribute('data-pace-buffer');
  if (!active) {
    readout.textContent = '';
    readout.removeAttribute('title');
    return;
  }

  const elapsed = Math.max(0, (nowMs - rehearsalPaceStartedAtMs) / 1000);
  const slideId = currentRehearsalSlideId();
  const plan = rehearsalPacePlan();
  if (slideId === REHEARSAL_QA_SLIDE_ID) {
    readout.textContent = `${rehearsalTime(elapsed)} | Q&A untimed · talk cap 12:00`;
    readout.title = 'Final Q&A is excluded. Prepared speaking targets 11:25 and must stop by 12:00.';
    readout.classList.add('qa');
    readout.setAttribute('data-pace-state', 'qa');
    return;
  }

  const target = plan.slides.get(slideId);
  if (!target) {
    readout.textContent = `${rehearsalTime(elapsed)} | untimed slide · cap 12:00`;
    readout.title = 'This slide has no rehearsal allowance; the talk still has a 12:00 hard cap.';
    readout.setAttribute('data-pace-state', 'untimed');
    return;
  }
  const behind = elapsed > target.end;
  const lateness = Math.max(0, elapsed - target.end);
  const bufferRemaining = Math.max(0, plan.bufferSeconds - lateness);
  readout.textContent = `${rehearsalTime(elapsed)} / pace ${rehearsalTime(target.end)}`
    + ` · ${rehearsalTime(bufferRemaining)} buffer · cap 12:00`;
  readout.title = `${target.seconds}s planned here; checkpoints end at 11:25, leaving 0:35 before the 12:00 hard cap.`
    + (behind ? ` ${Math.ceil(lateness)}s behind this checkpoint.` : '');
  readout.classList.toggle('behind', behind);
  readout.setAttribute('data-pace-state', behind ? 'behind' : 'on-pace');
  readout.setAttribute('data-pace-buffer', String(Math.floor(bufferRemaining)));
  if (!behind) return;
  const card = document.querySelector(`.card[data-slide="${cssEsc(slideId)}"]`);
  if (card && card.classList.contains('current')) card.classList.add('pace-behind');
}

function startRehearsalPace(paintNow = true, nowMs = Date.now()) {
  if (rehearsalPaceTimer !== null) window.clearInterval(rehearsalPaceTimer);
  rehearsalPaceStartedAtMs = nowMs;
  rehearsalPaceTimer = window.setInterval(() => paintRehearsalPace(), 500);
  if (paintNow) paintRehearsalPace(nowMs);
}

function stopRehearsalPace(paintNow = true) {
  if (rehearsalPaceTimer !== null) window.clearInterval(rehearsalPaceTimer);
  rehearsalPaceTimer = null;
  rehearsalPaceStartedAtMs = null;
  if (paintNow) paintRehearsalPace();
}

// -------------------------------------------------------------------- mode
let mode = 'grid';
// A slide ID, never a DOM index. An index survives only until the deck changes
// shape: delete a slide while zoomed past the new end and nothing matches, so
// no card gets .current and single mode renders an empty stage with no
// explanation. build() calls applyMode() unconditionally, so there is no later
// pass that would notice. Keying on the id means applyMode() re-resolves the
// position on every rebuild for free, and clamps when the slide is gone.
let currentId = null;

function currentPos() {
  if (!model.slides.length) return -1;
  const i = model.slides.findIndex((s) => s.id === currentId);
  return i >= 0 ? i : 0;   // slide deleted out from under us: fall back to the first
}

// PowerPoint exports only a final-state PNG, so the optional preview module
// reconstructs pending entrance regions and overlays model-bound generated
// MP4s at their normalized geometry without replacing that canonical image.
// It owns no server state and performs no writes.
const studioAnimationPreview = window.StudioAnimationPreview
  ? window.StudioAnimationPreview.create({
      document,
      window,
      getModel: () => model,
      getMode: () => mode,
      getCurrentId: () => currentId,
    })
  : null;
window.studioAnimationPreview = studioAnimationPreview;
function syncAnimationPreview() {
  if (studioAnimationPreview) studioAnimationPreview.sync();
}

function applyMode() {
  const stage = $('stage');
  // toggle, not assign: a wholesale className replace would drop any other
  // class the stage is carrying (the two lines below already do it this way)
  stage.classList.toggle('mode-single', mode === 'single');
  stage.classList.toggle('mode-grid', mode !== 'single');
  $('gridModeBtn').classList.toggle('active', mode === 'grid');
  $('singleModeBtn').classList.toggle('active', mode === 'single');
  const pos = currentPos();
  // re-pin the id so a fallback (deleted slide) sticks instead of re-resolving
  // to 0 on every later keypress
  if (pos >= 0) currentId = model.slides[pos].id;
  stage.classList.toggle('deck-empty', pos < 0);
  const empty = $('deckEmpty');
  if (empty) empty.hidden = pos >= 0;
  document.querySelectorAll('.card').forEach((c, i) => {
    const current = i === pos;
    c.classList.toggle('current', current);
    c.tabIndex = mode === 'grid' ? 0 : -1;
    c.setAttribute('role', mode === 'grid' ? 'button' : 'group');
    const cardLabel = mode === 'grid' ? `Open slide ${i + 1}` : `Slide ${i + 1}`;
    c.setAttribute('data-base-label', cardLabel);
    c.setAttribute('aria-label', cardLabel);
    c.querySelectorAll('.spot').forEach((spot) => { spot.tabIndex = mode === 'single' && current ? 0 : -1; });
  });
  if (selectedObject && (selectedObject.slideId !== currentId
      || !findModelObject(selectedObject.slideId, selectedObject.objectId, selectedObject.objectKind))) {
    selectedObject = null;
    doubleClickTarget = null;
    clearObjectHistoryFocus(true);
  }
  paintProtectionState();
  renderProtections();
  // The HUD readout is mode-dependent ("4 / 16" vs "16 slides"), so it has to
  // repaint here: called only from the bootstrap, its single-mode branch was
  // unreachable and the counter froze at whatever the page loaded with.
  paintSlidePos();
  paintRehearsalPace();
  syncAnimationPreview();
}
function setMode(m) {
  const priorMode = mode;
  const enteringSlideId = currentRehearsalSlideId();
  if (m !== 'single') stopRehearsalPace(false);
  else if (priorMode !== 'single' && enteringSlideId === REHEARSAL_START_SLIDE_ID) {
    startRehearsalPace(false);
  }
  mode = m;
  if (mode !== 'single' && selectedObject) {
    selectedObject = null;
    doubleClickTarget = null;
    clearObjectHistoryFocus(true);
  }
  applyMode();
}
$('gridModeBtn').addEventListener('click', () => setMode('grid'));
$('singleModeBtn').addEventListener('click', () => setMode('single'));
let doubleClickTarget = null;
$('deck').addEventListener('click', (e) => {
  if (handleProtectionControl(e)) return;
  const card = e.target.closest('.card');
  if (!card) return;
  if (mode === 'grid') {
    currentId = card.dataset.slide;
    setMode('single');
    return;
  }
  const frame = e.target.closest('.frame');
  if (!frame || !card.classList.contains('current')) return;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const slide = (model.slides || []).find((item) => item.id === card.dataset.slide);
  if (!slide) return;
  // A native dblclick dispatches two click events first. Reusing the first hit
  // prevents the second click from cycling to a stacked object before the
  // toggle fires.
  if (e.detail > 1 && doubleClickTarget && doubleClickTarget.slideId === slide.id) {
    e.preventDefault();
    selectObject(doubleClickTarget, { deferHistory: true });
    return;
  }
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  // Four CSS pixels of tolerance keeps hairline paths selectable without
  // changing their stored geometry. Smallest-area first makes a bottom timeline
  // path win over a full-slide picture overlay; repeat-click cycles overlaps.
  const target = pickObjectAtPoint(
    slide, x, y, 4 / rect.width, 4 / rect.height, e.clientX, e.clientY
  );
  if (target) {
    e.preventDefault();
    doubleClickTarget = target;
    selectObject(target, { deferHistory: true });
  } else doubleClickTarget = null;
});

$('deck').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  const frame = e.target.closest('.frame');
  if (mode !== 'single' || !card || !frame || !card.classList.contains('current')) return;
  const target = doubleClickTarget && doubleClickTarget.slideId === card.dataset.slide
    ? doubleClickTarget
    : selectedObject && selectedObject.slideId === card.dataset.slide ? selectedObject : null;
  doubleClickTarget = null;
  if (!target || pendingProtection) return;
  e.preventDefault();
  e.stopPropagation();
  selectObject(target);
  const state = protectionStateForTarget(target);
  toggleProtection(target, !state.locked);
});

// Keyboard equivalent of the click-to-zoom above: cards are focusable
// (tabindex on cardHtml's markup) but a plain div doesn't activate on
// Enter/Space on its own the way a real <button> would.
$('deck').addEventListener('keydown', (e) => {
  if (e.target.closest('[data-protection-toggle]')) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const spot = e.target.closest('.spot');
  if (mode === 'single' && spot) {
    const card = spot.closest('.card');
    if (!card || !card.classList.contains('current')) return;
    e.preventDefault();
    selectObject({
      kind: 'object',
      slideId: card.dataset.slide,
      objectId: spot.dataset.objectId,
      objectKind: spot.dataset.objectKind,
    });
    return;
  }
  if (mode !== 'grid') return;
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault();
  currentId = card.dataset.slide;
  setMode('single');
});

// Guard on text entry, not on body: cards are focusable, so clicking one (the
// usual way into single mode) leaves focus ON that card, and a body-only guard
// then killed Escape and the arrows for the rest of the session.
function typing(e) {
  const t = e.target, tn = (t.tagName || '').toLowerCase();
  return tn === 'input' || tn === 'textarea' || t.isContentEditable;
}
document.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (mode !== 'single') return;
  // resolve -> step -> write the id back, so the arrows stay correct across a
  // rebuild that reordered or removed slides
  const pos = currentPos();
  if (pos < 0) return;
  let next = pos;
  if (e.key === 'ArrowRight') next = Math.min(pos + 1, model.slides.length - 1);
  else if (e.key === 'ArrowLeft') next = Math.max(pos - 1, 0);
  else return;
  selectedObject = null;
  doubleClickTarget = null;
  clearObjectHistoryFocus(true);
  currentId = model.slides[next].id;
  applyMode();
});

// ------------------------------------------------------------------- pause
function setPaused(on, by) {
  paused = on;
  document.body.classList.toggle('paused', !!on);
  const btn = $('pauseBtn'), overlay = $('pausedOverlay');
  if (on) {
    btn.textContent = '▶ Resume'; btn.classList.add('resumed');
    overlay.classList.remove('hidden');
    $('pausedSub').textContent = by ? `Locked by ${by}, all editors blocked.` : 'All editors are locked out.';
  } else {
    btn.textContent = '⏸ Pause'; btn.classList.remove('resumed');
    overlay.classList.add('hidden');
  }
  // Pause is a hard stop for the loop runner too (server.js tickLoops returns
  // early while paused), so the runner block has to restate itself here, and
  // the countdown has to stop ticking down toward a pass that cannot happen.
  renderRunnerState(); syncRunnerTicker();
  renderObjectHistory();
}
$('pauseBtn').addEventListener('click', async () => {
  const btn = $('pauseBtn'); btn.disabled = true;
  const action = paused ? 'resume' : 'pause';
  try {
    const r = await post(`/api/${action}`, { by: 'studio' });
    if (!r || r.ok === false) toast((r && r.error) || `Could not ${action} editing`, true);
  } catch (_) {
    toast(`Could not ${action} editing (connection error)`, true);
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------------------- SSE
function connect() {
  disconnectEventStream();
  if (document.hidden) return;
  // ?viewer= marks this stream as a real browser viewer. `ppt watch` opens the
  // same endpoint without it and deliberately does not count as someone watching.
  const stream = new EventSource('/api/events?viewer=studio');
  es = stream;
  stream.onopen = () => {
    if (es !== stream) return;
    $('connDot').className = 'dot ok'; backoff = 1000;
  };
  stream.onerror = () => {
    if (es !== stream) return;
    $('connDot').className = 'dot bad';
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
        model = ev.model; thumbsVer = ev.thumbs || thumbsVer;
        boardNotes = ev.board || []; editorsList = ev.editors || [];
        lockItems = ev.locks || []; agentsList = ev.agents || [];
        protectionItems = normalizeProtections(ev.protections || []);
        protectionExceptionItems = normalizeProtectionExceptions(ev.protectionExceptions || []);
        profileInfo = ev.profile || profileInfo; spendInfo = ev.spend || spendInfo;
        // Before setPaused(), which repaints the runner block and needs the new
        // runner state in hand to describe it correctly.
        if (ev.loopRunner !== undefined) setLoopRunner(ev.loopRunner);
        setPaused(ev.paused, ev.pausedBy);
        // A snapshot arrives on every (re)connect, so the panels have to be
        // repainted here too: a dropped stream is exactly when they go stale.
        undoCount = ev.undoCount || 0; redoCount = ev.redoCount || 0;
        if (ev.pdfRev != null) pdfRev = ev.pdfRev;
        build();
        checkStale();
        renderChat(); renderChips(); paintUndo(); paintPdf(); paintSlidePos();
        renderBoard(); renderTasks(ev.tasks); renderLoops(ev.loops);
        fetchLint(); fetchTiming();
        refreshSelectedObjectHistory();
        break;
      case 'edit':
        model = ev.model;
        if (!maybeRebuild()) refreshFallback(ev.affected);
        syncAnimationPreview();
        patchGeometry(ev.affected);
        glow(ev.affected, ev.editor);
        paintProtectionState();
        renderProtections();
        checkStale();
        // There is no lint or timing SSE event, so an edit is the only signal
        // that either number moved (see the 30s fallback poll at the bottom).
        fetchLint(); fetchTiming();
        if (ev.undoCount != null) { undoCount = ev.undoCount; redoCount = ev.redoCount || 0; }
        paintUndo(); paintPdf(); paintSlidePos();
        feedItem(ev);
        tick(`${ev.editor || 'someone'}: ${ev.detail || ev.opType || 'edited the deck'}`);
        refreshSelectedObjectHistory();
        break;
      case 'object-history':
        // The event is deliberately only an invalidation signal. A focused GET
        // remains the single response contract, and request sequence IDs keep
        // a slow earlier read from winning after this refresh.
        refreshSelectedObjectHistory();
        break;
      // renderChat owns boardNotes; renderBoard reads it back, so the order
      // here matters and the panel never renders a stale copy.
      case 'board': renderChat(ev.notes); renderBoard(); break;
      case 'tasks':
        renderTasks(ev.tasks); feedItem(ev);
        tick(`task ${ev.action || 'updated'}${ev.task && ev.task.text ? ': ' + ev.task.text : ''}`);
        break;
      case 'loops':
        // Only action:'runner' carries loopRunner; every other action ships just
        // the rows, which is why the countdown is recomputed from those rows.
        if (ev.loopRunner !== undefined) setLoopRunner(ev.loopRunner);
        renderLoops(ev.loops); feedItem(ev);
        tick(`loop ${ev.action || 'updated'}${ev.loop && ev.loop.text ? ': ' + ev.loop.text : ''}`);
        break;
      // The team was stopped because nobody was watching (see reapIdleAgents in
      // server.js). Loud, because from the human's side an agent that silently
      // vanished mid-task is indistinguishable from one that is stuck.
      case 'reaped': {
        const names = Array.isArray(ev.agents) ? ev.agents.join(', ') : '';
        const msg = `Agents stopped${names ? ' (' + names + ')' : ''}: nobody was watching, so they were not left spending tokens.`;
        toast(msg); tick(msg); feedItem(ev);
        break;
      }
      case 'editors': editorsList = ev.editors || []; renderChips(); renderClaims(); break;
      case 'locks': lockItems = ev.locks || []; renderClaims(); renderProtections(); break;
      case 'protections': receiveProtections(
        ev.protections || [], ev.protectionExceptions || []
      ); break;
      // The roster event carries the profile too, so a spawn/exit refreshes the
      // pending flag: whether a running agent diverges from the chosen profile
      // is exactly what changes when the roster does.
      case 'agents': agentsList = ev.agents || []; if (ev.profile) profileInfo = ev.profile; renderChips(); break;
      case 'spend': if (ev.spend) spendInfo = ev.spend; renderChips(); break;
      case 'thumbs':
        if (ev.ok === false) { setStale('red'); break; }
        thumbsVer = ev.ver || (thumbsVer + 1);
        lastGoodThumbsRev = ev.rev != null ? ev.rev : lastGoodThumbsRev;
        // One id-keyed path for both the whole-deck and partial cases. The old
        // full-refresh branch walked `.frame img` in document order and assigned
        // slide-(i+1).png by position, which silently mis-assigns every image the
        // moment card order stops matching model order, and which would also pick
        // up any <img> inside any other .frame-classed element on the page.
        ((ev.slides == null) ? model.slides.map((s) => s.id) : ev.slides).forEach((id) => {
          slideImgVer[id] = thumbsVer;
          const n = slideNumber(id);
          if (!n) return;
          const img = document.querySelector(`.card[data-slide="${cssEsc(id)}"] img`);
          if (img) { img.style.display = ''; img.src = `/thumbs/slide-${n}.png?v=${thumbsVer}`; img.dataset.ok = '1'; }
        });
        checkStale();
        break;
      case 'pause': setPaused(true, ev.by); feedItem(ev); tick(`paused by ${ev.by || 'someone'}`); break;
      case 'resume': setPaused(false); feedItem(ev); tick(`resumed by ${ev.by || 'someone'}`); break;
      case 'render': if (ev.ok === false) setStale('amber'); feedItem(ev); break;
      case 'persist':
        setStale('red');
        toast(`Save failed (${ev.file || 'disk'}): ${ev.error || 'unknown error'}`, true);
        tick(`save failed: ${ev.file || 'disk'}`);
        break;
      case 'pdf':
        // pdfRev is what paintPdf() diffs against model.rev to tell you the
        // downloaded file is N edits behind; without this it stayed null forever.
        if (ev.ok) { pdfRev = ev.rev; paintPdf(); }
        toast(ev.ok ? 'PDF exported' : (ev.error || 'PDF export failed'), !ev.ok);
        feedItem(ev);
        break;
      case 'ping': default: break;
    }
  };
}

function disconnectEventStream() {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (es) { es.close(); es = null; }
}

// Chrome permits only a small number of HTTP/1.1 connections per origin.
// Background Studio tabs must not consume them with permanent SSE streams,
// otherwise a new tab can display HTML before studio.js or a download request
// gets a connection. A reconnect always receives a complete snapshot.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnectEventStream();
  else if (!es) connect();
});

// ---- toast: a brief visible error, mirroring the main dashboard's pattern.
// studio had none, so a failed action (most importantly: typing into the
// chatbox while paused) previously gave zero feedback. fetch() does not
// reject on an HTTP error status, only on a network failure, so post()'s
// resolved body must be checked explicitly, a plain try/catch never sees it.
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('toast'); if (!el) return;
  el.textContent = msg; el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = 'toast'), 3200);
}

// ------------------------------------------------------- slash commands
// Typed, explicit, handled entirely in this tab and never forwarded to the lead.
// The reason they exist is not convenience: POST /api/chat is 423'd while the
// deck is paused, but /api/board, /api/tasks and /api/loops are all deliberately
// UNGATED by pause. Without a direct path, pausing (the thing you do when
// something has gone wrong) would delete the whole control surface at exactly
// the moment you need it. They also cost no agent turn and cannot be misrouted.
const SLASH_CMDS = ['pin', 'note', 'task', 'loop', 'find', 'undo', 'redo', 'rules', 'loops', 'tasks', 'lint', 'activity', 'help'];
const SLASH_SET = new Set(SLASH_CMDS);
// Panel commands, so /rules can open the panel whose data-panel is 'board'.
const SLASH_PANELS = { rules: 'board', loops: 'loops', tasks: 'tasks', lint: 'lint', activity: 'activity' };

// The rule for "is this a command or is it prose that happens to start with /":
// a command is a slash, then ONE bare alphabetic word, then a space or the end.
// Everything else is left alone and reaches the lead untouched:
//   "/ hello there"        slash then a space, so there is no command word
//   "//cdn.example.com"    a second slash inside the first token
//   "/workspace/deck"      same shape, a filesystem path
//   "/api.example.com"     a dot (or colon, or digit) inside the token
//   "/thisisnotacommand…"  longer than any command name we define
// What is left ("/pn tighten s4") can only be a mistyped command, so it is
// REPORTED rather than forwarded: sending it to the lead would spend a real
// agent turn interpreting a typo.
function parseSlash(text) {
  const m = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const head = m[1];
  if (!head) return null;                             // bare "/" or "/ something"
  if (!/^[a-zA-Z][a-zA-Z-]*$/.test(head)) return null; // contains /, ., :, a digit, ...
  if (head.length > 12) return null;                   // longest real command is 8 chars
  const cmd = head.toLowerCase();
  return { cmd, rest: (m[2] || '').trim(), known: SLASH_SET.has(cmd) };
}

// Same author the panel composers use, so a rule pinned from the chat bar and
// one pinned from the board panel are attributed to the same person.
function authorName() {
  const el = $('asName');
  return ((el && el.value.trim()) || 'josh');
}

// post() resolves on 4xx instead of throwing, so r.ok === false is the only
// signal a write failed. Every slash command routes through here so that a
// rejected write produces a visible receipt too, not just silence.
async function slashWrite(path, body, okMsg, failMsg) {
  const r = await post(path, body).catch(() => null);
  if (!r || r.ok === false) {
    const err = (r && r.error) || failMsg;
    sysEcho(err, true); toast(err, true);
    return null;
  }
  if (okMsg) sysEcho(okMsg);
  return r;
}

// "--every 5m", "--every=5m" and a bare "every 5m" at the END of the text, so
// the cadence never has to be typed before the thing it applies to.
// The flag form always wins (it is explicit, so "--every each-edit" is still a
// cadence). The bare form is only honoured when the trailing word actually
// parses as a duration, otherwise "check the notes every slide" would quietly
// eat its own last two words and store "slide" as a cadence.
function splitEvery(rest) {
  let m = /\s+--every[=\s]+(\S+)\s*$/i.exec(rest);
  if (!m) {
    m = /\s+every\s+(\S+)\s*$/i.exec(rest);
    if (m && !parseCadence(m[1])) m = null;
  }
  if (!m) return { text: rest, cadence: '' };
  return { text: rest.slice(0, m.index).trim(), cadence: m[1] };
}

const SLASH_HELP = [
  'Commands this page runs itself, no agent turn and no pause gate:',
  '/pin <text>          pin a house rule (binding on every session)',
  '/note <text>         post a board message, the lead is not woken',
  '/task <text>         add a task to the shared queue',
  '/loop <text> --every 5m   add a standing loop (cadence optional)',
  '/find <text>         jump to the first slide matching text or notes',
  '/undo  /redo         step the deck history',
  '/rules /loops /tasks /lint /activity   open that panel',
  '/help                this list',
  'Anything else goes to the lead agent.',
].join('\n');

async function runSlash(cmd, rest) {
  if (!SLASH_SET.has(cmd)) {
    sysEcho(`Unknown command /${cmd}. Nothing was sent to the lead. Type /help for the list.`, true);
    return;
  }
  if (cmd === 'help') { sysEcho(SLASH_HELP); return; }

  const panel = SLASH_PANELS[cmd];
  if (panel) {
    // setPanel() is a toggle, and a command whose whole point is "show me this"
    // must never close it, so only call it when the panel is not already up.
    if (openPanel !== panel) setPanel(panel);
    sysEcho(`Opened the ${cmd === 'rules' ? 'board' : cmd} panel.`);
    return;
  }

  if (cmd === 'pin' || cmd === 'note') {
    if (!rest) { sysEcho(`Usage: /${cmd} <text>`, true); return; }
    const pinned = cmd === 'pin';
    await slashWrite('/api/board', { text: rest, author: authorName(), pinned },
      pinned ? 'Pinned as a house rule. Every session is bound by it.'
             : 'Posted to the board. The lead was not woken, use a plain message for that.',
      pinned ? 'Could not pin that rule' : 'Could not post that message');
    return;
  }

  if (cmd === 'task') {
    if (!rest) { sysEcho('Usage: /task <text>', true); return; }
    await slashWrite('/api/tasks', { text: rest, by: authorName(), assignee: '', wakeWorker: false },
      'Queued as a passive task for anyone. Assign a worker in the Tasks panel to wake it immediately.',
      'Could not add the task');
    return;
  }

  if (cmd === 'loop') {
    if (!rest) { sysEcho('Usage: /loop <text> --every 10m', true); return; }
    const { text, cadence } = splitEvery(rest);
    if (!text) { sysEcho('Usage: /loop <text> --every 10m', true); return; }
    // Never claim it started: a loop only fires if the runner is on, the deck is
    // live, someone is watching, and the cadence is machine-readable.
    const sched = parseCadence(cadence);
    const running = !!(loopRunner && loopRunner.enabled) && !paused && !(loopRunner && loopRunner.present === false);
    const tail = !cadence ? ' No cadence given, so it is manual only.'
      : !sched ? ` Cadence "${cadence}" is not a timer the runner can read, so it is manual only.`
      : running ? ` It will run every ${cadence}.`
      : ' Saved, but the loop runner is not currently able to fire it. Open the loops panel for the reason.';
    await slashWrite('/api/loops', { text, author: authorName(), cadence },
      'Added a standing loop.' + tail, 'Could not add the loop');
    return;
  }

  if (cmd === 'find') {
    if (!rest) { sysEcho('Usage: /find <text>', true); return; }
    runFind(rest);
    return;
  }

  if (cmd === 'undo' || cmd === 'redo') {
    const r = cmd === 'undo' ? await doUndo() : await doRedo();
    if (!r || r.ok === false) sysEcho((r && r.error) || `Nothing to ${cmd}.`, true);
    else sysEcho(`${cmd === 'undo' ? 'Undid' : 'Redid'} the last edit.`);
    return;
  }
}

// ---- chatbox: the human briefs the lead. Posting is a board note (author
// 'josh'); delivery to the lead is POST /api/chat. The {type:'board'} SSE echo
// renders the bubble (<100ms locally), so no optimistic append is needed.
let chatPosting = false;
function setChatDelivery(message, detail) {
  const form = $('chatform'), status = $('chatDelivery');
  const hasMessage = !!message;
  if (status) {
    status.hidden = !hasMessage;
    status.textContent = message || '';
    if (detail) status.title = detail;
    else status.removeAttribute('title');
  }
  if (form) {
    if (hasMessage) form.dataset.delivery = 'error';
    else if (!chatPosting) delete form.dataset.delivery;
  }
  publishChromeSizes();
}
function setChatPosting(on) {
  chatPosting = !!on;
  const form = $('chatform'), send = $('chatSend');
  if (send) {
    send.disabled = chatPosting;
    send.textContent = chatPosting ? 'Sending…' : 'Send';
  }
  if (!form) return;
  if (chatPosting) {
    form.dataset.delivery = 'sending';
    form.setAttribute('aria-busy', 'true');
  } else {
    form.removeAttribute('aria-busy');
    if (form.dataset.delivery === 'sending') {
      const status = $('chatDelivery');
      if (status && !status.hidden) form.dataset.delivery = 'error';
      else delete form.dataset.delivery;
    }
  }
}
function restoreChatDraft(text, pin, detail, message) {
  const inp = $('chatinput');
  if (inp) {
    const newerText = inp.value.trim();
    inp.value = newerText ? text + ' ' + newerText : text;
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
    inp.focus();
    if (inp.setSelectionRange) inp.setSelectionRange(inp.value.length, inp.value.length);
  }
  if (pin) setPinArmed(true);
  setChatDelivery(message || 'Message not saved — your draft is still here.', detail);
}
function leadDeliveryStatus(detail) {
  return /paused/i.test(detail || '')
    ? 'Saved to board — resume to notify the lead.'
    : 'Saved to board — lead not notified.';
}
async function sendChat() {
  const inp = $('chatinput'); if (!inp) return;
  const text = inp.value.trim(); if (!text) return;
  // Parsed BEFORE anything is sent: a slash command must never reach the lead,
  // and must still work while the deck is paused (see the block above).
  const slash = parseSlash(text);
  if (slash) {
    inp.value = ''; inp.style.height = 'auto'; publishChromeSizes();
    await runSlash(slash.cmd, slash.rest);
    return;
  }
  if (chatPosting) return;
  // A delivery warning describes the previous attempt. Clear it when a new
  // plain message starts so a later successful send cannot keep displaying an
  // obsolete "lead not notified" result.
  setChatDelivery(null);
  inp.value = '';
  // The pin toggle composes with a plain message: armed, the note posts pinned
  // and disarms. It is read (and cleared) before the awaits so a second Enter
  // during a slow POST cannot pin twice.
  const pin = pinArmed;
  if (pin) setPinArmed(false);
  setChatPosting(true);
  inp.style.height = 'auto';
  publishChromeSizes();
  try {
    let board;
    try {
      board = await post('/api/board', { text, author: 'josh', pinned: pin }); // the visible message
    } catch (_) {
      restoreChatDraft(text, pin, 'Connection error while saving the message.',
        'Save could not be confirmed — check the board before resending.');
      return;
    }
    if (!board || board.ok === false) {
      restoreChatDraft(text, pin, (board && board.error) || 'The message could not be saved.');
      return;
    }
    // A pinned note is filtered OUT of the chat log (renderChat drops pinned),
    // so without this receipt an armed message would appear to vanish.
    if (pin) sysEcho('Pinned as a house rule. It is binding on every session, and it is in the board panel, not the chat log.');
    // The board entry is already durable now. A generic retry or draft restore
    // here would post it a second time, so delivery failure stays a clear status.
    let r;
    try {
      r = await post('/api/chat', { text });                            // wake/spawn the lead
    } catch (_) {
      setChatDelivery('Saved to board — lead not notified.', 'Connection error while notifying the lead.');
      return;
    }
    if (!r || r.ok === false) {
      const detail = (r && r.error) || 'The lead did not accept the message.';
      setChatDelivery(leadDeliveryStatus(detail), detail);
    }
  } finally {
    setChatPosting(false);
  }
}

// ------------------------------------------------------------- find a slide
// Ported from the dashboard's ppt-search equivalent (app.js searchMatchIds):
// same fields, same in-memory model, so /find and ppt search agree.
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

// Deliberately NOT a filter that rebuilds #deck. A structural rebuild tears any
// in-flight glow out of the DOM mid-flight (see build()'s note at the top of
// this file), which is fatal with more than one editor active. So: mark the
// matches in place and move currentId, which applyMode() resolves on every
// later rebuild for free. The class is .search-hit, never .landed, so a search
// result can never be mistaken for an edit that just landed.
let findClearTimer = null;
const FIND_MARK_MS = 12000;
function clearFindMarks() {
  document.querySelectorAll('.card.search-hit').forEach((c) => c.classList.remove('search-hit'));
}
function runFind(term) {
  clearTimeout(findClearTimer);
  clearFindMarks();
  const ids = searchMatchIds(term);
  if (!ids.length) { sysEcho(`No slide matches ${term}. Searched titles, bullets, body text and speaker notes.`, true); return; }
  ids.forEach((id) => {
    const c = document.querySelector(`.card[data-slide="${cssEsc(id)}"]`);
    if (c) c.classList.add('search-hit');
  });
  currentId = ids[0];
  applyMode();
  if (mode === 'grid') {
    // Only in grid: single mode shows one card on a non-scrolling stage, where
    // scrollIntoView would move the page body instead of the deck.
    const first = document.querySelector(`.card[data-slide="${cssEsc(ids[0])}"]`);
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  findClearTimer = setTimeout(clearFindMarks, FIND_MARK_MS);
  const n = slideNumber(ids[0]);
  sysEcho(`${ids.length} slide${ids.length === 1 ? '' : 's'} match ${term}. Jumped to slide ${n} (${ids[0]})`
    + (ids.length > 1 ? `, the rest are outlined: ${ids.slice(1).map((id) => slideNumber(id)).join(', ')}.` : '.'));
}
if ($('chatform')) {
  $('chatform').addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
}
// Dismiss / interrupt agents (event-delegated: chips are re-rendered on every
// agents/editors update, a direct listener on a chip button would be torn
// out from under itself the next time renderChips() runs).
function handleAgentControl(e) {
  const dismiss = e.target && e.target.closest && e.target.closest('[data-dismiss-agents]');
  if (dismiss) post('/api/agents/stop', {}).catch(() => {});
  const interruptName = e.target && e.target.dataset && e.target.dataset.interrupt;
  if (interruptName) post('/api/agents/interrupt', { name: interruptName }).catch(() => {});
  // closest(), not e.target: the active button can contain the ·next marker,
  // so a click can land on that inner span instead of the button itself.
  const profBtn = e.target && e.target.closest && e.target.closest('[data-profile]');
  if (profBtn) setProfile(profBtn.dataset.profile);
  // Same closest() reason as the profile above: the active provider button can
  // contain the ·next marker, so the click can land on that inner span.
  const provBtn = e.target && e.target.closest && e.target.closest('[data-provider]');
  if (provBtn) setProvider(provBtn.dataset.provider);
  const fastBtn = e.target && e.target.closest && e.target.closest('[data-fast-mode]');
  if (fastBtn) setFastMode(fastBtn.dataset.fastMode === 'true');
}
$('agentChips').addEventListener('click', handleAgentControl);
if ($('compactMenu')) $('compactMenu').addEventListener('click', handleAgentControl);
// '/' focuses the chat input. Shares the deck-nav's typing() guard, so it never
// fires while the human is typing (most importantly: not inside the chat input
// it would otherwise re-focus), but does fire with a card focused.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !typing(e)) { e.preventDefault(); const i = $('chatinput'); if (i) i.focus(); }
});

// ------------------------------------------------------- measured chrome
// Grid mode reserves space for the two floating bars, so it needs their real
// height. A ResizeObserver rather than a resize listener is required, not just
// tidier: the chat pill grows when its textarea auto-grows and when the log
// opens, neither of which fires a window resize. offsetHeight (border box), not
// contentRect, which excludes padding and the border and reports ~25px short.
function publishChromeSizes() {
  const root = document.documentElement;
  const chrome = $('chrome'), chat = $('chat');
  if (chrome) root.style.setProperty('--chrome-h', chrome.offsetHeight + 'px');
  if (chat) root.style.setProperty('--chat-h', chat.offsetHeight + 'px');
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(publishChromeSizes);
  if ($('chrome')) ro.observe($('chrome'));
  if ($('chat')) ro.observe($('chat'));
}
window.addEventListener('resize', publishChromeSizes);
publishChromeSizes();

// ----------------------------------------------------------- docked panels
// One open at a time, and on desktop its width is reserved by the workspace
// rather than laid over the slide. All panels stay in the DOM so the renderers
// can write into them on every SSE event without an open/closed guard.
let openPanel = null;
let lastToggle = null;

function setPanel(name) {
  const previous = openPanel;
  openPanel = (name === openPanel) ? null : name;
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== openPanel; });
  document.querySelectorAll('.ptog').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.panel === openPanel)));
  document.body.classList.toggle('panel-open', !!openPanel);
  document.body.classList.toggle('object-history-open', openPanel === 'object-history');
  document.body.classList.remove('peek');
  if (previous === 'object-history' && openPanel !== 'object-history') abortObjectHistoryRequest();
  if (openPanel) {
    const p = document.querySelector(`.panel[data-panel="${openPanel}"]`);
    // Only the activity log sticks to the bottom (it cannot do so while hidden,
    // since clientHeight is 0). The board must NOT: its house rules sit at the
    // top and are the binding directives, so opening straight to the newest
    // chat message buries the one thing the panel exists to show.
    const sc = p && p.querySelector('.panel-scroll');
    if (sc) sc.scrollTop = openPanel === 'activity' ? sc.scrollHeight : 0;
    const f = p && p.querySelector('textarea, input, button:not([data-close])');
    if (openPanel === 'object-history' && p) p.focus({ preventScroll: true });
    else if (f && openPanel !== 'lint' && openPanel !== 'activity') f.focus();
    if (openPanel === 'loops') refreshRunner();
  } else if (lastToggle) {
    lastToggle.focus();
  }
  // Starts the countdown on open and, just as importantly, clears the 1s
  // interval on close so a closed panel is not repainting once a second forever.
  syncRunnerTicker();
}
$('ptogs').addEventListener('click', (e) => {
  const b = e.target.closest('.ptog'); if (!b) return;
  lastToggle = b; setPanel(b.dataset.panel);
});
document.querySelectorAll('.panel [data-close]').forEach((b) => {
  b.addEventListener('click', () => setPanel(null));
});

// ------------------------------------------------------- panel renderers
// Ported from the dashboard (app.js): same element ids, same endpoints, same
// server-owned state, so there is one implementation of "what a rule/task/loop
// looks like" and no second source of truth. The one real difference is that
// every list writes TWO counts. The chrome badge is the always-visible half and
// answers the question without opening anything, so it stays a bare number; the
// panel header can afford words.
function chromeCount(id, text, cls) {
  const el = $(id); if (!el) return;
  el.textContent = text == null ? '' : String(text);
  // .pcount:empty is display:none, so '' is how a count hides itself.
  el.className = 'pcount' + (cls ? ' ' + cls : '');
}
function panelCount(id, text) {
  const el = $(id); if (el) el.textContent = text || '';
}
// Short absolute stamp. The lists are read hours after the fact (a rule pinned
// this morning, a loop last run yesterday), so a bare clock time would be
// ambiguous on everything except the newest few rows.
function fmtWhen(ts) {
  return new Date(ts || Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------ message board
// Only the newest slice renders: the FULL conversation is already the chat log
// at the bottom of the page, so rebuilding ~190 nodes into a hidden panel on
// every board event buys nothing.
const NOTES_SHOWN = 40;

// No argument: boardNotes is owned by the SSE 'board' case and the bootstrap,
// exactly like renderChat's copy, and two writers for one array is how the two
// lists drift apart.
function renderBoard() {
  const pins = boardNotes.filter((n) => n.pinned);
  const msgs = boardNotes.filter((n) => !n.pinned);   // boardView() already sorts these newest-first
  // House rules are binding directives, so their count rides the chrome badge
  // whether or not the panel is open: a rule nobody can see is a rule that gets
  // broken. This is the one count that is deliberately never suppressed.
  chromeCount('rulesCount', pins.length ? String(pins.length) : '');
  panelCount('rulesCountPanel', pins.length
    ? `${pins.length} rule${pins.length === 1 ? '' : 's'}, ${msgs.length} message${msgs.length === 1 ? '' : 's'}`
    : `${msgs.length} message${msgs.length === 1 ? '' : 's'}`);
  const lab = $('rulesLabel');
  if (lab) lab.textContent = pins.length ? `House rules (${pins.length}, binding)` : 'House rules';
  $('rules').innerHTML = pins.length
    ? pins.map(ruleHtml).join('')
    : `<div class="panel-empty">No house rules yet. Tick Pin as house rule to add one every session has to follow.</div>`;
  const more = msgs.length > NOTES_SHOWN
    ? `<div class="panel-empty">Showing the ${NOTES_SHOWN} most recent of ${msgs.length} messages. The full conversation is in the chat log below.</div>`
    : '';
  $('notes').innerHTML = msgs.length
    ? msgs.slice(0, NOTES_SHOWN).map(noteHtml).join('') + more
    : `<div class="panel-empty">No messages yet.</div>`;
}

// .rule-text and friends are white-space:pre-wrap, so these templates are
// concatenated with no stray indentation: a newline in the markup would render
// as a literal blank line inside the rule.
function ruleHtml(n) {
  return `<div class="rule" data-id="${esc(n.id)}" title="${esc(`pinned by ${n.author} (${fmtWhen(n.ts)})`)}">`
    + `<div class="rule-text">${esc(n.text)}</div>`
    + `<button class="mini-x" data-unpin="${esc(n.id)}" aria-label="Unpin this house rule" title="unpin (it stays as a message)">×</button>`
    + `</div>`;
}

function noteHtml(n) {
  // Same author tint the chat bubbles use, so a note reads as the same voice in
  // both places. colorFor() returns null for humans, which is the no-tint case.
  const col = colorFor(n.author);
  const style = col ? ` style="color:${esc(col.ink)}"` : '';
  return `<div class="note" data-id="${esc(n.id)}">`
    + `<div class="note-text">${esc(n.text)}<div class="note-who"${style}>${esc(n.author)} · ${esc(fmtWhen(n.ts))}</div></div>`
    + `<button class="mini-x" data-del="${esc(n.id)}" aria-label="Delete this message" title="delete">×</button>`
    + `</div>`;
}

// --------------------------------------------------------------- task queue
let taskItems = [];

function renderTasks(tasks) {
  if (Array.isArray(tasks)) taskItems = tasks;
  const active = taskItems.filter((t) => t.status !== 'done');
  const done = taskItems.filter((t) => t.status === 'done');
  chromeCount('tasksCount', active.length ? String(active.length) : '');
  panelCount('tasksCountPanel', taskItems.length
    ? `${active.length} open, ${done.length} done` : '');
  const parts = [];
  if (!taskItems.length) {
    parts.push(`<div class="panel-empty">No tasks yet. Assign worker-N or media-N to wake that worker immediately, or leave the for field blank to add a passive task for anyone.</div>`);
  }
  active.forEach((t) => parts.push(taskHtml(t)));
  if (done.length) {
    parts.push(`<div class="notes-label">Done</div>`);
    done.slice(0, 12).forEach((t) => parts.push(taskHtml(t)));
  }
  $('tasklist').innerHTML = parts.join('');
}

function taskHtml(t) {
  const who = t.assignee ? esc(t.assignee) : 'anyone';
  const claimed = (t.status === 'claimed' && t.claimedBy) ? ` (claimed by ${esc(t.claimedBy)})` : '';
  const meta = t.status === 'done'
    ? `done${t.claimedBy ? ' by ' + esc(t.claimedBy) : ''}${t.doneTs ? ' · ' + esc(fmtWhen(t.doneTs)) : ''}`
    : `→ ${who}${claimed}`;
  const doneBtn = t.status === 'done' ? ''
    : `<button class="mini-btn" data-done="${esc(t.id)}" aria-label="Mark this task done" title="mark done">✓</button>`;
  return `<div class="task ${esc(t.status)}" data-id="${esc(t.id)}">`
    + `<div class="task-text">${esc(t.text)}<div class="task-who">${meta} · from ${esc(t.by)}</div></div>`
    + doneBtn
    + `<button class="mini-x" data-taskdel="${esc(t.id)}" aria-label="Delete this task" title="delete">×</button>`
    + `</div>`;
}

// ------------------------------------------------------------ standing loops
let loopItems = [];
// /api/state's loopRunner: {enabled, schedulable, manualOnly, nextDueMs,
// presenceRequired, present}. Still null on a server build that predates the
// runner, which renderRunnerState() reports as "no runner attached".
let loopRunner = null;
let runnerTs = 0;          // when the value above was received, for the countdown anchor

function setLoopRunner(v) {
  loopRunner = (v === undefined) ? null : v;
  runnerTs = Date.now();
}

// Mirror of server.js parseCadence, including the 60s floor. Ported rather than
// inferred because the ONE thing this panel must not do is draw a timer next to
// a cadence the scheduler cannot actually read ("each edit", "continuously").
const LOOP_MIN_CADENCE_MS = 60000;
function parseCadence(c) {
  if (!c) return null;
  const m = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)$/i.exec(String(c).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const ms = unit.charAt(0) === 's' ? n * 1000 : unit.charAt(0) === 'm' ? n * 60000 : n * 3600000;
  return Math.max(LOOP_MIN_CADENCE_MS, ms);
}

// Same formula the server uses (loopDueAt): the row it is computed from arrives
// fresh on EVERY loops event, whereas loopRunner.nextDueMs only rides the
// snapshot and the 'runner' action. Recomputing locally is what keeps the
// countdown honest right after an add, a toggle or a run.
function nextDueLoop() {
  const now = Date.now();
  let best = null;
  loopItems.forEach((l) => {
    if (!l.enabled) return;
    const every = parseCadence(l.cadence);
    if (!every) return;
    const ms = Math.max(0, ((l.lastRun || l.createdTs || now) + every) - now);
    if (!best || ms < best.ms) best = { ms, loop: l };
  });
  return best;
}
function nextDueMs() {
  const local = nextDueLoop();
  if (local) return local.ms;
  // No schedulable row in hand: fall back to the server's own number, aged by
  // how long ago it arrived.
  if (loopRunner && loopRunner.nextDueMs != null && runnerTs) {
    return Math.max(0, loopRunner.nextDueMs - (Date.now() - runnerTs));
  }
  return null;
}

function renderLoops(loops) {
  if (Array.isArray(loops)) loopItems = loops;
  const on = loopItems.filter((l) => l.enabled).length;
  chromeCount('loopsCount', loopItems.length ? `${on}/${loopItems.length}` : '');
  panelCount('loopsCountPanel', loopItems.length
    ? `${on} enabled of ${loopItems.length}` : '');
  renderRunnerState();
  syncRunnerTicker();
  $('looplist').innerHTML = loopItems.length
    ? loopItems.map(loopHtml).join('')
    : `<div class="panel-empty">No standing loops yet. A loop is a recurring check (for example: keep every box's text neat), unlike a task, which is done once and closed.</div>`;
}

// The three ways a stored loop quietly never fires are the whole point of this
// block. None of them is visible from the row itself:
//   1. the runner is off,
//   2. nobody is watching (agents are reaped when the viewer closes or goes
//      untouched for 10 minutes, and the runner refuses to run then on purpose,
//      so a loop can never resurrect a team with nobody at the screen),
//   3. the deck is paused.
// Plus the per-loop case: a cadence the scheduler cannot parse is manual only.
function renderRunnerState() {
  const el = $('runnerState'); if (!el) return;

  if (!loopRunner) {
    el.className = 'runner-state';
    el.textContent = loopItems.length
      ? 'No loop runner attached. These loops are registered and saved, but nothing is executing them on a schedule. A session has to pick them up (ppt loops, then a /loop pass).'
      : 'No loop runner attached. Loops added here are saved for a session to pick up, they do not execute on their own yet.';
    return;
  }

  const on = !!loopRunner.enabled;
  const present = loopRunner.present !== false;
  // Local counts, for the same freshness reason as nextDueLoop(): the server's
  // schedulable/manualOnly ride only the snapshot and the 'runner' action.
  const schedulable = loopItems.filter((l) => l.enabled && parseCadence(l.cadence)).length;
  const manualOnly = loopItems.filter((l) => l.enabled && !parseCadence(l.cadence)).length;
  const blocked = on && (paused || !present);
  el.className = 'runner-state' + (on ? ' on' : '') + (blocked ? ' blocked' : '');

  // Text on the switch, not colour alone, matching .loop-toggle's reasoning.
  const btn = `<button type="button" class="runner-toggle${on ? ' on' : ''}" data-runner="${on ? 'off' : 'on'}"`
    + ` aria-pressed="${on}" title="${on ? 'stop running loops on a schedule' : 'start running loops on a schedule'}">${on ? 'on' : 'off'}</button>`;
  const head = `<div class="runner-head"><span class="runner-lab">Loop runner</span>${btn}</div>`;

  const lines = [];
  if (!on) {
    lines.push('Off. Loops stay saved and a session can still run one by hand, but nothing is on a schedule.');
  } else {
    if (paused) lines.push('The deck is paused, and pause stops loops too. Nothing will fire until you resume.');
    if (!present) {
      lines.push('Nobody is registered as watching, so the runner will not fire. Agents are stopped when the viewer is closed or goes untouched for 10 minutes, and the runner refuses to run then on purpose: a loop must not bring agents back with nobody at the screen. Click or type on this page to count as present again.');
    }
    if (!schedulable) {
      lines.push(manualOnly
        ? 'No enabled loop has a cadence the scheduler can read, so nothing is queued.'
        : 'On, with no enabled loop to run.');
    } else if (!blocked) {
      const nx = nextDueLoop();
      const what = nx ? ` (${nx.loop.text})` : '';
      lines.push(`Next pass in <span class="runner-count">${esc(fmtMMSS(nextDueMs() / 1000))}</span>${esc(what)}.`
        + ' The runner checks on a timer, so it can fire a few seconds late.');
    } else {
      // Still show the number: it is the answer to "and how long has it been
      // sitting there un-run", which is the question a blocked runner raises.
      lines.push(`${schedulable} loop${schedulable === 1 ? '' : 's'} would be due in <span class="runner-count">${esc(fmtMMSS((nextDueMs() || 0) / 1000))}</span> once that is fixed.`);
    }
  }
  if (manualOnly) {
    lines.push(`${manualOnly} enabled loop${manualOnly === 1 ? '' : 's'} ${manualOnly === 1 ? 'has' : 'have'} a cadence nothing can schedule (for example: each edit). ${manualOnly === 1 ? 'That one runs' : 'Those run'} only when a session picks it up.`);
  }
  // Only fmtMMSS output and loop text reach innerHTML unescaped-adjacent, and
  // both are esc()'d above; the rest of these strings are literals.
  el.innerHTML = head + lines.map((t) => `<div class="runner-line">${t}</div>`).join('');
}

// A live countdown, not a static number: a frozen "next pass in 4:12" is
// indistinguishable from a runner that has stopped. Ticks only while the panel
// is open and the runner is actually able to fire, and is cleared otherwise.
let runnerTicker = null;
function syncRunnerTicker() {
  const rn = loopRunner || {};
  // nextDueMs() in the condition, not just "enabled": with the runner on but
  // nothing schedulable there is no number on screen, and a ticker with nothing
  // to patch would fall through to a full repaint every second.
  const want = openPanel === 'loops' && !!rn.enabled && !paused && rn.present !== false
    && nextDueMs() != null;
  if (want && !runnerTicker) runnerTicker = setInterval(tickRunnerCountdown, 1000);
  else if (!want && runnerTicker) { clearInterval(runnerTicker); runnerTicker = null; }
}
// Patches the one number rather than re-rendering the block: a wholesale
// innerHTML rewrite every second would steal focus from the on/off switch and
// make it unusable from the keyboard.
function tickRunnerCountdown() {
  const el = $('runnerState'); if (!el) return;
  const span = el.querySelector('.runner-count');
  const ms = nextDueMs();
  // The sentence itself changed under us (the last schedulable loop was deleted,
  // or the block was repainted into a different state): repaint once, then let
  // syncRunnerTicker decide whether there is still anything to count.
  if (!span || ms == null) { renderRunnerState(); syncRunnerTicker(); return; }
  span.textContent = fmtMMSS(ms / 1000);
}

// `present` and nextDueMs only ride the snapshot and the 'runner' action, so the
// copy in hand can be many minutes old by the time someone opens this panel. One
// fetch on open, never a poll: the two blockers reported above are exactly the
// facts that must not be stale at the moment you look at them.
function refreshRunner() {
  fetch('/api/state').then((r) => r.json()).then((s) => {
    if (!s) return;
    if (s.loopRunner !== undefined) setLoopRunner(s.loopRunner);
    renderLoops(s.loops);
  }).catch(() => {});
}

// The server 403s any `by` it recognises as an agent: turning recurrence on or
// off is the human's call, exactly like the usage profile. Not pause-gated.
$('runnerState').addEventListener('click', async (e) => {
  const b = e.target && e.target.closest && e.target.closest('[data-runner]');
  if (!b) return;
  const want = b.dataset.runner === 'on';
  b.disabled = true;
  const r = await post('/api/loops/runner', { enabled: want, by: authorName() }).catch(() => null);
  if (!r || r.ok === false) {
    toast((r && r.error) || 'Could not change the loop runner', true);
    b.disabled = false;
    return;
  }
  // Apply the POST's own view instead of waiting for the SSE echo, so the switch
  // is still correct if the stream is mid-reconnect.
  if (r.loopRunner) setLoopRunner(r.loopRunner);
  renderLoops();
  toast(want ? 'Loop runner on' : 'Loop runner off, nothing is on a schedule');
});

function loopHtml(l) {
  // Text on the toggle, not colour alone: .loop-toggle.on recolours, and a
  // recolour is exactly what a colourblind reader cannot see.
  // A cadence the scheduler cannot parse must SAY so on the row: "every each
  // edit" next to a 🔁 implies a timer that does not exist.
  const sched = parseCadence(l.cadence);
  const every = l.cadence
    ? (sched ? `every ${esc(l.cadence)}` : `${esc(l.cadence)} (manual only, no timer)`)
    : 'no cadence set (manual only, no timer)';
  const last = l.lastRun
    ? `last run ${esc(fmtWhen(l.lastRun))}${l.lastBy ? ' by ' + esc(l.lastBy) : ''}`
    : 'never run';
  const runs = (l.runs != null) ? ` · ${l.runs} run${l.runs === 1 ? '' : 's'}` : '';
  const tip = l.lastResult
    ? `last result: ${l.lastResult}`
    : (l.author ? `added by ${l.author}${l.createdTs ? ' (' + fmtWhen(l.createdTs) + ')' : ''}` : '');
  return `<div class="loop" data-id="${esc(l.id)}"${tip ? ` title="${esc(tip)}"` : ''}>`
    + `<button class="loop-toggle${l.enabled ? ' on' : ''}" data-toggle="${esc(l.id)}" aria-label="${l.enabled ? 'Disable' : 'Enable'} this loop" title="${l.enabled ? 'disable this loop' : 'enable this loop'}">${l.enabled ? 'on' : 'off'}</button>`
    + `<div class="loop-text">${esc(l.text)}<div class="loop-who">${l.enabled ? 'enabled' : 'disabled'} · ${every} · ${last}${runs}</div></div>`
    + `<button class="mini-x" data-loopdel="${esc(l.id)}" aria-label="Delete this loop" title="delete">×</button>`
    + `</div>`;
}

// ---------------------------------------------------------- house-rule lint
const LINT_LABEL = {
  'dash': 'em/en dash', 'min-size': 'under 20pt', 'header-align': 'header alignment',
  'speaker-notes': 'speaker notes', 'font-family': 'font family'
};

function renderLint(data) {
  if (!data) return;
  const n = data.ok ? 0 : (data.count || 0);
  // A clean deck still gets a visible mark: an empty badge is indistinguishable
  // from a lint check that never ran.
  chromeCount('lintCount', n ? String(n) : '✓', n ? 'warn' : 'ok');
  panelCount('lintCountPanel', n ? `${n} violation${n === 1 ? '' : 's'}` : 'clean');
  $('lintlist').innerHTML = n
    ? (data.issues || []).map(lintIssueHtml).join('')
    : `<div class="panel-empty">No house-rule violations found${data.rev != null ? ` (checked at rev ${esc(data.rev)})` : ''}.</div>`;
}

function lintIssueHtml(i) {
  const where = i.elementId ? `${esc(i.slideId)} · ${esc(i.elementId)}` : esc(i.slideId);
  // .note-who is borrowed for the detail line rather than inventing a class the
  // stylesheet does not have: it is the dim sub-line style these need, and an
  // unstyled div here would render the offending text at full weight.
  return `<div class="lint-issue" data-slide="${esc(i.slideId)}">`
    + `<div><b>${esc(LINT_LABEL[i.type] || i.type)}</b> ${where}`
    + `<div class="note-who">${esc(i.detail)}${i.text ? `: ${esc(i.text)}` : ''}</div></div>`
    + `</div>`;
}

function fetchLint() {
  return fetchJson('/api/lint').then(renderLint).catch(() => {});
}

// ------------------------------------------------------------------ timing
// The 12-minute cap is a pinned house rule, so this is a glance-at-a-number
// signal in the chrome, not a panel. studio.css has no timing-* colours, so the
// over-cap state is carried by the TEXT as well: a class nothing styles would
// have made a blown budget look identical to a fine one.
function renderTiming(data) {
  if (!data) return;
  const el = $('timingLabel'); if (!el) return;
  const flag = data.overCap ? ' over cap' : (data.overTarget ? ' over target' : '');
  el.textContent = '~' + fmtMMSS(data.totalSeconds) + flag;
  el.className = data.overCap ? 'timing-over' : (data.overTarget ? 'timing-warn' : 'timing-ok');
  el.title = `Estimated speaking time from visible slide text at ${data.wpm || 135} words per minute (${data.totalWords || 0} words), not a real rehearsal.`
    + ` Target ${fmtMMSS(data.targetSeconds)}, hard cap ${fmtMMSS(data.capSeconds)}.`;
}
function fetchTiming() {
  return fetchJson('/api/timing').then(renderTiming).catch(() => {});
}

// -------------------------------------------------------------- activity feed
function feedItem(ev) {
  const t = new Date(ev.ts || Date.now()).toLocaleTimeString();
  let cls = 'feed-item', ic = '✎', who = '', what = '', tintName = null;
  if (ev.type === 'edit') { who = ev.editor; what = ev.detail || ev.opType; tintName = ev.editor; }
  else if (ev.type === 'undo' || ev.type === 'redo') { ic = ev.type === 'undo' ? '↶' : '↷'; who = ev.editor; what = ev.detail || ev.type; tintName = ev.editor; }
  else if (ev.type === 'pause') { cls += ' pause'; ic = '⏸'; who = 'PAUSED'; what = 'by ' + (ev.by || 'someone'); }
  else if (ev.type === 'resume') { cls += ' resume'; ic = '▶'; who = 'RESUMED'; what = 'by ' + (ev.by || 'someone'); }
  else if (ev.type === 'render') { ic = ev.ok ? '⤓' : '⚠'; who = ev.ok ? 'pptx' : 'render'; what = ev.ok ? 'updated' : (ev.error || 'failed'); }
  else if (ev.type === 'pdf') { ic = ev.ok ? '⤓' : '⚠'; who = 'pdf'; what = ev.ok ? 'exported' : (ev.error || 'export failed'); }
  else if (ev.type === 'tasks') {
    const tk = ev.task || {};
    ic = ev.action === 'done' ? '✓' : ev.action === 'claim' ? '◐' : ev.action === 'delete' ? '×' : '＋';
    who = 'task'; what = (ev.action || 'update') + (tk.text ? ': ' + tk.text : '');
  }
  else if (ev.type === 'loops') {
    const lp = ev.loop || {};
    // 'run' is the RUNNER firing a loop (server-initiated, spends tokens);
    // 'ran' is a session reporting one it did by hand. Different glyphs on
    // purpose: only one of them is something the machine chose to do.
    ic = ev.action === 'delete' ? '×' : ev.action === 'ran' ? '✓' : ev.action === 'run' ? '▶'
      : ev.action === 'runner' ? '◍' : ev.action === 'toggle' ? (lp.enabled ? '🔁' : '⏸') : '＋';
    who = 'loop';
    what = ev.action === 'runner'
      ? `runner ${ev.loopRunner && ev.loopRunner.enabled ? 'on' : 'off'}`
      : (ev.action || 'update') + (lp.text ? ': ' + lp.text : '');
  }
  // The profile is a spend control this page owns, and it was the one logged
  // kind with no branch here, so 9 of the 80 seeded entries were silently
  // dropped on every reload.
  else if (ev.type === 'usage-profile') { ic = '◍'; who = ev.by || 'someone'; what = `usage profile ${ev.from || '?'} → ${ev.to || '?'}`; }
  else if (ev.type === 'reaped' || ev.type === 'agents-reaped') {
    ic = '✧'; who = 'agents';
    const names = Array.isArray(ev.agents) ? ev.agents.join(', ') : (ev.agents || '');
    what = `stopped${names ? ' (' + names + ')' : ''}${ev.why ? ': ' + ev.why : ''}`;
  }
  else if (ev.type === 'agent-spawn') { ic = '✦'; who = ev.name; what = `${ev.role === 'lead' ? 'lead' : 'worker'} joined`; tintName = ev.name; }
  else if (ev.type === 'agent-exit') { ic = '✧'; who = ev.name; what = `${ev.role === 'lead' ? 'lead' : 'worker'} left`; tintName = ev.name; }
  else return;
  // Tint only names that are really editors/agents. colorFor() hashes any
  // unknown string to a colour, so tinting a pseudo-author like PAUSED or task
  // would invent an agent identity for something that has none.
  const col = tintName ? colorFor(tintName) : null;
  const whoStyle = col ? ` style="color:${esc(col.ink)}"` : (ev.ink ? ` style="color:${esc(ev.ink)}"` : '');
  const div = document.createElement('div');
  div.className = cls;
  div.innerHTML = `<span class="ic">${ic}</span><span><span class="who"${whoStyle}>${esc(who)}</span> <span class="what">${esc(what)}</span></span><span class="t">${esc(t)}</span>`;
  const list = $('feed'); if (!list) return;
  const empty = list.querySelector('.panel-empty');
  if (empty) empty.remove();
  list.prepend(div);
  while (list.children.length > 120) list.removeChild(list.lastChild);
}

// Seeds from /api/state's `log`, oldest first, so prepend() leaves the newest
// on top. The log's field is `kind`, not `type`; Object.assign keeps the rest.
function seedFeed(log) {
  const list = $('feed'); if (!list) return;
  list.innerHTML = (log || []).length ? '' : `<div class="panel-empty">No activity yet.</div>`;
  (log || []).slice(-40).forEach((e) => feedItem(Object.assign({ type: e.kind, editor: e.editor, detail: e.detail, by: e.by }, e)));
}

// ------------------------------------------------------------- composers
// studio's post() resolves with the parsed body on 4xx instead of throwing (it
// is the plain helper at the top of this file, not the dashboard's throwing
// one), so every write below checks r.ok explicitly. A silent 404/423 that
// still cleared the textarea is the failure mode this avoids.
if ($('asName')) $('asName').value = localStorage.getItem('suite_author') || 'josh';

// Buttons alone do not cover Ctrl+Enter, which calls these functions directly.
// Keep a per-composer latch as the source of truth so a slow local server
// cannot turn one human intent into duplicate durable board/task/loop rows.
let notePosting = false, taskPosting = false, loopPosting = false;

async function submitNote() {
  if (notePosting) return;
  const text = $('noteText').value.trim();
  if (!text) return;
  const author = ($('asName').value.trim() || 'josh');
  localStorage.setItem('suite_author', author);
  const pinned = $('pinCheck').checked;
  const send = $('sendNote');
  notePosting = true; send.disabled = true;
  try {
    const r = await post('/api/board', { text, author, pinned }).catch(() => null);
    if (!r || r.ok === false) { toast((r && r.error) || 'Post failed', true); return; }
    $('noteText').value = ''; $('pinCheck').checked = false;
    toast(pinned ? 'Pinned a house rule' : 'Message posted');
  } finally {
    notePosting = false; send.disabled = false;
  }
}
$('composer').addEventListener('submit', (e) => { e.preventDefault(); submitNote(); });
$('noteText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitNote(); }
});

async function submitTask() {
  if (taskPosting) return;
  const text = $('taskText').value.trim();
  if (!text) return;
  const by = ($('asName').value.trim() || 'josh');
  const assignee = $('taskFor').value.trim();
  const send = $('sendTask');
  taskPosting = true; send.disabled = true;
  try {
    const r = await post('/api/tasks', {
      text, by, assignee, wakeWorker: !!assignee,
    }).catch(() => null);
    if (!r || r.ok === false) { toast((r && r.error) || 'Could not add the task', true); return; }
    $('taskText').value = ''; $('taskFor').value = '';
    const routed = r.task && r.task.assignee || assignee;
    toast(assignee
      ? (r.dispatch && r.dispatch.ok === false
          ? `Task saved for ${routed}; wake queued: ${r.dispatch.reason || 'retry pending'}`
          : `Task sent to ${routed}`)
      : 'Passive task added to the queue');
  } finally {
    taskPosting = false; send.disabled = false;
  }
}
$('taskComposer').addEventListener('submit', (e) => { e.preventDefault(); submitTask(); });
$('taskText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitTask(); }
});

async function submitLoop() {
  if (loopPosting) return;
  const text = $('loopText').value.trim();
  if (!text) return;
  const author = ($('asName').value.trim() || 'josh');
  const cadence = $('loopEvery').value.trim();
  const send = $('sendLoop');
  loopPosting = true; send.disabled = true;
  try {
    const r = await post('/api/loops', { text, author, cadence }).catch(() => null);
    if (!r || r.ok === false) { toast((r && r.error) || 'Could not add the loop', true); return; }
    $('loopText').value = ''; $('loopEvery').value = '';
    // Never a bare "Loop started": four separate things have to be true before a
    // stored loop actually fires, and the runner block above the list spells them
    // out. This says which of them is missing, or nothing if none is.
    const runnerOn = !!(loopRunner && loopRunner.enabled);
    toast(!parseCadence(cadence) ? 'Loop saved, manual only: that cadence is not a timer the runner can read'
      : !runnerOn ? 'Loop saved, but the loop runner is off so nothing is on a schedule'
      : paused ? 'Loop added, but the deck is paused and pause stops loops too'
      : (loopRunner && loopRunner.present === false) ? 'Loop added, but nobody is registered as watching so it will not fire'
      : 'Loop added');
  } finally {
    loopPosting = false; send.disabled = false;
  }
}
$('loopComposer').addEventListener('submit', (e) => { e.preventDefault(); submitLoop(); });
$('loopText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitLoop(); }
});

// Delegated onto the live lists: every one of these is re-rendered wholesale on
// its SSE event, so a listener bound to a row button would be torn out from
// under itself on the next update.
async function panelPost(path, body, failMsg) {
  const r = await post(path, body).catch(() => null);
  if (!r || r.ok === false) toast((r && r.error) || failMsg, true);
}
$('rules').addEventListener('click', (e) => {
  const id = e.target && e.target.getAttribute && e.target.getAttribute('data-unpin');
  if (id) panelPost('/api/board/pin', { id, pinned: false }, 'Could not unpin that rule');
});
$('notes').addEventListener('click', (e) => {
  const id = e.target && e.target.getAttribute && e.target.getAttribute('data-del');
  if (id) panelPost('/api/board/delete', { id }, 'Could not delete that message');
});
$('tasklist').addEventListener('click', (e) => {
  const el = e.target; if (!el || !el.getAttribute) return;
  const doneId = el.getAttribute('data-done');
  const delId = el.getAttribute('data-taskdel');
  if (doneId) panelPost('/api/tasks/done', { id: doneId, by: 'studio' }, 'Could not close that task');
  else if (delId) panelPost('/api/tasks/delete', { id: delId }, 'Could not delete that task');
});
$('looplist').addEventListener('click', (e) => {
  const el = e.target; if (!el || !el.getAttribute) return;
  const toggleId = el.getAttribute('data-toggle');
  const delId = el.getAttribute('data-loopdel');
  const loop = toggleId && loopItems.find((item) => item.id === toggleId);
  if (loop) panelPost('/api/loops/toggle', { id: toggleId, enabled: !loop.enabled }, 'Could not toggle that loop');
  else if (delId) panelPost('/api/loops/delete', { id: delId }, 'Could not delete that loop');
});

// ------------------------------------------------------------- chat pill
// The log only takes space once you are in the conversation, so a resting page
// is deck plus one bar. Collapsing on blur keeps it that way.
const chatEl = $('chat'), chatInput = $('chatinput');
function openChat(on) { chatEl.classList.toggle('open', on); publishChromeSizes(); }
if (chatInput) {
  chatInput.addEventListener('focus', () => openChat(true));
  chatInput.addEventListener('blur', () => { if (!chatInput.value.trim()) setTimeout(() => openChat(false), 160); });
  // auto-grow, capped by the CSS max-height
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
    publishChromeSizes();
  });
  // Enter sends, Shift+Enter is a newline. Deliberately not the dashboard's
  // Ctrl+Enter: here the chat bar is the primary control, so it gets the fast path.
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
}
// Pinning is deliberate, never inferred: a pinned rule silently constrains every
// future edit, so it takes a click here or an explicit "pin this" to the lead.
let pinArmed = false;
// One writer for the flag and its two visible states, so sendChat() can disarm
// after a send without the button drifting out of sync with the variable.
function setPinArmed(on) {
  pinArmed = !!on;
  const b = $('pinChatBtn'); if (!b) return;
  b.setAttribute('aria-pressed', String(pinArmed));
  b.title = pinArmed ? 'The next message will be pinned as a house rule' : 'Pin the next message as a house rule';
}
if ($('pinChatBtn')) {
  $('pinChatBtn').addEventListener('click', () => setPinArmed(!pinArmed));
}

// --------------------------------------------------------------- keyboard
// One handler, one ordered Escape stack. Three separate listeners used to
// fight over Escape, and it unconditionally dropped out of single mode.
document.addEventListener('keydown', (e) => {
  // Escape is not a text-editing command in the chat pill: it releases focus
  // and lets an empty pill collapse. Keep every other key (including native
  // undo/redo) owned by the textarea, and leave panel composer fields alone.
  if (e.key === 'Escape' && chatInput && document.activeElement === chatInput) {
    chatInput.blur();
    e.preventDefault();
    return;
  }
  // Native editing shortcuts belong to the field that has focus.  In
  // particular, Ctrl/Cmd+Z in a draft must not undo a durable deck edit.
  if (typing(e)) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    return;
  }
  if (e.key === 'Escape') {
    if (compactMenu && !compactMenu.hidden) { setCompactMenu(false, true); e.preventDefault(); return; }
    if (openPanel) { setPanel(null); return; }
    if (document.body.classList.contains('peek')) { document.body.classList.remove('peek'); return; }
    if (document.body.classList.contains('present')) { document.body.classList.remove('present'); return; }
    if (mode === 'single') setMode('grid');
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'b') { setPanel('board'); e.preventDefault(); }
  else if (k === 'l') { setPanel('loops'); e.preventDefault(); }
  else if (k === 't') { setPanel('tasks'); e.preventDefault(); }
  else if (k === 'p') { setPanel('protections'); e.preventDefault(); }
  else if (k === 'k') { setPanel('lint'); e.preventDefault(); }
  else if (k === 'a') { setPanel('activity'); e.preventDefault(); }
  else if (k === 'g') { setMode('grid'); }
  else if (k === 's') { setMode('single'); }
  else if (e.key === '`') { document.body.classList.toggle('peek'); e.preventDefault(); }
  else if (k === 'f') {
    // requestFullscreen must be called from the gesture itself
    document.body.classList.toggle('present');
    if (document.body.classList.contains('present') && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    e.preventDefault();
  }
});

// ---------------------------------------------------- undo / redo (human only)
// The server refuses undo/redo for agents (403) because the undo stack is not
// scoped per editor, so an agent undo would blindly rewind the human's work.
// That makes these buttons the ONLY ergonomic path, and there is no chat
// phrasing that can substitute for them.
let undoCount = 0, redoCount = 0, historyPosting = false;
function paintUndo() {
  ['undoBtn', 'compactUndoBtn'].map($).filter(Boolean).forEach((u) => {
    u.disabled = historyPosting || !undoCount;
    u.title = undoCount ? `Undo the last edit (Ctrl+Z), ${undoCount} available` : 'Nothing to undo';
  });
  ['redoBtn', 'compactRedoBtn'].map($).filter(Boolean).forEach((r) => {
    r.disabled = historyPosting || !redoCount;
    r.title = redoCount ? `Redo (Ctrl+Shift+Z), ${redoCount} available` : 'Nothing to redo';
  });
}
// Both RETURN their result (never just toast it) so /undo and /redo can write a
// receipt into the chat log. The buttons ignore the return value, so their
// behaviour is unchanged.
async function doUndo() {
  if (historyPosting) return { ok: false, error: 'A history action is already in progress.' };
  if (!undoCount) return { ok: false, error: 'Nothing to undo.' };
  historyPosting = true; paintUndo();
  try {
    const r = await post('/api/undo', { editor: 'studio' }).catch(() => null);
    if (!r || r.ok === false) toast((r && r.error) || 'Undo failed', true);
    return r || { ok: false, error: 'Undo failed (connection error)' };
  } finally {
    historyPosting = false; paintUndo();
  }
}
async function doRedo() {
  if (historyPosting) return { ok: false, error: 'A history action is already in progress.' };
  if (!redoCount) return { ok: false, error: 'Nothing to redo.' };
  historyPosting = true; paintUndo();
  try {
    const r = await post('/api/redo', { editor: 'studio' }).catch(() => null);
    if (!r || r.ok === false) toast((r && r.error) || 'Redo failed', true);
    return r || { ok: false, error: 'Redo failed (connection error)' };
  } finally {
    historyPosting = false; paintUndo();
  }
}
['undoBtn', 'compactUndoBtn'].map($).filter(Boolean).forEach((b) => b.addEventListener('click', doUndo));
['redoBtn', 'compactRedoBtn'].map($).filter(Boolean).forEach((b) => b.addEventListener('click', doRedo));

// ---------------------------------------------------------- PowerPoint export
// One shared guard covers the desktop and compact controls. A second click
// while the first request is polling/rendering reuses that work instead of
// starting another download.
let pptxDownloadInFlight = null;
function downloadPptx(event) {
  if (event) event.preventDefault();
  if (pptxDownloadInFlight) return pptxDownloadInFlight;
  const controls = ['downloadBtn', 'compactDownloadBtn'].map($).filter(Boolean);
  const original = controls.map((control) => ({
    control, text: control.textContent, disabled: !!control.disabled,
  }));
  controls.forEach((control) => {
    control.disabled = true;
    control.textContent = 'Preparing...';
    control.setAttribute('aria-busy', 'true');
  });
  pptxDownloadInFlight = (async () => {
    try {
      const blob = await requestPptxBlob();
      saveDownloadBlob(blob, 'presentation.pptx');
      toast('PowerPoint downloaded');
    } catch (error) {
      toast((error && error.message) || 'PowerPoint download failed', true);
    } finally {
      original.forEach(({ control, text, disabled }) => {
        control.textContent = text;
        control.disabled = disabled;
        control.removeAttribute('aria-busy');
      });
      pptxDownloadInFlight = null;
    }
  })();
  return pptxDownloadInFlight;
}
['downloadBtn', 'compactDownloadBtn'].map($).filter(Boolean)
  .forEach((control) => control.addEventListener('click', downloadPptx));

// --------------------------------------------------------------- PDF export
// Export THEN download. The old bare <a href="/api/pdf" download> handed you a
// JSON error file named presentation.pdf whenever nothing had been exported yet.
let pdfRev = null;
function paintPdf() {
  const buttons = ['exportPdfBtn', 'compactExportPdfBtn'].map($).filter(Boolean);
  if (!buttons.length) return;
  if (pdfRev == null) {
    buttons.forEach((b) => { b.classList.remove('stale'); b.title = 'Export the current deck to PDF, then download'; });
    return;
  }
  const behind = (model.rev || 0) - pdfRev;
  buttons.forEach((b) => {
    b.classList.toggle('stale', behind > 0);
    b.title = behind > 0
      ? `PDF is ${behind} edit${behind === 1 ? '' : 's'} behind the live deck (exported at rev ${pdfRev}), click to re-export`
      : `PDF matches the current deck (rev ${pdfRev})`;
  });
}
let pdfExportInFlight = null;
function exportPdf(event) {
  if (event) event.preventDefault();
  if (pdfExportInFlight) return pdfExportInFlight;
  const buttons = ['exportPdfBtn', 'compactExportPdfBtn'].map($).filter(Boolean);
  const original = buttons.map((b) => ({ b, text: b.textContent, disabled: !!b.disabled }));
  buttons.forEach((b) => {
    b.textContent = 'Exporting...'; b.disabled = true; b.setAttribute('aria-busy', 'true');
  });
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
      original.forEach(({ b, text, disabled }) => {
        b.textContent = text; b.disabled = disabled; b.removeAttribute('aria-busy');
      });
      pdfExportInFlight = null;
      paintPdf();
    }
  })();
  return pdfExportInFlight;
}
['exportPdfBtn', 'compactExportPdfBtn'].map($).filter(Boolean).forEach((b) => b.addEventListener('click', exportPdf));

// ------------------------------------------------ compact session controls
// This is deliberately non-modal: the deck and chat remain useful while the
// secondary settings/history/export layer is open, including during a pause.
const compactMenu = $('compactMenu'), compactMenuBtn = $('compactMenuBtn');
function compactViewport() { return window.matchMedia && window.matchMedia('(max-width: 900px)').matches; }
function setCompactMenu(open, returnFocus) {
  if (!compactMenu || !compactMenuBtn) return;
  const show = !!open && compactViewport();
  compactMenu.hidden = !show;
  compactMenuBtn.setAttribute('aria-expanded', String(show));
  if (!show && returnFocus) compactMenuBtn.focus();
}
if (compactMenuBtn) compactMenuBtn.addEventListener('click', () => setCompactMenu(compactMenu.hidden));
if ($('compactMenuClose')) $('compactMenuClose').addEventListener('click', () => setCompactMenu(false, true));
document.addEventListener('click', (e) => {
  const control = $('compactControls');
  if (compactMenu && !compactMenu.hidden && control && !control.contains(e.target)) setCompactMenu(false);
});
if (window.matchMedia) {
  const compactQuery = window.matchMedia('(max-width: 900px)');
  const closeForDesktop = () => { if (!compactQuery.matches) setCompactMenu(false); };
  if (compactQuery.addEventListener) compactQuery.addEventListener('change', closeForDesktop);
  else if (compactQuery.addListener) compactQuery.addListener(closeForDesktop);
}

// ------------------------------------------------------------ passive HUD
function paintSlidePos() {
  const el = $('slidePos'); if (!el) return;
  const n = model.slides.length;
  if (!n) { el.textContent = ''; return; }
  el.textContent = mode === 'single' ? `${currentPos() + 1} / ${n}` : `${n} slides`;
}
// Newest few events, fading out. ~95% of the feed's value is "something just
// happened", which is a glance; the scrollable history lives in its panel.
function tick(text) {
  const t = $('ticker'); if (!t || !text) return;
  const d = document.createElement('div');
  d.className = 'tick'; d.textContent = text;
  t.appendChild(d);
  while (t.children.length > 3) t.removeChild(t.firstChild);
  setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 8200);
}

// bootstrap: pull full state once, then stream
fetch('/api/state').then((r) => r.json()).then((s) => {
  model = s.model; thumbsVer = s.thumbs || 0;
  boardNotes = s.board || []; editorsList = s.editors || [];
  lockItems = s.locks || []; agentsList = s.agents || [];
  protectionItems = normalizeProtections(s.protections || []);
  protectionExceptionItems = normalizeProtectionExceptions(s.protectionExceptions || []);
  profileInfo = s.profile || null; spendInfo = s.spend || null;
  undoCount = s.undoCount || 0; redoCount = s.redoCount || 0;
  pdfRev = s.pdfRev != null ? s.pdfRev : null;
  // Absent on a server build without the runner: renderRunnerState() then says
  // plainly that loops are stored but not executing, the truthful default.
  setLoopRunner(s.loopRunner);
  setPaused(s.paused, s.pausedBy);
  build();
  checkStale();
  renderChat(); renderChips(); paintUndo(); paintPdf(); paintSlidePos();
  renderBoard(); renderTasks(s.tasks); renderLoops(s.loops); seedFeed(s.log);
  fetchLint(); fetchTiming();
  publishChromeSizes();
}).catch(() => {}).finally(connect);

// Neither lint nor timing has an SSE event, so the 'edit' case above is their
// only push. This catches an edit that landed from a client predating that
// refresh, and any moment the stream briefly drops a message.
setInterval(fetchLint, 30000);
setInterval(fetchTiming, 30000);
