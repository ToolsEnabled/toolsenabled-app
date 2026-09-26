import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
import { createNodeTranscriptStore } from '../../shell/node-transcript-store.cjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const view = await fs.readFile(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const declaration = name => declaredFunctionSource(view, name)

test('a late approval answer replaces its closed row in memory and after disk reopen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-approval-history-'))
  const disk = createNodeTranscriptStore({ directory })
  const client = createNodeTranscriptClient({ computerId: 'computer', bridge: disk })
  const sessionTranscripts = new Map(), sessionNodeIds = new Map([['session', 'node']])
  const captures = []
  const transcriptStore = { get: client.get, capture(node, entry) { const pending = client.capture(node, entry); captures.push(pending); return pending } }
  const persistTranscript = () => { throw Error('This controlled action batch must use the explicit flush') }
  const append = new Function('sessionTranscripts', 'sessionNodeIds', 'transcriptStore', 'standaloneSettledTurns',
    'TRANSCRIPT_MAX_ENTRIES', 'persistTranscript', declaration('transcriptAppend') + '\nreturn transcriptAppend')(
    sessionTranscripts, sessionNodeIds, transcriptStore, new Map(), 200, persistTranscript)
  const capture = new Function('actionChatRow', 'actionTimingFields', 'transcriptAppend',
    declaration('persistActionRow') + '\nreturn persistActionRow')(
    row => ({ tool: 'Approval', detail: 'Permission to use a tool', at: row.at }), () => ({}), append)
  try {
    await client.ready
    const row = { kind: 'approval', state: 'closed', at: 1 }
    capture('session', row)
    await Promise.all(captures)
    const initial = await disk.read({ computerId: 'computer', nodeId: 'node', limit: 60 })
    assert.equal(initial.entries.length, 1)
    assert.equal(initial.entries[0].state, 'closed')
    const identity = initial.entries[0].id
    row.state = 'refused'
    capture('session', row)
    await Promise.all(captures)
    assert.equal(sessionTranscripts.get('session').length, 1, 'late answer duplicated the viewport row')
    const reopened = createNodeTranscriptStore({ directory })
    const saved = await reopened.read({ computerId: 'computer', nodeId: 'node', limit: 60 })
    assert.equal(saved.entries.length, 1, 'late answer duplicated the durable row')
    assert.equal(saved.entries[0].id, identity)
    assert.equal(saved.entries[0].state, 'refused')
    assert.equal(saved.entries[0].kind, 'approval', 'reopening must not count the approval as another tool call')
  } finally { client.dispose(); await Promise.all(captures); await fs.rm(directory, { recursive: true, force: true }) }
})
