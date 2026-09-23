#!/usr/bin/env node
'use strict';
/*
 * Deterministic DOM-light checks for Studio states that are easy to miss in a
 * happy-path browser pass: unknown/stale thumbnails, model fallbacks after an
 * edit, and a genuinely empty deck.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
const studioHtml = fs.readFileSync(path.join(__dirname, 'public', 'studio.html'), 'utf8');
const studioCss = fs.readFileSync(path.join(__dirname, 'public', 'studio.css'), 'utf8');
function take(start, end, from = 0) {
  const a = source.indexOf(start, from);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`frontend state markers missing: ${start}`);
  return source.slice(a, b);
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

// ---- fallback refresh keeps the card/hotspot host while replacing only the
// model-derived fallback contents.
const fallbackSource = take('function fallbackInnerHtml(s) {', '\nfunction hotspotHtml');
const slides = [
  { id: 's1', decor: [], elements: [{ text: 'first' }] },
  { id: 's2', decor: [], elements: [{ text: 'second' }] },
];
const fallbacks = {
  s1: { innerHTML: 'old one' },
  s2: { innerHTML: 'old two' },
};
const cards = {
  s1: { querySelector: (selector) => selector === '.fallback' ? fallbacks.s1 : null },
  s2: { querySelector: (selector) => selector === '.fallback' ? fallbacks.s2 : null },
};
const fallbackClient = new Function('model', 'document', 'cssEsc', 'fbDecorHtml', 'fbElHtml', `
  ${fallbackSource}
  return { refreshFallback, fallbackInnerHtml };
`)(
  { slides },
  {
    querySelector: (selector) => {
      const match = /data-slide="([^"]+)"/.exec(selector);
      return match ? cards[match[1]] : null;
    },
  },
  String,
  (d) => `[decor:${d.id}]`,
  (e) => `[text:${e.text}]`
);
const firstCard = cards.s1;
fallbackClient.refreshFallback({ slideId: 's1' });
check('an affected edit refreshes only that slide fallback',
  fallbacks.s1.innerHTML === '[text:first]' && fallbacks.s2.innerHTML === 'old two');
check('fallback refresh preserves the card host used by glows', cards.s1 === firstCard);
slides[0].elements[0].text = 'undo first';
slides[1].elements[0].text = 'undo second';
fallbackClient.refreshFallback({});
check('an undo/redo without a slide id refreshes every fallback',
  fallbacks.s1.innerHTML === '[text:undo first]' && fallbacks.s2.innerHTML === '[text:undo second]');

const fbElementSource = take('function fbElHtml(e) {', '\nfunction fallbackInnerHtml');
const fbElementHtml = new Function('slideHpt', 'esc', `
  ${fbElementSource}
  return fbElHtml;
`)(540, String);
const explicitlyPlacedText = fbElementHtml({
  type: 'body', text: 'Placed native text',
  box: { x: 0.2, y: 0.3, w: 0.4, h: 0.15 },
});
check('Studio fallback places native text from its explicit normalized box',
  /left:20%;top:30%;width:40%;height:15%/.test(explicitlyPlacedText));

// ---- the freshness dot must not claim equality until a successful thumbs
// event identifies the exact revision being displayed.
const staleSource = take('let lastGoodThumbsRev = null;', '\n// -------------------------------------------------------------------- mode');
const staleDot = { className: '', title: '' };
const staleClient = new Function('$', 'model', `
  ${staleSource}
  return {
    checkStale,
    good: (rev) => { lastGoodThumbsRev = rev; },
    rev: (rev) => { model.rev = rev; },
  };
`)((id) => id === 'staleDot' ? staleDot : null, { rev: 10 });
staleClient.checkStale();
check('unknown thumbnail revision is visibly amber', staleDot.className === 'stale-dot amber');
staleClient.good(9);
staleClient.checkStale();
check('a one-revision thumbnail gap is visibly amber', staleDot.className === 'stale-dot amber');
staleClient.good(10);
staleClient.checkStale();
check('only exact revision equality paints the freshness dot green',
  staleDot.className === 'stale-dot' && /match/.test(staleDot.title));

// ---- the empty-state element starts with [hidden] in studio.html; applyMode
// owns clearing it when there are no cards.
const modeSource = take("let mode = 'grid';", "\n$('gridModeBtn').addEventListener");
function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle: (name, force) => {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains: (name) => values.has(name),
  };
}

// ---- rehearsal clock is client-only, follows stable ids in current live
// order, and paints only the current card after its cumulative target.
const paceSource = take(
  'const REHEARSAL_PACE_SECONDS = Object.freeze({',
  '\n// -------------------------------------------------------------------- mode'
);
const paceModel = {
  slides: [
    's1', 's15', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10',
    's12', 's13', 's11', 's14', 's16', 'sef432705',
  ].map((id) => ({ id })),
};
const paceCards = new Map(paceModel.slides.map((slide) => [slide.id, {
  dataset: { slide: slide.id },
  classList: classList(),
}]));
let paceReadout = null;
let paceInterval = null;
const paceStage = {
  classList: classList(),
  appendChild(node) { paceReadout = node; node.parentNode = this; },
};
const paceDocument = {
  createElement: () => {
    const attrs = new Map();
    return {
      id: '', className: '', hidden: false, textContent: '', title: '',
      classList: classList(),
      setAttribute: (name, value) => attrs.set(name, String(value)),
      removeAttribute: (name) => attrs.delete(name),
      getAttribute: (name) => attrs.get(name) || null,
    };
  },
  querySelectorAll: (selector) => selector === '.card.pace-behind'
    ? Array.from(paceCards.values()).filter((card) => card.classList.contains('pace-behind'))
    : selector === '.card' ? Array.from(paceCards.values()) : [],
  querySelector: (selector) => {
    const match = /data-slide="([^"]+)"/.exec(selector);
    return match ? paceCards.get(match[1]) || null : null;
  },
};
const paceWindow = {
  setInterval(fn) { paceInterval = fn; return 1; },
  clearInterval() { paceInterval = null; },
};
const paceClient = new Function('$', 'document', 'window', 'model', 'cssEsc', `
  let mode = 'grid';
  let currentId = null;
  ${paceSource}
  const select = (id) => {
    currentId = id;
    document.querySelectorAll('.card').forEach((card) => {
      card.classList.toggle('current', card.dataset.slide === id);
    });
  };
  return {
    plan: (sourceModel) => rehearsalPacePlan(sourceModel),
    start: (now) => { mode = 'single'; select('s1'); startRehearsalPace(true, now); },
    reset: (now) => { select('s1'); startRehearsalPace(true, now); },
    advance: (id, now) => { select(id); paintRehearsalPace(now); },
    grid: () => { mode = 'grid'; stopRehearsalPace(true); },
    state: () => ({
      startedAt: rehearsalPaceStartedAtMs,
      timer: rehearsalPaceTimer,
      readout: $('rehearsalPaceReadout'),
    }),
  };
`)(
  (id) => id === 'stage' ? paceStage : id === 'rehearsalPaceReadout' ? paceReadout : null,
  paceDocument,
  paceWindow,
  paceModel,
  String
);
const pacePlan = paceClient.plan();
const expectedPaceSeconds = new Map([
  ['s1', 30], ['s15', 45], ['s2', 45], ['s3', 55], ['s4', 45], ['s5', 45],
  ['s6', 40], ['s7', 45], ['s8', 55], ['s9', 50], ['s10', 45], ['s12', 55],
  ['s13', 45], ['s11', 45], ['s14', 35], ['s16', 5],
]);
check('every stable slide allowance matches the source-verified run-of-show row',
  expectedPaceSeconds.size === pacePlan.slides.size
    && Array.from(expectedPaceSeconds).every(([id, seconds]) =>
      pacePlan.slides.get(id) && pacePlan.slides.get(id).seconds === seconds));
const reorderedPaceModel = {
  slides: ['s15', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9',
    's10', 's12', 's13', 's11', 's14', 's16', 'sef432705'].map((id) => ({ id })),
};
const reorderedPacePlan = paceClient.plan(reorderedPaceModel);
check('stable slide ids rebuild cumulative checkpoints in the current reordered model order',
  reorderedPacePlan.totalSeconds === 685 && reorderedPacePlan.bufferSeconds === 35
    && reorderedPacePlan.slides.get('s15').start === 0
    && reorderedPacePlan.slides.get('s15').end === 45
    && reorderedPacePlan.slides.get('s1').start === 45
    && reorderedPacePlan.slides.get('s1').end === 75
    && reorderedPacePlan.slides.get('s2').start === 75
    && reorderedPacePlan.slides.get('s2').end === 120
    && !reorderedPacePlan.slides.has('sef432705'));
check('rehearsal plan follows the exact 11:25 run of show with 0:35 before the 12:00 cap',
  pacePlan.totalSeconds === 685 && pacePlan.hardCapSeconds === 720
    && pacePlan.bufferSeconds === 35 && pacePlan.slides.get('s1').end === 30
    && pacePlan.slides.get('s15').end === 75 && pacePlan.slides.get('s16').end === 685
    && !pacePlan.slides.has('sef432705'));
paceClient.start(1000);
const paceStarted = paceClient.state();
paceClient.advance('s15', 31000);
const paceAdvanced = paceClient.state();
check('pace clock starts on s1 and remains on pace while advancing within cumulative target',
  paceStarted.startedAt === 1000 && paceStarted.timer === 1 && paceInterval
    && paceAdvanced.startedAt === 1000
    && paceAdvanced.readout.getAttribute('data-pace-state') === 'on-pace'
    && !paceCards.get('s15').classList.contains('pace-behind'));
paceClient.advance('s15', 77000);
check('falling behind the 11:25 checkpoint marks only the current slide and consumes buffer',
  paceCards.get('s15').classList.contains('pace-behind')
    && !paceCards.get('s1').classList.contains('pace-behind')
    && paceClient.state().readout.getAttribute('data-pace-state') === 'behind'
    && paceClient.state().readout.getAttribute('data-pace-buffer') === '34'
    && /0:34 buffer.*cap 12:00/.test(paceClient.state().readout.textContent)
    && /checkpoints end at 11:25.*12:00 hard cap/.test(paceClient.state().readout.title));
paceClient.advance('s15', 112000);
check('lateness can exhaust but never make the reserved hard-cap buffer negative',
  paceClient.state().readout.getAttribute('data-pace-buffer') === '0'
    && /0:00 buffer.*cap 12:00/.test(paceClient.state().readout.textContent)
    && paceCards.get('s15').classList.contains('pace-behind'));
paceClient.reset(100000);
check('restarting the rehearsal resets elapsed state and clears the behind cue',
  paceClient.state().startedAt === 100000
    && !Array.from(paceCards.values()).some((card) => card.classList.contains('pace-behind'))
    && /^0:00 \/ pace 0:30.*0:35 buffer.*cap 12:00$/.test(paceClient.state().readout.textContent));
paceClient.advance('sef432705', 900000);
check('an active clock labels final Q&A untimed and never pulses it',
  paceClient.state().readout.getAttribute('data-pace-state') === 'qa'
    && /Q&A untimed.*talk cap 12:00/.test(paceClient.state().readout.textContent)
    && !paceCards.get('sef432705').classList.contains('pace-behind'));
paceClient.grid();
check('returning to grid fully ends and hides the rehearsal clock',
  paceClient.state().startedAt === null && paceClient.state().timer === null
    && paceClient.state().readout.hidden && !paceStage.classList.contains('pace-running'));

const stage = { classList: classList() };
const grid = { classList: classList() };
const single = { classList: classList() };
const empty = { hidden: true };
const elements = { stage, gridModeBtn: grid, singleModeBtn: single, deckEmpty: empty };
const modeModel = { slides: [] };
const modeClient = new Function(
  '$', 'document', 'window', 'model', 'paintSlidePos', 'selectedObject',
  'paintProtectionState', 'renderProtections', 'paintRehearsalPace',
  `
  ${modeSource}
  return { applyMode };
`)(
  (id) => elements[id],
  { querySelectorAll: () => [] },
  {},
  modeModel,
  () => {},
  null,
  () => {},
  () => {},
  () => {}
);
modeClient.applyMode();
check('an empty model reveals the explicit empty-deck message',
  empty.hidden === false && stage.classList.contains('deck-empty'));
modeModel.slides.push({ id: 's1' });
modeClient.applyMode();
check('adding a slide hides the empty-deck message again',
  empty.hidden === true && !stage.classList.contains('deck-empty'));

// ---- durable protection identities are normalized without touching model
// content, and optimistic state overlays (rather than replacing) confirmed SSE
// state. This is the rollback invariant used by the real DOM code.
const protectionPureSource = take(
  'function findModelObject(slideId, objectId, preferredKind) {',
  '\nfunction cleanObjectText(object) {'
);
const protectionModel = {
  slides: [{
    id: 'stable-slide',
    decor: [{ id: 'bottom-path', kind: 'shape', box: { x: .1, y: .8, w: .8, h: .01 } }],
    elements: [{ id: 'title-id', text: 'Do not rewrite me', box: { x: .1, y: .1, w: .8, h: .1 } }],
  }],
};
const protectionModelBefore = JSON.stringify(protectionModel);
const protectionClient = new Function('model', `
  let protectionItems = [];
  let protectionExceptionItems = [];
  let pendingProtection = null;
  ${protectionPureSource}
  return {
    normalizeProtection,
    normalizeProtections,
    canonicalProtectionRows,
    canonicalProtectionExceptionRows,
    sameProtectionTarget,
    setConfirmed: (rows) => { protectionItems = normalizeProtections(rows); },
    setExceptions: (rows) => { protectionExceptionItems = normalizeProtectionExceptions(rows); },
    setPending: (value) => { pendingProtection = value; },
    visibleProtections,
    visibleProtectionExceptions,
    protectionStateForTarget,
  };
`)(protectionModel);
const inferredPath = protectionClient.normalizeProtection({
  kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path',
});
check('protection normalization preserves stable slide/object ids and derives decor kind',
  inferredPath.slideId === 'stable-slide' && inferredPath.objectId === 'bottom-path'
    && inferredPath.objectKind === 'decor' && JSON.stringify(protectionModel) === protectionModelBefore);
check('successful toggle responses require a canonical, duplicate-free protection array',
  protectionClient.canonicalProtectionRows([
    { kind: 'slide', slideId: 'stable-slide', by: 'human' },
    {
      kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path',
      objectKind: 'decor', by: 'human',
    },
  ]).length === 2
    && protectionClient.canonicalProtectionRows({}) === null
    && protectionClient.canonicalProtectionRows([
      { kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path' },
    ]) === null
    && protectionClient.canonicalProtectionRows([
      { kind: 'slide', slideId: 'stable-slide', createdAt: 'not-a-server-timestamp' },
    ]) === null
    && protectionClient.canonicalProtectionRows([
      { kind: 'slide', slideId: 'stable-slide' },
      { kind: 'slide', slideId: 'stable-slide' },
    ]) === null
    && protectionClient.canonicalProtectionExceptionRows([{
      kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path',
      objectKind: 'decor', by: 'human', createdAt: 1,
    }]).length === 1
    && protectionClient.canonicalProtectionExceptionRows([{
      kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path',
      objectKind: 'decor', createdAt: 1,
    }]) === null);
protectionClient.setConfirmed([{ kind: 'slide', slideId: 'stable-slide', by: 'human' }]);
protectionClient.setPending({
  target: inferredPath,
  protected: false,
  row: { ...inferredPath, by: 'studio', createdAt: 'now' },
});
check('optimistic object unlock beneath a slide lock overlays an editable exception',
  protectionClient.visibleProtections().length === 1
    && protectionClient.visibleProtectionExceptions().length === 1
    && protectionClient.protectionStateForTarget(inferredPath).source === 'exception');
protectionClient.setConfirmed([
  { kind: 'slide', slideId: 'stable-slide', by: 'human' },
  { kind: 'object', slideId: 'stable-slide', objectId: 'title-id', objectKind: 'element', by: 'other-tab' },
]);
check('an authoritative SSE lock update survives while an editable exception is pending',
  protectionClient.visibleProtections().length === 2
    && protectionClient.visibleProtectionExceptions().length === 1);
protectionClient.setPending(null);
const afterRollback = protectionClient.visibleProtections();
check('clearing a failed exception toggle reveals latest server truth',
  afterRollback.length === 2
    && afterRollback.some((item) => item.objectId === 'title-id')
    && !afterRollback.some((item) => item.objectId === 'bottom-path')
    && protectionClient.visibleProtectionExceptions().length === 0);
protectionClient.setConfirmed([]);
protectionClient.setPending({
  target: inferredPath,
  protected: true,
  row: { ...inferredPath, by: 'studio', createdAt: 'now' },
});
check('without a parent slide lock the same optimistic toggle creates a direct object lock',
  protectionClient.visibleProtections().length === 1
    && protectionClient.protectionStateForTarget(inferredPath).source === 'object');
protectionClient.setPending(null);

const slideTarget = { kind: 'slide', slideId: 'stable-slide' };
protectionClient.setConfirmed([
  { kind: 'slide', slideId: 'stable-slide', by: 'human' },
  { kind: 'object', slideId: 'stable-slide', objectId: 'title-id', objectKind: 'element', by: 'legacy' },
]);
protectionClient.setExceptions([inferredPath]);
protectionClient.setPending({
  target: slideTarget,
  protected: false,
  row: { ...slideTarget, by: 'studio', createdAt: 'now' },
});
check('optimistic slide unlock immediately makes the whole reverse tree editable',
  protectionClient.visibleProtections().every((item) => item.slideId !== 'stable-slide') &&
  protectionClient.visibleProtectionExceptions().every((item) => item.slideId !== 'stable-slide'));
protectionClient.setConfirmed([
  { kind: 'object', slideId: 'stable-slide', objectId: 'title-id', objectKind: 'element', by: 'legacy' },
]);
protectionClient.setPending({
  target: slideTarget,
  protected: true,
  row: { ...slideTarget, by: 'studio', createdAt: 'now' },
});
check('optimistic slide lock collapses child rows and exceptions into one slide lock',
  protectionClient.visibleProtections().length === 1 &&
  protectionClient.visibleProtections()[0].kind === 'slide' &&
  protectionClient.visibleProtectionExceptions().length === 0);
protectionClient.setPending(null);

// ---- DOM-light paint: persistent slide/object marks coexist with the existing
// dashed collaborator claim, and selection/pending states are explicit.
const protectionPaintSource = take(
  'function spotForTarget(target) {',
  '\nasync function requestProtectionToggle(target, protectedState, by) {'
);
function attrNode(baseLabel) {
  const attrs = new Map();
  if (baseLabel) attrs.set('data-base-label', baseLabel);
  return {
    classList: classList(),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => attrs.get(name) || null,
    removeAttribute: (name) => attrs.delete(name),
    attrs,
  };
}
const protectionSpot = attrNode('Select bottom path');
const protectionHead = {
  children: [],
  appendChild(node) { this.children.push(node); node.parentNode = this; },
};
const protectionCard = attrNode('Open slide 1');
protectionCard.classList.add('claimed');
protectionCard.querySelectorAll = () => [];
protectionCard.querySelector = (selector) => selector === '.card-head' ? protectionHead
  : selector.startsWith('.spot[') ? protectionSpot : null;
const paintDocument = {
  querySelectorAll: (selector) => selector === '.card' ? [protectionCard]
    : selector === '.spot' ? [protectionSpot] : [],
  querySelector: (selector) => selector.startsWith('.card[') ? protectionCard : null,
  createElement: () => {
    const node = attrNode();
    node.remove = () => {};
    return node;
  },
};
const paintRows = [
  { kind: 'slide', slideId: 'stable-slide' },
  { kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path', objectKind: 'decor' },
];
const selectedPath = { kind: 'object', slideId: 'stable-slide', objectId: 'bottom-path', objectKind: 'decor' };
const paintClient = new Function(
  'document', 'cssEsc', 'visibleProtections', 'visibleProtectionExceptions',
  'sameProtectionTarget', 'slideNumber', 'selectedObject', 'pendingProtection',
  `${protectionPaintSource}; return { paintProtectionState };`
)(
  paintDocument,
  String,
  () => paintRows,
  () => [selectedPath],
  (a, b) => a && b && a.kind === b.kind && a.slideId === b.slideId &&
    (a.kind === 'slide' || (a.objectId === b.objectId && a.objectKind === b.objectKind)),
  () => 1,
  selectedPath,
  { target: selectedPath, protected: false }
);
paintClient.paintProtectionState();
check('persistent slide paint coexists with temporary collaborator claim paint',
  protectionCard.classList.contains('protected-slide')
    && protectionCard.classList.contains('claimed')
    && /persistently protected/.test(protectionCard.getAttribute('aria-label')));
check('editable exception DOM overrides a direct lock and stays selected and accessible',
  protectionSpot.classList.contains('unlocked-object')
    && !protectionSpot.classList.contains('protected-object')
    && protectionSpot.classList.contains('selected-object')
    && protectionSpot.classList.contains('protection-pending')
    && /editable while slide is locked/.test(protectionSpot.getAttribute('aria-label'))
    && /selected/.test(protectionSpot.getAttribute('aria-label')));
check('card DOM gets textual persistent and selection summaries',
  protectionHead.children.some((node) => node.attrs.get('data-protection-summary') === '1')
    && protectionHead.children.some((node) => node.attrs.get('data-object-selection') === '1'));

// Source contract checks keep the mutation path centralized and the controls
// explicit: navigating/selecting alone has no protection endpoint attached.
check('Studio exposes a simple lock strip, an audit panel, and one double-click object toggle',
  /data-panel="protections"/.test(studioHtml)
    && /id="lockQuickbar"/.test(studioHtml)
    && /id="protectionSelection"[^>]*aria-live="polite"/.test(studioHtml)
    && /k === 'p'.*setPanel\('protections'\)/.test(source)
    && /addEventListener\('dblclick'/.test(source)
    && /toggleProtection\(target, !state\.locked\)/.test(source));
check('Studio centralizes the canonical protection toggle API and stable identity fields',
  (source.match(/\/api\/protections\/toggle/g) || []).length === 1
    && /objectId: target\.objectId, objectKind: target\.objectKind/.test(source)
    && /protected: !!protectedState/.test(source)
    && /function protectionActor\(\)[\s\S]*?\$\('asName'\)/.test(source)
    && /data\.ok !== true/.test(source)
    && /canonicalProtectionRows\(data\.protections\)/.test(source));
check('persistent and temporary CSS indicators use solid and dashed channels',
  /\.card\.protected-slide \.frame::after/.test(studioCss)
    && /\.card\.claimed \{ outline: 2px dashed/.test(studioCss)
    && /\.spot\.protected-object/.test(studioCss)
    && /\.spot\.unlocked-object/.test(studioCss));
check('rehearsal cue stays click-through in the bottom band and has a steady reduced-motion form',
  /\.card\.current\.pace-behind \.frame::before/.test(studioCss)
    && /pointer-events:\s*none/.test(studioCss.slice(studioCss.indexOf('.card.current.pace-behind')))
    && /bottom:\s*1\.5%;\s*height:\s*18%/.test(studioCss)
    && /prefers-reduced-motion:\s*reduce[\s\S]*?\.card\.current\.pace-behind \.frame::before[\s\S]*?animation:\s*none/.test(studioCss));
check('presenter pace readout occupies a reserved row outside slide pixels',
  /#stage\.mode-single\.pace-running\s*\{[\s\S]*?grid-template-rows/.test(studioCss)
    && /\.rehearsal-pace-readout:not\(\[hidden\]\)/.test(studioCss)
    && /#stage\.mode-single\.pace-running \.card\.current[\s\S]*?100vh - 52px/.test(studioCss));

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
