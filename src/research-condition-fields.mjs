import { canonical, invariant, object } from './benchmark/prompts.mjs'
import { observationPlanFromSpec, observationContract, IDENTITY_FIELDS } from './benchmark/observations.mjs'
import { applyWorkflowSetup } from './research-workflow-setup.mjs'
import { resetRecordedResponses } from './research-recorded-responses.mjs'

const ID = /^[a-z][a-z0-9_-]{0,63}$/
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
const PROTOCOL = ['protocol', 'conditions', 'inputs', 'environment', 'requireReview', 'decisions']
const copy = value => JSON.parse(canonical(value))
const keys = (value, allowed, label, required = allowed) => {
  invariant(object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), label + ' has missing or unsupported fields.')
}
const text = (value, label) => { invariant(typeof value === 'string', label + ' must retain text.'); return value }
const optional = value => ({ present: value !== undefined, text: typeof value === 'string' ? value : '' })
const hasOnly = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
const pathField = value => ({ mode: 'retain', mapped: Array.isArray(value), segments: Array.isArray(value)
  ? value.map(value => ({ kind: typeof value === 'number' ? 'index' : 'key', text: String(value) })) : [] })

function contextCopy(context) {
  keys(context, ['spec', 'protocolFields', 'workflow', 'observationPlan', 'sourceText'], 'Condition fields context', ['spec', 'protocolFields', 'workflow', 'observationPlan'])
  keys(context.protocolFields, PROTOCOL, 'Condition protocol fields')
  keys(context.workflow, ['plan', 'assignments'], 'Condition workflow context')
  invariant(object(context.spec) && Array.isArray(context.protocolFields.conditions) && object(context.workflow.assignments), 'Retain the study and current condition roster/assignments.')
  invariant(context.observationPlan === null || object(context.observationPlan), 'Accounting must be a plan or explicit null.')
  if (context.sourceText !== undefined) {
    keys(context.sourceText, ['conditions', 'workflow', 'observations'], 'Condition source text')
    Object.values(context.sourceText).forEach(value => text(value, 'Source editor'))
  }
  return copy(context)
}
export function conditionFieldsBinding(context) { return canonical(contextCopy(context)) }

function blankModel() {
  return { mode: 'fields', present: false, identity: Object.fromEntries(IDENTITY_FIELDS.map(key => [key, optional(undefined)])), settingsPresent: false, settings: [] }
}
function modelFields(model) {
  const result = blankModel()
  if (!object(model) || Object.hasOwn(model, 'settings') && !object(model.settings)) return { ...result, mode: 'retain' }
  result.present = true
  result.identity = Object.fromEntries(IDENTITY_FIELDS.map(key => [key, optional(model[key])]))
  result.settingsPresent = Object.hasOwn(model, 'settings')
  result.settings = Object.entries(model.settings || {}).map(([key, value]) => ({ key,
    type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    text: typeof value === 'string' ? value : canonical(value) }))
  return result
}
function supportedCollection(collection, condition) {
  const workflow = !!condition.workflowId
  return hasOnly(collection, ['comparisonUnit', 'instructions', 'tools', 'contextConstruction', 'sessionIsolation'])
    && collection.comparisonUnit === 'model' && Array.isArray(collection.tools) && !collection.tools.length
    && hasOnly(collection.instructions, ['system', 'developer']) && ['system', 'developer'].every(key => Object.hasOwn(collection.instructions, key)
      && (collection.instructions[key] === null || typeof collection.instructions[key] === 'string'))
    && collection.contextConstruction === (workflow ? 'frozen-workflow-projection' : 'frozen-public-request')
    && collection.sessionIsolation === (workflow ? 'fresh-call-requested' : 'fresh-request')
}
function advancedReason(condition) {
  if (!hasOnly(condition, ['id', 'label', 'model', 'adapter', 'collection', 'workflowId'])) return 'Unknown condition fields are retained in expert JSON.'
  if (condition.label !== undefined && typeof condition.label !== 'string') return 'The advanced label is retained in expert JSON.'
  const adapter = condition.adapter
  if (!['replay', 'command', 'http'].includes(adapter?.kind)) return 'This collector remains an exact advanced configuration.'
  const allowed = adapter.kind === 'replay' ? ['kind', 'mode', 'responses', 'workflowResponses']
    : adapter.kind === 'command' ? ['kind', 'command', 'args', 'env', 'credentialEnv'] : ['kind', 'url', 'credentialEnv']
  if (!hasOnly(adapter, allowed)) return 'Unknown adapter fields are retained in expert JSON.'
  if (adapter.kind === 'replay' && (!object(adapter.responses) || adapter.mode !== undefined && !['output', 'envelope'].includes(adapter.mode)
    || adapter.workflowResponses !== undefined && !object(adapter.workflowResponses))) return 'Unfinished recorded adapter values are retained in expert JSON.'
  if (adapter.kind === 'http' && (typeof adapter.url !== 'string' || adapter.credentialEnv !== undefined && typeof adapter.credentialEnv !== 'string')) return 'Unfinished endpoint values are retained in expert JSON.'
  if (adapter.kind === 'command' && (typeof adapter.command !== 'string' || !Array.isArray(adapter.args) || !adapter.args.every(arg => typeof arg === 'string')
    || adapter.env !== undefined && !(Array.isArray(adapter.env) && adapter.env.every(name => typeof name === 'string'))
    || adapter.credentialEnv !== undefined && typeof adapter.credentialEnv !== 'string')) return 'Unfinished local command values are retained in expert JSON.'
  if (object(condition.model) && (!hasOnly(condition.model, [...IDENTITY_FIELDS, 'settings'])
    || IDENTITY_FIELDS.some(key => condition.model[key] !== undefined && typeof condition.model[key] !== 'string'))) return 'Unknown requested-model fields are retained in expert JSON.'
  if (condition.collection !== undefined && !supportedCollection(condition.collection, condition)) return 'Advanced collection/tool declarations are retained without changing their admission scope.'
  return ''
}
function checksFields(context, condition) {
  const standard = observationPlanFromSpec()
  let contract = standard
  if (context.observationPlan) {
    try { contract = observationContract({ ...context.spec, ...context.protocolFields, observationPlan: context.observationPlan }, condition) }
    catch { throw new Error('The accounting draft cannot be resolved. Preserve and complete its expert JSON before preparing condition fields.') }
  }
  return { identityMode: 'retain', identityPolicy: contract.identity?.policy || 'record', identityFields: copy(contract.identity?.fields || ['provider', 'id']),
    completionMode: 'retain', completionPolicy: contract.completion?.policy || 'record',
    paths: { provider: pathField(contract.mapping?.identity?.provider), id: pathField(contract.mapping?.identity?.id), status: pathField(contract.mapping?.completion?.status) } }
}
function rowFor(context, condition, key) {
  const reason = advancedReason(condition), adapter = condition.adapter || {}, collection = condition.collection
  const workflowId = Object.hasOwn(context.workflow.assignments, condition.id) ? context.workflow.assignments[condition.id] : condition.workflowId ?? null
  invariant(workflowId === null || typeof workflowId === 'string', 'Retain an explicit workflow ID or null for ' + condition.id + '.')
  return { key, sourceId: condition.id, baseId: condition.id, id: condition.id, label: optional(condition.label),
    profile: reason ? 'advanced' : adapter.kind, advancedReason: reason, model: modelFields(condition.model),
    adapter: { mode: adapter.mode || 'absent', url: typeof adapter.url === 'string' ? adapter.url : '', credentialEnv: optional(adapter.credentialEnv),
      command: typeof adapter.command === 'string' ? adapter.command : '', args: Array.isArray(adapter.args) ? copy(adapter.args) : [],
      env: { present: adapter.env !== undefined, names: Array.isArray(adapter.env) ? copy(adapter.env) : [] },
      responsesText: canonical(adapter.responses ?? {}), workflowResponses: { present: adapter.workflowResponses !== undefined, text: canonical(adapter.workflowResponses ?? {}) } },
    workflowId: workflowId ?? '', collection: { mode: adapter.kind === 'http' && supportedCollection(collection, condition) ? 'http' : 'retain',
      ...Object.fromEntries(['system', 'developer'].map(key => [key, { kind: typeof collection?.instructions?.[key] === 'string' ? 'text' : 'null', text: typeof collection?.instructions?.[key] === 'string' ? collection.instructions[key] : '' }])) },
    checks: checksFields(context, condition) }
}
export function createConditionFieldsDraft(context) {
  const current = contextCopy(context), ids = new Set()
  invariant(current.protocolFields.conditions.length <= 32, 'Condition fields support at most 32 conditions.')
  const rows = current.protocolFields.conditions.map((condition, index) => {
    invariant(object(condition) && ID.test(condition.id) && !ids.has(condition.id), 'Every source condition needs a distinct lowercase ID before preparing fields.')
    ids.add(condition.id); return rowFor(current, condition, 'row-' + index)
  })
  return { version: 1, binding: canonical(current), createObservationPlan: false, rows }
}
function checked(context, draft) {
  const current = contextCopy(context)
  keys(draft, ['version', 'binding', 'createObservationPlan', 'rows'], 'Condition fields draft')
  invariant(draft.version === 1 && draft.binding === canonical(current), 'Condition fields are stale: the source study or expert editor text changed. Prepare fields explicitly; your current text is preserved.')
  invariant(typeof draft.createObservationPlan === 'boolean' && Array.isArray(draft.rows) && draft.rows.length <= 32, 'Retain at most 32 condition rows and an explicit accounting setup choice.')
  const keysSeen = new Set(), sourceIds = new Set(), originals = new Map(current.protocolFields.conditions.map(row => [row.id, row]))
  for (const row of draft.rows) {
    keys(row, ['key', 'sourceId', 'baseId', 'id', 'label', 'profile', 'advancedReason', 'model', 'adapter', 'workflowId', 'collection', 'checks'], 'Condition row')
    invariant(typeof row.key === 'string' && row.key && !keysSeen.has(row.key), 'Condition editor keys must be distinct.'); keysSeen.add(row.key)
    invariant(row.baseId === null || originals.has(row.baseId), 'The retained condition configuration is missing.')
    invariant(row.sourceId === null || originals.has(row.sourceId) && row.baseId === row.sourceId && row.id === row.sourceId && !sourceIds.has(row.sourceId), 'Existing condition IDs are read-only in ordinary fields. Use coordinated expert JSON to rename them.')
    if (row.sourceId !== null) sourceIds.add(row.sourceId)
    invariant(['replay', 'command', 'http', 'advanced'].includes(row.profile), 'Choose recorded replay, a local command or the HTTPS frozen-request profile.')
  }
  return { current, next: structuredClone(draft), originals }
}
function selected(draft, key) { const row = draft.rows.find(row => row.key === key); invariant(row, 'Select a current condition row.'); return row }
function newId(current, draft, id) {
  invariant(typeof id === 'string' && ID.test(id), 'Enter a lowercase condition ID (letters, digits, hyphens or underscores, at most 64 characters).')
  invariant(!draft.rows.some(row => row.id === id) && !current.protocolFields.conditions.some(row => row.id === id), 'Choose a new condition ID; existing IDs cannot be reused or renamed through ordinary fields.')
}
const nextKey = draft => { let index = 0; while (draft.rows.some(row => row.key === 'row-' + index)) index++; return 'row-' + index }
export function addConditionFieldsRow(context, draft, { id, profile }) {
  const { current, next } = checked(context, draft); newId(current, next, id)
  invariant(['replay', 'command', 'http'].includes(profile) && next.rows.length < 32, 'Explicitly choose recorded replay, a local command or HTTPS; the roster is limited to 32 conditions.')
  const blank = { replay: { kind: 'replay', responses: {} }, command: { kind: 'command', command: '', args: [] }, http: { kind: 'http', url: '' } }
  const condition = { id, adapter: blank[profile] }
  const row = rowFor(current, condition, nextKey(next)); row.sourceId = null; row.baseId = null
  row.model = blankModel()
  // A live collector names the model it requests; a recorded one does not.
  if (profile !== 'replay') { row.model.present = true; row.model.identity.provider.present = true; row.model.identity.id.present = true }
  if (profile === 'http') row.collection.mode = 'http'
  next.rows.push(row); return next
}
export function duplicateConditionFieldsRow(context, draft, key, id) {
  const { current, next } = checked(context, draft); newId(current, next, id)
  invariant(next.rows.length < 32, 'The condition roster is limited to 32 conditions.')
  const row = structuredClone(selected(next, key)); row.key = nextKey(next); row.sourceId = null; row.id = id
  row.adapter.responsesText = '{}'; if (row.adapter.workflowResponses.present) row.adapter.workflowResponses.text = '{}'
  next.rows.push(row); return next
}
export function conditionFieldsReferences(context, draft, key) {
  const { current, next } = checked(context, draft), row = selected(next, key), references = []
  for (const contrast of current.spec.analysisPlan?.contrasts || []) if ([contrast.first, contrast.second].includes(row.id)) references.push('analysisPlan.contrasts.' + (contrast.id || '(unnamed)'))
  for (const workflow of current.workflow.plan?.workflows || []) if (row.workflowId === workflow.id && !next.rows.some(other => other.key !== key && other.workflowId === workflow.id)) references.push('workflowPlan.workflows.' + workflow.id + ' (last assignment)')
  return references
}
export function removeConditionFieldsRow(context, draft, key) {
  const { next } = checked(context, draft), references = conditionFieldsReferences(context, draft, key)
  invariant(!references.length, 'Cannot remove this condition: ' + references.join(', ') + '. Resolve these references through coordinated expert editing.')
  selected(next, key); next.rows = next.rows.filter(row => row.key !== key); return next
}
export function setConditionFieldsProfile(context, draft, key, profile) {
  const { next } = checked(context, draft), row = selected(next, key)
  invariant(row.profile !== 'advanced' && ['replay', 'command', 'http'].includes(profile), 'Advanced collector configurations must be changed through expert JSON.')
  row.profile = profile
  row.adapter = { mode: 'absent', url: '', credentialEnv: optional(undefined), command: '', args: [], env: { present: false, names: [] }, responsesText: '{}', workflowResponses: { present: false, text: '{}' } }
  row.collection.mode = profile === 'http' ? 'http' : 'retain'
  return next
}
export function editConditionFieldsModel(context, draft, key) {
  const { next } = checked(context, draft), row = selected(next, key)
  invariant(row.profile !== 'advanced', 'The advanced model configuration is retained in expert JSON.')
  row.model = blankModel(); row.model.present = true; return next
}
export function requireConditionFieldsChecks(context, draft, key) {
  const { current, next } = checked(context, draft), row = selected(next, key)
  invariant(row.profile !== 'advanced', 'The advanced accounting configuration is retained in expert JSON.')
  if (!current.observationPlan) next.createObservationPlan = true
  row.checks.identityMode = 'set'; row.checks.identityPolicy = 'require-match'
  row.checks.identityFields = [...new Set(['provider', 'id', ...row.checks.identityFields])]
  row.checks.completionMode = 'set'; row.checks.completionPolicy = 'require-complete'
  for (const [name, standard] of Object.entries({ provider: ['identity', 'provider'], id: ['identity', 'id'], status: ['completion', 'status'] })) {
    const value = row.checks.paths[name]
    if (!value.mapped || !value.segments.length) row.checks.paths[name] = pathField(standard)
    row.checks.paths[name].mode = 'set'
  }
  return next
}

function optionalValue(field, label) {
  keys(field, ['present', 'text'], label); invariant(typeof field.present === 'boolean', label + ' needs an explicit presence choice.')
  text(field.text, label); return field.present ? field.text : undefined
}
function settingValue(field) {
  keys(field, ['key', 'type', 'text'], 'Model setting'); text(field.key, 'Setting key'); text(field.text, 'Setting value')
  invariant(field.key.length > 0, 'Enter a model setting key.')
  if (field.type === 'string') return field.text
  if (field.type === 'null') return null
  if (field.type === 'boolean') { invariant(['true', 'false'].includes(field.text), field.key + ': choose true or false.'); return field.text === 'true' }
  if (field.type === 'number') { invariant(NUMBER.test(field.text) && Number.isFinite(Number(field.text)), field.key + ': enter one complete finite JSON number; unfinished text is preserved.'); return Number(field.text) }
  invariant(['array', 'object'].includes(field.type), field.key + ': choose a setting type.')
  let value; try { value = JSON.parse(field.text) } catch { throw new Error(field.key + ': the setting must be valid JSON; its text is preserved.') }
  invariant(field.type === 'array' ? Array.isArray(value) : object(value), field.key + ': the JSON value must match its selected type.')
  return copy(value)
}
function compileModel(condition, fields) {
  keys(fields, ['mode', 'present', 'identity', 'settingsPresent', 'settings'], 'Requested model fields')
  invariant(['retain', 'fields'].includes(fields.mode), 'Choose retained or typed model fields.')
  if (fields.mode === 'retain') return
  invariant(typeof fields.present === 'boolean' && typeof fields.settingsPresent === 'boolean', 'Declare model and settings presence.')
  if (!fields.present) { delete condition.model; return }
  keys(fields.identity, IDENTITY_FIELDS, 'Requested identity fields')
  const model = Object.fromEntries(IDENTITY_FIELDS.map(key => [key, optionalValue(fields.identity[key], key)]).filter(([, value]) => value !== undefined))
  if (fields.settingsPresent) {
    invariant(Array.isArray(fields.settings), 'Retain typed setting rows.')
    const pairs = fields.settings.map(field => [field.key, settingValue(field)])
    invariant(new Set(pairs.map(([key]) => key)).size === pairs.length, 'Model setting keys must be distinct; duplicate text is preserved.')
    model.settings = Object.fromEntries(pairs)
  }
  condition.model = model
}
function responseMap(value, label) {
  text(value, label); let decoded
  try { decoded = JSON.parse(value) } catch { throw new Error(label + ' must be valid JSON; your text is preserved.') }
  invariant(object(decoded), label + ' must be an object keyed by task ID.'); return copy(decoded)
}
function mappedPath(field, label) {
  keys(field, ['mode', 'mapped', 'segments'], label)
  invariant(['retain', 'set', 'inherit'].includes(field.mode) && typeof field.mapped === 'boolean' && Array.isArray(field.segments), label + ': retain explicit path choices.')
  if (!field.mapped) return null
  invariant(field.segments.length > 0 && field.segments.length <= 16, label + ': declare 1–16 literal path segments.')
  return field.segments.map(segment => {
    keys(segment, ['kind', 'text'], label + ' segment'); text(segment.text, label)
    if (segment.kind === 'key') { invariant(segment.text.length > 0 && segment.text.length <= 128, label + ': enter a nonempty property key of at most 128 characters.'); return segment.text }
    invariant(segment.kind === 'index' && /^(?:0|[1-9]\d*)$/.test(segment.text) && Number.isSafeInteger(Number(segment.text)), label + ': enter a nonnegative integer array index.')
    return Number(segment.text)
  })
}
function applyChecks(plan, condition, checks) {
  keys(checks, ['identityMode', 'identityPolicy', 'identityFields', 'completionMode', 'completionPolicy', 'paths'], 'Returned report checks')
  keys(checks.paths, ['provider', 'id', 'status'], 'Returned report paths')
  for (const mode of [checks.identityMode, checks.completionMode, ...Object.values(checks.paths).map(path => path.mode)]) invariant(['retain', 'set', 'inherit'].includes(mode), 'Choose retained, explicit or inherited report checks.')
  const changed = checks.identityMode !== 'retain' || checks.completionMode !== 'retain' || Object.values(checks.paths).some(path => path.mode !== 'retain')
  if (!changed) return
  invariant(plan, 'Explicitly start an accounting plan before applying returned report checks.')
  const override = copy(Object.hasOwn(plan.overrides || {}, condition.id) ? plan.overrides[condition.id] : {})
  for (const [group, mode, value] of [['identity', checks.identityMode, { policy: checks.identityPolicy, fields: checks.identityFields }], ['completion', checks.completionMode, { policy: checks.completionPolicy }]]) {
    if (mode === 'set') override[group] = copy(value)
    else if (mode === 'inherit') delete override[group]
  }
  for (const [name, group, key] of [['provider', 'identity', 'provider'], ['id', 'identity', 'id'], ['status', 'completion', 'status']]) {
    const field = checks.paths[name]
    if (field.mode === 'set') { override.mapping ||= {}; override.mapping[group] ||= {}; override.mapping[group][key] = mappedPath(field, name + ' path') }
    if (field.mode === 'inherit' && override.mapping?.[group]) {
      delete override.mapping[group][key]
      if (!Object.keys(override.mapping[group]).length) delete override.mapping[group]
      if (!Object.keys(override.mapping).length) delete override.mapping
    }
  }
  plan.overrides ||= {}
  if (Object.keys(override).length) Object.defineProperty(plan.overrides, condition.id, { value: override, enumerable: true, configurable: true, writable: true })
  else delete plan.overrides[condition.id]
}
export function compileConditionFields(context, draft) {
  const { current, next, originals } = checked(context, draft), ids = new Set()
  invariant(next.rows.length > 0, 'Keep at least one condition before applying.')
  const retainedSources = new Set(next.rows.map(row => row.sourceId).filter(id => id !== null))
  for (const id of originals.keys()) if (!retainedSources.has(id)) for (const contrast of current.spec.analysisPlan?.contrasts || [])
    invariant(![contrast.first, contrast.second].includes(id), 'Cannot remove ' + id + ': analysisPlan.contrasts.' + (contrast.id || '(unnamed)') + ' still references it.')
  const observationPlan = current.observationPlan ? copy(current.observationPlan) : next.createObservationPlan ? observationPlanFromSpec() : null
  if (observationPlan?.overrides) for (const id of originals.keys()) if (!retainedSources.has(id)) delete observationPlan.overrides[id]
  const conditions = next.rows.map(row => {
    invariant(typeof row.id === 'string' && ID.test(row.id) && !ids.has(row.id), 'Every condition needs a distinct lowercase ID.')
    invariant(row.sourceId !== null || !originals.has(row.id), 'A new row cannot reuse an existing condition ID.'); ids.add(row.id)
    let condition = row.baseId === null ? { id: row.id } : copy(originals.get(row.baseId))
    if (row.sourceId === null && row.baseId !== null) condition = resetRecordedResponses([condition])[0]
    condition.id = row.id
    const label = optionalValue(row.label, 'Condition label')
    if (row.profile === 'advanced' && condition.label !== undefined && typeof condition.label !== 'string')
      invariant(canonical(row.label) === canonical(optional(condition.label)), 'The advanced label must remain exact; edit its expert JSON.')
    else if (label !== undefined) condition.label = label; else delete condition.label
    if (row.baseId !== null && advancedReason(originals.get(row.baseId))) invariant(row.profile === 'advanced', 'Advanced source configurations must remain exact; use expert JSON to replace them.')
    if (row.profile === 'advanced') invariant(row.baseId !== null && advancedReason(originals.get(row.baseId)), 'An advanced row needs its retained advanced source configuration.')
    else {
      compileModel(condition, row.model)
      keys(row.adapter, ['mode', 'url', 'credentialEnv', 'command', 'args', 'env', 'responsesText', 'workflowResponses'], 'Collector fields')
      if (row.profile === 'replay') {
        invariant(['absent', 'output', 'envelope'].includes(row.adapter.mode), 'Choose the exact recorded response interpretation.')
        const adapter = { kind: 'replay', responses: responseMap(row.adapter.responsesText, 'Recorded responses') }
        if (row.adapter.mode !== 'absent') adapter.mode = row.adapter.mode
        keys(row.adapter.workflowResponses, ['present', 'text'], 'Recorded workflow fixtures')
        invariant(typeof row.adapter.workflowResponses.present === 'boolean', 'Declare whether the workflow response map is present.')
        if (row.adapter.workflowResponses.present) adapter.workflowResponses = responseMap(row.adapter.workflowResponses.text, 'Recorded workflow responses')
        condition.adapter = adapter
      } else if (row.profile === 'command') {
        const credential = optionalValue(row.adapter.credentialEnv, 'Credential environment variable')
        invariant(credential === undefined || /^[A-Z][A-Z0-9_]{0,99}$/.test(credential),
          'Name the credential environment variable in capitals, such as EXAMPLE_CREDENTIAL.')
        const command = text(row.adapter.command, 'Command')
        invariant(command.trim().length > 0, 'Name the command this collector runs.')
        invariant(Array.isArray(row.adapter.args), 'The command argument list must be a list of exact arguments.')
        row.adapter.args.forEach((arg, index) => invariant(typeof arg === 'string', 'Command argument ' + (index + 1) + ' must be exact text.'))
        keys(row.adapter.env, ['present', 'names'], 'Command environment allowlist')
        invariant(typeof row.adapter.env.present === 'boolean', 'Declare whether the command environment allowlist is present.')
        invariant(Array.isArray(row.adapter.env.names), 'The command environment allowlist must be a list of variable names.')
        invariant(row.adapter.env.present || row.adapter.env.names.length === 0, 'Remove every environment variable name before turning its list off.')
        for (const name of row.adapter.env.names) invariant(typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(name),
          'A command environment allowlist names variables in capitals, such as HOME.')
        condition.adapter = { kind: 'command', command, args: copy(row.adapter.args),
          ...(row.adapter.env.present ? { env: copy(row.adapter.env.names) } : {}),
          ...(credential === undefined ? {} : { credentialEnv: credential }) }
      } else {
        const credential = optionalValue(row.adapter.credentialEnv, 'Credential environment variable')
        condition.adapter = { kind: 'http', url: text(row.adapter.url, 'HTTPS endpoint'), ...(credential === undefined ? {} : { credentialEnv: credential }) }
      }
      keys(row.collection, ['mode', 'system', 'developer'], 'Collection fields')
      invariant(['retain', 'http'].includes(row.collection.mode), 'Choose retained or explicit public collection controls.')
      if (row.collection.mode === 'http') {
        const instructions = Object.fromEntries(['system', 'developer'].map(key => {
          const field = row.collection[key]; keys(field, ['kind', 'text'], key + ' instruction')
          invariant(['null', 'text'].includes(field.kind), 'Choose explicit null or exact instruction text.'); text(field.text, key + ' instruction')
          return [key, field.kind === 'null' ? null : field.text]
        }))
        condition.collection = { comparisonUnit: 'model', instructions, tools: [], contextConstruction: row.workflowId ? 'frozen-workflow-projection' : 'frozen-public-request', sessionIsolation: row.workflowId ? 'fresh-call-requested' : 'fresh-request' }
      }
    }
    invariant(typeof row.workflowId === 'string' && (row.workflowId === '' || ID.test(row.workflowId)), 'Choose an existing workflow ID or explicit no workflow.')
    if (row.workflowId) condition.workflowId = row.workflowId; else delete condition.workflowId
    if (observationPlan && row.sourceId === null && row.baseId !== null && Object.hasOwn(current.observationPlan?.overrides || {}, row.baseId)) observationPlan.overrides[row.id] = copy(current.observationPlan.overrides[row.baseId])
    if (row.profile !== 'advanced') applyChecks(observationPlan, condition, row.checks)
    return condition
  })
  const setup = { protocolFields: { ...current.protocolFields, conditions }, workflow: { plan: current.workflow.plan, assignments: Object.fromEntries(conditions.map(condition => [condition.id, condition.workflowId ?? null])) }, observationPlan }
  applyWorkflowSetup(current.spec, setup)
  return copy(setup)
}
