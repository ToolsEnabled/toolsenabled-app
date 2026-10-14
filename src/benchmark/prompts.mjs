// Portable compiler. This exact source ships in exported benchmark projects.
// A template slot accepts an atom or another template; agent trees are unrelated.
import { COMPOSITION_LIMITS, renderComposition, compositionSemantics, compositionRequirements, slotAccepts, slotRoleText, validSlotRoles } from './composition.mjs'
export const COMPILER_VERSION = '1.3.0'
export const MAX_EXPANSIONS = COMPOSITION_LIMITS.nodes
export const MAX_PROMPT_LENGTH = COMPOSITION_LIMITS.text
/* PROMPT B. THIS FILE USED TO EXPORT FOUR ROLE NAMES.
   They were one worked example's vocabulary -- buy and sell, reason and
   process -- sitting in the general compiler as though they were its schema,
   and the owner's own material says "details" where they said "process", so
   their real bundles could not drop into a template this product shipped. A
   compiler that knows any role name knows one domain. Roles are now whatever a
   catalog's own bundles declare: any names, any number, the way labels already
   work. The Lean and operational examples declare their four beside the
   catalogs that use them. */
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const own = (object, key) => Object.hasOwn(object, key)
export function invariant(ok, message) { if (!ok) throw new Error(message) }
export function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    invariant(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Only finite JSON values can be frozen.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
}
export function reviewContent(bundle) {
  const { review, ...content } = bundle
  return bundle.kind === 'template' ? { ...content, slotOrder: bundle.slotOrder || Object.keys(bundle.slots || {}) } : content
}
export async function bundleHash(bundle) { return sha256(canonical(reviewContent(bundle))) }
// A review binds the complete dependency graph, not just the bundle's own text.
// Records are data supplied by a person; these hashes do not authenticate identity.
export async function catalogRoots(catalog) {
  catalog = structuredClone(catalog)
  const byId = catalogMap(catalog)
  const hashes = new Map(await Promise.all(catalog.map(async bundle => [bundle.id, await bundleHash(bundle)])))
  const roots = new Map(), active = new Set()
  const visit = async id => {
    if (roots.has(id)) return roots.get(id)
    invariant(byId.has(id), `Missing semantic dependency: ${id}.`)
    invariant(!active.has(id), `Cyclic semantic dependency: ${id}.`)
    active.add(id)
    const dependencies = []
    for (const dependency of [...(byId.get(id).dependencies || [])].sort()) {
      dependencies.push({ id: dependency, rootSha256: (await visit(dependency)).rootSha256 })
    }
    active.delete(id)
    const hash = hashes.get(id)
    const value = { hash, rootSha256: await sha256(canonical({ format: 'benchmark-bundle-root', version: 1, id, hash, dependencies })), dependencies }
    roots.set(id, value)
    return value
  }
  for (const id of byId.keys()) await visit(id)
  return roots
}
export async function createReviewRecord(catalog, bundleId, reviewer, { decision = 'approved', at = new Date().toISOString() } = {}) {
  invariant(typeof reviewer === 'string' && reviewer.trim(), 'Enter the name of the person reviewing this exact bundle.')
  invariant(['approved', 'rejected'].includes(decision) && typeof at === 'string' && Number.isFinite(Date.parse(at)), 'A review needs a decision and valid timestamp.')
  const binding = (await catalogRoots(catalog)).get(bundleId)
  invariant(binding, `No bundle to review: ${bundleId}.`)
  return { bundleId, reviewer: reviewer.trim(), decision, at, sha256: binding.hash, rootSha256: binding.rootSha256 }
}
// Kept for programmatic callers; authoring stores createReviewRecord results in
// spec.reviews, outside the immutable semantic bundle.
export async function approveBundle(bundle, reviewer, at = new Date().toISOString(), { catalog = [bundle] } = {}) {
  const review = await createReviewRecord(catalog, bundle.id, reviewer, { at })
  return { ...structuredClone(bundle), review }
}
function reviewed(bundle, binding, records) {
  const record = records.filter(row => row.bundleId === bundle.id).at(-1) || bundle.review
  const approved = typeof record?.reviewer === 'string' && !!record.reviewer.trim() && Number.isFinite(Date.parse(record.at)) && record.sha256 === binding.hash
    && record.decision !== 'rejected' && (record.rootSha256 === binding.rootSha256 || (!binding.dependencies.length && !record.rootSha256))
  return { ...binding, approved, ...(record ? { review: record } : {}) }
}
export async function reviewStatus(bundle, { catalog = [bundle], reviews = [] } = {}) {
  return reviewed(bundle, (await catalogRoots(catalog)).get(bundle.id), reviews)
}
export function catalogMap(catalog) {
  invariant(Array.isArray(catalog) && catalog.length && catalog.length <= 512, 'The catalog needs 1–512 bundles.')
  const byId = new Map()
  for (const bundle of catalog) {
    invariant(object(bundle) && ID.test(bundle.id), 'Each bundle needs a unique lowercase identifier.')
    invariant(!byId.has(bundle.id), `Duplicate bundle: ${bundle.id}.`)
    invariant(typeof bundle.version === 'string' && bundle.version.trim(), `Give ${bundle.id} a version.`)
    invariant(['atom', 'template'].includes(bundle.kind), `${bundle.id}: kind must be atom or template.`)
    invariant(typeof bundle.text === 'string' && bundle.text.trim() && bundle.text.length <= 100000, `${bundle.id} needs prompt wording, at most 100,000 characters.`)
    invariant(!bundle.parameters || object(bundle.parameters), `${bundle.id}: parameters must be an object.`)
    invariant(!bundle.dependencies || (Array.isArray(bundle.dependencies) && bundle.dependencies.every(id => ID.test(id)) && new Set(bundle.dependencies).size === bundle.dependencies.length), `${bundle.id}: dependencies must be distinct bundle identifiers.`)
    if (bundle.parameterSchema !== undefined) {
      invariant(object(bundle.parameterSchema), `${bundle.id}: parameterSchema must be an object.`)
      for (const [name, rule] of Object.entries(bundle.parameterSchema)) {
        invariant(/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) && object(rule) && ['string', 'number', 'integer', 'boolean'].includes(rule.type), `${bundle.id}: invalid parameter schema for ${name}.`)
        invariant(Object.keys(rule).every(key => ['type', 'required', 'enum', 'minimum', 'maximum'].includes(key)), `${bundle.id}: unsupported parameter constraint for ${name}.`)
        invariant(rule.required === undefined || typeof rule.required === 'boolean', `${bundle.id}: ${name} required must be boolean.`)
        invariant(rule.enum === undefined || (Array.isArray(rule.enum) && rule.enum.length && rule.enum.every(value => ['string', 'number', 'boolean'].includes(typeof value))), `${bundle.id}: ${name} needs a nonempty scalar enum.`)
        if (rule.enum) invariant(rule.enum.every(value => rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type && (rule.type !== 'number' || Number.isFinite(value))), `${bundle.id}: ${name} enum values must match the declared type.`)
        for (const key of ['minimum', 'maximum']) invariant(rule[key] === undefined || Number.isFinite(rule[key]), `${bundle.id}: invalid ${name} ${key}.`)
        invariant((rule.minimum === undefined && rule.maximum === undefined) || ['number', 'integer'].includes(rule.type), `${bundle.id}: numeric bounds require a numeric parameter.`)
        invariant(rule.minimum === undefined || rule.maximum === undefined || rule.minimum <= rule.maximum, `${bundle.id}: ${name} minimum exceeds maximum.`)
      }
    }
    invariant(!bundle.slots || object(bundle.slots), `${bundle.id}: slots must be an object.`)
    if (bundle.slotOrder) invariant(Array.isArray(bundle.slotOrder) && new Set(bundle.slotOrder).size === bundle.slotOrder.length && bundle.slotOrder.length === Object.keys(bundle.slots || {}).length && bundle.slotOrder.every(name => own(bundle.slots || {}, name)), `${bundle.id}: slot order must name each slot exactly once.`)
    invariant(bundle.kind !== 'atom' || !Object.keys(bundle.slots || {}).length, `${bundle.id}: atoms cannot declare slots.`)
    for (const [name, role] of Object.entries(bundle.slots || {})) {
      invariant(ID.test(name) && validSlotRoles(role), `${bundle.id}: invalid slot ${name}.`)
      invariant(bundle.text.includes(`{{slot:${name}}}`), `${bundle.id}: the prompt omits slot ${name}.`)
    }
    byId.set(bundle.id, bundle)
  }
  return byId
}
function substitute(value, params, label) {
  if (typeof value === 'string') {
    const exact = /^\{\{([a-z][a-zA-Z0-9_-]*)\}\}$/.exec(value)
    if (exact) {
      invariant(own(params, exact[1]), `${label}: missing parameter ${exact[1]}.`)
      return params[exact[1]]
    }
    return value.replace(/\{\{([a-z][a-zA-Z0-9_-]*)\}\}/g, (_, name) => {
      invariant(own(params, name), `${label}: missing parameter ${name}.`)
      return String(params[name])
    })
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, params, label))
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, params, label)]))
  return value
}

export async function compilePrompt(catalog, root, { requireReview = false, variables = {}, reviews: records = [], withheldPaths = [], omissions, rootRole = 'node' } = {}) {
  invariant(object(variables), 'Task variables must be an object.')
  invariant(Array.isArray(withheldPaths) && new Set(withheldPaths).size === withheldPaths.length, 'Withheld atom paths must be a distinct list.')
  const withheld = new Set(withheldPaths)
  const byId = catalogMap(catalog)
  invariant(Array.isArray(records) && records.every(record => object(record) && ID.test(record.bundleId)), 'Review records must name bundle identifiers.')
  const roots = await catalogRoots(catalog)
  const reviews = new Map(catalog.map(bundle => [bundle.id, reviewed(bundle, roots.get(bundle.id), records)]))
  const nodes = [], used = new Set(), active = new Set()
  // Explicit stack avoids making JavaScript's call stack a semantic depth limit.
  const stack = [{ ref: root, path: 'root', role: rootRole, parent: null, key: null, exit: false }]
  while (stack.length) {
    const frame = stack.pop()
    if (frame.exit) {
      const node = frame.node
      let cursor = 0
      const fragments = []
      const append = value => {
        if (fragments.at(-1)?.kind === 'text') fragments.at(-1).value += value
        else fragments.push({ kind: 'text', value })
      }
      for (const match of node.bundle.text.matchAll(/\{\{(slot:)?([a-z][a-zA-Z0-9_-]*)\}\}/g)) {
        const [, slot, name] = match
        append(node.bundle.text.slice(cursor, match.index))
        if (slot) {
          invariant(own(node.children, name), node.path + ': unknown slot ' + name + '.')
          fragments.push({ kind: 'slot', name })
        } else {
          invariant(own(node.params, name), node.path + ': missing parameter ' + name + '.')
          append(String(node.params[name]))
        }
        cursor = match.index + match[0].length
      }
      append(node.bundle.text.slice(cursor))
      node.fragments = fragments
      const semantics = substitute(node.bundle.semantics || { kind: 'prompt' }, node.params, node.path)
      invariant(object(semantics), node.path + ': local semantics must be an object.')
      node.semantic = Object.fromEntries(Object.entries(semantics).filter(([key]) => !['path', 'children', 'childOrder'].includes(key)))
      active.delete(frame.ref)
      continue
    }
    const { ref, path, role } = frame
    invariant(object(ref) && typeof ref.use === 'string', `${path}: choose a bundle.`)
    invariant(!active.has(ref), `${path}: cyclic prompt structure.`)
    invariant(nodes.length < MAX_EXPANSIONS, `This composition exceeds the ${MAX_EXPANSIONS}-node resource budget.`)
    const bundle = byId.get(ref.use)
    invariant(bundle, `${path}: missing bundle ${ref.use}.`)
    invariant(!withheld.has(path) || bundle.kind === 'atom', `${path}: withholding applies to atomic requirements, not a whole template or execution constitution.`)
    invariant(slotAccepts(role, bundle.role || 'node'), `${path}: ${bundle.id} has role ${bundle.role || 'node'}, and this place accepts ${slotRoleText(role)}.`)
    invariant(!requireReview || reviews.get(bundle.id).approved, `${bundle.id} needs review of its current wording, semantics, code and tests.`)
    const dependencies = [...(bundle.dependencies || [])]
    while (dependencies.length) {
      const id = dependencies.pop()
      invariant(!requireReview || reviews.get(id).approved, `${id} needs review as a dependency of ${bundle.id}.`)
      if (!used.has(id)) { used.add(id); dependencies.push(...(byId.get(id).dependencies || [])) }
    }
    invariant(ref.params === undefined || object(ref.params), `${path}: parameters must be an object.`)
    invariant(ref.variables === undefined || object(ref.variables), `${path}: local variables must be an object.`)
    const localVariables = { ...(frame.variables || variables), ...(ref.variables || {}) }
    const params = { ...(bundle.parameters || {}), ...localVariables, ...(ref.params || {}) }
    invariant(Object.values(params).every(value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))), `${path}: parameters must be finite scalar values.`)
    if (bundle.parameterSchema) {
      invariant(Object.keys(ref.params || {}).every(name => own(bundle.parameterSchema, name)), `${path}: an undeclared parameter was supplied.`)
      for (const [name, rule] of Object.entries(bundle.parameterSchema)) {
        const value = params[name]
        invariant(value !== undefined || rule.required === false, `${path}: missing parameter ${name}.`)
        if (value === undefined) continue
        invariant(rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type, `${path}: ${name} must be ${rule.type}.`)
        invariant(rule.minimum === undefined || value >= rule.minimum, `${path}: ${name} is below its minimum.`)
        invariant(rule.maximum === undefined || value <= rule.maximum, `${path}: ${name} is above its maximum.`)
        invariant(rule.enum === undefined || rule.enum.some(allowed => canonical(value) === canonical(allowed)), `${path}: ${name} is outside its allowed values.`)
      }
    }
    const slots = bundle.slots || {}
    invariant(!ref.slots || object(ref.slots), `${path}: slots must be an object.`)
    invariant(Object.keys(ref.slots || {}).every(key => own(slots, key)), `${path}: an undeclared slot was supplied.`)
    const layers = value => value === undefined ? [] : Array.isArray(value) ? value : [value]
    const omissions = [...layers(bundle.promptOmissions), ...layers(ref.promptOmissions)]
    const node = { path, parentPath: frame.parent?.path || null, slot: frame.key, bundle, params, children: {}, omissions }
    if (frame.parent) frame.parent.children[frame.key] = node
    nodes.push(node); used.add(bundle.id); active.add(ref)
    stack.push({ ...frame, node, exit: true })
    for (const name of [...(bundle.slotOrder || Object.keys(slots))].reverse()) {
      const childRole = slots[name]
      invariant(own(ref.slots || {}, name), `${path}: fill the ${name} slot.`)
      stack.push({ ref: ref.slots[name], path: `${path}/${name}`, role: childRole, parent: node, key: name, exit: false, variables: localVariables })
    }
  }
  for (const path of withheld) invariant(nodes.some(node => node.path === path), 'Unknown withheld atom path: ' + path + '.')
  const composition = JSON.parse(canonical({ format: 'benchmark-composition-ir', version: 1, rootPath: 'root', appendices: [], nodes: nodes.map(node => ({
    path: node.path, parentPath: node.parentPath, slot: node.slot, kind: node.bundle.kind, role: node.bundle.role || 'node',
    bundle: { id: node.bundle.id, version: node.bundle.version, sha256: reviews.get(node.bundle.id).hash, rootSha256: roots.get(node.bundle.id).rootSha256 },
    parameters: { ...node.params }, semantic: node.semantic,
    ports: (node.bundle.slotOrder || Object.keys(node.bundle.slots || {})).map(name => ({ name, role: node.bundle.slots[name], path: node.path + '/' + name })),
    fragments: node.fragments, disclosed: !withheld.has(node.path),
    ...(node.omissions.length ? { omissions: node.omissions } : {}),
    requirement: String(substitute(node.bundle.requirement || node.bundle.text.replace(/\{\{slot:[^}]+\}\}/g, '[child requirements]'), node.params, node.path)),
  })) }))
  const bindings = []
  let rendered = renderComposition(composition, { onOmissionSource: (text, omission, path) => bindings.push({ text, omission, path }) })
  for (const binding of bindings) invariant(binding.omission.sourceSha256 === await sha256(binding.text), `${binding.path}: the source of this reusable variant changed. Reopen Variance and select its omissions again.`)
  if (omissions !== undefined) {
    invariant(object(omissions) && omissions.sourceSha256 === await sha256(rendered.text), 'The original prompt changed after its omissions were selected. Reopen Variance and select the sections again.')
    composition.omissions = JSON.parse(canonical(omissions))
    rendered = renderComposition(composition)
  }
  return { ...rendered, composition, semantic: compositionSemantics(composition), checklist: compositionRequirements(composition),
    bundles: [...used].sort().map(id => ({ id, ...reviews.get(id) })),
    promptSha256: await sha256(rendered.text), compilerVersion: COMPILER_VERSION }

}

export function combinations(choices, limit = 512) {
  invariant(object(choices), 'Variant choices must be an object.')
  let rows = [{}]
  for (const [name, values] of Object.entries(choices)) {
    invariant(Array.isArray(values) && values.length && new Set(values.map(canonical)).size === values.length, `${name}: choose distinct values.`)
    invariant(rows.length * values.length <= limit, `The combination exceeds ${limit} tasks. Narrow the selected values.`)
    rows = rows.flatMap(row => values.map(value => ({ ...row, [name]: value })))
  }
  return rows
}
