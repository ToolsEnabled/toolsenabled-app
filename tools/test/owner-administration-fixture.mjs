import crypto from 'node:crypto'
import path from 'node:path'
const transportPublicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey.export({ type: 'spki', format: 'pem' })
export function identity(stateRoot) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const issuer = crypto.generateKeyPairSync('ed25519')
  const context = { operationId: 'a'.repeat(48), accountId: 'fixture-account', email: 'fixture@example.test', name: 'Fixture',
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    profile: crypto.createHash('sha256').update(path.resolve(stateRoot)).digest('hex'),
    issuerPublicKey: issuer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
  const receipt = serverCollected => ({ version: 1, kind: 'owner-administration', operationId: context.operationId,
    accountId: context.accountId, publicKey: context.publicKey, profile: context.profile,
    enrollmentRequestHash: 'b'.repeat(64), credentialHash: 'e'.repeat(64), pairId: 'fixture-pair', deviceId: 'fixture-device', name: context.name,
    claimedAtMs: 100, credentialStored: true, readBackVerified: true, durable: true, serverCollected, mutationOutcome: 'STORED_SYNCED' })
  const signedRequest = (operation, overrides = {}) => {
    const request = { version: 1, operation, ...Object.fromEntries(Object.entries(context).filter(([name]) => name !== 'issuerPublicKey')), issuedAtMs: 100,
      ...(operation === 'enroll' ? { transportPublicKey } : { pairId: 'fixture-pair', deviceId: 'fixture-device', enrollmentRequestHash: 'b'.repeat(64), credentialHash: 'e'.repeat(64) }),
      ...(operation === 'collect' ? { credentialStored: true, readBackVerified: true } : {}),
      ...(operation === 'pair' ? { webDriveEnabled: true, capabilityDigest: 'c'.repeat(64) } : {}), ...overrides }
    const bytes = Buffer.from(JSON.stringify(request))
    return { request: bytes.toString('base64url'), signature: crypto.sign(null,
      Buffer.concat([Buffer.from('ToolsEnabled owner administrative enrollment v1\n'), bytes]), privateKey).toString('base64url') }
  }
  return { context, receipt, signedRequest }
}
