import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTreeDelegationAuthority } = require('../../shell/tree-delegation-authority.cjs');

function cloneParent(parent) {
  return {
    ...parent,
    treeAnchors: [...parent.treeAnchors],
    workspaceRoots: [...parent.workspaceRoots],
    permissionSession: { ...parent.permissionSession },
  };
}

function makeParentHarness(initial) {
  let parent = { ...initial };
  let live = true;
  return {
    readParent: (sessionId) => (live && sessionId === parent.sessionId ? cloneParent(parent) : null),
    setParent: (patch) => {
      parent = { ...parent, ...patch };
    },
    stop: () => {
      live = false;
    },
    start: () => {
      live = true;
    },
    getParent: () => parent,
  };
}

function makeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

function makeCounterRandomId(prefix = 'tok') {
  let counter = 0;
  return () => `${prefix}-${counter++}`;
}

const BASE_PARENT = Object.freeze({
  sessionId: 'parent-session-1',
  owner: 'owner-abc',
  nodeId: 'parent-node',
  treeId: 'tree-1',
  treeAnchors: ['tree-1', 'manager-a', 'parent-node'],
  cwd: '/workspace/root',
  permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' },
  workspaceRoots: ['/workspace/root'],
});

// The model identifier is deliberately NOT "standard" -- it must never be
// compared against the permission tier.
const CHILD_SPEC = Object.freeze({ nodeId: 'child-node', tier: 'claude-sonnet', role: 'builder' });

function makeSubmission(harness, childSpec, overrides = {}) {
  const parent = harness.getParent();
  return {
    sessionId: 'child-session-1',
    cwd: parent.cwd,
    tier: childSpec.tier,
    role: { id: childSpec.role },
    requestKeys: {
      threadId: childSpec.nodeId,
      treeAnchors: [...parent.treeAnchors, childSpec.nodeId],
    },
    ...overrides,
  };
}

function isRefused(err) {
  return err instanceof Error && err.code === 'TREE_DELEGATION_REFUSED';
}

test('success: issue -> redeem -> assertStart with a real (non-"standard") model id', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  assert.equal(typeof token, 'string');

  const submission = makeSubmission(h, CHILD_SPEC);
  const permit = authority.redeem(token, submission, BASE_PARENT.owner);
  assert.equal(typeof permit.assertStart, 'function');
  assert.equal(typeof permit.cancel, 'function');

  assert.equal(permit.assertStart('standard'), true);
});

test('issue does not restrict childSpec.tier to "standard" -- it is a model id', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const child = { nodeId: 'child-node', tier: 'claude-opus', role: 'reviewer' };
  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, child);
  const permit = authority.redeem(token, makeSubmission(h, child), BASE_PARENT.owner);
  assert.equal(permit.assertStart('standard'), true);
});

test('assertStart still requires planTier to be exactly "standard"', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);
  assert.throws(() => permit.assertStart('claude-sonnet'), isRefused);
  assert.throws(() => permit.assertStart('elevated'), isRefused);
});

test('redeem spends the token before calling now(): a throwing now() cannot open a replay window', () => {
  const h = makeParentHarness(BASE_PARENT);
  let armed = false;
  let thrown = false;
  let clockValue = 0;
  const now = () => {
    if (armed && !thrown) {
      thrown = true;
      throw new Error('simulated clock failure');
    }
    return clockValue;
  };
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);

  armed = true;
  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner));

  // The token must already be gone even though redeem() threw, so a retry
  // with working dependencies must not succeed.
  assert.throws(
    () => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner),
    isRefused,
  );
});

test('redeem spends the token before calling readParent(): a throwing readParent cannot open a replay window', () => {
  let armed = false;
  let thrown = false;
  const baseReadParent = makeParentHarness(BASE_PARENT).readParent;
  const readParent = (sessionId) => {
    if (armed && !thrown) {
      thrown = true;
      throw new Error('simulated readParent failure');
    }
    return baseReadParent(sessionId);
  };
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);

  armed = true;
  const h = makeParentHarness(BASE_PARENT);
  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);

  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
});

test('a reentrant readParent that calls redeem() again on the same token cannot double-redeem it', () => {
  const baseReadParent = makeParentHarness(BASE_PARENT).readParent;
  let authority;
  let issuedToken;
  let armed = false;
  let reentrantError = null;
  const h = makeParentHarness(BASE_PARENT);

  const readParent = (sessionId) => {
    if (armed && reentrantError === null) {
      try {
        authority.redeem(issuedToken, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);
        reentrantError = 'did-not-throw';
      } catch (err) {
        reentrantError = err;
      }
    }
    return baseReadParent(sessionId);
  };
  const clock = makeClock();
  authority = createTreeDelegationAuthority({ readParent, now: clock.now, randomId: makeCounterRandomId(), ttlMs: 1000 });

  const issued = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  issuedToken = issued.token;
  armed = true;

  const permit = authority.redeem(issuedToken, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);

  assert.ok(isRefused(reentrantError));
  assert.equal(permit.assertStart('standard'), true);
});

test('issue() snapshots the child spec before randomId()/now(): mutation afterward has no effect', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const mutableChild = { ...CHILD_SPEC };
  const randomId = (() => {
    let counter = 0;
    return () => {
      mutableChild.nodeId = 'mutated-during-randomId';
      mutableChild.role = 'mutated-role';
      return `tok-${counter++}`;
    };
  })();
  const authority = createTreeDelegationAuthority({ readParent: h.readParent, now: clock.now, randomId, ttlMs: 1000 });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, mutableChild);
  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);
  assert.equal(permit.assertStart('standard'), true);
});

test('redeem rejects a threadId that does not equal the reserved nodeId', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  const submission = makeSubmission(h, CHILD_SPEC, {
    requestKeys: { threadId: 'someone-elses-thread', treeAnchors: [...BASE_PARENT.treeAnchors, CHILD_SPEC.nodeId] },
  });
  assert.throws(() => authority.redeem(token, submission, BASE_PARENT.owner), isRefused);
});

test('redeem rejects when the parent\'s own nodeId drifted between issue and redeem', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  // Drift the parent's own nodeId (and keep anchors' last entry matching,
  // to isolate the nodeId-drift check from the anchors structural check).
  h.setParent({ nodeId: 'renamed-parent-node', treeAnchors: ['tree-1', 'manager-a', 'renamed-parent-node'] });

  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
});

test('assertStart rejects when the parent\'s own nodeId drifts after redeem', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);

  h.setParent({ nodeId: 'renamed-parent-node', treeAnchors: ['tree-1', 'manager-a', 'renamed-parent-node'] });
  assert.throws(() => permit.assertStart('standard'), isRefused);
});

test('a parent record whose anchors do not start with its own treeId is refused', () => {
  const badParent = { ...BASE_PARENT, treeAnchors: ['wrong-root', 'manager-a', 'parent-node'] };
  const h = makeParentHarness(badParent);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  assert.throws(() => authority.issue(badParent.sessionId, badParent.owner, CHILD_SPEC), isRefused);
});

test('a parent record whose anchors do not end with its own nodeId is refused', () => {
  const badParent = { ...BASE_PARENT, treeAnchors: ['tree-1', 'manager-a', 'someone-else-node'] };
  const h = makeParentHarness(badParent);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  assert.throws(() => authority.issue(badParent.sessionId, badParent.owner, CHILD_SPEC), isRefused);
});

test('a parent record with empty workspaceRoots is refused', () => {
  const badParent = { ...BASE_PARENT, workspaceRoots: [] };
  const h = makeParentHarness(badParent);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  assert.throws(() => authority.issue(badParent.sessionId, badParent.owner, CHILD_SPEC), isRefused);
});

test('redeem re-checks expiry after readParent returns, using a fresh clock read', () => {
  const clock = makeClock();
  let armed = false;
  const baseReadParent = makeParentHarness(BASE_PARENT).readParent;
  const readParent = (sessionId) => {
    if (armed) {
      clock.advance(10_000); // simulate a slow readParent letting time pass
    }
    return baseReadParent(sessionId);
  };
  const authority = createTreeDelegationAuthority({ readParent, now: clock.now, randomId: makeCounterRandomId(), ttlMs: 1000 });

  const h = makeParentHarness(BASE_PARENT);
  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);

  armed = true;
  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
});

test('assertStart re-checks expiry after readParent returns, using a fresh clock read', () => {
  const clock = makeClock();
  let armed = false;
  const baseReadParent = makeParentHarness(BASE_PARENT).readParent;
  const readParent = (sessionId) => {
    if (armed) {
      clock.advance(10_000);
    }
    return baseReadParent(sessionId);
  };
  const authority = createTreeDelegationAuthority({ readParent, now: clock.now, randomId: makeCounterRandomId(), ttlMs: 1000 });

  const h = makeParentHarness(BASE_PARENT);
  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);

  armed = true;
  assert.throws(() => permit.assertStart('standard'), isRefused);
});

test('assertStart re-checks cancellation after readParent returns: a reentrant cancel() still takes effect', () => {
  const baseReadParent = makeParentHarness(BASE_PARENT).readParent;
  let permit;
  let armed = false;
  const readParent = (sessionId) => {
    if (armed) {
      // Simulate a misbehaving integration that cancels the permit from
      // inside the readParent callback itself.
      permit.cancel();
    }
    return baseReadParent(sessionId);
  };
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({ readParent, now: clock.now, randomId: makeCounterRandomId(), ttlMs: 1000 });

  const h = makeParentHarness(BASE_PARENT);
  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);

  armed = true;
  assert.throws(() => permit.assertStart('standard'), isRefused);
});

test('cancel() permanently prevents any later assertStart()', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);

  permit.cancel();
  assert.throws(() => permit.assertStart('standard'), isRefused);
});

test('replay: redeeming the same token twice fails the second time', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);

  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
});

test('expiry: redeem refuses once the grant TTL has elapsed', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 500,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  clock.advance(500);
  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
});

test('parent-stop: redeem refuses if the parent is no longer live', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  h.stop();
  assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
});

test('parent-stop: assertStart refuses if the parent is no longer live', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);
  h.stop();
  assert.throws(() => permit.assertStart('standard'), isRefused);
});

test('scope-change: cwd/treeId/workspaceRoots/permissionSession drift between issue and redeem all refuse', () => {
  const clock = makeClock();
  const randomId = makeCounterRandomId();

  for (const patch of [
    { cwd: '/workspace/other' },
    { treeId: 'tree-2' },
    { workspaceRoots: ['/workspace/root', '/workspace/extra'] },
    { permissionSession: { origin: 'local', tier: 'elevated', profile: 'workspace' } },
    { treeAnchors: ['tree-1', 'manager-b', 'parent-node'] },
  ]) {
    const h = makeParentHarness(BASE_PARENT);
    const authority = createTreeDelegationAuthority({ readParent: h.readParent, now: clock.now, randomId, ttlMs: 1000 });
    const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
    h.setParent(patch);
    assert.throws(() => authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner), isRefused);
  }
});

test('redeem rejects a mismatched model tier, role, or cwd from the submission', () => {
  const clock = makeClock();
  const randomId = makeCounterRandomId();

  const mismatches = [
    { tier: 'claude-haiku' },
    { role: { id: 'someone-else-role' } },
    { cwd: '/somewhere/else' },
  ];
  for (const override of mismatches) {
    const h = makeParentHarness(BASE_PARENT);
    const authority = createTreeDelegationAuthority({ readParent: h.readParent, now: clock.now, randomId, ttlMs: 1000 });
    const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
    const submission = makeSubmission(h, CHILD_SPEC, override);
    assert.throws(() => authority.redeem(token, submission, BASE_PARENT.owner), isRefused);
  }
});

test('redeem rejects wrong owner, both as the supplied argument and via parent drift', () => {
  const clock = makeClock();
  const randomId = makeCounterRandomId();

  const h1 = makeParentHarness(BASE_PARENT);
  const authority1 = createTreeDelegationAuthority({ readParent: h1.readParent, now: clock.now, randomId, ttlMs: 1000 });
  const issued1 = authority1.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  assert.throws(
    () => authority1.redeem(issued1.token, makeSubmission(h1, CHILD_SPEC), 'someone-else'),
    isRefused,
  );

  const h2 = makeParentHarness(BASE_PARENT);
  const authority2 = createTreeDelegationAuthority({ readParent: h2.readParent, now: clock.now, randomId, ttlMs: 1000 });
  const issued2 = authority2.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  h2.setParent({ owner: 'owner-swapped' });
  assert.throws(
    () => authority2.redeem(issued2.token, makeSubmission(h2, CHILD_SPEC), BASE_PARENT.owner),
    isRefused,
  );
});

test('redeem rejects a broken ancestry: wrong order, missing child suffix, or extra anchor', () => {
  const clock = makeClock();
  const randomId = makeCounterRandomId();

  const badAnchorSets = [
    [...BASE_PARENT.treeAnchors], // missing the child suffix entirely
    ['tree-1', 'parent-node', 'manager-a', CHILD_SPEC.nodeId], // wrong order
    [...BASE_PARENT.treeAnchors, 'phantom-ancestor', CHILD_SPEC.nodeId], // extra anchor
    [...BASE_PARENT.treeAnchors, 'someone-elses-node'], // wrong final entry
  ];
  for (const treeAnchors of badAnchorSets) {
    const h = makeParentHarness(BASE_PARENT);
    const authority = createTreeDelegationAuthority({ readParent: h.readParent, now: clock.now, randomId, ttlMs: 1000 });
    const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
    const submission = makeSubmission(h, CHILD_SPEC, { requestKeys: { threadId: CHILD_SPEC.nodeId, treeAnchors } });
    assert.throws(() => authority.redeem(token, submission, BASE_PARENT.owner), isRefused);
  }
});

test('a treeAnchors array with a hole plus an extra own property is rejected as malformed, not treated as dense', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);

  const sneaky = [BASE_PARENT.treeAnchors[0]];
  sneaky.length = 3;
  sneaky[2] = CHILD_SPEC.nodeId; // index 1 is a hole
  sneaky.extra = 'padding'; // own enumerable property that could fool a key-count check
  assert.equal(Object.keys(sneaky).length, sneaky.length); // confirms the trap actually applies

  const submission = makeSubmission(h, CHILD_SPEC, { requestKeys: { threadId: CHILD_SPEC.nodeId, treeAnchors: sneaky } });
  assert.throws(() => authority.redeem(token, submission, BASE_PARENT.owner), isRefused);
});

test('bounded string length: an oversized field is rejected', () => {
  const h = makeParentHarness(BASE_PARENT);
  const clock = makeClock();
  const authority = createTreeDelegationAuthority({
    readParent: h.readParent,
    now: clock.now,
    randomId: makeCounterRandomId(),
    ttlMs: 1000,
  });

  const oversizedChild = { ...CHILD_SPEC, nodeId: 'x'.repeat(5000) };
  assert.throws(() => authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, oversizedChild), isRefused);
});

test('malformed constructor dependencies throw a plain TypeError, not the safe refusal code', () => {
  assert.throws(() => createTreeDelegationAuthority({}), TypeError);
  assert.throws(
    () => createTreeDelegationAuthority({ readParent: () => null, now: () => 0, randomId: () => 'x', ttlMs: 0 }),
    TypeError,
  );
});

test('omitting now/randomId falls back to real defaults (performance.now, crypto.randomUUID)', () => {
  const h = makeParentHarness(BASE_PARENT);
  const authority = createTreeDelegationAuthority({ readParent: h.readParent, ttlMs: 5000 });

  const { token } = authority.issue(BASE_PARENT.sessionId, BASE_PARENT.owner, CHILD_SPEC);
  // node:crypto randomUUID() shape: 8-4-4-4-12 hex groups.
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  const permit = authority.redeem(token, makeSubmission(h, CHILD_SPEC), BASE_PARENT.owner);
  assert.equal(permit.assertStart('standard'), true);
});
