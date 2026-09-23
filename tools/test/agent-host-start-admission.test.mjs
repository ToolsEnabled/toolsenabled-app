import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { createAgentHost } = require(path.join(root, 'shell/agent-host.cjs'))
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const scratch = testScratchRoot('.tree-start-admission-test')
mkdirSync(scratch, { recursive: true })
const request = { sessionId: 'admitted-start', agentId: 'child-one',
  role: { id: 'worker', name: 'Worker', owns: 'Inspect the fixture.', mustNot: 'Change user files.', handoff: 'Return evidence.', rules: [], revision: 1 },
  agentAuthority: { agentId: 'child-one', provider: 'codex', roleId: 'worker', expectedOrgRevision: 3, expectedRoleRevision: 1 } }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

for (const outcome of ['success', 'account-refusal', 'cancel', 'role-revoked']) {
  test(`admission precedes asynchronous account selection and preserves ${outcome}`, async t => {
    const account = deferred()
    const entered = deferred()
    const ticket = Object.freeze({})
    const events = []
    const beforeStarts = engine.calls.length
    const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
      confinementPlanner: () => ({ ok: true, tier: 'guided', isolated: true, env: { CODEX_HOME: path.join(scratch, 'synthetic-home') }, threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, servers: [] }),
      accountResolver: async () => { events.push('account'); entered.resolve(); await account.promise;
        return outcome === 'account-refusal' ? { blocked: true, code: 'AGENT_ACCOUNT_UNAVAILABLE', reason: 'Synthetic account is unavailable.' }
          : { rotated: false, account: null, code: 'ACCOUNTS_NOT_CONFIGURED' } },
      sessionAuthority: {
        admissionVersion: 1,
        admit(principal) { events.push('admit'); assert.equal(principal.expectedOrgRevision, 3); return ticket },
        async bind(principal, scope, admission) {
          events.push('bind'); assert.equal(admission, ticket); assert.equal(principal.expectedOrgRevision, 3);
          if (outcome === 'role-revoked') throw Object.assign(new Error('Role changed.'), { code: 'OWNER_HOST_SESSION_REFUSED' })
          return { bound: true, mode: 'owner-host', credential: Buffer.alloc(32, 49).toString('base64url') }
        },
        async revoke() { events.push('revoke'); return { revoked: true } },
      },
    })
    t.after(() => host.closeAll())
    const start = host.startSession(request).then(value => ({ value }), error => ({ error }))
    await entered.promise
    assert.deepEqual(events, ['admit', 'account'])
    assert.equal(engine.calls.length, beforeStarts, 'no provider starts during account selection')
    const stopping = outcome === 'cancel' ? host.closeSession({ sessionId: request.sessionId }) : null
    account.resolve()
    const result = await start
    if (outcome === 'success') {
      assert.equal(result.value?.sessionId, request.sessionId)
      assert.equal(engine.calls.length, beforeStarts + 1)
    } else {
      assert.equal(result.error?.code, { 'account-refusal': 'AGENT_ACCOUNT_UNAVAILABLE', cancel: 'AGENT_SESSION_START_CANCELLED', 'role-revoked': 'OWNER_HOST_SESSION_REFUSED' }[outcome])
      assert.equal(engine.calls.length, beforeStarts)
    }
    if (['account-refusal', 'cancel'].includes(outcome)) assert.equal(events.includes('bind'), false, 'no credential on failed/cancelled account preparation')
    if (stopping) await stopping
  })
}
