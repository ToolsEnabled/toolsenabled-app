import { canonical, invariant, object } from './benchmark/prompts.mjs'
import { slotAccepts, slotRoles, validSlotRoles } from './benchmark/composition.mjs'

const own = (value, key) => Object.hasOwn(value, key)
const copy = value => JSON.parse(canonical(value))
const ID = /^[a-z][a-z0-9_-]{0,63}$/

// Retain the existing authoring defaults, including unresolved choices. This
// constructs a draft; the canonical compiler still decides whether it is valid.
export function createDefaultNode(catalog, bundleId) {
  invariant(Array.isArray(catalog), 'Node construction needs a bundle catalog.')
  const build = (bundle, seen) => {
    if (!bundle || seen.has(bundle.id)) return { use: '' }
    const next = new Set([...seen, bundle.id])
    return { use: bundle.id, ...(bundle.parameters ? { params: copy(bundle.parameters) } : {}),
      ...(bundle.slots ? { slots: Object.fromEntries(Object.entries(bundle.slots).map(([name, role]) => {
        /* PROMPT B. An atom this place accepts, or else a template it accepts
           that is itself made of named parts. The second clause used to be
           written as a list of four role names; it is now the shape those four
           names described, so a catalog that names its parts anything at all
           gets the same default. */
        const accepts = item => slotAccepts(role, item.role || 'node')
        const madeOfNamedParts = item => Object.values(item.slots || {}).length > 0
          && Object.values(item.slots).every(child => slotRoles(child).every(part => part !== 'node' && part !== '*'))
        const candidate = catalog.find(item => item.kind === 'atom' && accepts(item))
          || catalog.find(item => item.kind === 'template' && accepts(item) && madeOfNamedParts(item))
        return [name, build(candidate, next)]
      })) } : {}) }
  }
  return build(catalog.find(bundle => bundle.id === bundleId), new Set())
}

function assertNodeShape(node) {
  const pending = [node], seen = new Set()
  while (pending.length) {
    const next = pending.pop()
    invariant(object(next) && typeof next.use === 'string', 'Retained children must be node references; use an explicit unfilled choice when needed.')
    invariant(next.params === undefined || object(next.params), 'Retained node parameters must be an object.')
    invariant(next.slots === undefined || object(next.slots), 'Retained node slots must be an object.')
    // Shared input objects are allowed. The canonical copy below expands them
    // into independently owned occurrences and rejects non-JSON/cyclic data.
    if (seen.has(next)) continue
    seen.add(next); pending.push(...Object.values(next.slots || {}))
  }
}

function declaredSlots(bundle) {
  invariant(bundle.slots === undefined || object(bundle.slots), 'Bundle child declarations must be an object.')
  const slots = bundle.slots || {}
  invariant(Object.values(slots).every(validSlotRoles), 'Bundle child roles must be nonempty role names.')
  invariant(bundle.kind !== 'atom' || !Object.keys(slots).length, 'An atom cannot declare children.')
  return slots
}

// A Bundle field chooses the node being edited. Retaining its child connections
// is the default; discarding a whole branch requires an explicit separate mode.
export function replaceNodeBundle(catalog, node, bundleId, options = {}) {
  invariant(object(options) && Object.keys(options).every(key => ['role', 'mode'].includes(key)), 'Unsupported node replacement options.')
  const { role = 'node', mode = 'preserve' } = options
  invariant(validSlotRoles(role), 'Choose a valid incoming node role.')
  invariant(['preserve', 'replace'].includes(mode), 'Choose preserve or explicit whole-branch replace mode.')
  invariant(Array.isArray(catalog), 'Node replacement needs a bundle catalog.')
  invariant(typeof bundleId === 'string' && ID.test(bundleId), 'Choose an existing replacement bundle with a valid identifier.')
  const targets = catalog.filter(bundle => object(bundle) && bundle.id === bundleId)
  invariant(targets.length === 1, 'Choose one existing replacement bundle with a unique identifier.')
  const target = targets[0]
  invariant(['atom', 'template'].includes(target.kind), 'The replacement bundle needs an atom or template kind.')
  const targetRole = target.role === undefined ? 'node' : target.role
  invariant(typeof targetRole === 'string' && targetRole.length && slotAccepts(role, targetRole), 'The replacement bundle is incompatible with this incoming role.')
  invariant(target.parameters === undefined || object(target.parameters), 'Replacement bundle parameters must be an object.')
  const slots = declaredSlots(target)
  if (mode === 'replace') return createDefaultNode(catalog, bundleId)

  assertNodeShape(node)
  const previous = catalog.filter(bundle => object(bundle) && bundle.id === node.use)
  const children = node.slots || {}, names = Object.keys(children)
  invariant(previous.length <= 1, 'The current bundle identifier is ambiguous; restore its catalog before retaining children.')
  invariant(!names.length || previous.length === 1, 'The current bundle is unknown; retaining its children requires its original slot declarations.')
  const oldSlots = previous.length ? declaredSlots(previous[0]) : {}
  for (const name of names) {
    invariant(own(oldSlots, name), 'The existing child ' + name + ' has no declared source role; its data was preserved without applying the edit.')
    invariant(own(slots, name) && canonical(slots[name]) === canonical(oldSlots[name]), 'This bundle would remove or change the role of child ' + name + '. Choose explicit whole-branch replacement to discard it.')
  }
  const next = copy(node)
  if (node.use === bundleId) return next
  next.use = bundleId
  delete next.params; delete next.slots
  if (target.parameters !== undefined) next.params = copy(target.parameters)
  if (target.slots !== undefined) next.slots = Object.fromEntries(Object.keys(slots).map(name => [name, own(children, name) ? copy(children[name]) : { use: '' }]))
  return next
}
