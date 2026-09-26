const copy = value => structuredClone(value)
const rows = value => Array.isArray(value) ? value : []
const record = value => value && typeof value === 'object' && !Array.isArray(value)

// Editable values remain separate from the compiled corpus recipe. This view
// neither expands the library nor derives answers, qualification or approval.
export function createCompositionFieldsEditor({ onChange = () => {}, sharedConstruction = false } = {}) {
  let inventory = null, draft = null, selected = '', disabled = false, destroyed = false
  const el = document.createElement('div')
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
  const mark = (node, name) => { node.setAttribute('data-composition-fields-' + name, ''); return node }
  mark(el, 'editor')
  const label = (title, input) => { const node = make('label'); node.append(make('span', title), input); return node }
  const focusKey = (node, key) => { node.setAttribute('data-composition-fields-focus', key); return node }
  const emit = () => { if (!destroyed) onChange(copy(draft)) }
  const bind = (input, update, redraw = false, notify = true) => {
    input.addEventListener('input', event => {
      event.stopPropagation()
      if (disabled || input.disabled || destroyed) return
      if (update(input.type === 'checkbox' ? input.checked : input.value) === false) return
      if (notify) emit()
      if (redraw) render(); else updateStatus()
    })
    input.addEventListener('change', event => event.stopPropagation())
  }
  const field = (title, name, value, update, { multiline = false, key = name } = {}) => {
    const input = focusKey(mark(make(multiline ? 'textarea' : 'input'), name), key)
    input.setAttribute('aria-label', title)
    if (multiline) input.setAttribute('rows', '2')
    else { input.type = 'text'; input.setAttribute('type', 'text') }
    input.value = value ?? ''; bind(input, update); return label(title, input)
  }
  const select = (title, name, value, options, update, { redraw = false, notify = true, key = name, disabledValues = [] } = {}) => {
    const input = focusKey(mark(make('select'), name), key), choices = [...options]
    if (!choices.some(([id]) => id === value)) choices.unshift([value ?? '', value ? String(value) + ' (unavailable)' : 'Choose a value'])
    for (const [id, text] of choices) { const option = make('option', text); option.value = id; option.setAttribute('value', id); option.disabled = disabledValues.includes(id); input.append(option) }
    input.value = value ?? ''; input.setAttribute('aria-label', title)
    bind(input, next => { if (disabledValues.includes(next) || update(next) === false) { input.value = value ?? ''; return false } }, redraw, notify)
    return label(title, input)
  }
  const checkbox = (title, name, value, update, key = name) => {
    const input = focusKey(mark(make('input'), name), key)
    input.type = 'checkbox'; input.setAttribute('type', 'checkbox'); input.checked = value === true
    input.setAttribute('aria-label', title); bind(input, update); return label(title, input)
  }
  const button = (title, name, action, unavailable = false, key = name) => {
    const node = focusKey(mark(make('button', title), name), key); node.type = 'button'; node.setAttribute('type', 'button')
    node.disabled = disabled || unavailable
    if (unavailable) node.setAttribute('data-composition-fields-unavailable', '')
    node.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation()
      if (!disabled && !node.disabled && !destroyed) { action(); emit(); render() }
    })
    return node
  }
  const section = (title, name) => { const node = mark(make('fieldset'), name); node.append(make('legend', title)); return node }
  const disable = () => {
    for (const tag of ['input', 'textarea', 'select', 'button']) for (const node of el.querySelectorAll(tag)) {
      node.disabled = disabled || node.hasAttribute('data-composition-fields-unavailable')
    }
  }
  function updateStatus() {
    const status = el.querySelector('[data-composition-fields-status]')
    if (!status || !inventory || !draft) return
    const stale = inventory.bindingSha256 !== draft.bindingSha256 || inventory.taskId !== draft.taskId
    status.textContent = rows(inventory.rows).length + ' exact composition occurrences; ' + rows(draft.occurrences).filter(row => row.enabled === true).length + ' enabled factors. '
      + (stale ? 'Sources or task meanings changed. Retained fields are stale; prepare and explicitly reset them before building a recipe.'
        : 'Each enabled occurrence varies independently. Local choices retain child connections; whole-branch choices require every child and cannot overlap enabled descendant factors.')
  }
  function parameterEditor(name, value, schema, context) {
    const node = section(name + ' (' + (value?.kind || schema?.type || 'type not recorded') + ')', 'parameter')
    node.setAttribute('data-composition-fields-parameter-name', name)
    if (!record(value)) { node.append(make('p', 'This retained parameter is incomplete. Reset the fields or select a compatible bundle to replace its local parameters.')); return node }
    const include = checkbox('Include ' + name, 'parameter-include', value.present, next => { value.present = next }, context + '/include')
    const input = include.querySelector('input')
    const update = next => { value.text = next; value.present = true; input.checked = true }
    const options = rows(schema?.enum).map(item => [String(item), item === '' ? '(empty string)' : String(item)])
    node.append(include)
    if (value.kind === 'boolean' || options.length) node.append(select('Value for ' + name, 'parameter-value', value.text,
      options.length ? options : [['true', 'true'], ['false', 'false']], update, { key: context + '/value' }))
    else node.append(field('Value for ' + name, 'parameter-value', value.text, update, { key: context + '/value' }))
    const constraints = [schema && schema.required !== false ? 'Required parameter.' : 'Omit local override when Include is unchecked; a bundle default or task variable may still apply.']
    if (schema?.minimum !== undefined) constraints.push('Minimum ' + schema.minimum + '.')
    if (schema?.maximum !== undefined) constraints.push('Maximum ' + schema.maximum + '.')
    if (options.length) constraints.push('Allowed values: ' + options.map(([, text]) => text === '' ? '(empty string)' : text).join(', ') + '.')
    constraints.push('Editing a value includes it. Unfinished text is retained until recipe validation.')
    node.append(make('p', constraints.join(' ')))
    return node
  }
  const pathKey = path => Array.isArray(path) ? JSON.stringify(path) : ''
  const acceptsRole = (required, actual) => required === '*' || required === actual
  const bundleAt = id => rows(inventory?.bundles).find(bundle => bundle.bundleId === id)
  const orderedSlots = bundle => [...rows(bundle?.slotOrder), ...Object.keys(bundle?.slots || {}).filter(name => !rows(bundle?.slotOrder).includes(name))]
  function localAsSubtree(choice, row) {
    const bundle = bundleAt(choice.bundleId)
    if (!bundle) return null
    return { kind: 'bundle', bundleId: choice.bundleId, parameters: copy(choice.parameters), slots: Object.fromEntries(orderedSlots(bundle).map(name =>
      [name, row.slots?.[name] === bundle.slots[name] ? { kind: 'copy', path: [...row.path, name] } : { kind: 'unfilled' }])) }
  }
  function subtreeAsLocal(node, row) {
    if (node?.kind === 'copy' && pathKey(node.path) === pathKey(row.path)) return copy(row.current)
    if (node?.kind !== 'bundle' || !rows(row.compatible).some(bundle => bundle.bundleId === node.bundleId)) return null
    const slots = Object.keys(row.slots || {})
    if (!record(node.slots) || Object.keys(node.slots).length !== slots.length || !slots.every(name =>
      node.slots[name]?.kind === 'copy' && pathKey(node.slots[name].path) === pathKey([...row.path, name]))) return null
    return { bundleId: node.bundleId, parameters: copy(node.parameters) }
  }
  function subtreeEditor(choice, row, index, context) {
    const container = mark(make('div'), 'subtree')
    // Iterate rather than impose a new depth ceiling. Flat, path-labeled
    // fieldsets also keep deeply nested branches usable without widening them.
    const pending = [{ value: choice.subtree, path: [], role: row.requiredRole, update: next => { choice.subtree = next } }]
    while (pending.length) {
      const { value, path, role, update } = pending.pop(), nodeContext = context + '/subtree/' + pathKey(path)
      const node = section(path.length ? 'Branch / ' + path.join(' / ') : 'Choice branch', 'structural-node')
      node.setAttribute('data-composition-fields-node-path', pathKey(path))
      node.setAttribute('data-composition-fields-choice-index', String(index))
      node.append(make('p', 'Required role: ' + role + '.'), select('Branch source', 'node-kind', value?.kind,
        [['unfilled', 'Not filled'], ['copy', 'Copy existing branch'], ['bundle', 'Build branch']], next => {
          if (next === value?.kind) return false
          update(next === 'copy' ? { kind: 'copy', path: null } : next === 'bundle'
            ? { kind: 'bundle', bundleId: '', parameters: {}, slots: {} } : { kind: 'unfilled' })
        }, { redraw: true, key: nodeContext + '/kind' }))
      if (value?.kind === 'copy') {
        const copies = rows(inventory.rows).filter(source => acceptsRole(role, source.role))
        const source = copies.find(source => pathKey(source.path) === pathKey(value.path))
        node.append(select('Frozen source branch', 'copy-path', pathKey(value.path), [['', 'Choose a source branch'], ...copies.map(source =>
          [pathKey(source.path), source.pathLabel + ' / ' + source.current.bundleId])], next => { value.path = next === '' ? null : JSON.parse(next) },
        { redraw: true, key: nodeContext + '/copy' }), make('p', source
          ? 'Copies ' + source.pathLabel + ' from the frozen source task' + (source.subtreeNodes ? ' (' + source.subtreeNodes + ' nodes)' : '') + '. The generated branch has independent ownership; it does not follow other factor choices.'
          : 'Choose an existing branch with this incoming role. A missing or unavailable copy stays unresolved and blocks recipe compilation.'))
      } else if (value?.kind === 'bundle') {
        const bundles = rows(inventory.bundles).filter(bundle => acceptsRole(role, bundle.role)), bundle = bundleAt(value.bundleId)
        node.append(select('Branch bundle', 'node-bundle', value.bundleId, [['', 'Choose a bundle'], ...bundles.map(bundle => [bundle.bundleId, bundle.label || bundle.bundleId])], next => {
          if (next === '') { value.bundleId = ''; return }
          const replacement = bundles.find(bundle => bundle.bundleId === next)
          if (!replacement) { value.bundleId = next; return }
          const oldSlots = record(value.slots) ? value.slots : {}
          value.bundleId = next; value.parameters = copy(replacement.parameters)
          value.slots = Object.fromEntries(orderedSlots(replacement).map(name => [name,
            bundle?.slots?.[name] === replacement.slots[name] && Object.hasOwn(oldSlots, name) ? copy(oldSlots[name]) : { kind: 'unfilled' }]))
        }, { redraw: true, key: nodeContext + '/bundle' }))
        if (!bundle || !acceptsRole(role, bundle.role)) node.append(make('p', 'Select an available bundle with the required role. Retained parameters and child fields remain unresolved until the selection is valid.'))
        if (orderedSlots(bundle).length) node.append(mark(make('p', 'Declared child evaluation order: ' + orderedSlots(bundle).join(' → ') + '. Fill every child explicitly; changing the bundle may remove or add slots.'), 'slot-order'))
        for (const [name, parameter] of Object.entries(record(value.parameters) ? value.parameters : {})) node.append(parameterEditor(name, parameter, bundle?.parameterSchema?.[name], nodeContext + '/' + name))
        const names = [...orderedSlots(bundle), ...Object.keys(value.slots || {}).filter(name => !orderedSlots(bundle).includes(name))]
        for (const name of [...names].reverse()) {
          const childRole = bundle?.slots?.[name]
          if (childRole === undefined) {
            node.append(make('p', 'Retained child ' + name + ' is not declared by the selected bundle. Its fields are preserved; select a valid bundle before compiling.'))
            continue
          }
          pending.push({ value: value.slots?.[name] || { kind: 'unfilled' }, path: [...path, name], role: childRole,
            update: next => { if (!record(value.slots)) value.slots = {}; value.slots[name] = next } })
        }
      } else node.append(make('p', 'This branch is not filled. Choose a source copy or explicitly build its bundle and children before compiling.'))
      container.append(node)
    }
    return container
  }
  function renderContent() {
    el.replaceChildren()
    if (!inventory || !draft) {
      el.append(mark(make('p', 'Prepare composition fields from an existing task. Saved unfinished fields are retained until an explicit reset.'), 'status')); return
    }
    el.append(mark(make('p'), 'status')); updateStatus()
    for (const item of rows(inventory.blocking)) el.append(mark(make('p', item.message), 'blocking'))
    el.append(make('p', 'Base task: ' + (inventory.taskName || inventory.taskId) + '. Select a family, study split and construction policy; required qualification and review remain separate.'))
    if ((!sharedConstruction && (!record(draft.selection) || !record(draft.coverage))) || !record(draft.expectedPolicy)) {
      el.append(make('p', 'This retained draft is missing policy fields. Prepare and explicitly reset it before building a recipe.')); return
    }
    const policies = section('Task-set construction', 'policies')
    policies.append(field('Family ID', 'family', draft.familyId, next => { draft.familyId = next }),
      select('Study split', 'split', draft.split, [['development', 'Development'], ['held-out', 'Held-out']], next => { draft.split = next }),
      field('Construction and sampling rationale', 'rationale', draft.rationale, next => { draft.rationale = next }, { multiline: true }))
    if (sharedConstruction) policies.append(mark(make('p', 'The family workspace owns the shared seed, sampling and coverage policy. Retained local policy text is preserved; edit the workspace controls to change the combined construction.'), 'shared-construction'))
    else policies.append(field('Frozen random seed', 'seed', draft.seed, next => { draft.seed = next }),
      select('Task selection', 'selection-kind', draft.selection.kind, [['all', 'All candidates'], ['seeded', 'Seeded selection'], ['balanced', 'Balanced coverage selection']], next => { draft.selection.kind = next }),
      field('Maximum selected tasks', 'selection-limit', draft.selection.limit, next => { draft.selection.limit = next }),
      select('Required structural coverage', 'coverage-kind', draft.coverage.kind, [['none', 'None'], ['marginal', 'Every factor choice'], ['pairwise', 'Every pair of factor choices']], next => { draft.coverage.kind = next }),
      field('Minimum tasks per coverage cell', 'coverage-minimum', draft.coverage.minimum, next => { draft.coverage.minimum = next }))
    policies.append(make('p', 'Limits: ' + inventory.limits?.candidates + ' constructed candidates, ' + inventory.limits?.axes + ' factors and ' + inventory.limits?.selection + ' selected tasks. Structural coverage does not establish semantic qualification.'))
    const expectedOptions = inventory.domain === 'lean-bench' ? [['derive-lean', 'Derive with the LEAN domain oracle']] : [['', 'Choose an expected-answer policy'], ['reuse-base', 'Reuse the base task answer']]
    policies.append(select('Expected-answer policy', 'expected-policy', draft.expectedPolicy.kind, expectedOptions, next => { draft.expectedPolicy.kind = next }),
      field('Why this expected-answer policy applies', 'expected-rationale', draft.expectedPolicy.rationale, next => { draft.expectedPolicy.rationale = next }, { multiline: true }),
      make('p', inventory.domain === 'lean-bench' ? 'The shared domain compiler derives observations for each generated composition. Native execution and required review remain separate.'
        : 'Reusing the base answer requires an explicit rationale that it remains valid for every choice. No new answer is inferred from these fields.'))
    el.append(policies)
    const occurrences = rows(draft.occurrences)
    if (!occurrences.some(row => row.key === selected)) selected = occurrences[0]?.key || ''
    el.append(select('Composition occurrence', 'occurrence', selected, occurrences.map(item => {
      const row = rows(inventory.rows).find(row => row.key === item.key)
      return [item.key, row ? row.pathLabel + ' / ' + row.requiredRole + ' / ' + row.current.bundleId : String(item.key) + ' (stale occurrence)']
    }), next => { selected = next }, { redraw: true, notify: false }))
    const occurrence = occurrences.find(row => row.key === selected), row = rows(inventory.rows).find(row => row.key === selected)
    if (!occurrence || !row) { el.append(make('p', 'The retained occurrence is absent from the current roster. Prepare and explicitly reset fields to replace it.')); return }
    el.append(checkbox('Vary this occurrence as an independent factor', 'enabled', occurrence.enabled, next => { occurrence.enabled = next }),
      field('Factor ID', 'axis-id', occurrence.axisId, next => { occurrence.axisId = next }),
      make('p', 'Occurrence: ' + row.pathLabel + '. Required role: ' + row.requiredRole + '. Local choices keep declared child connections. A whole-branch choice supplies a complete replacement and cannot overlap enabled descendant factors.'))
    rows(occurrence.choices).forEach((choice, index) => {
      const controls = section('Choice ' + (index + 1), 'choice'), context = occurrence.key + '/choice-' + index
      controls.setAttribute('data-composition-fields-choice-index', String(index))
      const compatible = rows(row.compatible), selectedBundle = compatible.find(bundle => bundle.bundleId === choice.bundleId)
      controls.append(field('Choice ID', 'choice-id', choice.id, next => { choice.id = next }, { key: context + '/id' }))
      const structural = Object.hasOwn(choice, 'subtree')
      if (Array.isArray(inventory.bundles)) {
        const local = structural ? subtreeAsLocal(choice.subtree, row) : null
        controls.append(select('Choice construction', 'choice-kind', structural ? 'subtree' : 'local', [['local', 'Keep child connections'], ['subtree', 'Replace whole branch']], next => {
          const replacement = next === 'subtree' ? localAsSubtree(choice, row) : subtreeAsLocal(choice.subtree, row)
          if (!replacement) return false
          occurrence.choices[index] = next === 'subtree' ? { id: choice.id, subtree: replacement } : { id: choice.id, ...replacement }
          if (next === 'subtree') draft.version = 2
        }, { redraw: true, key: context + '/kind', disabledValues: structural && !local ? ['local'] : !structural && !bundleAt(choice.bundleId) ? ['subtree'] : [] }))
        if (structural && !local) controls.append(mark(make('p', 'Keep child connections is unavailable because this branch differs from the original child connections. Retain the whole-branch choice or remove it explicitly; changing mode cannot discard authored children.'), 'conversion-status'))
      }
      if (structural) {
        if (Array.isArray(inventory.bundles)) controls.append(subtreeEditor(choice, row, index, context))
        else controls.append(make('p', 'This saved branch needs a current topology inventory. Prepare fields to inspect it; its draft is preserved.'))
      } else {
        controls.append(select('Compatible bundle', 'bundle', choice.bundleId, compatible.map(bundle => [bundle.bundleId, bundle.label || bundle.bundleId]), next => {
          const bundle = compatible.find(item => item.bundleId === next)
          if (!bundle) return
          choice.bundleId = next; choice.parameters = copy(bundle.parameters)
        }, { redraw: true, key: context + '/bundle' }))
      if (!selectedBundle) controls.append(make('p', 'This retained bundle is unavailable for the occurrence. Its parameter text is preserved; recipe compilation will refuse it.'))
      else if (rows(selectedBundle.slotOrder).length) controls.append(mark(make('p', 'Declared child evaluation order: ' + selectedBundle.slotOrder.join(' → ') + '. Choosing a different order changes the composition meaning.'), 'slot-order'))
      for (const [name, value] of Object.entries(record(choice.parameters) ? choice.parameters : {})) controls.append(parameterEditor(name, value, selectedBundle?.parameterSchema?.[name], context + '/' + name))
      }
      controls.append(button('Remove choice', 'remove-choice', () => occurrence.choices.splice(index, 1), false, context + '/remove'))
      el.append(controls)
    })
    el.append(button('Add choice', 'add-choice', () => {
      let index = 1
      while (occurrence.choices.some(choice => choice.id === 'choice-' + index)) index++
      occurrence.choices.push({ id: 'choice-' + index, bundleId: row.current.bundleId, parameters: copy(row.current.parameters) })
    }, !Array.isArray(occurrence.choices) || occurrence.choices.length >= 512))
    if (!rows(occurrence.choices).length) el.append(make('p', 'This factor has no choices. Add a choice before enabling it and building a recipe.'))
  }
  function render() {
    if (destroyed) return
    const active = document.activeElement, key = el.contains(active) ? active.getAttribute('data-composition-fields-focus') : null
    const start = active?.selectionStart, end = active?.selectionEnd
    renderContent(); disable()
    if (key !== null) {
      const next = [...el.querySelectorAll('[data-composition-fields-focus]')].find(node => node.getAttribute('data-composition-fields-focus') === key)
      if (next && !next.disabled) { next.focus({ preventScroll: true }); if (typeof start === 'number' && typeof next.setSelectionRange === 'function') next.setSelectionRange(start, end) }
    }
  }
  render()
  return {
    el,
    setContext(nextInventory, nextDraft) { if (destroyed) return; inventory = nextInventory ? copy(nextInventory) : null; if (nextDraft !== undefined) draft = copy(nextDraft); render() },
    getDraft: () => copy(draft),
    setDisabled(value) { disabled = Boolean(value); disable() },
    destroy() { destroyed = true; el.replaceChildren() },
  }
}
