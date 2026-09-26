'use strict';

/**
 * tree-delegation-authority.cjs
 *
 * Standalone, dependency-free CommonJS module that issues a one-time
 * delegation token for a specific expected child (node/model/role) under a
 * specific live parent session, later redeems that token into a permit
 * once the child has actually shown up with matching identity, scope, and
 * ancestry, and lets the caller synchronously re-check that permit
 * immediately before it would act on it.
 *
 * `childSpec.tier` / `submission.tier` is a MODEL identifier (e.g.
 * "claude-sonnet"), not a permission tier -- it is validated only as an
 * opaque bounded string that must match exactly between issue() and
 * redeem(), never restricted to a fixed set of values. The only literal
 * "standard" check in this module is on `assertStart(planTier)`, which is
 * a permission-plan tier, an entirely different axis.
 *
 * SCOPE LIMIT: this module never launches a process, opens a file, or
 * makes a network call, and a successful assertStart() is not proof that
 * any tree, session, or process actually exists or works -- it only means
 * every check this module knows how to run passed at that instant. All
 * real OS-level confinement, process spawning, and tree bookkeeping are
 * the caller's responsibility, entirely outside this module.
 *
 * All policy refusals -- malformed input, replay, expiry, a stopped
 * parent, or any drift in scope/authority/ancestry -- surface as the same
 * safe error code, TREE_DELEGATION_REFUSED, with no further reason
 * exposed. Only genuine dependency-contract violations (a malformed
 * randomId()/now() return value, a non-monotonic clock) throw a distinct,
 * undisguised error, since those indicate a bug in the wiring rather than
 * an attacker- or environment-controlled condition.
 *
 * Pending (issued-but-not-yet-redeemed) tokens are opportunistically swept
 * once their TTL elapses at the start of every issue() call. A token is
 * removed from internal bookkeeping the instant redeem() is called on it
 * (before any other work), regardless of whether redemption then succeeds
 * or fails -- there is no permanent tombstone; a redeemed grant's data
 * lives only inside the permit closure returned to the caller, never in
 * module-level state.
 */

const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');

const REFUSAL_CODE = 'TREE_DELEGATION_REFUSED';
const SUPPORTED_PLAN_TIER = 'standard';
const SUPPORTED_PERMISSION_SESSION = Object.freeze({
  origin: 'local',
  tier: 'confined',
  profile: 'workspace',
});
const MAX_STRING_LENGTH = 4096;

function refused() {
  const error = new Error('Tree delegation authority refused this request.');
  error.code = REFUSAL_CODE;
  return error;
}

function defaultNow() {
  return performance.now();
}

function defaultRandomId() {
  return randomUUID();
}

function isBoundedNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_LENGTH;
}

// A sparse array has fewer own indexed properties than its length, but
// counting `Object.keys(value).length` against `value.length` can be
// fooled: an array with a hole PLUS an extra non-index own property (e.g.
// `const a = [x]; a.length = 2; a.extra = 'y';`) can have a key count that
// coincidentally matches `length` while still having a real hole. Probe
// every index explicitly instead.
function isDenseArray(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      return false;
    }
  }
  return true;
}

function isStringArray(value) {
  return isDenseArray(value) && value.every((entry) => isBoundedNonEmptyString(entry));
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function isValidPermissionSessionShape(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    isBoundedNonEmptyString(value.origin) &&
    isBoundedNonEmptyString(value.tier) &&
    isBoundedNonEmptyString(value.profile)
  );
}

function permissionSessionMatches(a, b) {
  return a.origin === b.origin && a.tier === b.tier && a.profile === b.profile;
}

function isSupportedPermissionSession(value) {
  return permissionSessionMatches(value, SUPPORTED_PERMISSION_SESSION);
}

function isValidParentRecordShape(parent) {
  return (
    parent !== null &&
    typeof parent === 'object' &&
    isBoundedNonEmptyString(parent.sessionId) &&
    isBoundedNonEmptyString(parent.owner) &&
    isBoundedNonEmptyString(parent.nodeId) &&
    isBoundedNonEmptyString(parent.treeId) &&
    isBoundedNonEmptyString(parent.cwd) &&
    isStringArray(parent.treeAnchors) &&
    isStringArray(parent.workspaceRoots) &&
    parent.workspaceRoots.length > 0 &&
    isValidPermissionSessionShape(parent.permissionSession)
  );
}

// Structural invariants on a parent record's own ancestry chain: it must
// be rooted at the tree's own id, and its own last entry must be the
// parent's own node id (i.e. the chain legitimately ends with itself
// before a child ever appends its own id on top of it).
function anchorsAreStructurallyValid(parent) {
  const anchors = parent.treeAnchors;
  return anchors.length > 0 && anchors[0] === parent.treeId && anchors[anchors.length - 1] === parent.nodeId;
}

function isValidChildSpecShape(spec) {
  return (
    spec !== null &&
    typeof spec === 'object' &&
    isBoundedNonEmptyString(spec.nodeId) &&
    isBoundedNonEmptyString(spec.tier) &&
    isBoundedNonEmptyString(spec.role)
  );
}

function isValidSubmissionShape(submission) {
  return (
    submission !== null &&
    typeof submission === 'object' &&
    isBoundedNonEmptyString(submission.sessionId) &&
    isBoundedNonEmptyString(submission.cwd) &&
    isBoundedNonEmptyString(submission.tier) &&
    submission.role !== null &&
    typeof submission.role === 'object' &&
    isBoundedNonEmptyString(submission.role.id) &&
    submission.requestKeys !== null &&
    typeof submission.requestKeys === 'object' &&
    isBoundedNonEmptyString(submission.requestKeys.threadId) &&
    isStringArray(submission.requestKeys.treeAnchors)
  );
}

function readParentSafely(readParent, sessionId) {
  let parent;
  try {
    parent = readParent(sessionId);
  } catch {
    throw refused();
  }
  if (parent === null || parent === undefined) {
    throw refused();
  }
  if (!isValidParentRecordShape(parent)) {
    throw refused();
  }
  if (parent.sessionId !== sessionId) {
    throw refused();
  }
  if (!anchorsAreStructurallyValid(parent)) {
    throw refused();
  }
  return parent;
}

/**
 * @param {object} deps
 * @param {(sessionId: string) => (object | null)} deps.readParent -
 *   Authoritative callback returning the current parent record, or null if
 *   the parent is stopped/unavailable. Called fresh at issue(), redeem(),
 *   and every assertStart() -- never cached across calls.
 * @param {() => number} [deps.now] - Monotonic clock in ms; defaults to
 *   performance.now() when omitted. Must be finite and non-decreasing.
 * @param {() => string} [deps.randomId] - Token generator; defaults to
 *   node:crypto randomUUID() when omitted.
 * @param {number} deps.ttlMs - Grant lifetime in ms from issuance, also
 *   the outer bound checked again at assertStart() time.
 */
function createTreeDelegationAuthority({ readParent, now, randomId, ttlMs }) {
  if (typeof readParent !== 'function') {
    throw new TypeError('readParent must be a function');
  }
  const resolvedNow = now === undefined ? defaultNow : now;
  const resolvedRandomId = randomId === undefined ? defaultRandomId : randomId;
  if (typeof resolvedNow !== 'function') {
    throw new TypeError('now must be a function');
  }
  if (typeof resolvedRandomId !== 'function') {
    throw new TypeError('randomId must be a function');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive finite number');
  }

  /** @type {Map<string, object>} */
  const grants = new Map();
  let lastObservedNow = -Infinity;

  function readNow() {
    const value = resolvedNow();
    if (!Number.isFinite(value)) {
      throw new TypeError('now() must return a finite number');
    }
    if (value < lastObservedNow) {
      throw new RangeError('now() must be monotonically non-decreasing');
    }
    lastObservedNow = value;
    return value;
  }

  // Opportunistic maintenance: drop any still-pending grant whose TTL has
  // elapsed without ever being redeemed. Redeemed or otherwise-decided
  // grants are never left in this map at all (redeem() deletes its token
  // before doing anything else), so this is the only cleanup needed to
  // bound its size. Only called from issue(): calling it from redeem()
  // would mean redeem() invokes the external now() before spending the
  // specific token it was asked to redeem, reopening a replay window.
  function sweepExpiredPending() {
    const nowValue = readNow();
    for (const [token, grant] of grants) {
      if (nowValue >= grant.expiresAt) {
        grants.delete(token);
      }
    }
  }

  function issue(parentSessionId, owner, childSpec) {
    sweepExpiredPending();

    if (!isBoundedNonEmptyString(parentSessionId)) {
      throw refused();
    }
    if (!isBoundedNonEmptyString(owner)) {
      throw refused();
    }
    if (!isValidChildSpecShape(childSpec)) {
      throw refused();
    }

    const parent = readParentSafely(readParent, parentSessionId);
    if (parent.owner !== owner) {
      throw refused();
    }
    if (!isSupportedPermissionSession(parent.permissionSession)) {
      throw refused();
    }

    // Snapshot everything needed for the grant BEFORE calling
    // randomId()/now(). Those are the last external callbacks in this
    // function; if either is slow, throws, or reenters, there must
    // already be an immutable, fully-formed snapshot rather than a
    // half-built grant depending on live object references.
    const parentSnapshot = Object.freeze({
      parentSessionId: parent.sessionId,
      parentNodeId: parent.nodeId,
      owner: parent.owner,
      cwd: parent.cwd,
      treeId: parent.treeId,
      treeAnchors: Object.freeze(parent.treeAnchors.slice()),
      workspaceRoots: Object.freeze(parent.workspaceRoots.slice()),
      permissionSession: Object.freeze({ ...parent.permissionSession }),
    });
    const childSnapshot = Object.freeze({
      nodeId: childSpec.nodeId,
      tier: childSpec.tier,
      role: childSpec.role,
    });

    const token = resolvedRandomId();
    if (!isBoundedNonEmptyString(token)) {
      throw new TypeError('randomId must return a non-empty string');
    }
    if (grants.has(token)) {
      throw new Error('token collision from randomId');
    }

    const issuedAt = readNow();
    const expiresAt = issuedAt + ttlMs;
    if (!Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER) {
      throw refused();
    }

    const grant = Object.freeze({
      token,
      ...parentSnapshot,
      ...childSnapshot,
      issuedAt,
      expiresAt,
    });
    grants.set(token, grant);

    return { token };
  }

  function redeem(token, submission, owner) {
    if (!isBoundedNonEmptyString(token)) {
      throw refused();
    }
    const grant = grants.get(token);
    if (!grant) {
      throw refused();
    }

    // Spend the token BEFORE invoking ANY external callback -- now() as
    // well as readParent(). Both may throw, be slow, or (in a buggy or
    // adversarial integration) reenter redeem() with the same token
    // before returning. Flipping this out of the map first, before either
    // callback runs, means any such reentrant or retried call finds no
    // grant at all, instead of racing to redeem the same token twice.
    grants.delete(token);

    if (readNow() >= grant.expiresAt) {
      throw refused();
    }
    if (!isValidSubmissionShape(submission)) {
      throw refused();
    }
    if (!isBoundedNonEmptyString(owner)) {
      throw refused();
    }
    if (owner !== grant.owner) {
      throw refused();
    }

    const current = readParentSafely(readParent, grant.parentSessionId);

    // readParent may have taken real time or advanced a shared clock;
    // re-check expiry with a fresh read rather than trusting the
    // timestamp from before the call.
    if (readNow() >= grant.expiresAt) {
      throw refused();
    }

    if (current.owner !== grant.owner) {
      throw refused();
    }
    if (current.nodeId !== grant.parentNodeId) {
      throw refused();
    }
    if (current.cwd !== grant.cwd) {
      throw refused();
    }
    if (current.treeId !== grant.treeId) {
      throw refused();
    }
    if (!arraysEqual(current.workspaceRoots, grant.workspaceRoots)) {
      throw refused();
    }
    if (!permissionSessionMatches(current.permissionSession, grant.permissionSession)) {
      throw refused();
    }
    if (!arraysEqual(current.treeAnchors, grant.treeAnchors)) {
      throw refused();
    }

    if (submission.tier !== grant.tier) {
      throw refused();
    }
    if (submission.role.id !== grant.role) {
      throw refused();
    }
    if (submission.cwd !== grant.cwd) {
      throw refused();
    }
    // The thread identity a redeeming child presents must exactly equal
    // the node id reserved for it at issue time.
    if (submission.requestKeys.threadId !== grant.nodeId) {
      throw refused();
    }

    const submittedAnchors = submission.requestKeys.treeAnchors;
    const expectedLength = grant.treeAnchors.length + 1;
    if (submittedAnchors.length !== expectedLength) {
      throw refused();
    }
    for (let i = 0; i < grant.treeAnchors.length; i += 1) {
      if (submittedAnchors[i] !== grant.treeAnchors[i]) {
        throw refused();
      }
    }
    if (submittedAnchors[expectedLength - 1] !== grant.nodeId) {
      throw refused();
    }

    const capturedAuthority = grant; // already fully frozen and immutable

    let cancelled = false;

    function assertStart(planTier) {
      if (cancelled) {
        throw refused();
      }
      if (planTier !== SUPPORTED_PLAN_TIER) {
        throw refused();
      }
      if (readNow() >= capturedAuthority.expiresAt) {
        throw refused();
      }

      const fresh = readParentSafely(readParent, capturedAuthority.parentSessionId);

      // readParent can take real time, or -- in a misbehaving integration
      // -- reenter this very permit's cancel() during its own execution.
      // Re-check both expiry and cancellation again after the callback
      // returns, not only before it was called.
      if (cancelled) {
        throw refused();
      }
      if (readNow() >= capturedAuthority.expiresAt) {
        throw refused();
      }

      if (fresh.owner !== capturedAuthority.owner) {
        throw refused();
      }
      if (fresh.nodeId !== capturedAuthority.parentNodeId) {
        throw refused();
      }
      if (fresh.cwd !== capturedAuthority.cwd) {
        throw refused();
      }
      if (fresh.treeId !== capturedAuthority.treeId) {
        throw refused();
      }
      if (!arraysEqual(fresh.workspaceRoots, capturedAuthority.workspaceRoots)) {
        throw refused();
      }
      if (!permissionSessionMatches(fresh.permissionSession, capturedAuthority.permissionSession)) {
        throw refused();
      }
      if (!arraysEqual(fresh.treeAnchors, capturedAuthority.treeAnchors)) {
        throw refused();
      }

      return true;
    }

    function cancel() {
      cancelled = true;
    }

    return Object.freeze({ assertStart, cancel });
  }

  return { issue, redeem };
}

module.exports = { createTreeDelegationAuthority };
