'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const refuse = message => { throw Object.assign(new Error(message), { code: 'RESEARCH_DELEGATION_REFUSED' }) }
const within = (root, child) => {
  const relative = path.relative(root, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
}

function createResearchDelegationAuthority({ readParent, normalizeRequest, validateAccess, enforceAccess, roomsRoot, ttlMs = 330000, now = Date.now }) {
  if (![readParent, normalizeRequest, validateAccess, enforceAccess].every(fn => typeof fn === 'function')
      || !path.isAbsolute(roomsRoot || '')) refuse('Research delegation requires its paired engine and private room storage.')
  const records = new Map()
  function current(record) {
    if (record.cancelled || now() >= record.expires) refuse('This research start is no longer available.')
    const parent = readParent(record.parent.sessionId)
    if (!parent || JSON.stringify(parent) !== record.parentSnapshot) refuse('The research parent changed before its child started.')
    enforceAccess('host.list_dir', { path: record.parentAccess.root }, record.parentAccess)
    enforceAccess('host.list_dir', { path: record.access.root }, record.access)
    return parent
  }
  function freshRoomBase() {
    const target = path.resolve(roomsRoot)
    let ancestor = target
    while (!fs.existsSync(ancestor)) {
      const next = path.dirname(ancestor)
      if (next === ancestor) refuse('Research room storage is unavailable.')
      ancestor = next
    }
    validateAccess({ version: 1, mode: 'clean-room', root: ancestor, access: 'read-write' })
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    return validateAccess({ version: 1, mode: 'clean-room', root: target, access: 'read-write' }).root
  }
  function prepareAccess(research, parentAccess = null) {
    let access, room = null
    if (research.mode === 'folder') {
      if (!parentAccess || !within(parentAccess.root, path.resolve(research.folder))) refuse('The selected research folder is outside its parent boundary.')
      const selected = enforceAccess('host.list_dir', { path: research.folder }, parentAccess)
      access = validateAccess({ version: 1, mode: 'folder', root: selected.path, access: research.access })
    } else {
      const base = freshRoomBase()
      room = fs.mkdtempSync(path.join(base, 'room-'))
      try {
        for (const file of research.files) {
          const destination = path.join(room, ...file.path.split('/'))
          if (!within(room, destination)) refuse('A clean-room input left its new room.')
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
          fs.writeFileSync(destination, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        }
        access = validateAccess({ version: 1, mode: 'clean-room', root: room, access: research.access })
      } catch (error) {
        // This directory was minted here and has never been handed to an agent.
        fs.rmSync(room, { recursive: true, force: true })
        throw error
      }
    }
    return { access, room }
  }
  // Only the authenticated owner-window start handler calls this method. It
  // creates a new folder; a renderer path can never become an access grant.
  function prepareSetup(request, owner) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      refuse('Research setup requires a fresh session request.')
    }
    const forbidden = ['delegationToken', 'resumeThreadId', 'resumeAccount', 'replacesSessionId',
      'continueFromAccount', 'accountRecovery', 'accountRetry', 'editorForkReceipt', 'editorFork',
      'boundedWork', 'boundedWorkPermit', 'delegationPermit']
    const validRequest = () => {
      if (typeof owner !== 'string' || !owner || typeof request.sessionId !== 'string' || !request.sessionId
          || typeof request.tier !== 'string' || !request.tier
          || typeof request.requestKeys?.threadId !== 'string' || !request.requestKeys.threadId
          || !Array.isArray(request.requestKeys.treeAnchors) || !request.requestKeys.treeAnchors.length
          || request.requestKeys.treeAnchors.length > 16
          || request.requestKeys.treeAnchors.at(-1) !== request.requestKeys.threadId
          || request.requestKeys.treeAnchors.some(anchor => typeof anchor !== 'string' || !anchor)
          || new Set(request.requestKeys.treeAnchors).size !== request.requestKeys.treeAnchors.length
          || forbidden.some(key => request[key] !== undefined)) {
        refuse('A new research clean room requires this owner window, a visible node, and a fresh session.')
      }
      const research = normalizeRequest(request.research)
      if (research.mode !== 'clean-room') refuse('Manual research setup creates a new clean room from explicit inputs only.')
      return research
    }
    const snapshot = () => JSON.stringify({ sessionId: request.sessionId, tier: request.tier,
      requestKeys: request.requestKeys, treeIdentity: request.treeIdentity,
      agentId: request.agentId, role: request.role, research: validRequest() })
    // Reject all mixed start modes before creating a room.
    if (request.researchPermit !== undefined) refuse('This research start already has a permit.')
    const expected = snapshot()
    const { access, room } = prepareAccess(validRequest())
    const record = { access, room, cancelled: false, expires: now() + ttlMs }
    let finished = false
    return Object.freeze({
      researchAccess: access,
      details: Object.freeze({ nodeId: request.requestKeys.threadId, mode: access.mode, access: access.access }),
      assertStart() {
        if (record.cancelled || now() >= record.expires || snapshot() !== expected) {
          refuse('This owner research setup changed or expired before startup.')
        }
        enforceAccess('host.list_dir', { path: access.root }, access)
      },
      cancel() { record.cancelled = true },
      finish({ failed = false } = {}) {
        if (finished) return
        record.cancelled = true
        if (failed) {
          enforceAccess('host.list_dir', { path: room }, access)
          fs.rmSync(room, { recursive: true, force: true })
        }
        finished = true
      },
    })
  }
  function issue(parentSessionId, owner, request, nodeId) {
    const parent = readParent(parentSessionId)
    if (!parent || parent.owner !== owner || parent.permissionSession?.origin !== 'local'
        || !['full', 'confined'].includes(parent.permissionSession.tier)
        || !parent.agentId || !parent.nodeId || !parent.treeId
        || !Array.isArray(parent.treeAnchors) || !parent.treeAnchors.length || parent.treeAnchors.length >= 16
        || typeof nodeId !== 'string' || !nodeId || typeof request.tier !== 'string' || typeof request.role !== 'string') {
      refuse('Research delegation needs its authenticated running parent on the visible tree.')
    }
    const parentAccess = parent.researchAccess
      ? validateAccess(parent.researchAccess)
      : validateAccess({ version: 1, mode: 'folder', root: parent.cwd, access: 'read-write' })
    const research = normalizeRequest(request.research)
    if (parentAccess.access === 'read-only' && research.access !== 'read-only') refuse('A child cannot gain write access from a read-only research parent.')
    const { access, room } = prepareAccess(research, parentAccess)
    const token = randomBytes(32).toString('base64url')
    const record = { parent, parentSnapshot: JSON.stringify(parent), parentAccess, owner, nodeId,
      research, access, room, tier: request.tier, role: request.role, expires: now() + ttlMs, cancelled: false, redeemed: false }
    records.set(token, record)
    return Object.freeze({ token, parent, access, research })
  }
  function redeem(token, request, owner) {
    const record = records.get(token)
    if (!record || record.redeemed) refuse('This research start token has already been used or expired.')
    record.redeemed = true
    try {
      current(record)
      if (owner !== record.owner || request.requestKeys?.threadId !== record.nodeId
          || JSON.stringify(request.requestKeys?.treeAnchors) !== JSON.stringify([...record.parent.treeAnchors, record.nodeId])
          || request.tier !== record.tier || request.agentAuthority?.roleId !== record.role
          || !request.agentId || request.agentId !== record.nodeId
          || JSON.stringify(normalizeRequest(request.research)) !== JSON.stringify(record.research)
          || ['resumeThreadId', 'resumeAccount', 'replacesSessionId', 'continueFromAccount', 'accountRecovery',
            'accountRetry', 'editorFork', 'boundedWork'].some(key => request[key] !== undefined)) {
        refuse('The research start token belongs to a different child, owner, scope or set of inputs.')
      }
      return Object.freeze({
        researchAccess: record.access,
        details: Object.freeze({ parentSessionId: record.parent.sessionId, nodeId: record.nodeId,
          mode: record.access.mode, access: record.access.access }),
        assertStart() { current(record) },
        cancel() { record.cancelled = true },
      })
    } catch (error) {
      record.cancelled = true
      throw error
    }
  }
  function finish(token, { failed = false } = {}) {
    const record = records.get(token)
    if (!record) return
    records.delete(token)
    record.cancelled = true
    if (failed && record.room) {
      // Only after the caller has confirmed provider cleanup. Revalidate identity
      // so replacement/link attacks never turn scratch cleanup into other data.
      enforceAccess('host.list_dir', { path: record.room }, record.access)
      fs.rmSync(record.room, { recursive: true, force: true })
    }
  }
  return Object.freeze({ issue, redeem, finish, prepareSetup })
}
module.exports = { createResearchDelegationAuthority }
