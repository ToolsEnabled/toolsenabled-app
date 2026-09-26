# Research Benchmark Template — specification, version 2.0.0

This is the citable specification of the generic benchmark template the Research page generates studies
from. The template, not the application that hosts it, is the artifact a paper cites. Every statement here
describes what the pinned runtime in `src/benchmark/` does; where the runtime is the authority, the file and
symbol are named so the statement can be checked against the bytes a project pins.

## 0. Version and identity

| Item | Value | Where it is fixed |
| --- | --- | --- |
| Template identifier | `research-benchmark-template` | `TEMPLATE.id` in `src/benchmark/study.mjs` |
| Template version | **2.0.0** | `TEMPLATE.version` |
| Specification schema | `schemaVersion: 2` (`STUDY_VERSION`) | `src/benchmark/study.mjs` |
| Prompt compiler | `COMPILER_VERSION` 1.2.0 | `src/benchmark/prompts.mjs` |
| Analysis artifact | `ANALYSIS_VERSION` 3; analysis plan version 1; design plan version 1; typed endpoints version 1 | `src/benchmark/analysis.mjs` |
| Provenance registry | `PROVENANCE_VERSION` 1 | `src/benchmark/lean-codegen.mjs` |
| Generator release | `TEMPLATE.generator` = ToolsEnabled 1.0.45, kept equal to `package.json` by test | `src/benchmark/study.mjs` |
| Change record | `TEMPLATE.changes`: the pinned runtime files this template version changed, printed in every report | `src/benchmark/study.mjs` |

**Versioning policy.** The major number of the template version equals the specification schema version it
describes. A change that adds a section to the report or a file to the export without changing the meaning of
any frozen field raises the minor number; a change to the meaning of a frozen field raises the major number and
the schema version together. Frozen projects keep the runtime they were frozen with, so a change never
rewrites an existing study.

**Template runtime identity.** Two studies frozen with different runtime bytes never share an identity. The
identity is the SHA-256 of the canonical JSON of
`{ format: "research-benchmark-template-identity", version: 1, template: { id, version }, schemaVersion, runtimeFiles, runtimeSources }`,
where `runtimeSources` maps each of the 45 pinned runtime files to the SHA-256 of its bytes
(`templateIdentity` in `src/benchmark/study.mjs`). A project that pins no runtime sources has no runtime identity
and every artifact says so instead of guessing.

**Citation record.** Every runnable export and every report package carries `CITATION.cff` (Citation File
Format 1.2.0) and `CITATION.bib`. Both are generated from the frozen project alone by `templateCitation`, so the
page's *Export research report* and `node cli.mjs analyze` write the same bytes. The record names the study by
its frozen project digest, the template by its version and runtime identity, and the primary references of the
statistical methods the frozen plan uses, and the generator release. Authorship comes only from the optional
`citation` field of the specification (§1); when it is absent the record prints "Not declared" and never a guess.
The exported `README.md` and `package.json` (field `toolsenabled`) also state the generator release, the template
version and the runtime identity, so a standalone engine names what generated it.

## 1. Specification schema (schemaVersion 2)

A study is one JSON object. Unknown fields refuse validation (`validateVersionTwoFields`). Top-level fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | `2`. Version-1 specifications are read for legacy projects only. |
| `executionPlan` | yes | `{ version: 1, purpose }` with purpose `apparatus-development`, `recorded-diagnostic` or `experiment`; an experiment also declares its design (schedule, replicate meaning, primary outcome, dependence treatment). See `docs/research-execution-readiness.md`. |
| `id`, `name` | yes | Lowercase identifier (`^[a-z][a-z0-9_-]{0,63}$`) and a title. |
| `domain` | yes | `generic` or `lean-bench`. |
| `leanProfile`, `requireReview` | domain-specific | Lean Bench requires current personal bundle reviews before freezing. |
| `catalog` | yes | Prompt bundles: atoms and templates with typed slots (§2). |
| `tasks` | yes | 1–512 tasks (§3). |
| `conditions` | yes | 1–32 collection conditions (§4). |
| `protocol` | yes | Seed, replicates, attempt and time budgets, grading (§5). |
| `inputs` | yes | Manifest of external files, each with a relative path and SHA-256; may be empty. |
| `environment` | no | Node requirement, dependencies, instructions; the pinned `leanImage` digest for native grading. |
| `analysisPlan` | no | Cohort, primary population, denominator, contrasts, uncertainty, multiplicity, typed endpoints (§7). |
| `designPlan` | no | Arms, draw units, phases and planned arm contrasts (`docs/research-benchmark-design.md`). |
| `observationPlan` | no | How adapter reports map to identity, completion, usage and cost. |
| `requirementPlan`, `nativePreparationPlan` | no | Selected-input qualification and native preparation controls. |
| `workflowPlan` | no | Frozen sequential prompt workflows (`docs/research-benchmark-workflows.md`). |
| `corpusPlan`, `corpusHistory` | no | Mechanical task generation and its detached provenance. |
| `auditPlan`, `auditReviews` | no | Judge audit of a retained source study. |
| `experimentTemplate` | no | The generated resource-action-plan experiment (`docs/research-benchmark-resource-template.md`). |
| `decisions` | no | The investigator's rationale, printed verbatim in the report. |
| `reviews`, `taskReviews` | no | Personal review records bound to bundle and task digests. |
| `runtimeSources` | yes to freeze | SHA-256 of every pinned runtime file (§8). |
| `citation` | no | `{ authors: [{ name, affiliation?, orcid? }], title?, year?, doi?, url?, note? }`; 1–64 authors, ORCID as `0000-0000-0000-000X`, DOI without a URL prefix, https URL. |

## 2. Composition and nesting

A catalog bundle is `{ id, version, kind: "atom" | "template", role, text, parameters, slots?, semantics?, dependencies? }`.
Text carries `{{parameter}}` substitutions and, in a template, `{{slot:name}}` positions; each slot is typed by
the role it accepts and takes an atom or another template. A task names its root bundle and fills slots
recursively (`{ use, params, slots }`); references are validated to depth 128 and the composition limits of
`src/benchmark/composition.mjs` (node count and prompt length). The compiled prompt is the disclosed node prose
in tree order followed by any runtime appendix. Every compiled task carries `promptSha256`, a source map of
character ranges to node paths, the composition tree with each bundle's SHA-256 and review status, and
`compilerVersion`. A review record binds a bundle's own hash and the hashes of its dependency roots
(`catalogRoots` in `src/benchmark/prompts.mjs`); it identifies what a person acknowledged and is not an identity
attestation. Proven by `tools/test/research-benchmark-composition.test.mjs` and
`tools/test/research-benchmark-composition-fields.test.mjs`.

## 3. Tasks

`{ id, root, input, expected, split, familyId?, factors?, cohort?, variables?, information?, audit?, resource?, generation?, origin?, provenance? }`.
`split` is `development` or `held-out` and is mandatory. `familyId` names the cluster a task belongs to; a family
cannot span both splits. `factors` are named finite scalars and produce stratified tables. `information`
declares withheld requirements and the admissible readings the grader accepts. Two tasks with the same compiled
semantics refuse to freeze ("Use replicates for repeated measurements").

## 4. Conditions

`{ id, label?, model?, adapter, collection?, workflowId? }`. `model` declares provider, model id, version, surface,
fingerprint and settings. `adapter.kind` is `replay` (recorded responses keyed by task), `command` (one JSON
request on stdin, one JSON response on stdout, no shell), `http` (HTTPS POST of the same envelope, no embedded
credentials) or `module` (a pinned `.mjs` file). Credentials are referenced by environment-variable name only
and never enter any artifact. `collection` declares the comparison unit, the exact system and developer
instructions, the tool list, context construction and session isolation; the report prints what the attempts
reported applying beside what was declared.

## 5. Protocol

`seed` (0–2^32−1), `replicates` (1–100), `maxAttemptsPerTrial` (1–10), `maxTotalAttempts` (≤ 100,000),
`timeoutMs` (≤ 1 h), `maxDurationMs` (≤ 1 day), `grading.kind` ∈ `exact | json | module | lean-python |
judge-audit | resource-action-plan`. The runner retains the first completed attempt of a trial and never redraws
on its grade; transport failures alone may retry within the attempt budget. The frozen schedule is limited to
10,000 trials.

## 6. Schedule

Trials are the full cross of tasks × conditions × replicates, each with identity `task.condition.replicate`.
The order is a Fisher–Yates shuffle in Durstenfeld's in-place form, drawn from the mulberry32 generator seeded
with `protocol.seed`, so the same specification always freezes the same order. With a design plan, draws are
shuffled as whole units so the members of a draw stay adjacent, and a phase may leave trials unscheduled with
their identities retained.

## 7. Analysis plan and estimators

`analysisPlan` is `{ version: 1, cohort, primaryDenominator, primaryPopulation, rationale, contrasts, multiplicity, uncertainty, endpoints? }`.

- `cohort` ∈ `qualification | pilot | exploratory | confirmatory | legacy`; it is a label, never a review receipt.
- `primaryPopulation` is `"all"`, `{ kind: "split", split }`, `{ kind: "task-set", taskIds }` or, for an audit,
  `"reference-eligible"`. It resolves at freeze into a ledger of included and excluded tasks with the frozen
  reason; outcomes cannot change inclusion.
- `primaryDenominator` is `scheduled` (every scheduled trial, unmeasured trials included) or `completed`.
- `contrasts` (≤ 64) name two distinct conditions; the estimate is first minus second.
- `multiplicity` is `none-descriptive` or `bonferroni`.
- `uncertainty` is `null`, `{ kind: "family-bootstrap", seed, iterations, confidence }` or
  `{ kind: "cluster-bootstrap", clusterBy: "familyId" | { factor }, seed, iterations, confidence }` with
  100–10,000 resamples and a level in [0.5, 1).
- `endpoints` declares typed outcomes (binary, count, rate, duration, proportion, event-time) read by literal
  path from the retained attempt record; see `docs/research-benchmark-endpoints.md`.

**Estimators.** The primary rate of a condition is k / n over the primary population, with n the scheduled or
the completed trials as declared. A contrast is the difference of two such rates. When an uncertainty
procedure is declared, the interval is a paired percentile bootstrap over whole clusters
(`clusterInterval` and `contrastsFor` in `src/benchmark/analysis.mjs`): each of the B resamples draws clusters
(task families, or the declared factor) with replacement, keeps every cluster's rows together in both
conditions of a contrast, recomputes the statistic, and reads the (α/2, 1 − α/2) quantiles of the sorted draws
using linear interpolation at position (n − 1)p (Hyndman and Fan definition 7). With `bonferroni`, α is divided
by the number of planned intervals in the family: the planned condition contrasts, or the design-arm contrasts
when those are reported. Fewer than two clusters, or a resample with an empty denominator, leaves the interval
absent with a stated reason. Beside every contrast interval the report prints an interval note computed at
render time from the frozen plan: the per-interval level after the multiplicity rule, the position of each
endpoint among the sorted draws, the number of clusters resampled, and whether the interval is degenerate (every
resample gave the same value), in which case it is named as carrying no information about uncertainty. The
abstract headline reports the declared primary population with its eligible denominator, and every number in
the abstract is rounded exactly as in its table. The bootstrap generator is the same seeded
mulberry32 generator, so an interval is reproducible from the frozen seed. Typed endpoints use the estimators
listed in the endpoints document with the same interval procedure. Proven by
`tools/test/research-benchmark-analysis.test.mjs` and `tools/test/research-benchmark-endpoints.test.mjs`.

**Repeated trials and dispersion.** Replicates are repeated measurements of one frozen schedule. With
`replicates ≥ 2` the report computes, from the retained rows, the primary rate within each replicate index per
condition and its mean, sample standard deviation (n − 1) and range. This is descriptive and measures repeated
runs of one apparatus, not the variance of re-freezing a study or of another task sample.

**Pre-registration by freeze.** The plan is part of the frozen project; the project's SHA-256 is the
registration identifier the report prints. Every started attempt binds to that identity, and the report is
regenerated from the project and the journal, so a plan cannot change after collection without changing the
identifier. It is not a time-stamped entry with an independent custodian.

## 8. Freeze, provenance and verification

`freezeStudy` validates the specification, compiles every task, resolves the population, builds the schedule
and the readiness contract, and hashes the canonical JSON of the result; that hash is the project identity.
`runtimeSources` pins the 45 runtime files (`RUNTIME_FILES`) by SHA-256, and `verifyProject` re-freezes the
specification and refuses a project whose canonical bytes differ. A frozen project retains its own runtime: a
later template version never re-identifies it.

## 9. Execution and evidence

The attempt journal (`attempts.jsonl`) is the durable raw record. A `started` event is flushed before dispatch
and carries the request envelope actually sent; a `finished` event carries the verbatim response, the grade,
the phase and reason of a failure and the elapsed time; qualification, template-preparation and resource
events record pre-collection checks with their receipts. `validateJournal` binds the journal to the frozen
project. Recovery never treats a missing response as success and never redraws a retained one.

## 10. Export (the runnable engine)

`projectFiles` writes the pinned runtime, `project.json`, `specification.json`, `schedule.json`, prompts and
checklists, review records, generated artifacts (information packets, readiness, requirements, workflows,
corpus, design, resource templates, native preparation), `ATTRIBUTIONS.md` and `provenance.json`,
`CITATION.cff` and `CITATION.bib`, and `manifest.json` with the SHA-256 of every file. The ZIP is
deterministic (stored entries, sorted names, fixed timestamps). `node cli.mjs verify` refuses any changed byte
and regenerates every generated artifact, including the citation files, for comparison.

## 11. Report

`researchReportFiles` produces `report.html` and `report.md` in this order: front matter (with the template
version and runtime identity), abstract, research question and design, task construction with the complete
compiled prompt and layer map per exemplar task, conditions with the retained request envelope, protocol and
apparatus, **statistical methods** (the frozen procedure with its references, pre-registration by freeze,
dispersion, contamination and leakage controls), results tables with the disposition figure, **replicate
dispersion**, run walkthrough, per-trial evidence, integrity and reproduction, limitations and threats to
validity, the reproducibility checklist, attribution and reused code, **cite this study and its template**,
and **references**. The package is deterministic: the generation time is the last journal timestamp. Fields
the project does not carry print "Not declared". Every citation printed comes from `METHOD_REFERENCES` in
`src/benchmark/study.mjs`; an unregistered key refuses, and each entry states whether its identifier was
re-resolved online when it was recorded.

## 12. Limitations of the template

- It records declarations; it does not authenticate a provider's identity, session isolation or training data.
- It cannot detect contamination. It records what an audit needs: prompt digests, splits, withheld
  information, session-isolation declarations and the collection window.
- Intervals resample declared clusters and correct nothing about task selection; percentile intervals can
  under-cover with few clusters.
- Grades measure the declared criterion on the frozen inputs; construct validity is the investigator's claim.
- Replicates measure repeated runs of one frozen schedule, not the variance of re-freezing a study.
- A review record identifies what a person acknowledged, not who they are.

## 13. Conformance tests

`tools/test/research-benchmark-template-citation.test.mjs` (citation files, runtime identity, statistical
methods section, dispersion, contamination paragraph, checklist rows, CLI verification of the citation files),
`tools/test/research-benchmark-report-paper.test.mjs` (report items 1–13),
`tools/test/research-benchmark-report-table-notes.test.mjs`, `tools/test/research-benchmark-analysis.test.mjs`,
`tools/test/research-benchmark-endpoints.test.mjs` (page/CLI byte parity), `tools/test/research-benchmark-provenance.test.mjs`.

## 14. References of the template's methods

Efron, B. (1979). Bootstrap methods: another look at the jackknife. The Annals of Statistics, 7(1), 1–26.
doi:10.1214/aos/1176344552 · Efron, B., & Tibshirani, R. J. (1993). An Introduction to the Bootstrap. Chapman
and Hall, ISBN 0412042312 (the only DOI on record, 10.1201/9780429246593, is the 1994 reissue and is not used) · DiCiccio, T. J., & Efron, B. (1996). Bootstrap confidence intervals. Statistical Science, 11(3),
189–228. doi:10.1214/ss/1032280214 · Field, C. A., & Welsh, A. H. (2007). Bootstrapping clustered data. Journal
of the Royal Statistical Society: Series B, 69(3), 369–390. doi:10.1111/j.1467-9868.2007.00593.x · Davison, A.
C., & Hinkley, D. V. (1997). Bootstrap Methods and their Application. Cambridge University Press.
doi:10.1017/CBO9780511802843 · Dunn, O. J.
(1961). Multiple comparisons among means. Journal of the American Statistical Association, 56(293), 52–64.
doi:10.1080/01621459.1961.10482090 (Bonferroni 1936 itself could not be verified on a primary or library
record and is not cited) · Cameron, A. C., Gelbach, J. B., & Miller, D. L. (2008). Bootstrap-based improvements
for inference with clustered errors. The Review of Economics and Statistics, 90(3), 414–427.
doi:10.1162/rest.90.3.414 · Hyndman, R. J., & Fan, Y. (1996). Sample quantiles in statistical packages. The American Statistician, 50(4),
361–365. doi:10.1080/00031305.1996.10473566 · Durstenfeld, R. (1964). Algorithm 235: Random permutation.
Communications of the ACM, 7(7), 420. doi:10.1145/364520.364540 · Ettinger, T. (2017). mulberry32 (mulberry32.c), GitHub
Gist, CC0 1.0, https://gist.github.com/tommyettinger/46a874533244883189143505d203312c (not peer reviewed) · Nosek, B. A., Ebersole, C. R., DeHaven, A. C., & Mellor, D. T.
(2018). The preregistration revolution. PNAS, 115(11), 2600–2606. doi:10.1073/pnas.1708274114 · Dodge, J.,
Gururangan, S., Card, D., Schwartz, R., & Smith, N. A. (2019). Show your work: Improved reporting of experimental
results. EMNLP-IJCNLP 2019. doi:10.18653/v1/D19-1224 · Reimers, N., & Gurevych, I. (2017). Reporting score
distributions makes a difference. EMNLP 2017. doi:10.18653/v1/D17-1035 · Bouthillier, X., et al. (2021).
Accounting for variance in machine learning benchmarks. MLSys 2021. arXiv:2103.03098 · Miller, E. (2024). Adding
error bars to evals: A statistical approach to language model evaluations. arXiv:2411.00640 · Sainz, O., et al.
(2023). NLP evaluation in trouble: On the need to measure LLM data contamination for each benchmark. Findings
of EMNLP 2023. doi:10.18653/v1/2023.findings-emnlp.722 · Jacovi, A., Caciularu, A., Goldman, O., & Goldberg,
Y. (2023). Stop uploading test data in plain text. EMNLP 2023. doi:10.18653/v1/2023.emnlp-main.308 · Pineau,
J., et al. (2021). Improving reproducibility in machine learning research. JMLR, 22(164), 1–20 · Dehghani, M.,
et al. (2021). The benchmark lottery. arXiv:2107.07002 · Smith, A. M., Katz, D. S., & Niemeyer, K. E. (2016).
Software citation principles. PeerJ Computer Science, 2, e86. doi:10.7717/peerj-cs.86 · Druskat, S., et al.
(2021). Citation File Format (version 1.2.0). Zenodo. doi:10.5281/zenodo.5171937.

The machine-readable form of every entry, with its verification status, is `METHOD_REFERENCES` in
`src/benchmark/study.mjs`; the report's References section and both citation files are generated from it.

## 15. Change log

- **2.0.0 (2026-09-11).** First published version. Pinned runtime files changed: analysis.mjs, cli.mjs,
  lean-codegen.mjs, report.mjs, study.mjs, templates.mjs (`TEMPLATE.changes`). Added: template constants, runtime
  identity and generator release; the optional `citation` field; `CITATION.cff` and `CITATION.bib` in exports and
  report packages; the statistical methods, replicate dispersion, interval notes, citation, change record and
  references sections of the report; pre-registration and contamination statements; extended limitations and
  checklist; provenance registry entries for the seeded generator, the shuffle, Bonferroni intervals and the
  sample quantile, with the PKWARE, W3C and CRC-32 references corrected to dated, resolvable sources. Fixed: the
  Bonferroni family for design-arm contrasts (was the condition-contrast count); the abstract headline (was
  all-row rates while naming the primary population); abstract rounding.
