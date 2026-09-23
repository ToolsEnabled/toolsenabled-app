import {
  conditionFieldsBinding, addConditionFieldsRow, duplicateConditionFieldsRow, removeConditionFieldsRow,
  setConditionFieldsProfile, editConditionFieldsModel, requireConditionFieldsChecks, conditionFieldsReferences,
} from './research-condition-fields.mjs'

const copy = value => structuredClone(value)
const rows = value => Array.isArray(value) ? value : []
const json = value => JSON.stringify(value, null, 2)
const identityFields = ['provider', 'id', 'version', 'surface', 'fingerprint']
const modelNames = { provider: 'provider', id: 'model-id', version: 'version', surface: 'surface', fingerprint: 'fingerprint' }

// A draft editor only: conversion and coupled workflow/accounting validation
// stay in the shared authoring helper. No request or account operation occurs.
export function createConditionFieldsEditor({ onChange = () => {} } = {}) {
  let context = null, draft = null, contextKey = null, selected = '', newId = '', newProfile = '', duplicateId = ''
  let disabled = false, readOnly = false, stale = false, destroyed = false, revision = 0, message = ''
  const el = document.createElement('div')
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
  const mark = (node, name, value = '') => { node.setAttribute('data-condition-fields-' + name, value); return node }
  const focusKey = (node, key) => mark(node, 'focus', key)
  mark(el, 'editor')
  const editable = () => !destroyed && !disabled && !readOnly && !stale && context !== null && draft !== null
  const currentRow = () => rows(draft?.rows).find(row => row.key === selected)
  const emit = () => { if (!destroyed) onChange(copy(draft)) }
  const label = (title, input) => { const node = make('label'); node.append(make('span', title), input); return node }
  const section = (title, name, value = '') => { const node = mark(make('fieldset'), name, value); node.append(make('legend', title)); return node }
  const canUse = (node, at, mutate = true) => !destroyed && !disabled && at === revision && el.contains(node) && !node.disabled && (!mutate || editable())
  const lock = (node, value) => { if (value) mark(node, 'locked'); return node }
  function bind(input, update, { redraw = false, publish = true, mutate = true } = {}) {
    const at = revision
    input.addEventListener('input', event => {
      event.stopPropagation()
      if (!canUse(input, at, mutate)) return
      try {
        update(input.type === 'checkbox' ? input.checked : input.value)
        message = ''
        if (redraw) render(); else refreshRoster()
        if (publish) emit()
      } catch (error) { message = error.message; render() }
    })
    input.addEventListener('change', event => event.stopPropagation())
  }
  function field(title, name, value, update, { multiline = false, unavailable = false, key = name, publish = true, mutate = true } = {}) {
    const input = focusKey(mark(make(multiline ? 'textarea' : 'input'), name), key)
    input.setAttribute('aria-label', title)
    if (multiline) input.setAttribute('rows', '3')
    else { input.type = 'text'; input.setAttribute('type', 'text') }
    input.value = value ?? ''; lock(input, unavailable); bind(input, update, { publish, mutate })
    return label(title, input)
  }
  function select(title, name, value, options, update, { redraw = true, unavailable = false, key = name, publish = true, mutate = true } = {}) {
    const input = focusKey(mark(make('select'), name), key), choices = [...options]
    if (!choices.some(([id]) => id === value)) choices.unshift([value ?? '', value ? String(value) + ' (retained value)' : 'Choose a value'])
    for (const [id, title] of choices) { const option = make('option', title); option.value = id; option.setAttribute('value', id); input.append(option) }
    input.value = value ?? ''; input.setAttribute('aria-label', title); lock(input, unavailable)
    if (!mutate) mark(input, 'navigation')
    bind(input, update, { redraw, publish, mutate }); return label(title, input)
  }
  function checkbox(title, name, value, update, { unavailable = false, key = name, redraw = true, token } = {}) {
    const input = focusKey(mark(make('input'), name), key); input.type = 'checkbox'; input.setAttribute('type', 'checkbox')
    input.checked = value === true; input.setAttribute('aria-label', title)
    if (token !== undefined) { input.value = token; input.setAttribute('value', token) }
    lock(input, unavailable); bind(input, update, { redraw }); return label(title, input)
  }
  function button(title, name, action, { unavailable = false, key = name } = {}) {
    const node = focusKey(mark(make('button', title), name), key), at = revision
    node.type = 'button'; node.setAttribute('type', 'button'); lock(node, unavailable)
    node.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (!canUse(node, at)) return
      try { action(); message = ''; render(); emit() } catch (error) { message = error.message; render() }
    })
    return node
  }
  function optional(title, name, value) {
    const node = make('div')
    node.append(checkbox('Include ' + title, name + '-present', value.present, next => { value.present = next }),
      field(title, name, value.text, next => { value.text = next }, { unavailable: !value.present }))
    return node
  }
  function syncDisabled() {
    for (const tag of ['input', 'select', 'textarea', 'button']) for (const node of el.querySelectorAll(tag)) {
      node.disabled = disabled || node.hasAttribute('data-condition-fields-locked') || (!node.hasAttribute('data-condition-fields-navigation') && !editable())
    }
  }
  function refreshRoster() {
    const roster = el.querySelector('[data-condition-fields-row]')
    if (!roster) return
    roster.replaceChildren()
    for (const row of rows(draft?.rows)) {
      const title = (row.id || '(new condition)') + (row.label?.present && row.label.text ? ' — ' + row.label.text : '')
      const option = make('option', title); option.value = row.key; option.setAttribute('value', row.key); roster.append(option)
    }
    roster.value = selected
    // A literal-path text edit explicitly creates an override. Reflect that
    // scope without replacing the focused text field or its cursor.
    for (const section of el.querySelectorAll('[data-condition-fields-path]')) {
      const mode = currentRow()?.checks?.paths?.[section.getAttribute('data-condition-fields-path')]?.mode
      const input = section.querySelector('[data-condition-fields-path-mode]')
      if (input && mode) input.value = mode
    }
  }
  function retainedPreview(row) {
    return rows(context?.protocolFields?.conditions).find(item => item.id === (row.baseId || row.sourceId)) ?? null
  }
  function modelEditor(row) {
    const node = section('Requested model', 'model')
    node.append(make('p', 'These fields declare the requested identity and settings. Returned report checks below compare what the response reports; these declarations do not establish what executed.'))
    if (row.model.mode === 'retain') {
      node.append(make('p', 'The imported model is retained exactly. Choose an explicit replacement to edit it through ordinary fields.'),
        make('pre', json(retainedPreview(row)?.model)), button('Replace retained model with editable fields', 'model-edit', () => { draft = editConditionFieldsModel(context, draft, row.key) }))
      return node
    }
    node.append(checkbox('Include requested model', 'model-present', row.model.present, next => { row.model.present = next }))
    const fields = section('Identity fields', 'identity')
    for (const name of identityFields) fields.append(optional('Requested ' + (name === 'id' ? 'model ID' : name), modelNames[name], row.model.identity[name]))
    if (!row.model.present) for (const tag of ['input', 'select', 'textarea', 'button']) for (const control of fields.querySelectorAll(tag)) lock(control, true)
    node.append(fields, checkbox('Include model settings', 'settings-present', row.model.settingsPresent, next => { row.model.settingsPresent = next }, { unavailable: !row.model.present }))
    const settings = section('Typed settings', 'settings')
    settings.append(make('p', 'Numbers, booleans, null and strings are distinct. Incomplete text stays in this draft until Apply. Array and object values use JSON for that setting only.'))
    rows(row.model.settings).forEach((setting, index) => {
      const item = section('Setting ' + (index + 1), 'setting-row'), key = row.key + ':setting:' + index
      item.append(field('Setting key', 'setting-key', setting.key, next => { setting.key = next }, { key: key + ':key' }),
        select('Setting type', 'setting-type', setting.type, [['', 'Choose a type'], ...['string', 'number', 'boolean', 'null', 'array', 'object'].map(type => [type, type])], next => { setting.type = next }, { key: key + ':type' }))
      if (setting.type === 'boolean') item.append(select('Boolean value', 'setting-text', setting.text, [['', 'Choose a value'], ['true', 'true'], ['false', 'false']], next => { setting.text = next }, { key: key + ':text', redraw: false }))
      else if (setting.type === 'null') item.append(make('p', 'Explicit null. No value text is exported.'))
      else item.append(field(setting.type === 'array' || setting.type === 'object' ? 'Setting JSON value' : 'Setting value', 'setting-text', setting.text, next => { setting.text = next },
        { key: key + ':text', multiline: ['array', 'object'].includes(setting.type), unavailable: !setting.type }))
      item.append(button('Remove setting', 'remove-setting', () => row.model.settings.splice(index, 1), { key: key + ':remove' })); settings.append(item)
    })
    settings.append(button('Add setting', 'add-setting', () => row.model.settings.push({ key: '', type: '', text: '' })))
    if (!row.model.present || !row.model.settingsPresent) for (const tag of ['input', 'select', 'textarea', 'button']) for (const control of settings.querySelectorAll(tag)) lock(control, true)
    node.append(settings); return node
  }
  function workflowEditor(row) {
    const workflows = rows(context?.workflow?.plan?.workflows)
    return select('Assigned workflow', 'workflow-id', row.workflowId, [['', 'No workflow'], ...workflows.map(workflow => [workflow.id, workflow.id])], next => { row.workflowId = next })
  }
  function replayEditor(row) {
    const node = section('Recorded responses', 'replay')
    node.append(select('Response interpretation', 'replay-mode', row.adapter.mode, [['absent', 'Output (mode omitted)'], ['output', 'Output (explicit)'], ['envelope', 'Wrapped reply (output plus usage and tool logs)']], next => { row.adapter.mode = next }),
      field('Recorded response map by task ID', 'responses', row.adapter.responsesText, next => { row.adapter.responsesText = next }, { multiline: true }),
      make('p', 'Supply your own saved responses. The form does not create answers, reported identity, usage or tool logs. Empty maps do not establish successful diagnostic evidence.'), workflowEditor(row))
    if (row.workflowId) node.append(make('p', 'An assigned recorded workflow requires the wrapped-reply setting and an explicit task/stage response map. Selecting a workflow does not fill either field.'))
    node.append(checkbox('Include a workflow stage response map', 'stage-map-present', row.adapter.workflowResponses.present, next => { row.adapter.workflowResponses.present = next }),
      field('Recorded stage responses by task ID and stage ID', 'workflow-responses', row.adapter.workflowResponses.text, next => { row.adapter.workflowResponses.text = next }, { multiline: true, unavailable: !row.adapter.workflowResponses.present }),
      button('Initialize empty stage response map', 'initialize-stage-map', () => { row.adapter.workflowResponses.present = true; row.adapter.workflowResponses.text = '{}' }, { unavailable: row.adapter.workflowResponses.present }),
      make('p', 'Removing a workflow does not remove this map. Explicitly remove the map when it no longer applies.'))
    return node
  }
  function commandEditor(row) {
    const node = section('Local command program', 'command-collector')
    node.append(make('p', 'The runner starts this program for each collection request. It writes the frozen request JSON to standard input. It reads an object containing output from standard output. Attach programs carried with the project under Project files so the export records their hashes. No command is started by these fields.'),
      field('Command', 'command', row.adapter.command, next => { row.adapter.command = next }),
      make('p', 'Name the program only, such as node. Arguments go in the list below, one entry each, exactly as the program receives them. No shell expansion happens.'))
    const args = section('Arguments', 'args')
    rows(row.adapter.args).forEach((value, index) => {
      const item = section('Argument ' + (index + 1), 'arg-row'), key = row.key + ':arg:' + index
      item.append(field('Argument ' + (index + 1), 'arg', value, next => { row.adapter.args[index] = next }, { key: key + ':text' }),
        button('Remove argument', 'remove-arg', () => row.adapter.args.splice(index, 1), { key: key + ':remove' }))
      args.append(item)
    })
    args.append(button('Add argument', 'add-arg', () => row.adapter.args.push('')))
    node.append(args)
    const env = section('Environment allowlist', 'env')
    env.append(make('p', 'Name additional variables the program needs, in capitals, such as HOME. The runner also passes PATH, SystemRoot, WINDIR, TMPDIR, TEMP and TMP when available, plus any separately named credential variable. These fields store names, not their values. Remove every variable row before turning this list off.'),
      checkbox('Declare an environment allowlist', 'env-present', row.adapter.env.present, next => { row.adapter.env.present = next },
        { unavailable: row.adapter.env.present && rows(row.adapter.env.names).length > 0 }))
    const names = section('Variable names', 'env-names')
    rows(row.adapter.env.names).forEach((value, index) => {
      const item = section('Variable ' + (index + 1), 'env-row'), key = row.key + ':env:' + index
      item.append(field('Variable name ' + (index + 1), 'env-name', value, next => { row.adapter.env.names[index] = next }, { key: key + ':text' }),
        button('Remove variable', 'remove-env', () => row.adapter.env.names.splice(index, 1), { key: key + ':remove' }))
      names.append(item)
    })
    names.append(button('Add variable name', 'add-env', () => row.adapter.env.names.push('')))
    if (!row.adapter.env.present) for (const tag of ['input', 'select', 'textarea', 'button']) for (const control of names.querySelectorAll(tag)) lock(control, true)
    env.append(names); node.append(env)
    node.append(checkbox('Use a credential environment variable', 'credential-present', row.adapter.credentialEnv.present, next => { row.adapter.credentialEnv.present = next }),
      field('Credential environment-variable name', 'credential-env', row.adapter.credentialEnv.text, next => { row.adapter.credentialEnv.text = next }, { unavailable: !row.adapter.credentialEnv.present }),
      make('p', 'Enter the variable name only. The runner resolves its value at execution.'), workflowEditor(row),
      make('p', 'Existing collection declarations are retained. Use Conditions (JSON) to declare or change instructions, tools and context; these command fields do not change them.'))
    return node
  }
  function httpEditor(row) {
    const node = section('HTTPS frozen-request endpoint', 'http')
    node.append(make('p', 'This endpoint must accept the exported frozen-request JSON and return an object containing output. It is not a provider-native chat API profile. No endpoint is contacted by these fields.'),
      field('HTTPS endpoint URL', 'url', row.adapter.url, next => { row.adapter.url = next }),
      checkbox('Use a credential environment variable', 'credential-present', row.adapter.credentialEnv.present, next => { row.adapter.credentialEnv.present = next }),
      field('Credential environment-variable name', 'credential-env', row.adapter.credentialEnv.text, next => { row.adapter.credentialEnv.text = next }, { unavailable: !row.adapter.credentialEnv.present }),
      make('p', 'Enter the variable name only. The runner resolves its value at execution.'), workflowEditor(row),
      select('Requested collection controls', 'collection-mode', row.collection.mode, [['retain', 'Retain the existing collection declaration'], ['http', 'Use the visible frozen-request controls']], next => { row.collection.mode = next }))
    if (row.collection.mode === 'retain') node.append(make('p', 'Existing instructions, tools and context declarations are retained exactly. Existing admission blockers still apply.'), make('pre', json(retainedPreview(row)?.collection)))
    else {
      node.append(make('p', 'Requested comparison unit: model. Exposed tools: none ([]). Context: ' + (row.workflowId ? 'the selected workflow supplies each stage’s real instructions and the output passed down to it. The request is frozen and every call starts fresh.' : 'frozen-public-request; session isolation: fresh-request.')))
      for (const name of ['system', 'developer']) node.append(select('Requested ' + name + ' instruction kind', name + '-kind', row.collection[name].kind, [['null', 'Explicit null'], ['text', 'Text']], next => { row.collection[name].kind = next }),
        field('Requested ' + name + ' instruction', name, row.collection[name].text, next => { row.collection[name].text = next }, { multiline: true, unavailable: row.collection[name].kind === 'null' }))
    }
    return node
  }
  const modes = [['retain', 'Keep the current value unchanged'], ['set', 'Override for this condition'], ['inherit', 'Use the shared plan value']]
  function pathEditor(row, name, title) {
    const path = row.checks.paths[name], node = section(title, 'path', name), group = name === 'status' ? 'completion' : 'identity'
    const inherited = path.mode === 'inherit', shared = context?.observationPlan?.mapping?.[group]?.[name]
    const displayed = inherited ? { mapped: Array.isArray(shared), segments: rows(shared).map(value => ({ kind: typeof value === 'number' ? 'index' : 'key', text: String(value) })) } : path
    node.append(select('Path scope', 'path-mode', path.mode, modes, next => { path.mode = next }, { key: name + ':mode' }),
      checkbox('This reported value has a mapping', 'path-mapped', displayed.mapped, next => { path.mapped = next; path.mode = 'set' }, { unavailable: inherited, key: name + ':mapped' }))
    if (inherited) node.append(make('p', 'Displayed shared mapping; no condition override will remain for this path.'))
    rows(displayed.segments).forEach((segment, index) => {
      const item = mark(make('div'), 'path-segment'), key = name + ':' + index
      item.append(select('Path segment type', 'segment-kind', segment.kind, [['key', 'Literal object key'], ['index', 'Array index']], next => { segment.kind = next; path.mode = 'set' }, { key: key + ':kind', unavailable: inherited || !displayed.mapped }),
        field('Path segment', 'segment-text', segment.text, next => { segment.text = next; path.mode = 'set' }, { key: key + ':text', unavailable: inherited || !displayed.mapped }),
        button('Remove segment', 'remove-segment', () => { path.segments.splice(index, 1); path.mode = 'set' }, { key: key + ':remove', unavailable: inherited || !displayed.mapped }))
      node.append(item)
    })
    node.append(button('Add path segment', 'add-segment', () => { path.segments.push({ kind: 'key', text: '' }); path.mode = 'set' }, { key: name + ':add', unavailable: inherited || !displayed.mapped }))
    if (!displayed.mapped) node.append(make('p', 'Explicitly unmapped: this observation will stay empty. Turn on “This reported value has a mapping” to map it. No returned value is inferred.'))
    return node
  }
  function checksEditor(row) {
    const node = section('Checks of returned reports', 'checks'), checks = row.checks
    const shared = context?.observationPlan, identityInherited = checks.identityMode === 'inherit', completionInherited = checks.completionMode === 'inherit'
    const identity = identityInherited && shared ? shared.identity : { policy: checks.identityPolicy, fields: checks.identityFields }
    const completion = completionInherited && shared ? shared.completion : { policy: checks.completionPolicy }
    node.append(make('p', 'These checks compare reported identity and completion against the frozen request. They do not authenticate a provider or prove that requested model settings were enforced.'),
      button('Use required external experiment checks', 'require-checks', () => { draft = requireConditionFieldsChecks(context, draft, row.key) }))
    if (!shared) node.append(make('p', draft.createObservationPlan ? 'Apply will explicitly stage a new shared accounting plan. Inspect its full proposed mappings and rationale in the Accounting preview. No usage, price or returned identity is invented.' : 'No shared accounting plan is present. The required-checks action explicitly proposes one; merely opening these fields creates none.'))
    node.append(select('Identity rule scope', 'identity-mode', checks.identityMode, modes, next => { checks.identityMode = next }),
      select('Reported identity policy', 'identity-policy', identity.policy, [['record', 'Record the report'], ['require-match', 'Require matching reported identity']], next => { checks.identityPolicy = next; checks.identityMode = 'set' }, { unavailable: identityInherited }))
    for (const name of identityFields) node.append(checkbox('Compare reported ' + (name === 'id' ? 'model ID' : name), 'identity-field', rows(identity.fields).includes(name), next => {
      checks.identityFields = next ? [...new Set([...checks.identityFields, name])] : checks.identityFields.filter(field => field !== name); checks.identityMode = 'set'
    }, { token: name, key: 'compare:' + name, unavailable: identityInherited }))
    node.append(select('Completion rule scope', 'completion-mode', checks.completionMode, modes, next => { checks.completionMode = next }),
      select('Reported generation policy', 'completion-policy', completion.policy, [['record', 'Record reported completion'], ['require-complete', 'Require complete generation']], next => { checks.completionPolicy = next; checks.completionMode = 'set' }, { unavailable: completionInherited }),
      make('p', 'Mappings use literal path segments. A key containing a dot is one key; an array index is a separate typed segment.'))
    node.append(pathEditor(row, 'provider', 'Reported provider path'), pathEditor(row, 'id', 'Reported model ID path'), pathEditor(row, 'status', 'Reported completion status path'))
    const retained = make('details'); retained.append(make('summary', 'Retained accounting mappings and estimates'),
      make('p', 'Shared settings, other identity paths, usage and cost mappings, estimates and sibling overrides remain unchanged unless explicitly edited in Accounting.'),
      make('pre', json(shared ? { sharedPlan: shared, selectedOverride: shared.overrides?.[row.sourceId || row.id] ?? null } : null)))
    node.append(retained); return node
  }
  function renderContent() {
    revision++; el.replaceChildren()
    const text = !draft ? 'Prepare condition fields from the current protocol, workflow and accounting editors.'
      : stale ? 'These fields are stale. The source editors changed; prepare fields explicitly before applying. Retained values remain inspectable.'
        : readOnly ? 'Condition fields are read-only. You can inspect another condition without changing the draft.'
          : 'Configure the requested conditions, then apply the complete setup. Fields do not establish scientific admission or independent qualification.'
    el.append(mark(make('p', text), 'status'), mark(make('p', message), 'error'))
    el.querySelector('[data-condition-fields-error]').setAttribute('role', 'status')
    if (!draft) return
    if (!rows(draft.rows).some(row => row.key === selected)) selected = draft.rows[0]?.key || ''
    const roster = section('Condition roster', 'roster')
    roster.append(select('Condition to inspect', 'row', selected, rows(draft.rows).map(row => [row.key, row.id || '(new condition)']), next => { selected = next; duplicateId = '' }, { publish: false, mutate: false }),
      field('New condition ID', 'new-id', newId, next => { newId = next }, { publish: false }),
      select('New collector profile', 'new-profile', newProfile, [['', 'Choose a collector'], ['replay', 'Recorded responses'], ['command', 'Local command program'], ['http', 'HTTPS frozen-request endpoint']], next => { newProfile = next }, { publish: false }),
      button('Add condition', 'add', () => { draft = addConditionFieldsRow(context, draft, { id: newId, profile: newProfile }); selected = draft.rows.at(-1).key; newId = ''; newProfile = '' }, { unavailable: rows(draft.rows).length >= 32 }))
    el.append(roster)
    const row = currentRow()
    if (!row) { el.append(make('p', 'Add at least one condition before applying.')); return }
    let references = []
    try { references = conditionFieldsReferences(context, draft, row.key) } catch (error) { references = [error.message] }
    roster.append(field('New ID for duplicated configuration', 'duplicate-id', duplicateId, next => { duplicateId = next }, { publish: false }),
      button('Duplicate configuration', 'duplicate', () => { draft = duplicateConditionFieldsRow(context, draft, row.key, duplicateId); selected = draft.rows.at(-1).key; duplicateId = '' }, { unavailable: rows(draft.rows).length >= 32 }),
      make('p', 'Duplication clears only the new condition’s saved response maps. It creates no observed results or qualification.'),
      button('Remove selected draft condition', 'remove', () => { draft = removeConditionFieldsRow(context, draft, row.key); selected = draft.rows[0]?.key || '' }, { unavailable: references.length > 0 }))
    if (references.length) roster.append(mark(make('p', 'Removal is blocked by: ' + references.join('; ') + '. Resolve these references through the coordinated expert editors.'), 'references'))
    else roster.append(make('p', 'Removing a source condition stages removal of only its own accounting override and roster assignment. Apply the setup to publish that change; Undo restores the previous draft.'))
    const identity = section('Condition identity', 'condition')
    identity.append(field('Condition ID', 'id', row.id, next => { row.id = next }, { unavailable: row.sourceId !== null }))
    const source = retainedPreview(row), advancedLabel = row.profile === 'advanced' && source && Object.hasOwn(source, 'label') && typeof source.label !== 'string'
    if (advancedLabel) identity.append(make('p', 'The advanced display label is retained exactly. Edit its expert JSON to replace it.'), make('pre', json(source.label)))
    else identity.append(optional('Display label', 'label', row.label))
    if (row.sourceId !== null) identity.append(make('p', 'Existing IDs remain fixed in ordinary fields. Use coordinated expert JSON to rename a referenced condition.'))
    el.append(identity)
    if (row.profile === 'advanced') {
      el.append(mark(make('p', 'Retained advanced configuration: ' + row.advancedReason + '. Ordinary model, collector and report edits are unavailable; use the expert editors to replace this configuration.'), 'advanced'), make('pre', json(retainedPreview(row))))
      return
    }
    el.append(select('Collector profile', 'profile', row.profile, [['replay', 'Recorded responses'], ['command', 'Local command program'], ['http', 'HTTPS frozen-request endpoint']], profile => { draft = setConditionFieldsProfile(context, draft, row.key, profile) }),
      modelEditor(row), row.profile === 'http' ? httpEditor(row) : row.profile === 'command' ? commandEditor(row) : replayEditor(row), checksEditor(row))
  }
  function render({ restoreFocus = true } = {}) {
    if (destroyed) return
    const active = document.activeElement, key = el.contains(active) ? active.getAttribute('data-condition-fields-focus') : null
    const start = active?.selectionStart, end = active?.selectionEnd
    renderContent(); refreshRoster(); syncDisabled()
    if (restoreFocus && key !== null) {
      const next = [...el.querySelectorAll('[data-condition-fields-focus]')].find(node => node.getAttribute('data-condition-fields-focus') === key)
      if (next && !next.disabled) { next.focus({ preventScroll: true }); if (typeof start === 'number' && typeof next.setSelectionRange === 'function') next.setSelectionRange(start, end) }
    }
  }
  render()
  return {
    el, getDraft: () => copy(draft),
    setContext(next = {}) {
      if (destroyed) return
      const changedKey = (next.contextKey ?? null) !== contextKey
      let nextStale = next.stale === true
      if (next.context && next.draft) { try { nextStale ||= conditionFieldsBinding(next.context) !== next.draft.binding } catch { nextStale = true } }
      else if (next.draft) nextStale = true
      const same = !changedKey && nextStale === stale && (next.readOnly === true) === readOnly
        && JSON.stringify(next.context ?? null) === JSON.stringify(context) && JSON.stringify(next.draft ?? null) === JSON.stringify(draft)
      if (same) { syncDisabled(); return }
      contextKey = next.contextKey ?? null; context = copy(next.context ?? null); draft = copy(next.draft ?? null)
      stale = nextStale; readOnly = next.readOnly === true; message = ''
      if (changedKey || !draft) { selected = ''; newId = ''; newProfile = ''; duplicateId = '' }
      render({ restoreFocus: !changedKey })
    },
    setDisabled(value) { const next = value === true; if (disabled !== next) { disabled = next; render() } else syncDisabled() },
    destroy() { destroyed = true; context = null; draft = null; selected = ''; newId = ''; newProfile = ''; duplicateId = ''; revision++; el.replaceChildren() },
  }
}
