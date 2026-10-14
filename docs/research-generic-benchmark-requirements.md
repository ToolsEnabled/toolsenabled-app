# Generic benchmark requirements ledger (G9)

This is the in-repo G9 ledger: which parts of the generic Research/Benchmark
templates satisfy the owner's cross-study requirements, which gaps remain, and
what proves each "works" row. It supersedes nothing in the lane's own reports;
it is the durable in-repo copy the lane's reports/003-REQUIREMENTS-LEDGER.md (a lane document, outside this repository)
and 003-REQUIREMENTS-LEDGER-DISPOSITION.md (same lane, outside this repository) called for.

Study names are the generic placeholders the source ledger used and stay
generic here: **Study A** names a compositional, program-checked benchmark
shape; **Study B** names a multi-agent, policy-compared design shape. No
concrete study domain, dataset, product or institution is named anywhere in
this file.

Legend — **Done**: exists generically today, proven by a retained test.
**Partial**: exists but is incomplete or still domain-specific for part of the
requirement. **Missing**: no generic mechanism yet. **Delivered (G#)**: the
registered gap below was closed by the named commit(s) on this branch.

## 1. Cross-cutting apparatus requirements (both studies)

| # | Requirement | Status | Proof |
| --- | --- | --- | --- |
| C1 | Reusable prompt atoms/templates, typed slots, parameters, arbitrary-depth recursion | Done | `tools/test/research-benchmark-composition.test.mjs` |
| C2 | One canonical composition drives prompt, checklist and source maps | Done | `tools/test/research-benchmark-composition-fields.test.mjs` |
| C3 | Approval ledger: wording/semantics/hooks/tests/hash per bundle; dependency-root reviews | Done | `tools/test/research-benchmark.test.mjs` |
| C4 | Mechanical corpus generation: axes, wrappers, constraints, seeds, canonical dedup, coverage | Done | `tools/test/research-benchmark-corpus.test.mjs` |
| C5 | Withheld information, admissible readings, conventions | Done | `tools/test/research-benchmark-information.test.mjs` |
| C6 | Export is self-contained and pinned; tampering refused | Done | `tools/test/research-benchmark-dispatch.test.mjs` |
| C7 | GUI and CLI invoke the same runner; page/CLI output byte-identical | Done | `tools/test/research-benchmark-endpoints.test.mjs` |
| C8 | Trial vs attempt; exactly-once counted trials; interruption/late/duplicate/recovery | Done (single-host) | `tools/test/research-benchmark-concurrency.test.mjs` |
| C9 | Failure taxonomy stays distinguishable (transport, incomplete, clarification, refusal, malformed…) | Done | `tools/test/research-benchmark-information.test.mjs` |
| C10 | Primary endpoint and denominator fixed before collection | Done | `tools/test/research-benchmark-primary-population.test.mjs` |
| C11 | Analysis: clusters, multiplicity, contrasts, uncertainty; tables regenerated | Done for the binary pass and for typed endpoints | `tools/test/research-benchmark-analysis.test.mjs`, `tools/test/research-benchmark-endpoints.test.mjs` |
| C12 | Model identity, session isolation, collection dates recorded; identity checked | Done | `tools/test/research-benchmark-observations.test.mjs` |
| C13 | Cost/time/tokens distinct; unavailable is not zero | Done | `tools/test/research-benchmark-observations.test.mjs` |
| C14 | Explicit workflow graph: stages, branching, tools, termination, budgets, treatment/orchestration | Done for prompt-only workflows; tools unsupported | `tools/test/research-benchmark-workflow.test.mjs` |
| C15 | Sandboxed execution of generated programs, declared resource/timeout policy | Missing | Gap G2 |
| C16 | Pinning survives platform updates; a running/resumed project retains its release | Done | `tools/test/research-benchmark-dispatch.test.mjs` |
| C17 | Qualification before counted work: correct/wrong/malformed/refusal/timeout controls, Gates A–E | Partial (generic executable controls not yet mechanized) | `tools/test/research-benchmark-activation.test.mjs`; Gap G2/G7 for executable controls |
| C18 | Judge audit of an external benchmark with declared criterion scopes | Done | `tools/test/research-benchmark-audit.test.mjs` |
| C19 | Research page modules beyond the builder (grid, run board, results, queue, library, sessions) | Done (page); engine backend not exercised by this stage | `tools/test/research-view.test.mjs` |

## 2. Study A — compositional, program-checked shape

| # | Protocol element | Status | Proof / gap |
| --- | --- | --- | --- |
| A1 | Reusable roles mixed into strategies, strategies in template slots, recursive nesting | Done | `tools/test/research-benchmark-composition-fields.test.mjs` |
| A2 | Canonical semantics per bundle drive prompt/checklist/reference/expected-trace | Partial | Literal declared `expected` works (`tools/test/research-benchmark-activation.test.mjs`); derived expectations for domain variants need Gap G1 |
| A3 | Semantic constitution: chronology, fills, readiness, missing data, rounding, ownership, resets, termination | Partial | Domain-specific today; Gap G1 makes the constitution an ordinary reviewed bundle |
| A4 | Candidate program executed in a pinned environment, trace normalized and compared | Partial | Gap G2 (generic execution contract) |
| A5 | Meaningful activation, negative/mutation controls, independent interpreter agreement | Done for interpreted answers; Partial for executed programs | `tools/test/research-benchmark-activation.test.mjs`; executed-program controls need Gap G2 |
| A6 | Data provenance, environment digests pinned, defaults never silent | Partial | Gap G2 |
| A7 | Task selection: seeds, distributions, constraints, duplicate checks, frozen manifest, dev/held-out split | Done | `tools/test/research-benchmark-corpus.test.mjs` |
| A8 | Trial/attempt records with provider ids, timestamps, transport/completion status, grade | Done for interpreted answers; executed-source hash not retained | `tools/test/research-benchmark-observations.test.mjs`; Gap G2 for executed-source retention |
| A9 | Underspecified tasks: admissible completions, clarification/refusal reported separately | Done | `tools/test/research-benchmark-information.test.mjs` |
| A10 | Judge audit of a published external benchmark | Done | `tools/test/research-benchmark-audit.test.mjs` |
| A11 | Development vs held-out; pilot outputs separated unless prospectively specified | Done | `tools/test/research-benchmark-primary-population.test.mjs` |
| A12 | Independent reconstruction of a pilot from raw retained artifacts | Done for semantic and domain-native evidence | `tools/test/research-native-evidence-verification.test.mjs` |

## 3. Study B — multi-agent, policy-compared shape

| # | Protocol element | Status | Proof / gap |
| --- | --- | --- | --- |
| B1 | Arms = coordination policies over a shared or isolated workspace | Missing | Gap G3 |
| B2 | Concurrent agents per draw, mediated tool surface, retained event log | Missing | Gap G4 |
| B3 | Assignment unit = draw (site × arm × replicate) with fixed cell sizes | **Delivered (G5)** | `tools/test/research-benchmark-design.test.mjs`, `docs/research-benchmark-design.md` |
| B4 | Typed endpoints: rate, counts, durations, event-time with cap, proportion | **Delivered (G6)** | `tools/test/research-benchmark-endpoints.test.mjs`, `tools/test/research-benchmark-endpoint-fields.test.mjs`, `docs/research-benchmark-endpoints.md` |
| B5 | Test-gate oracle: focal tests, five-run determinism gate, rejections recorded | Missing | Gap G7 |
| B6 | Stop rule for the pilot, escalation budget, wall-clock cap, contradictory-contract handling | Partial (prose-only `stopping`, `maxDurationMs`; no machine-checked rule) | Gap G8, ordinary half **DEFERRED to 1.0.45** |
| B7 | Attribution of contested writes from the event log alone | Partial (endpoint/proportion machinery exists; the event log itself is Gap G4) | `tools/test/research-benchmark-endpoints.test.mjs`; Gap G4 |
| B8 | Exchangeability check across draw/replicate index | **Delivered (G6)** | `tools/test/research-benchmark-endpoints.test.mjs` (exchangeability diagnostic) |
| B9 | Historical mining, semantic replay, perturbation probes, hazard model | Out of the runner's scope by design | — |
| B10 | One runner per language as a gated instrument | Partial | Gap G2/G3/G7 |

## 4. Gap register disposition (this stage)

| Gap | State as of this stage | Evidence |
| --- | --- | --- |
| G1 Derive-module expectations | Proposal reviewed-pending; nothing implemented | lane proposal, outside this repository |
| G2 Generic execution contract | Data-contract proposal only | lane proposal, outside this repository |
| G3 Environment fixtures | Data-contract proposal only | lane proposal, outside this repository |
| G4 Agent adapter | Blocked on the owner's event-log answer | lane proposal, outside this repository |
| G5 Grouped assignment design | **Delivered**, commits `192008c2`, `532ba042`, `8ce36862`, `20bbbcd9` | `docs/research-benchmark-design.md`, `tools/test/research-benchmark-design.test.mjs` |
| G6 Typed endpoints | **Delivered**, commits `192008c2`, `532ba042`, `8ce36862`, `20bbbcd9` | `docs/research-benchmark-endpoints.md`, `tools/test/research-benchmark-endpoint-fields.test.mjs`, `tools/test/research-benchmark-endpoints.test.mjs` |
| G7 Environment qualification gates | Data-contract proposal only | lane proposal, outside this repository |
| G8 Stop rules and phases | Proposal written; ordinary half **DEFERRED to 1.0.45** (proposal `G8-stop-rules-phases-v2` is a lane document, not in this repository) | — |
| G9 Ledger and guide | **Delivered by this stage** | this file and `docs/research-generic-templates-guide.md`, checked by `tools/test/research-generic-docs-links.test.mjs` |

## 5. Owner standard

The owner's standard — both study designs completable end to end with only the
generic templates, minus engine/container setup — is **not met** as of this
stage: Study B's design and analysis are now expressible generically (G5, G6),
but collection for both studies still stops at G1/G2/G3/G4/G7, and G8's
runner half remains outstanding.
