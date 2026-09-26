// Deterministic development fixture for the typed-endpoint contract and its
// byte-identity control. Runtime pins are supplied by the caller: the control
// uses digests recorded at the base commit so the frozen project hash does not
// follow later edits to the runtime files it compares against.
import { genericStarter } from '../../../src/benchmark/starters.mjs'
import { developmentDraft } from './research-benchmark-development.mjs'

export const FIXED_NOW = 1700000000000
// The release that recorded this fixture's byte-identity control, declared here for the
// same reason the runtime digests above are supplied by the caller rather than read live.
// compileStudy stamps spec.generator with the RUNNING release only when the spec declares
// none (study.mjs:667), and that stamp is inside the frozen project digest. An unpinned
// fixture therefore re-froze under a different identity at every application bump: moving
// to 1.0.45 moved projectSha256, and with it the journal (which carries projectSha256 and
// readinessSha256 in all 32 events), the summary and 23 report files - a red at every
// release that says nothing about the frozen study this control exists to protect.
// Declaring the pin is what a real frozen study does, so the control now behaves like one:
// it still catches any compiler, analysis or report change, and it additionally catches a
// regression in the preservation rule itself, because a freeze that overwrote this declared
// value would move projectSha256 too. That the pin reproduces digests recorded by the .44
// app is the evidence it is the right value. The stamp's own correctness is asserted where
// it belongs, against package.json, by research-benchmark-generator-identity.test.mjs.
export const RECORDED_GENERATOR = Object.freeze({ name: 'ToolsEnabled', version: '1.0.44' })

// The schema this control was recorded under, pinned for exactly the reason the
// generator and the runtime digests above are pinned: so the frozen project hash
// does not follow a later schema. Schema 3 added four modules to the exported
// runtime, and a study runs against the inventory it was frozen with, so this
// fixture stays a schema-2 project and keeps its schema-2 identity and journal.
// It is therefore also the standing proof that a project frozen before that
// change still runs -- see the test named for it in the suite.
export const RECORDED_SCHEMA_VERSION = 2

export function endpointStudy(runtimeSources, { replicates = 2, endpoints = null } = {}) {
  const spec = developmentDraft(genericStarter()), template = spec.tasks[0]
  spec.name = 'Typed endpoint fixture'
  spec.tasks = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(template), id: `task-${i + 1}`, familyId: i < 2 ? 'family-a' : 'family-b',
    split: i < 2 ? 'development' : 'held-out', variables: { a: i + 1, b: 10 }, expected: String(i + 11), factors: { depth: i % 2 + 1 } }))
  const first = Object.fromEntries(spec.tasks.map((task, i) => [task.id, i < 3 ? task.expected : 'wrong']))
  const second = Object.fromEntries(spec.tasks.map((task, i) => [task.id, i < 1 ? task.expected : 'wrong']))
  spec.conditions = [{ ...spec.conditions[0], id: 'first', adapter: { kind: 'replay', responses: first } }, { ...spec.conditions[0], id: 'second', adapter: { kind: 'replay', responses: second } }]
  spec.protocol.replicates = replicates; spec.protocol.maxTotalAttempts = 1000
  spec.analysisPlan.primaryPopulation = 'all'
  spec.analysisPlan.contrasts = [{ id: 'first-second', first: 'first', second: 'second' }]
  spec.analysisPlan.uncertainty = { kind: 'family-bootstrap', seed: 872, iterations: 300, confidence: 0.95 }
  spec.generator = { ...RECORDED_GENERATOR }
  // Supplying runtime digests is what makes this the historical byte-identity
  // control rather than a live fixture, so the recorded schema is pinned on the
  // same condition: the control stays a schema-2 project and keeps its schema-2
  // identity, journal and runtime inventory. Callers that pass no digests get a
  // current-schema study compiled against this build.
  if (runtimeSources) { spec.schemaVersion = RECORDED_SCHEMA_VERSION; spec.runtimeSources = structuredClone(runtimeSources) }
  if (endpoints) spec.analysisPlan.endpoints = structuredClone(endpoints)
  return spec
}
