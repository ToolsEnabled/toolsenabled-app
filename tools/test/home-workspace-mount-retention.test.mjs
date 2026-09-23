/* THE AGENT WORKSPACE MOUNT, DRIVEN THROUGH THE REAL COMPUTERS VIEW.
 *
 * Owner, verbatim, quoted in src/home-chat-composer-draft.js's own header:
 * "theres occassionally really annoying UI redraws and they erase my typing."
 *
 * tools/test/home-agent-workspace.test.mjs and home-chat-composer-draft-
 * store.test.mjs are the only suites that drive mountHomeAgentWorkspace, and
 * BOTH inject their own `loadView` returning a hand-written computersView
 * stand-in. So the pool's plumbing is covered and the thing it plumbs into --
 * src/views/computers.js's real mountWorkspaceChat -> paintWorkspaceChat ->
 * `chat.importDraft?.(surface.draft?.read?.())` -- was never exercised by a
 * test at all. That import, and the matching `surface.draft?.write?.(
 * surface.root?.exportDraft?.())` in disposeWorkspaceChat, are what actually
 * carry a person's unsent words across this mount.
 *
 * This file takes the OTHER route: no loadView is passed, so the pool uses its
 * own default `() => import('./views/computers.js')` and the real view boots
 * over the shared real-source world in tools/test/lib/tree-command-real-mount.
 * mjs. What is asserted is the composer's own DOM after that mount -- the text,
 * the selection RANGE and the attachment chip -- not a value handed back by a
 * fixture that was told what to return.
 *
 * WHY THE SELECTION API IS INSTALLED BELOW. The stand-in implements no browser
 * selection at all (tools/test/lib/dom-stand-in.mjs defines only focus(), at
 * its Element class). Without it buildChat's `input.setSelectionRange?.(draft.
 * start, draft.end)` silently no-ops and any caret assertion passes while
 * measuring nothing. MEASURED while writing this file: unpatched, the mounted
 * input reported `selectionStart === undefined`, so a green caret assertion
 * would have proved nothing. tools/test/helpers/tree-rail-chat-harness.mjs:57-60
 * installs the same API for the same stated reason, per element, because it can
 * intercept buildChat inside a vm context. This suite cannot -- the composer's
 * input is parsed out of an innerHTML template (src/components.js:815), never
 * built through document.createElement -- so the API goes on the stand-in's
 * shared Element prototype instead. MEASURED: an innerHTML-parsed element and a
 * createElement one share that prototype, so the patch reaches the real input.
 * The product's export/import path is untouched and actual.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { fleetFetch, installWorld, seedTreeNode, settle, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

const { mountHomeAgentWorkspace } = await import('../../src/home-agent-workspace.js')
const { createComposerDraftStore } = await import('../../src/home-chat-composer-draft.js')

const NODE_ID = 'worker-1'
const subjectFor = (agentId = NODE_ID) => ({ id: `agent:${COMPUTER_ID}:${agentId}`, computerId: COMPUTER_ID, agentId })

function installSelectionApi() {
  const proto = Object.getPrototypeOf(globalThis.document.createElement('input'))
  const held = Object.getOwnPropertyDescriptor(proto, 'setSelectionRange')
  proto.selectionStart = 0
  proto.selectionEnd = 0
  proto.setSelectionRange = function (start, end) { this.selectionStart = start; this.selectionEnd = end }
  return () => {
    delete proto.selectionStart
    delete proto.selectionEnd
    if (held) Object.defineProperty(proto, 'setSelectionRange', held)
    else delete proto.setSelectionRange
  }
}

async function fixture(t, { nodes = [NODE_ID] } = {}) {
  const world = await installWorld(fleetFetch())
  const seeded = []
  const storageKey = fleetTreesStorageKey(COMPUTER_ID)
  for (const [index, nodeId] of nodes.entries()) {
    seedTreeNode(world.storage, { nodeId, sessionId: `session-${index + 1}`, status: 'running', parentId: index ? nodes[0] : null })
    seeded.push(...JSON.parse(world.storage.getItem(storageKey)).nodes)
  }
  // The shared one-node seed replaces its record. Retain both real nodes in
  // the multi-conversation case before either workspace reads the store.
  const record = JSON.parse(world.storage.getItem(storageKey))
  world.storage.setItem(storageKey, JSON.stringify({ ...record, nodes: seeded }))
  const restoreSelection = installSelectionApi()
  const drafts = createComposerDraftStore()
  const open = []
  t.after(async () => {
    for (const release of open) release()
    // retire() runs in a queueMicrotask and reads a bare `window`
    // (clearMountedGraph); let it land before the globals go away.
    await settle(20)
    restoreSelection()
    world.restore()
  })
  const mount = async (subject = subjectFor()) => {
    const host = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(host)
    const release = mountHomeAgentWorkspace(host, subject, drafts)
    open.push(release)
    const surface = await release.ready
    await settle(20)
    return { host, release, surface, input: host.querySelector('.chat-input input'),
      chips: () => host.querySelectorAll('.chat-attachment-chip') }
  }
  return { world, drafts, mount }
}

test('the real workspace mount restores the held text, selection range and attachment', async t => {
  const f = await fixture(t)
  const subject = subjectFor()
  f.drafts.writeDraft(subject.id, {
    text: 'Unsent words in the box', attachments: [{ id: 'att-1', name: 'shot.png' }], start: 6, end: 11,
  })
  const pane = await f.mount(subject)
  assert.ok(pane.surface, 'the real computers view must hand back a mounted surface')
  assert.ok(pane.input, 'the mounted workspace must build a composer input')
  assert.equal(pane.input.value, 'Unsent words in the box')
  // A RANGE, not merely a collapsed caret: a restore that only moved the caret
  // to the end would still pass a start-only assertion.
  assert.equal(pane.input.selectionStart, 6)
  assert.equal(pane.input.selectionEnd, 11)
  assert.equal(pane.chips().length, 1)
})

test('typing into the mounted composer is written back through the real dispose', async t => {
  const f = await fixture(t)
  const subject = subjectFor()
  f.drafts.writeDraft(subject.id, { text: 'First words', attachments: [{ id: 'att-1' }], start: 0, end: 0 })
  const pane = await f.mount(subject)
  pane.input.value = 'Edited in the pane'
  pane.input.setSelectionRange(7, 12)
  pane.release()
  await settle(20)
  const held = f.drafts.readDraft(subject.id)
  assert.equal(held.text, 'Edited in the pane')
  assert.equal(held.start, 7)
  assert.equal(held.end, 12)
  assert.equal(held.attachments[0].id, 'att-1', 'an attachment the person never removed must not be dropped')
})

test('closing the pane and opening it again brings the typing back', async t => {
  const f = await fixture(t)
  const subject = subjectFor()
  const first = await f.mount(subject)
  first.input.value = 'Half-written thought'
  first.input.setSelectionRange(5, 12)
  first.release()
  await settle(20)
  const second = await f.mount(subject)
  assert.equal(second.input.value, 'Half-written thought')
  assert.equal(second.input.selectionStart, 5)
  assert.equal(second.input.selectionEnd, 12)
})

test('two conversations mounted from one store keep separate drafts', async t => {
  const f = await fixture(t, { nodes: [NODE_ID, 'worker-2'] })
  const one = subjectFor(), two = subjectFor('worker-2')
  f.drafts.writeDraft(one.id, { text: 'For the first agent', attachments: [], start: 3, end: 3 })
  f.drafts.writeDraft(two.id, { text: 'For the second agent', attachments: [{ id: 'att-2' }], start: 4, end: 9 })
  const paneOne = await f.mount(one)
  const paneTwo = await f.mount(two)
  assert.equal(paneOne.input.value, 'For the first agent')
  assert.equal(paneOne.chips().length, 0)
  assert.equal(paneTwo.input.value, 'For the second agent')
  assert.equal(paneTwo.input.selectionStart, 4)
  assert.equal(paneTwo.input.selectionEnd, 9)
  assert.equal(paneTwo.chips().length, 1)
})

test('a conversation that never held a draft opens empty and invents nothing', async t => {
  const f = await fixture(t)
  const pane = await f.mount()
  assert.equal(pane.input.value, '')
  assert.equal(pane.chips().length, 0)
  assert.equal(f.drafts.readDraft(subjectFor().id), null)
})
