/* The ledger view is the boundary between the live feed's answer and the
 * controls a person can press. Drive its exported entry point with the same
 * answers src/ledger-live.js supplies; the loader only replaces browser
 * furniture and I/O, not the view under test. The feed itself is driven at the
 * foot of this file against a stand-in window.mcAgent. */

import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import test from 'node:test'

register(`data:text/javascript,${encodeURIComponent(`
  const stub = (source) => ({ format: 'module', source, shortCircuit: true })
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: 'test:css', shortCircuit: true }
    const replacements = {
      '../components.js': 'components', '../ledger-live.js': 'ledger-live',
      '../data-source.js': 'data-source',
      '../sample-ledger.js': 'sample-ledger', '../write-surfaces.js': 'write-surfaces',
      '../hidden-rows.js': 'hidden-rows',
      '../arm-press.js': 'arm-press', '../first-run-needs.js': 'first-run-needs',
      '../ledger-file-box.js': 'ledger-file-box', './ledger-purchases.js': 'ledger-purchases',
    }
    if (context.parentURL?.endsWith('/src/views/ledger.js') && replacements[specifier])
      return { url: 'test:' + replacements[specifier], shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url === 'test:css') return stub('')
    if (url === 'test:components') return stub(\`export const el = () => globalThis.__ledgerRoot(); export const attachSeg = () => () => {}\`)
    if (url === 'test:ledger-live') return stub(\`export const fetchLiveLedger = (options) => { globalThis.__ledgerAsked.push(options); return Promise.resolve(globalThis.__ledgerReply) }\`)
    if (url === 'test:data-source') return stub(\`export const DATA_SOURCE_EVENT='source'; export const resolveDataSource=async()=>globalThis.__ledgerOrigin; export const sourceIsBadged=o=>o==='mock'; export const currentDataSource=()=>globalThis.__ledgerOrigin\`)
    if (url === 'test:sample-ledger') return stub(\`export const sampleLedgerData=()=>globalThis.__ledgerSample()\`)
    if (url === 'test:write-surfaces') return stub(\`export function mountLedgerWriteSurface(_r,{onMount}) { onMount({showRegister:value=>globalThis.__registerStates.push(value)}); return ()=>{} }\`)
    if (url === 'test:hidden-rows') return stub(\`export const createHiddenRows=()=>({list:()=>[],add(){},remove(){}})\`)
    if (url === 'test:arm-press') return stub(\`export const armOnce=()=>false\`)
    if (url === 'test:first-run-needs') return stub(\`export const GUIDE_ACTION={href:'#guide',label:'Guide'}\`)
    /* storedFleetTrees is stubbed as well as mountLedgerFileBox, and its
       absence is why this whole suite could not load. src/views/ledger.js
       imports BOTH from ../ledger-file-box.js (line 90, used at the
       circleNames read), the real module exports both, but this stub replaced
       the module with one that had only the mount -- so importing the view
       threw "does not provide an export named 'storedFleetTrees'" and every
       test in this file failed as one. Measured 2026-09-04 on the untouched
       base and under BOTH node binaries on this machine, v22.19.0 and
       v22.14.0, so it was not a runner artifact: the gate over the entire
       ledger view had been dead since that import was added. It answers []
       here because these tests drive the view's own behaviour, not the file
       box's reader, which has its own suite (ledger-file-box.test.mjs). */
    if (url === 'test:ledger-file-box') return stub(\`export function mountLedgerFileBox(slot, options) { globalThis.__fileBoxMounts.push({ slot, options }); return () => {} }; export function storedFleetTrees() { return [] }\`)
    /* P mounts src/views/ledger-purchases.js's renderPurchasesTab() wholesale
       (src/views/ledger.js syncPurchasesMount); this suite drives that glue --
       does ledger.js call it entering P and destroy it leaving P or on this
       view's own destroy -- not ledger-purchases.js's own behaviour (the
       approvals mount, the handshake, the checkout link), which has its own
       suite (tools/test/ledger-purchases.test.mjs). The stand-in records every
       mount and every destroy call so the lifecycle is provable without
       ledger-purchases.js's real, heavier imports. */
    if (url === 'test:ledger-purchases') return stub(\`export function renderPurchasesTab(container) {
      globalThis.__approvalsMounts.push('mounted')
      const el = globalThis.document.createElement('div')
      el.className = 'ledger-purchases-tab'
      if (typeof container.appendChild === 'function') container.appendChild(el)
      return { destroy: () => { globalThis.__approvalsMounts.push('destroyed') } }
    }\`)
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

class Node {
  constructor({ dataset = {}, tagName = 'DIV' } = {}) {
    this.dataset = dataset; this.tagName = tagName; this.textContent = ''; this.innerHTML = ''
    this.hidden = false; this.attributes = new Map(); this.listeners = new Map()
    this.classList = { toggle() {} }
    /* Custom properties, because the view mounts the owner's picked ledger
       colours on its own root (src/home-status-colors.js mountHomeStatusColors,
       via src/views/ledger.js). A stand-in node with no `style` made that mount
       throw, which is a gap in the furniture, not a fact about the view. */
    this.style = {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, String(value)) },
      getPropertyValue(name) { return this.values.get(name) ?? '' },
    }
  }
  addEventListener(type, fn) { this.listeners.set(type, fn) }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  removeAttribute(name) { this.attributes.delete(name) }
  toggleAttribute(name, force) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name) }
  closest(selector) { return selector === '.ledger-stat' ? this.parent : null }
  querySelector() { return null }
  querySelectorAll() { return [] }
}

/* A press on a button inside a group, the way the DOM delivers it: the
   group's listener runs with a target that answers closest() with the button
   for a selector naming the button's own attribute. */
function pressIn(group, button, attribute) {
  const fn = group.listeners.get('click')
  assert.ok(fn, 'nothing listens for a click on the group')
  return fn({ target: { closest: selector => (selector.includes(`[data-${attribute}]`) ? button : null) } })
}
const pressToggle = toggle => toggle.listeners.get('click')()

const SUMMARY_STATES = ['open', 'in-progress', 'gated', 'proposed', 'done', 'blocked']

function makeRoot() {
  const registerNode = new Node()
  const modeButtons = ['r', 't', 'a', 'p', 'all'].map(mode => new Node({ dataset: { mode }, tagName: 'BUTTON' }))
  const modeGroup = new Node(); modeGroup.querySelectorAll = () => modeButtons
  const scopeButtons = ['all', 'global', 'tree', 'session', 'thread'].map(scope => new Node({ dataset: { scope }, tagName: 'BUTTON' }))
  const scopeGroup = new Node(); scopeGroup.querySelectorAll = () => scopeButtons
  const visible = new Node(); const hiddenNote = new Node(); const hiddenToggle = new Node()
  const removedToggle = new Node(); const chainNote = new Node(); const fileSlot = new Node()
  const purchasesSlot = new Node(); const summarySection = new Node()
  const resetGroup = new Node(); const resetStatus = new Node()
  const summaries = Object.fromEntries(SUMMARY_STATES.map(state => {
    const value = new Node(); value.parent = new Node(); return [state, value]
  }))
  const notes = Object.values(summaries).map(value => new Node())
  const root = new Node()
  root.querySelector = selector => {
    if (selector === '.ledger-register') return registerNode
    if (selector === '.ledger-mode') return modeGroup
    if (selector === '[data-scope-filter]') return scopeGroup
    if (selector === '[data-hidden-note]') return hiddenNote
    if (selector === '[data-chain-note]') return chainNote
    if (selector === '[data-show-hidden]') return hiddenToggle
    if (selector === '[data-show-removed]') return removedToggle
    if (selector === '[data-ledger-file-slot]') return fileSlot
    if (selector === '[data-purchases-slot]') return purchasesSlot
    if (selector === '[data-ledger-resets]') return resetGroup
    if (selector === '[data-ledger-reset-status]') return resetStatus
    if (selector === '.ledger-summary') return summarySection
    if (selector === '[data-visible-count]') return visible
    const state = /^\[data-summary="([^"]+)"\]$/.exec(selector)?.[1]
    return state ? summaries[state] : null
  }
  root.querySelectorAll = selector => selector === '[data-summary-note]' ? notes : []
  root.addEventListener = () => {}; root.removeEventListener = () => {}
  return { root, registerNode, summaries, visible, scopeButtons, scopeGroup, modeButtons, modeGroup, removedToggle, chainNote, fileSlot, purchasesSlot, summarySection }
}

const windowStub = { addEventListener() {}, removeEventListener() {} }
globalThis.window = windowStub
globalThis.localStorage = { getItem: () => null, setItem() {} }
/* documentElement carries the theme the colour mount reads, and the observer
   is the one it watches that attribute with. Both are furniture the browser
   always has; neither stands in for anything the view decides. */
globalThis.document = { createElement: () => new Node(), documentElement: new Node({ dataset: { theme: 'white' } }) }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.__fileBoxMounts = []
const { ledgerView } = await import('../../src/views/ledger.js')

const settle = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }

async function render(reply, { origin = 'local', sample = null, mcAgent = undefined } = {}) {
  const fixture = makeRoot()
  globalThis.__ledgerReply = reply
  globalThis.__ledgerAsked = []
  globalThis.__ledgerOrigin = origin
  globalThis.__ledgerSample = sample || (() => ({ requests: [], questions: { ok: true, reason: null, observedAt: null, value: [] }, chain: { ok: true, drift: [] } }))
  globalThis.__registerStates = []
  globalThis.__fileBoxMounts = []
  globalThis.__approvalsMounts = []
  globalThis.__ledgerRoot = () => fixture.root
  windowStub.mcAgent = mcAgent
  const view = ledgerView()
  await settle()
  return { ...fixture, view, states: globalThis.__registerStates, asked: globalThis.__ledgerAsked, approvalsMounts: globalThis.__approvalsMounts }
}

const row = (id, status, state, extra = {}) => ({
  id, kind: 'R', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null, status, state,
  words: `Placeholder words for ${id}.`, filedBy: 'owner', filedAt: '2026-09-01T10:00:00.000Z',
  gateCount: 0, unmetGateCount: 0, decisions: 0, history: [], removedAt: null, removed: false, ...extra,
})
const QUESTIONS_OK = { ok: true, reason: null, observedAt: null, value: [] }
const CHAIN_OK = { ok: true, events: 1, drift: [], unchained: [], code: null }
const DATA = { requests: [row('R7', 'open', 'open', { gateCount: 2 })], questions: QUESTIONS_OK, revision: 1, updatedAt: '2026-09-01', exists: true, chain: CHAIN_OK }

test('a live read enables the action surface with the rows it answered', async () => {
  const result = await render({ ok: true, data: DATA })
  assert.equal(result.root.dataset.projectionState, 'ready', 'a successful read must be exposed as ready')
  assert.equal(result.root.dataset.liveMode, 'live')
  assert.equal(result.states.at(-1).kind, 'live', 'the action surface must receive the live state, not an inferred empty state')
  assert.deepEqual(result.states.at(-1).items, [{ id: 'R7', label: 'R7 · open' }], 'the action surface must receive the request the feed supplied')
  assert.equal(result.summaries.open.textContent, 1, 'the visible open total must count the live request')
  assert.match(result.registerNode.innerHTML, /Placeholder words for R7\./, 'the row must carry the person\'s words')
  assert.equal(result.visible.textContent, '1 rule')
  assert.deepEqual(result.asked, [{ scope: 'all', removed: false }], 'the read must carry the reach filter and the removed toggle')
  assert.equal(result.chainNote.hidden, true, 'a verified history draws no note')
  assert.equal(result.removedToggle.hidden, false, 'the removed toggle is offered on the R tab')
  assert.equal(result.fileSlot, globalThis.__fileBoxMounts[0].slot, 'the file box is mounted in its slot')
  result.view.destroy()
})

test('a failed read stays unavailable and carries its reason as data', async () => {
  const result = await render({ ok: false, reason: 'the installed application did not answer', code: 'AGENT_LEDGER_UNREADABLE' })
  assert.equal(result.root.dataset.projectionState, 'unreadable', 'a could-not-read must never collapse into a definite empty answer')
  assert.equal(result.states.at(-1).kind, 'unreadable', 'controls must receive an unavailable state when their input could not be read')
  assert.equal(result.registerNode.dataset.registerReason, 'the installed application did not answer', 'a control that cannot succeed must carry the refusal reason as data')
  assert.match(result.registerNode.innerHTML, /could not be read/i, 'the person must be told this is a read failure')
  assert.equal(result.summaries.open.textContent, '—', 'an unknown total must not be rendered as zero')
  result.view.destroy()
})

test('an answered ledger with nothing on file is the empty state, with the door to filing and not a failure', async () => {
  const result = await render({ ok: true, data: { ...DATA, requests: [], exists: false } })
  assert.equal(result.root.dataset.projectionState, 'empty', 'an answered empty ledger is a definite empty answer')
  assert.equal(result.states.at(-1).kind, 'empty', 'controls must receive the definite empty state rather than a read refusal')
  assert.equal(result.summaries.open.textContent, 0, 'known-empty totals must be zero rather than unknown')
  assert.match(result.registerNode.innerHTML, /nothing on file yet/i)
  assert.match(result.registerNode.innerHTML, /File a request above/)
  assert.doesNotMatch(result.registerNode.innerHTML, /could not be read/i)
  assert.equal(result.registerNode.dataset.registerReason, undefined)
  result.view.destroy()
})

test('the reach filter narrows the rows, re-reads with the reach, and counts a proposed row in its own tile', async () => {
  const data = {
    ...DATA,
    requests: [
      row('R1', 'open', 'open'),
      row('R2', 'open', 'open', { scope: 'tree', scopeKey: 'node-1', scopeLabel: 'Coordinator' }),
      row('R3', 'proposed', 'proposed', { scope: 'tree', scopeKey: 'node-1', filedBy: 'codex' }),
      row('R4', 'removed', 'removed', { removedAt: '2026-09-01T11:00:00.000Z', removed: true }),
    ],
  }
  const result = await render({ ok: true, data })
  assert.equal(result.summaries.open.textContent, 2)
  assert.equal(result.summaries.proposed.textContent, 1, 'a proposed row counts in its own tile')
  assert.equal(result.visible.textContent, '3 rules', 'a removed row is not drawn until asked for')
  assert.doesNotMatch(result.registerNode.innerHTML, /data-row-id="R4"/, 'a removed row drew without the toggle')
  assert.match(result.registerNode.innerHTML, /data-state="proposed"/)
  assert.match(result.registerNode.innerHTML, /Your agent codex filed this from your words\./, 'the proposed row does not say who filed it')
  assert.deepEqual(result.states.at(-1).items.map(item => item.id), ['R1', 'R2', 'R3'], 'the picker offers the proposed row and not the removed one')

  /* Narrow to one tree: the global row goes, the read is asked again with
     the reach, and the choice is remembered. */
  const remembered = []
  globalThis.localStorage = { getItem: () => null, setItem(key, value) { remembered.push([key, value]) } }
  await pressIn(result.scopeGroup, result.scopeButtons.find(button => button.dataset.scope === 'tree'), 'scope')
  await settle()
  assert.deepEqual(result.asked.at(-1), { scope: 'tree', removed: false }, 'the re-read must carry the reach')
  assert.equal(result.visible.textContent, '2 rules')
  assert.doesNotMatch(result.registerNode.innerHTML, /data-row-id="R1"/, 'a global row survived the tree filter')
  assert.ok(remembered.some(([key, value]) => key === 'mc.ledger.scope' && value === 'tree'), 'the reach is not remembered per copy')
  globalThis.localStorage = { getItem: () => null, setItem() {} }

  /* Show removed: re-read with the flag, the removed row draws, the counter
     carries the tail, and the toggle offers to hide again. */
  await pressToggle(result.removedToggle)
  await settle()
  assert.deepEqual(result.asked.at(-1), { scope: 'tree', removed: true })
  await pressIn(result.scopeGroup, result.scopeButtons.find(button => button.dataset.scope === 'all'), 'scope')
  await settle()
  assert.match(result.registerNode.innerHTML, /data-row-id="R4"/, 'the removed row did not draw with the toggle on')
  assert.equal(result.visible.textContent, '4 rules · 1 removed')
  assert.equal(result.removedToggle.textContent, 'Hide removed')
  assert.deepEqual(result.states.at(-1).items.map(item => item.id), ['R1', 'R2', 'R3'], 'a removed row must never be offered to Approve or Decline')
  result.view.destroy()
})

test('a narrowed register with no row left says so as an answer, never as the empty verdict', async () => {
  const data = { ...DATA, requests: [row('R1', 'open', 'open')] }
  const result = await render({ ok: true, data })
  globalThis.__ledgerReply = { ok: true, data: { ...data, requests: [] } }
  await pressIn(result.scopeGroup, result.scopeButtons.find(button => button.dataset.scope === 'thread'), 'scope')
  await settle()
  assert.equal(result.root.dataset.projectionState, 'ready', 'a filter that hides every row is not an empty ledger')
  assert.match(result.registerNode.innerHTML, /There are no requests in this list\./)
  assert.equal(result.visible.textContent, '0 rules')
  result.view.destroy()
})

test('the row controls are drawn only for the verbs the bridge has, and a broken history is said above the rows', async () => {
  const bridge = { requestEdit: async () => ({ ok: true }), requestRemove: async () => ({ ok: true }), requestDecide: async () => ({ ok: true }), request: async () => ({ ok: true }) }
  const data = { ...DATA, requests: [row('R1', 'open', 'open'), row('R2', 'proposed', 'proposed', { filedBy: 'claude' })], chain: { ok: false, events: 2, drift: [], unchained: [], code: 'R_LEDGER_CHAIN_BROKEN' } }
  const result = await render({ ok: true, data }, { mcAgent: bridge })
  const html = result.registerNode.innerHTML
  assert.match(html, /data-row-action="edit" data-id="R1"/, 'Edit is not drawn on a live row')
  assert.match(html, /data-row-action="delete" data-id="R1"/, 'Delete is not drawn on a live row')
  assert.match(html, /data-row-action="approve" data-id="R2"/, 'Approve is not drawn on a proposed row')
  assert.match(html, /data-row-action="decline" data-id="R2"/, 'Decline is not drawn on a proposed row')
  assert.equal(result.chainNote.hidden, false, 'a broken history draws no note')
  assert.match(result.chainNote.textContent, /could not be verified/)
  assert.equal(result.chainNote.dataset.state, 'refused')
  assert.equal(result.states.at(-1).kind, 'live', 'the rows are still handed to the surface')
  result.view.destroy()

  /* MEASURED 2026-09-03: owner-request-store.js's verifyHistory() computes
     `ok: drift.length === 0 && missing.length === 0` -- drift and ok:true
     never coexist in anything the read side can actually answer with. A
     fixture that set ok:true alongside a non-empty drift array was testing a
     shape the real IPC reply can never take, and it hid paintChainNote()
     checking `chain.ok === false` BEFORE it checked drift, so the specific
     "R1 changed outside ToolsEnabled" sentence a drifted ledger is supposed
     to earn was unreachable dead code: any real drift reply also has
     ok:false, so the generic "edited in place" sentence fired first and won,
     every time. */
  const none = await render({ ok: true, data: { ...data, chain: { ok: false, events: 2, drift: ['R1'], unchained: [], code: 'R_LEDGER_CHAIN_DRIFT' } } })
  assert.doesNotMatch(none.registerNode.innerHTML, /data-row-action=/, 'a bridge with no verbs drew controls')
  assert.equal(none.chainNote.hidden, false)
  assert.match(none.chainNote.textContent, /^R1 does not match the available history/,
    'a drifted record names itself even though the chain, correctly, also reads not-ok')
  assert.equal(none.chainNote.dataset.state, 'unavailable', 'drift is a caution, not the same refused tone as a broken chain')
  none.view.destroy()

  const missing = await render({ ok: true, data: { ...data, chain: { ok: false, events: 3, drift: ['R1'], missing: ['T2'], code: 'AGENT_LEDGER_CHAIN_DRIFT' } } })
  assert.equal(missing.chainNote.hidden, false)
  assert.match(missing.chainNote.textContent, /R1 does not match/)
  assert.match(missing.chainNote.textContent, /T2 is missing from the ledger/)
  missing.view.destroy()
})

/* THE OWNER'S RESOLVE ACTION (2026-09-07): "a standing R row (open,
   in-progress, partial, blocked-external) moves to one of
   RESOLUTION_STATUSES" -- so Resolve is gated on the STATUS, not the rail
   state (a gated row is still standing; the gate is a different axis), it
   is drawn only with the bridge verb, and it must never appear on a row
   that has already stopped standing (done, not-possible-as-asked,
   superseded, proposed, removed). */
test('Resolve is drawn on a standing R row only, and only with the bridge verb', async () => {
  const bridge = { requestEdit: async () => ({ ok: true }), requestRemove: async () => ({ ok: true }), requestDecide: async () => ({ ok: true }), resolveStandingRequest: async () => ({ ok: true }) }
  const data = {
    ...DATA,
    requests: [
      row('R1', 'open', 'open'),
      row('R2', 'in-progress', 'in-progress'),
      row('R3', 'partial', 'partial'),
      row('R4', 'blocked-external', 'blocked-external'),
      row('R5', 'done', 'done'),
      row('R6', 'not-possible-as-asked', 'not-possible-as-asked'),
      row('R7', 'superseded', 'superseded'),
      row('R9', 'proposed', 'proposed'),
    ],
  }
  const result = await render({ ok: true, data }, { mcAgent: bridge })
  const html = result.registerNode.innerHTML
  for (const id of ['R1', 'R2', 'R3', 'R4']) {
    assert.match(html, new RegExp(`data-row-action="resolve" data-id="${id}"`), `${id} is standing and must offer Resolve`)
  }
  for (const id of ['R5', 'R6', 'R7', 'R9']) {
    assert.doesNotMatch(html, new RegExp(`data-row-action="resolve" data-id="${id}"`), `${id} is not standing and must not offer Resolve`)
  }
  result.view.destroy()

  /* A gated row is still open underneath -- the gate is a different axis --
     so it keeps its Resolve control even though its rail mark is 'gated'. */
  const gated = await render({ ok: true, data: { ...DATA, requests: [row('R2', 'in-progress', 'gated', { gateCount: 1, unmetGateCount: 1 })] } }, { mcAgent: bridge })
  assert.match(gated.registerNode.innerHTML, /data-row-action="resolve" data-id="R2"/, 'a gated row is still standing')
  gated.view.destroy()

  /* No resolveStandingRequest on the bridge: no Resolve anywhere, even on a
     row that is otherwise perfectly standing -- the same rule every other
     verb on this page already follows. */
  const noVerb = await render({ ok: true, data }, { mcAgent: { requestEdit: async () => ({ ok: true }) } })
  assert.doesNotMatch(noVerb.registerNode.innerHTML, /data-row-action="resolve"/, 'no verb, no control, on any row')
  noVerb.view.destroy()

  /* T, A and P never draw an R-shaped Resolve control: kindActionsMarkup
     (T/A's own drawing function) is untouched by this feature and shares no
     code path with rowActionsMarkup. */
  const kinds = await render({
    ok: true,
    data: { ...DATA, requests: [{ ...row('T1', 'open', 'open'), kind: 'T' }, row('R1', 'open', 'open')] },
  }, { mcAgent: bridge })
  await pressIn(kinds.modeGroup, kinds.modeButtons.find(button => button.dataset.mode === 't'), 'mode')
  assert.doesNotMatch(kinds.registerNode.innerHTML, /data-row-action="resolve"/, 'the T tab must never offer R\'s Resolve control')
  kinds.view.destroy()
})

/* THE SIX-TILE SUMMARY STRIP STAYS COARSE (Controller's ruling, 2026-09-07):
   the row's own rail glyph is exact (STATE in src/views/ledger.js), but the
   strip was not redrawn for this feature, so a blocked-external row still
   counts in the existing 'blocked' tile and a partial row still counts in
   'in-progress'; superseded and not-possible-as-asked are terminal and
   count in no tile at all, the same as declined/removed already do not. */
test('the summary strip stays coarse: blocked-external counts as blocked, partial counts as in-progress, and superseded/not-possible-as-asked count nowhere', async () => {
  const data = {
    ...DATA,
    requests: [
      row('R1', 'blocked-external', 'blocked-external'),
      row('R2', 'partial', 'partial'),
      row('R3', 'superseded', 'superseded'),
      row('R4', 'not-possible-as-asked', 'not-possible-as-asked'),
    ],
  }
  const result = await render({ ok: true, data })
  assert.equal(result.summaries.blocked.textContent, 1, 'a blocked-external row must still light the existing blocked tile')
  assert.equal(result.summaries['in-progress'].textContent, 1, 'a partial row must still light the existing in-progress tile')
  const tileTotal = ['open', 'in-progress', 'gated', 'proposed', 'done', 'blocked']
    .reduce((sum, state) => sum + Number(result.summaries[state].textContent), 0)
  assert.equal(tileTotal, 2, 'superseded and not-possible-as-asked must count in no tile at all -- not one of the other five either')
  /* The row's OWN glyph must stay exact regardless of what the tile does --
     the coarsening is for the counter only, never for the rail. */
  assert.match(result.registerNode.innerHTML, /data-state="blocked-external"/)
  assert.match(result.registerNode.innerHTML, /data-state="partial"/)
  assert.match(result.registerNode.innerHTML, /data-state="superseded"/)
  assert.match(result.registerNode.innerHTML, /data-state="not-possible-as-asked"/)
  result.view.destroy()

  /* The same coarsening applies on 'all', which mixes R rows into the same
     six tiles through a different code path (rowKindState, not rowState
     directly) -- it must not disagree with the R tab about what a
     blocked-external row counts as. */
  const mixed = await render({ ok: true, data: { ...DATA, requests: [row('R1', 'blocked-external', 'blocked-external'), { ...row('T1', 'open', 'open'), kind: 'T' }] } })
  await pressIn(mixed.modeGroup, mixed.modeButtons.find(button => button.dataset.mode === 'all'), 'mode')
  assert.equal(mixed.summaries.blocked.textContent, 1, 'all must coarsen R the same way the R tab does')
  mixed.view.destroy()
})

test('the example register is badged, narrows the same way, and never re-reads', async () => {
  const sample = () => ({
    requests: [row('R1', 'open', 'open'), row('R2', 'open', 'open', { scope: 'thread', scopeKey: 'node-9' }), row('R5', 'removed', 'removed', { removed: true, removedAt: '2026-09-01T11:00:00.000Z' })],
    questions: QUESTIONS_OK, revision: 3, updatedAt: '2026-09-01', exists: true, chain: { ok: false, events: 0, drift: [], unchained: [], code: null },
  })
  const result = await render(null, { origin: 'mock', sample })
  assert.equal(result.root.dataset.projectionState, 'simulated')
  assert.equal(result.root.dataset.liveMode, 'simulated')
  assert.deepEqual(result.asked, [], 'the example must never reach the feed')
  assert.match(result.visible.textContent, /^Example, not your data — 2 rules$/)
  assert.equal(result.states.at(-1).kind, 'simulated')
  assert.equal(result.chainNote.hidden, true, 'the example never claims a history problem')
  await pressIn(result.scopeGroup, result.scopeButtons.find(button => button.dataset.scope === 'thread'), 'scope')
  await settle()
  assert.deepEqual(result.asked, [])
  assert.match(result.visible.textContent, /^Example, not your data — 1 rule$/)
  assert.equal(globalThis.__fileBoxMounts[0].options.isBadged(), true, 'the file box must know the register is the example')
  result.view.destroy()
})

test('the A tab reads the questions half on its own: a questions read that fell over is said there and leaves the R tab alone', async () => {
  const data = { ...DATA, questions: { ok: false, reason: 'the questions report did not answer', observedAt: null, value: [] } }
  const result = await render({ ok: true, data })
  assert.equal(result.root.dataset.projectionState, 'ready', 'a failed questions read must not flip the R tab')
  assert.equal(result.registerNode.dataset.registerReason, undefined)
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'a'), 'mode')
  assert.equal(result.root.dataset.projectionState, 'unreadable')
  assert.equal(result.registerNode.dataset.registerReason, 'the questions report did not answer')
  assert.match(result.registerNode.innerHTML, /questions could not be read/i)
  assert.equal(result.removedToggle.hidden, true)
  result.view.destroy()
})

test('the A tab reads the questions half the other way round: a requests read that fell over leaves the questions half drawing from the questions read, and says so on the kind-A half beside it', async () => {
  const question = { id: 'Q3', title: 'Which relay region?', status: 'open', statusClass: 'open', packageId: 'P1' }
  /* Over the relay, or on an older installed application: no ledger verb,
     but the build-time questions report was read fine and rides on the
     failure reply. */
  const result = await render({
    ok: false, reason: 'This copy has no installed application to read your requests from.', code: 'AGENT_LEDGER_UNAVAILABLE',
    questions: { ok: true, reason: null, observedAt: '2026-09-01T10:00:00.000Z', value: [question] },
  })
  assert.equal(result.root.dataset.projectionState, 'unreadable', 'the R tab still says the requests could not be read')
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'a'), 'mode')
  assert.equal(result.root.dataset.projectionState, 'ready', 'a failed requests read must not take the questions half down')
  assert.equal(result.registerNode.dataset.registerReason, undefined, 'the requests failure reason leaked onto the questions half')
  assert.match(result.registerNode.innerHTML, /data-record-key="q:Q3"/, 'the question row is not drawn')
  assert.match(result.registerNode.innerHTML, /Which relay region\?/)
  /* THE KIND-A RECORDS HALF SHARES THE REQUESTS FEED WITH R AND T, so a
     failed requests read DOES say so here -- new information the old Q tab
     never carried, because it never depended on this feed for its own rows.
     What must not happen is the OLD R/Q-specific wording leaking across:
     neither "your requests" nor "your questions" belongs beside a read that,
     on this tab, only ever fails the kind-A half. */
  assert.match(result.registerNode.innerHTML, /This list could not be read/, 'the kind-A half says its own read failed')
  assert.doesNotMatch(result.registerNode.innerHTML, /your requests could not be read/i)
  assert.doesNotMatch(result.registerNode.innerHTML, /your questions could not be read/i)
  assert.equal(result.visible.textContent, '1 question · 1 open · the asks could not be read', 'the counter must not read as the whole tab when the asks could not be read (T1383)')
  assert.equal(result.summaries.open.textContent, 1, 'the open total must count the question')
  assert.equal(result.states.at(-1).kind, 'unreadable', 'the forms act on requests, and the requests are still unreadable')
  assert.equal(result.removedToggle.hidden, true)

  /* Back on the R tab the failure is said again, untouched by the read on A. */
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'r'), 'mode')
  assert.equal(result.root.dataset.projectionState, 'unreadable')
  assert.match(result.registerNode.innerHTML, /requests could not be read/i)
  result.view.destroy()

  /* A failure reply that carries no questions observation at all (a stub, or
     a feed older than this page) is the one case the questions half has
     nothing to draw from, and it says so as a read that fell over. */
  const bare = await render({ ok: false, reason: 'the installed application did not answer', code: 'AGENT_LEDGER_UNREADABLE' })
  await pressIn(bare.modeGroup, bare.modeButtons.find(button => button.dataset.mode === 'a'), 'mode')
  assert.equal(bare.root.dataset.projectionState, 'unreadable')
  assert.match(bare.registerNode.innerHTML, /questions could not be read/i)
  bare.view.destroy()
})

test('a relay reader sees the owning computer named in each unreadable Ledger section', async () => {
  // This is a renderer/feed fixture, not a paired-device transport proof.
  // Keep the real readerRemedy so a missing twin or consumer call both fail.
  for (const origin of ['local', 'relay']) {
    const result = await render({ ok: false, reason: 'Owned fixture read failure', code: 'AGENT_LEDGER_UNREADABLE' }, { origin })
    try {
      for (const mode of ['r', 't', 'a', 'all']) {
        await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === mode), 'mode')
        const html = result.registerNode.innerHTML
        assert.match(html, /could not be read/i, `${origin}/${mode} must actually render its failed read`)
        if (origin === 'relay') {
          assert.doesNotMatch(html, /Nothing was changed\. Close ToolsEnabled/, `${mode} must not instruct the reader to restart their own computer's app`)
          assert.match(html, /On that computer, close ToolsEnabled/, `${mode} must name the computer that needs attention`)
        } else {
          assert.match(html, /Nothing was changed\. Close ToolsEnabled/, `${mode} must retain the local remedy`)
          assert.doesNotMatch(html, /On that computer/)
        }
      }
    } finally { result.view.destroy() }
  }
})

test('the reach filter is offered on every tab but P, which mounts its own view', async () => {
  const result = await render({ ok: true, data: DATA })
  assert.equal(result.scopeGroup.hidden, false, 'R keeps the reach filter')
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 't'), 'mode')
  assert.equal(result.scopeGroup.hidden, false, 'T carries scope like R')
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'a'), 'mode')
  assert.equal(result.scopeGroup.hidden, false, 'the kind-A records carry scope even though questions do not')
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'p'), 'mode')
  assert.equal(result.scopeGroup.hidden, true, 'P mounts approvals.js, which has no reach of its own')
  result.view.destroy()
})

test('a copy that remembered the old Q tab opens on A, not R, the day this ships', async () => {
  globalThis.localStorage = { getItem: key => (key === 'mc.ledger.mode' ? 'q' : null), setItem() {} }
  const result = await render({ ok: true, data: DATA })
  assert.ok(result.modeButtons.some(button => button.dataset.mode === 'a' && button.attributes.get('aria-pressed') === 'true'), 'the remembered q reads as a, not a silent fall back to r')
  result.view.destroy()
  globalThis.localStorage = { getItem: () => null, setItem() {} }
})

test('T tasks and the P tab: T draws its own empty sentence today (no engine kind yet), and P mounts and unmounts ledger-purchases.js\'s renderPurchasesTab on entering and leaving', async () => {
  const result = await render({ ok: true, data: DATA })
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 't'), 'mode')
  assert.match(result.registerNode.innerHTML, /There are no tasks in this list\./, 'no id in this fixture carries the letter T')
  assert.equal(result.approvalsMounts.length, 0, 'T must never mount the purchases view')

  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'p'), 'mode')
  assert.deepEqual(result.approvalsMounts, ['mounted'], 'entering P mounts renderPurchasesTab exactly once')
  assert.equal(result.summarySection.hidden, true, 'the outer summary is hidden while the mounted view draws its own')
  /* The purchases on file are listed under the queue (T1280). */
  assert.equal(result.registerNode.hidden, false, 'the P tab lists no purchase record at all')
  assert.match(result.registerNode.innerHTML, /There are no purchases in this list\./)
  assert.equal(result.purchasesSlot.hidden, false)

  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'r'), 'mode')
  assert.deepEqual(result.approvalsMounts, ['mounted', 'destroyed'], 'leaving P tears the mount down rather than leaving it polling, hidden')
  assert.equal(result.summarySection.hidden, false)
  assert.equal(result.registerNode.hidden, false)

  /* Re-entering P mounts a fresh instance rather than reusing a destroyed
     one, and destroying the WHOLE ledger view while P is open tears the
     mount down exactly once -- the safety net in destroy(), not a second
     path a leaving-P press could race with. */
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 'p'), 'mode')
  assert.deepEqual(result.approvalsMounts, ['mounted', 'destroyed', 'mounted'])
  result.view.destroy()
  assert.deepEqual(result.approvalsMounts, ['mounted', 'destroyed', 'mounted', 'destroyed'])
})

/* T'S TERMINAL SUPERSEDED STATE (Worker's TASK_STATUS_VOCABULARY: "Replaced
   by a newer task; terminal, like done or removed."). Same standing as
   done and removed: a glyph of its own, no action buttons (the store
   refuses complete and remove on it), and the row cites which task
   replaced it, the way rows already cite other ids. */
test('a superseded T row draws no action buttons and cites the task that replaced it', async () => {
  /* A bridge with BOTH T verbs, so the row would otherwise have real
     buttons to draw -- proving the superseded gate itself, not merely
     that no bridge was configured. */
  const bridge = { completeTask: async () => ({ ok: true }), removeTask: async () => ({ ok: true }) }
  const superseded = row('T4', 'superseded', 'superseded', { kind: 'T', supersededBy: 'T9' })
  const result = await render({ ok: true, data: { ...DATA, requests: [...DATA.requests, superseded] } }, { mcAgent: bridge })
  await pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 't'), 'mode')
  assert.match(result.registerNode.innerHTML, /data-state="superseded"/, 'the superseded row must carry its own state, not fall back to unknown')
  assert.doesNotMatch(result.registerNode.innerHTML, /data-row-action="complete"/, 'a superseded task must never offer Complete, even though the bridge has completeTask')
  assert.doesNotMatch(result.registerNode.innerHTML, /data-row-action="delete"/, 'a superseded task must never offer Delete either, even though the bridge has removeTask')
  assert.match(result.registerNode.innerHTML, /Superseded by T9\./, 'the row must cite the task that replaced it')

  /* A superseded row with no supersededBy on file (the store answered
     without one) stays honest: no false citation invented for it. */
  const bare = row('T5', 'superseded', 'superseded', { kind: 'T' })
  const bareResult = await render({ ok: true, data: { ...DATA, requests: [bare] } })
  await pressIn(bareResult.modeGroup, bareResult.modeButtons.find(button => button.dataset.mode === 't'), 'mode')
  assert.doesNotMatch(bareResult.registerNode.innerHTML, /Superseded by/, 'a superseded row with no cited id must not invent one')
})

/* THE CHECKOUT LINK ITSELF IS NOT THIS FILE'S TEST. src/views/ledger.js's
   own comment above (test:ledger-purchases stub) says so directly: P mounts
   ledger-purchases.js's renderPurchasesTab() wholesale, and that module's
   own suite, tools/test/ledger-purchases.test.mjs ("checkout link is drawn
   only when checkoutSurfaceAvailable() is true"), already drives the real
   link against the real module. A duplicate here against this file's stub
   -- which never draws a `.ledger-purchases-checkout-link` node or exposes
   `purchasesCheckoutLink` -- would test a shape this view does not have. */

/* ------------------------------------------------------------ the feed -- */

const { fetchLiveLedger, rowOf, stateOf, kindOf, NO_HOST_REASON } = await import('../../src/ledger-live.js')


test('task metadata survives the shell read, feed projection and rendered T row', async () => {
  const { readCanonicalLedger } = createRequire(import.meta.url)('../../shell/canonical-ledger-read.cjs')
  const cases = [
    [{ difficulty: 'easy', failedReviewCount: 0 }, 'Difficulty: </span>easy', null],
    [{ difficulty: 'medium', failedReviewCount: 1 }, 'Difficulty: </span>medium', 'Did not pass review 1 time<'],
    [{ difficulty: 'hard', failedReviewCount: 2 }, 'Difficulty: </span>hard', 'Did not pass review 2 times<'],
    [{}, null, null],
    [{ difficulty: 'urgent', failedReviewCount: -1 }, null, null],
    [{ difficulty: '<img src=x>', failedReviewCount: '2' }, null, null],
  ]
  for (const [metadata, grade, reviews] of cases) {
    const read = readCanonicalLedger({
      readPolicy: () => ({ verifyHistory: false }),
      loadModule: () => ({
        readAll: () => ({
          exists: true, revision: 1, updatedAt: '2026-09-22',
          records: [{ id: 'T7', kind: 'T', scope: 'global', status: 'open', words: 'Review the task.', ...metadata }],
        }),
        verifyHistory: () => assert.fail('history verification is off for this projection case'),
      }),
    })
    assert.equal(read.ok, true)
    const projected = rowOf(read.records[0])
    const result = await render({ ok: true, data: { ...DATA, requests: [projected] } })
    try {
      pressIn(result.modeGroup, result.modeButtons.find(button => button.dataset.mode === 't'), 'mode')
      const html = result.registerNode.innerHTML
      if (grade) assert.ok(html.includes(grade), 'the task grade reaches the actual row')
      else assert.doesNotMatch(html, /data-task-difficulty-value/, 'an ungraded task shows no grade')
      if (reviews) assert.ok(html.includes(reviews), 'the failed review count reaches the actual row')
      else assert.doesNotMatch(html, /data-task-failed-reviews/, 'no failed review, no count')
      assert.doesNotMatch(result.registerNode.innerHTML, /<img src=x>/)
    } finally {
      result.view.destroy()
    }
  }
})

test('row projection preserves valid task facts and keeps missing or invalid facts unknown', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    for (const failedReviewCount of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
      const row = rowOf({ id: 'T1', difficulty, failedReviewCount })
      assert.equal(row.difficulty, difficulty)
      assert.equal(row.failedReviewCount, failedReviewCount)
    }
  }
  for (const difficulty of [undefined, null, '', 'Hard', 'other', 1]) {
    assert.equal(rowOf({ id: 'T1', difficulty }).difficulty, null)
  }
  for (const failedReviewCount of [undefined, null, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(rowOf({ id: 'T1', failedReviewCount }).failedReviewCount, null)
  }
})

const RECORD = Object.freeze({
  id: 'R3', parentId: null, scope: 'tree', scopeKey: 'node-1', scopeLabel: 'Coordinator', status: 'open', words: 'Keep the tests green.',
  filedBy: 'owner', filedAt: '2026-09-01T10:00:00.000Z', gateCount: 1, unmetGateCount: 1, decisions: 0,
  history: [{ seq: 1, kind: 'file', at: '2026-09-01T10:00:00.000Z', actor: 'owner' }], removedAt: null,
})

test('the feed shapes every record once and classifies its glyph from the ledger\'s own statuses', () => {
  assert.deepEqual(rowOf(RECORD), {
    ...RECORD, kind: 'R', state: 'gated', removed: false,
    difficulty: null, failedReviewCount: null,
    recurrence: null, completedAt: null, completedBy: null, supersedes: null, supersededBy: null, answer: null, purchase: null,
    latestDecision: null,
  })
  assert.deepEqual(Object.keys(rowOf({})).sort(), Object.keys(rowOf(RECORD)).sort(), 'a bare record and a full one produce the same fields')
  const cases = [
    [{ status: 'proposed' }, 'proposed'],
    [{ status: 'open' }, 'open'],
    [{ status: 'open', unmetGateCount: 2 }, 'gated'],
    [{ status: 'in-progress' }, 'in-progress'],
    /* THE OWNER'S RESOLVE ACTION (2026-09-07): four statuses that used to
       collapse into a neighbour now read their own rail mark. A gated
       partial row still reads 'gated' -- the gate axis is unchanged --
       but an ungated one is 'partial', its own state, not 'in-progress'. */
    [{ status: 'partial' }, 'partial'],
    [{ status: 'partial', unmetGateCount: 1 }, 'gated'],
    [{ status: 'blocked-external' }, 'blocked-external'],
    [{ status: 'not-possible-as-asked' }, 'not-possible-as-asked'],
    [{ status: 'superseded' }, 'superseded'],
    /* A 'blocked*' status the ledger's own vocabulary does not mint (never
       blocked-external or not-possible-as-asked) still falls through to
       the old generic mark, kept for a status this reader has not seen. */
    [{ status: 'blocked-other' }, 'blocked'],
    [{ status: 'done' }, 'done'],
    [{ status: 'done', unmetGateCount: 3 }, 'done'],
    [{ status: 'declined' }, 'removed'],
    [{ status: 'removed' }, 'removed'],
    [{ status: 'nonsense' }, 'unknown'],
    [{}, 'unknown'],
  ]
  for (const [record, expected] of cases) assert.equal(stateOf(record), expected, JSON.stringify(record))
  assert.equal(rowOf({ id: 'R9', status: 'declined' }).removed, true)
  assert.equal(rowOf({ id: 'R9', status: 'open', removedAt: '2026-09-01T00:00:00.000Z' }).removed, true)
  assert.equal(rowOf({ id: 'R9', status: 'open', filedBy: '' }).filedBy, 'owner')
})

/* THE OWNER'S FOUR SUBSETS (2026-09-07). Until the engine lane lands `kind`
   on the store, the ONLY honest source for it is the id's own letter, and a
   record whose id does not start with one of the four kind letters is R --
   matching every id this ledger minted before this feature existed. */
test('kind comes from the record when the store has landed it, and from the id\'s own letter until then', () => {
  assert.equal(kindOf({ id: 'R12' }), 'R')
  assert.equal(kindOf({ id: 'T4' }), 'T')
  assert.equal(kindOf({ id: 'A1' }), 'A')
  assert.equal(kindOf({ id: 'P9' }), 'P')
  assert.equal(kindOf({ id: 'T4.1' }), 'T', 'a refinement carries its root\'s letter')
  assert.equal(kindOf({ id: 'R12' }), 'R')
  assert.equal(kindOf({}), 'R', 'no id at all is R, never a guess at a rarer kind')
  assert.equal(kindOf({ id: '' }), 'R')
  assert.equal(kindOf({ id: 'Z9' }), 'R', 'a letter the ledger does not mint is R, not an invented fifth kind')
  assert.equal(kindOf({ id: 'r12' }), 'R', 'the letter is read case-insensitively, the way ids are always printed uppercase')
  /* The store's own field, once L1 lands it, wins outright over the id --
     an explicit kind is a fact, the id's letter is only ever a fallback. */
  assert.equal(kindOf({ id: 'R12', kind: 'T' }), 'T')
  assert.equal(kindOf({ id: 'T4', kind: 'garbage' }), 'T', 'a kind field the ledger does not know falls back to the id, not to R blindly')
  assert.equal(rowOf({ id: 'T4', status: 'open' }).kind, 'T', 'rowOf carries the derived kind through to the row the view reads')
})

/* T's recurrence, A's answer and P's purchase must reach the row shaped, not
   dropped -- they are the engine's own plain objects, never a string, so
   rowOf's text() would silently blank them if it were the tool used here. */
test('recurrence, answer and purchase reach the row as the objects the store handed over, not blanked or stringified', () => {
  const recurrence = { interval: 'weekly', completions: [] }
  const answer = { words: 'Yes, go ahead.', at: '2026-09-06T00:00:00.000Z' }
  const purchase = { lines: [{ label: 'Widget', amountCents: 500 }] }
  assert.deepEqual(rowOf({ id: 'T4', recurrence }).recurrence, recurrence)
  assert.deepEqual(rowOf({ id: 'A1', answer }).answer, answer)
  assert.deepEqual(rowOf({ id: 'P1', purchase }).purchase, purchase)
  assert.equal(rowOf({ id: 'R1' }).recurrence, null, 'a record that never carried one answers null, not {}')
  assert.equal(rowOf({ id: 'R1' }).answer, null)
  assert.equal(rowOf({ id: 'R1' }).purchase, null)
  assert.equal(rowOf({ id: 'T4', completedAt: '2026-09-06', completedBy: 'owner' }).completedAt, '2026-09-06')
  assert.equal(rowOf({ id: 'T4', completedAt: '2026-09-06', completedBy: 'owner' }).completedBy, 'owner')
})

test('the feed reads through window.mcAgent.ledger, keeps the two halves apart, and never invents a row', async () => {
  const asked = []
  windowStub.mcAgent = {
    ledger: async request => {
      asked.push(request)
      return { ok: true, revision: 4, updatedAt: '2026-09-01', exists: true, records: [RECORD], chain: { ok: true, events: 1, drift: [], unchained: [], code: null }, filter: request }
    },
  }
  /* The questions report is absent on an install: the fetch answers the
     shipped report, which is an answered empty list, not a failure. */
  const reportAnswers = async url => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('schema')
      ? { $schema: 'x', $id: 'https://example.invalid/ledger.schema.json', type: 'object', additionalProperties: false, properties: { schemaVersion: { const: 1 }, domain: { const: 'ledger' }, generatedAt: {}, ok: {}, reason: {}, sources: {}, data: {} }, $defs: { source: {}, data: {} }, required: ['schemaVersion', 'domain', 'generatedAt', 'ok', 'reason', 'sources', 'data'] }
      : { schemaVersion: 1, domain: 'ledger', generatedAt: '1970-01-01T00:00:00.000Z', ok: false, reason: 'No local agent fleet host detected on this machine.', sources: [], data: null }),
  })
  globalThis.fetch = reportAnswers
  try {
    const result = await fetchLiveLedger({ scope: 'tree', removed: true })
    assert.deepEqual(asked, [{ scope: 'tree', key: null, removed: true }])
    assert.equal(result.ok, true)
    assert.deepEqual(result.data.requests, [rowOf(RECORD)])
    assert.deepEqual(result.data.questions, { ok: true, reason: 'No local agent fleet host detected on this machine.', observedAt: null, value: [] }, 'an answered report with no fleet is an empty list, not a failure')
    assert.deepEqual(result.data.chain, { checked: true, ok: true, events: 1, drift: [], missing: [], unchained: [], code: null })
    assert.equal(result.data.revision, 4)
    assert.equal(result.data.exists, true)

    /* A questions fetch that fell over is said on its own half only. */
    globalThis.fetch = async () => { throw new Error('offline') }
    const offline = await fetchLiveLedger()
    assert.equal(offline.ok, true, 'a questions failure must not flip the requests half')
    assert.equal(offline.data.questions.ok, false)
    assert.match(offline.data.questions.reason, /offline/)
    assert.deepEqual(asked.at(-1), { scope: 'all', key: null, removed: false })

    /* The bridge's own refusal, and a bridge that threw. Each failure reply
       still carries the questions observation -- the questions report was
       read regardless -- so the Q tab can draw from it. */
    windowStub.mcAgent = { ledger: async () => ({ ok: false, code: 'AGENT_LEDGER_UNAVAILABLE', reason: 'this copy has no ledger module', records: [] }) }
    const refused = await fetchLiveLedger()
    assert.deepEqual({ ...refused, questions: undefined }, { ok: false, reason: 'this copy has no ledger module', code: 'AGENT_LEDGER_UNAVAILABLE', questions: undefined })
    assert.equal(refused.questions.ok, false, 'a refused requests read must still carry the questions observation')
    assert.match(refused.questions.reason, /offline/)
    windowStub.mcAgent = { ledger: async () => { throw new Error('Error invoking remote method: AGENT_LEDGER_UNREADABLE') } }
    const threw = await fetchLiveLedger()
    assert.equal(threw.ok, false)
    assert.equal(threw.code, 'AGENT_LEDGER_UNREADABLE')
    assert.match(threw.questions.reason, /offline/)

    /* No bridge at all: a browser with no installed application behind it.
       The questions report answered, and the reply says so beside the
       refusal -- this is the relay case that used to take the Q tab down. */
    globalThis.fetch = reportAnswers
    windowStub.mcAgent = undefined
    const noHost = await fetchLiveLedger()
    assert.deepEqual(noHost, { ok: false, reason: NO_HOST_REASON, code: 'AGENT_LEDGER_UNAVAILABLE', questions: { ok: true, reason: 'No local agent fleet host detected on this machine.', observedAt: null, value: [] } })
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(NO_HOST_REASON), 'the sentence carries a code')
  } finally {
    delete globalThis.fetch
    windowStub.mcAgent = undefined
  }
})
