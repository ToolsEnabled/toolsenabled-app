// Plain role documents are portable drafts. Import never writes to the store;
// the normal Save/Create operation validates and persists the reviewed draft.
export const ROLE_DOCUMENT_VERSION = 1
export const ROLE_FIELDS = [
  { key: 'owns', label: 'Responsibilities', hint: 'What this role owns, how it starts, and what a good result looks like.' },
  { key: 'mustNot', label: 'Boundaries', hint: 'What belongs to another role, and where this role should stop or escalate.' },
  { key: 'handoff', label: 'Context & handoff', hint: 'What to provide at the start, who receives the result, and what evidence to return.' },
]

export function roleDraft(role) {
  return {
    id: role?.id || '', baseDefaultRole: role?.baseDefaultRole || null,
    rules: Object.fromEntries(ROLE_FIELDS.map(({ key }) => [key, role?.[key] ?? role?.rules?.[key] ?? ''])),
    functions: Array.isArray(role?.functions) ? [...role.functions].sort() : null,
    requiresDirectUserAuthorization: role?.requiresDirectUserAuthorization === true,
  }
}

export function sameDraft(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function roleDocument(draft) {
  return JSON.stringify({ format: 'toolsenabled.role', version: ROLE_DOCUMENT_VERSION, ...draft }, null, 2) + '\n'
}

export function parseRoleDocument(text, maxRuleText = 1500) {
  if (text.length > 400000) throw new Error('This role file is too large. Import one role at a time.')
  let doc
  try { doc = JSON.parse(text) } catch { throw new Error('Use a JSON role file exported from the role workspace.') }
  if (!doc || doc.format !== 'toolsenabled.role' || doc.version !== ROLE_DOCUMENT_VERSION) throw new Error('This file is not a supported ToolsEnabled role document.')
  const keys = ['format', 'version', 'id', 'baseDefaultRole', 'rules', 'functions', 'requiresDirectUserAuthorization']
  if (Object.keys(doc).some(key => !keys.includes(key))) throw new Error('The role document contains unsupported fields.')
  if (typeof doc.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(doc.id)) throw new Error('Give the role an ID using lowercase letters, numbers, hyphens or underscores.')
  if (doc.baseDefaultRole !== null && (typeof doc.baseDefaultRole !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(doc.baseDefaultRole))) throw new Error('The base role must be a role ID or null.')
  if (!doc.rules || typeof doc.rules !== 'object' || Object.keys(doc.rules).length !== 3 || ROLE_FIELDS.some(({ key }) =>
    typeof doc.rules[key] !== 'string' || doc.rules[key].length > maxRuleText || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(doc.rules[key]))) {
    throw new Error(`Include all three directions fields, each with 0–${maxRuleText} readable characters.`)
  }
  if (doc.functions !== null && (!Array.isArray(doc.functions) || doc.functions.length > 2048 || doc.functions.some(id =>
    typeof id !== 'string' || id.length > 160 || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(id)) || new Set(doc.functions).size !== doc.functions.length)) {
    throw new Error('Functions must be null for the installed defaults, or a list of unique function IDs.')
  }
  if (typeof doc.requiresDirectUserAuthorization !== 'boolean') throw new Error('The action policy must be true or false.')
  return roleDraft(doc)
}

export function directionsPreview(role, draft) {
  const sections = ROLE_FIELDS.map(({ key, label }) => `## ${label}\n\n${draft.rules[key]}`)
  if (role?.rules?.length) sections.push(`## Inherited operating guidance\n\n${role.rules.map(rule => `- ${rule}`).join('\n')}`)
  return `# ${role?.name || draft.id || 'New role'}\n\n${sections.join('\n\n')}\n`
}

// Collapse actual declared reporting lines by role. A role can be used at
// multiple levels; never invent a role hierarchy from names or base inheritance.
export function roleConnections(org, roles) {
  const known = new Set(roles.map(role => role.id))
  const agents = new Map((org?.agents || []).map(agent => [agent.id, agent]))
  const connections = new Map()
  for (const relation of org?.relationships || []) {
    if (relation.type !== 'manages') continue
    const from = agents.get(relation.from)?.role
    const to = agents.get(relation.to)?.role
    if (!known.has(from) || !known.has(to)) continue
    const key = `${from}:${to}`
    const edge = connections.get(key) || { from, to, count: 0 }
    edge.count += 1
    connections.set(key, edge)
  }
  return [...connections.values()]
}

export function initialRolePositions(roles) {
  return Object.fromEntries(roles.map((role, index) => [role.id, {
    x: 40 + (index % 3) * 290, y: 40 + Math.floor(index / 3) * 190,
  }]))
}

export function functionExample(item) {
  const example = schema => {
    if (schema?.default !== undefined) return schema.default
    if (schema?.enum?.length) return schema.enum[0]
    if (schema?.type === 'boolean') return false
    if (schema?.type === 'integer' || schema?.type === 'number') return schema.minimum ?? 0
    if (schema?.type === 'array') return []
    if (schema?.type === 'object') return Object.fromEntries((schema.required || []).map(key => [key, example(schema.properties?.[key])]))
    return '<' + (schema?.description?.split('.')[0]?.slice(0, 70) || 'value') + '>'
  }
  return JSON.stringify({ name: item.id, arguments: example(item.inputSchema || { type: 'object' }) }, null, 2)
}
