// Pure inventory semantics extracted from installer-lifecycle.mjs. Callers
// select the fixed source identity table. This function performs no I/O and
// never creates the production reader's privately branded inventory authority.
const HASH = /^[a-f0-9]{64}$/i
const sameHash = (a, b) => HASH.test(a || '') && HASH.test(b || '') && a.toLowerCase() === b.toLowerCase()
const sameArtifact = (a, b) => sameHash(a?.sha256, b?.sha256) && a.bytes === b.bytes && Number.isSafeInteger(a.bytes) && a.bytes > 0

function refuse(message) {
  const error = new Error(`Installer lifecycle blocked: ${message}`)
  error.code = 'INSTALLER_LIFECYCLE_BLOCKED'
  error.cleanupUncertain = false
  error.cleanupUnconfirmed = false
  throw error
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) refuse(`unknown or missing ${label} contract`)
}
function exactSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some(item => !actual.includes(item))) refuse(`incomplete or unknown ${label}`)
}
function subjectValid(subject) {
  if (subject && Object.hasOwn(subject, 'installer')) refuse('ambiguous or legacy installer identity; the canonical measured subject uses artifact only')
  if (!sameArtifact(subject?.artifact, subject?.artifact) || !HASH.test(subject?.runtimeSha256 || '') || !HASH.test(subject?.shellSha256 || '')) refuse('exact installer/runtime/shell subject is missing')
}
function relativeFile(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 512 && !value.includes('\\') &&
    !/[:<>"|?*\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

export function validateLifecycleInventory(value, product, identities) {
  const identity = identities?.[product]
  if (!identity || !Object.hasOwn(identities, product)) refuse('unknown product identity')
  exactKeys(value, ['schemaVersion', 'product', 'supportedBaselines', 'dataPolicy', 'interruptionPolicy'], 'baseline inventory')
  if (value.schemaVersion !== 1 || value.product !== product || !Array.isArray(value.supportedBaselines) || !value.supportedBaselines.length) refuse('supported baseline inventory is absent or empty; upgrade coverage is unmeasured')
  const ids = new Set(), artifacts = new Set()
  for (const baseline of value.supportedBaselines) {
    exactKeys(baseline, ['id', 'version', 'subject', 'contentLayout'], 'supported baseline')
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(baseline.id || '') || ids.has(baseline.id) || typeof baseline.version !== 'string' || !baseline.version.trim()) refuse('invalid or duplicate supported baseline')
    subjectValid(baseline.subject)
    if (artifacts.has(baseline.subject.artifact.sha256.toLowerCase())) refuse('duplicate supported baseline artifact')
    // Keep existing migration refusal; a caller cannot redefine old layouts.
    if (baseline.contentLayout !== 'current') refuse(`baseline ${baseline.id}: content-layout migration driver is unavailable`)
    ids.add(baseline.id); artifacts.add(baseline.subject.artifact.sha256.toLowerCase())
  }
  exactKeys(value.dataPolicy, ['id', 'declaration', 'uninstallModes', 'contentKinds', 'contentRoots'], 'data policy')
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value.dataPolicy.id || '') || !relativeFile(value.dataPolicy.declaration)) refuse('documented source-controlled data policy is unavailable')
  exactSet(value.dataPolicy.uninstallModes, identity.uninstallModes, 'uninstall/data decisions')
  exactSet(value.dataPolicy.contentKinds, identity.contentKinds, 'real customer-content kinds')
  exactSet(value.dataPolicy.contentRoots, identity.contentRoots, 'customer-data root census')
  exactKeys(value.interruptionPolicy, ['points', 'recovery'], 'interrupted recovery policy')
  exactSet(value.interruptionPolicy.points, ['fresh-install-files-written', 'upgrade-files-written', 'uninstall-files-removed'], 'interruption points')
  if (value.interruptionPolicy.recovery !== 'rerun-exact-candidate-and-reopen') refuse('documented interrupted recovery strategy is unavailable')
  return value
}
