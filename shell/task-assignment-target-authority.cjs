'use strict'

/* Host-only target binding for T1139.  This module never accepts renderer
 * authority or a writer token. The app supplies current saved organisation
 * and live authenticated sessions; the engine assignment transaction calls
 * the returned resolver while its own task/settings lock is held. */

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const ASSIGNABLE_STATES = new Set(['open', 'in-progress', 'blocked-external'])

function refusal(code, message) {
  throw Object.assign(new Error(message), { code })
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function key(value, label) {
  if (typeof value !== 'string' || !SAFE_KEY.test(value)) refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', `${label} is not a verified host key.`)
  return value
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', `${label} is unavailable.`)
  return value
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index])
}

function sameObject(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameObject(value, right[index]))
  }
  if (!plain(left) || !plain(right)) return left === right
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return sameArray(leftKeys, rightKeys)
    && leftKeys.every(name => sameObject(left[name], right[name]))
}

function freezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy))
  if (plain(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, item]) => [name, freezeCopy(item)])))
  return value
}

function copyConfiguration(value) {
  if (!plain(value)
      || typeof value.tier !== 'string' || !value.tier
      || typeof value.provider !== 'string' || !value.provider
      || typeof value.model !== 'string' || !value.model
      || typeof value.effort !== 'string' || !value.effort) {
    refusal('T_LEDGER_ASSIGNMENT_TARGET_REFUSED', 'The target configuration is incomplete or untrusted.')
  }
  return Object.freeze({
    tier: value.tier,
    provider: value.provider,
    model: value.model,
    effort: value.effort,
  })
}

function liveSession(session) {
  return plain(session) && typeof session.sessionId === 'string' && SAFE_KEY.test(session.sessionId)
    && session.state === 'ready' && session.closeRequested !== true && session.ended !== true
    && typeof session.agentId === 'string' && SAFE_KEY.test(session.agentId)
    && typeof session.treeNodeKey === 'string' && SAFE_KEY.test(session.treeNodeKey)
    && plain(session.treeRequestIdentity)
    && Array.isArray(session.treeRequestIdentity.treeAnchors)
    && session.treeRequestIdentity.treeAnchors.length > 0
    && session.treeRequestIdentity.treeAnchors.every(item => typeof item === 'string' && SAFE_KEY.test(item))
    && new Set(session.treeRequestIdentity.treeAnchors).size === session.treeRequestIdentity.treeAnchors.length
    && session.treeRequestIdentity.treeAnchors.at(-1) === session.treeNodeKey
}

function sourceTaskBelongsToCoordinator(task, current) {
  if (!plain(task) || typeof task.scope !== 'string') return false
  if (task.scope === 'global') return true
  if (typeof task.scopeKey !== 'string' || !SAFE_KEY.test(task.scopeKey)) return false
  if (task.scope === 'session') return task.scopeKey === current.sessionId
  // Ledger thread scope is keyed to the saved node that owns the task.  The
  // provider conversation/thread is a separate authority field.  Source-task
  // ownership is checked against the authenticated coordinator; recipient
  // descendant binding is checked separately below.
  if (task.scope === 'thread') return task.scopeKey === current.nodeId
  if (task.scope === 'tree') return current.treeAnchors.includes(task.scopeKey)
  return false
}

/* A SECOND CLAIMANT IS TOLD WHO HOLDS THE TASK (T1736). Once a task has been
 * handed out, the store records its owner (ownerState 'assigned',
 * ownerNodeId); only that owner's own line of the tree can hand it on. Any
 * other coordinator is refused with the owner's name instead of the generic
 * subtree sentence, so two parents never race for the same task in silence. */
function currentOwnerName(org, ownerNodeId) {
  const rows = Array.isArray(org?.org?.agents)
    ? org.org.agents.filter(row => plain(row) && (row.id === ownerNodeId || row.nodeId === ownerNodeId)) : []
  const name = rows.length === 1 && typeof rows[0].displayName === 'string' ? rows[0].displayName.trim() : ''
  return name ? `${name}, node ${ownerNodeId}` : `node ${ownerNodeId}`
}

function roleRecordFor(org, roleId, label) {
  const roles = Array.isArray(org.roles) ? org.roles.filter(row => plain(row) && row.id === roleId) : []
  if (roles.length !== 1 || !Number.isSafeInteger(roles[0].revision) || roles[0].revision < 0) {
    refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', `${label} role membership is ambiguous or unavailable.`)
  }
  return roles[0]
}

function createTaskAssignmentAuthority({
  readOrg,
  readSessions,
  readCurrentCoordinator,
  readSettings,
  resolveTargetConfiguration,
} = {}) {
  if (typeof readOrg !== 'function' || typeof readSessions !== 'function'
      || typeof readCurrentCoordinator !== 'function'
      || typeof readSettings !== 'function' || typeof resolveTargetConfiguration !== 'function') {
    throw new TypeError('createTaskAssignmentAuthority needs host organisation, sessions, coordinator, settings and target configuration readers.')
  }

  function snapshot() {
    const currentInput = readCurrentCoordinator()
    if (!plain(currentInput)) refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The current coordinator authority is unavailable.')
    const current = {
      actor: currentInput.actor,
      // The authenticated organisation seat and the saved tree node are
      // different identities for a Controller rooted through ensureSeatForNode.
      // Keep the seat for organisation/role validation; nodeId remains the
      // saved-tree identity used by scope and ancestry checks.
      agentId: currentInput.agentId === null || currentInput.agentId === undefined
        ? null : key(currentInput.agentId, 'The coordinator organisation seat'),
      nodeId: currentInput.nodeId === null ? null : key(currentInput.nodeId, 'The coordinator node'),
      hostSessionId: key(currentInput.hostSessionId, 'The coordinator host session'),
      sessionId: key(currentInput.sessionId, 'The coordinator session'),
      treeId: key(currentInput.treeId, 'The coordinator tree'),
      treeAnchors: Array.isArray(currentInput.treeAnchors)
        ? currentInput.treeAnchors.map(anchor => key(anchor, 'The coordinator tree ancestry')) : null,
      roleId: currentInput.roleId === null || currentInput.roleId === undefined
        ? null : key(currentInput.roleId, 'The coordinator role'),
      roleRevision: currentInput.roleRevision === null || currentInput.roleRevision === undefined
        ? null : revision(currentInput.roleRevision, 'The coordinator role revision'),
      orgRevision: revision(currentInput.orgRevision, 'The coordinator organisation revision'),
    }
    if (!['human', 'agent'].includes(current.actor)
        || (current.actor === 'human' && current.nodeId !== null)
        || (current.actor === 'agent' && (current.nodeId === null || current.agentId === null))) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The current coordinator identity is unavailable or ambiguous.')
    }
    if (!current.treeAnchors?.length || current.treeAnchors[0] !== current.treeId
        || new Set(current.treeAnchors).size !== current.treeAnchors.length) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The current coordinator tree ancestry is unavailable.')
    }
    if (current.actor === 'agent'
        && (!current.treeAnchors.includes(current.nodeId)
          || current.treeAnchors.at(-1) !== current.nodeId)) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The current coordinator is not bound to the saved tree ancestry.')
    }
    const org = readOrg()
    if (!plain(org) || org.ok !== true || !plain(org.org) || !Array.isArray(org.org.agents)) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The saved organisation authority is unavailable.')
    }
    const orgRevision = revision(org.org.revision, 'The saved organisation revision')
    if (current.orgRevision !== orgRevision) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', 'The coordinator organisation revision changed; re-read the assignment target.')
    }
    if (current.actor === 'agent') {
      const coordinatorRows = org.org.agents.filter(row => plain(row) && row.id === current.agentId)
      if (coordinatorRows.length !== 1 || coordinatorRows[0].enabled === false
          || (current.roleId && coordinatorRows[0].role !== current.roleId)) {
        refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_UNKNOWN', 'The current coordinator is not one unambiguous enabled organisation member.')
      }
      const role = roleRecordFor(org, coordinatorRows[0].role, 'The coordinator')
      if (current.roleRevision !== null && role.revision !== current.roleRevision) {
        refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', 'The coordinator role revision changed; re-authenticate the assignment.')
      }
      current.roleId = coordinatorRows[0].role
      current.roleRevision = role.revision
    }
    return {
      current: Object.freeze({ ...current, treeAnchors: Object.freeze([...current.treeAnchors]) }),
      org,
      orgRevision,
    }
  }

  function bindTarget(task, nodeId, assignmentId, initialSnapshot) {
    const targetNodeId = key(nodeId, 'The assignment target')
    const { current, org, orgRevision } = initialSnapshot || snapshot()
    if (!ASSIGNABLE_STATES.has(task.status)) {
      refusal('T_LEDGER_ASSIGNMENT_STATE_INVALID', 'Only open, in-progress or blocked-external tasks can be assigned.')
    }
    const ownsSource = sourceTaskBelongsToCoordinator(task, current)
    if (!ownsSource && task.ownerState === 'assigned'
        && typeof task.ownerNodeId === 'string' && SAFE_KEY.test(task.ownerNodeId)) {
      refusal('T_LEDGER_ASSIGNMENT_ALREADY_OWNED',
        `${task.id} is already assigned to ${currentOwnerName(org, task.ownerNodeId)}. Only that agent or an agent it manages can hand it on. No task was changed.`)
    }
    const sessions = readSessions()
    const candidates = sessions instanceof Map
      ? [...sessions.values()].filter(session => session?.treeNodeKey === targetNodeId)
      : Array.isArray(sessions) ? sessions.filter(session => session?.treeNodeKey === targetNodeId) : []
    const live = candidates.filter(liveSession)
    if (live.length !== 1) refusal(live.length === 0 ? 'T_LEDGER_ASSIGNMENT_TARGET_UNKNOWN' : 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED', 'The assignment target does not have exactly one live authenticated session.')
    const session = live[0]
    // The session's authenticated organisation seat is authoritative for
    // role/membership.  treeNodeKey is the saved node used for descendant and
    // Ledger scope binding; it is not silently treated as the seat id.
    const targetAgentId = session.agentId
    const agentRows = org.org.agents.filter(row => plain(row) && row.id === targetAgentId)
    if (agentRows.length !== 1 || agentRows[0].enabled === false
        || (session.roleId !== null && session.roleId !== undefined && session.roleId !== agentRows[0].role)) {
      refusal(agentRows.length === 0 ? 'T_LEDGER_ASSIGNMENT_TARGET_UNKNOWN' : 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED', 'The assignment target session is not one unambiguous enabled organisation member.')
    }
    const targetRole = roleRecordFor(org, agentRows[0].role, 'The assignment target')
    const treeAnchors = [...session.treeRequestIdentity.treeAnchors]
    // A target is a descendant only when its verified saved ancestry extends
    // the entire current coordinator ancestry. Root equality alone permits a
    // manager to select a sibling or an ancestor-shaped path.
    const isDescendant = treeAnchors.length > current.treeAnchors.length
      && sameArray(treeAnchors.slice(0, current.treeAnchors.length), current.treeAnchors)
      && treeAnchors.at(-1) === targetNodeId
      && (current.actor === 'human' || targetNodeId !== current.nodeId)
    if (!isDescendant || !ownsSource) {
      refusal('T_LEDGER_ASSIGNMENT_TARGET_REFUSED', 'The assignment target is outside the coordinator subtree, task ownership or current coordinator tree.')
    }
    let targetConfiguration
    try { targetConfiguration = resolveTargetConfiguration(session, { nodeId: targetNodeId, orgRevision }) } catch (error) {
      refusal(error?.code || 'T_LEDGER_ASSIGNMENT_TARGET_REFUSED', error?.message || 'The target configuration could not be verified.')
    }
    targetConfiguration = copyConfiguration(targetConfiguration)
    const target = Object.freeze({
      targetAgentId: targetNodeId,
      agentId: targetAgentId,
      nodeId: targetNodeId,
      roleId: agentRows[0].role,
      // Assignment changes ownership.  The source task's scope above is
      // used only for authorization; the durable recipient scope is always
      // the saved recipient node, never a provider conversation id or a
      // global/null source key.
      scope: task.scope === 'thread' ? 'thread' : 'tree',
      scopeKey: targetNodeId,
      ownerNodeId: targetNodeId,
      sessionId: session.sessionId,
      treeId: treeAnchors[0],
      treeAnchors: Object.freeze([...treeAnchors]),
      threadId: session.threadId || null,
    })
    const locality = Object.freeze({
      sameHost: true,
      sameTree: current.actor === 'human' || treeAnchors.includes(current.nodeId),
    })
    const authorityReceipt = Object.freeze({
      kind: 'task-assignment-authority', taskId: task.id, assignmentId,
      targetAgentId: targetNodeId, targetSeatAgentId: targetAgentId,
      sessionId: session.sessionId, threadId: session.threadId || null, treeId: treeAnchors[0],
      treeAnchors: Object.freeze([...treeAnchors]), roleId: agentRows[0].role,
      scope: target.scope, scopeKey: target.scopeKey, ownerNodeId: target.ownerNodeId,
      roleRevision: targetRole.revision,
      coordinatorActor: current.actor, coordinatorAgentId: current.agentId,
      coordinatorHostSessionId: current.hostSessionId, coordinatorSessionId: current.sessionId,
      coordinatorTreeId: current.treeId, coordinatorTreeAnchors: Object.freeze([...current.treeAnchors]),
      coordinatorRoleId: current.roleId, coordinatorRoleRevision: current.roleRevision,
      coordinatorNodeId: current.nodeId, orgRevision,
    })
    return Object.freeze({
      taskId: task.id,
      assignmentId,
      targetAgentId: targetNodeId,
      target,
      locality,
      targetConfiguration,
      authorityRevision: orgRevision,
      authorityReceipt,
      current,
      targetRoleRevision: targetRole.revision,
    })
  }

  function resolveAssignmentAuthority({ task, nodeId, assignmentId, assignmentReplayContext } = {}) {
    if (!plain(task) || typeof task.id !== 'string' || !SAFE_KEY.test(task.id)
        || typeof assignmentId !== 'string' || !SAFE_KEY.test(assignmentId)) {
      refusal('T_LEDGER_ASSIGNMENT_INVALID', 'The assignment task or id is malformed.')
    }
    const frozenTask = Object.freeze({
      id: task.id, scope: task.scope, scopeKey: task.scopeKey || null, status: task.status,
      ownerState: typeof task.ownerState === 'string' ? task.ownerState : null,
      ownerNodeId: typeof task.ownerNodeId === 'string' ? task.ownerNodeId : null,
    })
    let replay = null
    if (assignmentReplayContext !== undefined) {
      const source = assignmentReplayContext?.source
      if (!plain(assignmentReplayContext) || assignmentReplayContext.kind !== 'task-assignment-replay'
          || assignmentReplayContext.taskId !== task.id
          || assignmentReplayContext.assignmentId !== assignmentId
          || typeof assignmentReplayContext.targetAgentId !== 'string'
          || assignmentReplayContext.targetAgentId !== nodeId
          || !plain(source)
          || !['global', 'session', 'tree', 'thread'].includes(source.scope)
          || (source.scope === 'global'
            ? source.scopeKey !== null || source.ownerNodeId !== null
            : typeof source.scopeKey !== 'string' || !SAFE_KEY.test(source.scopeKey))
          || (source.ownerNodeId !== null && (typeof source.ownerNodeId !== 'string' || !SAFE_KEY.test(source.ownerNodeId)))
          || typeof source.coreSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.coreSha256)
          || !plain(assignmentReplayContext.target)
          || !plain(assignmentReplayContext.targetConfiguration)
          || !Number.isSafeInteger(assignmentReplayContext.authorityRevision)
          || assignmentReplayContext.authorityRevision < 0
          || !plain(assignmentReplayContext.authorityReceipt)
          || typeof assignmentReplayContext.actor !== 'string'
          || typeof assignmentReplayContext.reason !== 'string') {
        refusal('T_LEDGER_ASSIGNMENT_EVENT_CONFLICT', 'The saved assignment replay binding is incomplete or ambiguous.')
      }
      replay = Object.freeze({
        kind: assignmentReplayContext.kind,
        taskId: assignmentReplayContext.taskId,
        assignmentId: assignmentReplayContext.assignmentId,
        source: Object.freeze({
          scope: source.scope,
          scopeKey: source.scopeKey === undefined ? null : source.scopeKey,
          ownerNodeId: source.ownerNodeId === undefined ? null : source.ownerNodeId,
          coreSha256: source.coreSha256,
        }),
        targetAgentId: assignmentReplayContext.targetAgentId,
        target: freezeCopy(assignmentReplayContext.target),
        targetConfiguration: freezeCopy(assignmentReplayContext.targetConfiguration),
        authorityRevision: assignmentReplayContext.authorityRevision,
        authorityReceipt: freezeCopy(assignmentReplayContext.authorityReceipt),
        actor: assignmentReplayContext.actor,
        reason: assignmentReplayContext.reason,
      })
    }
    const authorizationTask = replay
      ? Object.freeze({ id: frozenTask.id, scope: replay.source.scope, scopeKey: replay.source.scopeKey, status: frozenTask.status })
      : frozenTask
    const initial = snapshot()
    const bound = bindTarget(authorizationTask, nodeId, assignmentId, initial)
    if (replay
        && (bound.targetAgentId !== replay.targetAgentId
          || !sameObject(bound.target, replay.target)
          || !sameObject(bound.targetConfiguration, replay.targetConfiguration)
          || bound.authorityRevision !== replay.authorityRevision
          || !sameObject(bound.authorityReceipt, replay.authorityReceipt))) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', 'The saved assignment target, configuration, receipt or coordinator authority changed before replay.')
    }
    const comparable = Object.freeze({
      current: bound.current,
      target: bound.target,
      targetConfiguration: bound.targetConfiguration,
      authorityRevision: bound.authorityRevision,
      targetRoleRevision: bound.targetRoleRevision,
    })
    const assertCurrent = () => {
      let refreshed
      try {
        refreshed = bindTarget(authorizationTask, nodeId, assignmentId, snapshot())
      } catch (error) {
        refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', error?.message || 'The assignment target or coordinator authority changed before the task write.')
      }
      if (!sameObject(refreshed.current, comparable.current)
          || !sameObject(refreshed.target, comparable.target)
          || !sameObject(refreshed.targetConfiguration, comparable.targetConfiguration)
          || refreshed.authorityRevision !== comparable.authorityRevision
          || refreshed.targetRoleRevision !== comparable.targetRoleRevision) {
        refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', 'The assignment target, configuration, session, ancestry or coordinator authority changed before the task write.')
      }
      return true
    }
    const { current, target, locality, targetConfiguration, authorityRevision, authorityReceipt } = bound
    return Object.freeze({
      taskId: task.id,
      assignmentId,
      targetAgentId: target.targetAgentId,
      target,
      locality,
      targetConfiguration,
      authorityRevision,
      authorityReceipt,
      assertCurrent,
      coordinator: Object.freeze({
        actor: current.actor, agentId: current.agentId, nodeId: current.nodeId, hostSessionId: current.hostSessionId,
        sessionId: current.sessionId, treeId: current.treeId,
        treeAnchors: Object.freeze([...current.treeAnchors]), orgRevision: current.orgRevision,
        ...(current.roleId ? { roleId: current.roleId } : {}),
      }),
    })
  }

  function readSettingsSnapshot() {
    const settings = readSettings()
    if (!plain(settings)) refusal('T_LEDGER_ASSIGNMENT_SETTINGS_UNAVAILABLE', 'The assignment settings snapshot is unavailable.')
    return Object.freeze({ ...settings })
  }

  // This fence is bound when the app registers the capability.  It is not the
  // per-target fence above: the latter protects the recipient/session/config;
  // this one protects the coordinator registration itself across a queued
  // dispatch or a coordinator/org revision change.
  const registrationBaseline = snapshot()
  const assertCurrent = () => {
    let refreshed
    try { refreshed = snapshot() } catch (error) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', error?.message || 'The coordinator authority changed before the task write.')
    }
    if (!sameObject(refreshed.current, registrationBaseline.current)
        || refreshed.orgRevision !== registrationBaseline.orgRevision) {
      refusal('T_LEDGER_ASSIGNMENT_AUTHORITY_CHANGED', 'The coordinator authority, ancestry, role or organisation revision changed before the task write.')
    }
    return true
  }

  return Object.freeze({ resolveAssignmentAuthority, readSettings: readSettingsSnapshot, assertCurrent })
}

module.exports = Object.freeze({ createTaskAssignmentAuthority, SAFE_KEY })
