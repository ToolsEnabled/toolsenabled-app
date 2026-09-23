'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const authorityPath = path.join(__dirname, '..', '..', '..', 'shell', 'research-delegation-authority.cjs');
const engineRoot = 'C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp\\t605-research-delegation-engine-20260920';
const { createResearchDelegationAuthority } = require(authorityPath);
const { validateResearchAccess, enforceResearchAccess } = require(path.join(engineRoot, 'src', 'lib', 'research-access.js'));
const { normalizeResearchDelegation } = require(path.join(engineRoot, 'src', 'lib', 'research-delegation-request.js'));

const tempRoot = fs.mkdtempSync(path.join('C:\\Users\\ToolsEnabled-Dev\\AppData\\Local\\Temp', 't605-authority-test-'));
const parentRoot = path.join(tempRoot, 'parent');
const outsideRoot = path.join(tempRoot, 'outside');
const roomsRoot = path.join(tempRoot, 'rooms');
fs.mkdirSync(path.join(parentRoot, 'subset'), { recursive: true });
fs.mkdirSync(outsideRoot, { recursive: true });
fs.writeFileSync(path.join(parentRoot, 'visible.txt'), 'visible');
fs.writeFileSync(path.join(parentRoot, 'subset', 'child.txt'), 'child');
fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret');

let parent;
let now;
let authority;

function makeParent() {
  return {
    sessionId: 'parent-session',
    owner: 'owner-a',
    agentId: 'parent-agent',
    nodeId: 'parent-node',
    treeId: 'tree-a',
    treeAnchors: ['root'],
    cwd: parentRoot,
    permissionSession: { origin: 'local', tier: 'full' },
  };
}
function folderRequest(folder = path.join(parentRoot, 'subset')) {
  return { tier: 'luna', role: 'WORKER', research: {
    mode: 'folder', access: 'read-only', folder, prompt: 'Inspect the supplied folder.'
  }};
}
function cleanRequest() {
  return { tier: 'luna', role: 'WORKER', research: {
    mode: 'clean-room', access: 'read-only', prompt: 'Inspect explicit inputs.',
    files: [{ path: 'inputs/data.txt', content: 'alpha' }]
  }};
}
function requestFor(issued, overrides = {}) {
  return {
    agentId: issued.nodeId,
    tier: issued.tier,
    agentAuthority: { roleId: issued.role },
    requestKeys: { threadId: issued.nodeId, treeAnchors: [...issued.parent.treeAnchors, issued.nodeId] },
    research: issued.research,
    ...overrides
  };
}
function makeAuthority(clock = () => now) {
  parent = makeParent();
  now = 1000;
  authority = createResearchDelegationAuthority({
    readParent: sessionId => sessionId === parent.sessionId ? parent : null,
    normalizeRequest: normalizeResearchDelegation,
    validateAccess: value => validateResearchAccess(value),
    enforceAccess: (tool, args, scope) => enforceResearchAccess(tool, args, scope),
    roomsRoot,
    ttlMs: 100,
    now: clock
  });
}
function issue(req = folderRequest()) {
  return authority.issue(parent.sessionId, parent.owner, req, 'child-node');
}
function assertRefused(fn) {
  assert.throws(fn, error => error && (error.code === 'RESEARCH_DELEGATION_REFUSED' || error.code === 'RESEARCH_ACCESS_REFUSED'));
}

test.beforeEach(() => makeAuthority());
test.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

test('folder delegation gives the child only the selected real subtree', () => {
  const issued = issue();
  assert.equal(issued.access.root, path.join(parentRoot, 'subset'));
  assert.equal(fs.readFileSync(path.join(issued.access.root, 'child.txt'), 'utf8'), 'child');
  assertRefused(() => authority.issue(parent.sessionId, parent.owner, folderRequest(parentRoot), 'child-node'));
  const permit = authority.redeem(issued.token, requestFor(issued), parent.owner);
  assert.equal(permit.researchAccess.root, issued.access.root);
  permit.assertStart();
});

test('clean-room delegation materializes only explicit inputs', () => {
  const issued = issue(cleanRequest());
  assert.equal(fs.readFileSync(path.join(issued.access.root, 'inputs', 'data.txt'), 'utf8'), 'alpha');
  assert.equal(fs.existsSync(path.join(issued.access.root, 'visible.txt')), false);
  assert.equal(fs.existsSync(path.join(issued.access.root, 'outside', 'secret.txt')), false);
  const permit = authority.redeem(issued.token, requestFor(issued), parent.owner);
  assert.equal(permit.researchAccess.mode, 'clean-room');
  authority.finish(issued.token, { failed: true });
  assert.equal(fs.existsSync(issued.access.root), false);
});

test('folder link and stale parent or child identities are refused', () => {
  const link = path.join(parentRoot, 'outside-link');
  try {
    fs.symlinkSync(outsideRoot, link, 'junction');
  } catch (error) {
    assert.fail('junction fixture creation failed: ' + error.message);
  }
  assertRefused(() => issue(folderRequest(link)));

  const staleParent = issue();
  fs.renameSync(parentRoot, path.join(tempRoot, 'parent-moved'));
  fs.mkdirSync(parentRoot);
  assertRefused(() => authority.redeem(staleParent.token, requestFor(staleParent), parent.owner));

  makeAuthority();
  const staleChild = issue();
  fs.renameSync(path.join(parentRoot, 'subset'), path.join(parentRoot, 'subset-moved'));
  fs.mkdirSync(path.join(parentRoot, 'subset'));
  assertRefused(() => authority.redeem(staleChild.token, requestFor(staleChild), parent.owner));
});

test('redeem refuses wrong owner, node, tier, role, descriptor, and token replay', () => {
  for (const mutate of [
    request => ({ ...request, agentId: 'other-node' }),
    request => ({ ...request, tier: 'nova' }),
    request => ({ ...request, agentAuthority: { roleId: 'MANAGER' } }),
    request => ({ ...request, requestKeys: { ...request.requestKeys, threadId: 'other-node' } }),
    request => ({ ...request, research: { ...request.research, prompt: 'widened' } }),
  ]) {
    makeAuthority();
    const issued = issue();
    assertRefused(() => authority.redeem(issued.token, mutate(requestFor(issued)), parent.owner));
  }
  makeAuthority();
  const issued = issue();
  const permit = authority.redeem(issued.token, requestFor(issued), parent.owner);
  permit.assertStart();
  assertRefused(() => authority.redeem(issued.token, requestFor(issued), parent.owner));
  assertRefused(() => authority.redeem(issued.token, requestFor(issued), 'wrong-owner'));
});

test('expired or changed parent token cannot be redeemed', () => {
  let clock = 1000;
  makeAuthority(() => clock);
  const issued = issue();
  clock = 1100;
  assertRefused(() => authority.redeem(issued.token, requestFor(issued), parent.owner));

  makeAuthority(() => now);
  const changed = issue();
  parent = { ...parent, nodeId: 'changed-parent' };
  assertRefused(() => authority.redeem(changed.token, requestFor(changed), parent.owner));
});

test('failed cleanup cannot remove an unrelated folder', () => {
  const issued = issue(cleanRequest());
  const unrelated = path.join(tempRoot, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  authority.finish(issued.token, { failed: true });
  assert.equal(fs.existsSync(path.join(unrelated, 'keep.txt')), true);
  assertRefused(() => authority.redeem(issued.token, requestFor(issued), parent.owner));
});
