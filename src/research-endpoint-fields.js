// Labeled fields for typed endpoint declarations (analysisPlan.endpoints).
// The editor holds plain text rows; the builder converts them to the frozen
// contract when the analysis plan is applied, so unfinished text survives a
// refusal, a draft save and a remount without touching the applied plan.
import { invariant } from './benchmark/prompts.mjs'
import { ENDPOINT_KINDS } from './benchmark/analysis.mjs'

const copy = value => structuredClone(value)
const EXPOSURE_UNITS = ['ms', 'agent-ms', 'wall-ms', 'count']
const DIRECTIONS = ['higher-better', 'lower-better']
// Row keys must stay unique across a page reload: restored rows carry their
// old keys, so the counter is raised past every key it sees before it issues
// a new one, and a new key is never handed out while a row already holds it.
let keySeq = 0
const nextKey = (taken = []) => { const used = new Set(taken); let key; do { key = 'endpoint-' + (++keySeq) } while (used.has(key)); return key }
// A restored key's numeric suffix that is not a safe integer (a hostile or
// corrupted draft, e.g. endpoint-9007199254740993) is ignored rather than
// adopted: past Number.MAX_SAFE_INTEGER, ++keySeq can be a floating-point
// fixed point (9007199254740992 + 1 === 9007199254740992), which would make
// nextKey loop forever whenever that exact key is already taken.
const adoptKeys = rows => { for (const row of rows) { const match = /^endpoint-(\d+)$/.exec(String(row.key || '')); if (match) { const value = Number(match[1]); if (Number.isSafeInteger(value)) keySeq = Math.max(keySeq, value) } } }
// Two exact text forms for a literal path, adopted from the lane's final
// uncommitted edit (snapshot2 sha256 c8affe44e9e5a112a5b85ced1c18c2e9f63b792d25676607644967cdb38f71c7).
// The dotted form is used only when it round-trips losslessly: every string
// segment is free of dots and is not made solely of digits (a digit-only
// segment in dotted text means an index). Any other path is shown and typed
// as a JSON array, so segment content and type are never rewritten by the form.
// A segment is dotted-eligible only when it round-trips losslessly through
// plain dotted text: no whitespace anywhere (leading, trailing or inner --
// the outer text is trimmed as a whole before re-parsing, so boundary
// whitespace inside a segment cannot be told apart from incidental padding),
// no dot, not digit-only (a digit-only segment in dotted text means an
// index), and no quote or bracket character (a segment starting with '['
// would otherwise collide with the JSON-array-text heuristic below).
const plainSegment = step => typeof step === 'string' && step.length > 0 && !/[\s."\[\]]/.test(step) && !/^[0-9]+$/.test(step)
export function pathText(path) {
  if (!Array.isArray(path)) return ''
  return path.every(step => plainSegment(step) || (Number.isSafeInteger(step) && step >= 0)) ? path.map(step => String(step)).join('.') : JSON.stringify(path)
}
export function endpointPathFromText(text, label) {
  const trimmed = String(text ?? '').trim()
  invariant(trimmed.length > 0, label + ': name the attempt-record path, for example grade.conflicts, elapsedMs, or a JSON array such as ["grade","a.b"].')
  if (trimmed.startsWith('[')) {
    let parsed
    try { parsed = JSON.parse(trimmed) } catch { invariant(false, label + ': the JSON array path is not valid JSON.') }
    invariant(Array.isArray(parsed) && parsed.length > 0 && parsed.every(step => (typeof step === 'string' && step.length > 0) || (Number.isSafeInteger(step) && step >= 0)), label + ': a JSON array path lists nonempty strings or nonnegative integers.')
    return parsed
  }
  return trimmed.split('.').map(step => { invariant(step.length > 0, label + ': the path has an empty segment.'); return /^(0|[1-9][0-9]*)$/.test(step) ? Number(step) : step })
}
export function endpointRowsFromPlan(endpoints) {
  return (Array.isArray(endpoints) ? endpoints : []).map(endpoint => ({ key: nextKey(), id: endpoint.id ?? '', kind: endpoint.kind ?? 'binary', source: pathText(endpoint.source?.path),
    exposurePath: pathText(endpoint.exposure?.path), exposureUnit: endpoint.exposure?.unit ?? 'ms', cap: endpoint.cap === undefined ? '' : String(endpoint.cap),
    unit: endpoint.unit ?? '', direction: endpoint.direction ?? 'higher-better', primary: endpoint.primary === true, rationale: endpoint.rationale ?? '' }))
}
export function newEndpointRow(takenKeys = []) {
  return { key: nextKey(takenKeys), id: '', kind: 'binary', source: 'passed', exposurePath: '', exposureUnit: 'ms', cap: '', unit: '', direction: 'higher-better', primary: false, rationale: '' }
}
// Convert rows to the contract. Text stays text: an unfinished number refuses
// here with the row named, and nothing is coerced silently.
export function endpointsFromRows(rows) {
  invariant(Array.isArray(rows), 'Endpoint fields must be a list of rows.')
  return rows.map((row, index) => {
    const label = 'Endpoint ' + (index + 1) + (row.id ? ' (' + row.id + ')' : '')
    const endpoint = { id: String(row.id ?? '').trim(), kind: row.kind, source: { path: endpointPathFromText(row.source, label + ' source') } }
    if (row.kind === 'rate') endpoint.exposure = { path: endpointPathFromText(row.exposurePath, label + ' exposure'), unit: row.exposureUnit }
    if (row.kind === 'event-time') {
      const cap = String(row.cap ?? '').trim()
      invariant(/^[1-9][0-9]*$/.test(cap), label + ': the censoring cap must be a whole number of milliseconds.')
      endpoint.cap = Number(cap)
    }
    return { ...endpoint, direction: row.direction, primary: row.primary === true, unit: String(row.unit ?? '').trim(), rationale: String(row.rationale ?? '') }
  })
}

export function createEndpointFieldsEditor({ onChange = () => {} } = {}) {
  let rows = [], selected = '', disabled = false, destroyed = false
  const el = document.createElement('div')
  const mark = (node, name, value = '') => { node.setAttribute('data-endpoint-fields-' + name, value); return node }
  mark(el, 'editor')
  const make = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node }
  const label = (title, input) => { const node = make('label'); node.append(make('span', title), input); return node }
  const current = () => rows.find(row => row.key === selected) || null
  const emit = () => { if (!destroyed) onChange(copy(rows)) }
  const select = (name, value, options) => {
    const node = mark(make('select'), name)
    for (const [id, text] of options) { const option = make('option', text); option.value = id; if (id === value) option.selected = true; node.append(option) }
    node.value = value; return node
  }
  const text = (name, value, placeholder = '') => { const node = mark(make('input'), name); node.type = 'text'; node.value = value; node.placeholder = placeholder; return node }
  function bind(node, update, { redraw = false, refresh = false } = {}) {
    node.addEventListener('input', event => { event.stopPropagation(); if (disabled || destroyed) return; update(node.type === 'checkbox' ? node.checked : node.value); if (redraw) render(); else if (refresh) refreshRoster(); emit() })
    return node
  }
  // Keep the focused input in place: only the roster option text and the count sentence change while an identifier is typed.
  function refreshRoster() {
    const chooser = el.querySelector('[data-endpoint-fields-row]')
    if (chooser) for (const option of chooser.querySelectorAll('option')) { const row = rows.find(row => row.key === option.value); if (row) option.textContent = row.id ? row.id : '(unnamed)' }
    const count = el.querySelector('[data-endpoint-fields-count]')
    if (count) count.textContent = countText()
  }
  const countText = () => rows.length === 0 ? 'No typed endpoints are declared; the binary pass criterion is the primary summary.' : rows.length + ' typed endpoint' + (rows.length === 1 ? '' : 's') + ' declared.'
  function render() {
    el.replaceChildren()
    const roster = mark(make('div'), 'roster')
    const chooser = select('row', selected, rows.map(row => [row.key, row.id ? row.id : '(unnamed)']))
    chooser.addEventListener('change', event => { event.stopPropagation(); selected = chooser.value; render() })
    chooser.disabled = disabled || rows.length === 0
    const add = mark(make('button', 'Add endpoint'), 'add'); add.type = 'button'; add.disabled = disabled
    add.addEventListener('click', event => { event.stopPropagation(); if (disabled || destroyed) return; const row = newEndpointRow(rows.map(existing => existing.key)); rows.push(row); selected = row.key; render(); emit() })
    const remove = mark(make('button', 'Remove endpoint'), 'remove'); remove.type = 'button'; remove.disabled = disabled || !current()
    remove.addEventListener('click', event => { event.stopPropagation(); if (disabled || destroyed || !current()) return; const key = selected; rows = rows.filter(row => row.key !== key); selected = rows.at(-1)?.key || ''; render(); emit() })
    roster.append(label('Declared endpoint', chooser), add, remove)
    el.append(roster)
    const row = current()
    const count = mark(make('p', countText()), 'count')
    el.append(count)
    if (!row) return
    const form = mark(make('fieldset'), 'row-fields', row.key); form.disabled = disabled
    form.append(make('legend', 'Endpoint fields'))
    form.append(label('Identifier (lowercase)', bind(text('id', row.id, 'completions'), value => { row.id = value }, { refresh: true })))
    form.append(label('Kind', bind(select('kind', row.kind, ENDPOINT_KINDS.map(kind => [kind, kind])), value => { row.kind = value }, { redraw: true })))
    form.append(label('Source path in the attempt record', bind(text('source', row.source, 'grade.conflicts'), value => { row.source = value })))
    const exposure = mark(make('div'), 'exposure'); exposure.hidden = row.kind !== 'rate'
    exposure.append(label('Exposure path (rate denominator)', bind(text('exposure-path', row.exposurePath, 'elapsedMs'), value => { row.exposurePath = value })),
      label('Exposure unit', bind(select('exposure-unit', row.exposureUnit, EXPOSURE_UNITS.map(unit => [unit, unit])), value => { row.exposureUnit = value })))
    form.append(exposure)
    const cap = mark(make('div'), 'cap-field'); cap.hidden = row.kind !== 'event-time'
    cap.append(label('Censoring cap (ms)', bind(text('cap', row.cap, '60000'), value => { row.cap = value })))
    form.append(cap)
    form.append(label('Measurement unit', bind(text('unit', row.unit, 'events'), value => { row.unit = value })))
    form.append(label('Direction', bind(select('direction', row.direction, DIRECTIONS.map(direction => [direction, direction])), value => { row.direction = value })))
    const primary = mark(make('input'), 'primary'); primary.type = 'checkbox'; primary.checked = row.primary === true
    form.append(label('Primary endpoint', bind(primary, value => { row.primary = value === true })))
    const rationale = mark(make('textarea'), 'rationale'); rationale.rows = 3; rationale.value = row.rationale
    form.append(label('Rationale', bind(rationale, value => { row.rationale = value })))
    el.append(form)
  }
  render()
  return { el,
    // A draft persisted by a pre-fix build can carry duplicate keys (or a
    // hostile/corrupted one); every row after the first holder of a given
    // key is a genuinely new row and must get a fresh, distinct one so a
    // single Remove deletes exactly the row it targets.
    setRows(next) {
      rows = copy(Array.isArray(next) ? next : []); adoptKeys(rows)
      const seen = new Set()
      for (const row of rows) { if (!row.key || seen.has(row.key)) row.key = nextKey([...seen]); seen.add(row.key) }
      if (!rows.some(row => row.key === selected)) selected = rows[0]?.key || ''
      render()
    },
    getRows() { return copy(rows) },
    // Re-render only on an actual change: the builder calls this after every edit
    // (changed() -> syncControls()), and re-rendering unconditionally would
    // replace the focused input under the person's keystrokes. Adopted from the
    // lane's final uncommitted edit, snapshot2 sha256 c8affe44e9e5a112a5b85ced1c18c2e9f63b792d25676607644967cdb38f71c7.
    setDisabled(value) { const next = value === true; if (next === disabled) return; disabled = next; render() },
    destroy() { destroyed = true; el.replaceChildren() } }
}
