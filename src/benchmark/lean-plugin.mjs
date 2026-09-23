// Lean Bench's registration with the core. This file is part of the VERTICAL,
// not the core: it is allowed to import lean-* and trading-*, and the core is
// allowed to import nothing from it.
//
// It exists so that "what a third party must do to add a benchmark" has exactly
// one answer, and Lean Bench is the worked example of it. If this file were
// deleted, the core would still compile and run; it would simply have no Lean
// Bench. That is the property the old direct imports made impossible.
import { invariant } from './prompts.mjs'
import { registerBenchmark } from './registry.mjs'
import { leanProjectFiles } from './lean-codegen.mjs'
import { LEAN_EXTRACTION_POLICY, matchesNativeObservationProfile } from './lean-observations.mjs'
import { leanContractId, operationalStudy, OPERATIONAL_PROFILE } from './trading-study.mjs'
import { interpretLean } from './lean.mjs'
import { simulateTradingMarket } from './trading-market.mjs'

export const LEAN_BENCHMARK_ID = 'lean-bench'

// Lean Bench claims the fallback because it is the benchmark every project in
// this tree was frozen under: before the registry existed the core called
// pythonSource() unconditionally, so a study that declares no benchmark must
// keep extracting exactly as it did. A third-party benchmark registers with
// fallback omitted and is selected by its own matches(spec).
export const leanBenchmark = registerBenchmark({
  id: LEAN_BENCHMARK_ID,
  label: 'Lean Bench',
  fallback: true,
  // The study domain this benchmark admits. study.mjs used to hardcode it.
  domains: ['lean-bench'],
  // Shipped by ToolsEnabled and qualified by its own suites, so readiness may
  // reason about it with the built-in profiles. A benchmark registered by
  // anyone else omits this and is admitted under the third-party profile.
  firstParty: true,
  matches: spec => Boolean(spec) && (operationalStudy(spec) !== null || spec?.domain === 'lean-bench'),
  extraction: LEAN_EXTRACTION_POLICY,
  // The spec.leanProfile values this benchmark accepts. study.mjs used to hold
  // this list literally, alongside a domain test.
  profiles: ['synchronous-v1', OPERATIONAL_PROFILE],
  // How a study in this benchmark is interpreted, for the readiness contract.
  // The core has no opinion about which module is the oracle; the benchmark does.
  oracle: spec => operationalStudy(spec)
    ? { kind: 'builtin-operational-interpretation', source: 'trading-market.mjs' }
    : { kind: 'builtin-lean-interpretation', source: 'lean.mjs' },
  // Whether a retained native trace has the shape this benchmark records.
  matchesObservationProfile: (trace, operational) => matchesNativeObservationProfile(trace, operational),
  // The grading contract this benchmark implements. study.mjs used to carry
  // 'lean-python' inside a literal list of six, bind it to this domain with a
  // second literal, and hold this benchmark's Docker-digest and timeout rules in
  // the core. A third party declaring its own contract was refused at freeze
  // before any of its code ran, which no import inventory could see.
  //
  // assertReady IS A THUNK. study.mjs calls it while validating a study; calling
  // it here would run a benchmark's rules at registration time.
  // The spec.environment keys this benchmark owns. readiness.mjs used to carry
  // 'leanImage' inside its own literal allowlist of core keys, which made a
  // third party's own frozen configuration a hard run-time refusal.
  environmentKeys: ['leanImage'],
  gradingKinds: [{
    value: 'lean-python',
    title: 'LEAN Python',
    label: 'LEAN Python in pinned engine',
    // Information treatments may be graded by this contract. tasks.mjs carried
    // that fact as a literal 'lean-python' in a core allowlist.
    supportsInformation: true,
    // The protocol.grading fields this contract carries. study.mjs spelled this
    // as `kind === 'lean-python' ? ['executionTimeoutMs'] : []`.
    fields: ['executionTimeoutMs'],
    help: 'LEAN Python grading executes returned Python in the exported CLI or run service. Set environment.leanImage to an immutable Docker image digest (image@sha256:…), and allow at least 120 seconds per attempt for engine startup. The frozen prompt includes the exact strategy paths and input bars.',
    assertReady: spec => {
      const protocol = spec.protocol
      invariant(typeof spec.environment?.leanImage === 'string' && /^[a-z0-9][a-z0-9._\/:\-]*@sha256:[a-f0-9]{64}$/.test(spec.environment.leanImage), 'Pin the LEAN Docker image by SHA-256 digest in environment.leanImage before freezing code grading.')
      invariant(protocol.timeoutMs > 1000, 'LEAN grading needs an attempt budget greater than one second.')
      if (protocol.grading.executionTimeoutMs !== undefined) invariant(Number.isSafeInteger(protocol.grading.executionTimeoutMs) && protocol.grading.executionTimeoutMs >= 1 && protocol.grading.executionTimeoutMs <= protocol.timeoutMs - 1, 'The LEAN execution timeout must fit within the attempt budget.')
    },
  }],
  // The Research page surface this benchmark needs. The page used to decide this
  // with branches on spec.domain === 'lean-bench', so these fields appeared for
  // Lean Bench and could not appear for anyone else. A benchmark that declares
  // none of them gets the page's own generic surface.
  //
  // taskTrace IS A THUNK, called when a task is previewed. interpretLean and
  // simulateTradingMarket are already on this file's static graph through
  // lean-codegen and trading-study, so declaring it costs no new edge; calling
  // it during registration would close study -> plugins -> lean-plugin -> ... ->
  // study at module-init time.
  page: {
    fields: ['trace-details', 'combinations', 'derive-expected'],
    derivesExpected: true,
    taskTrace: (spec, task, compiled) => compiled.operational
      ? simulateTradingMarket(compiled.operational, task.input)
      : interpretLean(compiled.semantic, task.input),
  },
  // What the Research page offers in its Starter list. These were two of four
  // hardcoded <option> elements in a template string on that page, so a
  // registered third-party benchmark could not appear in the one control where a
  // benchmark is chosen.
  //
  // create IS A THUNK AND MUST STAY ONE. Building these reaches lean.mjs and
  // trading-catalog.mjs; study.mjs already imports plugins.mjs for registration,
  // so calling one while this descriptor is being registered closes
  // study -> plugins -> lean-plugin -> lean/trading-catalog -> ... -> study at
  // module-init time. The dynamic imports below also keep those modules off
  // lean-plugin's own import graph, so listing starters costs nothing.
  starters: [
    { id: 'lean-bench', label: 'Lean Bench: synchronous v1', create: async () => (await import('./lean.mjs')).leanStarter() },
    { id: 'lean-operational', label: 'Lean Bench: operational draft', create: async () => (await import('./trading-catalog.mjs')).operationalStarter() },
  ],
  // The extra files this benchmark contributes to an exported project, and the
  // precondition it puts on exporting one. export.mjs used to import both out of
  // the vertical directly; it now asks whichever benchmark owns the study.
  projectFiles: (project, sources) => leanProjectFiles(project, sources['lean-reference.py'], sources['execution_reference.py'], sources),
  assertExportable: (project, runtimeFiles) => {
    if (project.spec.domain !== 'lean-bench') return
    const bindings = project.spec.catalog.find(bundle => bundle.id === leanContractId(project.spec))?.hooks?.sourceHashes
    for (const file of runtimeFiles) {
      invariant(bindings?.[file] === project.spec.runtimeSources[file], `Review the current Lean apparatus source before exporting (${file}).`)
    }
  }
})
