// Validate the shared Engine allowance-buckets v1 wire contract. This does not
// decode any provider response, combine scopes, infer periods or rank accounts.
// Reject a damaged normalized envelope rather than repair it into a number.
const MAX_BUCKETS = 256
const bucketIssues = new Set(['invalid_modelId', 'invalid_tokenType', 'invalid_remainingFraction',
  'invalid_remainingAmount', 'invalid_resetsAt', 'model_scope_unknown', 'token_scope_unknown',
  'duplicate_bucket', 'conflicting_buckets'])
const readingIssues = new Set(['invalid_buckets', 'bucket_limit_exceeded', 'invalid_bucket'])
const INVALID = Object.freeze({ status: 'unknown', buckets: Object.freeze([]),
  issues: Object.freeze([Object.freeze({ code: 'invalid_reading' })]) })

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => Object.hasOwn(field, 'value'))
}
function text(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}
function list(value, max, valid) {
  if (!Array.isArray(value) || value.length > max) return false
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index))
    if (!field || !Object.hasOwn(field, 'value') || !valid(field.value)) return false
  }
  return true
}
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return false
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second, offset] = match
  const y = Number(year), m = Number(month), d = Number(day)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (offset === 'Z' || (Number(offset.slice(1, 3)) < 24 && Number(offset.slice(4)) < 60))
    && Number.isFinite(Date.parse(value))
}
const nullable = (value, valid) => value === null || valid(value)
const fraction = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const amount = value => typeof value === 'string' && value.length <= 128 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
export const bucketHasMeasurement = bucket => bucket.remainingFraction !== null || bucket.remainingAmount !== null

function validBucket(bucket) {
  if (!record(bucket) || !nullable(bucket.modelId, text) || !nullable(bucket.tokenType, text)
    || !nullable(bucket.remainingFraction, fraction) || !nullable(bucket.remainingAmount, amount)
    || !nullable(bucket.resetsAt, timestamp) || bucket.key !== JSON.stringify([bucket.modelId, bucket.tokenType])
    || !list(bucket.issues, bucketIssues.size, value => bucketIssues.has(value))
    || new Set(bucket.issues).size !== bucket.issues.length) return false
  const measured = bucketHasMeasurement(bucket)
  if (bucket.status !== (measured ? bucket.issues.length ? 'partial' : 'measured' : 'unknown')) return false
  if ((bucket.modelId === null) !== bucket.issues.includes('model_scope_unknown')
    || (bucket.tokenType === null) !== bucket.issues.includes('token_scope_unknown')) return false
  if (bucket.issues.some(issue => issue.startsWith('invalid_') && bucket[issue.slice(8)] !== null)) return false
  if (bucket.issues.some(issue => ['invalid_modelId', 'invalid_tokenType', 'conflicting_buckets'].includes(issue)) && measured) return false
  if (bucket.issues.includes('conflicting_buckets') && bucket.resetsAt !== null) return false
  return true
}

export function readAllowanceBuckets(value, provider) {
  if (value === null || value === undefined) return null
  if (!record(value) || value.schemaVersion !== 1 || value.provider !== provider || !text(value.provider)
    || !text(value.source) || !text(value.sourceVersion, 64) || !timestamp(value.observedAt)
    || !list(value.buckets, MAX_BUCKETS, validBucket)
    || !list(value.issues, MAX_BUCKETS, issue => record(issue) && readingIssues.has(issue.code)
      && (issue.code !== 'invalid_bucket' || Number.isInteger(issue.index) && issue.index >= 0 && issue.index < MAX_BUCKETS))
    || new Set(value.buckets.map(bucket => bucket.key)).size !== value.buckets.length) return INVALID
  const measured = value.buckets.some(bucketHasMeasurement)
  if (value.buckets.length && value.issues.some(issue => ['invalid_buckets', 'bucket_limit_exceeded'].includes(issue.code))) return INVALID
  const partial = value.issues.length || value.buckets.some(bucket => bucket.issues.length || !bucketHasMeasurement(bucket))
  if (value.status !== (measured ? partial ? 'partial' : 'measured' : 'unknown')) return INVALID
  return Object.freeze({ schemaVersion: 1, provider: value.provider, source: value.source, sourceVersion: value.sourceVersion,
    observedAt: value.observedAt, status: value.status,
    buckets: Object.freeze(value.buckets.map(bucket => Object.freeze({ key: bucket.key, modelId: bucket.modelId,
      tokenType: bucket.tokenType, remainingFraction: bucket.remainingFraction, remainingAmount: bucket.remainingAmount,
      resetsAt: bucket.resetsAt, status: bucket.status, issues: Object.freeze([...bucket.issues]) }))),
    issues: Object.freeze(value.issues.map(issue => Object.freeze({ code: issue.code,
      ...(issue.code === 'invalid_bucket' ? { index: issue.index } : {}) }))) })
}
