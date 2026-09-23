/* Candidate provenance and publication history are different facts.
 *
 * build/<version> is created when an isolated candidate is cut so its commit
 * cannot be garbage-collected. It does not say the candidate was published.
 * config/shipped-releases.json is the explicit, reviewed publication ledger.
 * Each row pins the candidate tag to its immutable commit and records the exact
 * public artifact hash; installer downgrade floors come from this ledger only.
 */
const SEMVER = /^\d+\.\d+\.\d+$/
const HEX40 = /^[0-9a-f]{40}$/i
const HEX64 = /^[0-9a-f]{64}$/i

export function validatePublishedReleaseLedger(value, {
  resolveCandidateTag = null,
  packageVersionAtRef = null,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('published release ledger must be an object')
  if (value.schemaVersion !== 1) throw new Error(`published release ledger schemaVersion must be 1, got ${value.schemaVersion}`)
  if (!Array.isArray(value.published) || value.published.length === 0) {
    throw new Error('published release ledger must contain at least one published release')
  }

  const seenVersions = new Set()
  const seenTags = new Set()
  for (const release of value.published) {
    if (!release || typeof release !== 'object' || Array.isArray(release)) throw new Error('published release row must be an object')
    if (!SEMVER.test(release.version)) throw new Error(`published release has invalid version ${JSON.stringify(release.version)}`)
    if (release.candidateTag !== `build/${release.version}`) {
      throw new Error(`published ${release.version} must name candidateTag build/${release.version}`)
    }
    if (!HEX40.test(release.buildRef)) throw new Error(`published ${release.version} has invalid buildRef`)
    if (typeof release.publishedFilename !== 'string' || !release.publishedFilename.endsWith('.exe') || !release.publishedFilename.includes(release.version)) {
      throw new Error(`published ${release.version} has invalid publishedFilename`)
    }
    if (!HEX64.test(release.publishedSha256)) throw new Error(`published ${release.version} has invalid publishedSha256`)
    if (seenVersions.has(release.version)) throw new Error(`published version ${release.version} appears more than once`)
    if (seenTags.has(release.candidateTag)) throw new Error(`candidate tag ${release.candidateTag} appears more than once`)
    seenVersions.add(release.version)
    seenTags.add(release.candidateTag)

    if (resolveCandidateTag) {
      const resolved = resolveCandidateTag(release.candidateTag)
      if (resolved !== release.buildRef) {
        throw new Error(
          `${release.candidateTag} resolves to ${resolved || '(missing)'}, not immutable ledger ref ${release.buildRef}`,
        )
      }
    }
    if (packageVersionAtRef) {
      const packageVersion = packageVersionAtRef(release.buildRef)
      if (packageVersion !== release.version) {
        throw new Error(`build ref ${release.buildRef} declares package version ${packageVersion}, not ${release.version}`)
      }
    }
  }
  return value.published.map((release) => Object.freeze({ ...release }))
}
