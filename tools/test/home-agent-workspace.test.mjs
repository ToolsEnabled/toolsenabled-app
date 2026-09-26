import test from 'node:test'
import assert from 'node:assert/strict'
import { createHomeAgentWorkspacePool, mountHomeAgentWorkspace } from '../../src/home-agent-workspace.js'
import { createComposerDraftStore } from '../../src/home-chat-composer-draft.js'

class Node {
  children = []
  setAttribute() {}
  appendChild(node) { this.children.push(node); node.parent = this }
  replaceChildren(...nodes) { this.children = []; nodes.forEach(node => this.appendChild(node)) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this) }
}
const subject = { id: 'agent:studio:worker', computerId: 'studio', agentId: 'worker' }
const settle = () => new Promise(resolve => setImmediate(resolve))
function withDocument(t) {
  const held = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: new Node(), createElement: () => new Node() } })
  t.after(() => held ? Object.defineProperty(globalThis, 'document', held) : delete globalThis.document)
}

test('closing or switching while chat loads cannot mount a late conversation', async t => {
  withDocument(t)
  const host = new Node()
  let resolve, mounts = 0
  const loading = new Promise(done => { resolve = done })
  const dispose = mountHomeAgentWorkspace(host, subject, createComposerDraftStore(), { loadView: () => loading })
  dispose()
  resolve({ computersView: () => { mounts += 1 } })
  await settle()
  assert.equal(mounts, 0)
  assert.equal(host.children.length, 0)
})

test('the selected computer, agent and rich draft reach the shared runtime and it disposes once', async t => {
  withDocument(t)
  const host = new Node(), drafts = createComposerDraftStore()
  drafts.writeDraft(subject.id, { text: 'Keep this draft', attachments: [{ id: 'attachment' }], start: 4, end: 7 })
  let options, mounted, destroyed = 0
  const chat = new Node()
  const view = { el: new Node(), destroy: () => { destroyed += 1 }, chatWorkspace: {
    ready: Promise.resolve(), mount(host, value) { mounted = value; host.replaceChildren(chat); return { dispose: () => chat.remove() } },
  } }
  const dispose = mountHomeAgentWorkspace(host, subject, drafts, {
    loadView: async () => ({ computersView: value => { options = value; return view } }),
  })
  await settle()
  assert.deepEqual(host.children, [chat])
  assert.equal(options.initialComputer, 'studio')
  assert.equal(options.chatWorkspace, true)
  assert.equal(mounted.nodeId, 'worker')
  assert.equal(mounted.draft.read().text, 'Keep this draft')
  assert.equal(mounted.draft.read().attachments[0].id, 'attachment')
  mounted.draft.write({ text: 'Revised', attachments: [], start: 7, end: 7 })
  assert.equal(drafts.read(subject.id), 'Revised')
  dispose()
  dispose()
  await settle()
  assert.equal(destroyed, 1)
  assert.equal(host.children.length, 0)
})

test('four panes share one runtime owner and replacing a sibling does not retire that owner', async t => {
  withDocument(t)
  let owners = 0, retired = 0, surfaceDisposals = 0
  const pool = createHomeAgentWorkspacePool({ loadView: async () => ({ computersView() {
    owners++
    return { el: new Node(), destroy: () => { retired++ }, chatWorkspace: { ready: Promise.resolve(), mount(host) {
      const root = new Node(); host.replaceChildren(root)
      return { root, dispose() { surfaceDisposals++; root.remove() } }
    } } }
  } }) })
  const drafts = createComposerDraftStore()
  const panes = Array.from({ length: 4 }, (_, index) => ({ host: new Node(), subject: { ...subject, id: `agent:studio:${index}`, agentId: String(index) } }))
  const releases = panes.map(pane => pool.mount(pane.host, pane.subject, drafts))
  await Promise.all(releases.map(release => release.ready))
  assert.equal(owners, 1)
  panes[2].host.hidden = true
  assert.equal(retired, 0)
  releases[0]()
  const replacement = pool.mount(panes[0].host, { ...subject, agentId: 'next' }, drafts)
  await replacement.ready
  assert.equal(owners, 1)
  assert.equal(surfaceDisposals, 1)
  assert.equal(panes[1].host.children.length, 1)
  for (const release of releases.slice(1)) release()
  replacement()
  await settle()
  assert.equal(retired, 1)
  pool.destroy()
  assert.equal(retired, 1)
})

test('replacing the final surface in the same render retains its session owner', async t => {
  withDocument(t)
  let owners = 0, retired = 0
  const pool = createHomeAgentWorkspacePool({ loadView: async () => ({ computersView() {
    owners++
    return { el: new Node(), destroy: () => { retired++ }, chatWorkspace: { ready: Promise.resolve(), mount() { return { dispose() {} } } } }
  } }) })
  const drafts = createComposerDraftStore(), host = new Node()
  const first = pool.mount(host, subject, drafts); await first.ready
  first()
  const next = pool.mount(host, subject, drafts); await next.ready
  assert.equal(owners, 1); assert.equal(retired, 0)
  next(); await settle(); assert.equal(retired, 1)
})

test('new conversation controls forward creation and draft state without creating on mount', async t => {
  withDocument(t)
  let submitted = null, options = null, created = 0
  const draft = { read: () => ({ message: 'Keep the new brief', tier: 'terra' }), write() {} }
  const pool = createHomeAgentWorkspacePool({ loadView: async () => ({ computersView: () => ({ el: new Node(), destroy() {}, chatWorkspace: {
    ready: Promise.resolve(), async newChat(host, value) { options = value; submitted = () => value.onSubjectCreated(subject); return { dispose() {} } },
  } }) }) })
  const release = pool.newChat(new Node(), 'studio', { draft, onSubjectChange: value => { created++; assert.equal(value, subject) } })
  await release.ready
  assert.equal(created, 0)
  assert.equal(options.draft.read().message, 'Keep the new brief')
  submitted(); assert.equal(created, 1)
  release(); pool.destroy()
})

test('a failed chat load leaves a visible recovery path', async t => {
  withDocument(t)
  const host = new Node()
  const dispose = mountHomeAgentWorkspace(host, subject, createComposerDraftStore(), {
    loadView: async () => { throw Error('unavailable') },
  })
  await settle()
  assert.match(host.children[0].textContent, /Choose another view.*Computers/)
  dispose()
  assert.equal(host.children.length, 0)
})

test('drafts retain attachments and selection, stay isolated, and never duplicate a queue edit', () => {
  const drafts = createComposerDraftStore()
  const initial = { text: 'report', attachments: [{ id: 'file' }], start: 2, end: 4 }
  drafts.writeDraft('one', initial)
  initial.attachments.push({ id: 'another' })
  const restored = drafts.readDraft('one')
  assert.deepEqual(restored, { text: 'report', attachments: [{ id: 'file' }], start: 2, end: 4 })
  restored.attachments.length = 0
  assert.equal(drafts.readDraft('one').attachments.length, 1)
  assert.equal(drafts.readDraft('two'), null)
  drafts.writeDraft('one', null)
  assert.equal(drafts.read('one'), 'report', 'a queue edit exports null; the ordinary draft remains held')
  drafts.writeDraft('one', { text: '', attachments: [] })
  assert.equal(drafts.readDraft('one'), null, 'a sent or cleared draft stays cleared')
})

// T1497: Home's panel mounts its chat while Home is still being built. The
// conversation must not read its kept draft before the draft store knows the
// account, or it reads and writes a route-local copy and the typing is lost.
test('a Home conversation opens only after its draft store knows the account', async t => {
  withDocument(t)
  const host = new Node()
  let known, reads = 0, mounted = null
  const ready = new Promise(done => { known = done })
  const drafts = { ready, readDraft: () => { reads += 1; return { text: 'Kept draft', attachments: [] } }, writeDraft() {} }
  const chat = new Node()
  const view = { el: new Node(), destroy() {}, chatWorkspace: {
    ready: Promise.resolve(), mount(target, value) { mounted = value; target.replaceChildren(chat); value.draft.read(); return { dispose: () => chat.remove() } },
  } }
  const pool = createHomeAgentWorkspacePool({ loadView: async () => ({ computersView: () => view }) })
  const dispose = pool.mount(host, subject, drafts)
  for (let turn = 0; turn < 5; turn++) await settle()
  assert.equal(mounted, null, 'the conversation waits for the account lookup')
  assert.equal(reads, 0)
  known()
  for (let turn = 0; turn < 5; turn++) await settle()
  assert.equal(mounted.nodeId, 'worker')
  assert.equal(reads, 1)
  dispose()
  pool.destroy()
})
