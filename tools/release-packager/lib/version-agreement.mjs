/* ONE RELEASE, ONE NUMBER -- and every place that number has to reach.
 *
 * THE GAP THIS CLOSES. The release version is written down in five independent
 * places, and until now nothing compared them to each other:
 *
 *   package.json               .version                 the anchor
 *   package-lock.json          .version                 npm's copy of it
 *   package-lock.json          .packages[""].version    npm's OTHER copy of it
 *   installer identity         identity.version         what the installer claims
 *   config/shipped-releases.json                        what is ALREADY public
 *
 * plus a sixth that is a different number entirely and must agree with a
 * different partner:
 *
 *   capability-defaults/package.json .version  ==  the engine source's .version
 *
 * writePackageVersion() in version-bump.mjs writes the first three together, so
 * they agree WHEN THE CUTTER DID THE BUMP. Nothing held them together when a
 * version was edited by hand, and nothing at all held the last two.
 *
 * WHY EACH ONE MATTERS, measured rather than assumed:
 *
 * 1. THE PUBLISHED-VERSION COLLISION IS THE COSTLY ONE. version-bump.mjs's own
 *    header states the rule this repo runs on: "two different binaries must
 *    never silently share a version number", and computeNextVersion() enforces
 *    it for the cutter's own arithmetic. But the rule was never checked against
 *    the PUBLICATION LEDGER. config/shipped-releases.json records 1.0.38 as
 *    published, with an exact publishedSha256 of the artifact customers hold.
 *    A tree whose package.json also says 1.0.38 cuts a SECOND, different
 *    1.0.38: same version, same pinned NSIS GUID, different bytes, and the
 *    update path decides what to install by comparing version numbers.
 *
 *    The nearest existing guard, tools/test/installer-product-identity.test.mjs
 *    'the build never lowers the version below an already shipped release',
 *    compares with `>= 0`. Equal passes it. That is deliberate for a downgrade
 *    floor and simply does not answer the collision question, which is why this
 *    is a new invariant and not a tightening of that one.
 *
 * 2. THE ENGINE PAIRING HAD A COMMENT AND NO GUARD.
 *    capability-defaults/package.json is the curated manifest staged over the
 *    engine's own via neutralDefaults; src/mcp-server.js reads its .version for
 *    the MCP serverInfo every agent client sees. Its header instructs: "On a
 *    version bump, update .version here as part of the same re-pin adoption".
 *    tools/test/payload-manifest-refs.test.mjs checks that the STAGED file
 *    equals capability-defaults -- it never compares either to the engine
 *    source, so a stale curated version ships a serverInfo that lies about
 *    which capability layer is running, and both files agree with each other
 *    while doing it.
 *
 * NOT A SPELLING PIN. Nothing here names an expected version literal. Every
 * assertion is a relation between values read at run time, so a correct bump to
 * any future number satisfies it and only a genuine disagreement fails.
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** Numeric, so 1.0.10 is newer than 1.0.9. Returns >0 when a is newer than b. */
export function compareReleaseVersions(a, b) {
  const parse = (value) => {
    const match = SEMVER.exec(String(value).trim())
    if (!match) throw new Error(`not a major.minor.patch version: ${JSON.stringify(value)}`)
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i] - right[i]
    if (diff !== 0) return diff
  }
  return 0
}

/* Every disagreement, not the first one. A checker that stops at the first
 * mismatch turns one bump into as many edit-run cycles as there are places,
 * and the last place is the one people give up before reaching. */
export function findVersionDisagreements({
  appVersion,
  lockVersion,
  lockRootVersion,
  installerIdentityVersion,
  engineVersion,
  capabilityDefaultsVersion,
  publishedVersions = [],
} = {}) {
  const problems = []

  const wellFormed = (field, value) => {
    if (typeof value === 'string' && SEMVER.test(value.trim())) return true
    problems.push({
      field,
      actual: value,
      message: `${field} is not a major.minor.patch version: ${JSON.stringify(value)}`,
    })
    return false
  }

  const anchorOk = wellFormed('package.json .version', appVersion)

  /* The three that must equal the anchor. Named individually because "the
   * versions disagree" sends someone to grep; naming the field sends them to
   * the line. */
  const mustMatchAnchor = [
    ['package-lock.json .version', lockVersion],
    ['package-lock.json .packages[""].version', lockRootVersion],
    ['installer identity .version', installerIdentityVersion],
  ]
  for (const [field, value] of mustMatchAnchor) {
    if (!wellFormed(field, value)) continue
    if (!anchorOk) continue
    if (value.trim() !== appVersion.trim()) {
      problems.push({
        field,
        expected: appVersion,
        actual: value,
        message: `${field} is ${value}, but package.json .version is ${appVersion}. `
          + 'One build would then describe itself with two different numbers depending on which file is read.',
      })
    }
  }

  /* The capability layer runs its own version line, so this pair is compared to
   * each other and NEVER to the app's release number. */
  const engineOk = wellFormed('engine package.json .version', engineVersion)
  const defaultsOk = wellFormed('capability-defaults/package.json .version', capabilityDefaultsVersion)
  if (engineOk && defaultsOk && engineVersion.trim() !== capabilityDefaultsVersion.trim()) {
    problems.push({
      field: 'capability-defaults/package.json .version',
      expected: engineVersion,
      actual: capabilityDefaultsVersion,
      message: `capability-defaults/package.json declares ${capabilityDefaultsVersion} but the engine source it stands in for declares ${engineVersion}. `
        + 'src/mcp-server.js reports the curated file as serverInfo.version, so the shipped payload would name a capability-layer version it is not.',
    })
  }

  /* Already public is not a version you may cut again. */
  if (anchorOk) {
    const collision = publishedVersions.find((published) => String(published).trim() === appVersion.trim())
    if (collision) {
      problems.push({
        field: 'package.json .version',
        actual: appVersion,
        message: `version ${appVersion} is already recorded as PUBLISHED in config/shipped-releases.json. `
          + 'Cutting it again produces a second, different artifact claiming one released version number, under the same pinned NSIS GUID; '
          + 'the published row pins the sha256 of the bytes customers already have. Bump the version before cutting.',
      })
    }
  }

  return problems
}

/** Throws naming every disagreement at once; returns the agreed anchor version. */
export function assertVersionAgreement(inputs) {
  const problems = findVersionDisagreements(inputs)
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} release-version disagreement(s):\n  ${problems.map((problem) => problem.message).join('\n  ')}`,
    )
  }
  return String(inputs.appVersion).trim()
}
