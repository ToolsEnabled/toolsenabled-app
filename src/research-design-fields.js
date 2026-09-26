// Labeled fields for the grouped assignment design (spec.designPlan). Rows are
// plain text; the builder converts them to the frozen contract when the design
// is applied, so unfinished values survive a refusal, a save and a remount.
import { invariant } from './benchmark/prompts.mjs'

const copy = value => structuredClone(value)
// Row keys must stay unique across a page reload: restored rows carry their
// old keys, so the counter is raised past every safe-integer key it sees (an
// unsafe-integer suffix -- at or beyond Number.MAX_SAFE_INTEGER, where ++ is
// a fixed point -- is ignored so the counter can never get stuck) before it
// issues a new one, and a new key is never handed out while a row already
// holds it. A draft persisted before either guarantee existed can still
// carry a duplicate key on restore; setRows below repairs that.
let keySeq = 0
const nextKey = (taken = []) => { const used = new Set(taken); let key; do { keySeq = Number.isSafeInteger(keySeq) ? keySeq + 1 : 1; key = 'design-' + keySeq } while (used.has(key)); return key }
const allKeys = rows => [...rows.arms, ...rows.phases, ...rows.contrasts].map(row => row.key)
const adoptKeys = rows => { for (const key of allKeys(rows)) { const match = /^design-(\d+)$/.exec(String(key || '')); if (match) { const value = Number(match[1]); if (Number.isSafeInteger(value)) keySeq = Math.max(keySeq, value) } } }
const text = value => String(value ?? '')
// Factor levels are typed the way task factors are typed: a level that parses
// as a JSON number or boolean keeps that type; anything else is a string. A
// string level that would itself parse back as a number or boolean (for
// example the literal string "1" or "true") is shown quoted, exactly the way
// it would need to be typed back in, so the round trip never changes its type.
function parseLevel(raw) {
  const value = raw.trim()
  if (/^".*"$/.test(value)) { try { const quoted = JSON.parse(value); if (typeof quoted === 'string') return quoted } catch { /* fall through: not valid JSON, read as plain text below */ } }
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) return Number(value)
  if (value === 'true' || value === 'false') return value === 'true'
  return value
}
// A comma inside a literal string level would otherwise be read as the
// boundary between two levels, so the splitter only breaks on a comma outside
// a quoted JSON string literal, and such a level is shown quoted too.
const splitLevelsText = text => {
  const parts = []
  let current = '', quoted = false
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (quoted) { current += ch; if (ch === '\\' && index + 1 < text.length) { current += text[++index]; continue } if (ch === '"') quoted = false; continue }
    if (ch === '"') { quoted = true; current += ch; continue }
    if (ch === ',') { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  return parts
}
const needsQuoting = level => level.includes(',') || parseLevel(level) !== level
const levelsText = levels => Array.isArray(levels) ? levels.map(level => typeof level === 'string' ? (needsQuoting(level) ? JSON.stringify(level) : level) : JSON.stringify(level)).join(', ') : ''
export function designRowsFromPlan(plan) {
  if (!plan) return { present: false, rationale: '', arms: [], unit: { enabled: false, groupBy: '', members: '2' }, phases: [], contrasts: [] }
  return { present: true, rationale: text(plan.rationale),
    arms: (plan.arms || []).map(arm => ({ key: nextKey(), id: text(arm.id), label: text(arm.label), conditionIds: [...(arm.conditionIds || [])] })),
    unit: plan.unit ? { enabled: true, groupBy: text(plan.unit.groupBy).replace(/^factor:/, ''), members: text(plan.unit.members) } : { enabled: false, groupBy: '', members: '2' },
    phases: (plan.phases || []).map(phase => ({ key: nextKey(), id: text(phase.id), draws: text(phase.draws), requiresRecordedDecision: text(phase.requiresRecordedDecision),
      factorLevels: Object.entries(phase.factorLevels || {}).map(([factor, levels]) => ({ factor, levels: levelsText(levels) })) })),
    contrasts: (plan.contrasts || []).map(contrast => ({ key: nextKey(), id: text(contrast.id), first: text(contrast.first), second: text(contrast.second) })) }
}
export function emptyDesignRows() { return designRowsFromPlan(null) }
// Convert rows to the contract, or null when the design is switched off.
// Nothing is coerced silently: every refusal names the row.
export function designPlanFromRows(rows) {
  invariant(rows && typeof rows === 'object', 'Design fields must be an object.')
  if (!rows.present) return null
  const plan = { version: 1, rationale: text(rows.rationale) }
  if (rows.arms.length) plan.arms = rows.arms.map((arm, index) => {
    const label = 'Arm ' + (index + 1) + (arm.id ? ' (' + arm.id + ')' : '')
    invariant(Array.isArray(arm.conditionIds) && arm.conditionIds.length > 0, label + ': tick at least one condition.')
    return { id: text(arm.id).trim(), conditionIds: [...arm.conditionIds], ...(text(arm.label).trim() ? { label: text(arm.label).trim() } : {}) }
  })
  if (rows.unit.enabled) {
    const members = text(rows.unit.members).trim()
    invariant(/^[1-9][0-9]*$/.test(members), 'Draw unit: members per draw must be a whole number.')
    invariant(text(rows.unit.groupBy).trim(), 'Draw unit: choose the task factor that groups a draw.')
    plan.unit = { kind: 'draw', groupBy: 'factor:' + text(rows.unit.groupBy).trim(), members: Number(members) }
  }
  if (rows.phases.length) plan.phases = rows.phases.map((phase, index) => {
    const label = 'Phase ' + (index + 1) + (phase.id ? ' (' + phase.id + ')' : ''), draws = text(phase.draws).trim()
    invariant(/^[1-9][0-9]*$/.test(draws), label + ': draws must be a whole number of replicates.')
    const result = { id: text(phase.id).trim(), draws: Number(draws) }
    const levels = (phase.factorLevels || []).filter(row => text(row.levels).trim())
    if (levels.length) result.factorLevels = Object.fromEntries(levels.map(row => { invariant(text(row.factor).trim(), label + ': name the factor for each level list.'); return [text(row.factor).trim(), splitLevelsText(text(row.levels)).map(parseLevel).filter(level => level !== '')] }))
    if (text(phase.requiresRecordedDecision).trim()) result.requiresRecordedDecision = text(phase.requiresRecordedDecision).trim()
    return result
  })
  if (rows.contrasts.length) plan.contrasts = rows.contrasts.map(contrast => ({ id: text(contrast.id).trim(), first: text(contrast.first).trim(), second: text(contrast.second).trim() }))
  return plan
}

export function createDesignFieldsEditor({ onChange = () => {} } = {}) {
  let rows = emptyDesignRows(), context = { conditionIds: [], factors: [] }, disabled = false, destroyed = false
  const el = document.createElement('div')
  const mark = (node, name, value = '') => { node.setAttribute('data-design-fields-' + name, value); return node }
  mark(el, 'editor')
  const make = (tag, content) => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; return node }
  const label = (title, input) => { const node = make('label'); node.append(make('span', title), input); return node }
  const emit = () => { if (!destroyed) onChange(copy(rows)) }
  const bind = (node, update, { redraw = false, refresh = false } = {}) => { node.addEventListener('input', event => { event.stopPropagation(); if (disabled || destroyed) return; update(node.type === 'checkbox' ? node.checked : node.value); if (redraw) render(); else if (refresh) refreshOptions(); emit() }); return node }
  // Identifier typing must not rebuild the form. Dependent selects (contrast
  // arms, phase decisions) and the summary are refreshed in place instead.
  const setOptions = (node, options) => { const value = node.value; node.replaceChildren(); for (const [id, title] of options) { const option = make('option', title); option.value = id; node.append(option) } node.value = options.some(([id]) => id === value) ? value : '' }
  function refreshOptions() {
    const armOptions = [['', 'Choose an arm'], ...rows.arms.map(arm => [arm.id, arm.id || '(unnamed)'])]
    for (const name of ['contrast-first', 'contrast-second']) for (const node of el.querySelectorAll('[data-design-fields-' + name + ']')) setOptions(node, armOptions)
    el.querySelectorAll('[data-design-fields-phase-decision]').forEach((node, index) => setOptions(node, [['', 'None'], ...rows.phases.slice(0, index).map(other => [other.id, other.id || '(unnamed)'])]))
    const summary = el.querySelector('[data-design-fields-summary]'); if (summary) summary.textContent = summaryText()
  }
  const summaryText = () => rows.arms.length + ' arm' + (rows.arms.length === 1 ? '' : 's') + ', ' + (rows.unit.enabled ? 'draw unit on ' + (rows.unit.groupBy || '(no factor)') : 'no draw unit') + ', ' + rows.phases.length + ' phase' + (rows.phases.length === 1 ? '' : 's') + ', ' + rows.contrasts.length + ' contrast' + (rows.contrasts.length === 1 ? '' : 's') + '.'
  const input = (name, value, placeholder = '') => { const node = mark(make('input'), name); node.type = 'text'; node.value = value; node.placeholder = placeholder; return node }
  const select = (name, value, options) => { const node = mark(make('select'), name); for (const [id, title] of options) { const option = make('option', title); option.value = id; if (id === value) option.selected = true; node.append(option) } node.value = value; return node }
  const button = (name, title, action) => { const node = mark(make('button', title), name); node.type = 'button'; node.disabled = disabled; node.addEventListener('click', event => { event.stopPropagation(); if (disabled || destroyed) return; action(); render(); emit() }); return node }
  function render() {
    el.replaceChildren()
    const toggle = mark(make('input'), 'present'); toggle.type = 'checkbox'; toggle.checked = rows.present === true; toggle.disabled = disabled
    el.append(label('Declare a grouped assignment design', bind(toggle, value => { rows.present = value === true }, { redraw: true })))
    if (!rows.present) { el.append(mark(make('p', 'No design is declared; the schedule is the plain crossed task, condition and replicate design.'), 'summary')); return }
    const rationale = mark(make('textarea'), 'rationale'); rationale.rows = 3; rationale.value = rows.rationale; rationale.disabled = disabled
    el.append(label('Design rationale', bind(rationale, value => { rows.rationale = value })))
    // Arms
    const arms = mark(make('fieldset'), 'arms'); arms.disabled = disabled; arms.append(make('legend', 'Arms (condition groups)'))
    rows.arms.forEach((arm, index) => {
      const row = mark(make('div'), 'arm', arm.key)
      row.append(label('Arm identifier', bind(input('arm-id', arm.id, 'sequential'), value => { arm.id = value }, { refresh: true })), label('Label', bind(input('arm-label', arm.label, 'One task at a time'), value => { arm.label = value })))
      const members = mark(make('div'), 'arm-conditions')
      for (const id of context.conditionIds) {
        const box = mark(make('input'), 'arm-condition', id); box.type = 'checkbox'; box.checked = arm.conditionIds.includes(id)
        members.append(label(id, bind(box, value => { arm.conditionIds = value ? [...new Set([...arm.conditionIds, id])] : arm.conditionIds.filter(other => other !== id) })))
      }
      row.append(members, button('remove-arm', 'Remove arm ' + (index + 1), () => { rows.arms = rows.arms.filter(other => other.key !== arm.key) }))
      arms.append(row)
    })
    arms.append(button('add-arm', 'Add arm', () => { rows.arms.push({ key: nextKey(allKeys(rows)), id: '', label: '', conditionIds: [] }) }))
    el.append(arms)
    // Draw unit
    const unit = mark(make('fieldset'), 'unit'); unit.disabled = disabled; unit.append(make('legend', 'Draw unit'))
    const enabled = mark(make('input'), 'unit-enabled'); enabled.type = 'checkbox'; enabled.checked = rows.unit.enabled === true
    unit.append(label('Group tasks into draws', bind(enabled, value => { rows.unit.enabled = value === true }, { redraw: true })))
    if (rows.unit.enabled) unit.append(label('Task factor that groups a draw', bind(select('unit-factor', rows.unit.groupBy, [['', 'Choose a factor'], ...context.factors.map(factor => [factor, factor])]), value => { rows.unit.groupBy = value })),
      label('Members per draw', bind(input('unit-members', rows.unit.members, '2'), value => { rows.unit.members = value })))
    el.append(unit)
    // Phases
    const phases = mark(make('fieldset'), 'phases'); phases.disabled = disabled; phases.append(make('legend', 'Phases (ordered replicate ranges)'))
    rows.phases.forEach((phase, index) => {
      const row = mark(make('div'), 'phase', phase.key)
      row.append(label('Phase identifier', bind(input('phase-id', phase.id, 'pilot'), value => { phase.id = value }, { refresh: true })), label('Draws (replicates)', bind(input('phase-draws', phase.draws, '2'), value => { phase.draws = value })),
        label('Requires a recorded decision from phase', bind(select('phase-decision', phase.requiresRecordedDecision, [['', 'None'], ...rows.phases.slice(0, index).map(other => [other.id, other.id || '(unnamed)'])]), value => { phase.requiresRecordedDecision = value })))
      for (const factor of context.factors) {
        const current = phase.factorLevels.find(row => row.factor === factor) || (phase.factorLevels.push({ factor, levels: '' }), phase.factorLevels.at(-1))
        row.append(label('Levels of ' + factor + ' in this phase (comma-separated; blank means all)', bind(input('phase-levels', current.levels, ''), value => { current.levels = value })))
      }
      row.append(button('remove-phase', 'Remove phase ' + (index + 1), () => { rows.phases = rows.phases.filter(other => other.key !== phase.key) }))
      phases.append(row)
    })
    phases.append(button('add-phase', 'Add phase', () => { rows.phases.push({ key: nextKey(allKeys(rows)), id: '', draws: '', requiresRecordedDecision: '', factorLevels: [] }) }))
    el.append(phases)
    // Arm contrasts
    const contrasts = mark(make('fieldset'), 'contrasts'); contrasts.disabled = disabled; contrasts.append(make('legend', 'Planned arm contrasts (first minus second)'))
    const armOptions = [['', 'Choose an arm'], ...rows.arms.map(arm => [arm.id, arm.id || '(unnamed)'])]
    rows.contrasts.forEach((contrast, index) => {
      const row = mark(make('div'), 'contrast', contrast.key)
      row.append(label('Contrast identifier', bind(input('contrast-id', contrast.id, 'isolation-vs-sequential'), value => { contrast.id = value })),
        label('First arm', bind(select('contrast-first', contrast.first, armOptions), value => { contrast.first = value })), label('Second arm', bind(select('contrast-second', contrast.second, armOptions), value => { contrast.second = value })),
        button('remove-contrast', 'Remove contrast ' + (index + 1), () => { rows.contrasts = rows.contrasts.filter(other => other.key !== contrast.key) }))
      contrasts.append(row)
    })
    contrasts.append(button('add-contrast', 'Add contrast', () => { rows.contrasts.push({ key: nextKey(allKeys(rows)), id: '', first: '', second: '' }) }))
    el.append(contrasts)
    el.append(mark(make('p', summaryText()), 'summary'))
  }
  render()
  return { el,
    setContext(next) {
      const conditionIds = [...(next.conditionIds || [])], factors = [...(next.factors || [])]
      const sameValues = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
      if (sameValues(context.conditionIds, conditionIds) && sameValues(context.factors, factors)) return
      context = { conditionIds, factors }; render()
    },
    setRows(next) {
      rows = next ? copy(next) : emptyDesignRows()
      adoptKeys(rows)
      // A row without a key gets one; a row whose key was already claimed by
      // an earlier row in this same restore (a persisted duplicate) gets a
      // fresh one too, so a duplicate never survives a restore.
      const seen = new Set()
      for (const list of [rows.arms, rows.phases, rows.contrasts]) for (const row of list) {
        if (row.key && !seen.has(row.key)) seen.add(row.key)
        else { row.key = nextKey(allKeys(rows)); seen.add(row.key) }
      }
      render()
    },
    getRows() { return copy(rows) },
    setDisabled(value) { const next = value === true; if (next === disabled) return; disabled = next; render() },
    destroy() { destroyed = true; el.replaceChildren() } }
}
