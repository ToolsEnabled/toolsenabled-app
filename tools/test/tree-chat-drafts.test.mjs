import assert from 'node:assert/strict'
import test from 'node:test'
import { createTreeChatDraftStore } from '../../src/tree-chat-drafts.js'

const composer = (text = '') => ({
  value: { text, attachments: [], start: 0, end: 0 },
  importDraft(value) { this.value = { ...value, attachments: value.attachments.slice() } },
  exportDraft() { return this.value && { ...this.value, attachments: this.value.attachments.slice() } },
})

test('tree tabs and the default rail keep independent drafts for the same computer and node', () => {
  const store = createTreeChatDraftStore(), tree = composer('Tree words'), rail = composer()
  const releaseTree = store.mount('computer', 'node', tree, { scope: 'tree' })
  const releaseRail = store.mount('computer', 'node', rail)
  rail.value.text = 'Rail words'
  releaseTree(); releaseRail()
  const reopenedTree = composer(), reopenedRail = composer()
  store.mount('computer', 'node', reopenedTree, { scope: 'tree' })
  store.mount('computer', 'node', reopenedRail)
  assert.equal(reopenedTree.value.text, 'Tree words')
  assert.equal(reopenedRail.value.text, 'Rail words')
})

test('late teardown can only overwrite its own current scope lease', () => {
  const store = createTreeChatDraftStore(), old = composer('Stale tree'), newer = composer('Latest tree'), rail = composer('Rail stays separate')
  const releaseOld = store.mount('computer', 'node', old, { scope: 'tree' })
  const releaseRail = store.mount('computer', 'node', rail)
  const releaseNew = store.mount('computer', 'node', newer, { scope: 'tree' })
  releaseNew(); releaseRail(); releaseOld()
  const result = composer(), railResult = composer()
  store.mount('computer', 'node', result, { scope: 'tree' }); store.mount('computer', 'node', railResult)
  assert.equal(result.value.text, 'Latest tree'); assert.equal(railResult.value.text, 'Rail stays separate')
})

test('restored tree drafts are consumed even when their next export is empty or a queue edit', () => {
  for (const current of [{ text: '', attachments: [], start: 0, end: 0 }, null]) {
    const store = createTreeChatDraftStore(), first = composer('Older saved intent')
    store.mount('computer', 'node', first, { scope: 'tree' })()
    const second = composer(), release = store.mount('computer', 'node', second, { scope: 'tree' })
    assert.equal(second.value.text, 'Older saved intent')
    second.value = current; release()
    const returned = composer(); store.mount('computer', 'node', returned, { scope: 'tree' })
    assert.equal(returned.value.text, '')
  }
})

test('forget removes every scope and invalidates pending releases without touching other nodes or computers', () => {
  const store = createTreeChatDraftStore(), releases = []
  for (const scope of ['rail', 'tree', 'future-surface']) {
    releases.push(store.mount('computer', 'node', composer(`Removed ${scope}`), { scope }))
    store.mount('computer', 'node-other', composer(`Other node ${scope}`), { scope })()
    store.mount('computer-other', 'node', composer(`Other computer ${scope}`), { scope })()
  }
  store.forget('computer', 'node')
  releases.forEach(release => release())
  for (const scope of ['rail', 'tree', 'future-surface']) {
    const removed = composer(), otherNode = composer(), otherComputer = composer()
    store.mount('computer', 'node', removed, { scope })
    store.mount('computer', 'node-other', otherNode, { scope })
    store.mount('computer-other', 'node', otherComputer, { scope })
    assert.equal(removed.value.text, '')
    assert.equal(otherNode.value.text, `Other node ${scope}`)
    assert.equal(otherComputer.value.text, `Other computer ${scope}`)
  }
})
