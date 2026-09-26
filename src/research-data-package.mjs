// Frictionless Data Package / Table Schema, deliberately independent of a domain.
// Source values remain strings in the sheet. Decoded values are available to callers;
// integers outside the safe Number range use BigInt, never a rounded identifier.
export const TABLE_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'datetime']
export const PACKAGE_PROFILE = 'https://datapackage.org/profiles/2.0/datapackage.json'
export const TABLE_PROFILE = 'https://datapackage.org/profiles/2.0/tableschema.json'
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const fail = message => { throw new Error(message) }

export function relativeDataPath(value) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f?#:%]/.test(value)
    || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('Use a relative file path inside the selected folder, with / between folders.')
  }
  return value
}

export function inspectSchema(schema) {
  if (!schema || !Array.isArray(schema.fields) || !schema.fields.length) fail('A table schema must declare its fields.')
  const names = new Set()
  for (const field of schema.fields) {
    if (typeof field?.name !== 'string' || !field.name.trim() || names.has(field.name)) fail('Column names must be nonempty and unique.')
    names.add(field.name)
    if (!TABLE_TYPES.includes(field.type)) fail(`${field.name}: declare a supported type (${TABLE_TYPES.join(', ')}).`)
    if (field.format && field.format !== 'default') fail(`${field.name}: use the default format; dates use ISO 8601.`)
    if (field.constraints !== undefined && (!field.constraints || typeof field.constraints !== 'object' || Array.isArray(field.constraints))) fail(`${field.name}: constraints must be an object.`)
    if (field.constraints) for (const key of Object.keys(field.constraints)) {
      if (!['required', 'unique', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum'].includes(key)) fail(`${field.name}: unsupported constraint ${key}.`)
    }
    const c = field.constraints || {}
    for (const key of ['required', 'unique']) if (own(c, key) && typeof c[key] !== 'boolean') fail(`${field.name}: ${key} must be true or false.`)
    for (const key of ['minLength', 'maxLength']) if (own(c, key) && (field.type !== 'string' || !Number.isSafeInteger(c[key]) || c[key] < 0)) fail(`${field.name}: ${key} requires a nonnegative integer and a text column.`)
    if (own(c, 'pattern')) { if (field.type !== 'string' || typeof c.pattern !== 'string') fail(`${field.name}: pattern requires a text column and a string.`); try { new RegExp(c.pattern, 'u') } catch { fail(`${field.name}: invalid pattern.`) } }
    if (own(c, 'enum') && !Array.isArray(c.enum)) fail(`${field.name}: enum must be an array.`)
    for (const key of ['minimum', 'maximum']) if (own(c, key)) {
      if (!['integer', 'number', 'date', 'datetime'].includes(field.type)) fail(`${field.name}: range constraints require a numeric or date column.`)
      if (['integer', 'number'].includes(field.type) && (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || field.type === 'integer' && !Number.isSafeInteger(c[key]))) fail(`${field.name}: ${key} must be an exact JSON number.`)
      try { decodeValue(String(c[key]), { ...field, constraints: {} }, {}) } catch { fail(`${field.name}: invalid ${key} for ${field.type}.`) }
    }
    if (own(c, 'minimum') && own(c, 'maximum') && comparable(c.minimum, field.type) > comparable(c.maximum, field.type)) fail(`${field.name}: minimum exceeds maximum.`)
  }
  if (schema.fieldsMatch && !['exact', 'equal'].includes(schema.fieldsMatch)) fail('Supported fieldsMatch values are exact and equal.')
  const primaryKey = schema.primaryKey == null ? [] : [].concat(schema.primaryKey)
  if (primaryKey.some(name => !names.has(name))) fail('Every primary key column must be declared in fields.')
  for (const missing of [schema.missingValues, ...schema.fields.map(field => field.missingValues)]) {
    if (missing !== undefined && (!Array.isArray(missing) || missing.some(v => typeof v !== 'string'))) fail('Declare missingValues as an array of strings.')
  }
  return schema
}

export function inspectPackage(descriptor) {
  if (!descriptor || !Array.isArray(descriptor.resources) || !descriptor.resources.length) fail('datapackage.json must contain a nonempty resources array.')
  const names = new Set()
  return descriptor.resources.map(resource => {
    if (typeof resource.name !== 'string' || !/^[a-z0-9._-]+$/.test(resource.name) || names.has(resource.name)) fail('Each resource needs a unique lowercase name using letters, numbers, ., _ or -.')
    names.add(resource.name)
    const paths = [].concat(resource.path || [])
    if (!paths.length) fail(`${resource.name}: provide a CSV or TSV file path.`)
    paths.forEach(relativeDataPath)
    const format = (resource.format || (/\.tsv(?:\.gz)?$/i.test(paths[0]) ? 'tsv' : 'csv')).toLowerCase()
    if (!['csv', 'tsv'].includes(format)) fail(`${resource.name}: this importer supports CSV and TSV tables, optionally gzip-compressed.`)
    if (resource.encoding && !/^utf-?8$/i.test(resource.encoding)) fail(`${resource.name}: encode the table as UTF-8.`)
    if (typeof resource.schema === 'string') relativeDataPath(resource.schema)
    else inspectSchema(resource.schema)
    const dialect = resource.dialect || {}
    if (typeof dialect !== 'object' || Array.isArray(dialect)) fail(`${resource.name}: put the dialect settings in an object.`)
    const csv = dialect.csv || dialect
    const delimiter = csv.delimiter || (format === 'tsv' ? '\t' : ',')
    if (typeof delimiter !== 'string' || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) fail(`${resource.name}: invalid delimiter.`)
    if (csv.quoteChar && csv.quoteChar !== '"' || csv.doubleQuote === false || dialect.header === false
      || dialect.headerRows && JSON.stringify(dialect.headerRows) !== '[1]' || dialect.skipRows?.length) fail(`${resource.name}: use a header on the first row and doubled double-quotes for escaped quotes.`)
    return { ...resource, paths, format, delimiter }
  })
}

// RFC 4180 quoting, including quoted line breaks and quotes divided across chunks.
export async function* csvRows(chunks, { delimiter = ',', signal, maxCellLength = 1024 * 1024 } = {}) {
  let row = [], cell = '', state = 'plain', skipLF = false, first = true, touched = false
  for await (let chunk of chunks) {
    if (signal?.aborted) throw new DOMException('Read cancelled.', 'AbortError')
    if (first && chunk.length) { chunk = chunk.replace(/^\uFEFF/, ''); first = false }
    for (const char of chunk) {
      if (skipLF) { skipLF = false; if (char === '\n') continue }
      if (state === 'quoted') {
        if (char === '"') state = 'afterQuote'
        else cell += char
      } else if (state === 'afterQuote' && char === '"') { cell += '"'; state = 'quoted' }
      else if (char === delimiter) { row.push(cell); cell = ''; state = 'plain'; touched = true }
      else if (char === '\r' || char === '\n') {
        row.push(cell); yield row; row = []; cell = ''; state = 'plain'; touched = false; skipLF = char === '\r'
      } else if (state === 'afterQuote') fail('Unexpected text after a closing CSV quote.')
      else if (char === '"') {
        if (cell) fail('Quote inside an unquoted CSV field.')
        state = 'quoted'; touched = true
      } else { cell += char; touched = true }
      if (cell.length > maxCellLength) fail('A cell exceeds the supported 1 MiB limit.')
      if (row.length > 2048) fail('A table exceeds the supported 2048 columns.')
    }
  }
  if (state === 'quoted') fail('Unclosed CSV quote at the end of the file.')
  if (touched || row.length || cell || state === 'afterQuote') { row.push(cell); yield row }
}

export async function* textChunks(stream, signal) {
  const reader = stream.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Read cancelled.', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      yield decoder.decode(value, { stream: true })
    }
    const end = decoder.decode(); if (end) yield end
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

// Compare timestamps as instants while preserving their original spelling in the
// sheet. Fractional seconds retain nanosecond precision, including before 1970.
function comparable(value, type) {
  if (type !== 'datetime') return value
  const fraction = String(value).match(/\.(\d{1,9})/)?.[1] || ''
  return BigInt(Date.parse(value)) * 1000000n + BigInt(fraction.padEnd(9, '0').slice(3))
}

export function decodeValue(raw, field, schema) {
  const missing = field.missingValues ?? schema.missingValues ?? ['']
  if (missing.includes(raw)) {
    if (field.constraints?.required || [].concat(schema.primaryKey || []).includes(field.name)) fail('A value is required.')
    return null
  }
  let value = raw
  if (field.type === 'integer') {
    if (!/^[+-]?\d+$/.test(raw)) fail('Expected an integer.')
    const exact = BigInt(raw)
    value = exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : exact
  } else if (field.type === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) fail('Expected a finite number without currency signs or thousands separators.')
    value = Number(raw)
  } else if (field.type === 'boolean') {
    if (!['true', 'false', 'True', 'False', 'TRUE', 'FALSE', '1', '0'].includes(raw)) fail('Expected true, false, 1 or 0.')
    value = /^(true|1)$/i.test(raw)
  } else if (field.type === 'date') {
    if (!validDate(raw)) fail('Expected a valid YYYY-MM-DD date.')
  } else if (field.type === 'datetime') {
    if (!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(raw)
      || !validDate(raw.slice(0, 10)) || !Number.isFinite(Date.parse(raw))) fail('Expected an ISO timestamp with seconds and a timezone, such as 2026-01-01T12:00:00Z.')
  }
  const c = field.constraints || {}
  const ordered = comparable(value, field.type)
  if (own(c, 'minimum') && ordered < comparable(c.minimum, field.type) || own(c, 'maximum') && ordered > comparable(c.maximum, field.type)) fail('Value is outside the declared range.')
  if (own(c, 'minLength') && raw.length < c.minLength || own(c, 'maxLength') && raw.length > c.maxLength) fail('Text length is outside the declared range.')
  if (c.pattern && !new RegExp(c.pattern, 'u').test(raw)) fail('Value does not match the declared pattern.')
  if (c.enum && !c.enum.some(item => typeof value === 'bigint' ? String(item) === String(value) : Object.is(item, value))) fail('Value is not one of the declared choices.')
  return value
}

export function headerMapping(header, schema) {
  inspectSchema(schema)
  if (new Set(header).size !== header.length || header.some(name => !name)) fail('The header contains an empty or duplicate column name.')
  const names = schema.fields.map(field => field.name)
  if (header.length !== names.length || names.some(name => !header.includes(name))) fail('The CSV header must contain exactly the columns declared in its schema.')
  if ((schema.fieldsMatch || 'exact') === 'exact' && names.some((name, i) => header[i] !== name)) fail('The CSV column order differs from the schema. Reorder it or declare fieldsMatch: equal.')
  return names.map(name => header.indexOf(name))
}

export function decodeRow(raw, schema, mapping, rowNumber) {
  const errors = [], values = []
  if (raw.length !== mapping.length) errors.push({ row: rowNumber, column: '', message: `Expected ${mapping.length} cells; found ${raw.length}.` })
  const cells = schema.fields.map((field, i) => raw[mapping[i]] ?? '')
  schema.fields.forEach((field, i) => {
    try { values.push(decodeValue(cells[i], field, schema)) }
    catch (error) { values.push(null); errors.push({ row: rowNumber, column: field.name, message: error.message }) }
  })
  return { cells, values, errors, rowNumber }
}

export async function readTablePage(stream, resource, { offset = 0, limit = 100, search = '', signal, onProgress = () => {} } = {}) {
  const rows = [], errors = []; let scanned = 0, matched = 0, mapping = null, errorCount = 0
  for await (const raw of csvRows(textChunks(stream, signal), { delimiter: resource.delimiter || ',', signal })) {
    if (!mapping) { mapping = headerMapping(raw, resource.schema); continue }
    scanned++
    const row = decodeRow(raw, resource.schema, mapping, scanned + 1)
    errorCount += row.errors.length; if (errors.length < 100) errors.push(...row.errors.slice(0, 100 - errors.length))
    if (scanned % 10000 === 0) onProgress(scanned)
    if (search && !row.cells.some(cell => cell.toLowerCase().includes(search.toLowerCase()))) continue
    if (matched++ < offset) continue
    if (rows.length === limit) return { rows, errors, errorCount, scanned, matched, hasMore: true, complete: false }
    rows.push(row)
  }
  if (!mapping) fail('The table is empty; include a header row.')
  return { rows, errors, errorCount, scanned, matched, hasMore: false, complete: true }
}

export async function validateTable(stream, resource, { signal, onProgress = () => {} } = {}) {
  let count = 0, errorCount = 0, mapping = null
  const errors = [], keys = new Map(), keyColumns = [].concat(resource.schema.primaryKey || [])
  const unique = resource.schema.fields.filter(f => f.constraints?.unique).map(f => [f.name])
  if (keyColumns.length) unique.push(keyColumns)
  let uniquenessComplete = true
  for await (const raw of csvRows(textChunks(stream, signal), { delimiter: resource.delimiter || ',', signal })) {
    if (!mapping) { mapping = headerMapping(raw, resource.schema); continue }
    count++
    const row = decodeRow(raw, resource.schema, mapping, count + 1)
    if (count <= 1000000) for (const columns of unique) {
      const indexes = columns.map(name => resource.schema.fields.findIndex(f => f.name === name))
      const vals = indexes.map(index => row.values[index] === null ? null : comparable(row.values[index], resource.schema.fields[index].type))
      if (vals.some(v => v === null)) continue
      const id = JSON.stringify(columns), set = keys.get(id) || new Set()
      keys.set(id, set)
      const key = JSON.stringify(vals, (_k, value) => typeof value === 'bigint' ? value.toString() : value)
      if (set.has(key)) row.errors.push({ row: count + 1, column: columns.join(', '), message: 'Duplicate key.' })
      set.add(key)
    } else if (unique.length) uniquenessComplete = false
    errorCount += row.errors.length
    if (errors.length < 100) errors.push(...row.errors.slice(0, 100 - errors.length))
    if (count % 10000 === 0) onProgress(count)
  }
  if (!mapping) fail('The table is empty; include a header row.')
  return { count, errorCount, errors, uniquenessComplete, foreignKeysChecked: !resource.schema.foreignKeys?.length }
}

export function schemaForHeaders(headers) {
  return { $schema: TABLE_PROFILE, fields: headers.map(name => ({ name, type: 'string' })), missingValues: [''] }
}
