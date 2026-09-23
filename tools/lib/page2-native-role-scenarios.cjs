'use strict'

// Role-library replay: inputs use the maintained native controls. mcOrg.read
// is observation only; no write IPC, injected callback or store fixture is used.
// These checks prove saved role policy, not enforcement in a provider session.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { navigate } = require('./page2-native-scenarios.cjs')

const RULE_FIELDS = ['owns', 'mustNot', 'handoff']
const CAPABILITIES = ['orgRoot', 'singleSeat', 'mayClaimWork', 'mayWakeReports', 'requiresMutationContext',
  'mayUseMissionBridge', 'mayReportMissionBridge', 'mayMutateMissionBridge']
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const rules = (word, phase) => ({
  owns: `Record ${word} ${phase} in this isolated QA role only.`,
  mustNot: 'Do not run tools, change files, start agents or treat these test directions as work.',
  handoff: `Return ${word} ${phase} observations to the person running this isolated check.`,
})

function ownedStorePath(qaRoot, value) {
  assert.ok(typeof value === 'string' && path.isAbsolute(value), 'The role store must return an absolute owned path')
  const relative = path.relative(qaRoot, value)
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`),
    'The actual role and organization stores must remain inside this run before any edit')
  // Refuse links before following an existing component. A new store's leaf
  // may be absent; the native launcher already owns the enclosing QA root.
  let current = qaRoot
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    let stat
    try { stat = fs.lstatSync(current) } catch (error) { if (error.code === 'ENOENT') break; throw error }
    assert.equal(stat.isSymbolicLink(), false, 'A role-store path must not redirect this QA edit through a link')
    if (stat.isFile()) assert.equal(stat.nlink, 1, 'The owned role store must not share a hard-linked file')
  }
  return relative
}

function assertRoleSnapshot(snapshot, qaRoot) {
  assert.equal(snapshot?.ok, true, 'The actual organization bridge must return its role library')
  assert.ok(Number.isSafeInteger(snapshot.org?.revision) && snapshot.org.revision >= 0)
  assert.ok(Array.isArray(snapshot.roles) && snapshot.roles.length > 0)
  assert.equal(new Set(snapshot.roles.map(role => role.id)).size, snapshot.roles.length)
  for (const role of snapshot.roles) {
    assert.ok(['id', 'name', 'custom', 'baseDefaultRole'].every(field => Object.hasOwn(role, field)),
      'Every role receipt must include its ID, displayed name, custom flag and base identity before an edit')
    assert.match(role.id, /^[a-z0-9][a-z0-9_-]{0,63}$/)
    assert.ok(typeof role.name === 'string' && role.name.trim(), 'Every role receipt must have a displayed name')
    assert.equal(typeof role.custom, 'boolean', 'Every role receipt must identify whether it is custom or shipped')
    assert.ok(role.baseDefaultRole === null || (typeof role.baseDefaultRole === 'string'
      && snapshot.roles.some(base => base.id === role.baseDefaultRole && base.custom === false)),
    'A role base must be null or the exact ID of a shipped role in the same receipt')
    if (role.custom) assert.equal(role.name, role.id, 'The current host names a custom role by its exact saved ID')
    else assert.equal(role.baseDefaultRole, null, 'A shipped role cannot inherit another base')
    assert.ok(Number.isSafeInteger(role.revision) && role.revision >= 0, 'Every role receipt must name its definition revision')
    assert.ok(RULE_FIELDS.every(field => typeof role[field] === 'string' && role[field] === role[field].trim() && role[field].length <= 6000
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(role[field])))
    assert.deepEqual(Object.keys(role.capabilities).sort(), [...CAPABILITIES].sort())
    assert.ok(Object.values(role.capabilities).every(value => typeof value === 'boolean'))
    assert.ok(role.functions === null || Array.isArray(role.functions))
    assert.equal(typeof role.requiresDirectUserAuthorization, 'boolean')
  }
  assert.ok(Array.isArray(snapshot.functionCatalog) && snapshot.functionCatalog.length > 2,
    'A missing function catalog cannot earn role-policy coverage')
  assert.equal(new Set(snapshot.functionCatalog.map(item => item.id)).size, snapshot.functionCatalog.length)
  return { organization: ownedStorePath(qaRoot, snapshot.overlayFile),
    roles: ownedStorePath(qaRoot, snapshot.roleMemorySelection?.file) }
}

async function readOrg(context) {
  const snapshot = await context.page.evaluate(() => window.mcOrg.read())
  const stores = assertRoleSnapshot(snapshot, context.paths.qaRoot)
  return { ...snapshot, stores }
}
function roleOf(snapshot, id) {
  const role = snapshot.roles.find(item => item.id === id)
  assert.ok(role, `The actual saved role library must contain ${id}`)
  return role
}
function assertOnlyRoleChanged(before, after, id) {
  assert.deepEqual(after.stores, before.stores, 'A role operation must retain its exact owned stores')
  assert.deepEqual(after.org, before.org, 'Role wording and function edits must retain the organization and seats')
  assert.deepEqual(after.functionCatalog, before.functionCatalog)
  assert.deepEqual(after.roles.filter(role => role.id !== id), before.roles.filter(role => role.id !== id),
    'A role operation must retain every unrelated role and revision')
}
function assertSavedRole(before, after, id, expected, { created = false } = {}) {
  assertOnlyRoleChanged(before, after, id)
  const role = roleOf(after, id)
  const previous = before.roles.find(item => item.id === id)
  assert.equal(Boolean(previous), !created)
  assert.equal(role.revision, created ? 1 : previous.revision + 1, 'One accepted role write must advance only its own revision once')
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, role[key]])), expected,
    'The saved role must retain the exact selected identity, directions, capabilities and policy')
  return role
}
async function agentState(context) {
  const nodes = await context.page.evaluate(() => {
    const result = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (!key?.startsWith('mc.fleet.trees.v1:')) continue
      for (const node of JSON.parse(localStorage.getItem(key))?.nodes || []) {
        result.push({ id: node.id, parentId: node.parentId ?? null, treeId: node.treeId,
          role: node.role, sessionId: node.sessionId ?? null })
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  })
  const file = path.join(context.paths.userData, 'agent-spawn-records.jsonl')
  const starts = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.action === 'agent_session_start').map(row => ({ sequence: row.sequence, sessionId: row.sessionId })) : []
  return { nodes, starts }
}
async function library(context) {
  const open = context.page.locator('dialog.role-studio[open]')
  if (await open.count()) await open.getByRole('button', { name: 'Close role workspace', exact: true }).click()
  await navigate(context, 'metrics')
  await navigate(context, 'computers')
  await context.page.getByRole('button', { name: 'Roles', exact: true }).click()
  const configuration = context.page.locator('.stats-page.is-active [data-fleet-details="configuration"]')
  await configuration.waitFor()
  assert.equal(await configuration.evaluate(element => element.open), true,
    'The actual Roles door must open its configuration panel')
  const box = configuration.locator('.board-roles-box')
  await box.waitFor()
  const dialog = box.locator('dialog.role-studio[open]')
  await dialog.waitFor()
  assert.equal(await dialog.locator('.rs-header h1').innerText(), 'Role workspace')
  await dialog.locator('[data-role-list] [data-select-role="observer"]').waitFor()
  return dialog
}
async function itemFor(box, id) {
  await box.locator(`[data-role-list] [data-select-role="${id}"]`).click()
  const item = box.locator('[data-studio-main]')
  await item.waitFor()
  await item.getByRole('tab', { name: 'Directions', exact: true }).click()
  return item
}
async function functionPolicy(item) {
  await item.getByRole('tab', { name: 'Functions', exact: true }).click()
  const policy = {
    standard: await item.locator('[data-field="functions-standard"]').isChecked(),
    direct: await item.locator('[data-field="direct-user"]').isChecked(),
    functions: await item.locator('[data-function-id]').evaluateAll(elements => elements.map(element => ({
      id: element.dataset.functionId, checked: element.checked, disabled: element.disabled,
    }))),
  }
  await item.getByRole('tab', { name: 'Directions', exact: true }).click()
  return policy
}
async function visibleRole(box, role) {
  const item = await itemFor(box, role.id)
  assert.equal(await item.locator('.rs-editor-heading h2').innerText(), role.name,
    'The displayed role name must match the same receipt as its ID and directions')
  for (const field of RULE_FIELDS) assert.equal(await item.locator(`[data-field="${field}"]`).inputValue(), role[field],
    'The displayed role directions must match one authoritative read receipt')
  assert.equal(await item.locator('.rs-editor-heading .rs-eyebrow').innerText(), role.custom ? 'CUSTOM ROLE' : 'DEFAULT ROLE')
  const caps = role.capabilities
  assert.deepEqual(await item.locator('.rs-abilities > span').allTextContents(), [
    caps.mayClaimWork ? 'Can take assigned work' : 'Cannot reserve work',
    caps.mayWakeReports ? 'Can wake reports' : 'Does not wake reports',
    ...(caps.orgRoot ? ['Organisation root'] : []), ...(caps.singleSeat ? ['One seat'] : []),
    caps.mayMutateMissionBridge ? 'Team APIs: act' : caps.mayReportMissionBridge ? 'Team APIs: report'
      : caps.mayUseMissionBridge ? 'Team APIs: inspect' : 'No team API access',
  ], 'Visible role abilities must match the authoritative saved capabilities')
  const { standard, direct, functions } = await functionPolicy(item)
  assert.equal(standard, role.functions === null)
  assert.equal(direct, role.requiresDirectUserAuthorization)
  assert.deepEqual(functions.filter(item => item.checked).map(item => item.id).sort(), [...(role.functions || [])].sort())
  assert.ok(functions.every(item => item.disabled === (role.functions === null)))
  return item
}
async function fillRules(context, item, directions) {
  for (const field of RULE_FIELDS) await context.type(item.locator(`[data-field="${field}"]`), directions[field])
}
async function newRole(context, box, id, directions) {
  await box.getByRole('button', { name: '+ New role', exact: true }).click()
  const item = box.locator('[data-studio-main]')
  await context.type(item.locator('[data-field="id"]'), id)
  await context.select(item.locator('[data-field="base"]'), 'observer')
  await fillRules(context, item, directions)
  return item
}
async function receipt(box, expected) {
  const out = box.locator('[data-studio-status]')
  await out.filter({ hasText: new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).waitFor()
  const actual = await out.innerText()
  assert.equal(actual, expected, 'The real role control must display its exact accepted or refused sentence')
  return actual
}
async function unchangedAgents(context, before) {
  assert.deepEqual(await agentState(context), before, 'Role-library controls must not start agents or change saved agent identities')
}
const roleProof = (snapshot, role) => ({ roleId: role.id, revision: role.revision, orgRevision: snapshot.org.revision,
  roleSha256: hash(role), stores: snapshot.stores, displayedFields: RULE_FIELDS,
  scope: 'Saved role definition and visible controls; no provider-session enforcement or visible per-role revision claim' })

async function refuseReservedRole(context, id) {
  const before = await readOrg(context), agents = await agentState(context), directions = rules(id, 'refused')
  assert.equal(before.roles.some(role => role.id === id), false)
  const box = await library(context), item = await newRole(context, box, id, directions)
  const policy = await functionPolicy(item)
  await item.locator('.rs-editor-footer').getByRole('button', { name: 'Create role', exact: true }).click()
  // Role Studio displays the authoritative store's exact refusal sentence.
  const refusalSentence = await receipt(box, `Role id "${id}" is reserved and cannot name a role.`)
  assert.equal(await item.locator('[data-field="id"]').inputValue(), id)
  assert.equal(await item.locator('[data-field="base"]').inputValue(), 'observer')
  for (const field of RULE_FIELDS) assert.equal(await item.locator(`[data-field="${field}"]`).inputValue(), directions[field], 'A reserved-ID refusal must retain the exact unsaved directions')
  assert.deepEqual(await functionPolicy(item), policy)
  assert.equal(await item.locator('.rs-editor-footer').getByRole('button', { name: 'Create role', exact: true }).isEnabled(), true)
  assert.deepEqual(await readOrg(context), before, 'A reserved role ID must not change any stored role or revision')
  await unchangedAgents(context, agents)
  await context.step(`role-reserved-${id}-retained-draft`, async () => ({ rejectedId: id, refusalSentence, directions, base: 'observer', policy, storedRoleCount: before.roles.length }))
  await context.capture(`native-role-reserved-${id}`)
}

const scenarios = [
  { id: 'role-library-open', title: 'Open the real role library and match the selected shipped role to its read receipt', controls: ['role.drawer.open', 'role.select'], requires: ['setup'], async run(context) {
    const before = await readOrg(context), agents = await agentState(context)
    const box = await library(context), observer = roleOf(before, 'observer')
    assert.equal(observer.custom, false)
    assert.deepEqual(await box.locator('[data-role-list] [data-select-role]').evaluateAll(elements => elements.map(item => item.dataset.selectRole)), before.roles.map(role => role.id))
    await visibleRole(box, observer)
    assert.deepEqual(await readOrg(context), before)
    await unchangedAgents(context, agents)
    context.state.nativeRoleLibrary = { id: `qa-role-${hash(context.paths.qaRoot).slice(0, 10)}`, shipped: observer }
    await context.step('role-library-selected-receipt', async () => roleProof(before, observer))
    await context.capture('native-role-library-selected')
  } },
  { id: 'role-custom-create', title: 'Create one custom Observer-based role through the real form and retain its exact stored definition', controls: ['role.create'], requires: ['role-library-open'], async run(context) {
    const id = context.state.nativeRoleLibrary.id, directions = rules(id, 'created')
    const before = await readOrg(context), agents = await agentState(context), base = roleOf(before, 'observer')
    assert.equal(before.roles.some(role => role.id === id), false)
    const box = await library(context), item = await newRole(context, box, id, directions)
    await item.locator('.rs-editor-footer').getByRole('button', { name: 'Create role', exact: true }).click()
    await receipt(box, 'Role created.')
    const after = await readOrg(context)
    const role = assertSavedRole(before, after, id, { id, custom: true, baseDefaultRole: 'observer', ...directions,
      capabilities: base.capabilities, functions: base.functions, requiresDirectUserAuthorization: base.requiresDirectUserAuthorization }, { created: true })
    await visibleRole(box, role)
    await visibleRole(await library(context), role)
    assert.deepEqual(await readOrg(context), after, 'The custom role must survive a real route remount')
    await unchangedAgents(context, agents)
    await context.step('role-custom-created-receipt', async () => roleProof(after, role))
    await context.capture('native-role-custom-created')
  } },
  { id: 'role-custom-edit', title: 'Save new custom-role directions while retaining its ID, base, capabilities and function policy', controls: ['role.edit'], requires: ['role-custom-create'], async run(context) {
    const id = context.state.nativeRoleLibrary.id, directions = rules(id, 'edited')
    const before = await readOrg(context), agents = await agentState(context), previous = roleOf(before, id)
    const box = await library(context), item = await visibleRole(box, previous)
    await fillRules(context, item, directions)
    await item.locator('.rs-editor-footer').getByRole('button', { name: 'Save role', exact: true }).click()
    await receipt(box, 'Role saved.')
    const after = await readOrg(context)
    const role = assertSavedRole(before, after, id, { id, custom: true, baseDefaultRole: previous.baseDefaultRole, ...directions,
      capabilities: previous.capabilities, functions: previous.functions, requiresDirectUserAuthorization: previous.requiresDirectUserAuthorization })
    await visibleRole(box, role)
    await unchangedAgents(context, agents)
    await context.step('role-custom-edited-receipt', async () => roleProof(after, role))
    await context.capture('native-role-custom-edited')
    const empty = { owns: '', mustNot: '', handoff: '' }
    await fillRules(context, item, empty)
    await item.locator('.rs-editor-footer').getByRole('button', { name: 'Save role', exact: true }).click()
    await receipt(box, 'Role saved.')
    const cleared = await readOrg(context)
    const emptyRole = assertSavedRole(after, cleared, id, { id, custom: true, baseDefaultRole: role.baseDefaultRole,
      ...empty, capabilities: role.capabilities, functions: role.functions,
      requiresDirectUserAuthorization: role.requiresDirectUserAuthorization })
    await visibleRole(box, emptyRole)
    await visibleRole(await library(context), emptyRole)
    assert.deepEqual(await readOrg(context), cleared, 'Empty directions must survive a real role-library remount')
    await unchangedAgents(context, agents)
    await context.step('role-custom-empty-directions-persisted', async () => ({ ...roleProof(cleared, emptyRole), directions: empty }))
    await context.capture('native-role-custom-empty-directions')
  } },
  { id: 'role-reserved-id-owner', title: 'Refuse reserved role ID owner and retain all entered directions',
    controls: ['role.reserved-id'], requires: ['role-library-open'], async run(context) { await refuseReservedRole(context, 'owner') } },
  { id: 'role-reserved-id-me', title: 'Refuse reserved role ID me and retain all entered directions',
    controls: ['role.reserved-id'], requires: ['role-library-open'], async run(context) { await refuseReservedRole(context, 'me') } },
  { id: 'role-reserved-id-act', title: 'Refuse reserved role ID act and retain all entered directions',
    controls: ['role.reserved-id'], requires: ['role-library-open'], async run(context) { await refuseReservedRole(context, 'act') } },
  { id: 'role-functions-filter', title: 'Filter the actual installed function choices without losing selections or changing a role', controls: ['role.functions.filter'], requires: ['role-custom-create'], async run(context) {
    const before = await readOrg(context), agents = await agentState(context), role = roleOf(before, context.state.nativeRoleLibrary.id)
    const box = await library(context), item = await visibleRole(box, role)
    await item.getByRole('tab', { name: 'Functions', exact: true }).click()
    const search = item.locator('[data-function-search]'), rows = item.locator('[data-function-row]')
    const ids = await rows.evaluateAll(elements => elements.map(row => row.querySelector('[data-function-id]').dataset.functionId))
    assert.deepEqual(ids, before.functionCatalog.map(item => item.id))
    const query = 'APP.CONTEXT'
    const expected = before.functionCatalog.filter(item => `${item.id} ${item.summary}`.toLowerCase().includes(query.toLowerCase())).map(item => item.id)
    assert.ok(expected.length > 0 && expected.length < ids.length)
    await context.type(search, query)
    assert.deepEqual(await item.locator('[data-function-row]:visible').evaluateAll(elements => elements.map(row => row.querySelector('[data-function-id]').dataset.functionId)), expected,
      'The visible filtered choices must be exactly the matching installed functions')
    await context.capture('native-role-functions-filtered')
    await context.type(search, `no-installed-function-${context.state.nativeRoleLibrary.id}`)
    assert.equal(await item.locator('[data-function-row]:visible').count(), 0)
    await context.type(search, '')
    assert.deepEqual(await item.locator('[data-function-row]:visible').evaluateAll(elements => elements.map(row => row.querySelector('[data-function-id]').dataset.functionId)), ids)
    await visibleRole(box, role)
    assert.deepEqual(await readOrg(context), before)
    await unchangedAgents(context, agents)
    await context.step('role-function-filter-exact-choices', async () => ({ roleId: role.id, query, visibleMatches: expected, restoredCount: ids.length }))
  } },
  { id: 'role-functions-restrict', title: 'Save an exact custom-role function subset and its direct-user action requirement', controls: ['role.functions.select'], requires: ['role-custom-edit', 'role-functions-filter'], async run(context) {
    const before = await readOrg(context), agents = await agentState(context), id = context.state.nativeRoleLibrary.id, previous = roleOf(before, id)
    const selected = ['app.context', 'settings.read']
    assert.ok(selected.every(id => before.functionCatalog.some(item => item.id === id)))
    assert.equal(previous.functions, null, 'The fresh Observer-based custom role must begin on its normal installed surface')
    assert.equal(previous.requiresDirectUserAuthorization, false)
    const box = await library(context), item = await visibleRole(box, previous)
    await item.getByRole('tab', { name: 'Functions', exact: true }).click()
    await item.locator('[data-field="functions-standard"]').uncheck()
    await item.locator('[data-field="direct-user"]').check()
    for (const id of selected) await item.locator(`[data-function-id="${id}"]`).check()
    await item.locator('.rs-editor-footer').getByRole('button', { name: 'Save role', exact: true }).click()
    await receipt(box, 'Role saved.')
    const after = await readOrg(context)
    const role = assertSavedRole(before, after, id, { id, custom: true, baseDefaultRole: previous.baseDefaultRole,
      ...Object.fromEntries(RULE_FIELDS.map(field => [field, previous[field]])), capabilities: previous.capabilities,
      functions: selected, requiresDirectUserAuthorization: true })
    await visibleRole(box, role)
    const reopened = await visibleRole(await library(context), role)
    assert.deepEqual(await readOrg(context), after, 'The exact function subset and direct-user requirement must survive remount')
    await unchangedAgents(context, agents)
    await context.step('role-function-policy-saved-exactly', async () => ({ ...roleProof(after, role), functions: selected, requiresDirectUserAuthorization: true }))
    await reopened.getByRole('tab', { name: 'Functions', exact: true }).click()
    await context.select(reopened.locator('[data-function-filter]'), 'selected')
    assert.deepEqual(await reopened.locator('[data-function-row]:visible').evaluateAll(elements => elements.map(row => row.querySelector('[data-function-id]').dataset.functionId)).then(ids => ids.sort()), selected)
    await context.capture('native-role-functions-restricted')
  } },
  { id: 'role-shipped-wording-restore', title: 'Edit the isolated shipped Observer wording and restore its exact original definition', controls: ['role.directions.restore'], requires: ['role-library-open'], async run(context) {
    const before = await readOrg(context), agents = await agentState(context), id = 'observer', original = roleOf(before, id)
    assert.deepEqual(original, context.state.nativeRoleLibrary.shipped, 'The isolated shipped role must still match the original selected receipt')
    assert.equal(original.revision, 0, 'A pre-existing shipped override cannot be treated as the shipped baseline')
    const box = await library(context), item = await visibleRole(box, original), directions = rules(id, 'temporary wording')
    await fillRules(context, item, directions)
    await item.locator('.rs-editor-footer').getByRole('button', { name: 'Save role', exact: true }).click()
    await receipt(box, 'Role saved.')
    const edited = await readOrg(context)
    const changed = assertSavedRole(before, edited, id, { id, custom: false, ...directions, capabilities: original.capabilities,
      functions: original.functions, requiresDirectUserAuthorization: original.requiresDirectUserAuthorization })
    await visibleRole(box, changed)
    await (await itemFor(box, id)).getByRole('button', { name: 'Restore defaults…', exact: true }).click()
    await item.locator('.rs-reset-confirm').waitFor()
    assert.deepEqual(await readOrg(context), edited, 'Opening reset confirmation must not change any saved role')
    await item.locator('.rs-reset-confirm').getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.deepEqual(await readOrg(context), edited, 'Cancelling reset must preserve the edited role')
    await item.getByRole('button', { name: 'Restore defaults…', exact: true }).click()
    await item.getByRole('button', { name: 'Restore this role', exact: true }).click()
    await receipt(box, 'Default directions and function policy restored.')
    const after = await readOrg(context)
    const restored = assertSavedRole(edited, after, id, { ...original, revision: changed.revision + 1 })
    await visibleRole(box, restored)
    await visibleRole(await library(context), restored)
    assert.deepEqual(await readOrg(context), after, 'Restored shipped wording must survive a real route remount')
    await unchangedAgents(context, agents)
    await context.step('role-shipped-definition-restored', async () => ({ ...roleProof(after, restored), beforeRevision: original.revision, editedRevision: changed.revision }))
    await context.capture('native-role-shipped-wording-restored')
  } },
]

module.exports = { scenarios, assertRoleSnapshot, assertSavedRole, ownedStorePath }
