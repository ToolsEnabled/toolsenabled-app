import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require_ = createRequire(import.meta.url)
const main = fs.readFileSync(path.join(ROOT, 'shell', 'main.cjs'), 'utf8')
const { createTaskAssignmentAuthority } = require_(path.join(ROOT, 'shell', 'task-assignment-target-authority.cjs'))

function functionSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(start >= 0 && end > start, `production function interval exists: ${startMarker}`)
  return source.slice(start, end)
}

function engineRoot() {
  const candidates = [
    process.env.MC_CANONICAL_ROOT,
    process.env.T1630_ENGINE_ROOT,
    process.env.TOOLSENABLED_TEST_ENGINE_ROOT,
  ].filter(value => typeof value === 'string' && value)
  const found = candidates.map(value => path.resolve(value)).find(value =>
    fs.existsSync(path.join(value, 'src', 'lib', 'owner-request-store.js')))
  assert.ok(found, 'the real composed Engine checkout is required for the main registration seam')
  return found
}

test('main assignment registration reaches the real writer and keeps removal methods private', () => {
  const priorStateRoot = process.env.TOOLSENABLED_STATE_ROOT
  // Retained inert state: registration reads the current kill marker but does
  // not write a profile marker or touch the application state tree.
  const retainedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-enabled-task-assignment-'))
  process.env.TOOLSENABLED_STATE_ROOT = retainedStateRoot
  let loaded
  let registration
  try {
    const canonicalEngineRoot = engineRoot()
    loaded = require_(path.join(canonicalEngineRoot, 'src', 'lib', 'owner-request-store.js'))
    const modelRegistry = require_(path.join(canonicalEngineRoot, 'src', 'lib', 'tool-registry.js'))
    const modelTiers = require_(path.join(canonicalEngineRoot, 'src', 'lib', 'mission-bridge', 'actions.js')).TIERS
    assert.equal(typeof modelRegistry.resolveTreeModelChoice, 'function', 'the composed registry must expose the real model resolver')

    const register = vm.runInNewContext(`(${functionSource(
      main,
      'function registerTaskLedgerAssignmentWriter(',
      '\nfunction getTaskLedgerAssignmentWriter',
    )})`, {
      TASK_ASSIGNMENT_PRINCIPAL: 'task-assignment-service',
      assignmentAuthorityFailure(code, reason) {
        throw Object.assign(new Error(reason), { code })
      },
    })
    const org = {
      ok: true,
      org: { revision: 1, agents: [
        { id: 'controller-seat', enabled: true, role: 'manager' },
        { id: 'worker-seat', enabled: true, role: 'worker' },
      ] },
      roles: [{ id: 'manager', revision: 1 }, { id: 'worker', revision: 1 }],
    }
    const readCoordinator = vm.runInNewContext(`(${functionSource(
      main,
      'function readTaskAssignmentCoordinator(',
      '\nfunction readTaskAssignmentSessions',
    )})`, {
      TASK_LEDGER_HOST_SESSION_ID: 'host-session',
      assignmentAuthorityFailure(code, reason) {
        throw Object.assign(new Error(reason), { code })
      },
      agentSessions: new Map([['controller-session', {
        state: 'ready', ended: false, closeRequested: false,
        agentId: 'controller-seat', agentAuthority: { roleId: 'manager' },
      }]]),
      agentHost: {
        readTreeParent() {
          return {
            sessionId: 'controller-session', agentId: 'controller-seat', nodeId: 'controller-node',
            treeId: 'root-node', treeAnchors: ['root-node', 'controller-node'],
          }
        },
      },
      agentOrgRecord: { read: () => org },
    })
    const coordinatorIdentity = readCoordinator({
      sessionId: 'controller-session', agentId: 'controller-seat', roleId: 'manager',
      expectedOrgRevision: 1, expectedRoleRevision: 1,
    })
    assert.equal(coordinatorIdentity.agentId, 'controller-seat')
    assert.equal(coordinatorIdentity.nodeId, 'controller-node')
    assert.notEqual(coordinatorIdentity.agentId, coordinatorIdentity.nodeId, 'root seat and saved Controller node remain distinct')
    const sessions = new Map([['worker-session', {
      sessionId: 'worker-session', state: 'ready', closeRequested: false, ended: false,
      agentId: 'worker-seat', roleId: 'worker', treeNodeKey: 'worker-node', threadId: 'provider-thread',
      treeRequestIdentity: { treeAnchors: ['root-node', 'controller-node', 'worker-node'] },
      requestedModelTier: 'luna', provider: 'codex', model: 'gpt-test', effort: 'low',
    }]])
    const current = {
      actor: 'agent', agentId: 'controller-seat', nodeId: 'controller-node',
      hostSessionId: 'host-session', sessionId: 'controller-session', treeId: 'root-node',
      treeAnchors: ['root-node', 'controller-node'], roleId: 'manager', roleRevision: 1, orgRevision: 1,
    }
    const assignmentAuthority = createTaskAssignmentAuthority({
      readOrg: () => org,
      readSessions: () => sessions,
      readCurrentCoordinator: () => current,
      readSettings: () => ({
        values: { 'agent.task_difficulty_enabled': true }, rejected: [], revision: 1,
      }),
      resolveTargetConfiguration: session => ({
        tier: session.requestedModelTier, provider: session.provider,
        model: session.model, effort: session.effort,
      }),
    })
    const result = register({
      loaded,
      modelRegistry,
      modelTiers,
      coordinatorIdentity,
      assignmentAuthority,
    })
    registration = result.registration
    assert.equal(typeof assignmentAuthority.assertCurrent, 'function', 'the composed authority exposes its coordinator fence')
    assert.equal(typeof result.capability.assignTask, 'function')
    assert.equal(typeof result.capability.prepareTaskHandoff, 'undefined', 'assignment cannot acquire native removal methods')
    assert.equal(typeof result.capability.commitTaskHandoff, 'undefined', 'assignment cannot acquire topology methods')
  } finally {
    if (registration && loaded && typeof loaded.revokeTaskLedgerWriter === 'function') {
      try { loaded.revokeTaskLedgerWriter(registration, 'TEST_COMPLETE') } catch {}
    }
    try { loaded && require_(path.join(engineRoot(), 'src', 'lib', 'state-store.js')).closeStateStore() } catch {}
    if (priorStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT
    else process.env.TOOLSENABLED_STATE_ROOT = priorStateRoot
  }
})
