import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { canonicalRootForTests } from '../canonical-root.mjs'

/* AN AGENT'S HAND-OFF THE MODEL ACCEPTED IS NOT OFFERED A SECOND TIME.
 *
 * The tree courier hands queued agent messages to an idle recipient through
 * sendTurn({ origin: 'agent' }). When the provider accepted that turn but the
 * host's accepted-prompt boundary then failed -- the accepted words could not
 * be saved -- sendTurn rejected with the storage code and left the turn
 * unrecorded. The courier read that as a refused hand-off: it put the batch
 * back and offered the same messages again at the next tick, a second turn of
 * the same work beside the first, repeated up to its attempt bound. The same
 * wiring as tree-queue-retirement.test.mjs: the real tree directory and local
 * message provider from the engine source, the fixture engine's adapter. */
const require_ = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const engineRoot = canonicalRootForTests()
require_(path.join(engineRoot, 'tests/lib/isolated-environment')).activate('tree-handoff-accepted-unsaved')
const { createTreeNodeDirectory } = require_(path.join(engineRoot, 'src/lib/agent-comms/tree-node-directory'))
const { createLocalAgentMessageProvider } = require_(path.join(engineRoot, 'src/lib/providers/agent-comms-local'))
const fixtures = path.join(root, 'tools/test/fixtures/confined-engine/src/lib')
const directoryPath = path.join(fixtures, 'agent-comms/tree-node-directory.js')
const providerPath = path.join(fixtures, 'providers/agent-comms-local.js')
const enginePath = path.join(fixtures, 'agent-engine/codex-process.js')
const { createAgentHost } = require_(path.join(root, 'shell/agent-host.cjs'))

async function until(predicate, label) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (predicate()) return; await delay(20) }
  assert.fail(label)
}

test('a tree hand-off the provider accepted but could not save is settled once, not offered again', async t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'tree-handoff-accepted-unsaved-'))
  const file = path.join(scratch, 'tree.json'), brokerFile = path.join(scratch, 'broker.json')
  const directory = createTreeNodeDirectory({ file })
  const provider = createLocalAgentMessageProvider({ directory, brokerFile })
  const originalDirectory = require_(directoryPath), originalProvider = require_(providerPath), engine = require_(enginePath)
  engine.calls.length = 0; engine.adapterCalls.length = 0; engine.pendingTurns.length = 0
  engine.control.holdTurns = false
  require_.cache[require_.resolve(directoryPath)].exports = {
    createTreeNodeDirectory: options => createTreeNodeDirectory({ ...options, file }),
  }
  require_.cache[require_.resolve(providerPath)].exports = provider
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    treeCourier: { pollMs: 35, heartbeatMs: 1000, readDeadlineMs: 500 },
    messageDeliveryReader: () => ({ mode: 'end-of-turn', intervalMs: 30_000 }),
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'agent-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }),
  })
  // The accepted-prompt boundary refuses to save an agent's hand-off, as
  // shell/main.cjs's transcript listener does when capture answers ok:false.
  const acceptedOrigins = []
  host.onAcceptedPrompt(prompt => {
    acceptedOrigins.push(prompt.origin)
    if (prompt.origin === 'agent') {
      return Promise.reject(Object.assign(new Error('Accepted transcript input is not saved.'), { code: 'MC_TRANSCRIPT_CAPTURE_UNSAVED' }))
    }
  })
  t.after(async () => {
    await host.closeAll()
    require_.cache[require_.resolve(directoryPath)].exports = originalDirectory
    require_.cache[require_.resolve(providerPath)].exports = originalProvider
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
  })
  const key = 'accepted-unsaved'
  const body = 'Retained report accepted-unsaved.'
  const managerId = `${key}-manager`, recipientId = `${key}-recipient`
  await host.startSession({ sessionId: managerId, treeIdentity: { selfName: 'Manager', managerName: null },
    requestKeys: { treeAnchors: [key], threadId: key } })
  await host.startSession({ sessionId: recipientId, treeIdentity: { selfName: 'Recipient', managerName: 'Manager' },
    requestKeys: { treeAnchors: [key, `${key}-node`], threadId: `${key}-node` } })
  const sent = await provider.send({ from: 'Manager', to: 'Recipient', body },
    { agentSessionId: managerId, agentPrincipal: { sessionId: managerId } })
  assert.equal(sent.delivered, true)
  const offers = () => engine.adapterCalls.filter(call => call.method === 'sendTurn' && call.request.text.includes(body))
  await until(() => offers().length >= 1, 'the courier never handed the message to the idle recipient')
  assert.deepEqual(acceptedOrigins, ['agent'], 'the provider accepted the hand-off')
  // Many courier ticks (pollMs 35): a refused hand-off would be re-offered.
  await delay(600)
  assert.equal(offers().length, 1, 'the accepted hand-off was offered to the model again as if it had been refused')
  const broker = JSON.parse(readFileSync(brokerFile, 'utf8'))
  assert.equal(broker.deadLetters.filter(row => row.entry.messageId === sent.messageId).length, 0,
    'an accepted hand-off must not be dead-lettered as undeliverable')
})
