// Experiments: the research workbench's dispatcher and its results.
//
// ONE EXPERIMENT MODEL (v2). An experiment is a grid — axes × values ×
// runsPerCell — with a runner and result columns as data. Where it RUNS is a
// decision, not a second system: an agent-runner experiment of at most eight
// cells runs LOCALLY as fleet-tree nodes on the computers page (the owner's
// amendment, unchanged: same store, same start contract, same streaming
// chips, same interrupt); anything larger, and every process or http
// experiment, goes to the durable run queue through the research service.
//
// The account row upgrades v1 on read: tiers become the reserved 'tier' axis,
// runsPerTier becomes runsPerCell, and every cell's {tier, run} becomes
// params — in the same array order, because the module-level tracked map
// indexes into it. The row rewrites itself as v2 on the next persist.
//
// RESULTS ARE THIS MODULE'S OWN RECORD for local cells. The tree keeps a
// node's latest reply only while the computers view is mounted to file it;
// experiments need their outcomes durable regardless of which page is open.
// So a module-level listener — it outlives every view — files each tracked
// session's outcome into ONE bounded account row (research_experiments), and
// touches the TREE only when no view holds a live store instance
// (markTreeStoreLive in src/fleet-trees.js). Queued cells resolve on the
// service run board instead; their local status stays 'queued'.
//
// The dataset path in a spec is TEXT the owner supplies. It is substituted
// into the worker's brief; the worker reads it under its own confinement.
// This module never opens it, and the R198 fence never comes near this file.

import {
  EXPERIMENT_TREE_KIND,
  createFleetTreeStore,
  isTreeStoreLive,
  markTreeStoreLive,
  safeTreeStorage,
} from './fleet-trees.js'
import { sessionEventText, sessionTurnStatus, sessionTurnSucceeded } from './agent-session-events.js'
import { DEFAULT_RESULT_SCHEMA, cellBrief, cellLabel, gridCells, parseAxes, parseResultSchema, parseRunner } from './research-grid.js'
import { runTaskDisplayStatus, runTaskIsStalled, submitRun } from './research-runs.js'
import { parseResearchAgentSetup, researchSetupForRunner } from './research-agent-setup.js'
export { parseResearchAgentSetup, researchSetupForRunner } from './research-agent-setup.js'

export const RESEARCH_EXPERIMENTS_ROW_KEY = 'research_experiments'
export const RESEARCH_EXPERIMENTS_EVENT = 'mc:research-experiments-changed'

/* The free cut runs one machine; the fleet face names it this-computer, and
   the tree store key carries the same id (verified on the installed build). */
export const EXPERIMENT_COMPUTER_ID = 'this-computer'

const MAX_EXPERIMENTS = 12
/* The tree bound: one experiment tree is the root and up to seven siblings.
   No longer a build refusal — a bigger grid goes to the run queue instead.
   The tree is created `kind: 'experiment'` (see dispatchExperiment), so the
   agent-tree width of four does not apply to it; its children are bounded by
   EXPERIMENT_TREE_MAX_CHILDREN in src/fleet-trees.js, the engine's eight. */
export const MAX_LOCAL_CELLS = 8
const MAX_QUEUE_CELLS = 512
const MAX_RUNS_PER_CELL = 5
const EXCERPT_CHARS = 400
const MAX_SERIALIZED = 60_000
const CAPS = Object.freeze({ name: 120, briefTemplate: 2000, datasetPath: 400 })

function cleanText(value, cap) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > cap) return null
  return trimmed
}

/* ---------- the row ---------- */

function freshCell(params) {
  return { params, status: 'designed', sessionId: null, nodeId: null, runId: null, startedAtMs: null, endedAtMs: null, replyExcerpt: '' }
}

/* v1 → v2, order-preserving: the tracked map holds cell INDEXES, so a cell may
   change shape here but never position. */
function upgradeV1Experiment(experiment) {
  const tiers = []
  let maxRun = 1
  for (const cell of experiment.cells) {
    if (typeof cell?.tier === 'string' && !tiers.includes(cell.tier)) tiers.push(cell.tier)
    if (Number.isInteger(cell?.run) && cell.run > maxRun) maxRun = cell.run
  }
  return {
    id: experiment.id,
    name: experiment.name,
    axes: [{ id: 'tier', values: tiers.length ? tiers : ['unspecified'] }],
    runner: { kind: 'agent', briefTemplate: experiment.promptTemplate },
    resultSchema: DEFAULT_RESULT_SCHEMA,
    runsPerCell: maxRun,
    datasetPath: experiment.datasetPath ?? null,
    projectId: null,
    serviceExperimentId: null,
    createdAtMs: experiment.createdAtMs,
    treeId: experiment.treeId ?? null,
    cells: experiment.cells.map(cell => ({
      params: { tier: cell.tier, ...(maxRun > 1 ? { replicate: cell.run } : {}) },
      status: cell.status, sessionId: cell.sessionId ?? null, nodeId: cell.nodeId ?? null,
      runId: null, startedAtMs: cell.startedAtMs ?? null, endedAtMs: cell.endedAtMs ?? null,
      replyExcerpt: cell.replyExcerpt ?? '',
    })),
  }
}

function validV1(experiment) {
  return experiment
    && typeof experiment === 'object'
    && typeof experiment.id === 'string'
    && cleanText(experiment.name, CAPS.name)
    && cleanText(experiment.promptTemplate, CAPS.briefTemplate)
    && Array.isArray(experiment.cells)
}

/* The parse gate enforces exactly what the renderers dereference: a stored
   row is a trust boundary (partial write, older build, another device), and
   one malformed experiment must drop HERE — not survive to blank the whole
   bench with a render throw. */
function validV2(experiment) {
  const setup = experiment && Object.hasOwn(experiment, 'agentSetup')
    ? parseResearchAgentSetup(experiment.agentSetup) : { ok: true, agentSetup: null }
  return experiment
    && typeof experiment === 'object'
    && typeof experiment.id === 'string'
    && cleanText(experiment.name, CAPS.name)
    && experiment.runner && typeof experiment.runner === 'object'
    && typeof experiment.runner.kind === 'string'
    && setup.ok
    && (experiment.runner.kind !== 'agent' || cleanText(experiment.runner.briefTemplate, CAPS.briefTemplate))
    && Array.isArray(experiment.axes)
    && experiment.axes.every(axis => axis && typeof axis === 'object'
      && typeof axis.id === 'string' && Array.isArray(axis.values) && axis.values.length > 0)
    && Array.isArray(experiment.cells)
    && experiment.cells.every(cell => cell && typeof cell === 'object'
      && cell.params && typeof cell.params === 'object' && typeof cell.status === 'string')
}

export function parseExperimentsRow(raw) {
  const empty = { experiments: [], damaged: false }
  if (raw === null || raw === undefined || raw === '') return empty
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { ...empty, damaged: true } }
  if (parsed && parsed.v === 2 && Array.isArray(parsed.experiments)) {
    return { experiments: parsed.experiments.filter(validV2), damaged: false }
  }
  if (parsed && parsed.v === 1 && Array.isArray(parsed.experiments)) {
    return { experiments: parsed.experiments.filter(validV1).map(upgradeV1Experiment), damaged: false }
  }
  return { ...empty, damaged: true }
}

export function serializeExperimentsRow({ experiments }) {
  if (experiments.length === 0) return null
  return JSON.stringify({ v: 2, experiments })
}

const IMPORT_FORMAT = 'toolsenabled-research-experiment'
const IMPORT_VERSION = 1
const IMPORT_KEYS = ['name', 'axes', 'runner', 'resultSchema', 'runsPerCell', 'datasetPath', 'agentSetup']

function importSpecShape(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, sentence: 'The experiment import spec is not an object.' }
  const keys = Reflect.ownKeys(spec)
  if (keys.some(key => !IMPORT_KEYS.includes(key)) || !keys.includes('name') || !keys.includes('axes')
      || !keys.includes('runner') || !keys.includes('resultSchema') || !keys.includes('runsPerCell')
      || !keys.includes('datasetPath')) {
    return { ok: false, sentence: 'The experiment import has unsupported or missing fields.' }
  }
  const setup = parseResearchAgentSetup(spec.agentSetup)
  if (!setup.ok) return setup
  let axisInput = spec.axes
  if (Array.isArray(spec.axes)) {
    const ids = new Set()
    for (const axis of spec.axes) {
      if (!axis || typeof axis !== 'object' || Array.isArray(axis)
          || Reflect.ownKeys(axis).length !== 2
          || !Object.hasOwn(axis, 'id') || !Object.hasOwn(axis, 'values')
          || typeof axis.id !== 'string' || ids.has(axis.id)) {
        return { ok: false, sentence: 'The experiment import has duplicate or unsupported axis fields.' }
      }
      ids.add(axis.id)
    }
    axisInput = Object.fromEntries(spec.axes.map(axis => [axis.id, axis.values]))
  }
  const axes = parseAxes(axisInput)
  if (!axes.ok) return axes
  const runner = parseRunner(spec.runner)
  if (!runner.ok) return runner
  if (spec.resultSchema === null || spec.resultSchema === undefined) return { ok: false, sentence: 'The experiment import must include result columns.' }
  const resultSchema = parseResultSchema(spec.resultSchema)
  if (!resultSchema.ok) return resultSchema
  return {
    ok: true,
    spec: {
      ...spec,
      axes: axes.axes,
      runner: runner.runner,
      resultSchema: resultSchema.resultSchema,
      ...(setup.agentSetup ? { agentSetup: setup.agentSetup } : {}),
    },
  }
}

export function parseExperimentImport(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SERIALIZED
      || new TextEncoder().encode(text).byteLength > MAX_SERIALIZED) {
    return { ok: false, sentence: 'The experiment import is empty or exceeds 60000 UTF-8 bytes.' }
  }
  let envelope
  try { envelope = JSON.parse(text) } catch { return { ok: false, sentence: 'The experiment import is not valid JSON.' } }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Reflect.ownKeys(envelope).some(key => !['format', 'version', 'spec'].includes(key))
      || envelope.format !== IMPORT_FORMAT || envelope.version !== IMPORT_VERSION) {
    return { ok: false, sentence: 'This experiment file uses an unsupported format. Choose an exported ToolsEnabled experiment file.' }
  }
  const shaped = importSpecShape(envelope.spec)
  if (!shaped.ok) return shaped
  const built = buildExperiment({ ...shaped.spec, agentSetup: shaped.spec.agentSetup }, { experiments: [] })
  if (!built.ok) return built
  const { id, projectId, serviceExperimentId, createdAtMs, treeId, cells, ...spec } = built.experiment
  return { ok: true, spec }
}

export function serializeExperimentImport(spec) {
  const shaped = importSpecShape(spec)
  if (!shaped.ok) return shaped
  const built = buildExperiment({ ...shaped.spec, agentSetup: shaped.spec.agentSetup }, { experiments: [] })
  if (!built.ok) return built
  const { id, projectId, serviceExperimentId, createdAtMs, treeId, cells, ...normalized } = built.experiment
  const text = JSON.stringify({ format: IMPORT_FORMAT, version: IMPORT_VERSION, spec: normalized })
  if (new TextEncoder().encode(text).byteLength > MAX_SERIALIZED) {
    return { ok: false, sentence: 'The experiment file exceeds 60000 UTF-8 bytes. Reduce its explicit inputs before downloading.' }
  }
  return { ok: true, text }
}


/* ---------- building a spec ---------- */

/**
 * Build one v2 experiment from already-parsed shapes: the view runs
 * parseAxes/parseRunner/parseResultSchema first, so every refusal here is
 * about the combination, not the pieces.
 */
export function buildExperiment({ name, axes, runner, resultSchema, runsPerCell, datasetPath, projectId, timeoutMs, agentSetup }, existing) {
  const cleanName = cleanText(name, CAPS.name)
  const parsedSetup = parseResearchAgentSetup(agentSetup)
  if (!parsedSetup.ok) return parsedSetup
  if (!cleanName) return { ok: false, sentence: `Name the experiment first — up to ${CAPS.name} characters.` }
  let cleanDataset = null
  if (!(datasetPath === '' || datasetPath === null || datasetPath === undefined)) {
    cleanDataset = cleanText(datasetPath, CAPS.datasetPath)
    if (!cleanDataset) return { ok: false, sentence: `A dataset path fits in ${CAPS.datasetPath} characters.` }
  }
  if (!Array.isArray(axes) || axes.length === 0) {
    return { ok: false, sentence: 'The grid needs at least one axis with values.' }
  }
  if (!runner || typeof runner !== 'object' || typeof runner.kind !== 'string') {
    return { ok: false, sentence: 'Pick how this experiment runs: sessions, a command, or a web address.' }
  }
  const validRunner = parseRunner(runner)
  if (!validRunner.ok) return validRunner
  if (runner.kind === 'agent' && !axes.some(axis => axis.id === 'tier' && axis.values.length > 0)) {
    return { ok: false, sentence: 'Give this experiment a tier axis — pick at least one model tier to run on.' }
  }
  const runs = Number.isInteger(runsPerCell) && runsPerCell >= 1 && runsPerCell <= MAX_RUNS_PER_CELL
    ? runsPerCell
    : null
  if (!runs) return { ok: false, sentence: `Repeats per cell is a whole number from 1 to ${MAX_RUNS_PER_CELL}.` }
  const cells = gridCells(axes, { replicates: runs }).map(freshCell)
  const setupGate = researchSetupForRunner(parsedSetup.agentSetup, runner, cells.length)
  if (!setupGate.ok) return setupGate
  if (cells.length > MAX_QUEUE_CELLS) {
    return { ok: false, sentence: `That grid is ${cells.length} runs counting repeats; this bench submits at most ${MAX_QUEUE_CELLS} per experiment. Trim an axis or the repeats.` }
  }
  if (runner.kind === 'agent') {
    // An unknown {token} is refused at design time, never discovered mid-run.
    const probe = cellBrief(runner.briefTemplate, { ...cells[0].params, dataset: cleanDataset ?? '' })
    if (!probe.ok) return probe
  }
  if (existing.experiments.length >= MAX_EXPERIMENTS) {
    return { ok: false, sentence: `This bench holds at most ${MAX_EXPERIMENTS} experiments. Remove one first.` }
  }
  const experiment = {
    id: `exp-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${existing.experiments.length}`}`,
    name: cleanName,
    axes,
    runner,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    resultSchema: resultSchema || DEFAULT_RESULT_SCHEMA,
    runsPerCell: runs,
    datasetPath: cleanDataset,
    ...(parsedSetup.agentSetup ? { agentSetup: parsedSetup.agentSetup } : {}),
    projectId: typeof projectId === 'string' ? projectId : null,
    serviceExperimentId: null,
    createdAtMs: Date.now(),
    treeId: null,
    cells,
  }
  const next = { experiments: [...existing.experiments, experiment] }
  const serialized = serializeExperimentsRow(next)
  if (serialized && serialized.length > MAX_SERIALIZED) {
    return { ok: false, sentence: 'Your experiments have filled the space this account file gives them. Remove one first.' }
  }
  return { ok: true, experiment, next, serialized }
}

export function removeExperiment(state, id) {
  const remaining = state.experiments.filter(experiment => experiment.id !== id)
  if (remaining.length === state.experiments.length) return { ok: false, sentence: 'That experiment is not on this bench.' }
  const next = { experiments: remaining }
  return { ok: true, next, serialized: serializeExperimentsRow(next) }
}

/** The brief one worker receives: the template with every {axis} token and
 *  {dataset} substituted from the cell. Text substitution only — the worker
 *  reads any path under its own confinement. A v1-upgraded row whose prose
 *  happens to contain a stray {token} falls back to the old plain {dataset}
 *  substitution, so every v1 template keeps running exactly as before. */
export function workerBrief(experiment, cell) {
  const dataset = experiment.datasetPath || ''
  const trailer = `\n\n(Experiment "${experiment.name}", ${cellLabel(experiment.axes, cell.params)}. Reply with your result.)`
  const built = cellBrief(experiment.runner.briefTemplate, { ...cell.params, dataset })
  if (built.ok) return `${built.text}${trailer}`
  return `${experiment.runner.briefTemplate.split('{dataset}').join(dataset)}${trailer}`
}

/* ---------- where an experiment runs ---------- */

/**
 * The one dispatch decision, pure: an agent-runner grid of at most
 * MAX_LOCAL_CELLS runs locally as tree nodes (no project needed — the tree
 * knows nothing of projects); everything else is queued through the research
 * service, and queued work is always filed under a project.
 */
export function decideDispatch(experiment, { projectId = experiment.projectId } = {}) {
  const validRunner = parseRunner(experiment.runner)
  if (!validRunner.ok) return validRunner
  if (experiment.runner.kind === 'agent' && experiment.cells.length <= MAX_LOCAL_CELLS) {
    return { ok: true, mode: 'local' }
  }
  if (typeof projectId === 'string' && projectId.length > 0) {
    return { ok: true, mode: 'queue', projectId }
  }
  return { ok: false, sentence: 'Queued runs are filed under a project — pick one above, then run it again.' }
}

/** Runner declaration → the service's runner config, one place. */
export function runnerConfigFor(runner) {
  const { kind, ...config } = runner
  return kind === 'process' ? { stdin: 'none', ...config, args: config.args || [] } : config
}

function collectorFor(runner) {
  return runner.kind === 'agent' ? { kind: 'none' } : { kind: 'stdout-json', recordKind: 'summary' }
}

/* ---------- the dispatcher ---------- */

/* Module-level: tracked sessions outlive the research view. */
const tracked = new Map()   // sessionId -> { context, experimentId, cellIndex }
const transcripts = new Map() // sessionId -> accumulated text (capped)
let listenerUnsub = null
const accountContexts = new Map()
let mutationSequence = 0
export function experimentsReadCheckpoint() { return mutationSequence }

function newContext(accountId) {
  return { accountId, state: { experiments: [], damaged: false }, persist: null, queuePersist: null,
    revision: 0, savedRevision: 0, changedAt: 0, dirtyExperiments: new Set(), writing: null, persistenceError: '' }
}
let activeContext = newContext(null)
accountContexts.set(null, activeContext)

function announce() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(RESEARCH_EXPERIMENTS_EVENT))
}

/* The in-memory copy of the row, authoritative between persists. The view
   seeds it on mount from the account row; dispatch and the listener mutate
   and persist it. */
let state = activeContext.state

export function seedExperiments(parsed, { accountId = null, persist, agent, transcripts: history, readCheckpoint } = {}) {
  let context = accountContexts.get(accountId)
  if (!context) { context = newContext(accountId); accountContexts.set(accountId, context) }
  const retained = new Set(context.dirtyExperiments)
  for (const track of tracked.values()) if (track.context === context) retained.add(track.experimentId)
  const held = new Map(context.state.experiments.filter(experiment => retained.has(experiment.id)).map(experiment => [experiment.id, experiment]))
  const incoming = Number.isSafeInteger(readCheckpoint) && context.changedAt > readCheckpoint ? context.state : parsed
  const merged = incoming.experiments.map(experiment => {
    const previous = held.get(experiment.id)
    // Saved designs are immutable. Preserve an in-flight or unsaved outcome
    // only for that same design; a removed design is never resurrected.
    return previous && previous.createdAtMs === experiment.createdAtMs ? previous : experiment
  })
  context.state = { experiments: merged, damaged: incoming.damaged }
  if (typeof persist === 'function') context.persist = persist
  activeContext = context
  state = context.state
  if (agent) {
    ensureListener(agent)
    for (const experiment of state.experiments) for (const [cellIndex, cell] of experiment.cells.entries()) {
      if (!cell.sessionId || !['starting', 'running', 'unconfirmed'].includes(cell.status)) continue
      let track = tracked.get(cell.sessionId)
      if (!track) {
        track = { context, experimentId: experiment.id, cellIndex }
        tracked.set(cell.sessionId, track)
        cell.status = 'unconfirmed'
      }
      if (track.context === context && cell.status === 'unconfirmed' && !track.recovering) {
        void recoverSavedSession(cell.sessionId, track, agent, history)
      }
    }
  }
  if (context.revision > context.savedRevision && context.persist) void persistState(context)
  for (const [id, other] of accountContexts) {
    if (other !== context && !other.writing && other.revision === other.savedRevision
      && ![...tracked.values()].some(track => track.context === other)) accountContexts.delete(id)
  }
}

async function recoverSavedSession(sessionId, track, agent, history) {
  track.recovering = true
  const current = () => tracked.get(sessionId) === track && !track.completedRevision
  try {
    if (typeof agent.sessionActivity !== 'function') return
    const activity = await agent.sessionActivity({ sessionId })
    if (!current() || activity?.ok !== true) return
    const experiment = track.context.state.experiments.find(item => item.id === track.experimentId)
    const cell = experiment?.cells[track.cellIndex]
    if (!cell || cell.sessionId !== sessionId) return
    if (activity.busy === true) { cell.status = 'running'; return }
    if (!(activity.turnsCompleted > 0) || typeof activity.lastTurnStatus !== 'string' || !activity.lastTurnStatus) return
    if (cell.nodeId && typeof history?.read === 'function') {
      const record = await history.read({ computerId: EXPERIMENT_COMPUTER_ID, nodeId: cell.nodeId, limit: 60 })
      if (!current()) return
      if (record?.ok !== true) return
      const text = (record.entries || []).filter(entry => entry?.who === 'agent'
        && typeof entry.id === 'string' && entry.id.startsWith(`agent:${sessionId}:`)
        && typeof entry.text === 'string').map(entry => entry.text).join('\n\n')
      transcripts.set(sessionId, text.slice(-EXCERPT_CHARS * 4))
    }
    if (current()) fileOutcome(sessionId, activity.lastTurnStatus)
  } catch {
    // No native result was observed. Keep the saved session identifiable and
    // unconfirmed; neither replace it nor infer completion from old text.
  } finally {
    track.recovering = false
    if (track.context === activeContext) announce()
  }
}

export function experimentsSnapshot() {
  return { experiments: state.experiments.slice(), damaged: state.damaged,
    ...(activeContext.persistenceError ? { persistenceError: activeContext.persistenceError } : {}) }
}

function changed(context, experiment) {
  context.dirtyExperiments.add(experiment.id)
  context.changedAt = ++mutationSequence
  return ++context.revision
}

/* A design edit reserves the same queue as worker-result writes. Membership
 * changes only after the edit is accepted. Outcomes received during that await
 * mutate their original objects and are flushed after the accepted membership
 * change; a refused deletion therefore keeps both the design and its outcome. */
export async function commitExperimentChange(change, { persist, isCurrent = () => true } = {}) {
  const context = activeContext
  const writer = persist || context.persist
  const operation = (context.writing || Promise.resolve()).then(async () => {
    if (context !== activeContext || !isCurrent()) return { ok: false, sentence: 'The research account or project changed before saving.' }
    try {
      const result = change(context.state)
      if (!result.ok) return result
      const before = new Set(context.state.experiments.map(experiment => experiment.id))
      const after = new Set(result.next.experiments.map(experiment => experiment.id))
      const added = result.next.experiments.filter(experiment => !before.has(experiment.id))
      const removed = new Set([...before].filter(id => !after.has(id)))
      const saved = await writer(serializeExperimentsRow(result.next))
      if (saved?.ok !== true) return { ok: false, sentence: saved?.sentence || saved?.reason || 'Your experiment change could not be saved.' }
      // Apply only membership changes to the latest row: a native outcome or
      // a newer account read may have arrived since the write was submitted.
      context.state = { experiments: context.state.experiments.filter(experiment => !removed.has(experiment.id)), damaged: false }
      for (const experiment of added) if (!context.state.experiments.some(item => item.id === experiment.id)) context.state.experiments.push(experiment)
      for (const id of removed) changed(context, { id })
      for (const experiment of added) changed(context, experiment)
      if (context === activeContext) state = context.state
      return result
    } catch (error) { return { ok: false, sentence: error?.message || 'Your experiment change could not be saved.' } }
  })
  context.writing = operation
  void operation.then(() => { if (context.writing === operation) context.writing = null })
  const result = await operation
  if (!result.ok) return result
  const saved = await persistState(context, writer)
  if (context === activeContext) announce()
  return saved.ok ? result : saved
}

function persistState(context = activeContext, persist = context.persist) {
  const operation = (context.writing || Promise.resolve()).then(async () => {
    try {
      if (typeof persist !== 'function') throw new Error('Your experiment results could not be saved. Return to this account to retry.')
      while (context.savedRevision < context.revision) {
        const revision = context.revision
        const result = await persist(serializeExperimentsRow(context.state))
        if (result?.ok === false || (context.accountId !== null && result?.ok !== true)) {
          throw new Error(result?.reason || result?.sentence || 'Your experiment results could not be saved. Return to this account to retry.')
        }
        context.savedRevision = revision
        for (const [sessionId, track] of tracked) {
          if (track.context === context && track.completedRevision <= revision) tracked.delete(sessionId)
        }
      }
      context.dirtyExperiments.clear()
      context.persistenceError = ''
      return { ok: true }
    } catch (error) {
      context.persistenceError = error?.message || 'Your experiment results could not be saved. Return to this account to retry.'
      if (context === activeContext) announce()
      return { ok: false, sentence: context.persistenceError }
    }
  })
  context.writing = operation
  void operation.then(() => { if (context.writing === operation) context.writing = null })
  return operation
}

function fileOutcome(sessionId, status) {
  const track = tracked.get(sessionId)
  if (!track || track.completedRevision) return
  const context = track.context
  const experiment = context.state.experiments.find(candidate => candidate.id === track.experimentId)
  const cell = experiment?.cells?.[track.cellIndex]
  const text = (transcripts.get(sessionId) || '').trim()
  transcripts.delete(sessionId)
  if (!cell || cell.sessionId !== sessionId) { tracked.delete(sessionId); return }
  cell.status = sessionTurnSucceeded(status) ? 'finished' : 'failed'
  cell.endedAtMs = Date.now()
  cell.replyExcerpt = text.slice(-EXCERPT_CHARS)
  track.completedRevision = changed(context, experiment)
  void persistState(context)
  if (context === activeContext) announce()

  /* The tree's copy of the same outcome — only when no view holds a live
     store. A mounted computers view files its own nodes through its own
     listener; writing beside it would clobber the whole record. */
  if (cell.nodeId && !isTreeStoreLive(EXPERIMENT_COMPUTER_ID)) {
    const release = markTreeStoreLive(EXPERIMENT_COMPUTER_ID)
    try {
      const store = createFleetTreeStore({
        computerId: EXPERIMENT_COMPUTER_ID,
        storage: safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage),
      })
      if (text) store.setNodeReply(cell.nodeId, text)
      store.setNodeStatus(cell.nodeId, cell.status, { note: '' })
    } catch {
      /* The account context retains the outcome until persistence succeeds.
         The computers view re-learns the session on its next mount. */
    } finally { release() }
  }
}

function ensureListener(agent) {
  if (listenerUnsub || typeof agent?.onEvent !== 'function') return
  listenerUnsub = agent.onEvent(packet => {
    const sessionId = packet?.sessionId
    if (!sessionId || !tracked.has(sessionId)) return
    const event = packet.event
    const delta = sessionEventText(packet, sessionId)
    if (delta) {
      const held = transcripts.get(sessionId) || ''
      transcripts.set(sessionId, (held + delta).slice(-EXCERPT_CHARS * 4))
    } else if (event?.type === 'assistant_text' && typeof event.text === 'string') {
      transcripts.set(sessionId, event.text.slice(-EXCERPT_CHARS * 4))
    }
    const status = sessionTurnStatus(packet, sessionId)
    if (status) fileOutcome(sessionId, status)
  })
}

/**
 * Dispatch one experiment locally: a fresh tree, one node per cell, one
 * session per node — sequentially, because the engine host bounds concurrent
 * sessions and a refusal mid-way must leave a truthful board, not a guessed
 * one. Returns per-cell outcomes; cells refused at start read 'failed' with
 * the sentence. Only the decide guard is new; the tree flow is v1's.
 */
export async function dispatchExperiment(experimentId, { agent, persist, startAgent, isCurrent = () => true } = {}) {
  const context = activeContext
  const current = () => context === activeContext && isCurrent()
  const stale = () => ({ ok: false, sentence: 'The research project or account changed while starting workers. Inspect the original experiment and its tree before running again.' })
  if (!current()) return stale()
  const experiment = context.state.experiments.find(candidate => candidate.id === experimentId)
  if (!experiment) return { ok: false, sentence: 'That experiment is not on this bench.' }
  if (decideDispatch(experiment).mode !== 'local') {
    return { ok: false, sentence: 'This grid is queue-sized. Use its queue control instead — the run board follows it there.' }
  }
  if (experiment.cells.some(cell => cell.status === 'running' || cell.status === 'starting')) {
    return { ok: false, sentence: 'This experiment is already running. Watch it on the run board.' }
  }
  if (experiment.cells.some(cell => cell.status === 'unconfirmed')) {
    return { ok: false, sentence: 'A saved worker could not be confirmed. Inspect its tree before starting this experiment again.' }
  }
  if (typeof startAgent !== 'function' || typeof persist !== 'function') {
    return { ok: false, sentence: 'This copy cannot start workers from the bench. Open ToolsEnabled from its installed app.' }
  }
  if (!context.persist || context.accountId === null) context.persist = persist
  ensureListener(agent)

  let store
  let release = () => {}
  try {
    release = markTreeStoreLive(EXPERIMENT_COMPUTER_ID)
    store = createFleetTreeStore({
      computerId: EXPERIMENT_COMPUTER_ID,
      storage: safeTreeStorage(typeof window === 'undefined' ? null : window.localStorage),
    })
  } catch {
    release()
    return { ok: false, sentence: 'The saved trees in this browser could not be opened, so no workers were started.' }
  }

  let startedCount = 0
  try {
    let rootId = null
    for (let index = 0; index < experiment.cells.length; index += 1) {
      if (!current()) break
      const cell = experiment.cells[index]
      const added = store.addNode({
        treeId: rootId ? experiment.treeId : null,
        parentId: rootId,
        role: 'helper',
        message: workerBrief(experiment, cell),
        /* THE MARK IS SET HERE, ON THE TREE, ONCE. The first cell mints the
           experiment's own tree, and naming its kind is what exempts the grid
           from the agent-tree width (owner, 2026-09-11: "loops and grids dont
           even need to be tied together or to any of this"). Every later cell
           joins that tree as a child and inherits the rule from it. */
        ...(rootId ? {} : { treeKind: EXPERIMENT_TREE_KIND }),
      })
      if (!added.ok) {
        cell.status = 'failed'
        cell.replyExcerpt = added.problems?.[0] || 'The tree could not take this worker, so this cell did not run. Make room on the computers page, then run it again.'
        changed(context, experiment)
        continue
      }
      if (!rootId) {
        rootId = added.node.id
        experiment.treeId = added.node.treeId
      }
      cell.nodeId = added.node.id
      cell.sessionId = null
      cell.status = 'starting'
      cell.startedAtMs = Date.now()
      changed(context, experiment)

      if (experiment.agentSetup && typeof store.setNodeResearchRestriction !== 'function') {
        cell.status = 'failed'
        cell.endedAtMs = Date.now()
        cell.replyExcerpt = 'The fleet store cannot record this clean-room restriction, so no worker was started.'
        store.setNodeStatus(added.node.id, 'failed', { note: '' })
        changed(context, experiment)
        continue
      }

      let scopeReceipt = null
      let started
      try {
        started = await startAgent({ text: workerBrief(experiment, cell), surface: 'research-experiment', tier: cell.params.tier,
          ...(experiment.agentSetup ? { researchSetup: true, research: { ...experiment.agentSetup, prompt: workerBrief(experiment, cell) } } : {}),
          requestKeys: { threadId: added.node.id, treeAnchors: added.node.parentId
            ? [added.node.parentId, added.node.id] : [added.node.id] },
          treeIdentity: { selfName: added.node.id, managerName: added.node.parentId || null },
          onSessionOpen: ({ sessionId, researchRestriction }) => {
            if (typeof sessionId !== 'string' || !sessionId.length) return { ok: false, sentence: 'The worker did not return a session identity.' }
            cell.sessionId = sessionId
            tracked.set(sessionId, { context, experimentId: experiment.id, cellIndex: index })
            store.attachSession(added.node.id, sessionId)
            changed(context, experiment)
            if (!experiment.agentSetup) return { ok: true }
            if (!researchRestriction || typeof researchRestriction !== 'object') {
              scopeReceipt = { ok: false, sentence: 'The worker did not return a trusted clean-room scope, so no restricted worker was admitted.' }
              return scopeReceipt
            }
            const receipt = store.setNodeResearchRestriction(added.node.id, researchRestriction)
            scopeReceipt = receipt?.ok === true && receipt.snapshot?.persistenceFailed !== true
              ? receipt : { ok: false, sentence: 'The clean-room scope could not be saved, so no restricted worker was admitted.' }
            return scopeReceipt
          },
          onSessionEnd: ({ sessionId }) => fileOutcome(sessionId, 'failed'),
        })
      } catch {
        started = { ok: false, sentence: 'The worker start could not be confirmed. Inspect the agents on this computer before trying again.' }
      }
      if (experiment.agentSetup && !scopeReceipt && started?.researchRestriction) {
        const receipt = store.setNodeResearchRestriction(added.node.id, started.researchRestriction)
        scopeReceipt = receipt?.ok === true && receipt.snapshot?.persistenceFailed !== true
          ? receipt : { ok: false, sentence: 'The clean-room scope could not be saved, so no restricted worker was admitted.' }
      }
      if (experiment.agentSetup && (!scopeReceipt || scopeReceipt.ok === false)) {
        if (started && typeof started.sessionId === 'string' && started.sessionId.length > 0) {
          store.attachSession(added.node.id, started.sessionId)
          cell.sessionId = started.sessionId
        }
        cell.status = 'failed'
        cell.endedAtMs = Date.now()
        cell.replyExcerpt = scopeReceipt?.sentence || 'The worker did not return a trusted clean-room scope, so no restricted worker was admitted.'
        store.setNodeStatus(added.node.id, 'failed', { note: '' })
        changed(context, experiment)
        continue
      }
      if (!started || started.ok === false || typeof started.sessionId !== 'string' || started.sessionId.length === 0) {
        /* The fourth outcome shape: a session that IS open whose brief did
           not land. The node keeps the session's name, exactly as the
           compose panel would — an agent running on the computer you are driving with
           nothing on screen pointing at it is the defect that rule closed. */
        if (started && typeof started.sessionId === 'string' && started.sessionId.length > 0) {
          store.attachSession(added.node.id, started.sessionId)
        }
        cell.status = 'failed'
        cell.endedAtMs = Date.now()
        cell.replyExcerpt = started?.sentence || 'The worker did not start, and this copy was not told why.'
        store.setNodeStatus(added.node.id, 'failed', { note: '' })
        changed(context, experiment)
        continue
      }
      startedCount += 1
      // The first turn can finish before send() acknowledges it. The starter
      // exposes the native session before sending, so its real terminal event
      // wins over this later admission receipt.
      if (cell.sessionId !== started.sessionId) {
        cell.sessionId = started.sessionId
        tracked.set(started.sessionId, { context, experimentId: experiment.id, cellIndex: index })
      }
      if (cell.status === 'starting') cell.status = 'running'
      store.attachSession(added.node.id, started.sessionId)
      store.setNodeStatus(added.node.id, cell.status, { note: '' })
      changed(context, experiment)
    }
  } finally {
    release()
  }

  const saved = await persistState(context)
  if (!current()) return stale()
  announce()
  if (!saved.ok) return saved
  return { ok: true, startedCount, total: experiment.cells.length, treeId: experiment.treeId }
}

/**
 * Submit a queue-sized (or process/http) experiment's designed cells to the
 * research service. The first cell carries the full declaration inline; the
 * service registers or matches it by configuration, and every later cell
 * submits by the captured service experiment id so two same-config
 * experiments cannot silently share one mid-loop. A refused cell stays
 * 'designed' — the honest state — and the first refusal sentence rides back.
 */
export async function submitExperimentRuns(experimentId, { submit = submitRun, persist, projectId, isCurrent = () => true } = {}) {
  const stale = () => ({ ok: false, sentence: 'The research project or account changed during submission. Inspect the original project before submitting again.' })
  const context = activeContext
  const current = () => context === activeContext && isCurrent()
  if (!current()) return stale()
  const experiment = context.state.experiments.find(candidate => candidate.id === experimentId)
  if (!experiment) return { ok: false, sentence: 'That experiment is not on this bench.' }
  if (experiment.agentSetup) return { ok: false, sentence: 'Clean-room experiments run only as local agent cells; queue submission would drop their restriction.' }
  if (experiment.projectId && projectId && experiment.projectId !== projectId) return { ok: false, sentence: 'This saved experiment belongs to another Research project. Select its original project before submitting it.' }
  const decision = decideDispatch(experiment, { projectId })
  if (!decision.ok) return decision
  if (decision.mode !== 'queue') {
    return { ok: false, sentence: 'This grid runs on the computer you are driving as sessions. Use its Run control instead.' }
  }
  if (typeof persist === 'function') context.queuePersist = persist
  if (!experiment.projectId) { experiment.projectId = decision.projectId; changed(context, experiment) }

  const spec = {
    projectId: experiment.projectId,
    name: experiment.name,
    runnerKind: experiment.runner.kind,
    runnerConfig: runnerConfigFor(experiment.runner),
    resultSchema: experiment.resultSchema,
    collector: collectorFor(experiment.runner),
    ...(experiment.timeoutMs === undefined ? {} : { timeoutMs: experiment.timeoutMs }),
  }
  let submitted = 0
  let replayed = 0
  let sentence = null
  for (const cell of experiment.cells) {
    if (!current()) return stale()
    if (cell.status !== 'designed') continue
    const body = experiment.serviceExperimentId
      ? { experimentId: experiment.serviceExperimentId, params: cell.params }
      : { experiment: spec, params: cell.params }
    const outcome = await submit(body)
    if (!current()) return stale()
    if (outcome.ok !== true) {
      if (!sentence) sentence = outcome.reason || 'the research service refused a run'
      continue
    }
    if (!experiment.serviceExperimentId && outcome.experiment?.experimentId) {
      experiment.serviceExperimentId = outcome.experiment.experimentId
    }
    cell.status = 'queued'
    cell.runId = outcome.run.runId
    changed(context, experiment)
    if (outcome.disposition === 'replay') replayed += 1
    else submitted += 1
  }
  // Keep queue writes independent of the local-session listener's captured
  // account writer. A later queue click must not replace an agent's writer.
  const saved = await persistState(context, context.queuePersist || context.persist)
  if (!current()) return stale()
  if (!saved.ok) return saved
  announce()
  return { ok: true, submitted, replayed, total: experiment.cells.length, sentence }
}

/* Display truth for queue-dispatched cells. The account row keeps 'queued'
   by design (the service run board owns resolution — see the header note),
   but the gathered panel must not show 'queued' beside a service run that
   already finished. Pure translation for rendering; nothing is mutated and
   nothing is persisted. Unknown service words pass through untranslated —
   an honest unfamiliar word beats a familiar wrong one. */
/* Every service state this board can meet, mapped to a single-token key the
   renderer words. Two lessons are baked in here. The map used to carry five
   entries and pass anything else through raw, so a person read the machine's
   own enums — `retry_wait`, `leased`, `uncertain` — on screen. And it read
   only `task.status`, so a run whose lease had died showed "uncertain" in
   this board while the service board beside it, reading the same data,
   correctly said "stalled" (installed 1.0.12: same run, same screen, same
   instant). The stalled test is shared with the other renderers now. */
const SERVICE_CELL_WORDS = Object.freeze({
  failed: 'failed',
  cancelled: 'cancelled',
  running: 'running',
  claimed: 'claimed',
  leased: 'claimed',
  queued: 'queued',
  retry_wait: 'retrying',
  uncertain: 'uncertain',
  expired: 'stalled',
})
export function cellsWithServiceStatus(experiment, runs) {
  const taskByRunId = new Map((Array.isArray(runs) ? runs : [])
    .filter(run => run && typeof run.runId === 'string' && run.task && typeof run.task.status === 'string')
    .map(run => [run.runId, run.task]))
  return experiment.cells.map(cell => {
    if (cell.status !== 'queued' || !cell.runId || !taskByRunId.has(cell.runId)) return cell
    const task = taskByRunId.get(cell.runId)
    if (runTaskIsStalled(task)) return { ...cell, status: 'stalled' }
    if (task.status === 'succeeded') return { ...cell, status: runTaskDisplayStatus(task) }
    return { ...cell, status: SERVICE_CELL_WORDS[task.status] || task.status }
  })
}

/* The same translation for the moment BEFORE the service has answered. A
   queue-dispatched cell's local row says 'queued' for life, so painting it
   raw asserts "queued" for runs that may be finished — which is what a
   researcher saw on every cold load and on any failed poll (installed
   1.0.11: nine finished cells read "queued" at 240ms). Unknown is its own
   word, and the pulse already speaks it. */
export function cellsAwaitingService(experiment) {
  return experiment.cells.map(cell => (cell.status === 'queued' ? { ...cell, status: 'unread' } : cell))
}

/* Test seam: the module-level maps outlive suites otherwise. */
export function resetExperimentTracking() {
  tracked.clear()
  transcripts.clear()
  listenerUnsub?.()
  listenerUnsub = null
  accountContexts.clear()
  mutationSequence = 0
  activeContext = newContext(null)
  accountContexts.set(null, activeContext)
  state = activeContext.state
}
