import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const { assertRoleSnapshot, assertSavedRole, ownedStorePath, scenarios } = require('../lib/page2-native-role-scenarios.cjs')
const capabilities = { orgRoot: false, singleSeat: false, mayClaimWork: false, mayWakeReports: false,
  requiresMutationContext: false, mayUseMissionBridge: false, mayReportMissionBridge: false, mayMutateMissionBridge: false }
const role = (id, revision = 0) => ({ id, name: id, custom: id !== 'observer', baseDefaultRole: id === 'observer' ? null : 'observer',
  owns: 'Fixture observations', mustNot: 'Perform work', handoff: 'Return observations', revision, capabilities,
  functions: null, requiresDirectUserAuthorization: false })
const snapshot = qaRoot => ({ ok: true, org: { revision: 1, agents: [{ id: 'manager' }] }, roles: [role('observer')],
  functionCatalog: ['app.context', 'settings.read', 'agent.status'].map(id => ({ id, effect: 'state-read', summary: id })),
  overlayFile: path.join(qaRoot, 'stores', 'organization.json'), roleMemorySelection: { file: path.join(qaRoot, 'stores', 'roles.json') },
  stores: { organization: path.join('stores', 'organization.json'), roles: path.join('stores', 'roles.json') } })
function owned(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-role-proof-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'stores'))
  return root
}

test('role snapshot requires actual complete definitions and both exact owned store locations', t => {
  const root = owned(t), value = snapshot(root)
  assert.deepEqual(assertRoleSnapshot(value, root), value.stores)
  for (const mutate of [
    copy => { copy.ok = false },
    copy => { copy.roles[0].revision = null },
    copy => { copy.roles[0].capabilities.mayClaimWork = 'false' },
    copy => { copy.roles.push(structuredClone(copy.roles[0])) },
    copy => { copy.functionCatalog = [] },
    copy => { copy.roleMemorySelection.file = path.join(root, '..', 'owner-role.json') },
    copy => { copy.overlayFile = path.join(root, '..', 'owner-org.json') },
  ]) {
    const copy = structuredClone(value); mutate(copy)
    assert.throws(() => assertRoleSnapshot(copy, root))
  }
})

test('a role edit cannot redirect its owned path through a symlink or hard-linked file', t => {
  const root = owned(t)
  writeFileSync(path.join(root, 'stores', 'original.json'), '{}')
  linkSync(path.join(root, 'stores', 'original.json'), path.join(root, 'stores', 'linked.json'))
  assert.throws(() => ownedStorePath(root, path.join(root, 'stores', 'linked.json')), /hard-linked/)
  symlinkSync(path.join(root, 'stores'), path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => ownedStorePath(root, path.join(root, 'redirect', 'roles.json')), /through a link/)
})

for (const field of ['id', 'name', 'custom', 'baseDefaultRole']) {
  test(`role evidence rejects a missing ${field} before any edit`, t => {
    const root = owned(t), value = snapshot(root)
    delete value.roles[0][field]
    assert.throws(() => assertRoleSnapshot(value, root), /must include its ID/)
  })
}

test('role evidence rejects malformed names, custom flags and foreign or nonshipped base identities', t => {
  const root = owned(t), value = snapshot(root)
  value.roles.push(role('qa-role-control', 1))
  assert.deepEqual(assertRoleSnapshot(value, root), value.stores)
  for (const mutate of [
    copy => { copy.roles[0].name = ' ' },
    copy => { copy.roles[0].custom = 'false' },
    copy => { copy.roles[0].baseDefaultRole = 'observer' },
    copy => { copy.roles[1].name = 'Another ID' },
    copy => { copy.roles[1].baseDefaultRole = 'missing-base' },
    copy => { copy.roles[1].baseDefaultRole = 'qa-role-control' },
  ]) {
    const copy = structuredClone(value); mutate(copy)
    assert.throws(() => assertRoleSnapshot(copy, root))
  }
})

test('one custom creation and one saved restriction bind the exact role identity and revision', t => {
  const root = owned(t), before = snapshot(root), created = structuredClone(before)
  const id = 'qa-role-control'
  created.roles.push(role(id, 1))
  const first = assertSavedRole(before, created, id, { id, baseDefaultRole: 'observer', custom: true, capabilities }, { created: true })
  assert.equal(first.id, id)
  const edited = structuredClone(created), changed = edited.roles.find(item => item.id === id)
  changed.revision = 2; changed.functions = ['app.context', 'settings.read']; changed.requiresDirectUserAuthorization = true
  assert.equal(assertSavedRole(created, edited, id, { id, revision: 2, functions: changed.functions, requiresDirectUserAuthorization: true }).id, id)
})

for (const [name, mutate] of [
  ['a changed unrelated role', value => { value.roles[0].owns = 'Unrelated rewrite' }],
  ['a changed organization seat', value => { value.org.agents[0].id = 'another-manager' }],
  ['a changed store identity', value => { value.stores.roles = 'another-store.json' }],
  ['a second revision advance', value => { value.roles[1].revision = 3 }],
  ['the wrong exact function subset', value => { value.roles[1].functions = ['agent.status'] }],
  ['a missing direct-user restriction', value => { value.roles[1].requiresDirectUserAuthorization = false }],
]) {
  test(`role-policy evidence rejects ${name}`, t => {
    const before = snapshot(owned(t)); before.roles.push(role('qa-role-control', 1))
    const after = structuredClone(before)
    after.roles[1] = { ...after.roles[1], revision: 2, functions: ['app.context', 'settings.read'], requiresDirectUserAuthorization: true }
    mutate(after)
    assert.throws(() => assertSavedRole(before, after, 'qa-role-control', {
      id: 'qa-role-control', functions: ['app.context', 'settings.read'], requiresDirectUserAuthorization: true,
    }))
  })
}

test('the role batch names each reserved-ID action separately and orders its prerequisites', () => {
  const known = new Set(['setup'])
  for (const scenario of scenarios) {
    assert.ok(!known.has(scenario.id))
    for (const required of scenario.requires) assert.ok(known.has(required), `${scenario.id} has an unavailable predecessor ${required}`)
    known.add(scenario.id)
  }
  assert.equal(scenarios.length, 9)
  assert.deepEqual(scenarios.filter(item => item.id.startsWith('role-reserved-id-')).map(item => item.id),
    ['role-reserved-id-owner', 'role-reserved-id-me', 'role-reserved-id-act'])
})

test('native role receipts accept empty directions but retain readable-text bounds and policy checks', t => {
  const root = owned(t), value = snapshot(root)
  Object.assign(value.roles[0], { owns: '', mustNot: '', handoff: '' })
  assert.deepEqual(assertRoleSnapshot(value, root), value.stores)
  for (const field of ['owns', 'mustNot', 'handoff']) for (const text of [undefined, null, false, [], {}, ' ', '\u0000', 'x'.repeat(6001)]) {
    const copy = structuredClone(value); copy.roles[0][field] = text
    assert.throws(() => assertRoleSnapshot(copy, root))
  }
})

// Helper-contract controls only; the contextual Electron replay separately
// exercises the actual Home guide, its storage writer and reload behavior.
const { quietNewPageTips } = require('../lib/page2-native-scenarios.cjs')
function guideControlModel(fault) {
  let saved = { version: 1, quiet: false, seen: { home: true } }, quiet = false, closed = false
  const clicks = []
  const guide = {
    async waitFor(options = {}) { if (options.state === 'hidden') assert.equal(closed, true) },
    locator(selector) { assert.equal(selector, '#first-use-preference-feedback'); return { async innerText() {
      if (fault === 'session-only') return 'Tips are off for this visit. This choice could not be saved.'
      return quiet ? 'Tips are off. Use Guide to revisit any page.' : 'New-page tips are on.'
    } } },
    getByRole(role, { name, exact }) {
      assert.equal(role, 'button'); assert.equal(exact, true)
      return { async click() {
        if (name === 'Close guide') { closed = true; clicks.push(name); return }
        assert.equal(name, quiet ? 'Turn on new-page tips' : 'Turn off new-page tips')
        clicks.push(name); quiet = !quiet
        if (fault !== 'unsaved') saved = { ...saved, quiet }
        if (fault === 'unrelated-change') saved.seen = { home: true, computers: true }
      }, async isEnabled() { assert.equal(name, quiet ? 'Turn on new-page tips' : 'Turn off new-page tips'); return fault !== 'not-reversible' } }
    },
  }
  const context = { page: {
    locator(selector) { assert.equal(selector, '.first-use-layer:not([hidden])'); return guide },
    async evaluate(callback) {
      const value = vm.runInNewContext('(' + callback.toString() + ')()', { localStorage: {
        getItem(key) { assert.equal(key, 'mc.set.feature_guides.v1'); return JSON.stringify(saved) },
        setItem() { assert.fail('The audit helper must never inject a preference write') },
      } })
      return JSON.parse(JSON.stringify(value))
    },
  } }
  return { context, clicks, closed: () => closed }
}
test('ordinary setup guide preparation saves a reversible preference through only actual control gestures', async () => {
  const model = guideControlModel()
  const result = await quietNewPageTips(model.context)
  assert.deepEqual(model.clicks, ['Turn off new-page tips', 'Turn on new-page tips', 'Turn off new-page tips', 'Close guide'])
  assert.deepEqual(result.states.map(state => state.quiet), [true, false, true])
  assert.ok(result.states.every(state => JSON.stringify(state.seen) === JSON.stringify({ home: true })))
  assert.equal(result.closed, true)
})
for (const fault of ['session-only', 'unsaved', 'unrelated-change', 'not-reversible']) {
  test(`ordinary setup guide preparation refuses ${fault} before closing or proceeding`, async () => {
    const model = guideControlModel(fault)
    await assert.rejects(quietNewPageTips(model.context))
    assert.equal(model.closed(), false)
    assert.deepEqual(model.clicks, ['Turn off new-page tips'])
  })
}
