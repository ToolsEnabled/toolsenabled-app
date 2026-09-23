import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { peIdentityManifestIsSane } = require('../../../shell/installer-pe-identity.cjs')

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`cannot emit download manifest without ${name}`)
  return value.trim()
}

function candidateLocation(stagingDir, filename) {
  const root = requiredString(stagingDir, 'stagingDir').replace(/[\\/]+$/, '')
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root}${separator}${filename}`
}

/** Derive the web/update manifest from the same measured facts that render the
 * candidate declaration. No caller supplies a second version or hash. */
export function downloadManifestFromFacts(facts) {
  const candidate = facts?.candidate
  const versionInfo = facts?.versionInfo
  const manifest = {
    filename: requiredString(candidate?.filename, 'candidate.filename'),
    version: requiredString(facts?.version, 'version'),
    bytes: candidate?.bytes,
    sha256: requiredString(candidate?.sha256, 'candidate.sha256').toLowerCase(),
    productName: requiredString(versionInfo?.productName, 'versionInfo.productName'),
    fileVersion: requiredString(versionInfo?.fileVersion, 'versionInfo.fileVersion'),
    productVersion: requiredString(versionInfo?.productVersion, 'versionInfo.productVersion'),
    buildRef: requiredString(facts?.buildRef, 'buildRef'),
    publisher: requiredString(facts?.publisher, 'publisher'),
    appId: requiredString(facts?.appId?.configured, 'appId.configured'),
    immutableLocation: candidateLocation(facts?.stagingDir, candidate?.filename),
  }
  if (!Number.isInteger(manifest.bytes) || manifest.bytes <= 0) throw new Error('cannot emit download manifest without positive candidate.bytes')
  if (!/^[0-9a-f]{64}$/i.test(manifest.sha256)) throw new Error('cannot emit download manifest without a 64-character candidate.sha256')
  if (!/^[0-9a-f]{40}$/i.test(manifest.buildRef)) throw new Error('cannot emit download manifest without a full 40-character buildRef')
  if (!peIdentityManifestIsSane(manifest)) {
    throw new Error('cannot emit download manifest whose PE identity disagrees with its release version')
  }
  return Object.freeze(manifest)
}
