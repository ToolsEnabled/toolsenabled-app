import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { createActionPermissionProfileHost } = require('../../shell/action-permission-profile-host.cjs')

test('saved profile host reads committed preferences and confines inherited authority to one owner', () => {
  let saved = 'committed'; let damaged = false
  const owner = {}; const other = {}
  const sessions = new Map([['child', { owner, ownerKind: 'window' }], ['parent', { owner, ownerKind: 'window' }],
    ['foreign', { owner: other, ownerKind: 'window' }]])
  let ancestors = ['foreign']
  const host = createActionPermissionProfileHost({
    prefs: { snapshot: () => ({ ok: true, damaged, values: { permissions: saved } }), set: (key, value) => { saved = value; return { ok: true } } },
    policy: { SETTINGS_KEY: 'permissions', normalize: value => { if (value === 'invalid') throw new Error('Invalid'); return value } },
    sessions, getAgentHost: () => ({ isDirectUserTurn: () => true, inheritedUserPermissionSessions: () => ancestors }),
  })
  assert.equal(host.readSaved(), 'committed')
  assert.equal(host.hasInheritedUserPermission('child'), false)
  ancestors = ['parent']
  assert.equal(host.hasInheritedUserPermission('child'), true)
  sessions.get('parent').ended = true
  assert.equal(host.hasInheritedUserPermission('child'), false)
  assert.throws(() => host.save('invalid'))
  assert.equal(host.readSaved(), 'committed')
  damaged = true
  assert.throws(() => host.readSaved())
})

test('host exposes trusted working-profile receipts and ignores renderer claims', () => {
  let receipt = { id: 'independent', atMs: 1 }
  const host = createActionPermissionProfileHost({
    prefs: { snapshot: () => ({ ok: true, damaged: false, values: {} }), set: () => ({ ok: true }) },
    policy: { SETTINGS_KEY: 'permissions', normalize: value => value },
    sessions: new Map(), getAgentHost: () => null,
    readWorkingProfile: () => receipt,
  })
  assert.equal(host.readWorkingProfile(), 'independent')
  receipt = { id: 'locked', atMs: 2 }
  assert.equal(host.readWorkingProfile(), 'locked')
})

test('a fresh host observes external profile changes and treats unavailable receipts as unknown', () => {
  let profile = 'autonomous-plus'
  const makeHost = readWorkingProfile => createActionPermissionProfileHost({
    prefs: { snapshot: () => ({ ok: true, damaged: false, values: {} }), set: () => ({ ok: true }) },
    policy: { SETTINGS_KEY: 'permissions', normalize: value => value },
    sessions: new Map(), getAgentHost: () => null, readWorkingProfile,
  })
  assert.equal(makeHost(() => profile).readWorkingProfile(), 'autonomous-plus')
  profile = 'balanced'
  assert.equal(makeHost(() => profile).readWorkingProfile(), 'balanced')
  assert.equal(makeHost(() => { throw new Error('trusted settings unavailable') }).readWorkingProfile(), null)
  assert.equal(makeHost(() => ({ label: 'renderer claim' })).readWorkingProfile(), null)
})

test('working-profile receipt parsing is OS-neutral for Linux and Windows', () => {
  for (const id of ['locked', 'careful', 'balanced', 'independent', 'autonomous', 'autonomous-plus']) {
    const host = createActionPermissionProfileHost({
      prefs: { snapshot: () => ({ ok: true, damaged: false, values: {} }), set: () => ({ ok: true }) },
      policy: { SETTINGS_KEY: 'permissions', normalize: value => value },
      sessions: new Map(), getAgentHost: () => null, readWorkingProfile: () => ({ id }),
    })
    assert.equal(host.readWorkingProfile(), id)
  }
})

test('host ancestry permission includes active ancestor turns only, never siblings or another tree', () => {
  const source = readFileSync(new URL('../../shell/agent-host.cjs', import.meta.url), 'utf8')
  const at = source.indexOf('  function inheritedUserPermissionSessions(')
  const end = source.indexOf('\n  }', at)
  assert.ok(at >= 0 && end > at)
  const sessions = new Map()
  const add = (id, node, anchors, direct = true) => sessions.set(id, { sessionId: id, treeNodeKey: node, treeRequestIdentity: { treeAnchors: anchors }, direct })
  add('child', 'child-node', ['root', 'parent-node', 'child-node'])
  add('parent', 'parent-node', ['root', 'parent-node'])
  add('sibling', 'sibling-node', ['root', 'sibling-node'])
  add('foreign', 'parent-node', ['different-root', 'parent-node'])
  add('root', 'root', ['root'], false)
  const inherited = new Function('sessions', 'isDirectUserTurn', source.slice(at, end + 4) + '; return inheritedUserPermissionSessions;')(
    sessions, id => sessions.get(id)?.direct === true)
  assert.deepEqual(inherited('child'), ['parent'])
  sessions.get('parent').direct = false
  assert.deepEqual(inherited('child'), [])
  sessions.get('parent').direct = true
  sessions.get('child').closeRequested = true
  assert.deepEqual(inherited('child'), [])
})
