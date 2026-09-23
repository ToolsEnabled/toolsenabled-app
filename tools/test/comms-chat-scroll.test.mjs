import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DATA_SOURCE_EVENT } from '../../src/data-source.js'

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    if (specifier.endsWith('live-status.js')) return { url: 'stub:live-status', shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url === 'stub:live-status') {
      return { format: 'module', shortCircuit: true, source: 'export const fetchOps = async () => ({ ok: false, reason: "stub: no ops projection in tests" })' }
    }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)

const moduleUrl = process.env.DOM_STAND_IN_MODULE
  ? pathToFileURL(process.env.DOM_STAND_IN_MODULE).href
  : new URL('./lib/dom-stand-in.mjs', import.meta.url).href
const { installDomStandIn, Element } = await import(moduleUrl)
const installed = installDomStandIn(globalThis)

/* See the file header: comms.js's setLiveWord() reads liveEl.lastChild,
   which the shared stand-in does not model (only lastElementChild). A
   trailing plain-text _content item becomes a settable stand-in text node;
   an Element child is returned as-is, matching real Node.lastChild. */
Object.defineProperty(Element.prototype, 'lastChild', {
  configurable: true,
  get() {
    const last = this._content.at(-1)
    if (last === undefined) return null
    if (typeof last !== 'string') return last
    const owner = this
    return {
      get textContent() { return last },
      set textContent(value) {
        owner._content[owner._content.length - 1] = String(value)
        owner._text = owner._content.map(item => typeof item === 'string' ? item : item.textContent).join('')
      },
    }
  },
})

document.body.classList.add('reduce-motion')
window.mcShell = { getBridgeProof() {} }
let liveMessages = []
window.mcAgent = { localMessages: async () => ({ ok: true, messages: liveMessages }) }
window.innerHeight = 0

const { commsView } = await import('../../src/views/comms.js')

const views = new Set()
function mountView() {
  const view = commsView()
  document.body.appendChild(view.el)
  views.add(view)
  return view
}
function destroyView(view) {
  view.destroy()
  view.el.remove()
  views.delete(view)
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
/* Re-poll on demand instead of waiting the real 4000ms interval: the
   product's own re-ask trigger (sign-in, sign-out, the example toggle), not
   a test-only seam. */
const rePoll = async () => { [...views].at(-1).el.querySelector('.comms-refresh').click(); await flush() }

test.after(() => {
  for (const view of views) destroyView(view)
  delete window.mcShell
  delete window.mcAgent
  delete window.innerHeight
  document.body.classList.remove('reduce-motion')
  installed.restore()
})

async function mountOnChannel(seedMessages) {
  liveMessages = seedMessages
  const view = mountView()
  await flush()
  const log = view.el.querySelector('.ch-log')
  assert.ok(log, 'the single-channel log did not mount')
  assert.ok(view.el.querySelector('.ch'), 'no live channel reached the rail')
  // History tests observe the combined timeline explicitly. The initial view
  // focuses the most recently active conversation.
  Array.from(view.el.querySelectorAll('.ch')).find(row => row.dataset.id === 'all').click()
  return { view, log }
}

test('the initial view focuses the latest conversation and keeps it selected when another becomes active', async () => {
  liveMessages = [
    { id: 'older', sender: 'Manager', recipient: 'Reviewer', text: 'Please review.', at: '2026-09-07T00:00:00.000Z' },
    { id: 'recent', sender: 'Builder', recipient: 'Manager', text: 'The update is ready.', at: '2026-09-07T00:01:00.000Z' },
  ]
  const view = mountView()
  try {
    await flush()
    const log = view.el.querySelector('.ch-log')
    assert.equal(view.el.querySelector('.ch-title').textContent, 'Builder ↔ Manager')
    assert.equal(log.querySelectorAll('.cmsg').length, 1)
    assert.equal(log.querySelector('.cmsg').dataset.msgId, 'recent')
    liveMessages.push({ id: 'new', sender: 'Reviewer', recipient: 'Manager', text: 'Review done.', at: '2026-09-07T00:02:00.000Z' })
    await rePoll()
    assert.equal(view.el.querySelector('.ch-title').textContent, 'Builder ↔ Manager')
    assert.equal(log.querySelectorAll('.cmsg').length, 1, 'background activity does not change the conversation being read')
    const chooser = view.el.querySelector('.comms-conversation-select')
    chooser.value = 'all'; chooser.dispatch('change')
    assert.equal(log.querySelectorAll('.cmsg').length, 3, 'the narrow-window picker reaches all conversations')
  } finally { destroyView(view) }
})

test('the single-channel pane keeps a reader\'s place when they have scrolled away from the bottom and a new message arrives', async () => {
  const { view, log } = await mountOnChannel([{ id: 'm1', sender: 'Worker 1', text: 'first message', at: '2026-09-07T00:00:00.000Z' }])
  try {
    log.scrollHeight = 2000
    log.clientHeight = 400
    log.scrollTop = 500
    log.dispatch('scroll')
    const before = log.scrollTop
    assert.equal(before, 500, 'the scroll stand-in did not hold the position the test set')
    assert.equal(view.el.querySelector('.jump-chip').classList.contains('hidden'), false,
      'the jump-to-latest chip must show once the reader is away from the bottom')

    liveMessages = [...liveMessages, { id: 'm2', sender: 'Worker 2', text: 'second message', at: '2026-09-07T00:00:05.000Z' }]
    await rePoll()

    assert.ok(log.scrollTop === before, `a reader scrolled away from the bottom was dragged from ${before} to ${log.scrollTop}`)
  } finally { destroyView(view) }
})

test('the single-channel pane still follows a reader who is at or near the bottom', async () => {
  const { view, log } = await mountOnChannel([{ id: 'm1', sender: 'Worker 1', text: 'first message', at: '2026-09-07T00:00:00.000Z' }])
  try {
    log.scrollHeight = 2000
    log.clientHeight = 400
    log.scrollTop = log.scrollHeight - log.clientHeight
    log.dispatch('scroll')
    assert.equal(view.el.querySelector('.jump-chip').classList.contains('hidden'), true,
      'the jump-to-latest chip must hide once the reader is back at the bottom')

    liveMessages = [...liveMessages, { id: 'm2', sender: 'Worker 2', text: 'second message', at: '2026-09-07T00:00:05.000Z' }]
    await rePoll()

    assert.ok(log.scrollTop === log.scrollHeight, `a reader at the bottom was left at ${log.scrollTop} of ${log.scrollHeight}`)
  } finally { destroyView(view) }
})

test('the single-channel pane holds a scrolled-away reader through several rapid updates in a row', async () => {
  const { view, log } = await mountOnChannel([{ id: 'm1', sender: 'Worker 1', text: 'first message', at: '2026-09-07T00:00:00.000Z' }])
  try {
    log.scrollHeight = 2000
    log.clientHeight = 400
    log.scrollTop = 500
    log.dispatch('scroll')
    for (let i = 0; i < 5; i++) {
      liveMessages = [...liveMessages, { id: `rapid-${i}`, sender: 'Worker 4', text: `rapid ${i}`, at: `2026-09-07T00:01:${String(i).padStart(2, '0')}.000Z` }]
      await rePoll()
      assert.ok(log.scrollTop === 500, `poll ${i} moved a scrolled-away reader to ${log.scrollTop}`)
    }
  } finally { destroyView(view) }
})

test('an unchanged poll preserves message nodes, open disclosures, and the focused control', async () => {
  const { view, log } = await mountOnChannel([{ id: 'long', sender: 'Worker', text: 'Long original message. '.repeat(80), at: '2026-09-07T00:00:00.000Z' }])
  try {
    const row = log.querySelector('.cmsg'), fold = row.querySelector('details'), copy = row.querySelector('.chat-message-copy')
    fold.open = true
    row.querySelector('.cmsg-details-toggle').click()
    copy.focus()
    await rePoll()
    assert.equal(log.querySelector('.cmsg'), row)
    assert.equal(log.querySelector('details'), fold)
    assert.equal(fold.open, true)
    assert.equal(row.querySelector('.cmsg-details').hidden, false)
    assert.equal(document.activeElement, copy)
  } finally { destroyView(view) }
})

test('repeated polls count a newly arrived message once while the reader is scrolled up', async () => {
  const { view, log } = await mountOnChannel([{ id: 'm1', sender: 'Worker', text: 'One', at: '2026-09-07T00:00:00.000Z' }])
  try {
    log.scrollHeight = 2000; log.clientHeight = 400; log.scrollTop = 200; log.dispatch('scroll')
    liveMessages.push({ id: 'm2', sender: 'Worker', text: 'Two', at: '2026-09-07T00:01:00.000Z' })
    await rePoll(); await rePoll(); await rePoll()
    assert.equal(view.el.querySelector('.jl').textContent, '1 new · Jump to latest')
    assert.equal(log.scrollTop, 200)
    view.el.querySelector('.jump-chip').click()
    assert.equal(log.scrollTop, log.scrollHeight)
  } finally { destroyView(view) }
})

test('a source change clears the old message nodes before a new machine answers', async () => {
  const { view, log } = await mountOnChannel([{ id: 'old', sender: 'Worker', text: 'Old machine', at: '2026-09-07T00:00:00.000Z' }])
  try {
    window.mcAgent.localMessages = () => new Promise(() => {})
    window.dispatch(DATA_SOURCE_EVENT)
    assert.equal(log.querySelector('.cmsg'), null)
    assert.equal(view.el.dataset.projectionState, 'loading')
  } finally { window.mcAgent.localMessages = async () => ({ ok: true, messages: liveMessages }); destroyView(view) }
})

test('agent and delivery filters compose with full-body search and can be cleared', async () => {
  const { view, log } = await mountOnChannel([
    { id: 'a', sender: 'Manager', recipient: 'Builder', text: 'Intro. '.repeat(140) + 'Needle in the folded body', deliveryState: 'unconfirmed' },
    { id: 'b', sender: 'Reviewer', recipient: 'Manager', text: 'Needle reviewed', deliveryState: 'available' },
    { id: 'c', sender: 'Builder', recipient: 'Manager', text: 'Finished', deliveryState: 'available' },
  ])
  try {
    const search = view.el.querySelector('.comms-search'), select = view.el.querySelector('.comms-agent')
    const filterToggle = view.el.querySelector('.comms-filter-toggle'), filterPanel = view.el.querySelector('.comms-filter-panel')
    assert.equal(filterPanel.hidden, true)
    filterToggle.click()
    assert.equal(filterPanel.hidden, false)
    assert.equal(filterToggle.getAttribute('aria-expanded'), 'true')
    search.value = 'Needle'; search.dispatch('input')
    assert.equal(log.querySelectorAll('.cmsg').length, 2)
    assert.equal(log.querySelector('details').open, true, 'a search match inside a long message is visible')
    select.value = 'Builder'; select.dispatch('change')
    assert.equal(log.querySelectorAll('.cmsg').length, 1)
    view.el.querySelector('.comms-issues').click()
    assert.equal(log.querySelector('.cmsg').dataset.msgId, 'a')
    assert.equal(view.el.querySelector('.comms-issues').getAttribute('aria-pressed'), 'true')
    filterToggle.click()
    assert.equal(filterPanel.hidden, true)
    assert.equal(view.el.querySelector('.comms-filter-count').textContent, '2')
    assert.equal(view.el.querySelector('.comms-clear').hidden, false)
    view.el.querySelector('.comms-clear').click()
    assert.equal(log.querySelectorAll('.cmsg').length, 3)
    assert.equal(search.value, ''); assert.equal(select.value, '')
    assert.equal(view.el.querySelector('.comms-filter-count').hidden, true)
  } finally { destroyView(view) }
})

test('an unreadable first history never presents zero messages or zero delivery issues as facts', async () => {
  window.mcAgent.localMessages = async () => ({ ok: false, reason: 'The test inbox is temporarily unavailable.' })
  const view = mountView()
  try {
    await flush()
    assert.equal(view.el.dataset.projectionState, 'unavailable')
    assert.equal(view.el.querySelector('.comms-count').textContent, 'Waiting for message history')
    assert.equal(view.el.querySelector('.comms-issue-count').textContent, '—')
    assert.equal(view.el.querySelector('.ch-total').textContent, '—')
  } finally { window.mcAgent.localMessages = async () => ({ ok: true, messages: liveMessages }); destroyView(view) }
})

// Browser mechanics absent from the shared DOM fixture: scrollTop is clamped
// when a scrolling box becomes empty, scroll events are queued/coalesced, and
// animation frames run separately. This fixture does not model comms state or
// choose a destination; all channel and pinning behavior is the mounted view.
async function scrollingView() {
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame
  const previousVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  const frames = new Map()
  let serial = 0, scrollQueued = false, top = 0, writes = 0, closed = false, grown = 0
  globalThis.requestAnimationFrame = callback => { const id = ++serial; frames.set(id, callback); return id }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  Object.defineProperty(document, 'visibilityState', { configurable: true, writable: true, value: 'visible' })
  liveMessages = ['Builder', 'Controller', 'Reviewer'].flatMap((sender, group) =>
    Array.from({ length: 12 }, (_, i) => ({ id: `${sender}-${i}`, sender, recipient: 'Manager',
      text: `${sender} update ${i}`, at: new Date(Date.UTC(2026, 8, 7, 0, group, i)).toISOString() })))
  const view = mountView(), log = view.el.querySelector('.ch-log')
  // `grown` models rows that get taller after their first layout (a web font or
  // picture arriving). It stays zero unless a case asks for it.
  const height = () => Math.max(240, log.querySelectorAll('.cmsg').length * 80 + grown)
  const clamp = value => Math.max(0, Math.min(Number(value) || 0, height() - 240))
  Object.defineProperties(log, {
    clientHeight: { configurable: true, get: () => 240 },
    scrollHeight: { configurable: true, get: height },
    scrollTop: { configurable: true,
      get() { const next = clamp(top); if (next !== top) scrollQueued = true; top = next; return top },
      set(value) { writes++; const next = clamp(value); if (next !== top) scrollQueued = true; top = next },
    },
  })
  const replaceChildren = log.replaceChildren.bind(log)
  log.replaceChildren = (...nodes) => { replaceChildren(...nodes); void log.scrollTop }
  const fixture = {
    view, log,
    ids: () => Array.from(view.el.querySelectorAll('.ch')).map(row => row.dataset.id),
    idFor: name => Array.from(view.el.querySelectorAll('.ch')).find(row => row.querySelector('.ch-name').textContent.includes(name)).dataset.id,
    choose(id) { Array.from(view.el.querySelectorAll('.ch')).find(row => row.dataset.id === id).click() },
    scrollEvents() { if (scrollQueued) { scrollQueued = false; log.dispatch('scroll') } },
    frame() { const due = [...frames]; for (const [id, callback] of due) { frames.delete(id); callback() } },
    callbacks: () => [...frames.values()],
    settle() { this.scrollEvents(); this.frame(); this.scrollEvents() },
    grow(px) { grown += px },
    latest() {
      assert.ok(log.scrollHeight - log.scrollTop - log.clientHeight < 48, 'the mounted conversation must open at its latest message')
      assert.equal(view.el.querySelector('.jump-chip').classList.contains('hidden'), true)
    },
    writes: () => writes,
    close() {
      if (closed) return
      closed = true
      destroyView(view)
      globalThis.requestAnimationFrame = previousFrame
      globalThis.cancelAnimationFrame = previousCancel
      if (previousVisibility) Object.defineProperty(document, 'visibilityState', previousVisibility)
      else delete document.visibilityState
    },
  }
  try { await flush(); return fixture } catch (error) { fixture.close(); throw error }
}

test('T1245 first-open conversations and All messages reach latest when clamped scroll events precede frames', async () => {
  const h = await scrollingView()
  try {
    h.settle(); h.latest()
    assert.equal(h.view.el.querySelector('h1').textContent, 'Messages')
    for (const id of h.ids()) {
      h.choose(id)
      h.settle()
      h.latest()
      assert.ok(h.log.scrollTop > 0, 'the fixture must exercise a tall previous conversation')
    }
  } finally { h.close() }
})

test('T1245 a deliberately scrolled-up conversation restores its place after switching', async () => {
  const h = await scrollingView()
  try {
    h.choose(h.idFor('Builder')); h.settle()
    h.log.scrollTop = 160; h.scrollEvents()
    h.choose(h.idFor('Controller')); h.settle(); h.latest()
    h.choose(h.idFor('Builder')); h.settle()
    assert.equal(h.log.scrollTop, 160)
    assert.equal(h.view.el.querySelector('.jump-chip').classList.contains('hidden'), false)
  } finally { h.close() }
})

test('T1245 rapid channel switches before pending frames preserve both latest and remembered positions', async () => {
  const h = await scrollingView()
  try {
    h.choose(h.idFor('Builder')); h.settle()
    h.log.scrollTop = 160; h.scrollEvents()
    h.choose(h.idFor('Controller'))
    const stale = h.callbacks()
    h.choose('all')
    h.choose(h.idFor('Builder'))
    for (const callback of stale) callback()
    h.settle()
    assert.equal(h.log.scrollTop, 160, 'an old frame must not drag the newly selected reader')
    h.choose(h.idFor('Controller')); h.settle(); h.latest()
    h.choose('all'); h.settle(); h.latest()
  } finally { h.close() }
})

for (const deliverScrollFirst of [true, false]) {
  test(`T1245 real scrolling during pending frames is retained with scroll event ${deliverScrollFirst ? 'before' : 'after'} frame`, async () => {
    const h = await scrollingView()
    try {
      h.choose(h.idFor('Builder')); h.settle()
      h.choose(h.idFor('Controller'))
      h.log.scrollTop = 160
      if (deliverScrollFirst) h.scrollEvents()
      h.frame(); h.scrollEvents()
      assert.equal(h.log.scrollTop, 160)
      assert.equal(h.view.el.querySelector('.jump-chip').classList.contains('hidden'), false)
      h.choose('all'); h.settle()
      h.choose(h.idFor('Controller')); h.settle()
      assert.equal(h.log.scrollTop, 160, 'the reader intent must also be remembered for the next visit')
    } finally { h.close() }
  })
}

test('T1245 incoming messages between channel render and frame keep latest without overriding a new user scroll', async () => {
  const h = await scrollingView()
  try {
    h.choose(h.idFor('Builder')); h.settle()
    h.choose(h.idFor('Controller'))
    liveMessages.push({ id: 'controller-new', sender: 'Controller', recipient: 'Manager', text: 'New update', at: '2026-09-07T00:04:00Z' })
    await rePoll(); h.settle(); h.latest()
    h.choose('all'); h.settle()
    h.choose(h.idFor('Controller'))
    h.log.scrollTop = 160 // the browser has moved; its scroll event is still queued
    liveMessages.push({ id: 'controller-next', sender: 'Controller', recipient: 'Manager', text: 'Another update', at: '2026-09-07T00:05:00Z' })
    await rePoll(); h.settle()
    assert.equal(h.log.scrollTop, 160)
    assert.equal(h.view.el.querySelector('.jump-chip').classList.contains('hidden'), false)
  } finally { h.close() }
})

test('T1245 disposing the mounted view makes pending channel frames inert', async () => {
  const h = await scrollingView()
  try {
    h.choose(h.idFor('Builder')); h.settle()
    h.choose(h.idFor('Controller'))
    const stale = h.callbacks()
    h.close()
    const writes = h.writes(), top = h.log.scrollTop
    for (const callback of stale) callback()
    assert.equal(h.writes(), writes)
    assert.equal(h.log.scrollTop, top)
  } finally { h.close() }
})

test('T1245 a frameless page opens each conversation at latest without waiting for a callback', async () => {
  const h = await scrollingView()
  try {
    document.visibilityState = 'hidden'
    for (const id of h.ids()) { h.choose(id); h.scrollEvents(); h.latest() }
  } finally { h.close() }
})


test('T1245 stale frames across source loading and new readiness cannot replace the new history or reader position', async () => {
  const h = await scrollingView()
  const originalReader = window.mcAgent.localMessages
  try {
    h.choose(h.idFor('Builder')); h.settle()
    h.choose(h.idFor('Controller'))
    const oldFrames = h.callbacks()
    assert.ok(oldFrames.length > 0, 'the old source must have a pending channel frame')
    assert.ok(h.log.scrollTop > 0, 'the old conversation must have a real scroll range')

    let answerNewSource
    window.mcAgent.localMessages = () => new Promise(resolve => { answerNewSource = resolve })
    window.dispatch(DATA_SOURCE_EVENT)
    await flush()
    assert.equal(typeof answerNewSource, 'function', 'the real feed must be waiting for the replacement source')
    assert.equal(h.view.el.dataset.projectionState, 'loading')
    assert.equal(h.log.querySelectorAll('.cmsg').length, 0)
    assert.equal(h.log.scrollTop, 0)
    const loadingFrames = h.callbacks()
    assert.ok(loadingFrames.length > 0, 'the loading render must also leave a pending frame')
    for (const callback of oldFrames) callback()
    assert.equal(h.view.el.dataset.projectionState, 'loading')
    assert.equal(h.log.querySelectorAll('.cmsg').length, 0, 'an old frame restored old-source content during loading')
    assert.equal(h.log.scrollTop, 0)

    // Reuse the conversation name across sources; only its history changes.
    // Channel equality alone must not let a former source frame act here.
    liveMessages = Array.from({ length: 16 }, (_, i) => ({
      id: `replacement-${i}`, sender: 'Controller', recipient: 'Manager',
      text: `Replacement source message ${i}`, at: new Date(Date.UTC(2026, 8, 8, 0, 0, i)).toISOString(),
    }))
    answerNewSource({ ok: true, messages: liveMessages })
    await flush()
    assert.equal(h.view.el.dataset.projectionState, 'ready')
    const messageIds = () => Array.from(h.log.querySelectorAll('.cmsg')).map(row => row.dataset.msgId)
    assert.deepEqual(messageIds(), liveMessages.map(message => message.id))
    h.latest()
    for (const callback of [...oldFrames, ...loadingFrames]) callback()
    assert.deepEqual(messageIds(), liveMessages.map(message => message.id), 'stale frames changed the replacement history')
    h.latest()

    // Move before the scroll event is delivered. Stale callbacks must not
    // discard the new source's protection against a subsequent incoming row.
    h.log.scrollTop = 160
    liveMessages.push({ id: 'replacement-new', sender: 'Controller', recipient: 'Manager',
      text: 'A new replacement-source message', at: '2026-09-08T00:01:00Z' })
    window.mcAgent.localMessages = async () => ({ ok: true, messages: liveMessages })
    await rePoll(); h.settle()
    assert.equal(h.view.el.dataset.projectionState, 'ready')
    assert.deepEqual(messageIds(), liveMessages.map(message => message.id))
    assert.equal(h.log.scrollTop, 160, 'stale source frames lost the new reader position')
    assert.equal(h.view.el.querySelector('.jump-chip').classList.contains('hidden'), false)
  } finally { window.mcAgent.localMessages = originalReader; h.close() }
})

test('T1245 a conversation that grows before its frame still settles at latest when our own scroll event arrives first', async () => {
  const h = await scrollingView()
  try {
    h.choose(h.idFor('Builder')); h.settle()
    h.choose(h.idFor('Controller'))
    // Its rows get taller after the first layout (a font or picture arrives),
    // then the browser delivers the scroll event our own render queued. That
    // event is not a reader scrolling up, so the next frame must still settle.
    h.grow(120)
    h.settle()
    h.latest()
  } finally { h.close() }
})

/* T1513. The page itself, over the owner journal's shape for two trees that
   each have a Manager and a Builder, with the trees saved on this computer: the
   conversation list, the rows and the Agent filter tell the two apart. */
test('Messages names same-named agents from different trees by their tree in the list, the rows and the Agent filter', async () => {
  const { FLEET } = await import('../../src/fleet-profile.js')
  const computerId = FLEET.machines[0].id
  const iso = m => new Date(Date.parse('2026-09-22T10:00:00Z') + m * 60000).toISOString()
  const node = (id, treeId, parentId, role, message) => ({ id, treeId, parentId, role, nameOrdinal: 1, message, status: 'finished',
    statusNote: '', reply: '', sessionId: `s-${id}`, tier: '', effort: '', createdAt: iso(0), updatedAt: iso(0) })
  const memory = new Map([[`mc.fleet.trees.v1:${computerId}`, JSON.stringify({ version: 1, computerId,
    trees: [{ id: 'tree-a', name: 'Invoice export', createdAt: iso(0), updatedAt: iso(0) }, { id: 'tree-b', name: 'Release notes', createdAt: iso(0), updatedAt: iso(0) }],
    nodes: [node('node-a-manager', 'tree-a', null, 'manager', 'Fix the invoice export.'), node('node-a-builder', 'tree-a', 'node-a-manager', 'builder', 'Build it.'),
      node('node-b-manager', 'tree-b', null, 'manager', 'Write the release notes.'), node('node-b-builder', 'tree-b', 'node-b-manager', 'builder', 'Draft them.')] })]])
  const hadStorage = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: key => memory.has(key) ? memory.get(key) : null, setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key) } })
  const side = (id, from, to, m, text) => ({ id, sender: from.split('-')[1][0].toUpperCase() + from.split('-')[1].slice(1), senderId: from, senderNodeKey: `node-${from}`,
    recipient: to.split('-')[1][0].toUpperCase() + to.split('-')[1].slice(1), recipientId: to, recipientNodeKey: `node-${to}`, text, at: iso(m) })
  liveMessages = [side('a1', 'a-manager', 'a-builder', 1, 'Fix the invoice export.'), side('b1', 'b-manager', 'b-builder', 2, 'Write the release notes.'),
    side('a2', 'a-builder', 'a-manager', 3, 'Export fixed.'), side('b2', 'b-builder', 'b-manager', 4, 'Notes drafted.')]
  const view = mountView()
  try {
    await flush()
    const names = Array.from(view.el.querySelectorAll('.ch')).map(row => row.querySelector('.ch-name').textContent)
    assert.deepEqual(names.slice(1).sort(), ['Builder ↔ Manager · Invoice export', 'Builder ↔ Manager · Release notes'])
    Array.from(view.el.querySelectorAll('.ch')).find(row => row.dataset.id === 'all').click()
    const authors = Array.from(view.el.querySelectorAll('.ch-log .cmsg-au')).map(node => node.textContent)
    assert.deepEqual(authors, ['Manager · Invoice export', 'Manager · Release notes', 'Builder · Invoice export', 'Builder · Release notes'])
    const options = Array.from(view.el.querySelectorAll('.comms-agent option')).map(option => option.value).filter(Boolean)
    assert.deepEqual(options, ['Builder · Invoice export', 'Builder · Release notes', 'Manager · Invoice export', 'Manager · Release notes'])
    const select = view.el.querySelector('.comms-agent')
    select.value = 'Manager · Release notes'; select.dispatch('change')
    assert.deepEqual(Array.from(view.el.querySelectorAll('.ch-log .cmsg')).map(row => row.dataset.msgId), ['b1', 'b2'], "one tree's Manager, not both")
  } finally {
    destroyView(view)
    if (hadStorage) Object.defineProperty(window, 'localStorage', hadStorage); else delete window.localStorage
  }
})
