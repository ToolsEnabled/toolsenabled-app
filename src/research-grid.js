// The grid engine: an experiment as axes × values, with the runner and the
// result columns as data. Pure functions, no DOM, no storage — the designer
// renders what these return and the dispatcher iterates them. Every refusal
// is a sentence a person can act on, in the {ok:false, sentence} shape the
// rest of the workbench speaks.
//
// Nothing here knows any research domain. An axis is a name and its values;
// what the names mean belongs to the person's study, never to this file.

const MAX_AXES = 3
const MAX_VALUES_PER_AXIS = 24
const MAX_CELLS = 512
const AXIS_ID = /^[a-z][a-z0-9_]{0,31}$/
const MAX_VALUE_CHARS = 120
// 'replicate' is injected into every cell by the repeat counter and 'dataset'
// is substituted beside the axis tokens; an axis by either name would be
// silently overwritten. 'tier' stays legal — it is the reserved-MEANING axis
// the designer builds from the tier checkboxes.
const RESERVED_AXIS_IDS = new Set(['replicate', 'dataset'])

/**
 * Parse a declared axes object: { axisId: [value, ...], ... }.
 * Axis ids become the {axisId} substitution tokens, so they are lowercased
 * identifiers; values are short plain strings shown on the board verbatim.
 */
export function parseAxes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, sentence: 'Axes are written as an object: each axis name with its list of values.' }
  }
  const names = Object.keys(value)
  if (names.length === 0) return { ok: false, sentence: 'Give the grid at least one axis with at least one value.' }
  if (names.length > MAX_AXES) return { ok: false, sentence: `A grid holds at most ${MAX_AXES} axes. Fold the rest into one axis or run two experiments.` }
  const axes = []
  for (const name of names) {
    if (!AXIS_ID.test(name)) {
      return { ok: false, sentence: `"${name}" cannot name an axis — use a short lowercase name like model or effort, letters and digits only.` }
    }
    if (RESERVED_AXIS_IDS.has(name)) {
      return {
        ok: false,
        sentence: name === 'replicate'
          ? '"replicate" is reserved for the repeat counter — pick another axis name.'
          : '"dataset" is reserved for the dataset path token — pick another axis name.',
      }
    }
    const values = value[name]
    if (!Array.isArray(values) || values.length === 0) {
      return { ok: false, sentence: `Axis "${name}" needs a list with at least one value.` }
    }
    if (values.length > MAX_VALUES_PER_AXIS) {
      return { ok: false, sentence: `Axis "${name}" holds at most ${MAX_VALUES_PER_AXIS} values.` }
    }
    const cleaned = []
    for (const item of values) {
      if ((typeof item !== 'string' && typeof item !== 'number') || String(item).trim().length === 0 || String(item).length > MAX_VALUE_CHARS) {
        return { ok: false, sentence: `Axis "${name}" has a value that is not short plain text.` }
      }
      cleaned.push(String(item).trim())
    }
    if (new Set(cleaned).size !== cleaned.length) {
      return { ok: false, sentence: `Axis "${name}" repeats a value; each value appears once.` }
    }
    axes.push({ id: name, values: cleaned })
  }
  const count = axes.reduce((total, axis) => total * axis.values.length, 1)
  if (count > MAX_CELLS) {
    return { ok: false, sentence: `That grid is ${count} cells; this bench submits at most ${MAX_CELLS} per experiment.` }
  }
  return { ok: true, axes, cellCount: count }
}

export function gridCellCount(axes) {
  return axes.reduce((total, axis) => total * axis.values.length, 1)
}

/** Every cell of the grid, as { axisId: value, ... } objects in row-major order. */
export function gridCells(axes, { replicates = 1 } = {}) {
  let cells = [{}]
  for (const axis of axes) {
    const next = []
    for (const cell of cells) {
      for (const value of axis.values) next.push({ ...cell, [axis.id]: value })
    }
    cells = next
  }
  if (replicates > 1) {
    const replicated = []
    for (const cell of cells) {
      for (let replicate = 1; replicate <= replicates; replicate += 1) {
        replicated.push({ ...cell, replicate })
      }
    }
    return replicated
  }
  return cells
}

const RUNNER_KINDS = new Set(['agent', 'process', 'http'])
export const MAX_PINNED_FILES = 64

/** Declaration checks only. The service owns filesystem access, account
 * confinement and byte measurement; the designer never opens these paths. */
export function parsePinnedFiles(kind, pins) {
  if (kind !== 'process') return { ok: false, sentence: 'Pinned inputs are supported only for a command, not sessions or a web address. Remove the pins before changing runner kind.' }
  if (!Array.isArray(pins) || pins.length < 1 || pins.length > MAX_PINNED_FILES) {
    return { ok: false, sentence: `Declare 1 through ${MAX_PINNED_FILES} pinned inputs, or remove all pin rows to leave inputs unpinned.` }
  }
  const seen = new Set()
  for (const pin of pins) {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)
      || Object.keys(pin).some(key => !['path', 'sha256'].includes(key))
      || typeof pin.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(pin.sha256)) {
      return { ok: false, sentence: 'Each pinned input needs only its path and a full 64-character SHA-256 digest.' }
    }
    const file = pin.path
    const windows = typeof file === 'string' && /^[a-z]:[\\/]/i.test(file)
    if (typeof file !== 'string' || !file || file.length > 1024 || file.includes('\0')
      || (!windows && !/^\/(?!\/)/.test(file))
      || file.split(windows ? /[\\/]/ : /\//).some(part => part === '.' || part === '..')
      || (windows && (/[<>:"|?*]/.test(file.slice(2)) || file.slice(3).split(/[\\/]/).some(part => /[. ]$/.test(part))))) {
      return { ok: false, sentence: 'Use a full file path of at most 1024 characters. Parent-folder shortcuts, device paths and named data streams are not supported.' }
    }
    const identity = windows ? file.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase() : file.replace(/\/+/g, '/')
    if (seen.has(identity)) return { ok: false, sentence: 'The same input path is pinned more than once. Keep one path and digest pair.' }
    seen.add(identity)
  }
  return { ok: true, pinnedFiles: pins }
}

export function pinnedFileRowsToConfig(kind, rows) {
  const pins = (Array.isArray(rows) ? rows : []).filter(row => String(row?.path ?? '').trim() || String(row?.sha256 ?? '').trim())
    .map(row => ({ path: row.path, sha256: String(row.sha256 ?? '').trim() }))
  return pins.length ? parsePinnedFiles(kind, pins) : { ok: true }
}

const RUNNER_FORM_FIELDS = new Set(['kind', 'command', 'args', 'briefTemplate', 'url', 'pinnedFiles'])

/** Duplicate is a form prefill, not a config migration. Extra settings remain
 * visible as JSON, and an unchanged command keeps exact argument bytes. */
export function runnerDesignerFields(runner) {
  const visible = new Set(['kind', 'pinnedFiles', ...(runner.kind === 'process' ? ['command', 'args'] : runner.kind === 'agent' ? ['briefTemplate'] : ['url'])])
  return {
    runnerKind: runner.kind,
    runnerDetail: runner.kind === 'process' ? [runner.command, ...(runner.args || [])].join('\n')
      : runner.kind === 'agent' ? runner.briefTemplate : runner.url || '',
    runnerOptions: JSON.stringify(Object.fromEntries(Object.entries(runner).filter(([key]) => !visible.has(key))), null, 2),
    pinnedRows: runner.pinnedFiles || [],
    originalRunner: runner,
  }
}

/** Shared by the actual designer submit handler and its boundary tests. */
export function parseDesignerRunner({ kind, detail, pinnedRows, optionsText = '', optionsKind, originalRunner }) {
  let options
  try { options = optionsText.trim() ? JSON.parse(optionsText) : {} } catch {
    return { ok: false, sentence: 'Additional runner settings must be a JSON object. Nothing was saved.' }
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { ok: false, sentence: 'Additional runner settings must be a JSON object.' }
  if (Object.keys(options).some(key => RUNNER_FORM_FIELDS.has(key))) {
    return { ok: false, sentence: 'Use the command, address, task and pinned-input controls for those settings, not the additional settings object.' }
  }
  if (Object.keys(options).length && optionsKind && optionsKind !== kind) {
    return { ok: false, sentence: 'The additional settings belong to the previous runner kind. Keep that kind, or clear and explicitly re-enter settings for the new runner.' }
  }
  const pins = pinnedFileRowsToConfig(kind, pinnedRows)
  if (!pins.ok) return pins
  let core
  if (kind === 'process') {
    if (originalRunner?.kind === kind && detail === runnerDesignerFields(originalRunner).runnerDetail) {
      core = { command: originalRunner.command, args: originalRunner.args || [] }
    } else {
      const [command, ...args] = detail.split('\n').map(line => line.trim()).filter(Boolean)
      core = { command: command || '', args }
    }
  } else core = kind === 'agent' ? { briefTemplate: detail.trim() } : { url: detail.trim() }
  return parseRunner({ ...options, kind, ...core, ...(pins.pinnedFiles ? { pinnedFiles: pins.pinnedFiles } : {}) })
}

/**
 * Parse the runner declaration. 'agent' runs cells as tree nodes here or as
 * queued sessions; 'process' and 'http' always go to the run queue, because
 * only the service host runs commands and calls services.
 */
export function parseRunner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, sentence: 'The runner is an object with a kind: agent, process, or http.' }
  }
  if (!RUNNER_KINDS.has(value.kind)) {
    return { ok: false, sentence: 'The runner kind is agent, process, or http.' }
  }
  if (Object.hasOwn(value, 'pinnedFiles')) {
    const pins = parsePinnedFiles(value.kind, value.pinnedFiles)
    if (!pins.ok) return pins
  }
  if (value.kind === 'process') {
    if (typeof value.command !== 'string' || value.command.trim().length === 0) {
      return { ok: false, sentence: 'A process runner names the command it runs.' }
    }
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some(item => typeof item !== 'string'))) {
      return { ok: false, sentence: 'Process arguments are a list of text values; write {axis} where a cell value belongs.' }
    }
  }
  if (value.kind === 'http') {
    if (typeof value.url !== 'string' || !value.url.startsWith('https://')) {
      return { ok: false, sentence: 'An http runner declares an https:// address; plain http is not sent.' }
    }
  }
  if (value.kind === 'agent') {
    if (typeof value.briefTemplate !== 'string' || value.briefTemplate.trim().length === 0) {
      return { ok: false, sentence: 'An agent runner writes the brief each session gets; put {axis} tokens where cell values belong.' }
    }
  }
  return { ok: true, runner: value }
}

const COLUMN_KINDS = new Set(['string', 'number', 'boolean'])

/** The default result columns match what the board always shows. */
export const DEFAULT_RESULT_SCHEMA = Object.freeze({
  fields: Object.freeze({ answer: 'string' }),
  required: Object.freeze([]),
})

/**
 * Parse declared result columns: { fields: {name: kind}, required: [name] }.
 * Shallow on purpose — these become table columns and honest type checks,
 * not a schema language.
 */
export function parseResultSchema(value) {
  if (value === undefined || value === null) return { ok: true, resultSchema: DEFAULT_RESULT_SCHEMA }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, sentence: 'Result columns are an object: fields with their kinds, and which are required.' }
  }
  const fields = value.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
    return { ok: false, sentence: 'Declare at least one result column under fields.' }
  }
  for (const [name, kind] of Object.entries(fields)) {
    if (!AXIS_ID.test(name)) return { ok: false, sentence: `"${name}" cannot name a column — short lowercase names only.` }
    if (!COLUMN_KINDS.has(kind)) return { ok: false, sentence: `Column "${name}" needs a kind of string, number, or boolean.` }
  }
  const required = value.required === undefined ? [] : value.required
  if (!Array.isArray(required) || required.some(name => !Object.hasOwn(fields, name))) {
    return { ok: false, sentence: 'Every required column must be one of the declared fields.' }
  }
  return { ok: true, resultSchema: { fields: { ...fields }, required: [...required] } }
}

/**
 * One cell's brief: the template with every {axisId} replaced by that cell's
 * value. A token naming an axis the grid does not carry is a refusal — an
 * empty substitution is how a wrong brief runs quietly.
 */
export function cellBrief(template, cell) {
  const missing = []
  const text = String(template).replace(/\{([a-z][a-z0-9_]*)\}/g, (token, name) => {
    if (!Object.hasOwn(cell, name)) { missing.push(name); return token }
    return String(cell[name])
  })
  if (missing.length > 0) {
    return { ok: false, sentence: `The template names {${missing[0]}} but the grid has no axis called ${missing[0]}.` }
  }
  return { ok: true, text }
}

/** A short label for one cell, axis values joined in axis order. */
export function cellLabel(axes, cell) {
  const parts = axes.map(axis => String(cell[axis.id]))
  if (Object.hasOwn(cell, 'replicate')) parts.push(`#${cell.replicate}`)
  return parts.join(' · ')
}

/**
 * Compose the designer's axis rows into the object parseAxes reads. A row is
 * { name, values } with values written as one comma-separated line. An
 * untouched row is skipped — a blank row is a row nobody used, not a mistake —
 * while a half-filled row and a name collision are refusals, because an object
 * key would silently swallow the second of two same-named rows.
 */
export function axisRowsToObject(rows) {
  const axesRaw = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name ?? '').trim()
    const valuesText = String(row?.values ?? '').trim()
    if (name.length === 0 && valuesText.length === 0) continue
    if (name.length === 0) {
      return { ok: false, sentence: 'One axis row has values but no name. Name it, or clear the row.' }
    }
    if (Object.hasOwn(axesRaw, name)) {
      return { ok: false, sentence: `Two axis rows are both named "${name}". Give each axis its own name.` }
    }
    axesRaw[name] = valuesText.split(',').map(value => value.trim()).filter(value => value.length > 0)
  }
  return { ok: true, axesRaw }
}

/**
 * Compose the designer's result-column rows into the shape parseResultSchema
 * reads. A row is { name, kind, required }; a nameless row is one nobody used.
 * No named rows means "keep the standard columns", reported as an absent shape
 * rather than an empty one so the frozen default applies.
 */
export function columnRowsToSchema(rows) {
  const fields = {}
  const required = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name ?? '').trim()
    if (name.length === 0) continue
    if (Object.hasOwn(fields, name)) {
      return { ok: false, sentence: `Two result columns are both named "${name}". Give each column its own name.` }
    }
    fields[name] = row?.kind
    if (row?.required === true) required.push(name)
  }
  if (Object.keys(fields).length === 0) return { ok: true, schemaRaw: undefined }
  return { ok: true, schemaRaw: { fields, required } }
}

/**
 * What a declared grid will actually run, for the designer's live preview:
 * the run count with repeats included and the first few cell labels. A parse
 * refusal passes through unchanged, so the person reads the problem in the
 * preview before ever pressing Save.
 */
export function gridRunPreview(axesRaw, { replicates = 1, limit = 6 } = {}) {
  const parsed = parseAxes(axesRaw)
  if (!parsed.ok) return parsed
  const cells = gridCells(parsed.axes, { replicates })
  return {
    ok: true,
    runCount: cells.length,
    labels: cells.slice(0, limit).map(cell => cellLabel(parsed.axes, cell)),
    more: Math.max(0, cells.length - limit),
  }
}
