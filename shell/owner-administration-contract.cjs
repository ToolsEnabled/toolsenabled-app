'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const ACTIONS = new Set(['identity', 'prepare', 'import', 'finalize', 'resume', 'pair-request', 'cancel'])
const CONTEXT_KEYS = ['operationId', 'accountId', 'email', 'name', 'publicKey', 'profile', 'issuerPublicKey']
const RECEIPT_KEYS = ['version', 'kind', 'operationId', 'accountId', 'publicKey', 'profile', 'enrollmentRequestHash', 'credentialHash',
  'pairId', 'deviceId', 'name', 'claimedAtMs', 'credentialStored', 'readBackVerified', 'durable', 'serverCollected', 'mutationOutcome']
function exact(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function text(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value)
}
function key(value) {
  if (!text(value, 100)) throw Error('Invalid public key')
  const bytes = Buffer.from(value, 'base64url')
  const parsed = crypto.createPublicKey({ key: bytes, type: 'spki', format: 'der' })
  if (parsed.asymmetricKeyType !== 'ed25519' || bytes.toString('base64url') !== value
    || parsed.export({ format: 'der', type: 'spki' }).toString('base64url') !== value) throw Error('Invalid public key')
  return parsed
}
function context(value, stateRoot, discovery = false) {
  if (discovery) {
    if (!value || value.publicKey !== null) throw Error('Discovery requires an unpinned key')
    const checked = context({ ...value, publicKey: value.issuerPublicKey }, stateRoot)
    return Object.freeze({ ...checked, publicKey: null })
  }
  if (!exact(value, CONTEXT_KEYS) || !/^[0-9a-f]{48}$/.test(value.operationId || '')
    || !text(value.accountId) || !text(value.email, 320) || !text(value.name, 64)
    || !/^[0-9a-f]{64}$/.test(value.profile || '')) throw Error('Invalid administrative context')
  key(value.publicKey); key(value.issuerPublicKey)
  if (stateRoot !== undefined && (!path.isAbsolute(stateRoot)
    || crypto.createHash('sha256').update(path.resolve(stateRoot)).digest('hex') !== value.profile)) throw Error('Invalid profile binding')
  return Object.freeze(Object.fromEntries(CONTEXT_KEYS.map(name => [name, value[name]])))
}
function binding(value) {
  const normalized = context(value)
  return Object.freeze({ operationId: normalized.operationId,
    contextDigest: crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex') })
}
function receipt(value, expected) {
  if (!exact(value, RECEIPT_KEYS) || value.version !== 1 || value.kind !== 'owner-administration'
      || ['operationId', 'accountId', 'publicKey', 'profile', 'name'].some(name => value[name] !== expected[name])
      || !/^[0-9a-f]{64}$/.test(value.enrollmentRequestHash || '') || !/^[0-9a-f]{64}$/.test(value.credentialHash || '') || !text(value.pairId) || !text(value.deviceId)
      || !Number.isSafeInteger(value.claimedAtMs) || value.claimedAtMs < 0
      || value.credentialStored !== true || value.readBackVerified !== true || value.durable !== true
      || typeof value.serverCollected !== 'boolean' || !['STORED_SYNCED', 'NOT_ATTEMPTED'].includes(value.mutationOutcome)) throw Error('Invalid durable receipt')
  return Object.freeze(Object.fromEntries(RECEIPT_KEYS.map(name => [name, value[name]])))
}
function signedRequest(value, expected, operation) {
  if (!exact(value, ['request', 'signature']) || !text(value.request, 24000) || !text(value.signature, 100)) throw Error('Invalid signed request')
  const bytes = Buffer.from(value.request, 'base64url')
  const signature = Buffer.from(value.signature, 'base64url')
  if (bytes.toString('base64url') !== value.request || signature.length !== 64
      || signature.toString('base64url') !== value.signature) throw Error('Invalid encoding')
  const request = JSON.parse(bytes.toString('utf8'))
  const common = ['version', 'operation', 'operationId', 'accountId', 'email', 'name', 'publicKey', 'profile', 'issuedAtMs']
  const extras = { enroll: ['transportPublicKey'], collect: ['pairId', 'deviceId', 'enrollmentRequestHash', 'credentialHash', 'credentialStored', 'readBackVerified'],
    pair: ['pairId', 'deviceId', 'enrollmentRequestHash', 'credentialHash', 'webDriveEnabled', 'capabilityDigest'] }
  if (!extras[operation] || !exact(request, [...common, ...extras[operation]]) || request.version !== 1 || request.operation !== operation
      || CONTEXT_KEYS.filter(name => name !== 'issuerPublicKey').some(name => request[name] !== expected[name])
      || !Number.isSafeInteger(request.issuedAtMs) || request.issuedAtMs < 0
      || !crypto.verify(null, Buffer.concat([Buffer.from('ToolsEnabled owner administrative enrollment v1\n'), bytes]), key(expected.publicKey), signature)) throw Error('Invalid request binding')
  if (operation === 'enroll') {
    if (typeof request.transportPublicKey !== 'string' || request.transportPublicKey.length > 2000) throw Error('Invalid transport')
    const transport = crypto.createPublicKey(request.transportPublicKey)
    if (transport.asymmetricKeyType !== 'rsa' || transport.asymmetricKeyDetails?.modulusLength !== 3072
        || transport.export({ type: 'spki', format: 'pem' }) !== request.transportPublicKey) throw Error('Invalid transport')
  }
  if (operation !== 'enroll' && (!text(request.pairId) || !text(request.deviceId)
      || !/^[0-9a-f]{64}$/.test(request.enrollmentRequestHash || '') || !/^[0-9a-f]{64}$/.test(request.credentialHash || ''))) throw Error('Invalid receipt binding')
  if (operation === 'collect' && (request.credentialStored !== true || request.readBackVerified !== true)) throw Error('Invalid storage evidence')
  if (operation === 'pair' && (request.webDriveEnabled !== true || !/^[0-9a-f]{64}$/.test(request.capabilityDigest || ''))) throw Error('Invalid consent evidence')
  return Object.freeze({ request: value.request, signature: value.signature })
}
function answer(value, expected, action) {
  if (!value || value.ok !== true || !ACTIONS.has(action)) throw Error('Invalid answer')
  if (action === 'identity') {
    if (value.stage !== 'identity') throw Error('Invalid identity stage')
    key(value.publicKey)
    return Object.freeze({ ok: true, stage: 'identity', publicKey: value.publicKey })
  }
  const allowed = { prepare: ['prepared'], import: ['stored'], finalize: ['finalized'],
    resume: ['prepared', 'stored'], 'pair-request': ['pair-request'], cancel: ['cancelled'] }
  if (!allowed[action].includes(value.stage)) throw Error('Invalid stage')
  const output = { ok: true, stage: value.stage }
  if (['stored', 'finalized', 'pair-request'].includes(value.stage)) {
    output.receipt = receipt(value.receipt, expected)
    if (output.receipt.serverCollected !== ['finalized', 'pair-request'].includes(value.stage)) throw Error('Invalid collection evidence')
  }
  const operation = { prepared: 'enroll', stored: 'collect', 'pair-request': 'pair' }[value.stage]
  if (operation) output.signedRequest = signedRequest(value.signedRequest, expected, operation)
  // No unknown child field or error text reaches a renderer, including future
  // credential-shaped additions to an otherwise valid answer.
  return Object.freeze(output)
}
function pairDigest(pairId) {
  if (!text(pairId)) throw Error('Invalid pair')
  return crypto.createHash('sha256').update('te.relay.pair.v1\n' + pairId
    + '\ncapabilities\nproviders.install\nproviders.login-start\nproviders.login-status\nproviders.presence').digest('hex')
}
module.exports = { ACTIONS, CONTEXT_KEYS, exact, context, binding, receipt, answer, pairDigest }
