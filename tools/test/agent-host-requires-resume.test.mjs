// Regression (2026-09-10 review R8): an interrupt that closed the provider's
// whole process (Antigravity reports requiresResume) must not leave a host
// session that looks ready. New turns are refused as ended and Stop still closes it.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAgentHost } from '../../shell/agent-host.cjs'

const require = createRequire(import.meta.url)

test('an interrupt that requires resume retires the host session instead of leaving it ready', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-agy-resume-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'engine')
  cpSync(new URL('./fixtures/confined-engine/', import.meta.url), root, { recursive: true })
  const modulePath = path.join(root, 'src/lib/agent-engine/antigravity-cli-process.js')
  writeFileSync(modulePath, `const calls=[];
    async function startAntigravitySession(options){calls.push(options);let turns=0;
      return{threadId:'agy-native-id',adapter:{sendTurn:async()=>({turnId:'turn-'+(++turns)}),
        interrupt:async()=>({status:'interrupted',requiresResume:true}),answerApproval(){}},close(){calls.push('close')}}}
    module.exports={ROOT_ADMISSION_CONTRACT_VERSION:1,MODEL_SELECTION_CONTRACT_VERSION:1,calls,startAntigravitySession,resumeAntigravitySession:startAntigravitySession}`)
  const planner = require(path.join(root, 'src/lib/agent-session-confinement.js'))
  planner.antigravitySessionPlan = () => ({ ok: true, tier: 'guided', isolated: true, agentApiMode: 'Only', roleFunctionsOnly: true,
    threadOptions: { sandbox: 'read-only', approvalPolicy: 'never' }, env: {}, configDir: directory, servers: ['toolsenabled-research'], antigravity: { contractVersion: 1 } })
  const host = createAgentHost({ enginePath: path.join(root, 'src/lib/agent-engine/codex-process.js'), defaultCwd: directory,
    accountResolver: () => ({ rotated: true, account: { name: 'native', provider: 'gemini', client: 'antigravity', resolvedHome: directory } }),
    providerCommandResolver: () => path.join(directory, 'agy'), startProviderProbe: () => 'gemini', freeMemory: () => 64 * 1024 ** 3 })
  try {
    const session = await host.startSession({ sessionId: 'agy-interrupt', tier: 'agy-gemini-3-8-flash-high' })
    await host.sendTurn({ sessionId: session.sessionId, text: 'work' })
    const interrupted = await host.interrupt({ sessionId: session.sessionId })
    assert.equal(interrupted.requiresResume, true, 'the caller learns that this conversation needs Resume')
    await assert.rejects(host.sendTurn({ sessionId: session.sessionId, text: 'more' }), error => /ENDED/.test(String(error?.code)),
      'a session whose process is gone is not ready for another turn')
    assert.deepEqual(await host.closeSession({ sessionId: session.sessionId }), { sessionId: session.sessionId, closed: true }, 'Stop still closes it')
  } finally { await host.closeAll() }
})
