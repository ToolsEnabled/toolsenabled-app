import test from 'node:test'
import assert from 'node:assert/strict'
import { createStoppedConversationAdoption, MAX_TAB_BYTES, MAX_TABS, MAX_PAGES } from '../../shell/stopped-conversation-adoption.cjs'

const identity = { nativeSessionId: 'native', threadId: 'thread', provider: 'codex', account: null }
const source = { computerId: 'computer', nodeId: 'source' }, destination = { computerId: 'computer', nodeId: 'circle' }
const metadata = { ...source, ...identity, revision: 1 }
const tab = { id: source.nodeId, sessionId: identity.nativeSessionId }
const request = { identity, source, destination, assertCurrent() {} }
function fixture({ tabs = { v: 1, tabs: [tab] }, read = null, target = null } = {}) {
  const writes = []
  const readTranscript = read || (async () => ({ ok: true, durable: true, metadata, entries: [], before: null }))
  const helper = createStoppedConversationAdoption({ readTabs: () => typeof tabs === 'string' ? tabs : JSON.stringify(tabs),
    readTranscript, store: { read: async () => ({ ok: true, durable: true, entries: target || [], metadata: null }),
      append: async value => { writes.push(value); return { ok: true, durable: true } },
      bindSessionMetadata: async value => { writes.push(value); return { ok: true, durable: true } } } })
  return { helper, writes }
}
for (const [name, tabs] of [
  ['oversized saved tab ledger', JSON.stringify({ v: 1, tabs: [tab], padding: 'x'.repeat(MAX_TAB_BYTES) })],
  ['too many saved tab rows', { v: 1, tabs: [tab, ...Array.from({ length: MAX_TABS }, (_, i) => ({ id: 'other-' + i }))] }],
  ['duplicate exact source', { v: 1, tabs: [tab, tab] }],
  ['unreadable tab evidence', 'damaged JSON'],
]) test(name + ' refuses before any destination write', async () => {
  const f = fixture({ tabs })
  await assert.rejects(f.helper.prepare(request), { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.deepEqual(f.writes, [])
})

test('pagination limit refuses the complete transfer instead of reporting a truncated conversation as complete', async () => {
  let reads = 0
  const f = fixture({ read: async () => { const page = reads++
    return { ok: true, durable: true, metadata, entries: [{ id: 'row-' + page, who: 'agent', text: 'Kept' }],
      before: page < MAX_PAGES ? 'cursor-' + page : null }
  } })
  await assert.rejects(f.helper.prepare(request), { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.deepEqual(f.writes, [])
})

test('repeated pagination cursor refuses without selecting a recent different source', async () => {
  let reads = 0
  const f = fixture({ read: async () => { reads++; return { ok: true, durable: true, metadata,
    entries: [{ id: 'row', who: 'agent', text: 'Kept' }], before: 'repeated' } } })
  await assert.rejects(f.helper.prepare(request), { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.ok(reads <= 2, 'a repeated source cursor must stop pagination immediately')
  assert.deepEqual(f.writes, [])
})

test('a populated destination refuses instead of overwriting another saved conversation', async () => {
  const f = fixture({ target: [{ id: 'other', who: 'agent', text: 'Another conversation' }] })
  const prepared = await f.helper.prepare(request)
  await assert.rejects(prepared.persist(), { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.deepEqual(f.writes, [])
})

test('changed canonical source revision refuses before copying a stale identity', async () => {
  let reads = 0
  const f = fixture({ read: async () => ({ ok: true, durable: true, metadata: { ...metadata, revision: ++reads },
    entries: [], before: null }) })
  const prepared = await f.helper.prepare(request)
  await assert.rejects(prepared.persist(), { code: 'AGENT_STOPPED_ADOPTION_REFUSED' })
  assert.deepEqual(f.writes, [])
})
