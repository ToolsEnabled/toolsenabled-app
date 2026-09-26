'use strict';

const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const fail = () => { const e = new Error('Tree lifecycle authority refused this request.'); e.code = 'TREE_DELEGATION_REFUSED'; throw e; };
const string = v => typeof v === 'string' && v.length > 0 && v.length <= 4096;
function strings(v) {
  if (!Array.isArray(v) || !v.length || v.length > 128) return false;
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i) || !string(v[i])) return false;
  return new Set(v).size === v.length;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const fields = ['sessionId', 'nodeId', 'treeId', 'owner', 'cwd'];
function snapshot(r, target = false) {
  if (!r || typeof r.then === 'function' || !fields.every(k => string(r[k]))
      || !strings(r.treeAnchors) || !strings(r.workspaceRoots)
      // The tree identity IS its root node: a Controller has [controller],
      // not [separateTreeId, controller]. strings already requires nonempty.
      || r.treeAnchors[0] !== r.treeId
      || r.treeAnchors.at(-1) !== r.nodeId
      || r.permissionSession?.origin !== 'local' || r.permissionSession?.tier !== 'confined'
      || r.permissionSession?.profile !== 'workspace') fail();
  if (target && (!string(r.modelTier) || !string(r.roleId)
      || !(r.threadId === null || string(r.threadId)))) fail();
  return Object.freeze({ ...Object.fromEntries(fields.map(k => [k, r[k]])),
    ...(target ? { modelTier: r.modelTier, roleId: r.roleId, threadId: r.threadId } : {}),
    treeAnchors: Object.freeze([...r.treeAnchors]), workspaceRoots: Object.freeze([...r.workspaceRoots]),
    permissionSession: Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' }) });
}
function matches(a, b) {
  return Object.keys(b).every(k => k === 'permissionSession' ? true
    : Array.isArray(b[k]) ? same(a[k], b[k]) : a[k] === b[k]);
}

/** readParent returns live authority, never renderer state. readNode returns
 * the SAME immutable admission object until a new actual root is admitted;
 * keep it through stop. Replacement with equal contents is still a new version.
 * Canonical paths/inode validation belong to these trusted readers. This pure
 * module never resolves a filesystem path and is not an OS confinement proof.
 */
function createTreeLifecycleAuthority({ readParent, readNode, ttlMs, now = () => performance.now(), randomId = randomUUID }) {
  if (![readParent, readNode, now, randomId].every(v => typeof v === 'function')
      || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('Invalid lifecycle authority dependencies');
  const grants = new Map();
  const reservations = new Map();
  const reservationKey = (nodeId, owner) => JSON.stringify([owner, nodeId]);
  let last = -Infinity;
  let generation = 0n;
  let busy = false;
  const guarded = fn => (...args) => {
    if (busy) fail();
    busy = true;
    try { return fn(...args); } finally { busy = false; }
  };
  function clock() {
    const t = now();
    if (!Number.isFinite(t) || t < last) fail();
    last = t;
    return t;
  }
  function read(fn, ...args) { try { return fn(...args); } catch { fail(); } }
  function release(g) {
    g.cancelled = true;
    if (reservations.get(g.key) === g) reservations.delete(g.key);
    if (grants.get(g.token) === g) grants.delete(g.token);
  }
  function sweep() {
    const t = clock();
    for (const g of reservations.values()) if (t >= g.expiresAt) release(g);
  }
  function verify(g) {
    if (clock() >= g.expiresAt) release(g);
    if (g.cancelled || reservations.get(g.key) !== g) fail();
    const parent = snapshot(read(readParent, g.parent.sessionId));
    const record = read(readNode, g.target.nodeId, g.target.owner);
    const target = snapshot(record, true);
    if (record !== g.record || !matches(parent, g.parent) || !matches(target, g.target)) fail();
    if (clock() >= g.expiresAt) release(g);
    if (g.cancelled || reservations.get(g.key) !== g) fail();
    return true;
  }
  const issue = guarded((parentSessionId, owner, spec) => {
    sweep();
    if (!string(parentSessionId) || !string(owner) || !spec
        || !['resume-node', 'fresh-start-existing-node'].includes(spec.action)
        || !string(spec.nodeId) || !string(spec.expectedSessionId)
        || (spec.treeId !== undefined && spec.treeId !== null && !string(spec.treeId))) fail();
    const key = reservationKey(spec.nodeId, owner);
    if (reservations.has(key)) fail();
    const parent = snapshot(read(readParent, parentSessionId));
    const record = read(readNode, spec.nodeId, owner);
    const target = snapshot(record, true);
    if (parent.sessionId !== parentSessionId || parent.owner !== owner || target.owner !== owner
        || target.nodeId !== spec.nodeId || target.sessionId !== spec.expectedSessionId
        || (spec.treeId && spec.treeId !== target.treeId) || target.treeId !== parent.treeId
        || target.cwd !== parent.cwd || !same(target.workspaceRoots, parent.workspaceRoots)
        || target.treeAnchors.length <= parent.treeAnchors.length
        || !parent.treeAnchors.every((v, i) => target.treeAnchors[i] === v)
        || (spec.action === 'resume-node' && !string(target.threadId))) fail();
    const entropy = randomId();
    if (!string(entropy)) fail();
    // Unique within this authority even if an injected/random source repeats;
    // no permanent spent-token set is necessary. Entropy keeps it opaque.
    const token = `${entropy}.${++generation}`;
    const expiresAt = clock() + ttlMs;
    if (!Number.isSafeInteger(Math.ceil(expiresAt))) fail();
    const g = { parent, target, record, action: spec.action, expiresAt, cancelled: false, key, token };
    reservations.set(key, g);
    try { verify(g); } catch (error) { release(g); throw error; }
    grants.set(token, g);
    return Object.freeze({ token, parent, target });
  });
  const assertBeforeClose = guarded(token => {
    const g = grants.get(token);
    if (!g) fail();
    return verify(g);
  });
  const redeem = guarded((token, submission, owner) => {
    const g = grants.get(token);
    if (!g) fail();
    grants.delete(token); // Spend before ANY trusted callback or input getter.
    try {
    const s = submission;
    if (!s || owner !== g.target.owner || !string(s.sessionId) || s.sessionId === g.target.sessionId
        || s.cwd !== g.target.cwd || s.tier !== g.target.modelTier || s.role?.id !== g.target.roleId
        || s.requestKeys?.threadId !== g.target.nodeId || !strings(s.requestKeys?.treeAnchors)
        || !same(s.requestKeys.treeAnchors, g.target.treeAnchors)
        || (g.action === 'resume-node' ? s.resumeThreadId !== g.target.threadId : s.resumeThreadId !== undefined)) fail();
    verify(g);
    return Object.freeze({
      assertBeforeClose: guarded(() => verify(g)),
      assertStart: guarded(planTier => { if (planTier !== 'standard') fail(); return verify(g); }),
      cancel() { release(g); },
    });
    } catch (error) { release(g); throw error; }
  });
  // No callbacks: safe even when a trusted reader cancels its pending grant.
  function cancel(token) {
    const g = grants.get(token);
    if (g) release(g);
  }
  const assertUnreserved = guarded((nodeId, owner) => {
    if (!string(nodeId) || !string(owner)) fail();
    sweep();
    if (reservations.has(reservationKey(nodeId, owner))) fail();
    return true;
  });
  return Object.freeze({ issue, redeem, assertBeforeClose, cancel, assertUnreserved });
}
module.exports = { createTreeLifecycleAuthority };
