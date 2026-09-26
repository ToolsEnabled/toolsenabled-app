import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'

const require = createRequire(import.meta.url)
const appRoot = fileURLToPath(new URL('../..', import.meta.url))
const engineRoot = canonicalRootForTests({ requireConfigured: true })
const { createResearchDelegationAuthority } = require(path.join(appRoot, 'shell', 'research-delegation-authority.cjs'))
const { validateResearchAccess, enforceResearchAccess } = require(path.join(engineRoot, 'src', 'lib', 'research-access.js'))
const { normalizeResearchDelegation } = require(path.join(engineRoot, 'src', 'lib', 'research-delegation-request.js'))

const fixtureRoot = await fs.promises.mkdtemp(path.join(process.env.T605_RESEARCH_FIXTURE_ROOT || os.tmpdir(), 't605-owner-setup-'))
const roomsRoot = path.join(fixtureRoot, 'rooms')
let clock
let authority

const request = (overrides = {}) => ({
  sessionId: 'owner-session',
  tier: 'full',
  requestKeys: { threadId: 'thread-1', treeAnchors: ['root', 'thread-1'] },
  research: { mode: 'clean-room', access: 'read-only', prompt: 'Inspect only these supplied inputs.', files: [] },
  ...overrides,
})
const makeAuthority = (ttlMs = 100) => {
  clock = 1000
  authority = createResearchDelegationAuthority({
    readParent: () => null,
    normalizeRequest: normalizeResearchDelegation,
    validateAccess: value => validateResearchAccess(value),
    enforceAccess: (tool, args, scope) => enforceResearchAccess(tool, args, scope),
    roomsRoot,
    ttlMs,
    now: () => clock,
  })
}
const refused = fn => assert.throws(fn, error =>
  error?.code === 'RESEARCH_DELEGATION_REFUSED' || error?.code === 'RESEARCH_ACCESS_REFUSED'
    || error?.code === 'RESEARCH_DELEGATION_INVALID'
    || error?.name === 'ResearchAccessError' || /Research delegation needs an explicit/.test(error?.message || ''))
const rooms = () => fs.readdirSync(roomsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)

beforeEach(async () => {
  await fs.promises.rm(roomsRoot, { recursive: true, force: true })
  await fs.promises.mkdir(roomsRoot, { recursive: true })
  makeAuthority()
})
after(async () => fs.promises.rm(fixtureRoot, { recursive: true, force: true }))

test('prepareSetup creates a frozen prompt-only clean room and successful finish retains it', async () => {
  const permit = authority.prepareSetup(request(), 'owner-key')
  assert.equal(Object.isFrozen(permit), true)
  assert.equal(permit.researchAccess.mode, 'clean-room')
  assert.deepEqual(permit.details, { nodeId: 'thread-1', mode: 'clean-room', access: 'read-only' })
  permit.assertStart()
  const room = permit.researchAccess.root
  assert.equal(fs.readdirSync(room).length, 0)
  permit.finish()
  assert.equal(fs.existsSync(room), true)
  permit.finish({ failed: true })
  assert.equal(fs.existsSync(room), true)
})

test('explicit text inputs are isolated, and failed finish removes only the owned room', async () => {
  const unrelated = path.join(roomsRoot, 'unrelated')
  await fs.promises.mkdir(unrelated)
  await fs.promises.writeFile(path.join(unrelated, 'keep.txt'), 'keep')
  const permit = authority.prepareSetup(request({
    research: { mode: 'clean-room', access: 'read-only', prompt: 'Read supplied text.', files: [
      { path: 'inputs/a.txt', content: 'alpha' }, { path: 'nested/b.txt', content: 'beta' },
    ] },
  }), 'owner-key')
  const room = permit.researchAccess.root
  assert.equal(fs.readFileSync(path.join(room, 'inputs/a.txt'), 'utf8'), 'alpha')
  assert.equal(fs.readFileSync(path.join(room, 'nested/b.txt'), 'utf8'), 'beta')
  permit.finish({ failed: true })
  assert.equal(fs.existsSync(room), false)
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep')
  permit.finish({ failed: true })
  assert.equal(fs.existsSync(room), false)
})

test('missing identity, empty owner, non-clean-room and mixed start fields refuse before room creation', () => {
  const invalid = [
    ['owner', request(), ''],
    ['session', request({ sessionId: undefined }), 'owner-key'],
    ['tier', request({ tier: undefined }), 'owner-key'],
    ['thread', request({ requestKeys: { treeAnchors: ['root', 'thread-1'] } }), 'owner-key'],
    ['anchors', request({ requestKeys: { threadId: 'thread-1', treeAnchors: ['thread-1', 'thread-1'] } }), 'owner-key'],
    ['mode', request({ research: { mode: 'folder', access: 'read-only', folder: fixtureRoot, prompt: 'folder' } }), 'owner-key'],
    ['mixed', request({ delegationToken: 'token' }), 'owner-key'],
    ['resume', request({ resumeThreadId: 'old' }), 'owner-key'],
    ['bounded', request({ boundedWork: { limit: 1 } }), 'owner-key'],
    ['permit', request({ researchPermit: {} }), 'owner-key'],
  ]
  for (const [, value, owner] of invalid) {
    const before = rooms()
    refused(() => authority.prepareSetup(value, owner))
    assert.deepEqual(rooms(), before)
  }
})

test('closure snapshot, cancellation, expiry, and post-finish starts are refused', () => {
  const original = request()
  const permit = authority.prepareSetup(original, 'owner-key')
  const room = permit.researchAccess.root
  permit.assertStart()
  original.tier = 'changed'
  refused(() => permit.assertStart())
  const cancelled = authority.prepareSetup(request({ sessionId: 'cancelled' }), 'owner-key')
  cancelled.cancel()
  refused(() => cancelled.assertStart())
  makeAuthority(10)
  const expired = authority.prepareSetup(request({ sessionId: 'expired' }), 'owner-key')
  clock = 1010
  refused(() => expired.assertStart())
  permit.finish({ failed: true })
  refused(() => permit.assertStart())
  assert.equal(fs.existsSync(room), false)
})

test('replaced room identity is refused before assertStart and failed cleanup', () => {
  const permit = authority.prepareSetup(request({ sessionId: 'replaced-room' }), 'owner-key')
  const room = permit.researchAccess.root
  const moved = room + '-moved'
  fs.renameSync(room, moved)
  fs.symlinkSync(fixtureRoot, room, process.platform === 'win32' ? 'junction' : 'dir')
  refused(() => permit.assertStart())
  refused(() => permit.finish({ failed: true }))
  assert.equal(fs.existsSync(moved), true)
  fs.rmSync(room, { recursive: true, force: true })
  fs.renameSync(moved, room)
})

test('malformed request objects and invalid input shapes refuse as delegation errors', () => {
  for (const value of [undefined, null, {}, request({ research: undefined }), request({ requestKeys: undefined }),
    request({ research: { mode: 'clean-room', access: 'read-only', prompt: 'x', files: [null] } })]) {
    refused(() => authority.prepareSetup(value, 'owner-key'))
  }
})
