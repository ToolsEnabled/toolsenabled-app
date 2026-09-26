// Generic, deterministic task construction. Domain-specific oracle calculation
// is supplied by the shared study compiler, never improvised by the GUI.
import { canonical, catalogMap, invariant, object, reviewContent, sha256 } from './prompts.mjs'
import { validateInformation } from './information.mjs'
import { compileTask, semanticTaskId } from './tasks.mjs'
import { COMPOSITION_LIMITS, validateComposition } from './composition.mjs'

export const CORPUS_VERSION = 1
export const MAX_CANDIDATES = 4096
export const MAX_COVERAGE_CELLS = 16384
export const MAX_COVERAGE_RULES = 128
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value)
const same = (a, b) => canonical(a) === canonical(b)
const scalar = value => ['string', 'boolean', 'number'].includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value))
const positive = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum
const fields = (value, allowed, label) => invariant(Object.keys(value).every(key => allowed.includes(key)), `${label} contains an unsupported field.`)

function distinct(rows, label) {
  invariant(Array.isArray(rows) && rows.every(row => object(row) && id(row.id)), `${label} need lowercase identifiers.`)
  invariant(new Set(rows.map(row => row.id)).size === rows.length, `${label} identifiers must be distinct.`)
}
export function validateCorpusPlan(plan) {
  invariant(object(plan) && plan.version === CORPUS_VERSION, 'The task recipe needs version 1.')
  fields(plan, ['version', 'seed', 'rationale', 'families', 'selection', 'coverage', 'features', 'fieldAuthoring', 'pool'], 'Task recipe')
  invariant(Number.isSafeInteger(plan.seed) && plan.seed >= 0 && plan.seed <= 0xffffffff, 'The task recipe needs a frozen 32-bit seed.')
  invariant(typeof plan.rationale === 'string' && plan.rationale.trim(), 'Record the task construction and sampling rationale.')
  distinct(plan.families, 'Task families')
  if (plan.pool !== undefined) return validatePromptPoolPlan(plan)
  invariant(plan.families.length > 0 && plan.families.length <= 512, 'Declare 1–512 task families.')
  invariant(object(plan.selection) && ['all', 'seeded', 'balanced'].includes(plan.selection.kind), 'Choose all, seeded, or balanced task selection.')
  invariant(positive(plan.selection.limit, 512), 'The task selection limit must be 1–512 tasks.')
  fields(plan.selection, ['kind', 'limit'], 'Selection policy')
  invariant(Array.isArray(plan.coverage) && plan.coverage.length <= MAX_COVERAGE_RULES, `Declare at most ${MAX_COVERAGE_RULES} coverage rules.`)
  const ruleIds = new Set()
  for (const rule of plan.coverage) {
    invariant(object(rule) && positive(rule.minimum, 512), 'Coverage rules need positive minimum counts of at most 512.')
    fields(rule, ['dimension', 'dimensions', 'minimum', 'levels'], 'Coverage rule')
    invariant(Object.hasOwn(rule, 'dimension') !== Object.hasOwn(rule, 'dimensions'), 'A coverage rule needs either dimension or dimensions.')
    const dimensions = ruleDimensions(rule)
    invariant(Array.isArray(dimensions) && dimensions.length >= (rule.dimension === undefined ? 2 : 1) && dimensions.length <= 4
      && dimensions.every(value => typeof value === 'string') && new Set(dimensions).size === dimensions.length, 'Joint coverage needs 2–4 distinct dimensions.')
    const key = canonical({ dimensions: [...dimensions].sort(), levels: rule.levels || {} })
    invariant(!ruleIds.has(key), 'Coverage scopes must be distinct; reversing a pair does not create a new rule.')
    ruleIds.add(key)
    if (rule.levels !== undefined) {
      invariant(object(rule.levels) && Object.keys(rule.levels).every(key => dimensions.includes(key)), 'Coverage levels must name dimensions in this rule.')
      for (const values of Object.values(rule.levels)) invariant(Array.isArray(values) && values.length > 0 && values.length <= MAX_CANDIDATES
        && values.every(value => typeof value === 'string' && value.length > 0 && value.length <= 64) && new Set(values).size === values.length, 'Coverage levels need distinct bounded nonempty strings.')
    }
  }
  invariant(plan.features === undefined || Array.isArray(plan.features), 'Composition features must be an array.')
  distinct(plan.features || [], 'Composition features')
  invariant((plan.features || []).length <= MAX_COVERAGE_RULES, 'Too many composition features.')
  for (const feature of plan.features || []) {
    fields(feature, ['id', 'bundles', 'rationale'], 'Composition feature')
    invariant(Array.isArray(feature.bundles) && feature.bundles.length > 0 && feature.bundles.length <= 4096 && feature.bundles.every(id)
      && new Set(feature.bundles).size === feature.bundles.length, 'A composition feature needs distinct bundle identifiers.')
    invariant(typeof feature.rationale === 'string' && feature.rationale.trim(), 'Explain each composition feature classification.')
  }
  let candidates = 0
  const axes = new Set()
  for (const family of plan.families) {
    fields(family, ['id', 'split', 'task', 'axes', 'constraints'], 'Corpus family')
    invariant(['development', 'held-out'].includes(family.split), `${family.id}: declare a study split for the entire family.`)
    invariant(object(family.task) && object(family.task.root), `${family.id}: supply a base task with a prompt root.`)
    invariant(!['id', 'familyId', 'split', 'generation'].some(key => Object.hasOwn(family.task, key)), `${family.id}: task identity, family, split and generation metadata are assigned by the recipe.`)
    distinct(family.axes, `${family.id} axes`)
    let count = 1
    for (const axis of family.axes) {
      fields(axis, ['id', 'choices'], 'Corpus axis')
      invariant(!Object.hasOwn(family.task.factors || {}, axis.id), `${family.id}: axis ${axis.id} would overwrite an existing task factor.`)
      distinct(axis.choices, `${family.id}/${axis.id} choices`)
      invariant(axis.choices.length > 0 && axis.choices.length <= 512, `${axis.id}: declare 1–512 choices.`)
      for (const choice of axis.choices) {
        fields(choice, ['id', 'edits'], 'Corpus choice')
        invariant(Array.isArray(choice.edits) && choice.edits.length <= 64, `${axis.id}/${choice.id}: declare at most 64 edits.`)
        for (const edit of choice.edits) validateEdit(edit)
      }
      count *= axis.choices.length
      invariant(count <= MAX_CANDIDATES, `The task recipe exceeds the ${MAX_CANDIDATES}-candidate construction budget.`)
      axes.add(axis.id)
    }
    candidates += count
    invariant(candidates <= MAX_CANDIDATES, `The task recipe exceeds the ${MAX_CANDIDATES}-candidate construction budget.`)
    distinct(family.constraints, `${family.id} constraints`)
    for (const constraint of family.constraints) {
      fields(constraint, ['id', 'when', 'reason'], 'Compatibility constraint')
      invariant(object(constraint.when) && Object.keys(constraint.when).length && typeof constraint.reason === 'string' && constraint.reason.trim(), `${constraint.id}: an exclusion needs its assignment predicate and reason.`)
      for (const [axisId, values] of Object.entries(constraint.when)) {
        const axis = family.axes.find(row => row.id === axisId)
        invariant(axis && Array.isArray(values) && values.length && values.every(value => axis.choices.some(choice => choice.id === value)), `${constraint.id}: constraint references an unknown axis or choice.`)
      }
    }
  }
  for (const rule of plan.coverage) for (const dimension of ruleDimensions(rule)) {
    invariant(dimension === 'family' || ['composition-depth', 'composition-nodes'].includes(dimension)
      || (dimension.startsWith('axis:') && axes.has(dimension.slice(5)))
      || (dimension.startsWith('feature:') && (plan.features || []).some(row => row.id === dimension.slice(8))), `Unknown coverage dimension: ${dimension}.`)
    for (const value of rule.levels?.[dimension] || []) {
      if (dimension === 'family') invariant(plan.families.some(row => row.id === value), 'A requested family coverage level is not declared.')
      else if (dimension.startsWith('axis:')) invariant(plan.families.some(row => row.axes.some(axis => axis.id === dimension.slice(5) && axis.choices.some(choice => choice.id === value))), 'A requested axis coverage level is not declared.')
      else if (dimension.startsWith('feature:')) invariant(['present', 'absent'].includes(value), 'A feature coverage level must be present or absent.')
      else invariant(/^(0|[1-9][0-9]*)$/.test(value) && Number(value) <= 4096 && (dimension !== 'composition-nodes' || Number(value) > 0), 'Composition coverage levels must be canonical bounded integer strings.')
    }
  }
  if (plan.selection.kind === 'balanced') invariant(plan.coverage.length > 0, 'Balanced selection needs declared coverage dimensions.')
  if (plan.fieldAuthoring !== undefined) validateFieldAuthoring(plan)
  return plan
}
function validateFieldAuthoring(plan) {
  const authoring = plan.fieldAuthoring
  exactFields(authoring, ['version', 'families', 'axisMappings'], 'Family field authoring')
  invariant(authoring.version === 1 && Array.isArray(authoring.families) && authoring.families.length === plan.families.length,
    'Family field authoring must identify every generated family.')
  const sourceIds = new Set(), sourceFamilies = new Set(), familyIds = new Set()
  for (const row of authoring.families) {
    exactFields(row, ['sourceTaskId', 'sourceFamilyId', 'familyId', 'sourceBindingSha256', 'expectedPolicy'], 'Family authoring source')
    invariant(id(row.sourceTaskId) && id(row.sourceFamilyId) && /^[a-f0-9]{64}$/.test(row.sourceBindingSha256)
      && plan.families.some(family => family.id === row.familyId) && !familyIds.has(row.familyId)
      && !sourceIds.has(row.sourceTaskId) && !sourceFamilies.has(row.sourceFamilyId), 'Family authoring identities must be complete and distinct.')
    familyIds.add(row.familyId); sourceIds.add(row.sourceTaskId); sourceFamilies.add(row.sourceFamilyId)
    exactFields(row.expectedPolicy, ['kind', 'rationale'], 'Family expected-answer policy')
    invariant(['derive-lean', 'reuse-base'].includes(row.expectedPolicy.kind) && typeof row.expectedPolicy.rationale === 'string' && row.expectedPolicy.rationale.trim(),
      'Retain each family expected-answer policy and rationale.')
  }
  invariant(Array.isArray(authoring.axisMappings) && authoring.axisMappings.length === plan.families.reduce((count, family) => count + family.axes.length, 0),
    'Family authoring must map every generated factor exactly once.')
  const mapped = new Set(), local = new Set()
  for (const row of authoring.axisMappings) {
    exactFields(row, ['sourceTaskId', 'familyId', 'axisId', 'recipeAxisId', 'path', 'choices'], 'Family factor mapping')
    const family = plan.families.find(family => family.id === row.familyId), axis = family?.axes.find(axis => axis.id === row.recipeAxisId)
    invariant(axis && id(row.axisId) && !mapped.has(row.recipeAxisId) && !local.has(canonical([row.familyId, row.axisId]))
      && authoring.families.some(source => source.familyId === row.familyId && source.sourceTaskId === row.sourceTaskId)
      && Array.isArray(row.path) && row.path.every(id) && same(row.choices, axis.choices.map(choice => choice.id))
      && axis.choices.every(choice => choice.edits.length === 1 && choice.edits[0].kind === 'node' && same(choice.edits[0].path, row.path)),
      'Family factor provenance must match its exact recipe family, path and choices.')
    mapped.add(row.recipeAxisId); local.add(canonical([row.familyId, row.axisId]))
  }
}
function validateEdit(edit) {
  invariant(object(edit) && ['node', 'parameter', 'wrap', 'input', 'expected', 'variable', 'information', 'withhold'].includes(edit.kind), 'Unknown corpus edit kind.')
  const allowed = { node: ['path', 'value'], parameter: ['path', 'name', 'value'], wrap: ['path', 'bundleId', 'slot', 'otherSlots', 'params', 'repeat'],
    input: ['value'], expected: ['value'], variable: ['name', 'value'], information: ['value'], withhold: ['path'] }
  fields(edit, ['kind', ...allowed[edit.kind]], 'Corpus edit')
  if (['node', 'parameter', 'wrap', 'withhold'].includes(edit.kind)) invariant(Array.isArray(edit.path) && edit.path.every(id), 'A composition edit needs a path of declared slot names; [] names the root.')
  if (edit.kind === 'information') validateInformation(edit.value)
  if (['parameter', 'variable'].includes(edit.kind)) invariant(typeof edit.name === 'string' && /^[a-z][a-zA-Z0-9_-]{0,63}$/.test(edit.name) && scalar(edit.value), 'A parameter edit needs a name and finite scalar value.')
  if (['input', 'expected'].includes(edit.kind)) invariant(Object.hasOwn(edit, 'value'), `${edit.kind} edits need an explicit JSON value.`)
  if (edit.kind === 'node') invariant(object(edit.value) && id(edit.value.use), 'A node edit needs a bundle reference.')
  if (edit.kind === 'wrap') {
    invariant(id(edit.bundleId) && id(edit.slot) && object(edit.otherSlots || {}), 'A wrapper edit needs a template, insertion slot and other slot references.')
    invariant(Number.isSafeInteger(edit.repeat) && edit.repeat >= 0 && edit.repeat <= 64, 'A wrapper repeat count must be 0–64.')
    invariant(!Object.hasOwn(edit.otherSlots || {}, edit.slot), 'The insertion slot cannot also be supplied as a sibling.')
    invariant(edit.params === undefined || (object(edit.params) && Object.values(edit.params).every(scalar)), 'Wrapper parameters must be finite scalar values.')
  }
}
function referenceAt(task, path) {
  let ref = task.root
  for (const slot of path) {
    invariant(object(ref.slots) && Object.hasOwn(ref.slots, slot), `Corpus edit path does not exist: ${path.join('/')}.`)
    ref = ref.slots[slot]
  }
  return ref
}
function replaceAt(task, path, ref) {
  if (!path.length) task.root = ref
  else referenceAt(task, path.slice(0, -1)).slots[path.at(-1)] = ref
}
function editTask(task, edit, byId) {
  if (edit.kind === 'input' || edit.kind === 'expected') task[edit.kind] = structuredClone(edit.value)
  else if (edit.kind === 'information') task.information = structuredClone(edit.value)
  else if (edit.kind === 'withhold') {
    invariant(task.information, 'Declare a reading set before generating withheld-information variants.')
    invariant(byId.get(referenceAt(task, edit.path)?.use)?.kind === 'atom', 'Only atomic requirements can be withheld.')
    const path = ['root', ...edit.path].join('/')
    if (!task.information.withheldPaths.includes(path)) task.information.withheldPaths.push(path)
  }
  else if (edit.kind === 'variable') { task.variables ||= {}; task.variables[edit.name] = edit.value }
  else if (edit.kind === 'parameter') { const ref = referenceAt(task, edit.path); ref.params ||= {}; ref.params[edit.name] = edit.value }
  else if (edit.kind === 'node') { referenceAt(task, edit.path); replaceAt(task, edit.path, structuredClone(edit.value)) }
  else {
    const wrapper = byId.get(edit.bundleId)
    invariant(wrapper?.kind === 'template' && Object.hasOwn(wrapper.slots || {}, edit.slot), `${edit.bundleId}: select a real template insertion slot.`)
    for (let i = 0; i < edit.repeat; i++) {
      const child = referenceAt(task, edit.path)
      replaceAt(task, edit.path, { use: edit.bundleId, ...(edit.params ? { params: structuredClone(edit.params) } : {}), slots: { ...structuredClone(edit.otherSlots || {}), [edit.slot]: child } })
    }
  }
}
function typecheck(task, byId) {
  const stack = [{ ref: task.root, role: 'node' }]
  let count = 0
  while (stack.length) {
    const { ref, role } = stack.pop(), bundle = byId.get(ref?.use)
    invariant(bundle, `Generated task references missing bundle ${ref?.use}.`)
    invariant((bundle.role || 'node') === role || role === '*', `Generated bundle ${bundle.id} has an incompatible slot role.`)
    invariant(++count <= 4096, 'Generated task exceeds the 4,096-component budget.')
    invariant(Object.keys(ref.slots || {}).every(slot => Object.hasOwn(bundle.slots || {}, slot)), `Generated bundle ${bundle.id} contains an undeclared slot.`)
    for (const [slot, childRole] of Object.entries(bundle.slots || {})) {
      invariant(ref.slots?.[slot], `Generated bundle ${bundle.id} is missing slot ${slot}.`)
      stack.push({ ref: ref.slots[slot], role: childRole })
    }
  }
}
function randomOrder(rows, seed) {
  let state = seed >>> 0
  for (let i = rows.length - 1; i > 0; i--) {
    state += 0x6D2B79F5; let value = state
    value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    const j = Math.floor(((value ^ value >>> 14) >>> 0) / 4294967296 * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }
  return rows
}
const ruleDimensions = rule => Object.hasOwn(rule, 'dimension') ? [rule.dimension] : rule.dimensions
const structural = dimension => dimension.startsWith('feature:') || dimension.startsWith('composition-')
const extendedCoverage = plan => plan.features !== undefined || plan.coverage.some(rule => rule.dimensions || rule.levels || ruleDimensions(rule).some(structural))
function level(row, dimension) {
  if (dimension === 'family') return row.familyId
  if (dimension.startsWith('axis:')) return row.choices[dimension.slice(5)] ?? null
  if (!row.composition) return null
  if (dimension.startsWith('feature:')) return row.composition.features[dimension.slice(8)]
  return String(row.composition[dimension === 'composition-depth' ? 'depth' : 'nodes'])
}
function compositionFeatures(ir, features) {
  const { depth } = validateComposition(ir), present = new Set(ir.nodes.map(node => node.bundle.id)), bundles = [...present].sort()
  return { depth, nodes: ir.nodes.length, bundles, features: Object.fromEntries(features.map(feature => [feature.id, feature.bundles.some(id => present.has(id)) ? 'present' : 'absent'])) }
}
// The declared level universe is Cartesian, before exclusions or selection.
// A missing combination remains an explicit zero cell. Structural levels come
// from the canonical baseline composition; they never assert trace activation.
function coverageIndex(plan, candidates) {
  const coverage = [], rules = [], seenCells = new Set(), membership = new Map(candidates.map(row => [row, []])), extended = extendedCoverage(plan)
  for (const rule of plan.coverage) {
    const dimensions = ruleDimensions(rule), domains = dimensions.map(dimension => rule.levels?.[dimension] || (
      dimension === 'family' ? plan.families.map(row => row.id)
      : dimension.startsWith('axis:') ? plan.families.flatMap(row => row.axes.filter(axis => axis.id === dimension.slice(5)).flatMap(axis => axis.choices.map(choice => choice.id)))
      : dimension.startsWith('feature:') ? ['absent', 'present'] : candidates.map(row => level(row, dimension)).filter(value => value !== null)))
      .map(values => [...new Set(values)].sort())
    invariant(domains.every(values => values.length > 0), 'A structural coverage dimension has no compiled levels. Declare explicit levels to retain unavailable coverage.')
    const count = domains.reduce((count, values) => count * values.length, 1)
    invariant(coverage.length + count <= MAX_COVERAGE_CELLS, `Coverage exceeds the ${MAX_COVERAGE_CELLS}-cell budget; narrow the declared levels or dimension sets.`)
    const combinations = domains.reduce((rows, values) => rows.flatMap(row => values.map(value => [...row, value])), [[]]), cells = new Map()
    for (const combination of combinations) {
      const values = Object.fromEntries(dimensions.map((dimension, i) => [dimension, combination[i]])), index = coverage.length
      const identity = canonical(values)
      invariant(!seenCells.has(identity), 'Coverage rules overlap on the same dimension set and levels; declare disjoint scopes.')
      seenCells.add(identity)
      cells.set(canonical(combination), index)
      coverage.push({ dimension: dimensions.join(' × '), value: dimensions.length === 1 ? combination[0] : canonical(values), minimum: rule.minimum, available: 0, selected: 0,
        ...(extended ? { values, candidates: 0, excluded: {} } : {}) })
    }
    let unclassified = 0, outsideLevels = 0
    for (const row of candidates) {
      const values = dimensions.map(dimension => level(row, dimension))
      if (values.some(value => value === null)) { unclassified++; continue }
      const index = cells.get(canonical(values))
      if (index === undefined) { outsideLevels++; continue }
      membership.get(row).push(index)
      const cell = coverage[index]
      if (row.disposition === 'eligible') cell.available++
      if (extended) {
        cell.candidates++
        if (row.disposition !== 'eligible') cell.excluded[row.disposition] = (cell.excluded[row.disposition] || 0) + 1
      }
    }
    if (extended) rules.push({ dimensions, levels: Object.fromEntries(dimensions.map((dimension, i) => [dimension, domains[i]])), minimum: rule.minimum,
      cells: count, unclassifiedCandidates: unclassified, outsideDeclaredLevels: outsideLevels })
  }
  return { coverage, membership, ...(extended ? { rules } : {}) }
}

export function corpusPlanFromTask(task) {
  const { id: taskId, familyId, split, generation, ...base } = structuredClone(task)
  return { version: CORPUS_VERSION, seed: 42, selection: { kind: 'all', limit: 512 }, coverage: [{ dimension: 'family', minimum: 1 }],
    rationale: 'Draft recipe from the selected task. Review axes, exclusions, sampling and coverage before a counted study.',
    families: [{ id: familyId || taskId, split, task: base, axes: [], constraints: [] }] }
}

// Ordinary fields lower to the existing corpus recipe. The field roster is
// source-bound authoring state; it grants neither oracle validity nor review.
export const COMPOSITION_FIELD_LIMITS = Object.freeze({ candidates: MAX_CANDIDATES, axes: MAX_COVERAGE_RULES, selection: 512 })

export const PROMPT_SELECTION_METHODS = Object.freeze([
  ['all', 'All available (census)'], ['random', 'Simple random sample'],
  ['equal', 'Equal allocation across groups'], ['proportional', 'Proportional to the pool'],
  ['weighted', 'Custom allocation weights'], ['quotas', 'Exact counts per group'],
])
export const PROMPT_DIMENSIONS = Object.freeze([
  ['omission', 'Recorded omission treatment'], ['arm', 'Omission variant'],
  ['omission-ranges', 'Declared omission ranges'], ['family', 'Source family'],
  ['split', 'Development / held-out'], ['depth', 'Composition depth'],
])
export function validatePromptPoolPlan(plan) {
  invariant(plan.families.length === 0 && Array.isArray(plan.coverage) && !plan.coverage.length && !plan.fieldAuthoring && !plan.features, 'A prompt pool uses its own group allocation; it cannot also declare construction families or coverage rules.')
  fields(plan.pool, ['version', 'tasks'], 'Prompt pool')
  invariant(plan.pool.version === 1 && Array.isArray(plan.pool.tasks) && plan.pool.tasks.length > 0 && plan.pool.tasks.length <= MAX_CANDIDATES, 'Supply 1–4,096 candidate prompts.')
  distinct(plan.pool.tasks, 'Candidate prompts')
  for (const task of plan.pool.tasks) invariant(object(task.root) && ['development', 'held-out'].includes(task.split) && !task.generation, 'Each pool task needs its prompt root, split and detached source provenance.')
  const selection = plan.selection
  invariant(object(selection), 'Declare a prompt selection policy.')
  fields(selection, ['kind', 'limit', 'dimensions', 'weights'], 'Prompt selection')
  invariant(PROMPT_SELECTION_METHODS.some(([kind]) => kind === selection.kind), 'Choose a supported prompt selection method.')
  invariant(positive(selection.limit, 512), 'Select 1–512 prompts per benchmark.')
  invariant(Array.isArray(selection.dimensions) && selection.dimensions.length >= 1 && selection.dimensions.length <= 3
    && new Set(selection.dimensions).size === selection.dimensions.length
    && selection.dimensions.every(value => PROMPT_DIMENSIONS.some(([id]) => id === value) || /^factor:.{1,128}$/.test(value)), 'Choose one to three distinct grouping dimensions.')
  invariant(object(selection.weights) && Object.keys(selection.weights).length <= MAX_CANDIDATES && Object.values(selection.weights).every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9), 'Allocation values must be finite, nonnegative numbers no larger than one billion.')
  if (selection.kind === 'quotas') invariant(Object.values(selection.weights).every(Number.isSafeInteger), 'Exact group counts must be whole numbers.')
  return plan
}
const asLayers = value => value ? [value].flat() : []
export function promptDimensions(task, composition) {
  const ranges = [...asLayers(composition.omissions), ...composition.nodes.flatMap(node => asLayers(node.omissions))].reduce((count, layer) => count + layer.ranges.length, 0)
  const dimensions = { omission: ranges ? 'Omission variant' : 'No recorded omissions', arm: task.variance?.arm || (ranges ? 'Reusable omission variant' : 'No recorded omission arm'),
    'omission-ranges': ranges, family: task.familyId || task.id, split: task.split, depth: validateComposition(composition).depth }
  for (const [key, value] of Object.entries(task.factors || {})) dimensions['factor:' + key] = value
  return dimensions
}
export function promptDistribution(rows, dimensions) {
  const groups = new Map()
  for (const row of rows.filter(row => row.disposition === 'eligible' || row.disposition === 'selected' || row.disposition === 'sample-excluded')) {
    const values = dimensions.map(key => Object.hasOwn(row.dimensions, key) ? row.dimensions[key] : null), key = canonical(values)
    if (!groups.has(key)) groups.set(key, { key, values, label: values.map(value => value === null ? '(not declared)' : typeof value === 'string' && value && !/^(?:-?\d+(?:\.\d+)?|true|false|null|\(not declared\))$/.test(value) ? value : JSON.stringify(value)).join(' / '), available: 0, requested: 0, selected: 0 })
    groups.get(key).available++
  }
  return [...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}
// Fixed stratum counts, then SRS without replacement within each stratum.
// Largest remainders round fractional allocations; ties use canonical group order.
// Infeasible quotas are reported, never silently redistributed.
export function selectPromptRows(rows, selection, seed) {
  const eligible = rows.filter(row => row.disposition === 'eligible'), groups = promptDistribution(eligible, selection.dimensions), issues = []
  const count = selection.kind === 'all' ? eligible.length : selection.limit
  if (!eligible.length) issues.push('No eligible prompts are available.')
  if (count > 512) issues.push('This benchmark supports at most 512 selected prompts.')
  if (count > eligible.length) issues.push(`Requested ${count} prompts; only ${eligible.length} are available without replacement.`)
  const stratified = !['all', 'random'].includes(selection.kind)
  if (stratified && ['weighted', 'quotas'].includes(selection.kind)) {
    if (groups.some(group => !Object.hasOwn(selection.weights, group.key))) issues.push('Enter an allocation for every group, including zero for groups you intend to exclude.')
    if (Object.keys(selection.weights).some(key => !groups.some(group => group.key === key))) issues.push('The groups changed. Review and refresh the allocation values.')
  }
  if (selection.kind === 'quotas') {
    for (const group of groups) group.requested = selection.weights[group.key] ?? 0
    if (groups.reduce((sum, group) => sum + group.requested, 0) !== count) issues.push('Exact group counts must add up to the requested prompt count.')
  } else if (stratified && groups.length) {
    const weights = groups.map(group => selection.kind === 'equal' ? 1 : selection.kind === 'proportional' ? group.available : selection.weights[group.key] ?? 0)
    const total = weights.reduce((sum, value) => sum + value, 0)
    if (!(total > 0)) issues.push('At least one group must have a positive allocation weight.')
    else {
      const ideal = weights.map(value => count * value / total)
      groups.forEach((group, index) => { group.requested = Math.floor(ideal[index]) })
      const order = groups.map((_, index) => index).sort((a, b) => (ideal[b] - Math.floor(ideal[b])) - (ideal[a] - Math.floor(ideal[a])) || a - b)
      for (let left = count - groups.reduce((sum, group) => sum + group.requested, 0), index = 0; index < left; index++) groups[order[index]].requested++
    }
  }
  if (stratified) for (const group of groups) if (group.requested > group.available) issues.push(`${group.label}: requested ${group.requested}, available ${group.available}. Reduce this allocation or expand the pool.`)
  const selected = []
  if (!issues.length) {
    if (!stratified) selected.push(...(selection.kind === 'all' ? eligible : randomOrder([...eligible], seed)).slice(0, count))
    else {
      const shuffled = randomOrder([...eligible], seed)
      for (const group of groups) selected.push(...shuffled.filter(row => canonical(selection.dimensions.map(key => row.dimensions[key] ?? null)) === group.key).slice(0, group.requested))
    }
  }
  const chosen = new Set(selected.map(row => row.taskId))
  for (const group of groups) {
    group.selected = selected.filter(row => canonical(selection.dimensions.map(key => row.dimensions[key] ?? null)) === group.key).length
    if (!stratified) group.requested = selection.kind === 'all' ? group.available : null
    group.inclusionProbability = issues.length ? null : stratified ? group.selected / group.available : count / eligible.length
    group.designWeight = group.inclusionProbability ? 1 / group.inclusionProbability : null
  }
  return { groups, issues, selectedIds: selected.map(row => row.taskId), chosen,
    zeroAllocationGroups: groups.filter(group => group.selected === 0).length,
    algorithm: stratified ? 'Largest-remainder allocation (canonical ties); seeded Fisher-Yates within strata without replacement' : selection.kind === 'all' ? 'Census of eligible prompts' : 'Seeded Fisher-Yates simple random sample without replacement' }
}
async function generatePromptPool(plan, catalog, { prepareCandidate, oracle }) {
  plan = JSON.parse(canonical(plan))
  const recipeSha256 = await sha256(canonical(plan)), candidates = [], identities = new Map(), poolTasks = new Map(), families = new Map()
  const prepare = prepareCandidate || (async task => {
    const compiled = await compileTask({ domain: 'generic', catalog, protocol: { grading: { kind: 'json' } } }, task, { requireReview: false, requireTaskReview: false, validateExpected: false })
    return { task, semanticId: await semanticTaskId('generic', compiled), composition: compiled.compiled.composition, promptSha256: compiled.compiled.promptSha256 }
  })
  for (const source of plan.pool.tasks) {
    const task = structuredClone(source), familyId = task.familyId || task.id
    invariant(!families.has(familyId) || families.get(familyId) === task.split, `${familyId}: related prompts cannot cross development and held-out splits.`)
    families.set(familyId, task.split)
    const row = { taskId: task.id, familyId, choices: {}, disposition: 'eligible', reasons: [] }
    try {
      const prepared = await prepare(task)
      invariant(/^[a-f0-9]{64}$/.test(prepared.semanticId) && /^[a-f0-9]{64}$/.test(prepared.promptSha256), 'The prompt compiler must return canonical task and wording fingerprints.')
      row.semanticId = prepared.semanticId; row.promptSha256 = prepared.promptSha256
      row.dimensions = promptDimensions(task, prepared.composition)
      row.constructionSha256 = await sha256(canonical({ root: task.root, variables: task.variables || {}, input: task.input ?? null, information: task.information ?? null, promptOmissions: task.promptOmissions ?? null }))
      const prior = identities.get(row.semanticId)
      if (prior) {
        invariant(same(prior.expected ?? null, task.expected ?? null), 'Identical prompts declare different expected answers.')
        row.disposition = 'duplicate-excluded'; row.reasons.push({ duplicateOf: prior.id, reason: 'Same canonical task and input; counted once in the available pool.' })
      } else { identities.set(row.semanticId, task); poolTasks.set(task.id, task) }
    } catch (error) { row.disposition = 'construction-excluded'; row.reasons.push({ reason: error.message }) }
    candidates.push(row)
  }
  const allocation = selectPromptRows(candidates, plan.selection, plan.seed), tasks = []
  for (const id of allocation.selectedIds) {
    const row = candidates.find(row => row.taskId === id), task = poolTasks.get(id)
    task.generation = { recipeSha256, choices: {}, constructionSha256: row.constructionSha256 }
    row.taskSha256 = await sha256(canonical(task)); tasks.push(task)
  }
  for (const row of candidates) if (row.disposition === 'eligible') {
    row.disposition = allocation.chosen.has(row.taskId) ? 'selected' : 'sample-excluded'
    if (row.disposition === 'sample-excluded') row.reasons.push({ reason: allocation.issues.length ? 'Selection unavailable; inspect allocation issues.' : 'Not selected by the recorded sampling policy.' })
  }
  const eligible = candidates.filter(row => ['selected', 'sample-excluded'].includes(row.disposition))
  const manifest = { format: 'benchmark-corpus', version: CORPUS_VERSION, recipeSha256,
    catalogSha256: await sha256(canonical([...catalog].sort((a, b) => a.id < b.id ? -1 : 1).map(reviewContent))),
    status: allocation.issues.length ? 'allocation-unavailable' : 'ready', candidateCount: candidates.length, eligibleCount: eligible.length,
    uniqueWordingCount: new Set(eligible.map(row => row.promptSha256)).size, selectedCount: tasks.length,
    selection: plan.selection, seed: plan.seed, selectionAlgorithm: allocation.algorithm, oracle, coverage: [], unmetCoverage: [], candidates,
    allocation: { dimensions: plan.selection.dimensions, groups: allocation.groups, issues: allocation.issues, zeroAllocationGroups: allocation.zeroAllocationGroups,
      unit: 'One distinct task with its input; family identity and split retained.',
      probabilityScope: 'Conditional on the recorded eligible pool and fixed integer group allocations. Design weights are metadata; existing analyses do not automatically apply them.' } }
  return { tasks, manifest, manifestSha256: await sha256(canonical(manifest)) }
}
const jsonCopy = value => JSON.parse(canonical(value))
const parameterName = value => typeof value === 'string' && /^[a-z][a-zA-Z0-9_-]{0,63}$/.test(value)
const fieldText = (value, label) => { invariant(typeof value === 'string' && value.trim(), 'Enter ' + label + '.'); return value.trim() }
const fieldInteger = (value, label, minimum, maximum) => {
  invariant(typeof value === 'string' && /^\d+$/.test(value.trim()), 'Enter a whole number for ' + label + '.')
  const number = Number(value)
  invariant(Number.isSafeInteger(number) && number >= minimum && number <= maximum, label + ' is outside its supported bounds.')
  return number
}
function exactFields(value, names, label) { invariant(object(value), label + ' must be an object.'); fields(value, names, label) }
const parameterField = (value, rule = {}) => ({ kind: value === undefined ? rule.type === 'integer' ? 'number' : rule.type || 'string' : typeof value,
  text: value === undefined ? '' : String(value), present: value !== undefined })
function parameterFields(bundle, ref, variables) {
  const names = [...new Set([...Object.keys(bundle.parameters || {}), ...Object.keys(bundle.parameterSchema || {}), ...Object.keys(ref?.params || {}),
    ...Object.keys(variables || {}).filter(name => !bundle.parameterSchema || Object.hasOwn(bundle.parameterSchema, name))])].sort()
  const values = { ...(bundle.parameters || {}), ...(variables || {}), ...(ref?.params || {}) }
  return Object.fromEntries(names.map(name => [name, parameterField(values[name], bundle.parameterSchema?.[name])]))
}
const slotSignature = bundle => canonical(Object.entries(bundle.slots || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))

export async function compositionFieldInventory(spec, taskId) {
  invariant(object(spec) && Array.isArray(spec.tasks), 'Select an existing study task for the composition fields.')
  // Bind and enumerate one private JSON snapshot, including across compiler awaits.
  spec = jsonCopy(spec)
  const task = spec.tasks.find(row => row.id === taskId)
  invariant(task, 'The selected source task is unavailable.')
  const catalog = catalogMap(spec.catalog), blocking = []
  if (task.information) blocking.push({ code: 'information-recipe-required', message: 'Admissible reading roots need an explicit reading-aware task recipe. These occurrence fields do not silently edit only one reading.' })
  if (spec.experimentTemplate || task.resource) blocking.push({ code: 'resource-recipe-required', message: 'Use the generated resource experiment fields to change resource cases; composition fields cannot detach their execution contract.' })
  if (spec.auditPlan || task.audit) blocking.push({ code: 'audit-recipe-required', message: 'Use the audit recipe to change source-bound judge cases; composition fields cannot replace their reference criteria.' })
  const compiled = await compileTask(spec, task, { requireReview: false, requireTaskReview: false })
  const refs = new Map(), pending = [{ ref: task.root, path: [], requiredRole: 'node' }]
  while (pending.length) {
    const row = pending.pop(), bundle = catalog.get(row.ref.use)
    refs.set(canonical(row.path), row)
    for (const name of [...(bundle.slotOrder || Object.keys(bundle.slots || {}))].reverse())
      pending.push({ ref: row.ref.slots[name], path: [...row.path, name], requiredRole: bundle.slots[name] })
  }
  const subtreeNodes = new Map()
  for (const node of [...compiled.compiled.composition.nodes].reverse())
    subtreeNodes.set(node.path, 1 + node.ports.reduce((count, port) => count + subtreeNodes.get(port.path), 0))
  const bundles = spec.catalog.map(bundle => ({ bundleId: bundle.id, label: bundle.id + ' (' + bundle.version + ')',
    role: bundle.role || 'node', kind: bundle.kind, parameters: parameterFields(bundle, null, task.variables),
    parameterSchema: jsonCopy(bundle.parameterSchema || {}), slots: jsonCopy(bundle.slots || {}),
    slotOrder: [...(bundle.slotOrder || Object.keys(bundle.slots || {}))] }))
  const rows = compiled.compiled.composition.nodes.map(node => {
    const path = node.path.split('/').slice(1), key = canonical(path), source = refs.get(key), bundle = catalog.get(source.ref.use)
    const compatible = spec.catalog.filter(candidate => (source.requiredRole === '*' || (candidate.role || 'node') === source.requiredRole)
      && candidate.kind === bundle.kind && slotSignature(candidate) === slotSignature(bundle)).map(candidate => ({
      bundleId: candidate.id, label: candidate.id + ' (' + candidate.version + ')',
      parameters: parameterFields(candidate, candidate.id === bundle.id ? source.ref : null, task.variables),
      parameterSchema: jsonCopy(candidate.parameterSchema || {}), slotOrder: [...(candidate.slotOrder || Object.keys(candidate.slots || {}))],
    }))
    return { key, path, pathLabel: node.path, requiredRole: source.requiredRole, role: bundle.role || 'node', kind: bundle.kind,
      slots: jsonCopy(bundle.slots || {}), subtreeNodes: subtreeNodes.get(node.path),
      current: { bundleId: bundle.id, parameters: parameterFields(bundle, source.ref, task.variables) }, compatible }
  })
  const bindingSha256 = await sha256(canonical({ format: 'benchmark-composition-field-source', version: 2, task,
    domain: spec.domain, leanProfile: spec.leanProfile || null, grading: spec.protocol.grading,
    catalog: spec.catalog.map(reviewContent), inputs: spec.inputs || [], runtimeSources: spec.runtimeSources || {},
    experimentTemplate: spec.experimentTemplate || null, auditPlan: spec.auditPlan || null }))
  return { version: 2, bindingSha256, taskId, taskName: task.id, domain: spec.domain,
    familyId: task.familyId || task.id, split: task.split, seed: String(spec.protocol.seed), rows, bundles, blocking, limits: COMPOSITION_FIELD_LIMITS }
}

export function createCompositionFieldDraft(inventory) {
  invariant([1, 2].includes(inventory?.version) && Array.isArray(inventory.rows), 'Prepare a composition field roster first.')
  return jsonCopy({ version: 2, bindingSha256: inventory.bindingSha256, taskId: inventory.taskId,
    familyId: inventory.familyId, split: inventory.split, rationale: '', seed: inventory.seed,
    selection: { kind: 'all', limit: '512' }, coverage: { kind: 'marginal', minimum: '1' },
    expectedPolicy: { kind: inventory.domain === 'lean-bench' ? 'derive-lean' : '', rationale: '' },
    occurrences: inventory.rows.map((row, index) => ({ key: row.key, path: row.path, axisId: 'node-' + String(index + 1).padStart(4, '0'),
      enabled: false, choices: [{ id: 'current', ...row.current }] })) })
}

function decodeParameters(choice, option) {
  exactFields(choice.parameters, Object.keys(option.parameters), 'Local parameter fields')
  invariant(canonical(Object.keys(choice.parameters).sort()) === canonical(Object.keys(option.parameters).sort()), 'Retain every declared local parameter field, including omitted optional fields.')
  const values = []
  for (const [name, field] of Object.entries(choice.parameters)) {
    invariant(parameterName(name), 'Local parameter fields require supported parameter names.')
    exactFields(field, ['kind', 'text', 'present'], 'Parameter ' + name)
    invariant(typeof field.present === 'boolean' && typeof field.text === 'string' && ['string', 'number', 'boolean'].includes(field.kind), 'Retain the explicit type, value and inclusion state of parameter ' + name + '.')
    const rule = option.parameterSchema[name]
    if (!field.present) { invariant(!rule || rule.required === false, 'Supply required parameter ' + name + '.'); continue }
    let value = field.text
    if (field.kind === 'number') {
      invariant(field.text.trim() && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(field.text.trim()), 'Finish the numeric value for ' + name + '.')
      value = Number(field.text); invariant(Number.isFinite(value), name + ' must be finite.')
    } else if (field.kind === 'boolean') {
      invariant(['true', 'false'].includes(field.text), 'Choose true or false for ' + name + '.'); value = field.text === 'true'
    }
    if (rule) {
      invariant(rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type, name + ' differs from its declared parameter type.')
      invariant(rule.minimum === undefined || value >= rule.minimum, name + ' is below its minimum.')
      invariant(rule.maximum === undefined || value <= rule.maximum, name + ' is above its maximum.')
      invariant(rule.enum === undefined || rule.enum.some(allowed => same(allowed, value)), name + ' is outside its declared values.')
    }
    values.push([name, value])
  }
  return Object.fromEntries(values)
}

function decodeSubtreeChoice(field, requiredRole, inventory, sourceTask) {
  // Count expanded copies before cloning them. A short draft can otherwise
  // conceal thousands of copied nodes. The canonical compiler also checks the
  // complete destination's node, text, path and rendered-occurrence budgets.
  const holder = {}, pending = [{ field, requiredRole, parent: holder, key: 'root' }]
  const rows = new Map(inventory.rows.map(row => [row.key, row]))
  const bundles = new Map(inventory.bundles.map(bundle => [bundle.bundleId, bundle]))
  let nodes = 0
  while (pending.length) {
    const next = pending.pop(), field = next.field
    invariant(object(field) && ['copy', 'bundle', 'unfilled'].includes(field.kind), 'Choose how to fill every branch.')
    invariant(field.kind !== 'unfilled', 'Finish every unfilled child branch before building the recipe.')
    if (field.kind === 'copy') {
      exactFields(field, ['kind', 'path'], 'Copied branch')
      invariant(Array.isArray(field.path) && field.path.every(id), 'A copied branch needs an exact source occurrence path.')
      const row = rows.get(canonical(field.path))
      invariant(row, 'The copied branch path is not in the selected source task.')
      invariant(next.requiredRole === '*' || row.role === next.requiredRole, 'The copied branch does not satisfy its incoming role.')
      nodes += row.subtreeNodes
      invariant(nodes <= COMPOSITION_LIMITS.nodes, 'The expanded branch exceeds the ' + COMPOSITION_LIMITS.nodes + '-node composition budget.')
      next.parent[next.key] = jsonCopy(referenceAt(sourceTask, field.path))
    } else {
      exactFields(field, ['kind', 'bundleId', 'parameters', 'slots'], 'Built branch')
      const bundle = bundles.get(field.bundleId)
      invariant(bundle, 'Select an available catalog bundle for every built branch.')
      invariant(next.requiredRole === '*' || bundle.role === next.requiredRole, 'The built branch does not satisfy its incoming role.')
      exactFields(field.slots, Object.keys(bundle.slots), 'Built branch child slots')
      invariant(same(Object.keys(field.slots).sort(), Object.keys(bundle.slots).sort()), 'Fill exactly every declared child slot of the selected bundle.')
      nodes++
      invariant(nodes <= COMPOSITION_LIMITS.nodes, 'The expanded branch exceeds the ' + COMPOSITION_LIMITS.nodes + '-node composition budget.')
      const value = { use: bundle.bundleId, params: decodeParameters(field, bundle) }
      if (bundle.slotOrder.length) value.slots = Object.fromEntries(bundle.slotOrder.map(name => [name, null]))
      next.parent[next.key] = value
      for (const name of [...bundle.slotOrder].reverse()) pending.push({ field: field.slots[name], requiredRole: bundle.slots[name], parent: value.slots, key: name })
    }
  }
  return holder.root
}

export async function compileCompositionFields(spec, draft) {
  exactFields(draft, ['version', 'bindingSha256', 'taskId', 'familyId', 'split', 'rationale', 'seed', 'selection', 'coverage', 'expectedPolicy', 'occurrences'], 'Composition fields')
  spec = jsonCopy(spec); draft = jsonCopy(draft)
  invariant([1, 2].includes(draft.version), 'Use the supported composition field version.')
  const inventory = await compositionFieldInventory(spec, draft.taskId)
  invariant(draft.bindingSha256 === inventory.bindingSha256, 'The source task, input, meanings or runtime changed. Retained composition fields are stale; explicitly prepare a fresh roster.')
  invariant(!inventory.blocking.length, inventory.blocking.map(row => row.message).join(' '))
  invariant(id(draft.familyId) && ['development', 'held-out'].includes(draft.split), 'Give the generated family an identifier and explicit study split.')
  const rationale = fieldText(draft.rationale, 'the construction and selection rationale')
  exactFields(draft.selection, ['kind', 'limit'], 'Selection fields')
  invariant(['all', 'seeded', 'balanced'].includes(draft.selection.kind), 'Choose the implemented task selection policy.')
  exactFields(draft.coverage, ['kind', 'minimum'], 'Coverage fields')
  invariant(['none', 'marginal', 'pairwise'].includes(draft.coverage.kind), 'Choose no factor quotas, marginal quotas or all pairwise factor quotas.')
  exactFields(draft.expectedPolicy, ['kind', 'rationale'], 'Expected-answer policy')
  invariant(draft.expectedPolicy.kind === (spec.domain === 'lean-bench' ? 'derive-lean' : 'reuse-base'),
    spec.domain === 'lean-bench' ? 'Derive LEAN apparatus expectations through the existing domain compiler.' : 'Explicitly decide whether the source declared answer applies to every generated generic case; arbitrary semantic answers cannot be inferred from fields.')
  const expectedRationale = fieldText(draft.expectedPolicy.rationale, 'the expected-answer policy rationale')
  invariant(Array.isArray(draft.occurrences) && draft.occurrences.length === inventory.rows.length, 'Retain exactly one field row for every source occurrence.')
  const sourceTask = spec.tasks.find(task => task.id === draft.taskId), recipe = corpusPlanFromTask(sourceTask), family = recipe.families[0]
  recipe.seed = fieldInteger(draft.seed, 'the corpus seed', 0, 0xffffffff)
  recipe.rationale = rationale + '\nExpected-answer policy (' + draft.expectedPolicy.kind + '): ' + expectedRationale
  recipe.selection = { kind: draft.selection.kind, limit: fieldInteger(draft.selection.limit, 'the selected task limit', 1, 512) }
  family.id = draft.familyId; family.split = draft.split
  const keys = new Set(), active = []
  for (const occurrence of draft.occurrences) {
    exactFields(occurrence, ['key', 'path', 'axisId', 'enabled', 'choices'], 'Occurrence fields')
    const row = inventory.rows.find(candidate => candidate.key === occurrence.key)
    invariant(row && !keys.has(row.key) && canonical(occurrence.path) === canonical(row.path), 'Every occurrence path must match its exact source roster once.')
    keys.add(row.key)
    invariant(typeof occurrence.enabled === 'boolean', 'Explicitly select whether each occurrence varies.')
    if (occurrence.enabled) active.push({ occurrence, row })
  }
  invariant(active.length <= COMPOSITION_FIELD_LIMITS.axes, 'Too many independently varied occurrences for the supported recipe.')
  const structuralAxisPaths = []
  for (const { occurrence, row } of active) {
    if (!Array.isArray(occurrence.choices) || !occurrence.choices.some(choice => object(choice) && Object.hasOwn(choice, 'subtree'))) continue
    invariant(draft.version === 2, 'Explicit subtree choices require composition field version 2.')
    invariant(!active.some(other => other.row.path.length > row.path.length && row.path.every((name, i) => other.row.path[i] === name)),
      'A whole-branch choice overlaps an enabled descendant factor. Disable that descendant or include its choices explicitly inside the branch.')
    structuralAxisPaths.push({ axisId: occurrence.axisId, path: row.path })
  }
  // A parent replacement carries the original subtree. It must happen before
  // any descendant replacement, regardless of the order fields were submitted.
  active.sort((a, b) => a.row.path.length - b.row.path.length || (a.row.key < b.row.key ? -1 : a.row.key > b.row.key ? 1 : 0))
  structuralAxisPaths.sort((a, b) => a.path.length - b.path.length || (canonical(a.path) < canonical(b.path) ? -1 : canonical(a.path) > canonical(b.path) ? 1 : 0))
  let requestedAssignments = 1
  const axisPaths = []
  for (const { occurrence, row } of active) {
    invariant(id(occurrence.axisId) && !family.axes.some(axis => axis.id === occurrence.axisId), 'Every enabled occurrence needs a distinct factor identifier.')
    invariant(Array.isArray(occurrence.choices) && occurrence.choices.length > 0 && occurrence.choices.length <= 512, 'Each enabled occurrence needs 1–512 explicit choices.')
    requestedAssignments *= occurrence.choices.length
    invariant(requestedAssignments <= MAX_CANDIDATES, 'The full composition matrix exceeds the ' + MAX_CANDIDATES + '-candidate budget; no factor levels were truncated.')
    const original = referenceAt({ root: jsonCopy(sourceTask.root) }, row.path), choiceIds = new Set(), constructions = new Set()
    const choices = occurrence.choices.map(choice => {
      const structural = object(choice) && Object.hasOwn(choice, 'subtree')
      exactFields(choice, structural ? ['id', 'subtree'] : ['id', 'bundleId', 'parameters'], 'Occurrence choice')
      invariant(id(choice.id) && !choiceIds.has(choice.id), 'Each occurrence choice needs a distinct identifier.'); choiceIds.add(choice.id)
      let value
      if (structural) value = decodeSubtreeChoice(choice.subtree, row.requiredRole, inventory, sourceTask)
      else {
        const option = row.compatible.find(candidate => candidate.bundleId === choice.bundleId)
        invariant(option, 'A replacement must preserve the incoming role and exact child slot names and roles.')
        value = { use: choice.bundleId, params: decodeParameters(choice, option), ...(original.slots ? { slots: jsonCopy(original.slots) } : {}) }
      }
      const identity = canonical(value)
      invariant(!constructions.has(identity), 'Identical local choices cannot manufacture separate factor levels.'); constructions.add(identity)
      return { id: choice.id, edits: [{ kind: 'node', path: row.path, value }] }
    })
    family.axes.push({ id: occurrence.axisId, choices }); axisPaths.push({ axisId: occurrence.axisId, path: row.path, choices: choices.map(choice => choice.id) })
  }
  const minimum = fieldInteger(draft.coverage.minimum, 'the coverage minimum', 1, 512)
  recipe.coverage = [{ dimension: 'family', minimum: 1 }]
  if (draft.coverage.kind !== 'none') for (const axis of family.axes) recipe.coverage.push({ dimension: 'axis:' + axis.id, minimum })
  if (draft.coverage.kind === 'pairwise') for (let left = 0; left < family.axes.length; left++) for (let right = left + 1; right < family.axes.length; right++)
    recipe.coverage.push({ dimensions: ['axis:' + family.axes[left].id, 'axis:' + family.axes[right].id], minimum })
  validateCorpusPlan(recipe)
  return { plan: jsonCopy(recipe), inventory, construction: { sourceTaskId: draft.taskId, sourceBindingSha256: inventory.bindingSha256,
    axisPaths, structuralAxisPaths, requestedAssignments, selectedLimit: recipe.selection.limit, expectedPolicy: jsonCopy(draft.expectedPolicy),
    scope: 'Construction and structural coverage only. Generated cases still require exact source-bound controls and applicable reviews; no independent oracle, activation, native validation or study approval is inferred.' } }
}

// Assemble source families before generating once. Family-local factor labels
// cannot become pooled coverage dimensions merely because their spellings match.
export async function compileCompositionFamilyFields(spec, workspace) {
  exactFields(workspace, ['version', 'rationale', 'seed', 'selection', 'coverage', 'families'], 'Composition family workspace')
  spec = jsonCopy(spec); workspace = jsonCopy(workspace)
  invariant(workspace.version === 1, 'Use composition family workspace version 1.')
  invariant(Array.isArray(spec.tasks), 'Prepare source tasks before adding their families.')
  invariant(Array.isArray(workspace.families) && workspace.families.length > 0 && workspace.families.length <= 512,
    'Retain 1–512 explicitly prepared source families.')
  const rationale = fieldText(workspace.rationale, 'the complete corpus construction and sampling rationale')
  const seenSources = new Set(), seenSourceFamilies = new Set(), seenFamilies = new Set(), compiled = []
  let requestedAssignments = 0
  for (const entry of workspace.families) {
    exactFields(entry, ['sourceTask', 'fields'], 'Prepared source family')
    invariant(object(entry.sourceTask) && id(entry.sourceTask.id) && object(entry.fields) && entry.sourceTask.id === entry.fields.taskId,
      'Each family needs its exact source task and matching retained occurrence fields.')
    const sources = spec.tasks.filter(task => task.id === entry.sourceTask.id)
    invariant(sources.length === 1, 'An original source task is unavailable. Undo generation or open the source draft; retained source capsules cannot replace live source tasks.')
    invariant(same(sources[0], entry.sourceTask), 'An original source task changed. Retained family fields are stale; explicitly prepare that source family again.')
    const sourceFamilyId = entry.sourceTask.familyId || entry.sourceTask.id
    invariant(id(sourceFamilyId), 'Every source task needs a valid original family identity.')
    invariant(!seenSources.has(entry.sourceTask.id), 'A source task may occur only once in the family workspace.')
    invariant(!seenSourceFamilies.has(sourceFamilyId), 'Two source seeds from the same original family cannot become independent generated families. Use an explicit advanced recipe for that dependence.')
    invariant(id(entry.fields.familyId) && !seenFamilies.has(entry.fields.familyId), 'Every prepared source family needs a distinct generated family identifier.')
    seenSources.add(entry.sourceTask.id); seenSourceFamilies.add(sourceFamilyId); seenFamilies.add(entry.fields.familyId)
    // Old local policy fields remain raw authoring state, but only the explicit
    // workspace policy governs the combined sampling and coverage contract.
    const result = await compileCompositionFields(spec, { ...entry.fields, seed: workspace.seed, selection: workspace.selection, coverage: workspace.coverage })
    requestedAssignments += result.construction.requestedAssignments
    invariant(requestedAssignments <= MAX_CANDIDATES, 'The combined family corpus exceeds the ' + MAX_CANDIDATES + '-candidate construction budget; families were not truncated.')
    compiled.push({ result, sourceFamilyId })
  }
  compiled.sort((a, b) => a.result.plan.families[0].id < b.result.plan.families[0].id ? -1 : a.result.plan.families[0].id > b.result.plan.families[0].id ? 1 : 0)
  const first = compiled[0].result.plan
  const plan = { version: CORPUS_VERSION, seed: first.seed, selection: first.selection, coverage: [{ dimension: 'family', minimum: 1 }],
    rationale: rationale, families: [] }, axisMappings = [], loweredIds = new Set(), families = []
  const existingFactors = new Set(compiled.flatMap(row => Object.keys(row.result.plan.families[0].task.factors || {})))
  for (const { result, sourceFamilyId } of compiled) {
    const family = jsonCopy(result.plan.families[0]), namespace = new Map()
    for (const axis of family.axes) {
      const localId = axis.id, recipeAxisId = 'cf-' + (await sha256(canonical({ format: 'composition-family-axis', version: 1, familyId: family.id, axisId: localId }))).slice(0, 32)
      invariant(!loweredIds.has(recipeAxisId) && !existingFactors.has(recipeAxisId), 'A lowered family factor conflicts with an existing factor identity.')
      loweredIds.add(recipeAxisId); namespace.set(localId, recipeAxisId); axis.id = recipeAxisId
      const path = result.construction.axisPaths.find(row => row.axisId === localId)
      axisMappings.push({ sourceTaskId: result.construction.sourceTaskId, familyId: family.id, axisId: localId, recipeAxisId, path: path.path, choices: path.choices })
    }
    for (const rule of result.plan.coverage) {
      if (rule.dimension === 'family') continue
      // compileCompositionFields produces marginal and within-family pairwise
      // scopes only. Do not introduce cross-family cells or merge same labels.
      const renamed = dimension => 'axis:' + namespace.get(dimension.slice(5))
      plan.coverage.push(rule.dimension ? { dimension: renamed(rule.dimension), minimum: rule.minimum }
        : { dimensions: rule.dimensions.map(renamed), minimum: rule.minimum })
    }
    plan.families.push(family)
    plan.rationale += '\nFamily ' + family.id + ' from source ' + result.construction.sourceTaskId + ' (original family ' + sourceFamilyId + '):\n' + result.plan.rationale
    families.push({ sourceTaskId: result.construction.sourceTaskId, sourceFamilyId, familyId: family.id,
      sourceBindingSha256: result.construction.sourceBindingSha256, axisPaths: result.construction.axisPaths,
      structuralAxisPaths: result.construction.structuralAxisPaths, requestedAssignments: result.construction.requestedAssignments,
      expectedPolicy: result.construction.expectedPolicy })
  }
  plan.fieldAuthoring = { version: 1, families: families.map(({ sourceTaskId, sourceFamilyId, familyId, sourceBindingSha256, expectedPolicy }) =>
    ({ sourceTaskId, sourceFamilyId, familyId, sourceBindingSha256, expectedPolicy })), axisMappings }
  validateCorpusPlan(plan)
  return jsonCopy({ plan, inventories: compiled.map(row => row.result.inventory), construction: { families, axisMappings, requestedAssignments,
    selectedLimit: plan.selection.limit,
    scope: 'Family construction and within-family coverage only. Original family dependence, primary-population eligibility, exact source-bound qualification and applicable reviews remain required; no independent sampling units or scientific admission are inferred.' } })
}

export function corpusProjectFiles(project) {
  return project.corpus ? { 'corpus/recipe.json': JSON.stringify(project.spec.corpusPlan, null, 2) + '\n',
    'corpus/manifest.json': JSON.stringify(project.corpus, null, 2) + '\n',
    ...(project.spec.corpusPlan.fieldAuthoring ? { 'corpus/field-authoring.json': JSON.stringify(project.spec.corpusPlan.fieldAuthoring, null, 2) + '\n' } : {}) } : {}
}

export async function generateCorpus(plan, catalog, { resolveExpected = null, prepareCandidate = null, oracle = { kind: 'declared-answers' }, enumerateOnly = false } = {}) {
  validateCorpusPlan(plan)
  if (plan.pool) return generatePromptPool(plan, catalog, { prepareCandidate, oracle })
  // Construction is defined by the frozen JSON bytes. In-memory aliases must
  // not couple independently addressed occurrences or choice subtrees.
  plan = JSON.parse(canonical(plan)); catalog = structuredClone(catalog)
  const byId = catalogMap(catalog), candidates = [], rawIdentities = new Map(), semanticIdentities = new Map()
  for (const feature of plan.features || []) invariant(feature.bundles.every(id => byId.has(id)), `Feature ${feature.id} references an unknown catalog bundle.`)
  const needsComposition = !!plan.features?.length || plan.coverage.some(rule => ruleDimensions(rule).some(structural))
  const prepare = prepareCandidate || (async task => {
    const compiled = await compileTask({ domain: 'generic', catalog, protocol: { grading: { kind: 'json' } } }, task, { requireReview: false, requireTaskReview: false })
    return { task, semanticId: await semanticTaskId('generic', compiled), composition: compiled.compiled.composition }
  })
  const recipeSha256 = await sha256(canonical(plan))
  const catalogSha256 = await sha256(canonical([...catalog].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(reviewContent)))
  for (const family of plan.families) {
    let combinations = [[]]
    for (const axis of family.axes) combinations = combinations.flatMap(row => axis.choices.map(choice => [...row, { axis: axis.id, choice }]))
    for (const combination of combinations) {
      const choices = Object.fromEntries(combination.map(({ axis, choice }) => [axis, choice.id]))
      const identity = await sha256(canonical({ familyId: family.id, choices }))
      const taskId = `${family.id.slice(0, 30)}-${identity.slice(0, 32)}`
      const exclusions = family.constraints.filter(rule => Object.entries(rule.when).every(([axis, values]) => values.includes(choices[axis])))
      const row = { taskId, familyId: family.id, choices, disposition: 'eligible', reasons: [] }
      if (exclusions.length) {
        row.disposition = 'constraint-excluded'; row.reasons = exclusions.map(rule => ({ constraintId: rule.id, reason: rule.reason })); candidates.push(row); continue
      }
      let task = { ...structuredClone(family.task), id: taskId, familyId: family.id, split: family.split, factors: { ...(family.task.factors || {}), ...choices } }
      try {
        for (const { choice } of combination) for (const edit of choice.edits) editTask(task, edit, byId)
        typecheck(task, byId)
        if (resolveExpected) task.expected = await resolveExpected(task)
        const prepared = await prepare(task)
        invariant(object(prepared.task) && /^[a-f0-9]{64}$/.test(prepared.semanticId), 'The candidate compiler must return its task and canonical semantic identity.')
        task = prepared.task; row.semanticId = prepared.semanticId
        if (needsComposition) row.composition = compositionFeatures(prepared.composition, plan.features || [])
      } catch (error) {
        row.disposition = 'construction-excluded'; row.reasons = [{ reason: error.message }]; candidates.push(row); continue
      }
      // Eligibility and semantic aliases are resolved before sampling, through
      // the same compiler that freezes the selected tasks. No collected outcome
      // or grader score enters construction or selection.
      row.constructionSha256 = await sha256(canonical({ root: task.root, variables: task.variables || {}, input: task.input ?? null, information: task.information ?? null }))
      if (rawIdentities.has(row.constructionSha256)) {
        const prior = rawIdentities.get(row.constructionSha256)
        invariant(same(prior.task.expected ?? null, task.expected ?? null), 'Identical task constructions declare different expected answers.')
        row.disposition = 'duplicate-excluded'; row.reasons = [{ duplicateOf: prior.row.taskId, reason: 'Identical construction; use replicates for repeated measurements.' }]
      } else if (semanticIdentities.has(row.semanticId)) {
        const prior = semanticIdentities.get(row.semanticId)
        invariant(task.information || same(prior.task.expected, task.expected), 'Identical semantic tasks declare different expected answers.')
        row.disposition = 'duplicate-excluded'; row.reasons = [{ duplicateOf: prior.row.taskId, reason: 'Identical canonical task semantics and inputs; use replicates for repeated measurements.' }]
      } else { rawIdentities.set(row.constructionSha256, { row, task }); semanticIdentities.set(row.semanticId, { row, task }) }
      candidates.push(row)
    }
  }
  invariant(new Set(candidates.map(row => row.taskId)).size === candidates.length, 'Generated task identifiers collided.')
  const eligible = candidates.filter(row => row.disposition === 'eligible')
  if (enumerateOnly) {
    const manifest = { format: 'benchmark-candidate-pool', version: CORPUS_VERSION, recipeSha256, catalogSha256,
      status: eligible.length ? 'ready' : 'empty', candidateCount: candidates.length, eligibleCount: eligible.length,
      selectedCount: 0, candidates, oracle, selectionAlgorithm: 'All eligible constructions, before task-set sampling.' }
    return { tasks: eligible.map(row => structuredClone(rawIdentities.get(row.constructionSha256).task)), manifest, manifestSha256: await sha256(canonical(manifest)) }
  }
  const { coverage, membership, rules } = coverageIndex(plan, candidates)
  const pool = plan.selection.kind === 'all' ? [...eligible] : randomOrder([...eligible], plan.seed), selected = []
  if (plan.selection.kind === 'all') invariant(pool.length <= plan.selection.limit, 'All eligible candidates exceed the declared selection limit; change the recipe or sampling policy.')
  while (pool.length && selected.length < plan.selection.limit) {
    let index = 0
    if (plan.selection.kind === 'balanced') {
      const score = row => membership.get(row).reduce((sum, index) => sum + Math.max(0, coverage[index].minimum - coverage[index].selected), 0)
      let best = score(pool[0])
      for (let i = 1; i < pool.length; i++) { const value = score(pool[i]); if (value > best) { best = value; index = i } }
    }
    const [row] = pool.splice(index, 1); row.disposition = 'selected'; selected.push(row)
    for (const index of membership.get(row)) coverage[index].selected++
  }
  for (const row of pool) { row.disposition = 'sample-excluded'; row.reasons = [{ reason: 'Not selected by the frozen sampling policy.' }] }
  const tasks = []
  for (const row of selected) {
    const task = rawIdentities.get(row.constructionSha256).task
    invariant(Object.hasOwn(task, 'expected'), `${task.id}: declare its expected result or supply a pinned domain oracle.`)
    task.generation = { recipeSha256, choices: row.choices, constructionSha256: row.constructionSha256 }
    row.taskSha256 = await sha256(canonical(task)); tasks.push(task)
  }
  const unmetCoverage = coverage.filter(cell => cell.selected < cell.minimum)
  const manifest = { format: 'benchmark-corpus', version: CORPUS_VERSION, recipeSha256, catalogSha256,
    status: !tasks.length ? 'empty' : unmetCoverage.length ? 'coverage-unmet' : 'ready',
    selectionAlgorithm: { all: 'declaration order', seeded: 'seeded Fisher-Yates shuffle', balanced: 'greedy coverage deficit with seeded ties' }[plan.selection.kind],
    candidateCount: candidates.length, selectedCount: tasks.length, selection: plan.selection, oracle, coverage, unmetCoverage, candidates,
    ...(rules ? { coverageDefinition: { levelUniverse: 'Cartesian product of declared levels; composed numeric levels are observed unless explicitly requested.',
      compositionScope: 'Canonical baseline composition only; feature presence means at least one declared bundle occurs as a node, excluding dependency-only bundles. This is structural coverage, not activation or independent qualification.',
      selectionGuarantee: 'Deterministic greedy deficits with seeded ties; unmet coverage is not proof of infeasibility or optimality.', features: plan.features || [], rules } } : {}) }
  return { tasks, manifest, manifestSha256: await sha256(canonical(manifest)) }
}
