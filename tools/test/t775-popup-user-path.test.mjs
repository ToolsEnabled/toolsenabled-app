import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { mountSwitchAndContinueDialog, switchChoices } from '../../src/switch-and-continue.js'
import { SWITCH_PANEL } from '../../src/fleet-tree-copy.js'

// T775: exercise the current caller and real dialog together across the account/
// catalog await and across successive targets. This is DOM-stand-in coverage,
// not native modal focus, layout, provider custody, or real-user acceptance.
const source = fs.readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t, { readPage, callerSource = source } = {}) {
  let context = null
  const dom = installDomStandIn(globalThis)
  // Register before any fallible setup; disposal failure must also restore globals.
  t.after(() => {
    try {
      for (const dialog of [...(context?.switchDialogs.values() || [])]) dialog.dispose()
    } finally {
      dom.restore()
    }
  })
  const accounts = deferred(), catalog = deferred()
  const nodes = new Map([
    ['target-a', { id: 'target-a', name: 'Alpha', sessionId: 'session-a', role: 'worker', tier: 'luna' }],
    ['target-b', { id: 'target-b', name: 'Beta', sessionId: 'session-b', role: 'worker', tier: 'luna' }],
  ])
  const calls = { reads: [], status: [], continued: [], listeners: new Set(), accountReads: 0, catalogReads: 0 }
  const transcriptStore = {
    get: id => ({ account: 'fixture-account', provider: 'codex', effort: 'max', lines: [{ who: 'you', text: id + ' saved question' }] }),
    readPage: (...args) => {
      calls.reads.push(args)
      return readPage ? readPage(...args) : Promise.resolve({ entries: [{ who: 'you', text: args[0] + ' saved question' }], before: null })
    },
  }
  context = vm.createContext({
    destroyed: false, document: dom.document, window: {}, mockSource: () => false,
    treeStore: { getNode: id => nodes.get(id) || null }, transcriptStore,
    switchDialogs: new Map(),
    loadAccounts: () => { calls.accountReads++; return accounts.promise },
    readStartableTiers: () => { calls.catalogReads++; return catalog.promise },
    LAUNCH_TIERS: [{ id: 'luna', provider: 'codex', label: 'Luna' }], EFFORT_CHOICES: [],
    savedSessionEffort: () => 'max', sessionEfforts: new Map(), tierEffortOf: () => 'max',
    switchChoices, mountSwitchAndContinueDialog, SWITCH_PANEL,
    treeNodeName: node => node.name, roleLabel: role => role, roleDisplayFor: role => role,
    nodeBusy: () => false, pendingModelChoice: () => null,
    queueModelChoice: () => { throw new Error('Idle fixture must not queue a continuation') },
    statusSink: () => ({}),
    continueNodeWithChoice: (node, choice) => { calls.continued.push({ nodeId: node.id, sessionId: node.sessionId, choice }) },
    setOrgStatus: (sentence, kind, options) => { calls.status.push({ sentence, kind, options }) },
    registerNodeStatusListener: (nodeId, listener) => {
      const entry = { nodeId, listener }
      calls.listeners.add(entry)
      return () => calls.listeners.delete(entry)
    },
  })
  vm.runInContext(declaredFunctionSource(callerSource, 'offerSwitchAndContinue'), context)
  return {
    dom, nodes, calls, context,
    open: id => context.offerSwitchAndContinue(nodes.get(id), { sentence: 'Fixture account refused.' }),
    ready: (answer = { answered: true, tiers: ['luna'] }) => {
      accounts.resolve({ accounts: [] })
      catalog.resolve(answer)
    },
  }
}

for (const change of ['session-replaced', 'target-removed', 'store-replaced', 'view-destroyed']) {
  test('T775 pending popup does not open after ' + change, async t => {
    const f = fixture(t)
    const opening = f.open('target-a')
    assert.equal(f.calls.accountReads, 1)
    assert.equal(f.calls.catalogReads, 1)
    assert.equal(f.dom.document.body.querySelector('dialog'), null, 'no premature popup')
    if (change === 'session-replaced') f.nodes.set('target-a', { ...f.nodes.get('target-a'), sessionId: 'replacement-a' })
    if (change === 'target-removed') f.nodes.delete('target-a')
    if (change === 'store-replaced') f.context.treeStore = { getNode: id => f.nodes.get(id) }
    if (change === 'view-destroyed') f.context.destroyed = true
    f.ready()
    const result = await opening
    process.stderr.write('T775_STAGE pre-assert case=' + change + '\n')
    assert.equal(result === null, true, 'the old open request cannot target current state')
    assert.equal(f.dom.document.body.querySelector('dialog'), null)
    assert.equal(f.calls.reads.length, 0, 'no conversation is fetched for the obsolete open')
    assert.equal(f.calls.listeners.size, 0)
    assert.equal(f.context.switchDialogs.size, 0)
    assert.equal(f.calls.continued.length, 0)
  })
}

test('T775 concurrent opens for one target settle to one dialog and one lifecycle listener', async t => {
  const f = fixture(t)
  const first = f.open('target-a'), second = f.open('target-a')
  f.ready()
  const [one, two] = await Promise.all([first, second])
  await tick()
  assert.equal(one, two, 'both callers receive the same live dialog')
  assert.equal(f.dom.document.body.querySelectorAll('dialog').length, 1)
  assert.equal(f.calls.listeners.size, 1)
  assert.deepEqual(f.calls.reads.map(([id]) => id), ['target-a'])
  one.root.querySelector('[data-switch-continue]').click()
  assert.equal(f.calls.continued.length, 1, 'one click continues once')
  assert.equal(f.calls.continued[0].nodeId, 'target-a')
  assert.equal(f.calls.continued[0].sessionId, 'session-a')
  assert.equal(f.context.switchDialogs.size, 0)
  assert.equal(f.calls.listeners.size, 0)
})

test('T775 unanswered model catalog gives a visible refusal and reads no target transcript', async t => {
  const f = fixture(t)
  const opening = f.open('target-a')
  f.ready({ answered: false, tiers: [] })
  assert.equal(await opening, null)
  assert.equal(f.calls.status.length, 1)
  assert.match(f.calls.status[0].sentence, /available models could not be confirmed/i)
  assert.equal(f.calls.status[0].kind, 'refuse')
  assert.equal(f.calls.status[0].options.sticky, true)
  assert.equal(f.calls.reads.length, 0)
  assert.equal(f.calls.continued.length, 0)
})

test('T775 late conversation for closed Alpha cannot replace Beta or alter the selected chat draft and scroll', async t => {
  const alpha = deferred()
  const f = fixture(t, { readPage: id => id === 'target-a' ? alpha.promise : Promise.resolve({
    entries: [{ who: 'you', text: 'Beta saved question' }], before: null,
  }) })
  const log = f.dom.document.createElement('div')
  log.scrollHeight = 1200
  log.scrollTop = 247
  const composer = f.dom.document.createElement('textarea')
  composer.value = 'Unsent selected-chat draft'
  composer.selectionStart = 7
  composer.selectionEnd = 15
  f.dom.document.body.append(log, composer)
  composer.focus()
  f.ready()
  const first = await f.open('target-a')
  const firstPane = first.root.querySelector('[data-switch-target-chat]')
  firstPane.scrollHeight = 700
  first.root.querySelector('[data-switch-cancel]').focus()
  first.root.dispatch('cancel')
  assert.equal(f.dom.document.activeElement, composer, 'Escape restores the opener')

  const second = await f.open('target-b')
  await tick(); await tick()
  const secondPane = second.root.querySelector('[data-switch-target-chat]')
  secondPane.scrollTop = 91
  second.root.querySelector('[data-switch-cancel]').focus()
  alpha.resolve({ entries: [{ who: 'you', text: 'Alpha late private-to-target question' }], before: null })
  await tick(); await tick()
  assert.equal(first.root.isConnected, false)
  assert.equal(firstPane.querySelectorAll('.saved-message').length, 0, 'closed Alpha does not paint')
  assert.equal(firstPane.scrollTop, 0, 'closed Alpha does not scroll')
  assert.equal(second.root.querySelector('[data-switch-target-name]').textContent, 'Beta')
  assert.match(secondPane.textContent, /Beta saved question/)
  assert.doesNotMatch(secondPane.textContent, /Alpha/)
  assert.equal(secondPane.scrollTop, 91, 'old target completion does not move the new preview')
  assert.deepEqual(f.calls.reads.map(([id]) => id), ['target-a', 'target-b'])
  second.root.dispatch('cancel')
  assert.equal(f.dom.document.activeElement, composer)
  assert.equal(composer.value, 'Unsent selected-chat draft')
  assert.equal(composer.selectionStart, 7)
  assert.equal(composer.selectionEnd, 15)
  assert.equal(log.scrollTop, 247, 'selected chat viewport remains where the person left it')
  assert.equal(f.calls.continued.length, 0)
  assert.equal(f.calls.listeners.size, 0)
})

test('T775 failed target transcript read names the failure without substituting another conversation', async t => {
  const f = fixture(t, { readPage: async () => { throw new Error('fixture read unavailable') } })
  f.ready()
  const dialog = await f.open('target-a')
  await tick()
  const pane = dialog.root.querySelector('[data-switch-target-chat]')
  assert.equal(dialog.root.querySelector('[data-switch-target-name]').textContent, 'Alpha')
  assert.match(pane.textContent, /Saved conversation could not be read: fixture read unavailable/)
  assert.equal(pane.querySelectorAll('.saved-message').length, 0)
  assert.deepEqual(f.calls.reads.map(([id]) => id), ['target-a'])
  dialog.root.querySelector('[data-switch-cancel]').click()
  assert.equal(f.calls.continued.length, 0)
  assert.equal(f.calls.listeners.size, 0)
})

// A backup hook isolates these intentional error probes even if the fixture regresses.
function preserveGlobalDescriptors(t) {
  const keys = ['document', 'window', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
  const current = () => keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  const original = current()
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  return { original, current }
}

test('T775 fixture registers restoration before a missing caller declaration refuses setup', t => {
  const globals = preserveGlobalDescriptors(t)
  let cleanup
  assert.throws(() => fixture({ after: callback => { cleanup = callback } }, { callerSource: '' }),
    /Expected one declaration of offerSwitchAndContinue, found 0/)
  assert.equal(typeof cleanup, 'function', 'setup refusal must leave a registered restore hook')
  cleanup()
  assert.deepEqual(globals.current(), globals.original, 'all six original descriptors are restored')
})

test('T775 fixture restores all globals when dialog disposal throws and preserves that error', t => {
  const globals = preserveGlobalDescriptors(t)
  let cleanup
  const f = fixture({ after: callback => { cleanup = callback } })
  const refusal = new Error('fixture disposal refused')
  f.context.switchDialogs.set('failed-disposal', { dispose() { throw refusal } })
  assert.throws(() => cleanup(), error => error === refusal, 'the disposal error remains observable')
  assert.deepEqual(globals.current(), globals.original, 'disposal failure cannot strand six DOM globals')
})
