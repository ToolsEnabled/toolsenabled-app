// THE COMPOSITION ROOT. This file is neither core nor vertical: it is the one
// place that names which benchmarks this build ships with.
//
// Importing it has the side effect of registering every in-tree benchmark with
// registry.mjs. Core modules must NOT import this file -- they import
// registry.mjs and ask it questions. Entry points import this file once, early,
// so the registry is populated before any study is compiled or graded.
//
// A third party adds a benchmark by writing their own plugin module beside
// lean-plugin.mjs and adding one line here. They do not edit audit.mjs,
// tasks.mjs, export.mjs, cli.mjs or any other compiler module. That is the whole
// point of the seam; if adding a benchmark ever requires touching a core module
// again, the seam has regressed.
//
// ADDING A FIFTH VERTICAL? READ THIS FIRST.
//
// Registering here is necessary and not sufficient. Four separate places used
// to carry a literal ['generic', 'lean-bench'] domain list, and each one
// refused a third party AFTER the previous one had been opened: study.mjs
// (validateStudy), readiness.mjs (the admission profile), research-benchmark.js
// (draft import) and research-information-fields.mjs (field authoring). Three of
// them were found only because the one before it stopped being the blocker.
//
// THE REFUSAL FORM IS THE THING TO GREP FOR. A hardcoded domain list that
// REFUSES looks like `invariant(...includes(spec.domain)...)`. That is the
// pattern that blocks a new benchmark. The many `spec.domain === 'lean-bench'`
// sites are conditional BRANCHES that fall through harmlessly for an unknown
// domain, and they are noise in this search. Grep the refusal form:
//
//   grep -rnE "includes\(spec\.domain\)|includes\(project\.spec\.domain\)" src/
//
// SAME CLASS, SECOND TRAP: any module that ASKS the registry a question must
// import this file for its registration side effect, or it will refuse every
// domain -- including lean-bench -- because the registry is empty in that
// module's process. study.mjs and research-information-fields.mjs both do.
//
// THIRD TRAP, AND THE ONE THAT WILL MISLEAD YOU: EDITING A COMMENT IN ANY FILE
// LISTED IN RUNTIME_FILES MOVES EVERY EXPORTED ARTIFACT'S DIGEST. This file is
// one of them. An exported project pins the sha256 of each runtime source, and
// README.md, CITATION.bib, CITATION.cff, package.json, specification.json and
// readiness/contract.json all carry a digest derived from those pins -- so
// research-benchmark-export-bytes test A goes red for a comment, exactly as it
// would for a real change. That is CORRECT for a reproducibility instrument:
// the bytes a study would run against really did change.
//
// The converse trips people the other way, so check the list before concluding
// anything: export.mjs is NOT in RUNTIME_FILES. It is the exporter, it does not
// ship inside an exported project, and editing it moves no digest at all. I
// expected a comment there to turn the gate red, it did not, and for a moment
// that looked like a broken gate rather than a correct one. `RUNTIME_FILES` is
// the whole answer to "should this edit have moved bytes?".
//
// What it costs you is a false alarm at the worst moment. If test A is red and
// test B is GREEN, no study content moved and the cause is a runtime source
// edit -- possibly only a comment. Do not go looking for a broken compiler.
// Re-freeze with `node tools/research-benchmark-export-baseline.mjs` and say in
// the commit why the bytes moved.
//
// Isolate it by REVERTING ONE VARIABLE rather than reasoning about which change
// was responsible. That is how this note came to exist: a snippet load and a
// comment landed together, the gate went red, the snippets looked guilty, and
// reverting them alone left it red.
import './lean-plugin.mjs'

export { registeredBenchmarks, benchmarkFor, extractionPolicyFor } from './registry.mjs'
