import '../../../src/role-studio.css'
import { buildRoleStudio } from '../../../src/role-studio.js'

// Actual editor and events. The persistence callbacks retain receipts in this
// sandboxed renderer; durable store/projection coverage lives in Engine tests.
const empty = { owns: '', mustNot: '', handoff: '' }
const original = { id: 'empty-helper', name: 'empty-helper', custom: true, baseDefaultRole: null, revision: 1,
  ...empty, owns: 'Initial responsibility.', rules: [], functions: ['app.context'], requiresDirectUserAuthorization: true }
let roles = [original]
const operations = []
const box = buildRoleStudio({ availability: { state: 'ready', ruleTextLimit: 6000, roles, org: { agents: [] },
  functionCatalog: [{ id: 'app.context', summary: 'Read app context.', effect: 'state-read' }] },
  onEdit: async value => {
    operations.push({ kind: 'edit', value })
    if (value.id === 'new-empty-helper') return { ok: false, reason: 'The requested role change was refused.' }
    roles = roles.map(role => role.id === value.id ? { ...role, ...value.rules, revision: role.revision + 1,
      functions: value.functions, requiresDirectUserAuthorization: value.requiresDirectUserAuthorization } : role)
    return { ok: true, roles }
  },
  onCreate: async value => {
    operations.push({ kind: 'create', value })
    roles = [...roles, { ...value, ...value.rules, rules: [], revision: 1, name: value.id, custom: true }]
    return { ok: true, roles }
  }, onReset: async () => ({ ok: false }), onRead: async () => ({ state: 'ready', roles }) })
document.body.append(box)
window.emptyRoleEditor = {
  operations: () => structuredClone(operations), roles: () => structuredClone(roles),
  point(selector) {
    const element = box.querySelector(selector)
    if (!element) throw new Error('Missing editor control ' + selector)
    element.scrollIntoView({ block: 'nearest' }); element.focus()
    const rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Editor control is not reachable: ' + selector)
    return { x: Math.round(x), y: Math.round(y) }
  },
  fields: () => Object.fromEntries(['owns', 'mustNot', 'handoff'].map(field => [field, box.querySelector(`[data-field="${field}"]`)?.value])),
  status: () => box.querySelector('[data-studio-status]').textContent,
  outsideStatus: () => box.querySelector('[data-roles="out"]').textContent,
}
