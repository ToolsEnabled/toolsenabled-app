import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, beforeEach, after } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require = createRequire(import.meta.url)
const appRoot = fileURLToPath(new URL('../..', import.meta.url))
const engineRoot = canonicalRootForTests({ requireConfigured: true })
const { createResearchDelegationAuthority } = require(path.join(appRoot, 'shell', 'research-delegation-authority.cjs'))
const { validateResearchAccess, enforceResearchAccess } = require(path.join(engineRoot, 'src', 'lib', 'research-access.js'))
const { normalizeResearchDelegation } = require(path.join(engineRoot, 'src', 'lib', 'research-delegation-request.js'))

const fixtureBase = process.env.T605_RESEARCH_FIXTURE_ROOT || os.tmpdir()
const fixtureRoot = await fs.promises.mkdtemp(path.join(fixtureBase, 't605-research-authority-'))
const parentRoot = path.join(fixtureRoot, 'parent')
const outsideRoot = path.join(fixtureRoot, 'outside')
const roomsRoot = path.join(fixtureRoot, 'rooms')
await fs.promises.mkdir(path.join(parentRoot, 'subset'), { recursive: true })
await fs.promises.mkdir(outsideRoot, { recursive: true })
await fs.promises.writeFile(path.join(parentRoot, 'visible.txt'), 'visible')
await fs.promises.writeFile(path.join(parentRoot, 'subset', 'child.txt'), 'child')
await fs.promises.writeFile(path.join(outsideRoot, 'secret.txt'), 'secret')

let parent
let authority
let clock

const parentRecord = () => ({
  sessionId: 'parent-session',
  owner: 'owner-a',
  agentId: 'parent-agent',
  nodeId: 'parent-node',
  treeId: 'tree-a',
  treeAnchors: ['root'],
  cwd: parentRoot,
  permissionSession: { origin: 'local', tier: 'full' },
})
const folderRequest = (folder = path.join(parentRoot, 'subset')) => ({
  tier: 'luna', role: 'WORKER',
  research: { mode: 'folder', access: 'read-only', folder, prompt: 'Inspect the supplied folder.' },
})
const cleanRequest = () => ({
  tier: 'luna', role: 'WORKER',
  research: { mode: 'clean-room', access: 'read-only', prompt: 'Inspect explicit inputs.',
    files: [{ path: 'inputs/data.txt', content: 'alpha' }] },
})
const redeemRequest = (issued, overrides = {}) => ({
  agentId: 'child-node',
  tier: 'luna',
  agentAuthority: { roleId: 'WORKER' },
  requestKeys: { threadId: 'child-node', treeAnchors: [...issued.parent.treeAnchors, 'child-node'] },
  research: issued.research,
  ...overrides,
})
const refused = fn => assert.throws(fn, error =>
  error?.code === 'RESEARCH_DELEGATION_REFUSED' || error?.code === 'RESEARCH_ACCESS_REFUSED')
const setup = (now = () => clock) => {
  parent = parentRecord()
  clock = 1000
  authority = createResearchDelegationAuthority({
    readParent: sessionId => sessionId === parent.sessionId ? parent : null,
    normalizeRequest: normalizeResearchDelegation,
    validateAccess: value => validateResearchAccess(value),
    enforceAccess: (tool, args, scope) => enforceResearchAccess(tool, args, scope),
    roomsRoot, ttlMs: 100, now,
  })
}
const issue = (request = folderRequest()) =>
  authority.issue(parent.sessionId, parent.owner, request, 'child-node')

beforeEach(() => setup())
after(async () => fs.promises.rm(fixtureRoot, { recursive: true, force: true }))

test('folder delegation exposes only a selected real subtree through redeem and assertStart', async () => {
  const issued = issue()
  assert.equal(issued.access.root, path.join(parentRoot, 'subset'))
  assert.equal(await fs.promises.readFile(path.join(issued.access.root, 'child.txt'), 'utf8'), 'child')
  refused(() => authority.issue(parent.sessionId, parent.owner, folderRequest(outsideRoot), 'child-node'))
  const permit = authority.redeem(issued.token, redeemRequest(issued), parent.owner)
  assert.equal(permit.researchAccess.root, issued.access.root)
  permit.assertStart()
})

test('clean-room contains exactly explicit text inputs and failed finish removes only its room', async () => {
  const issued = issue(cleanRequest())
  assert.equal(await fs.promises.readFile(path.join(issued.access.root, 'inputs', 'data.txt'), 'utf8'), 'alpha')
  assert.equal(await fs.promises.stat(issued.access.root).then(() => true), true)
  assert.equal(fs.existsSync(path.join(issued.access.root, 'visible.txt')), false)
  assert.equal(fs.existsSync(path.join(issued.access.root, 'outside', 'secret.txt')), false)
  const permit = authority.redeem(issued.token, redeemRequest(issued), parent.owner)
  assert.equal(permit.researchAccess.mode, 'clean-room')
  authority.finish(issued.token, { failed: true })
  assert.equal(fs.existsSync(issued.access.root), false)
})

test('folder links and stale parent or child identities are refused', async () => {
  const link = path.join(parentRoot, 'outside-link')
  await fs.promises.symlink(outsideRoot, link, 'junction')
  refused(() => issue(folderRequest(link)))

  const staleParent = issue()
  await fs.promises.rename(parentRoot, path.join(fixtureRoot, 'parent-moved'))
  await fs.promises.mkdir(parentRoot)
  refused(() => authority.redeem(staleParent.token, redeemRequest(staleParent), parent.owner))
  await fs.promises.rm(parentRoot, { recursive: true, force: true })
  await fs.promises.rename(path.join(fixtureRoot, 'parent-moved'), parentRoot)

  setup()
  const staleChild = issue()
  await fs.promises.rename(path.join(parentRoot, 'subset'), path.join(parentRoot, 'subset-moved'))
  await fs.promises.mkdir(path.join(parentRoot, 'subset'))
  refused(() => authority.redeem(staleChild.token, redeemRequest(staleChild), parent.owner))
  await fs.promises.rm(path.join(parentRoot, 'subset'), { recursive: true, force: true })
  await fs.promises.rename(path.join(parentRoot, 'subset-moved'), path.join(parentRoot, 'subset'))
})

test('redeem rejects wrong owner, node, tier, role, descriptor, replay, and expiry', () => {
  for (const mutate of [
    request => ({ ...request, agentId: 'other-node' }),
    request => ({ ...request, tier: 'nova' }),
    request => ({ ...request, agentAuthority: { roleId: 'MANAGER' } }),
    request => ({ ...request, requestKeys: { ...request.requestKeys, threadId: 'other-node' } }),
    request => ({ ...request, research: { ...request.research, prompt: 'widened' } }),
  ]) {
    setup()
    const issued = issue()
    refused(() => authority.redeem(issued.token, mutate(redeemRequest(issued)), parent.owner))
  }
  setup()
  const issued = issue()
  refused(() => authority.redeem(issued.token, redeemRequest(issued), 'wrong-owner'))
  setup()
  const valid = issue()
  const permit = authority.redeem(valid.token, redeemRequest(valid), parent.owner)
  permit.assertStart()
  refused(() => authority.redeem(valid.token, redeemRequest(valid), parent.owner))
  setup(() => clock)
  const expired = issue()
  clock = 1100
  refused(() => authority.redeem(expired.token, redeemRequest(expired), parent.owner))
})

test('changed parent and unrelated cleanup are refused without deleting unrelated data', async () => {
  const changed = issue()
  parent = { ...parent, nodeId: 'changed-parent' }
  refused(() => authority.redeem(changed.token, redeemRequest(changed), parent.owner))

  setup()
  const issued = issue(cleanRequest())
  const unrelated = path.join(fixtureRoot, 'unrelated')
  await fs.promises.mkdir(unrelated)
  await fs.promises.writeFile(path.join(unrelated, 'keep.txt'), 'keep')
  authority.finish(issued.token, { failed: true })
  assert.equal(fs.existsSync(path.join(unrelated, 'keep.txt')), true)
  refused(() => authority.redeem(issued.token, redeemRequest(issued), parent.owner))
})

test('a restricted parent cannot refresh a replaced root by issuing another child', async () => {
  const root = await fs.promises.mkdtemp(path.join(fixtureRoot, 'scoped-parent-'))
  parent = { ...parent, cwd: root, researchAccess: validateResearchAccess({
    version: 1, mode: 'folder', root, access: 'read-only',
  }) }
  await fs.promises.rename(root, root + '-moved')
  await fs.promises.mkdir(root)
  refused(() => issue(cleanRequest()))
})

test('assertStart rechecks a child folder after redemption', async () => {
  const selected = await fs.promises.mkdtemp(path.join(parentRoot, 'selected-'))
  const issued = issue(folderRequest(selected))
  const permit = authority.redeem(issued.token, redeemRequest(issued), parent.owner)
  await fs.promises.rename(selected, selected + '-moved')
  await fs.promises.symlink(outsideRoot, selected, process.platform === 'win32' ? 'junction' : 'dir')
  refused(() => permit.assertStart())
})

test('room storage refuses aliases and a failed input write cleans only the newly minted room', async t => {
  const alias = path.join(fixtureRoot, 'room-storage-alias')
  await fs.promises.symlink(outsideRoot, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const aliased = createResearchDelegationAuthority({
    readParent: () => parent, normalizeRequest: normalizeResearchDelegation,
    validateAccess: validateResearchAccess, enforceAccess: enforceResearchAccess, roomsRoot: alias,
  })
  refused(() => aliased.issue(parent.sessionId, parent.owner, cleanRequest(), 'child-node'))
  const before = (await fs.promises.readdir(roomsRoot)).sort()
  const write = fs.writeFileSync
  const mock = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (String(args[0]).startsWith(roomsRoot + path.sep)) {
      throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' })
    }
    return write(...args)
  })
  try {
    assert.throws(() => issue(cleanRequest()), { code: 'ENOSPC' })
    assert.deepEqual((await fs.promises.readdir(roomsRoot)).sort(), before)
    assert.equal(await fs.promises.readFile(path.join(outsideRoot, 'secret.txt'), 'utf8'), 'secret')
  } finally { mock.mock.restore() }
})

test('successful finish retires the start token and retains explicit inputs for review', async () => {
  const issued = issue(cleanRequest())
  const permit = authority.redeem(issued.token, redeemRequest(issued), parent.owner)
  authority.finish(issued.token)
  refused(() => authority.redeem(issued.token, redeemRequest(issued), parent.owner))
  refused(() => permit.assertStart())
  assert.equal(enforceResearchAccess('host.read_file', { path: 'inputs/data.txt' },
    permit.researchAccess).path, path.join(issued.access.root, 'inputs', 'data.txt'))
  assert.equal(await fs.promises.readFile(path.join(issued.access.root, 'inputs', 'data.txt'), 'utf8'), 'alpha')
})
