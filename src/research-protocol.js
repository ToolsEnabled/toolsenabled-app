import { atDefault, decidedCount, decisionsText, effectiveValue, emptyProtocolDecisions, isDecided, normalizeProtocolDecisions, normalizeValue, previousProtocolEntries, protocolField, settingsCount, valueText, withLeanBench, withRulings, withoutSection } from './research-protocol.mjs'
import { PROTOCOL_OPTION_CHOICES, PROTOCOL_OPTION_LABELS, PROTOCOL_OPTION_SECTIONS, PROTOCOL_ORIGIN_LABELS, PROTOCOL_PRESETS, protocolPresetValue, withProtocolPreset } from './research-protocol-options.mjs'
import './research-protocol.css'

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`
const sectionIds = section => section.groups.flatMap(group => group.fields)
const label = field => PROTOCOL_OPTION_LABELS[field.id] || field.label

// Grouped controls edit the existing registry. Loading a draft, opening details
// and choosing Custom never apply a preset or infer a new decision.
export function createProtocolEditor({ onChange }) {
  const el = document.createElement('div'); el.className = 'protocol-editor'
  let state = emptyProtocolDecisions(), locked = false, open = new Set()
  const q = name => el.querySelector(`[data-proto-${name}]`)
  const emit = changed => onChange(structuredClone(state), changed)
  const expanded = key => open.has(key) ? ' open' : ''
  const checkbox = field => field.kind === 'yesno' && field.setting
  const stateWord = field => field.setting ? (atDefault(state, field) ? 'Default' : 'Changed') : (isDecided(state, field.id) ? 'Decided' : 'Not decided')

  function control(field) {
    const value = effectiveValue(state, field), id = `proto-${field.id}`, blank = field.setting ? 'Default' : 'Not decided'
    if (checkbox(field)) return `<input id="${id}" type="checkbox" data-proto-field="${esc(field.id)}"${value === 'yes' ? ' checked' : ''}>`
    if (field.kind === 'choice') return `<select id="${id}" data-proto-field="${esc(field.id)}">${field.setting ? '' : option('', 'Not decided', value === undefined ? '' : null)}${field.options.map(([key, text], i) => option(key, PROTOCOL_OPTION_CHOICES[field.id]?.[i] || text, value)).join('')}</select>`
    if (field.kind === 'yesno') return `<select id="${id}" data-proto-field="${esc(field.id)}">${option('', 'Not decided', value === undefined ? '' : null)}${option('yes', 'Yes', value)}${option('no', 'No', value)}</select>`
    if (field.kind === 'number') return `<span class="proto-number"><input id="${id}" type="number" data-proto-field="${esc(field.id)}" value="${value === undefined ? '' : esc(value)}"${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max !== undefined ? ` max="${field.max}"` : ''}${field.step !== undefined ? ` step="${field.step}"` : ''} placeholder="${blank}"><span class="proto-unit">${esc(field.unit)}</span></span>`
    if (field.kind === 'text') return `<input id="${id}" data-proto-field="${esc(field.id)}" value="${value === undefined ? '' : esc(value)}" maxlength="4000" placeholder="${esc(field.placeholder || blank)}">`
    if (field.kind === 'note') return `<textarea id="${id}" data-proto-field="${esc(field.id)}" rows="3" maxlength="4000" placeholder="${esc(field.placeholder || blank)}">${value === undefined ? '' : esc(value)}</textarea>`
    return `<textarea id="${id}" data-proto-field="${esc(field.id)}" rows="3" placeholder="${esc(field.placeholder || 'One per line')}">${value === undefined ? '' : esc(value.join('\n'))}</textarea>`
  }
  function fieldRow(id) {
    const field = protocolField(id), settled = field.setting ? !atDefault(state, field) : isDecided(state, id)
    return `<div class="proto-field${settled ? ' is-decided' : ''}${field.setting ? ' is-setting' : ''}" data-proto-row="${esc(id)}">
      <div class="proto-field-head"><label for="proto-${esc(id)}"${checkbox(field) ? ' class="proto-check"' : ''}>${checkbox(field) ? control(field) : ''}<span>${esc(label(field))}</span></label><span class="proto-state" data-proto-state>${stateWord(field)}</span></div>
      ${checkbox(field) ? '' : `<div class="proto-control">${control(field)}</div>`}
      <details class="proto-field-details" data-proto-details="source:${esc(id)}"${expanded(`source:${id}`)}><summary>Details and source</summary>
        <p class="proto-selected" data-proto-selected>${esc(valueText(field, effectiveValue(state, field)) || 'Not decided.')}</p>
        <p class="proto-hint"><span class="proto-origin">${esc(PROTOCOL_ORIGIN_LABELS[field.origin])}</span> ${esc(field.source)}</p>
        <p class="proto-why">${esc(field.why)}</p>
        <p class="proto-lb"><button type="button" class="proto-small" data-proto-use-field="${esc(id)}">${field.setting ? 'Reset to default' : 'Use example value'}</button><span class="proto-lb-value">${esc(valueText(field, field.lb))}</span></p>
      </details></div>`
  }
  function group(entry) {
    const fields = `<div class="proto-fields">${entry.fields.map(fieldRow).join('')}</div>`
    if (!entry.preset) return `<div class="proto-group"><h4>${esc(entry.title)}</h4>${fields}</div>`
    const preset = PROTOCOL_PRESETS[entry.preset], selected = protocolPresetValue(state, entry.preset)
    return `<div class="proto-group proto-policy"><label for="proto-preset-${esc(entry.preset)}">${esc(preset.label)}</label>
      <select id="proto-preset-${esc(entry.preset)}" data-proto-preset="${esc(entry.preset)}">${preset.options.map(item => option(item.id, item.label, selected)).join('')}${option('custom', 'Custom per-case rules', selected)}</select>
      <details data-proto-overrides="${esc(entry.id)}" data-proto-details="group:${esc(entry.id)}"${selected === 'custom' ? ' open' : expanded(`group:${entry.id}`)}><summary>Individual rules (${entry.fields.length})</summary>${fields}</details></div>`
  }
  function sectionMeta(entry) {
    const fields = sectionIds(entry).map(protocolField), decisions = fields.filter(field => !field.setting), settings = fields.filter(field => field.setting)
    const changed = settings.filter(field => !atDefault(state, field)).length
    return [decisions.length ? `${decisions.filter(field => isDecided(state, field.id)).length} of ${decisions.length} decided` : '', settings.length ? `${settings.length} settings${changed ? `, ${changed} changed` : ''}` : ''].filter(Boolean).join(' · ')
  }
  function section(entry) {
    return `<details class="proto-section" data-proto-section="${esc(entry.id)}" data-proto-details="section:${esc(entry.id)}"${expanded(`section:${entry.id}`)}>
      <summary><span class="proto-section-title">${esc(entry.title)}</span><span class="proto-meta" data-proto-section-meta>${esc(sectionMeta(entry))}</span></summary>
      ${entry.groups.map(group).join('')}
      <details class="proto-section-tools" data-proto-details="tools:${esc(entry.id)}"${expanded(`tools:${entry.id}`)}><summary>Section examples and resets</summary>
        <button type="button" class="proto-small" data-proto-rulings-section="${esc(entry.id)}">Use recorded decisions</button><button type="button" class="proto-small" data-proto-use-section="${esc(entry.id)}">Use example values</button><button type="button" class="proto-small" data-proto-clear-section="${esc(entry.id)}">Reset this section</button></details></details>`
  }
  const countLine = () => { const d = decidedCount(state), s = settingsCount(state); return `<b>${d.decided}</b> of ${d.total} decisions made · ${s.total} settings${s.changed ? `, <b>${s.changed}</b> changed` : ' at defaults'}` }
  function previousEntries() {
    const entries = previousProtocolEntries(state)
    if (!entries.length) return ''
    return `<details class="proto-previous" data-proto-previous data-proto-details="previous"${expanded('previous')}><summary>Previous protocol entries (${entries.length})</summary>
      <p class="proto-hint">Kept from this saved draft for reference. These entries no longer set instructions or override the current controls, and are excluded from the decisions below.</p>
      <dl>${entries.map(({ field, value }) => `<dt>${esc(field.label)}</dt><dd>${esc(valueText(field, value))}<br><span class="proto-hint">Set in: ${esc(field.managedBy)}.</span></dd>`).join('')}</dl></details>`
  }
  function render() {
    el.innerHTML = `<div class="proto-head"><h3>Protocol options</h3>
      <p class="proto-intro">Study rules, collection controls and evaluation policies. Models and efforts are set in the pipeline below; replicates and attempt limits are set in Schedule and budgets.</p>
      <p class="proto-hint">Decisions stay undecided until selected. Settings start at their existing defaults. Collection controls feed the generated harness; the full set of rules and notes is retained in the frozen study decisions. Details show each rule's exact wording, source and example.</p>
      <div class="proto-toolbar"><span class="proto-count" data-proto-count>${countLine()}</span><button type="button" class="proto-small" data-proto-expand>Expand all</button><button type="button" class="proto-small" data-proto-collapse>Collapse all</button></div>
      <details class="proto-examples" data-proto-details="examples"${expanded('examples')}><summary>Examples and resets</summary>
        <p class="proto-hint">The retained example is LeanBench. Applying it is optional; its historical decisions are not new approvals for this study.</p>
        <div class="proto-section-tools"><button type="button" class="proto-small" data-proto-rulings>Use recorded decisions</button><button type="button" class="proto-small" data-proto-use-all>Use all example values</button><button type="button" class="proto-small" data-proto-fill-undecided>Fill unset values from example</button><button type="button" class="proto-small" data-proto-reset-settings>Reset settings to defaults</button><button type="button" class="proto-small" data-proto-clear-all>Clear decisions</button></div></details></div>
      ${PROTOCOL_OPTION_SECTIONS.map(section).join('')}
      ${previousEntries()}
      <section class="proto-notes"><h4>Notes for the frozen decisions</h4><p class="proto-hint">Additional selection, stopping and analysis rules.</p><textarea data-proto-notes rows="4" maxlength="20000" placeholder="Additional study rules.">${esc(state.notes)}</textarea></section>
      <details class="proto-preview" data-proto-details="preview"${expanded('preview')}><summary>Preview frozen decisions</summary><p class="proto-hint">Apply protocol writes this record into the study. Registered wording is preserved for compatibility with existing drafts.</p><pre data-proto-text tabindex="0">${esc(decisionsText(state))}</pre></details>`
    disable()
  }
  function disable() { for (const tag of ['button', 'input', 'select', 'textarea']) for (const node of el.querySelectorAll(tag)) node.disabled = locked }
  const openState = () => { open = new Set([...el.querySelectorAll('[data-proto-details]')].filter(node => node.open).map(node => node.getAttribute('data-proto-details'))) }
  function refresh(fieldId) {
    const field = protocolField(fieldId), row = el.querySelector(`[data-proto-row="${fieldId}"]`)
    if (row) {
      row.classList.toggle('is-decided', field.setting ? !atDefault(state, field) : isDecided(state, fieldId))
      row.querySelector('[data-proto-state]').textContent = stateWord(field)
      row.querySelector('[data-proto-selected]').textContent = valueText(field, effectiveValue(state, field)) || 'Not decided.'
    }
    for (const entry of PROTOCOL_OPTION_SECTIONS) {
      q(`section="${entry.id}"`).querySelector('[data-proto-section-meta]').textContent = sectionMeta(entry)
      for (const group of entry.groups.filter(group => group.preset && group.fields.includes(fieldId))) q(`preset="${group.preset}"`).value = protocolPresetValue(state, group.preset)
    }
    q('count').innerHTML = countLine(); q('text').textContent = decisionsText(state)
  }
  function setValue(fieldId, raw) {
    const field = protocolField(fieldId); if (!field || field.managedBy) return
    const value = normalizeValue(field, raw)
    if (value === undefined) delete state.values[fieldId]; else state.values[fieldId] = value
  }
  function applySection(id, action) {
    const entry = PROTOCOL_OPTION_SECTIONS.find(section => section.id === id); if (!entry) return
    const example = action === 'rulings' ? withRulings(state) : withLeanBench(state)
    for (const id of sectionIds(entry)) {
      if (action === 'clear') delete state.values[id]
      else if (action !== 'rulings' || protocolField(id).origin === 'owner') state.values[id] = structuredClone(example.values[id])
    }
    open.add(`section:${id}`); render(); emit(null)
  }
  el.addEventListener('input', event => {
    if (locked) return
    const target = event.target
    if (target.hasAttribute('data-proto-field') && target.tagName !== 'SELECT' && target.getAttribute('type') !== 'checkbox') { const id = target.getAttribute('data-proto-field'); setValue(id, target.value); refresh(id); emit(id) }
    if (target.hasAttribute('data-proto-notes')) { state.notes = target.value.slice(0, 20000); q('text').textContent = decisionsText(state); emit(null) }
  })
  el.addEventListener('change', event => {
    if (locked) return
    const target = event.target
    if (target.hasAttribute('data-proto-preset')) {
      const id = target.getAttribute('data-proto-preset'); openState()
      if (target.value === 'custom') { q(`overrides="${id}"`).open = true; open.add(`group:${id}`); return }
      state = withProtocolPreset(state, id, target.value); render(); emit(null); return
    }
    if (target.hasAttribute('data-proto-field') && (target.tagName === 'SELECT' || target.getAttribute('type') === 'checkbox')) { const id = target.getAttribute('data-proto-field'); setValue(id, target.getAttribute('type') === 'checkbox' ? target.checked : target.value); refresh(id); emit(id) }
  })
  el.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || locked) return
    const has = name => button.hasAttribute(`data-proto-${name}`), get = name => button.getAttribute(`data-proto-${name}`)
    openState()
    if (has('rulings')) { state = withRulings(state); render(); emit(null) }
    else if (has('use-all')) { state = withLeanBench(state); render(); emit(null) }
    else if (has('fill-undecided')) { state = withLeanBench(state, null, { onlyUndecided: true }); render(); emit(null) }
    else if (has('reset-settings')) { for (const id of Object.keys(state.values)) if (protocolField(id)?.setting && !protocolField(id).managedBy) delete state.values[id]; render(); emit(null) }
    else if (has('clear-all')) { state = withoutSection(state, null, { settingsToo: false }); render(); emit(null) }
    else if (has('rulings-section')) applySection(get('rulings-section'), 'rulings')
    else if (has('use-section')) applySection(get('use-section'), 'example')
    else if (has('clear-section')) applySection(get('clear-section'), 'clear')
    else if (has('use-field')) { const field = protocolField(get('use-field')); if (!field || field.managedBy) return; if (field.setting) delete state.values[field.id]; else state.values[field.id] = structuredClone(field.lb); render(); emit(field.id) }
    else if (has('expand')) { for (const entry of PROTOCOL_OPTION_SECTIONS) open.add(`section:${entry.id}`); render() }
    else if (has('collapse')) { open = new Set(); render() }
  })
  el.addEventListener('toggle', openState, true)
  render()
  return {
    el,
    set(next) { openState(); state = normalizeProtocolDecisions(next); render() },
    value: () => structuredClone(state),
    text: () => decisionsText(state),
    setDisabled(value) { locked = !!value; disable() },
  }
}
