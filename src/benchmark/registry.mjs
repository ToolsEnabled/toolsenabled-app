// The seam that lets a benchmark be added without editing the core.
//
// The dependency arrow used to point from the core into the Lean/trading
// vertical: cli, tasks, export, audit, qualify, readiness, requirements, runner
// and study all imported Lean or trading symbols directly, so ToolsEnabled could
// not gain a second benchmark without someone editing ToolsEnabled's own
// compiler. This module reverses that. A vertical DECLARES itself here; the core
// asks the registry what a given study needs and never names a vertical.
//
// Lean Bench stays in the tree as the reference plugin and registers through
// this same door, so the door is known to work: whatever a third party must do
// to add a benchmark, Lean Bench already does, and nothing else.
import { invariant, object } from './prompts.mjs'
import { declareExtractionPolicy, validateExtractionPolicy } from './extraction.mjs'

const benchmarks = new Map()
let fallbackId = null

// The core's own extraction rule for a study that declares no benchmark: the
// whole reply is the program. It names no language and no vertical.
export const DEFAULT_EXTRACTION_POLICY = declareExtractionPolicy({
  mode: 'raw', language: 'text', label: 'program', pick: 'only', prose: 'refuse',
  note: 'Core default: the reply is the program.'
})

// The grading contracts the CORE itself implements. A benchmark adds its own
// through gradingKinds; nothing here names a vertical.
//
// label is what the Research page puts in its Scoring control, title is how a
// refusal names the contract in a sentence, and help is the note the page shows
// when this contract is available. They live beside the value so a third party's
// contract is described by whoever implemented it rather than by the page.
export const CORE_GRADING_KINDS = Object.freeze([
  Object.freeze({ value: 'exact', title: 'Exact text', label: 'Exact text' }),
  Object.freeze({ value: 'json', title: 'Exact JSON', label: 'Exact JSON' }),
  Object.freeze({ value: 'judge-audit', title: 'Judge verdict', label: 'Judge verdict against reference' }),
  Object.freeze({ value: 'module', title: 'Custom grading module', label: 'Custom grading module' }),
  Object.freeze({ value: 'resource-action-plan', title: 'Generated resource execution', label: 'Generated resource execution' }),
])

// The execution-environment keys the CORE itself understands. readiness.mjs
// carried this list literally WITH A VERTICAL'S OWN KEY INSIDE IT
// ('leanImage'), and any other key raised the scientific blocker
// `execution-environment-unsupported`, which assertCollectionAdmission turns
// into a hard refusal at run time. That is the same allowlist class as the four
// domain lists, one layer down: a third-party benchmark whose grading contract
// needs any frozen configuration of its own could freeze the study and then
// never run it. A benchmark now declares its own keys through environmentKeys.
export const CORE_ENVIRONMENT_KEYS = Object.freeze(['node', 'nodeVersion', 'python', 'dependencies', 'instructions'])

const EMPTY_PAGE = Object.freeze({ fields: Object.freeze([]) })

function validateGradingKinds(id, kinds) {
  invariant(Array.isArray(kinds), `Benchmark "${id}" must declare gradingKinds as an array.`)
  for (const kind of kinds) {
    invariant(object(kind) && typeof kind.value === 'string' && kind.value.trim(), `Benchmark "${id}" has a grading contract without a value.`)
    invariant(!CORE_GRADING_KINDS.some(core => core.value === kind.value), `Benchmark "${id}" cannot redeclare the core grading contract "${kind.value}".`)
    invariant(typeof kind.label === 'string' && kind.label.trim(), `Benchmark "${id}" grading contract "${kind.value}" needs the label a person will read.`)
    invariant(typeof kind.title === 'string' && kind.title.trim(), `Benchmark "${id}" grading contract "${kind.value}" needs the title a refusal can name it by.`)
    if (kind.help !== undefined) invariant(typeof kind.help === 'string' && kind.help.trim(), `Benchmark "${id}" grading contract "${kind.value}" must declare help as the text a person reads, or omit it.`)
    // The extra protocol.grading fields this contract may declare. study.mjs
    // carried `kind === 'lean-python' ? ['executionTimeoutMs'] : []` as a
    // literal, so a third-party contract could declare no configuration at all:
    // any field but `kind` was refused as an unsupported field.
    if (kind.fields !== undefined) invariant(Array.isArray(kind.fields) && kind.fields.every(name => typeof name === 'string' && name.trim() && name !== 'kind'),
      `Benchmark "${id}" grading contract "${kind.value}" must declare fields as an array of its own protocol.grading field names, never "kind".`)
    // Whether an information treatment may be graded by this contract. tasks.mjs
    // carried ['exact', 'json', 'lean-python'] literally, so a benchmark's own
    // contract was refused there however else the core had been opened up.
    if (kind.supportsInformation !== undefined) invariant(typeof kind.supportsInformation === 'boolean',
      `Benchmark "${id}" grading contract "${kind.value}" must declare supportsInformation as a boolean, or omit it.`)
    // assertReady is a THUNK: study.mjs calls it while validating a study, never
    // here. Its preconditions belong to whoever implemented the contract -- the
    // core used to carry Lean's Docker-digest and timeout rules itself.
    if (kind.assertReady !== undefined) invariant(typeof kind.assertReady === 'function', `Benchmark "${id}" grading contract "${kind.value}" must supply assertReady(spec) as a function, or omit it.`)
    const claimed = gradingKind(kind.value)
    invariant(!claimed, `Benchmark "${id}" claims grading contract "${kind.value}", which "${claimed?.benchmarkId}" already declared. Two benchmarks cannot own one contract.`)
  }
}

// The page surface a benchmark asks for. Before this existed, the Research page
// decided which fields and controls to show with sixteen branches on
// spec.domain === 'lean-bench', so a third party got a page shaped for Lean
// Bench: fields it does not need, and no way to declare the ones it does.
function validatePageSurface(id, page) {
  invariant(object(page), `Benchmark "${id}" must declare page as an object.`)
  if (page.fields !== undefined) invariant(Array.isArray(page.fields) && page.fields.every(name => typeof name === 'string' && name.trim()),
    `Benchmark "${id}" must declare page.fields as an array of the page field names it reveals.`)
  // taskTrace is a THUNK. It is called when a task is previewed, never at
  // registration: it reaches this benchmark's interpreter, and study.mjs imports
  // plugins.mjs, so calling one here closes a module-init cycle.
  if (page.taskTrace !== undefined) invariant(typeof page.taskTrace === 'function',
    `Benchmark "${id}" must supply page.taskTrace(spec, task, compiled) as a function; it is called when a task is previewed, not at registration.`)
  if (page.derivesExpected !== undefined) invariant(typeof page.derivesExpected === 'boolean',
    `Benchmark "${id}" must declare page.derivesExpected as a boolean.`)
}

export function registerBenchmark(descriptor) {
  invariant(object(descriptor), 'A benchmark registration must be an object.')
  const { id, matches, extraction, fallback = false } = descriptor
  invariant(typeof id === 'string' && id.trim(), 'A benchmark registration must carry a stable id.')
  invariant(typeof matches === 'function', `Benchmark "${id}" must supply matches(spec) so the core can tell whose study this is.`)
  if (extraction !== undefined) validateExtractionPolicy(extraction)
  if (descriptor.gradingKinds !== undefined) validateGradingKinds(id, descriptor.gradingKinds)
  if (descriptor.page !== undefined) validatePageSurface(id, descriptor.page)
  if (descriptor.domains !== undefined) invariant(Array.isArray(descriptor.domains) && descriptor.domains.every(name => typeof name === 'string' && name.trim()),
    `Benchmark "${id}" must declare domains as an array of study-domain names.`)
  if (descriptor.environmentKeys !== undefined) invariant(Array.isArray(descriptor.environmentKeys)
    && descriptor.environmentKeys.every(name => typeof name === 'string' && name.trim() && !CORE_ENVIRONMENT_KEYS.includes(name)),
    `Benchmark "${id}" must declare environmentKeys as an array of its own spec.environment key names, none of which may be a core key (${CORE_ENVIRONMENT_KEYS.join(', ')}).`)
  // Starters are what the Research page offers in its Starter list. `create` is a
  // THUNK and is never called here: see registeredStarters.
  if (descriptor.starters !== undefined) {
    invariant(Array.isArray(descriptor.starters), `Benchmark "${id}" must declare starters as an array.`)
    for (const starter of descriptor.starters) {
      invariant(object(starter) && typeof starter.id === 'string' && starter.id.trim(), `Benchmark "${id}" has a starter without an id.`)
      invariant(typeof starter.label === 'string' && starter.label.trim(), `Benchmark "${id}" starter "${starter.id}" needs the label a person will read.`)
      invariant(typeof starter.create === 'function', `Benchmark "${id}" starter "${starter.id}" must supply create() so the draft is built when chosen, not at registration.`)
    }
  }
  invariant(!benchmarks.has(id), `Benchmark "${id}" is already registered. Registering twice hides which one a study ran under.`)
  if (fallback) {
    invariant(fallbackId === null, `Benchmark "${id}" claims the fallback, but "${fallbackId}" already holds it. Only one benchmark can answer for studies that declare none.`)
    fallbackId = id
  }
  benchmarks.set(id, Object.freeze({ ...descriptor }))
  return benchmarks.get(id)
}

export function registeredBenchmarks() {
  return [...benchmarks.values()]
}

// The domains a registered benchmark answers for. study.mjs used to carry a
// literal ['generic', 'lean-bench'] allowlist, which refused a third party's
// study before any of its own code ran -- a block no import inventory could see,
// because it is data, not an import. The allowlist is now whatever is
// registered, so a benchmark admits its own domain by declaring it.
export function registeredDomains() {
  return [...new Set([...benchmarks.values()].flatMap(entry => entry.domains || []))]
}

export function isRegisteredDomain(domain) {
  return registeredDomains().includes(domain)
}

// One registered benchmark by id, or null.
export function benchmarkById(id) {
  return benchmarks.get(id) || null
}

// The benchmark that OWNS a domain, ignoring the fallback. Use this where the
// core previously wrote `spec.domain === 'lean-bench' && ...`: a generic study
// owns no benchmark and must not inherit a vertical's rules.
export function benchmarkForDomain(domain) {
  return [...benchmarks.values()].find(entry => (entry.domains || []).includes(domain)) || null
}

// Which registered benchmark owns this study. A study that matches none falls to
// the registered fallback, and to nothing at all if no vertical is loaded, so a
// caller can tell "no benchmark" apart from "the wrong benchmark".
export function benchmarkFor(spec) {
  for (const entry of benchmarks.values()) if (entry.id !== fallbackId && entry.matches(spec)) return entry
  const fallbackEntry = fallbackId ? benchmarks.get(fallbackId) : null
  if (fallbackEntry && fallbackEntry.matches(spec)) return fallbackEntry
  return fallbackEntry || null
}

export function requireBenchmarkFor(spec, capability) {
  const entry = benchmarkFor(spec)
  invariant(entry, `No benchmark is registered to ${capability} for this study. Load the benchmark that froze it before reading it.`)
  invariant(typeof entry[capability] === 'function', `Benchmark "${entry.id}" does not implement ${capability}.`)
  return entry
}

// The declared extraction policy for a study. This is the call that replaced
// audit.mjs and readiness.mjs importing pythonSource() out of the Lean vertical.
export function extractionPolicyFor(spec) {
  return benchmarkFor(spec)?.extraction || DEFAULT_EXTRACTION_POLICY
}

// Every starter the shipped benchmarks offer, in registration order, each
// tagged with the benchmark it came from so the page can say whose it is.
//
// `create` IS NOT CALLED HERE. It is a thunk on purpose: building a Lean starter
// reaches lean.mjs and trading-catalog.mjs, and study.mjs already imports
// plugins.mjs, so invoking one during registration closes a module-init cycle.
// Listing starters must stay free of any work.
export function registeredStarters() {
  return [...benchmarks.values()].flatMap(entry => (entry.starters || []).map(starter => ({
    id: starter.id,
    label: starter.label,
    benchmarkId: entry.id,
    benchmarkLabel: entry.label || entry.id,
    create: starter.create,
  })))
}

// The starter with this id, or null. The page uses this instead of a literal
// ternary over known starter names.
export function starterById(id) {
  return registeredStarters().find(starter => starter.id === id) || null
}

// Every grading contract on offer: the core's own, then each benchmark's, in
// registration order. The Research page builds its Scoring control from this
// instead of carrying one vertical's contract as a hardcoded <option>.
export function offeredGradingKinds() {
  return [...CORE_GRADING_KINDS.map(kind => ({ ...kind, benchmarkId: null })),
    ...[...benchmarks.values()].flatMap(entry => (entry.gradingKinds || []).map(kind => ({ ...kind, benchmarkId: entry.id })))]
}

// One grading contract by value, with the benchmark that owns it, or null.
export function gradingKind(value) {
  return offeredGradingKinds().find(kind => kind.value === value) || null
}

// The contracts a study in this domain may actually choose: the core's, plus
// those of the benchmark that owns the domain. study.mjs used to hold the whole
// list literally, with a vertical's contract inside it.
export function gradingKindsForDomain(domain) {
  const owner = benchmarkForDomain(domain)
  return offeredGradingKinds().filter(kind => kind.benchmarkId === null || kind.benchmarkId === owner?.id)
}

// The page surface declared by the benchmark that owns this domain. A generic
// study owns no benchmark and gets the empty surface, which is what makes the
// page generic by default rather than Lean-shaped by default.
export function pageSurfaceForDomain(domain) {
  return benchmarkForDomain(domain)?.page || EMPTY_PAGE
}

// The spec.environment keys this study may declare: the core's own, plus those
// of whichever benchmark answers for the study. Resolved through benchmarkFor
// rather than benchmarkForDomain so a study that declares no benchmark keeps
// the fallback's keys, which is exactly what the literal list in readiness.mjs
// gave every study before this existed.
export function environmentKeysFor(spec) {
  return [...CORE_ENVIRONMENT_KEYS, ...(benchmarkFor(spec)?.environmentKeys || [])]
}

// Does a registered benchmark supply this domain's own task semantics?
//
// The core used to write `spec.domain === 'generic'` where it meant "this study
// has no benchmark-supplied semantics to collide with". That spelling refused
// every third-party domain as a side effect of excluding one vertical. A
// benchmark that names its own oracle or derives its own expected answers is
// what the rule is actually about; a benchmark that does neither is not.
export function benchmarkSuppliesSemantics(domain) {
  const owner = benchmarkForDomain(domain)
  return Boolean(owner && (typeof owner.oracle === 'function' || owner.page?.derivesExpected === true))
}

export function declaresPageField(domain, name) {
  return (pageSurfaceForDomain(domain).fields || []).includes(name)
}

// Test apparatus. A suite that registers a throwaway benchmark must be able to
// put the registry back, or the next suite inherits it.
export function resetRegistry() {
  benchmarks.clear()
  fallbackId = null
}
