/* THE AGENT BESIDE THE MENU.
 *
 * OWNER (T775, 2026-09-21): "in the popup we need to show the chat next to
 * the menu so the user knows what agent is being restarted."
 *
 * The Switch-and-continue dialog opens BY ITSELF when a saved account is
 * refused (src/views/computers.js offerSwitchAndContinue), so the person may
 * be reading another circle when it appears. Before this, the dialog was a
 * menu with no name and no words on it. These cases drive the dialog by value
 * through the same DOM stand-in the other dialog suites use:
 *   - the pane names the circle and draws its saved conversation through the
 *     chat's own "Saved conversation" renderer (src/node-transcript-history.js);
 *   - the pane is bound to the node the dialog was OPENED for, not to whatever
 *     the tree selects later;
 *   - a legacy store with no readPage still shows its held lines;
 *   - markStale() makes a changed session visible on the dialog and refuses
 *     Continue while "Not now" still closes it;
 *   - without a target the dialog is the single pane it always was;
 *   - the stylesheet lays the two panes side by side and stacks them narrow.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { switchChoices, mountSwitchAndContinueDialog } from '../../src/switch-and-continue.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { EFFORT_CHOICES, SWITCH_PANEL } from '../../src/fleet-tree-copy.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../../src')
const SESSION_TIER = LAUNCH_TIERS.find(tier => tier.provider === 'claude')?.id || LAUNCH_TIERS[0].id

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function choicesFor() {
  return switchChoices({ accounts: [{ name: 'other', provider: 'claude', signedIn: true }], tiers: LAUNCH_TIERS, efforts: EFFORT_CHOICES, currentTier: SESSION_TIER })
}

/* A store shaped like src/node-transcript-client.js: readPage(nodeId, before, limit)
   answers { entries, before }. It records every nodeId it was asked for. */
function pagedStore(byNode) {
  const asked = []
  return {
    asked,
    readPage: async (nodeId, before, limit) => {
      asked.push({ nodeId, before, limit })
      return { entries: byNode[nodeId] || [], before: null }
    },
  }
}

function mount(dom, extra = {}) {
  return mountSwitchAndContinueDialog({ document: dom.document, host: dom.document.body, choices: choicesFor(), tiers: LAUNCH_TIERS,
    current: { account: 'a', provider: 'claude', tier: SESSION_TIER, effort: null }, ...extra })
}

test('the dialog names the circle and draws its saved conversation beside the menu, through the chat renderer', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const store = pagedStore({ n1: [
      { who: 'you', text: 'please summarise the report', at: 1_700_000_000_000 },
      { who: 'agent', text: 'The report has **three** findings.', at: 1_700_000_001_000 },
    ] })
    const dialog = mount(dom, { target: { name: 'Worker 2', detail: 'worker · Claude Sonnet · account a' }, conversation: { store, nodeId: 'n1' } })
    assert.ok(dialog, 'the dialog mounts')
    assert.ok(dialog.root.classList.contains('switch-continue-with-target'), 'the two-pane class is on the dialog')
    await settle(); await settle()

    const pane = dialog.root.querySelector('[data-switch-target]')
    assert.ok(pane, 'the agent pane is drawn')
    assert.equal(dialog.root.querySelector('[data-switch-target-name]').textContent, 'Worker 2')
    assert.equal(dialog.root.querySelector('[data-switch-target-detail]').textContent, 'worker · Claude Sonnet · account a')
    assert.match(pane.textContent, /This agent/, 'the pane says whose it is in the product\'s words')

    const panes = dialog.root.querySelector('.switch-panes')
    assert.ok(panes, 'the panes wrapper exists')
    assert.equal(panes.children[0], pane, 'the agent pane comes first in reading order')
    assert.ok(panes.children[1]?.matches('[data-switch-menu]'), 'the menu is the second pane')

    const rows = pane.querySelectorAll('.saved-message')
    assert.equal(rows.length, 2, 'both saved lines are drawn')
    assert.equal(rows[0].querySelector('.saved-message-who').textContent, 'You')
    assert.equal(rows[1].querySelector('.saved-message-who').textContent, 'Agent')
    assert.match(rows[0].textContent, /please summarise the report/)
    assert.ok(rows[1].querySelector('.chat-message-body'), 'the agent line goes through the chat message body renderer')
    assert.doesNotMatch(rows[1].textContent, /\*\*/, 'markdown markers do not reach the glass')
    assert.deepEqual(store.asked.map(call => call.nodeId), ['n1'], 'exactly the target node was read')

    /* The menu is untouched by the pane: same rows, and the keyboard still
       lands on it. */
    assert.equal(dialog.root.querySelectorAll('[data-switch-model]').length, LAUNCH_TIERS.length)
    const keep = dialog.root.querySelector('[data-switch-account]')
    assert.ok(keep.hasAttribute('autofocus'), 'the keep-account row keeps the initial focus, not the conversation')
    assert.equal(dialog.target.name, 'Worker 2')
  } finally { dom.restore() }
})

test('the pane is bound to the node the dialog was opened for, whatever the tree selects afterwards', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const store = pagedStore({
      a: [{ who: 'you', text: 'A: build the index' }],
      b: [{ who: 'you', text: 'B: write the tests' }],
    })
    let selected = 'b'
    const opened = { name: 'Manager 6', nodeId: 'a' }
    const dialog = mount(dom, { target: { name: opened.name }, conversation: { store, nodeId: opened.nodeId } })
    await settle(); await settle()
    assert.deepEqual(store.asked.map(call => call.nodeId), ['a'], 'the dialog reads the node it was opened for, not the selection')
    assert.match(dialog.root.querySelector('[data-switch-target]').textContent, /A: build the index/)
    assert.doesNotMatch(dialog.root.querySelector('[data-switch-target]').textContent, /B: write the tests/)

    selected = 'c'
    await settle()
    assert.equal(selected, 'c')
    assert.equal(dialog.root.querySelector('[data-switch-target-name]').textContent, 'Manager 6', 'a later selection does not rename the pane')
    assert.deepEqual(store.asked.map(call => call.nodeId), ['a'], 'a later selection does not re-read another node')
  } finally { dom.restore() }
})

test('a legacy window-memory store with no readPage still shows its held lines, newest last', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const store = { get: nodeId => nodeId === 'n1' ? { lines: [{ who: 'you', text: 'first' }, { who: 'agent', text: 'second' }, { who: 'action', text: 'ran a tool', kind: 'tool' }] } : null }
    const dialog = mount(dom, { target: { name: 'Builder 5' }, conversation: { store, nodeId: 'n1' } })
    await settle()
    const rows = dialog.root.querySelectorAll('.saved-message')
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map(row => row.querySelector('.saved-message-who').textContent), ['You', 'Agent', 'Activity'])
    assert.match(rows[2].textContent, /ran a tool/)
  } finally { dom.restore() }
})

test('a circle with nothing saved still gets a named pane that says so', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const dialog = mount(dom, { target: { name: 'Builder 6' }, conversation: { store: { get: () => null }, nodeId: 'n9' } })
    await settle()
    const pane = dialog.root.querySelector('[data-switch-target]')
    assert.equal(dialog.root.querySelector('[data-switch-target-name]').textContent, 'Builder 6')
    assert.match(pane.textContent, new RegExp(SWITCH_PANEL.noConversation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(pane.querySelectorAll('.saved-message').length, 0)
  } finally { dom.restore() }
})

test('markStale refuses Continue and says why, while Not now still closes the dialog', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    let chosen = null, cancelled = 0
    const dialog = mount(dom, { target: { name: 'Worker 3' }, conversation: { store: pagedStore({ n1: [] }), nodeId: 'n1' },
      onChoose: value => { chosen = value }, onCancel: () => { cancelled += 1 } })
    await settle()
    const continueButton = dialog.root.querySelector('[data-switch-continue]')
    assert.equal(continueButton.disabled, false, 'Continue starts live')

    assert.equal(dialog.markStale(), true)
    assert.equal(continueButton.disabled, true, 'a changed session disables Continue')
    assert.equal(continueButton.getAttribute('aria-disabled'), 'true')
    assert.equal(dialog.root.dataset.switchStale, 'true')
    assert.equal(dialog.root.querySelector('[data-switch-cost]').textContent, SWITCH_PANEL.targetChanged, 'the sentence is the product\'s own')
    continueButton.click()
    assert.equal(chosen, null, 'a stale dialog cannot answer with a choice')
    assert.equal(dialog.markStale('again'), false, 'marking twice is a no-op')
    assert.equal(dialog.root.querySelector('[data-switch-cost]').textContent, SWITCH_PANEL.targetChanged, 'the first sentence stands')

    dialog.root.querySelector('[data-switch-cancel]').click()
    assert.equal(cancelled, 1, 'Not now still works on a stale dialog')
    assert.equal(dialog.root.isConnected, false, 'and the dialog leaves the document')
    assert.equal(dialog.markStale(), false, 'a closed dialog ignores a late report')
  } finally { dom.restore() }
})

test('a custom sentence reaches the dialog, and a target name is escaped like every other word on it', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const dialog = mount(dom, { target: { name: 'Worker <b>x</b>' }, conversation: null })
    assert.doesNotMatch(dialog.root.innerHTML, /<b>x<\/b>/, 'a name is text, never markup')
    dialog.markStale('This circle was removed.')
    assert.equal(dialog.root.querySelector('[data-switch-cost]').textContent, 'This circle was removed.')
  } finally { dom.restore() }
})

test('without a target the dialog is the single pane it always was', () => {
  const dom = installDomStandIn(globalThis)
  try {
    const dialog = mount(dom)
    assert.equal(dialog.root.querySelector('[data-switch-target]'), null)
    assert.equal(dialog.root.classList.contains('switch-continue-with-target'), false)
    assert.equal(dialog.target, null)
    assert.ok(dialog.root.querySelector('[data-switch-menu]'), 'the menu pane still wraps the rows')
    assert.equal(dialog.root.querySelectorAll('[data-switch-model]').length, LAUNCH_TIERS.length)
    assert.equal(typeof dialog.markStale, 'function', 'the caller may still report a changed session')
  } finally { dom.restore() }
})

test('closing the dialog hands the keyboard back to the chat that had it, whichever way it closes', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const composer = dom.document.createElement('textarea')
    composer.value = 'a draft the person was typing'
    dom.document.body.appendChild(composer)
    composer.focus()
    assert.equal(dom.document.activeElement, composer)

    const first = mount(dom, { target: { name: 'Worker 1' }, conversation: { store: pagedStore({ n1: [] }), nodeId: 'n1' } })
    first.root.querySelector('[data-switch-continue]').focus()
    assert.notEqual(dom.document.activeElement, composer, 'the dialog took the keyboard while open')
    first.root.querySelector('[data-switch-cancel]').click()
    assert.equal(dom.document.activeElement, composer, 'Not now gives the composer its focus back')
    assert.equal(composer.value, 'a draft the person was typing', 'and never touches the draft')

    composer.focus()
    let chosen = null
    const second = mount(dom, { target: { name: 'Worker 1' }, conversation: { store: pagedStore({ n1: [] }), nodeId: 'n1' }, onChoose: value => { chosen = value } })
    second.root.querySelector('[data-switch-continue]').focus()
    second.root.querySelector('[data-switch-continue]').click()
    assert.ok(chosen, 'Continue answered')
    assert.equal(dom.document.activeElement, composer, 'Continue gives the composer its focus back too')
    assert.equal(composer.value, 'a draft the person was typing')
  } finally { dom.restore() }
})

/* THE BINDING IN THE VIEW, BY SOURCE. src/views/computers.js offerSwitchAndContinue
   is the one caller that opens this dialog on its own. This reads that function
   and asserts the shape the owner asked for: the target's ids are copied out at
   open (not read through the mutable node later), the same frozen target is
   re-checked on Continue and on every status notification, the dialog is told
   when the target moved on, and the listener is released with the dialog. */
test('offerSwitchAndContinue freezes its target at open, names it, draws its conversation and marks the dialog stale when it moves on', () => {
  const source = fs.readFileSync(path.join(SRC, 'views/computers.js'), 'utf8')
  const start = source.indexOf('async function offerSwitchAndContinue(')
  assert.notEqual(start, -1, 'offerSwitchAndContinue must still exist in the view')
  const end = source.indexOf('\n  async function resumeNodeSession(', start)
  assert.notEqual(end, -1, 'the function is followed by resumeNodeSession, which bounds this read')
  const fn = source.slice(start, end)
  assert.match(fn, /const target = Object\.freeze\(\{ nodeId: current\.id, sessionId: current\.sessionId \?\? null \}\)/, 'the target ids are copied out at open')
  assert.match(fn, /const targetCurrent = \(\) => \{/, 'one re-check serves every later decision')
  assert.match(fn, /store\?\.getNode\(target\.nodeId\)/, 'the re-check reads the store by the frozen id')
  assert.match(fn, /\(live\.sessionId \?\? null\) === target\.sessionId/, 'and compares the frozen session, not the node reference')
  assert.match(fn, /onChoose: choice => \{\s*settle\(\)\s*const live = targetCurrent\(\)\s*if \(!live\) \{ setOrgStatus\(SWITCH_PANEL\.targetChanged/, 'Continue re-validates the same target and says so when it changed')
  assert.match(fn, /target: \{ name: treeNodeName\(current\), detail: targetDetail \}/, 'the dialog is told the circle\'s own name')
  assert.match(fn, /conversation: transcriptStore \? \{ store: transcriptStore, nodeId: target\.nodeId \} : null/, 'the conversation is the chat\'s own store, bound to the frozen id')
  /* M11 review of T775, finding F3: the listener is NOT released when the
     target moves on. A stale dialog is still a body-level modal, and only a
     listener that is still registered can take it down when the view is
     destroyed or its store replaced afterwards. The one release is settle(),
     through the dialog's own close. */
  const listener = fn.slice(fn.indexOf('unsubscribe = registerNodeStatusListener(target.nodeId'), fn.indexOf('return dialog', fn.indexOf('unsubscribe = registerNodeStatusListener(target.nodeId')))
  assert.match(listener, /^unsubscribe = registerNodeStatusListener\(target\.nodeId, \(\) => \{\s*if \(destroyed \|\| treeStore !== store\) \{ dialog\.dispose\(\); return \}\s*if \(targetCurrent\(\)\) return\s*dialog\.markStale\(SWITCH_PANEL\.targetChanged\)\s*\}\)\s*$/, 'a destroyed view or replaced store disposes the dialog; a moved-on target marks it stale; nothing else happens in the listener')
  assert.doesNotMatch(listener, /unsubscribe\(\)/, 'going stale releases nothing: the listener stays registered until the dialog closes')
  assert.match(fn, /onClose: settle,/, 'every exit path releases the slot and listener through the dialog\'s single exit')
  assert.match(fn, /const settle = \(\) => \{ unsubscribe\(\); unsubscribe = \(\) => \{\}; switchDialogs\.delete\(target\.nodeId\) \}/, 'Continue and Not now both release the listener and the per-circle slot')
  assert.match(fn, /onCancel: settle,/)
  assert.doesNotMatch(fn, /switchDialogs\.delete\(current\.id\)/, 'no path keys the slot by the mutable node any more')
})

/* THE BINDING IN THE VIEW, BY EXECUTION. The same offerSwitchAndContinue is
   sliced out of computers.js and RUN in a vm context with every collaborator it
   names replaced by a recorder, the way the recovery suites drive their view
   functions. This is the proof the source-pattern case above cannot give: the
   dialog really receives the circle's name and the transcript store bound to
   the frozen node id; a status notification after the session changed really
   marks it stale and releases the listener; Continue after that change really
   refuses with the product's sentence and starts nothing; Not now really
   releases the listener and the per-circle slot. */
function callerFixture({ sessionId = 'session-1' } = {}) {
  const source = fs.readFileSync(path.join(SRC, 'views/computers.js'), 'utf8')
  const record = { dialogs: [], listeners: [], released: 0, status: [], continued: [], queued: [], stale: [] }
  let node = { id: 'node-7', sessionId, tier: 'claude-sonnet', role: 'worker', effort: '' }
  const store = { getNode: id => (id === node.id ? node : null) }
  const transcriptStore = { get: () => ({ account: 'a', provider: 'claude', effort: 'medium', lines: [] }), readPage: async () => ({ entries: [], before: null }) }
  const context = vm.createContext({
    destroyed: false, document: { body: {} }, window: {}, mockSource: () => false, treeStore: store, transcriptStore,
    switchDialogs: new Map(), loadAccounts: async () => ({ accounts: [] }), readStartableTiers: async () => ({ answered: true, tiers: ['claude-sonnet'] }),
    setOrgStatus: (sentence, kind, options) => { record.status.push({ sentence, kind, options }) },
    LAUNCH_TIERS: [{ id: 'claude-sonnet', label: 'Claude Sonnet', provider: 'claude' }], EFFORT_CHOICES: [],
    savedSessionEffort: () => 'medium', sessionEfforts: new Map(), tierEffortOf: () => 'medium',
    switchChoices: () => ({ accounts: [], models: [], efforts: [] }), SWITCH_PANEL,
    /* The stub keeps the real dialog's contract: markStale writes the sentence
       once and answers false after that or after close; dispose closes once,
       through onClose. */
    mountSwitchAndContinueDialog: options => {
      const dialog = { options, disposed: false, stale: false,
        markStale(sentence) { if (dialog.disposed || dialog.stale) return false; dialog.stale = true; record.stale.push(sentence); return true },
        dispose() { if (dialog.disposed) return; dialog.disposed = true; options.onClose?.() },
        close() { dialog.dispose() } }
      record.dialogs.push(dialog)
      return dialog
    },
    nodeBusy: () => false, pendingModelChoice: () => null, queueModelChoice: (...args) => { record.queued.push(args) },
    continueNodeWithChoice: (live, choice) => { record.continued.push({ nodeId: live.id, sessionId: live.sessionId, choice }); return Promise.resolve(true) },
    statusSink: () => ({ textContent: '' }), treeNodeName: n => `Worker ${n.id}`, roleLabel: role => role, roleDisplayFor: role => role,
    /* The real registration removes the listener on release, so a released
       listener never hears a later notification; the recorder does the same. */
    registerNodeStatusListener: (nodeId, listener) => {
      const entry = { nodeId, listener }
      record.listeners.push(entry)
      return () => { record.released += 1; record.listeners = record.listeners.filter(held => held !== entry) }
    },
  })
  vm.runInContext(declaredFunctionSource(source, 'offerSwitchAndContinue'), context)
  return { record, context, node: () => node, replaceSession: next => { node = { ...node, sessionId: next } },
    open: () => context.offerSwitchAndContinue(node, { sentence: 'The account said no.', refusedAccount: 'a' }),
    notify: () => { for (const { listener } of record.listeners) listener() } }
}

test('the view hands the dialog the frozen circle and its transcript store, and watches that circle through the status listener', async () => {
  const f = callerFixture()
  const dialog = await f.open()
  assert.ok(dialog, 'the dialog opened')
  assert.equal(f.record.dialogs.length, 1)
  const { options } = f.record.dialogs[0]
  /* Copied out of the vm realm before comparing: assert/strict compares
     prototypes, and the object was built in the context. */
  assert.deepEqual({ ...options.target }, { name: 'Worker node-7', detail: 'worker · Claude Sonnet · account a' })
  assert.equal(options.conversation.store, f.context.transcriptStore, 'the chat\'s own store, not a copy')
  assert.equal(options.conversation.nodeId, 'node-7')
  assert.equal(options.refusalSentence, 'The account said no.')
  assert.deepEqual(f.record.listeners.map(entry => entry.nodeId), ['node-7'], 'one listener, on the frozen node id')
  assert.equal(f.context.switchDialogs.get('node-7'), dialog, 'the per-circle slot is keyed by the frozen id')

  f.notify()
  assert.deepEqual(f.record.stale, [], 'an unchanged session is not stale')
  assert.equal(f.record.released, 0)

  options.onChoose({ account: 'a', provider: 'claude', tier: 'claude-sonnet', effort: 'high', route: 'resume' })
  assert.equal(f.record.continued.length, 1, 'Continue on the live target continues it')
  assert.equal(f.record.continued[0].sessionId, 'session-1')
  assert.equal(f.record.released, 1, 'and releases the listener')
  assert.equal(f.context.switchDialogs.has('node-7'), false, 'and the slot')
})

test('a session change after opening makes the dialog stale, and Continue on that stale target starts nothing', async () => {
  const f = callerFixture()
  await f.open()
  const { options } = f.record.dialogs[0]
  f.replaceSession('session-2')
  f.notify()
  assert.deepEqual(f.record.stale, [SWITCH_PANEL.targetChanged], 'the dialog is told, in the product\'s sentence')
  assert.equal(f.record.released, 0, 'the listener stays registered: the stale modal still needs taking down if the view goes away (M11 F3)')
  assert.equal(f.record.listeners.length, 1)
  f.notify()
  assert.deepEqual(f.record.stale, [SWITCH_PANEL.targetChanged], 'a later notification cannot mark it twice')
  assert.equal(f.record.released, 0)

  options.onChoose({ account: 'a', provider: 'claude', tier: 'claude-sonnet', effort: 'high', route: 'resume' })
  assert.deepEqual(f.record.continued, [], 'nothing continues on a changed session')
  assert.deepEqual(f.record.queued, [], 'nothing is queued either')
  assert.equal(f.record.status.at(-1)?.sentence, SWITCH_PANEL.targetChanged, 'Continue says why instead of going silent')
  assert.equal(f.context.switchDialogs.has('node-7'), false)
  assert.equal(f.record.released, 1, 'Continue is the release, once')
  assert.deepEqual(f.record.listeners, [], 'and the listener is gone')
})

/* M11 review of T775, finding F3, the two sequences that were not covered: a
   dialog that has ALREADY gone stale, and only then the view is destroyed or
   its store replaced. The stale modal must still come down, its slot and its
   listener must still be released -- and exactly once. */
test('a dialog that went stale is still taken down when the view is destroyed afterwards, releasing slot and listener once', async () => {
  const f = callerFixture()
  const dialog = await f.open()
  f.replaceSession('session-2')
  f.notify()
  assert.equal(dialog.stale, true, 'the dialog is stale')
  assert.equal(dialog.disposed, false, 'and still up')
  assert.equal(f.record.released, 0, 'with its listener still registered')
  assert.equal(f.context.switchDialogs.get('node-7'), dialog, 'and its slot still held')

  f.context.destroyed = true
  f.notify()
  assert.equal(dialog.disposed, true, 'the destroyed view disposes the stale modal')
  assert.equal(f.record.released, 1, 'the listener is released once')
  assert.deepEqual(f.record.listeners, [], 'and is gone')
  assert.equal(f.context.switchDialogs.has('node-7'), false, 'the per-circle slot is released')
  assert.deepEqual(f.record.stale, [SWITCH_PANEL.targetChanged], 'the stale sentence was written once and never again')

  f.notify()
  dialog.dispose()
  assert.equal(f.record.released, 1, 'nothing releases twice')
})

test('a dialog that went stale is still taken down when the store is replaced afterwards, releasing slot and listener once', async () => {
  const f = callerFixture()
  const dialog = await f.open()
  f.replaceSession('session-2')
  f.notify()
  assert.equal(dialog.stale, true)
  assert.equal(f.record.released, 0)

  f.context.treeStore = { getNode: () => null }
  f.notify()
  assert.equal(dialog.disposed, true, 'another computer\'s page disposes the stale modal')
  assert.equal(f.record.released, 1, 'the listener is released once')
  assert.deepEqual(f.record.listeners, [])
  assert.equal(f.context.switchDialogs.has('node-7'), false)

  f.notify()
  dialog.close()
  assert.equal(f.record.released, 1, 'nothing releases twice')
})

/* The same two sequences through the REAL dialog in the DOM stand-in (the
   shape of M11's lifecycle probe, evidence/T775-v2-M11-lifecycle-probe.json):
   the extracted caller drives mountSwitchAndContinueDialog itself, so what is
   checked is the body-level modal coming off the document, not a stub's flag. */
test('through the real dialog: a stale modal is off the document once the view is destroyed or its store replaced', async () => {
  for (const leave of ['destroy', 'replace-store']) {
    const dom = installDomStandIn(globalThis)
    try {
      const f = callerFixture()
      f.context.document = dom.document
      f.context.mountSwitchAndContinueDialog = options => mountSwitchAndContinueDialog(options)
      const dialog = await f.open()
      f.replaceSession('session-2')
      f.notify()
      assert.equal(dialog.root.isConnected, true, `${leave}: the stale dialog is still on the document`)
      assert.equal(dialog.root.dataset.switchStale, 'true', `${leave}: and says the target moved on`)
      assert.equal(f.record.listeners.length, 1, `${leave}: its listener is still registered`)

      if (leave === 'destroy') f.context.destroyed = true
      else f.context.treeStore = { getNode: () => null }
      f.notify()
      assert.equal(dialog.root.isConnected, false, `${leave}: the modal is off the document`)
      assert.equal(dialog.isClosed(), true, `${leave}: and closed`)
      assert.equal(f.context.switchDialogs.has('node-7'), false, `${leave}: the slot is released`)
      assert.equal(f.record.listeners.length, 0, `${leave}: and the listener`)
      assert.equal(f.record.released, 1, `${leave}: once`)
      dialog.dispose()
      assert.equal(f.record.released, 1, `${leave}: a later dispose releases nothing twice`)
    } finally { dom.restore() }
  }
})

test('a session change that lands only at Continue is caught there too, without the listener', async () => {
  const f = callerFixture()
  await f.open()
  const { options } = f.record.dialogs[0]
  f.replaceSession('session-2')
  options.onChoose({ account: 'a', provider: 'claude', tier: 'claude-sonnet', effort: 'high', route: 'resume' })
  assert.deepEqual(f.record.continued, [])
  assert.equal(f.record.status.at(-1)?.sentence, SWITCH_PANEL.targetChanged)
  assert.equal(f.record.released, 1, 'Continue releases the listener whether or not it fired')
})

test('Not now releases the listener and the per-circle slot; a circle with no transcript store still gets its name', async () => {
  const f = callerFixture()
  await f.open()
  f.record.dialogs[0].options.onCancel()
  assert.equal(f.record.released, 1)
  assert.equal(f.context.switchDialogs.has('node-7'), false)
  const again = await f.open()
  assert.ok(again, 'the circle can be asked again after Not now')
  assert.equal(f.record.dialogs.length, 2)

  const bare = callerFixture()
  bare.context.transcriptStore = null
  await bare.open()
  assert.equal(bare.record.dialogs[0].options.conversation, null, 'no store, no conversation pane -- never an invented one')
  assert.equal(bare.record.dialogs[0].options.target.name, 'Worker node-7', 'the name is still there')
})

test('the stylesheet puts the conversation beside the menu and stacks the two on a narrow window', () => {
  const css = fs.readFileSync(path.join(SRC, 'switch-and-continue.css'), 'utf8')
  const rule = selector => {
    const at = css.indexOf(selector)
    assert.notEqual(at, -1, `${selector} must be styled`)
    return css.slice(at, css.indexOf('}', at))
  }
  assert.match(rule('.switch-continue-with-target .switch-panes'), /grid-template-columns:\s*minmax\([^)]*\)\s+minmax\(/, 'two columns side by side with a target')
  assert.match(rule('.switch-target-chat {'), /overflow:\s*auto/, 'the conversation scrolls inside its pane')
  assert.match(rule('.switch-target-chat {'), /max-height/, 'the conversation cannot push Continue out of reach')
  const narrow = css.slice(css.indexOf('@media (max-width: 720px)'))
  assert.notEqual(narrow.length, css.length, 'a narrow-window rule exists')
  assert.match(narrow, /\.switch-continue-with-target \.switch-panes \{ grid-template-columns: minmax\(0, 1fr\); \}/, 'one column when narrow')
  assert.match(rule('dialog.switch-continue.switch-continue-with-target'), /min\(960px, calc\(100vw \/ var\(--zoom, 1\) - 32px\)\)/, 'the wider dialog still fits the window at every zoom')
})

/* ---- M11 review (T775, 2026-09-21): three changes required ----
 * (1) the PANE (.switch-target-chat, overflow: auto) is the scrollport, not
 *     the renderer's entries list -- scroll it after render, fenced by close;
 * (2) the stale reason on the cost line must survive a later account, model
 *     or depth change, with Continue still refused;
 * (3) a view that is destroyed must take its body-level modal with it, and
 *     every exit path -- the returned close() included -- must release the
 *     caller's slot and listener; a late page read cannot paint into it. */

test('the newest reply is scrolled into view on the pane itself, on both render paths, and not after close', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const paged = mount(dom, { target: { name: 'Worker 4' }, conversation: { store: pagedStore({ n1: [{ who: 'agent', text: 'latest' }] }), nodeId: 'n1' } })
    const pane = paged.root.querySelector('[data-switch-target-chat]')
    assert.ok(pane.classList.contains('switch-target-chat'), 'the pane is the element the stylesheet lets scroll')
    pane.scrollHeight = 480
    await settle(); await settle()
    assert.equal(pane.scrollTop, 480, 'the pane, not the inner list, is scrolled to its end after the page renders')
    const entries = pane.querySelector('.node-transcript-history-entries')
    assert.equal(entries.scrollTop, 0, 'the overflow: visible entries list is left alone')
    paged.dispose()

    const legacy = mount(dom, { target: { name: 'Worker 5' }, conversation: { store: { get: () => ({ lines: [{ who: 'agent', text: 'held' }] }) }, nodeId: 'n2' } })
    const legacyPane = legacy.root.querySelector('[data-switch-target-chat]')
    legacyPane.scrollHeight = 360
    await settle()
    assert.equal(legacyPane.scrollTop, 360, 'the legacy path scrolls the same pane')
    legacy.dispose()

    const closedEarly = mount(dom, { target: { name: 'Worker 6' }, conversation: { store: pagedStore({ n3: [{ who: 'agent', text: 'late' }] }), nodeId: 'n3' } })
    const closedPane = closedEarly.root.querySelector('[data-switch-target-chat]')
    closedPane.scrollHeight = 900
    closedEarly.root.querySelector('[data-switch-cancel]').click()
    await settle(); await settle()
    assert.equal(closedPane.scrollTop, 0, 'a dialog closed before its page lands is not scrolled by the late timer')
  } finally { dom.restore() }
})

test('the stale reason and the refused Continue survive later account, model and depth changes', () => {
  const dom = installDomStandIn(globalThis)
  try {
    let chosen = null
    const dialog = mount(dom, { target: { name: 'Worker 7' }, onChoose: value => { chosen = value } })
    dialog.markStale()
    const cost = () => dialog.root.querySelector('[data-switch-cost]').textContent
    const pick = selector => { const input = dialog.root.querySelectorAll(selector).find(row => !row.disabled && !row.checked); assert.ok(input, selector); input.checked = true; input.dispatch('change') }
    pick('[data-switch-account]')
    assert.equal(cost(), SWITCH_PANEL.targetChanged, 'an account change does not paint a cost over the stale reason')
    pick('[data-switch-model]')
    assert.equal(cost(), SWITCH_PANEL.targetChanged, 'nor does a model change')
    pick('[data-switch-effort]')
    assert.equal(cost(), SWITCH_PANEL.targetChanged, 'nor does a depth change')
    const button = dialog.root.querySelector('[data-switch-continue]')
    assert.equal(button.disabled, true, 'Continue stays refused through those changes')
    button.click()
    assert.equal(chosen, null)
    assert.equal(dialog.readChoice().account, 'other', 'the picks themselves are still read back honestly')
  } finally { dom.restore() }
})

test('onClose fires exactly once for every exit path, dispose is idempotent, and a late page read cannot paint or resurrect', async () => {
  const dom = installDomStandIn(globalThis)
  try {
    const exits = { choose: 0, cancel: 0, close: 0 }
    const count = () => ({ onClose: () => { exits.close += 1 }, onChoose: () => { exits.choose += 1 }, onCancel: () => { exits.cancel += 1 } })

    const byContinue = mount(dom, { target: { name: 'W' }, ...count() })
    byContinue.root.querySelector('[data-switch-continue]').click()
    assert.deepEqual(exits, { choose: 1, cancel: 0, close: 1 }, 'Continue: one onClose, then onChoose')
    byContinue.close(); byContinue.dispose()
    assert.equal(exits.close, 1, 'a later close() or dispose() is a no-op')

    const byCancel = mount(dom, { target: { name: 'W' }, ...count() })
    byCancel.root.querySelector('[data-switch-cancel]').click()
    assert.deepEqual(exits, { choose: 1, cancel: 1, close: 2 }, 'Not now: one onClose, then onCancel')

    const byEscape = mount(dom, { target: { name: 'W' }, ...count() })
    byEscape.root.dispatch('cancel')
    assert.deepEqual(exits, { choose: 1, cancel: 2, close: 3 }, 'Escape: one onClose, then onCancel')

    const byClose = mount(dom, { target: { name: 'W' }, ...count() })
    byClose.close()
    assert.deepEqual(exits, { choose: 1, cancel: 2, close: 4 }, 'the returned close() releases the caller too')
    assert.equal(byClose.root.isConnected, false)
    assert.equal(byClose.isClosed(), true)

    /* A page read still in flight when the owner disposes the dialog lands
       on a section that is no longer in the document: nothing is painted
       and nothing comes back on screen. */
    let release
    const late = { readPage: () => new Promise(resolve => { release = resolve }) }
    const disposed = mount(dom, { target: { name: 'W' }, conversation: { store: late, nodeId: 'n9' }, ...count() })
    disposed.dispose(); disposed.dispose()
    assert.deepEqual(exits, { choose: 1, cancel: 2, close: 5 }, 'dispose is one onClose, however often it is called')
    assert.equal(disposed.root.isConnected, false, 'the modal left the document')
    release({ entries: [{ who: 'agent', text: 'too late' }], before: null })
    await settle(); await settle()
    assert.equal(disposed.root.querySelectorAll('.saved-message').length, 0, 'the late page painted nothing')
    assert.equal(dom.document.body.querySelector('dialog'), null, 'and nothing was put back on screen')
  } finally { dom.restore() }
})

test('a destroyed Computers view takes its modal down and releases the slot and listener; the returned close() releases them too', async () => {
  const f = callerFixture()
  const dialog = await f.open()
  f.context.destroyed = true
  f.notify()
  assert.equal(dialog.disposed, true, 'the view going away disposes the dialog rather than leaving a stale modal over the next view')
  assert.equal(f.record.released, 1, 'the listener is released')
  assert.equal(f.context.switchDialogs.has('node-7'), false, 'and the per-circle slot')

  const g = callerFixture()
  const second = await g.open()
  second.close()
  assert.equal(g.record.released, 1, 'a close() from any caller releases the listener through onClose')
  assert.equal(g.context.switchDialogs.has('node-7'), false, 'and the slot')
  g.notify()
  assert.deepEqual(g.record.stale, [], 'nothing is marked stale after release')

  const h = callerFixture()
  const third = await h.open()
  h.context.treeStore = { getNode: () => null }
  h.notify()
  assert.equal(third.disposed, true, 'a replaced store (another computer\'s page) disposes the modal as well')
})
