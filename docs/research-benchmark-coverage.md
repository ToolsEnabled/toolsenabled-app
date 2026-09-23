# Frozen joint corpus coverage

The Research corpus recipe, standalone compiler, verifier and report use the same deterministic sampler. A marginal quota can cover every individual factor level while omitting combinations. A rule with `dimensions` covers the Cartesian product of 2–4 dimensions. It can be combined with the existing one-dimensional rules:

```json
{
  "coverage": [
    {"dimensions": ["axis:entry", "axis:exit"], "minimum": 1},
    {"dimensions": ["axis:operator", "composition-depth"],
     "levels": {"composition-depth": ["2", "4", "6"]}, "minimum": 2},
    {"dimension": "feature:stateful-entry",
     "levels": {"feature:stateful-entry": ["present"]}, "minimum": 3}
  ],
  "features": [
    {"id": "stateful-entry", "bundles": ["my-cross-entry", "my-streak-entry"],
     "rationale": "These personally reviewed atoms depend on prior observations."}
  ]
}
```

This is an excerpt, not an executable study. The named axes, choices and bundles must exist in the full recipe/catalog. Its rationale is an investigator declaration, not a supplied approval. No actual study atom or RACE policy is selected by this module.

`family` and `axis:<id>` use the declared family and choice identifiers. `composition-depth` is the maximum number of slot edges from the root in the canonical baseline composition; `composition-nodes` counts its nodes. These can differ from recipe labels such as `axis:depth`. `feature:<id>` is `present` when at least one bundle in that declared group occurs as a composition node, and `absent` otherwise. Dependencies alone do not count. Repeated instances count once per candidate for coverage. A group can describe an atom, operator, or investigator-defined statefulness class. The catalog hash binds bundle content; each candidate records actual depth, node count, node bundle identities and feature membership. The full compiled composition remains in the exported task artifacts.

By default, family/axis domains contain every declared level, feature domains contain both `absent` and `present`, and numeric composition domains contain all successfully compiled baseline levels. Optional `levels` narrows or explicitly declares the requested domain for each dimension. Numeric levels are canonical integer strings. Explicit numeric levels are necessary to request a depth or size never produced by construction. If no candidate compiles and no numeric levels are supplied, generation refuses to infer a domain. Requested levels do not exclude tasks from the eligible population; use compatibility constraints for exclusions.

Every requested Cartesian cell remains in the ledger, including cells made impossible by compatibility constraints, missing dimensions across heterogeneous families, canonical deduplication or structural coupling. Such cells have zero availability and prevent a ready freeze. Rules also report candidates that cannot be classified and candidates outside requested levels. Structural construction failures are unclassified because no canonical composition exists for them. To request only meaningful combinations, use justified level scopes or redesign the factors. Multiple rules may use the same dimension set with disjoint level scopes; overlapping cells are refused so quotas cannot contradict or double-count each other. For example, a wrapper that always adds two edges can use separate rules for `(depth 1, absent)` and `(depth 3, present)`. Record that coupling in the recipe rationale. Do not remove cells after observing collected outcomes.

The sampler resolves construction failures and semantic aliases before selection. Balanced selection greedily reduces outstanding cell deficits, with seeded shuffle order breaking ties. Each selected task supplies one count to each matching rule cell. The ledger records actual quotas; a missed quota is not a proof that no feasible selection exists. The sampler does not claim an optimal covering array, probability sampling, activation coverage or independent validation of its expected observations. The existing marginal-only recipe representation and sampling behavior are retained. The recipe allows at most 128 rules, 128 declared features, 16,384 cells, 4,096 candidates and 512 selected tasks. Resource checks reject excessive Cartesian products before materializing the cell list.

Use the Corpus recipe editor to author these fields. Generate to inspect the selection ledger, then freeze the exact result. The report includes requested level domains, unclassified/out-of-scope counts, feature rationales, every cell and its preselection exclusions, and compiled candidate features. The portable verifier independently regenerates `corpus/recipe.json` and `corpus/manifest.json` from the frozen project and requires their manifest membership; rehashing an altered file does not make it valid.

Structural coverage is distinct from meaningful activation on the frozen input. An atom can occur without its predicate becoming true, and an operator can occur without its distinguishing transition firing. Independent interpretation, registered activated wrong-reading controls, personal review and native qualification remain separate gates. This module neither filters on model grades nor clears those gates. Information-treatment feature checks use the private baseline composition; they do not claim coverage of every admissible reading.

`tools/test/fixtures/research-benchmark-coverage.mjs` defines an eight-candidate synthetic three-factor control. Four retained tasks cover all binary pairs; a two-task marginal control misses pairs. The tests also exercise impossible combinations, missing family axes, duplicate aliases, compiled versus labeled depth, dependency-only bundles, repeated occurrences, unavailable numeric levels, schema/resource refusals and altered portable ledgers. The actual browser journey authors the rules, observes a quota refusal, exports/runs the frozen project, imports its durable evidence, and compares all GUI/CLI report bytes.
