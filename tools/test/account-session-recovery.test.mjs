import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { lstatSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { tmpdir } from 'node:os'
const require = createRequire(import.meta.url)
const { limitReason } = require('../../shell/account-session-recovery.cjs')
// These recording engines start no provider process. Real machine pressure
// must not prevent the account-recovery cases from reaching their subject.
// agent-memory-admission and agent-resource-wiring cover admission separately.
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024
// The native fixture may use only the current owner's validated temp. Check the
// complete parent chain before creation and the final directory before removal.
const SCRATCH_PARENT = ownedFixtureTempRoot()
function admitScratchDirectory(directory) {
 if (process.platform !== 'win32') return directory
 const normalized = path.win32.resolve(directory)
 const parent = SCRATCH_PARENT.toLowerCase()
 assert.ok(normalized.toLowerCase() === parent || normalized.toLowerCase().startsWith(parent + '\\'),
  'fixture scratch must be inside the validated owner temp before any path inspection')
 let cursor = path.win32.parse(normalized).root
 for (const segment of path.win32.relative(cursor, normalized).split('\\')) {
  cursor = path.win32.join(cursor, segment)
  const entry = lstatSync(cursor)
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'fixture scratch parents must be ordinary directories')
 }
 const finalPath = path.win32.normalize(realpathSync.native(normalized)).replace(/^\\\\\?\\/, '')
 assert.equal(finalPath.toLowerCase(), normalized.toLowerCase(), 'fixture scratch must not resolve through a path alias')
 return normalized
}
function createScratch(prefix) {
 admitScratchDirectory(SCRATCH_PARENT)
 return admitScratchDirectory(mkdtempSync(path.join(SCRATCH_PARENT, prefix)))
}
function removeScratch(directory) {
 admitScratchDirectory(directory)
 rmSync(directory, { recursive: true, force: true })
}
const failure = { type: 'turn_completed', status: 'failed', text: "You've hit your limit. Please try again later." }

















test('a bug inside the account resolver surfaces instead of reading as an unchecked account', async () => {
 const { readFileSync } = require('node:fs')
 const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
 const at = main.indexOf('async function resolveSessionAccount('); const end = main.indexOf('\n}', at)
 assert.ok(at > 0 && end > at)
 const slice = main.slice(at, end + 2) + '; return resolveSessionAccount;'
 /* ACCOUNT_REGISTRY_FILE is left unbound on purpose. A private start reads it, so
    the resolver's own code throws a ReferenceError: the shape of a real bug. */
 const broken = new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts', 'ACCOUNT_HOME_DIR',
  'PROVIDER_ISOLATION_REQUESTED', slice)(
  () => ({ resolveAccountForSession: async () => ({ rotated: true }) }), () => null, () => 'services-root', 'owner-home', true)
 await assert.rejects(broken({ provider: 'claude' }), error => error instanceof ReferenceError,
  'a ReferenceError in the resolver was reported as an account that could not be checked')
 /* A real failed account read keeps the generic refusal and does not repeat its private detail. */
 const failing = new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts', 'ACCOUNT_HOME_DIR',
  'PROVIDER_ISOLATION_REQUESTED', 'ACCOUNT_REGISTRY_FILE', slice)(
  () => ({ resolveAccountForSession: async () => { throw Object.assign(new Error('private read failure'), { code: 'EIO' }) } }),
  () => null, () => 'services-root', 'owner-home', true, 'registry')
 await assert.rejects(failing({ provider: 'claude' }),
  error => error.code === 'AGENT_ACCOUNT_UNAVAILABLE' && !error.message.includes('private read failure'))
})


test('exact resume preserves original-account limit and sign-in classifications before any provider spawn', async t => {
 const cwd = createScratch('resume-reason-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath); let starts = 0; let status = 'exhausted'
 t.mock.method(engine, 'resumeCodexSession', async () => { starts++; throw new Error('must not spawn') })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
  confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async () => ({ rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL',
    attempts: [{ account: 'different-account', status: 'exhausted' }, { account: 'primary', status }] }),
 })
 try {
  for (const [state, code] of [['exhausted', 'AGENT_RESUME_ACCOUNT_LIMIT'], ['signed_out', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'], ['not_provisioned', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'], ['transient', 'AGENT_RESUME_ACCOUNT_UNAVAILABLE']]) {
   status = state
   await assert.rejects(host.startSession({ sessionId: 'resume-' + state, resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary' }), error => error.code === code && error.message.length < 300)
  }
  assert.equal(starts, 0)
 } finally { await host.closeAll(); removeScratch(cwd) }
})

test('resume account-limit refusal leaves the running predecessor intact before replacement teardown', async t => {
 const cwd = createScratch('resume-replacement-limit-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath); let starts = 0; let closes = 0; let blocked = false
 t.mock.method(engine, 'startCodexSession', async () => {
  starts++
  return { threadId: 'old-thread', close() { closes++ }, adapter: { sendTurn: async () => ({ turnId: 't' }), interrupt() {} } }
 })
 t.mock.method(engine, 'resumeCodexSession', async () => {
  starts++
  return { threadId: 'replacement-thread', close() { closes++ }, adapter: { sendTurn: async () => ({ turnId: 't2' }), interrupt() {} } }
 })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const identity = { treeIdentity: { selfName: 'Worker', managerName: 'Controller' }, requestKeys: { treeAnchors: ['root', 'node-42'], threadId: 'node-42' } }
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
  confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async () => blocked
   ? ({ rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL', attempts: [{ account: 'primary', status: 'exhausted' }] })
   : ({ rotated: true, account: { name: 'primary', provider: 'codex' } }),
 })
 try {
  await host.startSession({ sessionId: 'old', ...identity })
  assert.equal(starts, 1)
  blocked = true
  await assert.rejects(host.startSession({ sessionId: 'replacement', resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary', replacesSessionId: 'old', ...identity }),
   { code: 'AGENT_RESUME_ACCOUNT_LIMIT' })
  assert.equal(starts, 1, 'account refusal must not dispatch a replacement provider')
  assert.equal(closes, 0, 'account refusal must not close the running predecessor')
  assert.ok(host.sessionAccounts().some(row => row.sessionId === 'old'), 'the original session remains running after refusal')
  blocked = false
  await host.startSession({ sessionId: 'replacement', resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary', replacesSessionId: 'old', ...identity })
  assert.equal(starts, 2, 'an admitted replacement starts exactly one provider')
  assert.equal(closes, 1, 'an admitted replacement closes exactly one predecessor')
  assert.ok(!host.sessionAccounts().some(row => row.sessionId === 'old'), 'the predecessor is retired only after replacement admission')
  assert.ok(host.sessionAccounts().some(row => row.sessionId === 'replacement'))
 } finally { await host.closeAll(); removeScratch(cwd) }
})





/* THE ATTRIBUTION LEAVES THE HOST ON THE REFUSAL, OR NOT AT ALL.
 *
 * ABSENT FIRST. A probe that predates exhaustedBy says nothing, and the refusal
 * must then say nothing either -- not 'provider', not 'configured'. Everything
 * downstream treats a missing answer as "leave this conversation alone", so a
 * default invented here would defeat that at the source. */
test('a resume limit refusal carries the measured attribution, and carries nothing when the probe did not say', async t => {
 const cwd = createScratch('resume-attribution-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath)
 t.mock.method(engine, 'resumeCodexSession', async () => { throw new Error('must not spawn') })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 let measured = null
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
  confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async () => ({ rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL',
   attempts: [{ account: 'primary', status: 'exhausted', ...measured }] }),
 })
 const refusalFor = async id => {
  let thrown = null
  await host.startSession({ sessionId: id, resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary' })
   .then(() => { throw new Error('the resume should have been refused') }, error => { thrown = error })
  return thrown
 }
 try {
  // 1. THE PROBE DID NOT SAY. No attribution may appear.
  measured = null
  const silent = await refusalFor('resume-silent')
  assert.equal(silent.code, 'AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal('exhaustedBy' in silent, false, 'an unmeasured limit must not acquire an attribution')

  // 2. THE PROVIDER REFUSED IT, measured. The fact travels verbatim.
  measured = { exhaustedBy: 'provider', exhaustedLimit: 100 }
  const provider = await refusalFor('resume-provider')
  assert.equal(provider.code, 'AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal(provider.exhaustedBy, 'provider')

  // 3. AND A VALUE THIS CONTRACT DOES NOT NAME IS DROPPED, not passed through:
  // the refusal is an allowlist, never a way for an arbitrary field to leave.
  measured = { exhaustedBy: 'something-else' }
  const junk = await refusalFor('resume-junk')
  assert.equal('exhaustedBy' in junk, false)
 } finally { await host.closeAll(); removeScratch(cwd) }
})
