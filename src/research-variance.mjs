import { compilePrompt, invariant, canonical, sha256 } from './benchmark/prompts.mjs'
import { createRoutingDraft, expandComposition } from './research-routing.mjs'
import { compositionGenerationBinding } from './research-composition-generator.mjs'
import { memberPool, sampleIndices } from './research-nesting.mjs'

export const newVarianceStudy = id => ({ id, name: '', source: { kind: 'snippet', id: '' }, mode: 'individual', includeControl: true, marks: [], target: '', filter: 'snippets' })
export const emptyVarianceState = () => ({ active: 'study-1', studies: [newVarianceStudy('study-1')] })
export function varianceSources(spec, routing, kind) {
  if (kind === 'task') return spec.tasks.filter(task => !task.variance).map(task => ({ id: task.id, label: task.id }))
  if (kind === 'composition') return (routing?.compositions || []).filter(item => item.name).map(item => ({ id: item.name, label: item.name }))
  if (kind === 'snippet') return spec.catalog.filter(item => item.kind === 'atom').map(item => ({ id: item.id, label: item.title || item.id }))
  return []
}

export async function varianceInventory(spec, routing, source) {
  let task
  if (source?.kind === 'task') task = structuredClone(spec.tasks.find(item => item.id === source.id))
  else if (source?.kind === 'composition') task = { root: expandComposition(source.id, routing, { catalog: spec.catalog }), input: null, expected: null, split: 'development' }
  else if (source?.kind === 'snippet' && spec.catalog.some(item => item.id === source.id && item.kind === 'atom')) task = { root: { use: source.id }, input: null, expected: null, split: 'development' }
  invariant(task, 'Choose a source prompt for this variance study.')
  invariant(!task.promptOmissions && !task.variance, 'Choose the original task to define a new variance study.')
  invariant(!task.information, 'This task already has an information-reading treatment. Choose its untreated source task to define a separate variance study.')
  const compiled = await compilePrompt(spec.catalog, task.root, { variables: task.variables || {}, rootRole: source.kind === 'snippet' ? '*' : 'node' })
  const nodes = new Map(compiled.composition.nodes.map(node => [node.path, node])), counts = new Map()
  const entries = compiled.sourceMap.map(range => {
    const node = nodes.get(range.path), bundle = spec.catalog.find(item => item.id === range.bundleId)
    const occurrence = (counts.get(range.path) || 0) + 1; counts.set(range.path, occurrence)
    return { key: `${range.path}#${occurrence}`, path: range.path, occurrence, bundleId: range.bundleId, kind: node.kind,
      title: bundle.title || bundle.id, depth: range.path.split('/').length - 1, start: range.start, end: range.end,
      text: compiled.text.slice(range.start, range.end) }
  })
  return { task, compiled, entries, source: structuredClone(source) }
}

export function varianceMark(inventory, target, start, end, { label = '', scope = 'occurrence', id = 'section-1' } = {}) {
  const entry = inventory.entries.find(item => item.key === target)
  invariant(entry && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= entry.text.length, 'Highlight the text to leave out, or choose the whole section.')
  invariant(['occurrence', 'matching'].includes(scope), 'Choose where this omission applies.')
  const splitsPair = at => at > 0 && at < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[at - 1]) && /[\uDC00-\uDFFF]/.test(entry.text[at])
  invariant(!splitsPair(start) && !splitsPair(end), 'Select complete characters for this omission.')
  return { id, label: label.trim() || `Section ${id.replace('section-', '')}`, enabled: true, scope, target, path: entry.path,
    bundleId: entry.bundleId, start, end, text: entry.text.slice(start, end), sourceText: entry.text, sourceSha256: inventory.compiled.promptSha256 }
}

function markRanges(inventory, mark) {
  invariant(mark.sourceSha256 === inventory.compiled.promptSha256, `“${mark.label}” was selected from an earlier prompt. Remove it and select the section again.`)
  const target = inventory.entries.find(item => item.key === mark.target)
  invariant(target && target.text === mark.sourceText && target.bundleId === mark.bundleId && target.path === mark.path, 'The selected occurrence changed. Select the section again.')
  invariant(Number.isSafeInteger(mark.start) && Number.isSafeInteger(mark.end) && mark.start >= 0 && mark.end > mark.start && mark.end <= target.text.length
    && target.text.slice(mark.start, mark.end) === mark.text, 'The selected text no longer matches its character range.')
  invariant(['occurrence', 'matching'].includes(mark.scope), 'Choose one occurrence or matching uses.')
  const targets = mark.scope === 'matching' ? inventory.entries.filter(item => item.bundleId === target.bundleId && item.text === target.text) : [target]
  return targets.map(item => ({ start: item.start + mark.start, end: item.start + mark.end, path: item.path, text: mark.text, label: mark.label }))
}

export async function buildVarianceStudy(spec, routing, study, { forLibrary = false } = {}) {
  invariant(typeof study.name === 'string' && study.name.trim() && study.name.trim().length <= 80, 'Name this variance study (at most 80 characters).')
  invariant(['individual', 'together'].includes(study.mode) && typeof study.includeControl === 'boolean', 'Choose how to generate the omissions and whether to include the original.')
  invariant(Array.isArray(study.marks) && study.marks.length <= 128, 'A variance study supports up to 128 selected sections.')
  const selected = study.marks.filter(mark => mark.enabled)
  invariant(selected.length, 'Select at least one section to omit.')
  const inventory = await varianceInventory(spec, routing, study.source)
  invariant(!Object.hasOwn(inventory.task.factors || {}, 'prompt_variance_study') && !Object.hasOwn(inventory.task.factors || {}, 'prompt_variance_arm'), 'The source already declares prompt_variance_study or prompt_variance_arm factors. Choose its original source to create a separate study.')
  const treatments = study.mode === 'individual' ? selected.map(mark => ({ label: `Without ${mark.label}`, marks: [mark] })) : [{ label: 'Selected omissions together', marks: selected }]
  if (study.includeControl) treatments.unshift({ label: 'Original · no omissions', marks: [] })
  invariant(forLibrary || spec.tasks.length + treatments.length <= 512, 'These variants would exceed 512 tasks. Reduce the selection or remove unused tasks first.')
  let group = 1
  while (spec.tasks.some(task => task.id.startsWith(`variance-${group}-`))) group++
  const prefix = `variance-${group}`, previews = []
  for (const [index, treatment] of treatments.entries()) {
    const raw = treatment.marks.flatMap(mark => markRanges(inventory, mark))
    const seen = new Set(), ranges = raw.filter(range => { const key = canonical({ start: range.start, end: range.end, path: range.path }); if (seen.has(key)) return false; seen.add(key); return true })
    const promptOmissions = ranges.length ? { version: 1, sourceSha256: inventory.compiled.promptSha256, ranges } : undefined
    const compiled = promptOmissions ? await compilePrompt(spec.catalog, inventory.task.root, { variables: inventory.task.variables || {}, omissions: promptOmissions, rootRole: study.source.kind === 'snippet' ? '*' : 'node' }) : inventory.compiled
    const task = { ...structuredClone(inventory.task), id: `${prefix}-${index + 1}`, familyId: inventory.task.familyId || inventory.task.id || prefix,
      factors: { ...(inventory.task.factors || {}), prompt_variance_study: study.name.trim(), prompt_variance_arm: treatment.label },
      variance: { version: 1, study: study.name.trim(), studyId: study.id, source: structuredClone(study.source),
        sourceSha256: inventory.compiled.promptSha256, arm: treatment.label, sections: treatment.marks.map(mark => ({ id: mark.id, label: mark.label, scope: mark.scope, target: mark.target })) },
      ...(promptOmissions ? { promptOmissions } : {}) }
    previews.push({ label: treatment.label, task, compiled, ranges, removed: inventory.compiled.text.length - compiled.text.length })
  }
  return { inventory, previews, tasks: previews.map(item => item.task) }
}

// Reusable variants carry omissions with the snippet or named composition.
// The same compiler applies them wherever the user subsequently places it.
export async function saveVarianceLibrary(spec, routing, study) {
  const built = await buildVarianceStudy(spec, routing, study, { forLibrary: true })
  const catalog = structuredClone(spec.catalog), draft = structuredClone(routing || createRoutingDraft()), saved = []
  const variants = built.previews.filter(item => item.ranges.length)
  invariant(catalog.length + (study.source.kind === 'snippet' ? variants.length : 0) <= 512, 'The snippet library would exceed 512 entries.')
  // Named composition libraries may contain large generated batches. Runtime
  // task and expansion budgets still apply when these structures are used.
  for (const item of variants) {
    const title = `${study.name.trim()} / ${item.label}`
    if (study.source.kind === 'snippet') {
      const original = catalog.find(bundle => bundle.id === study.source.id)
      let index = 1; while (catalog.some(bundle => bundle.id === `variance-snippet-${index}`)) index++
      const bundle = { ...structuredClone(original), id: `variance-snippet-${index}`, version: '1', title,
        labels: [...new Set([...(original.labels || []), 'Variance'])],
        promptOmissions: [...(original.promptOmissions ? [original.promptOmissions].flat() : []), item.task.promptOmissions],
        variance: { ...item.task.variance, sourceBundle: original.id, previewText: item.compiled.text } }
      delete bundle.review
      catalog.push(bundle)
      const check = await compilePrompt(catalog, { use: bundle.id }, { rootRole: '*' })
      invariant(check.text === item.compiled.text, 'The reusable snippet differs from the preview.')
      saved.push({ kind: 'snippet', id: bundle.id, name: title })
    } else {
      let name = title.slice(0, 64), index = 2
      while (draft.compositions.some(row => row.name === name)) name = `${title.slice(0, 56)} (${index++})`
      const root = study.source.kind === 'composition' ? { composition: study.source.id } : structuredClone(built.inventory.task.root)
      if (built.inventory.task.variables) root.variables = { ...(root.variables || {}), ...structuredClone(built.inventory.task.variables) }
      root.promptOmissions = [...(root.promptOmissions ? [root.promptOmissions].flat() : []), item.task.promptOmissions]
      draft.compositions.push({ name, node: root, variance: item.task.variance })
      const check = await compilePrompt(catalog, expandComposition(name, draft, { catalog }), { variables: built.inventory.task.variables || {} })
      invariant(check.text === item.compiled.text, 'The reusable composition differs from the preview.')
      saved.push({ kind: 'composition', id: name, name })
    }
  }
  return { catalog, draft, saved }
}

export async function materializeVarianceTasks(spec, routing, study) {
  const built = await buildVarianceStudy(spec, routing, study, { forLibrary: true })
  const tasks = structuredClone(spec.tasks), matches = new Map()
  const key = (compiled, task) => canonical({ semantic: compiled.semantic, text: compiled.text, input: task.input ?? null })
  for (const [index, task] of tasks.entries()) {
    if (task.information) continue
    try {
      const compiled = await compilePrompt(spec.catalog, task.root, { variables: task.variables || {}, omissions: task.promptOmissions })
      const identity = key(compiled, task)
      if (!matches.has(identity)) matches.set(identity, index)
    } catch { /* An unrelated unfinished task is retained for the user to complete. */ }
  }
  let index = 1
  while (tasks.some(task => Object.hasOwn(task.factors || {}, `prompt_variance_${index}`))) index++
  const factor = `prompt_variance_${index}`, used = new Set(), added = [], reused = []
  const original = matches.get(key(built.inventory.compiled, built.inventory.task))
  for (const preview of built.previews) {
    const task = structuredClone(preview.task)
    if (study.source.kind !== 'task' && task.expected === null && original !== undefined) task.expected = structuredClone(tasks[original].expected)
    const identity = key(preview.compiled, task), existing = matches.get(identity)
    let at = existing
    if (at === undefined) { at = tasks.length; tasks.push(task); matches.set(identity, at); added.push(task.id) }
    else {
      invariant(canonical(tasks[at].expected) === canonical(task.expected), 'A matching task has a different reference result. Choose that existing task as the source and review its expected result.')
      reused.push(tasks[at].id)
    }
    invariant(!used.has(at), 'Two selected variants produce the same prompt. Combine or remove duplicate omissions before generating tasks.')
    used.add(at)
    tasks[at].factors = { ...(tasks[at].factors || {}), [factor]: preview.label }
  }
  invariant(tasks.length <= 512, 'These variants would exceed 512 tasks. Reduce the selection or remove unused tasks first.')
  return { tasks, added, reused, factor, first: used.values().next().value }
}

/* ---- A VARIANT RUN over sets. ----
   The run names what to vary (composition sets, whole or picked), which
   snippets to mark text in, which parts to leave out, and the text marks.
   Each treatment (one omission alone, or all together, plus the untouched
   control) is applied to every composition in scope: a marked snippet is
   swapped for a variant snippet that carries the omission, and a part is
   left out through a variant template without that hole. Every row is a
   self-contained tree, so the variant set stands on its own. */
export const VARIANCE_RUN_LIMIT = 10000
export const emptyVarianceRun = () => ({ name: '', members: [], snippets: [], parts: [], marks: [], mode: 'individual', includeControl: true, method: 'sample', count: '100', seed: '42' })
const runText = value => String(value ?? '').trim()
const categoriesOf = bundle => { const list = (bundle.labels || []).map(runText).filter(Boolean); return list.length ? [...new Set(list)] : ['Unlabelled'] }

// The text of one snippet as written, with the digest a mark binds to. Marks
// edit this text: words leave, or give way to other words, and the variant
// snippet carries the edited wording.
export async function snippetText(spec, id) {
  const bundle = spec.catalog.find(item => item.id === id && item.kind === 'atom')
  invariant(bundle, 'Choose a snippet that is still in the library.')
  const text = String(bundle.text ?? '')
  return { id, title: bundle.title || bundle.id, text, promptSha256: await sha256(text) }
}
const short = value => (value.length > 40 ? value.slice(0, 37) + '…' : value)
export function textMark(snippet, start, end, { label = '', id = 'mark-1', replacement = '' } = {}) {
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= snippet.text.length, 'Highlight the words to change, or omit the whole snippet.')
  const splitsPair = at => at > 0 && at < snippet.text.length && /[\uD800-\uDBFF]/.test(snippet.text[at - 1]) && /[\uDC00-\uDFFF]/.test(snippet.text[at])
  invariant(!splitsPair(start) && !splitsPair(end), 'Select complete characters for this omission.')
  replacement = String(replacement ?? '')
  invariant(replacement.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(replacement), 'Replacement wording must be plain text of at most 4,000 characters.')
  const text = snippet.text.slice(start, end)
  const fallback = replacement ? `“${short(text)}” → “${short(replacement)}”` : start === 0 && end === snippet.text.length ? `Without ${snippet.title}` : `Without “${short(text)}”`
  return { id, label: label.trim() || fallback, enabled: true, bundleId: snippet.id, title: snippet.title, start, end, text, replacement, sourceSha256: snippet.promptSha256 }
}
// The snippet's wording after its marks: later marks first, so earlier
// offsets hold; a removal also closes the gap it leaves.
export function editedText(text, marks) {
  let next = text
  for (const mark of [...marks].sort((a, b) => b.start - a.start)) {
    invariant(!marks.some(other => other !== mark && other.start < mark.end && mark.start < other.end), 'Two marks on the same snippet overlap. Remove one of them.')
    const before = next.slice(0, mark.start), after = next.slice(mark.end)
    next = mark.replacement ? before + mark.replacement + after
      : (before.endsWith(' ') && after.startsWith(' ')) ? before + after.slice(1) : (before.endsWith(' ') && /^[.,;:!?]/.test(after)) ? before.slice(0, -1) + after : before + after
  }
  return next
}
export function varianceTreatments(run) {
  const marks = (run.marks || []).filter(mark => mark.enabled), parts = [...new Set(run.parts || [])]
  const treatments = run.mode === 'together' && (marks.length || parts.length) ? [{ label: 'All changes together', marks, parts }]
    : [...marks.map(mark => ({ label: mark.label, marks: [mark], parts: [] })), ...parts.map(part => ({ label: `Without ${part}`, marks: [], parts: [part] }))]
  if (run.includeControl) treatments.unshift({ label: 'Original · unchanged', marks: [], parts: [] })
  return treatments
}
// A template without some of its holes: the slot markers leave the text, the
// holes leave the declaration, and the run's markers never ride along.
function withoutSlots(template, slots) {
  let text = template.text
  for (const slot of slots) text = text.replace(new RegExp(`[ \\t]*\\{\\{slot:${slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}[ \\t]*`, 'g'), '')
  text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
  const { compositionGeneration, nestingGeneration, review, ...rest } = template
  return { ...structuredClone(rest), text, slots: Object.fromEntries(Object.entries(template.slots || {}).filter(([name]) => !slots.includes(name))) }
}
export async function previewVarianceRun(spec, routing, run) {
  run = structuredClone(run)
  const catalog = spec.catalog, binding = compositionGenerationBinding(catalog, routing)
  const name = runText(run.name)
  invariant(name && name.length <= 64 && !/[\x00-\x1f]/.test(name), 'Name this variant set with at most 64 characters, without line breaks.')
  invariant(Array.isArray(run.members) && run.members.length, 'Choose at least one set of compositions to vary.')
  const compositions = [...new Set(run.members.flatMap(member => memberPool(member, routing, catalog)))]
  invariant(compositions.length, 'The chosen sets hold no compositions.')
  const treatments = varianceTreatments(run)
  invariant(treatments.some(item => item.marks.length || item.parts.length), 'Mark words in a snippet first.')
  invariant(['individual', 'together'].includes(run.mode) && typeof run.includeControl === 'boolean', 'Choose how to generate the omissions and whether to include the original.')
  invariant(['all', 'sample'].includes(run.method), 'Choose all variants or a random subset.')
  // Variant snippets: one per snippet and combination of its marks, bound to
  // the snippet's current text.
  const marked = new Map(), bundles = [], usedIds = new Set(catalog.map(item => item.id))
  const allocate = prefix => { let index = 1; while (usedIds.has(`${prefix}-${index}`)) index++; const id = `${prefix}-${index}`; usedIds.add(id); return id }
  const variantSnippet = async marks => {
    const bundleId = marks[0].bundleId, key = bundleId + '|' + marks.map(mark => mark.id).sort().join(',')
    if (marked.has(key)) return marked.get(key)
    const original = catalog.find(item => item.id === bundleId && item.kind === 'atom')
    invariant(original, `The snippet for “${marks[0].label}” is no longer in the library. Remove that mark.`)
    const current = await snippetText(spec, bundleId)
    for (const mark of marks) invariant(mark.sourceSha256 === current.promptSha256 && current.text.slice(mark.start, mark.end) === mark.text, `“${mark.label}” was marked on an earlier wording of ${current.title}. Remove it and mark the text again.`)
    const { review, ...rest } = original
    const bundle = { ...structuredClone(rest), id: allocate('variance-snippet'), version: '1', title: `${current.title} / ${marks.map(mark => mark.label).join(' + ')}`,
      labels: [...new Set([...(original.labels || []), 'Variance'])], text: editedText(current.text, marks),
      variance: { version: 2, set: name, sourceBundle: bundleId, marks: marks.map(mark => ({ id: mark.id, label: mark.label, start: mark.start, end: mark.end, text: mark.text, replacement: mark.replacement || '' })) } }
    bundles.push(bundle); marked.set(key, bundle.id)
    return bundle.id
  }
  const templates = new Map()
  const variantTemplate = (template, slots) => {
    const key = template.id + '|' + [...slots].sort().join(',')
    if (templates.has(key)) return templates.get(key)
    const bundle = { ...withoutSlots(template, slots), id: allocate('variance-template'), version: '1', title: `${template.title || template.id} / without ${slots.join(', ')}`,
      labels: [...new Set([...(template.labels || []), 'Variance'])], variance: { version: 2, set: name, sourceBundle: template.id, parts: [...slots] } }
    bundles.push(bundle); templates.set(key, bundle.id)
    return bundle.id
  }
  // Apply one treatment to one expanded tree. Returns null when nothing in the
  // tree answers to it.
  const apply = async (root, treatment) => {
    let changed = false
    const swaps = new Map()
    for (const mark of treatment.marks) { if (!swaps.has(mark.bundleId)) swaps.set(mark.bundleId, []); swaps.get(mark.bundleId).push(mark) }
    const walk = async node => {
      if (!node || typeof node !== 'object') return node
      const next = { ...node }
      if (next.slots) {
        next.slots = {}
        const dropped = []
        for (const [slot, child] of Object.entries(node.slots)) {
          const bundle = catalog.find(item => item.id === child?.use)
          if (bundle?.kind === 'atom' && treatment.parts.some(part => categoriesOf(bundle).includes(part))) { dropped.push(slot); continue }
          next.slots[slot] = await walk(child)
        }
        if (dropped.length) {
          const template = catalog.find(item => item.id === node.use)
          invariant(template && template.kind === 'template', 'A part can only be left out of a template with holes.')
          next.use = variantTemplate(template, dropped); changed = true
        }
      }
      if (swaps.has(next.use)) { next.use = await variantSnippet(swaps.get(next.use)); changed = true }
      return next
    }
    const result = await walk(root)
    return changed ? result : null
  }
  // A composition that no treatment touches stays out of the set entirely:
  // its control would only repeat the source set.
  const candidates = []
  for (const composition of compositions) {
    const root = expandComposition(composition, routing, { catalog })
    const produced = []
    for (const treatment of treatments) {
      if (!treatment.marks.length && !treatment.parts.length) continue
      const node = await apply(root, treatment)
      if (node) produced.push({ source: composition, arm: treatment.label, node })
      invariant(candidates.length + produced.length <= 40000, 'This run would produce more than 40,000 candidates. Pick fewer compositions or changes.')
    }
    if (!produced.length) continue
    for (const treatment of treatments) if (!treatment.marks.length && !treatment.parts.length) candidates.push({ source: composition, arm: treatment.label, node: structuredClone(root) })
    candidates.push(...produced)
  }
  invariant(candidates.some(item => item.arm !== 'Original · unchanged'), 'No composition in scope uses a changed snippet. Mark words in a snippet they use, or choose other sets.')
  const total = candidates.length
  const count = run.method === 'all' ? total : Number(run.count)
  invariant(Number.isInteger(count) && count > 0 && count <= VARIANCE_RUN_LIMIT, `Generate between 1 and ${VARIANCE_RUN_LIMIT.toLocaleString()} variants at a time. Use a random subset for a larger pool.`)
  invariant(count <= total, `Only ${total.toLocaleString()} variants are available. Reduce the requested count.`)
  const seed = Number(run.seed)
  invariant(run.method !== 'sample' || (String(run.seed).trim() && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff), 'Enter a whole-number seed from 0 to 4294967295.')
  const indices = run.method === 'all' ? Array.from({ length: count }, (_, i) => i) : sampleIndices(total, count, seed)
  const names = new Set((routing?.compositions || []).map(item => item.name)), rows = []
  let serial = 1
  for (const index of indices) {
    let rowName
    do { rowName = `${name} ${serial++}` } while (names.has(rowName))
    names.add(rowName)
    rows.push({ index, name: rowName, ...candidates[index] })
  }
  const used = new Set(), collect = node => { if (!node) return; used.add(node.use); for (const child of Object.values(node.slots || {})) collect(child) }
  for (const row of rows) collect(row.node)
  return { binding, fingerprint: await sha256(canonical({ binding, run })), bundles: bundles.filter(bundle => used.has(bundle.id)), rows, total, treatments: treatments.map(item => item.label), form: run, method: run.method, seed: run.method === 'sample' ? seed : null }
}
export async function saveVarianceRun(spec, routing, preview, selections) {
  invariant(preview.binding === compositionGenerationBinding(spec.catalog, routing), 'The compositions or snippets changed. Generate the variant set again before saving.')
  invariant(Array.isArray(selections) && selections.length > 0, 'Keep at least one variant to save.')
  const next = structuredClone(routing || createRoutingDraft()), byIndex = new Map(preview.rows.map(row => [row.index, row]))
  const names = new Set(next.compositions.map(item => item.name)), indices = new Set(), added = [], used = new Set()
  const collect = node => { if (!node) return; used.add(node.use); for (const child of Object.values(node.slots || {})) collect(child) }
  for (const selection of selections) {
    const row = byIndex.get(selection.index), name = runText(selection.name)
    invariant(row && !indices.has(selection.index), 'Keep valid, distinct variants from this preview.')
    invariant(name && name.length <= 64 && !/[\x00-\x1f]/.test(name), 'Each kept variant needs a name of 1–64 characters, without line breaks.')
    invariant(!names.has(name), `A composition named "${name}" already exists. Rename it in the list.`)
    names.add(name); indices.add(selection.index); collect(row.node)
    added.push({ name, node: structuredClone(row.node), variance: { version: 2, set: runText(preview.form.name), source: row.source, arm: row.arm } })
  }
  const bundles = preview.bundles.filter(bundle => used.has(bundle.id))
  invariant(spec.catalog.length + bundles.length <= 512, 'The snippet library would exceed 512 entries. Keep fewer variants or remove unused snippets.')
  const catalog = [...structuredClone(spec.catalog), ...structuredClone(bundles)]
  for (const composition of added) await compilePrompt(catalog, composition.node, { requireReview: false })
  next.compositions.push(...added)
  return { catalog, draft: next, name: runText(preview.form.name), count: added.length, bundles: bundles.length }
}
