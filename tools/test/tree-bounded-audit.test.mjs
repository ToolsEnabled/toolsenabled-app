import sessionChangePaths from '../../shell/session-change-paths.cjs'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { createScreenControlHost } from '../../shell/screen-control-host.cjs'
import { createSessionDiffAccess } from '../../shell/session-diff-access.cjs'

const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
function productionFunction(name) {
  const start = main.search(new RegExp(`(?:async )?function ${name}\\(`))
  const end = main.indexOf('\n}', start)
  assert.ok(start >= 0 && end > start, `missing production audit function ${name}`)
  return main.slice(start, end + 2)
}

// Exercise the maintained grant store alongside the signed session ending.
// Only the native adapter/indicator boundaries are fixtures; no desktop input
// or native permission qualification is claimed by this unit test.
async function screenGrants(t) {
  const owner = { isDestroyed: () => false }
  const sessions = new Map(['child-session', 'unrelated-session'].map(sessionId => [sessionId, {
    owner, ownerKind: 'window', agentId: sessionId,
  }]))
  const host = createScreenControlHost({ sessions,
    readBinding: () => ({ enabled: true, revision: 1, roleId: 'builder' }),
    permissionLevel: () => 'unrestricted', adapter: { supported: () => true },
    // The host refuses to construct without the desktop lease release
    // operation (610f2025); these grants never run a native action.
    indicator: { ready: async () => {}, show() {}, hide() {}, release() {} }, audit: async () => {},
  })
  t.after(() => host.revokeAll())
  await host.grant(owner, { sessionIds: [...sessions.keys()] })
  assert.equal(host.state(owner).grants.length, 2)
  return { host, owner }
}

test('actual main audit records the admitted parent and cap on its signed start and end, with matching retained receipts', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tree-bounded-audit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // Local test keystore contract only; this does not claim native Electron
  // key protection or call the canonical audit service/provider.
  const recorder = createSpawnRecorder({ directory, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
    decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
  } })
  const canonical = []
  const screen = await screenGrants(t)
  const factory = new Function('deps', `const {getSpawnRecorder,recordCanonical,accountPrincipal,agentIpcError,sessionStartRefusalSentence,accessibilityHost,screenControlHost,sessionDiffAccess}=deps;
    const UNAUTHENTICATED_PRINCIPAL = 'unauthenticated', accountResetStarted = false;
    ${['spawnRecordAgentId', 'spawnRecordDetails', 'recordSpawnIntent', 'recordSessionEndImpl'].map(productionFunction).join('\n')}
    return {recordSpawnIntent,recordSessionEndImpl};`)
  const api = factory({ getSpawnRecorder: () => recorder,
    sessionDiffAccess: createSessionDiffAccess({ path, sessions: new Map() }),
    recordCanonical: async (...args) => { canonical.push(args); return { ok: true } },
    accountPrincipal: () => 'fixture-owner', agentIpcError: code => { throw Object.assign(new Error(code), { code }) },
    sessionStartRefusalSentence: () => 'fixture refusal', accessibilityHost: { revokeSession() {} }, screenControlHost: screen.host,
  })
  const admitted = { action: 'tree.dispatch', computerId: 'computer', treeId: 'tree', parentNodeId: 'selected-parent',
    parentSessionId: 'parent-session', nodeId: 'saved-child', agentId: 'saved-child', sessionId: 'child-session',
    capMs: 60000, startedAt: 1000, deadlineAt: 61000 }
  const start = await api.recordSpawnIntent({ sessionId: 'child-session', agentId: 'saved-child', cwd: directory,
    boundedWork: { parentNodeId: 'untrusted-copy' }, boundedWorkPermit: { details: admitted } })
  assert.deepEqual(canonical[0][2].boundedWork, admitted)
  const session = { agentId: 'saved-child', boundedWork: admitted, started: { sequence: start.sequence }, turnsCompleted: 1, lastTurnStatus: 'completed' }
  const end = api.recordSessionEndImpl(session, 'child-session', 'closed')
  assert.equal(session.endRecord, end)
  assert.deepEqual(screen.host.state(screen.owner).grants.map(row => row.sessionId), ['unrelated-session'])
  const rows = readFileSync(recorder.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows.map(row => row.details.boundedWork), [admitted, admitted])
  assert.equal(rows[1].end.resolves, start.sequence)
  assert.equal(end.eventHash, rows[1].eventHash)
  assert.deepEqual(recorder.verify(), { ok: true, count: 2 })
  rows[0].details.boundedWork.parentNodeId = 'another-parent'
  writeFileSync(recorder.ledgerPath, rows.map(JSON.stringify).join('\n') + '\n')
  assert.equal(recorder.verify().code, 'SPAWN_RECORD_HASH_MISMATCH')
})

for (const reason of ['cap-reached', 'parent-stopped']) {
  test(`the actual main event fanout signs ${reason} without changing it to an ordinary stop`, async t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tree-bounded-cause-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const recorder = createSpawnRecorder({ directory, safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(Buffer.from(value).toString('base64')),
      decryptString: value => Buffer.from(value.toString(), 'base64').toString(),
    } })
    const boundedWork = { action: 'tree.dispatch', computerId: 'computer', treeId: 'tree',
      parentNodeId: 'parent', parentSessionId: 'parent-session', nodeId: 'child', agentId: 'child',
      sessionId: 'child-session', capMs: 60000, startedAt: 1000, deadlineAt: 61000 }
    const start = recorder.record({ action: 'agent_session_start', sessionId: 'child-session', details: { agentId: 'child', boundedWork } })
    const session = { agentId: 'child', boundedWork, started: { sequence: start.sequence }, turnsCompleted: 1, lastTurnStatus: 'completed' }
    const sessions = new Map([['child-session', session]])
    const makeEnd = new Function('deps', `const {getSpawnRecorder,accountPrincipal,accessibilityHost,screenControlHost,sessionDiffAccess}=deps;
      ${['spawnRecordAgentId', 'spawnRecordDetails', 'recordSessionEndImpl'].map(productionFunction).join('\n')}
      return recordSessionEndImpl;`)
    const screen = await screenGrants(t)
    const end = makeEnd({ getSpawnRecorder: () => recorder, accountPrincipal: () => 'fixture-owner', accessibilityHost: { revokeSession() {} }, screenControlHost: screen.host,
      sessionDiffAccess: createSessionDiffAccess({ path, sessions }) })
    const marker = 'removeAgentEventListener = host.onEvent('
    const begin = main.indexOf(marker), finish = main.indexOf('\n  })', begin)
    assert.ok(begin >= 0 && finish > begin)
    let forwarded = 0
    const event = vm.runInNewContext(`(${main.slice(begin + marker.length, finish + 4)})`, {
      bindSessionChangePaths: sessionChangePaths.bindSessionChangePaths, WORKSPACE_ROOT: process.cwd(), path,
        agentSessions: sessions, recordSessionEnd: end,
      mainLagMonitor: { note: (name, action) => action() },
      getAgentCommandSurface: () => ({ forwardSessionEvent: () => { forwarded++; return true } }),
      transcriptCapture: { packet() {} }, noteAgentTurnUsage() {}, noteAgentTurnCompleted() {}, ownedByThisWindow: () => false,
    })
    event({ sessionId: 'child-session', event: { type: 'session_ended', reason } })
    const history = recorder.history()
    assert.equal(history.verified, true)
    const endings = history.entries.filter(row => row.action === 'agent_session_end')
    assert.equal(endings.length, 1)
    assert.equal(endings[0].end.reason, reason, 'the signed ledger must preserve the same cause as the host status')
    assert.equal(endings[0].end.resolves, start.sequence)
    const recordedEnd = readFileSync(recorder.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse)
      .find(row => row.action === 'agent_session_end')
    assert.deepEqual(recordedEnd.details.boundedWork, boundedWork, 'the signed bytes retain the admitted cap and parent')
    assert.equal(session.endRecord.sequence, endings[0].sequence)
    assert.equal(session.endRecord.eventHash, recordedEnd.eventHash)
    assert.equal(forwarded, 1)
    assert.equal(sessions.size, 0)
    assert.deepEqual(screen.host.state(screen.owner).grants.map(row => row.sessionId), ['unrelated-session'])
    end(session, 'child-session', 'closed')
    assert.equal(recorder.history().entries.filter(row => row.action === 'agent_session_end').length, 1,
      'a later explicit close cannot overwrite the already observed cause or append a second ending')
  })
}
