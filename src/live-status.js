// Fetches the read-only snapshot written by tools/gen-status.mjs
// (public/data/status.json → served at /data/status.json). This module
// NEVER invents a number: a network failure, a missing file, or a
// malformed payload all resolve to an explicit `{ ok: false, reason }`
// rather than a default/zero/mock value. Callers must branch on `ok`.

const STATUS_URL = '/data/status.json'

export const PROJECTION_DOMAINS = Object.freeze([
  'fleet', 'agents', 'metrics', 'ops', 'ledger', 'coordinator', 'research',
])

/** Fetch + validate the snapshot once. Read-only; no retries, no mutation. */
export async function fetchStatus() {
  let res
  try {
    res = await fetch(STATUS_URL, { cache: 'no-store' })
  } catch (err) {
    return { ok: false, reason: `network error reaching ${STATUS_URL}: ${err.message || err}` }
  }
  if (!res.ok) {
    return { ok: false, reason: `${STATUS_URL} responded ${res.status} ${res.statusText}` }
  }
  let data
  try {
    data = await res.json()
  } catch (err) {
    return { ok: false, reason: `${STATUS_URL} did not parse as JSON: ${err.message || err}` }
  }
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1) {
    return { ok: false, reason: `${STATUS_URL} has an unrecognized shape (missing/wrong schemaVersion)` }
  }
  // fetchedAtMs is OUR clock at the moment of a successful pull — distinct
  // from data.generatedAt (the generator's clock) and from each section's
  // own observedAt/authenticatedAt/at (the underlying reading's clock).
  // All three can legitimately disagree; the UI must be able to show any of
  // them rather than collapsing to one "as of" number.
  if (data.ok === false) {
    return { ok: false, reason: data.reason, data, fetchedAtMs: Date.now() }
  }
  return { ok: true, data, fetchedAtMs: Date.now() }
}

/**
 * Fetch one schema plus its domain snapshot and validate the payload in the
 * browser before returning it.  A valid unavailable envelope remains
 * unavailable end to end: callers receive `{ok:false, reason}` with the
 * validated envelope attached as `data`, never a plausible empty value.
 */
export async function fetchProjection(domain, { fetchImpl = fetch } = {}) {
  if (!PROJECTION_DOMAINS.includes(domain)) {
    return { ok: false, reason: `unknown projection domain: ${domain}` }
  }
  const dataUrl = `/data/${domain}.json`
  const schemaUrl = `/data/schema/${domain}.schema.json`
  let dataResponse
  let schemaResponse
  try {
    ;[dataResponse, schemaResponse] = await Promise.all([
      fetchImpl(dataUrl, { cache: 'no-store' }),
      fetchImpl(schemaUrl, { cache: 'no-store' }),
    ])
  } catch (err) {
    return { ok: false, reason: `network error reaching ${dataUrl} or ${schemaUrl}: ${err?.message || err}` }
  }
  if (!dataResponse?.ok) {
    return { ok: false, reason: `${dataUrl} responded ${dataResponse?.status ?? 'without a response'} ${dataResponse?.statusText || ''}`.trim() }
  }
  if (!schemaResponse?.ok) {
    return { ok: false, reason: `${schemaUrl} responded ${schemaResponse?.status ?? 'without a response'} ${schemaResponse?.statusText || ''}`.trim() }
  }

  let data
  let schema
  try {
    ;[data, schema] = await Promise.all([dataResponse.json(), schemaResponse.json()])
  } catch (err) {
    return { ok: false, reason: `${dataUrl} or ${schemaUrl} did not parse as JSON: ${err?.message || err}` }
  }
  if (!recognizedProjectionSchema(schema, domain)) {
    return { ok: false, reason: `${schemaUrl} has an unrecognized schema contract` }
  }
  const errors = validateSchemaValue(data, schema)
  if (errors.length) {
    return { ok: false, reason: `${dataUrl} failed schema validation: ${errors[0]}` }
  }
  const fetchedAtMs = Date.now()
  if (data.ok === false) {
    return { ok: false, reason: data.reason, data, fetchedAtMs }
  }
  return { ok: true, data, fetchedAtMs }
}

export const fetchFleet = options => fetchProjection('fleet', options)
export const fetchAgents = options => fetchProjection('agents', options)
export const fetchMetrics = options => fetchProjection('metrics', options)
export const fetchOps = options => fetchProjection('ops', options)
export const fetchLedger = options => fetchProjection('ledger', options)
export const fetchCoordinator = options => fetchProjection('coordinator', options)
export const fetchResearch = options => fetchProjection('research', options)

function recognizedProjectionSchema(schema, domain) {
  return isPlainObject(schema)
    && typeof schema.$schema === 'string'
    && typeof schema.$id === 'string'
    && schema.$id.endsWith(`/${domain}.schema.json`)
    && schema.type === 'object'
    && schema.additionalProperties === false
    && isPlainObject(schema.properties)
    && schema.properties.schemaVersion?.const === 1
    && schema.properties.domain?.const === domain
    && isPlainObject(schema.$defs?.source)
    && isPlainObject(schema.$defs?.data)
    && Array.isArray(schema.required)
    && ['schemaVersion', 'domain', 'generatedAt', 'ok', 'reason', 'sources', 'data']
      .every(key => schema.required.includes(key))
}

/** Small JSON-Schema subset shared semantically with gen-projection-lib.mjs. */
function validateSchemaValue(value, schema, rootSchema = schema, path = '$') {
  const errors = []
  validateNode(value, schema, rootSchema, path, errors)
  return errors
}

function validateNode(value, schema, rootSchema, path, errors) {
  if (!isPlainObject(schema)) { errors.push(`${path}: schema node is not an object`); return }
  if (typeof schema.$ref === 'string') {
    const target = resolveSchemaRef(rootSchema, schema.$ref)
    if (!target) errors.push(`${path}: unresolved schema reference ${schema.$ref}`)
    else validateNode(value, target, rootSchema, path, errors)
    return
  }
  if (Array.isArray(schema.allOf)) for (const child of schema.allOf) validateNode(value, child, rootSchema, path, errors)
  if (Array.isArray(schema.anyOf)) {
    const count = schema.anyOf.filter(child => validateSchemaValue(value, child, rootSchema, path).length === 0).length
    if (count === 0) errors.push(`${path}: does not match any allowed shape`)
  }
  if (Array.isArray(schema.oneOf)) {
    const count = schema.oneOf.filter(child => validateSchemaValue(value, child, rootSchema, path).length === 0).length
    if (count !== 1) errors.push(`${path}: must match exactly one allowed shape (matched ${count})`)
  }
  if (isPlainObject(schema.if)) {
    const matched = validateSchemaValue(value, schema.if, rootSchema, path).length === 0
    if (matched && isPlainObject(schema.then)) validateNode(value, schema.then, rootSchema, path, errors)
    if (!matched && isPlainObject(schema.else)) validateNode(value, schema.else, rootSchema, path, errors)
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}: must equal the declared constant`)
  if (Array.isArray(schema.enum) && !schema.enum.some(entry => JSON.stringify(value) === JSON.stringify(entry))) errors.push(`${path}: value is not in the declared enum`)

  const types = Array.isArray(schema.type) ? schema.type : (typeof schema.type === 'string' ? [schema.type] : [])
  if (types.length && !types.some(type => schemaTypeMatches(value, type))) { errors.push(`${path}: expected ${types.join('|')}`); return }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) for (const key of schema.required) if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property ${key}`)
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) validateNode(child, properties[key], rootSchema, `${path}.${key}`, errors)
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`)
      else if (isPlainObject(schema.additionalProperties)) validateNode(child, schema.additionalProperties, rootSchema, `${path}.${key}`, errors)
    }
    if (Number.isSafeInteger(schema.minProperties) && Object.keys(value).length < schema.minProperties) errors.push(`${path}: too few properties`)
    if (Number.isSafeInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) errors.push(`${path}: too many properties`)
  }
  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path}: too few items`)
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}: too many items`)
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items must be unique`)
    if (isPlainObject(schema.items)) value.forEach((item, index) => validateNode(item, schema.items, rootSchema, `${path}[${index}]`, errors))
  }
  if (typeof value === 'string') {
    if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path}: string is too short`)
    if (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path}: string is too long`)
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern, 'u')).test(value)) errors.push(`${path}: string does not match pattern`)
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) errors.push(`${path}: invalid date-time`)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: number is below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: number is above maximum`)
  }
}

function resolveSchemaRef(rootSchema, ref) {
  if (!ref.startsWith('#/')) return null
  let current = rootSchema
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return null
    current = current[key]
  }
  return current
}

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isPlainObject(value)
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  return typeof value === type
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** age in ms, or null if the input timestamp is missing/unparseable. */
export function ageMs(iso, nowMs = Date.now()) {
  if (!iso) return null
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, nowMs - t)
}

/** Human "3h 12m ago" / "42s ago" style relative age. null input -> null output. */
export function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  const remM = m % 60
  if (h < 24) return remM ? `${h}h ${remM}m ago` : `${h}h ago`
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH ? `${d}d ${remH}h ago` : `${d}d ago`
}
