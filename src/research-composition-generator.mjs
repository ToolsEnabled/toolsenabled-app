import { canonical, compilePrompt, invariant, sha256 } from './benchmark/prompts.mjs'
import { createRoutingDraft } from './research-routing.mjs'
import { COMPOSITION_LIMITS } from './benchmark/composition.mjs'

export const COMPOSITION_BATCH_LIMIT = 10000
export const emptyCompositionGeneration = () => ({
  form: { prefix: '', instructions: '', separator: 'paragraph', method: 'sample', count: '10', seed: '42', parts: [], compatibility: { mode: 'all', groups: [] } },
  review: null,
})
export const compositionGenerationBinding = (catalog, routing) => canonical({ catalog, routing: routing || null })
export const compositionSnippets = catalog => catalog.filter(item => item.kind === 'atom')
const separators = { paragraph: '\n\n', line: '\n', space: ' ' }

export function compositionCombinationCount(form) {
  if (!form.parts?.length || form.parts.some(part => !part.snippets?.length)) return 0
  return form.parts.reduce((count, part) => count * new Set(part.snippets).size, 1)
}

// A candidate is allowed when all its snippets belong to at least one group
// the author declared compatible. Overlapping groups describe a union, so a
// candidate is counted once. Count/unrank the union without enumerating it.
export function compositionGenerationSpace(form) {
  const raw = compositionCombinationCount(form), choices = (form.parts || []).map(part => [...new Set(part.snippets)])
  const groups = form.compatibility?.groups || [], restricted = form.compatibility?.mode === 'groups'
  const masks = new Map(), memo = new Map()
  if (restricted) {
    invariant(groups.length <= 32, 'Use at most 32 compatibility groups in one batch.')
    groups.forEach((group, i) => (group.snippets || []).forEach(id => masks.set(id, (masks.get(id) || 0n) | 1n << BigInt(i))))
  }
  const initial = restricted ? (1n << BigInt(groups.length)) - 1n : 1n
  function count(depth, mask) {
    if (!mask || !raw) return 0
    if (depth === choices.length) return 1
    const key = depth + ':' + mask
    if (memo.has(key)) return memo.get(key)
    invariant(memo.size < 50000, 'These overlapping compatibility groups are too complex. Generate smaller batches of groups.')
    const total = choices[depth].reduce((sum, id) => sum + count(depth + 1, restricted ? mask & (masks.get(id) || 0n) : mask), 0)
    memo.set(key, total)
    return total
  }
  const total = count(0, initial)
  return { raw, total, at(index) {
    invariant(Number.isInteger(index) && index >= 0 && index < total, 'The composition index is outside the compatible pool.')
    let mask = initial
    return choices.map((part, depth) => {
      for (const id of part) {
        const next = restricted ? mask & (masks.get(id) || 0n) : mask, size = count(depth + 1, next)
        if (index < size) { mask = next; return id }
        index -= size
      }
      throw new Error('Could not resolve this compatible composition.')
    })
  } }
}

function choicesFor(form, catalog) {
  invariant(typeof form.prefix === 'string' && form.prefix.trim() && form.prefix.trim().length <= 50 && !/[\x00-\x1f]/.test(form.prefix), 'Enter a composition name prefix of 1–50 characters.')
  invariant(Array.isArray(form.parts) && form.parts.length > 0 && form.parts.length <= 32, 'Choose between 1 and 32 ordered parts.')
  invariant(Object.hasOwn(separators, form.separator), 'Choose a separator between parts.')
  invariant(['all', 'sample'].includes(form.method), 'Choose all combinations or a random subset.')
  invariant(typeof form.instructions === 'string' && form.instructions.length <= 32000, 'Shared instructions must be text of at most 32,000 characters.')
  const atoms = new Map(compositionSnippets(catalog).map(item => [item.id, item]))
  const choices = form.parts.map((part, index) => {
    invariant(typeof part.label === 'string' && part.label.trim() && part.label.length <= 80, `Name part ${index + 1} using at most 80 characters.`)
    invariant(Array.isArray(part.snippets) && part.snippets.length > 0 && part.snippets.every(id => atoms.has(id)), `Part ${index + 1}: select snippets that still exist in this project.`)
    invariant(new Set(part.snippets).size === part.snippets.length, `Part ${index + 1} repeats a snippet choice.`)
    return part.snippets
  })
  invariant(!form.compatibility || ['all', 'groups'].includes(form.compatibility.mode), 'Choose how snippets may combine.')
  if (form.compatibility?.mode === 'groups') {
    const groups = form.compatibility.groups
    invariant(Array.isArray(groups) && groups.length > 0, 'Add a compatibility group and choose its snippets.')
    invariant(groups.every(group => typeof group.name === 'string' && group.name.trim() && group.name.length <= 80 && Array.isArray(group.snippets) && group.snippets.length && group.snippets.every(id => atoms.has(id))), 'Name each compatibility group and select snippets that exist in this project.')
  }
  const space = compositionGenerationSpace(form), total = space.total
  invariant(total > 0, 'No compatible compositions cover every part. Adjust the selected snippets or compatibility groups.')
  invariant(Number.isSafeInteger(total) && total <= 0xffffffff, 'This pool is too large. Reduce the alternatives in some parts.')
  const count = form.method === 'all' ? total : Number(form.count)
  invariant(Number.isInteger(count) && count > 0 && count <= COMPOSITION_BATCH_LIMIT, `Preview between 1 and ${COMPOSITION_BATCH_LIMIT} compositions at a time. Use a random subset for a larger pool.`)
  invariant(count <= total, `Only ${total} combinations are available. Reduce the requested count.`)
  const seed = Number(form.seed)
  invariant(form.method !== 'sample' || (String(form.seed).trim() && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff), 'Enter a whole-number seed from 0 to 4294967295.')
  let indices
  if (form.method === 'all') indices = Array.from({ length: count }, (_, i) => i)
  else {
    // Floyd sampling selects distinct indices without enumerating the full pool.
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
    indices = [...selected].sort((a, b) => a - b)
  }
  return { atoms, choices, indices, total, seed, space }
}

export async function previewCompositionGeneration(catalog, routing, form) {
  form = structuredClone(form)
  const binding = compositionGenerationBinding(catalog, routing)
  const { atoms, choices, indices, total, seed, space } = choicesFor(form, catalog)
  invariant(catalog.length < 512, 'This project has 512 snippets/templates. Remove an unused template before saving another composition batch.')
  let serial = 1
  while (catalog.some(item => item.id === `composition-batch-${serial}`)) serial++
  const id = `composition-batch-${serial}`
  const slots = Object.fromEntries(choices.map((_, i) => [`part_${i + 1}`, '*']))
  const text = choices.map((_, i) => `{{slot:part_${i + 1}}}`).join(separators[form.separator])
  const wrapper = { id, version: '1', title: `Composition / ${form.prefix.trim()}`, labels: ['Composition'], kind: 'template', role: 'node',
    text: (form.instructions ? '{{instructions}}\n\n' : '') + text, parameters: { instructions: form.instructions }, slots, semantics: { kind: 'prompt' },
    compositionGeneration: structuredClone(form) }
  const previewCatalog = [...catalog, wrapper], names = new Set((routing?.compositions || []).map(item => item.name)), rows = []
  // Flat parts have no inherited values. Compile each distinct snippet once,
  // then reuse its exact rendered text; a 10,000-row preview need not compile
  // the same atoms tens of thousands of times or retain 10,000 text copies.
  const rendered = new Map()
  for (const snippet of new Set(choices.flat())) {
    try { rendered.set(snippet, { text: (await compilePrompt(previewCatalog, { use: snippet }, { requireReview: false, rootRole: '*' })).text }) }
    catch (error) { rendered.set(snippet, { error: error.message }) }
  }
  let nameIndex = 1
  for (const index of indices) {
    const selected = space.at(index)
    let name
    do { name = `${form.prefix.trim()} ${nameIndex++}` } while (names.has(name))
    names.add(name)
    const node = { use: id, slots: Object.fromEntries(selected.map((snippet, i) => [`part_${i + 1}`, { use: snippet }])) }
    const row = { index, name, node, members: selected.map((snippet, i) => ({ part: form.parts[i].label, id: snippet, title: atoms.get(snippet).title || snippet })),
      groups: form.compatibility?.mode === 'groups' ? form.compatibility.groups.filter(group => selected.every(id => group.snippets.includes(id))).map(group => group.name) : [],
      error: selected.map(id => rendered.get(id).error).filter(Boolean).join(' ') }
    const size = selected.reduce((sum, id) => sum + (rendered.get(id).text?.length || 0), form.instructions ? form.instructions.length + 2 : 0) + Math.max(0, selected.length - 1) * separators[form.separator].length
    if (size > COMPOSITION_LIMITS.text) row.error = 'This composition exceeds the prompt text limit. Use shorter snippets or fewer parts.'
    Object.defineProperty(row, 'text', { get: () => row.error ? '' : (form.instructions ? form.instructions + '\n\n' : '') + selected.map(id => rendered.get(id).text).join(separators[form.separator]) })
    rows.push(row)
  }
  return { binding, fingerprint: await sha256(canonical({ binding, form })), wrapper, rows, total, rawTotal: space.raw, form: structuredClone(form),
    method: form.method, seed: form.method === 'sample' ? seed : null }
}

export function saveGeneratedCompositions(catalog, routing, preview, selections) {
  invariant(preview.binding === compositionGenerationBinding(catalog, routing), 'The snippets or saved compositions changed. Generate a fresh preview before saving.')
  invariant(Array.isArray(selections) && selections.length > 0, 'Select at least one reviewed composition to save.')
  const draft = structuredClone(routing || createRoutingDraft()), names = new Set(draft.compositions.map(item => item.name)), indices = new Set(), additions = [], byIndex = new Map(preview.rows.map(row => [row.index, row]))
  for (const selection of selections) {
    const row = byIndex.get(selection.index), name = String(selection.name || '').trim()
    invariant(row && !row.error && !indices.has(selection.index), 'Choose valid, distinct compositions from this preview.')
    invariant(name && name.length <= 64 && !/[\x00-\x1f]/.test(name), 'Each selected composition needs a name of 1–64 characters, without line breaks.')
    invariant(!names.has(name), `A composition named "${name}" already exists. Rename it in the review list.`)
    names.add(name); indices.add(selection.index)
    additions.push({ name, node: structuredClone(row.node), snippetGeneration: { version: 1, method: preview.method, seed: preview.seed,
      poolSize: preview.total, combinationIndex: row.index, groups: [...row.groups] } })
  }
  draft.compositions.push(...additions)
  return { catalog: [...structuredClone(catalog), structuredClone(preview.wrapper)], draft, count: additions.length }
}
