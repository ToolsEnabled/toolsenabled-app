import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { resumableThread } from '../../src/tree-resume-decision.js'

// Execute the shipping handler with inert boundaries: no provider process or DOM.
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const start = source.indexOf('  async function resumeNodeSessionUnguarded(')
const end = source.indexOf('  async function runPaletteAction(', start)
assert.ok(start >= 0 && end > start)
const handler = source.slice(start, end)
for (const [savedProvider, provider] of [['codex', 'claude'], ['claude', 'codex']]) {
  test(`renderer refuses ${savedProvider} to ${provider} before replacement side effects`, async () => {
    const node = { id: 'node', tier: 'picked', sessionId: 'original' }
    const calls = []
    const context = {
      treeStore: { getNode: () => node },
      transcriptStore: { ready: Promise.resolve(), get: () => ({ threadId: 'thread', provider: savedProvider }) },
      window: { mcAgent: { start: () => calls.push('start'), close: () => calls.push('close') } },
      isWriteEnabled: () => true, START_CONTROL_FLAG: 'start',
      nodeCleanupPending: () => false, destroyed: false, resumableThread,
      LAUNCH_TIERS: [{ id: 'picked', provider }],
      withRetainedStartIdentity: bridge => { calls.push('replacement'); return bridge },
      identityRoleForTreeNode: () => null,
      ensureSeatForNode: () => { calls.push('seat'); throw new Error('replacement reached') },
    }
    const resume = vm.runInNewContext(`(${handler.trim()})`, context)
    const out = { textContent: '' }
    assert.equal(await resume(node, { out }), false)
    assert.equal(out.textContent, resumableThread({ savedThreadId: 'thread', savedProvider, provider }).message)
    assert.match(out.textContent, /Codex/)
    assert.match(out.textContent, /Claude/)
    assert.deepEqual(calls, [])
    assert.equal(node.sessionId, 'original')
    assert.equal(await resume(node), false)
    assert.deepEqual(calls, [])
  })
}
