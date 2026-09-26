import { csvRows, decodeRow, headerMapping, relativeDataPath, textChunks } from './research-data-package.mjs'

export const sourceQualityKey = (resource, path) => `${resource}\u0000${path}`

// There is no row limit and no file-size limit on a quality-notes resource.
// The rows are read as a stream and turned into notes one at a time, so a file
// of any length and any byte size is read to its end.
//
// What is held afterwards is one record per recorded note, because the sheet
// heading has to be able to name a file's verdict without re-reading the file.
// That retention is the only bound left, it is set far above any plausible
// assessment of a real dataset, and reaching it refuses the whole load with a
// message that names the bound and says nothing was applied. It never drops a
// verdict quietly: a partial reading of a quality file is exactly the failure
// mode this bound exists to avoid.
export const SOURCE_QUALITY_LIMITS = Object.freeze({
  notes: 2000000,
  held: 'one record per recorded note, so a file’s verdict can be shown beside its sheet without re-reading the notes',
})
export const SOURCE_QUALITY_REQUIRED_COLUMNS = Object.freeze(['resource', 'path', 'verdict', 'reason'])
export const SEVERITIES = Object.freeze(['excluded', 'concern', 'none'])

// The default reading of a verdict spelling, used only when the package does
// not state its own. Two things matter here. Anything a package clears is
// cleared; anything else it bothered to record a verdict for is flagged. A
// spelling this list has never seen — provisional, superseded, vorläufig — is
// a recorded verdict, so it is marked, not silently ranked as clean.
export const SOURCE_QUALITY_DEFAULT_READING = Object.freeze({
  excluded: Object.freeze(['excluded', 'exclude', 'excludes', 'failed', 'fail', 'fails', 'rejected', 'reject', 'unusable', 'invalid']),
  none: Object.freeze(['pass', 'passed', 'passes', 'ok', 'okay', 'clear', 'cleared', 'clean', 'valid', 'included', 'include', 'accepted', 'accept', 'good', 'none', 'no issue', 'no issues']),
})

const normal = value => String(value ?? '').trim().toLocaleLowerCase()
const fail = message => { throw new Error(message) }

// A package may state what its own verdict spellings mean, in any wording and
// any language: { "vorläufig": "concern", "überholt": "excluded" }.
export function sourceQualityVocabulary(descriptor) {
  const declared = descriptor?.toolsenabled?.sourceQualityVerdicts
  if (declared === undefined) return null
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) fail('toolsenabled.sourceQualityVerdicts must map each verdict spelling to excluded, concern or none.')
  const map = new Map()
  for (const [spelling, severity] of Object.entries(declared)) {
    if (!normal(spelling)) fail('toolsenabled.sourceQualityVerdicts cannot rank a blank verdict spelling.')
    if (!SEVERITIES.includes(severity)) fail(`toolsenabled.sourceQualityVerdicts ranks ${spelling} as ${severity}; use ${SEVERITIES.join(', ')}.`)
    map.set(normal(spelling), severity)
  }
  return map
}

const vocabularyOf = vocabulary => vocabulary instanceof Map ? vocabulary
  : vocabulary && typeof vocabulary === 'object' ? new Map(Object.entries(vocabulary).map(([key, value]) => [normal(key), value]))
  : null

// The severity of one verdict spelling. The package's own ranking wins; then
// the default reading above; then, for any spelling nobody has ranked, the
// fact that a verdict was recorded at all.
export function sourceQualitySeverity(verdict, vocabulary = null) {
  const value = normal(verdict)
  if (!value) return 'none'
  const declared = vocabularyOf(vocabulary)?.get(value)
  if (SEVERITIES.includes(declared)) return declared
  if (SOURCE_QUALITY_DEFAULT_READING.excluded.includes(value)) return 'excluded'
  if (SOURCE_QUALITY_DEFAULT_READING.none.includes(value)) return 'none'
  return 'concern'
}

// A row may rank itself through an optional severity column, which is the most
// direct way for a dataset to say what one of its own verdicts means. Loading
// has already refused any other spelling in that column, so the fall-through
// here only applies to notes assembled by a caller rather than read from a file.
export function noteSeverity(note, vocabulary = null) {
  const declared = normal(note?.severity)
  if (SEVERITIES.includes(declared)) return declared
  return sourceQualitySeverity(note?.verdict, vocabulary)
}

// This opt-in package property is a ToolsEnabled convention. The referenced
// quality notes remain an ordinary, independently readable CSV/TSV resource.
export async function loadSourceQuality(descriptor, resources, openTable, { signal, maxNotes = SOURCE_QUALITY_LIMITS.notes } = {}) {
  const name = descriptor?.toolsenabled?.sourceQuality
  if (name === undefined) return null
  if (typeof name !== 'string' || !name) throw new Error('toolsenabled.sourceQuality must name a quality-notes resource.')
  const resource = resources.find(item => item.name === name)
  if (!resource) throw new Error(`Quality-notes resource ${name} is missing from the package.`)
  for (const column of SOURCE_QUALITY_REQUIRED_COLUMNS) {
    if (!resource.schema.fields.some(field => field.name === column && field.type === 'string')) throw new Error(`Quality notes require a text column named ${column}.`)
  }
  const vocabulary = sourceQualityVocabulary(descriptor)
  const ranksItself = resource.schema.fields.some(field => field.name === 'severity' && field.type === 'string')
  const targets = new Map(resources.map(item => [item.name, item])), entries = new Map()
  let count = 0, bytes = 0, rows = 0, errorCount = 0
  const errors = []
  for (const path of resource.resolvedPaths) {
    const stream = (await openTable(path, signal)).pipeThrough(new TransformStream({
      transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk) },
    }))
    let mapping = null
    for await (const raw of csvRows(textChunks(stream, signal), { delimiter: resource.delimiter || ',', signal })) {
      if (!mapping) { mapping = headerMapping(raw, resource.schema); continue }
      rows++
      const row = decodeRow(raw, resource.schema, mapping, rows + 1)
      if (row.errors.length) {
        errorCount += row.errors.length
        // Keep the first hundred so the count reported below is the true total
        // rather than the number that happened to fit.
        if (errors.length < 100) errors.push(...row.errors.slice(0, 100 - errors.length))
        continue
      }
      const record = Object.fromEntries(resource.schema.fields.map((field, index) => [field.name, row.values[index]]))
      for (const column of SOURCE_QUALITY_REQUIRED_COLUMNS) {
        if (typeof record[column] !== 'string' || !record[column].trim()) throw new Error(`Quality notes row ${row.rowNumber}: ${column} is required.`)
      }
      if (ranksItself && normal(record.severity) && !SEVERITIES.includes(normal(record.severity))) {
        throw new Error(`Quality notes row ${row.rowNumber}: severity ${record.severity} is not ${SEVERITIES.join(', ')}. Leave it blank to use the verdict, or rank the spelling in toolsenabled.sourceQualityVerdicts.`)
      }
      const target = targets.get(record.resource), relative = relativeDataPath(record.path)
      const part = target?.paths.indexOf(relative) ?? -1
      if (part < 0) throw new Error(`Quality notes row ${row.rowNumber} refers to an undeclared data file: ${record.resource} / ${relative}.`)
      if (count >= maxNotes) {
        throw new Error(`Quality notes for ${name} passed ${maxNotes.toLocaleString('en-US')} recorded notes at row ${row.rowNumber}, which is the most this page holds at once. `
          + `It holds ${SOURCE_QUALITY_LIMITS.held}, and it has no partial mode: nothing here was truncated and no file has been marked either way. `
          + 'Load a quality-notes resource within that count, or split the assessment across separate packages.')
      }
      const key = sourceQualityKey(record.resource, target.resolvedPaths[part])
      const notes = entries.get(key) || []
      notes.push(record); entries.set(key, notes); count++
    }
    if (!mapping) throw new Error(`Quality notes resource ${name}: ${path} has no header row.`)
  }
  if (errorCount) throw new Error(`Quality notes contain ${errorCount} format errors; first at row ${errors[0].row}: ${errors[0].message}`)
  return { resource: name, entries, count, rows, bytes, vocabulary, ranksItself, limits: SOURCE_QUALITY_LIMITS }
}

// The strongest verdict recorded for a file decides, in any order: a later
// passing check of one property never cancels a recorded exclusion.
export function sourceQualityFlag(notes, vocabulary = null) {
  const recorded = Array.isArray(notes) ? notes : []
  const worst = recorded.find(item => noteSeverity(item, vocabulary) === 'excluded') || recorded.find(item => noteSeverity(item, vocabulary) === 'concern')
  if (!worst) return { excluded: false, severity: 'none', verdict: '', label: '' }
  const severity = noteSeverity(worst, vocabulary)
  return { excluded: severity === 'excluded', severity, verdict: worst.verdict, label: `Source quality: ${worst.verdict}${severity === 'excluded' ? ' · this file is not sound data' : ''}` }
}
