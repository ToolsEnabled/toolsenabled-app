import assert from 'node:assert/strict'
import test from 'node:test'
import { retryWorld, settle } from './helpers/t844-retry-world.mjs'

// Real Computers view, saved tree/transcript stores, resume consumer and
// buildChat textarea. DOM and asynchronous provider bridge are inert. No
// browser/native resume occurrence is claimed by this mounted-source proof.
for (const switchRail of [false, true]) test(switchRail
  ? 'a deferred resume blur preserves the other rail selected while waiting'
  : 'a mounted rail textarea keeps draft and caret across delayed resume and sends only to the successor', { timeout: 15_000 }, async t => {
  const { createTranscriptStore } = await import('../../src/session-transcript-store.js')
  const { safeTreeStorage, fleetTreesStorageKey, createFleetTreeStore } = await import('../../src/fleet-trees.js')
  const { RESUME_PANEL } = await import('../../src/fleet-tree-copy.js')
  const f = await retryWorld(t)
  const elementPrototype = Object.getPrototypeOf(document.body)
  const missingSelection = typeof elementPrototype.setSelectionRange !== 'function'
  if (missingSelection) elementPrototype.setSelectionRange = function(start, end) { this.selectionStart = start; this.selectionEnd = end }
  t.after(() => { if (missingSelection) delete elementPrototype.setSelectionRange })
  let otherId = null
  if (switchRail) {
    const store = createFleetTreeStore({ computerId: f.computerId, storage: safeTreeStorage(f.world.storage) })
    const added = store.addNode({ role: 'worker', message: 'Other rail', tier: 'luna' })
    assert.ok(added.node); otherId = added.node.id
    store.attachSession(otherId, 'other-rail-session'); store.setNodeStatus(otherId, 'finished')
    await f.mount({ fresh: true })
  }
  const transcripts = createTranscriptStore({ computerId: f.computerId, storage: safeTreeStorage(f.world.storage) })
  assert.equal(transcripts.save(f.nodeId, { threadId: 'retained-resume-thread', provider: 'codex', effort: 'max', account: null,
    lines: [{ who: 'you', text: 'Saved question', at: 1 }, { who: 'agent', text: 'Saved answer', at: 2 }] }), true)
  const nextId = f.sessionId + '-resumed'
  let releaseStart, enteredStart
  const started = new Promise(resolve => { enteredStart = resolve })
  const pendingStart = new Promise(resolve => { releaseStart = resolve })
  const calls = []
  f.world.bridge.start = async request => { calls.push(request); enteredStart(); await pendingStart;
    return { ok: true, sessionId: nextId, threadId: 'retained-resume-thread', resumed: { turns: [] } } }
  t.after(() => releaseStart())
  const chat = await f.openChat()
  console.log('T1485_RESUME_STAGE mounted')
  const composer = chat.querySelector('.chat-input textarea')
  assert.ok(composer, 'the production chat must mount its real multiline composer')
  chat.openActions()
  await settle(5)
  const resume = [...chat.querySelectorAll('.chat-actions-row')].find(row => row.children[0]?.textContent === RESUME_PANEL.action)
  assert.ok(resume, 'the actual chat must expose its Resume action')
  assert.equal(resume.disabled, false, 'the fixture must reach the real resume consumer')
  resume.dispatch('click')
  console.log('T1485_RESUME_STAGE requested')
  await Promise.race([started, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Resume did not reach held host start: ' + chat.textContent)), 3000)
    started.then(() => clearTimeout(timer))
  })])
  console.log('T1485_RESUME_STAGE host-start-entered')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].resumeThreadId, 'retained-resume-thread')
  const draft = 'Typed while resuming\nsecond line remains'
  chat.importDraft({ text: draft, start: 7, end: 12, attachments: [{ path: 'retained-draft-image.png', name: 'retained-draft-image.png', mime: 'image/png' }] })
  const savedDraft = chat.exportDraft()
  composer.dispatch('input')
  composer.focus()
  releaseStart()
  await settle(50)
  const record = JSON.parse(f.world.storage.getItem(fleetTreesStorageKey(f.computerId))).nodes.find(node => node.id === f.nodeId)
  assert.equal(record.sessionId, nextId, 'the async resume must actually bind before checking deferral')
  console.log('T1485_RESUME_STAGE successor-bound')
  const current = () => f.view.el.querySelector('[data-rail-chat-host] .chat')
  assert.equal(current() === chat, true, 'resume must not dispose a rail while its textarea holds focus')
  assert.equal(current().querySelector('.chat-input textarea') === composer, true)
  assert.equal(document.activeElement === composer, true)
  assert.equal(composer.value, draft)
  assert.equal(composer.selectionStart, 7)
  assert.equal(composer.selectionEnd, 12)
  assert.deepEqual(chat.exportDraft(), savedDraft)
  if (switchRail) {
    const other = await f.openChat(otherId)
    const otherDraft = { text: 'Other node keeps its words', start: 2, end: 5, attachments: [] }
    other.importDraft(otherDraft)
    const before = other.exportDraft()
    composer.dispatch('blur')
    await settle(10)
    assert.equal(current() === other, true, 'stale blur must not reopen the resumed node over the selected rail')
    assert.deepEqual(other.exportDraft(), before)
    return
  }
  document.activeElement = null
  composer.dispatch('blur')
  await settle(10)
  const rebound = current()
  assert.ok(rebound)
  assert.equal(rebound !== chat, true, 'blur must release the deferred rebind to the resumed session')
  assert.equal(rebound.querySelector('.chat-input textarea').value, draft)
  assert.deepEqual(rebound.exportDraft(), savedDraft, 'rebind must retain words, selection and attachment descriptor')
  const once = rebound
  composer.dispatch('blur')
  await settle(5)
  assert.equal(current() === once, true, 'another blur must not repeat the released rebuild')
  assert.equal(calls.length, 1, 'typing/blur must never start another session')
  const sends = []
  f.world.bridge.send = async request => { sends.push(request); return { ok: true, turnId: 'resumed-send' } }
  rebound.importDraft({ ...savedDraft, attachments: [] })
  rebound.querySelector('.chat-input textarea').dispatch('keydown', { key: 'Enter' })
  await settle(15)
  assert.equal(sends.length, 1, 'resumed chat must send the remaining text once')
  assert.equal(sends[0].sessionId, nextId)
  assert.equal(sends[0].text, draft)
})
