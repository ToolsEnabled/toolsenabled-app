import { requirementValueField } from './benchmark/requirement-fields.mjs'

const copy = value => structuredClone(value)
const rows = value => Array.isArray(value) ? value : []
const scalar = kind => kind === 'null' ? { kind } : { kind, text: '' }

// A retained field draft is separate from the compiled plan. No assertion,
// activation choice, independence claim or personal approval is inferred here.
export function createRequirementFieldsEditor({ onChange = () => {} } = {}) {
  let inventory = null, draft = null, selected = '', disabled = false, destroyed = false
  const el = document.createElement('div')
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
  const mark = (node, name) => { node.setAttribute('data-requirement-fields-' + name, ''); return node }
  mark(el, 'editor')
  const emit = () => { if (!destroyed) onChange(copy(draft)) }
  const label = (title, input) => { const node = make('label'); node.append(make('span', title), input); return node }
  const bind = (input, update, redraw, notify = true) => {
    input.addEventListener('input', event => {
      event.stopPropagation(); if (disabled || input.disabled || destroyed) return
      update(input.value); if (notify) emit(); if (redraw) render()
    })
    input.addEventListener('change', event => event.stopPropagation())
  }
  const field = (title, name, value, update, multiline = false) => {
    const input = mark(make(multiline ? 'textarea' : 'input'), name)
    input.setAttribute('aria-label', title); if (!multiline) { input.type = 'text'; input.setAttribute('type', 'text') }
    else input.setAttribute('rows', '2')
    input.value = value ?? ''; bind(input, update, false); return label(title, input)
  }
  const select = (title, name, value, options, update, redraw = true, notify = true) => {
    const input = mark(make('select'), name), choices = [...options]
    if (!choices.some(([id]) => id === value)) choices.unshift([value ?? '', value ? String(value) + ' (unavailable)' : 'Choose a value'])
    for (const [id, text] of choices) { const option = make('option', text); option.value = id; option.setAttribute('value', id); input.append(option) }
    input.value = value ?? ''; input.setAttribute('aria-label', title); bind(input, update, redraw, notify); return label(title, input)
  }
  const button = (title, name, action, unavailable = false) => {
    const node = mark(make('button', title), name); node.type = 'button'; node.setAttribute('type', 'button')
    node.disabled = disabled || unavailable; if (unavailable) node.setAttribute('data-requirement-fields-unavailable', '')
    node.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (!disabled && !node.disabled && !destroyed) { action(); emit(); render() } })
    return node
  }
  const section = (title, name) => { const node = mark(make('fieldset'), name); node.append(make('legend', title)); return node }
  function valueEditor(value, update, context, scalarOnly = false) {
    const node = mark(make('div'), 'value'); node.setAttribute('data-requirement-fields-value-context', context)
    const kinds = scalarOnly ? ['string', 'number', 'boolean', 'null'] : ['string', 'number', 'boolean', 'null', 'object', 'array']
    node.append(select('Value type', 'value-kind', value?.kind, kinds.map(kind => [kind, kind]), kind => update(kind === 'array' ? { kind, items: [] } : kind === 'object' ? { kind, entries: [] } : scalar(kind))))
    if (value?.kind === 'array') {
      rows(value.items).forEach((item, index) => {
        const child = section('Item ' + (index + 1), 'array-item')
        child.append(valueEditor(item, next => { value.items[index] = next }, context + '/' + index), button('Remove item', 'remove-item', () => value.items.splice(index, 1)))
        node.append(child)
      })
      node.append(button('Add item', 'add-item', () => value.items.push(scalar('string'))))
    } else if (value?.kind === 'object') {
      rows(value.entries).forEach((entry, index) => {
        const child = section(entry.name || 'Object field', 'object-entry')
        child.append(field('Field name', 'entry-name', entry.name, next => { entry.name = next }),
          valueEditor(entry.value, next => { entry.value = next }, context + '/' + entry.name), button('Remove field', 'remove-entry', () => value.entries.splice(index, 1)))
        node.append(child)
      })
      node.append(button('Add field', 'add-entry', () => value.entries.push({ name: '', value: scalar('string') })))
    } else if (value?.kind === 'boolean') node.append(select('Value', 'value-text', value.text, [['true', 'true'], ['false', 'false']], next => { value.text = next }, false))
    else if (value?.kind !== 'null') node.append(field('Value', 'value-text', value?.text, next => { value.text = next }))
    return node
  }
  const disable = () => { for (const tag of ['input', 'textarea', 'select', 'button']) for (const node of el.querySelectorAll(tag)) node.disabled = disabled || node.hasAttribute('data-requirement-fields-unavailable') }
  function render() {
    el.replaceChildren()
    if (!inventory || !draft) {
      el.append(mark(make('p', 'Prepare requirement fields from the current tasks, readings and source pins. Saved unfinished fields are retained until an explicit regeneration.'), 'status')); return
    }
    const stale = inventory.bindingSha256 !== draft.bindingSha256
    el.append(mark(make('p', inventory.rows.length + ' occurrence targets across all tasks and readings. ' + inventory.appendices.length + ' runtime appendices remain separate. '
      + (stale ? 'Sources or task meanings changed. Retained fields are stale; explicitly regenerate and review them before applying.' : 'Complete every occurrence; generation enforces the complete composition registry.')), 'status'))
    for (const item of inventory.blocking) el.append(mark(make('p', item.reason), 'blocking'))
    el.append(field('Why these controls establish the intended requirements', 'rationale', draft.rationale, next => { draft.rationale = next }, true),
      field('Qualification timeout (ms)', 'timeout', draft.timeoutMs, next => { draft.timeoutMs = next }))
    if (inventory.needsInterpreters) {
      const interpreters = draft.interpreters
      if (interpreters) {
        const options = inventory.interpreterOptions.map(item => [item.path, item.path])
        el.append(select('Reference interpreter source file', 'reference', interpreters.reference, options, next => { interpreters.reference = next }),
          select('Independent interpreter source file', 'independent', interpreters.independent, options, next => { interpreters.independent = next }),
          field('Why the implementations are independent', 'interpreter-rationale', interpreters.rationale, next => { interpreters.rationale = next }, true))
      } else el.append(make('p', 'This retained draft has no interpreter fields. Regenerate the roster for the current domain.'))
    }
    const targets = rows(draft.targets)
    if (!targets.some(target => target.key === selected)) selected = targets[0]?.key || ''
    const title = row => row.taskId + (row.readingId ? ' / ' + row.readingId : '') + ' / ' + row.path + ' / ' + row.role
    el.append(select('Requirement occurrence', 'target', selected, targets.map(target => { const row = inventory.rows.find(item => item.key === target.key); return [target.key, row ? title(row) : target.key + ' (stale occurrence)'] }), next => { selected = next }, true, false))
    const target = targets.find(item => item.key === selected), row = inventory.rows.find(item => item.key === selected)
    if (!target || !row) { el.append(make('p', 'The retained occurrence is absent from the current source roster. Regenerate explicitly to replace it.')); disable(); return }
    el.append(make('p', row.requirement), field('Why this occurrence needs these controls', 'target-rationale', target.rationale, next => { target.rationale = next }, true))
    const activation = section('Observed activation', 'activation-section')
    activation.append(make('p', row.activationMode === 'unsupported' ? 'The selected interpreter has no supported occurrence-level activation metric. This remains blocking.'
      : 'Choose an observed metric and a positive minimum. A process proposal is not a native fill.'))
    rows(target.activation).forEach((rule, index) => {
      const controls = section('Activation ' + (index + 1), 'activation-row')
      if (row.activationMode === 'module-declared') controls.append(select('Metric kind', 'activation-kind', rule.kind, [['counter', 'Counter'], ['transition', 'Transition']], next => { rule.kind = next }), field('Module metric name', 'activation-name', rule.name, next => { rule.name = next }))
      else controls.append(select('Instrumented metric', 'activation', rule.name ? rule.kind + ':' + rule.name : '', row.activationOptions.map(option => [option.kind + ':' + option.name, option.label]), next => { const [kind, name] = next.split(':'); rule.kind = kind; rule.name = name }))
      controls.append(field('Minimum occurrences', 'activation-minimum', rule.minimum, next => { rule.minimum = next }), button('Remove activation', 'remove-activation', () => target.activation.splice(index, 1)))
      activation.append(controls)
    })
    activation.append(button('Add activation rule', 'add-activation', () => target.activation.push({ kind: 'counter', name: '', minimum: '1' }), target.activation.length >= 32)); el.append(activation)
    const witnesses = section('Independent witness inputs and assertions', 'witnesses')
    witnesses.append(make('p', 'Initial witness inputs are copies of the task input for editing. Enter independently justified observable values; expected answers are not filled in.'))
    rows(target.probes).forEach((probe, index) => {
      const controls = section('Witness ' + (index + 1), 'probe')
      controls.append(field('Witness ID', 'probe-id', probe.id, next => { probe.id = next }))
      const input = make('details'); input.append(make('summary', 'Edit witness input fields'), valueEditor(probe.input, next => { probe.input = next }, 'probe-' + index + '/input')); controls.append(input)
      rows(probe.assertions).forEach((assertion, assertionIndex) => {
        const assertionFields = section('Observable assertion ' + (assertionIndex + 1), 'assertion')
        assertionFields.append(select('Observation location', 'assertion-path', assertion.path === null ? '' : JSON.stringify(assertion.path), row.observationFields.map(option => [JSON.stringify(option.path), option.label]), next => { assertion.path = JSON.parse(next) }),
          valueEditor(assertion.value, next => { assertion.value = next }, 'probe-' + index + '/assertion-' + assertionIndex, true), button('Remove assertion', 'remove-assertion', () => probe.assertions.splice(assertionIndex, 1)))
        controls.append(assertionFields)
      })
      controls.append(button('Add independent assertion', 'add-assertion', () => probe.assertions.push({ path: null, value: scalar('number') }), probe.assertions.length >= 64), button('Remove witness', 'remove-probe', () => target.probes.splice(index, 1)))
      witnesses.append(controls)
    })
    witnesses.append(button('Add witness input', 'add-probe', () => target.probes.push({ id: 'probe-' + (target.probes.length + 1), input: requirementValueField(row.input), assertions: [] }), target.probes.length >= 16)); el.append(witnesses)
    const alternatives = section('Plausible local alternative meanings', 'alternatives')
    alternatives.append(make('p', 'Each alternative clones the full root and changes only this occurrence. Qualification must detect it on the witness and actual selected input.'))
    rows(target.wrongReadings).forEach((alternative, index) => {
      const controls = section('Alternative ' + (index + 1), 'alternative')
      controls.append(field('Alternative ID', 'alternative-id', alternative.id, next => { alternative.id = next }),
        select('Change', 'alternative-kind', alternative.kind, [['parameter', 'Local parameter'], ['replacement', 'Compatible bundle']], kind => { target.wrongReadings[index] = { id: alternative.id, rationale: alternative.rationale, kind, ...(kind === 'parameter' ? { parameter: '', value: scalar('number') } : { bundleId: '', parameters: {} }) } }))
      if (alternative.kind === 'parameter') controls.append(select('Parameter', 'parameter', alternative.parameter, Object.keys(row.parameters).map(name => [name, name]), next => { alternative.parameter = next }), valueEditor(alternative.value, next => { alternative.value = next }, 'alternative-' + index, true))
      else {
        controls.append(select('Replacement bundle', 'bundle', alternative.bundleId, row.replacements.map(bundle => [bundle.id, bundle.id]), next => { alternative.bundleId = next; alternative.parameters = Object.fromEntries(Object.entries(row.replacements.find(bundle => bundle.id === next).parameters).map(([name, value]) => [name, requirementValueField(value)])) }))
        for (const [name, value] of Object.entries(alternative.parameters || {})) { const parameter = section(name, 'replacement-parameter'); parameter.append(valueEditor(value, next => { alternative.parameters[name] = next }, 'alternative-' + index + '/' + name, true)); controls.append(parameter) }
      }
      controls.append(field('Why this is a plausible mistaken meaning', 'alternative-rationale', alternative.rationale, next => { alternative.rationale = next }, true), button('Remove alternative', 'remove-alternative', () => target.wrongReadings.splice(index, 1))); alternatives.append(controls)
    })
    alternatives.append(button('Add local alternative', 'add-alternative', () => target.wrongReadings.push({ id: 'alternative-' + (target.wrongReadings.length + 1), rationale: '', kind: 'parameter', parameter: '', value: scalar('number') }), target.wrongReadings.length >= 16)); el.append(alternatives)
    disable()
  }
  render()
  return { el, setContext(nextInventory, nextDraft) { inventory = nextInventory ? copy(nextInventory) : null; if (nextDraft !== undefined) draft = copy(nextDraft); render() },
    getDraft: () => copy(draft), setDisabled(value) { disabled = Boolean(value); disable() }, destroy() { destroyed = true; el.replaceChildren() } }
}
