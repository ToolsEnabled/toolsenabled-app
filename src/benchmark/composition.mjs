// Portable normalized composition. Fragments are typed: parameter values
// remain literal text even when they contain characters that resemble slots.
import { canonical, invariant, object } from './prompts.mjs'

export const COMPOSITION_VERSION = 1
export const COMPOSITION_LIMITS = Object.freeze({ nodes: 4096, text: 2 * 1024 * 1024, paths: 8 * 1024 * 1024, occurrences: 4096 * 16 })
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/
const own = (value, key) => Object.hasOwn(value, key)
const fields = (value, names, label) => invariant(object(value) && Object.keys(value).every(key => names.includes(key)), label + ' has unsupported fields.')
const jsonCopy = value => JSON.parse(canonical(value))

/* PROMPT B. WHAT A PLACE ACCEPTS, AND THERE IS NO LIST OF ROLES ANYWHERE.
   A slot names one role, several, or '*' for anything. Several is the ordinary
   case -- a template that may hold a leaf or another template -- and it exists
   because the alternative was '*', which accepts everything including what it
   should not. Roles themselves are whatever the catalog's own bundles declare;
   nothing in this product carries a set of them. */
export const slotRoles = declared => (Array.isArray(declared) ? declared : [declared])
export const slotAccepts = (declared, role) => slotRoles(declared).some(item => item === '*' || item === role)
export const slotRoleText = declared => slotRoles(declared).map(String).join(' or ')
export const validSlotRoles = declared => {
  const accepted = slotRoles(declared)
  return accepted.length > 0 && accepted.every(item => typeof item === 'string' && item.length > 0)
    && new Set(accepted).size === accepted.length
}

export function validateComposition(ir) {
  fields(ir, ['format', 'version', 'rootPath', 'nodes', 'appendices', 'omissions'], 'Composition')
  invariant(ir.format === 'benchmark-composition-ir' && ir.version === COMPOSITION_VERSION && ir.rootPath === 'root', 'Unknown composition representation.')
  invariant(Array.isArray(ir.nodes) && ir.nodes.length > 0 && ir.nodes.length <= COMPOSITION_LIMITS.nodes, 'Composition exceeds its node budget.')
  const nodes = new Map()
  let pathSize = 0, literalSize = 0
  invariant(Array.isArray(ir.appendices) && ir.appendices.length <= 64 && new Set(ir.appendices.map(row => row.id)).size === ir.appendices.length, 'Composition appendices must have distinct bounded identities.')
  for (const appendix of ir.appendices) {
    fields(appendix, ['id', 'text', 'source', 'sha256'], 'Composition appendix')
    invariant(ID.test(appendix.id) && typeof appendix.text === 'string' && /^[a-z0-9_-]+\.mjs$/.test(appendix.source)
      && (appendix.sha256 === null || HASH.test(appendix.sha256)), 'An appendix needs its exact text and source binding.')
    literalSize += appendix.text.length
  }
  invariant(literalSize <= COMPOSITION_LIMITS.text, 'Composition appendices exceed the text budget.')
  for (const node of ir.nodes) {
    fields(node, ['path', 'parentPath', 'slot', 'kind', 'role', 'bundle', 'parameters', 'semantic', 'ports', 'fragments', 'disclosed', 'requirement', 'omissions'], 'Composition node')
    invariant(typeof node.path === 'string' && !nodes.has(node.path), 'Composition paths must be unique.')
    pathSize += node.path.length
    invariant(pathSize <= COMPOSITION_LIMITS.paths, 'Composition exceeds its path budget.')
    invariant(node.path === 'root' ? node.parentPath === null && node.slot === null
      : typeof node.parentPath === 'string' && ID.test(node.slot) && node.path === node.parentPath + '/' + node.slot, 'A composition path differs from its parent and slot.')
    invariant(['atom', 'template'].includes(node.kind) && typeof node.role === 'string' && node.role, 'Composition nodes need their declared kind and role.')
    fields(node.bundle, ['id', 'version', 'sha256', 'rootSha256'], 'Composition bundle binding')
    invariant(ID.test(node.bundle.id) && typeof node.bundle.version === 'string' && node.bundle.version.trim() && HASH.test(node.bundle.sha256) && HASH.test(node.bundle.rootSha256), 'Composition bundle bindings are incomplete.')
    invariant(object(node.parameters) && Object.values(node.parameters).every(value => ['string', 'number', 'boolean'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))), 'Composition parameters must be finite scalars.')
    invariant(object(node.semantic) && !['path', 'children', 'childOrder'].some(key => own(node.semantic, key)), 'Local semantics cannot overwrite structural fields.')
    invariant(Array.isArray(node.ports) && new Set(node.ports.map(port => port.name)).size === node.ports.length && (node.kind !== 'atom' || node.ports.length === 0), 'Composition ports are invalid.')
    for (const port of node.ports) {
      fields(port, ['name', 'role', 'path'], 'Composition port')
      invariant(ID.test(port.name) && validSlotRoles(port.role) && port.path === node.path + '/' + port.name, 'A composition port has an invalid name, role or target.')
    }
    invariant(typeof node.disclosed === 'boolean' && (node.disclosed || node.kind === 'atom') && typeof node.requirement === 'string', 'Only atoms can be withheld; every node needs its requirement.')
    invariant(Array.isArray(node.fragments) && node.fragments.length > 0, 'Composition prose needs typed fragments.')
    const used = new Set()
    for (const fragment of node.fragments) {
      invariant(object(fragment) && ['text', 'slot'].includes(fragment.kind), 'Unknown composition prose fragment.')
      if (fragment.kind === 'text') {
        fields(fragment, ['kind', 'value'], 'Text fragment')
        invariant(typeof fragment.value === 'string', 'A text fragment must be a string.')
        literalSize += fragment.value.length
        invariant(literalSize <= COMPOSITION_LIMITS.text, 'Composition literals exceed the text budget.')
      } else {
        fields(fragment, ['kind', 'name'], 'Slot fragment')
        invariant(node.ports.some(port => port.name === fragment.name), 'A prose slot has no declared port.')
        used.add(fragment.name)
      }
    }
    invariant(node.ports.every(port => used.has(port.name)), 'Composition prose omits a declared port.')
    nodes.set(node.path, node)
  }
  invariant(nodes.has('root'), 'Composition omitted its root.')
  const stack = [{ path: 'root', depth: 0 }], visited = new Set(), order = []
  let depth = 0
  while (stack.length) {
    const next = stack.pop(), node = nodes.get(next.path)
    invariant(node && !visited.has(next.path), 'Composition has a cycle, shared child or missing target.')
    visited.add(next.path); order.push(next.path); depth = Math.max(depth, next.depth)
    for (const port of [...node.ports].reverse()) {
      const child = nodes.get(port.path)
      invariant(child && child.parentPath === node.path && child.slot === port.name && slotAccepts(port.role, child.role), 'Composition child ownership or role differs from its port.')
      stack.push({ path: port.path, depth: next.depth + 1 })
    }
  }
  invariant(canonical(order) === canonical(ir.nodes.map(node => node.path)), 'Composition nodes must be reachable exactly once in declared preorder.')
  const validateOmissions = (omissions, prefix = 'root') => {
    fields(omissions, ['version', 'sourceSha256', 'ranges'], 'Prompt omissions')
    invariant(omissions.version === 1 && HASH.test(omissions.sourceSha256), 'Prompt omissions need the original prompt fingerprint.')
    invariant(Array.isArray(omissions.ranges) && omissions.ranges.length > 0 && omissions.ranges.length <= 128, 'Select 1–128 prompt sections to omit.')
    let size = 0
    for (const range of omissions.ranges) {
      fields(range, ['start', 'end', 'text', 'path', 'label'], 'Omitted section')
      invariant(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end > range.start
        && typeof range.text === 'string' && range.text.length === range.end - range.start && typeof range.path === 'string' && /^root(?:\/|$)/.test(range.path) && nodes.has(prefix + range.path.slice(4))
        && typeof range.label === 'string' && range.label.trim() && range.label.length <= 120, 'An omitted section needs its exact text, occurrence, label, and character range.')
      size += range.text.length
    }
    invariant(size <= COMPOSITION_LIMITS.text * 4, 'Selected omission text exceeds the retained-text budget.')
  }
  if (ir.omissions !== undefined) validateOmissions(ir.omissions)
  for (const node of ir.nodes) if (node.omissions !== undefined) {
    invariant(Array.isArray(node.omissions) && node.omissions.length > 0 && node.omissions.length <= 16, 'A reusable variant supports up to 16 successive omission layers.')
    for (const omissions of node.omissions) validateOmissions(omissions, node.path)
  }
  canonical(ir)
  return { nodes, depth }
}

export function compositionSemantics(ir) {
  validateComposition(ir)
  const lowered = new Map()
  for (const node of [...ir.nodes].reverse()) {
    lowered.set(node.path, { ...jsonCopy(node.semantic), path: node.path, childOrder: node.ports.map(port => port.name),
      children: Object.fromEntries(node.ports.map(port => [port.name, lowered.get(port.path)])) })
  }
  return lowered.get(ir.rootPath)
}

export function compositionRequirements(ir) {
  validateComposition(ir)
  const ranges = ir.omissions || ir.nodes.some(node => node.omissions) ? renderComposition(ir).sourceMap : []
  const disclosure = node => {
    const occurrences = ranges.filter(range => range.path === node.path)
    const omittedCharacters = occurrences.reduce((sum, range) => sum + (range.omittedCharacters || 0), 0)
    if (!omittedCharacters) return { disclosed: node.disclosed }
    const disclosed = node.disclosed && occurrences.some(range => range.end > range.start)
    return { disclosed, disclosure: disclosed ? 'partial' : 'withheld', omittedCharacters }
  }
  return [...ir.nodes.map(node => ({ path: node.path, bundleId: node.bundle.id, version: node.bundle.version, ...disclosure(node),
    requirementId: node.path + '#' + node.bundle.id, sha256: node.bundle.sha256, rootSha256: node.bundle.rootSha256, role: node.role, requirement: node.requirement })),
  ...ir.appendices.map(row => ({ requirementId: 'runtime#' + row.id, path: 'runtime', bundleId: null, source: row.source,
    sha256: row.sha256, role: 'execution-contract', disclosed: true, requirement: row.text }))]
}

export function renderComposition(ir, { onOmissionSource = () => {} } = {}) {
  const { depth } = validateComposition(ir), lowered = new Map()
  const removedBefore = (at, ranges) => ranges.reduce((sum, range) => sum + Math.max(0, Math.min(at, range.end) - range.start), 0)
  const omit = (text, omissions, path) => {
    onOmissionSource(text, omissions, path)
    const ranges = []
    for (const range of [...omissions.ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
      invariant(range.end <= text.length && text.slice(range.start, range.end) === range.text, 'An omitted section no longer matches the original prompt. Select it again.')
      const previous = ranges.at(-1)
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
      else ranges.push({ start: range.start, end: range.end })
    }
    let cursor = 0, result = ''
    for (const range of ranges) { result += text.slice(cursor, range.start); cursor = range.end }
    return { text: result + text.slice(cursor), ranges }
  }
  for (const node of [...ir.nodes].reverse()) {
    let text = '', originalLength = 0
    const placements = []
    for (const fragment of node.fragments) {
      if (fragment.kind === 'text') { text += fragment.value; originalLength += fragment.value.length }
      else {
        const path = node.path + '/' + fragment.name
        placements.push({ path, offset: text.length }); text += lowered.get(path).text
        originalLength += lowered.get(path).originalLength
      }
      invariant(text.length <= COMPOSITION_LIMITS.text, 'The composed prompt exceeds its text budget.')
    }
    const projections = []
    for (const omissions of node.omissions || []) {
      const result = omit(text, omissions, node.path); text = result.text; projections.push(result.ranges)
    }
    lowered.set(node.path, { text: node.disclosed ? text : '', originalLength: node.disclosed ? originalLength : 0, placements, projections })
  }
  let text = lowered.get(ir.rootPath).text
  const outer = ir.omissions ? omit(text, ir.omissions, 'root') : { text, ranges: [] }
  text = outer.text
  const project = (at, transforms) => {
    for (const transform of transforms) { at += transform.offset; at -= removedBefore(at, transform.ranges) }
    return at
  }
  const sourceMap = [], occurrences = [{ path: ir.rootPath, transforms: [{ offset: 0, ranges: outer.ranges }] }], nodes = new Map(ir.nodes.map(node => [node.path, node]))
  while (occurrences.length) {
    invariant(sourceMap.length < COMPOSITION_LIMITS.occurrences, 'Repeated slots exceed the source-map budget.')
    const { path, transforms } = occurrences.pop(), node = nodes.get(path), rendered = lowered.get(path)
    const start = project(0, transforms), end = project(rendered.text.length, transforms), omittedCharacters = rendered.originalLength - (end - start)
    sourceMap.push({ path, start, end, requirementId: path + '#' + node.bundle.id, bundleId: node.bundle.id, ...(omittedCharacters > 0 ? { omittedCharacters } : {}) })
    invariant(sourceMap.length + occurrences.length + rendered.placements.length <= COMPOSITION_LIMITS.occurrences, 'Repeated slots exceed the source-map budget.')
    for (const placement of [...rendered.placements].reverse()) occurrences.push({ path: placement.path, transforms: [
      { offset: placement.offset, ranges: rendered.projections[0] || [] },
      ...rendered.projections.slice(1).map(ranges => ({ offset: 0, ranges })), ...transforms,
    ] })
  }
  for (const appendix of ir.appendices) {
    const start = text.length
    text += appendix.text
    invariant(text.length <= COMPOSITION_LIMITS.text, 'The composed prompt exceeds its text budget.')
    sourceMap.push({ path: 'runtime', requirementId: 'runtime#' + appendix.id, bundleId: null, start, end: text.length })
  }
  return { text, sourceMap, sourceMapUnit: 'UTF-16 code units', nodeCount: ir.nodes.length, depth }
}

// Both browser export and standalone verification regenerate these artifacts
// from the same frozen representation, including every admissible reading.
export function compositionProjectFiles(project) {
  const files = {}
  for (const task of project.tasks) for (const variant of [{ id: null, compiled: task.compiled }, ...(task.interpretations || [])]) {
    const compiled = variant.compiled, ir = compiled.composition, rendered = renderComposition(ir), checklist = compositionRequirements(ir)
    invariant(canonical(rendered) === canonical(Object.fromEntries(Object.keys(rendered).map(key => [key, compiled[key]])))
      && canonical(checklist) === canonical(compiled.checklist) && canonical(compositionSemantics(ir)) === canonical(compiled.semantic), 'A compiled consumer differs from its frozen composition.')
    const suffix = task.id + (variant.id ? '/readings/' + variant.id : '')
    files['composition/' + suffix + '.json'] = JSON.stringify(ir, null, 2) + '\n'
    files['prompts/' + suffix + '.txt'] = rendered.text + '\n'
    files['checklists/' + suffix + '.json'] = JSON.stringify(checklist, null, 2) + '\n'
    files['source-maps/' + suffix + '.json'] = JSON.stringify({ unit: rendered.sourceMapUnit, promptSha256: compiled.promptSha256, ranges: rendered.sourceMap }, null, 2) + '\n'
  }
  return files
}
