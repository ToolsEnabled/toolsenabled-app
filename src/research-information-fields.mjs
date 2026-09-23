// The composition root, imported for its registration side effect: a module
// that ASKS the registry a question must make sure the shipped benchmarks are
// loaded, or it will refuse every domain including lean-bench.
import './benchmark/plugins.mjs'
import { gradingKind, isRegisteredDomain } from './benchmark/registry.mjs'
import { canonical, compilePrompt, invariant, object, sha256 } from './benchmark/prompts.mjs'
import { validateInformation } from './benchmark/information.mjs'
import { compileTask, deriveTaskExpected } from './benchmark/tasks.mjs'

const ID = /^[a-z][a-z0-9_-]{0,63}$/
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const copy = value => JSON.parse(canonical(value))
const own = (value, key) => Object.hasOwn(value, key)
const fields = (value, names, label) => invariant(object(value) && Object.keys(value).length === names.length
  && names.every(key => own(value, key)), label + ' has missing or unsupported fields.')
const text = (value, label) => { invariant(typeof value === 'string', label + ' must retain text.'); return value }
const required = (value, label) => { text(value, label); invariant(value.trim(), 'Enter ' + label + '.'); return value }
const validId = value => typeof value === 'string' && ID.test(value)
const pathKey = (path, name) => canonical([path, name])

function referenceAt(root, path) {
  let ref = root
  for (const slot of path) {
    invariant(object(ref?.slots) && own(ref.slots, slot), 'The selected reading occurrence no longer exists.')
    ref = ref.slots[slot]
  }
  invariant(object(ref) && typeof ref.use === 'string', 'The selected reading occurrence needs a node reference.')
  return ref
}

function assertSource(spec, taskId) {
  invariant(object(spec) && Array.isArray(spec.tasks) && Array.isArray(spec.catalog), 'Select a study task before preparing information fields.')
  const matches = spec.tasks.filter(task => task.id === taskId)
  invariant(matches.length === 1, 'Select one existing task with a unique identifier.')
  const task = matches[0]
  invariant(!spec.corpusPlan, 'Detach the generated task recipe before authoring information fields, or edit its advanced recipe.')
  invariant(!spec.auditPlan && !task.audit, 'Use the audit recipe for source-bound judge tasks.')
  invariant(!spec.experimentTemplate && !task.resource, 'Use the resource template fields for generated resource tasks.')
  // The domain allowlist is the registry's, not a literal pair. A third copy of
  // that pair in the page's draft importer already refused third-party drafts
  // after study.mjs was opened; this was the fourth, and it refused them from
  // authoring information fields.
  //
  // The GRADING list was the same defect one layer down: it carried a vertical's
  // own contract ('lean-python') as a literal, so a benchmark's declared
  // contract was refused HERE even once tasks.mjs admitted it -- and this editor
  // compiles through compileTask, so the two disagreeing means the page refuses
  // a treatment the compiler would accept. Both now ask the same question.
  const contract = gradingKind(spec.protocol?.grading?.kind)
  invariant((spec.domain === 'generic' || isRegisteredDomain(spec.domain))
    && (['exact', 'json'].includes(spec.protocol?.grading?.kind) || contract?.supportsInformation === true),
    'Information fields require exact or JSON grading, or a registered grading contract that declares it can carry an information treatment.')
  return task
}

// This inventory is UI authoring state. It does not remove an information
// treatment to bypass the ordinary corpus editor's reading-aware design gate.
export async function informationFieldInventory(spec, taskId) {
  spec = copy(spec)
  const task = assertSource(spec, taskId)
  if (task.information) validateInformation(task.information)
  const baseline = { root: copy(task.root), ...(own(task, 'variables') ? { variables: copy(task.variables) } : {}),
    ...(own(task, 'expected') ? { expected: copy(task.expected) } : {}) }
  const sources = [{ key: 'baseline', label: 'Baseline task', reading: baseline },
    ...(task.information?.readings || task.information?.readingPool || []).map(reading => ({ key: 'reading:' + reading.id, label: reading.label || reading.id, reading: copy(reading) }))]
  let atoms = []
  for (const source of sources) {
    const variables = { ...(task.variables || {}), ...(source.reading.variables || {}) }
    const compiled = await compilePrompt(spec.catalog, source.reading.root, { variables, requireReview: false })
    source.parameters = []
    for (const node of compiled.composition.nodes) {
      const path = node.path.split('/').slice(1), bundle = spec.catalog.find(bundle => bundle.id === node.bundle.id)
      const names = [...new Set([...Object.keys(node.parameters), ...Object.keys(bundle.parameterSchema || {})])].sort()
      for (const name of names) {
        const value = node.parameters[name], type = bundle.parameterSchema?.[name]?.type
        const kind = value === undefined ? type === 'integer' ? 'number' : type : typeof value
        invariant(['string', 'number', 'boolean'].includes(kind), 'A local information-reading parameter needs a supported scalar type.')
        source.parameters.push({ key: pathKey(path, name), path, pathLabel: node.path, name, kind,
          text: value === undefined ? '' : String(value), present: value !== undefined })
      }
    }
    if (source.key === 'baseline') atoms = compiled.composition.nodes.filter(node => node.kind === 'atom')
      .map(node => ({ path: node.path, segments: node.path.split('/').slice(1), bundleId: node.bundle.id, role: node.role }))
  }
  return copy({ version: 1, bindingSha256: await sha256(canonical({ format: 'benchmark-information-field-source', version: 1, taskId, spec })),
    taskId, domain: spec.domain, gradingKind: spec.protocol.grading.kind, familyId: task.familyId || task.id,
    initialInformation: task.information || null, atoms, sources })
}

function sourceRow(inventory, source, key, original = false) {
  const reading = source.reading
  return { key, sourceKey: source.key, id: original ? reading.id : '', label: own(reading, 'label') ? reading.label : null,
    rationale: original ? reading.rationale : '', expected: { mode: 'retained', text: own(reading, 'expected')
      ? inventory.gradingKind === 'exact' && typeof reading.expected === 'string' ? reading.expected : canonical(reading.expected) : '' },
    conventionsText: own(reading, 'conventions') ? canonical(reading.conventions) : null, edits: [] }
}

export function createInformationFieldDraft(inventory) {
  invariant(inventory?.version === 1 && Array.isArray(inventory.sources), 'Prepare the information source inventory first.')
  const initial = inventory.initialInformation
  return copy({ version: 1, bindingSha256: inventory.bindingSha256, taskId: inventory.taskId, familyId: inventory.familyId,
    rationale: initial?.rationale || '', responseMode: initial?.responseMode || 'raw', selection: initial && own(initial, 'readingPool') ? 'readingPool' : 'readings',
    withheldPaths: initial?.withheldPaths || [], readings: inventory.sources.filter(source => source.key !== 'baseline')
      .map((source, index) => sourceRow(inventory, source, 'reading-' + (index + 1), true)) })
}

function assertDraft(inventory, draft) {
  fields(draft, ['version', 'bindingSha256', 'taskId', 'familyId', 'rationale', 'responseMode', 'selection', 'withheldPaths', 'readings'], 'Information fields')
  invariant(draft.version === 1 && draft.bindingSha256 === inventory.bindingSha256 && draft.taskId === inventory.taskId,
    'Information fields are stale: the source task, specification, context, catalog or runtime changed. Explicitly prepare a fresh source; retained text is unchanged.')
  invariant(Array.isArray(draft.readings) && draft.readings.length <= 64, 'Retain at most 64 declared reading rows.')
}

export function addInformationFieldReading(inventory, draft, sourceKey) {
  inventory = copy(inventory); draft = copy(draft)
  assertDraft(inventory, draft)
  invariant(draft.readings.length < 64, 'The information treatment supports at most 64 readings.')
  const source = inventory.sources.find(source => source.key === sourceKey)
  invariant(source, 'Explicitly choose an available baseline or original reading source.')
  let index = 1
  while (draft.readings.some(row => row.key === 'reading-' + index)) index++
  draft.readings.push(sourceRow(inventory, source, 'reading-' + index))
  return draft
}

function scalarEdit(edit, parameter) {
  invariant(edit.kind === parameter.kind, 'The local parameter edit must retain its source scalar type.')
  const raw = text(edit.text, 'Local parameter value')
  if (edit.kind === 'string') return raw
  if (edit.kind === 'boolean') {
    invariant(['true', 'false'].includes(raw), 'Choose true or false for the local parameter.')
    return raw === 'true'
  }
  invariant(edit.kind === 'number' && NUMBER.test(raw.trim()) && Number.isFinite(Number(raw)), 'Finish the finite numeric local parameter value.')
  return Number(raw)
}

export async function compileInformationFields(spec, draft) {
  spec = copy(spec); draft = copy(draft)
  const inventory = await informationFieldInventory(spec, draft.taskId)
  assertDraft(inventory, draft)
  invariant(validId(draft.familyId), 'Give the information task an explicit family identifier.')
  required(draft.rationale, 'the information-treatment rationale')
  invariant(['raw', 'tagged-json'].includes(draft.responseMode) && ['readings', 'readingPool'].includes(draft.selection), 'Choose the supported response format and reading selection rule.')
  invariant(Array.isArray(draft.withheldPaths) && new Set(draft.withheldPaths).size === draft.withheldPaths.length
    && draft.withheldPaths.every(path => inventory.atoms.some(atom => atom.path === path)), 'Choose each withheld baseline atom occurrence once; templates and unknown paths cannot be withheld.')
  invariant(draft.readings.length > 0, 'Explicitly add at least one reading source and supply its fields.')
  const originalTask = spec.tasks.find(task => task.id === draft.taskId), readings = [], keys = new Set(), ids = new Set()
  for (const row of draft.readings) {
    fields(row, ['key', 'sourceKey', 'id', 'label', 'rationale', 'expected', 'conventionsText', 'edits'], 'Information reading fields')
    invariant(validId(row.key) && !keys.has(row.key) && validId(row.id) && !ids.has(row.id), 'Reading row keys and declared IDs must be distinct complete identifiers.')
    keys.add(row.key); ids.add(row.id)
    const source = inventory.sources.find(source => source.key === row.sourceKey)
    invariant(source, 'The original reading source is unavailable; its identity cannot be inferred.')
    const reading = copy(source.reading)
    reading.id = row.id; reading.rationale = required(row.rationale, 'the reading rationale')
    invariant(row.label === null || typeof row.label === 'string', 'The reading label must be text or explicitly absent.')
    if (row.label === null) delete reading.label; else reading.label = row.label
    invariant(row.conventionsText === null || typeof row.conventionsText === 'string', 'Retain conventions text or explicit absence.')
    if (row.conventionsText === null) delete reading.conventions
    else {
      try { reading.conventions = JSON.parse(row.conventionsText) } catch { throw new Error('Conventions must be valid JSON; your text is retained.') }
      canonical(reading.conventions)
    }
    invariant(Array.isArray(row.edits), 'Retain a list of explicit local parameter edits.')
    const edited = new Set()
    for (const edit of row.edits) {
      fields(edit, ['path', 'parameter', 'kind', 'text'], 'Local reading edit')
      invariant(Array.isArray(edit.path) && edit.path.every(validId) && typeof edit.parameter === 'string', 'Select an exact occurrence and local parameter.')
      const key = pathKey(edit.path, edit.parameter), parameter = source.parameters.find(parameter => parameter.key === key)
      invariant(parameter && !edited.has(key), 'Each local edit must name one distinct existing source occurrence and parameter.')
      edited.add(key)
      const ref = referenceAt(reading.root, edit.path)
      // Computed own keys preserve JSON parameter names such as __proto__;
      // assignment into a new {} must not invoke an inherited setter.
      ref.params = { ...(ref.params || {}), [edit.parameter]: scalarEdit(edit, parameter) }
    }
    fields(row.expected, ['mode', 'text'], 'Expected-observation fields')
    text(row.expected.text, 'Expected observation')
    if (row.expected.mode === 'retained') invariant(canonical(reading.root) === canonical(source.reading.root),
      'This reading changed. Explicitly declare a fresh expected observation or choose the supported LEAN derivation; a source answer cannot be reused silently.')
    else if (row.expected.mode === 'declare') {
      if (inventory.gradingKind === 'exact') reading.expected = row.expected.text
      else {
        try { reading.expected = JSON.parse(row.expected.text) } catch { throw new Error('Declare one valid JSON expected observation; your text is retained.') }
        canonical(reading.expected)
      }
    } else if (row.expected.mode === 'derive-lean') {
      invariant(inventory.domain === 'lean-bench', 'Only the supported LEAN interpreter can derive this expected observation; generic readings require an explicit declaration.')
      reading.expected = await deriveTaskExpected(spec, { ...originalTask, root: reading.root, variables: { ...(originalTask.variables || {}), ...(reading.variables || {}) } })
    } else throw new Error('Choose retained, declare, or supported LEAN derivation for the expected observation.')
    readings.push(reading)
  }
  const task = { ...copy(originalTask), familyId: draft.familyId, information: { version: 1, scope: 'declared-set', rationale: draft.rationale,
    responseMode: draft.responseMode, withheldPaths: copy(draft.withheldPaths), [draft.selection]: readings } }
  validateInformation(task.information)
  const compiled = await compileTask(spec, task, { requireReview: false, requireTaskReview: false })
  return { task: copy(task), compiled: copy(compiled), inventory }
}
