import { getReadinessContract, readinessDigest } from '../../lib/release-readiness.mjs'
import { inspectSourceSuite } from '../../lib/adapters/source-suites.mjs'
import { installedLifecycleScenarioCensus } from '../../lib/adapters/installed-lifecycle.mjs'

// Registering an adapter that always refuses must not read as "ready to run".
// Two installed rows have no executable scenario at all, so the plan keeps
// them visible by name, with the reason and the remedy, and stays blocked.
const SCENARIOS = new Map(installedLifecycleScenarioCensus().map(row => [row.id, row]))

function inspectSources(product, contract, sourceRoots) {
  const names = product === 'toolsenabled' ? ['app', 'engine'] : ['website']
  if (!sourceRoots || typeof sourceRoots !== 'object' || Array.isArray(sourceRoots)
      || Object.keys(sourceRoots).length !== names.length
      || names.some(name => !Object.hasOwn(sourceRoots, name))) {
    throw new Error(`source inspection requires exactly these source roots: ${names.join(', ')}`)
  }
  const suites = contract.requirements.filter(row => row.id.startsWith('source:')).map(row => {
    // Reuse the qualifier's discovery and command reconciliation. Never infer
    // coverage from a glob or maintain a second, more permissive inventory.
    const selection = inspectSourceSuite(row.id.slice('source:'.length), { sourceRoots })
    return {
      id: row.id,
      status: selection.complete ? 'reconciled' : 'blocked',
      manifestSha256: selection.manifestSha256,
      discoveredFiles: selection.discovered.length,
      selectedFiles: selection.files.length,
      exclusions: structuredClone(selection.exclusions),
      obligations: structuredClone(selection.obligations),
    }
  })
  return {
    scope: 'source-selection-only',
    authority: 'Filesystem inventory and entry-point inspection only. No tests ran; source commits, cleanliness and runtime behavior were not verified.',
    status: suites.some(row => row.status === 'blocked') ? 'blocked' : 'unverified',
    suites,
  }
}

// A view of the fixed contract and, when requested, its current source
// selection. This does not execute tests or produce a qualification receipt.
export function createReadinessPlan(product, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['sourceRoots', 'target'].includes(key))) {
    throw new Error('planning options may only locate sourceRoots and select a registered target')
  }
  const contract = getReadinessContract(product, options.target)
  const sourceInspection = Object.hasOwn(options, 'sourceRoots')
    ? inspectSources(product, contract, options.sourceRoots) : null
  const requirements = contract.requirements.map(row => ({
    id: row.id,
    scope: row.scope,
    profiles: [...row.profiles],
    assertions: [...row.assertions],
    implementation: row.adapter ? {
      status: 'registered',
      id: row.adapter.id,
      sha256: row.adapter.sha256,
      proofScope: row.adapter.proofScope,
      ...(SCENARIOS.has(row.id) ? {
        executableScenario: SCENARIOS.get(row.id).executableScenario,
        ...(SCENARIOS.get(row.id).refusal ? { refusal: { ...SCENARIOS.get(row.id).refusal } } : {}),
      } : {}),
    } : {
      status: 'missing',
      reason: row.unavailableReason,
    },
  }))
  const missingAdapters = requirements.filter(row => row.implementation.status === 'missing').map(row => row.id)
  const unexecutableRequirements = requirements.filter(row => row.implementation.executableScenario === false).map(row => row.id)
  return {
    schema: 'toolsenabled.release-readiness-plan',
    schemaVersion: 1,
    scope: 'planning-only',
    authority: 'Source contract and optional source-selection description only; no execution or evidence verification was performed. This plan cannot qualify a release.',
    // Even a future contract with all implementations registered still needs
    // real candidate execution and independent verification before release.
    status: !contract.subjectMeasurer || missingAdapters.length || unexecutableRequirements.length || sourceInspection?.status === 'blocked' ? 'blocked' : 'unverified',
    product: contract.product,
    target: { ...contract.target },
    installer: { ...contract.installer },
    runtimeAccount: contract.runtimeAccount,
    subjectMeasurer: contract.subjectMeasurer ? { status: 'registered', ...contract.subjectMeasurer }
      : { status: 'missing', reason: contract.subjectMeasurerUnavailableReason },
    contractSha256: readinessDigest(contract),
    missingAdapters,
    unexecutableRequirements,
    requirements,
    ...(sourceInspection ? { sourceInspection } : {}),
  }
}
