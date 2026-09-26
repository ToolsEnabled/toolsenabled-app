import { canonical, invariant, sha256 } from './benchmark/prompts.mjs'
import { createRoutingDraft, expandComposition } from './research-routing.mjs'
import { compositionGenerationBinding, compositionGenerationSpace } from './research-composition-generator.mjs'

// The arrangements offered. 'custom' (no intro line, only the shared text) is
// still accepted from older drafts and saved nestings; Together with shared
// instructions says the same thing, so it is no longer offered.
export const NESTING_MODES = Object.freeze([
  ['together', 'Together'], ['sequence', 'In sequence'],
  ['conditional-all', 'Each matching condition'], ['conditional-first', 'First matching condition'],
])
export const NESTING_MODE_IDS = Object.freeze([...NESTING_MODES.map(([id]) => id), 'custom'])
/* A nesting takes SETS. Each member is a saved set (or every composition),
   taken whole or picked from; the nested set is the product of the members,
   sampled like a composition run. The single-nesting functions below (build,
   reopen, outline) stay for saved v1 nestings and the tests that pin them. */
export const ALL_SET = '*'
export const NESTING_RUN_LIMIT = 10000
export const emptyNestingForm = () => ({ name: '', editing: '', mode: 'together', instructions: '', members: [], method: 'sample', count: '100', seed: '42', snippets: false, fallback: false })
export const emptyNestingMember = () => ({ set: ALL_SET, pick: 'all', selected: [], condition: '' })
// A member may also be a snippet category: its set is written 'snippet:<category>'.
export const SNIPPET_PREFIX = 'snippet:'
export const isSnippetMember = member => typeof member?.set === 'string' && member.set.startsWith(SNIPPET_PREFIX)
export const snippetCategoryOf = member => (isSnippetMember(member) ? member.set.slice(SNIPPET_PREFIX.length) : '')
const categoriesOf = bundle => { const list = (bundle.labels || []).map(text).filter(Boolean); return list.length ? [...new Set(list)] : ['Unlabelled'] }
export function snippetCategories(catalog) {
  const categories = new Map()
  for (const bundle of catalog || []) {
    if (bundle.kind !== 'atom') continue
    for (const category of categoriesOf(bundle)) { if (!categories.has(category)) categories.set(category, []); categories.get(category).push(bundle.id) }
  }
  return [...categories].map(([name, members]) => ({ name, members }))
}
// A composition's family, for grouping: the donor family of the first snippet
// reached walking its tree (through nested compositions), or none.
export function compositionFamily(name, draft, catalog, seen = new Set()) {
  const composition = (draft?.compositions || []).find(item => item.name === name)
  if (!composition || seen.has(name)) return ''
  seen.add(name)
  const walk = node => {
    if (!node) return ''
    if (node.composition) return compositionFamily(node.composition, draft, catalog, seen)
    const bundle = (catalog || []).find(item => item.id === node.use)
    if (bundle?.kind === 'atom') return text(bundle.donor?.family)
    for (const child of Object.values(node.slots || {})) { const family = walk(child); if (family) return family }
    return ''
  }
  return walk(composition.node)
}
// Every snippet a composition uses, walking its tree through nested
// compositions. Variance uses it to say which compositions take a change.
export function compositionSnippets(name, draft, catalog, seen = new Set()) {
  const composition = (draft?.compositions || []).find(item => item.name === name)
  if (!composition || seen.has(name)) return []
  seen.add(name)
  const ids = new Set()
  const walk = node => {
    if (!node) return
    if (node.composition) { for (const id of compositionSnippets(node.composition, draft, catalog, seen)) ids.add(id); return }
    const bundle = (catalog || []).find(item => item.id === node.use)
    if (bundle?.kind === 'atom') ids.add(bundle.id)
    for (const child of Object.values(node.slots || {})) walk(child)
  }
  walk(composition.node)
  return [...ids]
}
// The last member of a first-match nesting may be the fallback: it applies when
// no condition matched, and needs no condition of its own.
export const hasFallback = form => form?.mode === 'conditional-first' && !!form.fallback
const text = value => String(value ?? '').trim()
export const conditionalNesting = mode => mode === 'conditional-all' || mode === 'conditional-first'
const INTRODUCTION = {
  together: 'Carry out all of the following members as one task.',
  sequence: 'Carry out the following members in the stated order. Complete each member before proceeding to the next.',
  'conditional-all': 'Apply each member only when its stated condition holds. More than one member may apply. If none match, apply none of these members.',
  'conditional-first': 'Consider these conditions in order. Apply only the first matching member. If none match, apply none of these members.',
  'conditional-first-fallback': 'Consider these conditions in order. Apply only the first matching member. If none match, apply the last member.',
  custom: '',
}

// Every generated wrapper carries its run's name: composition runs on
// compositionGeneration.set, nested runs on nestingGeneration.name. A set is
// the compositions whose node uses one of those wrappers.
export function nestingSets(draft, catalog) {
  const sets = new Map()
  for (const bundle of catalog || []) {
    const name = text(bundle.nestingGeneration ? bundle.nestingGeneration.name : bundle.compositionGeneration?.set)
    if (!name) continue
    if (!sets.has(name)) sets.set(name, { name, kind: bundle.nestingGeneration ? 'nesting' : 'composition', wrappers: new Set(), members: [] })
    sets.get(name).wrappers.add(bundle.id)
  }
  // A variant composition belongs to its variance set only, never to the set
  // of the wrapper it still points at.
  for (const composition of draft?.compositions || []) {
    const variance = text(composition.variance?.set)
    if (variance) {
      if (!sets.has(variance)) sets.set(variance, { name: variance, kind: 'variance', wrappers: new Set(), members: [] })
      sets.get(variance).members.push(composition.name); continue
    }
    for (const set of sets.values()) if (set.wrappers.has(composition.node?.use)) set.members.push(composition.name)
  }
  return [...sets.values()].filter(set => set.members.length || set.wrappers.size).map(({ wrappers, ...set }) => set)
}
export function memberPool(member, draft, catalog) {
  const all = (draft?.compositions || []).map(item => item.name).filter(Boolean)
  const available = isSnippetMember(member) ? snippetCategories(catalog).find(category => category.name === snippetCategoryOf(member))?.members || []
    : !member?.set || member.set === ALL_SET ? all : nestingSets(draft, catalog).find(set => set.name === member.set)?.members || []
  if (member?.pick !== 'some') return available
  const chosen = new Set(member.selected || [])
  return available.filter(name => chosen.has(name))
}
export function nestingRunSpace(form, draft, catalog) {
  const parts = (form.members || []).map(member => ({ label: member.set, snippets: memberPool(member, draft, catalog) }))
  return compositionGenerationSpace({ parts, compatibility: { mode: 'all', groups: [] } })
}
// Floyd's sampling of distinct indices from a seeded generator: the same
// sequence the composition run uses, so a seed means the same thing here.
export function sampleIndices(total, count, seed) {
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
  const selected = new Set()
  for (let j = total - count; j < total; j++) {
    const candidate = Math.floor(random() * (j + 1))
    selected.add(selected.has(candidate) ? j : candidate)
  }
  return [...selected].sort((a, b) => a - b)
}
function runWrapper(form, catalog) {
  let index = 1
  while (catalog.some(item => item.id === `nesting-batch-${index}`)) index++
  const id = `nesting-batch-${index}`, slots = {}, parameters = { instructions: String(form.instructions || '') }
  const fallback = hasFallback(form)
  const parts = [fallback ? INTRODUCTION['conditional-first-fallback'] : INTRODUCTION[form.mode], '{{instructions}}']
  form.members.forEach((member, i) => {
    const slot = `member_${i + 1}`, last = fallback && i === form.members.length - 1
    slots[slot] = '*'
    if (!last) parameters[`when_${i + 1}`] = String(member.condition || '')
    parts.push(last ? `Otherwise:\n{{slot:${slot}}}` : `Member ${i + 1}${conditionalNesting(form.mode) ? ` — when {{when_${i + 1}}}` : ''}:\n{{slot:${slot}}}`)
  })
  return { id, version: '1', title: `Nesting / ${text(form.name)}`, labels: ['Nesting'], kind: 'template', role: 'node',
    text: parts.filter(Boolean).join('\n\n'), parameters, slots, semantics: { kind: 'prompt' }, nestingGeneration: structuredClone(form) }
}
export async function previewNestingRun(draft, catalog, form) {
  form = structuredClone(form)
  const binding = compositionGenerationBinding(catalog, draft)
  const name = text(form.name)
  invariant(name && name.length <= 64 && !/[\x00-\x1f]/.test(name), 'Name this nested set with at most 64 characters, without line breaks.')
  invariant(NESTING_MODE_IDS.includes(form.mode), 'Choose how the members work together.')
  invariant(Array.isArray(form.members) && form.members.length > 0 && form.members.length <= 32, 'Choose between 1 and 32 members.')
  invariant(form.mode !== 'custom' || text(form.instructions), 'Write the instructions that connect these members.')
  invariant(typeof form.instructions === 'string' && form.instructions.length <= 32000, 'Shared instructions must be text of at most 32,000 characters.')
  const sets = new Set(nestingSets(draft, catalog).map(set => set.name)), categories = new Set(snippetCategories(catalog).map(category => category.name))
  form.members.forEach((member, index) => {
    invariant(isSnippetMember(member) ? categories.has(snippetCategoryOf(member)) : member.set === ALL_SET || sets.has(member.set), `Member ${index + 1}: choose a saved set${isSnippetMember(member) ? ' or a snippet category that still exists' : ''}.`)
    invariant(['all', 'some'].includes(member.pick), `Member ${index + 1}: take the whole set or pick from it.`)
    invariant(memberPool(member, draft, catalog).length > 0, `Member ${index + 1}: ${member.pick === 'some' ? 'pick at least one' : 'this set is empty'}.`)
    const last = hasFallback(form) && index === form.members.length - 1
    invariant(!conditionalNesting(form.mode) || last || text(member.condition), `Member ${index + 1}: describe when its instructions apply.`)
  })
  invariant(!hasFallback(form) || form.members.length >= 2, 'A fallback needs at least one condition before it.')
  invariant(catalog.length < 512, 'This project has 512 snippets/templates. Remove an unused template before generating another nested set.')
  const space = nestingRunSpace(form, draft, catalog), total = space.total
  invariant(total > 0, 'No compositions to nest. Choose sets that hold compositions.')
  invariant(Number.isSafeInteger(total) && total <= 0xffffffff, 'This pool is too large. Pick fewer compositions in some members.')
  invariant(['all', 'sample'].includes(form.method), 'Choose all combinations or a random subset.')
  const count = form.method === 'all' ? total : Number(form.count)
  invariant(Number.isInteger(count) && count > 0 && count <= NESTING_RUN_LIMIT, `Generate between 1 and ${NESTING_RUN_LIMIT.toLocaleString()} nested compositions at a time. Use a random subset for a larger pool.`)
  invariant(count <= total, `Only ${total.toLocaleString()} combinations are available. Reduce the requested count.`)
  const seed = Number(form.seed)
  invariant(form.method !== 'sample' || (String(form.seed).trim() && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff), 'Enter a whole-number seed from 0 to 4294967295.')
  const wrapper = runWrapper(form, catalog)
  const indices = form.method === 'all' ? Array.from({ length: count }, (_, i) => i) : sampleIndices(total, count, seed)
  const names = new Set((draft?.compositions || []).map(item => item.name)), rows = []
  let serial = 1
  for (const index of indices) {
    const chosen = space.at(index)
    invariant(!chosen.includes(name), 'A nested set cannot contain a composition of its own name.')
    let rowName
    do { rowName = `${name} ${serial++}` } while (names.has(rowName))
    names.add(rowName)
    const members = chosen.map((choice, i) => isSnippetMember(form.members[i])
      ? { set: form.members[i].set, snippet: choice, title: catalog.find(bundle => bundle.id === choice)?.title || choice }
      : { set: form.members[i].set, composition: choice })
    rows.push({ index, name: rowName, members,
      node: { use: wrapper.id, slots: Object.fromEntries(members.map((member, i) => [`member_${i + 1}`, member.snippet ? { use: member.snippet } : { composition: member.composition }])) } })
  }
  return { binding, fingerprint: await sha256(canonical({ binding, form })), wrapper, rows, total, form, method: form.method, seed: form.method === 'sample' ? seed : null }
}
export function saveNestingRun(draft, catalog, preview, selections) {
  invariant(preview.binding === compositionGenerationBinding(catalog, draft), 'The compositions changed. Generate the nested set again before saving.')
  invariant(Array.isArray(selections) && selections.length > 0, 'Keep at least one nested composition to save.')
  const next = structuredClone(draft || createRoutingDraft()), bundles = [...structuredClone(catalog), structuredClone(preview.wrapper)]
  const names = new Set(next.compositions.map(item => item.name)), indices = new Set(), byIndex = new Map(preview.rows.map(row => [row.index, row])), added = []
  for (const selection of selections) {
    const row = byIndex.get(selection.index), name = text(selection.name)
    invariant(row && !indices.has(selection.index), 'Keep valid, distinct nested compositions from this preview.')
    invariant(name && name.length <= 64 && !/[\x00-\x1f]/.test(name), 'Each kept nested composition needs a name of 1–64 characters, without line breaks.')
    invariant(!names.has(name), `A composition named "${name}" already exists. Rename it in the list.`)
    names.add(name); indices.add(selection.index)
    added.push({ name, node: structuredClone(row.node), nesting: { version: 2, mode: preview.form.mode, set: text(preview.form.name), ...(hasFallback(preview.form) ? { fallback: true } : {}) } })
  }
  next.compositions.push(...added)
  for (const composition of added) expandComposition(composition.name, next, { catalog: bundles }) // includes indirect cycle detection
  return { draft: next, catalog: bundles, name: text(preview.form.name), count: added.length }
}

// Families classify tasks; they never restrict which named compositions can
// occupy these slots. The ordinary compiler still checks the resulting tree.
export function buildNesting(draft, catalog, form) {
  const next = structuredClone(draft || createRoutingDraft()), bundles = structuredClone(catalog)
  const name = text(form.name), editing = text(form.editing)
  invariant(name && name.length <= 64 && !/[\x00-\x1f]/.test(name), 'Give this nesting a name of at most 64 characters, without line breaks.')
  invariant(NESTING_MODE_IDS.includes(form.mode), 'Choose how the members work together.')
  const existing = next.compositions.find(item => item.name === name)
  invariant(!editing || (editing === name && existing?.nesting?.version === 1), 'The nesting being edited is no longer available. Start a new nesting or reopen it.')
  invariant(!existing || editing === name, 'That composition name is already in use. Choose a new name.')
  invariant(Array.isArray(form.members) && form.members.length > 0 && form.members.length <= 128, 'Choose between 1 and 128 composition members.')
  invariant(form.mode !== 'custom' || text(form.instructions), 'Write the instructions that connect these members.')
  for (const [index, member] of form.members.entries()) {
    invariant(next.compositions.some(item => item.name === member.composition), `Member ${index + 1}: choose an existing composition.`)
    invariant(member.composition !== name, 'A composition cannot contain itself. Choose a different member.')
    invariant(!conditionalNesting(form.mode) || (hasFallback(form) && index === form.members.length - 1) || text(member.condition), `Member ${index + 1}: describe when its instructions apply.`)
  }
  invariant(!hasFallback(form) || form.members.length >= 2, 'A fallback needs at least one condition before it.')
  invariant(bundles.length < 512, 'This project already has 512 snippets/templates. Remove an unused one before adding a nesting wrapper.')
  let index = 1
  while (bundles.some(item => item.id === `nesting-${index}`)) index++
  const id = `nesting-${index}`, slots = {}, parameters = { instructions: String(form.instructions || '') }, children = {}
  const fallback = hasFallback(form)
  const parts = [fallback ? INTRODUCTION['conditional-first-fallback'] : INTRODUCTION[form.mode], '{{instructions}}']
  form.members.forEach((member, i) => {
    const slot = `member_${i + 1}`, last = fallback && i === form.members.length - 1
    slots[slot] = '*'; children[slot] = { composition: member.composition }
    if (!last) parameters[`when_${i + 1}`] = String(member.condition || '')
    parts.push(last ? `Otherwise:\n{{slot:${slot}}}` : `Member ${i + 1}${conditionalNesting(form.mode) ? ` — when {{when_${i + 1}}}` : ''}:\n{{slot:${slot}}}`)
  })
  // Each save gets a fresh wrapper. Existing generated tasks keep their exact
  // member connections and wording until the user explicitly regenerates them.
  bundles.push({ id, version: '1', title: `Nesting / ${name}`, labels: ['Nesting'], kind: 'template', role: 'node',
    text: parts.filter(Boolean).join('\n\n'), parameters, slots, semantics: { kind: 'prompt' } })
  const composition = { name, node: { use: id, slots: children }, nesting: { version: 1, mode: form.mode, ...(fallback ? { fallback: true } : {}) } }
  if (existing) next.compositions[next.compositions.indexOf(existing)] = composition
  else next.compositions.push(composition)
  expandComposition(name, next, { catalog: bundles }) // includes indirect cycle detection
  return { draft: next, catalog: bundles, name }
}

export function nestingFormFor(name, draft, catalog) {
  const composition = draft?.compositions.find(item => item.name === name)
  if (composition?.nesting?.version !== 1) return null
  const bundle = catalog.find(item => item.id === composition.node.use)
  if (!bundle) return null
  return { name, editing: name, mode: composition.nesting.mode, ...(composition.nesting.fallback ? { fallback: true } : {}),
    instructions: composition.node.params?.instructions ?? bundle.parameters?.instructions ?? '',
    members: Object.entries(composition.node.slots || {}).map(([slot, node], i) => ({ composition: node.composition || '',
      condition: composition.node.params?.[`when_${i + 1}`] ?? bundle.parameters?.[`when_${i + 1}`] ?? '' })) }
}

// Keep reference boundaries visible instead of flattening them into anonymous
// copies. Opening a named member in the inspector follows the same graph.
export function nestingOutline(name, draft, catalog) {
  let remaining = 4096
  const walk = (node, label, trail) => {
    invariant(remaining-- > 0, 'This outline exceeds 4096 nodes. Inspect a smaller member.')
    if (node?.composition) {
      const wanted = node.composition
      invariant(!trail.includes(wanted), `Composition loop: ${[...trail, wanted].join(' → ')}`)
      const item = draft?.compositions.find(row => row.name === wanted)
      invariant(item, `Missing composition: ${wanted}`)
      return { label, name: wanted, kind: 'composition', children: [walk(item.node, 'Contents', [...trail, wanted])] }
    }
    const bundle = catalog.find(item => item.id === node?.use)
    invariant(bundle, `Missing snippet: ${node?.use || 'not chosen'}`)
    return { label, name: bundle.title || bundle.id, id: bundle.id, kind: bundle.kind,
      children: Object.entries(node.slots || {}).map(([slot, child]) => walk(child, slot, trail)) }
  }
  return walk({ composition: name }, 'Composition', [])
}
